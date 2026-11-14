/**
 * Qwen AI authentication helpers
 *
 * The chat.qwen.ai web client keeps a short-lived access token (about 15
 * minutes) in `localStorage.qwen_access_token_state` and renews it through
 * `GET https://auth.qwen.ai/api/v2/auths/refresh` using the long-lived,
 * HttpOnly `refresh_token` cookie. These helpers are shared by the in-app login
 * extractor, the proxy adapter and the account renewal path so every component
 * agrees on how tokens and cookies are read.
 */

import { randomUUID } from 'crypto'

export const QWEN_AI_BASE = 'https://chat.qwen.ai'
export const QWEN_AI_AUTH_BASE = 'https://auth.qwen.ai'
export const QWEN_AI_REFRESH_URL = `${QWEN_AI_AUTH_BASE}/api/v2/auths/refresh`
export const QWEN_AI_WEB_VERSION = '0.3.42'

/** The web client refreshes three minutes before the access token expires. */
export const QWEN_AI_REFRESH_SKEW_MS = 3 * 60 * 1000

/**
 * Normalize a cookies credential to a Cookie header string. In-app login stores
 * cookies as a name -> value object; HAR/manual imports store a raw string.
 */
export function normalizeCookieHeader(value: unknown): string {
  if (!value) return ''
  if (typeof value === 'string') return value.trim()
  if (typeof value === 'object') {
    return Object.entries(value as Record<string, unknown>)
      .filter((entry): entry is [string, string] => typeof entry[1] === 'string' && entry[1].length > 0)
      .map(([name, cookieValue]) => `${name}=${cookieValue}`)
      .join('; ')
  }
  return String(value)
}

/** Read a single cookie value from a Cookie header string. */
export function extractCookieValue(cookieHeader: string | null | undefined, name: string): string {
  if (!cookieHeader) return ''
  for (const pair of cookieHeader.split(';')) {
    const trimmed = pair.trim()
    if (!trimmed) continue
    const index = trimmed.indexOf('=')
    if (index === -1) continue
    if (trimmed.slice(0, index) === name) {
      return trimmed.slice(index + 1)
    }
  }
  return ''
}

/** Replace (or append) one cookie in a Cookie header string. */
export function replaceCookieValue(
  cookieHeader: string | null | undefined,
  name: string,
  value: string
): string {
  if (!value) return normalizeCookieHeader(cookieHeader)
  const normalized = normalizeCookieHeader(cookieHeader)
  const pattern = new RegExp(`(^|;\\s*)${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}=[^;]*`)
  if (pattern.test(normalized)) {
    return normalized.replace(pattern, `$1${name}=${value}`)
  }
  return normalized ? `${normalized}; ${name}=${value}` : `${name}=${value}`
}

/**
 * Pull the long-lived `refresh_token` out of an account's credentials. It can
 * be an explicit field, a cookie object, or a Cookie header string.
 */
export function extractQwenAiRefreshToken(credentials: Record<string, unknown>): string {
  const explicit = credentials.refresh_token || credentials.refreshToken
  if (typeof explicit === 'string' && explicit.trim()) {
    return explicit.trim()
  }

  const rawCookies = credentials.cookies ?? credentials.cookie
  if (rawCookies && typeof rawCookies === 'object') {
    const token = (rawCookies as Record<string, unknown>).refresh_token
    if (typeof token === 'string' && token.trim()) {
      return token.trim()
    }
  }

  return extractCookieValue(normalizeCookieHeader(rawCookies), 'refresh_token')
}

/** Decode a JWT payload, accepting base64url as well as standard base64. */
export function decodeJwtPayload(token: string): Record<string, unknown> | null {
  if (!token) return null
  const parts = token.split('.')
  if (parts.length !== 3) return null
  try {
    const normalized = parts[1].replace(/-/g, '+').replace(/_/g, '/')
    const padded = normalized.padEnd(normalized.length + ((4 - (normalized.length % 4)) % 4), '=')
    const parsed = JSON.parse(Buffer.from(padded, 'base64').toString('utf8'))
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null
  } catch {
    return null
  }
}

/** Read the JWT `exp` claim in milliseconds, or null when unreadable. */
export function getJwtExpiryMs(token: string): number | null {
  const payload = decodeJwtPayload(token)
  const exp = payload?.exp
  if (typeof exp !== 'number' || !Number.isFinite(exp)) return null
  return exp * 1000
}

/** True when a JWT is expired (or unreadable). Non-JWT tokens are not expired. */
export function isJwtExpired(token: string, skewMs = 0): boolean {
  const expiry = getJwtExpiryMs(token)
  if (expiry === null) return false
  return expiry <= Date.now() + skewMs
}

/** True when the Qwen access token is missing or inside the refresh window. */
export function isQwenAiTokenExpiring(
  token: string,
  skewMs = QWEN_AI_REFRESH_SKEW_MS
): boolean {
  if (!token) return true
  const expiry = getJwtExpiryMs(token)
  if (expiry === null) return false
  return expiry - Date.now() <= skewMs
}

/** Extract a rotated `refresh_token` from Set-Cookie response headers. */
export function extractRefreshTokenFromSetCookie(headers: unknown): string {
  if (!headers || typeof headers !== 'object') return ''
  const raw = (headers as Record<string, unknown>)['set-cookie']
  const values = Array.isArray(raw) ? raw : typeof raw === 'string' ? [raw] : []
  for (const value of values) {
    if (typeof value !== 'string') continue
    const match = value.match(/(?:^|;\s*)refresh_token=([^;]+)/)
    if (match) {
      try {
        return decodeURIComponent(match[1])
      } catch {
        return match[1]
      }
    }
  }
  return ''
}

export function qwenAiRequestId(): string {
  return randomUUID()
}

/** The web client sends this trimmed local date string as the Timezone header. */
export function qwenAiTimezoneHeader(date = new Date()): string {
  return date.toString().replace(/\s*\([^)]*\)\s*$/, '')
}
