/**
 * LoadBalancer Round-Robin Test Suite
 *
 * This file copies the core logic from src/main/proxy/loadbalancer.ts
 * and injects a mock storeManager so we can test without Electron.
 *
 * Run: npx -y tsx tests/loadbalancer.test.ts
 */

// ─── Mock Types ──────────────────────────────────────────────────────────────

interface MockAccount {
  id: string
  providerId: string
  name: string
  credentials: Record<string, string>
  status: 'active' | 'inactive' | 'expired' | 'error'
  lastUsed?: number
  createdAt: number
  updatedAt: number
  requestCount?: number
  dailyLimit?: number
  todayUsed?: number
}

interface MockProvider {
  id: string
  name: string
  type: 'builtin' | 'custom'
  authType: string
  apiEndpoint: string
  headers: Record<string, string>
  enabled: boolean
  createdAt: number
  updatedAt: number
  supportedModels?: string[]
  modelMappings?: Record<string, string>
}

interface MockAccountSelection {
  account: MockAccount
  provider: MockProvider
  actualModel: string
}

interface MockStoreManager {
  getProviders: () => MockProvider[]
  getAccountsByProviderId: (providerId: string, includeCredentials: boolean) => MockAccount[]
  getEffectiveModels: (providerId: string) => { displayName: string; actualModelId: string; isCustom: boolean }[]
  getConfig: () => {
    modelMappings: Record<string, { requestModel: string; actualModel: string; preferredProviderId?: string; preferredAccountId?: string }>
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeProvider(id: string, name: string, models?: string[]): MockProvider {
  return {
    id, name, type: 'builtin', authType: 'token',
    apiEndpoint: 'https://example.com', headers: {},
    enabled: true, createdAt: Date.now(), updatedAt: Date.now(),
    supportedModels: models,
  }
}

function makeAccount(id: string, providerId: string, overrides: Partial<MockAccount> = {}): MockAccount {
  return {
    id, providerId, name: id, credentials: { token: 'tk-' + id },
    status: 'active', createdAt: Date.now(), updatedAt: Date.now(),
    ...overrides,
  }
}

function createStoreManager(opts: { providers: MockProvider[]; accounts: MockAccount[] }): MockStoreManager {
  return {
    getProviders: () => opts.providers,
    getAccountsByProviderId: (providerId: string) =>
      opts.accounts.filter(a => a.providerId === providerId),
    getEffectiveModels: (providerId: string) => {
      const p = opts.providers.find(pr => pr.id === providerId)
      if (!p || !p.supportedModels) return []
      return p.supportedModels.map(m => ({ displayName: m, actualModelId: m, isCustom: false }))
    },
    getConfig: () => ({ modelMappings: {} }),
  }
}

function tally(results: MockAccountSelection[]): Record<string, number> {
  const counts: Record<string, number> = {}
  for (const r of results) counts[r.account.id] = (counts[r.account.id] || 0) + 1
  return counts
}

// ─── ORIGINAL LoadBalancer (copied from src/main/proxy/loadbalancer.ts) ──────

class OriginalLoadBalancer {
  private providerIndex: Map<string, number> = new Map()
  private accountIndex: Map<string, number> = new Map()
  private failedAccounts: Map<string, { count: number; lastFailTime: number }> = new Map()
  private static readonly FAIL_THRESHOLD = 3
  private static readonly RECOVERY_TIME = 60000

  constructor(private storeManager: MockStoreManager) {}

  private isAccountInFailure(accountId: string): boolean {
    const failure = this.failedAccounts.get(accountId)
    if (!failure) return false
    if (Date.now() - failure.lastFailTime > OriginalLoadBalancer.RECOVERY_TIME) {
      this.failedAccounts.delete(accountId)
      return false
    }
    return failure.count >= OriginalLoadBalancer.FAIL_THRESHOLD
  }

  selectAccount(
    model: string,
    strategy: 'round-robin' | 'fill-first' | 'failover' = 'round-robin',
    preferredProviderId?: string,
    preferredAccountId?: string
  ): MockAccountSelection | null {
    const candidates = this.getAvailableAccounts(model, preferredProviderId, strategy === 'failover')
    if (candidates.length === 0) return null
    if (preferredAccountId) {
      const preferred = candidates.find(c => c.account.id === preferredAccountId)
      if (preferred && !this.isAccountInFailure(preferredAccountId)) return preferred
    }
    if (strategy === 'fill-first') return this.selectFillFirst(candidates)
    if (strategy === 'failover') return this.selectFailover(candidates)
    return this.selectRoundRobin(candidates)
  }

  private getAvailableAccounts(model: string, preferredProviderId?: string, excludeFailed = false): MockAccountSelection[] {
    const providers = this.storeManager.getProviders().filter(p => p.enabled)
    const candidates: MockAccountSelection[] = []
    for (const provider of providers) {
      if (preferredProviderId && provider.id !== preferredProviderId) continue
      if (!this.providerSupportsModel(provider, model)) continue
      const accounts = this.storeManager.getAccountsByProviderId(provider.id, true)
        .filter(a => this.isAccountAvailable(a))
        .filter(a => !excludeFailed || !this.isAccountInFailure(a.id))
      for (const account of accounts) {
        candidates.push({ account, provider, actualModel: this.mapModel(model, provider) })
      }
    }
    return candidates
  }

  private providerSupportsModel(provider: MockProvider, model: string): boolean {
    const effectiveModels = this.storeManager.getEffectiveModels(provider.id)
    if (effectiveModels.length === 0) return true
    const nm = model.toLowerCase()
    if (effectiveModels.some(m => m.displayName.toLowerCase() === nm)) return true
    const gm = this.storeManager.getConfig().modelMappings[model]
    if (gm) {
      if (gm.preferredProviderId) return gm.preferredProviderId === provider.id
      if (effectiveModels.some(m => m.displayName.toLowerCase() === gm.actualModel.toLowerCase())) return true
    }
    return false
  }

  private isAccountAvailable(account: MockAccount): boolean {
    if (account.status !== 'active') return false
    if (account.dailyLimit && account.todayUsed && account.todayUsed >= account.dailyLimit) return false
    return true
  }

  private mapModel(model: string, provider: MockProvider): string {
    const em = this.storeManager.getEffectiveModels(provider.id)
    const hit = em.find(m => m.displayName.toLowerCase() === model.toLowerCase())
    if (hit) return hit.actualModelId
    const gm = this.storeManager.getConfig().modelMappings[model]
    if (gm && (!gm.preferredProviderId || gm.preferredProviderId === provider.id)) {
      const am = gm.actualModel
      const ah = em.find(m => m.displayName.toLowerCase() === am.toLowerCase())
      return ah ? ah.actualModelId : am
    }
    return model
  }

  /**
   * Round Robin strategy
   * Uses two-level round-robin: provider level + account level.
   * This isolates each provider's account index so that removing/adding
   * accounts (e.g., due to temporary unavailability) in one provider
   * never drifts the round-robin pointer of another.
   */
  private selectRoundRobin(candidates: MockAccountSelection[]): MockAccountSelection {
    // Group candidates by provider (preserve insertion order)
    const byProvider = new Map<string, MockAccountSelection[]>()
    for (const c of candidates) {
      if (!byProvider.has(c.provider.id)) {
        byProvider.set(c.provider.id, [])
      }
      byProvider.get(c.provider.id)!.push(c)
    }
    const providerIds = [...byProvider.keys()]

    // Provider-level round-robin
    const providerKey = providerIds.join(',')
    const providerIdx = this.providerIndex.get(providerKey) || 0
    const chosenProviderId = providerIds[providerIdx % providerIds.length]
    this.providerIndex.set(providerKey, providerIdx + 1)

    // Account-level round-robin (isolated per provider)
    const providerAccounts = byProvider.get(chosenProviderId)!
    const accountIdx = this.accountIndex.get(chosenProviderId) || 0
    const selected = providerAccounts[accountIdx % providerAccounts.length]
    this.accountIndex.set(chosenProviderId, accountIdx + 1)

    return selected
  }

  private selectFillFirst(candidates: MockAccountSelection[]): MockAccountSelection {
    return candidates.reduce((best, cur) => {
      const bu = best.account.todayUsed || 0, cu = cur.account.todayUsed || 0
      if (cu < bu) return cur
      if (cu === bu) {
        const bl = best.account.lastUsed || 0, cl = cur.account.lastUsed || 0
        if (cl < bl) return cur
      }
      return best
    })
  }

  private selectFailover(candidates: MockAccountSelection[]): MockAccountSelection {
    const healthy = candidates.filter(c => !this.isAccountInFailure(c.account.id))
    if (healthy.length > 0) return this.selectRoundRobin(healthy)
    const sorted = candidates.sort((a, b) => {
      const fa = this.failedAccounts.get(a.account.id), fb = this.failedAccounts.get(b.account.id)
      const ca = fa ? fa.count : 0, cb = fb ? fb.count : 0
      if (ca !== cb) return ca - cb
      const ta = fa ? fa.lastFailTime : 0, tb = fb ? fb.lastFailTime : 0
      return ta - tb
    })
    return sorted[0]
  }

  resetRoundRobinIndex(): void {
    this.providerIndex.clear()
    this.accountIndex.clear()
  }
}

// ─── FIXED LoadBalancer (per-provider account round-robin) ───────────────────

class FixedLoadBalancer {
  private providerIndex: Map<string, number> = new Map()   // key = "p1,p2,..."
  private accountIndex: Map<string, number> = new Map()    // key = providerId
  private failedAccounts: Map<string, { count: number; lastFailTime: number }> = new Map()
  private static readonly FAIL_THRESHOLD = 3
  private static readonly RECOVERY_TIME = 60000

  constructor(private storeManager: MockStoreManager) {}

  private isAccountInFailure(accountId: string): boolean {
    const failure = this.failedAccounts.get(accountId)
    if (!failure) return false
    if (Date.now() - failure.lastFailTime > FixedLoadBalancer.RECOVERY_TIME) {
      this.failedAccounts.delete(accountId)
      return false
    }
    return failure.count >= FixedLoadBalancer.FAIL_THRESHOLD
  }

  selectAccount(
    model: string,
    strategy: 'round-robin' | 'fill-first' | 'failover' = 'round-robin',
    preferredProviderId?: string,
    preferredAccountId?: string
  ): MockAccountSelection | null {
    const candidates = this.getAvailableAccounts(model, preferredProviderId, strategy === 'failover')
    if (candidates.length === 0) return null
    if (preferredAccountId) {
      const preferred = candidates.find(c => c.account.id === preferredAccountId)
      if (preferred && !this.isAccountInFailure(preferredAccountId)) return preferred
    }
    if (strategy === 'fill-first') return this.selectFillFirst(candidates)
    if (strategy === 'failover') return this.selectFailover(candidates)
    return this.selectRoundRobin(candidates)
  }

  private getAvailableAccounts(model: string, preferredProviderId?: string, excludeFailed = false): MockAccountSelection[] {
    const providers = this.storeManager.getProviders().filter(p => p.enabled)
    const candidates: MockAccountSelection[] = []
    for (const provider of providers) {
      if (preferredProviderId && provider.id !== preferredProviderId) continue
      if (!this.providerSupportsModel(provider, model)) continue
      const accounts = this.storeManager.getAccountsByProviderId(provider.id, true)
        .filter(a => this.isAccountAvailable(a))
        .filter(a => !excludeFailed || !this.isAccountInFailure(a.id))
      for (const account of accounts) {
        candidates.push({ account, provider, actualModel: this.mapModel(model, provider) })
      }
    }
    return candidates
  }

  private providerSupportsModel(provider: MockProvider, model: string): boolean {
    const effectiveModels = this.storeManager.getEffectiveModels(provider.id)
    if (effectiveModels.length === 0) return true
    const nm = model.toLowerCase()
    if (effectiveModels.some(m => m.displayName.toLowerCase() === nm)) return true
    const gm = this.storeManager.getConfig().modelMappings[model]
    if (gm) {
      if (gm.preferredProviderId) return gm.preferredProviderId === provider.id
      if (effectiveModels.some(m => m.displayName.toLowerCase() === gm.actualModel.toLowerCase())) return true
    }
    return false
  }

  private isAccountAvailable(account: MockAccount): boolean {
    if (account.status !== 'active') return false
    if (account.dailyLimit && account.todayUsed && account.todayUsed >= account.dailyLimit) return false
    return true
  }

  private mapModel(model: string, provider: MockProvider): string {
    const em = this.storeManager.getEffectiveModels(provider.id)
    const hit = em.find(m => m.displayName.toLowerCase() === model.toLowerCase())
    if (hit) return hit.actualModelId
    const gm = this.storeManager.getConfig().modelMappings[model]
    if (gm && (!gm.preferredProviderId || gm.preferredProviderId === provider.id)) {
      const am = gm.actualModel
      const ah = em.find(m => m.displayName.toLowerCase() === am.toLowerCase())
      return ah ? ah.actualModelId : am
    }
    return model
  }

  /**
   * FIX: Two-level round-robin
   * 1. Pick provider using round-robin across providers
   * 2. Pick account using round-robin within that provider
   *
   * This isolates each provider's account index, so removing/adding
   * accounts in one provider never drifts the index of another.
   */
  private selectRoundRobin(candidates: MockAccountSelection[]): MockAccountSelection {
    // Group by provider (preserve insertion order)
    const byProvider = new Map<string, MockAccountSelection[]>()
    for (const c of candidates) {
      if (!byProvider.has(c.provider.id)) byProvider.set(c.provider.id, [])
      byProvider.get(c.provider.id)!.push(c)
    }
    const providerIds = [...byProvider.keys()]

    // Provider-level RR
    const providerKey = providerIds.join(',')
    const providerIdx = this.providerIndex.get(providerKey) || 0
    const chosenProviderId = providerIds[providerIdx % providerIds.length]
    this.providerIndex.set(providerKey, providerIdx + 1)

    // Account-level RR (per provider)
    const providerAccounts = byProvider.get(chosenProviderId)!
    const accountIdx = this.accountIndex.get(chosenProviderId) || 0
    const selected = providerAccounts[accountIdx % providerAccounts.length]
    this.accountIndex.set(chosenProviderId, accountIdx + 1)

    return selected
  }

  private selectFillFirst(candidates: MockAccountSelection[]): MockAccountSelection {
    return candidates.reduce((best, cur) => {
      const bu = best.account.todayUsed || 0, cu = cur.account.todayUsed || 0
      if (cu < bu) return cur
      if (cu === bu) {
        const bl = best.account.lastUsed || 0, cl = cur.account.lastUsed || 0
        if (cl < bl) return cur
      }
      return best
    })
  }

  private selectFailover(candidates: MockAccountSelection[]): MockAccountSelection {
    const healthy = candidates.filter(c => !this.isAccountInFailure(c.account.id))
    if (healthy.length > 0) return this.selectRoundRobin(healthy)
    const sorted = candidates.sort((a, b) => {
      const fa = this.failedAccounts.get(a.account.id), fb = this.failedAccounts.get(b.account.id)
      const ca = fa ? fa.count : 0, cb = fb ? fb.count : 0
      if (ca !== cb) return ca - cb
      const ta = fa ? fa.lastFailTime : 0, tb = fb ? fb.lastFailTime : 0
      return ta - tb
    })
    return sorted[0]
  }

  resetRoundRobinIndex(): void {
    this.providerIndex.clear()
    this.accountIndex.clear()
  }
}

// ─── Test Framework ──────────────────────────────────────────────────────────

let exitCode = 0
function test(name: string, fn: () => void) {
  try {
    fn()
    console.log(`  ✅ ${name}`)
  } catch (err: any) {
    console.error(`  ❌ ${name}`)
    console.error('     ', err.message || err)
    exitCode = 1
  }
}

function assertApprox(actual: number, expected: number, tolerance: number, msg?: string) {
  if (Math.abs(actual - expected) > tolerance) {
    throw new Error((msg ? msg + ': ' : '') + `expected ~${expected} (±${tolerance}), got ${actual}`)
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
console.log('\n🧪 LoadBalancer Round-Robin Tests\n')

// ─── Test 1: Perfect scenario ────────────────────────────────────────────────
test('Original: 1 provider, 3 accounts → perfectly even (99 calls)', () => {
  const providers = [makeProvider('p1', 'Provider1', ['gpt-4'])]
  const accounts = [makeAccount('0934', 'p1'), makeAccount('5012', 'p1'), makeAccount('1234', 'p1')]
  const lb = new OriginalLoadBalancer(createStoreManager({ providers, accounts }))
  const results: MockAccountSelection[] = []
  for (let i = 0; i < 99; i++) {
    const sel = lb.selectAccount('gpt-4', 'round-robin')!
    results.push(sel)
  }
  const c = tally(results)
  if (c['0934'] !== 33 || c['5012'] !== 33 || c['1234'] !== 33) {
    throw new Error(`Uneven: ${JSON.stringify(c)}`)
  }
})

// ─── Test 2: Intermittent unavailability — fair among available ──────────────
test('Original: intermittent unavailability → fair among available accounts', () => {
  const providers = [makeProvider('p1', 'Provider1', ['gpt-4'])]
  const accounts = [makeAccount('0934', 'p1'), makeAccount('5012', 'p1'), makeAccount('1234', 'p1')]
  const store = createStoreManager({ providers, accounts })
  const lb = new OriginalLoadBalancer(store)
  const results: MockAccountSelection[] = []

  for (let cycle = 0; cycle < 10; cycle++) {
    accounts.forEach(a => { a.status = 'active'; a.todayUsed = 0 })
    for (let i = 0; i < 3; i++) results.push(lb.selectAccount('gpt-4', 'round-robin')!)

    accounts[1].status = 'error' // 5012 drops out
    for (let i = 0; i < 2; i++) results.push(lb.selectAccount('gpt-4', 'round-robin')!)
  }

  const c = tally(results)
  console.log('     Distribution:', JSON.stringify(c))

  // Fair distribution: 0934=20, 1234=20, 5012=10
  // (5012 is only available for 30 of 50 calls, so it gets half the share of the others)
  if (c['0934'] !== 20 || c['5012'] !== 10 || c['1234'] !== 20) {
    throw new Error(`Unexpected distribution: ${JSON.stringify(c)}`)
  }
})

// ─── Test 3: Random failures (user-reported scenario) ─────────────────────────
test('Original: random 20% unavailability of 0934 → fair distribution', () => {
  const providers = [makeProvider('p1', 'Provider1', ['gpt-4'])]
  const accounts = [makeAccount('0934', 'p1'), makeAccount('5012', 'p1'), makeAccount('1234', 'p1')]
  const store = createStoreManager({ providers, accounts })
  const lb = new OriginalLoadBalancer(store)
  const results: MockAccountSelection[] = []

  // Use a fixed seed-like pattern for reproducibility
  for (let i = 0; i < 300; i++) {
    if (i % 5 === 0) { // 0934 unavailable every 5th call (~20%)
      accounts[0].todayUsed = 999; accounts[0].dailyLimit = 999
    } else {
      accounts[0].todayUsed = 0; accounts[0].dailyLimit = undefined
    }
    const sel = lb.selectAccount('gpt-4', 'round-robin')
    if (sel) results.push(sel)
  }

  const c = tally(results)
  const total = results.length
  console.log(
    '     Distribution:',
    Object.entries(c).map(([k, v]) => `${k}: ${v} (${((v / total) * 100).toFixed(1)}%)`).join(', ')
  )

  // Fair shares given 0934 is unavailable 60/300 calls:
  //   Available slots: 0934=240, 5012=300, 1234=300  => total 840
  //   Expected: 0934 ≈ 85.7, 5012 ≈ 107.1, 1234 ≈ 107.1
  assertApprox(c['0934'] / total, 85.7 / 300, 0.05, '0934 share')
  assertApprox(c['5012'] / total, 107.1 / 300, 0.05, '5012 share')
  assertApprox(c['1234'] / total, 107.1 / 300, 0.05, '1234 share')
})

// ─── Test 4: FIXED version under same stress ─────────────────────────────────
test('Fixed: random 20% unavailability of 0934 → fair distribution', () => {
  const providers = [makeProvider('p1', 'Provider1', ['gpt-4'])]
  const accounts = [makeAccount('0934', 'p1'), makeAccount('5012', 'p1'), makeAccount('1234', 'p1')]
  const store = createStoreManager({ providers, accounts })
  const lb = new FixedLoadBalancer(store)
  const results: MockAccountSelection[] = []

  for (let i = 0; i < 300; i++) {
    if (i % 5 === 0) {
      accounts[0].todayUsed = 999; accounts[0].dailyLimit = 999
    } else {
      accounts[0].todayUsed = 0; accounts[0].dailyLimit = undefined
    }
    const sel = lb.selectAccount('gpt-4', 'round-robin')
    if (sel) results.push(sel)
  }

  const c = tally(results)
  const total = results.length
  console.log(
    '     Distribution:',
    Object.entries(c).map(([k, v]) => `${k}: ${v} (${((v / total) * 100).toFixed(1)}%)`).join(', ')
  )

  assertApprox(c['0934'] / total, 85.7 / 300, 0.05, '0934 share')
  assertApprox(c['5012'] / total, 107.1 / 300, 0.05, '5012 share')
  assertApprox(c['1234'] / total, 107.1 / 300, 0.05, '1234 share')
})

// ─── Test 5: FIXED version — intermittent drop-out ───────────────────────────
test('Fixed: 5012 drops out periodically → fair among available', () => {
  const providers = [makeProvider('p1', 'Provider1', ['gpt-4'])]
  const accounts = [makeAccount('0934', 'p1'), makeAccount('5012', 'p1'), makeAccount('1234', 'p1')]
  const store = createStoreManager({ providers, accounts })
  const lb = new FixedLoadBalancer(store)
  const results: MockAccountSelection[] = []

  for (let cycle = 0; cycle < 10; cycle++) {
    accounts.forEach(a => { a.status = 'active'; a.todayUsed = 0 })
    for (let i = 0; i < 3; i++) results.push(lb.selectAccount('gpt-4', 'round-robin')!)

    accounts[1].status = 'error'
    for (let i = 0; i < 2; i++) results.push(lb.selectAccount('gpt-4', 'round-robin')!)
  }

  const c = tally(results)
  console.log('     Distribution:', JSON.stringify(c))
  // Fair: 0934=20, 1234=20, 5012=10  (each gets 50% when present)
  if (c['0934'] !== 20 || c['5012'] !== 10 || c['1234'] !== 20) {
    throw new Error(`Unexpected distribution: ${JSON.stringify(c)}`)
  }
})

// ─── Test 6: Multi-provider fairness ─────────────────────────────────────────
test('Original vs Fixed: 2 providers, 2 accounts each → both even', () => {
  const providers = [
    makeProvider('p1', 'Provider1', ['gpt-4']),
    makeProvider('p2', 'Provider2', ['gpt-4']),
  ]
  const accounts = [
    makeAccount('a1', 'p1'), makeAccount('a2', 'p1'),
    makeAccount('b1', 'p2'), makeAccount('b2', 'p2'),
  ]
  const store = createStoreManager({ providers, accounts })

  const orig = new OriginalLoadBalancer(store)
  const fixd = new FixedLoadBalancer(store)

  const r1: MockAccountSelection[] = []
  const r2: MockAccountSelection[] = []
  for (let i = 0; i < 40; i++) {
    r1.push(orig.selectAccount('gpt-4', 'round-robin')!)
    r2.push(fixd.selectAccount('gpt-4', 'round-robin')!)
  }

  const c1 = tally(r1), c2 = tally(r2)
  if (c1['a1'] !== 10 || c1['a2'] !== 10 || c1['b1'] !== 10 || c1['b2'] !== 10) {
    throw new Error(`Original uneven: ${JSON.stringify(c1)}`)
  }
  if (c2['a1'] !== 10 || c2['a2'] !== 10 || c2['b1'] !== 10 || c2['b2'] !== 10) {
    throw new Error(`Fixed uneven: ${JSON.stringify(c2)}`)
  }
})

// ═══════════════════════════════════════════════════════════════════════════════
console.log('\n🏁 Tests completed.\n')
if (exitCode !== 0) process.exit(exitCode)
