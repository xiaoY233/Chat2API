import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'

import type { RequestLogEntry } from '../store/types.ts'
import type {
  RequestLogConfig,
  RequestLogFilter,
  RequestLogStats,
  RequestLogTrendPoint,
} from './types.ts'
import { normalizeRequestLogConfig } from './types.ts'
import {
  sanitizeRequestLogEntry,
  sanitizeRequestLogUpdates,
  trimRequestLogsToMaxEntries,
} from './sanitizer.ts'

interface RequestLogManagerOptions {
  storageDir: string
  config?: Partial<RequestLogConfig>
}

export class RequestLogManager {
  private readonly logFile: string
  private readonly storageDir: string
  private requestLogs: RequestLogEntry[] = []
  private config: RequestLogConfig
  private initialized = false
  private persistTimer: NodeJS.Timeout | null = null
  private dirty = false
  private readonly persistDelayMs = 2000

  constructor(options: RequestLogManagerOptions) {
    this.storageDir = options.storageDir
    this.logFile = join(options.storageDir, 'request-logs.ndjson')
    this.config = normalizeRequestLogConfig(options.config)
  }

  async initialize(): Promise<void> {
    if (this.initialized) return

    mkdirSync(this.storageDir, { recursive: true })
    this.requestLogs = this.loadRequestLogs()
    this.initialized = true
  }

  setConfig(config: Partial<RequestLogConfig>): void {
    this.config = normalizeRequestLogConfig(config)
    this.requestLogs = trimRequestLogsToMaxEntries(this.requestLogs, this.config)
    this.schedulePersist()
  }

  async migrateLegacyLogs(legacyLogs: RequestLogEntry[]): Promise<boolean> {
    this.ensureInitialized()

    if (legacyLogs.length === 0 || this.requestLogs.length > 0) {
      return false
    }

    this.requestLogs = trimRequestLogsToMaxEntries(
      legacyLogs
        .sort((a, b) => a.timestamp - b.timestamp)
        .map((entry) => ({
          ...sanitizeRequestLogEntry(stripId(entry), this.config),
          id: entry.id,
        })),
      this.config,
    )
    this.schedulePersist()

    return true
  }

  addRequestLog(entry: Omit<RequestLogEntry, 'id'>): RequestLogEntry {
    this.ensureInitialized()

    const logEntry: RequestLogEntry = {
      ...sanitizeRequestLogEntry(entry, this.config),
      id: generateId(),
    }

    if (!this.config.enabled) {
      return logEntry
    }

    this.requestLogs.push(logEntry)
    this.requestLogs = trimRequestLogsToMaxEntries(this.requestLogs, this.config)
    this.schedulePersist()

    return logEntry
  }

  updateRequestLog(id: string, updates: Partial<RequestLogEntry>): boolean {
    this.ensureInitialized()
    if (!this.config.enabled || this.config.maxEntries <= 0) {
      return false
    }

    const index = this.requestLogs.findIndex((entry) => entry.id === id)
    if (index === -1) {
      return false
    }

    this.requestLogs[index] = {
      ...this.requestLogs[index],
      ...sanitizeRequestLogUpdates(updates, this.config),
    }
    this.schedulePersist()
    return true
  }

  getRequestLogs(limit?: number, filter?: RequestLogFilter): RequestLogEntry[] {
    this.ensureInitialized()
    let result = [...this.requestLogs]

    if (filter?.status) {
      result = result.filter((entry) => entry.status === filter.status)
    }

    if (filter?.providerId) {
      result = result.filter((entry) => entry.providerId === filter.providerId)
    }

    result.sort((a, b) => b.timestamp - a.timestamp)

    if (limit && result.length > limit) {
      return result.slice(0, limit)
    }

    return result
  }

  getRequestLogById(id: string): RequestLogEntry | undefined {
    this.ensureInitialized()
    return this.requestLogs.find((entry) => entry.id === id)
  }

  clearRequestLogs(): void {
    this.ensureInitialized()
    this.requestLogs = []
    this.schedulePersist()
  }

  getRequestLogStats(): RequestLogStats {
    this.ensureInitialized()
    const today = new Date().toISOString().split('T')[0]
    const todayStart = new Date(today).getTime()
    const todayEnd = todayStart + 24 * 60 * 60 * 1000
    const todayLogs = this.requestLogs.filter((entry) => entry.timestamp >= todayStart && entry.timestamp < todayEnd)

    return {
      total: this.requestLogs.length,
      success: this.requestLogs.filter((entry) => entry.status === 'success').length,
      error: this.requestLogs.filter((entry) => entry.status === 'error').length,
      todayTotal: todayLogs.length,
      todaySuccess: todayLogs.filter((entry) => entry.status === 'success').length,
      todayError: todayLogs.filter((entry) => entry.status === 'error').length,
    }
  }

  getRequestLogTrend(days: number = 7): RequestLogTrendPoint[] {
    this.ensureInitialized()
    const dayMs = 24 * 60 * 60 * 1000
    const today = new Date().toISOString().split('T')[0]
    const todayStart = new Date(today).getTime()
    const trends: RequestLogTrendPoint[] = []

    for (let i = days - 1; i >= 0; i--) {
      const dayStart = todayStart - i * dayMs
      const dayEnd = dayStart + dayMs
      const date = new Date(dayStart).toISOString().split('T')[0]
      const dayLogs = this.requestLogs.filter((entry) => entry.timestamp >= dayStart && entry.timestamp < dayEnd)
      const successLogs = dayLogs.filter((entry) => entry.status === 'success')
      const errorLogs = dayLogs.filter((entry) => entry.status === 'error')
      const totalLatency = successLogs.reduce((sum, entry) => sum + entry.latency, 0)

      trends.push({
        date,
        total: dayLogs.length,
        success: successLogs.length,
        error: errorLogs.length,
        avgLatency: successLogs.length > 0 ? Math.round(totalLatency / successLogs.length) : 0,
      })
    }

    return trends
  }

  exportRequestLogs(): RequestLogEntry[] {
    this.ensureInitialized()
    return [...this.requestLogs]
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

  private ensureInitialized(): void {
    if (!this.initialized) {
      throw new Error('RequestLogManager is not initialized')
    }
  }

  private loadRequestLogs(): RequestLogEntry[] {
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
          return JSON.parse(line) as RequestLogEntry
        } catch {
          return null
        }
      })
      .filter((entry): entry is RequestLogEntry => entry !== null)
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

    const content = this.requestLogs.map((entry) => JSON.stringify(entry)).join('\n')
    writeFileSync(this.logFile, content, 'utf-8')
    this.dirty = false
  }
}

function generateId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 11)}`
}

function stripId(entry: RequestLogEntry): Omit<RequestLogEntry, 'id'> {
  const { id: _id, ...rest } = entry
  return rest
}
