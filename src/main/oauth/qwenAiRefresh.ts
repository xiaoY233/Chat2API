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

async function tryRefresh(cookieHeader: string): Promise<string | null> {
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
    return token
  }
  return null
}

/**
 * Refresh a Qwen AI access token using the account's stored cookies or the
 * retained login-session cookies. Returns null when no session is available.
 */
export async function refreshQwenAiToken(
  accountCookies?: string
): Promise<{ token: string; cookies: string } | null> {
  const { cookies: partitionCookies } = await getProviderSessionCookies('qwen-ai')
  const candidates = Array.from(
    new Set(
      [accountCookies, partitionCookies]
        .filter((value): value is string => !!value)
        .map((value) => value.trim())
    )
  )

  for (const cookies of candidates) {
    const merged = mergeCookieHeader(partitionCookies, cookies)
    try {
      const token = await tryRefresh(merged)
      if (token) {
        return { token, cookies: merged }
      }
    } catch (error) {
      console.warn('[QwenAI] Native token refresh failed:', error)
    }
  }

  return null
}