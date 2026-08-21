/**
 * Proxy Service Module - Load Balancer
 * Implements Round Robin and Fill First strategies
 */

import { Account, Provider, LoadBalanceStrategy } from '../store/types'
import { AccountSelection } from './types'
import { storeManager } from '../store/store'
import { normalizeProviderModelForMatch } from './adapters/providerModelOptions'
import { hasQwenAiSessionCookie } from './adapters/qwen-ai-token-refresh'
import { qwenAiRequestGovernor } from './qwenAiRequestGovernor'

const LOAD_BALANCER_DEBUG = process.env.CHAT2API_LOAD_BALANCER_DEBUG === 'true'

export interface AccountSelectionConstraints {
  /** Keep one failover chain inside accounts with an established Qwen web session. */
  qwenAiWebSessionTier?: 'complete'
  /**
   * A retained Qwen chat is valid only for its creating account. Let the
   * governor queue that account instead of silently selecting another one.
   */
  allowQueuedQwenAiPreferredAccount?: boolean
}

type AccountFailureState = {
  count: number
  lastFailTime: number
  cooldownUntil?: number
  reason?: string
}

export type AccountFailureSnapshot = AccountFailureState & {
  recoveryUntil?: number
}

function debugLoadBalancer(message: string): void {
  if (LOAD_BALANCER_DEBUG) console.log(message)
}

/**
 * Load Balancer
 */
export class LoadBalancer {
  private roundRobinIndex: Map<string, number> = new Map()
  private failedAccounts: Map<string, AccountFailureState> = new Map()
  private static readonly FAIL_THRESHOLD = 1
  private static readonly RECOVERY_TIME = 60000 // 1 minute
  private static readonly QWEN_AI_RISK_COOLDOWN = 10 * 60 * 1000

  /**
   * Mark account as failed
   */
  markAccountFailed(accountId: string): void {
    const current = this.failedAccounts.get(accountId) || { count: 0, lastFailTime: 0 }
    this.failedAccounts.set(accountId, {
      count: current.count + 1,
      lastFailTime: Date.now(),
      cooldownUntil: current.cooldownUntil,
      reason: current.reason || 'request_failure',
    })
  }

  markAccountCooldown(accountId: string, cooldownMs: number, reason: string): void {
    const current = this.failedAccounts.get(accountId) || { count: 0, lastFailTime: 0 }
    this.failedAccounts.set(accountId, {
      count: current.count + 1,
      lastFailTime: Date.now(),
      cooldownUntil: Date.now() + cooldownMs,
      reason,
    })
    console.warn(`[LoadBalancer] Account ${accountId} cooled down for ${Math.ceil(cooldownMs / 1000)}s: ${reason}`)
  }

  markQwenAiRiskControl(accountId: string): void {
    this.markAccountCooldown(accountId, LoadBalancer.QWEN_AI_RISK_COOLDOWN, 'qwen_ai_risk_control')
  }

  /**
   * Clear account failure status
   */
  clearAccountFailure(accountId: string): void {
    this.failedAccounts.delete(accountId)
  }

  clearAllAccountFailures(): void {
    this.failedAccounts.clear()
  }

  getAccountFailureSnapshot(): Record<string, AccountFailureSnapshot> {
    const now = Date.now()
    const snapshot: Record<string, AccountFailureSnapshot> = {}

    this.failedAccounts.forEach((failure, accountId) => {
      if (failure.cooldownUntil && failure.cooldownUntil <= now) {
        this.failedAccounts.delete(accountId)
        return
      }

      if (!failure.cooldownUntil && now - failure.lastFailTime > LoadBalancer.RECOVERY_TIME) {
        this.failedAccounts.delete(accountId)
        return
      }

      snapshot[accountId] = {
        ...failure,
        ...(!failure.cooldownUntil
          ? { recoveryUntil: failure.lastFailTime + LoadBalancer.RECOVERY_TIME }
          : {}),
      }
    })

    return snapshot
  }

  /**
   * Check if account is in failure state
   */
  private isAccountInFailure(accountId: string): boolean {
    const failure = this.failedAccounts.get(accountId)
    if (!failure) return false

    const now = Date.now()
    if (failure.cooldownUntil && failure.cooldownUntil > now) {
      return true
    }

    if (failure.cooldownUntil && failure.cooldownUntil <= now) {
      this.failedAccounts.delete(accountId)
      return false
    }

    if (now - failure.lastFailTime > LoadBalancer.RECOVERY_TIME) {
      this.failedAccounts.delete(accountId)
      return false
    }

    return failure.count >= LoadBalancer.FAIL_THRESHOLD
  }

  private isAccountInHardCooldown(accountId: string): boolean {
    const failure = this.failedAccounts.get(accountId)
    if (!failure?.cooldownUntil) return false

    if (failure.cooldownUntil <= Date.now()) {
      this.failedAccounts.delete(accountId)
      return false
    }

    return true
  }

  /**
   * Select account
   * @param model Requested model
   * @param strategy Load balance strategy
   * @param preferredProviderId Preferred provider ID
   * @param preferredAccountId Preferred account ID
   */
  selectAccount(
    model: string,
    strategy: LoadBalanceStrategy = 'round-robin',
    preferredProviderId?: string,
    preferredAccountId?: string,
    excludedAccountIds: ReadonlySet<string> = new Set(),
    constraints: AccountSelectionConstraints = {},
  ): AccountSelection | null {
    let candidates = this.getAvailableAccounts(
      model,
      preferredProviderId,
      true,
      excludedAccountIds,
    )

    if (constraints.qwenAiWebSessionTier === 'complete') {
      candidates = candidates.filter(candidate => this.hasCompleteQwenAiWebSession(candidate))
    }

    if (candidates.length === 0) {
      candidates = this.getAvailableAccounts(
        model,
        preferredProviderId,
        false,
        excludedAccountIds,
      )
      if (constraints.qwenAiWebSessionTier === 'complete') {
        candidates = candidates.filter(candidate => this.hasCompleteQwenAiWebSession(candidate))
      }
    }

    if (candidates.length === 0) {
      return null
    }

    if (preferredAccountId) {
      const preferred = candidates.find(c => c.account.id === preferredAccountId)
      if (
        preferred
        && !this.isAccountInFailure(preferredAccountId)
        && (
          !this.isQwenAiProvider(preferred.provider)
          || constraints.allowQueuedQwenAiPreferredAccount === true
          || qwenAiRequestGovernor.isAccountImmediatelyAvailable(preferredAccountId)
        )
      ) {
        return preferred
      }
    }

    if (constraints.qwenAiWebSessionTier !== 'complete') {
      const sessionReadyCandidates = candidates.filter(candidate => (
        !this.hasIncompleteQwenAiWebSession(candidate)
      ))
      if (sessionReadyCandidates.length > 0) {
        candidates = sessionReadyCandidates
      }
    }

    const immediatelyAvailable = candidates.filter(candidate => (
      !this.isQwenAiProvider(candidate.provider)
      || qwenAiRequestGovernor.isAccountImmediatelyAvailable(candidate.account.id)
    ))
    if (immediatelyAvailable.length > 0) {
      candidates = immediatelyAvailable
    }

    if (strategy === 'fill-first') {
      return this.selectFillFirst(candidates)
    }

    if (strategy === 'failover') {
      return this.selectFailover(candidates)
    }

    return this.selectRoundRobin(candidates)
  }

  /**
   * Get available accounts list
   */
  private getAvailableAccounts(
    model: string,
    preferredProviderId?: string,
    excludeFailed: boolean = false,
    excludedAccountIds: ReadonlySet<string> = new Set(),
  ): AccountSelection[] {
    const providers = storeManager.getProviders().filter(p => p.enabled)
    const candidates: AccountSelection[] = []

    for (const provider of providers) {
      if (preferredProviderId && provider.id !== preferredProviderId) {
        continue
      }

      if (!this.providerSupportsModel(provider, model)) {
        continue
      }

      const accounts = storeManager.getAccountsByProviderId(provider.id, true)
        .filter(account => this.isAccountAvailable(account))
        .filter(account => !excludedAccountIds.has(account.id))
        .filter(account => !this.isAccountInHardCooldown(account.id))
        .filter(account => !excludeFailed || !this.isAccountInFailure(account.id))

      debugLoadBalancer(`[LoadBalancer] Provider ${provider.name} (${provider.id}) has ${accounts.length} available accounts`)

      for (const account of accounts) {
        debugLoadBalancer(`[LoadBalancer] Account ${account.name} (${account.id}) selected as candidate`)
        candidates.push({
          account,
          provider,
          actualModel: this.mapModel(model, provider),
        })
      }
    }

    return candidates
  }

  /**
   * Check if provider supports model
   */
  private providerSupportsModel(provider: Provider, model: string): boolean {
    const effectiveModels = storeManager.getEffectiveModels(provider.id)
    if (effectiveModels.length === 0) {
      return true
    }

    const normalizedModel = this.normalizeModelForProviderMatch(model).toLowerCase()
    const supported = effectiveModels.some(m => {
      const normalizedSupported = this.normalizeModelForProviderMatch(m.displayName).toLowerCase()
      const normalizedActualModel = this.normalizeModelForProviderMatch(m.actualModelId).toLowerCase()
      if (normalizedSupported.endsWith('*')) {
        return normalizedModel.startsWith(normalizedSupported.slice(0, -1))
      }
      return normalizedSupported === normalizedModel || normalizedActualModel === normalizedModel
    })
    
    if (supported) {
      return true
    }

    const config = storeManager.getConfig()
    const globalMapping = config.modelMappings[model]
    if (globalMapping) {
      if (globalMapping.preferredProviderId) {
        if (globalMapping.preferredProviderId === provider.id) {
          debugLoadBalancer(`[LoadBalancer] Model "${model}" matched preferred provider ${provider.name}`)
          return true
        }
        return false
      }
      
      const actualModel = globalMapping.actualModel
      const normalizedActualModel = this.normalizeModelForProviderMatch(actualModel).toLowerCase()
      const actualSupported = effectiveModels.some(m => {
        const normalizedSupported = this.normalizeModelForProviderMatch(m.displayName).toLowerCase()
        const normalizedSupportedActual = this.normalizeModelForProviderMatch(m.actualModelId).toLowerCase()
        if (normalizedSupported.endsWith('*')) {
          return normalizedActualModel.startsWith(normalizedSupported.slice(0, -1))
        }
        return normalizedSupported === normalizedActualModel
          || normalizedSupportedActual === normalizedActualModel
      })
      
      if (actualSupported) {
      debugLoadBalancer(`[LoadBalancer] Model "${model}" (actualModel: "${actualModel}") supported by ${provider.name}`)
        return true
      }
    }

    debugLoadBalancer(`[LoadBalancer] Provider ${provider.name} does not support model ${model}`)
    return false
  }

  private normalizeModelForProviderMatch(model: string): string {
    return normalizeProviderModelForMatch(model)
  }

  private isQwenAiProvider(provider: Provider): boolean {
    return provider.id === 'qwen-ai' || provider.apiEndpoint.includes('chat.qwen.ai')
  }

  hasCompleteQwenAiWebSession(candidate: AccountSelection): boolean {
    if (!this.isQwenAiProvider(candidate.provider)) return false

    const credentials = candidate.account.credentials || {}
    const cookies = String(credentials.cookies || credentials.cookie || '').trim()
    return hasQwenAiSessionCookie(cookies)
  }

  private hasIncompleteQwenAiWebSession(candidate: AccountSelection): boolean {
    if (!this.isQwenAiProvider(candidate.provider)) return false

    const credentials = candidate.account.credentials || {}
    const cookies = String(credentials.cookies || credentials.cookie || '').trim()
    return Boolean(cookies && !hasQwenAiSessionCookie(cookies))
  }

  /**
   * Check if account is available
   */
  private isAccountAvailable(account: Account): boolean {
    if (account.status !== 'active') {
      return false
    }

    if (account.dailyLimit && account.todayUsed && account.todayUsed >= account.dailyLimit) {
      return false
    }

    return true
  }

  /**
   * Map model name
   */
  private mapModel(model: string, provider: Provider): string {
    debugLoadBalancer(`[LoadBalancer] mapModel called with model="${model}", provider="${provider.name}"`)
    
    const effectiveModels = storeManager.getEffectiveModels(provider.id)
    const normalizedModel = this.normalizeModelForProviderMatch(model).toLowerCase()
    const effectiveModel = effectiveModels.find(m =>
      this.normalizeModelForProviderMatch(m.displayName).toLowerCase() === normalizedModel
      || this.normalizeModelForProviderMatch(m.actualModelId).toLowerCase() === normalizedModel
    )
    
    if (effectiveModel) {
      debugLoadBalancer(`[LoadBalancer] Model mapped from "${model}" to "${effectiveModel.actualModelId}" via effective models`)
      return effectiveModel.actualModelId
    }

    const config = storeManager.getConfig()
    const mapping = config.modelMappings[model]

    if (mapping && (!mapping.preferredProviderId || mapping.preferredProviderId === provider.id)) {
      const actualModel = mapping.actualModel
      debugLoadBalancer(`[LoadBalancer] Model mapped from "${model}" to "${actualModel}" via global mapping`)
      
      const normalizedActualModel = this.normalizeModelForProviderMatch(actualModel).toLowerCase()
      const actualEffectiveModel = effectiveModels.find(m =>
        this.normalizeModelForProviderMatch(m.displayName).toLowerCase() === normalizedActualModel
        || this.normalizeModelForProviderMatch(m.actualModelId).toLowerCase() === normalizedActualModel
      )
      if (actualEffectiveModel) {
        debugLoadBalancer(`[LoadBalancer] Model further mapped from "${actualModel}" to "${actualEffectiveModel.actualModelId}" via effective models`)
        return actualEffectiveModel.actualModelId
      }
      
      return actualModel
    }

    debugLoadBalancer(`[LoadBalancer] No mapping found, returning original model "${model}"`)
    return model
  }

  /**
   * Round Robin strategy
   */
  private selectRoundRobin(candidates: AccountSelection[]): AccountSelection {
    const providerIds = Array.from(new Set(candidates.map(c => c.provider.id)))
    const key = providerIds.join(',')

    const currentIndex = this.roundRobinIndex.get(key) || 0
    const selected = candidates[currentIndex % candidates.length]

    this.roundRobinIndex.set(key, (currentIndex + 1) % candidates.length)

    return selected
  }

  /**
   * Fill First strategy
   * Use current account preferentially until limit is reached
   */
  private selectFillFirst(candidates: AccountSelection[]): AccountSelection {
    return candidates.reduce((best, current) => {
      const bestUsed = best.account.todayUsed || 0
      const currentUsed = current.account.todayUsed || 0

      if (currentUsed < bestUsed) {
        return current
      }

      if (currentUsed === bestUsed) {
        const bestLastUsed = best.account.lastUsed || 0
        const currentLastUsed = current.account.lastUsed || 0

        if (currentLastUsed < bestLastUsed) {
          return current
        }
      }

      return best
    })
  }

  /**
   * Failover strategy
   * Select account with least failures, preferring healthy accounts
   */
  private selectFailover(candidates: AccountSelection[]): AccountSelection {
    const healthyCandidates = candidates.filter(c => !this.isAccountInFailure(c.account.id))
    
    if (healthyCandidates.length > 0) {
      return this.selectRoundRobin(healthyCandidates)
    }

    const sortedCandidates = candidates.sort((a, b) => {
      const failureA = this.failedAccounts.get(a.account.id)
      const failureB = this.failedAccounts.get(b.account.id)

      const countA = failureA ? failureA.count : 0
      const countB = failureB ? failureB.count : 0

      if (countA !== countB) {
        return countA - countB
      }

      const timeA = failureA ? failureA.lastFailTime : 0
      const timeB = failureB ? failureB.lastFailTime : 0

      return timeA - timeB
    })

    return sortedCandidates[0]
  }

  /**
   * Reset Round Robin index
   */
  resetRoundRobinIndex(): void {
    this.roundRobinIndex.clear()
  }

  /**
   * Get available account count
   */
  getAvailableAccountCount(model: string, providerId?: string): number {
    return this.getAvailableAccounts(model, providerId).length
  }

  /**
   * Get all available models
   */
  getAvailableModels(): string[] {
    const providers = storeManager.getProviders().filter(p => p.enabled)
    const models = new Set<string>()

    for (const provider of providers) {
      const accounts = storeManager.getAccountsByProviderId(provider.id)
        .filter(account => this.isAccountAvailable(account))

      if (accounts.length > 0) {
        const effectiveModels = storeManager.getEffectiveModels(provider.id)
        effectiveModels.forEach(m => models.add(m.displayName))
      }
    }

    return Array.from(models)
  }
}

export const loadBalancer = new LoadBalancer()
export default loadBalancer
