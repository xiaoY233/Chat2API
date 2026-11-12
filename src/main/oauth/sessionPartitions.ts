/**
 * Provider login-session partitions
 *
 * The in-app login stores each provider's browser session in a persistent
 * Electron partition. v1.5.6 uses a deterministic partition per provider
 * (`persist:oauth-<providerType>`). Accounts added before that used a random
 * partition (`persist:oauth-<timestamp>`).
 *
 * To let existing accounts renew their tokens without a fresh login, this
 * module resolves the best partition for a provider: the deterministic one when
 * it holds cookies, otherwise the newest legacy partition that has cookies for
 * the provider's domains.
 */

import { promises as fs } from 'fs'
import path from 'path'
import { getTokenExtractionConfig } from './tokenExtractionConfig'
import type { ProviderType } from './types'

async function partitionHasCookies(
  session: any,
  partition: string,
  domains: string[]
): Promise<boolean> {
  try {
    const ses = session.fromPartition(partition)
    for (const domain of domains) {
      const cookies = await ses.cookies.get({ domain })
      if (cookies.some((cookie: any) => cookie?.value)) {
        return true
      }
    }
  } catch {
    // Partition does not exist or cannot be read
  }
  return false
}

/** Resolve the persistent session partition that most likely holds a login. */
export async function resolveProviderSessionPartition(
  providerType: ProviderType
): Promise<string> {
  const deterministic = `persist:oauth-${providerType}`
  try {
    const electron = await import('electron')
    const app = (electron as any)?.app
    const session = (electron as any)?.session
    if (!app || !session) {
      return deterministic
    }

    const domains = getTokenExtractionConfig(providerType)?.targetDomains || []
    if (domains.length === 0) {
      return deterministic
    }

    if (await partitionHasCookies(session, deterministic, domains)) {
      return deterministic
    }

    const partitionsDir = path.join(app.getPath('userData'), 'Partitions')
    const entries = await fs.readdir(partitionsDir).catch(() => [] as string[])
    const legacy = entries
      .filter((name) => /^oauth-\d+$/.test(name))
      .sort()
      .reverse()
      .slice(0, 20)

    for (const name of legacy) {
      const candidate = `persist:${name}`
      if (await partitionHasCookies(session, candidate, domains)) {
        console.log('[SessionPartitions] Reusing legacy login session', name, 'for', providerType)
        return candidate
      }
    }
  } catch (error) {
    console.warn('[SessionPartitions] Failed to resolve partition:', error)
  }
  return deterministic
}

/** Read the cookie header for a partition, limited to the provider's domains. */
export async function getPartitionCookieHeader(
  partition: string,
  domains: string[]
): Promise<string | null> {
  try {
    const electron = await import('electron')
    const session = (electron as any)?.session
    if (!session) return null

    const ses = session.fromPartition(partition)
    const seen = new Set<string>()
    const pairs: string[] = []
    for (const domain of domains) {
      const cookies = await ses.cookies.get({ domain })
      for (const cookie of cookies) {
        if (cookie?.name && cookie.value && !seen.has(cookie.name)) {
          seen.add(cookie.name)
          pairs.push(`${cookie.name}=${cookie.value}`)
        }
      }
    }
    return pairs.length > 0 ? pairs.join('; ') : null
  } catch {
    return null
  }
}

/** Resolve a provider's session partition and its cookie header. */
export async function getProviderSessionCookies(
  providerType: ProviderType
): Promise<{ partition: string; cookies: string | null }> {
  const partition = await resolveProviderSessionPartition(providerType)
  const domains = getTokenExtractionConfig(providerType)?.targetDomains || []
  const cookies = await getPartitionCookieHeader(partition, domains)
  return { partition, cookies }
}