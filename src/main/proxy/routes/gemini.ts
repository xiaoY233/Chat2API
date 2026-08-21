import Router from '@koa/router'
import type { RouterContext } from '@koa/router'
import type { Context } from 'koa'
import { loadBalancer } from '../loadbalancer'
import { modelMapper } from '../modelMapper'
import { requestForwarder } from '../forwarder'
import { proxyStatusManager } from '../status'
import { storeManager } from '../../store/store'
import { QwenAiAdapter } from '../adapters/qwen-ai'
import {
  chatCompletionStreamToGeminiSse,
  chatCompletionToGeminiResponse,
  geminiToChatCompletionRequest,
} from '../gemini/translator'
import { geminiFileStore } from '../gemini/fileStore'
import {
  getQwenAiDirectUploadSessionScope,
  type QwenAiDirectUploadInput,
} from '../adapters/qwen-ai-files'
import type { ProxyContext } from '../types'

const router = new Router()
const generateContentRoutePattern = /^\/v1beta\/models\/(.+):generateContent$/
const streamGenerateContentRoutePattern = /^\/v1beta\/models\/(.+):streamGenerateContent$/

function requestId(): string {
  return `gemini-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

function getModelResource(model: string, ownedBy = 'chat2api'): any {
  return {
    name: `models/${model}`,
    version: model,
    displayName: model,
    description: `Chat2API routed model ${model}`,
    inputTokenLimit: 1048576,
    outputTokenLimit: 65536,
    supportedGenerationMethods: ['generateContent', 'streamGenerateContent'],
    owned_by: ownedBy,
  }
}

function selectModel(model: string, request?: { preferredProviderId?: string; preferredAccountId?: string }) {
  const config = storeManager.getConfig()
  const selection = loadBalancer.selectAccount(
    model,
    config.loadBalanceStrategy,
    request?.preferredProviderId || modelMapper.getPreferredProvider(model),
    request?.preferredAccountId || modelMapper.getPreferredAccount(model),
  )
  return selection
}

function createClientAbortSignal(ctx: Context): AbortSignal {
  const controller = new AbortController()
  const abort = () => {
    if (!controller.signal.aborted) {
      controller.abort()
    }
  }
  ctx.req.once('aborted', abort)
  ctx.res.once('close', () => {
    if (!ctx.res.writableEnded) abort()
  })
  return controller.signal
}

function extractUserInput(messages: Array<{ role: string; content?: string | any[] | null }>): string | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (message.role !== 'user' || !message.content) {
      continue
    }

    if (typeof message.content === 'string') {
      return message.content
    }

    if (Array.isArray(message.content)) {
      const text = message.content
        .filter((part: any) => part?.type === 'text' && part.text)
        .map((part: any) => part.text)
        .join(' ')
      if (text) {
        return text
      }
    }
  }

  return undefined
}

async function forwardGemini(ctx: Context, stream: boolean): Promise<void> {
  const model = ctx.params.model
  const startTime = Date.now()
  let chatRequest
  try {
    chatRequest = {
      ...geminiToChatCompletionRequest(model, ctx.request.body || {}),
      stream,
    }
  } catch (error) {
    ctx.status = 400
    ctx.body = {
      error: {
        code: 400,
        message: error instanceof Error ? error.message : 'Invalid Gemini-compatible request',
        status: 'INVALID_ARGUMENT',
      },
    }
    return
  }
  const selection = selectModel(model, chatRequest)

  if (!selection) {
    const latency = Date.now() - startTime
    ctx.status = 503
    const responseBody = {
      error: {
        code: 503,
        message: `No available account for model: ${model}`,
        status: 'UNAVAILABLE',
      },
    }
    ctx.body = responseBody
    storeManager.addRequestLog({
      timestamp: startTime,
      status: 'error',
      statusCode: 503,
      method: ctx.method,
      url: ctx.path,
      model,
      actualModel: model,
      requestBody: JSON.stringify(ctx.request.body || {}),
      userInput: extractUserInput(chatRequest.messages || []),
      responseStatus: 503,
      responseBody: JSON.stringify(responseBody),
      latency,
      isStream: stream,
      errorMessage: responseBody.error.message,
    })
    return
  }

  const { account, provider, actualModel } = selection
  const signal = createClientAbortSignal(ctx)
  chatRequest.stream = stream
  const context: ProxyContext = {
    requestId: requestId(),
    providerId: provider.id,
    accountId: account.id,
    model,
    actualModel,
    startTime,
    isStream: stream,
    clientIP: ctx.ip,
    signal,
  }

  proxyStatusManager.recordRequestStart(model, provider.id, account.id)
  let statisticsRecorded = false
  const recordSuccess = () => {
    if (!statisticsRecorded) {
      statisticsRecorded = true
      proxyStatusManager.recordRequestSuccess(Date.now() - startTime)
    }
  }
  const recordFailure = () => {
    if (!statisticsRecorded) {
      statisticsRecorded = true
      proxyStatusManager.recordRequestFailure(Date.now() - startTime)
    }
  }

  try {
    const result = await requestForwarder.forwardChatCompletion(chatRequest, account, provider, actualModel, context)

    if (!result.success) {
      recordFailure()
      ctx.status = result.status || 500
      const responseBody = {
        error: {
          code: ctx.status,
          message: result.error || 'Gemini-compatible request failed',
          status: result.status === 499 ? 'CANCELLED' : 'INTERNAL',
        },
      }
      ctx.body = responseBody
      storeManager.addRequestLog({
        timestamp: startTime,
        status: 'error',
        statusCode: ctx.status,
        method: ctx.method,
        url: ctx.path,
        model,
        actualModel,
        providerId: provider.id,
        providerName: provider.name,
        accountId: account.id,
        accountName: account.name,
        requestBody: JSON.stringify(ctx.request.body || {}),
        userInput: extractUserInput(chatRequest.messages || []),
        responseStatus: ctx.status,
        responseBody: JSON.stringify(responseBody),
        latency: Date.now() - startTime,
        isStream: stream,
        errorMessage: result.error,
      })
      return
    }

    recordSuccess()

    if (stream && result.stream) {
      storeManager.addRequestLog({
        timestamp: startTime,
        status: 'success',
        statusCode: result.status || 200,
        method: ctx.method,
        url: ctx.path,
        model,
        actualModel,
        providerId: provider.id,
        providerName: provider.name,
        accountId: account.id,
        accountName: account.name,
        requestBody: JSON.stringify(ctx.request.body || {}),
        userInput: extractUserInput(chatRequest.messages || []),
        responseStatus: result.status || 200,
        latency: Date.now() - startTime,
        isStream: true,
      })
      ctx.set('Content-Type', 'text/event-stream')
      ctx.set('Cache-Control', 'no-cache')
      const geminiStream = chatCompletionStreamToGeminiSse(result.stream, actualModel)
      const abortStream = () => {
        if (typeof (result.stream as any).destroy === 'function') {
          ;(result.stream as any).destroy(new Error('Gemini-compatible client disconnected'))
        }
        if (typeof (geminiStream as any).destroy === 'function') {
          ;(geminiStream as any).destroy(new Error('Gemini-compatible client disconnected'))
        }
      }
      signal.addEventListener('abort', abortStream, { once: true })
      geminiStream.once('close', () => signal.removeEventListener('abort', abortStream))
      ctx.body = geminiStream
      return
    }

    ctx.set('Content-Type', 'application/json')
    const responseBody = chatCompletionToGeminiResponse(result.body, actualModel)
    ctx.body = responseBody
    storeManager.addRequestLog({
      timestamp: startTime,
      status: 'success',
      statusCode: result.status || 200,
      method: ctx.method,
      url: ctx.path,
      model,
      actualModel,
      providerId: provider.id,
      providerName: provider.name,
      accountId: account.id,
      accountName: account.name,
      requestBody: JSON.stringify(ctx.request.body || {}),
      userInput: extractUserInput(chatRequest.messages || []),
      responseStatus: result.status || 200,
      responseBody: JSON.stringify(responseBody),
      latency: Date.now() - startTime,
      isStream: false,
    })
  } catch (error) {
    recordFailure()
    const status = (error as { status?: number; statusCode?: number })?.status ||
      (error as { status?: number; statusCode?: number })?.statusCode ||
      (signal.aborted ? 499 : 500)
    const message = error instanceof Error ? error.message : 'Gemini-compatible request failed'
    ctx.status = status
    const responseBody = {
      error: {
        code: status,
        message,
        status: status === 499 ? 'CANCELLED' : 'INTERNAL',
      },
    }
    ctx.body = responseBody
    storeManager.addRequestLog({
      timestamp: startTime,
      status: 'error',
      statusCode: status,
      method: ctx.method,
      url: ctx.path,
      model,
      actualModel,
      providerId: provider.id,
      providerName: provider.name,
      accountId: account.id,
      accountName: account.name,
      requestBody: JSON.stringify(ctx.request.body || {}),
      userInput: extractUserInput(chatRequest.messages || []),
      responseStatus: status,
      responseBody: JSON.stringify(responseBody),
      latency: Date.now() - startTime,
      isStream: stream,
      errorMessage: message,
      errorStack: error instanceof Error ? error.stack : undefined,
    })
  }
}

function directUploadInput(ctx: Context): QwenAiDirectUploadInput {
  const body = (ctx.request.body || {}) as any
  return {
    filename: body.filename || body.displayName || body.display_name,
    mimeType: body.mimeType || body.mime_type,
    sizeBytes: body.sizeBytes ?? body.size_bytes,
    clientFileKey: body.clientFileKey || body.client_file_key,
  }
}

async function startQwenAiDirectUpload(ctx: Context): Promise<void> {
  const model = String(((ctx.request.body || {}) as any).model || ctx.query.model || 'qwen')
  const selection = selectModel(model)
  if (!selection) {
    ctx.status = 503
    ctx.body = { error: { message: `No available account for model: ${model}` } }
    return
  }

  if (!QwenAiAdapter.isQwenAiProvider(selection.provider)) {
    ctx.status = 400
    ctx.body = { error: { message: 'Qwen AI direct upload requires a qwen-ai provider selection' } }
    return
  }

  try {
    const adapter = new QwenAiAdapter(selection.provider, selection.account)
    ctx.body = await adapter.startDirectFileUpload(directUploadInput(ctx))
  } catch (error) {
    ctx.status = 400
    ctx.body = { error: { message: error instanceof Error ? error.message : 'Qwen AI direct upload start failed' } }
  }
}

async function completeQwenAiDirectUpload(ctx: Context): Promise<void> {
  const sessionId = String(((ctx.request.body || {}) as any).sessionId || ((ctx.request.body || {}) as any).session_id || '')
  if (!sessionId) {
    ctx.status = 400
    ctx.body = { error: { message: 'Missing sessionId' } }
    return
  }

  const scope = getQwenAiDirectUploadSessionScope(sessionId)
  if (!scope) {
    ctx.status = 404
    ctx.body = { error: { message: `Qwen AI direct upload session not found or expired: ${sessionId}` } }
    return
  }

  const provider = storeManager.getProviderById(scope.providerId)
  const account = storeManager.getAccountById(scope.accountId, true)
  if (!provider || !account || !QwenAiAdapter.isQwenAiProvider(provider)) {
    ctx.status = 404
    ctx.body = { error: { message: 'Qwen AI direct upload account not found' } }
    return
  }

  try {
    const adapter = new QwenAiAdapter(provider, account)
    ctx.body = { file: await adapter.completeDirectFileUpload(sessionId) }
  } catch (error) {
    ctx.status = 400
    ctx.body = { error: { message: error instanceof Error ? error.message : 'Qwen AI direct upload complete failed' } }
  }
}

function setCapturedModelParam(ctx: RouterContext): void {
  const captures = ctx.captures || []
  const model = captures[0] || ''
  ctx.params = {
    ...ctx.params,
    model: decodeURIComponent(model.replace(/^models\//, '')),
  }
}

router.get('/v1beta/models', async (ctx: Context) => {
  const providers = storeManager.getProviders().filter(provider => provider.enabled)
  const models: any[] = []
  const added = new Set<string>()

  for (const provider of providers) {
    const accounts = storeManager.getAccountsByProviderId(provider.id).filter(account => account.status === 'active')
    if (accounts.length === 0) continue
    for (const model of storeManager.getEffectiveModels(provider.id)) {
      if (added.has(model.displayName)) continue
      added.add(model.displayName)
      models.push(getModelResource(model.displayName, provider.name))
    }
  }

  ctx.body = { models }
})

router.get('/v1beta/models/:model', async (ctx: Context) => {
  ctx.body = getModelResource(ctx.params.model)
})

router.post('/v1beta/chat2api/qwen-ai/direct-upload/start', startQwenAiDirectUpload)

router.post('/v1beta/chat2api/qwen-ai/direct-upload/complete', completeQwenAiDirectUpload)

router.post(generateContentRoutePattern, async (ctx: Context) => {
  setCapturedModelParam(ctx)
  await forwardGemini(ctx, false)
})

router.post(streamGenerateContentRoutePattern, async (ctx: Context) => {
  setCapturedModelParam(ctx)
  await forwardGemini(ctx, true)
})

router.post('/upload/v1beta/files', async (ctx: Context) => {
  try {
    const file = ctx.get('X-Goog-Upload-Protocol')
      ? geminiFileStore.createUploadSession(ctx)
      : geminiFileStore.createSimpleFile(ctx)
    ctx.body = { file }
  } catch (error) {
    ctx.status = 400
    ctx.body = { error: { message: error instanceof Error ? error.message : 'Gemini file upload failed' } }
  }
})

router.post('/upload/v1beta/files/:id', async (ctx: Context) => {
  try {
    const file = geminiFileStore.storeUploadChunk(ctx.params.id, ctx)
    ctx.body = { file }
  } catch (error) {
    ctx.status = 400
    ctx.body = { error: { message: error instanceof Error ? error.message : 'Gemini file upload failed' } }
  }
})

router.get('/v1beta/files/:id', async (ctx: Context) => {
  const file = geminiFileStore.getFile(`files/${ctx.params.id}`)
  if (!file) {
    ctx.status = 404
    ctx.body = { error: { message: `File not found: files/${ctx.params.id}` } }
    return
  }
  ctx.body = { file }
})

router.delete('/v1beta/files/:id', async (ctx: Context) => {
  geminiFileStore.deleteFile(`files/${ctx.params.id}`)
  ctx.status = 200
  ctx.body = {}
})

export default router
