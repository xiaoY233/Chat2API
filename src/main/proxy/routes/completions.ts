/**
 * Proxy Service Module - Completions Route (Optional)
 * Implements /v1/completions route (legacy API)
 */

import Router from '@koa/router'
import type { Context } from 'koa'
import { PassThrough } from 'stream'
import { loadBalancer } from '../loadbalancer'
import { requestForwarder } from '../forwarder'
import { streamHandler } from '../stream'
import { proxyStatusManager } from '../status'
import { modelMapper } from '../modelMapper'
import { storeManager } from '../../store/store'

const router = new Router({ prefix: '/v1' })

interface CompletionRequest {
  model: string
  prompt: string | string[]
  max_tokens?: number
  temperature?: number
  top_p?: number
  n?: number
  stream?: boolean
  stop?: string | string[]
  echo?: boolean
}

/**
 * Generate request ID
 */
function generateRequestId(): string {
  return `cmpl-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

/**
 * Extract user input from prompt
 */
function extractUserInput(prompt: string | string[]): string | undefined {
  if (Array.isArray(prompt)) {
    return prompt.filter(p => p).join(' ')
  }
  return prompt || undefined
}

/**
 * Convert prompt to messages format
 */
function promptToMessages(prompt: string | string[]): Array<{ role: string; content: string }> {
  if (Array.isArray(prompt)) {
    return prompt.map((p, index) => ({
      role: index % 2 === 0 ? 'user' : 'assistant',
      content: p,
    }))
  }

  return [{ role: 'user', content: prompt }]
}

/**
 * Handle Completions request
 */
router.post('/completions', async (ctx: Context) => {
  const startTime = Date.now()
  const requestId = generateRequestId()

  let request: CompletionRequest
  try {
    request = ctx.request.body as CompletionRequest
  } catch (error) {
    ctx.status = 400
    ctx.body = {
      error: {
        message: 'Invalid request body',
        type: 'invalid_request_error',
      },
    }
    return
  }

  if (!request.model) {
    ctx.status = 400
    ctx.body = {
      error: {
        message: 'Missing required field: model',
        type: 'invalid_request_error',
        param: 'model',
      },
    }
    return
  }

  if (request.prompt === undefined) {
    ctx.status = 400
    ctx.body = {
      error: {
        message: 'Missing required field: prompt',
        type: 'invalid_request_error',
        param: 'prompt',
      },
    }
    return
  }

  const config = storeManager.getConfig()
  const preferredProviderId = modelMapper.getPreferredProvider(request.model)
  const preferredAccountId = modelMapper.getPreferredAccount(request.model)

  const selection = loadBalancer.selectAccount(
    request.model,
    config.loadBalanceStrategy,
    preferredProviderId,
    preferredAccountId
  )

  if (!selection) {
    ctx.status = 503
    ctx.body = {
      error: {
        message: `No available account for model: ${request.model}`,
        type: 'service_unavailable_error',
        code: 'no_available_account',
      },
    }
    return
  }

  const { account, provider, actualModel } = selection

  const chatRequest = {
    model: actualModel,
    messages: promptToMessages(request.prompt),
    max_tokens: request.max_tokens,
    temperature: request.temperature,
    top_p: request.top_p,
    n: request.n,
    stream: request.stream,
    stop: request.stop,
  }

  proxyStatusManager.recordRequestStart(request.model, provider.id, account.id)

  try {
    const result = await requestForwarder.forwardChatCompletion(
      chatRequest,
      account,
      provider,
      actualModel,
      {
        requestId,
        providerId: provider.id,
        accountId: account.id,
        model: request.model,
        actualModel,
        startTime,
        isStream: request.stream || false,
      }
    )

    const latency = Date.now() - startTime

    if (!result.success) {
      proxyStatusManager.recordRequestFailure(latency)

      ctx.status = result.status || 500
      ctx.body = {
        error: {
          message: result.error || 'Request failed',
          type: 'api_error',
        },
      }

      storeManager.addLog('error', `Request failed: ${result.error}`, {
        requestId,
        providerId: provider.id,
        accountId: account.id,
        model: request.model,
        latency,
      })

      storeManager.addRequestLog({
        timestamp: startTime,
        status: 'error',
        statusCode: result.status || 500,
        method: 'POST',
        url: '/v1/completions',
        model: request.model,
        actualModel,
        providerId: provider.id,
        providerName: provider.name,
        accountId: account.id,
        accountName: account.name,
        requestBody: JSON.stringify(request),
        userInput: extractUserInput(request.prompt),
        responseStatus: result.status || 500,
        latency,
        isStream: request.stream || false,
        errorMessage: result.error,
      })

      storeManager.recordRequestInStats(false, latency, request.model, provider.id, account.id)

      return
    }

    proxyStatusManager.recordRequestSuccess(latency)

    storeManager.updateAccount(account.id, {
      lastUsed: Date.now(),
      requestCount: (account.requestCount || 0) + 1,
      todayUsed: (account.todayUsed || 0) + 1,
    })

    storeManager.addLog('debug', `Request succeeded`, {
      requestId,
      providerId: provider.id,
      accountId: account.id,
      model: request.model,
      actualModel,
      latency,
      isStream: request.stream,
    })

    const userInput = extractUserInput(request.prompt)
    const responseBodyForLog = !request.stream && result.body
      ? JSON.stringify(result.body)
      : undefined

    let logEntryId: string | undefined

    if (!request.stream) {
      const logEntry = storeManager.addRequestLog({
        timestamp: startTime,
        status: 'success',
        statusCode: 200,
        method: 'POST',
        url: '/v1/completions',
        model: request.model,
        actualModel,
        providerId: provider.id,
        providerName: provider.name,
        accountId: account.id,
        accountName: account.name,
        requestBody: JSON.stringify(request),
        userInput,
        responseStatus: 200,
        responseBody: responseBodyForLog,
        latency,
        isStream: false,
      })
      logEntryId = logEntry.id
    } else {
      const logEntry = storeManager.addRequestLog({
        timestamp: startTime,
        status: 'success',
        statusCode: 200,
        method: 'POST',
        url: '/v1/completions',
        model: request.model,
        actualModel,
        providerId: provider.id,
        providerName: provider.name,
        accountId: account.id,
        accountName: account.name,
        requestBody: JSON.stringify(request),
        userInput,
        responseStatus: 200,
        latency,
        isStream: true,
      })
      logEntryId = logEntry.id
    }

    storeManager.recordRequestInStats(true, latency, request.model, provider.id, account.id)

    if (request.stream && result.stream) {
      ctx.set('Content-Type', 'text/event-stream')
      ctx.set('Cache-Control', 'no-cache')
      ctx.set('Connection', 'keep-alive')
      ctx.set('X-Accel-Buffering', 'no')

      const transformStream = streamHandler.createTransformStream(actualModel, requestId)

      // Collect stream content for log update
      let collectedContent = ''
      transformStream.on('data', (chunk: Buffer) => {
        collectedContent += chunk.toString()
      })

      result.stream.pipe(transformStream)

      transformStream.once('end', () => {
        if (logEntryId) {
          storeManager.updateRequestLog(logEntryId, {
            responseBody: collectedContent || undefined,
          })
        }
      })

      ctx.body = transformStream
    } else {
      ctx.set('Content-Type', 'application/json')
      ctx.body = result.body
    }
  } catch (error) {
    const latency = Date.now() - startTime
    proxyStatusManager.recordRequestFailure(latency)

    const errorMessage = error instanceof Error ? error.message : 'Unknown error'

    ctx.status = 500
    ctx.body = {
      error: {
        message: errorMessage,
        type: 'internal_error',
      },
    }

    storeManager.addLog('error', `Request exception: ${errorMessage}`, {
      requestId,
      providerId: provider.id,
      accountId: account.id,
      model: request.model,
      latency,
      error: errorMessage,
    })

    storeManager.addRequestLog({
      timestamp: startTime,
      status: 'error',
      statusCode: 500,
      method: 'POST',
      url: '/v1/completions',
      model: request.model,
      actualModel,
      providerId: provider.id,
      providerName: provider.name,
      accountId: account.id,
      accountName: account.name,
      requestBody: JSON.stringify(request),
      userInput: extractUserInput(request.prompt),
      responseStatus: 500,
      latency,
      isStream: request.stream || false,
      errorMessage,
    })

    storeManager.recordRequestInStats(false, latency, request.model, provider.id, account.id)
  }
})

export default router
