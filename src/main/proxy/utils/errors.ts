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
