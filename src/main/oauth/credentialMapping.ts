/**
 * Normalize credentials captured by the in-app login window.
 *
 * The login window emits the raw key of each token source (`userToken`,
 * `chatglm_refresh_token`, `cookieJar`, ...). The account dialogs map those to
 * the keys the proxy adapters read when an account is added, but silent
 * renewal runs in the main process and previously merged the raw keys. That
 * left the old credential in place (e.g. DeepSeek kept using `token` while the
 * renewed value was stored as `userToken`).
 *
 * This module applies the same mapping for renewal.
 */

function pick(
  raw: Record<string, string>,
  ...keys: string[]
): string | undefined {
  for (const key of keys) {
    const value = raw[key]
    if (typeof value === 'string' && value.trim()) {
      return value
    }
  }
  return undefined
}

export function normalizeRenewedCredentials(
  providerId: string,
  raw: Record<string, string>
): Record<string, string> {
  const out: Record<string, string> = { ...raw }

  switch (providerId) {
    case 'deepseek': {
      const token = pick(raw, 'token', 'userToken')
      if (token) out.token = token
      break
    }
    case 'glm': {
      const refreshToken = pick(raw, 'refresh_token', 'chatglm_refresh_token', 'token')
      if (refreshToken) out.refresh_token = refreshToken
      break
    }
    case 'qwen': {
      const ticket = pick(raw, 'ticket', 'tongyi_sso_ticket', 'token')
      if (ticket) out.ticket = ticket
      break
    }
    case 'qwen-ai': {
      const token = pick(raw, 'token', 'tongyi_sso_ticket')
      if (token) out.token = token
      break
    }
    case 'zai': {
      const token = pick(raw, 'token', 'accessToken', 'jwt')
      if (token) out.token = token
      break
    }
    case 'minimax': {
      const token = pick(raw, 'token', '_token')
      if (token) out.token = token

      let realUserID = pick(raw, 'realUserID')
      if (!realUserID) {
        const detail = pick(raw, 'user_detail_agent')
        if (detail) {
          try {
            const parsed = JSON.parse(detail)
            realUserID = parsed?.realUserID || parsed?.id
          } catch {
            // Not JSON; ignore
          }
        }
      }
      if (realUserID) out.realUserID = String(realUserID)
      break
    }
    case 'mimo': {
      const serviceToken = pick(raw, 'service_token', 'serviceToken')
      const userId = pick(raw, 'user_id', 'userId')
      const phToken = pick(raw, 'ph_token', 'xiaomichatbot_ph')
      if (serviceToken) out.service_token = serviceToken
      if (userId) out.user_id = userId
      if (phToken) out.ph_token = phToken
      break
    }
    case 'perplexity': {
      const sessionToken = pick(
        raw,
        'sessionToken',
        '__Secure-next-auth.session-token',
        'next-auth.session-token',
        'token'
      )
      if (sessionToken) out.sessionToken = sessionToken
      break
    }
    case 'longcat': {
      const cookie = pick(raw, 'cookie', 'cookieJar')
      if (cookie) {
        // The freshly captured jar is authoritative; derive the passport from
        // it so a stale standalone value cannot override the new session.
        out.cookie = cookie
        const match = cookie.match(/(?:^|;\s*)passport_token_key=([^;]*)/i)
        out.passport_token_key = match ? match[1].trim() : ''
      } else {
        const passport = pick(raw, 'passport_token_key', 'token')
        if (passport && !passport.includes(';')) {
          out.passport_token_key = passport
        }
      }
      break
    }
    case 'kimi':
    default:
      break
  }

  return out
}
