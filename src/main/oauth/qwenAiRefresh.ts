/**
 * Qwen AI native token refresh
 *
 * chat.qwen.ai exposes `GET /api/v2/auths/refresh`, which mints a new access
 * token from the browser session cookies (this is what the web frontend calls
 * when its token expires). Chat2API keeps the Qwen login session on disk, so the
 * token can be renewed without opening a window or asking the user to log in
 * again.
 */

import axios from 'axios'
import { getQwenBaxiaSession } from '../proxy/adapters/qwen-baxia'
import { getProviderSessionCookies } from './sessionPartitions'

const QWEN_AI_BASE = 'https://chat.qwen.ai'
const REFRESH_URL = `${QWEN_AI_BASE}/api/v2/auths/refresh`

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

type RefreshAttempt = { token: string } | { token: null; noSession: boolean }

export type QwenRefreshResult =
  | { status: 'success'; token: string; cookies: string }
  | { status: 'no-session' }
  | { status: 'failed' }

async function tryRefresh(cookieHeader: string): Promise<RefreshAttempt> {
  const baxia = await getQwenBaxiaSession()
  const response = await axios.get(REFRESH_URL, {
    headers: {
      Accept: 'application/json',
      'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
      source: 'web',
      Version: '0.3.41',
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
    console.log('[QwenAI] Refreshed access token from the retained session')
    return { token }
  }

  const reason = data?.data?.code || data?.data?.message || data?.data?.details
  console.log('[QwenAI] Token refresh did not return a token:', reason || `HTTP ${response.status}`)

  // The endpoint answered that there is no authenticated session. Opening a
  // login window cannot help in that case; the user has to sign in again.
  const noSession =
    response.status === 401 ||
    data?.data?.code === 'not found' ||
    data?.data?.code === 'unauthorized'
  return { token: null, noSession }
}

/**
 * Refresh a Qwen AI access token using the account's stored cookies or the
 * retained login-session cookies.
 *
 * `no-session` means the refresh endpoint explicitly rejected the session, so
 * a hidden login window would only land on the login page. `failed` means the
 * refresh could not be completed (network, WAF, server error), where letting
 * Qwen's own frontend retry in the retained session may still work.
 */
export async function refreshQwenAiToken(
  accountCookies?: string
): Promise<QwenRefreshResult> {
  const { cookies: partitionCookies } = await getProviderSessionCookies('qwen-ai')
  const candidates = Array.from(
    new Set(
      [accountCookies, partitionCookies]
        .filter((value): value is string => !!value)
        .map((value) => value.trim())
    )
  )

  if (candidates.length === 0) {
    return { status: 'no-session' }
  }

  let sawTransientFailure = false
  for (const cookies of candidates) {
    const merged = mergeCookieHeader(partitionCookies, cookies)
    try {
      const result = await tryRefresh(merged)
      if (result.token) {
        return { status: 'success', token: result.token, cookies: merged }
      }
      if (!result.noSession) {
        sawTransientFailure = true
      }
    } catch (error) {
      sawTransientFailure = true
      console.warn('[QwenAI] Native token refresh failed:', error)
    }
  }

  return sawTransientFailure ? { status: 'failed' } : { status: 'no-session' }
}