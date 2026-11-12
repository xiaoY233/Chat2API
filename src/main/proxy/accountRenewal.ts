/**
 * Account credential renewal
 *
 * DeepSeek and Kimi accounts are added through the in-app OAuth login, which
 * captures a short-lived web token. When the upstream server expires that token
 * the adapter throws an authentication error. Because the login session is kept
 * on disk in a per-provider partition, the provider page can be reloaded in a
 * hidden window to capture a freshly minted token without asking the user to
 * log in again.
 *
 * This module decides when a failure is an authentication failure, performs a
 * single silent re-acquisition per account (de-duplicated and rate limited),
 * persists the new credentials to the store, and hands back an updated account
 * so the caller can retry the request once.
 */

import type { Account, Provider } from '../store/types'

const RENEWABLE_PROVIDER_TYPES: Record<string, string> = {
  deepseek: 'deepseek',
  kimi: 'kimi',
  'qwen-ai': 'qwen-ai',
}

const AUTH_FAILURE_PATTERNS: RegExp[] = [
  /invalid token/i,
  /token invalid or expired/i,
  /token expired or invalid/i,
  /token expired/i,
  /token is no longer valid/i,
  /session has expired/i,
  /please sign in again/i,
  /authorization failed/i,
  /unauthenticated/i,
  /auth\.token/i,
  /授权已过期/,
  /请重新登录/,
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
          if (refreshed) {
            return refreshed
          }
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

  const merged = { ...account.credentials, ...credentials }
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