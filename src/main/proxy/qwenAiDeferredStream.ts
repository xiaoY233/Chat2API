import { PassThrough } from 'node:stream'
import type { AccountFailoverOutcome } from './accountFailover'
import type { QwenAiOutputStream } from './adapters/qwen-ai'
import type { ForwardResult } from './types'

const QWEN_AI_STREAM_FAILURE_EVENT = 'qwen-ai-stream-failure'

type QwenAiFailure = Error & {
  status?: number
  code?: string
  headers?: Record<string, string>
  retryable?: boolean
  accountFault?: boolean
  retryScope?: 'next-account'
}

function isDeferredClientCancellation(error: unknown): boolean {
  const record = error && typeof error === 'object'
    ? error as Record<string, unknown>
    : undefined
  const code = typeof record?.code === 'string' ? record.code : ''
  const status = typeof record?.status === 'number' ? record.status : undefined
  const message = error instanceof Error ? error.message : String(error || '')
  return status === 499
    || code === 'ERR_CANCELED'
    || /client disconnected|client canceled|client cancelled|aborted because the client/i.test(message)
}

function failureFromResult(result: ForwardResult): QwenAiFailure {
  return Object.assign(new Error(result.error || 'Qwen AI account failover exhausted'), {
    status: result.status,
    code: result.errorCode,
    headers: result.headers,
    retryable: result.retryable,
    accountFault: result.accountFault,
    retryScope: result.retryScope,
  })
}

function missingStreamFailure(): QwenAiFailure {
  return Object.assign(new Error('Qwen AI returned no stream after account failover'), {
    status: 502,
    code: 'qwen_ai_missing_stream',
    accountFault: false,
  })
}

/**
 * Expose a stable stream immediately while account attempts run in the
 * background. All semantic frames stay private until the first fully
 * validated Qwen result is selected; the route-level SSE wrapper supplies
 * keep-alive comments while validation is pending.
 */
export function createDeferredQwenAiFailoverStream(
  outcomePromise: Promise<AccountFailoverOutcome>,
  signal?: AbortSignal,
): QwenAiOutputStream {
  const output = new PassThrough() as QwenAiOutputStream
  let source: NodeJS.ReadableStream | undefined
  let activeQwenSource: QwenAiOutputStream | undefined
  let settled = false
  let sourceFailure: Error | undefined
  let sourceFailurePending = false
  // A Qwen handler emits its failure event before writing the terminal SSE
  // error/[DONE] frames. Keep those bytes and close the outer stream normally
  // after the source has drained; transport/abort failures still propagate as
  // stream errors.
  let sourceFailurePreserveOutput = false
  let terminalFailureFramesWritten = false

  // The route installs its own error listener synchronously. Keep one local
  // listener as a guard for callers that close before route wiring completes.
  output.on('error', () => undefined)

  const detachAbort = () => signal?.removeEventListener('abort', onAbort)
  const setEffectiveSelection = (outcome: AccountFailoverOutcome) => {
    const result = outcome.result
    const qwenSource = result.stream as QwenAiOutputStream | undefined
    activeQwenSource = qwenSource
    output.qwenAiEffectiveAccountId = qwenSource?.qwenAiEffectiveAccountId
      || result.effectiveAccountId
      || outcome.selection.account.id
    output.qwenAiEffectiveProviderId = qwenSource?.qwenAiEffectiveProviderId
      || result.effectiveProviderId
      || outcome.selection.provider.id
    output.qwenAiEffectiveActualModel = qwenSource?.qwenAiEffectiveActualModel
      || result.effectiveActualModel
      || outcome.selection.actualModel
    // A deferred stream is the stream observed by the Responses route. Keep
    // the live Qwen state on that outer stream so it can be resolved after
    // the provider handler learns the real response ID.
    output.qwenAiSessionState = qwenSource?.qwenAiSessionState
      || result.qwenAiSessionState
    Object.defineProperty(output, 'qwenAiToolCallIds', {
      configurable: true,
      enumerable: false,
      get: () => activeQwenSource?.qwenAiToolCallIds || result.qwenAiToolCallIds,
    })
  }
  const fail = (error: Error, preserveOutput = false) => {
    if (settled) return
    sourceFailure = error
    sourceFailurePending = true
    sourceFailurePreserveOutput = sourceFailurePreserveOutput || preserveOutput
    output.qwenAiFailure = error
    output.emit(QWEN_AI_STREAM_FAILURE_EVENT, error)
    // The Qwen handler emits its failure notification before it writes the
    // terminal `event: error` and `[DONE]` frames. Give that source a chance
    // to flush those bytes before closing the deferred stream.
    if (preserveOutput && source && !source.readableEnded) return
    settleFailure(error)
  }
  const writeFailureFrames = (error: Error) => {
    if (terminalFailureFramesWritten || output.destroyed || output.writableEnded) return
    terminalFailureFramesWritten = true
    const details = error as Error & {
      status?: unknown
      type?: unknown
      code?: unknown
      retryable?: unknown
      accountFault?: unknown
      upstreamState?: unknown
    }
    const status = typeof details.status === 'number' ? details.status : undefined
    const type = typeof details.type === 'string' && details.type.trim()
      ? details.type
      : 'api_error'
    const code = typeof details.code === 'string' && details.code.trim()
      ? details.code
      : 'qwen_ai_stream_error'
    const payload = {
      error: {
        message: error.message,
        type,
        code,
        ...(status === undefined ? {} : { status }),
        ...(typeof details.retryable === 'boolean' ? { retryable: details.retryable } : {}),
        ...(typeof details.accountFault === 'boolean' ? { accountFault: details.accountFault } : {}),
        ...(typeof details.upstreamState === 'string' ? { upstream_state: details.upstreamState } : {}),
      },
    }
    output.write(`event: error\ndata: ${JSON.stringify(payload)}\n\n`)
    output.end('data: [DONE]\n\n')
  }
  const settleFailure = (error: Error) => {
    if (settled) return
    settled = true
    sourceFailurePending = false
    detachAbort()
    output.qwenAiFailure = error
    // A final account-failover result has no source stream to supply a
    // provider error trailer. Emit a normal SSE terminal sequence so a
    // Responses bridge can produce `response.failed` instead of observing a
    // transport-level EOF. The same fallback covers an unexpected source
    // error that arrives without Qwen's own terminal frames.
    if (!sourceFailurePreserveOutput && !isDeferredClientCancellation(error)) {
      writeFailureFrames(error)
      return
    }
    if (
      sourceFailurePreserveOutput
      && !output.destroyed
      && !output.writableEnded
    ) {
      // `destroy(error)` discards PassThrough data that is still queued for a
      // downstream Responses parser. Ending normally lets the already-written
      // `event: error` and `[DONE]` bytes drain before EOF, which LiteLLM can
      // translate into a structured failed response.
      output.end()
      return
    }
    output.destroy(error)
  }
  const complete = () => {
    if (settled) return
    settled = true
    sourceFailurePending = false
    detachAbort()
    output.end()
  }
  const destroySource = () => {
    const destroyable = source as (NodeJS.ReadableStream & { destroy?: () => void }) | undefined
    destroyable?.destroy?.()
  }
  function onAbort() {
    const error = Object.assign(new Error('Qwen AI account failover aborted because the client disconnected.'), {
      status: 499,
      code: 'ERR_CANCELED',
      accountFault: false,
    })
    destroySource()
    fail(error)
  }

  output.once('close', () => {
    if (!settled) destroySource()
    detachAbort()
  })

  if (signal?.aborted) {
    queueMicrotask(onAbort)
    return output
  }
  signal?.addEventListener('abort', onAbort, { once: true })

  void outcomePromise.then(outcome => {
    if (settled) return
    setEffectiveSelection(outcome)

    if (!outcome.result.success) {
      fail(failureFromResult(outcome.result))
      return
    }
    if (!outcome.result.stream) {
      fail(missingStreamFailure())
      return
    }

    source = outcome.result.stream
    const qwenSource = source as QwenAiOutputStream

    qwenSource.once(QWEN_AI_STREAM_FAILURE_EVENT, (error: Error) => fail(error, true))
    source.once('error', (error: Error) => {
      if (sourceFailurePending) {
        settleFailure(sourceFailure || error)
        return
      }
      settleFailure(error)
    })
    source.once('end', () => {
      // Stream handlers attach state at terminal completion. Prefer that
      // final value when it became available after the failover outcome was
      // resolved.
      if (qwenSource.qwenAiSessionState) {
        output.qwenAiSessionState = qwenSource.qwenAiSessionState
      }
      if (qwenSource.qwenAiFailure) {
        const failure = qwenSource.qwenAiFailure
        fail(failure, true)
      } else complete()
    })
    source.once('close', () => {
      const readable = source as NodeJS.ReadableStream & { readableEnded?: boolean }
      if (!settled && !readable.readableEnded) {
        const incomplete = Object.assign(new Error('Validated Qwen AI stream closed before completion'), {
          status: 502,
          code: 'qwen_ai_stream_incomplete',
          accountFault: false,
        })
        settleFailure(sourceFailurePending ? sourceFailure || incomplete : incomplete)
      }
    })
    // Always attach the source before inspecting its terminal state. A Qwen
    // handler can emit its failure event and queue `event: error`/[DONE] before
    // the failover promise resumes this callback. Piping first drains those
    // already-buffered bytes; returning early would end the deferred stream
    // with a bare EOF and make the Responses bridge report a missing
    // `response.completed` event.
    source.pipe(output, { end: false })

    const sourceFailure = qwenSource.qwenAiFailure
    if (sourceFailure) {
      fail(sourceFailure, true)
    }
  }).catch(error => {
    fail(error instanceof Error ? error : new Error(String(error)))
  })

  return output
}
