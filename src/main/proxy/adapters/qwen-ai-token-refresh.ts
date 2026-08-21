import axios, { type AxiosResponse } from 'axios'
import { createHash } from 'crypto'
import type { Account } from '../../store/types'
import { storeManager } from '../../store/store'

const QWEN_AI_BASE = 'https://chat.qwen.ai'
const REFRESH_THRESHOLD_MS = 6 * 60 * 60 * 1000

type SetCookieHeader = string | string[] | undefined

type QwenAiRefreshError = Error & {
  status?: number
  code?: string
  retryable?: boolean
  accountFault?: boolean
  retryScope?: 'next-account'
  /** Persisted account state for an explicit, permanent credential result. */
  accountStatus?: 'inactive'
}

type QwenAiSignInResponse = AxiosResponse<any>

function isObjectValue(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

function decodeJwtPayload(token: string): Record<string, any> | null {
  try {
    const parts = token.split('.')
    if (parts.length !== 3) {
      return null
    }

    const base64 = parts[1].replace(/-/g, '+').replace(/_/g, '/')
    const padded = base64.padEnd(base64.length + (4 - base64.length % 4) % 4, '=')
    return JSON.parse(Buffer.from(padded, 'base64').toString('utf8'))
  } catch {
    return null
  }
}

function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

function currentTimezoneHeader(): string {
  return new Date().toString().replace(/\s*\(.+\)$/, '')
}

function normalizeSetCookieHeaders(value: SetCookieHeader): string[] {
  if (Array.isArray(value)) {
    return value.filter(header => typeof header === 'string' && header.trim())
  }

  return typeof value === 'string' && value.trim() ? [value] : []
}

function parseCookiePair(value: string): [string, string] | null {
  const pair = value.split(';', 1)[0]?.trim()
  if (!pair) {
    return null
  }

  const separator = pair.indexOf('=')
  if (separator <= 0) {
    return null
  }

  const name = pair.slice(0, separator).trim()
  const cookieValue = pair.slice(separator + 1)
  if (!/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/.test(name)) {
    return null
  }

  return [name, cookieValue]
}

export function mergeCookieHeaders(existingCookieHeader: string, setCookieHeader: SetCookieHeader): string {
  const cookies = new Map<string, string>()

  for (const existingCookie of String(existingCookieHeader || '').split(';')) {
    const parsed = parseCookiePair(existingCookie)
    if (parsed) {
      cookies.set(parsed[0], parsed[1])
    }
  }

  for (const header of normalizeSetCookieHeaders(setCookieHeader)) {
    const parsed = parseCookiePair(header)
    if (parsed) {
      cookies.set(parsed[0], parsed[1])
    }
  }

  return Array.from(cookies.entries())
    .map(([name, value]) => `${name}=${value}`)
    .join('; ')
}

function hasCookie(cookieHeader: string, name: string): boolean {
  return new RegExp(`(?:^|;\\s*)${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}=[^;]+`).test(cookieHeader)
}

export function hasQwenAiSessionCookie(cookieHeader: string): boolean {
  return hasCookie(String(cookieHeader || ''), 'token')
}

export function resolveQwenAiAuthHeaders(token: string, cookieHeader: string): Record<string, string> {
  const normalizedToken = String(token || '').trim()
  const cookies = String(cookieHeader || '').trim()
  const hasSessionCookie = hasQwenAiSessionCookie(cookies)

  return {
    ...(normalizedToken && !hasSessionCookie
      ? { Authorization: `Bearer ${normalizedToken}` }
      : {}),
    ...(normalizedToken && !hasSessionCookie && !cookies ? { source: 'desktop' } : {}),
    ...(cookies ? { Cookie: cookies } : {}),
  }
}

function extractSignInToken(body: unknown): string {
  if (!isObjectValue(body)) return ''
  const nestedData = isObjectValue(body.data) ? body.data : undefined
  for (const candidate of [nestedData?.token, body.token]) {
    if (typeof candidate === 'string' && candidate.trim()) return candidate.trim()
  }
  return ''
}

function sanitizeRefreshDetail(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const compact = value.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim()
  if (!compact) return undefined

  return compact
    .replace(/(Bearer\s+)[^\s]+/gi, '$1[REDACTED]')
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, '[REDACTED_JWT]')
    .replace(/((?:token|cookie|password|authorization)\s*[=:]\s*)[^\s,;]+/gi, '$1[REDACTED]')
    .slice(0, 300)
}

function detailFromValue(value: unknown): string | undefined {
  const direct = sanitizeRefreshDetail(value)
  if (direct) return direct
  if (!isObjectValue(value)) return undefined

  for (const key of ['message', 'detail', 'details', 'reason', 'code']) {
    const nested = sanitizeRefreshDetail(value[key])
    if (nested) return nested
  }
  return undefined
}

export function extractQwenAiRefreshDetail(body: unknown): string | undefined {
  if (!isObjectValue(body)) return sanitizeRefreshDetail(body)
  const nestedData = isObjectValue(body.data) ? body.data : undefined
  const candidates = [
    nestedData?.details,
    nestedData?.detail,
    nestedData?.message,
    body.details,
    body.detail,
    body.message,
  ]

  for (const candidate of candidates) {
    const detail = detailFromValue(candidate)
    if (detail) return detail
  }
  return undefined
}

function isRiskControlled(body: unknown): boolean {
  try {
    return /FAIL_SYS_USER_VALIDATE|RGV587|risk-control|challenge|captcha|x5sec|baxia|punish/i.test(
      JSON.stringify(body || {}),
    )
  } catch {
    return false
  }
}

/**
 * Qwen's sign-in endpoint has used several response shapes for an account
 * that has never been registered. Keep this classifier deliberately narrow:
 * ordinary invalid passwords and transient HTTP 401s must retain normal
 * account-failover semantics without permanently disabling the account.
 */
function isUnregisteredAccountResponse(body: unknown, detail?: string): boolean {
  let serialized = ''
  try {
    serialized = JSON.stringify(body || {})
  } catch {
    serialized = ''
  }

  return /(?:not[\s_-]*registered|unregistered|(?:account|user|email)[\s_-]*(?:does[\s_-]*not|is[\s_-]*not|not)[\s_-]*(?:exist|found|registered)|user[\s_-]*not[\s_-]*found|account[\s_-]*not[\s_-]*found|USER_NOT_REGISTERED|ACCOUNT_NOT_REGISTERED|USER_NOT_FOUND|ACCOUNT_NOT_FOUND|(?:\u5e10\u6237|\u8d26\u6237|\u8d26\u53f7|\u7528\u6237)(?:\u672a\u6ce8\u518c|\u4e0d\u5b58\u5728))/i
    .test(`${detail || ''} ${serialized}`)
}

function persistUnregisteredAccount(account: Account, error: QwenAiRefreshError): void {
  if (error.accountStatus !== 'inactive') return

  try {
    storeManager.updateAccount(account.id, {
      status: 'inactive',
      errorMessage: error.message,
    })
  } catch (persistError) {
    // Keep the auth failure visible even while persistence is unavailable.
    console.warn('[QwenAI] Failed to persist unregistered account state:', persistError)
  }
}

function createRefreshError(options: {
  message: string
  status: number
  retryable: boolean
  accountFault: boolean
  retryScope?: 'next-account'
  accountStatus?: 'inactive'
}): QwenAiRefreshError {
  const error = new Error(options.message) as QwenAiRefreshError
  error.status = options.status
  error.code = 'qwen_ai_token_refresh_failed'
  error.retryable = options.retryable
  error.accountFault = options.accountFault
  if (options.retryScope) error.retryScope = options.retryScope
  if (options.accountStatus) error.accountStatus = options.accountStatus
  return error
}

function createRefreshResponseError(response: QwenAiSignInResponse): QwenAiRefreshError {
  const upstreamStatus = response.status
  const detail = extractQwenAiRefreshDetail(response.data)
  const detailSuffix = detail ? `: ${detail}` : ''
  const riskControlled = isRiskControlled(response.data)
  const unregistered = isUnregisteredAccountResponse(response.data, detail)

  if (riskControlled) {
    return createRefreshError({
      message: `Qwen AI token refresh failed (risk-control)${detailSuffix}`,
      status: 403,
      retryable: false,
      accountFault: false,
    })
  }

  if (unregistered) {
    return createRefreshError({
      message: `Qwen AI account is not registered${detailSuffix}`,
      status: 401,
      retryable: false,
      accountFault: true,
      retryScope: 'next-account',
      accountStatus: 'inactive',
    })
  }

  if (upstreamStatus >= 200 && upstreamStatus < 300) {
    return createRefreshError({
      message: `Qwen AI credentials were rejected during token refresh${detailSuffix}`,
      status: 401,
      retryable: false,
      accountFault: true,
      retryScope: 'next-account',
    })
  }

  if (upstreamStatus === 429) {
    return createRefreshError({
      message: `Qwen AI token refresh was rate limited${detailSuffix}`,
      status: 429,
      retryable: false,
      // Refresh throttling is a provider response, not proof that this
      // credential is invalid. Keep the account eligible after the normal
      // request pacing window instead of exhausting the whole pool.
      accountFault: false,
    })
  }

  if (upstreamStatus >= 500) {
    return createRefreshError({
      message: `Qwen AI token refresh service failed (HTTP ${upstreamStatus})${detailSuffix}`,
      status: upstreamStatus === 504 ? 504 : 502,
      retryable: true,
      // A failed refresh can be retried against the same credentials once
      // the upstream service recovers; do not mark the account as faulty.
      accountFault: false,
    })
  }

  if (upstreamStatus >= 400 && upstreamStatus < 500 && upstreamStatus !== 404 && upstreamStatus !== 405) {
    return createRefreshError({
      message: `Qwen AI credentials were rejected during token refresh${detailSuffix}`,
      status: 401,
      retryable: false,
      accountFault: true,
      retryScope: 'next-account',
    })
  }

  return createRefreshError({
    message: `Qwen AI token refresh returned an invalid response (HTTP ${upstreamStatus})${detailSuffix}`,
    status: 502,
    retryable: true,
    accountFault: false,
  })
}

function createRefreshTransportError(error: unknown, signal?: AbortSignal): QwenAiRefreshError {
  const record = isObjectValue(error) ? error : undefined
  const code = typeof record?.code === 'string' ? record.code : ''
  const message = error instanceof Error ? error.message : ''
  const cancelled = signal?.aborted || code === 'ERR_CANCELED' || /\bcancel(?:led|ed)?\b/i.test(message)
  if (cancelled) {
    return createRefreshError({
      message: 'Qwen AI token refresh was cancelled',
      status: 499,
      retryable: false,
      accountFault: false,
    })
  }

  const timedOut = code === 'ECONNABORTED' || /timed?\s*out|timeout/i.test(message)
  return createRefreshError({
    message: timedOut
      ? 'Qwen AI token refresh timed out'
      : 'Qwen AI token refresh request failed',
    status: timedOut ? 504 : 502,
    retryable: true,
    accountFault: false,
  })
}

export class QwenAiTokenRefresher {
  isTokenExpiringSoon(token: string, now: number = Date.now()): boolean {
    const payload = decodeJwtPayload(token)
    if (!payload?.exp || typeof payload.exp !== 'number') {
      return true
    }

    return payload.exp * 1000 - now <= REFRESH_THRESHOLD_MS
  }

  async refreshIfNeeded(account: Account, signal?: AbortSignal): Promise<Account> {
    const cookies = String(account.credentials.cookies || account.credentials.cookie || '').trim()
    const incompleteWebSession = Boolean(cookies) && !hasQwenAiSessionCookie(cookies)
    if (
      !this.canRefresh(account) ||
      (!incompleteWebSession && !this.isTokenExpiringSoon(account.credentials.token || ''))
    ) {
      return account
    }

    return this.refresh(account, signal)
  }

  async repairWebSession(account: Account, signal?: AbortSignal): Promise<Account> {
    const cookies = String(account.credentials.cookies || account.credentials.cookie || '').trim()
    if (hasQwenAiSessionCookie(cookies) || !this.canRefresh(account)) {
      return account
    }

    return this.refresh(account, signal)
  }

  async refreshAfterUnauthorized(account: Account, signal?: AbortSignal): Promise<Account> {
    if (!this.canRefresh(account)) {
      return account
    }

    return this.refresh(account, signal)
  }

  private canRefresh(account: Account): boolean {
    return Boolean(account.credentials.email && account.credentials.password)
  }

  private async refresh(account: Account, signal?: AbortSignal): Promise<Account> {
    const payload = {
      email: account.credentials.email,
      password: sha256Hex(account.credentials.password),
    }
    const requestOptions = {
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
        Origin: QWEN_AI_BASE,
        Referer: `${QWEN_AI_BASE}/`,
        source: 'web',
        Version: '0.2.67',
        Timezone: currentTimezoneHeader(),
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36',
      },
      timeout: 15000,
      signal,
      validateStatus: () => true,
    }

    let response: QwenAiSignInResponse
    try {
      response = await axios.post(`${QWEN_AI_BASE}/api/v2/auths/signin`, payload, requestOptions)
      if (response.status === 404 || response.status === 405) {
        response = await axios.post(`${QWEN_AI_BASE}/api/v1/auths/signin`, payload, requestOptions)
      }
    } catch (error) {
      throw createRefreshTransportError(error, signal)
    }

    const token = extractSignInToken(response.data)
    if (response.status !== 200 || !token || typeof token !== 'string') {
      const refreshError = createRefreshResponseError(response)
      // Keep an explicitly unregistered account out of both the request
      // load-balancer and the background session-repair queue until its
      // login is fixed. Other 401/403/429 cases preserve their normal
      // account-failover semantics.
      persistUnregisteredAccount(account, refreshError)
      throw refreshError
    }

    const cookies = mergeCookieHeaders(
      account.credentials.cookies || account.credentials.cookie || '',
      response.headers['set-cookie'],
    )
    const credentials = {
      ...account.credentials,
      token,
      ...(cookies ? { cookies } : {}),
    }

    const updated = storeManager.updateAccount(account.id, {
      email: account.credentials.email,
      credentials,
      status: 'active',
      errorMessage: undefined,
    })

    return updated ? {
      ...updated,
      credentials,
    } : {
      ...account,
      email: account.credentials.email,
      credentials,
      status: 'active',
      errorMessage: undefined,
      updatedAt: Date.now(),
    }
  }
}

export const qwenAiTokenRefresher = new QwenAiTokenRefresher()
