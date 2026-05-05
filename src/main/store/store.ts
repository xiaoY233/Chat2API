/**
 * Credential Storage Module - Core Storage Implementation
 * Uses SQLite for persistent storage (replaced electron-store for better performance)
 * Uses Electron's safeStorage API for sensitive data encryption
 */

import { app, safeStorage, BrowserWindow } from 'electron'
import { homedir } from 'os'
import { join } from 'path'
import {
  StoreSchema,
  AppConfig,
  Account,
  Provider,
  LogEntry,
  DEFAULT_CONFIG,
  BUILTIN_PROVIDERS,
  LogLevel,
  SystemPrompt,
  SessionRecord,
  SessionConfig,
  DEFAULT_SESSION_CONFIG,
  ChatMessage,
  RequestLogEntry,
  RequestLogConfig,
  PersistentStatistics,
  DailyStatistics,
  DEFAULT_STATISTICS,
  EffectiveModel,
  ProviderModelOverrides,
  DEFAULT_USER_MODEL_OVERRIDES,
  UserModelOverrides,
  CustomModel,
  DEFAULT_REQUEST_LOG_CONFIG,
} from './types'
import { BUILTIN_PROMPTS } from '../data/builtin-prompts'
import { RequestLogManager } from '../requestLogs/manager'
import { normalizeRequestLogConfig } from '../requestLogs/types'
import { sqliteStore, SQLiteStore } from './sqlite'

/**
 * Storage Manager Class
 * Responsible for data persistence and encryption
 * Now backed by SQLite instead of electron-store
 */
class StoreManager {
  private isInitialized: boolean = false
  private mainWindow: BrowserWindow | null = null
  private initializationError: Error | null = null
  private requestLogManager: RequestLogManager | null = null
  private db: SQLiteStore

  constructor() {
    this.db = sqliteStore
  }

  setMainWindow(window: BrowserWindow | null): void {
    this.mainWindow = window
  }

  /**
   * Check if storage has initialization error
   */
  hasInitializationError(): boolean {
    return this.initializationError !== null
  }

  /**
   * Get initialization error
   */
  getInitializationError(): Error | null {
    return this.initializationError
  }

  /**
   * Initialize Storage
   * Initialize SQLite database and migrate from electron-store if needed
   */
  async initialize(): Promise<void> {
    if (this.isInitialized) {
      return
    }

    try {
      await this.db.initialize()
      // Get config directly from db to avoid ensureInitialized check
      const config = this.db.getConfig()
      if (!config) {
        throw new Error('Failed to load configuration after database initialization')
      }
      await this.initializeRequestLogManager(config)
      this.isInitialized = true
      this.initializationError = null

      // Ensure credentials encryption consistency after migration
      await this.ensureCredentialsEncryptionConsistency()
    } catch (error) {
      console.error('[Store] Failed to initialize storage:', error)
      this.initializationError = error instanceof Error ? error : new Error(String(error))
      throw this.initializationError
    }
  }

  private async initializeRequestLogManager(config: AppConfig): Promise<void> {
    const storagePath = join(homedir(), '.chat2api')
    this.requestLogManager = new RequestLogManager({
      storageDir: join(storagePath, 'request-logs'),
      config: config.requestLogConfig,
    })
    await this.requestLogManager.initialize()
  }

  private ensureInitialized(): void {
    if (!this.isInitialized) {
      const errorMsg = this.initializationError
        ? `Storage initialization failed: ${this.initializationError.message}`
        : 'Storage not initialized, please call initialize() first'
      throw new Error(errorMsg)
    }
  }

  private getLogPriority(level: LogLevel): number {
    switch (level) {
      case 'debug':
        return 10
      case 'info':
        return 20
      case 'warn':
        return 30
      case 'error':
        return 40
      default:
        return 20
    }
  }

  private shouldRecordLog(level: LogLevel): boolean {
    const config = this.getConfig()
    return this.getLogPriority(level) >= this.getLogPriority(config.logLevel)
  }

  /**
   * Encrypt Sensitive Data
   * @param data Data to encrypt
   * @returns Encrypted string
   */
  encryptData(data: string): string {
    try {
      if (safeStorage.isEncryptionAvailable()) {
        if (!this.getConfig().credentialEncryption) {
          return data
        }
        const encrypted = Buffer.from(safeStorage.encryptString(data))
        return encrypted.toString('base64')
      }
    } catch (error) {
      console.error('Failed to encrypt data:', error)
    }
    return data
  }

  /**
   * Decrypt Sensitive Data
   * @param encryptedData Encrypted data
   * @returns Decrypted string
   */
  decryptData(encryptedData: string): string {
    // If global credential encryption is disabled, return as plaintext directly
    const config = this.getConfig()
    if (!config.credentialEncryption || !safeStorage.isEncryptionAvailable()) {
      return encryptedData
    }

    // If not a base64 string, assume it's already plaintext
    if (!encryptedData || !/^[A-Za-z0-9+/]*={0,2}$/.test(encryptedData)) {
      return encryptedData
    }

    try {
      const buffer = Buffer.from(encryptedData, 'base64')
      return safeStorage.decryptString(buffer)
    } catch (error) {
      // Only log if it looks like it should have been encrypted
      if (encryptedData.length > 20) {
        console.warn('[Store] Failed to decrypt data, returning as plaintext:', error instanceof Error ? error.message : String(error))
      }
      return encryptedData
    }
  }

  /**
   * Encrypt Credentials Object
   * @param credentials Credentials object
   * @returns Encrypted credentials object
   */
  encryptCredentials(credentials: Record<string, string>): Record<string, string> {
    const encrypted: Record<string, string> = {}
    for (const [key, value] of Object.entries(credentials)) {
      encrypted[key] = this.encryptData(value)
    }
    return encrypted
  }

  /**
   * Decrypt Credentials Object
   * @param encryptedCredentials Encrypted credentials object
   * @returns Decrypted credentials object
   */
  decryptCredentials(encryptedCredentials: Record<string, string>): Record<string, string> {
    const decrypted: Record<string, string> = {}
    for (const [key, value] of Object.entries(encryptedCredentials)) {
      decrypted[key] = this.decryptData(value)
    }
    return decrypted
  }

  // ==================== Provider Operations ====================

  getProviders(): Provider[] {
    this.ensureInitialized()
    return this.db.getProviders()
  }

  getProviderById(id: string): Provider | undefined {
    this.ensureInitialized()
    return this.db.getProviderById(id)
  }

  addProvider(provider: Provider): void {
    this.ensureInitialized()
    this.db.addProvider(provider)
  }

  updateProvider(id: string, updates: Partial<Provider>): Provider | null {
    this.ensureInitialized()
    return this.db.updateProvider(id, updates)
  }

  deleteProvider(id: string): boolean {
    this.ensureInitialized()
    return this.db.deleteProvider(id)
  }

  // ==================== Model Overrides Operations ====================

  getModelOverrides(providerId: string): ProviderModelOverrides | undefined {
    this.ensureInitialized()
    const overrides = this.db.getUserModelOverrides()
    return overrides[providerId]
  }

  hasModelOverrides(providerId: string): boolean {
    const overrides = this.getModelOverrides(providerId)
    return !!(overrides && (overrides.addedModels?.length || overrides.excludedModels?.length))
  }

  // ==================== Account Operations ====================

  getAccounts(includeCredentials: boolean = false): Account[] {
    this.ensureInitialized()
    const accounts = this.db.getAccounts()
    if (includeCredentials) {
      return accounts.map(account => ({
        ...account,
        credentials: this.decryptCredentials(account.credentials),
      }))
    }
    return accounts
  }

  getAccountById(id: string, includeCredentials: boolean = false): Account | undefined {
    this.ensureInitialized()
    const account = this.db.getAccountById(id)
    if (account && includeCredentials) {
      return {
        ...account,
        credentials: this.decryptCredentials(account.credentials),
      }
    }
    return account
  }

  getAccountsByProviderId(providerId: string, includeCredentials: boolean = false): Account[] {
    this.ensureInitialized()
    const accounts = this.db.getAccountsByProviderId(providerId)
    if (includeCredentials) {
      return accounts.map(account => ({
        ...account,
        credentials: this.decryptCredentials(account.credentials),
      }))
    }
    return accounts
  }

  addAccount(account: Account): void {
    this.ensureInitialized()
    const encryptedAccount: Account = {
      ...account,
      credentials: this.encryptCredentials(account.credentials),
    }
    this.db.addAccount(encryptedAccount)
  }

  updateAccount(id: string, updates: Partial<Account>): Account | null {
    this.ensureInitialized()
    const existing = this.db.getAccountById(id)
    if (!existing) return null

    let encryptedUpdates = { ...updates }
    if (updates.credentials) {
      encryptedUpdates.credentials = this.encryptCredentials(updates.credentials)
    }

    const updated = { ...existing, ...encryptedUpdates, updatedAt: Date.now() }
    this.db.updateAccount(id, updated)
    return {
      ...updated,
      credentials: updates.credentials || this.decryptCredentials(existing.credentials),
    }
  }

  deleteAccount(id: string): boolean {
    this.ensureInitialized()
    return this.db.deleteAccount(id)
  }

  getActiveAccounts(includeCredentials: boolean = false): Account[] {
    this.ensureInitialized()
    const accounts = this.db.getAccounts()
    const active = accounts.filter(a => a.status === 'active')
    if (includeCredentials) {
      return active.map(account => ({
        ...account,
        credentials: this.decryptCredentials(account.credentials),
      }))
    }
    return active
  }

  // ==================== Configuration Operations ====================

  getConfig(): AppConfig {
    this.ensureInitialized()
    const config = this.db.getConfig()
    if (!config) {
      // This should not happen as db initializes default config
      return DEFAULT_CONFIG
    }
    return config
  }

  setConfig(config: AppConfig): void {
    this.ensureInitialized()
    this.db.setConfig(config)
    this.requestLogManager?.setConfig(config.requestLogConfig)
  }

  updateConfig(updates: Partial<AppConfig>): AppConfig {
    this.ensureInitialized()
    const currentConfig = this.getConfig()
    const newConfig = {
      ...currentConfig,
      ...updates,
    }

    if (updates.toolPromptConfig && currentConfig.toolPromptConfig) {
      newConfig.toolPromptConfig = {
        ...currentConfig.toolPromptConfig,
        ...updates.toolPromptConfig,
      }
    }

    if (updates.sessionConfig && currentConfig.sessionConfig) {
      newConfig.sessionConfig = {
        ...currentConfig.sessionConfig,
        ...updates.sessionConfig,
      }
    }

    if (updates.requestLogConfig) {
      newConfig.requestLogConfig = normalizeRequestLogConfig({
        ...currentConfig.requestLogConfig,
        ...updates.requestLogConfig,
      })
    }

    this.db.setConfig(newConfig)
    this.requestLogManager?.setConfig(newConfig.requestLogConfig)

    // If credential encryption setting changed, re-normalize credentials
    if (updates.credentialEncryption !== undefined && updates.credentialEncryption !== currentConfig.credentialEncryption) {
      // Run asynchronously without awaiting to avoid blocking the config update
      this.ensureCredentialsEncryptionConsistency().catch(err => {
        console.error('[Store] Failed to re-normalize credentials after encryption setting change:', err)
      })
    }

    return newConfig
  }

  resetConfig(): AppConfig {
    this.ensureInitialized()
    this.db.setConfig(DEFAULT_CONFIG)
    this.requestLogManager?.setConfig(DEFAULT_CONFIG.requestLogConfig)
    return DEFAULT_CONFIG
  }

  // ==================== Log Operations ====================

  addLog(
    level: LogLevel,
    message: string,
    data?: {
      accountId?: string
      providerId?: string
      requestId?: string
      data?: Record<string, unknown>
      model?: string
      actualModel?: string
      latency?: number
      isStream?: boolean
      error?: string
    }
  ): LogEntry {
    this.ensureInitialized()
    const entry: LogEntry = {
      id: this.generateId(),
      timestamp: Date.now(),
      level,
      message,
      ...data,
    }

    if (!this.shouldRecordLog(level)) {
      return entry
    }

    this.db.addLog(entry)
    return entry
  }

  getLogs(limit?: number, level?: LogLevel): LogEntry[] {
    this.ensureInitialized()
    return this.db.getLogs(limit, level)
  }

  clearLogs(): void {
    this.ensureInitialized()
    this.db.clearLogs()
  }

  getLogStats(): { total: number; info: number; warn: number; error: number; debug: number } {
    this.ensureInitialized()
    const logs = this.db.getLogs(undefined, undefined)
    return {
      total: logs.length,
      info: logs.filter(l => l.level === 'info').length,
      warn: logs.filter(l => l.level === 'warn').length,
      error: logs.filter(l => l.level === 'error').length,
      debug: logs.filter(l => l.level === 'debug').length,
    }
  }

  getLogTrend(days: number = 7): { date: string; total: number; info: number; warn: number; error: number }[] {
    this.ensureInitialized()
    const logs = this.db.getLogs(undefined, undefined)
    const now = Date.now()
    const dayMs = 24 * 60 * 60 * 1000
    const trends: { date: string; total: number; info: number; warn: number; error: number }[] = []

    for (let i = days - 1; i >= 0; i--) {
      const dayStart = now - (i + 1) * dayMs
      const dayEnd = now - i * dayMs
      const date = new Date(dayStart).toISOString().split('T')[0]

      const dayLogs = logs.filter(l => l.timestamp >= dayStart && l.timestamp < dayEnd)

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

  getAccountLogTrend(accountId: string, days: number = 7): { date: string; total: number; info: number; warn: number; error: number }[] {
    this.ensureInitialized()
    const logs = this.db.getLogs(undefined, undefined)
    const accountLogs = logs.filter(l => l.accountId === accountId && l.requestId)
    const now = Date.now()
    const dayMs = 24 * 60 * 60 * 1000
    const trends: { date: string; total: number; info: number; warn: number; error: number }[] = []

    for (let i = days - 1; i >= 0; i--) {
      const dayStart = now - (i + 1) * dayMs
      const dayEnd = now - i * dayMs
      const date = new Date(dayStart).toISOString().split('T')[0]

      const dayLogs = accountLogs.filter(l => l.timestamp >= dayStart && l.timestamp < dayEnd)

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

  exportLogs(format: 'json' | 'txt' = 'json'): string {
    this.ensureInitialized()
    const logs = this.db.getLogs(undefined, undefined)

    if (format === 'json') {
      return JSON.stringify(logs, null, 2)
    }

    return logs
      .map(log => {
        const time = new Date(log.timestamp).toISOString()
        const level = log.level.toUpperCase().padEnd(5)
        let line = `[${time}] [${level}] ${log.message}`
        if (log.providerId) line += ` | Provider: ${log.providerId}`
        if (log.accountId) line += ` | Account: ${log.accountId}`
        if (log.requestId) line += ` | Request: ${log.requestId}`
        if (log.data) line += ` | Data: ${JSON.stringify(log.data)}`
        return line
      })
      .join('\n')
  }

  getLogById(id: string): LogEntry | undefined {
    this.ensureInitialized()
    const logs = this.db.getLogs(undefined, undefined)
    return logs.find(l => l.id === id)
  }

  cleanExpiredLogs(): void {
    this.ensureInitialized()
    const config = this.getConfig()
    this.db.cleanExpiredLogs(config.logRetentionDays)
  }

  // ==================== Request Log Operations ====================

  addRequestLog(entry: Omit<RequestLogEntry, 'id'>): RequestLogEntry {
    this.ensureInitialized()
    return this.getRequestLogManager().addRequestLog(entry)
  }

  updateRequestLog(id: string, updates: Partial<RequestLogEntry>): boolean {
    this.ensureInitialized()
    return this.getRequestLogManager().updateRequestLog(id, updates)
  }

  getRequestLogs(limit?: number, filter?: { status?: 'success' | 'error'; providerId?: string }): RequestLogEntry[] {
    this.ensureInitialized()
    return this.getRequestLogManager().getRequestLogs(limit, filter)
  }

  getRequestLogById(id: string): RequestLogEntry | undefined {
    this.ensureInitialized()
    return this.getRequestLogManager().getRequestLogById(id)
  }

  clearRequestLogs(): void {
    this.ensureInitialized()
    this.getRequestLogManager().clearRequestLogs()
    // Reset statistics as well
    this.db.setStatistics(DEFAULT_STATISTICS)
  }

  getRequestLogStats(): { total: number; success: number; error: number; todayTotal: number; todaySuccess: number; todayError: number } {
    this.ensureInitialized()
    return this.getRequestLogManager().getRequestLogStats()
  }

  getRequestLogTrend(days: number = 7): { date: string; total: number; success: number; error: number; avgLatency: number }[] {
    this.ensureInitialized()
    return this.getRequestLogManager().getRequestLogTrend(days)
  }

  // ==================== Statistics Operations ====================

  getStatistics(): PersistentStatistics {
    this.ensureInitialized()
    const stats = this.db.getStatistics()
    return stats || DEFAULT_STATISTICS
  }

  updateStatistics(updates: Partial<PersistentStatistics>): PersistentStatistics {
    this.ensureInitialized()
    const currentStats = this.getStatistics()
    const newStats = {
      ...currentStats,
      ...updates,
      lastUpdated: Date.now(),
    }
    this.db.setStatistics(newStats)
    return newStats
  }

  recordRequestInStats(
    success: boolean,
    latency: number,
    model?: string,
    providerId?: string,
    accountId?: string
  ): PersistentStatistics {
    this.ensureInitialized()
    const stats = this.getStatistics()
    const today = new Date().toISOString().split('T')[0]

    const newStats: PersistentStatistics = {
      ...stats,
      totalRequests: stats.totalRequests + 1,
      successRequests: success ? stats.successRequests + 1 : stats.successRequests,
      failedRequests: success ? stats.failedRequests : stats.failedRequests + 1,
      totalLatency: success ? stats.totalLatency + latency : stats.totalLatency,
      lastUpdated: Date.now(),
      modelUsage: { ...stats.modelUsage },
      providerUsage: { ...stats.providerUsage },
      accountUsage: { ...stats.accountUsage },
      dailyStats: { ...stats.dailyStats },
    }

    if (model) {
      newStats.modelUsage[model] = (newStats.modelUsage[model] || 0) + 1
    }
    if (providerId) {
      newStats.providerUsage[providerId] = (newStats.providerUsage[providerId] || 0) + 1
    }
    if (accountId) {
      newStats.accountUsage[accountId] = (newStats.accountUsage[accountId] || 0) + 1
    }

    if (!newStats.dailyStats[today]) {
      newStats.dailyStats[today] = {
        date: today,
        totalRequests: 0,
        successRequests: 0,
        failedRequests: 0,
        totalLatency: 0,
        modelUsage: {},
        providerUsage: {},
      }
    }

    newStats.dailyStats[today].totalRequests++
    if (success) {
      newStats.dailyStats[today].successRequests++
      newStats.dailyStats[today].totalLatency += latency
    } else {
      newStats.dailyStats[today].failedRequests++
    }

    if (model) {
      newStats.dailyStats[today].modelUsage[model] = (newStats.dailyStats[today].modelUsage[model] || 0) + 1
    }
    if (providerId) {
      newStats.dailyStats[today].providerUsage[providerId] = (newStats.dailyStats[today].providerUsage[providerId] || 0) + 1
    }

    this.db.setStatistics(newStats)
    return newStats
  }

  getTodayStatistics(): DailyStatistics {
    this.ensureInitialized()
    const stats = this.getStatistics()
    const today = new Date().toISOString().split('T')[0]
    return stats.dailyStats[today] || {
      date: today,
      totalRequests: 0,
      successRequests: 0,
      failedRequests: 0,
      totalLatency: 0,
      modelUsage: {},
      providerUsage: {},
    }
  }

  cleanOldDailyStats(): void {
    this.ensureInitialized()
    const stats = this.getStatistics()
    const cutoff = Date.now() - 30 * 24 * 60 * 60 * 1000
    const cutoffDate = new Date(cutoff).toISOString().split('T')[0]

    const filteredDailyStats: Record<string, DailyStatistics> = {}
    for (const [date, dayStats] of Object.entries(stats.dailyStats)) {
      if (date >= cutoffDate) {
        filteredDailyStats[date] = dayStats as DailyStatistics
      }
    }

    if (Object.keys(filteredDailyStats).length !== Object.keys(stats.dailyStats).length) {
      stats.dailyStats = filteredDailyStats
      this.db.setStatistics(stats)
    }
  }

  // ==================== System Prompts Operations ====================

  getSystemPrompts(): SystemPrompt[] {
    this.ensureInitialized()
    return this.db.getSystemPrompts()
  }

  getBuiltinPrompts(): SystemPrompt[] {
    return BUILTIN_PROMPTS
  }

  getCustomPrompts(): SystemPrompt[] {
    this.ensureInitialized()
    return this.db.getCustomPrompts()
  }

  getSystemPromptById(id: string): SystemPrompt | undefined {
    return this.getSystemPrompts().find(p => p.id === id)
  }

  addSystemPrompt(prompt: Omit<SystemPrompt, 'id' | 'createdAt' | 'updatedAt'>): SystemPrompt {
    this.ensureInitialized()
    return this.db.addSystemPrompt(prompt)
  }

  updateSystemPrompt(id: string, updates: Partial<SystemPrompt>): SystemPrompt | null {
    this.ensureInitialized()
    return this.db.updateSystemPrompt(id, updates)
  }

  deleteSystemPrompt(id: string): boolean {
    this.ensureInitialized()
    return this.db.deleteSystemPrompt(id)
  }

  getSystemPromptsByType(type: SystemPrompt['type']): SystemPrompt[] {
    return this.getSystemPrompts().filter(p => p.type === type)
  }

  // ==================== Session Operations ====================

  getSessionConfig(): SessionConfig {
    this.ensureInitialized()
    const config = this.getConfig()
    return config.sessionConfig || DEFAULT_SESSION_CONFIG
  }

  updateSessionConfig(updates: Partial<SessionConfig>): SessionConfig {
    this.ensureInitialized()
    const currentConfig = this.getConfig()
    const newSessionConfig = {
      ...(currentConfig.sessionConfig || DEFAULT_SESSION_CONFIG),
      ...updates,
    }
    this.updateConfig({ sessionConfig: newSessionConfig })
    return newSessionConfig
  }

  getSessions(): SessionRecord[] {
    this.ensureInitialized()
    return this.db.getSessions()
  }

  getSessionById(id: string): SessionRecord | undefined {
    this.ensureInitialized()
    return this.db.getSessionById(id)
  }

  getActiveSessions(): SessionRecord[] {
    this.ensureInitialized()
    const config = this.getSessionConfig()
    const timeoutMs = config.sessionTimeout * 60 * 1000
    const now = Date.now()
    const sessions = this.db.getSessions()
    return sessions.filter(s => s.status === 'active' && (now - s.lastActiveAt) < timeoutMs)
  }

  addSession(session: SessionRecord): void {
    this.ensureInitialized()
    this.db.addSession(session)
  }

  updateSession(id: string, updates: Partial<SessionRecord>): SessionRecord | null {
    this.ensureInitialized()
    return this.db.updateSession(id, updates)
  }

  addMessageToSession(sessionId: string, message: ChatMessage): SessionRecord | null {
    this.ensureInitialized()
    const session = this.db.getSessionById(sessionId)
    if (!session) return null

    const config = this.getSessionConfig()
    let messages = session.messages
    if (messages.length >= config.maxMessagesPerSession) {
      messages = messages.slice(-config.maxMessagesPerSession + 1)
    }
    messages.push(message)

    const updated = { ...session, messages, lastActiveAt: Date.now() }
    this.db.updateSession(sessionId, updated)
    return updated
  }

  deleteSession(id: string): boolean {
    this.ensureInitialized()
    return this.db.deleteSession(id)
  }

  expireSession(id: string): SessionRecord | null {
    return this.updateSession(id, { status: 'expired' })
  }

  cleanExpiredSessions(): number {
    this.ensureInitialized()
    const sessions = this.db.getSessions()
    const config = this.getSessionConfig()
    const timeoutMs = config.sessionTimeout * 60 * 1000
    const now = Date.now()

    let removedCount = 0

    // Delete sessions with expired status directly
    let remaining = sessions.filter(s => {
      if (s.status === 'expired') {
        removedCount++
        return false
      }
      return true
    })

    // Handle timed-out active sessions
    if (config.deleteAfterTimeout) {
      remaining = remaining.filter(s => {
        if (s.status === 'active' && (now - s.lastActiveAt) >= timeoutMs) {
          removedCount++
          return false
        }
        return true
      })
    } else {
      remaining = remaining.map(s => {
        if (s.status === 'active' && (now - s.lastActiveAt) >= timeoutMs) {
          removedCount++
          return { ...s, status: 'expired' as const }
        }
        return s
      })
    }

    // Clear and re-insert
    this.db.clearAllSessions()
    for (const s of remaining) {
      this.db.addSession(s)
    }

    return removedCount
  }

  getSessionsByAccountId(accountId: string): SessionRecord[] {
    this.ensureInitialized()
    return this.db.getSessionsByAccountId(accountId)
  }

  getSessionsByProviderId(providerId: string): SessionRecord[] {
    this.ensureInitialized()
    return this.db.getSessionsByProviderId(providerId)
  }

  clearAllSessions(): void {
    this.ensureInitialized()
    this.db.clearAllSessions()
  }

  // ==================== Model Management Operations ====================

  private getUserModelOverrides(): UserModelOverrides {
    this.ensureInitialized()
    return this.db.getUserModelOverrides()
  }

  private setUserModelOverrides(overrides: UserModelOverrides): void {
    this.ensureInitialized()
    this.db.setUserModelOverrides(overrides)
  }

  private getProviderModelOverrides(providerId: string): ProviderModelOverrides {
    const overrides = this.getUserModelOverrides()
    return overrides[providerId] || { addedModels: [], excludedModels: [] }
  }

  getEffectiveModels(providerId: string): EffectiveModel[] {
    this.ensureInitialized()
    const provider = this.getProviderById(providerId)
    if (!provider) return []

    const defaultModels = provider.supportedModels || []
    const modelMappings = provider.modelMappings || {}
    const overrides = this.getProviderModelOverrides(providerId)

    const effectiveModels: EffectiveModel[] = []

    defaultModels.forEach(displayName => {
      if (!overrides.excludedModels.includes(displayName)) {
        const actualModelId = modelMappings[displayName] || displayName
        effectiveModels.push({ displayName, actualModelId, isCustom: false })
      }
    })

    overrides.addedModels.forEach(customModel => {
      effectiveModels.push({
        displayName: customModel.displayName,
        actualModelId: customModel.actualModelId,
        isCustom: true,
      })
    })

    return effectiveModels
  }

  addCustomModel(providerId: string, model: CustomModel): EffectiveModel[] {
    this.ensureInitialized()
    const overrides = this.getUserModelOverrides()
    if (!overrides[providerId]) {
      overrides[providerId] = { addedModels: [], excludedModels: [] }
    }

    const existing = overrides[providerId].addedModels.find(
      m => m.displayName === model.displayName || m.actualModelId === model.actualModelId
    )
    if (existing) {
      throw new Error(`Model with display name "${model.displayName}" or actual ID "${model.actualModelId}" already exists`)
    }

    overrides[providerId].addedModels.push(model)
    this.setUserModelOverrides(overrides)
    return this.getEffectiveModels(providerId)
  }

  removeModel(providerId: string, modelName: string): EffectiveModel[] {
    this.ensureInitialized()
    const provider = this.getProviderById(providerId)
    if (!provider) throw new Error('Provider not found')

    const overrides = this.getUserModelOverrides()
    if (!overrides[providerId]) {
      overrides[providerId] = { addedModels: [], excludedModels: [] }
    }

    const defaultModels = provider.supportedModels || []
    const isDefaultModel = defaultModels.includes(modelName)

    if (isDefaultModel) {
      if (!overrides[providerId].excludedModels.includes(modelName)) {
        overrides[providerId].excludedModels.push(modelName)
      }
    } else {
      overrides[providerId].addedModels = overrides[providerId].addedModels.filter(m => m.displayName !== modelName)
    }

    this.setUserModelOverrides(overrides)
    return this.getEffectiveModels(providerId)
  }

  resetModels(providerId: string): EffectiveModel[] {
    this.ensureInitialized()
    const overrides = this.getUserModelOverrides()
    if (overrides[providerId]) {
      delete overrides[providerId]
      this.setUserModelOverrides(overrides)
    }
    return this.getEffectiveModels(providerId)
  }

  // ==================== Generic Key-Value Store (for backward compatibility) ====================

  async getItem(key: string): Promise<unknown> {
    this.ensureInitialized()
    // Handle known keys
    switch (key) {
      case 'providers':
        return this.db.getProviders()
      case 'accounts':
        return this.db.getAccounts()
      case 'config':
        return this.db.getConfig() || DEFAULT_CONFIG
      case 'systemPrompts':
        return this.db.getCustomPrompts()
      case 'sessions':
        return this.db.getSessions()
      case 'statistics':
        return this.db.getStatistics() || DEFAULT_STATISTICS
      case 'userModelOverrides':
        return this.db.getUserModelOverrides()
      case 'logs':
        return this.db.getLogs(undefined, undefined)
      case 'requestLogs':
        return this.requestLogManager?.getRequestLogs(undefined, undefined) || []
      default:
        // For unknown keys, try generic table
        return this.db.getGeneric(key)
    }
  }

  async setItem(key: string, value: unknown): Promise<void> {
    this.ensureInitialized()
    switch (key) {
      case 'providers':
        // Not implemented (use addProvider/updateProvider)
        console.warn('[Store] Direct set of providers not supported')
        break
      case 'accounts':
        console.warn('[Store] Direct set of accounts not supported')
        break
      case 'config':
        this.db.setConfig(value as AppConfig)
        break
      case 'systemPrompts':
        console.warn('[Store] Direct set of systemPrompts not supported')
        break
      case 'sessions':
        console.warn('[Store] Direct set of sessions not supported')
        break
      case 'statistics':
        this.db.setStatistics(value as PersistentStatistics)
        break
      case 'userModelOverrides':
        this.db.setUserModelOverrides(value as UserModelOverrides)
        break
      case 'logs':
        // Not supported, use addLog
        console.warn('[Store] Direct set of logs not supported')
        break
      case 'requestLogs':
        console.warn('[Store] Direct set of requestLogs not supported')
        break
      default:
        await this.db.setGeneric(key, value)
    }
  }

  async deleteItem(key: string): Promise<void> {
    this.ensureInitialized()
    switch (key) {
      case 'logs':
        this.db.clearLogs()
        break
      case 'requestLogs':
        this.requestLogManager?.clearRequestLogs()
        break
      default:
        await this.db.deleteGeneric(key)
    }
  }

  // ==================== Utility Methods ====================

  generateId(): string {
    return `${Date.now()}-${Math.random().toString(36).substring(2, 11)}`
  }

  flushPendingWrites(): void {
    // No-op for SQLite (writes are immediate)
  }

  clearAll(): void {
    this.ensureInitialized()
    // Clear all tables
    this.db.clearLogs()
    this.db.clearAllSessions()
    this.db.setUserModelOverrides({})
    // Delete all accounts and providers but keep built-in providers?
    // Simpler: reinitialize with defaults
    const providers = this.db.getProviders()
    const builtinIds = BUILTIN_PROVIDERS.map(p => p.id)
    for (const p of providers) {
      if (!builtinIds.includes(p.id)) {
        this.db.deleteProvider(p.id)
      }
    }
    for (const acc of this.db.getAccounts()) {
      this.db.deleteAccount(acc.id)
    }
    this.db.setStatistics(DEFAULT_STATISTICS)
    this.db.setConfig(DEFAULT_CONFIG)
    this.requestLogManager?.clearRequestLogs()
  }

  exportData(): Omit<StoreSchema, 'accounts'> & { accounts: Omit<Account, 'credentials'>[] } {
    this.ensureInitialized()
    const providers = this.db.getProviders()
    const accounts = this.db.getAccounts().map(a => {
      const { credentials, ...rest } = a
      return rest
    })
    const config = this.db.getConfig() || DEFAULT_CONFIG
    const logs = this.db.getLogs(undefined, undefined)
    const requestLogs = this.requestLogManager?.exportRequestLogs() || []
    const systemPrompts = this.db.getCustomPrompts()
    const sessions = this.db.getSessions()
    const statistics = this.db.getStatistics() || DEFAULT_STATISTICS
    const userModelOverrides = this.db.getUserModelOverrides()

    return {
      providers,
      accounts,
      config,
      logs,
      requestLogs,
      systemPrompts,
      sessions,
      statistics,
      userModelOverrides,
    }
  }

  getStorePath(): string {
    return join(homedir(), '.chat2api')
  }

  /**
   * Get Store instance (for backward compatibility with electron-store)
   * Returns null since SQLite doesn't have a store instance
   */
  getStore(): null {
    return null
  }

  /**
   * Get Logs Store instance (for backward compatibility with electron-store)
   * Returns null since SQLite doesn't have a separate logs store
   */
  getLogsStore(): null {
    return null
  }

  /**
   * Ensure credentials encryption consistency with current config
   * Converts all stored credentials to match the current encryption setting
   */
  private async ensureCredentialsEncryptionConsistency(): Promise<void> {
    const config = this.getConfig()
    const shouldEncrypt = config.credentialEncryption && safeStorage.isEncryptionAvailable()
    const accounts = this.db.getAccounts()
    let modifiedCount = 0

    for (const account of accounts) {
      const storedCreds = account.credentials
      const newCreds: Record<string, string> = {}
      let needsUpdate = false

      for (const [key, value] of Object.entries(storedCreds)) {
        // Determine if the current value is encrypted
        let isEncrypted = false
        if (safeStorage.isEncryptionAvailable() && /^[A-Za-z0-9+/]*={0,2}$/.test(value) && value.length > 20) {
          // Attempt to decrypt to see if it's valid encrypted data
          try {
            const buffer = Buffer.from(value, 'base64')
            safeStorage.decryptString(buffer)
            isEncrypted = true
          } catch {
            // Not valid encrypted data
          }
        }

        if (shouldEncrypt && !isEncrypted) {
          // Need to encrypt plaintext
          try {
            const encrypted = safeStorage.encryptString(value)
            newCreds[key] = encrypted.toString('base64')
            needsUpdate = true
          } catch (err) {
            console.error(`[Store] Failed to encrypt credential ${key} for account ${account.id}:`, err)
            newCreds[key] = value // keep as plaintext
          }
        } else if (!shouldEncrypt && isEncrypted) {
          // Need to decrypt to plaintext
          try {
            const buffer = Buffer.from(value, 'base64')
            const decrypted = safeStorage.decryptString(buffer)
            newCreds[key] = decrypted
            needsUpdate = true
          } catch (err) {
            console.error(`[Store] Failed to decrypt credential ${key} for account ${account.id}:`, err)
            newCreds[key] = value // keep as is
          }
        } else {
          // Already correct format
          newCreds[key] = value
        }
      }

      if (needsUpdate) {
        const updatedAccount = { ...account, credentials: newCreds, updatedAt: Date.now() }
        this.db.updateAccount(account.id, updatedAccount)
        modifiedCount++
      }
    }

    if (modifiedCount > 0) {
      console.log(`[Store] Normalized credentials encryption for ${modifiedCount} accounts (encryption=${shouldEncrypt})`)
    }
  }

  private getRequestLogManager(): RequestLogManager {
    if (!this.requestLogManager) {
      throw new Error('Request log manager is not initialized')
    }
    return this.requestLogManager
  }
}

// Export singleton instance
export const storeManager = new StoreManager()
