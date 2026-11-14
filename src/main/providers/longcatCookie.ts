/**
 * LongCat cookie helpers
 *
 * The LongCat web app authenticates with the `passport_token_key` cookie
 * (plus optional `_lxsdk_*` cookies). Users may paste a bare token, a single
 * `name=value` pair, or a complete Cookie header. OAuth login captures the
 * whole cookie jar, so credentials can also carry a `cookie` header.
 */

export function normalizeLongCatCookie(value: string): string {
  const trimmed = (value || '').trim()
  if (!trimmed) {
    return ''
  }
  // A complete Cookie header already contains every pair.
  if (trimmed.includes(';')) {
    return trimmed
  }
  if (/passport_token_key\s*=/i.test(trimmed)) {
    return trimmed
  }
  // A single `name=value` pair (e.g. a `_lxsdk_cuid` cookie). Bare base64
  // tokens may end in `=` padding, so do not treat those as cookie pairs.
  if (/^[A-Za-z0-9_.-]+=[^;]*$/.test(trimmed) && !/=+$/.test(trimmed)) {
    return trimmed
  }
  // Bare token value.
  return `passport_token_key=${trimmed}`
}

/**
 * Build the Cookie header sent to longcat.ai from stored credentials.
 * Prefers the captured full cookie jar, but lets an edited
 * `passport_token_key` override the value inside the jar.
 */
export function buildLongCatCookieHeader(credentials: Record<string, string> = {}): string {
  const rawCookie = (credentials.cookie || credentials.sessionToken || '').trim()
  const rawPassport = (credentials.passport_token_key || credentials.token || '').trim()

  // The passport field may itself hold a complete Cookie header (manual paste).
  if (rawPassport.includes(';')) {
    return normalizeLongCatCookie(rawPassport)
  }

  const passport = rawPassport
    ? (cookieValueFromHeader(rawPassport, 'passport_token_key') || rawPassport)
    : ''

  if (!rawCookie) {
    return normalizeLongCatCookie(passport)
  }

  const jar = normalizeLongCatCookie(rawCookie)
  if (!passport) {
    return jar
  }
  if (/passport_token_key\s*=/i.test(jar)) {
    return jar.replace(/passport_token_key\s*=[^;]*/i, `passport_token_key=${passport}`)
  }
  return `${jar}; passport_token_key=${passport}`
}

function cookieValueFromHeader(header: string, name: string): string {
  const match = header.match(new RegExp(`(?:^|;\\s*)${name}=([^;]*)`, 'i'))
  return match ? match[1].trim() : ''
}

export const LONGCAT_API_BASE = 'https://longcat.ai'
export const LONGCAT_LOGIN_URL = 'https://longcat.ai/chat'
export const LONGCAT_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'

export function longCatHeaders(cookie: string, extra: Record<string, string> = {}): Record<string, string> {
  return {
    'Accept': 'text/event-stream,application/json',
    'Accept-Language': 'en-US,en;q=0.9',
    'Cache-Control': 'no-cache',
    'Content-Type': 'application/json',
    'Origin': LONGCAT_API_BASE,
    'Pragma': 'no-cache',
    'Referer': `${LONGCAT_API_BASE}/`,
    'User-Agent': LONGCAT_USER_AGENT,
    'X-Client-Language': 'en',
    'X-Requested-With': 'XMLHttpRequest',
    Cookie: cookie,
    ...extra,
  }
}
