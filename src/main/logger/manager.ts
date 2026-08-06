import { app, BrowserWindow } from 'electron'
import * as fs from 'fs'
import * as path from 'path'
import type { LogEntry, LogLevel } from '../../shared/types'
import { IpcChannels } from '../ipc/channels'

interface LogStats {
  total: number
  info: number
  warn: number
  error: number
  debug: number
}

interface LogFilter {
  level?: LogLevel | 'all'
  keyword?: string
  startTime?: number
  endTime?: number
  limit?: number
  offset?: number
}

interface LogTrend {
  date: string
  total: number
  info: number
  warn: number
  error: number
}

class LogManager {
  private logs: LogEntry[] = []
  private logFile: string
  private maxLogs: number = 10000
  private retentionDays: number = 7
  private initialized: boolean = false
  private mainWindow: BrowserWindow | null = null

  constructor() {
    const userDataPath = app.getPath('userData')
    const logDir = path.join(userDataPath, 'logs')
    
    if (!fs.existsSync(logDir)) {
      fs.mkdirSync(logDir, { recursive: true })
    }
    
    this.logFile = path.join(logDir, 'app.log')
  }

  setMainWindow(window: BrowserWindow | null): void {
    this.mainWindow = window
  }

  async initialize(): Promise<void> {
    if (this.initialized) return
    
    try {
      await this.loadLogs()
      this.initialized = true
    } catch (error) {
      console.error('Failed to initialize log manager:', error)
      this.logs = []
      this.initialized = true
    }
  }

  private async loadLogs(): Promise<void> {
    try {
      if (fs.existsSync(this.logFile)) {
        const content = await fs.promises.readFile(this.logFile, 'utf-8')
        const lines = content.trim().split('\n').filter(Boolean)
        
        this.logs = lines
          .map(line => {
            try {
              return JSON.parse(line) as LogEntry
            } catch {
              return null
            }
          })
          .filter((log): log is LogEntry => log !== null)
          .slice(-this.maxLogs)
      }
    } catch (error) {
      console.error('Failed to load logs:', error)
      this.logs = []
    }
  }

  private async saveLogs(): Promise<void> {
    try {
      const content = this.logs.map(log => JSON.stringify(log)).join('\n')
      await fs.promises.writeFile(this.logFile, content, 'utf-8')
    } catch (error) {
      console.error('Failed to save logs:', error)
    }
  }

  log(
    level: LogLevel,
    message: string,
    data?: {
      accountId?: string
      providerId?: string
      requestId?: string
      data?: Record<string, unknown>
    }
  ): LogEntry {
    const entry: LogEntry = {
      id: `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
      timestamp: Date.now(),
      level,
      message,
      ...data,
    }

    this.logs.push(entry)

    if (this.logs.length > this.maxLogs) {
      this.logs = this.logs.slice(-this.maxLogs)
    }

    this.saveLogs().catch(console.error)

    this.mainWindow?.webContents.send(IpcChannels.LOGS_NEW_LOG, entry)

    return entry
  }

  info(message: string, data?: Parameters<LogManager['log']>[2]): LogEntry {
    return this.log('info', message, data)
  }

  warn(message: string, data?: Parameters<LogManager['log']>[2]): LogEntry {
    return this.log('warn', message, data)
  }

  error(message: string, data?: Parameters<LogManager['log']>[2]): LogEntry {
    return this.log('error', message, data)
  }

  debug(message: string, data?: Parameters<LogManager['log']>[2]): LogEntry {
    return this.log('debug', message, data)
  }

  getLogs(filter?: LogFilter): LogEntry[] {
    let filtered = [...this.logs]

    if (filter?.level && filter.level !== 'all') {
      filtered = filtered.filter(log => log.level === filter.level)
    }

    if (filter?.keyword) {
      const keyword = filter.keyword.toLowerCase()
      filtered = filtered.filter(log => 
        log.message.toLowerCase().includes(keyword)
      )
    }

    if (filter?.startTime) {
      filtered = filtered.filter(log => log.timestamp >= filter.startTime!)
    }

    if (filter?.endTime) {
      filtered = filtered.filter(log => log.timestamp <= filter.endTime!)
    }

    filtered.sort((a, b) => b.timestamp - a.timestamp)

    if (filter?.offset !== undefined) {
      filtered = filtered.slice(filter.offset)
    }

    if (filter?.limit !== undefined) {
      filtered = filtered.slice(0, filter.limit)
    }

    return filtered
  }

  getStats(): LogStats {
    const stats: LogStats = {
      total: this.logs.length,
      info: 0,
      warn: 0,
      error: 0,
      debug: 0,
    }

    for (const log of this.logs) {
      stats[log.level]++
    }

    return stats
  }

  getTrend(days: number = 7): LogTrend[] {
    const now = Date.now()
    const dayMs = 24 * 60 * 60 * 1000
    const trends: LogTrend[] = []

    for (let i = days - 1; i >= 0; i--) {
      const dayStart = now - (i + 1) * dayMs
      const dayEnd = now - i * dayMs
      const date = new Date(dayStart).toISOString().split('T')[0]

      const dayLogs = this.logs.filter(
        log => log.timestamp >= dayStart && log.timestamp < dayEnd
      )

      trends.push({
        date,
        total: dayLogs.length,
        info: dayLogs.filter(l => l.level === 'info').length,
        warn: dayLogs.filter(l => l.level === 'warn').length,
        error: dayLogs.filter(l => l.level === 'error').length,
      })
    }

    return trends
  }

  async clearLogs(): Promise<void> {
    this.logs = []
    await this.saveLogs()
  }

  async cleanOldLogs(): Promise<void> {
    const now = Date.now()
    const retentionMs = this.retentionDays * 24 * 60 * 60 * 1000
    
    this.logs = this.logs.filter(log => now - log.timestamp < retentionMs)
    await this.saveLogs()
  }

  setRetentionDays(days: number): void {
    this.retentionDays = days
  }

  setMaxLogs(max: number): void {
    this.maxLogs = max
    if (this.logs.length > this.maxLogs) {
      this.logs = this.logs.slice(-this.maxLogs)
      this.saveLogs().catch(console.error)
    }
  }

  exportLogs(format: 'json' | 'txt' = 'json'): string {
    if (format === 'json') {
      return JSON.stringify(this.logs, null, 2)
    }

    return this.logs
      .map(log => {
        const time = new Date(log.timestamp).toISOString()
        const level = log.level.toUpperCase().padEnd(5)
        let line = `[${time}] [${level}] ${log.message}`
        
        if (log.providerId) {
          line += ` | Provider: ${log.providerId}`
        }
        if (log.accountId) {
          line += ` | Account: ${log.accountId}`
        }
        if (log.requestId) {
          line += ` | Request: ${log.requestId}`
        }
        if (log.data) {
          line += ` | Data: ${JSON.stringify(log.data)}`
        }
        
        return line
      })
      .join('\n')
  }

  getLogById(id: string): LogEntry | undefined {
    return this.logs.find(log => log.id === id)
  }
}

export const logManager = new LogManager()
