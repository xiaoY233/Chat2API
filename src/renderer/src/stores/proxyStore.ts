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
  addModelMapping: (mapping: ModelMapping) => void
  updateModelMapping: (requestModel: string, mapping: Partial<ModelMapping>) => void
  removeModelMapping: (requestModel: string) => void
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

  addModelMapping: (mapping) => set((state) => ({
    modelMappings: [...state.modelMappings, mapping],
  })),

  updateModelMapping: (requestModel, mapping) => set((state) => ({
    modelMappings: state.modelMappings.map(m =>
      m.requestModel === requestModel ? { ...m, ...mapping } : m
    ),
  })),

  removeModelMapping: (requestModel) => set((state) => ({
    modelMappings: state.modelMappings.filter(m => m.requestModel !== requestModel),
  })),

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
    if (!window.electronAPI?.invoke) {
      set({ proxyStatistics: DEFAULT_STATISTICS })
      return
    }
    try {
      const statistics = await window.electronAPI.invoke('proxy:getStatistics') as ProxyStatistics
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
        set({
          appConfig: config,
          loadBalanceStrategy: config.loadBalanceStrategy,
          modelMappings: Object.values(config.modelMappings || {}),
          proxyConfig: {
            ...DEFAULT_PROXY_CONFIG,
            port: config.proxyPort,
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
      const newConfig = { ...currentConfig, ...config } as AppConfig
      
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
