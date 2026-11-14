/**
 * Qwen AI native token refresh
 *
 * chat.qwen.ai exposes `GET https://auth.qwen.ai/api/v2/auths/refresh`, which
 * mints a new access token from the long-lived `refresh_token` cookie (this is
 * exactly what the web frontend calls when its token expires). Chat2API keeps
 * the Qwen login session on disk, so the token can be renewed without opening a
 * window or asking the user to log in again.
 */

import axios from 'axios'
import { getCachedQwenBaxiaSession } from '../proxy/adapters/qwen-baxia'
import { getProviderSessionCookies } from './sessionPartitions'
import {
  QWEN_AI_BASE,
  QWEN_AI_REFRESH_URL,
  QWEN_AI_WEB_VERSION,
  extractCookieValue,
  extractQwenAiRefreshToken,
  extractRefreshTokenFromSetCookie,
  getJwtExpiryMs,
  normalizeCookieHeader,
  qwenAiRequestId,
  qwenAiTimezoneHeader,
  replaceCookieValue,
} from './qwenAiAuth'

const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36'

function mergeCookieHeader(...parts: Array<string | undefined | null>): string {
  const seen = new Set<string>()
  const pairs: string[] = []
  for (const part of parts) {
    if (!part) continue
    for (const pair of part.split(';')) {
      const trimmed = pair.trim()
      if (!trimmed) continue
      const name = trimmed.split('=')[0]
      if (seen.has(name)) continue
      seen.add(name)
      pairs.push(trimmed)
    }
  }
  return pairs.join('; ')
}

type RefreshAttempt =
  | { token: string; refreshToken: string; expiresAt: number | null }
  | { token: null; noSession: boolean; reason: string }

export type QwenRefreshResult =
  | {
      status: 'success'
      token: string
      refreshToken: string
      cookies: string
      expiresAt: number | null
    }
  | { status: 'no-session'; reason?: string }
  | { status: 'failed'; reason?: string }

async function tryRefresh(cookieHeader: string): Promise<RefreshAttempt> {
  // Use a cached signature when one exists, but never harvest on the refresh
  // path: a blocked page would add ~45s to every request before the refresh
  // can even report that the session was revoked. auth.qwen.ai answers without
  // baxia headers.
  const baxia = getCachedQwenBaxiaSession()
  const response = await axios.get(QWEN_AI_REFRESH_URL, {
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
      source: 'web',
      Version: QWEN_AI_WEB_VERSION,
      'X-Request-Id': qwenAiRequestId(),
      Timezone: qwenAiTimezoneHeader(),
      'x-request-origin': QWEN_AI_BASE,
      Origin: QWEN_AI_BASE,
      Referer: `${QWEN_AI_BASE}/`,
      'User-Agent': USER_AGENT,
      ...(baxia
        ? { 'bx-ua': baxia.bxUa, 'bx-umidtoken': baxia.bxUmidToken, 'bx-v': baxia.bxV }
        : {}),
      Cookie: cookieHeader,
    },
    timeout: 20000,
    validateStatus: () => true,
  })

  const data =
    typeof response.data === 'string'
      ? (() => {
          try {
            return JSON.parse(response.data)
          } catch {
            return null
          }
        })()
      : response.data

  const token = data?.data?.access_token
  if (data?.success && typeof token === 'string' && token.length > 20) {
    const expiresAtRaw = Number(data?.data?.expires_at)
    const expiresAt = Number.isFinite(expiresAtRaw) && expiresAtRaw > 0
      ? expiresAtRaw * 1000
      : getJwtExpiryMs(token)
    const rotated = extractRefreshTokenFromSetCookie(response.headers)
    console.log('[QwenAI] Refreshed access token from the retained session')
    return {
      token,
      refreshToken: rotated || extractCookieValue(cookieHeader, 'refresh_token'),
      expiresAt,
    }
  }

  const reason =
    data?.data?.code ||
    data?.data?.details ||
    data?.data?.message ||
    data?.message ||
    `HTTP ${response.status}`
  console.log('[QwenAI] Token refresh did not return a token:', reason)

  // The endpoint explicitly rejected the session. A hidden login window cannot
  // mint a token from a rejected refresh cookie, so the user has to sign in
  // again. `not found` is what the old (wrong) chat.qwen.ai host answered; keep
  // treating it as no-session for older builds.
  const code = String(data?.data?.code || '').toLowerCase()
  const noSession =
    response.status === 401 ||
    response.status === 403 ||
    code === 'unauthorized' ||
    code === 'invalid token' ||
    code === 'forbidden' ||
    code === '401' ||
    code === 'not found'
  return { token: null, noSession, reason: String(reason) }
}

function uniqueNonEmpty(values: Array<string | undefined | null>): string[] {
  return Array.from(new Set(values.map((value) => (value || '').trim()).filter(Boolean)))
}

/**
 * Refresh a Qwen AI access token using the account's stored cookies and/or the
 * retained login-session cookies.
 *
 * `no-session` means the refresh endpoint explicitly rejected the refresh
 * token. `failed` means the refresh could not be completed (network, WAF,
 * server error), where letting Qwen's own frontend retry in the retained
 * session may still work.
 */
export async function refreshQwenAiToken(
  credentials: Record<string, unknown> = {}
): Promise<QwenRefreshResult> {
  const accountCookies = normalizeCookieHeader(credentials.cookies ?? credentials.cookie)
  const explicitRefreshToken = extractQwenAiRefreshToken(credentials)
  const { cookies: partitionCookies } = await getProviderSessionCookies('qwen-ai')

  const mergedCookies = mergeCookieHeader(partitionCookies, accountCookies)
  const refreshTokens = uniqueNonEmpty([
    explicitRefreshToken,
    extractCookieValue(partitionCookies, 'refresh_token'),
    extractCookieValue(accountCookies, 'refresh_token'),
    extractCookieValue(mergedCookies, 'refresh_token'),
  ])

  if (refreshTokens.length === 0) {
    console.log('[QwenAI] No refresh_token cookie is available for this account')
    return { status: 'no-session', reason: 'missing refresh_token' }
  }

  let sawTransientFailure = false
  let lastReason = ''

  for (const refreshToken of refreshTokens) {
    const cookieHeader = replaceCookieValue(mergedCookies, 'refresh_token', refreshToken)
    try {
      const result = await tryRefresh(cookieHeader)
      if (result.token) {
        return {
          status: 'success',
          token: result.token,
          refreshToken: result.refreshToken || refreshToken,
          cookies: replaceCookieValue(cookieHeader, 'refresh_token', result.refreshToken || refreshToken),
          expiresAt: result.expiresAt,
        }
      }
      lastReason = result.reason
      if (!result.noSession) {
        sawTransientFailure = true
      }
    } catch (error) {
      sawTransientFailure = true
      lastReason = error instanceof Error ? error.message : String(error)
      console.warn('[QwenAI] Native token refresh failed:', error)
    }
  }

  return sawTransientFailure
    ? { status: 'failed', reason: lastReason }
    : { status: 'no-session', reason: lastReason }
}
