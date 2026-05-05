/**
 * SQLite Database Layer
 * Replaces electron-store for better performance and lower CPU usage
 */

import Database from 'better-sqlite3'
import { join } from 'path'
import { homedir } from 'os'
import { existsSync, readFileSync, renameSync } from 'fs'
import { safeStorage } from 'electron'
import type {
  Provider,
  Account,
  SessionRecord,
  SystemPrompt,
  LogEntry,
  AppConfig,
  PersistentStatistics,
  UserModelOverrides,
  StoreSchema,
} from './types'
import { DEFAULT_CONFIG, DEFAULT_STATISTICS, DEFAULT_USER_MODEL_OVERRIDES, BUILTIN_PROVIDERS } from './types'
import { BUILTIN_PROMPTS } from '../data/builtin-prompts'

const MIGRATION_BACKUP_SUFFIX = '.migrated'

export class SQLiteStore {
  private db!: Database.Database
  private storagePath: string
  private dbPath: string

  constructor() {
    this.storagePath = join(homedir(), '.chat2api')
    this.dbPath = join(this.storagePath, 'store.db')
  }

  /**
   * Initialize database: create tables, run migrations, import from JSON if needed
   */
  async initialize(): Promise<void> {
    const dbExists = existsSync(this.dbPath)

    // If database doesn't exist but old JSON files exist, migrate
    if (!dbExists && this.hasOldElectronStore()) {
      await this.migrateFromElectronStore()
    }

    this.db = new Database(this.dbPath)
    this.db.pragma('journal_mode = WAL')
    this.db.pragma('synchronous = NORMAL')
    this.db.pragma('cache_size = -64000') // 64MB cache

    this.createTables()

    // If no config exists (fresh install), initialize default data
    const config = this.getConfig()
    if (!config) {
      this.initDefaultData()
    }
  }

  private hasOldElectronStore(): boolean {
    const dataJson = join(this.storagePath, 'data.json')
    const logsJson = join(this.storagePath, 'logs-data.json')
    return existsSync(dataJson) || existsSync(logsJson)
  }

  /**
   * Migrate data from electron-store JSON files to SQLite using electron-store API
   */
  private async migrateFromElectronStore(): Promise<void> {
    console.log('[SQLite] Starting migration from electron-store...')

    const dataJsonPath = join(this.storagePath, 'data.json')
    const logsJsonPath = join(this.storagePath, 'logs-data.json')

    // Default values
    let providers: Provider[] = []
    let accounts: Account[] = []
    let config: AppConfig = DEFAULT_CONFIG
    let systemPrompts: SystemPrompt[] = []
    let sessions: SessionRecord[] = []
    let statistics: PersistentStatistics = DEFAULT_STATISTICS
    let userModelOverrides: UserModelOverrides = DEFAULT_USER_MODEL_OVERRIDES
    let logs: LogEntry[] = []

    // Use electron-store API to read encrypted JSON files
    try {
      // Dynamically import electron-store (ESM module)
      const electronStoreModule = await import('electron-store')
      const Store = electronStoreModule.default

      // Check if data.json exists and is readable via electron-store
      if (existsSync(dataJsonPath)) {
        console.log('[SQLite] Reading data.json via electron-store API...')
        const store = new Store({
          name: 'data',
          cwd: this.storagePath,
          encryptionKey: 'chat2api-fixed-encryption-key-v1', // Matches original
        })
        const data = store.store as unknown as StoreSchema
        providers = data.providers || []
        accounts = data.accounts || []
        config = data.config || DEFAULT_CONFIG
        systemPrompts = (data.systemPrompts || []).filter((p: SystemPrompt) => !p.isBuiltin)
        sessions = data.sessions || []
        statistics = data.statistics || DEFAULT_STATISTICS
        userModelOverrides = data.userModelOverrides || DEFAULT_USER_MODEL_OVERRIDES
        console.log('[SQLite] Successfully read data via electron-store')
      }
    } catch (err) {
      console.error('[SQLite] Failed to read data.json using electron-store API, falling back to file read', err)
      // Fallback to direct file read (should not happen, but keep for safety)
      try {
        const content = readFileSync(dataJsonPath, 'utf-8')
        const data = JSON.parse(content) as StoreSchema
        providers = data.providers || []
        accounts = data.accounts || []
        config = data.config || DEFAULT_CONFIG
        systemPrompts = (data.systemPrompts || []).filter((p: SystemPrompt) => !p.isBuiltin)
        sessions = data.sessions || []
        statistics = data.statistics || DEFAULT_STATISTICS
        userModelOverrides = data.userModelOverrides || DEFAULT_USER_MODEL_OVERRIDES
      } catch (fallbackErr) {
        console.error('[SQLite] Fallback parse also failed', fallbackErr)
      }
    }

    // Parse logs-data.json using electron-store API
    if (existsSync(logsJsonPath)) {
      try {
        const electronStoreModule = await import('electron-store')
        const Store = electronStoreModule.default
        const logsStore = new Store({
          name: 'logs-data',
          cwd: this.storagePath,
          encryptionKey: 'chat2api-fixed-encryption-key-v1',
        })
        logs = logsStore.get('logs') as LogEntry[] || []
        console.log('[SQLite] Successfully read logs-data via electron-store')
      } catch (err) {
        console.error('[SQLite] Failed to read logs-data.json using electron-store API', err)
        // Fallback to direct file read
        try {
          const content = readFileSync(logsJsonPath, 'utf-8')
          const logsData = JSON.parse(content)
          logs = logsData.logs || []
        } catch (fallbackErr) {
          console.error('[SQLite] Fallback parse for logs also failed', fallbackErr)
        }
      }
    }

    // Create database connection if not already created
    this.db = new Database(this.dbPath)
    this.db.pragma('journal_mode = WAL')
    this.createTables()

    // Insert data
    const insertConfig = this.db.prepare('INSERT OR REPLACE INTO config (key, value) VALUES (?, ?)')
    insertConfig.run('app', JSON.stringify(config))

    const insertProvider = this.db.prepare('INSERT OR REPLACE INTO providers (id, data) VALUES (?, ?)')
    for (const p of providers) {
      insertProvider.run(p.id, JSON.stringify(p))
    }

    const insertAccount = this.db.prepare('INSERT OR REPLACE INTO accounts (id, provider_id, data) VALUES (?, ?, ?)')
    // Normalize credentials based on encryption setting
    const shouldEncrypt = config.credentialEncryption && safeStorage.isEncryptionAvailable()
    for (const a of accounts) {
      let accountToStore = { ...a }
      if (shouldEncrypt && accountToStore.credentials) {
        const encryptedCreds: Record<string, string> = {}
        for (const [key, value] of Object.entries(accountToStore.credentials)) {
          try {
            const encrypted = safeStorage.encryptString(value)
            encryptedCreds[key] = encrypted.toString('base64')
          } catch (err) {
            console.error(`[SQLite] Failed to encrypt credential ${key} for account ${a.id}:`, err)
            encryptedCreds[key] = value // fallback to plaintext
          }
        }
        accountToStore = { ...accountToStore, credentials: encryptedCreds }
      }
      insertAccount.run(a.id, a.providerId, JSON.stringify(accountToStore))
    }

    const insertSession = this.db.prepare('INSERT OR REPLACE INTO sessions (id, provider_id, account_id, data) VALUES (?, ?, ?, ?)')
    for (const s of sessions) {
      insertSession.run(s.id, s.providerId, s.accountId, JSON.stringify(s))
    }

    const insertPrompt = this.db.prepare('INSERT OR REPLACE INTO system_prompts (id, data) VALUES (?, ?)')
    for (const p of systemPrompts) {
      insertPrompt.run(p.id, JSON.stringify(p))
    }

    const insertOverride = this.db.prepare('INSERT OR REPLACE INTO model_overrides (provider_id, data) VALUES (?, ?)')
    for (const [providerId, overrides] of Object.entries(userModelOverrides)) {
      insertOverride.run(providerId, JSON.stringify(overrides))
    }

    const insertLog = this.db.prepare('INSERT OR REPLACE INTO logs (id, timestamp, level, message, account_id, provider_id, request_id, data) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    for (const log of logs) {
      insertLog.run(
        log.id,
        log.timestamp,
        log.level,
        log.message,
        log.accountId || null,
        log.providerId || null,
        log.requestId || null,
        log.data ? JSON.stringify(log.data) : null
      )
    }

    const insertStat = this.db.prepare('INSERT OR REPLACE INTO statistics (key, data) VALUES (?, ?)')
    insertStat.run('main', JSON.stringify(statistics))

    // Rename old files to .migrated backup
    try {
      renameSync(dataJsonPath, dataJsonPath + MIGRATION_BACKUP_SUFFIX)
      if (existsSync(logsJsonPath)) {
        renameSync(logsJsonPath, logsJsonPath + MIGRATION_BACKUP_SUFFIX)
      }
      console.log('[SQLite] Migration completed and old files backed up')
    } catch (err) {
      console.error('[SQLite] Failed to rename old files', err)
    }
  }

  private createTables(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS config (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS providers (
        id TEXT PRIMARY KEY,
        data TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS accounts (
        id TEXT PRIMARY KEY,
        provider_id TEXT NOT NULL,
        data TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_accounts_provider ON accounts(provider_id);

      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        provider_id TEXT NOT NULL,
        account_id TEXT NOT NULL,
        data TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_sessions_provider ON sessions(provider_id);
      CREATE INDEX IF NOT EXISTS idx_sessions_account ON sessions(account_id);

      CREATE TABLE IF NOT EXISTS system_prompts (
        id TEXT PRIMARY KEY,
        data TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS model_overrides (
        provider_id TEXT PRIMARY KEY,
        data TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS logs (
        id TEXT PRIMARY KEY,
        timestamp INTEGER NOT NULL,
        level TEXT NOT NULL,
        message TEXT NOT NULL,
        account_id TEXT,
        provider_id TEXT,
        request_id TEXT,
        data TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_logs_timestamp ON logs(timestamp);
      CREATE INDEX IF NOT EXISTS idx_logs_level ON logs(level);

      CREATE TABLE IF NOT EXISTS statistics (
        key TEXT PRIMARY KEY,
        data TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS kv_store (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `)
  }

  private initDefaultData(): void {
    // Insert default config
    this.db.prepare('INSERT INTO config (key, value) VALUES (?, ?)').run('app', JSON.stringify(DEFAULT_CONFIG))

    // Insert built-in providers
    const insertProvider = this.db.prepare('INSERT OR REPLACE INTO providers (id, data) VALUES (?, ?)')
    for (const provider of BUILTIN_PROVIDERS) {
      insertProvider.run(provider.id, JSON.stringify(provider))
    }

    // Default statistics
    this.db.prepare('INSERT INTO statistics (key, data) VALUES (?, ?)').run('main', JSON.stringify(DEFAULT_STATISTICS))
  }

  // ==================== Config ====================

  getConfig(): AppConfig | null {
    const row = this.db.prepare('SELECT value FROM config WHERE key = ?').get('app') as { value: string } | undefined
    return row ? JSON.parse(row.value) : null
  }

  setConfig(config: AppConfig): void {
    this.db.prepare('INSERT OR REPLACE INTO config (key, value) VALUES (?, ?)').run('app', JSON.stringify(config))
  }

  // ==================== Providers ====================

  getProviders(): Provider[] {
    const rows = this.db.prepare('SELECT data FROM providers').all() as { data: string }[]
    return rows.map(row => JSON.parse(row.data))
  }

  getProviderById(id: string): Provider | undefined {
    const row = this.db.prepare('SELECT data FROM providers WHERE id = ?').get(id) as { data: string } | undefined
    return row ? JSON.parse(row.data) : undefined
  }

  addProvider(provider: Provider): void {
    this.db.prepare('INSERT OR REPLACE INTO providers (id, data) VALUES (?, ?)').run(provider.id, JSON.stringify(provider))
  }

  updateProvider(id: string, updates: Partial<Provider>): Provider | null {
    const existing = this.getProviderById(id)
    if (!existing) return null
    const updated = { ...existing, ...updates, updatedAt: Date.now() }
    this.db.prepare('INSERT OR REPLACE INTO providers (id, data) VALUES (?, ?)').run(id, JSON.stringify(updated))
    return updated
  }

  deleteProvider(id: string): boolean {
    const result = this.db.prepare('DELETE FROM providers WHERE id = ?').run(id)
    if (result.changes > 0) {
      // Also delete associated accounts
      this.db.prepare('DELETE FROM accounts WHERE provider_id = ?').run(id)
      return true
    }
    return false
  }

  // ==================== Accounts ====================

  getAccounts(): Account[] {
    const rows = this.db.prepare('SELECT data FROM accounts').all() as { data: string }[]
    return rows.map(row => JSON.parse(row.data))
  }

  getAccountById(id: string): Account | undefined {
    const row = this.db.prepare('SELECT data FROM accounts WHERE id = ?').get(id) as { data: string } | undefined
    return row ? JSON.parse(row.data) : undefined
  }

  getAccountsByProviderId(providerId: string): Account[] {
    const rows = this.db.prepare('SELECT data FROM accounts WHERE provider_id = ?').all(providerId) as { data: string }[]
    return rows.map(row => JSON.parse(row.data))
  }

  addAccount(account: Account): void {
    this.db.prepare('INSERT OR REPLACE INTO accounts (id, provider_id, data) VALUES (?, ?, ?)').run(
      account.id,
      account.providerId,
      JSON.stringify(account)
    )
  }

  updateAccount(id: string, updates: Partial<Account>): Account | null {
    const existing = this.getAccountById(id)
    if (!existing) return null
    const updated = { ...existing, ...updates, updatedAt: Date.now() }
    this.db.prepare('INSERT OR REPLACE INTO accounts (id, provider_id, data) VALUES (?, ?, ?)').run(
      id,
      updated.providerId,
      JSON.stringify(updated)
    )
    return updated
  }

  deleteAccount(id: string): boolean {
    const result = this.db.prepare('DELETE FROM accounts WHERE id = ?').run(id)
    return result.changes > 0
  }

  // ==================== Sessions ====================

  getSessions(): SessionRecord[] {
    const rows = this.db.prepare('SELECT data FROM sessions').all() as { data: string }[]
    return rows.map(row => JSON.parse(row.data))
  }

  getSessionById(id: string): SessionRecord | undefined {
    const row = this.db.prepare('SELECT data FROM sessions WHERE id = ?').get(id) as { data: string } | undefined
    return row ? JSON.parse(row.data) : undefined
  }

  getSessionsByProviderId(providerId: string): SessionRecord[] {
    const rows = this.db.prepare('SELECT data FROM sessions WHERE provider_id = ?').all(providerId) as { data: string }[]
    return rows.map(row => JSON.parse(row.data))
  }

  getSessionsByAccountId(accountId: string): SessionRecord[] {
    const rows = this.db.prepare('SELECT data FROM sessions WHERE account_id = ?').all(accountId) as { data: string }[]
    return rows.map(row => JSON.parse(row.data))
  }

  addSession(session: SessionRecord): void {
    this.db.prepare('INSERT OR REPLACE INTO sessions (id, provider_id, account_id, data) VALUES (?, ?, ?, ?)').run(
      session.id,
      session.providerId,
      session.accountId,
      JSON.stringify(session)
    )
  }

  updateSession(id: string, updates: Partial<SessionRecord>): SessionRecord | null {
    const existing = this.getSessionById(id)
    if (!existing) return null
    const updated = { ...existing, ...updates }
    this.db.prepare('INSERT OR REPLACE INTO sessions (id, provider_id, account_id, data) VALUES (?, ?, ?, ?)').run(
      id,
      updated.providerId,
      updated.accountId,
      JSON.stringify(updated)
    )
    return updated
  }

  deleteSession(id: string): boolean {
    const result = this.db.prepare('DELETE FROM sessions WHERE id = ?').run(id)
    return result.changes > 0
  }

  clearAllSessions(): void {
    this.db.prepare('DELETE FROM sessions').run()
  }

  // ==================== System Prompts ====================

  getSystemPrompts(): SystemPrompt[] {
    const rows = this.db.prepare('SELECT data FROM system_prompts').all() as { data: string }[]
    const custom = rows.map(row => JSON.parse(row.data))
    // Merge with built-in prompts (always returned from memory)
    return [...BUILTIN_PROMPTS, ...custom]
  }

  getCustomPrompts(): SystemPrompt[] {
    const rows = this.db.prepare('SELECT data FROM system_prompts').all() as { data: string }[]
    return rows.map(row => JSON.parse(row.data))
  }

  addSystemPrompt(prompt: Omit<SystemPrompt, 'id' | 'createdAt' | 'updatedAt'>): SystemPrompt {
    const newPrompt: SystemPrompt = {
      ...prompt,
      id: this.generateId(),
      isBuiltin: false,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }
    this.db.prepare('INSERT OR REPLACE INTO system_prompts (id, data) VALUES (?, ?)').run(newPrompt.id, JSON.stringify(newPrompt))
    return newPrompt
  }

  updateSystemPrompt(id: string, updates: Partial<SystemPrompt>): SystemPrompt | null {
    const existing = this.getCustomPrompts().find(p => p.id === id)
    if (!existing) return null
    const updated = { ...existing, ...updates, updatedAt: Date.now() }
    this.db.prepare('INSERT OR REPLACE INTO system_prompts (id, data) VALUES (?, ?)').run(id, JSON.stringify(updated))
    return updated
  }

  deleteSystemPrompt(id: string): boolean {
    const result = this.db.prepare('DELETE FROM system_prompts WHERE id = ?').run(id)
    return result.changes > 0
  }

  // ==================== Model Overrides ====================

  getUserModelOverrides(): UserModelOverrides {
    const rows = this.db.prepare('SELECT provider_id, data FROM model_overrides').all() as { provider_id: string; data: string }[]
    const overrides: UserModelOverrides = {}
    for (const row of rows) {
      overrides[row.provider_id] = JSON.parse(row.data)
    }
    return overrides
  }

  setUserModelOverrides(overrides: UserModelOverrides): void {
    // Clear existing
    this.db.prepare('DELETE FROM model_overrides').run()
    const insert = this.db.prepare('INSERT INTO model_overrides (provider_id, data) VALUES (?, ?)')
    for (const [providerId, data] of Object.entries(overrides)) {
      insert.run(providerId, JSON.stringify(data))
    }
  }

  // ==================== Logs (control logs) ====================

  addLog(log: LogEntry): void {
    this.db.prepare(
      `INSERT INTO logs (id, timestamp, level, message, account_id, provider_id, request_id, data)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      log.id,
      log.timestamp,
      log.level,
      log.message,
      log.accountId || null,
      log.providerId || null,
      log.requestId || null,
      log.data ? JSON.stringify(log.data) : null
    )
  }

  addLogsBatch(logs: LogEntry[]): void {
    if (logs.length === 0) return
    const insert = this.db.prepare(
      `INSERT INTO logs (id, timestamp, level, message, account_id, provider_id, request_id, data)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    const insertMany = this.db.transaction((logs: LogEntry[]) => {
      for (const log of logs) {
        insert.run(
          log.id,
          log.timestamp,
          log.level,
          log.message,
          log.accountId || null,
          log.providerId || null,
          log.requestId || null,
          log.data ? JSON.stringify(log.data) : null
        )
      }
    })
    insertMany(logs)
  }

  getLogs(limit?: number, level?: string): LogEntry[] {
    let sql = 'SELECT id, timestamp, level, message, account_id, provider_id, request_id, data FROM logs'
    const params: any[] = []
    if (level) {
      sql += ' WHERE level = ?'
      params.push(level)
    }
    sql += ' ORDER BY timestamp DESC'
    if (limit) {
      sql += ' LIMIT ?'
      params.push(limit)
    }
    const rows = this.db.prepare(sql).all(...params) as any[]
    return rows.map(row => ({
      id: row.id,
      timestamp: row.timestamp,
      level: row.level,
      message: row.message,
      accountId: row.account_id,
      providerId: row.provider_id,
      requestId: row.request_id,
      data: row.data ? JSON.parse(row.data) : undefined,
    }))
  }

  clearLogs(): void {
    this.db.prepare('DELETE FROM logs').run()
  }

  cleanExpiredLogs(retentionDays: number): void {
    const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000
    this.db.prepare('DELETE FROM logs WHERE timestamp < ?').run(cutoff)
  }

  // ==================== Statistics ====================

  getStatistics(): PersistentStatistics | null {
    const row = this.db.prepare('SELECT data FROM statistics WHERE key = ?').get('main') as { data: string } | undefined
    return row ? JSON.parse(row.data) : null
  }

  setStatistics(stats: PersistentStatistics): void {
    this.db.prepare('INSERT OR REPLACE INTO statistics (key, data) VALUES (?, ?)').run('main', JSON.stringify(stats))
  }

  // ==================== Generic Key-Value Store ====================

  getGeneric(key: string): unknown {
    const row = this.db.prepare('SELECT value FROM kv_store WHERE key = ?').get(key) as { value: string } | undefined
    return row ? JSON.parse(row.value) : undefined
  }

  setGeneric(key: string, value: unknown): void {
    this.db.prepare('INSERT OR REPLACE INTO kv_store (key, value) VALUES (?, ?)').run(key, JSON.stringify(value))
  }

  deleteGeneric(key: string): void {
    this.db.prepare('DELETE FROM kv_store WHERE key = ?').run(key)
  }

  // ==================== Utility ====================

  generateId(): string {
    return `${Date.now()}-${Math.random().toString(36).substring(2, 11)}`
  }

  close(): void {
    if (this.db) {
      this.db.close()
    }
  }
}

export const sqliteStore = new SQLiteStore()
