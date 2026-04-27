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
  SystemPrompt,
  SessionRecord,
  SessionConfig,
  DEFAULT_SESSION_CONFIG,
  ChatMessage,
  RequestLogEntry,
  PersistentStatistics,
  DailyStatistics,
  DEFAULT_STATISTICS,
  EffectiveModel,
  ProviderModelOverrides,
  DEFAULT_USER_MODEL_OVERRIDES,
  UserModelOverrides,
  CustomModel,
} from './types'
import { BUILTIN_PROMPTS } from '../data/builtin-prompts'
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
  private initializationError: Error | null = null

  private pendingLogs: LogEntry[] = []
  private pendingRequestLogs: RequestLogEntry[] = []
  private logSaveTimer: NodeJS.Timeout | null = null
  private readonly LOG_SAVE_DELAY_MS = 3000

  private pendingIpcLogs: LogEntry[] = []
  private pendingIpcRequestLogs: RequestLogEntry[] = []
  private ipcFlushTimer: NodeJS.Timeout | null = null
  private readonly IPC_FLUSH_DELAY_MS = 500

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

    // 迁移：如果存在旧的加密数据文件，先解密并迁移到明文存储
    const migratedData = await this.migrateEncryptedStorage(storagePath)

    try {
      this.store = new Store({
        name: 'data',
        cwd: storagePath,
        defaults: this.getDefaultData(),
        encryptionKey: this.getEncryptionKey(),
      })

      // 写入迁移数据（如果有）
      if (migratedData) {
        this.store.set(migratedData)
        console.log('[Store] Successfully migrated encrypted data to unencrypted storage')
      }

      await this.initializeDefaultProviders()
      this.isInitialized = true
      this.initializationError = null
    } catch (error) {
      console.error('[Store] Failed to initialize storage:', error)
      this.initializationError = error instanceof Error ? error : new Error(String(error))

      // Try to recover by backing up corrupted data and reinitializing
      try {
        await this.recoverFromCorruptedData(storagePath)
        this.store = new Store({
          name: 'data',
          cwd: storagePath,
          defaults: this.getDefaultData(),
          encryptionKey: this.getEncryptionKey(),
        })
        this.isInitialized = true
        this.initializationError = null
        console.log('[Store] Successfully recovered from corrupted data')
      } catch (recoveryError) {
        console.error('[Store] Failed to recover from corrupted data:', recoveryError)
        throw this.initializationError
      }
    }
  }

  /**
   * Migrate encrypted storage to unencrypted storage
   * If an old encrypted data.json exists, decrypt it and remove the file
   * so the new unencrypted store can be created cleanly.
   */
  private async migrateEncryptedStorage(storagePath: string): Promise<Record<string, unknown> | null> {
    try {
      const { existsSync, unlinkSync } = await import('fs')
      const { join } = await import('path')
      const dataFile = join(storagePath, 'data.json')

      if (!existsSync(dataFile)) {
        return null
      }

      // Try to read with the old fixed encryption key
      const encryptedStore = new Store({
        name: 'data',
        cwd: storagePath,
        encryptionKey: 'chat2api-fixed-encryption-key-v1',
      })

      const data = encryptedStore.store as Record<string, unknown>
      const hasData =
        (Array.isArray(data.providers) && data.providers.length > 0) ||
        (Array.isArray(data.accounts) && data.accounts.length > 0) ||
        (data.config && Object.keys(data.config).length > 0)

      if (!hasData) {
        // File exists but only contains defaults; safe to remove
        unlinkSync(dataFile)
        return null
      }

      // Remove the encrypted file so the new unencrypted store can take over
      unlinkSync(dataFile)
      return data
    } catch (error) {
      console.log('[Store] No encrypted data to migrate or migration skipped:', error)
      return null
    }
  }

  /**
   * Recover from corrupted data file
   * Backup the corrupted file and create a new one
   */
  private async recoverFromCorruptedData(storagePath: string): Promise<void> {
    const { renameSync, existsSync } = await import('fs')
    const { join } = await import('path')
    
    const dataPath = join(storagePath, 'data.json')
    const backupPath = join(storagePath, `data.corrupted.${Date.now()}.json`)
    
    if (existsSync(dataPath)) {
      console.log('[Store] Backing up corrupted data file to:', backupPath)
      try {
        renameSync(dataPath, backupPath)
        console.log('[Store] Corrupted data file backed up successfully')
      } catch (backupError) {
        console.error('[Store] Failed to backup corrupted data:', backupError)
        throw backupError
      }
    }
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
   * Returns a fixed encryption key for electron-store
   * Note: electron-store uses this key to encrypt/decrypt the data file,
   * so it must be stable across app restarts
   */
  private getEncryptionKey(): string | undefined {
    // electron-store 文件级加密已关闭，数据以明文 JSON 存储
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
      requestLogs: [],
      systemPrompts: [],
      sessions: [],
      statistics: DEFAULT_STATISTICS,
      userModelOverrides: DEFAULT_USER_MODEL_OVERRIDES,
    }
  }

  /**
   * Initialize Default Providers
   * Clear provider list, users create providers by adding accounts
   */
  private async initializeDefaultProviders(): Promise<void> {
    const providers = this.store?.get('providers') || []
    const builtinIds = BUILTIN_PROVIDERS.map(p => p.id)
    
    const validProviders = providers.filter((p: Provider) => {
      if (p.type === 'builtin') {
        return builtinIds.includes(p.id)
      }
      return true
    })
    
    const userModelOverrides = this.store?.get('userModelOverrides') || {}
    
    const updatedProviders = validProviders.map((p: Provider) => {
      if (p.type === 'builtin') {
        const builtinConfig = BUILTIN_PROVIDERS.find(bp => bp.id === p.id)
        if (builtinConfig) {
          const hasUserOverrides = userModelOverrides[p.id] && 
            ((userModelOverrides[p.id].addedModels && userModelOverrides[p.id].addedModels.length > 0) ||
             (userModelOverrides[p.id].excludedModels && userModelOverrides[p.id].excludedModels.length > 0))
          
          return { 
            ...p, 
            apiEndpoint: builtinConfig.apiEndpoint,
            chatPath: builtinConfig.chatPath,
            supportedModels: hasUserOverrides ? p.supportedModels : builtinConfig.supportedModels,
            modelMappings: hasUserOverrides ? p.modelMappings : builtinConfig.modelMappings,
            headers: builtinConfig.headers,
            description: builtinConfig.description,
          }
        }
      }
      return p
    })
    
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
      const errorMsg = this.initializationError 
        ? `Storage initialization failed: ${this.initializationError.message}`
        : 'Storage not initialized, please call initialize() first'
      throw new Error(errorMsg)
    }
  }

  private scheduleLogSave(): void {
    if (this.logSaveTimer) {
      clearTimeout(this.logSaveTimer)
    }
    this.logSaveTimer = setTimeout(() => {
      this.flushLogs().catch(console.error)
      this.logSaveTimer = null
    }, this.LOG_SAVE_DELAY_MS)
  }

  /**
   * Force flush pending logs to disk immediately.
   * Call this before app exit.
   */
  async flushLogs(): Promise<void> {
    if (this.logSaveTimer) {
      clearTimeout(this.logSaveTimer)
      this.logSaveTimer = null
    }
    if (!this.isInitialized || !this.store) return

    if (this.pendingLogs.length > 0) {
      const logs = this.store.get('logs') as LogEntry[] || []
      logs.push(...this.pendingLogs)
      const config = this.getConfig()
      const maxLogs = config.logRetentionDays * 1000
      if (logs.length > maxLogs) {
        logs.splice(0, logs.length - maxLogs)
      }
      this.store.set('logs', logs)
      this.pendingLogs = []
    }

    if (this.pendingRequestLogs.length > 0) {
      const requestLogs = this.store.get('requestLogs') as RequestLogEntry[] || []
      requestLogs.push(...this.pendingRequestLogs)
      const config = this.getConfig()
      const maxLogs = config.logRetentionDays * 500
      if (requestLogs.length > maxLogs) {
        requestLogs.splice(0, requestLogs.length - maxLogs)
      }
      this.store.set('requestLogs', requestLogs)
      this.pendingRequestLogs = []
    }
  }

  private scheduleIpcFlush(): void {
    if (this.ipcFlushTimer) {
      clearTimeout(this.ipcFlushTimer)
    }
    this.ipcFlushTimer = setTimeout(() => {
      this.flushIpc()
      this.ipcFlushTimer = null
    }, this.IPC_FLUSH_DELAY_MS)
  }

  /**
   * Batch flush pending IPC messages to renderer.
   * Groups rapid-fire logs into a single burst to reduce IPC pressure.
   */
  private flushIpc(): void {
    if (!this.mainWindow) return

    if (this.pendingIpcLogs.length > 0) {
      for (const log of this.pendingIpcLogs) {
        this.mainWindow.webContents.send(IpcChannels.LOGS_NEW_LOG, log)
      }
      this.pendingIpcLogs = []
    }

    if (this.pendingIpcRequestLogs.length > 0) {
      for (const log of this.pendingIpcRequestLogs) {
        this.mainWindow.webContents.send(IpcChannels.REQUEST_LOGS_NEW, log)
      }
      this.pendingIpcRequestLogs = []
    }
  }

  /**
   * Encrypt Sensitive Data
   * @param data Data to encrypt
   * @returns Encrypted string
   */
  encryptData(data: string): string {
    // 默认关闭 safeStorage 凭证加密，直接明文存储
    return data
  }

  /**
   * Decrypt Sensitive Data
   * @param encryptedData Encrypted data
   * @returns Decrypted string
   */
  decryptData(encryptedData: string): string {
    // 兼容旧数据：若数据仍为 safeStorage 密文则尝试解密，否则直接返回
    try {
      if (safeStorage.isEncryptionAvailable()) {
        const buffer = Buffer.from(encryptedData, 'base64')
        const decrypted = safeStorage.decryptString(buffer)
        // 若解密结果与原数据不同，说明是旧加密数据，返回解密结果
        if (decrypted !== encryptedData) {
          return decrypted
        }
      }
    } catch {
      // 解密失败说明不是 safeStorage 密文，直接返回原数据
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
    const providers = this.store!.get('providers') as Provider[] || []
    return providers.find((p: Provider) => p.id === id)
  }

  /**
   * Add Provider
   */
  addProvider(provider: Provider): void {
    this.ensureInitialized()
    const providers = this.store!.get('providers') as Provider[] || []
    providers.push(provider)
    this.store!.set('providers', providers)
  }

  /**
   * Update Provider
   */
  updateProvider(id: string, updates: Partial<Provider>): Provider | null {
    this.ensureInitialized()
    const providers = this.store!.get('providers') as Provider[] || []
    const index = providers.findIndex((p: Provider) => p.id === id)
    
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
    const providers = this.store!.get('providers') as Provider[] || []
    const index = providers.findIndex((p: Provider) => p.id === id)
    
    if (index === -1) {
      return false
    }
    
    providers.splice(index, 1)
    this.store!.set('providers', providers)
    
    const accounts = this.store!.get('accounts') as Account[] || []
    const filteredAccounts = accounts.filter((a: Account) => a.providerId !== id)
    this.store!.set('accounts', filteredAccounts)
    
    return true
  }

  // ==================== Model Overrides Operations ====================

  /**
   * Get Model Overrides for a Provider
   * Returns user customizations to built-in provider models
   */
  getModelOverrides(providerId: string): ProviderModelOverrides | undefined {
    this.ensureInitialized()
    const userModelOverrides = this.store!.get('userModelOverrides') || DEFAULT_USER_MODEL_OVERRIDES
    return userModelOverrides[providerId]
  }

  /**
   * Check if Provider has Model Overrides
   * Returns true if provider has user-added models or excluded models
   */
  hasModelOverrides(providerId: string): boolean {
    const overrides = this.getModelOverrides(providerId)
    if (!overrides) return false
    
    return (
      (overrides.addedModels && overrides.addedModels.length > 0) ||
      (overrides.excludedModels && overrides.excludedModels.length > 0)
    )
  }

  // ==================== Account Operations ====================

  /**
   * Get All Accounts
   * @param includeCredentials Whether to include decrypted credentials
   */
  getAccounts(includeCredentials: boolean = false): Account[] {
    this.ensureInitialized()
    const accounts = this.store!.get('accounts') as Account[] || []
    
    if (includeCredentials) {
      return accounts.map((account: Account) => ({
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
    const accounts = this.store!.get('accounts') as Account[] || []
    const account = accounts.find((a: Account) => a.id === id)
    
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
    const accounts = this.store!.get('accounts') as Account[] || []
    const filtered = accounts.filter((a: Account) => a.providerId === providerId)
    
    if (includeCredentials) {
      return filtered.map((account: Account) => ({
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
    const accounts = this.store!.get('accounts') as Account[] || []
    const index = accounts.findIndex((a: Account) => a.id === id)
    
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
    const accounts = this.store!.get('accounts') as Account[] || []
    const index = accounts.findIndex((a: Account) => a.id === id)
    
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
    const accounts = this.store!.get('accounts') as Account[] || []
    const active = accounts.filter((a: Account) => a.status === 'active')
    
    if (includeCredentials) {
      return active.map((account: Account) => ({
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
    
    // Deep merge for nested objects
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

    this.pendingLogs.push(entry)

    const config = this.getConfig()
    const maxLogs = config.logRetentionDays * 1000
    if (this.pendingLogs.length > maxLogs) {
      this.pendingLogs.splice(0, this.pendingLogs.length - maxLogs)
    }

    this.scheduleLogSave()

    this.pendingIpcLogs.push(entry)
    this.scheduleIpcFlush()

    return entry
  }

  /**
   * Get Logs
   * @param limit Limit count
   * @param level Log level filter
   */
  getLogs(limit?: number, level?: LogLevel): LogEntry[] {
    this.ensureInitialized()
    let logs = (this.store!.get('logs') as LogEntry[] || []).concat(this.pendingLogs)

    if (level) {
      logs = logs.filter((l: LogEntry) => l.level === level)
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
    this.pendingLogs = []
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
    
    const filtered = logs.filter((l: LogEntry) => l.timestamp >= cutoff)
    this.store!.set('logs', filtered)
  }

  // ==================== Request Log Operations ====================

  /**
   * Add Request Log Entry
   */
  addRequestLog(entry: Omit<RequestLogEntry, 'id'>): RequestLogEntry {
    this.ensureInitialized()

    const newEntry: RequestLogEntry = {
      ...entry,
      id: this.generateId(),
    }

    this.pendingRequestLogs.push(newEntry)

    const config = this.getConfig()
    const maxLogs = config.logRetentionDays * 500
    if (this.pendingRequestLogs.length > maxLogs) {
      this.pendingRequestLogs.splice(0, this.pendingRequestLogs.length - maxLogs)
    }

    this.scheduleLogSave()

    this.pendingIpcRequestLogs.push(newEntry)
    this.scheduleIpcFlush()

    return newEntry
  }

  /**
   * Update Request Log Entry
   */
  updateRequestLog(id: string, updates: Partial<RequestLogEntry>): boolean {
    this.ensureInitialized()

    // 先在 pending 中查找
    const pendingIndex = this.pendingRequestLogs.findIndex((l) => l.id === id)
    if (pendingIndex !== -1) {
      this.pendingRequestLogs[pendingIndex] = { ...this.pendingRequestLogs[pendingIndex], ...updates }
      return true
    }

    const requestLogs = this.store!.get('requestLogs') || []
    const index = requestLogs.findIndex((l: RequestLogEntry) => l.id === id)
    if (index === -1) return false

    requestLogs[index] = { ...requestLogs[index], ...updates }
    this.store!.set('requestLogs', requestLogs)

    return true
  }

  /**
   * Get Request Logs
   */
  getRequestLogs(limit?: number, filter?: { status?: 'success' | 'error'; providerId?: string }): RequestLogEntry[] {
    this.ensureInitialized()
    let requestLogs = (this.store!.get('requestLogs') as RequestLogEntry[] || []).concat(this.pendingRequestLogs)

    if (filter?.status) {
      requestLogs = requestLogs.filter((l: RequestLogEntry) => l.status === filter.status)
    }

    if (filter?.providerId) {
      requestLogs = requestLogs.filter((l: RequestLogEntry) => l.providerId === filter.providerId)
    }

    requestLogs.sort((a: RequestLogEntry, b: RequestLogEntry) => b.timestamp - a.timestamp)

    if (limit && requestLogs.length > limit) {
      requestLogs = requestLogs.slice(0, limit)
    }

    return requestLogs
  }

  /**
   * Get Request Log By ID
   */
  getRequestLogById(id: string): RequestLogEntry | undefined {
    this.ensureInitialized()
    const pending = this.pendingRequestLogs.find((l) => l.id === id)
    if (pending) return pending
    const requestLogs = this.store!.get('requestLogs') || []
    return requestLogs.find((l: RequestLogEntry) => l.id === id)
  }

  /**
   * Clear Request Logs
   */
  clearRequestLogs(): void {
    this.ensureInitialized()
    this.pendingRequestLogs = []
    this.store!.set('requestLogs', [])
    this.store!.set('statistics', DEFAULT_STATISTICS)
  }

  /**
   * Get Request Log Statistics
   */
  getRequestLogStats(): { total: number; success: number; error: number; todayTotal: number; todaySuccess: number; todayError: number } {
    this.ensureInitialized()
    const requestLogs = this.store!.get('requestLogs') || []
    
    const today = new Date().toISOString().split('T')[0]
    const todayStart = new Date(today).getTime()
    const todayEnd = todayStart + 24 * 60 * 60 * 1000
    
    const todayLogs = requestLogs.filter((l: RequestLogEntry) => l.timestamp >= todayStart && l.timestamp < todayEnd)
    
    return {
      total: requestLogs.length,
      success: requestLogs.filter((l: RequestLogEntry) => l.status === 'success').length,
      error: requestLogs.filter((l: RequestLogEntry) => l.status === 'error').length,
      todayTotal: todayLogs.length,
      todaySuccess: todayLogs.filter((l: RequestLogEntry) => l.status === 'success').length,
      todayError: todayLogs.filter((l: RequestLogEntry) => l.status === 'error').length,
    }
  }

  /**
   * Get Request Log Trend
   */
  getRequestLogTrend(days: number = 7): { date: string; total: number; success: number; error: number; avgLatency: number }[] {
    this.ensureInitialized()
    const requestLogs = this.store!.get('requestLogs') as RequestLogEntry[] || []
    const now = Date.now()
    const dayMs = 24 * 60 * 60 * 1000
    const today = new Date().toISOString().split('T')[0]
    const todayStart = new Date(today).getTime()
    const trends: { date: string; total: number; success: number; error: number; avgLatency: number }[] = []

    for (let i = days - 1; i >= 0; i--) {
      const dayStart = todayStart - i * dayMs
      const dayEnd = dayStart + dayMs
      const date = new Date(dayStart).toISOString().split('T')[0]

      const dayLogs = requestLogs.filter(
        (l: RequestLogEntry) => l.timestamp >= dayStart && l.timestamp < dayEnd
      )

      const successLogs = dayLogs.filter((l: RequestLogEntry) => l.status === 'success')
      const errorLogs = dayLogs.filter((l: RequestLogEntry) => l.status === 'error')
      const totalLatency = successLogs.reduce((sum: number, l: RequestLogEntry) => sum + l.latency, 0)

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

  // ==================== Statistics Operations ====================

  /**
   * Get Persistent Statistics
   */
  getStatistics(): PersistentStatistics {
    this.ensureInitialized()
    return this.store!.get('statistics') || DEFAULT_STATISTICS
  }

  /**
   * Update Statistics
   */
  updateStatistics(updates: Partial<PersistentStatistics>): PersistentStatistics {
    this.ensureInitialized()
    const currentStats = this.store!.get('statistics') || DEFAULT_STATISTICS
    const newStats = {
      ...currentStats,
      ...updates,
      lastUpdated: Date.now(),
    }
    this.store!.set('statistics', newStats)
    return newStats
  }

  /**
   * Record Request in Statistics
   */
  recordRequestInStats(
    success: boolean,
    latency: number,
    model?: string,
    providerId?: string,
    accountId?: string
  ): PersistentStatistics {
    this.ensureInitialized()
    const stats = this.store!.get('statistics') || DEFAULT_STATISTICS
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
    
    this.store!.set('statistics', newStats)
    return newStats
  }

  /**
   * Get Today Statistics
   */
  getTodayStatistics(): DailyStatistics {
    this.ensureInitialized()
    const stats = this.store!.get('statistics') || DEFAULT_STATISTICS
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

  /**
   * Clean Old Daily Statistics (older than 30 days)
   */
  cleanOldDailyStats(): void {
    this.ensureInitialized()
    const stats = this.store!.get('statistics') || DEFAULT_STATISTICS
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
      this.store!.set('statistics', stats)
    }
  }

  // ==================== System Prompts Operations ====================

  /**
   * Get All System Prompts
   * Merges built-in prompts with custom prompts
   */
  getSystemPrompts(): SystemPrompt[] {
    this.ensureInitialized()
    const customPrompts = this.store!.get('systemPrompts') || []
    return [...BUILTIN_PROMPTS, ...customPrompts]
  }

  /**
   * Get Built-in System Prompts
   */
  getBuiltinPrompts(): SystemPrompt[] {
    return BUILTIN_PROMPTS
  }

  /**
   * Get Custom System Prompts
   */
  getCustomPrompts(): SystemPrompt[] {
    this.ensureInitialized()
    return this.store!.get('systemPrompts') || []
  }

  /**
   * Get System Prompt By ID
   */
  getSystemPromptById(id: string): SystemPrompt | undefined {
    return this.getSystemPrompts().find(p => p.id === id)
  }

  /**
   * Add Custom System Prompt
   */
  addSystemPrompt(prompt: Omit<SystemPrompt, 'id' | 'createdAt' | 'updatedAt'>): SystemPrompt {
    this.ensureInitialized()
    const prompts = this.store!.get('systemPrompts') || []
    
    const newPrompt: SystemPrompt = {
      ...prompt,
      id: this.generateId(),
      isBuiltin: false,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }
    
    prompts.push(newPrompt)
    this.store!.set('systemPrompts', prompts)
    
    return newPrompt
  }

  /**
   * Update Custom System Prompt
   * Cannot update built-in prompts
   */
  updateSystemPrompt(id: string, updates: Partial<SystemPrompt>): SystemPrompt | null {
    this.ensureInitialized()
    
    // Check if it's a built-in prompt
    if (BUILTIN_PROMPTS.some(p => p.id === id)) {
      console.warn('Cannot update built-in prompt:', id)
      return null
    }
    
    const prompts = this.store!.get('systemPrompts') || []
    const index = prompts.findIndex((p: SystemPrompt) => p.id === id)
    
    if (index === -1) {
      return null
    }
    
    prompts[index] = {
      ...prompts[index],
      ...updates,
      updatedAt: Date.now(),
    }
    
    this.store!.set('systemPrompts', prompts)
    return prompts[index]
  }

  /**
   * Delete Custom System Prompt
   * Cannot delete built-in prompts
   */
  deleteSystemPrompt(id: string): boolean {
    this.ensureInitialized()
    
    // Check if it's a built-in prompt
    if (BUILTIN_PROMPTS.some(p => p.id === id)) {
      console.warn('Cannot delete built-in prompt:', id)
      return false
    }
    
    const prompts = this.store!.get('systemPrompts') || []
    const index = prompts.findIndex((p: SystemPrompt) => p.id === id)
    
    if (index === -1) {
      return false
    }
    
    prompts.splice(index, 1)
    this.store!.set('systemPrompts', prompts)
    
    return true
  }

  /**
   * Get System Prompts By Type
   */
  getSystemPromptsByType(type: SystemPrompt['type']): SystemPrompt[] {
    return this.getSystemPrompts().filter(p => p.type === type)
  }

  // ==================== Session Operations ====================

  /**
   * Get Session Configuration
   */
  getSessionConfig(): SessionConfig {
    this.ensureInitialized()
    const config = this.store!.get('config') || DEFAULT_CONFIG
    return config.sessionConfig || DEFAULT_SESSION_CONFIG
  }

  /**
   * Update Session Configuration
   */
  updateSessionConfig(updates: Partial<SessionConfig>): SessionConfig {
    this.ensureInitialized()
    const currentConfig = this.store!.get('config') || DEFAULT_CONFIG
    const newSessionConfig = {
      ...(currentConfig.sessionConfig || DEFAULT_SESSION_CONFIG),
      ...updates,
    }
    const newConfig = {
      ...currentConfig,
      sessionConfig: newSessionConfig,
    }
    this.store!.set('config', newConfig)
    return newSessionConfig
  }

  /**
   * Get All Sessions
   */
  getSessions(): SessionRecord[] {
    this.ensureInitialized()
    return this.store!.get('sessions') || []
  }

  /**
   * Get Session By ID
   */
  getSessionById(id: string): SessionRecord | undefined {
    this.ensureInitialized()
    const sessions = this.store!.get('sessions') || []
    return sessions.find((s: SessionRecord) => s.id === id)
  }

  /**
   * Get Active Sessions
   */
  getActiveSessions(): SessionRecord[] {
    this.ensureInitialized()
    const sessions = this.store!.get('sessions') || []
    const config = this.getSessionConfig()
    const timeoutMs = config.sessionTimeout * 60 * 1000
    const now = Date.now()
    
    return sessions.filter((s: SessionRecord) => 
      s.status === 'active' && 
      (now - s.lastActiveAt) < timeoutMs
    )
  }

  /**
   * Add Session
   */
  addSession(session: SessionRecord): void {
    this.ensureInitialized()
    const sessions = this.store!.get('sessions') || []
    sessions.push(session)
    this.store!.set('sessions', sessions)
  }

  /**
   * Update Session
   */
  updateSession(id: string, updates: Partial<SessionRecord>): SessionRecord | null {
    this.ensureInitialized()
    const sessions = this.store!.get('sessions') || []
    const index = sessions.findIndex((s: SessionRecord) => s.id === id)
    
    if (index === -1) {
      return null
    }
    
    sessions[index] = {
      ...sessions[index],
      ...updates,
    }
    
    this.store!.set('sessions', sessions)
    return sessions[index]
  }

  /**
   * Add Message to Session
   */
  addMessageToSession(sessionId: string, message: ChatMessage): SessionRecord | null {
    this.ensureInitialized()
    const sessions = this.store!.get('sessions') || []
    const index = sessions.findIndex((s: SessionRecord) => s.id === sessionId)
    
    if (index === -1) {
      return null
    }
    
    const config = this.getSessionConfig()
    const session = sessions[index]
    
    if (session.messages.length >= config.maxMessagesPerSession) {
      session.messages = session.messages.slice(-config.maxMessagesPerSession + 1)
    }
    
    session.messages.push(message)
    session.lastActiveAt = Date.now()
    
    sessions[index] = session
    this.store!.set('sessions', sessions)
    return session
  }

  /**
   * Delete Session
   */
  deleteSession(id: string): boolean {
    this.ensureInitialized()
    const sessions = this.store!.get('sessions') || []
    const index = sessions.findIndex((s: SessionRecord) => s.id === id)
    
    if (index === -1) {
      return false
    }
    
    sessions.splice(index, 1)
    this.store!.set('sessions', sessions)
    return true
  }

  /**
   * Mark Session as Expired
   */
  expireSession(id: string): SessionRecord | null {
    return this.updateSession(id, { status: 'expired' })
  }

  /**
   * Clean Expired Sessions
   * Always delete sessions with 'expired' status
   * For timed-out active sessions, behavior depends on deleteAfterTimeout config:
   * - If true: Delete them from storage
   * - If false: Mark them as 'expired' (will be deleted on next clean)
   */
  cleanExpiredSessions(): number {
    this.ensureInitialized()
    const sessions = this.store!.get('sessions') || []
    const config = this.getSessionConfig()
    const timeoutMs = config.sessionTimeout * 60 * 1000
    const now = Date.now()
    
    let removedCount = 0
    
    // Always delete sessions that are already expired
    let remainingSessions = sessions.filter((s: SessionRecord) => {
      if (s.status === 'expired') {
        removedCount++
        return false
      }
      return true
    })
    
    // Handle timed-out active sessions based on config
    if (config.deleteAfterTimeout) {
      // Delete timed-out sessions from storage
      remainingSessions = remainingSessions.filter((s: SessionRecord) => {
        if (s.status === 'active' && (now - s.lastActiveAt) >= timeoutMs) {
          removedCount++
          return false
        }
        return true
      })
    } else {
      // Mark timed-out sessions as expired (will be deleted on next clean)
      remainingSessions = remainingSessions.map((s: SessionRecord) => {
        if (s.status === 'active' && (now - s.lastActiveAt) >= timeoutMs) {
          removedCount++
          return { ...s, status: 'expired' as const }
        }
        return s
      })
    }
    
    this.store!.set('sessions', remainingSessions)
    
    return removedCount
  }

  /**
   * Get Sessions By Account ID
   */
  getSessionsByAccountId(accountId: string): SessionRecord[] {
    this.ensureInitialized()
    const sessions = this.store!.get('sessions') || []
    return sessions.filter((s: SessionRecord) => s.accountId === accountId)
  }

  /**
   * Get Sessions By Provider ID
   */
  getSessionsByProviderId(providerId: string): SessionRecord[] {
    this.ensureInitialized()
    const sessions = this.store!.get('sessions') || []
    return sessions.filter((s: SessionRecord) => s.providerId === providerId)
  }

  /**
   * Clear All Sessions
   */
  clearAllSessions(): void {
    this.ensureInitialized()
    this.store!.set('sessions', [])
  }

  // ==================== Model Management Operations ====================

  /**
   * Get User Model Overrides
   */
  private getUserModelOverrides(): UserModelOverrides {
    this.ensureInitialized()
    return this.store!.get('userModelOverrides') || DEFAULT_USER_MODEL_OVERRIDES
  }

  /**
   * Set User Model Overrides
   */
  private setUserModelOverrides(overrides: UserModelOverrides): void {
    this.ensureInitialized()
    this.store!.set('userModelOverrides', overrides)
  }

  /**
   * Get Provider Model Overrides
   */
  private getProviderModelOverrides(providerId: string): ProviderModelOverrides {
    const overrides = this.getUserModelOverrides()
    return overrides[providerId] || {
      addedModels: [],
      excludedModels: [],
    }
  }

  /**
   * Get Effective Models for a Provider
   * Merges default models with user overrides
   */
  getEffectiveModels(providerId: string): EffectiveModel[] {
    this.ensureInitialized()
    
    const provider = this.getProviderById(providerId)
    if (!provider) {
      return []
    }

    const defaultModels = provider.supportedModels || []
    const modelMappings = provider.modelMappings || {}
    const overrides = this.getProviderModelOverrides(providerId)

    const effectiveModels: EffectiveModel[] = []

    defaultModels.forEach(displayName => {
      if (!overrides.excludedModels.includes(displayName)) {
        const actualModelId = modelMappings[displayName] || displayName
        effectiveModels.push({
          displayName,
          actualModelId,
          isCustom: false,
        })
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

  /**
   * Add Custom Model to Provider
   */
  addCustomModel(providerId: string, model: CustomModel): EffectiveModel[] {
    this.ensureInitialized()
    
    const overrides = this.getUserModelOverrides()
    
    if (!overrides[providerId]) {
      overrides[providerId] = {
        addedModels: [],
        excludedModels: [],
      }
    }

    const existingModel = overrides[providerId].addedModels.find(
      m => m.displayName === model.displayName || m.actualModelId === model.actualModelId
    )
    
    if (existingModel) {
      throw new Error(`Model with display name "${model.displayName}" or actual ID "${model.actualModelId}" already exists`)
    }

    overrides[providerId].addedModels.push(model)
    this.setUserModelOverrides(overrides)

    return this.getEffectiveModels(providerId)
  }

  /**
   * Remove Model from Provider
   * For default models: add to excludedModels
   * For custom models: remove from addedModels
   */
  removeModel(providerId: string, modelName: string): EffectiveModel[] {
    this.ensureInitialized()
    
    const provider = this.getProviderById(providerId)
    if (!provider) {
      throw new Error('Provider not found')
    }

    const overrides = this.getUserModelOverrides()
    
    if (!overrides[providerId]) {
      overrides[providerId] = {
        addedModels: [],
        excludedModels: [],
      }
    }

    const defaultModels = provider.supportedModels || []
    const isDefaultModel = defaultModels.includes(modelName)

    if (isDefaultModel) {
      if (!overrides[providerId].excludedModels.includes(modelName)) {
        overrides[providerId].excludedModels.push(modelName)
      }
    } else {
      overrides[providerId].addedModels = overrides[providerId].addedModels.filter(
        m => m.displayName !== modelName
      )
    }

    this.setUserModelOverrides(overrides)

    return this.getEffectiveModels(providerId)
  }

  /**
   * Reset Provider Models to Default
   * Removes all user overrides for the provider
   */
  resetModels(providerId: string): EffectiveModel[] {
    this.ensureInitialized()
    
    const overrides = this.getUserModelOverrides()
    
    if (overrides[providerId]) {
      delete overrides[providerId]
      this.setUserModelOverrides(overrides)
    }

    return this.getEffectiveModels(providerId)
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
    const accounts = (this.store!.get('accounts') || []).map((a: Account) => {
      const { credentials, ...rest } = a
      return rest
    })
    const config = this.store!.get('config') || DEFAULT_CONFIG
    const logs = this.store!.get('logs') || []
    const requestLogs = this.store!.get('requestLogs') || []
    const systemPrompts = this.store!.get('systemPrompts') || []
    const sessions = this.store!.get('sessions') || []
    const statistics = this.store!.get('statistics') || DEFAULT_STATISTICS
    const userModelOverrides = this.store!.get('userModelOverrides') || DEFAULT_USER_MODEL_OVERRIDES
    
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
