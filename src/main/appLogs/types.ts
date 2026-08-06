import type { LogLevel } from '../store/types.ts'

export interface AppLogFilter {
  level?: LogLevel | 'all'
  keyword?: string
  startTime?: number
  endTime?: number
  limit?: number
  offset?: number
}

export interface AppLogStats {
  total: number
  info: number
  warn: number
  error: number
  debug: number
}

export interface AppLogTrendPoint {
  date: string
  total: number
  info: number
  warn: number
  error: number
}
