import type { ForwardResult } from './types'
import { storeManager } from '../store/store'
import type {
  Account,
  AccountStatus,
  Provider,
  QwenAiGovernorConfig,
} from '../store/types'
import { normalizeQwenAiGovernorConfig } from '../store/types'
import type {
  QwenAiAccountFailoverRecord,
  QwenAiGovernorEffectiveConfig,
  QwenAiGovernorStatus,
} from '../../shared/types'
import {
  calculateQwenAiAdaptiveLimits,
  calculateQwenAiRequestReadyAt,
  parseQwenAiRetryAfterMs,
} from './qwenAiGovernorPolicy'
import { isQwenAiAccountFault as classifyQwenAiAccountFault } from './qwenAiAccountPolicy'

function isQwenAiAccountFault(value: Parameters<typeof classifyQwenAiAccountFault>[0] | undefined): boolean {
  return classifyQwenAiAccountFault(value)
}

export type QwenAiRequestClass = 'normal' | 'context_compaction'

type QueueItem = {
  id: string
  accountId: string
  run: () => Promise<ForwardResult>
  resolve: (value: ForwardResult) => void
  reject: (reason: unknown) => void
  enqueuedAt: number
  queueDepthAtEnqueue: number
  deadlineAt?: number
  timeout?: NodeJS.Timeout
  signal?: AbortSignal
  queueAbortListener?: () => void
  recoveryBypassAccountInterval: boolean
  recoveryBypassGlobalInterval: boolean
  waitForActiveSettlementOnAbort: boolean
  requestId?: string
  attempt: number
  requestClass: QwenAiRequestClass
  globalRecoveryProbe: boolean
  cancelled: boolean
}

export type QwenAiGovernorRunOptions = {
  signal?: AbortSignal
  /** Absolute outer request deadline, including time spent in this queue. */
  deadlineAt?: number
  /**
   * When false, return an internal admission-deferred result instead of
   * placing the request in the shared governor queue. Context compaction uses
   * this mode so a large map/reduce operation cannot accumulate hidden work
   * behind normal traffic or another compaction stage.
   */
  allowQueue?: boolean
  recoveryBypassAccountInterval?: boolean
  /**
   * Allow one explicitly account-scoped failover to start without waiting for
   * the aggregate pacing interval. The caller must keep this bounded and only
   * use it after an upstream `next-account` decision.
   */
  recoveryBypassGlobalInterval?: boolean
  waitForActiveSettlementOnAbort?: boolean
  requestId?: string
  attempt?: number
  /**
   * Normal client work is always preferred over internal context compaction.
   * Internal map/reduce calls must opt into the lower-priority class so one
   * large transcript cannot occupy every provider slot.
   */
  requestClass?: QwenAiRequestClass
}

type CooldownState = {
  until: number
  failures: number
  reason: string
}

type RiskEvent = {
  accountId: string
  timestamp: number
}

// A few account-level risk responses are not enough evidence to stop a large
// pool. The circuit is eligible only after risk reaches a pool-relative sample
// and no healthy account remains.
const GLOBAL_RISK_POOL_RATIO = 0.1

function withRetryAfterHeader(result: ForwardResult, cooldownMs: number): ForwardResult {
  const hasRetryAfter = Object.keys(result.headers || {})
    .some(key => key.toLowerCase() === 'retry-after')
  if (hasRetryAfter) return result

  return {
    ...result,
    headers: {
      ...(result.headers || {}),
      'Retry-After': String(Math.max(1, Math.ceil(cooldownMs / 1000))),
    },
  }
}

const ENV_DEFAULT_CONFIG: QwenAiGovernorConfig = {
  autoTuneEnabled: process.env.CHAT2API_QWEN_AI_AUTO_TUNE_ENABLED !== 'false',
  autoTuneMaxConcurrent: Math.max(1, numberFromEnv('CHAT2API_QWEN_AI_AUTO_TUNE_MAX_CONCURRENT', 100)),
  autoTuneMinGlobalIntervalMs: numberFromEnv('CHAT2API_QWEN_AI_AUTO_TUNE_MIN_GLOBAL_INTERVAL_MS', 1000),
  maxConcurrent: Math.max(1, numberFromEnv('CHAT2API_QWEN_AI_MAX_CONCURRENT', 1)),
  globalMinIntervalMs: numberFromEnv('CHAT2API_QWEN_AI_GLOBAL_MIN_INTERVAL_MS', 15000),
  accountMinIntervalMs: numberFromEnv('CHAT2API_QWEN_AI_ACCOUNT_MIN_INTERVAL_MS', 120000),
  riskCooldownMs: numberFromEnv('CHAT2API_QWEN_AI_RISK_COOLDOWN_MS', 10 * 60 * 1000),
  maxRiskCooldownMs: numberFromEnv('CHAT2API_QWEN_AI_MAX_RISK_COOLDOWN_MS', 30 * 60 * 1000),
  failureCooldownMs: numberFromEnv('CHAT2API_QWEN_AI_FAILURE_COOLDOWN_MS', 2 * 60 * 1000),
  globalRiskCooldownMs: numberFromEnv('CHAT2API_QWEN_AI_GLOBAL_RISK_COOLDOWN_MS', 30 * 60 * 1000),
  maxGlobalRiskCooldownMs: numberFromEnv('CHAT2API_QWEN_AI_MAX_GLOBAL_RISK_COOLDOWN_MS', 2 * 60 * 60 * 1000),
  riskWindowMs: numberFromEnv('CHAT2API_QWEN_AI_RISK_WINDOW_MS', 5 * 60 * 1000),
  globalRiskThreshold: Math.max(1, numberFromEnv('CHAT2API_QWEN_AI_GLOBAL_RISK_THRESHOLD', 3)),
}

const QWEN_AI_QUEUE_TIMEOUT_MS = Math.max(
  1000,
  numberFromEnv('CHAT2API_QWEN_AI_QUEUE_TIMEOUT_MS', 120 * 1000),
)

function numberFromEnv(name: string, fallback: number): number {
  const raw = process.env[name]
  if (!raw) return fallback

  const value = Number(raw)
  return Number.isFinite(value) && value >= 0 ? value : fallback
}

function compactionReservedSlots(maxConcurrent: number): number {
  const availableSlots = Math.max(0, Math.floor(maxConcurrent) - 1)
  if (availableSlots === 0) return 0

  // Keep one slot for ordinary traffic by default. Deployments that have a
  // separate Qwen pool for compaction can explicitly set this to zero; the
  // value is bounded against the effective governor cap.
  const configured = numberFromEnv(
    'CHAT2API_QWEN_AI_COMPACTION_RESERVED_SLOTS',
    1,
  )
  return Math.min(availableSlots, Math.max(0, Math.floor(configured)))
}

function explicitNumberFromEnv(
  name: string,
  fallback: number,
  options: { min?: number; max?: number } = {},
): number {
  if (process.env[name] === undefined) return fallback

  const min = options.min ?? 0
  const max = options.max ?? Number.MAX_SAFE_INTEGER
  return Math.min(max, Math.max(min, Math.floor(numberFromEnv(name, fallback))))
}

function explicitBooleanFromEnv(name: string, fallback: boolean): boolean {
  const raw = process.env[name]
  if (raw === undefined) return fallback
  if (raw === 'true') return true
  if (raw === 'false') return false
  return fallback
}

/**
 * Explicit environment values are deployment-level overrides. This matters
 * for Docker, where persisted defaults otherwise mask changes made in .env.
 */
function applyExplicitEnvironmentOverrides(config: QwenAiGovernorConfig): QwenAiGovernorConfig {
  return normalizeQwenAiGovernorConfig({
    autoTuneEnabled: explicitBooleanFromEnv(
      'CHAT2API_QWEN_AI_AUTO_TUNE_ENABLED',
      config.autoTuneEnabled,
    ),
    autoTuneMaxConcurrent: explicitNumberFromEnv(
      'CHAT2API_QWEN_AI_AUTO_TUNE_MAX_CONCURRENT',
      config.autoTuneMaxConcurrent,
      { min: 1, max: 100 },
    ),
    autoTuneMinGlobalIntervalMs: explicitNumberFromEnv(
      'CHAT2API_QWEN_AI_AUTO_TUNE_MIN_GLOBAL_INTERVAL_MS',
      config.autoTuneMinGlobalIntervalMs,
    ),
    maxConcurrent: explicitNumberFromEnv(
      'CHAT2API_QWEN_AI_MAX_CONCURRENT',
      config.maxConcurrent,
      { min: 1, max: 100 },
    ),
    globalMinIntervalMs: explicitNumberFromEnv(
      'CHAT2API_QWEN_AI_GLOBAL_MIN_INTERVAL_MS',
      config.globalMinIntervalMs,
    ),
    accountMinIntervalMs: explicitNumberFromEnv(
      'CHAT2API_QWEN_AI_ACCOUNT_MIN_INTERVAL_MS',
      config.accountMinIntervalMs,
    ),
    riskCooldownMs: explicitNumberFromEnv(
      'CHAT2API_QWEN_AI_RISK_COOLDOWN_MS',
      config.riskCooldownMs,
    ),
    maxRiskCooldownMs: explicitNumberFromEnv(
      'CHAT2API_QWEN_AI_MAX_RISK_COOLDOWN_MS',
      config.maxRiskCooldownMs,
    ),
    failureCooldownMs: explicitNumberFromEnv(
      'CHAT2API_QWEN_AI_FAILURE_COOLDOWN_MS',
      config.failureCooldownMs,
    ),
    globalRiskCooldownMs: explicitNumberFromEnv(
      'CHAT2API_QWEN_AI_GLOBAL_RISK_COOLDOWN_MS',
      config.globalRiskCooldownMs,
    ),
    maxGlobalRiskCooldownMs: explicitNumberFromEnv(
      'CHAT2API_QWEN_AI_MAX_GLOBAL_RISK_COOLDOWN_MS',
      config.maxGlobalRiskCooldownMs,
    ),
    riskWindowMs: explicitNumberFromEnv(
      'CHAT2API_QWEN_AI_RISK_WINDOW_MS',
      config.riskWindowMs,
      { min: 1000 },
    ),
    globalRiskThreshold: explicitNumberFromEnv(
      'CHAT2API_QWEN_AI_GLOBAL_RISK_THRESHOLD',
      config.globalRiskThreshold,
      { min: 1, max: 100 },
    ),
  })
}

function isQwenRiskControl(error?: string, status?: number, errorCode?: string): boolean {
  const riskText = `${error || ''} ${errorCode || ''}`
  return Boolean(
    errorCode === 'qwen_ai_risk_control' ||
    ((status === 403 || status === 429) &&
      /qwen_ai_risk_control|FAIL_SYS_USER_VALIDATE|RGV587|bxpunish|risk-control|challenge|x5sec|baxia|punish/i.test(riskText)),
  )
}

function isConfiguredActiveStatus(status: AccountStatus): boolean {
  return status === 'active'
}

function attachRelease(stream: NodeJS.ReadableStream, release: () => void): void {
  let released = false
  const releaseOnce = () => {
    if (!released) {
      released = true
      release()
    }
  }

  stream.once('end', releaseOnce)
  stream.once('close', releaseOnce)
  stream.once('error', releaseOnce)

  const state = stream as NodeJS.ReadableStream & {
    readableEnded?: boolean
    destroyed?: boolean
    closed?: boolean
  }
  if (state.readableEnded || state.destroyed || state.closed) {
    releaseOnce()
  }
}

function destroyForwardStream(stream: NodeJS.ReadableStream | undefined): void {
  if (!stream) return

  const candidate = stream as NodeJS.ReadableStream & {
    destroy?: (error?: Error) => void
  }
  if (typeof candidate.destroy === 'function') {
    candidate.destroy()
  }
}

export class QwenAiRequestGovernor {
  private queue: QueueItem[] = []
  private active = 0
  private lastGlobalStartAt = 0
  private timer: NodeJS.Timeout | undefined
  private accountNextAvailableAt: Map<string, number> = new Map()
  private accountCooldowns: Map<string, CooldownState> = new Map()
  private activeByAccount: Map<string, number> = new Map()
  private activeByRequestClass: Map<QwenAiRequestClass, number> = new Map()
  private globalCooldown: CooldownState | undefined
  private globalRecoveryProbeItemId: string | undefined
  private globalRecoveryProbeAccountId: string | undefined
  private globalRecoveryNextAt = 0
  private riskEvents: RiskEvent[] = []
  private recentFailovers: ReadonlyMap<string, QwenAiAccountFailoverRecord> = new Map()
  private nextQueueItemId = 1

  run(accountId: string, run: () => Promise<ForwardResult>, options: QwenAiGovernorRunOptions = {}): Promise<ForwardResult> {
    return new Promise((resolve, reject) => {
      const now = Date.now()
      this.expireGlobalCooldown(now)

      // A request that is already cancelled must never be converted into a
      // capacity or circuit response, even when a global cooldown is active.
      if (options.signal?.aborted) {
        resolve(this.createCancelledResult('Client disconnected before Qwen AI request was queued.'))
        return
      }

      const deadlineAt = typeof options.deadlineAt === 'number'
        && Number.isFinite(options.deadlineAt)
        ? options.deadlineAt
        : undefined
      if (deadlineAt !== undefined && now >= deadlineAt) {
        resolve(this.createRequestDeadlineResult())
        return
      }

      const requestClass = options.requestClass || 'normal'
      const globalCooldownInMs = this.getGlobalCooldownInMs(now)
      const globalRecoveryProbe = globalCooldownInMs > 0
        && this.canStartGlobalRecoveryProbe(accountId, requestClass, now)
      if (globalCooldownInMs > 0 && !globalRecoveryProbe) {
        resolve(this.createGlobalCircuitOpenResult(
          this.getGlobalRecoveryWaitMs(now, globalCooldownInMs),
        ))
        return
      }

      if (options.allowQueue === false) {
        const waitMs = this.getImmediateAdmissionWaitMs(
          accountId,
          requestClass,
          now,
          options.recoveryBypassGlobalInterval === true,
          options.recoveryBypassAccountInterval === true,
        )
        if (waitMs > 0) {
          resolve(this.createAdmissionDeferredResult(waitMs, requestClass))
          return
        }
      }

      const item: QueueItem = {
        id: String(this.nextQueueItemId++),
        accountId,
        run,
        resolve,
        reject,
        enqueuedAt: now,
        queueDepthAtEnqueue: this.queue.length + 1,
        deadlineAt,
        signal: options.signal,
        recoveryBypassAccountInterval: options.recoveryBypassAccountInterval === true,
        recoveryBypassGlobalInterval: options.recoveryBypassGlobalInterval === true,
        waitForActiveSettlementOnAbort: options.waitForActiveSettlementOnAbort === true,
        requestId: options.requestId,
        attempt: options.attempt ?? 1,
        requestClass,
        globalRecoveryProbe,
        cancelled: false,
      }

      if (globalRecoveryProbe) {
        this.globalRecoveryProbeItemId = item.id
        this.globalRecoveryProbeAccountId = accountId
        this.globalRecoveryNextAt = now + this.getGlobalRecoveryIntervalMs()
        console.warn(
          `[QwenAI Governor] Global circuit half-open probe admitted for account ${accountId}`,
        )
      }

      const cancelQueued = (result: ForwardResult) => {
        if (item.cancelled) return
        item.cancelled = true
        this.completeGlobalRecoveryProbe(item, false)
        this.removeQueuedItem(item)
        resolve(result)
      }

      const queueTimeoutAt = now + QWEN_AI_QUEUE_TIMEOUT_MS
      const timeoutAt = deadlineAt === undefined
        ? queueTimeoutAt
        : Math.min(queueTimeoutAt, deadlineAt)
      item.timeout = setTimeout(() => {
        this.pump()
        const stillQueued = this.queue.some(candidate => candidate === item || candidate.id === item.id)
        if (!stillQueued || item.cancelled) return

        if (!options.signal?.aborted) {
          this.logLifecycle(item, 'queue_timeout', {
            queueWaitMs: Math.max(0, Date.now() - item.enqueuedAt),
            activeRequests: this.active,
          })
        }
        cancelQueued(options.signal?.aborted
          ? this.createCancelledResult('Client disconnected while Qwen AI request was queued.')
          : this.createQueueTimeoutResult(item.requestClass))
      }, Math.max(0, timeoutAt - now))

      item.queueAbortListener = () => {
        cancelQueued(this.createCancelledResult('Client disconnected while Qwen AI request was queued.'))
      }
      options.signal?.addEventListener('abort', item.queueAbortListener, { once: true })

      this.queue.push(item)
      if (options.signal?.aborted) {
        item.queueAbortListener?.()
        return
      }
      this.pump()
      if (
        options.allowQueue === false
        && this.queue.some(candidate => candidate === item || candidate.id === item.id)
      ) {
        // A normal item may have won the ready slot between the synchronous
        // preflight above and `pump()`. Never leave an immediate-only
        // compaction item behind it in the shared queue.
        cancelQueued(this.createAdmissionDeferredResult(1000, requestClass))
      }
    })
  }

  private createCancelledResult(message: string): ForwardResult {
    return {
      success: false,
      status: 499,
      error: message,
      errorCode: 'qwen_ai_client_cancelled',
      retryable: false,
      accountFault: false,
    }
  }

  private createRequestDeadlineResult(): ForwardResult {
    return {
      success: false,
      status: 504,
      error: 'Qwen AI request exceeded its cumulative request deadline.',
      errorCode: 'qwen_ai_request_timeout',
      retryable: false,
      accountFault: false,
    }
  }

  private createQueueTimeoutResult(requestClass: QwenAiRequestClass): ForwardResult {
    const retryAfterSeconds = Math.max(1, Math.ceil(QWEN_AI_QUEUE_TIMEOUT_MS / 1000))
    return {
      success: false,
      status: 429,
      headers: {
        'Retry-After': String(retryAfterSeconds),
      },
      error: `Qwen AI request waited in queue for more than ${retryAfterSeconds}s.`,
      errorCode: 'qwen_ai_queue_timeout',
      retryable: true,
      accountFault: false,
      // No upstream generation was started. A normal client request can be
      // routed to another account; internal compaction keeps its pipeline
      // failure local so it does not churn the whole account pool.
      ...(requestClass === 'normal' ? { retryScope: 'next-account' as const } : {}),
    }
  }

  private createAdmissionDeferredResult(
    waitMs: number,
    requestClass: QwenAiRequestClass,
  ): ForwardResult {
    const retryAfterSeconds = Math.max(1, Math.ceil(Math.max(1, waitMs) / 1000))
    return {
      success: false,
      status: 429,
      headers: {
        'Retry-After': String(retryAfterSeconds),
      },
      error: `Qwen AI ${requestClass} admission is deferred until a provider slot is ready.`,
      errorCode: 'qwen_ai_compaction_admission_deferred',
      retryable: true,
      accountFault: false,
    }
  }

  /**
   * Return a positive wait when an immediate-only request cannot start. This
   * check is synchronous with `run()` and therefore closes the microtask race
   * where several compaction stages otherwise enqueue before the first one is
   * admitted.
   */
  private getImmediateAdmissionWaitMs(
    accountId: string,
    requestClass: QwenAiRequestClass,
    now: number,
    recoveryBypassGlobalInterval: boolean,
    recoveryBypassAccountInterval: boolean,
  ): number {
    const config = this.getEffectiveConfig()
    const compactionLimit = this.getCompactionConcurrencyLimit(config.maxConcurrent)
    const activeCompaction = this.getActiveRequestCount('context_compaction')

    if (
      this.active >= config.maxConcurrent
      || (requestClass === 'context_compaction' && activeCompaction >= compactionLimit)
      || this.queue.some(item => item.accountId === accountId && !item.cancelled)
    ) {
      // There is no reliable completion ETA for an in-flight stream. A short
      // retry hint keeps the caller out of the queue while the release hook
      // wakes its own scheduler as soon as the slot settles.
      return 1000
    }

    const readyAt = calculateQwenAiRequestReadyAt({
      lastGlobalStartAt: this.lastGlobalStartAt,
      globalMinIntervalMs: config.globalMinIntervalMs,
      recoveryBypassGlobalInterval,
      accountNextAvailableAt: this.accountNextAvailableAt.get(accountId) || 0,
      accountCooldownUntil: this.accountCooldowns.get(accountId)?.until || 0,
      recoveryBypassAccountInterval,
      accountActive: (this.activeByAccount.get(accountId) || 0) > 0,
    })
    if (readyAt === Number.POSITIVE_INFINITY) return 1000
    return Math.max(0, readyAt - now)
  }

  private clearQueueItemWaiters(item: QueueItem): void {
    if (item.timeout) {
      clearTimeout(item.timeout)
      item.timeout = undefined
    }
    if (item.queueAbortListener) {
      item.signal?.removeEventListener('abort', item.queueAbortListener)
      item.queueAbortListener = undefined
    }
  }

  private removeQueuedItem(item: QueueItem): void {
    const index = this.queue.findIndex(candidate => candidate === item || candidate.id === item.id)
    if (index >= 0) {
      this.queue.splice(index, 1)
      this.pump()
    }
    this.clearQueueItemWaiters(item)
  }

  private expireQueuedRequestDeadlines(now: number): void {
    const expired: QueueItem[] = []
    this.queue = this.queue.filter((item) => {
      if (item.deadlineAt === undefined || now < item.deadlineAt) return true
      expired.push(item)
      return false
    })

    for (const item of expired) {
      item.cancelled = true
      this.clearQueueItemWaiters(item)
      this.completeGlobalRecoveryProbe(item, false)
      this.logLifecycle(item, 'request_deadline', {
        queueWaitMs: Math.max(0, now - item.enqueuedAt),
        activeRequests: this.active,
      })
      item.resolve(item.signal?.aborted
        ? this.createCancelledResult('Client disconnected while Qwen AI request was queued.')
        : this.createRequestDeadlineResult())
    }
  }

  private pump(): void {
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = undefined
    }

    const config = this.getEffectiveConfig()
    const nowForGlobal = Date.now()
    this.expireQueuedRequestDeadlines(nowForGlobal)
    this.expireGlobalCooldown(nowForGlobal)
    const globalCooldownInMs = this.getGlobalCooldownInMs(nowForGlobal)
    if (globalCooldownInMs > 0) {
      this.rejectQueuedRequestsForGlobalCircuit(globalCooldownInMs, true)
      if (!this.queue.some(item => item.globalRecoveryProbe && !item.cancelled)) return
    }

    const compactionLimit = this.getCompactionConcurrencyLimit(config.maxConcurrent)
    while (this.active < config.maxConcurrent && this.queue.length > 0) {
      const now = Date.now()
      let selectedIndex = -1
      let nextReadyAt = Number.POSITIVE_INFINITY
      const activeCompaction = this.getActiveRequestCount('context_compaction')

      for (let index = 0; index < this.queue.length; index += 1) {
        const candidate = this.queue[index]
        // Compaction is deliberately kept below the total cap. Do not let a
        // queued compaction item hide a ready normal request or create a
        // timer that spins while the reserved slot is occupied.
        if (
          candidate.requestClass === 'context_compaction'
          && activeCompaction >= compactionLimit
        ) {
          continue
        }

        const readyAt = this.getReadyAt(candidate, now)
        if (readyAt <= now) {
          // Preserve FIFO within each class, while always giving ordinary
          // client traffic the first ready slot.
          if (candidate.requestClass === 'normal') {
            selectedIndex = index
            break
          }
          if (selectedIndex === -1) selectedIndex = index
          continue
        }
        nextReadyAt = Math.min(nextReadyAt, readyAt)
      }

      if (selectedIndex === -1) {
        if (nextReadyAt === Number.POSITIVE_INFINITY) {
          // Every queued item belongs to an active account. The active
          // stream's release callback will call pump() when it ends.
          return
        }
        const delayMs = Math.max(50, nextReadyAt - now)
        this.timer = setTimeout(() => this.pump(), delayMs)
        return
      }

      const item = this.queue.splice(selectedIndex, 1)[0]
      this.clearQueueItemWaiters(item)
      if (item.cancelled || item.signal?.aborted) {
        item.cancelled = true
        item.resolve(this.createCancelledResult('Client disconnected before Qwen AI request started.'))
        continue
      }
      this.start(item)
    }
  }

  private start(item: QueueItem): void {
    const config = this.getEffectiveConfig()
    const startedAt = Date.now()
    const queueWaitMs = Math.max(0, startedAt - item.enqueuedAt)
    this.active += 1
    this.activeByAccount.set(item.accountId, (this.activeByAccount.get(item.accountId) || 0) + 1)
    this.activeByRequestClass.set(
      item.requestClass,
      this.getActiveRequestCount(item.requestClass) + 1,
    )
    this.lastGlobalStartAt = startedAt
    this.accountNextAvailableAt.set(item.accountId, startedAt + config.accountMinIntervalMs)
    this.logLifecycle(item, 'admitted', {
      queueWaitMs,
      activeRequests: this.active,
    })

    let released = false
    let settledByAbort = false
    let runStarted = false
    let activeStream: NodeJS.ReadableStream | undefined
    const release = () => {
      if (!released) {
        released = true
        this.logLifecycle(item, 'released', {
          queueWaitMs,
          activeDurationMs: Math.max(0, Date.now() - startedAt),
          activeRequests: Math.max(0, this.active - 1),
        })
        this.active -= 1
        this.activeByAccount.set(item.accountId, Math.max(0, (this.activeByAccount.get(item.accountId) || 1) - 1))
        this.activeByRequestClass.set(
          item.requestClass,
          Math.max(0, this.getActiveRequestCount(item.requestClass) - 1),
        )
        this.pump()
      }
    }

    const abortActive = () => {
      if (settledByAbort) return
      settledByAbort = true
      // The caller can stop waiting immediately, but the admission slot must
      // remain occupied until the in-flight operation settles. Releasing it
      // here would allow a second upstream request while token refresh,
      // upload, or chat creation is still running.
      item.signal?.removeEventListener('abort', abortActive)
      if (!runStarted) {
        this.completeGlobalRecoveryProbe(item, false)
        release()
      } else if (activeStream) {
        destroyForwardStream(activeStream)
      }
      if (!runStarted || !item.waitForActiveSettlementOnAbort) {
        item.resolve(this.createCancelledResult('Client disconnected while Qwen AI request was active.'))
      }
    }

    item.signal?.addEventListener('abort', abortActive, { once: true })
    if (item.signal?.aborted) {
      abortActive()
      return
    }

    runStarted = true
    Promise.resolve()
      .then(() => {
        if (item.signal?.aborted) {
          return this.createCancelledResult('Client disconnected before Qwen AI request started.')
        }
        return item.run()
      })
      .then((result) => {
        if (item.cancelled || item.signal?.aborted) {
          item.signal?.removeEventListener('abort', abortActive)
          activeStream = result.stream
          destroyForwardStream(result.stream)
          this.completeGlobalRecoveryProbe(item, false)
          release()
          item.resolve(this.createCancelledResult('Client disconnected while Qwen AI request was active.'))
          return
        }

        const recordedResult = this.recordResult(item.accountId, result, item.requestClass)
        this.completeGlobalRecoveryProbe(item, recordedResult.success)
        if (recordedResult.success && recordedResult.stream) {
          activeStream = recordedResult.stream
          const releaseStream = () => {
            item.signal?.removeEventListener('abort', abortActive)
            release()
          }
          attachRelease(recordedResult.stream, releaseStream)
          if (item.signal?.aborted) {
            releaseStream()
          }
        } else {
          item.signal?.removeEventListener('abort', abortActive)
          release()
        }
        item.resolve(recordedResult)
      })
      .catch((error) => {
        item.signal?.removeEventListener('abort', abortActive)
        if (settledByAbort || item.signal?.aborted || item.cancelled) {
          this.completeGlobalRecoveryProbe(item, false)
          release()
          item.resolve(this.createCancelledResult('Client disconnected while Qwen AI request was active.'))
          return
        }
        if (isQwenAiAccountFault(error as { accountFault?: unknown } | undefined)) {
          this.openCooldown(item.accountId, this.getConfig().failureCooldownMs, 'exception')
        }
        this.completeGlobalRecoveryProbe(item, false)
        release()
        item.reject(error)
      })
  }

  private logLifecycle(
    item: QueueItem,
    event: 'queue_timeout' | 'request_deadline' | 'admitted' | 'released',
    metrics: Record<string, number>,
  ): void {
    if (!item.requestId) return

    console.info('[QwenAI Governor] lifecycle', JSON.stringify({
      event,
      requestId: item.requestId,
      accountId: item.accountId,
      attempt: item.attempt,
      requestClass: item.requestClass,
      normalActiveRequests: this.getActiveRequestCount('normal'),
      compactionActiveRequests: this.getActiveRequestCount('context_compaction'),
      normalQueuedRequests: this.queue.filter(candidate => candidate.requestClass === 'normal').length,
      compactionQueuedRequests: this.queue.filter(
        candidate => candidate.requestClass === 'context_compaction',
      ).length,
      queueDepthAtEnqueue: item.queueDepthAtEnqueue,
      ...metrics,
    }))
  }

  private getActiveRequestCount(requestClass: QwenAiRequestClass): number {
    return this.activeByRequestClass.get(requestClass) || 0
  }

  private getCompactionConcurrencyLimit(effectiveMaxConcurrent: number): number {
    const maxConcurrent = Math.max(1, Math.floor(effectiveMaxConcurrent))
    return Math.max(1, maxConcurrent - compactionReservedSlots(maxConcurrent))
  }

  private getReadyAt(item: QueueItem, now: number): number {
    const config = this.getEffectiveConfig()
    this.expireCooldown(item.accountId, now)

    return calculateQwenAiRequestReadyAt({
      lastGlobalStartAt: this.lastGlobalStartAt,
      globalMinIntervalMs: config.globalMinIntervalMs,
      accountNextAvailableAt: this.accountNextAvailableAt.get(item.accountId) || 0,
      accountCooldownUntil: this.accountCooldowns.get(item.accountId)?.until || 0,
      recoveryBypassAccountInterval: item.recoveryBypassAccountInterval,
      recoveryBypassGlobalInterval: item.recoveryBypassGlobalInterval,
      accountActive: (this.activeByAccount.get(item.accountId) || 0) > 0,
    })
  }

  private recordResult(
    accountId: string,
    result: ForwardResult,
    requestClass: QwenAiRequestClass = 'normal',
  ): ForwardResult {
    if (result.success) {
      this.accountCooldowns.delete(accountId)
      return result
    }

    // A managed-tool validation failure is produced by the local response
    // parser, not by Qwen capacity. The forwarder performs one bounded
    // recovery attempt, so opening the normal 5xx cooldown here would make
    // that retry sit behind the queue timeout.
    if (result.recoveryHint === 'managed_tool_stream_validation') {
      return result
    }

    // Qwen can keep a completed response branch busy for a short period after
    // the adapter has exhausted its same-payload continuation wait. This is
    // account-neutral (the credentials are fine), but immediately selecting
    // the account again reproduces the provider admission rejection. Apply a
    // deployment-level cooldown without classifying the account as faulty.
    if (result.errorCode?.toUpperCase() === 'CHAT_IN_PROGRESS') {
      const config = this.getConfig()
      const retryAfterMs = parseQwenAiRetryAfterMs(result.headers)
      const cooldownMs = Math.max(config.accountMinIntervalMs, retryAfterMs ?? 0)
      if (cooldownMs > 0) {
        this.openCooldown(accountId, cooldownMs, 'qwen_ai_chat_in_progress')
        return withRetryAfterHeader(result, cooldownMs)
      }
      return result
    }

    if (result.accountFault === false) {
      return result
    }

    if (
      isQwenAiAccountFault(result)
      && isQwenRiskControl(result.error, result.status, result.errorCode)
    ) {
      const config = this.getConfig()
      const current = this.accountCooldowns.get(accountId)
      const failures = (current?.failures || 0) + 1
      const cooldownMs = Math.min(config.riskCooldownMs * (2 ** (failures - 1)), config.maxRiskCooldownMs)
      this.openCooldown(accountId, cooldownMs, 'qwen_ai_risk_control', failures)
      // One context compaction can fan out into correlated map/reduce calls.
      // Keep each affected account out of rotation, but do not mistake those
      // internal calls for independent evidence that ordinary traffic must be
      // stopped globally.
      if (requestClass === 'normal') {
        this.recordGlobalRiskControl(accountId, config, this.getQwenAiAccountScope())
      }
      return result
    }

    // Provider availability/transit failures are not credential evidence. A
    // transient 5xx or ordinary rate limit must stay account-neutral so one
    // flaky upstream response cannot drain the entire account pool and turn
    // the next request into `no_available_account`. Capacity 429 is the
    // deliberate exception: Qwen reports that the account cannot accept the
    // generation, so the forwarder may fail over to another account.
    const capacity429 = isQwenAiAccountFault(result)
      && result.status === 429
      && result.errorCode === 'qwen_ai_capacity_limit'
    if (capacity429) {
      const config = this.getConfig()
      const retryAfterMs = parseQwenAiRetryAfterMs(result.headers)
      const maxCooldownMs = Math.max(config.failureCooldownMs, config.maxRiskCooldownMs)
      const cooldownMs = Math.min(
        maxCooldownMs,
        Math.max(config.failureCooldownMs, retryAfterMs ?? 0),
      )
      const reason = retryAfterMs !== undefined
        ? `http_429_retry_after_${Math.ceil(cooldownMs / 1000)}s`
        : 'qwen_ai_capacity_limit'
      this.openCooldown(accountId, cooldownMs, reason)
      return withRetryAfterHeader(result, cooldownMs)
    }

    return result
  }

  reportDeferredFailure(
    accountId: string,
    result: ForwardResult,
    requestClass: QwenAiRequestClass = 'normal',
  ): void {
    if (result.success) return
    this.recordResult(accountId, result, requestClass)
    this.pump()
  }

  private openCooldown(accountId: string, cooldownMs: number, reason: string, failures?: number): void {
    const now = Date.now()
    const current = this.accountCooldowns.get(accountId)
    this.accountCooldowns.set(accountId, {
      until: now + cooldownMs,
      failures: failures ?? current?.failures ?? 1,
      reason,
    })

    console.warn(
      `[QwenAI Governor] Account ${accountId} cooldown opened for ${Math.ceil(cooldownMs / 1000)}s (${reason})`,
    )
  }

  private recordGlobalRiskControl(
    accountId: string,
    config: QwenAiGovernorConfig,
    accountScope: { accountCount: number; healthyAccountCount: number },
  ): void {
    const now = Date.now()
    this.riskEvents = this.riskEvents
      .filter(event => now - event.timestamp <= config.riskWindowMs)
      .concat({ accountId, timestamp: now })

    const distinctRiskAccounts = new Set(this.riskEvents.map(event => event.accountId)).size
    const poolSize = accountScope.accountCount
    const poolRiskThreshold = poolSize > 0
      ? Math.max(config.globalRiskThreshold, Math.ceil(poolSize * GLOBAL_RISK_POOL_RATIO))
      : config.globalRiskThreshold
    if (
      distinctRiskAccounts < poolRiskThreshold
      || (poolSize > 0 && accountScope.healthyAccountCount > 0)
    ) {
      return
    }

    // Once the circuit is half-open, a failed probe is additional evidence
    // about that account, not a reason to extend the whole pool's cooldown.
    if (this.getGlobalCooldownInMs(now) > 0) return

    const failures = (this.globalCooldown?.failures || 0) + 1
    const cooldownMs = Math.min(
      config.globalRiskCooldownMs * (2 ** (failures - 1)),
      config.maxGlobalRiskCooldownMs,
    )

    console.warn(
      `[QwenAI Governor] Global risk threshold reached (${distinctRiskAccounts}/${poolSize || 'unknown'} risk accounts; `
      + `${accountScope.healthyAccountCount} healthy; threshold ${poolRiskThreshold})`,
    )
    this.openGlobalCooldown(cooldownMs, 'qwen_ai_global_risk_circuit', failures)
  }

  private openGlobalCooldown(cooldownMs: number, reason: string, failures: number): void {
    const now = Date.now()
    this.globalCooldown = {
      until: now + cooldownMs,
      failures,
      reason,
    }
    if (!this.globalRecoveryProbeItemId) this.globalRecoveryNextAt = 0

    console.warn(
      `[QwenAI Governor] Global circuit opened for ${Math.ceil(cooldownMs / 1000)}s (${reason})`,
    )

    this.rejectQueuedRequestsForGlobalCircuit(cooldownMs)
  }

  private expireCooldown(accountId: string, now: number): void {
    const cooldown = this.accountCooldowns.get(accountId)
    if (cooldown && cooldown.until <= now) {
      this.accountCooldowns.delete(accountId)
    }
  }

  private expireGlobalCooldown(now: number): void {
    if (this.globalCooldown && this.globalCooldown.until <= now) {
      this.globalCooldown = undefined
      if (!this.globalRecoveryProbeItemId) this.globalRecoveryNextAt = 0
      this.riskEvents = this.riskEvents.filter(event => now - event.timestamp <= this.getConfig().riskWindowMs)
    }
  }

  private getGlobalCooldownInMs(now: number): number {
    return Math.max(0, (this.globalCooldown?.until || 0) - now)
  }

  private getGlobalRecoveryIntervalMs(): number {
    return Math.max(1000, this.getEffectiveConfig().globalMinIntervalMs)
  }

  private canStartGlobalRecoveryProbe(
    accountId: string,
    requestClass: QwenAiRequestClass,
    now: number,
  ): boolean {
    if (
      requestClass !== 'normal'
      || this.globalCooldown?.reason !== 'qwen_ai_global_risk_circuit'
      || this.globalRecoveryProbeItemId
      || now < this.globalRecoveryNextAt
    ) {
      return false
    }

    this.expireCooldown(accountId, now)
    return (
      (this.activeByAccount.get(accountId) || 0) === 0
      && !this.queue.some(item => item.accountId === accountId && !item.cancelled)
      && (this.accountNextAvailableAt.get(accountId) || 0) <= now
      && (this.accountCooldowns.get(accountId)?.until || 0) <= now
    )
  }

  private getGlobalRecoveryWaitMs(now: number, globalCooldownInMs: number): number {
    const recoveryWaitMs = this.globalRecoveryProbeItemId
      ? this.getGlobalRecoveryIntervalMs()
      : Math.max(0, this.globalRecoveryNextAt - now)
    return Math.min(
      globalCooldownInMs,
      Math.max(1000, recoveryWaitMs || this.getGlobalRecoveryIntervalMs()),
    )
  }

  private completeGlobalRecoveryProbe(item: QueueItem, success: boolean): void {
    if (!item.globalRecoveryProbe || this.globalRecoveryProbeItemId !== item.id) return

    this.globalRecoveryProbeItemId = undefined
    this.globalRecoveryProbeAccountId = undefined
    if (success) {
      this.globalCooldown = undefined
      this.globalRecoveryNextAt = 0
      console.warn('[QwenAI Governor] Global circuit closed after a successful half-open probe')
      return
    }

    if (this.getGlobalCooldownInMs(Date.now()) > 0) {
      this.globalRecoveryNextAt = Date.now() + this.getGlobalRecoveryIntervalMs()
    }
  }

  private createGlobalCircuitOpenResult(waitMs: number): ForwardResult {
    const retryAfterSeconds = Math.max(1, Math.ceil(waitMs / 1000))
    return {
      success: false,
      status: 429,
      headers: {
        'Retry-After': String(retryAfterSeconds),
      },
      error: `Qwen AI global risk circuit is open; retry after ${retryAfterSeconds}s`,
      errorCode: 'qwen_ai_global_risk_circuit',
      retryable: false,
      accountFault: false,
    }
  }

  private rejectQueuedRequestsForGlobalCircuit(
    waitMs: number,
    preserveGlobalRecoveryProbe = false,
  ): void {
    if (this.queue.length === 0) return

    const queued = preserveGlobalRecoveryProbe
      ? this.queue.filter(item => !item.globalRecoveryProbe)
      : this.queue.slice()
    this.queue = preserveGlobalRecoveryProbe
      ? this.queue.filter(item => item.globalRecoveryProbe)
      : []
    const result = this.createGlobalCircuitOpenResult(waitMs)
    for (const item of queued) {
      item.cancelled = true
      this.clearQueueItemWaiters(item)
      this.completeGlobalRecoveryProbe(item, false)
      item.resolve(item.signal?.aborted
        ? this.createCancelledResult('Client disconnected while Qwen AI request was queued.')
        : { ...result })
    }
  }

  private getConfig(): QwenAiGovernorConfig {
    try {
      const config = storeManager.getConfig().qwenAiGovernorConfig || {}
      const persistedConfig = normalizeQwenAiGovernorConfig({
        ...ENV_DEFAULT_CONFIG,
        ...config,
        autoTuneEnabled: config.autoTuneEnabled ?? ENV_DEFAULT_CONFIG.autoTuneEnabled,
        autoTuneMaxConcurrent: config.autoTuneMaxConcurrent ?? ENV_DEFAULT_CONFIG.autoTuneMaxConcurrent,
        autoTuneMinGlobalIntervalMs: Math.max(
          0,
          config.autoTuneMinGlobalIntervalMs ?? ENV_DEFAULT_CONFIG.autoTuneMinGlobalIntervalMs,
        ),
        maxConcurrent: config.maxConcurrent ?? ENV_DEFAULT_CONFIG.maxConcurrent,
        globalRiskThreshold: config.globalRiskThreshold ?? ENV_DEFAULT_CONFIG.globalRiskThreshold,
      })
      return applyExplicitEnvironmentOverrides(persistedConfig)
    } catch {
      return applyExplicitEnvironmentOverrides(ENV_DEFAULT_CONFIG)
    }
  }

  private getRecentRiskEventCount(config: QwenAiGovernorConfig, now: number): number {
    return this.riskEvents
      .filter(event => now - event.timestamp <= config.riskWindowMs)
      .length
  }

  private getRecentRiskAccountCount(config: QwenAiGovernorConfig, now: number): number {
    return new Set(
      this.riskEvents
        .filter(event => now - event.timestamp <= config.riskWindowMs)
        .map(event => event.accountId),
    ).size
  }

  private getQwenAiAccountScope(loadBalancerFailures: Record<string, {
    count: number
    lastFailTime: number
    cooldownUntil?: number
    recoveryUntil?: number
    reason?: string
  }> = {}): {
    accountCount: number
    healthyAccountCount: number
    coolingAccountCount: number
  } {
    const now = Date.now()
    const providers = storeManager.getProviders()
    const qwenAiProviderIds = providers
      .filter(provider => provider.id === 'qwen-ai' || provider.apiEndpoint.includes('chat.qwen.ai'))
      .map(provider => provider.id)

    const accounts = storeManager.getAccounts()
      .filter(account => qwenAiProviderIds.includes(account.providerId))
      .filter(account => isConfiguredActiveStatus(account.status))

    let healthyAccountCount = 0
    let coolingAccountCount = 0

    for (const account of accounts) {
      this.expireCooldown(account.id, now)
      const governorCooldownInMs = Math.max(0, (this.accountCooldowns.get(account.id)?.until || 0) - now)
      const loadBalancerCooldownInMs = Math.max(0, (loadBalancerFailures[account.id]?.cooldownUntil || 0) - now)

      if (governorCooldownInMs > 0 || loadBalancerCooldownInMs > 0) {
        coolingAccountCount += 1
      } else {
        healthyAccountCount += 1
      }
    }

    return {
      accountCount: accounts.length,
      healthyAccountCount,
      coolingAccountCount,
    }
  }

  private calculateEffectiveConfig(
    config: QwenAiGovernorConfig,
    options: {
      accountCount: number
      healthyAccountCount: number
      coolingAccountCount: number
      recentRiskEvents: number
      recentRiskAccounts: number
    },
  ): QwenAiGovernorEffectiveConfig {
    const configuredMaxConcurrent = Math.max(1, config.maxConcurrent)
    const configuredGlobalMinIntervalMs = Math.max(0, config.globalMinIntervalMs)
    const adaptiveLimits = calculateQwenAiAdaptiveLimits({
      autoTuneEnabled: config.autoTuneEnabled,
      autoTuneMaxConcurrent: config.autoTuneMaxConcurrent,
      autoTuneMinGlobalIntervalMs: config.autoTuneMinGlobalIntervalMs,
      configuredMaxConcurrent,
      configuredGlobalMinIntervalMs,
      accountMinIntervalMs: config.accountMinIntervalMs,
      accountCount: options.accountCount,
      healthyAccountCount: options.healthyAccountCount,
      recentRiskEvents: options.recentRiskEvents,
      recentRiskAccountCount: options.recentRiskAccounts,
    })

    return {
      ...config,
      maxConcurrent: adaptiveLimits.maxConcurrent,
      globalMinIntervalMs: adaptiveLimits.globalMinIntervalMs,
      configuredMaxConcurrent,
      configuredGlobalMinIntervalMs,
      healthyAccountCount: options.healthyAccountCount,
      coolingAccountCount: options.coolingAccountCount,
      autoTuneReason: adaptiveLimits.autoTuneReason,
    }
  }

  private getEffectiveConfig(loadBalancerFailures?: Record<string, {
    count: number
    lastFailTime: number
    cooldownUntil?: number
    recoveryUntil?: number
    reason?: string
  }>): QwenAiGovernorEffectiveConfig {
    const config = this.getConfig()
    const now = Date.now()
    const accountScope = this.getQwenAiAccountScope(loadBalancerFailures)

    return this.calculateEffectiveConfig(config, {
      accountCount: accountScope.accountCount,
      healthyAccountCount: accountScope.healthyAccountCount,
      coolingAccountCount: accountScope.coolingAccountCount,
      recentRiskEvents: this.getRecentRiskEventCount(config, now),
      recentRiskAccounts: this.getRecentRiskAccountCount(config, now),
    })
  }

  getConfiguredConfig(): QwenAiGovernorConfig {
    return { ...this.getConfig() }
  }

  isAccountImmediatelyAvailable(accountId: string, now = Date.now()): boolean {
    this.expireGlobalCooldown(now)
    this.expireCooldown(accountId, now)
    const accountReady = (
      (this.activeByAccount.get(accountId) || 0) === 0
      && !this.queue.some(item => item.accountId === accountId && !item.cancelled)
      && (this.accountNextAvailableAt.get(accountId) || 0) <= now
      && (this.accountCooldowns.get(accountId)?.until || 0) <= now
    )
    if (!accountReady) return false
    if (this.getGlobalCooldownInMs(now) === 0) return true
    return this.canStartGlobalRecoveryProbe(accountId, 'normal', now)
  }

  getStatus(
    accounts: Account[],
    providers: Provider[],
    loadBalancerFailures: Record<string, {
      count: number
      lastFailTime: number
      cooldownUntil?: number
      recoveryUntil?: number
      reason?: string
    }> = {},
  ): QwenAiGovernorStatus {
    const now = Date.now()
    const config = this.getConfig()
    const effectiveConfig = this.getEffectiveConfig(loadBalancerFailures)
    this.expireGlobalCooldown(now)
    const globalCooldownUntil = this.globalCooldown?.until || 0
    const globalNextAvailableAt = Math.max(
      this.lastGlobalStartAt + effectiveConfig.globalMinIntervalMs,
      globalCooldownUntil,
    )
    const providerById = new Map(providers.map(provider => [provider.id, provider]))
    const recentRiskEvents = this.getRecentRiskEventCount(config, now)
    const recentRiskAccounts = this.getRecentRiskAccountCount(config, now)

    const accountStatuses = accounts.map(account => {
      this.expireCooldown(account.id, now)
      const governorCooldown = this.accountCooldowns.get(account.id)
      const loadBalancerFailure = loadBalancerFailures[account.id]
      const loadBalancerFailuresCount = loadBalancerFailure?.count || 0
      const recentFailover = this.recentFailovers.get(account.id)
      const accountNextAvailableAt = this.accountNextAvailableAt.get(account.id) || 0
      const readyAt = Math.max(
        globalNextAvailableAt,
        accountNextAvailableAt,
        governorCooldown?.until || 0,
        loadBalancerFailure?.cooldownUntil || 0,
      )
      const provider = providerById.get(account.providerId)

      return {
        accountId: account.id,
        accountName: account.name,
        providerId: account.providerId,
        providerName: provider?.name || account.providerId,
        status: account.status,
        queuedRequests: this.queue.filter(item => item.accountId === account.id).length,
        activeRequests: this.activeByAccount.get(account.id) || 0,
        nextAvailableAt: readyAt > now ? readyAt : undefined,
        nextAvailableInMs: Math.max(0, readyAt - now),
        governorCooldownUntil: governorCooldown && governorCooldown.until > now ? governorCooldown.until : undefined,
        governorCooldownInMs: Math.max(0, (governorCooldown?.until || 0) - now),
        governorCooldownReason: governorCooldown?.reason,
        governorFailures: governorCooldown?.failures || 0,
        loadBalancerCooldownUntil:
          loadBalancerFailure?.cooldownUntil && loadBalancerFailure.cooldownUntil > now
            ? loadBalancerFailure.cooldownUntil
            : undefined,
        loadBalancerCooldownInMs: Math.max(0, (loadBalancerFailure?.cooldownUntil || 0) - now),
        loadBalancerRecoveryUntil:
          loadBalancerFailure?.recoveryUntil && loadBalancerFailure.recoveryUntil > now
            ? loadBalancerFailure.recoveryUntil
            : undefined,
        loadBalancerRecoveryInMs: Math.max(0, (loadBalancerFailure?.recoveryUntil || 0) - now),
        loadBalancerReason:
          loadBalancerFailure?.reason || (loadBalancerFailuresCount > 0 ? 'request_failure' : undefined),
        loadBalancerFailures: loadBalancerFailuresCount,
        recentFailover: recentFailover ? { ...recentFailover } : undefined,
      }
    })

    const normalActiveRequests = this.getActiveRequestCount('normal')
    const compactionActiveRequests = this.getActiveRequestCount('context_compaction')
    const normalQueuedRequests = this.queue.filter(item => item.requestClass === 'normal').length
    const compactionQueuedRequests = this.queue.filter(
      item => item.requestClass === 'context_compaction',
    ).length
    const compactionMaxConcurrent = this.getCompactionConcurrencyLimit(
      effectiveConfig.maxConcurrent,
    )

    return {
      config,
      effectiveConfig,
      queueSize: this.queue.length,
      normalActiveRequests,
      compactionActiveRequests,
      normalQueuedRequests,
      compactionQueuedRequests,
      compactionMaxConcurrent,
      normalReservedSlots: Math.max(0, effectiveConfig.maxConcurrent - compactionMaxConcurrent),
      activeRequests: this.active,
      globalNextAvailableAt: globalNextAvailableAt > now ? globalNextAvailableAt : undefined,
      globalNextAvailableInMs: Math.max(0, globalNextAvailableAt - now),
      globalCooldownUntil:
        this.globalCooldown?.until && this.globalCooldown.until > now ? this.globalCooldown.until : undefined,
      globalCooldownInMs: this.getGlobalCooldownInMs(now),
      globalCooldownReason: this.globalCooldown?.reason,
      globalFailures: this.globalCooldown?.failures || 0,
      globalRecoveryProbeActive: Boolean(this.globalRecoveryProbeItemId),
      globalRecoveryProbeAccountId: this.globalRecoveryProbeAccountId,
      globalRecoveryNextAt:
        this.globalRecoveryNextAt > now ? this.globalRecoveryNextAt : undefined,
      globalRecoveryNextInMs: Math.max(0, this.globalRecoveryNextAt - now),
      recentRiskEvents,
      recentRiskAccounts,
      accounts: accountStatuses,
    }
  }

  reportAccountFailover(
    accountId: string,
    record: Omit<QwenAiAccountFailoverRecord, 'timestamp'> & { timestamp?: number },
  ): void {
    const nextRecord: QwenAiAccountFailoverRecord = {
      ...record,
      timestamp: record.timestamp ?? Date.now(),
    }
    const nextFailovers = new Map(this.recentFailovers)
    nextFailovers.set(accountId, nextRecord)
    this.recentFailovers = nextFailovers
  }

  clearAccountCooldown(accountId: string): void {
    this.accountCooldowns.delete(accountId)
    this.accountNextAvailableAt.delete(accountId)
    this.pump()
  }

  clearAllCooldowns(): void {
    this.accountCooldowns.clear()
    this.accountNextAvailableAt.clear()
    this.globalCooldown = undefined
    this.globalRecoveryProbeItemId = undefined
    this.globalRecoveryProbeAccountId = undefined
    this.globalRecoveryNextAt = 0
    this.riskEvents = []
    this.pump()
  }
}

export const qwenAiRequestGovernor = new QwenAiRequestGovernor()
