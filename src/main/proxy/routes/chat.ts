/**
 * Proxy Service Module - Chat Completions Route
 * Implements /v1/chat/completions route
 */

import { PassThrough } from 'node:stream'
import Router from '@koa/router'
import type { Context } from 'koa'
import {
  ChatCompletionRequest,
  ChatCompletionResponse,
  ProxyContext,
  type AccountSelection,
} from '../types'
import { loadBalancer } from '../loadbalancer'
import {
  requestForwarder,
  shouldDeferQwenAiManagedStreamCommit,
} from '../forwarder'
import { forwardWithAccountFailover, resolveAccountFailoverLimit } from '../accountFailover'
import { createDeferredQwenAiFailoverStream } from '../qwenAiDeferredStream'
import { qwenAiRequestGovernor } from '../qwenAiRequestGovernor'
import { KimiAdapter } from '../adapters/kimi'
import {
  QwenAiAdapter,
  QWEN_AI_STREAM_FAILURE_EVENT,
  type QwenAiOutputStream,
} from '../adapters/qwen-ai'
import { streamHandler } from '../stream'
import { proxyStatusManager } from '../status'
import { modelMapper } from '../modelMapper'
import { storeManager } from '../../store/store'
import {
  isAnthropicToolFormat,
  transformResponseToAnthropic,
  transformChunkToAnthropic
} from '../utils/toolFormatConverter'
import { isClientCancellationError, sanitizeForwardedErrorHeaders } from '../utils/errors'
import { SseKeepAliveStream } from '../utils/sseKeepAlive'
import { classifyChatRequest } from '../requestIntent'
import { createAssistantOutputBoundaryStream } from '../toolCalling/assistantOutputBoundary'
import {
  createQwenAiSessionRequestFingerprint,
  resolveQwenAiSessionBinding,
  type QwenAiSessionBinding,
  type QwenAiSessionBridge,
  type QwenAiSessionState,
} from '../qwenAiSessionBridge'
import {
  getTrailingQwenAiToolResultBatch,
  qwenAiToolCallSessionStore,
  type QwenAiToolCallSessionClaim,
} from '../qwenAiToolCallSessionStore'
import {
  isQwenAiAccountFault as classifyQwenAiAccountFault,
  qwenAiAccountRetryScope,
} from '../qwenAiAccountPolicy'

function isQwenAiAccountFault(value: Parameters<typeof classifyQwenAiAccountFault>[0] | undefined): boolean {
  return classifyQwenAiAccountFault(value)
}

const router = new Router({ prefix: '/v1/chat' })

/**
 * Generate Request ID
 */
function generateRequestId(): string {
  return `chatcmpl-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

/**
 * Get Client IP
 */
function getClientIP(ctx: Context): string {
  return ctx.headers['x-real-ip'] as string ||
    ctx.headers['x-forwarded-for'] as string ||
    ctx.ip ||
    'unknown'
}

/**
 * Extract user input from messages (last user message, full content)
 */
function extractUserInput(messages: Array<{ role: string; content?: string | any[] | null }>): string | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i]
    if (msg.role === 'user' && msg.content) {
      let content = ''
      if (typeof msg.content === 'string') {
        content = msg.content
      } else if (Array.isArray(msg.content)) {
        const textParts = msg.content.filter((p: any) => p.type === 'text')
        if (textParts.length > 0) {
          content = textParts.map((p: any) => p.text || '').join(' ')
        }
      }
      if (content) {
        return content
      }
    }
  }
  return undefined
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

function isQwenAiRiskControl(
  providerId: string | undefined,
  status: number | undefined,
  error: string | undefined,
  errorCode?: string,
  providerIsQwenAi = false,
): boolean {
  return Boolean(
    (providerId === 'qwen-ai' || providerIsQwenAi) &&
    (errorCode === 'qwen_ai_risk_control' || (
      (status === 403 || status === 429) &&
      error &&
      /qwen_ai_risk_control|FAIL_SYS_USER_VALIDATE|RGV587|bxpunish|risk-control|challenge|x5sec|baxia|punish/i.test(error)
    )),
  )
}

function streamFailureStatus(
  error: (Error & { status?: unknown }) | undefined,
  clientAborted = false,
): number {
  if (clientAborted) return 499
  if (typeof error?.status === 'number') return error.status
  if (isClientCancellationError(error)) return 499

  const message = error?.message || ''
  if (/timed out|timeout|idle for more than/i.test(message)) return 504
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

function streamFailureStringField(
  error: Error | undefined,
  field: 'type' | 'param',
): string | undefined {
  const value = (error as (Error & Record<string, unknown>) | undefined)?.[field]
  return typeof value === 'string' && value.trim() ? value : undefined
}

function streamFailureRetryable(error: Error | undefined): boolean | undefined {
  const retryable = (error as (Error & { retryable?: unknown }) | undefined)?.retryable
  return typeof retryable === 'boolean' ? retryable : undefined
}

function streamFailureRetryScope(
  error: Error | undefined,
  status?: number,
): 'next-account' | undefined {
  if (status === 499) return undefined
  const retryScope = (error as (Error & { retryScope?: unknown }) | undefined)?.retryScope
  return retryScope === 'next-account' ? retryScope : undefined
}

function isUpstreamProtocolStreamError(error: Error | undefined): boolean {
  return streamFailureStringField(error, 'type') === 'upstream_protocol_error'
}

function streamFailureHeaders(error: Error | undefined): Record<string, string> | undefined {
  const headers = (error as (Error & { headers?: unknown }) | undefined)?.headers
  return sanitizeForwardedErrorHeaders(headers)
}

function requestFailureLogLevel(status: number | undefined): 'debug' | 'warn' | 'error' {
  if (status === 499) return 'debug'
  if (status === 429) return 'warn'
  return 'error'
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

interface EffectiveSelectionHint {
  effectiveAccountId?: string
  effectiveProviderId?: string
  effectiveActualModel?: string
}

function resolveEffectiveSelection(
  fallback: AccountSelection,
  hint: EffectiveSelectionHint,
): AccountSelection {
  if (!hint.effectiveAccountId) return fallback

  const effectiveAccount = storeManager.getAccountById(hint.effectiveAccountId)
  const effectiveProvider = storeManager.getProviderById(
    hint.effectiveProviderId || effectiveAccount?.providerId || fallback.provider.id,
  )
  if (
    !effectiveAccount
    || !effectiveProvider
    || effectiveAccount.providerId !== effectiveProvider.id
  ) {
    return fallback
  }

  return {
    account: effectiveAccount,
    provider: effectiveProvider,
    actualModel: hint.effectiveActualModel || fallback.actualModel,
  }
}

/**
 * Handle Chat Completions Request
 */
router.post('/completions', async (ctx: Context) => {
  const startTime = Date.now()
  const requestId = generateRequestId()
  const clientIP = getClientIP(ctx)

  let request: ChatCompletionRequest
  try {
    request = ctx.request.body as ChatCompletionRequest
  } catch (error) {
    ctx.status = 400
    ctx.body = {
      error: {
        message: 'Invalid request body',
        type: 'invalid_request_error',
        param: null,
        code: null,
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
        code: null,
      },
    }
    return
  }

  if (!request.messages || !Array.isArray(request.messages) || request.messages.length === 0) {
    ctx.status = 400
    ctx.body = {
      error: {
        message: 'Missing required field: messages',
        type: 'invalid_request_error',
        param: 'messages',
        code: null,
      },
    }
    return
  }

  // Read feature parameters from Headers (lower priority than request body)
  const webSearchFromHeader = ctx.headers['x-web-search'] === 'true'
  const reasoningEffortFromHeader = ctx.headers['x-reasoning-effort'] as 'low' | 'medium' | 'high' | undefined
  const deepResearchFromHeader = ctx.headers['x-deep-research'] === 'true'

  // Handle reasoningEffort (camelCase) from AI SDK - convert to reasoning_effort (snake_case)
  const requestAny = request as any
  if (requestAny.reasoningEffort && !request.reasoning_effort) {
    request.reasoning_effort = requestAny.reasoningEffort
    console.log('[Chat] Reasoning effort set via reasoningEffort (camelCase):', requestAny.reasoningEffort)
    delete requestAny.reasoningEffort
  }

  // Merge into request (request body parameters take priority)
  if (webSearchFromHeader && request.web_search === undefined) {
    request.web_search = true
    console.log('[Chat] Web search enabled via X-Web-Search header')
  }
  if (reasoningEffortFromHeader && request.reasoning_effort === undefined) {
    request.reasoning_effort = reasoningEffortFromHeader
    console.log('[Chat] Reasoning effort set via X-Reasoning-Effort header:', reasoningEffortFromHeader)
  }
  if (deepResearchFromHeader && request.deep_research === undefined) {
    request.deep_research = true
    console.log('[Chat] Deep research enabled via X-Deep-Research header')
  }

  const requestIntent = classifyChatRequest(request)
  console.info('[Chat] request-intent', JSON.stringify({
    requestId,
    intent: requestIntent.intent,
    reason: requestIntent.reason,
    messageCount: requestIntent.messageCount,
    toolCount: requestIntent.toolCount,
    toolResultCount: requestIntent.toolResultCount,
    textChars: requestIntent.textChars,
    lastUserTextChars: requestIntent.lastUserTextChars,
    lastUserTextPrefix: requestIntent.lastUserTextPrefix,
    signals: requestIntent.signals,
  }))

  const config = storeManager.getConfig()
  const qwenAiToolCallSessionEnabled = config.qwenAiSessionMode !== 'legacy'
  const managedToolChatRequest = qwenAiToolCallSessionEnabled
    && requestIntent.intent !== 'context_compaction'
    && Boolean(request.tools?.length)
    && request.tool_choice !== 'none'
  const qwenAiRequestFingerprint = managedToolChatRequest
    ? createQwenAiSessionRequestFingerprint(request)
    : undefined
  const qwenAiToolResultBatch = managedToolChatRequest
    ? getTrailingQwenAiToolResultBatch(request.messages)
    : undefined
  const qwenAiToolCallClaimResult = qwenAiToolResultBatch
    ? qwenAiToolCallSessionStore.claim(qwenAiToolResultBatch.toolCallIds)
    : { status: 'missing' as const }
  if (qwenAiToolCallClaimResult.status === 'busy') {
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
      requestId,
      providerId: cachedQwenAiSessionBinding?.providerId,
      accountId: cachedQwenAiSessionBinding?.accountId,
      model: request.model,
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
  let qwenAiContinuationBinding: QwenAiSessionBinding | undefined
  if (cachedQwenAiSessionBinding) {
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
        request.model,
      )
    ) {
      qwenAiContinuationBinding = cachedQwenAiSessionBinding
      console.info('[Chat] Qwen tool-call continuation candidate', JSON.stringify({
        requestId,
        providerId: cachedQwenAiSessionBinding.providerId,
        accountId: cachedQwenAiSessionBinding.accountId,
        toolResultCount: qwenAiToolResultBatch?.toolCallIds.length || 0,
      }))
    } else {
      consumeQwenAiToolCallClaim('continuation_incompatible')
    }
  }

  const mappedPreferredProviderId = modelMapper.getPreferredProvider(request.model)
  const mappedPreferredAccountId = modelMapper.getPreferredAccount(request.model)
  const preferredProviderId = qwenAiContinuationBinding?.providerId ?? mappedPreferredProviderId
  const preferredAccountId = qwenAiContinuationBinding?.accountId ?? mappedPreferredAccountId

  const initialSelection = loadBalancer.selectAccount(
    request.model,
    config.loadBalanceStrategy,
    preferredProviderId,
    preferredAccountId,
    new Set<string>(),
    qwenAiContinuationBinding
      ? { allowQueuedQwenAiPreferredAccount: true }
      : undefined,
  )

  if (!initialSelection) {
    releaseQwenAiToolCallClaim('no_available_account')
    ctx.status = 503
    ctx.body = {
      error: {
        message: `No available account for model: ${request.model}`,
        type: 'service_unavailable_error',
        param: null,
        code: 'no_available_account',
      },
    }
    return
  }

  if (
    qwenAiContinuationBinding
    && initialSelection.provider.id === qwenAiContinuationBinding.providerId
    && initialSelection.account.id === qwenAiContinuationBinding.accountId
    && initialSelection.actualModel !== qwenAiContinuationBinding.actualModel
  ) {
    consumeQwenAiToolCallClaim('actual_model_changed')
    qwenAiContinuationBinding = undefined
  }

  const qwenAiSessionBridgeForSelection = (
    selection: AccountSelection,
  ): QwenAiSessionBridge | undefined => {
    if (
      !managedToolChatRequest
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
      ...(useContinuation && qwenAiToolResultBatch ? {
        continuation: {
          binding: qwenAiContinuationBinding!,
          inputMessages: qwenAiToolResultBatch.messages,
        },
      } : {}),
    }
  }

  const clientSignal = createClientAbortSignal(ctx)
  const createProxyContext = (
    selection: AccountSelection,
    deferManagedStreamCommit = false,
  ): ProxyContext => {
    const qwenAiSessionBridge = qwenAiSessionBridgeForSelection(selection)
    return {
      requestId,
      providerId: selection.provider.id,
      accountId: selection.account.id,
      model: request.model,
      actualModel: selection.actualModel,
      startTime,
      isStream: request.stream || false,
      clientIP,
      signal: clientSignal,
      requestIntent: requestIntent.intent,
      ...(deferManagedStreamCommit ? { deferManagedStreamCommit: true } : {}),
      ...(qwenAiSessionBridge ? { qwenAiSessionBridge } : {}),
    }
  }
  const registerQwenAiToolCallSessionBinding = (
    toolCallIds: readonly string[] | undefined,
    qwenAiSessionState: QwenAiSessionState | undefined,
  ) => {
    if (!managedToolChatRequest || !toolCallIds?.length) return
    const binding = resolveQwenAiSessionBinding(qwenAiSessionState)
    if (!binding) return
    if (!qwenAiToolCallSessionStore.set(toolCallIds, binding)) {
      storeManager.addLog('warn', 'Qwen tool-call session binding exceeded bounded cache limits', {
        requestId,
        providerId: binding.providerId,
        accountId: binding.accountId,
        model: request.model,
      })
      return
    }
    storeManager.addLog('debug', 'Stored Qwen tool-call session binding', {
      requestId,
      providerId: binding.providerId,
      accountId: binding.accountId,
      model: request.model,
      data: {
        toolCallCount: toolCallIds.length,
        chatId: binding.chatId,
        parentId: binding.parentId,
      },
    })
  }
  let { account, provider, actualModel } = initialSelection
  let context = createProxyContext(initialSelection)
  proxyStatusManager.recordRequestStart(request.model, provider.id, account.id)

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
    && shouldDeferQwenAiManagedStreamCommit(request)

  const runWithAccountFailover = () => forwardWithAccountFailover({
    initialSelection,
    maxFailovers,
    signal: clientSignal,
    forward: async ({ selection }) => {
      const attemptContext = createProxyContext(
        selection,
        deferManagedStreamCommit,
      )
      return requestForwarder.forwardChatCompletion(
        request,
        selection.account,
        selection.provider,
        selection.actualModel,
        attemptContext,
      )
    },
    selectNext: excludedAccountIds => loadBalancer.selectAccount(
      request.model,
      config.loadBalanceStrategy,
      preferredProviderId,
      preferredAccountId,
      excludedAccountIds,
      failoverSelectionConstraints,
    ),
    onFailedAttempt: ({ selection, attempt }, result) => {
      if (QwenAiAdapter.isQwenAiProvider(selection.provider)) {
        qwenAiRequestGovernor.reportAccountFailover(selection.account.id, {
          requestId,
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
        consumeQwenAiToolCallClaim('account_failover')
      }
      storeManager.addLog('warn', 'Retrying request with another account after upstream failure', {
        requestId,
        providerId: selection.provider.id,
        accountId: selection.account.id,
        model: request.model,
        errorCode: result.errorCode,
        data: {
          attempt,
          status: result.status,
          accountFault: result.accountFault,
        },
      })
    },
  })

  try {
    const failoverPromise = runWithAccountFailover()
    const outcome = deferManagedStreamCommit
      ? {
          selection: initialSelection,
          result: {
            success: true,
            status: 200,
            stream: createDeferredQwenAiFailoverStream(
              failoverPromise,
              clientSignal,
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
    const effectiveSelection = resolveEffectiveSelection(outcome.selection, result)
    account = effectiveSelection.account
    provider = effectiveSelection.provider
    actualModel = effectiveSelection.actualModel
    context = createProxyContext({ account, provider, actualModel })

    const latency = Date.now() - startTime

    if (!result.success) {
      const claimErrorCode = result.status === 499 ? undefined : result.errorCode
      const claimAccountFault = result.status === 499 ? false : result.accountFault
      const claimRetryScope = result.status === 499 ? undefined : result.retryScope
      finalizeFailedQwenAiToolCallClaim(
        claimErrorCode,
        claimAccountFault,
        claimRetryScope,
        isQwenAiSessionStaleErrorCode(claimErrorCode)
          ? 'session_stale'
          : isQwenAiContinuationRejectedErrorCode(claimErrorCode)
            ? 'continuation_rejected'
            : claimAccountFault === true && claimRetryScope === 'next-account'
              ? 'account_failover_exhausted'
              : 'request_failed',
      )
      proxyStatusManager.recordRequestFailure(latency)

      if (
        !QwenAiAdapter.isQwenAiProvider(provider)
          ? result.accountFault !== false
          : isQwenAiAccountFault(result)
      ) {
        if (isQwenAiRiskControl(
          provider.id,
          result.status,
          result.error,
          result.errorCode,
          QwenAiAdapter.isQwenAiProvider(provider),
        )) {
          loadBalancer.markQwenAiRiskControl(account.id)
        } else if (result.status && result.status >= 400
          && result.status !== 429 && result.status !== 499) {
          loadBalancer.markAccountFailed(account.id)
        }
      }

      ctx.status = result.status || 500
      const safeErrorHeaders = sanitizeForwardedErrorHeaders(result.headers)
      if (safeErrorHeaders) {
        for (const [key, value] of Object.entries(safeErrorHeaders)) {
          ctx.set(key, value)
        }
      }
      ctx.body = {
        error: {
          message: result.error || 'Request failed',
          type: 'api_error',
          param: null,
          code: result.errorCode ?? null,
        },
      }

      const failureLogLevel = requestFailureLogLevel(result.status)
      storeManager.addLog(failureLogLevel, `${result.status === 499 ? 'Request cancelled' : 'Request failed'}: ${result.error}`, {
        requestId,
        providerId: provider.id,
        accountId: account.id,
        model: request.model,
        latency,
        errorCode: result.errorCode,
      })

      const userInput = extractUserInput(request.messages)
      const errorResponseBody = JSON.stringify({
        error: {
          message: result.error || 'Request failed',
          type: 'api_error',
          param: null,
          code: result.errorCode ?? null,
        },
      })
      storeManager.addRequestLog({
        timestamp: startTime,
        status: 'error',
        statusCode: result.status || 500,
        method: 'POST',
        url: '/v1/chat/completions',
        model: request.model,
        actualModel,
        providerId: provider.id,
        providerName: provider.name,
        accountId: account.id,
        accountName: account.name,
        requestBody: JSON.stringify(request),
        userInput,
        webSearch: request.web_search,
        reasoningEffort: request.reasoning_effort,
        responseStatus: result.status || 500,
        responseBody: errorResponseBody,
        latency,
        isStream: request.stream || false,
        errorMessage: result.error,
        errorCode: result.errorCode,
      })

      storeManager.recordRequestInStats(false, latency, request.model, provider.id, account.id)

      return
    }

    const deferStreamOutcome = request.stream === true
      && Boolean(result.stream)
      && result.skipTransform === true

    if (!deferStreamOutcome) {
      loadBalancer.clearAccountFailure(account.id)
    }

    if (KimiAdapter.isKimiProvider(provider)) {
      if (result.providerSessionId) {
        ctx.set('X-Kimi-Conversation-Id', result.providerSessionId)
      }
      if (result.parentMessageId) {
        ctx.set('X-Kimi-Parent-Id', result.parentMessageId)
      }
    }

    if (!deferStreamOutcome) {
      proxyStatusManager.recordRequestSuccess(latency)

      storeManager.incrementAccountUsage(account.id)
    }

    storeManager.addLog('debug', deferStreamOutcome ? `Request stream started` : `Request succeeded`, {
      requestId,
      providerId: provider.id,
      accountId: account.id,
      model: request.model,
      actualModel,
      latency,
      isStream: request.stream,
    })

    const userInput = extractUserInput(request.messages)
    // Prepare response body for logging (only for non-stream requests)
    const responseBodyForLog = !request.stream && result.body
      ? JSON.stringify(result.body)
      : undefined

    // For streaming requests, we'll collect content and update the log later
    let logEntryId: string | undefined

    if (!request.stream) {
      // Non-streaming: record log with response body now
      const logEntry = storeManager.addRequestLog({
        timestamp: startTime,
        status: 'success',
        statusCode: 200,
        method: 'POST',
        url: '/v1/chat/completions',
        model: request.model,
        actualModel,
        providerId: provider.id,
        providerName: provider.name,
        accountId: account.id,
        accountName: account.name,
        requestBody: JSON.stringify(request),
        userInput,
        webSearch: request.web_search,
        reasoningEffort: request.reasoning_effort,
        responseStatus: 200,
        responseBody: responseBodyForLog,
        latency,
        isStream: false,
      })
      logEntryId = logEntry.id
    } else {
      // Streaming: record log now, will update response body later
      const logEntry = storeManager.addRequestLog({
        timestamp: startTime,
        status: 'success',
        statusCode: 200,
        method: 'POST',
        url: '/v1/chat/completions',
        model: request.model,
        actualModel,
        providerId: provider.id,
        providerName: provider.name,
        accountId: account.id,
        accountName: account.name,
        requestBody: JSON.stringify(request),
        userInput,
        webSearch: request.web_search,
        reasoningEffort: request.reasoning_effort,
        responseStatus: 200,
        latency,
        isStream: true,
      })
      logEntryId = logEntry.id
    }

    if (!deferStreamOutcome) {
      storeManager.recordRequestInStats(true, latency, request.model, provider.id, account.id)
    }

    if (request.stream === true && result.stream) {
      ctx.set('Content-Type', 'text/event-stream')
      ctx.set('Cache-Control', 'no-cache')
      ctx.set('Connection', 'keep-alive')
      ctx.set('X-Accel-Buffering', 'no')

      // Create a wrapper stream to handle errors and collect content
      const wrapperStream = new SseKeepAliveStream()

      // Collect stream content for logging (raw SSE output)
      let collectedContent = ''
      let streamOutcomeRecorded = !deferStreamOutcome
      let outputStreamEnded = false
      const sourceStream = result.stream as PassThrough

      const qwenAiStream = QwenAiAdapter.isQwenAiProvider(provider)
        ? sourceStream as QwenAiOutputStream
        : undefined
      const persistCompletedQwenAiToolCallBinding = () => {
        if (qwenAiStream?.qwenAiFailure) return
        consumeQwenAiToolCallClaim('continuation_consumed')
        if (!qwenAiStream) return
        registerQwenAiToolCallSessionBinding(
          qwenAiStream.qwenAiToolCallIds,
          qwenAiStream.qwenAiSessionState,
        )
      }
      const finalizeFailedQwenAiToolCallBinding = (error: Error | undefined) => {
        const status = streamFailureStatus(error, context.signal?.aborted)
        finalizeFailedQwenAiToolCallClaim(
          status === 499 ? undefined : streamFailureCode(error),
          streamFailureAccountFault(error, status),
          streamFailureRetryScope(error, status),
          'terminal_stream_failure',
        )
      }
      const getDeferredStreamSelection = (): AccountSelection => resolveEffectiveSelection(
        { account, provider, actualModel },
        {
          effectiveAccountId: qwenAiStream?.qwenAiEffectiveAccountId,
          effectiveProviderId: qwenAiStream?.qwenAiEffectiveProviderId,
          effectiveActualModel: qwenAiStream?.qwenAiEffectiveActualModel,
        },
      )

      const recordDeferredStreamOutcome = (success: boolean, error?: Error) => {
        if (!deferStreamOutcome || streamOutcomeRecorded) return
        streamOutcomeRecorded = true

        const completionLatency = Date.now() - startTime
        const completionSelection = getDeferredStreamSelection()
        const completionAccount = completionSelection.account
        const completionProvider = completionSelection.provider
        const completionActualModel = completionSelection.actualModel
        if (success) {
          loadBalancer.clearAccountFailure(completionAccount.id)
          proxyStatusManager.recordRequestSuccess(completionLatency)
          storeManager.incrementAccountUsage(completionAccount.id)
          storeManager.recordRequestInStats(
            true,
            completionLatency,
            request.model,
            completionProvider.id,
            completionAccount.id,
          )
          storeManager.addLog('debug', 'Stream response completed', {
            requestId,
            providerId: completionProvider.id,
            accountId: completionAccount.id,
            model: request.model,
            actualModel: completionActualModel,
          })
          if (logEntryId) {
            storeManager.updateRequestLog(logEntryId, {
              actualModel: completionActualModel,
              providerId: completionProvider.id,
              providerName: completionProvider.name,
              accountId: completionAccount.id,
              accountName: completionAccount.name,
              latency: completionLatency,
              responseStatus: 200,
            })
          }
          return
        }

        const failureStatus = streamFailureStatus(
          error as (Error & { status?: unknown }) | undefined,
          context.signal?.aborted,
        )
        const failureCode = streamFailureCode(error)
        const failureAccountFault = streamFailureAccountFault(error, failureStatus)
        const qwenAiFailure = QwenAiAdapter.isQwenAiProvider(completionProvider)
        if (qwenAiFailure) {
          qwenAiRequestGovernor.reportDeferredFailure(completionAccount.id, {
            success: false,
            status: failureStatus,
            headers: streamFailureHeaders(error),
            error: error?.message || 'Unknown Qwen AI stream error',
            errorCode: failureCode,
            retryable: false,
            accountFault: failureAccountFault,
          }, requestIntent.intent)
        }
        proxyStatusManager.recordRequestFailure(completionLatency)
        const shouldPenalizeStreamAccount = failureStatus !== 499 && (
          !qwenAiFailure
            ? failureAccountFault !== false
            : isQwenAiAccountFault({
                accountFault: failureAccountFault,
                status: failureStatus,
                code: failureCode,
                errorCode: failureCode,
                message: error?.message,
              })
        )
        if (shouldPenalizeStreamAccount) {
          if (qwenAiFailure && isQwenAiRiskControl(
            completionProvider.id,
            failureStatus,
            error?.message,
            failureCode,
            true,
          )) {
            loadBalancer.markQwenAiRiskControl(completionAccount.id)
          } else if (failureStatus !== 429) {
            loadBalancer.markAccountFailed(completionAccount.id)
          }
        }
        storeManager.recordRequestInStats(
          false,
          completionLatency,
          request.model,
          completionProvider.id,
          completionAccount.id,
        )
        const failureLogLevel = requestFailureLogLevel(failureStatus)
        storeManager.addLog(
          failureLogLevel,
          `${failureStatus === 499 ? 'Stream response cancelled' : 'Stream response failed'}: ${error?.message || 'Unknown stream error'}`,
          {
            requestId,
            providerId: completionProvider.id,
            accountId: completionAccount.id,
            model: request.model,
            actualModel: completionActualModel,
            status: failureStatus,
            errorCode: failureCode,
          },
        )
        if (logEntryId) {
          storeManager.updateRequestLog(logEntryId, {
            actualModel: completionActualModel,
            providerId: completionProvider.id,
            providerName: completionProvider.name,
            accountId: completionAccount.id,
            accountName: completionAccount.name,
            status: 'error',
            statusCode: failureStatus,
            responseStatus: failureStatus,
            latency: completionLatency,
            errorMessage: error?.message || 'Stream failed',
            errorCode: failureCode,
            responseBody: collectedContent || undefined,
          })
        }
      }

      if (qwenAiStream) {
        qwenAiStream.once(QWEN_AI_STREAM_FAILURE_EVENT, (error: Error) => {
          finalizeFailedQwenAiToolCallBinding(error)
          recordDeferredStreamOutcome(false, error)
        })
        if (qwenAiStream.qwenAiFailure) {
          finalizeFailedQwenAiToolCallBinding(qwenAiStream.qwenAiFailure)
          recordDeferredStreamOutcome(false, qwenAiStream.qwenAiFailure)
        }
      }

      const handleOutputStreamError = (err: Error) => {
        if (outputStreamEnded) return
        outputStreamEnded = true
        finalizeFailedQwenAiToolCallBinding(err)
        const clientCancelled = context.signal?.aborted || isClientCancellationError(err)
        if (clientCancelled) {
          console.log('[Chat] Stream cancelled:', err.message)
        } else {
          console.error('[Chat] Stream error:', err.message)
        }
        recordDeferredStreamOutcome(false, err)

        if (clientCancelled) {
          wrapperStream.end()
          return
        }

        // Kimi's Connect handler deliberately withholds [DONE] when an
        // upstream trailer reports an error. Preserve that signal so clients
        // do not mistake a permission/auth failure for a successful answer.
        if (qwenAiStream || isUpstreamProtocolStreamError(err)) {
          const status = streamFailureStatus(err, context.signal?.aborted)
          const errorType = streamFailureStringField(err, 'type')
          const errorParam = streamFailureStringField(err, 'param')
          const retryable = streamFailureRetryable(err)
          wrapperStream.write(`event: error\ndata: ${JSON.stringify({
            error: {
              message: err.message,
              type: errorType || 'api_error',
              code: streamFailureCode(err) || (qwenAiStream ? 'qwen_ai_stream_error' : 'upstream_stream_error'),
              status,
              ...(retryable === undefined
                ? (qwenAiStream ? { retryable: false } : {})
                : { retryable }),
              ...(errorParam === undefined ? {} : { param: errorParam }),
              ...(streamFailureAccountFault(err, status) === undefined
                ? {}
                : { accountFault: streamFailureAccountFault(err, status) }),
            },
          })}\n\n`)
          if (qwenAiStream) wrapperStream.write('data: [DONE]\n\n')
        } else if (KimiAdapter.isKimiProvider(provider)) {
          wrapperStream.write(`data: ${JSON.stringify({
            error: {
              message: err.message,
              type: 'api_error',
            },
          })}\n\n`)
        } else {
          const errorEvent = {
            id: requestId,
            object: 'chat.completion.chunk',
            created: Math.floor(Date.now() / 1000),
            model: actualModel,
            choices: [{
              index: 0,
              delta: {
                content: `\n\n[Error: ${err.message}]`,
              },
              finish_reason: 'stop',
            }],
          }

          wrapperStream.write(`data: ${JSON.stringify(errorEvent)}\n\n`)
          wrapperStream.write('data: [DONE]\n\n')
        }
        wrapperStream.end()

        if (!deferStreamOutcome) {
          storeManager.addLog(requestFailureLogLevel(streamFailureStatus(err)), `Stream error: ${err.message}`, {
            requestId,
            providerId: provider.id,
            accountId: account.id,
            model: request.model,
          })
        }
      }

      // Check if stream is already in correct SSE format (from adapters like Kimi, GLM, DeepSeek)
      if (result.skipTransform) {
        // Built-in adapters already emit OpenAI-compatible SSE. Enforce the
        // reserved assistant-output boundary once more at the route edge so
        // every provider and visible text channel receives the same policy.
        const guardedStream = createAssistantOutputBoundaryStream()
        sourceStream.once('error', (error: Error) => guardedStream.destroy(error))
        guardedStream.once('error', (error: Error) => {
          if (!sourceStream.destroyed) sourceStream.destroy()
          handleOutputStreamError(error)
        })

        guardedStream.on('data', (chunk: Buffer) => {
          collectedContent += chunk.toString()
        })

        sourceStream.pipe(guardedStream)
        guardedStream.pipe(wrapperStream, { end: false })

        // When source stream ends normally, update log and end wrapper
        guardedStream.once('end', () => {
          if (outputStreamEnded) return
          outputStreamEnded = true
          const qwenAiFailure = qwenAiStream?.qwenAiFailure
          recordDeferredStreamOutcome(!qwenAiFailure, qwenAiFailure)
          persistCompletedQwenAiToolCallBinding()
          // Update log with collected response
          if (logEntryId) {
            storeManager.updateRequestLog(logEntryId, {
              latency: Date.now() - startTime,
              responseBody: collectedContent || undefined,
            })
          }
          wrapperStream.end()
        })
      } else {
        // Need to transform the stream
        const transformStream = streamHandler.createTransformStream(
          actualModel,
          requestId,
          () => {
            storeManager.addLog('debug', `Stream response completed`, { requestId })
          }
        )
        const guardedStream = createAssistantOutputBoundaryStream()
        sourceStream.once('error', (error: Error) => transformStream.destroy(error))
        transformStream.once('error', (error: Error) => guardedStream.destroy(error))
        guardedStream.once('error', (error: Error) => {
          if (!sourceStream.destroyed) sourceStream.destroy()
          handleOutputStreamError(error)
        })

        // Collect from transform stream output
        guardedStream.on('data', (chunk: Buffer) => {
          collectedContent += chunk.toString()
        })

        sourceStream.pipe(transformStream)
        transformStream.pipe(guardedStream)
        guardedStream.pipe(wrapperStream, { end: false })

        guardedStream.once('end', () => {
          if (outputStreamEnded) return
          outputStreamEnded = true
          persistCompletedQwenAiToolCallBinding()
          // Update log with collected response
          if (logEntryId) {
            storeManager.updateRequestLog(logEntryId, {
              responseBody: collectedContent || undefined,
            })
          }
          wrapperStream.end()
        })
      }

      ctx.body = wrapperStream
    } else {
      ctx.set('Content-Type', 'application/json')

      consumeQwenAiToolCallClaim('continuation_consumed')
      registerQwenAiToolCallSessionBinding(
        result.qwenAiToolCallIds,
        result.qwenAiSessionState,
      )

      if (result.body) {
        // Check if we need to transform to Anthropic format
        if (isAnthropicToolFormat(request.tool_format)) {
          ctx.body = transformResponseToAnthropic(result.body)
          console.log('[Chat] Transformed response to Anthropic tool format')
        } else {
          ctx.body = result.body
        }
      } else {
        ctx.body = {
          id: requestId,
          object: 'chat.completion',
          created: Math.floor(Date.now() / 1000),
          model: actualModel,
          choices: [{
            index: 0,
            message: {
              role: 'assistant',
              content: '',
            },
            finish_reason: 'stop',
          }],
          usage: {
            prompt_tokens: 0,
            completion_tokens: 0,
            total_tokens: 0,
          },
        }
      }
    }
  } catch (error) {
    const caughtError = error instanceof Error ? error : undefined
    const latency = Date.now() - startTime
    proxyStatusManager.recordRequestFailure(latency)

    const errorMessage = error instanceof Error ? error.message : 'Unknown error'
    const errorStack = error instanceof Error ? error.stack : undefined
    const clientCancelled = context.signal?.aborted || isClientCancellationError(error)
    const errorStatus = clientCancelled ? 499 : 500
    finalizeFailedQwenAiToolCallClaim(
      errorStatus === 499 ? undefined : streamFailureCode(caughtError),
      streamFailureAccountFault(caughtError, errorStatus),
      streamFailureRetryScope(caughtError, errorStatus),
      'request_exception',
    )

    ctx.status = errorStatus
    ctx.body = {
      error: {
        message: errorMessage,
        type: 'internal_error',
        param: null,
        code: null,
      },
    }

    storeManager.addLog(clientCancelled ? 'debug' : 'error', `${clientCancelled ? 'Request cancelled' : 'Request exception'}: ${errorMessage}`, {
      requestId,
      providerId: provider.id,
      accountId: account.id,
      model: request.model,
      latency,
      error: errorMessage,
    })

    const userInput = extractUserInput(request.messages)
    const exceptionResponseBody = JSON.stringify({
      error: {
        message: errorMessage,
        type: 'internal_error',
        param: null,
        code: null,
      },
    })
    storeManager.addRequestLog({
      timestamp: startTime,
      status: 'error',
      statusCode: errorStatus,
      method: 'POST',
      url: '/v1/chat/completions',
      model: request.model,
      actualModel,
      providerId: provider.id,
      providerName: provider.name,
      accountId: account.id,
      accountName: account.name,
      requestBody: JSON.stringify(request),
      userInput,
      webSearch: request.web_search,
      reasoningEffort: request.reasoning_effort,
      responseStatus: errorStatus,
      responseBody: exceptionResponseBody,
      latency,
      isStream: request.stream || false,
      errorMessage,
      errorStack,
    })

    storeManager.recordRequestInStats(false, latency, request.model, provider.id, account.id)
  }
})

export default router
