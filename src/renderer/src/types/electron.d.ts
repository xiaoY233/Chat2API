import type { 
  Provider, 
  Account, 
  ProxyStatus, 
  ProxyStatistics,
  ProviderCheckResult, 
  OAuthResult,
  AuthType,
  CredentialField,
  LogLevel,
  LogEntry,
  LoadBalanceStrategy,
  ModelMapping,
  AppConfig,
  AccountStatus,
  ProviderType,
  ProviderVendor,
  ProviderStatus,
  ApiKey,
} from '../../../shared/types'

export type { 
  Provider, 
  Account, 
  ProxyStatus,
  ProxyStatistics,
  ProviderCheckResult, 
  OAuthResult,
  AuthType,
  CredentialField,
  LogLevel,
  LogEntry,
  LoadBalanceStrategy,
  ModelMapping,
  AppConfig,
  AccountStatus,
  ProviderType,
  ProviderVendor,
  ProviderStatus,
  ApiKey,
}

export interface CustomProviderFormData {
  name: string
  authType: AuthType
  apiEndpoint: string
  headers: Record<string, string>
  description: string
  supportedModels: string[]
  credentialFields: CredentialField[]
}

export interface BuiltinProviderConfig extends Provider {
  credentialFields: CredentialField[]
  tokenCheckEndpoint?: string
  tokenCheckMethod?: 'GET' | 'POST'
}

interface ProxyAPI {
  start: (port?: number) => Promise<boolean>
  stop: () => Promise<boolean>
  getStatus: () => Promise<ProxyStatus>
  onStatusChanged: (callback: (status: ProxyStatus) => void) => () => void
}

interface StoreAPI {
  get: <T>(key: string) => Promise<T | undefined>
  set: <T>(key: string, value: T) => Promise<void>
  delete: (key: string) => Promise<void>
  clearAll: () => Promise<void>
}

interface ProvidersAPI {
  getAll: () => Promise<Provider[]>
  getBuiltin: () => Promise<BuiltinProviderConfig[]>
  add: (data: {
    id?: string
    name: string
    type?: 'builtin' | 'custom'
    authType: AuthType
    apiEndpoint: string
    headers?: Record<string, string>
    description?: string
    supportedModels?: string[]
    credentialFields?: CredentialField[]
  }) => Promise<Provider>
  update: (id: string, updates: Partial<Provider>) => Promise<Provider | null>
  delete: (id: string) => Promise<boolean>
  checkStatus: (providerId: string) => Promise<ProviderCheckResult>
  checkAllStatus: () => Promise<Record<string, ProviderCheckResult>>
  duplicate: (id: string) => Promise<Provider>
  export: (id: string) => Promise<string>
  import: (jsonData: string) => Promise<Provider>
}

interface AccountsAPI {
  getAll: (includeCredentials?: boolean) => Promise<Account[]>
  add: (data: {
    providerId: string
    name: string
    email?: string
    credentials: Record<string, string>
    dailyLimit?: number
  }) => Promise<Account>
  update: (id: string, updates: Partial<Account>) => Promise<Account | null>
  delete: (id: string) => Promise<boolean>
  validate: (accountId: string) => Promise<boolean>
  validateToken: (providerId: string, credentials: Record<string, string>) => Promise<{
    valid: boolean
    error?: string
    userInfo?: {
      name?: string
      email?: string
      quota?: number
      used?: number
    }
  }>
  getById: (id: string, includeCredentials?: boolean) => Promise<Account | null>
  getByProvider: (providerId: string) => Promise<Account[]>
  getCredits: (accountId: string) => Promise<{
    totalCredits: number
    usedCredits: number
    remainingCredits: number
  } | null>
}

interface OAuthAPI {
  startLogin: (providerId: string, providerType: ProviderVendor) => Promise<OAuthResult>
  cancelLogin: () => Promise<void>
  loginWithToken: (providerId: string, providerType: ProviderVendor, token: string) => Promise<OAuthResult>
  validateToken: (providerId: string, providerType: ProviderVendor, credentials: Record<string, string>) => Promise<{
    valid: boolean
    tokenType?: string
    expiresAt?: number
    accountInfo?: {
      userId?: string
      email?: string
      name?: string
    }
    error?: string
  }>
  refreshToken: (providerId: string, providerType: ProviderVendor, credentials: Record<string, string>) => Promise<{
    type: string
    value: string
    expiresAt?: number
    refreshToken?: string
  } | null>
  getStatus: () => Promise<string>
  startInAppLogin: (providerId: string, providerType: ProviderVendor, timeout?: number) => Promise<OAuthResult>
  cancelInAppLogin: () => Promise<void>
  isInAppLoginOpen: () => Promise<boolean>
  onCallback: (callback: (result: OAuthResult) => void) => () => void
  onProgress: (callback: (event: {
    status: 'idle' | 'pending' | 'success' | 'error' | 'cancelled'
    message: string
    progress?: number
    data?: Record<string, unknown>
  }) => void) => () => void
}

interface LogFilter {
  level?: LogLevel | 'all'
  keyword?: string
  startTime?: number
  endTime?: number
  limit?: number
  offset?: number
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

interface LogsAPI {
  get: (filter?: LogFilter) => Promise<LogEntry[]>
  getStats: () => Promise<LogStats>
  getTrend: (days?: number) => Promise<LogTrend[]>
  getAccountTrend: (accountId: string, days?: number) => Promise<LogTrend[]>
  clear: () => Promise<void>
  export: (format?: 'json' | 'txt') => Promise<string>
  getById: (id: string) => Promise<LogEntry | undefined>
  onNewLog: (callback: (log: LogEntry) => void) => () => void
}

interface AppAPI {
  getVersion: () => Promise<string>
  minimize: () => Promise<void>
  maximize: () => Promise<void>
  close: () => Promise<void>
  showWindow: () => Promise<void>
  hideWindow: () => Promise<void>
  openExternal: (url: string) => Promise<void>
}

interface ConfigAPI {
  get: () => Promise<AppConfig>
  update: (updates: Partial<AppConfig>) => Promise<boolean>
}

interface ElectronAPI {
  proxy: ProxyAPI
  store: StoreAPI
  providers: ProvidersAPI
  accounts: AccountsAPI
  oauth: OAuthAPI
  logs: LogsAPI
  app: AppAPI
  config: ConfigAPI
  on: (channel: string, callback: (...args: unknown[]) => void) => () => void
  send: (channel: string, ...args: unknown[]) => void
  invoke: (channel: string, ...args: unknown[]) => Promise<unknown>
}

declare global {
  interface Window {
    electronAPI: ElectronAPI
  }
}

export {}
