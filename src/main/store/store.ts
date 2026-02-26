/**
 * Credential Storage Module - Core Storage Implementation
 * Uses electron-store for persistent storage
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
} from './types'
import { IpcChannels } from '../ipc/channels'

// Dynamically import electron-store (ESM module)
let Store: any = null

/**
 * Storage Instance Type Definition
 */
type StoreType = any

/**
 * Storage Manager Class
 * Responsible for data persistence and encryption
 */
class StoreManager {
  private store: StoreType | null = null
  private isInitialized: boolean = false
  private mainWindow: BrowserWindow | null = null

  setMainWindow(window: BrowserWindow | null): void {
    this.mainWindow = window
  }

  /**
   * Initialize Storage
   * Create storage instance and initialize default data
   */
  async initialize(): Promise<void> {
    if (this.isInitialized) {
      return
    }

    // Dynamically import electron-store (ESM module)
    if (!Store) {
      const module = await import('electron-store')
      Store = module.default
    }

    const storagePath = this.getStoragePath()

    this.store = new Store({
      name: 'data',
      cwd: storagePath,
      defaults: this.getDefaultData(),
      encryptionKey: this.getEncryptionKey(),
    })

    await this.initializeDefaultProviders()
    this.isInitialized = true
  }

  /**
   * Get Storage Path
   * Storage path: ~/.chat2api/
   */
  private getStoragePath(): string {
    return join(homedir(), '.chat2api')
  }

  /**
   * Get Encryption Key
   * Uses Electron's safeStorage API to generate encryption key
   */
  private getEncryptionKey(): string | undefined {
    try {
      if (safeStorage.isEncryptionAvailable()) {
        const key = 'chat2api-encryption-key'
        const encryptedKey = safeStorage.encryptString(key)
        return encryptedKey.toString('base64')
      }
    } catch (error) {
      console.warn('Encryption unavailable, using unencrypted storage:', error)
    }
    return undefined
  }

  /**
   * Get Default Data Structure
   */
  private getDefaultData(): StoreSchema {
    return {
      providers: [],
      accounts: [],
      config: DEFAULT_CONFIG,
      logs: [],
    }
  }

  /**
   * Initialize Default Providers
   * Clear provider list, users create providers by adding accounts
   */
  private async initializeDefaultProviders(): Promise<void> {
    const providers = this.store?.get('providers') || []
    const builtinIds = BUILTIN_PROVIDERS.map(p => p.id)
    
    // Filter out built-in providers not in current built-in list, keep only custom providers
    const validProviders = providers.filter((p: Provider) => {
      if (p.type === 'builtin') {
        return builtinIds.includes(p.id)
      }
      return true
    })
    
    // Update built-in provider configuration fields (force update to keep synchronized)
    const updatedProviders = validProviders.map((p: Provider) => {
      if (p.type === 'builtin') {
        const builtinConfig = BUILTIN_PROVIDERS.find(bp => bp.id === p.id)
        if (builtinConfig) {
        // Force update built-in provider key configuration
          return { 
            ...p, 
            apiEndpoint: builtinConfig.apiEndpoint,
            chatPath: builtinConfig.chatPath,
            supportedModels: builtinConfig.supportedModels,
            modelMappings: builtinConfig.modelMappings,
            headers: builtinConfig.headers,
            description: builtinConfig.description,
          }
        }
      }
      return p
    })
    
    // Always update storage to ensure built-in provider configuration is up-to-date
    this.store?.set('providers', updatedProviders)
  }

  /**
   * Ensure provider exists, create if not
   */
  ensureProviderExists(providerId: string): void {
    this.ensureInitialized()
    const providers = this.store!.get('providers') || []
    const exists = providers.some((p: Provider) => p.id === providerId)
    
    if (!exists) {
      const builtinConfig = BUILTIN_PROVIDERS.find(bp => bp.id === providerId)
      if (builtinConfig) {
        const now = Date.now()
        const newProvider: Provider = {
          id: builtinConfig.id,
          name: builtinConfig.name,
          type: 'builtin',
          authType: builtinConfig.authType,
          apiEndpoint: builtinConfig.apiEndpoint,
          chatPath: builtinConfig.chatPath,
          headers: builtinConfig.headers,
          enabled: true,
          createdAt: now,
          updatedAt: now,
          description: builtinConfig.description,
          supportedModels: builtinConfig.supportedModels,
          modelMappings: builtinConfig.modelMappings,
        }
        providers.push(newProvider)
        this.store!.set('providers', providers)
        console.log('[Store] Created missing provider:', providerId)
      }
    }
  }

  /**
   * Ensure Storage is Initialized
   */
  private ensureInitialized(): void {
    if (!this.isInitialized || !this.store) {
      throw new Error('Storage not initialized, please call initialize() first')
    }
  }

  /**
   * Encrypt Sensitive Data
   * @param data Data to encrypt
   * @returns Encrypted string
   */
  encryptData(data: string): string {
    try {
      console.log('[Store] encryptData input length:', data.length, 'content:', data.substring(0, 20) + '...')
      if (safeStorage.isEncryptionAvailable()) {
        // Create new Buffer to store encryption result
        const encrypted = Buffer.from(safeStorage.encryptString(data))
        const result = encrypted.toString('base64')
        console.log('[Store] encryptData output length:', result.length, 'content:', result.substring(0, 20) + '...')
        // Verify encryption is correct
        const decrypted = safeStorage.decryptString(encrypted)
        console.log('[Store] encryptData verify decryption:', decrypted.substring(0, 20) + '...', 'match:', decrypted === data)
        return result
      } else {
        console.log('[Store] Encryption unavailable, returning original data')
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
    try {
      if (safeStorage.isEncryptionAvailable()) {
        const buffer = Buffer.from(encryptedData, 'base64')
        return safeStorage.decryptString(buffer)
      }
    } catch (error) {
      console.error('Failed to decrypt data:', error)
    }
    return encryptedData
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

  /**
   * Get All Providers
   */
  getProviders(): Provider[] {
    this.ensureInitialized()
    return this.store!.get('providers') || []
  }

  /**
   * Get Provider By ID
   */
  getProviderById(id: string): Provider | undefined {
    this.ensureInitialized()
    const providers = this.store!.get('providers') || []
    return providers.find((p) => p.id === id)
  }

  /**
   * Add Provider
   */
  addProvider(provider: Provider): void {
    this.ensureInitialized()
    const providers = this.store!.get('providers') || []
    providers.push(provider)
    this.store!.set('providers', providers)
  }

  /**
   * Update Provider
   */
  updateProvider(id: string, updates: Partial<Provider>): Provider | null {
    this.ensureInitialized()
    const providers = this.store!.get('providers') || []
    const index = providers.findIndex((p) => p.id === id)
    
    if (index === -1) {
      return null
    }
    
    providers[index] = {
      ...providers[index],
      ...updates,
      updatedAt: Date.now(),
    }
    
    this.store!.set('providers', providers)
    return providers[index]
  }

  /**
   * Delete Provider
   */
  deleteProvider(id: string): boolean {
    this.ensureInitialized()
    const providers = this.store!.get('providers') || []
    const index = providers.findIndex((p) => p.id === id)
    
    if (index === -1) {
      return false
    }
    
    providers.splice(index, 1)
    this.store!.set('providers', providers)
    
    const accounts = this.store!.get('accounts') || []
    const filteredAccounts = accounts.filter((a) => a.providerId !== id)
    this.store!.set('accounts', filteredAccounts)
    
    return true
  }

  // ==================== Account Operations ====================

  /**
   * Get All Accounts
   * @param includeCredentials Whether to include decrypted credentials
   */
  getAccounts(includeCredentials: boolean = false): Account[] {
    this.ensureInitialized()
    const accounts = this.store!.get('accounts') || []
    
    if (includeCredentials) {
      return accounts.map((account) => ({
        ...account,
        credentials: this.decryptCredentials(account.credentials),
      }))
    }
    
    return accounts
  }

  /**
   * Get Account By ID
   * @param includeCredentials Whether to include decrypted credentials
   */
  getAccountById(id: string, includeCredentials: boolean = false): Account | undefined {
    this.ensureInitialized()
    const accounts = this.store!.get('accounts') || []
    const account = accounts.find((a) => a.id === id)
    
    if (account && includeCredentials) {
      return {
        ...account,
        credentials: this.decryptCredentials(account.credentials),
      }
    }
    
    return account
  }

  /**
   * Get Accounts By Provider ID
   */
  getAccountsByProviderId(providerId: string, includeCredentials: boolean = false): Account[] {
    this.ensureInitialized()
    const accounts = this.store!.get('accounts') || []
    const filtered = accounts.filter((a) => a.providerId === providerId)
    
    if (includeCredentials) {
      return filtered.map((account) => ({
        ...account,
        credentials: this.decryptCredentials(account.credentials),
      }))
    }
    
    return filtered
  }

  /**
   * Add Account
   * Credentials are automatically encrypted before storage
   */
  addAccount(account: Account): void {
    this.ensureInitialized()
    const accounts = this.store!.get('accounts') || []
    
    const encryptedAccount: Account = {
      ...account,
      credentials: this.encryptCredentials(account.credentials),
    }
    
    accounts.push(encryptedAccount)
    this.store!.set('accounts', accounts)
  }

  /**
   * Update Account
   */
  updateAccount(id: string, updates: Partial<Account>): Account | null {
    this.ensureInitialized()
    const accounts = this.store!.get('accounts') || []
    const index = accounts.findIndex((a) => a.id === id)
    
    if (index === -1) {
      return null
    }
    
    console.log('[Store] Update account:', {
      id,
      updatesCredentials: updates.credentials,
      oldCredentials: accounts[index].credentials,
      oldCredentialsDecrypted: this.decryptCredentials(accounts[index].credentials),
    })
    
    const updatedAccount: Account = {
      ...accounts[index],
      ...updates,
      updatedAt: Date.now(),
    }
    
    if (updates.credentials) {
      updatedAccount.credentials = this.encryptCredentials(updates.credentials)
      console.log('[Store] Encrypted credentials:', updatedAccount.credentials)
      console.log('[Store] Old credentials:', accounts[index].credentials)
      console.log('[Store] Credentials match:', JSON.stringify(updatedAccount.credentials) === JSON.stringify(accounts[index].credentials))
    }
    
    accounts[index] = updatedAccount
    this.store!.set('accounts', accounts)
    
    // Verify save was successful
    const savedAccounts = this.store!.get('accounts') as Account[]
    const savedAccount = savedAccounts.find(a => a.id === id)
    console.log('[Store] Verify after save:', {
      id,
      savedCredentials: savedAccount?.credentials,
    })
    
    return {
      ...updatedAccount,
      credentials: updates.credentials || this.decryptCredentials(accounts[index].credentials),
    }
  }

  /**
   * Delete Account
   */
  deleteAccount(id: string): boolean {
    this.ensureInitialized()
    const accounts = this.store!.get('accounts') || []
    const index = accounts.findIndex((a) => a.id === id)
    
    if (index === -1) {
      return false
    }
    
    accounts.splice(index, 1)
    this.store!.set('accounts', accounts)
    return true
  }

  /**
   * Get Active Accounts
   */
  getActiveAccounts(includeCredentials: boolean = false): Account[] {
    this.ensureInitialized()
    const accounts = this.store!.get('accounts') || []
    const active = accounts.filter((a) => a.status === 'active')
    
    if (includeCredentials) {
      return active.map((account) => ({
        ...account,
        credentials: this.decryptCredentials(account.credentials),
      }))
    }
    
    return active
  }

  // ==================== Configuration Operations ====================

  /**
   * Get Application Configuration
   */
  getConfig(): AppConfig {
    this.ensureInitialized()
    return this.store!.get('config') || DEFAULT_CONFIG
  }

  /**
   * Set Application Configuration
   */
  setConfig(config: AppConfig): void {
    this.ensureInitialized()
    this.store!.set('config', config)
  }

  /**
   * Update Application Configuration
   */
  updateConfig(updates: Partial<AppConfig>): AppConfig {
    this.ensureInitialized()
    const currentConfig = this.store!.get('config') || DEFAULT_CONFIG
    const newConfig = {
      ...currentConfig,
      ...updates,
    }
    this.store!.set('config', newConfig)
    return newConfig
  }

  /**
   * Reset Configuration to Default Values
   */
  resetConfig(): AppConfig {
    this.ensureInitialized()
    this.store!.set('config', DEFAULT_CONFIG)
    return DEFAULT_CONFIG
  }

  // ==================== Log Operations ====================

  /**
   * Add Log Entry
   */
  addLog(
    level: LogLevel,
    message: string,
    data?: {
      accountId?: string
      providerId?: string
      requestId?: string
      data?: Record<string, unknown>
    }
  ): LogEntry {
    this.ensureInitialized()
    const logs = this.store!.get('logs') || []
    
    const entry: LogEntry = {
      id: this.generateId(),
      timestamp: Date.now(),
      level,
      message,
      ...data,
    }
    
    logs.push(entry)
    
    const config = this.getConfig()
    const maxLogs = config.logRetentionDays * 1000
    if (logs.length > maxLogs) {
      logs.splice(0, logs.length - maxLogs)
    }
    
    this.store!.set('logs', logs)

    this.mainWindow?.webContents.send(IpcChannels.LOGS_NEW_LOG, entry)

    return entry
  }

  /**
   * Get Logs
   * @param limit Limit count
   * @param level Log level filter
   */
  getLogs(limit?: number, level?: LogLevel): LogEntry[] {
    this.ensureInitialized()
    let logs = this.store!.get('logs') || []
    
    if (level) {
      logs = logs.filter((l) => l.level === level)
    }
    
    if (limit && logs.length > limit) {
      logs = logs.slice(-limit)
    }
    
    return logs
  }

  /**
   * Clear Logs
   */
  clearLogs(): void {
    this.ensureInitialized()
    this.store!.set('logs', [])
  }

  /**
   * Get Log Statistics
   */
  getLogStats(): { total: number; info: number; warn: number; error: number; debug: number } {
    this.ensureInitialized()
    const logs = this.store!.get('logs') || []
    
    return {
      total: logs.length,
      info: logs.filter((l: LogEntry) => l.level === 'info').length,
      warn: logs.filter((l: LogEntry) => l.level === 'warn').length,
      error: logs.filter((l: LogEntry) => l.level === 'error').length,
      debug: logs.filter((l: LogEntry) => l.level === 'debug').length,
    }
  }

  /**
   * Get Log Trend
   */
  getLogTrend(days: number = 7): { date: string; total: number; info: number; warn: number; error: number }[] {
    this.ensureInitialized()
    const logs = this.store!.get('logs') || []
    const now = Date.now()
    const dayMs = 24 * 60 * 60 * 1000
    const trends: { date: string; total: number; info: number; warn: number; error: number }[] = []

    for (let i = days - 1; i >= 0; i--) {
      const dayStart = now - (i + 1) * dayMs
      const dayEnd = now - i * dayMs
      const date = new Date(dayStart).toISOString().split('T')[0]

      const dayLogs = logs.filter(
        (l: LogEntry) => l.timestamp >= dayStart && l.timestamp < dayEnd
      )

      trends.push({
        date,
        total: dayLogs.length,
        info: dayLogs.filter((l: LogEntry) => l.level === 'info').length,
        warn: dayLogs.filter((l: LogEntry) => l.level === 'warn').length,
        error: dayLogs.filter((l: LogEntry) => l.level === 'error').length,
      })
    }

    return trends
  }

  /**
   * Get Log Trend for specific account
   * Only counts successful API requests (logs with requestId) to match requestCount
   */
  getAccountLogTrend(accountId: string, days: number = 7): { date: string; total: number; info: number; warn: number; error: number }[] {
    this.ensureInitialized()
    const logs = this.store!.get('logs') || []
    const accountLogs = logs.filter((l: LogEntry) => l.accountId === accountId && l.requestId)
    const now = Date.now()
    const dayMs = 24 * 60 * 60 * 1000
    const trends: { date: string; total: number; info: number; warn: number; error: number }[] = []

    for (let i = days - 1; i >= 0; i--) {
      const dayStart = now - (i + 1) * dayMs
      const dayEnd = now - i * dayMs
      const date = new Date(dayStart).toISOString().split('T')[0]

      const dayLogs = accountLogs.filter(
        (l: LogEntry) => l.timestamp >= dayStart && l.timestamp < dayEnd
      )

      const infoCount = dayLogs.filter((l: LogEntry) => l.level === 'info').length
      const warnCount = dayLogs.filter((l: LogEntry) => l.level === 'warn').length
      const errorCount = dayLogs.filter((l: LogEntry) => l.level === 'error').length

      trends.push({
        date,
        total: infoCount,
        info: infoCount,
        warn: warnCount,
        error: errorCount,
      })
    }

    return trends
  }

  /**
   * Export Logs
   */
  exportLogs(format: 'json' | 'txt' = 'json'): string {
    this.ensureInitialized()
    const logs = this.store!.get('logs') || []

    if (format === 'json') {
      return JSON.stringify(logs, null, 2)
    }

    return logs
      .map((log: LogEntry) => {
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

  /**
   * Get Log By ID
   */
  getLogById(id: string): LogEntry | undefined {
    this.ensureInitialized()
    const logs = this.store!.get('logs') || []
    return logs.find((l: LogEntry) => l.id === id)
  }

  /**
   * Clear Expired Logs
   */
  cleanExpiredLogs(): void {
    this.ensureInitialized()
    const config = this.getConfig()
    const logs = this.store!.get('logs') || []
    const cutoff = Date.now() - config.logRetentionDays * 24 * 60 * 60 * 1000
    
    const filtered = logs.filter((l) => l.timestamp >= cutoff)
    this.store!.set('logs', filtered)
  }

  // ==================== Utility Methods ====================

  /**
   * Generate Unique ID
   */
  generateId(): string {
    return `${Date.now()}-${Math.random().toString(36).substring(2, 11)}`
  }

  /**
   * Get Storage Instance (for internal use only)
   */
  getStore(): StoreType | null {
    return this.store
  }

  /**
   * Clear All Data
   */
  clearAll(): void {
    this.ensureInitialized()
    this.store!.clear()
  }

  /**
   * Export Data (for backup)
   * Does not include encrypted credential data
   */
  exportData(): Omit<StoreSchema, 'accounts'> & { accounts: Omit<Account, 'credentials'>[] } {
    this.ensureInitialized()
    const providers = this.store!.get('providers') || []
    const accounts = (this.store!.get('accounts') || []).map((a) => {
      const { credentials, ...rest } = a
      return rest
    })
    const config = this.store!.get('config') || DEFAULT_CONFIG
    const logs = this.store!.get('logs') || []
    
    return {
      providers,
      accounts,
      config,
      logs,
    }
  }

  /**
   * Get Storage Path
   */
  getStorePath(): string {
    return this.getStoragePath()
  }
}

// Export singleton instance
export const storeManager = new StoreManager()

// Export types
export type { StoreType }
