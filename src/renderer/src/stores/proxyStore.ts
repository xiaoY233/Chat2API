import { create } from 'zustand'
import type { ProxyStatus, ProxyStatistics, LoadBalanceStrategy, ModelMapping, AppConfig } from '@/types/electron'

export interface ProxyConfig {
  port: number
  host: string
  timeout: number
  retryCount: number
  enableCors: boolean
  corsOrigin: string
  maxConnections: number
}

export interface AccountWeight {
  accountId: string
  weight: number
}

interface ProxyState {
  proxyStatus: ProxyStatus | null
  proxyStatistics: ProxyStatistics | null
  proxyConfig: ProxyConfig
  loadBalanceStrategy: LoadBalanceStrategy
  accountWeights: AccountWeight[]
  modelMappings: ModelMapping[]
  appConfig: AppConfig | null
  isLoading: boolean
  error: string | null

  setProxyStatus: (status: ProxyStatus | null) => void
  setProxyStatistics: (statistics: ProxyStatistics | null) => void
  setProxyConfig: (config: Partial<ProxyConfig>) => void
  setLoadBalanceStrategy: (strategy: LoadBalanceStrategy) => void
  setAccountWeights: (weights: AccountWeight[]) => void
  updateAccountWeight: (accountId: string, weight: number) => void
  setModelMappings: (mappings: ModelMapping[]) => void
  setAppConfig: (config: AppConfig | null) => void
  setLoading: (loading: boolean) => void
  setError: (error: string | null) => void
  resetProxyConfig: () => void
  fetchProxyStatus: () => Promise<void>
  fetchProxyStatistics: () => Promise<void>
  fetchAppConfig: () => Promise<void>
  saveAppConfig: (config: Partial<AppConfig>) => Promise<boolean>
  startProxy: (port?: number) => Promise<boolean>
  stopProxy: () => Promise<boolean>
}

const DEFAULT_PROXY_CONFIG: ProxyConfig = {
  port: 8080,
  host: '127.0.0.1',
  timeout: 60000,
  retryCount: 3,
  enableCors: true,
  corsOrigin: '*',
  maxConnections: 100,
}

const DEFAULT_STATISTICS: ProxyStatistics = {
  totalRequests: 0,
  successRequests: 0,
  failedRequests: 0,
  avgLatency: 0,
  requestsPerMinute: 0,
  activeConnections: 0,
  modelUsage: {},
  providerUsage: {},
  accountUsage: {},
}

export const useProxyStore = create<ProxyState>((set, get) => ({
  proxyStatus: null,
  proxyStatistics: null,
  proxyConfig: DEFAULT_PROXY_CONFIG,
  loadBalanceStrategy: 'round-robin',
  accountWeights: [],
  modelMappings: [],
  appConfig: null,
  isLoading: false,
  error: null,

  setProxyStatus: (status) => set({ proxyStatus: status }),

  setProxyStatistics: (statistics) => set({ proxyStatistics: statistics }),

  setProxyConfig: (config) => set((state) => ({
    proxyConfig: { ...state.proxyConfig, ...config },
  })),

  setLoadBalanceStrategy: (strategy) => set({ loadBalanceStrategy: strategy }),

  setAccountWeights: (weights) => set({ accountWeights: weights }),

  updateAccountWeight: (accountId, weight) => set((state) => {
    const weights = [...state.accountWeights]
    const index = weights.findIndex(w => w.accountId === accountId)
    if (index >= 0) {
      weights[index] = { accountId, weight }
    } else {
      weights.push({ accountId, weight })
    }
    return { accountWeights: weights }
  }),

  setModelMappings: (mappings) => set({ modelMappings: mappings }),

  setAppConfig: (config) => set({ appConfig: config }),

  setLoading: (loading) => set({ isLoading: loading }),

  setError: (error) => set({ error }),

  resetProxyConfig: () => set({ proxyConfig: DEFAULT_PROXY_CONFIG }),

  fetchProxyStatus: async () => {
    if (!window.electronAPI?.proxy?.getStatus) return
    try {
      const status = await window.electronAPI.proxy.getStatus()
      set({ proxyStatus: status })
    } catch (error) {
      set({ error: (error as Error).message })
    }
  },

  fetchProxyStatistics: async () => {
    if (!window.electronAPI?.statistics?.get) {
      set({ proxyStatistics: DEFAULT_STATISTICS })
      return
    }
    try {
      const persistentStats = await window.electronAPI.statistics.get()
      const today = new Date().toISOString().split('T')[0]
      const todayStats = persistentStats?.dailyStats?.[today] || {
        totalRequests: 0,
        successRequests: 0,
        failedRequests: 0,
        totalLatency: 0,
        modelUsage: {},
        providerUsage: {},
      }
      
      const avgLatency = todayStats.successRequests > 0 
        ? Math.round(todayStats.totalLatency / todayStats.successRequests) 
        : 0
      
      const statistics: ProxyStatistics = {
        totalRequests: todayStats.totalRequests,
        successRequests: todayStats.successRequests,
        failedRequests: todayStats.failedRequests,
        avgLatency: avgLatency,
        requestsPerMinute: 0,
        activeConnections: 0,
        modelUsage: todayStats.modelUsage,
        providerUsage: todayStats.providerUsage,
        accountUsage: persistentStats?.accountUsage || {},
      }
      
      set({ proxyStatistics: statistics || DEFAULT_STATISTICS })
    } catch (error) {
      set({ proxyStatistics: DEFAULT_STATISTICS })
    }
  },

  fetchAppConfig: async () => {
    if (!window.electronAPI?.store?.get) return
    try {
      set({ isLoading: true })
      const config = await window.electronAPI.store.get<AppConfig>('config')
      if (config) {
        // Restore account weights from backend
        const weights = config.accountWeights || {}
        const accountWeights = Object.entries(weights).map(([accountId, weight]) => ({
          accountId,
          weight,
        }))

        set({
          appConfig: config,
          loadBalanceStrategy: config.loadBalanceStrategy,
          accountWeights,
          modelMappings: Object.values(config.modelMappings || {}),
          proxyConfig: {
            ...DEFAULT_PROXY_CONFIG,
            port: config.proxyPort,
            host: config.proxyHost || '127.0.0.1',
            timeout: config.requestTimeout,
            retryCount: config.retryCount,
          },
        })
      }
    } catch (error) {
      set({ error: (error as Error).message })
    } finally {
      set({ isLoading: false })
    }
  },

  saveAppConfig: async (config) => {
    if (!window.electronAPI?.store?.set) return false
    try {
      set({ isLoading: true, error: null })
      const currentConfig = get().appConfig
      
      // Deep merge for nested objects like toolPromptConfig and sessionConfig
      let newConfig = { ...currentConfig, ...config } as AppConfig
      
      // Handle toolPromptConfig deep merge
      if (config.toolPromptConfig && currentConfig?.toolPromptConfig) {
        newConfig.toolPromptConfig = {
          ...currentConfig.toolPromptConfig,
          ...config.toolPromptConfig,
        }
      }
      
      // Handle sessionConfig deep merge
      if (config.sessionConfig && currentConfig?.sessionConfig) {
        newConfig.sessionConfig = {
          ...currentConfig.sessionConfig,
          ...config.sessionConfig,
        }
      }
      
      await window.electronAPI.store.set('config', newConfig)
      set({ appConfig: newConfig })
      return true
    } catch (error) {
      set({ error: (error as Error).message })
      return false
    } finally {
      set({ isLoading: false })
    }
  },

  startProxy: async (port) => {
    if (!window.electronAPI?.proxy?.start) return false
    try {
      set({ isLoading: true, error: null })
      const success = await window.electronAPI.proxy.start(port)
      if (success) {
        await get().fetchProxyStatus()
      }
      return success
    } catch (error) {
      set({ error: (error as Error).message })
      return false
    } finally {
      set({ isLoading: false })
    }
  },

  stopProxy: async () => {
    if (!window.electronAPI?.proxy?.stop) return false
    try {
      set({ isLoading: true, error: null })
      const success = await window.electronAPI.proxy.stop()
      if (success) {
        await get().fetchProxyStatus()
      }
      return success
    } catch (error) {
      set({ error: (error as Error).message })
      return false
    } finally {
      set({ isLoading: false })
    }
  },
}))

export default useProxyStore
