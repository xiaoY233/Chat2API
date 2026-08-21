/**
 * Error Types and Error Handler
 * Unified error handling system for the application
 */

export enum ErrorCode {
  PROVIDER_UNAVAILABLE = 'PROVIDER_UNAVAILABLE',
  AUTH_FAILED = 'AUTH_FAILED',
  RATE_LIMIT = 'RATE_LIMIT',
  NETWORK_ERROR = 'NETWORK_ERROR',
  INVALID_REQUEST = 'INVALID_REQUEST',
  PROVIDER_ERROR = 'PROVIDER_ERROR',
  TIMEOUT = 'TIMEOUT',
  UNKNOWN = 'UNKNOWN',
}

export class AppError extends Error {
  constructor(
    public code: ErrorCode,
    message: string,
    public details?: any
  ) {
    super(message)
    this.name = 'AppError'
  }

  toJSON() {
    return {
      name: this.name,
      code: this.code,
      message: this.message,
      details: this.details,
    }
  }
}

export class ProviderUnavailableError extends AppError {
  constructor(providerId: string, details?: any) {
    super(ErrorCode.PROVIDER_UNAVAILABLE, `Provider ${providerId} is unavailable`, details)
  }
}

export class AuthFailedError extends AppError {
  constructor(providerId: string, details?: any) {
    super(ErrorCode.AUTH_FAILED, `Authentication failed for provider ${providerId}`, details)
  }
}

export class RateLimitError extends AppError {
  constructor(providerId: string, retryAfter?: number, details?: any) {
    super(ErrorCode.RATE_LIMIT, `Rate limit exceeded for provider ${providerId}`, { retryAfter, ...details })
  }
}

export class NetworkError extends AppError {
  constructor(message: string, details?: any) {
    super(ErrorCode.NETWORK_ERROR, message, details)
  }
}

export class InvalidRequestError extends AppError {
  constructor(message: string, details?: any) {
    super(ErrorCode.INVALID_REQUEST, message, details)
  }
}

export class ProviderError extends AppError {
  constructor(providerId: string, message: string, details?: any) {
    super(ErrorCode.PROVIDER_ERROR, `Provider ${providerId} error: ${message}`, details)
  }
}

export class TimeoutError extends AppError {
  constructor(operation: string, timeout: number, details?: any) {
    super(ErrorCode.TIMEOUT, `Operation ${operation} timed out after ${timeout}ms`, details)
  }
}

export function isAppError(error: unknown): error is AppError {
  return error instanceof AppError
}

export function getErrorMessage(error: unknown): string {
  if (isAppError(error)) {
    return error.message
  }
  if (error instanceof Error) {
    return error.message
  }
  return 'Unknown error'
}

export function getErrorCode(error: unknown): ErrorCode {
  if (isAppError(error)) {
    return error.code
  }
  return ErrorCode.UNKNOWN
}

/**
 * Client cancellation is an expected end state for a request stream. Keep
 * this classification independent of any provider so routes and adapters do
 * not turn a disconnected client into a server-error log entry.
 */
export function isClientCancellationError(error: unknown): boolean {
  if (!error) return false

  const candidate = error as {
    status?: unknown
    statusCode?: unknown
    name?: unknown
    code?: unknown
    message?: unknown
  }

  if (typeof candidate.status === 'number') return candidate.status === 499
  if (typeof candidate.statusCode === 'number') return candidate.statusCode === 499

  const name = typeof candidate.name === 'string' ? candidate.name : ''
  const code = typeof candidate.code === 'string' ? candidate.code : ''
  const message = typeof candidate.message === 'string'
    ? candidate.message
    : String(error)

  if (name === 'AbortError' || name === 'CanceledError') return true
  if (code === 'ABORT_ERR' || code === 'ERR_CANCELED') return true

  return /client disconnected|downstream stream closed|request aborted by (?:the )?client/i.test(message)
}

/**
 * Only propagate headers that describe retry pacing on a synthesized API
 * error. Upstream response headers can contain cookies, challenge tokens, or
 * encoding/connection metadata that no longer matches the JSON body we emit.
 */
export function sanitizeForwardedErrorHeaders(headers: unknown): Record<string, string> | undefined {
  if (!headers || typeof headers !== 'object') return undefined

  // Deliberately exclude set-cookie, content-encoding, transfer-encoding,
  // connection, and challenge/authentication headers. The synthesized JSON
  // error is not the upstream response and must not inherit those semantics.
  const disallowedResponseHeaders = new Set([
    'set-cookie',
    'content-encoding',
    'transfer-encoding',
    'connection',
    'www-authenticate',
  ])

  const candidate = headers as {
    toJSON?: () => unknown
  }
  const serializable = typeof candidate.toJSON === 'function'
    ? candidate.toJSON()
    : headers
  if (!serializable || typeof serializable !== 'object' || Array.isArray(serializable)) return undefined

  const result: Record<string, string> = {}
  for (const [rawName, rawValue] of Object.entries(serializable as Record<string, unknown>)) {
    const name = rawName.toLowerCase()
    if (disallowedResponseHeaders.has(name)) continue
    if (!/^(?:retry-after|x-ratelimit-(?:limit|remaining|reset)|ratelimit-(?:limit|remaining|reset))$/i.test(name)) {
      continue
    }

    const value = Array.isArray(rawValue)
      ? rawValue.filter(item => typeof item === 'string').join(', ')
      : typeof rawValue === 'string' || typeof rawValue === 'number'
        ? String(rawValue)
        : ''
    const safeValue = value.replace(/[\r\n]/g, '').trim().slice(0, 200)
    if (!safeValue) continue

    const outputName = name === 'retry-after'
      ? 'Retry-After'
      : rawName
    result[outputName] = safeValue
  }

  return Object.keys(result).length > 0 ? result : undefined
}

export function createErrorFromAxiosError(error: any, providerId?: string): AppError {
  if (error.response) {
    const status = error.response.status
    const data = error.response.data

    if (status === 401 || status === 403) {
      return new AuthFailedError(providerId || 'unknown', data)
    }

    if (status === 429) {
      const retryAfter = error.response.headers['retry-after']
      return new RateLimitError(providerId || 'unknown', retryAfter ? parseInt(retryAfter) : undefined, data)
    }

    if (status >= 500) {
      return new ProviderError(providerId || 'unknown', `Server error: ${status}`, data)
    }

    if (status >= 400) {
      return new InvalidRequestError(`Invalid request: ${status}`, data)
    }
  }

  if (error.code === 'ECONNABORTED' || error.message?.includes('timeout')) {
    return new TimeoutError('request', error.config?.timeout || 0, error)
  }

  if (error.code === 'ENOTFOUND' || error.code === 'ECONNREFUSED') {
    return new NetworkError(`Network error: ${error.message}`, error)
  }

  return new AppError(ErrorCode.UNKNOWN, error.message || 'Unknown error', error)
}
