import { PassThrough } from 'stream'

export const DEFAULT_SSE_KEEPALIVE_INTERVAL_MS = 15_000
// A comment keeps the HTTP/SSE transport active without inventing a model
// chunk, token, reasoning frame, or completion state.
const KEEPALIVE_FRAME = Buffer.from(': keep-alive\n\n')

/**
 * Resolve the stream keep-alive interval without tying it to a provider or
 * client. A value of zero explicitly disables the timer.
 */
export function sseKeepAliveIntervalMsFromEnv(): number {
  const raw = process.env.CHAT2API_SSE_KEEPALIVE_INTERVAL_MS
  if (raw === undefined || raw.trim() === '') return DEFAULT_SSE_KEEPALIVE_INTERVAL_MS

  const value = Number(raw)
  return Number.isFinite(value) && value >= 0 ? value : DEFAULT_SSE_KEEPALIVE_INTERVAL_MS
}

export type SseKeepAliveStreamOptions = {
  intervalMs?: number
}

/**
 * Add legal SSE comment frames while an output stream is quiet. Comments are
 * ignored by SSE consumers, so they cannot become model content, finish
 * markers, or synthetic errors. Real writes reset the quiet-period timer.
 */
export class SseKeepAliveStream extends PassThrough {
  private readonly intervalMs: number
  private lastActivityAt = Date.now()
  private timer?: NodeJS.Timeout

  constructor(options: SseKeepAliveStreamOptions = {}) {
    super()
    this.intervalMs = options.intervalMs ?? sseKeepAliveIntervalMsFromEnv()

    if (this.intervalMs > 0) {
      // Put a protocol-neutral frame in the readable buffer immediately so
      // Koa and protocol bridges can commit response headers without waiting
      // for the first quiet-period timer. This is transport activity only and
      // must never be interpreted as upstream model progress.
      this.push(KEEPALIVE_FRAME)
      this.timer = setInterval(() => this.writeKeepAliveIfIdle(), this.intervalMs)
      this.timer.unref?.()
    }

    this.once('close', () => this.stopKeepAlive())
    this.once('finish', () => this.stopKeepAlive())
  }

  override _transform(
    chunk: Buffer | string,
    encoding: BufferEncoding,
    callback: (error?: Error | null, data?: Buffer | string) => void,
  ): void {
    this.lastActivityAt = Date.now()
    callback(null, chunk)
  }

  override _flush(callback: (error?: Error | null) => void): void {
    this.stopKeepAlive()
    callback()
  }

  override _destroy(error: Error | null, callback: (error?: Error | null) => void): void {
    this.stopKeepAlive()
    callback(error)
  }

  private writeKeepAliveIfIdle(): void {
    if (this.destroyed || this.readableEnded || this.writableEnded) {
      this.stopKeepAlive()
      return
    }

    if (Date.now() - this.lastActivityAt < this.intervalMs) return
    this.push(KEEPALIVE_FRAME)
  }

  private stopKeepAlive(): void {
    if (!this.timer) return
    clearInterval(this.timer)
    this.timer = undefined
  }
}
