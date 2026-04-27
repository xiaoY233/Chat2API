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

interface RequestLogEntry {
  id: string
  timestamp: number
  status: 'success' | 'error'
  statusCode: number
  model: string
  providerId?: string
  providerName?: string
  modelName?: string
  latency: number
  userInput?: string
  errorMessage?: string
}

const convertRequestLogsToActivities = (logs: RequestLogEntry[]): ActivityItem[] => {
  return logs.slice(0, 10).map(log => {
    return {
      id: log.id,
      type: log.status === 'success' ? 'success' : 'error',
      title: log.model,
      description: log.status === 'error' ? log.errorMessage : log.userInput?.slice(0, 100),
      timestamp: log.timestamp,
      providerName: log.providerName,
      modelName: log.model,
      latency: log.latency,
      statusCode: log.statusCode,
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
      const persistentStatsPromise = window.electronAPI?.statistics?.get?.() ?? Promise.resolve(null)
      const providersPromise = window.electronAPI?.providers?.getAll?.() ?? Promise.resolve([])
      const accountsPromise = window.electronAPI?.accounts?.getAll?.() ?? Promise.resolve([])
      const logsPromise = window.electronAPI?.logs?.get?.({ limit: 10 }) ?? Promise.resolve([])
      const trendPromise = window.electronAPI?.logs?.getTrend?.(7) ?? Promise.resolve([])
      const requestLogTrendPromise = window.electronAPI?.requestLogs?.getTrend?.(7) ?? Promise.resolve([])

      const [proxyStatus, statistics, persistentStats, providers, accounts, logs, trends, requestLogTrends] = await Promise.all([
        proxyStatusPromise,
        statisticsPromise,
        persistentStatsPromise,
        providersPromise,
        accountsPromise,
        logsPromise,
        trendPromise,
        requestLogTrendPromise,
      ]) as [ProxyStatus | null, ProxyStatistics | null, any, Provider[], Account[], LogEntry[], LogTrend[], any[]]

      setProxyStatus(proxyStatus)
      setStatistics(statistics)

      const totalRequests = persistentStats?.totalRequests ?? statistics?.totalRequests ?? 0
      const successRequests = persistentStats?.successRequests ?? statistics?.successRequests ?? 0
      const successRate = totalRequests > 0
        ? Math.round((successRequests / totalRequests) * 100)
        : 0
      
      const today = new Date().toISOString().split('T')[0]
      const todayStats = persistentStats?.dailyStats?.[today]
      const avgLatency = todayStats && todayStats.successRequests > 0
        ? Math.round(todayStats.totalLatency / todayStats.successRequests)
        : (successRequests > 0
          ? Math.round((persistentStats?.totalLatency ?? 0) / successRequests)
          : Math.round(statistics?.avgLatency ?? 0))
      
      const activeAccounts = accounts?.filter((a: Account) => a.status === 'active').length ?? 0

      const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString().split('T')[0]

      const useRequestLogTrends = requestLogTrends && requestLogTrends.length > 0
      const trendData = useRequestLogTrends ? requestLogTrends : trends

      const todayTrend = trendData.find((t: any) => t.date === today)
      const yesterdayTrend = trendData.find((t: any) => t.date === yesterday)

      const todayRequests = todayTrend?.total ?? todayTrend?.info ?? 0
      const yesterdayRequests = yesterdayTrend?.total ?? yesterdayTrend?.info ?? 0
      
      let requestsTrend = 0
      if (yesterdayRequests > 0) {
        requestsTrend = Math.round(((todayRequests - yesterdayRequests) / yesterdayRequests) * 100)
      } else if (todayRequests > 0) {
        requestsTrend = 100
      }

      const todaySuccess = useRequestLogTrends ? (todayTrend?.success ?? 0) : (todayTrend?.info ?? 0)
      const yesterdaySuccess = useRequestLogTrends ? (yesterdayTrend?.success ?? 0) : (yesterdayTrend?.info ?? 0)
      const todaySuccessRate = todayRequests > 0 ? Math.round((todaySuccess / todayRequests) * 100) : 0
      const yesterdaySuccessRate = yesterdayRequests > 0 ? Math.round((yesterdaySuccess / yesterdayRequests) * 100) : 0
      const successRateTrend = yesterdaySuccessRate > 0 ? todaySuccessRate - yesterdaySuccessRate : 0

      const todayAvgLatency = todayTrend?.avgLatency ?? 0
      const yesterdayAvgLatency = yesterdayTrend?.avgLatency ?? 0
      const latencyTrend = yesterdayAvgLatency > 0 && todayAvgLatency > 0
        ? Math.round(((todayAvgLatency - yesterdayAvgLatency) / yesterdayAvgLatency) * 100)
        : 0

      setStats({
        totalRequests,
        successRate,
        avgLatency,
        activeAccounts,
        requestsTrend,
        successRateTrend,
        latencyTrend,
      })

      const providerUsage = persistentStats?.providerUsage ?? {}
      const requestLogsPromise = window.electronAPI?.requestLogs?.get?.({ limit: 100 }) ?? Promise.resolve([])
      const requestLogs = await requestLogsPromise as RequestLogEntry[]
      
      const providerSuccessCount: Record<string, number> = {}
      const providerTotalCount: Record<string, number> = {}
      for (const log of requestLogs) {
        if (log.providerId) {
          providerTotalCount[log.providerId] = (providerTotalCount[log.providerId] || 0) + 1
          if (log.status === 'success') {
            providerSuccessCount[log.providerId] = (providerSuccessCount[log.providerId] || 0) + 1
          }
        }
      }
      
      const providerStats: ProviderStats[] = (providers ?? []).map((provider: Provider) => {
        const usage = providerUsage[provider.id] ?? 0
        const successCount = providerSuccessCount[provider.id] ?? usage
        const totalCount = providerTotalCount[provider.id] ?? usage

        return {
          id: provider.id,
          name: provider.name,
          status: provider.status ?? 'unknown',
          requestCount: totalCount,
          successCount: successCount,
          latency: undefined,
        }
      })
      setProviders(providerStats)

      const recentRequestLogs = requestLogs.slice(0, 10)
      if (recentRequestLogs && recentRequestLogs.length > 0) {
        setActivities(convertRequestLogsToActivities(recentRequestLogs))
      } else {
        setActivities(convertLogsToActivities(logs, providers ?? []))
      }
      
      if (useRequestLogTrends) {
        setChartData(requestLogTrends.map((t: any) => ({
          time: t.date.slice(5),
          requests: t.total,
          success: t.success,
          failed: t.error,
        })))
      } else {
        setChartData(convertTrendToChartData(trends))
      }

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
