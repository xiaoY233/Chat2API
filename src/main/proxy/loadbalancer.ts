/**
 * Proxy Service Module - Load Balancer
 * Implements Round Robin and Fill First strategies
 */

import { Account, Provider, LoadBalanceStrategy } from '../store/types'
import { AccountSelection } from './types'
import { storeManager } from '../store/store'

/**
 * Load Balancer
 */
export class LoadBalancer {
  private roundRobinIndex: Map<string, number> = new Map()
  private failedAccounts: Map<string, { count: number; lastFailTime: number }> = new Map()
  private static readonly FAIL_THRESHOLD = 3
  private static readonly RECOVERY_TIME = 60000 // 1 minute

  /**
   * Mark account as failed
   */
  markAccountFailed(accountId: string): void {
    const current = this.failedAccounts.get(accountId) || { count: 0, lastFailTime: 0 }
    this.failedAccounts.set(accountId, {
      count: current.count + 1,
      lastFailTime: Date.now(),
    })
  }

  /**
   * Clear account failure status
   */
  clearAccountFailure(accountId: string): void {
    this.failedAccounts.delete(accountId)
  }

  /**
   * Check if account is in failure state
   */
  private isAccountInFailure(accountId: string): boolean {
    const failure = this.failedAccounts.get(accountId)
    if (!failure) return false

    if (Date.now() - failure.lastFailTime > LoadBalancer.RECOVERY_TIME) {
      this.failedAccounts.delete(accountId)
      return false
    }

    return failure.count >= LoadBalancer.FAIL_THRESHOLD
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
    preferredAccountId?: string
  ): AccountSelection | null {
    const candidates = this.getAvailableAccounts(model, preferredProviderId, strategy === 'failover')

    if (candidates.length === 0) {
      return null
    }

    if (preferredAccountId) {
      const preferred = candidates.find(c => c.account.id === preferredAccountId)
      if (preferred && !this.isAccountInFailure(preferredAccountId)) {
        return preferred
      }
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
    excludeFailed: boolean = false
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
        .filter(account => !excludeFailed || !this.isAccountInFailure(account.id))

      console.log(`[LoadBalancer] Provider ${provider.name} (${provider.id}) has ${accounts.length} available accounts`)

      for (const account of accounts) {
        console.log(`[LoadBalancer] Account ${account.name} (${account.id}) Token: ${(account.credentials.token || '').substring(0, 20)}...`)
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
    if (!provider.supportedModels || provider.supportedModels.length === 0) {
      return true
    }

    const normalizedModel = model.toLowerCase()
    const supported = provider.supportedModels.some(m => {
      const normalizedSupported = m.toLowerCase()
      if (normalizedSupported.endsWith('*')) {
        return normalizedModel.startsWith(normalizedSupported.slice(0, -1))
      }
      return normalizedSupported === normalizedModel
    })
    
    if (!supported) {
      console.log(`[LoadBalancer] Provider ${provider.name} does not support model ${model}, supported models:`, provider.supportedModels)
    }
    
    return supported
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
    console.log(`[LoadBalancer] mapModel called with model="${model}", provider="${provider.name}"`)
    console.log(`[LoadBalancer] provider.modelMappings:`, provider.modelMappings)
    
    // First check provider-level model mapping
    if (provider.modelMappings && provider.modelMappings[model]) {
      const mapped = provider.modelMappings[model]
      console.log(`[LoadBalancer] Model mapped from "${model}" to "${mapped}" via provider mapping`)
      return mapped
    }

    // Then check global config model mapping
    const config = storeManager.getConfig()
    const mapping = config.modelMappings[model]

    if (mapping && mapping.preferredProviderId === provider.id) {
      console.log(`[LoadBalancer] Model mapped from "${model}" to "${mapping.actualModel}" via global mapping`)
      return mapping.actualModel
    }

    console.log(`[LoadBalancer] No mapping found, returning original model "${model}"`)
    return model
  }

  /**
   * Round Robin strategy
   */
  private selectRoundRobin(candidates: AccountSelection[]): AccountSelection {
    const providerIds = [...new Set(candidates.map(c => c.provider.id))]
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

      if (accounts.length > 0 && provider.supportedModels) {
        provider.supportedModels.forEach(m => models.add(m))
      }
    }

    return [...models]
  }
}

export const loadBalancer = new LoadBalancer()
export default loadBalancer
