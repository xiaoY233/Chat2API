import { randomUUID } from 'node:crypto'
import { PassThrough, type Readable } from 'node:stream'
import Router from '@koa/router'
import type { Context } from 'koa'
import {
  requestForwarder,
  shouldDeferQwenAiManagedStreamCommit,
} from '../forwarder'
import { loadBalancer } from '../loadbalancer'
import { forwardWithAccountFailover, resolveAccountFailoverLimit } from '../accountFailover'
import { createDeferredQwenAiFailoverStream } from '../qwenAiDeferredStream'
import { qwenAiRequestGovernor } from '../qwenAiRequestGovernor'
import {
  QwenAiAdapter,
  QWEN_AI_STREAM_FAILURE_EVENT,
  type QwenAiOutputStream,
} from '../adapters/qwen-ai'
import { modelMapper } from '../modelMapper'
import { proxyStatusManager } from '../status'
import { streamHandler } from '../stream'
import type { AccountSelection, ChatMessage, ProxyContext } from '../types'
import { storeManager } from '../../store/store'
import { isClientCancellationError, sanitizeForwardedErrorHeaders } from '../utils/errors'
import { SseKeepAliveStream } from '../utils/sseKeepAlive'
import {
  chatCompletionToResponse,
  responseOutputToChatMessages,
  responsesRequestToChatCompletion,
  ResponsesCompatibilityError,
  type ResponseCreateRequest,
} from '../responses/compat'
import { responsesConversationStore } from '../responses/store'
import { createResponsesStreamTransform } from '../responses/stream'
import { classifyChatRequest } from '../requestIntent'
import {
  createQwenAiSessionRequestFingerprint,
  resolveQwenAiSessionBinding,
  type QwenAiSessionBridge,
  type QwenAiSessionBinding,
  type QwenAiSessionState,
} from '../qwenAiSessionBridge'
import {
  getTrailingQwenAiToolResultBatch,
  qwenAiToolCallSessionStore,
  type QwenAiToolCallSessionClaim,
} from '../qwenAiToolCallSessionStore'
import {
  createResponseImageResolver,
  ResponseImageResolutionError,
} from '../responses/image'
import {
  isQwenAiAccountFault as classifyQwenAiAccountFault,
  qwenAiAccountRetryScope,
} from '../qwenAiAccountPolicy'

function isQwenAiAccountFault(value: Parameters<typeof classifyQwenAiAccountFault>[0] | undefined): boolean {
  return classifyQwenAiAccountFault(value)
}

const router = new Router({ prefix: '/v1' })

function createResponseId(): string {
  return `resp_${Date.now().toString(36)}${randomUUID().replace(/-/g, '')}`
}

function createClientAbortController(ctx: Context): {
  controller: AbortController
  cleanup: () => void
} {
  const controller = new AbortController()
  const abort = () => {
    if (!controller.signal.aborted) controller.abort()
  }
  const onClose = () => {
    if (!ctx.res.writableEnded) abort()
  }
  ctx.req.once('aborted', abort)
  ctx.res.once('close', onClose)
  return {
    controller,
    cleanup: () => {
      ctx.req.removeListener('aborted', abort)
      ctx.res.removeListener('close', onClose)
    },
  }
}

function clientIp(ctx: Context): string {
  const forwarded = ctx.headers['x-forwarded-for']
  return (ctx.headers['x-real-ip'] as string | undefined)
    ?? (Array.isArray(forwarded) ? forwarded[0] : forwarded)
    ?? ctx.ip
    ?? 'unknown'
}

function writeInvalidRequest(
  ctx: Context,
  message: string,
  param: string | null,
  code: string | null,
): void {
  ctx.status = 400
  ctx.body = {
    error: {
      message,
      type: 'invalid_request_error',
      param,
      code,
    },
  }
}

function destroyStream(stream: NodeJS.ReadableStream | undefined, error?: Error): void {
  const destroy = (stream as Readable | undefined)?.destroy
  if (typeof destroy === 'function' && !(stream as Readable).destroyed) {
    destroy.call(stream, error)
  }
}

function streamFailureStatus(
  error: (Error & { status?: unknown }) | undefined,
  clientAborted = false,
): number {
  if (clientAborted || isClientCancellationError(error)) return 499
  if (typeof error?.status === 'number') return error.status
  if (/timed out|timeout|idle for more than/i.test(error?.message || '')) return 504
  return 502
}

function streamFailureCode(error: Error | undefined): string | undefined {
  const code = (error as (Error & { code?: unknown }) | undefined)?.code
  return typeof code === 'string' && code.trim() ? code : undefined
}

function streamFailureAccountFault(
  error: Error | undefined,
  status?: number,
): boolean | undefined {
  if (status === 499) return false
  const accountFault = (error as (Error & { accountFault?: unknown }) | undefined)?.accountFault
  return typeof accountFault === 'boolean' ? accountFault : undefined
}

function streamFailureRetryScope(
  error: Error | undefined,
  status?: number,
): 'next-account' | undefined {
  if (status === 499) return undefined
  const retryScope = (error as (Error & { retryScope?: unknown }) | undefined)?.retryScope
  return retryScope === 'next-account' ? retryScope : undefined
}

function streamFailureHeaders(error: Error | undefined): Record<string, string> | undefined {
  const headers = (error as (Error & { headers?: unknown }) | undefined)?.headers
  return sanitizeForwardedErrorHeaders(headers)
}

function isResponseToolResultInputItem(value: unknown): value is Record<string, any> {
  return Boolean(value)
    && typeof value === 'object'
    && !Array.isArray(value)
    && (
      (value as Record<string, unknown>).type === 'function_call_output'
      || (value as Record<string, unknown>).type === 'custom_tool_call_output'
    )
}

function inputContainsOnlyToolResults(input: ResponseCreateRequest['input'] | undefined): boolean {
  return Array.isArray(input)
    && input.length > 0
    && input.every(isResponseToolResultInputItem)
}

function hasUsableQwenAiSessionBinding(
  binding: QwenAiSessionBinding | undefined,
  requestFingerprint: string | undefined,
  requestModel: string,
): binding is QwenAiSessionBinding {
  return Boolean(
    binding
    && requestFingerprint
    && binding.requestFingerprint === requestFingerprint
    && binding.requestedModel === requestModel
    && binding.providerId.trim()
    && binding.accountId.trim()
    && binding.actualModel.trim()
    && binding.chatId.trim()
    && binding.parentId.trim(),
  )
}

function isQwenAiSessionStaleErrorCode(errorCode: unknown): boolean {
  return String(errorCode || '').trim().toLowerCase() === 'qwen_ai_session_stale'
}

function isQwenAiContinuationRejectedErrorCode(errorCode: unknown): boolean {
  return String(errorCode || '').trim().toLowerCase() === 'qwen_ai_continuation_rejected'
}

function isQwenAiChatInProgressErrorCode(errorCode: unknown): boolean {
  return String(errorCode || '').trim().toUpperCase() === 'CHAT_IN_PROGRESS'
}

function responseOutputToolCallIds(output: Array<Record<string, any>>): string[] {
  const ids = new Set<string>()
  for (const item of output) {
    if (
      (item?.type === 'function_call' || item?.type === 'custom_tool_call')
      && typeof item.call_id === 'string'
      && item.call_id.trim()
    ) {
      ids.add(item.call_id.trim())
    }
  }
  return Array.from(ids)
}

router.post('/responses', async (ctx: Context) => {
  const startedAt = Date.now()
  const createdAt = Math.floor(startedAt / 1000)
  const responseId = createResponseId()
  const abort = createClientAbortController(ctx)
  const request = ctx.request.body as ResponseCreateRequest
  const config = storeManager.getConfig()

  const responseInputItems = Array.isArray(request?.input) ? request.input : []
  const toolResultItems = responseInputItems.filter(isResponseToolResultInputItem)
  if (toolResultItems.length > 0) {
    console.info('[Responses] tool-result ingress', JSON.stringify({
      requestId: responseId,
      toolResultCount: toolResultItems.length,
      isErrorTrueCount: toolResultItems.filter(item => item.is_error === true).length,
      isErrorFalseCount: toolResultItems.filter(item => item.is_error === false).length,
      isErrorMissingCount: toolResultItems.filter(item => typeof item.is_error !== 'boolean').length,
    }))
  }

  const previousResponseId = typeof request?.previous_response_id === 'string'
    && request.previous_response_id
    ? request.previous_response_id
    : undefined
  let previousMessages: ChatMessage[] = []
  let previousQwenAiSessionBinding: QwenAiSessionBinding | undefined
  if (previousResponseId) {
    const stored = responsesConversationStore.getConversation(previousResponseId)
    if (!stored) {
      abort.cleanup()
      writeInvalidRequest(
        ctx,
        `Previous response context is unavailable: ${previousResponseId}`,
        'previous_response_id',
        'response_context_unavailable',
      )
      return
    }
    previousMessages = stored.messages
    previousQwenAiSessionBinding = stored.qwenAiSessionBinding
  }

  let translated: ReturnType<typeof responsesRequestToChatCompletion>
  try {
    translated = responsesRequestToChatCompletion(request, previousMessages)
  } catch (error) {
    abort.cleanup()
    if (error instanceof ResponsesCompatibilityError) {
      writeInvalidRequest(ctx, error.message, error.param, error.code)
      return
    }
    writeInvalidRequest(ctx, error instanceof Error ? error.message : 'Invalid request body', null, null)
    return
  }

  const chatRequest = {
    ...translated.chatRequest,
    signal: abort.controller.signal,
  }
  const translatedToolResults = chatRequest.messages.filter(message => message.role === 'tool')
  if (translatedToolResults.length > 0) {
    console.info('[Responses] tool-result translated', JSON.stringify({
      requestId: responseId,
      toolResultCount: translatedToolResults.length,
      isErrorTrueCount: translatedToolResults.filter(message => message.is_error === true).length,
      isErrorFalseCount: translatedToolResults.filter(message => message.is_error === false).length,
      isErrorMissingCount: translatedToolResults.filter(message => typeof message.is_error !== 'boolean').length,
    }))
  }
  const requestIntent = classifyChatRequest(chatRequest)
  console.info('[Responses] request-intent', JSON.stringify({
    requestId: responseId,
    intent: requestIntent.intent,
    reason: requestIntent.reason,
    signals: requestIntent.signals,
    messageCount: requestIntent.messageCount,
    toolCount: requestIntent.toolCount,
    toolResultCount: requestIntent.toolResultCount,
    textChars: requestIntent.textChars,
  }))

  const qwenAiToolCallSessionEnabled = config.qwenAiSessionMode !== 'legacy'
  const managedToolResponsesRequest = qwenAiToolCallSessionEnabled
    && requestIntent.intent !== 'context_compaction'
    && Boolean(chatRequest.tools?.length)
    && chatRequest.tool_choice !== 'none'
  const qwenAiRequestFingerprint = managedToolResponsesRequest
    ? createQwenAiSessionRequestFingerprint(chatRequest)
    : undefined
  let qwenAiContinuationInputMessages = translated.conversationMessages.slice(previousMessages.length)
  // A Responses function_call_output with a file/image is translated into a
  // normal tool message followed by a synthetic user attachment message. The
  // attachment is safe to send as part of the delta because raw input below
  // contains only tool outputs, but it is not itself a tool-result message
  // for the strict call-id batch validator.
  const rawInputIsOnlyToolResults = inputContainsOnlyToolResults(request?.input)
  const previousQwenAiToolResultBatch = rawInputIsOnlyToolResults
    ? getTrailingQwenAiToolResultBatch([
      ...previousMessages,
      ...qwenAiContinuationInputMessages,
    ])
    : undefined
  const fullHistoryQwenAiToolResultBatch = managedToolResponsesRequest
    ? getTrailingQwenAiToolResultBatch(chatRequest.messages)
    : undefined
  const qwenAiToolCallClaimResult = fullHistoryQwenAiToolResultBatch
    ? qwenAiToolCallSessionStore.claim(fullHistoryQwenAiToolResultBatch.toolCallIds)
    : { status: 'missing' as const }
  if (qwenAiToolCallClaimResult.status === 'busy') {
    abort.cleanup()
    ctx.set('Retry-After', String(Math.max(1, Math.ceil(qwenAiToolCallClaimResult.retryAfterMs / 1000))))
    ctx.status = 429
    ctx.body = {
      error: {
        message: 'The Qwen tool-call continuation is already in progress.',
        type: 'api_error',
        param: null,
        code: 'CHAT_IN_PROGRESS',
      },
    }
    return
  }
  const cachedQwenAiSessionBinding = qwenAiToolCallClaimResult.status === 'claimed'
    ? qwenAiToolCallClaimResult.binding
    : undefined
  const qwenAiToolCallClaim: QwenAiToolCallSessionClaim | undefined =
    qwenAiToolCallClaimResult.status === 'claimed'
      ? qwenAiToolCallClaimResult.claim
      : undefined
  let qwenAiToolCallClaimFinalized = false
  const finalizeQwenAiToolCallClaim = (
    disposition: 'consume' | 'release',
    reason: string,
  ) => {
    if (!qwenAiToolCallClaim || qwenAiToolCallClaimFinalized) return
    qwenAiToolCallClaimFinalized = true
    const applied = disposition === 'consume'
      ? qwenAiToolCallSessionStore.consume(qwenAiToolCallClaim)
      : qwenAiToolCallSessionStore.release(qwenAiToolCallClaim)
    storeManager.addLog('debug', `${disposition === 'consume' ? 'Consumed' : 'Released'} Qwen tool-call session claim`, {
      requestId: responseId,
      providerId: cachedQwenAiSessionBinding?.providerId,
      accountId: cachedQwenAiSessionBinding?.accountId,
      model: chatRequest.model,
      data: { reason, applied },
    })
  }
  const consumeQwenAiToolCallClaim = (reason: string) => {
    finalizeQwenAiToolCallClaim('consume', reason)
  }
  const releaseQwenAiToolCallClaim = (reason: string) => {
    finalizeQwenAiToolCallClaim('release', reason)
  }
  const finalizeFailedQwenAiToolCallClaim = (
    errorCode: unknown,
    accountFault: boolean | undefined,
    retryScope: 'next-account' | undefined,
    reason: string,
  ) => {
    if (isQwenAiChatInProgressErrorCode(errorCode)) {
      releaseQwenAiToolCallClaim(`${reason}_chat_in_progress`)
      return
    }
    if (
      isQwenAiSessionStaleErrorCode(errorCode)
      || isQwenAiContinuationRejectedErrorCode(errorCode)
      || (accountFault === true && retryScope === 'next-account')
    ) {
      consumeQwenAiToolCallClaim(reason)
      return
    }
    releaseQwenAiToolCallClaim(reason)
  }
  let previousQwenAiSessionBindingCleared = false
  const clearPreviousQwenAiSessionBinding = (reason: string) => {
    if (!previousResponseId || !previousQwenAiSessionBinding || previousQwenAiSessionBindingCleared) {
      return
    }
    previousQwenAiSessionBindingCleared = true
    responsesConversationStore.clearQwenAiSessionBinding(previousResponseId)
    storeManager.addLog('debug', 'Cleared unusable Qwen Responses session binding', {
      requestId: responseId,
      providerId: previousQwenAiSessionBinding.providerId,
      accountId: previousQwenAiSessionBinding.accountId,
      model: chatRequest.model,
      data: { reason },
    })
  }
  let qwenAiContinuationBinding: QwenAiSessionBinding | undefined
  const clearQwenAiContinuationState = (reason: string) => {
    clearPreviousQwenAiSessionBinding(reason)
    consumeQwenAiToolCallClaim(reason)
  }

  if (previousQwenAiSessionBinding) {
    const bindingAccount = storeManager.getAccountById(previousQwenAiSessionBinding.accountId)
    const bindingProvider = storeManager.getProviderById(previousQwenAiSessionBinding.providerId)
    const bindingOwnershipMatches = bindingAccount?.providerId === bindingProvider?.id
      && bindingProvider !== undefined
      && QwenAiAdapter.isQwenAiProvider(bindingProvider)
    const continuationCompatible = managedToolResponsesRequest
      && rawInputIsOnlyToolResults
      && previousQwenAiToolResultBatch !== undefined
      && bindingOwnershipMatches
      && hasUsableQwenAiSessionBinding(
        previousQwenAiSessionBinding,
        qwenAiRequestFingerprint,
        chatRequest.model,
      )
    if (continuationCompatible) {
      qwenAiContinuationBinding = previousQwenAiSessionBinding
      qwenAiContinuationInputMessages = previousQwenAiToolResultBatch!.messages
    } else {
      clearPreviousQwenAiSessionBinding('continuation_incompatible')
    }
  }

  if (!qwenAiContinuationBinding && cachedQwenAiSessionBinding) {
    const bindingAccount = storeManager.getAccountById(cachedQwenAiSessionBinding.accountId)
    const bindingProvider = storeManager.getProviderById(cachedQwenAiSessionBinding.providerId)
    const bindingOwnershipMatches = bindingAccount?.providerId === bindingProvider?.id
      && bindingProvider !== undefined
      && QwenAiAdapter.isQwenAiProvider(bindingProvider)
    if (
      bindingOwnershipMatches
      && hasUsableQwenAiSessionBinding(
        cachedQwenAiSessionBinding,
        qwenAiRequestFingerprint,
        chatRequest.model,
      )
    ) {
      qwenAiContinuationBinding = cachedQwenAiSessionBinding
      qwenAiContinuationInputMessages = fullHistoryQwenAiToolResultBatch!.messages
    } else {
      consumeQwenAiToolCallClaim('continuation_incompatible')
    }
  }

  if (qwenAiContinuationBinding) {
    console.info('[Responses] Qwen session continuation candidate', JSON.stringify({
      requestId: responseId,
      providerId: qwenAiContinuationBinding.providerId,
      accountId: qwenAiContinuationBinding.accountId,
      toolResultCount: qwenAiContinuationInputMessages.length,
    }))
  }

  const imageResolver = createResponseImageResolver({ signal: abort.controller.signal })
  const mappedPreferredProviderId = modelMapper.getPreferredProvider(chatRequest.model)
  const mappedPreferredAccountId = modelMapper.getPreferredAccount(chatRequest.model)
  const preferredProviderId = qwenAiContinuationBinding?.providerId ?? mappedPreferredProviderId
  const preferredAccountId = qwenAiContinuationBinding?.accountId ?? mappedPreferredAccountId
  const initialSelection = loadBalancer.selectAccount(
    chatRequest.model,
    config.loadBalanceStrategy,
    preferredProviderId,
    preferredAccountId,
    new Set<string>(),
    qwenAiContinuationBinding
      ? { allowQueuedQwenAiPreferredAccount: true }
      : undefined,
  )
  if (!initialSelection) {
    abort.cleanup()
    releaseQwenAiToolCallClaim('no_available_account')
    ctx.status = 503
    ctx.body = {
      error: {
        message: `No available account for model: ${chatRequest.model}`,
        type: 'service_unavailable_error',
        param: null,
        code: 'no_available_account',
      },
    }
    return
  }

  let initialUsesQwenAiContinuation = Boolean(
    qwenAiContinuationBinding
    && initialSelection.provider.id === qwenAiContinuationBinding.providerId
    && initialSelection.account.id === qwenAiContinuationBinding.accountId
    && initialSelection.actualModel === qwenAiContinuationBinding.actualModel,
  )
  if (
    qwenAiContinuationBinding
    && initialSelection.provider.id === qwenAiContinuationBinding.providerId
    && initialSelection.account.id === qwenAiContinuationBinding.accountId
    && initialSelection.actualModel !== qwenAiContinuationBinding.actualModel
  ) {
    clearQwenAiContinuationState('actual_model_changed')
    qwenAiContinuationBinding = undefined
    initialUsesQwenAiContinuation = false
  }

  const qwenAiSessionBridgeForSelection = (
    selection: AccountSelection,
  ): QwenAiSessionBridge | undefined => {
    if (
      !managedToolResponsesRequest
      || !qwenAiRequestFingerprint
      || !QwenAiAdapter.isQwenAiProvider(selection.provider)
    ) {
      return undefined
    }

    const useContinuation = Boolean(
      qwenAiContinuationBinding
      && selection.provider.id === qwenAiContinuationBinding.providerId
      && selection.account.id === qwenAiContinuationBinding.accountId
      && selection.actualModel === qwenAiContinuationBinding.actualModel,
    )
    return {
      requestFingerprint: qwenAiRequestFingerprint,
      ...(useContinuation ? {
        continuation: {
          binding: qwenAiContinuationBinding!,
          inputMessages: qwenAiContinuationInputMessages,
        },
      } : {}),
    }
  }

  const createProxyContext = (
    selection: AccountSelection,
    deferManagedStreamCommit = false,
  ): ProxyContext => {
    const qwenAiSessionBridge = qwenAiSessionBridgeForSelection(selection)
    return {
      requestId: responseId,
      providerId: selection.provider.id,
      accountId: selection.account.id,
      model: chatRequest.model,
      actualModel: selection.actualModel,
      startTime: startedAt,
      isStream: chatRequest.stream === true,
      clientIP: clientIp(ctx),
      signal: abort.controller.signal,
      requestIntent: requestIntent.intent,
      ...(deferManagedStreamCommit ? { deferManagedStreamCommit: true } : {}),
      ...(qwenAiSessionBridge ? { qwenAiSessionBridge } : {}),
    }
  }
  let { account, provider, actualModel } = initialSelection
  let qwenAiStream: QwenAiOutputStream | undefined
  proxyStatusManager.recordRequestStart(chatRequest.model, provider.id, account.id)

  const initialProviderIsQwenAi = QwenAiAdapter.isQwenAiProvider(initialSelection.provider)
  const failoverSelectionConstraints = initialProviderIsQwenAi
    && loadBalancer.hasCompleteQwenAiWebSession(initialSelection)
    ? {
        qwenAiWebSessionTier: 'complete' as const,
        ...(qwenAiContinuationBinding
          ? { allowQueuedQwenAiPreferredAccount: true }
          : {}),
      }
    : qwenAiContinuationBinding
      ? { allowQueuedQwenAiPreferredAccount: true }
      : undefined
  const activeAccountCount = initialProviderIsQwenAi
    ? storeManager.getAccountsByProviderId(initialSelection.provider.id)
      .filter(candidate => candidate.status === 'active')
      .length
    : 0
  const maxFailovers = resolveAccountFailoverLimit({
    configuredMaxFailovers: config.retryCount,
    qwenAiProvider: initialProviderIsQwenAi,
    activeAccountCount,
    qwenAiMaxAccountFailovers: process.env.CHAT2API_QWEN_AI_MAX_ACCOUNT_FAILOVERS,
  })
  const deferManagedStreamCommit = initialProviderIsQwenAi
    && shouldDeferQwenAiManagedStreamCommit(chatRequest)

  const applyEffectiveSelection = (
    effectiveAccountId?: string,
    effectiveProviderId?: string,
    effectiveActualModel?: string,
  ) => {
    if (!effectiveAccountId) return
    const effectiveAccount = storeManager.getAccountById(effectiveAccountId)
    const effectiveProvider = storeManager.getProviderById(
      effectiveProviderId || effectiveAccount?.providerId || provider.id,
    )
    if (
      !effectiveAccount
      || !effectiveProvider
      || effectiveAccount.providerId !== effectiveProvider.id
    ) {
      return
    }

    account = effectiveAccount
    provider = effectiveProvider
    actualModel = effectiveActualModel || actualModel
  }
  const refreshEffectiveStreamSelection = () => {
    if (!qwenAiStream) return
    applyEffectiveSelection(
      qwenAiStream.qwenAiEffectiveAccountId,
      qwenAiStream.qwenAiEffectiveProviderId,
      qwenAiStream.qwenAiEffectiveActualModel,
    )
  }
  let responsesChunkCount = 0
  let lastResponsesChunkAt = 0
  let clientChunkCount = 0
  let lastClientChunkAt = 0
  let streamDeliveryLogged = false
  const logStreamDelivery = (outcome: 'completed' | 'failed', status: number, error?: Error) => {
    if (streamDeliveryLogged || chatRequest.stream !== true) return
    streamDeliveryLogged = true
    console.info('[Responses] stream-delivery', JSON.stringify({
      requestId: responseId,
      outcome,
      status,
      errorCode: streamFailureCode(error),
      elapsedMs: Date.now() - startedAt,
      responsesChunkCount,
      lastResponsesChunkAt,
      clientChunkCount,
      lastClientChunkAt,
    }))
  }

  let outcomeRecorded = false
  const recordSuccess = () => {
    if (outcomeRecorded) return
    refreshEffectiveStreamSelection()
    outcomeRecorded = true
    logStreamDelivery('completed', 200)
    const latency = Date.now() - startedAt
    loadBalancer.clearAccountFailure(account.id)
    proxyStatusManager.recordRequestSuccess(latency)
    storeManager.incrementAccountUsage(account.id)
    storeManager.recordRequestInStats(true, latency, chatRequest.model, provider.id, account.id)
    storeManager.addLog('debug', 'Responses request completed', {
      requestId: responseId,
      providerId: provider.id,
      accountId: account.id,
      model: chatRequest.model,
      actualModel,
      latency,
      isStream: chatRequest.stream === true,
    })
  }
  const recordFailure = (
    error: Error,
    status = 502,
    penalizeAccount = true,
    deferredStreamFailure = false,
  ) => {
    if (outcomeRecorded) return
    refreshEffectiveStreamSelection()
    outcomeRecorded = true
    logStreamDelivery('failed', status, error)
    const latency = Date.now() - startedAt
    const accountFault = streamFailureAccountFault(error, status)
    const retryScope = streamFailureRetryScope(error, status)
    const errorCode = streamFailureCode(error)
    const claimErrorCode = status === 499 ? undefined : errorCode
    const clearsPreviousBinding = (
      status !== 499
      &&
      initialUsesQwenAiContinuation
      && !isQwenAiChatInProgressErrorCode(claimErrorCode)
      && (
        isQwenAiSessionStaleErrorCode(claimErrorCode)
        || isQwenAiContinuationRejectedErrorCode(claimErrorCode)
        || deferredStreamFailure
        || (
          accountFault === true
          && retryScope === 'next-account'
        )
      )
    )
    if (clearsPreviousBinding) {
      clearPreviousQwenAiSessionBinding(
        isQwenAiSessionStaleErrorCode(claimErrorCode)
          ? 'terminal_stale_session'
          : isQwenAiContinuationRejectedErrorCode(claimErrorCode)
            ? 'terminal_continuation_rejected'
            : accountFault === true && retryScope === 'next-account'
              ? 'terminal_account_failover'
            : 'terminal_stream_failure',
      )
    }
    finalizeFailedQwenAiToolCallClaim(
      claimErrorCode,
      accountFault,
      retryScope,
      isQwenAiSessionStaleErrorCode(claimErrorCode)
        ? 'terminal_stale_session'
        : isQwenAiContinuationRejectedErrorCode(claimErrorCode)
          ? 'terminal_continuation_rejected'
          : accountFault === true && retryScope === 'next-account'
            ? 'terminal_account_failover'
            : 'terminal_stream_failure',
    )
    const shouldPenalizeAccount = penalizeAccount && (
      !QwenAiAdapter.isQwenAiProvider(provider)
        ? accountFault !== false
        : isQwenAiAccountFault({
            accountFault,
            status,
            code: errorCode,
            errorCode,
            message: error.message,
          })
    )
    if (deferredStreamFailure && QwenAiAdapter.isQwenAiProvider(provider)) {
      qwenAiRequestGovernor.reportDeferredFailure(account.id, {
        success: false,
        status,
        headers: streamFailureHeaders(error),
        error: error.message,
        errorCode,
        retryable: false,
        accountFault: accountFault ?? shouldPenalizeAccount,
      }, requestIntent.intent)
    }
    proxyStatusManager.recordRequestFailure(latency)
    if (shouldPenalizeAccount && status !== 429 && status !== 499) {
      loadBalancer.markAccountFailed(account.id)
    }
    storeManager.recordRequestInStats(false, latency, chatRequest.model, provider.id, account.id)
    storeManager.addLog(status === 499 ? 'debug' : 'error', 'Responses request failed', {
      requestId: responseId,
      providerId: provider.id,
      accountId: account.id,
      model: chatRequest.model,
      actualModel,
      latency,
      error: error.message,
      errorCode,
      data: { status, accountFault },
    })
  }
  const storeConversation = (
    output: Array<Record<string, any>>,
    qwenAiSessionState?: QwenAiSessionState,
  ) => {
    const transcript = [
      ...translated.conversationMessages,
      ...responseOutputToChatMessages(output),
    ]
    const toolCallIds = responseOutputToolCallIds(output)
    const qwenAiSessionBinding = managedToolResponsesRequest && toolCallIds.length > 0
      ? resolveQwenAiSessionBinding(qwenAiSessionState)
      : undefined
    if (
      initialUsesQwenAiContinuation
      && qwenAiSessionBinding
      && previousQwenAiSessionBinding
      && (
        qwenAiSessionBinding.providerId !== previousQwenAiSessionBinding.providerId
        || qwenAiSessionBinding.accountId !== previousQwenAiSessionBinding.accountId
        || qwenAiSessionBinding.chatId !== previousQwenAiSessionBinding.chatId
      )
    ) {
      clearQwenAiContinuationState('continuation_replayed_full_history')
    }
    // Consume the preceding batch before adding a new one so a reused call ID
    // always belongs to the newest completed Qwen branch.
    consumeQwenAiToolCallClaim('continuation_consumed')
    if (qwenAiSessionBinding && toolCallIds.length > 0) {
      if (!qwenAiToolCallSessionStore.set(toolCallIds, qwenAiSessionBinding)) {
        storeManager.addLog('warn', 'Qwen tool-call session binding exceeded bounded cache limits', {
          requestId: responseId,
          providerId: qwenAiSessionBinding.providerId,
          accountId: qwenAiSessionBinding.accountId,
          model: chatRequest.model,
        })
      } else {
        storeManager.addLog('debug', 'Stored Qwen tool-call session binding', {
          requestId: responseId,
          providerId: qwenAiSessionBinding.providerId,
          accountId: qwenAiSessionBinding.accountId,
          model: chatRequest.model,
          data: {
            toolCallCount: toolCallIds.length,
            chatId: qwenAiSessionBinding.chatId,
            parentId: qwenAiSessionBinding.parentId,
          },
        })
      }
    }
    const stored = responsesConversationStore.set(responseId, transcript, qwenAiSessionBinding)
    if (!stored) {
      storeManager.addLog('warn', 'Responses context exceeded the bounded previous_response store', {
        requestId: responseId,
        model: chatRequest.model,
      })
    }
  }

  try {
    const failoverPromise = forwardWithAccountFailover({
      initialSelection,
      maxFailovers,
      signal: abort.controller.signal,
      forward: async ({ selection }) => requestForwarder.forwardChatCompletion(
        chatRequest,
        selection.account,
        selection.provider,
        selection.actualModel,
        createProxyContext(
          selection,
          deferManagedStreamCommit,
        ),
      ),
      selectNext: excludedAccountIds => loadBalancer.selectAccount(
        chatRequest.model,
        config.loadBalanceStrategy,
        preferredProviderId,
        preferredAccountId,
        excludedAccountIds,
        failoverSelectionConstraints,
      ),
      onFailedAttempt: ({ selection, attempt }, result) => {
        if (QwenAiAdapter.isQwenAiProvider(selection.provider)) {
          qwenAiRequestGovernor.reportAccountFailover(selection.account.id, {
            requestId: responseId,
            status: result.status,
            errorCode: result.errorCode,
            attempt,
            accountFault: result.accountFault,
          })
        }
        if (
          !QwenAiAdapter.isQwenAiProvider(selection.provider)
            ? result.accountFault !== false
            : isQwenAiAccountFault(result)
        ) {
          loadBalancer.markAccountFailed(selection.account.id)
        }
        if (
          qwenAiContinuationBinding
          && selection.provider.id === qwenAiContinuationBinding.providerId
          && selection.account.id === qwenAiContinuationBinding.accountId
          && result.accountFault === true
          && result.retryScope === 'next-account'
        ) {
          clearQwenAiContinuationState('account_failover')
        }
        storeManager.addLog('warn', 'Retrying Responses request with another account after upstream failure', {
          requestId: responseId,
          providerId: selection.provider.id,
          accountId: selection.account.id,
          model: chatRequest.model,
          errorCode: result.errorCode,
          data: {
            attempt,
            status: result.status,
            accountFault: result.accountFault,
          },
        })
      },
    })
    const outcome = deferManagedStreamCommit
      ? {
          selection: initialSelection,
          result: {
            success: true,
            status: 200,
            stream: createDeferredQwenAiFailoverStream(
              failoverPromise,
              abort.controller.signal,
            ),
            skipTransform: true,
          },
          failoverCount: 0,
          excludedAccountIds: new Set<string>(),
        }
      : await failoverPromise
    account = outcome.selection.account
    provider = outcome.selection.provider
    actualModel = outcome.selection.actualModel
    const result = outcome.result
    applyEffectiveSelection(
      result.effectiveAccountId,
      result.effectiveProviderId,
      result.effectiveActualModel,
    )

    if (!result.success) {
      abort.cleanup()
      const status = abort.controller.signal.aborted ? 499 : result.status ?? 500
      const failure = Object.assign(new Error(result.error ?? 'Request failed'), {
        status,
        code: result.errorCode,
        headers: result.headers,
        accountFault: result.accountFault,
        retryScope: result.retryScope,
      })
      recordFailure(
        failure,
        status,
        !QwenAiAdapter.isQwenAiProvider(provider)
          ? result.accountFault !== false
          : isQwenAiAccountFault(result),
      )
      const safeHeaders = sanitizeForwardedErrorHeaders(result.headers)
      if (safeHeaders) {
        Object.entries(safeHeaders).forEach(([name, value]) => ctx.set(name, value))
      }
      ctx.status = status
      ctx.body = {
        error: {
          message: result.error ?? 'Request failed',
          type: 'api_error',
          param: null,
          code: result.errorCode ?? null,
        },
      }
      return
    }

    if (chatRequest.stream === true) {
      if (!result.stream) {
        abort.cleanup()
        const error = new Error('Upstream returned no stream for a streaming Responses request.')
        recordFailure(error)
        ctx.status = 502
        ctx.body = {
          error: { message: error.message, type: 'api_error', param: null, code: 'missing_stream' },
        }
        return
      }

      ctx.set('Content-Type', 'text/event-stream; charset=utf-8')
      ctx.set('Cache-Control', 'no-cache')
      ctx.set('Connection', 'keep-alive')
      ctx.set('X-Accel-Buffering', 'no')

      const rawStream = result.stream
      qwenAiStream = QwenAiAdapter.isQwenAiProvider(provider)
        ? rawStream as QwenAiOutputStream
        : undefined
      const chatStream = result.skipTransform
        ? rawStream
        : rawStream.pipe(streamHandler.createTransformStream(
          actualModel,
          `chatcmpl-${responseId.slice(5)}`,
          undefined,
          { requireDoneMarker: true },
        ))
      const responsesStream = createResponsesStreamTransform({
        request,
        responseId,
        model: actualModel,
        createdAt,
        imageResolver,
        onComplete: (response) => {
          storeConversation(response.output, qwenAiStream?.qwenAiSessionState)
          recordSuccess()
        },
        onIncomplete: (response) => {
          // An incomplete terminal response may not have a reusable Qwen
          // parent branch. Keep the transcript, but make the next turn replay.
          storeConversation(response.output)
          recordSuccess()
        },
        onFailure: (error) => {
          const imageResolutionFailure = error instanceof ResponseImageResolutionError
          const status = imageResolutionFailure
            ? error.status
            : streamFailureStatus(error, abort.controller.signal.aborted)
          recordFailure(error, status, !imageResolutionFailure, !imageResolutionFailure)
        },
      }).start()

      // Qwen emits its semantic failure notification immediately before it
      // tears down the provider stream. A deferred/failover wrapper can emit
      // that notification without an observable `error` event (for example
      // when the source is already being destroyed). Do not rely on the
      // transport error to close the Responses stream: fail it directly so
      // clients always receive a terminal `response.failed` event instead of
      // a bare EOF that LiteLLM reports as MidStreamFallbackError.
      if (qwenAiStream) {
        const failResponsesStream = (error: Error) => {
          recordFailure(
            error,
            streamFailureStatus(error, abort.controller.signal.aborted),
            true,
            true,
          )
          if (!responsesStream.readableEnded && !responsesStream.writableEnded) {
            responsesStream.fail(error)
            // Qwen emits the failure notification before its terminal
            // `error/[DONE]` frames. Let the source drain those bytes and
            // close the transform from its normal end/close path; ending it
            // here races the next source write and produces a bare EOF.
            const sourceState = qwenAiStream as QwenAiOutputStream & {
              readableEnded?: boolean
              destroyed?: boolean
            }
            if (sourceState.readableEnded || sourceState.destroyed) {
              responsesStream.end()
            }
          }
        }
        qwenAiStream.once(QWEN_AI_STREAM_FAILURE_EVENT, failResponsesStream)
        if (qwenAiStream.qwenAiFailure) {
          queueMicrotask(() => failResponsesStream(qwenAiStream!.qwenAiFailure!))
        }
      }
      const clientStream = new SseKeepAliveStream()

      responsesStream.on('data', () => {
        responsesChunkCount += 1
        lastResponsesChunkAt = Date.now()
      })
      clientStream.on('data', () => {
        clientChunkCount += 1
        lastClientChunkAt = Date.now()
      })

      const sourceError = (error: Error) => {
        if (sourceFailureTriggered) return
        sourceFailureTriggered = true
        const status = streamFailureStatus(error, abort.controller.signal.aborted)
        if (!abort.controller.signal.aborted) {
          responsesStream.fail(error)
          responsesStream.end()
        } else {
          recordFailure(error, status, true, true)
        }
      }
      // A source can be destroyed without an Error (for example by an HTTP
      // socket reset). Node then emits `close` without `error` or `end`.
      // Convert that transport truncation into a structured Responses failure
      // so downstream clients never receive a bare EOF without a terminal
      // response event.
      let rawStreamEnded = false
      let chatStreamEnded = chatStream === rawStream
      let sourceFailureTriggered = false
      const sourceClose = (ended: () => boolean) => {
        if (ended()) return
        if (abort.controller.signal.aborted) return
        const incomplete = Object.assign(
          new Error('Upstream stream closed before completion.'),
          { status: 502, code: 'incomplete_upstream_stream', accountFault: false },
        )
        sourceError(incomplete)
      }
      rawStream.once('end', () => { rawStreamEnded = true })
      rawStream.once('close', () => sourceClose(() => rawStreamEnded))
      if (chatStream !== rawStream) {
        chatStream.once('end', () => { chatStreamEnded = true })
        chatStream.once('close', () => sourceClose(() => chatStreamEnded))
      }
      rawStream.once('error', sourceError)
      if (chatStream !== rawStream) chatStream.once('error', sourceError)
      responsesStream.once('error', (error: Error) => {
        const imageResolutionFailure = error instanceof ResponseImageResolutionError
        recordFailure(
          error,
          imageResolutionFailure
            ? error.status
            : streamFailureStatus(error, abort.controller.signal.aborted),
          !imageResolutionFailure,
          !imageResolutionFailure,
        )
        destroyStream(rawStream)
        if (chatStream !== rawStream) destroyStream(chatStream)
        destroyStream(clientStream)
      })
      responsesStream.once('end', abort.cleanup)
      abort.controller.signal.addEventListener('abort', () => {
        const cancellation = new Error('Client disconnected from Responses stream.')
        recordFailure(cancellation, 499, true, true)
        destroyStream(rawStream)
        if (chatStream !== rawStream) destroyStream(chatStream)
        destroyStream(responsesStream)
        destroyStream(clientStream)
      }, { once: true })

      responsesStream.pipe(clientStream)
      chatStream.pipe(responsesStream)
      ctx.body = clientStream
      return
    }

    const fallbackCompletion = {
      id: `chatcmpl-${responseId.slice(5)}`,
      object: 'chat.completion',
      created: createdAt,
      model: actualModel,
      choices: [{
        index: 0,
        message: { role: 'assistant', content: '' },
        finish_reason: 'stop',
      }],
      usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    }
    const response = await chatCompletionToResponse(result.body ?? fallbackCompletion, request, {
      id: responseId,
      model: actualModel,
      createdAt,
      imageResolver,
    })
    storeConversation(
      response.output,
      response.status === 'completed' ? result.qwenAiSessionState : undefined,
    )
    recordSuccess()
    abort.cleanup()
    ctx.set('Content-Type', 'application/json')
    ctx.body = response
  } catch (error) {
    abort.cleanup()
    const caught = error instanceof Error ? error : new Error('Unknown Responses proxy error')
    const status = abort.controller.signal.aborted
      ? 499
      : caught instanceof ResponseImageResolutionError
        ? caught.status
        : 500
    recordFailure(caught, status, !(caught instanceof ResponseImageResolutionError))
    ctx.status = status
    ctx.body = {
      error: {
        message: caught.message,
        type: 'api_error',
        param: null,
        code: abort.controller.signal.aborted
          ? 'request_cancelled'
          : caught instanceof ResponseImageResolutionError
            ? caught.code
            : null,
      },
    }
  }
})

export default router
