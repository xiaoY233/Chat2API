/**
 * Qwen AI International Adapter
 * Implements chat.qwen.ai API protocol
 * Based on qwen3-reverse project
 */

import axios, { AxiosResponse } from 'axios'
import { PassThrough } from 'stream'
import { performance } from 'node:perf_hooks'
import { createParser } from 'eventsource-parser'
import { Account, Provider } from '../../store/types'
import type { ChatMessage } from '../types'
import type { ProviderModelCapability } from '../../../shared/types'
import { hasToolUse, parseToolUse } from '../promptToolUse'
import {
  hasQwenAiSessionCookie,
  QwenAiTokenRefresher,
  resolveQwenAiAuthHeaders,
} from './qwen-ai-token-refresh'
import {
  QwenAiFileUploader,
  QWEN_AI_DOCUMENT_EVIDENCE_MARKER,
  prepareQwenAiMultimodalMessage,
  type QwenAiDirectUploadInput,
  type QwenAiDirectUploadStartResult,
  type QwenAiManagedDocumentMode,
  type QwenAiMessageTransport,
} from './qwen-ai-files'
import { createBaseChunk } from '../utils/streamToolHandler'
import { isClientCancellationError, sanitizeForwardedErrorHeaders } from '../utils/errors'
import { ToolStreamParser } from '../toolCalling/ToolStreamParser'
import type { ToolCallingPlan } from '../toolCalling/types'
import { getToolProtocol } from '../toolCalling/protocols'
import {
  ManagedToolResultGuard,
  stripManagedToolResultWrappers,
  type ManagedToolResultGuardOutput,
} from '../toolCalling/managedToolResultGuard'
import {
  hasManagedWorkflowCompletionMarker,
  parseManagedWorkflowCompletionProof,
  requiresManagedWorkflowCompletionMarker,
} from '../toolCalling/workflowCompletion'
import {
  getToolArgumentValidationIssues,
  normalizeArguments,
} from '../toolCalling/protocols/shared'
import {
  getToolStreamValidationFailure,
  type ToolStreamValidationFailure,
} from '../toolCalling/streamValidationPolicy'
import type { ToolCall } from '../types'
import {
  isCompleteJsonText,
  mergeNativeToolArguments,
  mergeNativeToolName,
  normalizeNativeFunctionCallDelta,
  type NativeToolCallState,
} from './qwen-ai-native-tools'
import { createQwenAiFeatureConfig } from './qwen-ai-feature-config'
import {
  normalizeQwenAiModelModeName,
  resolveQwenAiModelMode,
} from '../../providers/qwen-ai-model-mode'
import type { QwenAiSessionState } from '../qwenAiSessionBridge'

const QWEN_AI_BASE = 'https://chat.qwen.ai'
const QWEN_AI_REQUEST_TIMEOUT_MS = positiveNumberFromEnv('QWEN_AI_REQUEST_TIMEOUT_MS', 840000)
const QWEN_AI_RESPONSE_TIMEOUT_MS = nonNegativeNumberFromEnv('QWEN_AI_RESPONSE_TIMEOUT_MS', 0)
const QWEN_AI_STREAM_IDLE_TIMEOUT_MS = positiveNumberFromEnv('QWEN_AI_STREAM_IDLE_TIMEOUT_MS', 180000)
const QWEN_AI_REQUEST_MAX_BYTES_DEFAULT = 90 * 1024
const QWEN_AI_MANAGED_BRANCH_MAX_BYTES = positiveNumberFromEnv(
  'CHAT2API_QWEN_AI_VALIDATED_STREAM_MAX_BYTES',
  16 * 1024 * 1024,
)
const QWEN_AI_DEBUG_PAYLOAD_LOGS = process.env.CHAT2API_QWEN_AI_DEBUG_PAYLOADS === 'true'
const QWEN_AI_DEBUG_STREAM_LOGS = process.env.CHAT2API_QWEN_AI_DEBUG_STREAM === 'true'
const QWEN_AI_DEBUG_REQUEST_LOGS = process.env.CHAT2API_QWEN_AI_DEBUG_REQUEST === 'true'
const QWEN_AI_CHAT_IN_PROGRESS_MAX_DELAY_MS = 60_000
const QWEN_AI_CHAT_IN_PROGRESS_DEFAULT_RETRY_ATTEMPTS = 5
const QWEN_AI_CHAT_IN_PROGRESS_DEFAULT_RETRY_DELAY_MS = 1_000
// Busy-chat admission is a short provider-state wait, not the generation
// timeout. Keep the default bounded while allowing deployments to tune it.
const QWEN_AI_CHAT_IN_PROGRESS_DEFAULT_RETRY_BUDGET_MS = 120_000
const QWEN_AI_CHAT_IN_PROGRESS_MAX_CONFIGURED_ATTEMPTS = 1_000
// Retained Responses tool-result continuations are followed immediately by
// a client request. A busy retained chat should be handed to the forwarder's
// same-account full replay path instead of making Claude wait on backoff.
const QWEN_AI_RESPONSES_CONTINUATION_DEFAULT_RETRY_ATTEMPTS = 0
// Recovery time is shared by response-id resumes and managed workflow
// continuations. It pauses while a replacement stream is producing output,
// so a valid long generation is not cut off by this guard.
const QWEN_AI_RECOVERY_DEFAULT_BUDGET_MS = 180_000
const QWEN_AI_RECOVERY_MAX_BUDGET_MS = 30 * 60 * 1_000
// Once semantic recovery starts, every replacement branch belongs to one
// logical recovery episode. Bound its total wall time even while Qwen keeps
// producing progress that would otherwise pause the no-progress budget.
const QWEN_AI_WORKFLOW_RECOVERY_DEFAULT_TIMEOUT_MS = 840_000
const QWEN_AI_WORKFLOW_RECOVERY_MAX_TIMEOUT_MS = 30 * 60 * 1_000

export const QWEN_AI_STREAM_FAILURE_EVENT = 'qwen-ai-stream-failure'

export type QwenAiOutputStream = PassThrough & {
  qwenAiFailure?: Error
  qwenAiEffectiveAccountId?: string
  qwenAiEffectiveProviderId?: string
  qwenAiEffectiveActualModel?: string
  /**
   * Live state for a completed Responses API Qwen turn. The forwarder owns
   * its metadata; the stream handler publishes it after learning Qwen's real
   * response ID.
   */
  qwenAiSessionState?: QwenAiSessionState
  /** Final client-visible tool IDs, published only after a valid terminal turn. */
  qwenAiToolCallIds?: string[]
}

const DEFAULT_HEADERS = {
  Accept: 'application/json',
  'Accept-Language': 'zh-CN,zh;q=0.9',
  'Content-Type': 'application/json',
  source: 'web',
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36',
  'sec-ch-ua': '"Not:A-Brand";v="99", "Google Chrome";v="145", "Chromium";v="145"',
  'sec-ch-ua-mobile': '?0',
  'sec-ch-ua-platform': '"macOS"',
  'Sec-Fetch-Dest': 'empty',
  'Sec-Fetch-Mode': 'cors',
  'Sec-Fetch-Site': 'same-origin',
  Version: '0.2.67',
  Origin: 'https://chat.qwen.ai',
}

const MODEL_ALIASES: Record<string, string> = {
  qwen: 'qwen3.7-max',
  qwen3: 'qwen3.7-max',
  'qwen3.8': 'qwen3.8-max',
  'qwen3.8-max': 'qwen3.8-max',
  'qwen3.8-max-preview': 'qwen3.8-max-preview',
  'qwen3.7': 'qwen3.7-max',
  'qwen3.7-plus': 'qwen3.7-plus',
  'qwen3.6': 'qwen3.6-plus',
  'qwen3.6-35b': 'qwen3.6-35b-a3b',
  'qwen3.6-27b': 'qwen3.6-27b',
  'qwen3-coder': 'qwen3-coder-plus',
}

type QwenAiMessage = ChatMessage

type StreamHandlingOptions = {
  signal?: AbortSignal
  /**
   * Responses API metadata owned by the forwarder. It is copied to the
   * output stream only after Qwen has supplied a real response ID.
   */
  qwenAiSessionState?: QwenAiSessionState
  /** Absolute deadline for the complete route request, including active SSE. */
  requestDeadlineAt?: number
  responseTimeoutMs?: number
  idleTimeoutMs?: number
  /** Withhold managed-tool frames until the response branch passes validation. */
  bufferManagedBranch?: boolean
  /** Accept a provider response that contains only thinking/summary text. */
  allowReasoningOnlyOutput?: boolean
  /** Emit accepted reasoning-only text as assistant content for summary turns. */
  reasoningOnlyAsContent?: boolean
  onFailure?: (error: Error) => void
  recoverFromIdle?: QwenAiRecoveryCallback
  recoverFromSemanticEmpty?: QwenAiRecoveryCallback
}

type QwenAiRecoveryCallback = (error: Error, onResume?: () => void) => Promise<boolean>

type QwenAiResumableStreamOptions = {
  signal?: AbortSignal
  getResponseId: () => string
  /** Classify parsed branch state before a source end becomes a transport failure. */
  getSemanticRecoveryError?: () => Error | undefined
  resume?: (responseId: string, signal?: AbortSignal) => Promise<any>
  /**
   * Start a new user-turn generation in the existing chat when a semantic
   * completion leaves the response-id branch unusable. This callback must
   * submit only the continuation turn; it must never replay the original
   * request.
   */
  continueWorkflow?: (
    parentResponseId: string,
    recoveryError?: Error,
    signal?: AbortSignal,
  ) => Promise<any>
  /**
   * Recreate the provider chat on the same credential and replay the complete
   * request after Qwen declares the current response id permanently ended.
   */
  restartFreshChat?: (recoveryError: Error, signal?: AbortSignal) => Promise<any>
  /** Same-account full replay specifically for a retained chat that vanished. */
  restartStaleSession?: (recoveryError: Error, signal?: AbortSignal) => Promise<any>
  /** Reset provider/parser state before a fresh workflow stream is attached. */
  onWorkflowContinuation?: () => void
  /** Reset provider/parser state before a same-account fresh chat is attached. */
  onFreshChatRestart?: () => void
  /** Return true once the adapter has emitted a terminal response. */
  isComplete?: () => boolean
  maxAttempts?: number
  delayMs?: number
  workflowContinuationAttempts?: number
  /** Shared budget for one or more no-progress recovery episodes. */
  recoveryBudgetMs?: number
  /** Absolute wall time across all managed workflow continuation branches. */
  workflowRecoveryTimeoutMs?: number
  /** Existing request deadline used to leave time for outer proxies to reply. */
  workflowRecoveryDeadlineAt?: number
}

export type QwenAiResumableStream = PassThrough & {
  /** Replace a semantically stalled source with Qwen's response-id continuation. */
  recoverFromIdle: QwenAiRecoveryCallback
}

interface ChatCompletionRequest {
  model: string
  /** Correlation identifier generated at the OpenAI-compatible boundary. */
  requestId?: string
  /** Original model name before mapping (used for feature detection like thinking mode) */
  originalModel?: string
  messages: QwenAiMessage[]
  stream?: boolean
  temperature?: number
  enable_thinking?: boolean
  thinking_budget?: number
  /** Client-declared tools are encoded in Chat2API's managed text protocol. */
  managedToolCalling?: boolean
  /** Keep the immediately preceding tool exchange inline with document transport. */
  managedToolWorkflowContinuation?: boolean
  /** Internal hint set by an OpenAI Responses image_generation tool request. */
  image_generation?: {
    enabled: true
    size?: string
    model?: string
    quality?: string
    format?: string
    action?: 'auto' | 'generate' | 'edit'
  }
  chatId?: string
  signal?: AbortSignal
  /** Absolute deadline shared by admission, upload, generation, and recovery. */
  deadlineAt?: number
  /** Remaining budget supplied by the outer same-account busy retry loop. */
  timeoutMs?: number
  /** Selects how the complete converted conversation reaches Qwen. */
  messageTransport?: QwenAiMessageTransport
}

interface QwenAiWorkflowContinuationRequest {
  chatId: string
  parentId: string
  model: string
  originalModel?: string
  /** Legacy text-only continuation payload. */
  content?: string
  /**
   * Delta OpenAI messages for a native Qwen continuation. This preserves
   * tool-result attachments through the ordinary multimodal uploader.
   */
  messages?: QwenAiMessage[]
  enable_thinking?: boolean
  thinking_budget?: number
  managedToolCalling?: boolean
  managedToolWorkflowContinuation?: boolean
  messageTransport?: QwenAiMessageTransport
  /** Per-call override for same-chat CHAT_IN_PROGRESS retries. */
  chatInProgressRetryAttempts?: number
  signal?: AbortSignal
  deadlineAt?: number
}

function positiveNumberFromEnv(name: string, fallback: number): number {
  const raw = process.env[name]
  if (!raw) return fallback
  const value = Number(raw)
  return Number.isFinite(value) && value > 0 ? value : fallback
}

function nonNegativeNumberFromEnv(name: string, fallback: number): number {
  const raw = process.env[name]
  if (raw === undefined || raw.trim() === '') return fallback
  const value = Number(raw)
  return Number.isFinite(value) && value >= 0 ? value : fallback
}

function nonNegativeIntegerFromEnv(name: string, fallback: number): number {
  const raw = process.env[name]
  if (raw === undefined || raw.trim() === '') return fallback
  const value = Number(raw)
  return Number.isInteger(value) && value >= 0 ? value : fallback
}

function estimateQwenAiTranscriptTokens(value: string): number {
  let asciiChars = 0
  let nonAsciiCodePoints = 0
  for (const codePoint of value) {
    if ((codePoint.codePointAt(0) || 0) <= 0x7f) asciiChars += 1
    else nonAsciiCodePoints += 1
  }
  return Math.ceil(asciiChars / 3) + nonAsciiCodePoints
}

export function qwenAiRequestTimeoutMsFromEnv(): number {
  return QWEN_AI_REQUEST_TIMEOUT_MS
}

export function qwenAiRequestMaxBytesFromEnv(): number {
  return Math.floor(nonNegativeNumberFromEnv(
    'CHAT2API_QWEN_AI_REQUEST_MAX_BYTES',
    QWEN_AI_REQUEST_MAX_BYTES_DEFAULT,
  ))
}

export function qwenAiSerializedPayloadBytes(payload: unknown): number {
  return Buffer.byteLength(JSON.stringify(payload), 'utf8')
}

export function qwenAiStreamResumeAttemptsFromEnv(): number {
  return Math.min(
    10,
    nonNegativeIntegerFromEnv('CHAT2API_QWEN_AI_STREAM_RESUME_ATTEMPTS', 3),
  )
}

export function qwenAiStreamResumeDelayMsFromEnv(): number {
  return Math.min(
    60_000,
    nonNegativeIntegerFromEnv('CHAT2API_QWEN_AI_STREAM_RESUME_DELAY_MS', 1_000),
  )
}

export function qwenAiWorkflowContinuationAttemptsFromEnv(): number {
  const raw = process.env.CHAT2API_QWEN_AI_WORKFLOW_CONTINUATION_ATTEMPTS
  if (raw === undefined || raw.trim() === '' || /^auto$/i.test(raw.trim())) {
    return 1
  }

  const value = Number(raw)
  if (!Number.isSafeInteger(value) || value < 0) return 1
  return value
}

/**
 * Qwen may reject a same-chat follow-up while the previous response is still
 * being finalized. These are retries of the exact same continuation payload,
 * not new turns. Keep the budget configurable and bounded so an upstream
 * queue cannot hold a client request forever.
 */
export function qwenAiChatInProgressRetryModeFromEnv(): 'attempts' | 'deadline' {
  const explicitMode = process.env.CHAT2API_QWEN_AI_CHAT_IN_PROGRESS_RETRY_MODE?.trim().toLowerCase()
  if (explicitMode === 'deadline') return 'deadline'
  if (explicitMode === 'attempts') return 'attempts'

  // An omitted/blank attempts value is the deployment's opt-in to deadline
  // mode. A non-blank value keeps the legacy explicit-attempt policy. This
  // makes the default configurable without tying behavior to any client.
  const rawAttempts = process.env.CHAT2API_QWEN_AI_CHAT_IN_PROGRESS_RETRY_ATTEMPTS
  return rawAttempts === undefined || rawAttempts.trim() === '' ? 'deadline' : 'attempts'
}

export function qwenAiChatInProgressRetryAttemptsFromEnv(): number | undefined {
  if (qwenAiChatInProgressRetryModeFromEnv() === 'deadline') return undefined

  return Math.min(
    QWEN_AI_CHAT_IN_PROGRESS_MAX_CONFIGURED_ATTEMPTS,
    nonNegativeIntegerFromEnv(
      'CHAT2API_QWEN_AI_CHAT_IN_PROGRESS_RETRY_ATTEMPTS',
      QWEN_AI_CHAT_IN_PROGRESS_DEFAULT_RETRY_ATTEMPTS,
    ),
  )
}

export function qwenAiChatInProgressRetryDelayMsFromEnv(): number {
  return Math.min(
    QWEN_AI_CHAT_IN_PROGRESS_MAX_DELAY_MS,
    nonNegativeIntegerFromEnv(
      'CHAT2API_QWEN_AI_CHAT_IN_PROGRESS_RETRY_DELAY_MS',
      QWEN_AI_CHAT_IN_PROGRESS_DEFAULT_RETRY_DELAY_MS,
    ),
  )
}

/**
 * Retry policy for a retained Responses tool-result continuation. This is
 * intentionally independent from semantic workflow recovery: a busy retained
 * chat can be replaced by a same-account full replay immediately.
 */
export function qwenAiResponsesContinuationRetryAttemptsFromEnv(): number {
  return Math.min(
    QWEN_AI_CHAT_IN_PROGRESS_MAX_CONFIGURED_ATTEMPTS,
    nonNegativeIntegerFromEnv(
      'CHAT2API_QWEN_AI_RESPONSES_CONTINUATION_RETRY_ATTEMPTS',
      QWEN_AI_RESPONSES_CONTINUATION_DEFAULT_RETRY_ATTEMPTS,
    ),
  )
}

/**
 * Return the effective busy-chat retry window for the current deployment.
 * Deadline mode uses its own admission budget, capped by the normal upstream
 * request timeout. An explicit attempt cap retains the legacy count contract.
 */
export function qwenAiChatInProgressRetryBudgetMsFromEnv(): number {
  const configuredBudgetMs = nonNegativeNumberFromEnv(
    'CHAT2API_QWEN_AI_CHAT_IN_PROGRESS_RETRY_BUDGET_MS',
    -1,
  )
  if (configuredBudgetMs >= 0) {
    return Math.min(QWEN_AI_REQUEST_TIMEOUT_MS, configuredBudgetMs)
  }

  const attempts = qwenAiChatInProgressRetryAttemptsFromEnv()
  if (attempts === undefined) {
    return Math.min(
      QWEN_AI_REQUEST_TIMEOUT_MS,
      QWEN_AI_CHAT_IN_PROGRESS_DEFAULT_RETRY_BUDGET_MS,
    )
  }

  // Explicit-attempt mode retains the legacy retry-count contract. The
  // request timeout remains the upper bound for each admission call; the
  // attempt count itself supplies the finite retry budget.
  return QWEN_AI_REQUEST_TIMEOUT_MS
}

/**
 * Return the bounded budget spent recovering a stalled Qwen response. A zero
 * value disables recovery attempts for deployments that prefer a fast error.
 */
export function qwenAiRecoveryBudgetMsFromEnv(): number {
  return Math.min(
    QWEN_AI_RECOVERY_MAX_BUDGET_MS,
    nonNegativeNumberFromEnv(
      'CHAT2API_QWEN_AI_RECOVERY_BUDGET_MS',
      QWEN_AI_RECOVERY_DEFAULT_BUDGET_MS,
    ),
  )
}

export function qwenAiWorkflowRecoveryTimeoutMsFromEnv(): number {
  return Math.min(
    QWEN_AI_WORKFLOW_RECOVERY_MAX_TIMEOUT_MS,
    nonNegativeNumberFromEnv(
      'CHAT2API_QWEN_AI_WORKFLOW_RECOVERY_TIMEOUT_MS',
      QWEN_AI_WORKFLOW_RECOVERY_DEFAULT_TIMEOUT_MS,
    ),
  )
}

/**
 * Wait for a retry while still honoring downstream cancellation. A boolean
 * result avoids turning an abort into an ordinary upstream protocol error.
 */
export function waitForQwenAiRetry(delayMs: number, signal?: AbortSignal): Promise<boolean> {
  const boundedDelay = Math.max(0, Math.min(QWEN_AI_CHAT_IN_PROGRESS_MAX_DELAY_MS, delayMs))
  if (signal?.aborted) return Promise.resolve(false)
  if (boundedDelay === 0) return Promise.resolve(!signal?.aborted)

  return new Promise<boolean>(resolve => {
    let timer: NodeJS.Timeout | undefined
    let settled = false

    const finish = (result: boolean) => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      resolve(result && !signal?.aborted)
    }

    const onAbort = () => finish(false)
    timer = setTimeout(() => finish(true), boundedDelay)
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

/**
 * Decide whether a parsed SSE message represents provider progress.
 *
 * Qwen can keep an HTTP response open with SSE comments or empty/heartbeat
 * events. Those bytes prove that the socket is alive, but they do not prove
 * that generation is making progress. The idle budget must therefore be
 * refreshed after parsing a meaningful event, rather than for every raw
 * network buffer.
 */
function isMeaningfulQwenAiEvent(
  event: { data?: unknown },
  previousSummaryLength = 0,
): boolean {
  const raw = typeof event.data === 'string' ? event.data.trim() : ''
  if (!raw) return false
  if (raw === '[DONE]') return true

  let data: unknown
  try {
    data = JSON.parse(raw)
  } catch {
    // A non-JSON event is handled as an upstream error by the parser. Count
    // it as activity so the resulting error is reported immediately.
    return true
  }

  if (!isObjectValue(data)) return false
  if (data.error || data.errors || data.ret) return true
  // response.created is not generated content and cannot complete a request,
  // but it proves that Qwen is still emitting upstream state. Keep the idle
  // watchdog alive; the separate response timeout remains the hard fallback.
  if (data['response.created']) return true

  const choices = data.choices
  if (!Array.isArray(choices)) return false

  return choices.some((choice) => {
    if (!isObjectValue(choice)) return false
    const delta = isObjectValue(choice.delta) ? choice.delta : undefined
    if (!delta) return typeof choice.finish_reason === 'string' && Boolean(choice.finish_reason)

    const content = delta.content
    const reasoning = delta.reasoning_content
    const generatedImages = isQwenAiImageGenerationPhase(delta.phase)
      ? extractQwenAiGeneratedImages(delta.extra)
      : []
    const summaryText = isObjectValue(delta.extra)
      && isObjectValue(delta.extra.summary_thought)
      && Array.isArray(delta.extra.summary_thought.content)
      ? delta.extra.summary_thought.content
        .filter((part: unknown): part is string => typeof part === 'string')
        .join('\n')
      : ''

    return (typeof content === 'string' && content.length > 0)
      || (typeof reasoning === 'string' && reasoning.length > 0)
      || generatedImages.length > 0
      || (delta.phase === 'thinking_summary' && summaryText.length > previousSummaryLength)
      || (delta.status === 'finished' && (delta.phase === 'answer' || delta.phase === null))
      || (typeof choice.finish_reason === 'string' && Boolean(choice.finish_reason))
  })
}

function destroyReadableStream(stream: any, error?: Error): void {
  if (!stream) return

  if (typeof stream.destroy === 'function') {
    stream.destroy(error)
    return
  }

  if (typeof stream.abort === 'function') {
    stream.abort()
  }
}

/**
 * Identify transient transport failures without treating provider responses
 * (401/403/429/5xx) as transport failures. This is deliberately protocol
 * neutral so the same classification can be used before a stream exists and
 * while an accepted stream is being resumed.
 */
export function isQwenAiTransientTransportError(error: unknown): boolean {
  if (!error || isClientCancellationError(error)) return false

  const queue: unknown[] = [error]
  const visited = new Set<object>()
  const evidence: string[] = []

  while (queue.length > 0 && visited.size < 32) {
    const value = queue.shift()
    if (!value || typeof value !== 'object') {
      if (typeof value === 'string') evidence.push(value)
      continue
    }

    const record = value as Record<string, unknown>
    if (visited.has(record)) continue
    visited.add(record)

    const status = record.status ?? record.statusCode ?? record.status_code
    if (typeof status === 'number' && status >= 400) return false
    if (typeof status === 'string' && /^\d{3}$/.test(status) && Number(status) >= 400) return false

    for (const field of ['code', 'errorCode', 'error_code', 'name', 'message']) {
      const candidate = record[field]
      if (typeof candidate === 'string') evidence.push(candidate)
    }
    for (const field of ['cause', 'original_exception', 'originalException', 'originalError']) {
      if (record[field] !== undefined) queue.push(record[field])
    }
  }

  return /EAI_AGAIN|ENOTFOUND|EHOSTUNREACH|ENETUNREACH|ECONNREFUSED|ECONNRESET|ECONNABORTED|ERR_STREAM_PREMATURE_CLOSE|ERR_NETWORK|ERR_SOCKET|socket hang up|premature close|network error/i.test(
    evidence.join(' '),
  )
}

function isResumableQwenAiTransportError(error: unknown): boolean {
  return isQwenAiTransientTransportError(error)
}

/**
 * Keep a Qwen SSE response alive across recoverable provider failures.
 * Interrupted generations resume by response id; semantically completed but
 * unfinished managed-tool turns may start same-chat continuations while Qwen
 * keeps making meaningful progress.
 * Keeping both paths below the protocol adapter makes them transparent to
 * compatible downstream clients.
 */
export function createQwenAiResumableStream(
  initialStream: any,
  options: QwenAiResumableStreamOptions,
): QwenAiResumableStream {
  const bridge = new PassThrough() as QwenAiResumableStream
  const maxAttempts = Math.max(0, options.maxAttempts ?? qwenAiStreamResumeAttemptsFromEnv())
  const delayMs = Math.max(0, options.delayMs ?? qwenAiStreamResumeDelayMsFromEnv())
  const configuredWorkflowContinuationAttempts = options.workflowContinuationAttempts
    ?? qwenAiWorkflowContinuationAttemptsFromEnv()
  const workflowContinuationAttemptLimit = Math.max(
    0,
    Math.floor(configuredWorkflowContinuationAttempts),
  )

  let source = initialStream
  let sourceGeneration = 0
  let sourceHandled = false
  let sourceComplete = false
  let terminalMarkerSeen = false
  let recoveryInFlight = false
  let activeRecovery: Promise<boolean> | undefined
  let recoveryResumed = false
  let recoveryResumeCallbacks: Array<() => void> = []
  let attempts = 0
  let workflowContinuationAttempts = 0
  let freshChatRestartAttempts = 0
  let transientFreshChatRecoveryEligible = false
  let staleSessionRecoveryEligible = false
  let settled = false
  let settledError: Error | undefined
  const configuredRecoveryBudgetMs = options.recoveryBudgetMs ?? qwenAiRecoveryBudgetMsFromEnv()
  let recoveryBudgetRemainingMs = Number.isFinite(configuredRecoveryBudgetMs)
    ? Math.max(0, configuredRecoveryBudgetMs)
    : qwenAiRecoveryBudgetMsFromEnv()
  let recoveryBudgetStartedAt: number | undefined
  let recoveryBudgetTimer: NodeJS.Timeout | undefined
  let recoveryBudgetController: AbortController | undefined
  let recoveryBudgetClientAbort: (() => void) | undefined
  let recoveryBudgetExpired = false
  let recoveryBudgetEffectiveTimerMs = 0
  const configuredWorkflowRecoveryTimeoutMs = options.workflowRecoveryTimeoutMs
    ?? qwenAiWorkflowRecoveryTimeoutMsFromEnv()
  const workflowRecoveryTimeoutMs = Number.isFinite(configuredWorkflowRecoveryTimeoutMs)
    ? Math.max(0, configuredWorkflowRecoveryTimeoutMs)
    : qwenAiWorkflowRecoveryTimeoutMsFromEnv()
  const workflowRecoveryRequestDeadlineAt = Number.isFinite(options.workflowRecoveryDeadlineAt)
    ? Math.max(0, options.workflowRecoveryDeadlineAt || 0)
    : undefined
  const requestDeadlineExpired = () => workflowRecoveryRequestDeadlineAt !== undefined
    && Date.now() >= workflowRecoveryRequestDeadlineAt
  const effectiveRecoveryBudgetError = () => requestDeadlineExpired()
    ? createQwenAiRequestTimeoutError()
    : createQwenAiRecoveryBudgetError()
  const effectiveWorkflowRecoveryTimeoutError = () => requestDeadlineExpired()
    ? createQwenAiRequestTimeoutError()
    : createQwenAiWorkflowRecoveryTimeoutError()
  let workflowRecoveryStartedAt: number | undefined
  let workflowRecoveryEffectiveTimeoutMs = 0
  let workflowRecoveryTimer: NodeJS.Timeout | undefined
  let workflowRecoveryController: AbortController | undefined
  let workflowRecoveryExpired = false
  let linkedRecoverySignalCleanup: (() => void) | undefined

  type SourceListeners = {
    data: (chunk: Buffer | string) => void
    error: (error: Error) => void
    end: () => void
    close: () => void
  }

  // Keep the exact callbacks installed by this bridge. The response stream
  // may also have listeners owned by Axios or the protocol parser; removing
  // those with removeAllListeners() can break cancellation and parsing.
  const sourceListeners = new Map<any, SourceListeners>()
  let completionScan = ''
  let completionCheckError: Error | undefined

  const pauseRecoveryBudget = (abortInFlight = false) => {
    const controller = recoveryBudgetController
    if (recoveryBudgetStartedAt !== undefined) {
      recoveryBudgetRemainingMs = Math.max(
        0,
        recoveryBudgetRemainingMs - (performance.now() - recoveryBudgetStartedAt),
      )
    }
    recoveryBudgetStartedAt = undefined
    recoveryBudgetEffectiveTimerMs = 0
    if (recoveryBudgetTimer) {
      clearTimeout(recoveryBudgetTimer)
      recoveryBudgetTimer = undefined
    }
    if (recoveryBudgetClientAbort) {
      options.signal?.removeEventListener('abort', recoveryBudgetClientAbort)
      recoveryBudgetClientAbort = undefined
    }
    recoveryBudgetController = undefined
    if (abortInFlight && controller && !controller.signal.aborted) {
      controller.abort()
    }
  }

  const releaseLinkedRecoverySignal = () => {
    linkedRecoverySignalCleanup?.()
    linkedRecoverySignalCleanup = undefined
  }

  const stopWorkflowRecoveryDeadline = (abortInFlight = false) => {
    const controller = workflowRecoveryController
    if (workflowRecoveryTimer) {
      clearTimeout(workflowRecoveryTimer)
      workflowRecoveryTimer = undefined
    }
    workflowRecoveryController = undefined
    workflowRecoveryStartedAt = undefined
    workflowRecoveryEffectiveTimeoutMs = 0
    if (abortInFlight && controller && !controller.signal.aborted) {
      controller.abort()
    }
    releaseLinkedRecoverySignal()
  }

  const startRecoveryBudget = (): AbortSignal | undefined => {
    if (recoveryBudgetStartedAt !== undefined) return recoveryBudgetController?.signal
    if (recoveryBudgetRemainingMs <= 0) return undefined

    const requestRemainingMs = workflowRecoveryRequestDeadlineAt === undefined
      ? Number.POSITIVE_INFINITY
      : Math.max(0, workflowRecoveryRequestDeadlineAt - Date.now())
    recoveryBudgetEffectiveTimerMs = Math.min(
      recoveryBudgetRemainingMs,
      requestRemainingMs,
    )
    if (recoveryBudgetEffectiveTimerMs <= 0) {
      recoveryBudgetExpired = true
      return undefined
    }

    recoveryBudgetStartedAt = performance.now()
    recoveryBudgetExpired = false
    recoveryBudgetController = new AbortController()
    recoveryBudgetClientAbort = () => recoveryBudgetController?.abort()
    options.signal?.addEventListener('abort', recoveryBudgetClientAbort, { once: true })
    if (options.signal?.aborted) recoveryBudgetController.abort()

    recoveryBudgetTimer = setTimeout(() => {
      recoveryBudgetExpired = true
      recoveryBudgetController?.abort()
    }, Math.max(1, Math.ceil(recoveryBudgetEffectiveTimerMs)))
    return recoveryBudgetController.signal
  }

  const assertRecoveryBudget = () => {
    if (recoveryBudgetExpired) throw effectiveRecoveryBudgetError()
    if (
      recoveryBudgetStartedAt !== undefined
      && performance.now() - recoveryBudgetStartedAt >= recoveryBudgetEffectiveTimerMs
    ) {
      recoveryBudgetExpired = true
      recoveryBudgetController?.abort()
      throw effectiveRecoveryBudgetError()
    }
  }

  const removeAbortListener = () => {
    options.signal?.removeEventListener('abort', onAbort)
  }

  const detachSource = (stream: any, destroy = false) => {
    const listeners = sourceListeners.get(stream)
    if (listeners && typeof stream?.removeListener === 'function') {
      stream.removeListener('data', listeners.data)
      stream.removeListener('error', listeners.error)
      stream.removeListener('end', listeners.end)
      stream.removeListener('close', listeners.close)
      sourceListeners.delete(stream)
    }
    if (destroy) destroyReadableStream(stream)
  }

  const fail = (error: Error) => {
    if (settled) return
    settled = true
    settledError = error
    pauseRecoveryBudget(true)
    stopWorkflowRecoveryDeadline(true)
    detachSource(source, true)
    removeAbortListener()
    bridge.destroy(error)
  }

  const finish = () => {
    if (settled) return
    settled = true
    pauseRecoveryBudget(true)
    stopWorkflowRecoveryDeadline(true)
    detachSource(source, true)
    removeAbortListener()
    bridge.end()
  }

  const startWorkflowRecoveryDeadline = (): AbortSignal | undefined => {
    if (workflowRecoveryStartedAt !== undefined) {
      return workflowRecoveryController?.signal
    }
    const requestRemainingMs = workflowRecoveryRequestDeadlineAt === undefined
      ? Number.POSITIVE_INFINITY
      : Math.max(0, workflowRecoveryRequestDeadlineAt - Date.now())
    workflowRecoveryEffectiveTimeoutMs = Math.min(
      workflowRecoveryTimeoutMs,
      requestRemainingMs,
    )
    if (workflowRecoveryEffectiveTimeoutMs <= 0) {
      workflowRecoveryExpired = true
      return undefined
    }

    workflowRecoveryStartedAt = performance.now()
    workflowRecoveryExpired = false
    workflowRecoveryController = new AbortController()
    workflowRecoveryTimer = setTimeout(() => {
      if (settled) return
      workflowRecoveryExpired = true
      fail(effectiveWorkflowRecoveryTimeoutError())
    }, Math.max(1, Math.ceil(workflowRecoveryEffectiveTimeoutMs)))
    return workflowRecoveryController.signal
  }

  const assertWorkflowRecoveryDeadline = () => {
    if (workflowRecoveryExpired) throw effectiveWorkflowRecoveryTimeoutError()
    if (
      workflowRecoveryStartedAt !== undefined
      && performance.now() - workflowRecoveryStartedAt >= workflowRecoveryEffectiveTimeoutMs
    ) {
      workflowRecoveryExpired = true
      throw effectiveWorkflowRecoveryTimeoutError()
    }
  }

  const linkAbortSignals = (
    signals: Array<AbortSignal | undefined>,
  ): { signal: AbortSignal; cleanup: () => void } => {
    const controller = new AbortController()
    const listeners: Array<{ signal: AbortSignal; listener: () => void }> = []

    for (const signal of signals) {
      if (!signal) continue
      if (signal.aborted) {
        controller.abort()
        break
      }
      const listener = () => controller.abort()
      signal.addEventListener('abort', listener, { once: true })
      listeners.push({ signal, listener })
    }

    return {
      signal: controller.signal,
      cleanup: () => {
        for (const entry of listeners) {
          entry.signal.removeEventListener('abort', entry.listener)
        }
      },
    }
  }

  const checkComplete = (): boolean => {
    if (sourceComplete) return true
    if (!options.isComplete) return false
    try {
      if (options.isComplete()) sourceComplete = true
    } catch (error) {
      completionCheckError = error instanceof Error ? error : new Error(String(error))
    }
    return sourceComplete
  }

  const takeCompletionCheckError = (): Error | undefined => {
    const error = completionCheckError
    completionCheckError = undefined
    return error
  }

  const getSemanticRecoveryError = (): Error | undefined => {
    try {
      return options.getSemanticRecoveryError?.()
    } catch (error) {
      return error instanceof Error ? error : new Error(String(error))
    }
  }

  const sawDoneMarker = (chunk: Buffer | string): boolean => {
    const text = typeof chunk === 'string'
      ? chunk
      : Buffer.isBuffer(chunk)
        ? chunk.toString('utf8')
        : ''
    if (!text) return false

    // Keep enough tail to recognize a marker split across network chunks,
    // while requiring an SSE data-line boundary to avoid matching model text.
    completionScan = `${completionScan}${text}`.slice(-128)
    return /(?:^|\r?\n)data\s*:\s*\[DONE\](?:\r?\n|$)/.test(completionScan)
  }

  const waitForRetry = async (signal?: AbortSignal): Promise<boolean> => {
    const effectiveSignal = signal || options.signal
    if (delayMs <= 0) return !effectiveSignal?.aborted
    if (effectiveSignal?.aborted) return false

    return new Promise<boolean>(resolve => {
      let timer: NodeJS.Timeout | undefined
      let finished = false

      const complete = (result: boolean) => {
        if (finished) return
        finished = true
        if (timer) clearTimeout(timer)
        effectiveSignal?.removeEventListener('abort', onRetryAbort)
        resolve(result && !effectiveSignal?.aborted)
      }

      const onRetryAbort = () => complete(false)
      timer = setTimeout(() => complete(true), delayMs)
      effectiveSignal?.addEventListener('abort', onRetryAbort, { once: true })
    })
  }

  const retireCurrentSource = () => {
    releaseLinkedRecoverySignal()
    detachSource(source, true)
  }

  const recover = async (
    initialError?: Error,
    onResume?: () => void,
  ): Promise<boolean> => {
    if (recoveryInFlight || settled) return false
    recoveryInFlight = true
    let lastError = initialError || new Error('Qwen AI response stream closed before completion')
    let semanticRecoveryEligible = isQwenAiSemanticRecoveryError(initialError)
    let responseEndedRecoveryEligible = isQwenAiResponseEndedError(initialError)
    transientFreshChatRecoveryEligible = isQwenAiUpstreamBusyError(initialError)
    staleSessionRecoveryEligible = isQwenAiStaleSessionError(initialError)
    if (responseEndedRecoveryEligible) {
      lastError = markQwenAiResponseEnded(normalizeQwenAiStreamFailure(lastError))
    }
    const recoverySignal = startRecoveryBudget()
    const failRecovery = (error: Error): never => {
      recoveryInFlight = false
      fail(error)
      throw error
    }

    // A zero budget is an explicit deployment choice to disable recovery.
    // Preserve the original provider failure instead of waiting indefinitely.
    if (!recoverySignal) {
      if (recoveryBudgetExpired) {
        failRecovery(effectiveRecoveryBudgetError())
      }
      failRecovery(
        recoveryBudgetRemainingMs <= 0
          ? normalizeQwenAiStreamFailure(lastError)
          : new Error('Qwen AI response recovery was aborted because the client disconnected.'),
      )
    }

    const ensureRecoveryBudget = () => {
      try {
        assertRecoveryBudget()
      } catch (error) {
        failRecovery(error instanceof Error ? error : effectiveRecoveryBudgetError())
      }
    }

    // A semantic terminal means Qwen already completed this response branch;
    // replaying it with GET only repeats the dangling text. When a same-chat
    // continuation is available, go straight to that new user turn. Keep the
    // response-id loop for transport/idle recovery and for callers that do
    // not provide a workflow continuation callback.
    const useWorkflowContinuation = semanticRecoveryEligible
      && !staleSessionRecoveryEligible
      && Boolean(options.continueWorkflow)
    while (
      !settled
      && attempts < maxAttempts
      && !useWorkflowContinuation
      && !responseEndedRecoveryEligible
      && !staleSessionRecoveryEligible
    ) {
      ensureRecoveryBudget()
      if (checkComplete()) {
        const completionError = takeCompletionCheckError()
        if (completionError) failRecovery(completionError)
        else finish()
        return false
      }
      const completionError = takeCompletionCheckError()
      if (completionError) {
        failRecovery(completionError)
      }

      if (options.signal?.aborted) {
        failRecovery(new Error('Qwen AI response stream aborted because the client disconnected.'))
      }

      const responseId = options.getResponseId().trim()
      if (!responseId || !options.resume) break

      attempts += 1
      if (!(await waitForRetry(recoverySignal))) {
        if (recoveryBudgetExpired) failRecovery(effectiveRecoveryBudgetError())
        failRecovery(new Error('Qwen AI response stream aborted because the client disconnected.'))
      }
      ensureRecoveryBudget()
      if (settled) {
        if (settledError) throw settledError
        return false
      }

      if (checkComplete()) {
        const lateCompletionError = takeCompletionCheckError()
        if (lateCompletionError) failRecovery(lateCompletionError)
        else finish()
        return false
      }
      const lateCompletionCheckError = takeCompletionCheckError()
      if (lateCompletionCheckError) {
        failRecovery(lateCompletionCheckError)
      }

      try {
        console.warn('[QwenAI] Resuming interrupted response stream', JSON.stringify({
          responseId,
          attempt: attempts,
          maxAttempts,
        }))
        const resumed = await options.resume(responseId, recoverySignal)
        const nextStream = resumed?.data ?? resumed

        // Abort/completion can race the resume request. Never attach a late
        // response to the bridge; release it immediately instead.
        if (recoveryBudgetExpired) {
          destroyReadableStream(nextStream)
          failRecovery(effectiveRecoveryBudgetError())
        }
        try {
          assertRecoveryBudget()
        } catch (error) {
          destroyReadableStream(nextStream)
          failRecovery(error instanceof Error ? error : effectiveRecoveryBudgetError())
        }
        if (settled || options.signal?.aborted || sourceComplete || checkComplete()) {
          destroyReadableStream(nextStream)
          if (!settled) {
            const lateResumeError = takeCompletionCheckError()
            if (lateResumeError) fail(lateResumeError)
            else finish()
          }
          return false
        }

        if (!nextStream || typeof nextStream.on !== 'function') {
          throw new Error('Qwen AI resume endpoint did not return a stream')
        }

        source = nextStream
        sourceGeneration += 1
        sourceHandled = false
        sourceComplete = false
        terminalMarkerSeen = false
        completionScan = ''
        pauseRecoveryBudget()
        recoveryInFlight = false
        onResume?.()
        attachSource(nextStream, sourceGeneration)
        return true
      } catch (error) {
        if (settled) {
          if (settledError) throw settledError
          return false
        }
        lastError = error instanceof Error ? error : new Error(String(error))
        if (recoveryBudgetExpired) {
          failRecovery(effectiveRecoveryBudgetError())
        }
        if (isQwenAiResponseEndedError(lastError)) {
          lastError = markQwenAiResponseEnded(normalizeQwenAiStreamFailure(lastError))
          responseEndedRecoveryEligible = true
          break
        }
        if (isQwenAiStaleSessionError(lastError)) {
          staleSessionRecoveryEligible = true
          break
        }
        if (isQwenAiUpstreamBusyError(lastError)) {
          transientFreshChatRecoveryEligible = true
        }
        if (isQwenAiNextAccountFailureError(lastError)) {
          failRecovery(normalizeQwenAiStreamFailure(lastError))
        }
        if (!isQwenAiSemanticRecoveryError(lastError)) {
          semanticRecoveryEligible = false
        }
        if (isClientCancellationError(lastError) || options.signal?.aborted) {
          failRecovery(new Error('Qwen AI response stream aborted because the client disconnected.'))
        }
      }
    }

    // Qwen returns "The request is ended!" when a response-id branch is
    // permanently closed. Repeating the GET can never make progress. While
    // the managed response is still private, replay the complete request once
    // in a new chat on the same credential instead.
    if (!settled && (
      responseEndedRecoveryEligible
      || transientFreshChatRecoveryEligible
      || staleSessionRecoveryEligible
    )) {
      const endedError = staleSessionRecoveryEligible
        ? markQwenAiStaleSessionError(normalizeQwenAiStreamFailure(lastError))
        : responseEndedRecoveryEligible
          ? markQwenAiResponseEnded(normalizeQwenAiStreamFailure(lastError))
          : normalizeQwenAiStreamFailure(lastError)
      const restartFreshChat = staleSessionRecoveryEligible
        ? (options.restartStaleSession || options.restartFreshChat)
        : options.restartFreshChat
      if (!restartFreshChat) {
        failRecovery(endedError)
      }
      if (freshChatRestartAttempts >= 1) {
        failRecovery(endedError)
      }

      freshChatRestartAttempts += 1
      ensureRecoveryBudget()
      try {
        console.warn('[QwenAI] Replaying in a fresh chat on the same account after private upstream failure', JSON.stringify({
          attempt: freshChatRestartAttempts,
          maxAttempts: 1,
        }))
        const restarted = await restartFreshChat(endedError, recoverySignal)
        const nextStream = restarted?.data ?? restarted

        if (recoveryBudgetExpired) {
          destroyReadableStream(nextStream)
          failRecovery(effectiveRecoveryBudgetError())
        }
        try {
          assertRecoveryBudget()
        } catch (error) {
          destroyReadableStream(nextStream)
          failRecovery(error instanceof Error ? error : effectiveRecoveryBudgetError())
        }
        if (settled || options.signal?.aborted || checkComplete()) {
          destroyReadableStream(nextStream)
          if (!settled) {
            const lateRestartError = takeCompletionCheckError()
            if (lateRestartError) fail(lateRestartError)
            else finish()
          }
          return false
        }
        if (!nextStream || typeof nextStream.on !== 'function') {
          throw new Error('Qwen AI fresh-chat replay did not return a stream')
        }

        source = nextStream
        sourceGeneration += 1
        sourceHandled = false
        sourceComplete = false
        terminalMarkerSeen = false
        completionScan = ''
        attempts = 0
        pauseRecoveryBudget()
        recoveryInFlight = false
        options.onFreshChatRestart?.()
        onResume?.()
        attachSource(nextStream, sourceGeneration)
        return true
      } catch (error) {
        if (settled) {
          if (settledError) throw settledError
          return false
        }
        let restartError = error instanceof Error ? error : new Error(String(error))
        if (isQwenAiResponseEndedError(restartError)) {
          restartError = markQwenAiResponseEnded(normalizeQwenAiStreamFailure(restartError))
        }
        if (isClientCancellationError(restartError) || options.signal?.aborted) {
          failRecovery(new Error('Qwen AI response stream aborted because the client disconnected.'))
        }
        failRecovery(normalizeQwenAiStreamFailure(restartError))
      }
    }

    // A response-id GET can only continue the provider's existing generation.
    // For a managed-tool semantic terminal, start a continuation user turn in
    // the same chat instead of replaying that branch. One bounded correction
    // is allowed by default; the selected text protocol is responsible for
    // making the initial branch unambiguous.
    if (
      !settled
      && semanticRecoveryEligible
      && options.continueWorkflow
      && workflowContinuationAttempts < workflowContinuationAttemptLimit
    ) {
      const parentResponseId = options.getResponseId().trim()
      if (parentResponseId) {
        const workflowRecoverySignal = startWorkflowRecoveryDeadline()
        if (!workflowRecoverySignal) {
          failRecovery(effectiveWorkflowRecoveryTimeoutError())
        }
        try {
          assertWorkflowRecoveryDeadline()
        } catch (error) {
          failRecovery(error instanceof Error ? error : effectiveWorkflowRecoveryTimeoutError())
        }
        const linkedRecoverySignal = linkAbortSignals([
          recoverySignal,
          workflowRecoverySignal,
        ])
        releaseLinkedRecoverySignal()
        linkedRecoverySignalCleanup = linkedRecoverySignal.cleanup
        workflowContinuationAttempts += 1
        ensureRecoveryBudget()
        if (!(await waitForRetry(linkedRecoverySignal.signal))) {
          if (workflowRecoveryExpired) {
            failRecovery(effectiveWorkflowRecoveryTimeoutError())
          }
          if (recoveryBudgetExpired) failRecovery(effectiveRecoveryBudgetError())
          failRecovery(new Error('Qwen AI response stream aborted because the client disconnected.'))
        }
        ensureRecoveryBudget()
        try {
          assertWorkflowRecoveryDeadline()
        } catch (error) {
          failRecovery(error instanceof Error ? error : effectiveWorkflowRecoveryTimeoutError())
        }

        try {
          console.warn('[QwenAI] Starting managed workflow continuation', JSON.stringify({
            parentResponseId,
            attempt: workflowContinuationAttempts,
            maxAttempts: workflowContinuationAttemptLimit,
          }))
          const continued = await options.continueWorkflow(
            parentResponseId,
            lastError,
            linkedRecoverySignal.signal,
          )
          const nextStream = continued?.data ?? continued

          if (workflowRecoveryExpired) {
            destroyReadableStream(nextStream)
            failRecovery(effectiveWorkflowRecoveryTimeoutError())
          }
          if (recoveryBudgetExpired) {
            destroyReadableStream(nextStream)
            failRecovery(effectiveRecoveryBudgetError())
          }
          try {
            assertWorkflowRecoveryDeadline()
          } catch (error) {
            destroyReadableStream(nextStream)
            failRecovery(error instanceof Error ? error : effectiveWorkflowRecoveryTimeoutError())
          }
          try {
            assertRecoveryBudget()
          } catch (error) {
            destroyReadableStream(nextStream)
            failRecovery(error instanceof Error ? error : effectiveRecoveryBudgetError())
          }
          if (settled || options.signal?.aborted || checkComplete()) {
            destroyReadableStream(nextStream)
            if (!settled) {
              const lateContinuationError = takeCompletionCheckError()
              if (lateContinuationError) fail(lateContinuationError)
              else finish()
            }
            return false
          }

          if (!nextStream || typeof nextStream.on !== 'function') {
            throw new Error('Qwen AI workflow continuation did not return a stream')
          }

          source = nextStream
          sourceGeneration += 1
          sourceHandled = false
          sourceComplete = false
          terminalMarkerSeen = false
          completionScan = ''
          // A fresh user turn has a new response branch. Pause only the
          // no-progress budget; the workflow wall-clock deadline stays active.
          attempts = 0
          pauseRecoveryBudget()
          recoveryInFlight = false
          options.onWorkflowContinuation?.()
          onResume?.()
          attachSource(nextStream, sourceGeneration)
          return true
        } catch (error) {
          releaseLinkedRecoverySignal()
          if (settled) {
            if (settledError) throw settledError
            return false
          }
          lastError = error instanceof Error ? error : new Error(String(error))
          if (workflowRecoveryExpired) {
            failRecovery(effectiveWorkflowRecoveryTimeoutError())
          }
          if (recoveryBudgetExpired) {
            failRecovery(effectiveRecoveryBudgetError())
          }
          if (isClientCancellationError(lastError) || options.signal?.aborted) {
            failRecovery(new Error('Qwen AI response stream aborted because the client disconnected.'))
          }
        }
      }
    }

    if (settled) {
      if (settledError) throw settledError
      return false
    }
    recoveryInFlight = false
    if (checkComplete()) {
      const completionError = takeCompletionCheckError()
      if (completionError) failRecovery(completionError)
      else finish()
      return false
    }
    const completionError = takeCompletionCheckError()
    if (completionError) {
      failRecovery(completionError)
    }
    const transportError = normalizeQwenAiStreamFailure(lastError)
    // Network and upstream 5xx failures are account-neutral. Preserve the
    // provider's 4xx classification (auth, risk control, or capacity) so the
    // governor can apply the appropriate account/cooldown policy.
    if (transportError.status === undefined || transportError.status >= 500) {
      transportError.accountFault = false
      delete transportError.retryScope
    }
    return failRecovery(transportError)
  }

  const startRecovery = (
    initialError?: Error,
    onResume?: () => void,
  ): Promise<boolean> => {
    if (activeRecovery) {
      if (onResume) {
        if (recoveryResumed) onResume()
        else recoveryResumeCallbacks.push(onResume)
      }
      return activeRecovery
    }

    recoveryResumed = false
    recoveryResumeCallbacks = onResume ? [onResume] : []
    const pending = recover(initialError, () => {
      recoveryResumed = true
      const callbacks = recoveryResumeCallbacks
      recoveryResumeCallbacks = []
      for (const callback of callbacks) {
        try {
          callback()
        } catch (error) {
          console.warn('[QwenAI] Recovery resume callback failed:', describeErrorForLog(error))
        }
      }
    })
    let tracked: Promise<boolean>
    tracked = pending.finally(() => {
      if (activeRecovery === tracked) activeRecovery = undefined
      recoveryResumeCallbacks = []
    })
    activeRecovery = tracked
    return tracked
  }

  bridge.recoverFromIdle = async (
    error: Error,
    onResume?: () => void,
  ): Promise<boolean> => {
    if (settled) {
      if (settledError) throw settledError
      return false
    }
    if (activeRecovery) return startRecovery(undefined, onResume)
    if (recoveryInFlight) return false

    const complete = checkComplete()
    const completionError = takeCompletionCheckError()
    if (completionError) {
      fail(completionError)
      throw completionError
    }
    if (complete) {
      finish()
      return false
    }

    // Mark and detach synchronously so late bytes from the stalled socket
    // cannot race the continuation stream into the shared parser.
    sourceHandled = true
    retireCurrentSource()
    return startRecovery(error, onResume)
  }

  const handleSourceEnd = (generation: number) => {
    if (settled || generation !== sourceGeneration || sourceHandled) return
    sourceHandled = true
    const complete = checkComplete()
    const completionError = takeCompletionCheckError()
    retireCurrentSource()
    if (completionError) {
      fail(completionError)
      return
    }
    if (complete) {
      finish()
      return
    }
    void startRecovery(getSemanticRecoveryError()).catch(() => undefined)
  }

  const handleSourceError = (generation: number, error: Error) => {
    if (settled || generation !== sourceGeneration || sourceHandled) return
    sourceHandled = true
    const complete = checkComplete()
    const completionError = takeCompletionCheckError()
    retireCurrentSource()
    if (completionError) {
      fail(completionError)
      return
    }
    if (complete) {
      finish()
      return
    }
    if (workflowRecoveryExpired) {
      fail(effectiveWorkflowRecoveryTimeoutError())
      return
    }
    if (recoveryBudgetExpired) {
      fail(effectiveRecoveryBudgetError())
      return
    }
    const semanticRecoveryError = getSemanticRecoveryError()
    if (semanticRecoveryError) {
      void startRecovery(semanticRecoveryError).catch(() => undefined)
      return
    }
    if (options.signal?.aborted || isClientCancellationError(error)) {
      fail(new Error('Qwen AI response stream aborted because the client disconnected.'))
      return
    }
    if (isResumableQwenAiTransportError(error)) {
      void startRecovery(error).catch(() => undefined)
      return
    }
    fail(error)
  }

  function attachSource(nextStream: any, generation: number) {
    const listeners: SourceListeners = {
      data: (chunk: Buffer | string) => {
        if (settled || generation !== sourceGeneration || terminalMarkerSeen) return
        try {
          bridge.write(chunk)
        } catch (error) {
          fail(error instanceof Error ? error : new Error(String(error)))
          return
        }

        // A downstream parser can synchronously classify this terminal frame
        // as semantically incomplete and replace the current source through
        // recoverFromIdle(). Do not let the old source's [DONE] settle the
        // bridge after that recovery has already started.
        if (
          settled
          || generation !== sourceGeneration
          || sourceHandled
          || recoveryInFlight
        ) {
          return
        }

        const done = sawDoneMarker(chunk)
        const complete = checkComplete()
        const completionError = takeCompletionCheckError()
        if (completionError) {
          fail(completionError)
          return
        }
        if (done) {
          sourceComplete = true
          terminalMarkerSeen = true
          // [DONE] is definitive; close the downstream bridge even if the
          // provider forgets to emit its final close event.
          finish()
        } else if (complete) {
          // Defer bridge completion until end/close so a handler can still
          // consume a provider finish event and emit its own terminal frame.
          sourceComplete = true
        }
      },
      error: (error: Error) => handleSourceError(generation, error),
      end: () => handleSourceEnd(generation),
      close: () => {
        if (!sourceHandled) handleSourceEnd(generation)
      },
    }
    sourceListeners.set(nextStream, listeners)
    nextStream.on('data', listeners.data)
    nextStream.once('error', listeners.error)
    nextStream.once('end', listeners.end)
    nextStream.once('close', listeners.close)
  }

  function onAbort() {
    if (settled) return
    fail(new Error('Qwen AI response stream aborted because the client disconnected.'))
  }

  bridge.once('close', () => {
    if (settled) return
    settled = true
    pauseRecoveryBudget(true)
    stopWorkflowRecoveryDeadline(true)
    detachSource(source, true)
    removeAbortListener()
  })

  if (options.signal?.aborted) {
    onAbort()
  } else {
    options.signal?.addEventListener('abort', onAbort, { once: true })
    sourceGeneration = 1
    attachSource(source, sourceGeneration)
  }

  return bridge
}

function uuid(): string {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0
    const v = c === 'x' ? r : (r & 0x3) | 0x8
    return v.toString(16)
  })
}

function timestamp(): number {
  return Date.now()
}

function currentTimezoneHeader(): string {
  return new Date().toString().replace(/\s*\(.+\)$/, '')
}

function isObjectValue(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

export type QwenAiGeneratedImage = {
  type: 'image_url'
  image_url: { url: string }
  source: 'qwen-ai'
}

export type QwenAiImageGenerationOptions = {
  chatType: 't2i'
  size: string
  model: string
}

const QWEN_AI_DEFAULT_IMAGE_SIZE = '1:1'
const QWEN_AI_DEFAULT_IMAGE_MODEL = 'qwen-image-2.0-pro'
const QWEN_AI_IMAGE_EXTRA_MAX_DEPTH = 6
const QWEN_AI_IMAGE_EXTRA_MAX_NODES = 512
const QWEN_AI_IMAGE_EXTRA_MAX_RESULTS = 32
const QWEN_AI_IMAGE_JSON_MAX_BYTES = 64 * 1024 * 1024
const QWEN_AI_IMAGE_MAX_ENCODED_BYTES = 16 * 1024 * 1024
const QWEN_AI_IMAGE_MAX_TOTAL_ENCODED_BYTES = 32 * 1024 * 1024
const QWEN_AI_IMAGE_CONTAINER_KEYS = [
  'images',
  'image_list',
  'result',
  'results',
  'output',
  'outputs',
  'tool_result',
  'data',
] as const
const QWEN_AI_IMAGE_VALUE_KEYS = [
  'image',
  'image_url',
  'b64_json',
  'base64',
] as const

function isQwenAiImageGenerationPhase(phase: unknown): boolean {
  return phase === 'image_gen_tool' || phase === 'image_generation'
}

/**
 * Translate the OpenAI image size vocabulary into ratios accepted by Qwen's
 * web image-generation mode. Unknown values use the deterministic default so
 * a client-specific spelling never leaks into the provider payload.
 */
export function resolveQwenAiImageGenerationOptions(
  value: ChatCompletionRequest['image_generation'],
): QwenAiImageGenerationOptions | undefined {
  if (value?.enabled !== true) return undefined

  const requestedSize = typeof value.size === 'string' ? value.size.trim().toLowerCase() : ''
  const sizeAliases: Record<string, string> = {
    auto: QWEN_AI_DEFAULT_IMAGE_SIZE,
    '1024x1024': '1:1',
    '1536x1024': '4:3',
    '1024x1536': '3:4',
    '1792x1024': '16:9',
    '1024x1792': '9:16',
  }
  const allowedSizes = new Set(['1:1', '3:4', '4:3', '16:9', '9:16'])
  const size = sizeAliases[requestedSize]
    ?? (allowedSizes.has(requestedSize) ? requestedSize : QWEN_AI_DEFAULT_IMAGE_SIZE)
  const requestedModel = typeof value.model === 'string' ? value.model.trim() : ''

  return {
    chatType: 't2i',
    size,
    model: requestedModel || QWEN_AI_DEFAULT_IMAGE_MODEL,
  }
}

function inferBase64ImageMimeType(value: string): string | undefined {
  const prefix = Buffer.from(value.slice(0, 128), 'base64')
  if (prefix.length >= 8 && prefix.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
    return 'image/png'
  }
  if (prefix.length >= 3 && prefix[0] === 0xff && prefix[1] === 0xd8 && prefix[2] === 0xff) {
    return 'image/jpeg'
  }
  if (prefix.length >= 6) {
    const signature = prefix.subarray(0, 6).toString('ascii')
    if (signature === 'GIF87a' || signature === 'GIF89a') return 'image/gif'
  }
  if (
    prefix.length >= 12
    && prefix.subarray(0, 4).toString('ascii') === 'RIFF'
    && prefix.subarray(8, 12).toString('ascii') === 'WEBP'
  ) {
    return 'image/webp'
  }
  if (prefix.length >= 2 && prefix[0] === 0x42 && prefix[1] === 0x4d) {
    return 'image/bmp'
  }
  if (prefix.length >= 12 && prefix.subarray(4, 12).toString('ascii').includes('ftypavif')) {
    return 'image/avif'
  }
  return undefined
}

function normalizeBase64Image(value: string): { encoded: string; mimeType: string } | undefined {
  if (!value || value.length > QWEN_AI_IMAGE_MAX_ENCODED_BYTES || /\s/.test(value)) return undefined

  const firstPadding = value.indexOf('=')
  const base = firstPadding >= 0 ? value.slice(0, firstPadding) : value
  const padding = firstPadding >= 0 ? value.slice(firstPadding) : ''
  if (!/^[a-z0-9+/]+$/i.test(base) || !/^={0,2}$/.test(padding)) return undefined

  const remainder = base.length % 4
  if (remainder === 1) return undefined
  const expectedPadding = remainder === 0 ? 0 : 4 - remainder
  if (padding.length > 0 && padding.length !== expectedPadding) return undefined

  const encoded = `${base}${'='.repeat(expectedPadding)}`
  if (encoded.length > QWEN_AI_IMAGE_MAX_ENCODED_BYTES) return undefined
  const mimeType = inferBase64ImageMimeType(encoded)
  return mimeType ? { encoded, mimeType } : undefined
}

function qwenAiInlineImageEncodedBytes(url: string): number {
  const separator = url.indexOf(',')
  return url.startsWith('data:image/') && separator >= 0 ? url.length - separator - 1 : 0
}

function normalizeQwenAiImageReference(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  if (!trimmed || trimmed.length > QWEN_AI_IMAGE_MAX_ENCODED_BYTES + 64) return undefined

  if (/^https?:\/\//i.test(trimmed)) {
    try {
      const parsed = new URL(trimmed)
      return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? trimmed : undefined
    } catch {
      return undefined
    }
  }

  const dataUrlMatch = trimmed.match(
    /^data:(image\/(?:png|jpe?g|gif|webp|bmp|avif));base64,([a-z0-9+/=]+)$/i,
  )
  if (dataUrlMatch) {
    const normalized = normalizeBase64Image(dataUrlMatch[2])
    return normalized
      ? `data:${normalized.mimeType};base64,${normalized.encoded}`
      : undefined
  }

  if (trimmed.length < 16) return undefined
  const normalized = normalizeBase64Image(trimmed)
  return normalized
    ? `data:${normalized.mimeType};base64,${normalized.encoded}`
    : undefined
}

/**
 * Extract only image-bearing fields used by Qwen's image_gen_tool. The web
 * client currently reads `extra.image_list || extra.tool_result`; accepting a
 * few documented wrapper shapes keeps this parser tolerant without exposing
 * arbitrary tool-result text to downstream clients.
 */
export function extractQwenAiGeneratedImages(extra: unknown): QwenAiGeneratedImage[] {
  if (!isObjectValue(extra)) return []

  const roots = [extra.image_list, extra.tool_result]
  const images: QwenAiGeneratedImage[] = []
  const imageKeys = new Set<string>()
  const visited = new Set<object>()
  let visitedNodes = 0
  let inlineEncodedBytes = 0

  const appendImage = (candidate: unknown) => {
    if (images.length >= QWEN_AI_IMAGE_EXTRA_MAX_RESULTS) return
    const url = normalizeQwenAiImageReference(candidate)
    if (!url || imageKeys.has(url)) return
    const encodedBytes = qwenAiInlineImageEncodedBytes(url)
    if (inlineEncodedBytes + encodedBytes > QWEN_AI_IMAGE_MAX_TOTAL_ENCODED_BYTES) return
    imageKeys.add(url)
    inlineEncodedBytes += encodedBytes
    images.push({
      type: 'image_url',
      image_url: { url },
      source: 'qwen-ai',
    })
  }

  const visit = (value: unknown, depth: number, directImageValue = false): void => {
    if (
      value === undefined
      || value === null
      || depth > QWEN_AI_IMAGE_EXTRA_MAX_DEPTH
      || visitedNodes >= QWEN_AI_IMAGE_EXTRA_MAX_NODES
      || images.length >= QWEN_AI_IMAGE_EXTRA_MAX_RESULTS
    ) {
      return
    }
    visitedNodes += 1

    if (typeof value === 'string') {
      if (directImageValue) appendImage(value)
      const trimmed = value.trim()
      if (
        (trimmed.startsWith('{') || trimmed.startsWith('['))
        && Buffer.byteLength(trimmed) <= QWEN_AI_IMAGE_JSON_MAX_BYTES
      ) {
        const parsed = parseJsonSafely(trimmed)
        if (parsed !== undefined) visit(parsed, depth + 1)
      }
      return
    }

    if (Array.isArray(value)) {
      for (const item of value) {
        if (
          visitedNodes >= QWEN_AI_IMAGE_EXTRA_MAX_NODES
          || images.length >= QWEN_AI_IMAGE_EXTRA_MAX_RESULTS
        ) {
          break
        }
        visit(item, depth + 1, true)
      }
      return
    }

    if (!isObjectValue(value) || visited.has(value)) return
    visited.add(value)

    for (const key of QWEN_AI_IMAGE_VALUE_KEYS) {
      const candidate = value[key]
      if (candidate === undefined) continue
      if (key === 'image_url' && isObjectValue(candidate)) {
        visit(candidate.url, depth + 1, true)
      } else {
        visit(candidate, depth + 1, true)
      }
    }
    for (const key of QWEN_AI_IMAGE_CONTAINER_KEYS) {
      const candidate = value[key]
      if (candidate !== undefined) visit(candidate, depth + 1)
    }
  }

  for (const root of roots) visit(root, 0, true)
  return images
}

function escapeQwenAiMarkdownImageDestination(value: string): string {
  return value.replace(/</g, '%3C').replace(/>/g, '%3E').replace(/[\r\n]/g, '')
}

export function formatQwenAiGeneratedImages(
  images: QwenAiGeneratedImage[],
  startingIndex = 0,
): string {
  return images
    .map((image, index) => (
      `![Generated image ${startingIndex + index + 1}](<${escapeQwenAiMarkdownImageDestination(image.image_url.url)}>)`
    ))
    .join('\n\n')
}

function qwenAiGeneratedImageContentDelta(
  existingContent: string,
  images: QwenAiGeneratedImage[],
  startingIndex: number,
): string {
  const markdown = formatQwenAiGeneratedImages(images, startingIndex)
  if (!existingContent) return markdown
  const separator = existingContent.endsWith('\n\n')
    ? ''
    : existingContent.endsWith('\n')
      ? '\n'
      : '\n\n'
  return `${separator}${markdown}`
}

/**
 * Detect Qwen's admission response for a busy chat. The provider returns this
 * as HTTP 200 JSON even though no SSE response branch was accepted. Restrict
 * traversal to the response envelope and its documented error/data children
 * so an arbitrary model payload cannot accidentally opt into retries.
 */
export function isQwenAiChatInProgressEnvelope(value: unknown): boolean {
  const queue: unknown[] = [value]
  const visited = new Set<object>()

  while (queue.length > 0) {
    const candidate = queue.shift()
    if (Array.isArray(candidate)) {
      queue.push(...candidate)
      continue
    }
    if (!isObjectValue(candidate) || visited.has(candidate)) continue
    visited.add(candidate)

    const code = typeof candidate.code === 'string' ? candidate.code.trim() : ''
    if (code.toUpperCase() === 'CHAT_IN_PROGRESS') return true

    queue.push(candidate.error, candidate.errors, candidate.data)
  }

  return false
}

function parseJsonSafely(value: string): unknown {
  try {
    return JSON.parse(value)
  } catch {
    return undefined
  }
}

export function describeErrorForLog(error: unknown): string {
  const record = isObjectValue(error) ? error : undefined
  const response = isObjectValue(record?.response) ? record.response : undefined
  const name = error instanceof Error && error.name ? error.name : 'Error'
  const rawMessage = error instanceof Error ? error.message : String(error)
  const message = rawMessage
    .replace(/(Bearer\s+)[^\s]+/gi, '$1[REDACTED]')
    .replace(/([?&](?:token|cookie|authorization|x5secdata|x5sectag)=)[^&\s]+/gi, '$1[REDACTED]')
    .slice(0, 500)
  const directStatus = typeof record?.status === 'number'
    ? record.status
    : typeof record?.statusCode === 'number'
      ? record.statusCode
      : undefined
  const responseStatus = typeof response?.status === 'number' ? response.status : undefined
  const statusValue = directStatus ?? responseStatus
  const status = statusValue === undefined ? '' : ` status=${statusValue}`
  const code = typeof record?.code === 'string' ? ` code=${record.code}` : ''

  return `${name}:${status}${code} ${message}`.trim()
}

type QwenAiUpstreamError = Error & {
  status?: number
  type?: string
  param?: string
  code?: string
  headers?: Record<string, string>
  retryable?: boolean
  accountFault?: boolean
  retryScope?: 'next-account'
  upstreamState?: 'no_events' | 'active_without_terminal' | 'completed_without_valid_output' | 'client_disconnected'
}

type QwenAiErrorEnvelopeMetadata = {
  status?: number
  type?: string
  param?: string
  code?: string
  retryable?: boolean
}

function markQwenAiNextAccountFailure(error: QwenAiUpstreamError): QwenAiUpstreamError {
  error.accountFault = true
  error.retryScope = 'next-account'
  return error
}

function markQwenAiResponseEnded(error: QwenAiUpstreamError): QwenAiUpstreamError {
  error.status = 502
  error.code = 'qwen_ai_response_ended'
  error.retryable = false
  error.accountFault = false
  delete error.retryScope
  return error
}

/**
 * Qwen occasionally loses a retained web chat while the credential remains
 * healthy.  The provider has returned this state as a structured
 * CHAT_NOT_FOUND code, as a human-readable message, and as 400/422 validation
 * responses.  Keep the classifier conservative: only explicit chat/session
 * references are considered stale so ordinary tool/schema validation errors
 * do not trigger a full replay.
 */
function qwenAiErrorText(value: unknown): string {
  if (typeof value === 'string') return value
  if (value === undefined || value === null) return ''
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

function qwenAiErrorStatus(error: unknown): number | undefined {
  if (!isObjectValue(error)) return undefined
  const record = error as Record<string, unknown>
  const response = isObjectValue(record.response) ? record.response : undefined
  const candidates = [record.status, record.statusCode, record.httpStatus, response?.status]
  for (const candidate of candidates) {
    const status = typeof candidate === 'number'
      ? candidate
      : typeof candidate === 'string' && /^\d{3}$/.test(candidate.trim())
        ? Number(candidate)
        : undefined
    if (status !== undefined && status >= 400 && status <= 599) return status
  }
  return undefined
}

function qwenAiErrorCodeValues(error: unknown): string[] {
  const values: string[] = []
  const visited = new Set<object>()
  const visit = (value: unknown, depth: number) => {
    if (depth > 5 || value === undefined || value === null) return
    if (typeof value === 'string') {
      values.push(value)
      return
    }
    if (!isObjectValue(value) || visited.has(value)) return
    visited.add(value)
    const record = value as Record<string, unknown>
    for (const key of ['code', 'errorCode', 'error_code', 'type']) visit(record[key], depth + 1)
    for (const key of ['error', 'errors', 'data', 'detail', 'response']) visit(record[key], depth + 1)
  }
  visit(error, 0)
  return values
}

function normalizeQwenAiErrorToken(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, '_')
    .replace(/[^a-z0-9_]/g, '')
}

export function isQwenAiStaleSessionError(error: unknown): boolean {
  if (!error) return false
  const status = qwenAiErrorStatus(error)
  const record = isObjectValue(error) ? error as Record<string, unknown> : undefined
  const param = typeof record?.param === 'string'
    ? record.param.toLowerCase().replace(/[^a-z0-9]/g, '')
    : ''
  if ((status === 400 || status === 422) && (
    param === 'chatid'
    || param === 'conversationid'
    || param === 'parentid'
    || param === 'responseid'
    || param === 'sessionid'
  )) return true
  const codeTokens = qwenAiErrorCodeValues(error).map(normalizeQwenAiErrorToken)
  const explicitCode = codeTokens.some(code => (
    code === 'qwen_ai_session_stale'
    || code === 'chat_not_found'
    || code === 'chat_notfound'
    || code === 'conversation_not_found'
    || code === 'conversation_notfound'
    || code === 'parent_not_found'
    || code === 'response_not_found'
    || code === 'session_not_found'
    || code === 'chat_missing'
    || code === 'chat_expired'
    || code === 'invalid_chat_id'
    || code === 'invalid_chat'
  ))
  if (explicitCode) return true

  // A bare 404/409 from the retained-chat endpoint has no useful body in
  // some deployments.  Restrict this fallback to those session-oriented HTTP
  // statuses; a generic 400/422 needs explicit reference evidence below.
  if (status === 404 || status === 409) return true

  const text = [
    error instanceof Error ? error.message : '',
    qwenAiErrorText(error),
    ...qwenAiErrorCodeValues(error),
  ].join(' ').toLowerCase()
  const referencePattern = /(?:chat|conversation|parent|response|session)\s*(?:id|reference|branch)?\s*(?:[_-]?not\s*found|[_-]?missing|[_-]?expired|[_-]?invalid)|(?:chat|conversation|parent|response|session)[_-]?not[_-]?found/i
  if (!referencePattern.test(text)) return false

  return status === undefined
    || status === 400
    || status === 404
    || status === 409
    || status === 422
    || status >= 500
}

function markQwenAiStaleSessionError(error: QwenAiUpstreamError): QwenAiUpstreamError {
  if (!error.status || error.status < 400 || error.status > 599) error.status = 502
  error.code = 'qwen_ai_session_stale'
  error.retryable = false
  error.accountFault = false
  delete error.retryScope
  return error
}

export function isQwenAiResponseEndedError(error: unknown): boolean {
  if (!error) return false
  const record = typeof error === 'object' ? error as Record<string, unknown> : undefined
  const code = typeof record?.code === 'string' ? record.code : ''
  if (code === 'qwen_ai_response_ended') return true

  const response = record?.response && typeof record.response === 'object'
    ? record.response as Record<string, unknown>
    : undefined
  const values = [
    error instanceof Error ? error.message : error,
    record?.message,
    record?.data,
    response?.data,
  ]
  const text = values.map(value => {
    if (typeof value === 'string') return value
    try {
      return value === undefined ? '' : JSON.stringify(value)
    } catch {
      return ''
    }
  }).join(' ')
  return /(?:^|\b)the request is ended!?(?:\b|$)/i.test(text)
}

function isQwenAiNextAccountFailureError(error: unknown): boolean {
  if (!isObjectValue(error)) return false
  const status = typeof error.status === 'number'
    ? error.status
    : isObjectValue(error.response) && typeof error.response.status === 'number'
      ? error.response.status
      : undefined
  const code = typeof error.code === 'string' ? error.code : ''
  return status === 401
    || status === 403
    || (status === 429 && code === 'qwen_ai_capacity_limit')
}

function createQwenAiStreamFailure(
  message: string,
  code: 'qwen_ai_stream_incomplete'
    | 'qwen_ai_empty_stream'
    | 'qwen_ai_semantic_empty'
    | 'qwen_ai_semantic_incomplete'
    | 'qwen_ai_wrapper_leak'
    | 'qwen_ai_invalid_tool_arguments' = 'qwen_ai_stream_incomplete',
): QwenAiUpstreamError {
  const error = new Error(message) as QwenAiUpstreamError
  // The provider closed its SSE response without a usable completion. This
  // is an upstream gateway failure, not an application exception or a client
  // cancellation, and replaying a slow generation is disabled by default.
  error.status = 502
  error.code = code
  error.retryable = false
  return error
}

function createQwenAiSemanticEmptyError(): QwenAiUpstreamError {
  const error = createQwenAiStreamFailure(
    'Qwen AI completed with reasoning but without an answer or tool call',
    'qwen_ai_semantic_empty',
  )
  // A reasoning-only completion is a response-shape problem, not evidence
  // that this account is invalid or rate limited.
  error.status = 422
  error.accountFault = false
  return error
}

function createQwenAiSemanticIncompleteError(): QwenAiUpstreamError {
  const error = createQwenAiStreamFailure(
    'Qwen AI completed with a dangling answer while managed tools were available',
    'qwen_ai_semantic_incomplete',
  )
  error.status = 422
  error.accountFault = false
  return error
}

function createQwenAiWrapperLeakError(): QwenAiUpstreamError {
  const error = createQwenAiStreamFailure(
    'Qwen AI returned an internal managed tool-result wrapper in assistant output',
    'qwen_ai_wrapper_leak',
  )
  error.status = 422
  error.type = 'upstream_protocol_error'
  error.param = 'content'
  error.accountFault = false
  return error
}

type QwenAiNativeToolArgumentIssue = {
  toolName: string
  missingRequired: string[]
  unexpected: string[]
  typeMismatches: string[]
  valueMismatches: string[]
}

function createQwenAiInvalidNativeToolArgumentsError(
  issues: QwenAiNativeToolArgumentIssue[],
): QwenAiUpstreamError {
  const details = issues
    .filter(issue => issue.toolName)
    .map(issue => {
      const problems = [
        ...(issue.missingRequired.length > 0
          ? [`missing required fields: ${issue.missingRequired.join(', ')}`]
          : []),
        ...(issue.unexpected.length > 0
          ? [`unexpected fields: ${issue.unexpected.join(', ')}`]
          : []),
        ...(issue.typeMismatches.length > 0
          ? [`invalid field types: ${issue.typeMismatches.join(', ')}`]
          : []),
        ...(issue.valueMismatches.length > 0
          ? [`invalid field values: ${issue.valueMismatches.join(', ')}`]
          : []),
      ]
      return `${issue.toolName}${problems.length > 0 ? ` (${problems.join('; ')})` : ''}`
    })
  const error = createQwenAiStreamFailure(
    `Qwen AI returned native tool arguments that do not match the declared schema${details.length > 0 ? `: ${details.join(', ')}` : ''}`,
    'qwen_ai_invalid_tool_arguments',
  )
  error.type = 'tool_call_parse_error'
  error.param = 'tool_calls'
  error.status = 422
  error.accountFault = false
  return error
}

function createQwenAiContinuationAbortError(): QwenAiUpstreamError {
  const error = new Error('Qwen AI workflow continuation aborted because the client disconnected.') as QwenAiUpstreamError
  error.status = 499
  error.code = 'qwen_ai_client_cancelled'
  error.retryable = false
  error.accountFault = false
  return error
}

function createQwenAiRecoveryBudgetError(): QwenAiUpstreamError {
  const error = new Error(
    'Qwen AI response recovery exceeded its configured no-progress budget.',
  ) as QwenAiUpstreamError
  error.status = 504
  error.code = 'qwen_ai_recovery_timeout'
  error.retryable = false
  error.accountFault = false
  return error
}

function createQwenAiRequestTimeoutError(): QwenAiUpstreamError {
  const error = new Error(
    'Qwen AI request exceeded its cumulative request deadline.',
  ) as QwenAiUpstreamError
  error.status = 504
  error.code = 'qwen_ai_request_timeout'
  error.retryable = false
  error.accountFault = false
  return error
}

function createQwenAiClientCancellationError(): QwenAiUpstreamError {
  const error = new Error(
    'Qwen AI request was cancelled because the client disconnected.',
  ) as QwenAiUpstreamError
  error.name = 'AbortError'
  error.status = 499
  error.code = 'qwen_ai_client_cancelled'
  error.retryable = false
  error.accountFault = false
  return error
}

type QwenAiRequestDeadlineScope = {
  signal?: AbortSignal
  wait<T>(operation: Promise<T>, disposeLateValue?: (value: T) => void): Promise<T>
  throwIfStopped(): void
  remainingTimeoutMs(configuredTimeoutMs: number): number
  dispose(): void
}

function createQwenAiRequestDeadlineScope(
  clientSignal?: AbortSignal,
  rawDeadlineAt?: number,
): QwenAiRequestDeadlineScope {
  const deadlineAt = typeof rawDeadlineAt === 'number' && Number.isFinite(rawDeadlineAt)
    ? rawDeadlineAt
    : undefined
  const needsLinkedSignal = Boolean(clientSignal) || deadlineAt !== undefined
  const controller = needsLinkedSignal ? new AbortController() : undefined
  let stopCause: 'client' | 'deadline' | undefined
  let deadlineTimer: NodeJS.Timeout | undefined
  let rejectStopped: ((error: QwenAiUpstreamError) => void) | undefined

  const stopped = needsLinkedSignal
    ? new Promise<never>((_resolve, reject) => {
        rejectStopped = reject
      })
    : undefined
  // A synchronously-aborted input can settle this promise before the first
  // operation is raced. Keep that rejection observed without changing it.
  void stopped?.catch(() => {})

  const errorForCause = (cause: 'client' | 'deadline'): QwenAiUpstreamError => cause === 'deadline'
    ? createQwenAiRequestTimeoutError()
    : createQwenAiClientCancellationError()

  const stop = (cause: 'client' | 'deadline') => {
    if (stopCause) return
    stopCause = cause
    const error = errorForCause(cause)
    if (controller && !controller.signal.aborted) controller.abort(error)
    rejectStopped?.(error)
  }

  const onClientAbort = () => stop('client')
  clientSignal?.addEventListener('abort', onClientAbort, { once: true })

  if (clientSignal?.aborted) {
    stop('client')
  } else if (deadlineAt !== undefined) {
    const remainingMs = deadlineAt - Date.now()
    if (remainingMs <= 0) {
      stop('deadline')
    } else {
      deadlineTimer = setTimeout(
        () => stop('deadline'),
        Math.min(2_147_483_647, remainingMs),
      )
    }
  }

  const throwIfStopped = () => {
    if (!stopCause && clientSignal?.aborted) stop('client')
    // Recheck wall time synchronously. This prevents a late success from
    // winning when CPU work delayed the deadline timer callback.
    if (!stopCause && deadlineAt !== undefined && Date.now() >= deadlineAt) {
      stop('deadline')
    }
    if (stopCause) throw errorForCause(stopCause)
  }

  return {
    signal: controller?.signal,
    async wait<T>(operation: Promise<T>, disposeLateValue?: (value: T) => void): Promise<T> {
      let waitFinished = false
      let accepted = false
      let pendingValue: T | undefined
      let hasPendingValue = false
      let lateValueDisposed = false
      const disposeOnce = (value: T) => {
        if (lateValueDisposed) return
        lateValueDisposed = true
        try {
          disposeLateValue?.(value)
        } catch {
          // The structured timeout/cancellation remains authoritative.
        }
      }
      operation.then(
        value => {
          if (accepted) return
          if (waitFinished) {
            disposeOnce(value)
          } else {
            pendingValue = value
            hasPendingValue = true
          }
        },
        () => {},
      )

      try {
        const value = stopped
          ? await Promise.race([operation, stopped])
          : await operation
        try {
          throwIfStopped()
        } catch (error) {
          disposeOnce(value)
          throw error
        }
        accepted = true
        return value
      } catch (error) {
        throwIfStopped()
        throw error
      } finally {
        waitFinished = true
        if (!accepted && hasPendingValue) disposeOnce(pendingValue as T)
      }
    },
    throwIfStopped,
    remainingTimeoutMs(configuredTimeoutMs: number): number {
      throwIfStopped()
      const safeConfigured = Math.max(1, Math.floor(configuredTimeoutMs))
      return deadlineAt === undefined
        ? safeConfigured
        : Math.max(1, Math.min(safeConfigured, deadlineAt - Date.now()))
    },
    dispose() {
      if (deadlineTimer) {
        clearTimeout(deadlineTimer)
        deadlineTimer = undefined
      }
      clientSignal?.removeEventListener('abort', onClientAbort)
      rejectStopped = undefined
    },
  }
}

function createQwenAiWorkflowRecoveryTimeoutError(): QwenAiUpstreamError {
  const error = new Error(
    'Qwen AI managed workflow recovery exceeded its configured wall-clock timeout.',
  ) as QwenAiUpstreamError
  error.status = 504
  error.code = 'qwen_ai_workflow_recovery_timeout'
  error.retryable = false
  error.accountFault = false
  return error
}

function isDanglingManagedToolAnswer(
  content: string,
  plan?: ToolCallingPlan,
): boolean {
  if (!plan?.shouldParseResponse || plan.allowedToolNames.size === 0) {
    return false
  }

  const parsed = getToolProtocol(plan.protocol).parse(content, {
    tools: plan.tools,
    protocol: plan.protocol,
    allowPartial: true,
  })
  if (parsed.toolCalls.length > 0) {
    return false
  }

  return requiresManagedWorkflowCompletionMarker(plan)
    && !hasManagedWorkflowCompletionMarker(content, plan)
}

function logQwenAiManagedParseFailure(
  path: 'stream' | 'non_stream',
  plan: ToolCallingPlan,
  parsed: {
    toolCalls?: unknown[]
    rawMatches?: unknown[]
    invalidToolNames?: unknown[]
    malformedReason?: string
  },
  content: string,
): void {
  console.warn('[QwenAI] Managed tool-call parse rejected', JSON.stringify({
    path,
    protocol: plan.protocol,
    malformedReason: parsed.malformedReason || 'unspecified',
    rawBlockCount: parsed.rawMatches?.length ?? 0,
    parsedToolCallCount: parsed.toolCalls?.length ?? 0,
    invalidToolNameCount: parsed.invalidToolNames?.length ?? 0,
    contentCodePoints: Array.from(content).length,
  }))
}

function replaceManagedWorkflowContentInSseFrames(
  frames: string[],
  visibleContent: string,
): string[] {
  const parsedFrames = frames.map((frame) => {
    const match = /^data: ([^\r\n]+)/m.exec(frame)
    if (!match) return { frame }
    let parsed: any
    try {
      parsed = JSON.parse(match[1])
    } catch {
      return { frame }
    }
    const content = parsed?.choices?.[0]?.delta?.content
    return { frame, parsed, content: typeof content === 'string' ? content : undefined }
  })
  const combinedContent = parsedFrames.map(item => item.content ?? '').join('')
  if (combinedContent === visibleContent) return frames

  let contentWritten = false
  return parsedFrames.map((item) => {
    if (item.content === undefined || !item.parsed) return item.frame
    item.parsed.choices[0].delta.content = contentWritten ? '' : visibleContent
    contentWritten = true
    return `data: ${JSON.stringify(item.parsed)}\n\n`
  })
}

/**
 * Qwen occasionally emits a client-tool availability sentence as assistant
 * text immediately before a real tool call (for example, `Tool Read does not
 * exists.`).  Keep this narrowly scoped: callers invoke it only after the
 * same assistant branch has produced a validated structured tool call.  A
 * normal answer therefore retains the literal sentence unchanged.
 */
const QWEN_AI_TOOL_AVAILABILITY_SENTENCE = /Tool\s+[^\s]+\s+does\s+not\s+exist(?:s|\(s\))?\./gi

function qwenAiToolAvailabilityNoiseRanges(content: string): Array<{ start: number, end: number }> {
  if (!content) return []

  const ranges: Array<{ start: number, end: number }> = []
  for (const match of content.matchAll(QWEN_AI_TOOL_AVAILABILITY_SENTENCE)) {
    const start = match.index ?? -1
    if (start < 0) continue
    const end = start + match[0].length
    let removalEnd = end
    while (removalEnd < content.length && (content[removalEnd] === ' ' || content[removalEnd] === '\t')) {
      removalEnd += 1
    }
    if (content[removalEnd] === '\r') removalEnd += 1
    if (content[removalEnd] === '\n') removalEnd += 1
    ranges.push({ start, end: removalEnd })
  }
  return ranges
}

/**
 * Apply the same filter across staged SSE content fragments.  Qwen may split
 * the sentence over several deltas, so ranges are calculated on the joined
 * answer text and then projected back onto each original frame.
 */
function stripQwenAiToolAvailabilityNoiseFromSseFrames(frames: string[]): string[] {
  if (frames.length === 0) return frames
  const parsedFrames: Array<{
    frame: string
    parsed?: any
    segments: Array<{ path: 'delta' | 'message', choiceIndex: number, start: number, end: number }>
  }> = []
  let joined = ''
  let toolCallCutoff = Number.POSITIVE_INFINITY

  for (const frame of frames) {
    const match = /^data: ([^\r\n]+)([\s\S]*)$/.exec(frame)
    if (!match) {
      parsedFrames.push({ frame, segments: [] })
      continue
    }
    let parsed: any
    try {
      parsed = JSON.parse(match[1])
    } catch {
      parsedFrames.push({ frame, segments: [] })
      continue
    }
    const segments: Array<{ path: 'delta' | 'message', choiceIndex: number, start: number, end: number }> = []
    const choices = Array.isArray(parsed?.choices) ? parsed.choices : []
    choices.forEach((choice: any, choiceIndex: number) => {
      const deltaCalls = choice?.delta?.tool_calls
      const messageCalls = choice?.message?.tool_calls
      if (
        (Array.isArray(deltaCalls) && deltaCalls.length > 0)
        || (Array.isArray(messageCalls) && messageCalls.length > 0)
      ) {
        toolCallCutoff = Math.min(toolCallCutoff, joined.length)
      }
      for (const path of ['delta', 'message'] as const) {
        const value = choice?.[path]?.content
        if (typeof value !== 'string') continue
        const start = joined.length
        joined += value
        segments.push({ path, choiceIndex, start, end: joined.length })
      }
    })
    parsedFrames.push({ frame, parsed, segments })
  }

  const ranges = qwenAiToolAvailabilityNoiseRanges(joined)
    .filter(range => range.start < toolCallCutoff)
  if (ranges.length === 0) return frames

  const project = (segment: { start: number, end: number }): string => {
    let value = joined.slice(segment.start, segment.end)
    for (const range of ranges) {
      if (range.end <= segment.start) continue
      if (range.start >= segment.end) break
      const localStart = Math.max(0, range.start - segment.start)
      const localEnd = Math.min(segment.end, range.end) - segment.start
      value = value.slice(0, localStart) + value.slice(localEnd)
    }
    return value
  }

  return parsedFrames.map(item => {
    if (!item.parsed || item.segments.length === 0) return item.frame
    let parsed = item.parsed
    for (const segment of item.segments) {
      const choice = parsed.choices?.[segment.choiceIndex]
      if (!choice?.[segment.path] || typeof choice[segment.path].content !== 'string') continue
      const nextChoice = {
        ...choice,
        [segment.path]: {
          ...choice[segment.path],
          content: project(segment),
        },
      }
      parsed = {
        ...parsed,
        choices: parsed.choices.map((candidate: any, index: number) => (
          index === segment.choiceIndex ? nextChoice : candidate
        )),
      }
    }
    const match = /^data: ([^\r\n]+)([\s\S]*)$/.exec(item.frame)
    if (!match) return item.frame
    return `${item.frame.slice(0, match.index)}data: ${JSON.stringify(parsed)}${match[2]}`
  })
}

function isQwenAiSemanticRecoveryError(error: unknown): boolean {
  const code = isObjectValue(error) && typeof error.code === 'string'
    ? error.code
    : ''
  return code === 'qwen_ai_semantic_empty'
    || code === 'qwen_ai_semantic_incomplete'
    || code === 'qwen_ai_wrapper_leak'
    || code === 'qwen_ai_invalid_tool_arguments'
    || code === 'undeclared_native_tool_call'
    || code === 'malformed_tool_call'
    || code === 'missing_tool_call'
    || isQwenAiStaleSessionError(error)
}

function createQwenAiToolValidationError(
  failure: ToolStreamValidationFailure,
): QwenAiUpstreamError {
  const error = new Error(failure.message) as QwenAiUpstreamError
  error.status = 422
  error.type = failure.type
  error.param = failure.param
  error.code = failure.code
  error.retryable = false
  error.accountFault = false
  return error
}

function createQwenAiUndeclaredNativeToolError(names: string[]): QwenAiUpstreamError {
  const uniqueNames = [...new Set(names.filter(Boolean))]
  const error = new Error(
    `Provider returned undeclared native tool call${uniqueNames.length === 1 ? '' : 's'}: ${uniqueNames.join(', ')}`,
  ) as QwenAiUpstreamError
  error.status = 422
  error.type = 'upstream_tool_error'
  error.param = 'tool_calls'
  error.code = 'undeclared_native_tool_call'
  error.retryable = false
  error.accountFault = false
  return error
}

const QWEN_AI_INTERNAL_NATIVE_TOOL_NAMES = new Set([
  'web_search',
  'web_extractor',
  'code_interpreter',
])

function isQwenAiInternalNativeTool(name: string): boolean {
  return QWEN_AI_INTERNAL_NATIVE_TOOL_NAMES.has(name.trim().toLowerCase())
}

function createQwenAiIncompleteNativeToolError(names: string[]): QwenAiUpstreamError {
  const uniqueNames = [...new Set(names.filter(Boolean))]
  return createQwenAiToolValidationError({
    message: `Provider returned declared native tool call${uniqueNames.length === 1 ? '' : 's'} with incomplete JSON arguments: ${uniqueNames.join(', ')}`,
    type: 'tool_call_parse_error',
    param: 'tool_calls',
    code: 'malformed_tool_call',
  })
}

function normalizeQwenAiStreamFailure(error: unknown): QwenAiUpstreamError {
  const source = error instanceof Error ? error : new Error(String(error))
  const sourceRecord = source as QwenAiUpstreamError
  if (isQwenAiStaleSessionError(source)) {
    return markQwenAiStaleSessionError(sourceRecord)
  }
  const declaredStatus = typeof sourceRecord.status === 'number'
    && sourceRecord.status >= 400
    && sourceRecord.status <= 599
    ? sourceRecord.status
    : undefined
  const cancellationCandidate = declaredStatus === undefined
    ? {
        name: source.name,
        code: sourceRecord.code,
        message: source.message,
      }
    : source
  const status = declaredStatus
    ?? (isClientCancellationError(cancellationCandidate)
      ? 499
      : /timed out|timeout|idle for more than/i.test(source.message)
        ? 504
        : 502)

  if (sourceRecord.status === status && typeof sourceRecord.retryable === 'boolean') {
    return sourceRecord
  }

  const normalized = new Error(source.message) as QwenAiUpstreamError
  normalized.name = source.name
  normalized.stack = source.stack
  normalized.status = status
  normalized.retryable = typeof sourceRecord.retryable === 'boolean'
    ? sourceRecord.retryable
    : false
  if (typeof sourceRecord.type === 'string') normalized.type = sourceRecord.type
  if (typeof sourceRecord.param === 'string') normalized.param = sourceRecord.param
  if (typeof sourceRecord.code === 'string') normalized.code = sourceRecord.code
  if (typeof sourceRecord.accountFault === 'boolean') normalized.accountFault = sourceRecord.accountFault
  if (sourceRecord.retryScope === 'next-account') normalized.retryScope = sourceRecord.retryScope
  if (sourceRecord.upstreamState) normalized.upstreamState = sourceRecord.upstreamState
  normalized.headers = sanitizeForwardedErrorHeaders(sourceRecord.headers)
  return normalized
}

function enforceQwenAiFailoverBoundary(
  error: QwenAiUpstreamError,
  canFailoverRequest?: () => boolean,
): QwenAiUpstreamError {
  if (error.retryScope !== 'next-account' || !canFailoverRequest) return error

  try {
    if (!canFailoverRequest()) delete error.retryScope
  } catch {
    delete error.retryScope
  }
  return error
}

export function isQwenAiUpstreamBusyMessage(message: string): boolean {
  const hasValidationEnvelope = /FAIL_SYS_USER_VALIDATE|RGV587/i.test(message)
  const hasBusySignal = /被挤爆|挤爆|请稍后重试|服务繁忙|系统繁忙|当前服务繁忙|(?:service|server|system) busy|overload(?:ed|ing)?|try again later|鍝庡摕鍠倈琚尋鐖唡鏈嶅姟绻佸繖|绯荤粺绻佸繖/i.test(message)
  const hasChallengeSignal = /challenge|captcha|x5sec|bxpunish|baxia|punish|验证码|人机验证/i.test(message)
  return hasValidationEnvelope && hasBusySignal && !hasChallengeSignal
}

function isQwenAiUpstreamBusyError(error: unknown): boolean {
  if (!error) return false
  const record = isObjectValue(error) ? error : undefined
  const code = typeof record?.code === 'string' ? record.code : ''
  if (code === 'qwen_ai_upstream_busy') return true

  const status = typeof record?.status === 'number'
    ? record.status
    : isObjectValue(record?.response) && typeof record.response.status === 'number'
      ? record.response.status
      : undefined
  const message = error instanceof Error
    ? error.message
    : typeof record?.message === 'string' ? record.message : String(error)
  return status === 503 && (
    isQwenAiUpstreamBusyMessage(message)
    || /(?:目前|当前).*服务.*(访问量|繁忙)|service\s+busy|overload|try again later/i.test(message)
  )
}

function isQwenAiRiskControlMessage(message: string): boolean {
  return !isQwenAiUpstreamBusyMessage(message)
    && /FAIL_SYS_USER_VALIDATE|RGV587|risk-control|challenge|captcha|x5sec|baxia|punish/i.test(message)
}

function isQwenAiRateLimitMessage(message: string): boolean {
  return /(?:^|\D)429(?:\D|$)|too many requests|rate.?limit|throttl|quota(?:[_\s-]?(?:limit|exceeded|exhausted))?|resource[_\s-]?exhausted|(?:service|server) busy|overload(?:ed|ing)?|哎哟喂|被挤爆|服务繁忙|系统繁忙/i.test(message)
}

function qwenAiErrorValueText(value: unknown): string {
  if (typeof value === 'string') return value.trim()
  if (Array.isArray(value)) {
    return value
      .map(item => qwenAiErrorValueText(item))
      .filter(Boolean)
      .join('; ')
  }
  if (!isObjectValue(value)) return ''

  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

function extractQwenAiErrorMessage(value: unknown): string {
  if (typeof value === 'string') return value.trim()
  if (Array.isArray(value)) return qwenAiErrorValueText(value)
  if (!isObjectValue(value)) return ''

  const ret = Array.isArray(value.ret)
    ? value.ret.filter((item): item is string => typeof item === 'string' && Boolean(item.trim())).join('; ')
    : ''
  const error = value.error
  const errors = value.errors
  const data = isObjectValue(value.data) ? value.data : undefined
  const nestedError = isObjectValue(error)
    ? extractQwenAiErrorMessage(error)
    : qwenAiErrorValueText(error)
  const nestedErrors = qwenAiErrorValueText(errors)
  const nestedData = data ? extractQwenAiErrorMessage(data) : ''
  const directMessage = typeof value.message === 'string' ? value.message.trim() : ''
  const directMsg = typeof value.msg === 'string' ? value.msg.trim() : ''
  const directDetails = typeof value.details === 'string' ? value.details.trim() : ''
  const directDetail = typeof value.detail === 'string' ? value.detail.trim() : ''
  const directReason = typeof value.reason === 'string' ? value.reason.trim() : ''
  const directDescription = typeof value.description === 'string' ? value.description.trim() : ''
  const directCode = typeof value.code === 'string' ? value.code.trim() : ''
  return directMessage
    || directMsg
    || directDetails
    || directDetail
    || directReason
    || directDescription
    || directCode
    || nestedError
    || nestedErrors
    || nestedData
    || ret
}

function redactQwenAiErrorText(value: string): string {
  return value
    .replace(/https?:\/\/[^\s"',}]+/gi, '[REDACTED_URL]')
    .replace(/(x5secdata|x5sectag|cookie|authorization|token)=([^&\s"',}]+)/gi, '$1=[REDACTED]')
    .replace(/\s+/g, ' ')
    .slice(0, 500)
}

function readQwenAiEnvelopeStatus(
  record: Record<string, unknown>,
  includeTopLevelCode = true,
): number | undefined {
  const candidates: unknown[] = [
    record.status,
    record.statusCode,
    record.httpStatus,
    record.error,
    record.errors,
  ]
  if (includeTopLevelCode) candidates.splice(3, 0, record.code)

  const visit = (candidate: unknown): number | undefined => {
    if (Array.isArray(candidate)) {
      for (const item of candidate) {
        const status = visit(item)
        if (status !== undefined) return status
      }
      return undefined
    }
    if (isObjectValue(candidate)) {
      for (const key of ['status', 'statusCode', 'httpStatus', 'code']) {
        const status = visit(candidate[key])
        if (status !== undefined) return status
      }
      return undefined
    }

    const status = typeof candidate === 'number'
      ? candidate
      : typeof candidate === 'string' && /^\d{3}$/.test(candidate.trim())
        ? Number(candidate)
        : undefined
    return status !== undefined && status >= 400 && status <= 599 ? status : undefined
  }

  for (const candidate of candidates) {
    const status = visit(candidate)
    if (status !== undefined) return status
  }

  return undefined
}

function extractQwenAiErrorEnvelopeMetadata(
  sources: unknown[],
): QwenAiErrorEnvelopeMetadata {
  const queue = [...sources]
  const visited = new Set<object>()
  let metadata: QwenAiErrorEnvelopeMetadata = {}

  while (queue.length > 0) {
    const value = queue.shift()
    if (Array.isArray(value)) {
      queue.push(...value)
      continue
    }
    if (!isObjectValue(value) || visited.has(value)) continue
    visited.add(value)

    const stringValue = (candidate: unknown): string | undefined => {
      if (typeof candidate === 'string' && candidate.trim()) return candidate.trim()
      if (typeof candidate === 'number' && Number.isFinite(candidate)) return String(candidate)
      return undefined
    }
    metadata = {
      status: metadata.status ?? readQwenAiEnvelopeStatus(value),
      type: metadata.type ?? stringValue(value.type),
      param: metadata.param ?? stringValue(value.param),
      code: metadata.code ?? stringValue(value.code),
      retryable: metadata.retryable ?? (
        typeof value.retryable === 'boolean' ? value.retryable : undefined
      ),
    }

    queue.push(value.error, value.errors, value.data)
  }

  return metadata
}

function createQwenAiStreamEnvelopeError(
  data: unknown,
  raw: string,
  eventType?: string,
): QwenAiUpstreamError | undefined {
  const record = isObjectValue(data) ? data : undefined
  const eventLooksLikeError = typeof eventType === 'string' && /error|fail|reject/i.test(eventType)

  // A non-JSON payload is only an upstream error when the SSE event itself is
  // marked as an error. Normal SSE data must still use the parser's regular
  // JSON error path below.
  if (!record) {
    if (!eventLooksLikeError) return undefined
    const message = typeof data === 'string' ? data.trim() : raw.trim()
    const isUpstreamBusy = isQwenAiUpstreamBusyMessage(message)
    const isRiskControl = isQwenAiRiskControlMessage(message)
    const isRateLimited = !isUpstreamBusy && isQwenAiRateLimitMessage(message)
    const isResponseEnded = isQwenAiResponseEndedError(message)
    if (!message && !isUpstreamBusy && !isRiskControl && !isRateLimited) return undefined
    const error = new Error(
      `Qwen AI upstream stream rejected the request: ${redactQwenAiErrorText(message) || 'unknown error'}`,
    ) as QwenAiUpstreamError
    error.status = isUpstreamBusy ? 503 : isRiskControl ? 403 : isRateLimited ? 429 : 502
    error.retryable = false
    if (isResponseEnded) {
      markQwenAiResponseEnded(error)
    } else if (isUpstreamBusy) {
      error.code = 'qwen_ai_upstream_busy'
      error.retryable = true
      error.accountFault = false
    } else if (isRiskControl) {
      error.code = 'qwen_ai_risk_control'
      error.retryable = true
      markQwenAiNextAccountFailure(error)
    } else if (isRateLimited) {
      error.code = 'qwen_ai_capacity_limit'
    }
    if (isResponseEnded) {
      // The generation is terminal. Recovery may replay it in a fresh chat on
      // the same credential, but it must never rotate the account.
    } else if (error.status === 401 || error.status === 403 || isRiskControl || isRateLimited) {
      markQwenAiNextAccountFailure(error)
    } else if (error.status >= 500) {
      error.accountFault = false
      delete error.retryScope
    }
    if (isQwenAiStaleSessionError(error)) {
      return markQwenAiStaleSessionError(error)
    }
    return error
  }

  const hasErrorField = record.error !== undefined && record.error !== null && record.error !== false
  const hasErrorsField = Array.isArray(record.errors)
    ? record.errors.length > 0
    : record.errors !== undefined && record.errors !== null && record.errors !== false
  const hasRetField = Array.isArray(record.ret) && record.ret.length > 0
  const isOrdinaryResponse = Boolean(
    'choices' in record
    || 'response.created' in record
    || 'usage' in record
  )
  const explicitStatus = readQwenAiEnvelopeStatus(
    record,
    !isOrdinaryResponse || hasErrorField || hasErrorsField || eventLooksLikeError,
  )
  const structuredMessage = extractQwenAiErrorMessage(record)
  const hasStructuredMessage = Boolean(structuredMessage)
  const hasRetError = hasRetField && (
    !isOrdinaryResponse
    || /(?:error|fail|reject|invalid|risk|captcha)/i.test(structuredMessage)
    || isQwenAiRateLimitMessage(structuredMessage)
    || eventLooksLikeError
  )
  const hasExplicitError = Boolean(
    hasErrorField
    || hasErrorsField
    || record.success === false
    || record.ok === false
    || explicitStatus !== undefined
  )
  const hasErrorSignal = Boolean(
    hasExplicitError
    || hasRetError
    || (!isOrdinaryResponse && hasStructuredMessage)
    || (eventLooksLikeError && hasStructuredMessage)
    || (eventLooksLikeError && !isOrdinaryResponse)
  )
  const envelopeMetadata = extractQwenAiErrorEnvelopeMetadata([
    ...(hasErrorField ? [record.error] : []),
    ...(hasErrorsField ? [record.errors] : []),
    ...(!isOrdinaryResponse && hasErrorSignal ? [record] : []),
  ])

  // Completion envelopes may contain arbitrary numeric values (for example
  // usage.output_tokens_details.text_tokens = 429). A completion envelope is
  // ignored unless it carries an explicit error/status or an error message;
  // this also protects normal data sent with a misleading event name.
  if (isOrdinaryResponse && !hasErrorSignal) {
    return undefined
  }

  const classificationEvidence = [
    structuredMessage,
    qwenAiErrorValueText(record.ret),
    qwenAiErrorValueText(record.error),
    qwenAiErrorValueText(record.errors),
    qwenAiErrorValueText(record.data),
    qwenAiErrorValueText(record.code),
    qwenAiErrorValueText(record.type),
  ].filter(Boolean).join('; ')
  const isUpstreamBusy = hasErrorSignal && isQwenAiUpstreamBusyMessage(classificationEvidence)
  const isRiskControl = !isUpstreamBusy
    && hasErrorSignal
    && isQwenAiRiskControlMessage(classificationEvidence)
  const isChatInProgress = isQwenAiChatInProgressEnvelope(record)
  const isRateLimited = !isUpstreamBusy && !isChatInProgress && (explicitStatus === 429 || (
    hasErrorSignal
    && isQwenAiRateLimitMessage(classificationEvidence)
  ))
  const isResponseEnded = isQwenAiResponseEndedError(classificationEvidence)
  const isStaleSession = isQwenAiStaleSessionError({
    status: explicitStatus,
    code: envelopeMetadata.code,
    message: classificationEvidence,
    data: record,
  })

  if (!isUpstreamBusy && !isRiskControl && !hasErrorSignal && !isRateLimited) return undefined

  const message = redactQwenAiErrorText(structuredMessage || raw)
  const error = new Error(`Qwen AI upstream stream rejected the request: ${message || 'unknown error'}`) as QwenAiUpstreamError
  error.status = isUpstreamBusy
    ? 503
    : isRiskControl
      ? 403
      : isChatInProgress
        ? 429
        : isRateLimited
          ? 429
          : explicitStatus ?? 502
  error.retryable = envelopeMetadata.retryable ?? false
  if (envelopeMetadata.type) error.type = envelopeMetadata.type
  if (envelopeMetadata.param) error.param = envelopeMetadata.param
  if (isResponseEnded) {
    markQwenAiResponseEnded(error)
  } else if (isUpstreamBusy) {
    error.code = 'qwen_ai_upstream_busy'
    error.retryable = true
    error.accountFault = false
  } else if (isRiskControl) {
    error.code = 'qwen_ai_risk_control'
  } else if (isChatInProgress) {
    error.code = 'CHAT_IN_PROGRESS'
    error.retryable = true
    error.accountFault = false
  } else if (isRateLimited) {
    error.code = 'qwen_ai_capacity_limit'
  } else if (envelopeMetadata.code) {
    error.code = envelopeMetadata.code
  }
  if (isStaleSession) {
    return markQwenAiStaleSessionError(error)
  }
  if (isResponseEnded) {
    // Same-account fresh-chat recovery owns this exact terminal response.
  } else if (isUpstreamBusy) {
    // Provider congestion is tied to this request shape, not the credential.
  } else if (isChatInProgress) {
    error.accountFault = false
    delete error.retryScope
  } else if (error.status === 401 || error.status === 403 || isRiskControl || isRateLimited) {
    markQwenAiNextAccountFailure(error)
  } else if (error.status >= 500) {
    error.accountFault = false
    delete error.retryScope
  }
  return error
}

export function findModelCapability(
  provider: Provider,
  requestedModel: string,
  modelId: string,
): ProviderModelCapability | undefined {
  const capabilities = provider.modelCapabilities
  if (!capabilities) return undefined

  // Feature suffixes are client-side aliases, not distinct upstream models.
  // Resolve them to the base model before looking up live capability metadata.
  const normalizeCapabilityKey = (value: string): string => value
    .replace(/(?:-(?:web-search|thinking|think|search|fast|r1))+$/i, '')
    .toLowerCase()
  const normalizeQwenCapabilityKey = (value: string): string => normalizeCapabilityKey(
    normalizeQwenAiModelModeName(value),
  )

  const candidates = new Set<string>([
    requestedModel,
    modelId,
    normalizeQwenAiModelModeName(requestedModel),
    normalizeQwenAiModelModeName(modelId),
    requestedModel.replace(/(?:-(?:web-search|thinking|think|search|fast|r1))+$/i, ''),
    modelId.replace(/(?:-(?:web-search|thinking|think|search|fast|r1))+$/i, ''),
  ])
  for (const [displayName, mappedId] of Object.entries(provider.modelMappings || {})) {
    if (
      normalizeQwenCapabilityKey(mappedId) === normalizeQwenCapabilityKey(modelId)
      || normalizeQwenCapabilityKey(displayName) === normalizeQwenCapabilityKey(requestedModel)
    ) {
      candidates.add(displayName)
      candidates.add(mappedId)
    }
  }

  const normalizedCandidates = new Set([...candidates].map(normalizeQwenCapabilityKey))
  for (const candidate of candidates) {
    if (Object.prototype.hasOwnProperty.call(capabilities, candidate)) {
      return capabilities[candidate]
    }
  }
  for (const [key, capability] of Object.entries(capabilities).reverse()) {
    if (normalizedCandidates.has(normalizeQwenCapabilityKey(key))) {
      return capability
    }
  }

  return undefined
}

/**
 * Resolve an old generic suffix only when it was not one of the deterministic
 * Qwen3.8-Max aliases. This preserves existing `-thinking`/`-fast` clients.
 */
function resolveLegacyQwenThinkingMode(modelName: string): boolean | undefined {
  const modelLower = modelName.toLowerCase()
  if (modelLower.endsWith('-thinking')) return true
  if (modelLower.endsWith('-fast')) return false
  if (modelLower.includes('think') || modelLower.includes('r1')) return true
  return undefined
}

export function resolveQwenAiFeatureMode(
  requestedModel: string,
  requestedThinking: boolean | undefined,
  capability: ProviderModelCapability | undefined,
): { thinkingEnabled: boolean; autoThinking: boolean } {
  const modelMode = resolveQwenAiModelMode(requestedModel)
  if (modelMode.thinkingEnabled !== undefined) {
    return {
      thinkingEnabled: modelMode.thinkingEnabled,
      autoThinking: modelMode.autoThinking ?? modelMode.thinkingEnabled,
    }
  }

  const legacyThinking = resolveLegacyQwenThinkingMode(requestedModel)
  const thinkingEnabled = resolveQwenThinkingEnabled(
    requestedThinking,
    legacyThinking,
    capability,
  )

  return {
    thinkingEnabled,
    // Keep prior behavior for other Qwen models while Qwen3.8-Max aliases
    // deliberately control this flag independently.
    autoThinking: thinkingEnabled,
  }
}

export function resolveQwenThinkingEnabled(
  requested: boolean | undefined,
  forced: boolean | undefined,
  capability: ProviderModelCapability | undefined,
): boolean {
  if (capability?.thinkingSkippable === false) return true
  return requested ?? forced ?? false
}

export class QwenAiAdapter {
  private provider: Provider
  private account: Account
  private tokenRefresher = new QwenAiTokenRefresher()
  private deleteChatRequests = new Map<string, Promise<boolean>>()
  private axiosInstance = axios.create({
    timeout: QWEN_AI_REQUEST_TIMEOUT_MS,
    maxBodyLength: Infinity,
    maxContentLength: Infinity,
  })

  constructor(provider: Provider, account: Account) {
    this.provider = provider
    this.account = account
  }

  private async refreshTokenIfNeeded(signal?: AbortSignal): Promise<void> {
    this.account = await this.tokenRefresher.refreshIfNeeded(this.account, signal)
  }

  private async postWithRefreshRetry(
    url: string,
    payload: unknown,
    createOptions: () => Record<string, any>,
  ): Promise<AxiosResponse> {
    let options = createOptions()
    let response = await this.axiosInstance.post(url, payload, options)

    if (response.status === 401) {
      this.account = await this.tokenRefresher.refreshAfterUnauthorized(this.account, options.signal)
      options = createOptions()
      response = await this.axiosInstance.post(url, payload, options)
    }

    return response
  }

  private async getWithRefreshRetry(
    url: string,
    createOptions: () => Record<string, any>,
  ): Promise<AxiosResponse> {
    let options = createOptions()
    let response = await this.axiosInstance.get(url, options)

    if (response.status === 401) {
      destroyReadableStream(response.data)
      this.account = await this.tokenRefresher.refreshAfterUnauthorized(this.account, options.signal)
      options = createOptions()
      response = await this.axiosInstance.get(url, options)
    }

    return response
  }

  private getToken(): string {
    const credentials = this.account.credentials
    return credentials.token || credentials.accessToken || credentials.apiKey || ''
  }

  private getCookies(): string {
    const credentials = this.account.credentials
    const cookies = credentials.cookies || credentials.cookie || ''
    if (typeof cookies === 'string') {
      return cookies
    }
    if (isObjectValue(cookies)) {
      return Object.entries(cookies)
        .filter(([, value]) => typeof value === 'string' && value)
        .map(([key, value]) => `${key}=${value}`)
        .join('; ')
    }
    return ''
  }

  private getCredentialValue(...keys: string[]): string {
    const credentials = this.account.credentials
    for (const key of keys) {
      const value = credentials[key]
      if (typeof value === 'string' && value.trim()) {
        return value.trim()
      }
    }
    return ''
  }

  private getHeaders(chatId?: string): Record<string, string> {
    const cookies = this.getCookies()
    const token = this.getToken()
    const headers: Record<string, string> = {
      ...DEFAULT_HEADERS,
      'X-Request-Id': uuid(),
      Timezone: currentTimezoneHeader(),
      ...resolveQwenAiAuthHeaders(token, cookies),
    }

    if (chatId) {
      headers['Referer'] = `https://chat.qwen.ai/c/${chatId}`
    }

    const baxiaUidToken = this.getCredentialValue('baxiaUidToken', 'baxia_uid_token', 'uidToken')
    if (baxiaUidToken) {
      headers['bx-umidtoken'] = baxiaUidToken
    }

    const baxiaUa = this.getCredentialValue('baxiaUa', 'baxia_ua', 'bxUa', 'bx_ua')
    if (baxiaUa) {
      headers['bx-ua'] = baxiaUa
    }

    const baxiaVersion = this.getCredentialValue('baxiaVersion', 'baxia_version', 'bxV', 'bx_v')
    if (baxiaVersion) {
      headers['bx-v'] = baxiaVersion
    }

    const x5secdata = this.getCredentialValue('x5secdata')
    if (x5secdata) {
      headers['x5secdata'] = x5secdata
    }

    const x5sectag = this.getCredentialValue('x5sectag')
    if (x5sectag) {
      headers['x5sectag'] = x5sectag
    }

    if (!token && !hasQwenAiSessionCookie(cookies)) {
      console.warn('[QwenAI] Warning: No JWT or session token cookie provided. Requests may fail authentication.')
      console.warn('[QwenAI] Required cookies: cnaui, aui, sca, xlly_s, cna, token, _bl_uid, x-ap')
    }

    return headers
  }

  private sanitizeHeadersForLog(headers: Record<string, any>): Record<string, unknown> {
    const sensitiveHeaders = new Set([
      'authorization',
      'cookie',
      'set-cookie',
      'bx-ua',
      'bx-umidtoken',
      'x5secdata',
      'x5sectag',
    ])

    return Object.fromEntries(
      Object.entries(headers).map(([key, value]) => [
        key,
        sensitiveHeaders.has(key.toLowerCase()) ? '[REDACTED]' : value,
      ]),
    )
  }

  private sanitizePayloadForLog(value: unknown): unknown {
    if (Array.isArray(value)) {
      return value.map(item => this.sanitizePayloadForLog(item))
    }

    if (typeof value === 'string' && value.includes(QWEN_AI_DOCUMENT_EVIDENCE_MARKER)) {
      return `${value.slice(0, value.indexOf(QWEN_AI_DOCUMENT_EVIDENCE_MARKER))}${QWEN_AI_DOCUMENT_EVIDENCE_MARKER}\n[REDACTED_DOCUMENT_EVIDENCE]`
    }

    if (value && typeof value === 'object') {
      return Object.fromEntries(
        Object.entries(value as Record<string, unknown>).map(([key, item]) => [
          key,
          key === 'url' ? '[REDACTED_URL]' : this.sanitizePayloadForLog(item),
        ]),
      )
    }

    return value
  }

  private summarizePayloadForLog(payload: Record<string, any>): Record<string, unknown> {
    const messages = Array.isArray(payload.messages) ? payload.messages : []
    const primaryMessage = messages[0] || {}
    const content = primaryMessage.content
    const contentChars = typeof content === 'string'
      ? content.length
      : (() => {
          try {
            return JSON.stringify(content || '').length
          } catch {
            return 0
          }
        })()

    return {
      stream: payload.stream,
      model: payload.model,
      chat_id: payload.chat_id,
      chat_mode: payload.chat_mode,
      messageCount: messages.length,
      contentChars,
      fileCount: Array.isArray(primaryMessage.files) ? primaryMessage.files.length : 0,
      feature_config: primaryMessage.feature_config,
      timestamp: payload.timestamp,
    }
  }

  private async readStreamPreview(
    stream: any,
    maxBytes = 4096,
    options: { signal?: AbortSignal; timeoutMs?: number } = {},
  ): Promise<string> {
    if (!stream) return ''
    if (typeof stream === 'string') return stream.slice(0, maxBytes)
    if (Buffer.isBuffer(stream)) return stream.toString('utf8', 0, maxBytes)
    if (typeof stream !== 'object' || typeof stream.on !== 'function') {
      try {
        return JSON.stringify(stream).slice(0, maxBytes)
      } catch {
        return String(stream).slice(0, maxBytes)
      }
    }

    const chunks: Buffer[] = []
    let total = 0

    await new Promise<void>((resolve) => {
      let done = false
      let timer: NodeJS.Timeout | undefined

      const cleanup = () => {
        if (timer) {
          clearTimeout(timer)
          timer = undefined
        }
        options.signal?.removeEventListener('abort', onAbort)
        if (typeof stream.removeListener === 'function') {
          stream.removeListener('data', onData)
          stream.removeListener('end', finish)
          stream.removeListener('close', finish)
          stream.removeListener('error', finish)
        }
      }

      const finish = () => {
        if (!done) {
          done = true
          cleanup()
          resolve()
        }
      }

      const onData = (chunk: Buffer | string) => {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk))
        const remaining = maxBytes - total
        if (remaining > 0) {
          chunks.push(buffer.subarray(0, remaining))
          total += Math.min(buffer.length, remaining)
        }
        if (total >= maxBytes && typeof stream.destroy === 'function') {
          stream.destroy()
        }
      }

      const onAbort = () => {
        if (typeof stream.destroy === 'function' && !stream.destroyed) {
          stream.destroy()
        }
        finish()
      }

      stream.on('data', onData)
      stream.once('end', finish)
      stream.once('close', finish)
      stream.once('error', finish)

      const timeoutMs = options.timeoutMs ?? QWEN_AI_REQUEST_TIMEOUT_MS
      if (timeoutMs > 0 && Number.isFinite(timeoutMs)) {
        timer = setTimeout(() => {
          if (typeof stream.destroy === 'function' && !stream.destroyed) {
            stream.destroy()
          }
          finish()
        }, timeoutMs)
      }
      options.signal?.addEventListener('abort', onAbort, { once: true })
      if (options.signal?.aborted) onAbort()
    })

    return Buffer.concat(chunks).toString('utf8')
  }

  private extractUpstreamErrorMessage(body: string): string {
    const trimmed = body.trim()
    if (!trimmed) return ''

    try {
      const parsed = JSON.parse(trimmed)
      const message = extractQwenAiErrorMessage(parsed)
      if (message) return message
    } catch {
      // Fall back to a compact body preview below.
    }

    return redactQwenAiErrorText(trimmed)
  }

  private hasRiskControlHeaders(headers: Record<string, any>): boolean {
    const setCookie = headers['set-cookie']
    const setCookieText = Array.isArray(setCookie) ? setCookie.join('\n') : String(setCookie || '')

    return Boolean(
      headers.bxpunish ||
      headers['bxpunish'] ||
      headers['x5secdata'] ||
      headers['x5sectag'] ||
      /x5sec/i.test(setCookieText),
    )
  }

  private isRiskControlMessage(message: string): boolean {
    return isQwenAiRiskControlMessage(message)
  }

  private async createInvalidStreamError(
    response: AxiosResponse,
    reason: string,
    bodyPreview?: string,
    previewOptions: { signal?: AbortSignal; timeoutMs?: number } = {},
  ): Promise<QwenAiUpstreamError> {
    const contentType = String(response.headers?.['content-type'] || 'unknown')
    const body = bodyPreview ?? await this.readStreamPreview(response.data, 4096, previewOptions)
    const upstreamMessage = this.extractUpstreamErrorMessage(body)
    const detail = upstreamMessage ? `: ${upstreamMessage}` : ''

    let envelopeError: QwenAiUpstreamError | undefined
    let chatInProgress = false
    try {
      const parsedBody = JSON.parse(body)
      envelopeError = createQwenAiStreamEnvelopeError(parsedBody, body, 'error')
      if (isObjectValue(parsedBody)) {
        chatInProgress = isQwenAiChatInProgressEnvelope(parsedBody)
      }
    } catch {
      envelopeError = createQwenAiStreamEnvelopeError(body, body, 'error')
    }

    // Qwen can attach generic validation/challenge headers to a structured
    // provider-congestion response. The body is more specific: an explicit
    // RGV587 busy envelope must remain request-scoped instead of cooling the
    // account merely because the response also carried those headers.
    const isUpstreamBusy = (
      envelopeError?.code === 'qwen_ai_upstream_busy'
      || isQwenAiUpstreamBusyMessage(upstreamMessage)
    )
    const isRiskControl = !isUpstreamBusy && !chatInProgress && (envelopeError?.status === 403
      || this.isRiskControlMessage(upstreamMessage)
      || reason.includes('risk-control'))
    const isResponseEnded = isQwenAiResponseEndedError(envelopeError || upstreamMessage)
    const isCapacityLimit = !isUpstreamBusy
      && !isRiskControl
      && !chatInProgress
      && !isResponseEnded
      && (response.status === 429 || envelopeError?.status === 429)
    const upstreamStatus = response.status >= 400 && response.status <= 599
      ? response.status
      : 502
    // The response headers may look like a WAF challenge even when Qwen's
    // body explicitly says the service is overloaded (RGV587). Keep the
    // client-facing reason aligned with the body classification so callers
    // do not treat a retryable busy response as an account challenge.
    const effectiveReason = isUpstreamBusy
      ? 'returned an upstream-busy response instead of a chat event stream'
      : reason
    const error = new Error(`Qwen AI upstream ${effectiveReason} (HTTP ${response.status}, content-type ${contentType})${detail}`) as QwenAiUpstreamError
    // Preserve only retry pacing metadata. The governor uses Retry-After to
    // distinguish ordinary quota throttling without exposing upstream cookies
    // or transport headers to the client.
    error.status = isResponseEnded
      ? 502
      : isUpstreamBusy
        ? 503
        : isRiskControl
          ? 403
          : chatInProgress
            ? 429
            : isCapacityLimit
              ? 429
              : upstreamStatus
    error.headers = sanitizeForwardedErrorHeaders(response.headers)
    error.retryable = envelopeError?.retryable ?? false
    if (envelopeError?.type) error.type = envelopeError.type
    if (envelopeError?.param) error.param = envelopeError.param
    if (isResponseEnded) {
      markQwenAiResponseEnded(error)
    } else if (isUpstreamBusy) {
      error.code = 'qwen_ai_upstream_busy'
      error.retryable = true
      error.accountFault = false
    } else if (isRiskControl) {
      error.code = 'qwen_ai_risk_control'
    } else if (chatInProgress) {
      error.status = 429
      error.code = 'CHAT_IN_PROGRESS'
      error.retryable = true
      error.accountFault = false
      delete error.retryScope
    } else if (isCapacityLimit) {
      error.code = 'qwen_ai_capacity_limit'
      // Capacity throttling is account-local and should fail over to another
      // healthy account instead of surfacing an API error to the client.
      error.retryable = true
      markQwenAiNextAccountFailure(error)
    } else if (envelopeError?.code) {
      error.code = envelopeError.code
    }
    if (isResponseEnded) {
      // A permanently ended response is replayed once in a fresh chat using
      // this same adapter/account.
    } else if (isUpstreamBusy) {
      // Keep the outer retry on this account; do not enter pool failover.
    } else if (chatInProgress) {
      error.accountFault = false
      delete error.retryScope
    } else if (error.status === 401 || error.status === 403 || isRiskControl || isCapacityLimit) {
      markQwenAiNextAccountFailure(error)
    } else if (error.status >= 500) {
      error.accountFault = false
      delete error.retryScope
    }
    if (isQwenAiStaleSessionError(error)) {
      return markQwenAiStaleSessionError(error)
    }
    return error
  }

  private async assertChatCompletionStreamResponse(
    response: AxiosResponse,
    options: {
      allowChatInProgress?: boolean
      previewTimeoutMs?: number
      signal?: AbortSignal
    } = {},
  ): Promise<{ chatInProgress: boolean; error?: QwenAiUpstreamError }> {
    if (options.signal?.aborted) {
      throw createQwenAiContinuationAbortError()
    }
    const contentType = String(response.headers?.['content-type'] || '').toLowerCase()
    const classifyChatInProgress = (
      error: QwenAiUpstreamError,
      body?: string,
    ): boolean => {
      const chatInProgress = error.code === 'CHAT_IN_PROGRESS'
        || (body !== undefined && isQwenAiChatInProgressEnvelope(parseJsonSafely(body)))
      if (!chatInProgress) return false

      error.status = 429
      error.code = 'CHAT_IN_PROGRESS'
      error.retryable = true
      error.accountFault = false
      delete error.retryScope
      return true
    }

    if (response.status >= 400) {
      const error = await this.createInvalidStreamError(
        response,
        `returned HTTP ${response.status}`,
        undefined,
        {
          signal: options.signal,
          timeoutMs: options.previewTimeoutMs,
        },
      )
      if (options.signal?.aborted) {
        throw createQwenAiContinuationAbortError()
      }
      if (classifyChatInProgress(error) && options.allowChatInProgress) {
        return { chatInProgress: true, error }
      }
      throw error
    }

    if (this.hasRiskControlHeaders(response.headers || {})) {
      const error = await this.createInvalidStreamError(
        response,
        'returned a risk-control or challenge response instead of a chat event stream',
        undefined,
        {
          signal: options.signal,
          timeoutMs: options.previewTimeoutMs,
        },
      )
      if (options.signal?.aborted) {
        throw createQwenAiContinuationAbortError()
      }
      if (classifyChatInProgress(error) && options.allowChatInProgress) {
        return { chatInProgress: true, error }
      }
      throw error
    }

    if (contentType.includes('application/json') || contentType.includes('text/html')) {
      const body = await this.readStreamPreview(response.data, 4096, {
        signal: options.signal,
        timeoutMs: options.previewTimeoutMs,
      })
      if (options.signal?.aborted) {
        throw createQwenAiContinuationAbortError()
      }
      const error = await this.createInvalidStreamError(
        response,
        'returned a non-stream response instead of a chat event stream',
        body,
      ) as QwenAiUpstreamError

      const chatInProgress = classifyChatInProgress(error, body)
      if (chatInProgress) {
        if (options.allowChatInProgress) {
          return { chatInProgress: true, error }
        }
      }

      throw error
    }

    return { chatInProgress: false }
  }

  mapModel(openaiModel: string): string {
    const model = normalizeQwenAiModelModeName(openaiModel)
      .replace(/-(?:thinking|fast)$/i, '')
    const lowerModel = model.toLowerCase()
    
    if (this.provider.modelMappings) {
      for (const [key, value] of Object.entries(this.provider.modelMappings)) {
        if (key.toLowerCase() === lowerModel) {
          return value
        }
      }
    }

    if (MODEL_ALIASES[lowerModel]) {
      return MODEL_ALIASES[lowerModel]
    }
    
    return model
  }

  async createChat(
    modelId: string,
    title: string = 'New Chat',
    signal?: AbortSignal,
    chatType: 't2t' | 't2i' = 't2t',
  ): Promise<string> {
    await this.refreshTokenIfNeeded(signal)

    const url = `${QWEN_AI_BASE}/api/v2/chats/new`
    const payload = {
      title,
      models: [modelId],
      chat_mode: 'normal',
      chat_type: chatType,
      timestamp: Date.now(),
      project_id: '',
    }

    try {
      const response = await this.postWithRefreshRetry(url, payload, () => ({
        headers: this.getHeaders(),
        signal,
        validateStatus: () => true,
      }))

      if (response.status >= 400) {
        throw await this.createInvalidStreamError(response, `chat creation returned HTTP ${response.status}`)
      }

      if (QWEN_AI_DEBUG_REQUEST_LOGS) {
        console.log('[QwenAI] Create chat response:', JSON.stringify(response.data, null, 2))
      }

      if (response.data?.data?.id) {
        if (QWEN_AI_DEBUG_REQUEST_LOGS) {
          console.log('[QwenAI] Created chat:', response.data.data.id)
        }
        return response.data.data.id
      }

      throw new Error('Failed to create chat: no chat ID returned')
    } catch (error) {
      console.error('[QwenAI] Failed to create chat:', describeErrorForLog(error))
      throw error
    }
  }

  async deleteChat(chatId: string): Promise<boolean> {
    const existingRequest = this.deleteChatRequests.get(chatId)
    if (existingRequest) {
      return existingRequest
    }

    const request = this.performDeleteChat(chatId)
    this.deleteChatRequests.set(chatId, request)
    const clearRequest = () => {
      if (this.deleteChatRequests.get(chatId) === request) {
        this.deleteChatRequests.delete(chatId)
      }
    }
    void request.then(clearRequest, clearRequest)
    return request
  }

  private async performDeleteChat(chatId: string): Promise<boolean> {
    const url = `${QWEN_AI_BASE}/api/v2/chats/${chatId}`

    try {
      const response = await this.axiosInstance.delete(url, {
        headers: this.getHeaders(),
      })

      if (response.data?.success) {
        console.log('[QwenAI] Deleted chat:', chatId)
        return true
      }

      console.warn('[QwenAI] Failed to delete chat:', response.data)
      return false
    } catch (error) {
      console.error('[QwenAI] Failed to delete chat:', describeErrorForLog(error))
      return false
    }
  }

  /**
   * Delete all chats for the current account
   * @returns Promise<boolean> - true if deletion was successful
   */
  async deleteAllChats(): Promise<boolean> {
    const url = `${QWEN_AI_BASE}/api/v2/chats/`

    try {
      console.log('[QwenAI] Deleting all chats for account')
      
      const response = await this.axiosInstance.delete(url, {
        headers: this.getHeaders(),
      })

      if (response.data?.success) {
        console.log('[QwenAI] All chats deleted successfully')
        return true
      }

      console.warn('[QwenAI] Failed to delete all chats:', response.data)
      return false
    } catch (error) {
      console.error('[QwenAI] Failed to delete all chats:', describeErrorForLog(error))
      return false
    }
  }

  async chatCompletion(request: ChatCompletionRequest): Promise<{
    response: AxiosResponse
    chatId: string
    parentId: string | null
  }> {
    const scope = createQwenAiRequestDeadlineScope(request.signal, request.deadlineAt)
    let chatId: string | undefined
    let response: AxiosResponse | undefined
    const cleanupChat = (id: string) => {
      void this.deleteChat(id).catch(error => {
        console.error('[QwenAI] Failed to delete chat:', describeErrorForLog(error))
      })
    }
    const disposeResponse = (value: AxiosResponse) => {
      destroyReadableStream(value?.data)
    }

    try {
      await scope.wait(this.refreshTokenIfNeeded(scope.signal))

      const token = this.getToken()
      if (!token) {
        const error = new Error('Qwen AI token not configured, please add token in account settings') as QwenAiUpstreamError
        error.status = 401
        error.retryable = false
        throw error
      }

      const modelId = this.mapModel(request.model)
      const imageGeneration = resolveQwenAiImageGenerationOptions(request.image_generation)
      const chatType = imageGeneration?.chatType ?? 't2t'

      // Use originalModel so aliases survive load-balancer mapping.
      const modelForThinking = request.originalModel || request.model

      scope.throwIfStopped()
      chatId = await scope.wait(
        this.createChat(modelId, 'OpenAI_API_Chat', scope.signal, chatType),
        lateChatId => cleanupChat(lateChatId),
      )
      if (QWEN_AI_DEBUG_REQUEST_LOGS) {
        console.log('[QwenAI] Created new chat:', chatId)
      }

      const messages = request.messages
      const uploader = new QwenAiFileUploader(
        this.axiosInstance,
        () => this.getHeaders(chatId),
        this.postWithRefreshRetry.bind(this),
        { providerId: this.provider.id, accountId: this.account.id },
      )
      const requestMaxBytes = qwenAiRequestMaxBytesFromEnv()
      const prepareUserMessage = (
        transport: QwenAiMessageTransport | undefined,
        managedDocumentMode?: QwenAiManagedDocumentMode,
      ) => (
        prepareQwenAiMultimodalMessage(messages, uploader, {
          transport,
          managedToolCalling: request.managedToolCalling,
          workflowContinuation: request.managedToolWorkflowContinuation,
          managedDocumentMode,
          requestMaxBytes,
          signal: scope.signal,
          deadlineAt: request.deadlineAt,
        })
      )
      let preparedUserMessage = await scope.wait(
        prepareUserMessage(request.messageTransport),
      )

      const fid = uuid()
      const childId = uuid()
      const ts = Math.floor(Date.now() / 1000)

      // The live model capability is authoritative when the upstream model does
      // not support skipping its reasoning phase.
      const modelCapability = findModelCapability(this.provider, modelForThinking, modelId)
      const featureMode = resolveQwenAiFeatureMode(
        modelForThinking,
        request.enable_thinking,
        modelCapability,
      )
      const shouldEnableThinking = featureMode.thinkingEnabled

      const featureConfig = createQwenAiFeatureConfig({
        thinkingEnabled: shouldEnableThinking,
        autoThinking: featureMode.autoThinking,
        thinkingBudget: request.thinking_budget,
      })

      const createPayload = () => ({
        stream: true,
        version: '2.1',
        incremental_output: true,
        chat_id: chatId,
        chat_mode: 'normal',
        model: modelId,
        parent_id: null,
        messages: [
          {
            fid,
            parentId: null,
            childrenIds: [childId],
            role: 'user',
            content: preparedUserMessage.content,
            user_action: 'chat',
            files: preparedUserMessage.files,
            timestamp: ts,
            models: [modelId],
            chat_type: chatType,
            feature_config: featureConfig,
            extra: {
              meta: {
                subChatType: chatType,
                ...(imageGeneration
                  ? { size: imageGeneration.size, model: imageGeneration.model }
                  : {}),
              },
            },
            sub_chat_type: chatType,
            parent_id: null,
          },
        ],
        timestamp: ts + 1,
        ...(imageGeneration ? { size: imageGeneration.size } : {}),
      })
      let payload = createPayload()
      let serializedPayload = JSON.stringify(payload)
      let payloadBytes = Buffer.byteLength(serializedPayload, 'utf8')

      // Treat the configured byte value as an offload target, not a client
      // request ceiling. Qwen's document transport can preserve the complete
      // context while reducing the completion JSON before its first POST.
      if (
        requestMaxBytes > 0
        && payloadBytes > requestMaxBytes
        && preparedUserMessage.transport !== 'document'
      ) {
        preparedUserMessage = await scope.wait(prepareUserMessage('document'))
        payload = createPayload()
        serializedPayload = JSON.stringify(payload)
        payloadBytes = Buffer.byteLength(serializedPayload, 'utf8')
      }

      if (
        requestMaxBytes > 0
        && payloadBytes > requestMaxBytes
        && request.managedToolCalling
        && preparedUserMessage.managedDocumentMode !== 'complete'
      ) {
        preparedUserMessage = await scope.wait(prepareUserMessage('document', 'complete'))
        payload = createPayload()
        serializedPayload = JSON.stringify(payload)
        payloadBytes = Buffer.byteLength(serializedPayload, 'utf8')
      }

      if (requestMaxBytes > 0 && payloadBytes > requestMaxBytes) {
        console.warn('[QwenAI] request remains above document-offload target', JSON.stringify({
          requestId: request.requestId,
          accountId: this.account.id,
          payloadUtf8Bytes: payloadBytes,
          requestTargetBytes: requestMaxBytes,
          messageTransport: preparedUserMessage.transport,
          managedDocumentMode: preparedUserMessage.managedDocumentMode,
          fileCount: preparedUserMessage.files.length,
        }))
      }

      console.info('[QwenAI] upstream request shape', JSON.stringify({
        requestId: request.requestId,
        accountId: this.account.id,
        model: modelId,
        sourceMessageCount: messages.length,
        transcriptChars: preparedUserMessage.content.length,
        transcriptUtf8Bytes: preparedUserMessage.transcriptUtf8Bytes,
        inlineUtf8Bytes: preparedUserMessage.inlineUtf8Bytes,
        payloadUtf8Bytes: payloadBytes,
        requestTargetBytes: requestMaxBytes,
        conservativeTextTokenEstimate: estimateQwenAiTranscriptTokens(preparedUserMessage.content),
        fileCount: preparedUserMessage.files.length,
        requestedMessageTransport: request.messageTransport ?? 'inline',
        messageTransport: preparedUserMessage.transport,
        managedDocumentMode: preparedUserMessage.managedDocumentMode,
        managedToolCalling: request.managedToolCalling === true,
        thinkingEnabled: shouldEnableThinking,
        modelMaxContextTokens: modelCapability?.maxContextLength,
        modelMaxSummaryTokens: modelCapability?.maxSummaryGenerationLength,
      }))

      const url = `${QWEN_AI_BASE}/api/v2/chat/completions?chat_id=${chatId}`

      if (QWEN_AI_DEBUG_REQUEST_LOGS || QWEN_AI_DEBUG_PAYLOAD_LOGS) {
        console.log('[QwenAI] Sending request to /api/v2/chat/completions...')
        console.log('[QwenAI] Request URL:', url)
        if (QWEN_AI_DEBUG_PAYLOAD_LOGS) {
          console.log('[QwenAI] Request payload:', JSON.stringify(this.sanitizePayloadForLog(payload), null, 2))
        } else {
          console.log('[QwenAI] Request payload summary:', JSON.stringify(this.summarizePayloadForLog(payload), null, 2))
        }
        console.log('[QwenAI] Request headers:', JSON.stringify(this.sanitizeHeadersForLog(this.getHeaders(chatId)), null, 2))
      }

      const requestTimeoutMs = scope.remainingTimeoutMs(Math.min(
        QWEN_AI_REQUEST_TIMEOUT_MS,
        request.timeoutMs ?? QWEN_AI_REQUEST_TIMEOUT_MS,
      ))
      response = await scope.wait(
        this.postWithRefreshRetry(url, serializedPayload, () => ({
          headers: {
            ...this.getHeaders(chatId),
            'Content-Length': String(payloadBytes),
            'x-accel-buffering': 'no',
          },
          responseType: 'stream',
          timeout: scope.remainingTimeoutMs(requestTimeoutMs),
          signal: scope.signal,
          validateStatus: () => true,
        })),
        disposeResponse,
      )

      if (QWEN_AI_DEBUG_REQUEST_LOGS) {
        console.log('[QwenAI] Response status:', response.status)
        console.log('[QwenAI] Response headers:', JSON.stringify(this.sanitizeHeadersForLog(response.headers), null, 2))
      }

      await scope.wait(this.assertChatCompletionStreamResponse(response, {
        signal: scope.signal,
        previewTimeoutMs: scope.remainingTimeoutMs(requestTimeoutMs),
      }))

      return {
        response,
        chatId,
        // The placeholder is only a fallback until the first
        // response.created event supplies the real assistant response id.
        parentId: childId,
      }
    } catch (error) {
      if (response) destroyReadableStream(response.data)
      if (chatId) cleanupChat(chatId)
      scope.throwIfStopped()
      throw error
    } finally {
      scope.dispose()
    }
  }

  /**
   * Resume an in-progress Qwen response after the transport drops. This is
   * the same response-id based endpoint used by Qwen's web client; it does
   * not submit the prompt a second time or duplicate tool execution.
   */
  async resumeChatCompletion(
    chatId: string,
    responseId: string,
    signal?: AbortSignal,
  ): Promise<AxiosResponse> {
    if (!chatId || !responseId) {
      throw new Error('Qwen AI resume requires both chat ID and response ID')
    }

    await this.refreshTokenIfNeeded(signal)

    const url = `${QWEN_AI_BASE}/api/v2/chat/completions?chat_id=${encodeURIComponent(chatId)}&response_id=${encodeURIComponent(responseId)}`
    const response = await this.getWithRefreshRetry(url, () => ({
      headers: {
        ...this.getHeaders(chatId),
        Accept: 'text/event-stream',
        'x-accel-buffering': 'no',
      },
      responseType: 'stream',
      timeout: QWEN_AI_REQUEST_TIMEOUT_MS,
      signal,
      validateStatus: () => true,
    }))

    if (QWEN_AI_DEBUG_REQUEST_LOGS) {
      console.log('[QwenAI] Resume response status:', response.status)
      console.log('[QwenAI] Resume response headers:', JSON.stringify(this.sanitizeHeadersForLog(response.headers)))
    }

    await this.assertChatCompletionStreamResponse(response, {
      signal,
    })
    return response
  }

  /**
   * Submit a provider-native follow-up user turn in the existing chat.
   *
   * This is intentionally different from resumeChatCompletion(): a response
   * id GET can only replay an interrupted generation. A semantic tool stall
   * needs a new generation whose parent is the completed assistant response,
   * while the original user/files payload remains untouched on Qwen's side.
   */
  async continueChatCompletion(
    request: QwenAiWorkflowContinuationRequest,
  ): Promise<AxiosResponse> {
    const chatId = request.chatId.trim()
    const parentId = request.parentId.trim()
    const continuationMessages = Array.isArray(request.messages)
      ? request.messages
      : []
    const fallbackContent = typeof request.content === 'string'
      ? request.content.trim()
      : ''
    if (!chatId || !parentId || (continuationMessages.length === 0 && !fallbackContent)) {
      throw new Error('Qwen AI workflow continuation requires chat ID, parent response ID, and content or messages')
    }

    await this.refreshTokenIfNeeded(request.signal)
    if (!this.getToken() && !this.getCookies()) {
      const error = new Error('Qwen AI token/cookies not configured, please add credentials in account settings') as QwenAiUpstreamError
      error.status = 401
      error.retryable = false
      throw error
    }

    const modelId = this.mapModel(request.model)
    const modelForThinking = request.originalModel || request.model
    const modelCapability = findModelCapability(this.provider, modelForThinking, modelId)
    const featureMode = resolveQwenAiFeatureMode(
      modelForThinking,
      request.enable_thinking,
      modelCapability,
    )
    const shouldEnableThinking = featureMode.thinkingEnabled
    const featureConfig = createQwenAiFeatureConfig({
      thinkingEnabled: shouldEnableThinking,
      autoThinking: featureMode.autoThinking,
      thinkingBudget: request.thinking_budget,
    })

    // A Responses tool-result follow-up can contain generated files or
    // images. Reuse the normal multimodal transport instead of flattening
    // the delta to text and silently dropping its attachments. The legacy
    // content field remains available for internal recovery continuations.
    let content = fallbackContent
    let files: any[] = []
    if (continuationMessages.length > 0) {
      const uploader = new QwenAiFileUploader(
        this.axiosInstance,
        () => this.getHeaders(chatId),
        this.postWithRefreshRetry.bind(this),
        { providerId: this.provider.id, accountId: this.account.id },
      )
      const preparedMessage = await prepareQwenAiMultimodalMessage(
        continuationMessages,
        uploader,
        {
          transport: request.messageTransport,
          managedToolCalling: request.managedToolCalling,
          workflowContinuation: request.managedToolWorkflowContinuation,
          requestMaxBytes: qwenAiRequestMaxBytesFromEnv(),
          signal: request.signal,
          deadlineAt: request.deadlineAt,
        },
      )
      content = preparedMessage.content
      files = preparedMessage.files
    }

    const fid = uuid()
    const childId = uuid()
    const ts = Math.floor(Date.now() / 1000)
    const payload = {
      stream: true,
      version: '2.1',
      incremental_output: true,
      chat_id: chatId,
      chat_mode: 'normal',
      model: modelId,
      parent_id: parentId,
      messages: [
        {
          fid,
          parentId,
          childrenIds: [childId],
          role: 'user',
          content,
          user_action: 'chat',
          files,
          timestamp: ts,
          models: [modelId],
          chat_type: 't2t',
          feature_config: featureConfig,
          extra: { meta: { subChatType: 't2t' } },
          sub_chat_type: 't2t',
          parent_id: parentId,
        },
      ],
      timestamp: ts + 1,
    }
    const url = `${QWEN_AI_BASE}/api/v2/chat/completions?chat_id=${encodeURIComponent(chatId)}`

    if (QWEN_AI_DEBUG_REQUEST_LOGS || QWEN_AI_DEBUG_PAYLOAD_LOGS) {
      console.log('[QwenAI] Sending workflow continuation to /api/v2/chat/completions...')
      console.log('[QwenAI] Continuation request URL:', url)
      if (QWEN_AI_DEBUG_PAYLOAD_LOGS) {
        console.log('[QwenAI] Continuation request payload:', JSON.stringify(this.sanitizePayloadForLog(payload), null, 2))
      } else {
        console.log('[QwenAI] Continuation request payload summary:', JSON.stringify(this.summarizePayloadForLog(payload), null, 2))
      }
    }

    const maxChatInProgressRetries = request.chatInProgressRetryAttempts === undefined
      ? qwenAiChatInProgressRetryAttemptsFromEnv()
      : Math.min(
          QWEN_AI_CHAT_IN_PROGRESS_MAX_CONFIGURED_ATTEMPTS,
          Math.max(0, Math.floor(request.chatInProgressRetryAttempts)),
        )
    const configuredRetryDelayMs = qwenAiChatInProgressRetryDelayMsFromEnv()
    // The default delay is one second. An explicit zero remains available for
    // deployments that want immediate polling; the admission budget is kept
    // separate from the timeout for a long-running accepted generation.
    const baseRetryDelayMs = configuredRetryDelayMs
    const retryBudgetMs = qwenAiChatInProgressRetryBudgetMsFromEnv()
    const continuationDeadline = Date.now() + retryBudgetMs
    let chatInProgressRetries = 0
    let lastChatInProgressError: QwenAiUpstreamError | undefined

    const createContinuationOptions = () => ({
      headers: {
        ...this.getHeaders(chatId),
        'x-accel-buffering': 'no',
      },
      responseType: 'stream',
      // Keep the normal request timeout for an accepted stream. The separate
      // admission deadline below only controls repeated CHAT_IN_PROGRESS
      // responses, so a long first token is not cut off by the busy budget.
      timeout: QWEN_AI_REQUEST_TIMEOUT_MS,
      signal: request.signal,
      validateStatus: () => true,
    })

    const createBusyContinuationExhaustedError = (
      validationError?: Error,
      retryAfterMs = baseRetryDelayMs,
    ): QwenAiUpstreamError => {
      const exhausted = (validationError || new Error('Qwen AI chat is still in progress')) as QwenAiUpstreamError
      // CHAT_IN_PROGRESS means the provider is temporarily serializing the
      // same chat. Surface it as a transient 429 so Claude/LiteLLM can retry
      // instead of waiting five minutes and receiving an opaque 504.
      exhausted.status = 429
      exhausted.code = 'CHAT_IN_PROGRESS'
      exhausted.retryable = true
      exhausted.accountFault = false
      const hasRetryAfter = Object.keys(exhausted.headers || {})
        .some(key => key.toLowerCase() === 'retry-after')
      if (!hasRetryAfter) {
        exhausted.headers = {
          ...(exhausted.headers || {}),
          'Retry-After': String(Math.max(1, Math.ceil(Math.max(1_000, retryAfterMs) / 1_000))),
        }
      }
      return exhausted
    }

    while (true) {
      if (Date.now() >= continuationDeadline) {
        throw createBusyContinuationExhaustedError(lastChatInProgressError)
      }

      const response = await this.postWithRefreshRetry(url, payload, createContinuationOptions)

      if (QWEN_AI_DEBUG_REQUEST_LOGS) {
        console.log('[QwenAI] Workflow continuation response status:', response.status)
        console.log('[QwenAI] Workflow continuation response headers:', JSON.stringify(this.sanitizeHeadersForLog(response.headers)))
      }

      const validation = (await this.assertChatCompletionStreamResponse(response, {
        allowChatInProgress: true,
        signal: request.signal,
        previewTimeoutMs: Math.max(
          1,
          Math.min(
            QWEN_AI_REQUEST_TIMEOUT_MS,
            Math.max(1, continuationDeadline - Date.now()),
          ),
        ),
      })) || { chatInProgress: false }
      if (!validation.chatInProgress) {
        return response
      }
      lastChatInProgressError = validation.error

      // The JSON admission response has been fully consumed by validation and
      // cannot be attached to the SSE parser. Dispose of it before waiting so
      // the retry does not leave a socket/listener behind.
      destroyReadableStream(response.data)

      if (request.signal?.aborted) {
        throw createQwenAiContinuationAbortError()
      }

      if (
        maxChatInProgressRetries !== undefined
        && chatInProgressRetries >= maxChatInProgressRetries
      ) {
        throw createBusyContinuationExhaustedError(validation.error)
      }

      chatInProgressRetries += 1
      const configuredDelayMs = Math.min(
        QWEN_AI_CHAT_IN_PROGRESS_MAX_DELAY_MS,
        baseRetryDelayMs * (2 ** (chatInProgressRetries - 1)),
      )
      const remainingBudgetMs = Math.max(0, continuationDeadline - Date.now())
      if (remainingBudgetMs <= 0) {
        throw createBusyContinuationExhaustedError(lastChatInProgressError, configuredDelayMs)
      }
      const delayMs = Math.min(configuredDelayMs, remainingBudgetMs)
      console.warn('[QwenAI] Workflow continuation was rejected because the chat is still in progress; waiting before retry', JSON.stringify({
        retry: chatInProgressRetries,
        maxRetries: maxChatInProgressRetries,
        retryBudgetMs,
        delayMs,
        ...(delayMs < configuredDelayMs ? { deadlineLimited: true } : {}),
      }))

      if (!(await waitForQwenAiRetry(delayMs, request.signal))) {
        throw createQwenAiContinuationAbortError()
      }
    }
  }

  async startDirectFileUpload(input: QwenAiDirectUploadInput): Promise<QwenAiDirectUploadStartResult> {
    await this.refreshTokenIfNeeded()

    const token = this.getToken()
    if (!token && !this.getCookies()) {
      throw new Error('Qwen AI token/cookies not configured, please add credentials in account settings')
    }

    const uploader = new QwenAiFileUploader(
      this.axiosInstance,
      () => this.getHeaders(),
      this.postWithRefreshRetry.bind(this),
      { providerId: this.provider.id, accountId: this.account.id },
    )
    return uploader.startDirectUpload(input)
  }

  async completeDirectFileUpload(sessionId: string): Promise<any> {
    await this.refreshTokenIfNeeded()

    const uploader = new QwenAiFileUploader(
      this.axiosInstance,
      () => this.getHeaders(),
      this.postWithRefreshRetry.bind(this),
      { providerId: this.provider.id, accountId: this.account.id },
    )
    return uploader.completeDirectUpload(sessionId)
  }

  static isQwenAiProvider(provider: Provider): boolean {
    return provider.id === 'qwen-ai' || provider.apiEndpoint.includes('chat.qwen.ai')
  }
}

export class QwenAiStreamHandler {
  private chatId: string = ''
  private model: string
  private created: number
  private onEnd?: (chatId: string) => void
  private responseId: string = ''
  private content: string = ''
  private generatedImages: QwenAiGeneratedImage[] = []
  private generatedImageKeys = new Set<string>()
  private generatedInlineImageEncodedBytes = 0
  private toolCallsSent: boolean = false
  private emittedToolCallIds = new Set<string>()
  private toolStreamParser?: ToolStreamParser
  private toolCallingPlan?: ToolCallingPlan
  private nativeToolCallStates = new Map<string, NativeToolCallState>()
  private nativeToolCallIndex = 0
  private warnedUndeclaredNativeToolNames = new Set<string>()
  private ignoredResponseIds = new Set<string>()
  private responseBranchLocked = false
  private processedResponseEvent = false
  private streamCompleted = false
  private continuationResetter?: () => void
  private readonly toolCallIdPrefix: string
  private answerToolResultGuard: ManagedToolResultGuard
  private reasoningToolResultGuard: ManagedToolResultGuard
  private summaryToolResultGuard: ManagedToolResultGuard
  private wrapperLeakDetected = false
  private wrapperLeakLogged = false
  private readonly promptTokens: number

  constructor(
    model: string,
    onEnd?: (chatId: string) => void,
    toolCallingPlan?: ToolCallingPlan,
    promptTokens = 1,
  ) {
    this.model = model
    this.created = Math.floor(Date.now() / 1000)
    this.onEnd = onEnd
    this.toolCallingPlan = toolCallingPlan
    this.promptTokens = Number.isSafeInteger(promptTokens) && promptTokens > 0
      ? promptTokens
      : 1
    this.toolCallIdPrefix = `call_${uuid().replace(/-/g, '')}`
    this.answerToolResultGuard = this.createAnswerToolResultGuard()
    this.reasoningToolResultGuard = new ManagedToolResultGuard(null)
    this.summaryToolResultGuard = new ManagedToolResultGuard(null)
    this.resetToolStreamParser()
  }

  private createEstimatedUsage(
    content: unknown,
    reasoning?: unknown,
    toolCalls?: unknown,
  ): { prompt_tokens: number; completion_tokens: number; total_tokens: number } {
    const serializedParts = [content, reasoning, toolCalls]
      .filter(value => value !== undefined && value !== null && value !== '')
      .map(value => {
        if (typeof value === 'string') return value
        try {
          return JSON.stringify(value)
        } catch {
          return String(value)
        }
      })
    const completionTokens = Math.max(
      1,
      serializedParts.reduce(
        (total, value) => total + estimateQwenAiTranscriptTokens(value),
        0,
      ),
    )
    return {
      prompt_tokens: this.promptTokens,
      completion_tokens: completionTokens,
      total_tokens: this.promptTokens + completionTokens,
    }
  }

  private withEstimatedUsage(response: any): any {
    const message = response?.choices?.[0]?.message
    return {
      ...response,
      usage: this.createEstimatedUsage(
        message?.content,
        message?.reasoning_content,
        message?.tool_calls,
      ),
    }
  }

  private resetToolStreamParser(): void {
    this.toolStreamParser = this.toolCallingPlan?.shouldParseResponse
      ? new ToolStreamParser(
          this.toolCallingPlan,
          this.toolCallIdPrefix,
          { inputAlreadyGuarded: true },
        )
      : undefined
  }

  private createAnswerToolResultGuard(): ManagedToolResultGuard {
    return new ManagedToolResultGuard(
      this.toolCallingPlan?.shouldParseResponse
        ? this.toolCallingPlan.protocol
        : null,
    )
  }

  private resetToolResultGuards(): void {
    this.answerToolResultGuard = this.createAnswerToolResultGuard()
    this.reasoningToolResultGuard = new ManagedToolResultGuard(null)
    this.summaryToolResultGuard = new ManagedToolResultGuard(null)
    this.wrapperLeakDetected = false
    this.wrapperLeakLogged = false
  }

  private guardAssistantOutput(
    content: string,
    channel: 'answer' | 'reasoning' | 'summary',
  ): ManagedToolResultGuardOutput {
    const guard = this.toolResultGuardForChannel(channel)
    const output = guard.push(content)
    if (guard.hasDetectedWrapperLeak()) this.markWrapperLeakDetected(channel)
    return output
  }

  private flushAssistantOutputGuard(
    channel: 'answer' | 'reasoning' | 'summary',
  ): ManagedToolResultGuardOutput {
    const guard = this.toolResultGuardForChannel(channel)
    const output = guard.flush()
    if (guard.hasDetectedWrapperLeak()) this.markWrapperLeakDetected(channel)
    return output
  }

  private guardCumulativeSummarySnapshot(
    snapshot: string,
    previousSnapshot: string,
  ): { sourceText: string, content: string, replacement?: string } {
    if (snapshot.startsWith(previousSnapshot)) {
      return {
        sourceText: snapshot,
        content: this.guardAssistantOutput(
          snapshot.slice(previousSnapshot.length),
          'summary',
        ).content,
      }
    }

    // A cumulative snapshot may be rewritten rather than appended. Inspect
    // the complete replacement before changing the incremental baseline so a
    // rewritten prefix cannot hide the beginning of a reserved wrapper.
    const inspected = stripManagedToolResultWrappers(snapshot, null)
    if (inspected.wrapperLeakDetected) {
      this.markWrapperLeakDetected('summary')
      return { sourceText: snapshot, content: '' }
    }

    this.summaryToolResultGuard = new ManagedToolResultGuard(null)
    return {
      sourceText: snapshot,
      content: '',
      replacement: inspected.content,
    }
  }

  private toolResultGuardForChannel(
    channel: 'answer' | 'reasoning' | 'summary',
  ): ManagedToolResultGuard {
    if (channel === 'reasoning') return this.reasoningToolResultGuard
    if (channel === 'summary') return this.summaryToolResultGuard
    return this.answerToolResultGuard
  }

  private currentBranchHasWrapperLeak(): boolean {
    return this.wrapperLeakDetected
      || this.answerToolResultGuard.hasDetectedWrapperLeak()
      || this.reasoningToolResultGuard.hasDetectedWrapperLeak()
      || this.summaryToolResultGuard.hasDetectedWrapperLeak()
  }

  private markWrapperLeakDetected(channel: 'answer' | 'reasoning' | 'summary'): void {
    this.wrapperLeakDetected = true
    if (this.toolCallingPlan) {
      this.toolCallingPlan = {
        ...this.toolCallingPlan,
        diagnostics: {
          ...this.toolCallingPlan.diagnostics,
          wrapperLeakDetected: true,
        },
      }
    }
    if (this.wrapperLeakLogged) return
    this.wrapperLeakLogged = true
    console.warn('[ToolCalling] Blocked leaked managed tool-result wrapper', JSON.stringify({
      wrapperLeakDetected: true,
      providerId: this.toolCallingPlan?.diagnostics.providerId || 'qwen-ai',
      model: this.toolCallingPlan?.diagnostics.actualModel
        || this.toolCallingPlan?.diagnostics.model
        || this.model,
      protocol: this.toolCallingPlan?.protocol,
      channel,
    }))
  }

  private resetManagedResponseArtifacts(): void {
    this.content = ''
    this.generatedImages = []
    this.generatedImageKeys = new Set<string>()
    this.generatedInlineImageEncodedBytes = 0
    this.toolCallsSent = false
    this.emittedToolCallIds = new Set<string>()
    this.nativeToolCallStates = new Map<string, NativeToolCallState>()
    this.nativeToolCallIndex = 0
    this.warnedUndeclaredNativeToolNames = new Set<string>()
    this.resetToolResultGuards()
    this.resetToolStreamParser()
  }

  private ingestGeneratedImages(extra: unknown): {
    images: QwenAiGeneratedImage[]
    startingIndex: number
  } {
    const startingIndex = this.generatedImages.length
    const availableSlots = Math.max(0, QWEN_AI_IMAGE_EXTRA_MAX_RESULTS - startingIndex)
    const nextImageKeys = new Set(this.generatedImageKeys)
    let acceptedCount = 0
    const images = extractQwenAiGeneratedImages(extra)
      .filter(image => {
        if (acceptedCount >= availableSlots) return false
        const key = image.image_url.url
        if (nextImageKeys.has(key)) return false
        const encodedBytes = qwenAiInlineImageEncodedBytes(key)
        if (
          this.generatedInlineImageEncodedBytes + encodedBytes
          > QWEN_AI_IMAGE_MAX_TOTAL_ENCODED_BYTES
        ) {
          return false
        }
        nextImageKeys.add(key)
        this.generatedInlineImageEncodedBytes += encodedBytes
        acceptedCount += 1
        return true
      })
    if (images.length > 0) {
      this.generatedImageKeys = nextImageKeys
      this.generatedImages = [...this.generatedImages, ...images]
    }
    return { images, startingIndex }
  }

  /**
   * Prepare this handler for a new provider response branch created by a
   * same-chat workflow continuation. The visible downstream stream remains
   * open; only provider/parser state from the abandoned branch is cleared.
   */
  prepareForWorkflowContinuation(): void {
    this.responseId = ''
    this.resetManagedResponseArtifacts()
    this.ignoredResponseIds = new Set<string>()
    this.responseBranchLocked = false
    this.processedResponseEvent = false
    this.streamCompleted = false
    this.resetToolStreamParser()
    this.continuationResetter?.()
  }

  setChatId(chatId: string) {
    this.chatId = chatId
  }

  getEmittedToolCallIds(): string[] {
    return Array.from(this.emittedToolCallIds)
  }

  private recordEmittedToolCallIds(toolCalls: readonly { id?: unknown }[]): void {
    for (const toolCall of toolCalls) {
      const id = typeof toolCall?.id === 'string' ? toolCall.id.trim() : ''
      if (id) this.emittedToolCallIds.add(id)
    }
  }

  private recordEmittedToolCallIdsFromChunk(chunk: unknown): void {
    if (!chunk || typeof chunk !== 'object') return
    const choices = (chunk as { choices?: unknown }).choices
    if (!Array.isArray(choices)) return
    for (const choice of choices) {
      if (!choice || typeof choice !== 'object') continue
      const candidate = choice as {
        delta?: { tool_calls?: unknown }
        message?: { tool_calls?: unknown }
      }
      const toolCalls = candidate.delta?.tool_calls ?? candidate.message?.tool_calls
      if (Array.isArray(toolCalls)) this.recordEmittedToolCallIds(toolCalls)
    }
  }

  private getResponseIndex(value: unknown): string | undefined {
    if (value === undefined || value === null) return undefined
    return String(value)
  }

  private getEventResponseId(data: Record<string, any>): string {
    const responseId = data.response_id ?? data['response.created']?.response_id
    return typeof responseId === 'string' ? responseId : ''
  }

  private getEventResponseIndex(data: Record<string, any>): string | undefined {
    return this.getResponseIndex(data.response_index ?? data['response.created']?.response_index)
  }

  private hasStartedResponseOutput(): boolean {
    return Boolean(this.processedResponseEvent || this.content || this.toolCallsSent || this.nativeToolCallStates.size > 0)
  }

  private setPrimaryResponseBranch(responseId: string, responseIndex?: string): void {
    this.responseId = responseId
    this.ignoredResponseIds.delete(responseId)

    if (responseIndex === '0') {
      this.responseBranchLocked = true
    }

    console.log('[QwenAI] Got response_id:', this.responseId, 'response_index:', responseIndex ?? 'unknown')
  }

  private ignoreResponseBranch(responseId: string, responseIndex?: string): void {
    if (!responseId) return

    const firstIgnoredEvent = !this.ignoredResponseIds.has(responseId)
    this.ignoredResponseIds.add(responseId)

    if (firstIgnoredEvent) {
      console.warn('[QwenAI] Ignoring secondary response branch:', {
        responseId,
        responseIndex: responseIndex ?? 'unknown',
        primaryResponseId: this.responseId || 'unselected',
      })
    }
  }

  private recordResponseCreated(created: Record<string, any>): boolean {
    const responseId = typeof created.response_id === 'string' ? created.response_id : ''
    if (!responseId) return false

    const responseIndex = this.getResponseIndex(created.response_index)

    if (!this.responseId) {
      if (responseIndex && responseIndex !== '0') {
        this.ignoreResponseBranch(responseId, responseIndex)
        return false
      }

      this.setPrimaryResponseBranch(responseId, responseIndex)
      return true
    }

    if (responseId === this.responseId) {
      if (responseIndex === '0') {
        this.responseBranchLocked = true
      }
      return true
    }

    if (responseIndex === '0' && !this.responseBranchLocked && !this.hasStartedResponseOutput()) {
      this.ignoreResponseBranch(this.responseId, undefined)
      this.setPrimaryResponseBranch(responseId, responseIndex)
      return true
    }

    this.ignoreResponseBranch(responseId, responseIndex)
    return false
  }

  private shouldProcessResponseEvent(data: Record<string, any>): boolean {
    const eventResponseId = this.getEventResponseId(data)
    const eventResponseIndex = this.getEventResponseIndex(data)

    if (!eventResponseId) {
      if (eventResponseIndex && eventResponseIndex !== '0') {
        console.warn('[QwenAI] Ignoring secondary response branch without response_id:', {
          responseIndex: eventResponseIndex,
          primaryResponseId: this.responseId || 'unselected',
        })
        return false
      }

      this.processedResponseEvent = true
      return true
    }

    if (this.ignoredResponseIds.has(eventResponseId)) {
      return false
    }

    if (!this.responseId) {
      if (eventResponseIndex && eventResponseIndex !== '0') {
        this.ignoreResponseBranch(eventResponseId, eventResponseIndex)
        return false
      }

      this.setPrimaryResponseBranch(eventResponseId, eventResponseIndex)
      this.processedResponseEvent = true
      return true
    }

    if (eventResponseId !== this.responseId) {
      this.ignoreResponseBranch(eventResponseId, eventResponseIndex)
      return false
    }

    this.processedResponseEvent = true
    return true
  }

  private sendToolCalls(
    transStream: PassThrough,
    usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number },
  ): boolean {
    if (this.toolCallsSent) return true
    
    const toolCalls = parseToolUse(this.content)
    if (toolCalls && toolCalls.length > 0) {
      this.toolCallsSent = true
      
      // Send tool_calls delta
      for (let i = 0; i < toolCalls.length; i++) {
        const tc = toolCalls[i]
        const tool = this.toolCallingPlan?.tools?.find(item => item.name === tc.function.name)
        const emittedToolCallId = `${this.toolCallIdPrefix}_${i}`
        this.recordEmittedToolCallIds([{ id: emittedToolCallId }])
        transStream.write(
          `data: ${JSON.stringify({
            id: this.responseId || this.chatId,
            model: this.model,
            object: 'chat.completion.chunk',
            choices: [{
              index: 0,
              delta: {
                tool_calls: [{
                  index: i,
                  id: emittedToolCallId,
                  type: 'function',
                  function: {
                    name: tc.function.name,
                    arguments: normalizeArguments(tc.function.arguments, tool),
                  },
                }],
              },
              finish_reason: null,
            }],
            created: this.created,
          })}\n\n`
        )
      }
      
      // Send finish with tool_calls
      transStream.write(
        `data: ${JSON.stringify({
          id: this.responseId || this.chatId,
          model: this.model,
          object: 'chat.completion.chunk',
          choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }],
          usage,
          created: this.created,
        })}\n\n`
      )
      transStream.end('data: [DONE]\n\n')
      if (this.onEnd && this.chatId) {
        this.onEnd(this.chatId)
      }
      return true
    }

    return false
  }

  private ingestNativeToolCallFragments(delta: Record<string, any>): {
    sawFragment: boolean
  } {
    if (!this.toolCallingPlan?.shouldParseResponse) {
      return { sawFragment: false }
    }

    const fragments = normalizeNativeFunctionCallDelta(delta)
    let sawFragment = false

    for (const fragment of fragments) {
      sawFragment = true
      const existing = this.nativeToolCallStates.get(fragment.key)
      const name = mergeNativeToolName(
        existing?.name ?? '',
        fragment.name,
        this.toolCallingPlan.allowedToolNames,
      )
      const allowed = Boolean(name && this.toolCallingPlan.allowedToolNames.has(name))
      const argumentsText = mergeNativeToolArguments(existing?.arguments ?? '', fragment.arguments)
      const nextState: NativeToolCallState = {
        key: fragment.key,
        id: existing?.id || `${this.toolCallIdPrefix}_${this.nativeToolCallIndex}`,
        index: fragment.index ?? existing?.index ?? this.nativeToolCallIndex,
        name,
        arguments: argumentsText,
        allowed,
      }

      if (!existing) {
        this.nativeToolCallIndex += 1
      }

      this.nativeToolCallStates.set(fragment.key, nextState)
      if (name && !allowed && !this.warnedUndeclaredNativeToolNames.has(name)) {
        this.warnedUndeclaredNativeToolNames.add(name)
        console.warn(
          isQwenAiInternalNativeTool(name)
            ? '[QwenAI] Ignoring provider-internal native tool call:'
            : '[QwenAI] Ignoring undeclared upstream native tool call:',
          name,
        )
      }
    }

    return { sawFragment }
  }

  private getCompleteUndeclaredNativeToolNames(): string[] {
    const names = new Set<string>()
    for (const state of this.nativeToolCallStates.values()) {
      if (
        state.name
        && !state.allowed
        && !isQwenAiInternalNativeTool(state.name)
        && isCompleteJsonText(state.arguments)
      ) {
        names.add(state.name)
      }
    }
    return [...names]
  }

  private getIncompleteDeclaredNativeToolNames(): string[] {
    const names = new Set<string>()
    for (const state of this.nativeToolCallStates.values()) {
      if (state.allowed && state.name && !isCompleteJsonText(state.arguments)) {
        names.add(state.name)
      }
    }
    return [...names]
  }

  private getInvalidNativeToolArgumentIssues(): QwenAiNativeToolArgumentIssue[] {
    const issues: QwenAiNativeToolArgumentIssue[] = []

    for (const state of this.nativeToolCallStates.values()) {
      if (!state.allowed || !state.name || !isCompleteJsonText(state.arguments)) continue

      const tool = this.toolCallingPlan?.tools?.find(item => item.name === state.name)
      const validation = getToolArgumentValidationIssues(state.arguments, tool)
      const typeMismatches = validation.typeMismatches ?? []
      const valueMismatches = validation.valueMismatches ?? []
      if (
        validation.missingRequired.length === 0
        && validation.unexpected.length === 0
        && typeMismatches.length === 0
        && valueMismatches.length === 0
      ) continue

      issues.push({
        toolName: state.name,
        missingRequired: validation.missingRequired,
        unexpected: validation.unexpected,
        typeMismatches,
        valueMismatches,
      })
    }

    return issues
  }

  private getCompleteNativeToolCalls(force: boolean = false): ToolCall[] {
    const toolCalls: ToolCall[] = []

    for (const state of this.nativeToolCallStates.values()) {
      if (!state.allowed || !state.name) continue
      if (!force && !isCompleteJsonText(state.arguments)) continue

      // Native provider calls bypass ToolCallingEngine's managed-protocol
      // parser. Normalize their complete arguments against the declared
      // client schema before exposing them to the downstream tool validator.
      const tool = this.toolCallingPlan?.tools?.find(item => item.name === state.name)
      let normalizedArguments: string
      try {
        normalizedArguments = normalizeArguments(state.arguments, tool)
      } catch {
        // A provider can report a syntactically incomplete fragment while
        // its status is still `typing`. Keep waiting for the terminal frame;
        // the terminal validation path will report the malformed call.
        continue
      }

      toolCalls.push({
        index: state.index,
        id: state.id,
        type: 'function',
        function: {
          name: state.name,
          arguments: normalizedArguments,
        },
      })
    }

    return toolCalls.sort((a, b) => (a.index ?? 0) - (b.index ?? 0))
  }

  private emitNativeToolCalls(
    transStream: PassThrough,
    toolCalls: ToolCall[],
    includeAssistantRole = true,
    usage = this.createEstimatedUsage(this.content, undefined, toolCalls),
  ): boolean {
    if (this.toolCallsSent || toolCalls.length === 0) return false

    this.toolCallsSent = true
    this.recordEmittedToolCallIds(toolCalls)

    for (let i = 0; i < toolCalls.length; i += 1) {
      const toolCall = toolCalls[i]
      transStream.write(
        `data: ${JSON.stringify({
          id: this.responseId || this.chatId,
          model: this.model,
          object: 'chat.completion.chunk',
          choices: [{
            index: 0,
            delta: {
              role: i === 0 && includeAssistantRole ? 'assistant' : undefined,
              tool_calls: [toolCall],
            },
            finish_reason: null,
          }],
          created: this.created,
        })}\n\n`,
      )
    }

    transStream.write(
      `data: ${JSON.stringify({
        id: this.responseId || this.chatId,
        model: this.model,
        object: 'chat.completion.chunk',
        choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }],
        usage,
        created: this.created,
      })}\n\n`,
    )
    transStream.end('data: [DONE]\n\n')

    if (this.onEnd && this.chatId) {
      this.onEnd(this.chatId)
    }

    return true
  }

  async handleStream(stream: any, options: StreamHandlingOptions = {}): Promise<QwenAiOutputStream> {
    const transStream: QwenAiOutputStream = new PassThrough()

    if (QWEN_AI_DEBUG_STREAM_LOGS) {
      console.log('[QwenAI] Starting stream handler...')
    }

    let reasoningText = ''
    let hasSentReasoning = false
    let summaryText = ''
    let summarySourceText = ''
    let initialChunkSent = false
    let finalChunkSent = false
    let sawUpstreamCompletion = false
    let requestDeadlineTimer: NodeJS.Timeout | undefined
    let responseTimer: NodeJS.Timeout | undefined
    let idleTimer: NodeJS.Timeout | undefined
    let abortListenerAttached = false
    let idleRecoveryInFlight = false
    let semanticRecoveryInFlight = false
    // A provider can accept the request, emit private progress, and then send
    // an in-stream 5xx envelope. Keep that branch private while the resumable
    // bridge attempts the same response-id on the same account.
    let transientRecoveryInFlight = false
    let upstreamEventCount = 0
    let lastUpstreamEventAt = 0
    let lastUpstreamEventType = 'none'
    const bufferManagedBranch = options.bufferManagedBranch === true
      && this.toolCallingPlan?.shouldParseResponse === true
    // Managed candidates remain private until their terminal workflow state
    // validates. This includes reasoning: publishing it out of band would make
    // a later capacity failover splice two different Qwen branches together.
    const stageManagedAnswer = !bufferManagedBranch
      && this.toolCallingPlan?.shouldParseResponse === true
    const buffersManagedCandidate = bufferManagedBranch || stageManagedAnswer
    let visibleFrameCommitted = false
    let answerFrameCommitted = false
    let managedBranchFrames: string[] = []
    let managedBranchBytes = 0
    let downstreamFrameCount = 0
    let lastDownstreamFrameAt = 0
    let parser: ReturnType<typeof createParser>
    let sourceDestroyPending = false
    let sourceDestroyed = false
    const responseTimeoutMs = options.responseTimeoutMs ?? QWEN_AI_RESPONSE_TIMEOUT_MS
    const requestDeadlineAt = typeof options.requestDeadlineAt === 'number'
      && Number.isFinite(options.requestDeadlineAt)
      ? options.requestDeadlineAt
      : undefined
    const requestDeadlineExpired = () => requestDeadlineAt !== undefined
      && Date.now() >= requestDeadlineAt

    const writeDownstreamFrame = (frame: string): boolean => {
      downstreamFrameCount += 1
      lastDownstreamFrameAt = Date.now()
      return transStream.write(frame)
    }

    const discardManagedBranchFrames = () => {
      managedBranchFrames = []
      managedBranchBytes = 0
    }

    const flushManagedBranchFrames = (hasValidatedToolCall = false) => {
      if (!buffersManagedCandidate || managedBranchFrames.length === 0) return
      const frames = hasValidatedToolCall
        ? stripQwenAiToolAvailabilityNoiseFromSseFrames(managedBranchFrames)
        : managedBranchFrames
      for (const frame of frames) {
        writeDownstreamFrame(frame)
      }
      visibleFrameCommitted = true
      answerFrameCommitted = true
      discardManagedBranchFrames()
    }

    this.continuationResetter = () => {
      // The old dangling answer has already been classified as incomplete;
      // do not carry its text, native fragments, or managed-parser buffer into
      // the new response branch. Keep initialChunkSent so a second role frame
      // is not emitted after visible prefix bytes have reached the client.
      reasoningText = ''
      summaryText = ''
      summarySourceText = ''
      sawUpstreamCompletion = false
      idleRecoveryInFlight = false
      semanticRecoveryInFlight = false
      discardManagedBranchFrames()
      if (bufferManagedBranch) {
        initialChunkSent = false
        hasSentReasoning = false
      }
      parser?.reset()
    }

    const cleanupTimers = () => {
      if (requestDeadlineTimer) {
        clearTimeout(requestDeadlineTimer)
        requestDeadlineTimer = undefined
      }
      if (responseTimer) {
        clearTimeout(responseTimer)
        responseTimer = undefined
      }
      if (idleTimer) {
        clearTimeout(idleTimer)
        idleTimer = undefined
      }
    }

    const cleanup = () => {
      cleanupTimers()
      if (abortListenerAttached) {
        options.signal?.removeEventListener('abort', onAbort)
        abortListenerAttached = false
      }
    }

    // Terminal SSE bytes are written to the transformed stream before the
    // provider socket is retired. Closing the source in the same call stack
    // can race a downstream Responses parser and turn a valid terminal frame
    // into a bare EOF. The writable `finish` event means all terminal bytes
    // have been accepted by the PassThrough, even when its readable side has
    // no consumer yet; waiting for `end` alone would leak the provider socket.
    const destroySourceAfterOutput = (error?: Error) => {
      if (sourceDestroyed || sourceDestroyPending) return
      sourceDestroyPending = true
      const destroy = () => {
        if (sourceDestroyed) return
        sourceDestroyed = true
        sourceDestroyPending = false
        transStream.removeListener('finish', destroy)
        transStream.removeListener('close', destroy)
        destroyReadableStream(stream, error)
      }
      if (transStream.writableFinished || transStream.destroyed) {
        queueMicrotask(destroy)
        return
      }
      transStream.once('finish', destroy)
      transStream.once('close', destroy)
    }

    const recordStreamFailure = (error: Error): boolean => {
      if (finalChunkSent) return false
      const description = describeErrorForLog(error)
      if (isClientCancellationError(error)) {
        console.log('[QwenAI] Stream cancelled:', description)
      } else {
        console.error('[QwenAI] Stream failed:', description)
      }
      finalChunkSent = true
      cleanup()
      transStream.qwenAiFailure = error
      transStream.emit(QWEN_AI_STREAM_FAILURE_EVENT, error)
      options.onFailure?.(error)
      return true
    }

    const failStream = (error: Error) => {
      const upstreamError = enforceQwenAiFailoverBoundary(
        normalizeQwenAiStreamFailure(error),
        () => !visibleFrameCommitted,
      )
      upstreamError.upstreamState = upstreamError.status === 499
        ? 'client_disconnected'
        : upstreamEventCount === 0
          ? 'no_events'
          : sawUpstreamCompletion
            ? 'completed_without_valid_output'
            : 'active_without_terminal'
      console.warn('[QwenAI] Upstream state at stream failure', JSON.stringify({
        upstreamEventCount,
        lastUpstreamEventAt,
        lastUpstreamEventType,
        responseId: this.responseId || undefined,
        sawUpstreamCompletion,
        clientAborted: upstreamError.status === 499,
        downstreamFrameCount,
        lastDownstreamFrameAt,
        bufferedManagedFrameCount: managedBranchFrames.length,
        bufferedManagedBytes: managedBranchBytes,
      }))
      if (!recordStreamFailure(upstreamError)) return
      discardManagedBranchFrames()
      const errorCode = typeof upstreamError.code === 'string'
        ? upstreamError.code
        : 'qwen_ai_stream_error'
      const errorStatus = typeof upstreamError.status === 'number'
        && upstreamError.status >= 400
        && upstreamError.status <= 599
        ? upstreamError.status
        : undefined
      const errorRetryable = typeof upstreamError.retryable === 'boolean'
        ? upstreamError.retryable
        : undefined
      const errorAccountFault = typeof upstreamError.accountFault === 'boolean'
        ? upstreamError.accountFault
        : undefined
      const errorType = typeof upstreamError.type === 'string'
        ? upstreamError.type
        : 'upstream_stream_error'
      const errorParam = typeof upstreamError.param === 'string'
        ? upstreamError.param
        : undefined
      transStream.write(`event: error\ndata: ${JSON.stringify({
        error: {
          message: upstreamError.message,
          type: errorType,
          code: errorCode,
          ...(errorParam === undefined ? {} : { param: errorParam }),
          ...(errorStatus === undefined ? {} : { status: errorStatus }),
          ...(errorRetryable === undefined ? {} : { retryable: errorRetryable }),
          ...(errorAccountFault === undefined ? {} : { accountFault: errorAccountFault }),
          ...(upstreamError.upstreamState === undefined ? {} : { upstream_state: upstreamError.upstreamState }),
        },
      })}\n\n`)
      transStream.end('data: [DONE]\n\n')

      // Queue the failure frame before retiring the source. Destroying an
      // Axios response with the same error first can race a downstream SSE
      // bridge and turn a recoverable stream error into a bare ECONNRESET.
      destroySourceAfterOutput(upstreamError)
    }

    const failIfRequestDeadlineExpired = (): boolean => {
      if (!requestDeadlineExpired()) return false
      failStream(createQwenAiRequestTimeoutError())
      return true
    }

    const handleIdle = async () => {
      if (finalChunkSent || idleRecoveryInFlight || semanticRecoveryInFlight || transientRecoveryInFlight) return
      idleTimer = undefined
      const idleError = new Error(
        `Qwen AI response stream was idle for more than ${Math.ceil((options.idleTimeoutMs || QWEN_AI_STREAM_IDLE_TIMEOUT_MS) / 1000)}s.`,
      )

      if (!options.recoverFromIdle) {
        failStream(idleError)
        return
      }

      idleRecoveryInFlight = true
      try {
        const recovered = await options.recoverFromIdle(idleError)
        if (recovered) {
          if (!finalChunkSent) refreshIdleTimer()
          return
        }
        if (!finalChunkSent) failStream(idleError)
      } catch (error) {
        if (!finalChunkSent) {
          failStream(error instanceof Error ? error : idleError)
        }
      } finally {
        idleRecoveryInFlight = false
      }
    }

    const refreshIdleTimer = () => {
      if (idleTimer) {
        clearTimeout(idleTimer)
      }
      idleTimer = setTimeout(() => {
        void handleIdle()
      }, options.idleTimeoutMs || QWEN_AI_STREAM_IDLE_TIMEOUT_MS)
    }

    const writeVisibleSse = (
      frame: string,
      answerVisible = true,
      progressVisible = answerVisible,
    ): boolean => {
      if (finalChunkSent) return false
      if (failIfRequestDeadlineExpired()) return false
      if (bufferManagedBranch || (stageManagedAnswer && answerVisible)) {
        const frameBytes = Buffer.byteLength(frame)
        if (managedBranchBytes + frameBytes > QWEN_AI_MANAGED_BRANCH_MAX_BYTES) {
          failStream(createQwenAiStreamFailure(
            `Qwen AI managed response branch exceeded the ${QWEN_AI_MANAGED_BRANCH_MAX_BYTES}-byte validation limit`,
          ))
          return false
        }
        managedBranchFrames.push(frame)
        managedBranchBytes += frameBytes
        if (!finalChunkSent) refreshIdleTimer()
        return true
      }
      writeDownstreamFrame(frame)
      if (progressVisible) visibleFrameCommitted = true
      if (answerVisible) answerFrameCommitted = true
      // Upstream events, parser buffering, and protocol fragments are not
      // client-visible progress. Refresh only after a frame reached the
      // downstream stream.
      if (!finalChunkSent) refreshIdleTimer()
      return true
    }

    const recoverFromSemanticEmpty = (error: QwenAiUpstreamError): void => {
      if (finalChunkSent || semanticRecoveryInFlight) return

      if (error.code === 'qwen_ai_wrapper_leak' && visibleFrameCommitted) {
        failStream(error)
        return
      }

      // A fresh provider branch may replace an invalid branch only while the
      // response is still private to this handler. Once a live frame reaches
      // the client, replay would splice two different generations into one
      // SSE response; report the late failure in-band instead.
      if (
        this.toolCallingPlan?.shouldParseResponse === true
        && !bufferManagedBranch
        && answerFrameCommitted
      ) {
        failStream(error)
        return
      }
      if (isQwenAiStaleSessionError(error) && visibleFrameCommitted) {
        failStream(error)
        return
      }

      const recover = options.recoverFromSemanticEmpty ?? options.recoverFromIdle
      if (!recover) {
        failStream(error)
        return
      }

      semanticRecoveryInFlight = true
      if (buffersManagedCandidate) {
        discardManagedBranchFrames()
      }
      if (buffersManagedCandidate || error.code === 'qwen_ai_wrapper_leak') {
        this.resetManagedResponseArtifacts()
        reasoningText = ''
        summaryText = ''
        summarySourceText = ''
      } else {
        this.resetToolResultGuards()
      }
      if (bufferManagedBranch) {
        initialChunkSent = false
        hasSentReasoning = false
      }
      // The current response has reached a provider terminal marker, but it
      // is not complete from the client's perspective. Let the response-id
      // continuation own the next terminal marker instead of treating this
      // one as definitive.
      sawUpstreamCompletion = false
      console.warn('[QwenAI] Recovering semantically incomplete stream response:', error.code)

      const onResume = () => {
        semanticRecoveryInFlight = false
        if (!finalChunkSent) refreshIdleTimer()
      }

      void recover(error, onResume).then(recovered => {
        semanticRecoveryInFlight = false
        if (finalChunkSent) return
        if (recovered) {
          refreshIdleTimer()
          return
        }
        failStream(error)
      }).catch(recoveryError => {
        semanticRecoveryInFlight = false
        if (finalChunkSent) return
        failStream(recoveryError instanceof Error ? recoveryError : error)
      })
    }

    const recoverFromTransientUpstreamFailure = (error: QwenAiUpstreamError): void => {
      if (finalChunkSent || semanticRecoveryInFlight || transientRecoveryInFlight) return

      const recover = options.recoverFromIdle ?? options.recoverFromSemanticEmpty

      // Once a frame has reached the client, a response-id replay would splice
      // two generations into one SSE stream. Let the caller report the late
      // failure instead. Private managed frames remain eligible for recovery.
      if (visibleFrameCommitted || !recover || error.status === undefined || error.status < 500) {
        failStream(error)
        return
      }

      transientRecoveryInFlight = true
      console.warn('[QwenAI] Recovering private stream after transient upstream failure:', describeErrorForLog(error))
      const onResume = () => {
        transientRecoveryInFlight = false
        if (!finalChunkSent) refreshIdleTimer()
      }

      void recover(error, onResume).then(recovered => {
        transientRecoveryInFlight = false
        if (finalChunkSent) return
        if (recovered) {
          refreshIdleTimer()
          return
        }
        failStream(error)
      }).catch(recoveryError => {
        transientRecoveryInFlight = false
        if (finalChunkSent) return
        failStream(recoveryError instanceof Error ? recoveryError : error)
      })
    }

    function onAbort() {
      failStream(new Error('Qwen AI response stream aborted because the client disconnected.'))
    }

    const onUpstreamError = (err: Error) => {
      if (finalChunkSent || semanticRecoveryInFlight || transientRecoveryInFlight) {
        return
      }
      const description = describeErrorForLog(err)
      if (isClientCancellationError(err)) {
        console.log('[QwenAI] Stream cancelled:', description)
      } else {
        console.error('[QwenAI] Stream error:', description)
      }
      failStream(err)
    }

    // Install the source error handler before an already-aborted signal or
    // expired deadline can destroy the stream with an error.
    stream.once('error', onUpstreamError)

    if (options.signal?.aborted) {
      failStream(new Error('Qwen AI response stream aborted before reading started.'))
      return transStream
    }

    if (requestDeadlineAt !== undefined) {
      const remainingMs = requestDeadlineAt - Date.now()
      if (remainingMs <= 0) {
        failStream(createQwenAiRequestTimeoutError())
        return transStream
      }
      requestDeadlineTimer = setTimeout(() => {
        failStream(createQwenAiRequestTimeoutError())
      }, remainingMs)
    }
    if (responseTimeoutMs > 0) {
      responseTimer = setTimeout(() => {
        failStream(new Error(`Qwen AI response stream timed out after ${Math.ceil(responseTimeoutMs / 1000)}s.`))
      }, responseTimeoutMs)
    }
    refreshIdleTimer()

    if (options.signal) {
      options.signal.addEventListener('abort', onAbort, { once: true })
      abortListenerAttached = true
    }

    const publishQwenAiSessionState = () => {
      const state = options.qwenAiSessionState
      // A create-chat payload has only a local placeholder child ID. Persist
      // a bridge state only when upstream SSE supplied the real parent
      // response ID that a follow-up Qwen turn can use.
      if (!state || !this.chatId.trim() || !this.responseId.trim()) return
      transStream.qwenAiSessionState = state
    }

    const publishQwenAiToolCallIds = () => {
      const toolCallIds = this.getEmittedToolCallIds()
      if (toolCallIds.length > 0) transStream.qwenAiToolCallIds = toolCallIds
    }

    const completeStream = (commitTerminalOutput: () => boolean): boolean => {
      if (failIfRequestDeadlineExpired()) return false
      if (!commitTerminalOutput()) return false
      this.streamCompleted = true
      publishQwenAiSessionState()
      publishQwenAiToolCallIds()
      finalChunkSent = true
      cleanup()
      destroySourceAfterOutput()
      return true
    }

    const writeGuardedContent = (content: string, finishOnToolCall = true) => {
      if (!content || finalChunkSent) return

      this.content += content

      const baseChunk = createBaseChunk(this.responseId || this.chatId, this.model, this.created)
      const outputChunks = this.toolStreamParser?.push(content, baseChunk, !initialChunkSent) ?? [
        {
          ...baseChunk,
          choices: [{ index: 0, delta: { content }, finish_reason: null }],
        },
      ]

      let emittedManagedToolCall = false
      for (const outputChunk of outputChunks) {
        this.recordEmittedToolCallIdsFromChunk(outputChunk)
        const choices = Array.isArray(outputChunk?.choices) ? outputChunk.choices : []
        if (choices.some((choice: any) => {
          const toolCalls = choice?.delta?.tool_calls
          return Array.isArray(toolCalls) && toolCalls.length > 0
        })) {
          emittedManagedToolCall = true
        }
        writeVisibleSse(`data: ${JSON.stringify(outputChunk)}\n\n`)
      }

      if (outputChunks.length > 0) {
        initialChunkSent = true
        if (QWEN_AI_DEBUG_STREAM_LOGS) {
          console.log('[QwenAI] Content/tool chunk written')
        }
      }

      // A managed tool protocol block is terminal once the parser has emitted
      // a complete tool call. Some upstream responses never send a follow-up
      // `finished`/`[DONE]` event, so waiting for it leaves the downstream
      // client hanging after it already received an actionable tool call.
      if (
        finishOnToolCall
        && emittedManagedToolCall
        && !finalChunkSent
        && !bufferManagedBranch
      ) {
        finishAnswer('tool_calls')
      }
    }

    const writeGuardedReasoning = (content: string) => {
      if (!content || finalChunkSent) return
      reasoningText += content
      if (options.reasoningOnlyAsContent) return

      if (!hasSentReasoning) {
        writeVisibleSse(
          `data: ${JSON.stringify({
            id: this.responseId || this.chatId,
            model: this.model,
            object: 'chat.completion.chunk',
            choices: [{ index: 0, delta: { role: 'assistant', reasoning_content: '' }, finish_reason: null }],
            created: this.created,
          })}\n\n`,
          false,
          true,
        )
        hasSentReasoning = true
        console.log('[QwenAI] Sent reasoning role chunk')
      }
      writeVisibleSse(
        `data: ${JSON.stringify({
          id: this.responseId || this.chatId,
          model: this.model,
          object: 'chat.completion.chunk',
          choices: [{ index: 0, delta: { reasoning_content: content }, finish_reason: null }],
          created: this.created,
        })}\n\n`,
        false,
        true,
      )
    }

    const writeGuardedSummary = (content: string) => {
      if (!content || finalChunkSent) return
      summaryText += content
      if (options.reasoningOnlyAsContent) return

      if (!hasSentReasoning) {
        writeVisibleSse(
          `data: ${JSON.stringify({
            id: this.responseId || this.chatId,
            model: this.model,
            object: 'chat.completion.chunk',
            choices: [{ index: 0, delta: { role: 'assistant', reasoning_content: '' }, finish_reason: null }],
            created: this.created,
          })}\n\n`,
          false,
        )
        hasSentReasoning = true
      }
      writeVisibleSse(
        `data: ${JSON.stringify({
          id: this.responseId || this.chatId,
          model: this.model,
          object: 'chat.completion.chunk',
          choices: [{ index: 0, delta: { reasoning_content: content }, finish_reason: null }],
          created: this.created,
        })}\n\n`,
        false,
        true,
      )
    }

    const flushAssistantOutputGuards = (): boolean => {
      const answer = this.flushAssistantOutputGuard('answer')
      const reasoning = this.flushAssistantOutputGuard('reasoning')
      const summary = this.flushAssistantOutputGuard('summary')
      if (this.currentBranchHasWrapperLeak()) {
        recoverFromSemanticEmpty(createQwenAiWrapperLeakError())
        return false
      }
      writeGuardedContent(answer.content, false)
      writeGuardedReasoning(reasoning.content)
      writeGuardedSummary(summary.content)
      return !finalChunkSent && !semanticRecoveryInFlight
    }

    const writeGeneratedImages = (
      images: QwenAiGeneratedImage[],
      startingIndex: number,
    ) => {
      if (images.length === 0 || finalChunkSent) return

      const content = qwenAiGeneratedImageContentDelta(this.content, images, startingIndex)
      this.content += content
      const baseChunk = createBaseChunk(this.responseId || this.chatId, this.model, this.created)
      const imageChunk = {
        ...baseChunk,
        choices: [{
          index: 0,
          delta: {
            ...(!initialChunkSent ? { role: 'assistant' } : {}),
            content,
            images,
          },
          finish_reason: null,
        }],
      }
      if (writeVisibleSse(`data: ${JSON.stringify(imageChunk)}\n\n`)) {
        initialChunkSent = true
      }
    }

    const finishAnswer = (finishReason: string = 'stop') => {
      if (finalChunkSent || semanticRecoveryInFlight) return
      if (failIfRequestDeadlineExpired()) return

      if (!flushAssistantOutputGuards()) return

      const completeUndeclaredNativeToolNames = this.getCompleteUndeclaredNativeToolNames()
      if (completeUndeclaredNativeToolNames.length > 0) {
        recoverFromSemanticEmpty(createQwenAiUndeclaredNativeToolError(completeUndeclaredNativeToolNames))
        return
      }

      const invalidNativeToolArguments = this.getInvalidNativeToolArgumentIssues()
      if (invalidNativeToolArguments.length > 0) {
        recoverFromSemanticEmpty(createQwenAiInvalidNativeToolArgumentsError(invalidNativeToolArguments))
        return
      }

      const incompleteDeclaredNativeToolNames = this.getIncompleteDeclaredNativeToolNames()
      if (incompleteDeclaredNativeToolNames.length > 0) {
        recoverFromSemanticEmpty(createQwenAiIncompleteNativeToolError(incompleteDeclaredNativeToolNames))
        return
      }

      const completeNativeToolCalls = this.getCompleteNativeToolCalls()
      if (completeNativeToolCalls.length > 0) {
        const usage = this.createEstimatedUsage(
          this.content,
          options.reasoningOnlyAsContent ? undefined : `${reasoningText}${summaryText}`,
          completeNativeToolCalls,
        )
        if (completeStream(() => {
          flushManagedBranchFrames(true)
          return this.emitNativeToolCalls(
            transStream,
            completeNativeToolCalls,
            !initialChunkSent,
            usage,
          )
        })) {
          return
        }
      }

      const hadPendingToolProtocol = this.toolStreamParser?.hasPendingToolProtocol() ?? false

      const baseChunk = createBaseChunk(this.responseId || this.chatId, this.model, this.created)
      const flushChunks = this.toolStreamParser?.flush(baseChunk) ?? []
      for (const outputChunk of flushChunks) {
        this.recordEmittedToolCallIdsFromChunk(outputChunk)
        writeVisibleSse(`data: ${JSON.stringify(outputChunk)}\n\n`)
      }

      const recoveredToolChunks = this.toolStreamParser?.recoverFromContent(this.content, baseChunk, !initialChunkSent) ?? []
      for (const outputChunk of recoveredToolChunks) {
        this.recordEmittedToolCallIdsFromChunk(outputChunk)
        writeVisibleSse(`data: ${JSON.stringify(outputChunk)}\n\n`)
      }
      if (recoveredToolChunks.length > 0) {
        initialChunkSent = true
        console.log('[QwenAI] Recovered tool call from accumulated answer content')
      }

      if (hasToolUse(this.content)) {
        console.log('[QwenAI] Found legacy tool_use in stream, sending tool_calls')
        const usage = this.createEstimatedUsage(
          this.content,
          options.reasoningOnlyAsContent ? undefined : `${reasoningText}${summaryText}`,
        )
        if (completeStream(() => {
          flushManagedBranchFrames(true)
          return this.sendToolCalls(transStream, usage)
        })) {
          return
        }
      }

      const emittedToolCall = this.toolStreamParser?.hasEmittedToolCall() ?? false
      const managedParse = !emittedToolCall && this.toolCallingPlan?.shouldParseResponse
        ? getToolProtocol(this.toolCallingPlan.protocol).parse(this.content, {
            tools: this.toolCallingPlan.tools,
            protocol: this.toolCallingPlan.protocol,
            allowPartial: true,
          })
        : undefined
      const validationFailure = getToolStreamValidationFailure({
        plan: this.toolCallingPlan,
        emittedToolCall,
        pendingToolProtocol: hadPendingToolProtocol,
      })
      if (validationFailure) {
        if (managedParse && this.toolCallingPlan) {
          logQwenAiManagedParseFailure('stream', this.toolCallingPlan, managedParse, this.content)
        }
        const validationError = createQwenAiToolValidationError(validationFailure)
        if (isQwenAiSemanticRecoveryError(validationError)) {
          recoverFromSemanticEmpty(validationError)
        } else {
          failStream(validationError)
        }
        return
      }

      if (
        !emittedToolCall
        && isDanglingManagedToolAnswer(this.content, this.toolCallingPlan)
      ) {
        recoverFromSemanticEmpty(createQwenAiSemanticIncompleteError())
        return
      }

      const completionProof = parseManagedWorkflowCompletionProof(
        this.content,
        this.toolCallingPlan,
      )
      if (!emittedToolCall && completionProof.complete) {
        if (!completionProof.content.trim()) {
          recoverFromSemanticEmpty(createQwenAiSemanticIncompleteError())
          return
        }
        this.content = completionProof.content
        if (buffersManagedCandidate) {
          managedBranchFrames = replaceManagedWorkflowContentInSseFrames(
            managedBranchFrames,
            completionProof.content,
          )
          managedBranchBytes = managedBranchFrames.reduce(
            (total, frame) => total + Buffer.byteLength(frame),
            0,
          )
        }
      }

      let hasAnswerOrTool = Boolean(this.content.trim() || emittedToolCall)

      if (
        !hasAnswerOrTool
        && options.allowReasoningOnlyOutput
        && (reasoningText.trim() || summaryText.trim())
      ) {
        const fallbackContent = summaryText.trim() || reasoningText.trim()
        if (!initialChunkSent) sendInitialChunk()
        writeGuardedContent(fallbackContent)
        hasAnswerOrTool = Boolean(this.content.trim())
        console.info('[QwenAI] Accepted reasoning-only output for context compaction', JSON.stringify({
          chars: fallbackContent.length,
          asContent: options.reasoningOnlyAsContent === true,
        }))
      }

      const hasReasoningOnlyOutput = Boolean(
        !hasAnswerOrTool && (reasoningText.trim() || summaryText.trim()),
      )
      if (hasReasoningOnlyOutput) {
        recoverFromSemanticEmpty(createQwenAiSemanticEmptyError())
        return
      }

      const hasUsableOutput = Boolean(hasAnswerOrTool)
      if (!hasUsableOutput) {
        failStream(createQwenAiStreamFailure(
          'Qwen AI returned an empty response stream without answer, reasoning, or tool calls',
          'qwen_ai_empty_stream',
        ))
        return
      }

      const resolvedFinishReason = emittedToolCall
        ? 'tool_calls'
        : finishReason
      const finalChunk = {
        id: this.responseId || this.chatId,
        model: this.model,
        object: 'chat.completion.chunk',
        choices: [{ index: 0, delta: {}, finish_reason: resolvedFinishReason }],
        usage: this.createEstimatedUsage(
          this.content,
          options.reasoningOnlyAsContent ? undefined : `${reasoningText}${summaryText}`,
        ),
        created: this.created,
      }
      if (!completeStream(() => {
        flushManagedBranchFrames(emittedToolCall)
        writeDownstreamFrame(`data: ${JSON.stringify(finalChunk)}\n\n`)
        transStream.end('data: [DONE]\n\n')
        return true
      })) return

      if (this.onEnd && this.chatId) {
        this.onEnd(this.chatId)
      }
    }

    const sendInitialChunk = () => {
      if (!initialChunkSent && !this.toolStreamParser) {
        const initialChunk = `data: ${JSON.stringify({
          id: '',
          model: this.model,
          object: 'chat.completion.chunk',
          choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }],
          created: this.created,
        })}\n\n`
        if (writeVisibleSse(initialChunk, false)) {
          initialChunkSent = true
        }
        if (QWEN_AI_DEBUG_STREAM_LOGS) {
          console.log('[QwenAI] Initial chunk written')
        }
      }
    }

    parser = createParser({
      onEvent: (event: any) => {
        try {
          if (finalChunkSent || semanticRecoveryInFlight || transientRecoveryInFlight) {
            return
          }
          if (failIfRequestDeadlineExpired()) return

          if (typeof event.data !== 'string' || event.data.trim() === '') {
            return
          }

          if (QWEN_AI_DEBUG_STREAM_LOGS) {
            console.log('[QwenAI] Parsed event:', event.event, 'data:', event.data?.substring(0, 200))
          }
          
          if (event.data === '[DONE]') {
            upstreamEventCount += 1
            lastUpstreamEventAt = Date.now()
            lastUpstreamEventType = 'done'
            console.log('[QwenAI] Received [DONE] signal')
            sawUpstreamCompletion = true
            finishAnswer('stop')
            return
          }

          let data: any
          try {
            data = JSON.parse(event.data)
          } catch (parseError) {
            const envelopeError = createQwenAiStreamEnvelopeError(event.data, event.data, event.event)
            if (envelopeError) {
              if (
                isQwenAiStaleSessionError(envelopeError)
                || (bufferManagedBranch && isQwenAiResponseEndedError(envelopeError))
              ) {
                recoverFromSemanticEmpty(envelopeError)
              } else if (envelopeError.status !== undefined && envelopeError.status >= 500) {
                recoverFromTransientUpstreamFailure(envelopeError)
              } else {
                failStream(envelopeError)
              }
              return
            }
            throw parseError
          }
          const envelopeError = createQwenAiStreamEnvelopeError(data, event.data, event.event)
          if (envelopeError) {
            if (
              isQwenAiStaleSessionError(envelopeError)
              || (bufferManagedBranch && isQwenAiResponseEndedError(envelopeError))
            ) {
              recoverFromSemanticEmpty(envelopeError)
            } else if (envelopeError.status !== undefined && envelopeError.status >= 500) {
              recoverFromTransientUpstreamFailure(envelopeError)
            } else {
              failStream(envelopeError)
            }
            return
          }
          upstreamEventCount += 1
          lastUpstreamEventAt = Date.now()
          lastUpstreamEventType = data['response.created']
            ? 'response.created'
            : Array.isArray(data.choices) ? 'choices' : 'json'
          if (QWEN_AI_DEBUG_STREAM_LOGS) {
            console.log('[QwenAI] Parsed JSON data keys:', Object.keys(data))
          }

          if (data['response.created']) {
            this.recordResponseCreated(data['response.created'])
            const pendingUndeclaredToolNames = this.getCompleteUndeclaredNativeToolNames()
            if (pendingUndeclaredToolNames.length > 0 && this.responseId) {
              recoverFromSemanticEmpty(createQwenAiUndeclaredNativeToolError(pendingUndeclaredToolNames))
              return
            }
          }

          if (data.choices && data.choices.length > 0) {
            if (!this.shouldProcessResponseEvent(data)) {
              return
            }

            // Compaction may intentionally keep Qwen reasoning private until
            // the terminal summary is available. Growing upstream reasoning
            // still proves generation progress and must refresh the semantic
            // idle watchdog even though no model bytes are exposed yet.
            if (isMeaningfulQwenAiEvent(event, summarySourceText.length)) {
              refreshIdleTimer()
            }

            const choice = data.choices[0]
            const delta = choice.delta || {}
            const phase = delta.phase
            const status = delta.status
            let content = delta.content || ''
            let summaryDiff = ''
            const generatedImageBatch = isQwenAiImageGenerationPhase(phase)
              ? this.ingestGeneratedImages(delta.extra)
              : { images: [], startingIndex: this.generatedImages.length }

            if (QWEN_AI_DEBUG_STREAM_LOGS) {
              console.log('[QwenAI] Phase:', phase, 'Status:', status, 'Content:', content.substring(0, 50))
            }

            if (phase === 'think' && status !== 'finished' && content) {
              content = this.guardAssistantOutput(content, 'reasoning').content
            } else if (phase === 'thinking_summary') {
              const parts = delta.extra?.summary_thought?.content
              const newSummary = Array.isArray(parts) ? parts.join('\n') : ''
              if (newSummary) {
                const update = this.guardCumulativeSummarySnapshot(newSummary, summarySourceText)
                summarySourceText = update.sourceText
                summaryDiff = update.content
                if (update.replacement !== undefined) summaryText = update.replacement
              }
            } else if ((phase === 'answer' || phase === null) && content) {
              content = this.guardAssistantOutput(content, 'answer').content
            }

            if (this.currentBranchHasWrapperLeak()) {
              recoverFromSemanticEmpty(createQwenAiWrapperLeakError())
              return
            }

            const nativeToolProgress = this.ingestNativeToolCallFragments(delta)

            if (nativeToolProgress.sawFragment) {
              const invalidNativeToolArguments = this.getInvalidNativeToolArgumentIssues()
              const completeUndeclaredNativeToolNames = this.getCompleteUndeclaredNativeToolNames()
              if (completeUndeclaredNativeToolNames.length > 0 && this.responseId) {
                recoverFromSemanticEmpty(createQwenAiUndeclaredNativeToolError(completeUndeclaredNativeToolNames))
                return
              }
              if (status === 'finished') {
                if (invalidNativeToolArguments.length > 0) {
                  recoverFromSemanticEmpty(createQwenAiInvalidNativeToolArgumentsError(invalidNativeToolArguments))
                  return
                }
              }

              const completeNativeToolCalls = this.getCompleteNativeToolCalls()
              const incompleteDeclaredNativeToolNames = this.getIncompleteDeclaredNativeToolNames()
              if (
                invalidNativeToolArguments.length === 0
                && completeUndeclaredNativeToolNames.length === 0
                && incompleteDeclaredNativeToolNames.length === 0
                && completeNativeToolCalls.length > 0
                && !bufferManagedBranch
              ) {
                finishAnswer('tool_calls')
                if (finalChunkSent || semanticRecoveryInFlight) {
                  return
                }
              }

              if (!content && generatedImageBatch.images.length === 0 && status !== 'finished') {
                return
              }
            }

            if (phase === 'think') {
              if (status !== 'finished' && content) {
                // Summary turns buffer thinking text and emit it as content at
                // the terminal marker; regular requests keep live reasoning.
                writeGuardedReasoning(content)
              }
              // When status === 'finished', the think phase is done
            } else if (phase === 'thinking_summary') {
              const extra = delta.extra || {}
              if (QWEN_AI_DEBUG_STREAM_LOGS) {
                console.log('[QwenAI] thinking_summary extra:', JSON.stringify(extra).substring(0, 300))
              }
              if (summaryDiff) {
                writeGuardedSummary(summaryDiff)
                console.log('[QwenAI] Updated summaryText, length:', summaryText.length)
              }
            } else if (phase === 'answer') {
              if (content && !initialChunkSent) sendInitialChunk()
              if (QWEN_AI_DEBUG_STREAM_LOGS) {
                console.log('[QwenAI] Entering answer branch, content:', content)
              }
              writeGuardedContent(content)
            } else if (phase === null && content) {
              if (!initialChunkSent) {
                sendInitialChunk()
              }
              writeGuardedContent(content)
            }

            writeGeneratedImages(
              generatedImageBatch.images,
              generatedImageBatch.startingIndex,
            )
            const imageGenerationFinished = status === 'finished'
              && isQwenAiImageGenerationPhase(phase)
              && this.generatedImages.length > 0
            if (imageGenerationFinished) {
              sawUpstreamCompletion = true
            }

            if (status === 'finished' && (phase === 'answer' || phase === null)) {
              sawUpstreamCompletion = true
              // Qwen's Web SSE commonly ends with this provider-native
              // terminal delta and then closes without a literal [DONE].
              // Managed frames stay private until this point, so it is safe
              // to validate and atomically commit the completed branch now.
              finishAnswer(delta.finish_reason || 'stop')
            } else if (imageGenerationFinished) {
              finishAnswer(delta.finish_reason || 'stop')
            }
          }
        } catch (err) {
          console.error('[QwenAI] Stream parse error:', describeErrorForLog(err))
          failStream(err instanceof Error ? err : new Error('Qwen AI stream event could not be parsed'))
        }
      },
    })

    stream.on('data', (buffer: Buffer) => {
      if (finalChunkSent || failIfRequestDeadlineExpired()) return
      const text = buffer.toString()
      if (QWEN_AI_DEBUG_STREAM_LOGS) {
        console.log('[QwenAI] Raw stream data:', text.substring(0, 500))
      }
      parser.feed(text)
    })
    stream.once('end', () => {
      if (QWEN_AI_DEBUG_STREAM_LOGS) {
        console.log('[QwenAI] Stream ended')
      }
      if (!finalChunkSent && !semanticRecoveryInFlight && !transientRecoveryInFlight) {
        if (sawUpstreamCompletion && !bufferManagedBranch) {
          finishAnswer('stop')
        } else {
          failStream(createQwenAiStreamFailure('Qwen AI response stream ended before an upstream completion signal'))
        }
      }
    })
    stream.once('close', () => {
      if (QWEN_AI_DEBUG_STREAM_LOGS) {
        console.log('[QwenAI] Stream closed')
      }
      if (!finalChunkSent && !semanticRecoveryInFlight && !transientRecoveryInFlight) {
        if (sawUpstreamCompletion && !bufferManagedBranch) {
          finishAnswer('stop')
        } else {
          failStream(createQwenAiStreamFailure('Qwen AI response stream closed before an upstream completion signal'))
        }
      }
    })
    transStream.once('close', () => {
      cleanup()
      if (!finalChunkSent) {
        const error = new Error('Qwen AI downstream stream closed before upstream completed.')
        const normalized = normalizeQwenAiStreamFailure(error)
        recordStreamFailure(normalized)
        destroyReadableStream(stream, normalized)
      }
    })

    return transStream
  }

  async handleNonStream(stream: any, options: StreamHandlingOptions = {}): Promise<any> {
    return new Promise((resolve, reject) => {
      const data = {
        id: '',
        model: this.model,
        object: 'chat.completion',
        choices: [
          {
            index: 0,
            message: { role: 'assistant', content: '', reasoning_content: '' },
            finish_reason: 'stop',
          },
        ],
        usage: this.createEstimatedUsage('', ''),
        created: this.created,
      }

      let reasoningText = ''
      let summaryText = ''
      let summarySourceText = ''
      let resolved = false
      let sawAnswerFinish = false
      let sawUpstreamCompletion = false
      let requestDeadlineTimer: NodeJS.Timeout | undefined
      let responseTimer: NodeJS.Timeout | undefined
      let idleTimer: NodeJS.Timeout | undefined
      let abortListenerAttached = false
      let idleRecoveryInFlight = false
      let semanticRecoveryInFlight = false
      let parser: ReturnType<typeof createParser>
      const responseTimeoutMs = options.responseTimeoutMs ?? QWEN_AI_RESPONSE_TIMEOUT_MS
      const requestDeadlineAt = typeof options.requestDeadlineAt === 'number'
        && Number.isFinite(options.requestDeadlineAt)
        ? options.requestDeadlineAt
        : undefined
      const requestDeadlineExpired = () => requestDeadlineAt !== undefined
        && Date.now() >= requestDeadlineAt

      this.continuationResetter = () => {
        // Keep the same downstream promise alive, but start parsing the fresh
        // provider response as a new assistant branch.
        reasoningText = ''
        summaryText = ''
        summarySourceText = ''
        data.id = ''
        data.choices[0].message = {
          role: 'assistant',
          content: '',
          reasoning_content: '',
        }
        data.choices[0].finish_reason = 'stop'
        sawAnswerFinish = false
        sawUpstreamCompletion = false
        idleRecoveryInFlight = false
        semanticRecoveryInFlight = false
        parser?.reset()
      }

      const cleanupTimers = () => {
        if (requestDeadlineTimer) {
          clearTimeout(requestDeadlineTimer)
          requestDeadlineTimer = undefined
        }
        if (responseTimer) {
          clearTimeout(responseTimer)
          responseTimer = undefined
        }
        if (idleTimer) {
          clearTimeout(idleTimer)
          idleTimer = undefined
        }
      }

      const cleanup = () => {
        cleanupTimers()
        if (abortListenerAttached) {
          options.signal?.removeEventListener('abort', onAbort)
          abortListenerAttached = false
        }
      }

      function rejectOnce(reason: any) {
        if (resolved) return
        resolved = true
        cleanup()
        const error = enforceQwenAiFailoverBoundary(
          normalizeQwenAiStreamFailure(reason),
          () => true,
        )
        destroyReadableStream(stream, error)
        reject(error)
      }

      const resolveOnce = (value: any): boolean => {
        if (resolved) return false
        if (requestDeadlineExpired()) {
          rejectOnce(createQwenAiRequestTimeoutError())
          return false
        }
        resolved = true
        this.streamCompleted = true
        cleanup()
        destroyReadableStream(stream)
        resolve(this.withEstimatedUsage(value))
        return true
      }

      const flushNonStreamOutputGuards = (): boolean => {
        const answer = this.flushAssistantOutputGuard('answer')
        const reasoning = this.flushAssistantOutputGuard('reasoning')
        const summary = this.flushAssistantOutputGuard('summary')
        if (this.currentBranchHasWrapperLeak()) {
          recoverFromSemanticEmpty(createQwenAiWrapperLeakError())
          return false
        }
        data.choices[0].message.content += answer.content
        reasoningText += reasoning.content
        summaryText += summary.content
        return !resolved && !semanticRecoveryInFlight
      }

      const finishNativeToolCalls = (): boolean => {
        if (requestDeadlineExpired()) {
          rejectOnce(createQwenAiRequestTimeoutError())
          return true
        }
        const toolCalls = this.getCompleteNativeToolCalls()
        if (toolCalls.length === 0) return false
        this.recordEmittedToolCallIds(toolCalls)
        if (!flushNonStreamOutputGuards()) return true

        const choice = data.choices[0]
        const response = {
          ...data,
          choices: [{
            ...choice,
            message: {
              ...choice.message,
              content: null,
              tool_calls: toolCalls,
            },
            finish_reason: 'tool_calls',
          }],
        }
        sawAnswerFinish = true
        sawUpstreamCompletion = true
        if (resolveOnce(response) && this.onEnd && this.chatId) {
          this.onEnd(this.chatId)
        }
        return true
      }

      const finishNonStream = () => {
        if (resolved || semanticRecoveryInFlight) return
        if (requestDeadlineExpired()) {
          rejectOnce(createQwenAiRequestTimeoutError())
          return
        }
        if (!flushNonStreamOutputGuards()) return

        const choice = data.choices[0]
        const answerText = choice.message.content || ''
        const finalReasoning = summaryText || reasoningText
        const completeUndeclaredNativeToolNames = this.getCompleteUndeclaredNativeToolNames()
        if (completeUndeclaredNativeToolNames.length > 0) {
          recoverFromSemanticEmpty(createQwenAiUndeclaredNativeToolError(completeUndeclaredNativeToolNames))
          return
        }

        const invalidNativeToolArguments = this.getInvalidNativeToolArgumentIssues()
        if (invalidNativeToolArguments.length > 0) {
          recoverFromSemanticEmpty(createQwenAiInvalidNativeToolArgumentsError(invalidNativeToolArguments))
          return
        }

        const incompleteDeclaredNativeToolNames = this.getIncompleteDeclaredNativeToolNames()
        if (incompleteDeclaredNativeToolNames.length > 0) {
          recoverFromSemanticEmpty(createQwenAiIncompleteNativeToolError(incompleteDeclaredNativeToolNames))
          return
        }

        if (finishNativeToolCalls()) return

        if (this.toolCallingPlan?.shouldParseResponse) {
          const managedParse = getToolProtocol(this.toolCallingPlan.protocol).parse(answerText, {
            tools: this.toolCallingPlan.tools,
            protocol: this.toolCallingPlan.protocol,
            allowPartial: true,
          })
          const managedValidationFailure = getToolStreamValidationFailure({
            plan: this.toolCallingPlan,
            emittedToolCall: (managedParse.toolCalls?.length ?? 0) > 0,
            pendingToolProtocol: (managedParse.rawMatches?.length ?? 0) > 0,
          })
          if (managedValidationFailure) {
            logQwenAiManagedParseFailure(
              'non_stream',
              this.toolCallingPlan,
              managedParse,
              answerText,
            )
            recoverFromSemanticEmpty(createQwenAiToolValidationError(managedValidationFailure))
            return
          }
        }

        if (isDanglingManagedToolAnswer(answerText, this.toolCallingPlan)) {
          recoverFromSemanticEmpty(createQwenAiSemanticIncompleteError())
          return
        }

        const completionProof = parseManagedWorkflowCompletionProof(
          answerText,
          this.toolCallingPlan,
        )
        if (completionProof.complete) {
          if (!completionProof.content.trim()) {
            recoverFromSemanticEmpty(createQwenAiSemanticIncompleteError())
            return
          }
          choice.message.content = completionProof.content
        }

        const visibleAnswerText = choice.message.content || ''
        if (!visibleAnswerText.trim() && finalReasoning.trim()) {
          if (options.allowReasoningOnlyOutput) {
            choice.message.content = finalReasoning
            console.info('[QwenAI] Accepted non-stream reasoning-only output for context compaction', JSON.stringify({
              chars: finalReasoning.length,
              asContent: options.reasoningOnlyAsContent === true,
            }))
          } else {
            recoverFromSemanticEmpty(createQwenAiSemanticEmptyError())
            return
          }
        }

        if (!visibleAnswerText.trim() && !finalReasoning.trim()) {
          rejectOnce(createQwenAiStreamFailure(
            'Qwen AI returned an empty response stream without answer or reasoning content',
            'qwen_ai_empty_stream',
          ))
          return
        }

        const response = {
          ...data,
          choices: [{
            ...choice,
            message: {
              ...choice.message,
              ...(finalReasoning ? { reasoning_content: finalReasoning } : {}),
              ...(this.generatedImages.length > 0
                ? { images: [...this.generatedImages] }
                : {}),
            },
          }],
        }
        if (!sawAnswerFinish) {
          console.log('[QwenAI] Non-stream completed with an upstream DONE signal.')
        }
        if (resolveOnce(response) && this.onEnd && this.chatId) {
          this.onEnd(this.chatId)
        }
      }

      const handleIdle = async () => {
        if (resolved || idleRecoveryInFlight || semanticRecoveryInFlight) return
        idleTimer = undefined
        const idleError = new Error(
          `Qwen AI response stream was idle for more than ${Math.ceil((options.idleTimeoutMs || QWEN_AI_STREAM_IDLE_TIMEOUT_MS) / 1000)}s.`,
        )

        if (!options.recoverFromIdle) {
          rejectOnce(idleError)
          return
        }

        idleRecoveryInFlight = true
        try {
          const recovered = await options.recoverFromIdle(idleError)
          if (recovered) {
            if (!resolved) refreshIdleTimer()
            return
          }
          if (!resolved) rejectOnce(idleError)
        } catch (error) {
          if (!resolved) rejectOnce(error instanceof Error ? error : idleError)
        } finally {
          idleRecoveryInFlight = false
        }
      }

      const refreshIdleTimer = () => {
        if (idleTimer) {
          clearTimeout(idleTimer)
        }
        idleTimer = setTimeout(() => {
          void handleIdle()
        }, options.idleTimeoutMs || QWEN_AI_STREAM_IDLE_TIMEOUT_MS)
      }

      const recoverFromSemanticEmpty = (error: QwenAiUpstreamError): void => {
        if (resolved || semanticRecoveryInFlight) return

        const recover = options.recoverFromSemanticEmpty ?? options.recoverFromIdle
        if (!recover) {
          rejectOnce(error)
          return
        }

        semanticRecoveryInFlight = true
        if (
          this.toolCallingPlan?.shouldParseResponse
          || error.code === 'qwen_ai_wrapper_leak'
        ) {
          this.resetManagedResponseArtifacts()
          reasoningText = ''
          summaryText = ''
          summarySourceText = ''
          data.choices[0].message = {
            role: 'assistant',
            content: '',
            reasoning_content: '',
          }
          data.choices[0].finish_reason = 'stop'
          sawAnswerFinish = false
        } else {
          this.resetToolResultGuards()
        }
        sawUpstreamCompletion = false
        console.warn('[QwenAI] Recovering semantically incomplete non-stream response:', error.code)

        const onResume = () => {
          semanticRecoveryInFlight = false
          if (!resolved) refreshIdleTimer()
        }

        void recover(error, onResume).then(recovered => {
          semanticRecoveryInFlight = false
          if (resolved) return
          if (recovered) {
            refreshIdleTimer()
            return
          }
          rejectOnce(error)
        }).catch(recoveryError => {
          semanticRecoveryInFlight = false
          if (!resolved) {
            rejectOnce(recoveryError instanceof Error ? recoveryError : error)
          }
        })
      }

      function onAbort() {
        rejectOnce(new Error('Qwen AI response stream aborted because the client disconnected.'))
      }

      const onUpstreamError = (err: Error) => {
        if (resolved || semanticRecoveryInFlight) {
          return
        }
        const description = describeErrorForLog(err)
        if (isClientCancellationError(err)) {
          console.log('[QwenAI] Non-stream cancelled:', description)
        } else {
          console.error('[QwenAI] Non-stream error:', description)
        }
        rejectOnce(err)
      }

      // rejectOnce destroys the source with its normalized error, including
      // when the request has already expired before parsing begins.
      stream.once('error', onUpstreamError)

      if (options.signal?.aborted) {
        rejectOnce(new Error('Qwen AI response stream aborted before reading started.'))
        return
      }

      if (requestDeadlineAt !== undefined) {
        const remainingMs = requestDeadlineAt - Date.now()
        if (remainingMs <= 0) {
          rejectOnce(createQwenAiRequestTimeoutError())
          return
        }
        requestDeadlineTimer = setTimeout(() => {
          rejectOnce(createQwenAiRequestTimeoutError())
        }, remainingMs)
      }
      if (responseTimeoutMs > 0) {
        responseTimer = setTimeout(() => {
          rejectOnce(new Error(`Qwen AI response stream timed out after ${Math.ceil(responseTimeoutMs / 1000)}s.`))
        }, responseTimeoutMs)
      }
      refreshIdleTimer()

      if (options.signal) {
        options.signal.addEventListener('abort', onAbort, { once: true })
        abortListenerAttached = true
      }

      parser = createParser({
        onEvent: (event: any) => {
          try {
            if (resolved || semanticRecoveryInFlight) {
              return
            }
            if (requestDeadlineExpired()) {
              rejectOnce(createQwenAiRequestTimeoutError())
              return
            }

            if (typeof event.data !== 'string' || event.data.trim() === '') {
              return
            }

            if (event.data === '[DONE]') {
              refreshIdleTimer()
              sawUpstreamCompletion = true
              finishNonStream()
              return
            }

            let parsed: any
            try {
              parsed = JSON.parse(event.data)
            } catch (parseError) {
              const envelopeError = createQwenAiStreamEnvelopeError(event.data, event.data, event.event)
              if (envelopeError) {
                if (isQwenAiStaleSessionError(envelopeError)) {
                  recoverFromSemanticEmpty(envelopeError)
                } else {
                  rejectOnce(envelopeError)
                }
                return
              }
              throw parseError
            }
            const envelopeError = createQwenAiStreamEnvelopeError(parsed, event.data, event.event)
            if (envelopeError) {
              if (isQwenAiStaleSessionError(envelopeError)) {
                recoverFromSemanticEmpty(envelopeError)
              } else {
                rejectOnce(envelopeError)
              }
              return
            }

            if (parsed['response.created']) {
              this.recordResponseCreated(parsed['response.created'])
              if (this.responseId) {
                data.id = this.responseId
              }
              const pendingUndeclaredToolNames = this.getCompleteUndeclaredNativeToolNames()
              if (pendingUndeclaredToolNames.length > 0 && this.responseId) {
                recoverFromSemanticEmpty(createQwenAiUndeclaredNativeToolError(pendingUndeclaredToolNames))
                return
              }
            }

            if (parsed.choices && parsed.choices.length > 0) {
              if (!this.shouldProcessResponseEvent(parsed)) {
                return
              }
              if (this.responseId) {
                data.id = this.responseId
              }

              const delta = parsed.choices[0].delta || {}
              const phase = delta.phase
              const status = delta.status
              let content = delta.content || ''
              let summaryDiff = ''
              const previousSummarySourceLength = summarySourceText.length
              const generatedImageBatch = isQwenAiImageGenerationPhase(phase)
                ? this.ingestGeneratedImages(delta.extra)
                : { images: [], startingIndex: this.generatedImages.length }
              let shouldFinishAnswer = false

              if (phase === 'think' && status !== 'finished' && content) {
                content = this.guardAssistantOutput(content, 'reasoning').content
              } else if (phase === 'thinking_summary') {
                const parts = delta.extra?.summary_thought?.content
                const newSummary = Array.isArray(parts) ? parts.join('\n') : ''
                if (newSummary) {
                  const update = this.guardCumulativeSummarySnapshot(newSummary, summarySourceText)
                  summarySourceText = update.sourceText
                  summaryDiff = update.content
                  if (update.replacement !== undefined) summaryText = update.replacement
                }
              } else if ((phase === 'answer' || phase === null) && content) {
                content = this.guardAssistantOutput(content, 'answer').content
              }

              if (this.currentBranchHasWrapperLeak()) {
                recoverFromSemanticEmpty(createQwenAiWrapperLeakError())
                return
              }

              this.ingestNativeToolCallFragments(delta)
              const completeUndeclaredNativeToolNames = this.getCompleteUndeclaredNativeToolNames()
              if (completeUndeclaredNativeToolNames.length > 0 && this.responseId) {
                recoverFromSemanticEmpty(createQwenAiUndeclaredNativeToolError(completeUndeclaredNativeToolNames))
                return
              }

              // Qwen can close a non-stream SSE response immediately after
              // emitting a complete native tool call, without a `finished`
              // delta or `[DONE]`. Treat the validated call as terminal just
              // like the streaming handler does; otherwise the bridge sees
              // only a transport close and discards the tool call.
              const invalidNativeToolArguments = this.getInvalidNativeToolArgumentIssues()
              if (invalidNativeToolArguments.length > 0) {
                recoverFromSemanticEmpty(createQwenAiInvalidNativeToolArgumentsError(invalidNativeToolArguments))
                return
              }
              const incompleteDeclaredNativeToolNames = this.getIncompleteDeclaredNativeToolNames()
              if (
                incompleteDeclaredNativeToolNames.length === 0
                && this.getCompleteNativeToolCalls().length > 0
                && finishNativeToolCalls()
              ) {
                return
              }

              if (isMeaningfulQwenAiEvent(event, previousSummarySourceLength)) {
                refreshIdleTimer()
              }

              if (phase === 'think' && status !== 'finished') {
                reasoningText += content
              } else if (phase === 'thinking_summary') {
                summaryText += summaryDiff
              } else if (phase === 'answer') {
                if (content) {
                  data.choices[0].message.content += content
                }
                if (status === 'finished') {
                  sawAnswerFinish = true
                  sawUpstreamCompletion = true
                  shouldFinishAnswer = true
                }
              } else if (phase === null) {
                if (content) {
                  data.choices[0].message.content += content
                }
                if (status === 'finished') {
                  sawAnswerFinish = true
                  sawUpstreamCompletion = true
                  shouldFinishAnswer = true
                }
              }

              if (generatedImageBatch.images.length > 0) {
                data.choices[0].message.content += qwenAiGeneratedImageContentDelta(
                  data.choices[0].message.content,
                  generatedImageBatch.images,
                  generatedImageBatch.startingIndex,
                )
              }

              const imageGenerationFinished = status === 'finished'
                && isQwenAiImageGenerationPhase(phase)
                && this.generatedImages.length > 0
              if (imageGenerationFinished) {
                sawUpstreamCompletion = true
                shouldFinishAnswer = true
              }

              if (shouldFinishAnswer) {
                finishNonStream()
              }
            }
          } catch (err) {
            console.error('[QwenAI] Non-stream parse error:', describeErrorForLog(err))
            rejectOnce(err)
          }
        },
      })

      stream.on('data', (buffer: Buffer) => {
        if (resolved) return
        if (requestDeadlineExpired()) {
          rejectOnce(createQwenAiRequestTimeoutError())
          return
        }
        parser.feed(buffer.toString())
      })
      const finishFromClose = () => {
        if (resolved || semanticRecoveryInFlight) return
        if (!sawUpstreamCompletion) {
          rejectOnce(createQwenAiStreamFailure('Qwen AI response stream closed before an upstream completion signal'))
          return
        }
        finishNonStream()
      }
      stream.once('end', finishFromClose)
      stream.once('close', finishFromClose)
    })
  }

  /**
   * Classify parsed state when the provider socket closes without a terminal
   * event. The resumable bridge uses this before treating the close as a
   * transport interruption, so semantic failures continue on a fresh branch.
   */
  getPendingSemanticRecoveryError(): Error | undefined {
    const undeclaredToolNames = this.getCompleteUndeclaredNativeToolNames()
    if (undeclaredToolNames.length > 0) {
      return createQwenAiUndeclaredNativeToolError(undeclaredToolNames)
    }

    const invalidNativeToolArguments = this.getInvalidNativeToolArgumentIssues()
    if (invalidNativeToolArguments.length > 0) {
      return createQwenAiInvalidNativeToolArgumentsError(invalidNativeToolArguments)
    }

    const incompleteDeclaredNativeToolNames = this.getIncompleteDeclaredNativeToolNames()
    if (incompleteDeclaredNativeToolNames.length > 0) {
      return createQwenAiIncompleteNativeToolError(incompleteDeclaredNativeToolNames)
    }

    return undefined
  }

  getChatId(): string {
    return this.chatId
  }

  getResponseId(): string {
    return this.responseId
  }

  isComplete(): boolean {
    return this.streamCompleted
  }
}

export const qwenAiAdapter = {
  QwenAiAdapter,
  QwenAiStreamHandler,
}
