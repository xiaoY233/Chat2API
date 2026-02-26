import { create } from 'zustand'
import type { LogEntry, LogLevel } from '@/types/electron'

interface LogFilter {
  level: LogLevel | 'all'
  keyword: string
  startTime?: number
  endTime?: number
}

interface LogStats {
  total: number
  info: number
  warn: number
  error: number
  debug: number
}

interface LogTrend {
  date: string
  total: number
  info: number
  warn: number
  error: number
}

interface LogsState {
  logs: LogEntry[]
  filteredLogs: LogEntry[]
  selectedLog: LogEntry | null
  filter: LogFilter
  stats: LogStats
  trend: LogTrend[]
  isLoading: boolean
  autoScroll: boolean
  hasMore: boolean
  pageSize: number

  setLogs: (logs: LogEntry[]) => void
  addLog: (log: LogEntry) => void
  setSelectedLog: (log: LogEntry | null) => void
  setFilter: (filter: Partial<LogFilter>) => void
  setStats: (stats: LogStats) => void
  setTrend: (trend: LogTrend[]) => void
  setIsLoading: (loading: boolean) => void
  setAutoScroll: (autoScroll: boolean) => void
  setHasMore: (hasMore: boolean) => void
  applyFilter: () => void
  clearLogs: () => void
  loadMore: () => Promise<void>
  refresh: () => Promise<void>
}

export const useLogsStore = create<LogsState>((set, get) => ({
  logs: [],
  filteredLogs: [],
  selectedLog: null,
  filter: {
    level: 'all',
    keyword: '',
  },
  stats: {
    total: 0,
    info: 0,
    warn: 0,
    error: 0,
    debug: 0,
  },
  trend: [],
  isLoading: false,
  autoScroll: true,
  hasMore: true,
  pageSize: 100,

  setLogs: (logs) => {
    set({ logs, hasMore: logs.length >= get().pageSize })
    get().applyFilter()
  },

  addLog: (log) => {
    const { logs, autoScroll, filter } = get()
    const newLogs = [log, ...logs].slice(0, 10000)
    set({ logs: newLogs })
    
    if (autoScroll) {
      let shouldAdd = true
      if (filter.level !== 'all' && log.level !== filter.level) {
        shouldAdd = false
      }
      if (filter.keyword && !log.message.toLowerCase().includes(filter.keyword.toLowerCase())) {
        shouldAdd = false
      }
      if (filter.startTime && log.timestamp < filter.startTime) {
        shouldAdd = false
      }
      if (filter.endTime && log.timestamp > filter.endTime) {
        shouldAdd = false
      }
      
      if (shouldAdd) {
        set({ filteredLogs: [log, ...get().filteredLogs].slice(0, 10000) })
      }
    }

    set((state) => ({
      stats: {
        ...state.stats,
        total: state.stats.total + 1,
        [log.level]: state.stats[log.level] + 1,
      },
    }))
  },

  setSelectedLog: (log) => set({ selectedLog: log }),

  setFilter: (filter) => {
    set((state) => ({ filter: { ...state.filter, ...filter } }))
    get().applyFilter()
  },

  setStats: (stats) => set({ stats }),

  setTrend: (trend) => set({ trend }),

  setIsLoading: (isLoading) => set({ isLoading }),

  setAutoScroll: (autoScroll) => set({ autoScroll }),

  setHasMore: (hasMore) => set({ hasMore }),

  applyFilter: () => {
    const { logs, filter } = get()
    let filtered = [...logs]

    if (filter.level !== 'all') {
      filtered = filtered.filter((log) => log.level === filter.level)
    }

    if (filter.keyword) {
      const keyword = filter.keyword.toLowerCase()
      filtered = filtered.filter((log) =>
        log.message.toLowerCase().includes(keyword)
      )
    }

    if (filter.startTime) {
      filtered = filtered.filter((log) => log.timestamp >= filter.startTime!)
    }

    if (filter.endTime) {
      filtered = filtered.filter((log) => log.timestamp <= filter.endTime!)
    }

    set({ filteredLogs: filtered })
  },

  clearLogs: () => {
    set({
      logs: [],
      filteredLogs: [],
      selectedLog: null,
      stats: { total: 0, info: 0, warn: 0, error: 0, debug: 0 },
      hasMore: false,
    })
  },

  loadMore: async () => {
    const { isLoading, hasMore, logs, pageSize } = get()
    if (isLoading || !hasMore) return
    if (!window.electronAPI?.logs?.get) return

    set({ isLoading: true })

    try {
      const offset = logs.length
      const newLogs = await window.electronAPI.logs.get({
        limit: pageSize,
        offset,
      })

      if (newLogs.length < pageSize) {
        set({ hasMore: false })
      }

      if (newLogs.length > 0) {
        set((state) => ({ logs: [...state.logs, ...newLogs] }))
        get().applyFilter()
      }
    } catch (error) {
      console.error('Failed to load more logs:', error)
    } finally {
      set({ isLoading: false })
    }
  },

  refresh: async () => {
    const { pageSize } = get()
    set({ isLoading: true })

    if (!window.electronAPI?.logs) {
      set({ isLoading: false })
      return
    }

    try {
      const [logs, stats, trend] = await Promise.all([
        window.electronAPI.logs.get({ limit: pageSize }),
        window.electronAPI.logs.getStats(),
        window.electronAPI.logs.getTrend(7),
      ])

      set({
        logs,
        stats,
        trend,
        hasMore: logs.length >= pageSize,
      })
      get().applyFilter()
    } catch (error) {
      console.error('Failed to refresh logs:', error)
    } finally {
      set({ isLoading: false })
    }
  },
}))

export type { LogFilter, LogStats, LogTrend }
