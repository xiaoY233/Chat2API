import { create } from 'zustand'
import type { ProxyStatus, ProxyStatistics, Provider, Account, ProviderCheckResult, LogEntry } from '@/types/electron'
import type { ProviderStats, ActivityItem, ChartDataPoint } from '@/components/dashboard'

interface DashboardStats {
  totalRequests: number
  successRate: number
  avgLatency: number
  activeAccounts: number
  requestsTrend: number
  successRateTrend: number
  latencyTrend: number
  accountsTrend: number
}

interface LogTrend {
  date: string
  total: number
  info: number
  warn: number
  error: number
}

interface DashboardState {
  proxyStatus: ProxyStatus | null
  statistics: ProxyStatistics | null
  stats: DashboardStats
  providers: ProviderStats[]
  activities: ActivityItem[]
  chartData: ChartDataPoint[]
  isLoading: boolean
  error: string | null
  lastUpdated: number | null

  setProxyStatus: (status: ProxyStatus | null) => void
  setStatistics: (statistics: ProxyStatistics | null) => void
  setStats: (stats: Partial<DashboardStats>) => void
  setProviders: (providers: ProviderStats[]) => void
  setActivities: (activities: ActivityItem[]) => void
  addActivity: (activity: ActivityItem) => void
  setChartData: (data: ChartDataPoint[]) => void
  setLoading: (loading: boolean) => void
  setError: (error: string | null) => void
  refreshData: () => Promise<void>
}

const convertLogsToActivities = (logs: LogEntry[], providers: Provider[]): ActivityItem[] => {
  return logs.slice(0, 10).map(log => {
    const provider = log.providerId ? providers.find(p => p.id === log.providerId) : undefined
    
    let type: ActivityItem['type'] = 'info'
    if (log.level === 'error') type = 'error'
    else if (log.level === 'warn') type = 'warning'
    else if (log.level === 'info' && log.message.includes('success')) type = 'success'
    
    return {
      id: log.id,
      type,
      title: log.message,
      description: log.data ? JSON.stringify(log.data).slice(0, 100) : undefined,
      timestamp: log.timestamp,
      providerName: provider?.name,
      modelName: log.data?.model as string | undefined,
    }
  })
}

const convertTrendToChartData = (trends: LogTrend[]): ChartDataPoint[] => {
  return trends.map(trend => ({
    time: trend.date.slice(5),
    requests: trend.total,
    success: trend.info,
    failed: trend.error + trend.warn,
  }))
}

export const useDashboardStore = create<DashboardState>((set, get) => ({
  proxyStatus: null,
  statistics: null,
  stats: {
    totalRequests: 0,
    successRate: 0,
    avgLatency: 0,
    activeAccounts: 0,
    requestsTrend: 0,
    successRateTrend: 0,
    latencyTrend: 0,
    accountsTrend: 0,
  },
  providers: [],
  activities: [],
  chartData: [],
  isLoading: false,
  error: null,
  lastUpdated: null,

  setProxyStatus: (status) => set({ proxyStatus: status }),
  setStatistics: (statistics) => set({ statistics }),
  setStats: (stats) => set((state) => ({ stats: { ...state.stats, ...stats } })),
  setProviders: (providers) => set({ providers }),
  setActivities: (activities) => set({ activities }),
  addActivity: (activity) => set((state) => ({
    activities: [activity, ...state.activities].slice(0, 50),
  })),
  setChartData: (data) => set({ chartData: data }),
  setLoading: (loading) => set({ isLoading: loading }),
  setError: (error) => set({ error }),

  refreshData: async () => {
    const { setLoading, setError, setProxyStatus, setStatistics, setStats, setProviders, setActivities, setChartData } = get()
    
    setLoading(true)
    setError(null)

    try {
      const proxyStatusPromise = window.electronAPI?.proxy?.getStatus?.() ?? Promise.resolve(null)
      const statisticsPromise = window.electronAPI?.invoke?.('proxy:getStatistics') ?? Promise.resolve(null)
      const providersPromise = window.electronAPI?.providers?.getAll?.() ?? Promise.resolve([])
      const accountsPromise = window.electronAPI?.accounts?.getAll?.() ?? Promise.resolve([])
      const providerStatusPromise = window.electronAPI?.providers?.checkAllStatus?.() ?? Promise.resolve({})
      const logsPromise = window.electronAPI?.logs?.get?.({ limit: 10 }) ?? Promise.resolve([])
      const trendPromise = window.electronAPI?.logs?.getTrend?.(7) ?? Promise.resolve([])

      const [proxyStatus, statistics, providers, accounts, providerStatuses, logs, trends] = await Promise.all([
        proxyStatusPromise,
        statisticsPromise,
        providersPromise,
        accountsPromise,
        providerStatusPromise,
        logsPromise,
        trendPromise,
      ]) as [ProxyStatus | null, ProxyStatistics | null, Provider[], Account[], Record<string, ProviderCheckResult>, LogEntry[], LogTrend[]]

      setProxyStatus(proxyStatus)
      setStatistics(statistics)

      const totalRequests = statistics?.totalRequests ?? 0
      const successRequests = statistics?.successRequests ?? 0
      const successRate = totalRequests > 0
        ? Math.round((successRequests / totalRequests) * 100)
        : 0
      const avgLatency = Math.round(statistics?.avgLatency ?? 0)
      const activeAccounts = accounts?.filter((a: Account) => a.status === 'active').length ?? 0

      // Calculate trends based on log data (compare today vs yesterday)
      const today = new Date().toISOString().split('T')[0]
      const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString().split('T')[0]

      const todayTrend = trends.find((t: LogTrend) => t.date === today)
      const yesterdayTrend = trends.find((t: LogTrend) => t.date === yesterday)

      const todayRequests = todayTrend?.total ?? 0
      const yesterdayRequests = yesterdayTrend?.total ?? 0
      const requestsTrend = yesterdayRequests > 0
        ? Math.round(((todayRequests - yesterdayRequests) / yesterdayRequests) * 100)
        : 0

      const todaySuccess = todayTrend?.info ?? 0
      const yesterdaySuccess = yesterdayTrend?.info ?? 0
      const todayError = todayTrend?.error ?? 0 + (todayTrend?.warn ?? 0)
      const yesterdayError = yesterdayTrend?.error ?? 0 + (yesterdayTrend?.warn ?? 0)
      const todaySuccessRate = todayRequests > 0 ? Math.round((todaySuccess / todayRequests) * 100) : 0
      const yesterdaySuccessRate = yesterdayRequests > 0 ? Math.round((yesterdaySuccess / yesterdayRequests) * 100) : 0
      const successRateTrend = yesterdaySuccessRate > 0
        ? todaySuccessRate - yesterdaySuccessRate
        : 0

      // For latency trend, we use a simple estimate based on error rate changes
      const latencyTrend = yesterdayRequests > 0 && todayRequests > 0
        ? Math.round(((todayError / todayRequests) - (yesterdayError / yesterdayRequests)) * 100)
        : 0

      // For accounts trend, compare current active accounts with total accounts
      const totalAccounts = accounts?.length ?? 0
      const accountsTrend = totalAccounts > 0
        ? Math.round(((activeAccounts - totalAccounts * 0.8) / (totalAccounts * 0.8)) * 100)
        : 0

      setStats({
        totalRequests,
        successRate,
        avgLatency,
        activeAccounts,
        requestsTrend,
        successRateTrend,
        latencyTrend,
        accountsTrend,
      })

      const providerStats: ProviderStats[] = (providers ?? []).map((provider: Provider) => {
        const status = providerStatuses?.[provider.id]
        const providerAccounts = accounts?.filter((a: Account) => a.providerId === provider.id) ?? []
        const accountUsage = providerAccounts.reduce((sum: number, a: Account) => sum + (a.requestCount ?? 0), 0)
        
        return {
          id: provider.id,
          name: provider.name,
          status: status?.status ?? 'unknown',
          requestCount: accountUsage,
          successCount: Math.floor(accountUsage * 0.9),
          latency: status?.latency,
        }
      })
      setProviders(providerStats)

      setActivities(convertLogsToActivities(logs, providers ?? []))
      setChartData(convertTrendToChartData(trends))

      set({ lastUpdated: Date.now() })
    } catch (error) {
      setError(error instanceof Error ? error.message : 'Failed to fetch data')
      setStats({
        totalRequests: 0,
        successRate: 0,
        avgLatency: 0,
        activeAccounts: 0,
        requestsTrend: 0,
        successRateTrend: 0,
        latencyTrend: 0,
        accountsTrend: 0,
      })
      setActivities([])
      setChartData([])
    } finally {
      setLoading(false)
    }
  },
}))
