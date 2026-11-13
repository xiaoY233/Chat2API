/**
 * Account credential renewal
 *
 * Providers added through the in-app browser login capture a short-lived web
 * token or cookie. When the upstream server expires it, the adapter throws an
 * authentication error. Because the login session is kept on disk in a
 * per-provider partition, the provider page can be reloaded in a hidden window
 * to capture freshly minted credentials without asking the user to log in
 * again. Qwen AI additionally exposes a native refresh endpoint, which is
 * tried first because it is instant and needs no window.
 *
 * This module decides when a failure is an authentication failure, performs a
 * single silent re-acquisition per account (de-duplicated and rate limited),
 * normalizes the captured keys to the ones the proxy adapters read, persists
 * the new credentials to the store, and hands back an updated account so the
 * caller can retry the request once.
 */

import type { Account, Provider } from '../store/types'
import { normalizeRenewedCredentials } from '../oauth/credentialMapping'

const RENEWABLE_PROVIDER_TYPES: Record<string, string> = {
  deepseek: 'deepseek',
  glm: 'glm',
  kimi: 'kimi',
  qwen: 'qwen',
  'qwen-ai': 'qwen-ai',
  zai: 'zai',
  minimax: 'minimax',
  mimo: 'mimo',
  perplexity: 'perplexity',
  longcat: 'longcat',
}

const AUTH_FAILURE_PATTERNS: RegExp[] = [
  /invalid token/i,
  /token invalid or expired/i,
  /token expired or invalid/i,
  /token expired/i,
  /token is no longer valid/i,
  /token refresh failed/i,
  /session has expired/i,
  /session (?:token )?(?:is )?(?:expired|invalid)/i,
  /cookie expired or invalid/i,
  /please sign in again/i,
  /please (?:log|sign) in/i,
  /not logged in/i,
  /authorization failed/i,
  /unauthenticated/i,
  /unauthorized/i,
  /\b401\b/,
  /auth\.token/i,
  /授权已过期/,
  /请重新登录/,
  /登录.*(?:过期|失效|重新)/,
  /未登录/,
  /请.*登录/,
]

const RENEWAL_COOLDOWN_MS = 60_000

const inflight = new Map<string, Promise<Record<string, string> | null>>()
const cooldownUntil = new Map<string, number>()

/** Whether an adapter error message indicates the stored token was rejected. */
export function isAuthFailure(message: string | undefined | null): boolean {
  if (!message) return false
  return AUTH_FAILURE_PATTERNS.some((pattern) => pattern.test(message))
}

/** Whether a provider can re-acquire credentials from a retained login session. */
export function isRenewableProvider(providerId: string): boolean {
  return providerId in RENEWABLE_PROVIDER_TYPES
}

/**
 * Attempt to silently re-acquire credentials for an account and persist them.
 * Returns an updated account copy on success, or null when renewal is not
 * possible (unsupported provider, cooldown, or session no longer logged in).
 */
export async function renewAccountCredentials(
  account: Account,
  provider: Provider
): Promise<Account | null> {
  const providerType = RENEWABLE_PROVIDER_TYPES[provider.id]
  if (!providerType) {
    return null
  }

  if (Date.now() < (cooldownUntil.get(account.id) || 0)) {
    return null
  }

  console.log('[AccountRenewal] Attempting credential renewal for', provider.id, 'account', account.id)

  const existing = inflight.get(account.id)
  const promise =
    existing ||
    (async () => {
      try {
        if (provider.id === 'qwen-ai') {
          const { refreshQwenAiToken } = await import('../oauth/qwenAiRefresh')
          const refreshed = await refreshQwenAiToken(
            account.credentials.cookies || account.credentials.cookie
          )
          if (refreshed.status === 'success') {
            return { token: refreshed.token, cookies: refreshed.cookies }
          }
          if (refreshed.status === 'no-session') {
            console.log(
              '[AccountRenewal] Qwen session is not signed in; a manual login is required'
            )
            return null
          }

          // The refresh itself failed (network/WAF/server error). If a browser
          // login session is still on disk, let Qwen's own frontend mint a
          // token in a hidden window and extract it.
          const { getProviderSessionCookies } = await import('../oauth/sessionPartitions')
          const { cookies: partitionCookies } = await getProviderSessionCookies('qwen-ai')
          if (!partitionCookies) {
            console.log(
              '[AccountRenewal] No retained Qwen login session; a manual login is required'
            )
            return null
          }
          console.log(
            '[AccountRenewal] Native Qwen refresh failed; retrying via the retained login window'
          )
        }
        const { oauthManager } = await import('../oauth/manager')
        return oauthManager.reacquireCredentials(provider.id, providerType as any)
      } catch (error) {
        console.warn('[AccountRenewal] Re-acquisition failed:', error)
        return null
      }
    })()
  if (!existing) {
    inflight.set(account.id, promise)
  }

  let credentials: Record<string, string> | null = null
  try {
    credentials = await promise
  } finally {
    if (!existing) {
      inflight.delete(account.id)
    }
  }

  if (!credentials || Object.keys(credentials).length === 0) {
    cooldownUntil.set(account.id, Date.now() + RENEWAL_COOLDOWN_MS)
    return null
  }

  const merged = {
    ...account.credentials,
    ...normalizeRenewedCredentials(provider.id, credentials),
  }
  try {
    const { storeManager } = await import('../store/store')
    storeManager.updateAccount(account.id, { credentials: merged })
  } catch (error) {
    console.warn('[AccountRenewal] Failed to persist renewed credentials:', error)
  }

  cooldownUntil.delete(account.id)
  console.log('[AccountRenewal] Renewed credentials for', provider.id, 'account', account.id)
  return {
    ...account,
    credentials: merged,
    status: 'active',
    errorMessage: undefined,
    updatedAt: Date.now(),
  }
}

/** Test helper: clear de-duplication and cooldown state. */
export function resetAccountRenewalForTests(): void {
  inflight.clear()
  cooldownUntil.clear()
}