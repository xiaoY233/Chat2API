/**
 * Temporarily unavailable models.
 *
 * A model can be pinned as temporarily unavailable on its provider without
 * removing it from `supportedModels` or `modelMappings`: the route and its
 * pricing/catalog entry stay wired, but requests fail fast with the same 503
 * shape the gateway already uses when no account can serve a model.
 *
 * Recovery is automatic. While a model is gated, the manager re-checks it with
 * a bare no-system call (no tools, no prompt engineering, `stream: false`) and
 * lifts the gate only when the provider returns a non-empty answer. Checks are
 * rate-limited per model and deduplicated, and a request for a gated model
 * triggers an out-of-band check so traffic can restore it sooner than the
 * periodic sweep.
 */

import { storeManager } from '../store/store'
import type { Provider } from '../store/types'
import { loadBalancer } from './loadbalancer'
import { requestForwarder } from './forwarder'
import type { ChatCompletionRequest, ForwardResult, ProxyContext } from './types'

/** A probe must not hold a slot for the full upstream timeout. */
const PROBE_TIMEOUT_MS = 60_000
/** Periodic recovery sweep for gated models. */
const PERIODIC_CHECK_MS = 10 * 60_000
/** Never probe the same model more than once a minute, whatever the traffic. */
const PROBE_COOLDOWN_MS = 60_000
/** Let the proxy settle before the first sweep. */
const STARTUP_DELAY_MS = 20_000
/** The probe is intentionally minimal: the failure mode is empty answers. */
const PROBE_PROMPT = 'ping'

export function gateKey(model: string): string {
  return model.trim().toLowerCase()
}

function messageText(message: unknown): string {
  if (!message || typeof message !== 'object') return ''
  const content = (message as { content?: unknown }).content
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === 'string') return part
        if (part && typeof part === 'object' && typeof (part as { text?: unknown }).text === 'string') {
          return (part as { text: string }).text
        }
        return ''
      })
      .join('')
  }
  return ''
}

function hasToolCalls(message: unknown): boolean {
  if (!message || typeof message !== 'object') return false
  const calls = (message as { tool_calls?: unknown }).tool_calls
  return Array.isArray(calls) && calls.length > 0
}

/**
 * A probe only proves recovery when the model actually answered. Successful
 * HTTP responses with empty content are exactly the failure this gate exists
 * for, so they must not restore it.
 */
export function isVerifiedReply(result: ForwardResult): boolean {
  if (!result.success) return false
  const body = result.body as
    | { choices?: Array<{ message?: unknown }> }
    | undefined
  const message = body?.choices?.[0]?.message
  return messageText(message).trim().length > 0 || hasToolCalls(message)
}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)
    timer.unref?.()
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (error) => {
        clearTimeout(timer)
        reject(error)
      }
    )
  })
}

export interface TemporaryUnavailability {
  providerId: string
  providerName: string
  model: string
}

export class ModelAvailabilityManager {
  private timer: NodeJS.Timeout | null = null
  private startupTimer: NodeJS.Timeout | null = null
  private readonly inFlight = new Map<string, Promise<boolean>>()
  private readonly lastProbeAt = new Map<string, number>()

  start(): void {
    if (this.timer) return
    this.startupTimer = setTimeout(() => {
      this.startupTimer = null
      void this.verifyGatedModels()
    }, STARTUP_DELAY_MS)
    this.startupTimer.unref?.()
    this.timer = setInterval(() => {
      void this.verifyGatedModels()
    }, PERIODIC_CHECK_MS)
    this.timer.unref?.()
  }

  stop(): void {
    if (this.startupTimer) {
      clearTimeout(this.startupTimer)
      this.startupTimer = null
    }
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
  }

  private aliasesFor(model: string, provider?: Provider): Set<string> {
    const aliases = new Set<string>([gateKey(model)])
    const providerMapping = provider?.modelMappings?.[model]
    if (providerMapping) aliases.add(gateKey(providerMapping))
    const configMapping = storeManager.getConfig().modelMappings?.[model]
    if (configMapping?.actualModel) aliases.add(gateKey(configMapping.actualModel))
    return aliases
  }

  private matchesGatedModel(requested: string, provider: Provider, gatedModel: string): boolean {
    const requestedAliases = this.aliasesFor(requested)
    const gatedAliases = this.aliasesFor(gatedModel, provider)
    for (const [publicId, actualId] of Object.entries(provider.modelMappings ?? {})) {
      if (gateKey(actualId) === gateKey(gatedModel)) gatedAliases.add(gateKey(publicId))
      if (gateKey(publicId) === gateKey(gatedModel)) gatedAliases.add(gateKey(actualId))
    }
    for (const alias of Array.from(requestedAliases)) {
      if (gatedAliases.has(alias)) return true
    }
    return false
  }

  /** The gate covering a requested model, or null when it may be served. */
  findGate(model: string): TemporaryUnavailability | null {
    for (const provider of storeManager.getProviders()) {
      if (!provider.enabled) continue
      for (const gatedModel of provider.temporarilyUnavailableModels ?? []) {
        if (this.matchesGatedModel(model, provider, gatedModel)) {
          return { providerId: provider.id, providerName: provider.name, model: gatedModel }
        }
      }
    }
    return null
  }

  isTemporarilyUnavailable(model: string): boolean {
    return this.findGate(model) !== null
  }

  /**
   * Ask for an out-of-band recovery check without delaying the caller. The
   * cooldown lives in `verify`, so request floods cannot hammer the upstream.
   */
  requestVerification(model: string): void {
    const gate = this.findGate(model)
    if (!gate) return
    void this.verify(gate.providerId, gate.model)
  }

  async verifyGatedModels(): Promise<void> {
    const gates: TemporaryUnavailability[] = []
    for (const provider of storeManager.getProviders()) {
      if (!provider.enabled) continue
      for (const model of provider.temporarilyUnavailableModels ?? []) {
        gates.push({ providerId: provider.id, providerName: provider.name, model })
      }
    }
    for (const gate of gates) {
      await this.verify(gate.providerId, gate.model)
    }
  }

  /**
   * Run one bare, no-system verification call and lift the gate only when the
   * provider returns content. Returns true when the model was restored.
   */
  async verify(providerId: string, model: string): Promise<boolean> {
    const key = `${providerId}:${gateKey(model)}`
    const running = this.inFlight.get(key)
    if (running) return running

    const last = this.lastProbeAt.get(key) ?? 0
    if (Date.now() - last < PROBE_COOLDOWN_MS) return false
    this.lastProbeAt.set(key, Date.now())

    const probe = this.runProbe(providerId, model).finally(() => {
      this.inFlight.delete(key)
    })
    this.inFlight.set(key, probe)
    return probe
  }

  private async runProbe(providerId: string, model: string): Promise<boolean> {
    const provider = storeManager.getProviderById(providerId)
    if (!provider || !provider.enabled) return false

    const config = storeManager.getConfig()
    const selection = loadBalancer.selectAccount(
      model,
      config.loadBalanceStrategy,
      providerId
    )
    if (!selection) {
      console.log(`[ModelAvailability] Cannot verify ${model}: no available account`)
      return false
    }

    const startedAt = Date.now()
    const context: ProxyContext = {
      requestId: `probe-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      providerId,
      accountId: selection.account.id,
      model,
      actualModel: selection.actualModel,
      startTime: startedAt,
      isStream: false,
      clientIP: '127.0.0.1',
    }
    const request: ChatCompletionRequest = {
      model,
      messages: [{ role: 'user', content: PROBE_PROMPT }],
      stream: false,
      max_tokens: 16,
      // Health probes must not leave a chat behind on the account.
      deleteSession: true,
    }

    try {
      const result = await withTimeout(
        requestForwarder.forwardChatCompletion(
          request,
          selection.account,
          provider,
          selection.actualModel,
          context
        ),
        PROBE_TIMEOUT_MS,
        `verification of ${model}`
      )

      if (isVerifiedReply(result)) {
        this.restore(providerId, model)
        storeManager.addLog('info', `Model verified and restored: ${model}`, {
          providerId,
          data: { latency: Date.now() - startedAt },
        })
        return true
      }

      console.warn(
        `[ModelAvailability] ${model} still unavailable:`,
        result.success ? 'empty answer' : result.error || 'request failed'
      )
      return false
    } catch (error) {
      console.warn(
        `[ModelAvailability] ${model} verification failed:`,
        error instanceof Error ? error.message : error
      )
      return false
    }
  }

  private restore(providerId: string, model: string): void {
    const provider = storeManager.getProviderById(providerId)
    if (!provider) return
    const remaining = (provider.temporarilyUnavailableModels ?? []).filter(
      (entry) => gateKey(entry) !== gateKey(model)
    )
    storeManager.updateProvider(providerId, { temporarilyUnavailableModels: remaining })
    console.log(`[ModelAvailability] Restored ${model} on ${provider.name}`)
  }

  /** Pin a model as temporarily unavailable (kept for ops and future checks). */
  markUnavailable(providerId: string, model: string): void {
    const provider = storeManager.getProviderById(providerId)
    if (!provider) return
    const current = provider.temporarilyUnavailableModels ?? []
    if (current.some((entry) => gateKey(entry) === gateKey(model))) return
    storeManager.updateProvider(providerId, {
      temporarilyUnavailableModels: [...current, model],
    })
    console.log(`[ModelAvailability] Gated ${model} on ${provider.name}`)
  }
}

export const modelAvailability = new ModelAvailabilityManager()

export default modelAvailability
