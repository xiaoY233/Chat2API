import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import type { LogEntry } from '../store/types.ts'
import type { AppLogFilter, AppLogStats, AppLogTrendPoint } from './types.ts'

interface AppLogManagerOptions {
  storageDir: string
  maxEntries?: number
}

export class AppLogManager {
  private readonly logFile: string
  private readonly storageDir: string
  private logs: LogEntry[] = []
  private maxEntries: number
  private initialized = false
  private persistTimer: NodeJS.Timeout | null = null
  private dirty = false
  private readonly persistDelayMs = 2000

  constructor(options: AppLogManagerOptions) {
    this.storageDir = options.storageDir
    this.logFile = join(options.storageDir, 'app-logs.ndjson')
    this.maxEntries = Math.max(0, options.maxEntries ?? 7000)
  }

  async initialize(): Promise<void> {
    if (this.initialized) return

    mkdirSync(this.storageDir, { recursive: true })
    this.logs = this.trimLogs(this.loadLogs())
    this.initialized = true
  }

  setMaxEntries(maxEntries: number): void {
    this.ensureInitialized()
    this.maxEntries = Math.max(0, maxEntries)
    this.logs = this.trimLogs(this.logs)
    this.schedulePersist()
  }

  async migrateLegacyLogs(legacyLogs: LogEntry[]): Promise<boolean> {
    this.ensureInitialized()

    if (legacyLogs.length === 0) {
      return false
    }

    const byId = new Map<string, LogEntry>()
    for (const entry of [...this.logs, ...legacyLogs]) {
      byId.set(entry.id, entry)
    }

    this.logs = this.trimLogs(
      [...byId.values()].sort((a, b) => a.timestamp - b.timestamp),
    )
    this.schedulePersist()
    return true
  }

  addLog(entry: LogEntry): LogEntry {
    this.ensureInitialized()
    this.logs.push(entry)
    this.logs = this.trimLogs(this.logs)
    this.schedulePersist()
    return entry
  }

  replaceLogs(logs: LogEntry[]): void {
    this.ensureInitialized()
    this.logs = this.trimLogs([...logs].sort((a, b) => a.timestamp - b.timestamp))
    this.schedulePersist()
  }

  getLogs(filter?: AppLogFilter): LogEntry[] {
    this.ensureInitialized()
    let result = [...this.logs]

    if (filter?.level && filter.level !== 'all') {
      result = result.filter((entry) => entry.level === filter.level)
    }

    if (filter?.keyword) {
      const keyword = filter.keyword.toLowerCase()
      result = result.filter((entry) => entry.message.toLowerCase().includes(keyword))
    }

    if (filter?.startTime) {
      result = result.filter((entry) => entry.timestamp >= filter.startTime!)
    }

    if (filter?.endTime) {
      result = result.filter((entry) => entry.timestamp <= filter.endTime!)
    }

    result.sort((a, b) => b.timestamp - a.timestamp)

    if (filter?.offset !== undefined) {
      result = result.slice(filter.offset)
    }

    if (filter?.limit !== undefined) {
      result = result.slice(0, filter.limit)
    }

    return result
  }

  getLogById(id: string): LogEntry | undefined {
    this.ensureInitialized()
    return this.logs.find((entry) => entry.id === id)
  }

  clearLogs(): void {
    this.ensureInitialized()
    this.logs = []
    this.schedulePersist()
  }

  getStats(): AppLogStats {
    this.ensureInitialized()

    return this.logs.reduce<AppLogStats>(
      (stats, entry) => ({
        ...stats,
        total: stats.total + 1,
        [entry.level]: stats[entry.level] + 1,
      }),
      { total: 0, info: 0, warn: 0, error: 0, debug: 0 },
    )
  }

  getTrend(days: number = 7): AppLogTrendPoint[] {
    this.ensureInitialized()
    return this.getTrendFromLogs(this.logs, days)
  }

  getAccountTrend(accountId: string, days: number = 7): AppLogTrendPoint[] {
    this.ensureInitialized()
    const accountLogs = this.logs.filter((entry) => entry.accountId === accountId && entry.requestId)
    return this.getTrendFromLogs(accountLogs, days, true)
  }

  exportLogs(): LogEntry[] {
    this.ensureInitialized()
    return [...this.logs]
  }

  flushSync(): void {
    if (!this.initialized) {
      return
    }

    if (this.persistTimer) {
      clearTimeout(this.persistTimer)
      this.persistTimer = null
    }

    this.persistNow()
  }

  private getTrendFromLogs(logs: LogEntry[], days: number, totalUsesInfo = false): AppLogTrendPoint[] {
    const dayMs = 24 * 60 * 60 * 1000
    const today = new Date().toISOString().split('T')[0]
    const todayStart = new Date(today).getTime()
    const trends: AppLogTrendPoint[] = []

    for (let i = days - 1; i >= 0; i--) {
      const dayStart = todayStart - i * dayMs
      const dayEnd = dayStart + dayMs
      const date = new Date(dayStart).toISOString().split('T')[0]
      const dayLogs = logs.filter((entry) => entry.timestamp >= dayStart && entry.timestamp < dayEnd)
      const info = dayLogs.filter((entry) => entry.level === 'info').length
      const warn = dayLogs.filter((entry) => entry.level === 'warn').length
      const error = dayLogs.filter((entry) => entry.level === 'error').length

      trends.push({
        date,
        total: totalUsesInfo ? info : dayLogs.length,
        info,
        warn,
        error,
      })
    }

    return trends
  }

  private ensureInitialized(): void {
    if (!this.initialized) {
      throw new Error('AppLogManager is not initialized')
    }
  }

  private loadLogs(): LogEntry[] {
    if (!existsSync(this.logFile)) {
      return []
    }

    const content = readFileSync(this.logFile, 'utf-8').trim()
    if (!content) {
      return []
    }

    return content
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        try {
          return JSON.parse(line) as LogEntry
        } catch {
          return null
        }
      })
      .filter((entry): entry is LogEntry => entry !== null)
  }

  private trimLogs(logs: LogEntry[]): LogEntry[] {
    if (this.maxEntries <= 0) {
      return []
    }

    return logs.length > this.maxEntries ? logs.slice(-this.maxEntries) : logs
  }

  private schedulePersist(): void {
    this.dirty = true

    if (this.persistTimer) {
      clearTimeout(this.persistTimer)
    }

    this.persistTimer = setTimeout(() => {
      this.persistTimer = null
      this.persistNow()
    }, this.persistDelayMs)
  }

  private persistNow(): void {
    if (!this.dirty) {
      return
    }

    const content = this.logs.map((entry) => JSON.stringify(entry)).join('\n')
    writeFileSync(this.logFile, content, 'utf-8')
    this.dirty = false
  }
}
