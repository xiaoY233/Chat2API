import { PassThrough, Readable } from 'stream'

const DEFAULT_MAX_BUFFER_BYTES = 16 * 1024 * 1024

type BufferedSseOptions = {
  maxBytes?: number
  maxHoldMs?: number
  signal?: AbortSignal
  forwardEvents?: readonly string[]
  forwardProperties?: readonly string[]
}

type BufferedSseStatus = number

type SseErrorDetails = {
  message: string
  type?: string
  code?: string
  status?: BufferedSseStatus
  retryable?: boolean
  accountFault?: boolean
}

function inferBufferedSseStatus(details: SseErrorDetails): BufferedSseStatus {
  const message = details.message || ''
  if (
    details.status === 499
    || details.type === 'request_aborted'
    || details.code === 'ERR_CANCELED'
    || /client disconnected|aborted by the client/i.test(message)
  ) {
    return 499
  }

  if (details.code === 'qwen_ai_upstream_busy') return 503

  if (details.status === 403 || details.code === 'qwen_ai_risk_control' || /risk-control|captcha|challenge|FAIL_SYS_USER_VALIDATE|RGV587/i.test(message)) {
    return 403
  }

  if (details.status === 429 || /(?:^|\D)429(?:\D|$)|rate.?limit|too many requests|throttl/i.test(message)) {
    return 429
  }

  if (details.status === 504) return 504

  if (/timed out|timeout|idle for more than/i.test(message)) {
    return 504
  }

  if (
    typeof details.status === 'number'
    && Number.isInteger(details.status)
    && details.status >= 400
    && details.status <= 599
  ) {
    return details.status
  }

  return 502
}

export class BufferedSseError extends Error {
  readonly type?: string
  readonly code?: string
  readonly status: BufferedSseStatus
  readonly retryable?: boolean
  readonly accountFault?: boolean

  constructor(details: SseErrorDetails) {
    super(details.message)
    this.name = 'BufferedSseError'
    this.type = details.type
    this.code = details.code
    this.status = inferBufferedSseStatus(details)
    this.retryable = details.retryable
    this.accountFault = details.accountFault
  }
}

/**
 * Consume an SSE stream before exposing it to the client. A bounded hold keeps
 * fast validation failures retryable without turning a long streaming response
 * into a request with no first byte. After the hold expires, the buffered
 * prefix is released and the remaining source is forwarded live.
 */
export function bufferValidatedSseStream(
  stream: NodeJS.ReadableStream,
  options: BufferedSseOptions = {},
): Promise<NodeJS.ReadableStream> {
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BUFFER_BYTES

  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let totalBytes = 0
    let settled = false
    let ended = false
    let holdTimer: NodeJS.Timeout | undefined

    const cleanup = () => {
      stream.removeListener('data', onData)
      stream.removeListener('end', onEnd)
      stream.removeListener('error', onError)
      stream.removeListener('close', onClose)
      options.signal?.removeEventListener('abort', onAbort)
      if (holdTimer) {
        clearTimeout(holdTimer)
        holdTimer = undefined
      }
    }

    const fail = (error: Error) => {
      if (settled) return
      settled = true
      cleanup()
      const destroyable = stream as NodeJS.ReadableStream & { destroy?: () => void }
      destroyable.destroy?.()
      reject(error)
    }

    const onData = (chunk: Buffer | string) => {
      if (settled) return
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      totalBytes += buffer.length
      if (totalBytes > maxBytes) {
        if (options.maxHoldMs !== undefined) {
          chunks.push(buffer)
          releaseLiveStream()
          return
        }
        fail(new BufferedSseError({
          message: `Validated SSE response exceeded the ${maxBytes}-byte buffer limit`,
          type: 'stream_validation_error',
          code: 'validated_stream_too_large',
        }))
        return
      }
      chunks.push(buffer)
    }

    const releaseLiveStream = () => {
      if (settled) return
      settled = true

      const pausable = stream as NodeJS.ReadableStream & { pause?: () => void }
      pausable.pause?.()
      cleanup()

      const output = new PassThrough()
      const sourceRecord = stream as NodeJS.ReadableStream & Record<string, unknown>
      const outputRecord = output as PassThrough & Record<string, unknown>
      const forwardedEventListeners: Array<{ event: string; listener: (...args: unknown[]) => void }> = []

      for (const property of options.forwardProperties || []) {
        Object.defineProperty(outputRecord, property, {
          configurable: true,
          enumerable: false,
          get: () => sourceRecord[property],
        })
      }

      for (const event of options.forwardEvents || []) {
        const listener = (...args: unknown[]) => output.emit(event, ...args)
        forwardedEventListeners.push({ event, listener })
        stream.on(event, listener)
      }

      let sourceEnded = false
      let sourceTerminated = false
      const onLiveEnd = () => {
        sourceEnded = true
        sourceTerminated = true
      }
      const onLiveError = (error: Error) => {
        sourceTerminated = true
        output.destroy(error)
      }
      const onLiveClose = () => {
        sourceTerminated = true
        if (!sourceEnded && !output.destroyed) {
          output.destroy(new BufferedSseError({
            message: 'Validated SSE response closed after live release',
            type: 'stream_validation_error',
            code: 'validated_stream_closed',
          }))
        }
      }
      const onLiveAbort = () => {
        sourceTerminated = true
        const error = new BufferedSseError({
          message: 'Validated SSE response was aborted by the client',
          type: 'request_aborted',
          code: 'ERR_CANCELED',
        })
        const destroyable = stream as NodeJS.ReadableStream & { destroy?: (error?: Error) => void }
        destroyable.destroy?.(error)
        output.destroy(error)
      }
      const cleanupLiveForwarding = () => {
        stream.removeListener('end', onLiveEnd)
        stream.removeListener('error', onLiveError)
        stream.removeListener('close', onLiveClose)
        options.signal?.removeEventListener('abort', onLiveAbort)
        for (const { event, listener } of forwardedEventListeners) {
          stream.removeListener(event, listener)
        }
      }
      const onOutputClose = () => {
        if (!sourceTerminated) {
          const destroyable = stream as NodeJS.ReadableStream & { destroy?: () => void }
          destroyable.destroy?.()
        }
        cleanupLiveForwarding()
      }

      stream.once('end', onLiveEnd)
      stream.once('error', onLiveError)
      stream.once('close', onLiveClose)
      options.signal?.addEventListener('abort', onLiveAbort, { once: true })
      output.once('close', onOutputClose)

      const payload = Buffer.concat(chunks, totalBytes)
      output.write(payload.length > 0 ? payload : Buffer.from(': keep-alive\n\n'))
      stream.pipe(output)
      resolve(output)
    }

    const onEnd = () => {
      if (settled) return
      ended = true
      const payload = Buffer.concat(chunks, totalBytes)
      const sseError = findSseError(payload.toString('utf8'))
      if (sseError) {
        fail(new BufferedSseError(sseError))
        return
      }
      const completionError = findSseCompletionError(payload.toString('utf8'))
      if (completionError) {
        fail(new BufferedSseError(completionError))
        return
      }

      settled = true
      cleanup()
      resolve(Readable.from([payload]))
    }

    const onError = (error: Error) => {
      fail(error)
    }

    const onClose = () => {
      if (!settled && !ended) {
        fail(new BufferedSseError({
          message: 'Validated SSE response closed before completion',
          type: 'stream_validation_error',
          code: 'validated_stream_closed',
        }))
      }
    }

    const onAbort = () => {
      const error = new BufferedSseError({
        message: 'Validated SSE response was aborted by the client',
        type: 'request_aborted',
        code: 'ERR_CANCELED',
      })
      fail(error)
    }

    if (options.signal?.aborted) {
      onAbort()
      return
    }

    stream.on('data', onData)
    stream.once('end', onEnd)
    stream.once('error', onError)
    stream.once('close', onClose)
    options.signal?.addEventListener('abort', onAbort, { once: true })

    if (options.maxHoldMs !== undefined) {
      holdTimer = setTimeout(releaseLiveStream, Math.max(0, options.maxHoldMs))
    }
  })
}

function findSseError(payload: string): SseErrorDetails | undefined {
  const blocks = payload.split(/\r?\n\r?\n/)

  for (const block of blocks) {
    let eventName = ''
    const dataLines: string[] = []

    for (const line of block.split(/\r?\n/)) {
      if (line.startsWith('event:')) {
        eventName = line.slice('event:'.length).trim()
      } else if (line.startsWith('data:')) {
        dataLines.push(line.slice('data:'.length).trimStart())
      }
    }

    if (eventName !== 'error') continue

    const rawData = dataLines.join('\n')
    try {
      const parsed = JSON.parse(rawData)
      const error = parsed?.error
      return {
        message: typeof error?.message === 'string' ? error.message : 'Upstream SSE stream returned an error event',
        type: typeof error?.type === 'string' ? error.type : undefined,
        code: typeof error?.code === 'string' ? error.code : undefined,
        status: toBufferedSseStatus(error?.status),
        retryable: typeof error?.retryable === 'boolean' ? error.retryable : undefined,
        accountFault: typeof error?.accountFault === 'boolean' ? error.accountFault : undefined,
      }
    } catch {
      return {
        message: rawData || 'Upstream SSE stream returned an error event',
        type: 'upstream_stream_error',
      }
    }
  }

  return undefined
}

function toBufferedSseStatus(value: unknown): BufferedSseStatus | undefined {
  return typeof value === 'number'
    && Number.isInteger(value)
    && value >= 400
    && value <= 599
    ? value
    : undefined
}

function findSseCompletionError(payload: string): SseErrorDetails | undefined {
  const blocks = payload.split(/\r?\n\r?\n/)
  let sawDone = false
  let sawFinishReason = false

  for (const block of blocks) {
    const dataLines = block
      .split(/\r?\n/)
      .filter(line => line.startsWith('data:'))
      .map(line => line.slice('data:'.length).trimStart())
    if (dataLines.length === 0) continue

    const rawData = dataLines.join('\n')
    if (rawData.trim() === '[DONE]') {
      sawDone = true
      continue
    }

    try {
      const parsed = JSON.parse(rawData)
      if (
        Array.isArray(parsed?.choices)
        && parsed.choices.some((choice: unknown) => (
          choice !== null
          && typeof choice === 'object'
          && (choice as { finish_reason?: unknown }).finish_reason != null
        ))
      ) {
        sawFinishReason = true
      }
    } catch {
      // Invalid JSON is handled by the producer's error event. It cannot count
      // as a valid completion marker here.
    }
  }

  if (!sawFinishReason) {
    return {
      message: 'Validated SSE response ended without a finish reason',
      type: 'stream_validation_error',
      code: 'validated_stream_missing_finish',
    }
  }
  if (!sawDone) {
    return {
      message: 'Validated SSE response ended without a [DONE] marker',
      type: 'stream_validation_error',
      code: 'validated_stream_missing_done',
    }
  }

  return undefined
}
