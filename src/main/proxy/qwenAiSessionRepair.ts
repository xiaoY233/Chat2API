import type { Account, Provider } from '../store/types'
import { storeManager } from '../store/store'
import {
  hasQwenAiSessionCookie,
  qwenAiTokenRefresher,
} from './adapters/qwen-ai-token-refresh'

const DEFAULT_REPAIR_INTERVAL_MS = 25_000
const DEFAULT_RESCAN_INTERVAL_MS = 60_000
const DEFAULT_FAILURE_RETRY_MS = 5 * 60_000
const DEFAULT_CREDENTIAL_RETRY_MS = 6 * 60 * 60_000
const DEFAULT_RISK_COOLDOWN_MS = 180_000

export type QwenAiSessionRepairState =
  | 'ready'
  | 'pending'
  | 'repairing'
  | 'backoff'
  | 'unrepairable'

export interface QwenAiSessionRepairAccountStatus {
  state: QwenAiSessionRepairState
  ready: boolean
  repairable: boolean
  nextAttemptAt?: number
}

export type QwenAiSessionRepairResult =
  | { status: 'repaired'; accountId: string }
  | { status: 'failed'; accountId: string; nextAttemptAt: number; globalPauseUntil?: number }
  | { status: 'paused'; nextAttemptAt: number }
  | { status: 'idle'; nextAttemptAt?: number }

type RepairError = Error & {
  status?: number
  code?: string
  accountFault?: boolean
}

function envBoolean(name: string, fallback: boolean): boolean {
  const value = process.env[name]?.trim().toLowerCase()
  if (!value) return fallback
  if (['0', 'false', 'off', 'no'].includes(value)) return false
  if (['1', 'true', 'on', 'yes'].includes(value)) return true
  return fallback
}

function envDuration(name: string, fallback: number, minimum: number): number {
  const value = Number(process.env[name])
  return Number.isFinite(value) && value >= minimum ? Math.floor(value) : fallback
}

function isQwenAiProvider(provider: Provider): boolean {
  return provider.id === 'qwen-ai' || provider.apiEndpoint.includes('chat.qwen.ai')
}

export function isQwenAiWebSessionReady(account: Account): boolean {
  const cookies = String(account.credentials.cookies || account.credentials.cookie || '')
  return hasQwenAiSessionCookie(cookies)
}

export function isQwenAiWebSessionRepairable(account: Account): boolean {
  return Boolean(account.credentials.email && account.credentials.password)
}

function safeErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : 'Unknown session repair failure'
  return message
    .replace(/(Bearer\s+)[^\s]+/gi, '$1[REDACTED]')
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, '[REDACTED_JWT]')
    .replace(/((?:token|cookie|password|authorization)\s*[=:]\s*)[^\s,;]+/gi, '$1[REDACTED]')
    .slice(0, 300)
}

export class QwenAiSessionRepairService {
  private running = false
  private timer?: NodeJS.Timeout
  private abortController?: AbortController
  private inFlight?: Promise<QwenAiSessionRepairResult>
  private inFlightAccountId?: string
  private nextRunAt?: number
  private globalPauseUntil = 0
  private retryAfterByAccount = new Map<string, number>()

  isEnabled(): boolean {
    return envBoolean('CHAT2API_QWEN_AI_SESSION_REPAIR_ENABLED', true)
  }

  start(): void {
    if (this.running || !this.isEnabled()) return
    this.running = true

    const summary = this.getPoolSummary()
    console.info(
      `[QwenAI Session Repair] started ready=${summary.ready} pending=${summary.pending} unrepairable=${summary.unrepairable}`,
    )
    this.schedule(0)
  }

  stop(): void {
    this.running = false
    if (this.timer) clearTimeout(this.timer)
    this.timer = undefined
    this.nextRunAt = undefined
    this.abortController?.abort()
    this.abortController = undefined
  }

  wake(): void {
    if (!this.running || this.inFlight) return
    this.schedule(0)
  }

  getAccountStatus(account: Account, now = Date.now()): QwenAiSessionRepairAccountStatus {
    // Persisted inactive/error accounts are intentionally excluded from the
    // repair queue. Treat them as unrepairable here as well so the management
    // view does not report a retryable pending session for a disabled account.
    if (account.status !== 'active') {
      return { state: 'unrepairable', ready: false, repairable: false }
    }

    if (isQwenAiWebSessionReady(account)) {
      return { state: 'ready', ready: true, repairable: true }
    }

    const repairable = isQwenAiWebSessionRepairable(account)
    if (!repairable) {
      return { state: 'unrepairable', ready: false, repairable: false }
    }

    if (this.inFlightAccountId === account.id) {
      return { state: 'repairing', ready: false, repairable: true }
    }

    const nextAttemptAt = Math.max(
      this.retryAfterByAccount.get(account.id) || 0,
      this.globalPauseUntil,
    )
    if (nextAttemptAt > now) {
      return { state: 'backoff', ready: false, repairable: true, nextAttemptAt }
    }

    return { state: 'pending', ready: false, repairable: true }
  }

  getRuntimeStatus(): {
    running: boolean
    inFlightAccountId?: string
    nextRunAt?: number
    globalPauseUntil?: number
  } {
    return {
      running: this.running,
      inFlightAccountId: this.inFlightAccountId,
      nextRunAt: this.nextRunAt,
      globalPauseUntil: this.globalPauseUntil > Date.now() ? this.globalPauseUntil : undefined,
    }
  }

  async repairNext(signal?: AbortSignal): Promise<QwenAiSessionRepairResult> {
    if (this.inFlight) return this.inFlight

    const operation = this.performRepairNext(signal)
    this.inFlight = operation
    try {
      return await operation
    } finally {
      if (this.inFlight === operation) this.inFlight = undefined
    }
  }

  private async performRepairNext(signal?: AbortSignal): Promise<QwenAiSessionRepairResult> {
    const now = Date.now()
    if (this.globalPauseUntil > now) {
      return { status: 'paused', nextAttemptAt: this.globalPauseUntil }
    }

    const accounts = this.getQwenAiAccounts()
    const candidate = accounts.find(account => {
      const status = this.getAccountStatus(account, now)
      return account.status === 'active' && status.state === 'pending'
    })

    if (!candidate) {
      const nextAttemptAt = this.getEarliestRetryAt(now)
      return { status: 'idle', ...(nextAttemptAt ? { nextAttemptAt } : {}) }
    }

    this.inFlightAccountId = candidate.id
    try {
      const repaired = await qwenAiTokenRefresher.repairWebSession(candidate, signal)
      if (!isQwenAiWebSessionReady(repaired)) {
        throw new Error('Qwen AI signin did not return the required session cookie')
      }

      this.retryAfterByAccount.delete(candidate.id)
      console.info(`[QwenAI Session Repair] repaired account=${candidate.id}`)
      storeManager.addLog('info', 'Qwen AI web session repaired', {
        accountId: candidate.id,
        providerId: candidate.providerId,
      })
      return { status: 'repaired', accountId: candidate.id }
    } catch (error) {
      const repairError = error as RepairError
      const status = Number(repairError.status)
      const riskControlled = status === 403 || status === 429
      const retryDelay = status === 401
        ? envDuration(
            'CHAT2API_QWEN_AI_SESSION_REPAIR_CREDENTIAL_RETRY_MS',
            DEFAULT_CREDENTIAL_RETRY_MS,
            60_000,
          )
        : envDuration(
            'CHAT2API_QWEN_AI_SESSION_REPAIR_FAILURE_RETRY_MS',
            DEFAULT_FAILURE_RETRY_MS,
            10_000,
          )
      const nextAttemptAt = Date.now() + retryDelay
      this.retryAfterByAccount.set(candidate.id, nextAttemptAt)

      if (riskControlled) {
        const riskCooldownMs = envDuration(
          'CHAT2API_QWEN_AI_SESSION_REPAIR_RISK_COOLDOWN_MS',
          DEFAULT_RISK_COOLDOWN_MS,
          60_000,
        )
        this.globalPauseUntil = Date.now() + riskCooldownMs
      }

      const message = safeErrorMessage(error)
      console.warn(
        `[QwenAI Session Repair] failed account=${candidate.id} status=${Number.isFinite(status) ? status : '-'} code=${repairError.code || '-'} message=${message}`,
      )
      storeManager.addLog('warn', `Qwen AI web session repair failed: ${message}`, {
        accountId: candidate.id,
        providerId: candidate.providerId,
        errorCode: repairError.code,
      })

      return {
        status: 'failed',
        accountId: candidate.id,
        nextAttemptAt,
        ...(this.globalPauseUntil > Date.now()
          ? { globalPauseUntil: this.globalPauseUntil }
          : {}),
      }
    } finally {
      this.inFlightAccountId = undefined
    }
  }

  private getQwenAiAccounts(): Account[] {
    const providers = storeManager.getProviders()
    const providerIds = new Set(
      providers.filter(isQwenAiProvider).map(provider => provider.id),
    )
    return storeManager.getAccounts(true)
      .filter(account => providerIds.has(account.providerId))
  }

  private getPoolSummary(): { ready: number; pending: number; unrepairable: number } {
    return this.getQwenAiAccounts().reduce((summary, account) => {
      const status = this.getAccountStatus(account)
      if (status.ready) return { ...summary, ready: summary.ready + 1 }
      if (!status.repairable) return { ...summary, unrepairable: summary.unrepairable + 1 }
      return { ...summary, pending: summary.pending + 1 }
    }, { ready: 0, pending: 0, unrepairable: 0 })
  }

  private getEarliestRetryAt(now: number): number | undefined {
    const candidates = [
      this.globalPauseUntil,
      ...this.retryAfterByAccount.values(),
    ].filter(timestamp => timestamp > now)
    return candidates.length > 0 ? Math.min(...candidates) : undefined
  }

  private schedule(delayMs: number): void {
    if (!this.running) return
    if (this.timer) clearTimeout(this.timer)

    const delay = Math.max(0, delayMs)
    this.nextRunAt = Date.now() + delay
    this.timer = setTimeout(() => {
      this.timer = undefined
      this.nextRunAt = undefined
      void this.runScheduled()
    }, delay)
    this.timer.unref?.()
  }

  private async runScheduled(): Promise<void> {
    if (!this.running) return

    this.abortController = new AbortController()
    let result: QwenAiSessionRepairResult
    try {
      result = await this.repairNext(this.abortController.signal)
    } finally {
      this.abortController = undefined
    }

    if (!this.running) return

    const now = Date.now()
    const repairIntervalMs = envDuration(
      'CHAT2API_QWEN_AI_SESSION_REPAIR_INTERVAL_MS',
      DEFAULT_REPAIR_INTERVAL_MS,
      1_000,
    )
    const rescanIntervalMs = envDuration(
      'CHAT2API_QWEN_AI_SESSION_REPAIR_RESCAN_MS',
      DEFAULT_RESCAN_INTERVAL_MS,
      5_000,
    )

    if (result.status === 'paused') {
      this.schedule(Math.max(repairIntervalMs, result.nextAttemptAt - now))
      return
    }

    if (result.status === 'idle') {
      const retryDelay = result.nextAttemptAt
        ? Math.max(repairIntervalMs, result.nextAttemptAt - now)
        : rescanIntervalMs
      this.schedule(Math.min(rescanIntervalMs, retryDelay))
      return
    }

    if (result.status === 'failed' && result.globalPauseUntil) {
      this.schedule(Math.max(repairIntervalMs, result.globalPauseUntil - now))
      return
    }

    this.schedule(repairIntervalMs)
  }
}

export const qwenAiSessionRepairService = new QwenAiSessionRepairService()
