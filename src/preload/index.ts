import { contextBridge, ipcRenderer } from 'electron'
import { IpcChannels } from '../main/ipc/channels'
import type { 
  Provider, 
  Account, 
  ProxyStatus, 
  ProviderCheckResult, 
  OAuthResult,
  AuthType,
  CredentialField,
  LogLevel,
  LogEntry,
  ProviderVendor,
  AppConfig,
  SystemPrompt,
  PromptType,
} from '../shared/types'

const proxyAPI = {
  start: (port?: number): Promise<boolean> => 
    ipcRenderer.invoke(IpcChannels.PROXY_START, port),
  
  stop: (): Promise<boolean> => 
    ipcRenderer.invoke(IpcChannels.PROXY_STOP),
  
  getStatus: (): Promise<ProxyStatus> => 
    ipcRenderer.invoke(IpcChannels.PROXY_GET_STATUS),
  
  onStatusChanged: (callback: (status: ProxyStatus) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, status: ProxyStatus) => callback(status)
    ipcRenderer.on(IpcChannels.PROXY_STATUS_CHANGED, handler)
    return () => ipcRenderer.removeListener(IpcChannels.PROXY_STATUS_CHANGED, handler)
  },
}

const storeAPI = {
  get: <T>(key: string): Promise<T | undefined> => 
    ipcRenderer.invoke(IpcChannels.STORE_GET, key),
  
  set: <T>(key: string, value: T): Promise<void> => 
    ipcRenderer.invoke(IpcChannels.STORE_SET, key, value),
  
  delete: (key: string): Promise<void> => 
    ipcRenderer.invoke(IpcChannels.STORE_DELETE, key),
  
  clearAll: (): Promise<void> => 
    ipcRenderer.invoke(IpcChannels.STORE_CLEAR_ALL),
}

const providersAPI = {
  getAll: (): Promise<Provider[]> => 
    ipcRenderer.invoke(IpcChannels.PROVIDERS_GET_ALL),
  
  getBuiltin: (): Promise<any[]> => 
    ipcRenderer.invoke(IpcChannels.PROVIDERS_GET_BUILTIN),
  
  add: (data: {
    name: string
    authType: AuthType
    apiEndpoint: string
    headers?: Record<string, string>
    description?: string
    supportedModels?: string[]
    credentialFields?: CredentialField[]
  }): Promise<Provider> => 
    ipcRenderer.invoke(IpcChannels.PROVIDERS_ADD, data),
  
  update: (id: string, updates: Partial<Provider>): Promise<Provider | null> => 
    ipcRenderer.invoke(IpcChannels.PROVIDERS_UPDATE, id, updates),
  
  delete: (id: string): Promise<boolean> => 
    ipcRenderer.invoke(IpcChannels.PROVIDERS_DELETE, id),
  
  checkStatus: (providerId: string): Promise<ProviderCheckResult> => 
    ipcRenderer.invoke(IpcChannels.PROVIDERS_CHECK_STATUS, providerId),
  
  checkAllStatus: (): Promise<Record<string, ProviderCheckResult>> => 
    ipcRenderer.invoke(IpcChannels.PROVIDERS_CHECK_ALL_STATUS),
  
  duplicate: (id: string): Promise<Provider> => 
    ipcRenderer.invoke(IpcChannels.PROVIDERS_DUPLICATE, id),
  
  export: (id: string): Promise<string> => 
    ipcRenderer.invoke(IpcChannels.PROVIDERS_EXPORT, id),
  
  import: (jsonData: string): Promise<Provider> => 
    ipcRenderer.invoke(IpcChannels.PROVIDERS_IMPORT, jsonData),
}

const accountsAPI = {
  getAll: (includeCredentials?: boolean): Promise<Account[]> => 
    ipcRenderer.invoke(IpcChannels.ACCOUNTS_GET_ALL, includeCredentials),
  
  getById: (id: string, includeCredentials?: boolean): Promise<Account | null> => 
    ipcRenderer.invoke(IpcChannels.ACCOUNTS_GET_BY_ID, id, includeCredentials),
  
  getByProvider: (providerId: string): Promise<Account[]> => 
    ipcRenderer.invoke(IpcChannels.ACCOUNTS_GET_BY_PROVIDER, providerId),
  
  add: (data: {
    providerId: string
    name: string
    email?: string
    credentials: Record<string, string>
    dailyLimit?: number
  }): Promise<Account> => 
    ipcRenderer.invoke(IpcChannels.ACCOUNTS_ADD, data),
  
  update: (id: string, updates: Partial<Account>): Promise<Account | null> => 
    ipcRenderer.invoke(IpcChannels.ACCOUNTS_UPDATE, id, updates),
  
  delete: (id: string): Promise<boolean> => 
    ipcRenderer.invoke(IpcChannels.ACCOUNTS_DELETE, id),
  
  validate: (accountId: string): Promise<boolean> => 
    ipcRenderer.invoke(IpcChannels.ACCOUNTS_VALIDATE, accountId),
  
  validateToken: (providerId: string, credentials: Record<string, string>): Promise<{
    valid: boolean
    error?: string
    userInfo?: {
      name?: string
      email?: string
      quota?: number
      used?: number
    }
  }> => 
    ipcRenderer.invoke(IpcChannels.ACCOUNTS_VALIDATE_TOKEN, providerId, credentials),

  getCredits: (accountId: string): Promise<{
    totalCredits: number
    usedCredits: number
    remainingCredits: number
  } | null> =>
    ipcRenderer.invoke(IpcChannels.ACCOUNTS_GET_CREDITS, accountId),
}

type ProviderType = ProviderVendor

interface TokenValidationResult {
  valid: boolean
  tokenType?: string
  expiresAt?: number
  accountInfo?: {
    userId?: string
    email?: string
    name?: string
  }
  error?: string
}

interface CredentialInfo {
  type: string
  value: string
  expiresAt?: number
  refreshToken?: string
}

interface OAuthProgressEvent {
  status: 'idle' | 'pending' | 'success' | 'error' | 'cancelled'
  message: string
  progress?: number
  data?: Record<string, unknown>
}

const oauthAPI = {
  startLogin: (providerId: string, providerType: ProviderType): Promise<OAuthResult> => 
    ipcRenderer.invoke(IpcChannels.OAUTH_START_LOGIN, providerId, providerType),
  
  cancelLogin: (): Promise<void> => 
    ipcRenderer.invoke(IpcChannels.OAUTH_CANCEL_LOGIN),
  
  loginWithToken: (providerId: string, providerType: ProviderType, token: string): Promise<OAuthResult> =>
    ipcRenderer.invoke(IpcChannels.OAUTH_LOGIN_WITH_TOKEN, { providerId, providerType, token }),
  
  validateToken: (providerId: string, providerType: ProviderType, credentials: Record<string, string>): Promise<TokenValidationResult> =>
    ipcRenderer.invoke(IpcChannels.OAUTH_VALIDATE_TOKEN, { providerId, providerType, credentials }),
  
  refreshToken: (providerId: string, providerType: ProviderType, credentials: Record<string, string>): Promise<CredentialInfo | null> =>
    ipcRenderer.invoke(IpcChannels.OAUTH_REFRESH_TOKEN, { providerId, providerType, credentials }),
  
  getStatus: (): Promise<string> =>
    ipcRenderer.invoke(IpcChannels.OAUTH_GET_STATUS),
  
  startInAppLogin: (providerId: string, providerType: ProviderType, timeout?: number): Promise<OAuthResult> =>
    ipcRenderer.invoke(IpcChannels.OAUTH_START_IN_APP_LOGIN, { providerId, providerType, timeout }),
  
  cancelInAppLogin: (): Promise<void> =>
    ipcRenderer.invoke(IpcChannels.OAUTH_CANCEL_IN_APP_LOGIN),
  
  isInAppLoginOpen: (): Promise<boolean> =>
    ipcRenderer.invoke(IpcChannels.OAUTH_IN_APP_LOGIN_STATUS),
  
  onCallback: (callback: (result: OAuthResult) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, result: OAuthResult) => callback(result)
    ipcRenderer.on(IpcChannels.OAUTH_CALLBACK, handler)
    return () => ipcRenderer.removeListener(IpcChannels.OAUTH_CALLBACK, handler)
  },
  
  onProgress: (callback: (event: OAuthProgressEvent) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, event: OAuthProgressEvent) => callback(event)
    ipcRenderer.on(IpcChannels.OAUTH_PROGRESS, handler)
    return () => ipcRenderer.removeListener(IpcChannels.OAUTH_PROGRESS, handler)
  },
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

const logsAPI = {
  get: (filter?: LogFilter): Promise<LogEntry[]> => 
    ipcRenderer.invoke(IpcChannels.LOGS_GET, filter),
  
  getStats: (): Promise<LogStats> => 
    ipcRenderer.invoke(IpcChannels.LOGS_GET_STATS),
  
  getTrend: (days?: number): Promise<LogTrend[]> => 
    ipcRenderer.invoke(IpcChannels.LOGS_GET_TREND, days),
  
  getAccountTrend: (accountId: string, days?: number): Promise<LogTrend[]> => 
    ipcRenderer.invoke(IpcChannels.LOGS_GET_ACCOUNT_TREND, accountId, days),
  
  clear: (): Promise<void> => 
    ipcRenderer.invoke(IpcChannels.LOGS_CLEAR),
  
  export: (format?: 'json' | 'txt'): Promise<string> => 
    ipcRenderer.invoke(IpcChannels.LOGS_EXPORT, format),
  
  getById: (id: string): Promise<LogEntry | undefined> => 
    ipcRenderer.invoke(IpcChannels.LOGS_GET_BY_ID, id),
  
  onNewLog: (callback: (log: LogEntry) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, log: LogEntry) => callback(log)
    ipcRenderer.on(IpcChannels.LOGS_NEW_LOG, handler)
    return () => ipcRenderer.removeListener(IpcChannels.LOGS_NEW_LOG, handler)
  },
}

const appAPI = {
  getVersion: (): Promise<string> => 
    ipcRenderer.invoke(IpcChannels.APP_GET_VERSION),
  
  minimize: (): Promise<void> => 
    ipcRenderer.invoke(IpcChannels.APP_MINIMIZE),
  
  maximize: (): Promise<void> => 
    ipcRenderer.invoke(IpcChannels.APP_MAXIMIZE),
  
  close: (): Promise<void> => 
    ipcRenderer.invoke(IpcChannels.APP_CLOSE),
  
  showWindow: (): Promise<void> => 
    ipcRenderer.invoke(IpcChannels.APP_SHOW_WINDOW),
  
  hideWindow: (): Promise<void> => 
    ipcRenderer.invoke(IpcChannels.APP_HIDE_WINDOW),
  
  openExternal: (url: string): Promise<void> => 
    ipcRenderer.invoke(IpcChannels.APP_OPEN_EXTERNAL, url),
}

const configAPI = {
  get: (): Promise<AppConfig> => 
    ipcRenderer.invoke(IpcChannels.CONFIG_GET),
  
  update: (updates: Partial<AppConfig>): Promise<boolean> => 
    ipcRenderer.invoke(IpcChannels.CONFIG_UPDATE, updates),
}

const promptsAPI = {
  getAll: (): Promise<SystemPrompt[]> => 
    ipcRenderer.invoke(IpcChannels.PROMPTS_GET_ALL),
  
  getBuiltin: (): Promise<SystemPrompt[]> => 
    ipcRenderer.invoke(IpcChannels.PROMPTS_GET_BUILTIN),
  
  getCustom: (): Promise<SystemPrompt[]> => 
    ipcRenderer.invoke(IpcChannels.PROMPTS_GET_CUSTOM),
  
  getById: (id: string): Promise<SystemPrompt | undefined> => 
    ipcRenderer.invoke(IpcChannels.PROMPTS_GET_BY_ID, id),
  
  add: (prompt: Omit<SystemPrompt, 'id' | 'createdAt' | 'updatedAt'>): Promise<SystemPrompt> => 
    ipcRenderer.invoke(IpcChannels.PROMPTS_ADD, prompt),
  
  update: (id: string, updates: Partial<SystemPrompt>): Promise<SystemPrompt | null> => 
    ipcRenderer.invoke(IpcChannels.PROMPTS_UPDATE, id, updates),
  
  delete: (id: string): Promise<boolean> => 
    ipcRenderer.invoke(IpcChannels.PROMPTS_DELETE, id),
  
  getByType: (type: PromptType): Promise<SystemPrompt[]> => 
    ipcRenderer.invoke(IpcChannels.PROMPTS_GET_BY_TYPE, type),
}

const electronAPI = {
  proxy: proxyAPI,
  store: storeAPI,
  providers: providersAPI,
  accounts: accountsAPI,
  oauth: oauthAPI,
  logs: logsAPI,
  app: appAPI,
  config: configAPI,
  prompts: promptsAPI,
  
  on: (channel: string, callback: (...args: unknown[]) => void) => {
    const subscription = (_event: Electron.IpcRendererEvent, ...args: unknown[]) => callback(...args)
    ipcRenderer.on(channel, subscription)
    return () => ipcRenderer.removeListener(channel, subscription)
  },
  
  send: (channel: string, ...args: unknown[]) => {
    ipcRenderer.send(channel, ...args)
  },
  
  invoke: (channel: string, ...args: unknown[]) => {
    return ipcRenderer.invoke(channel, ...args)
  },
}

contextBridge.exposeInMainWorld('electronAPI', electronAPI)

export type ElectronAPI = typeof electronAPI
