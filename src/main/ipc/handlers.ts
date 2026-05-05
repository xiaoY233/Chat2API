import { ipcMain, app, BrowserWindow, shell } from 'electron'
import axios from 'axios'
import { IpcChannels } from './channels'
import { storeManager } from '../store/store'
import { ProviderManager } from '../store/providers'
import { AccountManager } from '../store/accounts'
import { ProviderChecker } from '../providers/checker'
import { CustomProviderManager } from '../providers/custom'
import { getBuiltinProviders, getBuiltinProvider } from '../providers/builtin'
import { oauthManager } from '../oauth/manager'
import { ProxyServer } from '../proxy/server'
import { proxyStatusManager } from '../proxy/status'
import { sessionManager } from '../proxy/sessionManager'
import { TrayManager } from '../tray/TrayManager'
import { ConfigManager } from '../store/config'
import { generateManagementSecret } from '../proxy/middleware/managementAuth'
import { UpdaterManager } from '../updater'
import type { Provider, Account, ProxyStatus, ProviderCheckResult, OAuthResult, AuthType, CredentialField, LogLevel, LogEntry, ProviderVendor, AppConfig } from '../../shared/types'
import type { SystemPrompt, SessionConfig, SessionRecord, ManagementApiConfig } from '../store/types'
import type { ProviderType } from '../oauth/types'

let proxyServer: ProxyServer | null = null
let proxyStartTime: number | null = null
const updaterManager = UpdaterManager.getInstance()

export async function registerIpcHandlers(mainWindow: BrowserWindow | null): Promise<void> {
  try {
    await storeManager.initialize()
  } catch (error) {
    console.error('[IPC] Failed to initialize storage:', error)
    
    // Notify renderer about the initialization error
    mainWindow?.webContents.send(IpcChannels.STORE_INIT_ERROR, {
      message: error instanceof Error ? error.message : 'Failed to initialize storage',
    })
    
    // Still set mainWindow for potential recovery
    storeManager.setMainWindow(mainWindow)
    
    if (mainWindow) {
      oauthManager.setMainWindow(mainWindow)
    }
    
    // Register minimal IPC handlers for error recovery
    registerErrorRecoveryHandlers(mainWindow)
    return
  }
  
  storeManager.setMainWindow(mainWindow)
  
  if (mainWindow) {
    oauthManager.setMainWindow(mainWindow)
    updaterManager.initialize(mainWindow)
  }

  // Check if auto-start proxy is needed
  const config = storeManager.getConfig()
  if (config.autoStartProxy) {
    console.log('[App] Auto-starting proxy service...')
    const proxyPort = config.proxyPort
    const proxyHost = config.proxyHost || '127.0.0.1'
    try {
      proxyServer = new ProxyServer()
      const success = await proxyServer.start(proxyPort, proxyHost)
      if (success) {
        proxyStartTime = Date.now()
        console.log('[App] Proxy service auto-started successfully, port:', proxyPort)
        const status: ProxyStatus = {
          isRunning: true,
          port: proxyPort,
          uptime: 0,
          connections: 0,
        }
        mainWindow?.webContents.send(IpcChannels.PROXY_STATUS_CHANGED, status)
      } else {
        proxyServer = null
        console.log('[App] Proxy service auto-start failed')
      }
    } catch (error) {
      console.error('[App] Proxy service auto-start failed:', error)
      proxyServer = null
    }
  }

  ipcMain.handle(IpcChannels.PROXY_START, async (_, port?: number): Promise<boolean> => {
    try {
      if (proxyServer) {
        console.log('Proxy server is already running')
        return true
      }

      const config = storeManager.getConfig()
      const proxyPort = port || config.proxyPort
      const proxyHost = config.proxyHost || '127.0.0.1'

      proxyServer = new ProxyServer()
      const success = await proxyServer.start(proxyPort, proxyHost)
      
      if (success) {
        proxyStartTime = Date.now()
        const status: ProxyStatus = {
          isRunning: true,
          port: proxyPort,
          uptime: 0,
          connections: 0,
        }
        mainWindow?.webContents.send(IpcChannels.PROXY_STATUS_CHANGED, status)
        TrayManager.getInstance().updateProxyStatus(true)
      } else {
        proxyServer = null
      }
      
      return success
    } catch (error) {
      console.error('Failed to start proxy:', error)
      proxyServer = null
      return false
    }
  })

  ipcMain.handle(IpcChannels.PROXY_STOP, async (): Promise<boolean> => {
    try {
      if (!proxyServer) {
        return true
      }

      const success = await proxyServer.stop()
      
      if (success) {
        const status: ProxyStatus = {
          isRunning: false,
          port: proxyStatusManager.getPort(),
          uptime: proxyStartTime ? Date.now() - proxyStartTime : 0,
          connections: 0,
        }
        proxyServer = null
        proxyStartTime = null
        mainWindow?.webContents.send(IpcChannels.PROXY_STATUS_CHANGED, status)
        TrayManager.getInstance().updateProxyStatus(false)
      }
      
      return success
    } catch (error) {
      console.error('Failed to stop proxy:', error)
      return false
    }
  })

  ipcMain.handle(IpcChannels.PROXY_GET_STATUS, async (): Promise<ProxyStatus> => {
    const isRunning = proxyServer !== null
    const port = proxyStatusManager.getPort()
    return {
      isRunning,
      port,
      uptime: proxyStartTime && isRunning ? Date.now() - proxyStartTime : 0,
      connections: proxyStatusManager.getStatistics().activeConnections,
    }
  })

  ipcMain.handle(IpcChannels.PROXY_GET_STATISTICS, async () => {
    const stats = proxyStatusManager.getStatistics()
    return {
      totalRequests: stats.totalRequests,
      successRequests: stats.successRequests,
      failedRequests: stats.failedRequests,
      avgLatency: stats.avgLatency,
      requestsPerMinute: stats.requestsPerMinute,
      activeConnections: stats.activeConnections,
      modelUsage: stats.modelUsage,
      providerUsage: stats.providerUsage,
      accountUsage: stats.accountUsage,
    }
  })

  ipcMain.handle(IpcChannels.PROXY_RESET_STATISTICS, async (): Promise<void> => {
    proxyStatusManager.resetStatistics()
  })

  ipcMain.handle(IpcChannels.CONFIG_GET, async () => {
    return storeManager.getConfig()
  })

  ipcMain.handle(IpcChannels.CONFIG_UPDATE, async (_, updates: Partial<AppConfig>) => {
    const newConfig = storeManager.updateConfig(updates)
    
    BrowserWindow.getAllWindows().forEach((win) => {
      if (!win.isDestroyed()) {
        win.webContents.send(IpcChannels.CONFIG_CHANGED, newConfig)
      }
    })
    
    return true
  })

  ipcMain.handle(IpcChannels.STORE_GET, async (_, key: string): Promise<unknown> => {
    if (key === 'logs' || key === 'requestLogs') {
      const logsStore = storeManager.getLogsStore()
      return logsStore?.get(key)
    }
    const store = storeManager.getStore()
    return store?.get(key)
  })

  ipcMain.handle(IpcChannels.STORE_SET, async (_, key: string, value: unknown): Promise<void> => {
    if (key === 'logs' || key === 'requestLogs') {
      const logsStore = storeManager.getLogsStore()
      logsStore?.set(key as 'logs', value as never)
      return
    }
    const store = storeManager.getStore()
    store?.set(key as 'providers' | 'accounts' | 'config' | 'logs', value as never)
  })

  ipcMain.handle(IpcChannels.STORE_DELETE, async (_, key: string): Promise<void> => {
    if (key === 'logs' || key === 'requestLogs') {
      const logsStore = storeManager.getLogsStore()
      logsStore?.delete(key as 'logs')
      return
    }
    const store = storeManager.getStore()
    store?.delete(key as 'providers' | 'accounts' | 'config' | 'logs')
  })

  ipcMain.handle(IpcChannels.STORE_CLEAR_ALL, async (): Promise<void> => {
    storeManager.clearAll()
  })

  ipcMain.handle(IpcChannels.PROVIDERS_GET_ALL, async (): Promise<Provider[]> => {
    return ProviderManager.getAll()
  })

  ipcMain.handle(IpcChannels.PROVIDERS_GET_BUILTIN, async () => {
    return getBuiltinProviders()
  })

  ipcMain.handle(IpcChannels.PROVIDERS_ADD, async (_, data: {
    id?: string
    name: string
    type?: 'builtin' | 'custom'
    authType: AuthType
    apiEndpoint: string
    headers?: Record<string, string>
    description?: string
    supportedModels?: string[]
    credentialFields?: CredentialField[]
  }): Promise<Provider> => {
    return CustomProviderManager.create(data)
  })

  ipcMain.handle(IpcChannels.PROVIDERS_UPDATE, async (_, id: string, updates: Partial<Provider>): Promise<Provider | null> => {
    return ProviderManager.update(id, updates)
  })

  ipcMain.handle(IpcChannels.PROVIDERS_DELETE, async (_, id: string): Promise<boolean> => {
    return CustomProviderManager.delete(id)
  })

  ipcMain.handle(IpcChannels.PROVIDERS_CHECK_STATUS, async (_, providerId: string): Promise<ProviderCheckResult> => {
    const provider = ProviderManager.getById(providerId)

    if (!provider) {
      return {
        providerId,
        status: 'unknown',
        error: 'Provider not found',
      }
    }

    const result = await ProviderChecker.checkProviderStatus(provider)
    
    // Save status to provider
    ProviderManager.update(providerId, {
      status: result.status,
      lastStatusCheck: Date.now(),
    })
    
    return result
  })

  ipcMain.handle(IpcChannels.PROVIDERS_CHECK_ALL_STATUS, async (): Promise<Record<string, ProviderCheckResult>> => {
    const providers = ProviderManager.getAll()
    const results: Record<string, ProviderCheckResult> = {}
    
    await Promise.all(
      providers.map(async (provider) => {
        const result = await ProviderChecker.checkProviderStatus(provider)
        results[provider.id] = result
        
        // Save status to provider
        ProviderManager.update(provider.id, {
          status: result.status,
          lastStatusCheck: Date.now(),
        })
      })
    )
    
    return results
  })

  ipcMain.handle(IpcChannels.PROVIDERS_DUPLICATE, async (_, id: string): Promise<Provider> => {
    return CustomProviderManager.duplicate(id)
  })

  ipcMain.handle(IpcChannels.PROVIDERS_EXPORT, async (_, id: string): Promise<string> => {
    return CustomProviderManager.exportProvider(id)
  })

  ipcMain.handle(IpcChannels.PROVIDERS_IMPORT, async (_, jsonData: string): Promise<Provider> => {
    return CustomProviderManager.importProvider(jsonData)
  })

  ipcMain.handle(IpcChannels.PROVIDERS_SYNC_MODELS, async (_, providerId: string): Promise<{
    success: boolean
    supportedModels?: string[]
    modelMappings?: Record<string, string>
    error?: string
  }> => {
    try {
      const result = await ProviderChecker.fetchProviderModels(providerId)
      
      const provider = ProviderManager.getById(providerId)
      if (provider) {
        ProviderManager.update(providerId, {
          supportedModels: result.supportedModels,
          modelMappings: result.modelMappings,
        })
      }

      return {
        success: true,
        supportedModels: result.supportedModels,
        modelMappings: result.modelMappings,
      }
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to sync models',
      }
    }
  })

  ipcMain.handle(IpcChannels.PROVIDERS_UPDATE_MODELS, async (_, providerId: string): Promise<{
    success: boolean
    modelsCount?: number
    error?: string
  }> => {
    try {
      const provider = ProviderManager.getById(providerId)
      
      if (!provider) {
        return {
          success: false,
          error: 'Provider not found',
        }
      }

      let modelsApiEndpoint: string | undefined
      let modelsApiHeaders: Record<string, string> | undefined

      if (provider.type === 'builtin') {
        const builtinConfig = getBuiltinProvider(providerId)
        if (builtinConfig) {
          modelsApiEndpoint = builtinConfig.modelsApiEndpoint
          modelsApiHeaders = builtinConfig.modelsApiHeaders
        }
      }

      if (!modelsApiEndpoint) {
        return {
          success: false,
          error: 'This provider does not support dynamic model updates',
        }
      }

      const accounts = AccountManager.getByProviderId(providerId, true)
      const activeAccount = accounts.find(a => a.status === 'active')
      
      const requestHeaders: Record<string, string> = {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        ...modelsApiHeaders,
      }
      
      if (activeAccount?.credentials?.token) {
        requestHeaders['Authorization'] = `Bearer ${activeAccount.credentials.token}`
      }
      
      if (activeAccount?.credentials?.cookies) {
        requestHeaders['Cookie'] = activeAccount.credentials.cookies
      }

      const response = await axios.get(modelsApiEndpoint, {
        headers: requestHeaders,
        timeout: 15000,
        validateStatus: () => true,
      })

      if (response.status !== 200) {
        return {
          success: false,
          error: `Failed to fetch models: HTTP ${response.status}`,
        }
      }

      const models = response.data.data || response.data

      if (!Array.isArray(models) || models.length === 0) {
        return {
          success: false,
          error: 'No models found in the response',
        }
      }

      const supportedModels: string[] = []
      const modelMappings: Record<string, string> = {}

      models.forEach((model: any) => {
        if (typeof model === 'string') {
          supportedModels.push(model)
          modelMappings[model] = model
        } else if (model && typeof model === 'object') {
          const modelId = model.id || model.model_id || model.name
          const modelName = model.name || model.display_name || modelId
          
          if (modelId) {
            supportedModels.push(modelName || modelId)
            modelMappings[modelName || modelId] = modelId
          }
        }
      })

      if (supportedModels.length === 0) {
        return {
          success: false,
          error: 'Failed to parse models from the response',
        }
      }

      ProviderManager.update(providerId, {
        supportedModels,
        modelMappings,
      })

      return {
        success: true,
        modelsCount: supportedModels.length,
      }
    } catch (error) {
      console.error('[IPC] Failed to update models:', error)
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to update models',
      }
    }
  })

  ipcMain.handle(IpcChannels.PROVIDERS_GET_EFFECTIVE_MODELS, async (_, providerId: string) => {
    try {
      return storeManager.getEffectiveModels(providerId)
    } catch (error) {
      console.error('[IPC] Failed to get effective models:', error)
      return []
    }
  })

  ipcMain.handle(IpcChannels.PROVIDERS_ADD_CUSTOM_MODEL, async (_, providerId: string, model: { displayName: string; actualModelId: string }) => {
    try {
      return {
        success: true,
        models: storeManager.addCustomModel(providerId, model),
      }
    } catch (error) {
      console.error('[IPC] Failed to add custom model:', error)
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to add custom model',
        models: [],
      }
    }
  })

  ipcMain.handle(IpcChannels.PROVIDERS_REMOVE_MODEL, async (_, providerId: string, modelName: string) => {
    try {
      return {
        success: true,
        models: storeManager.removeModel(providerId, modelName),
      }
    } catch (error) {
      console.error('[IPC] Failed to remove model:', error)
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to remove model',
        models: [],
      }
    }
  })

  ipcMain.handle(IpcChannels.PROVIDERS_RESET_MODELS, async (_, providerId: string) => {
    try {
      return {
        success: true,
        models: storeManager.resetModels(providerId),
      }
    } catch (error) {
      console.error('[IPC] Failed to reset models:', error)
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to reset models',
        models: [],
      }
    }
  })

  ipcMain.handle(IpcChannels.ACCOUNTS_GET_ALL, async (_, includeCredentials?: boolean): Promise<Account[]> => {
    return AccountManager.getAll(includeCredentials)
  })

  ipcMain.handle(IpcChannels.ACCOUNTS_GET_BY_ID, async (_, id: string, includeCredentials?: boolean): Promise<Account | null> => {
    return storeManager.getAccountById(id, includeCredentials) || null
  })

  ipcMain.handle(IpcChannels.ACCOUNTS_GET_BY_PROVIDER, async (_, providerId: string): Promise<Account[]> => {
    return storeManager.getAccountsByProviderId(providerId)
  })

  ipcMain.handle(IpcChannels.ACCOUNTS_ADD, async (_, data: {
    providerId: string
    name: string
    email?: string
    credentials: Record<string, string>
    dailyLimit?: number
  }): Promise<Account> => {
    return AccountManager.create(data)
  })

  ipcMain.handle(IpcChannels.ACCOUNTS_UPDATE, async (_, id: string, updates: Partial<Account>): Promise<Account | null> => {
    return AccountManager.update(id, updates)
  })

  ipcMain.handle(IpcChannels.ACCOUNTS_DELETE, async (_, id: string): Promise<boolean> => {
    return AccountManager.delete(id)
  })

  ipcMain.handle(IpcChannels.ACCOUNTS_VALIDATE, async (_, accountId: string): Promise<boolean> => {
    const result = await AccountManager.validate(accountId)
    return result.valid
  })

  ipcMain.handle(IpcChannels.ACCOUNTS_VALIDATE_TOKEN, async (_, providerId: string, credentials: Record<string, string>) => {
    let provider = ProviderManager.getById(providerId)
    
    // If provider not in store, check builtin providers
    if (!provider) {
      const builtinConfig = getBuiltinProvider(providerId)
      if (builtinConfig) {
        provider = {
          id: builtinConfig.id,
          name: builtinConfig.name,
          type: 'builtin',
          authType: builtinConfig.authType,
          apiEndpoint: builtinConfig.apiEndpoint,
          headers: builtinConfig.headers,
          enabled: true,
          description: builtinConfig.description,
          supportedModels: builtinConfig.supportedModels || [],
          modelMappings: builtinConfig.modelMappings || {},
          createdAt: Date.now(),
          updatedAt: Date.now(),
        }
      }
    }
    
    if (!provider) {
      return { valid: false, error: 'Provider not found' }
    }
    
    const tempAccount: Account = {
      id: 'temp',
      providerId,
      name: 'temp',
      credentials,
      status: 'active',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }
    
    return ProviderChecker.checkAccountToken(provider, tempAccount)
  })

  ipcMain.handle(IpcChannels.ACCOUNTS_GET_CREDITS, async (_, accountId: string): Promise<{
    totalCredits: number
    usedCredits: number
    remainingCredits: number
  } | null> => {
    const account = AccountManager.getById(accountId, true)
    if (!account) {
      return null
    }
    
    const provider = ProviderManager.getById(account.providerId)
    if (!provider) {
      return null
    }

    if (provider.id !== 'minimax') {
      return null
    }

    try {
      const { MiniMaxAdapter } = await import('../proxy/adapters/minimax')
      const adapter = new MiniMaxAdapter(provider, account)
      return await adapter.getCredits()
    } catch (error) {
      console.error('[IPC] Failed to get credits:', error)
      return null
    }
  })

  ipcMain.handle(IpcChannels.ACCOUNTS_CLEAR_CHATS, async (_, accountId: string): Promise<{ success: boolean; error?: string }> => {
    try {
      const account = AccountManager.getById(accountId, true)
      if (!account) {
        return { success: false, error: 'Account not found' }
      }
      
      const provider = ProviderManager.getById(account.providerId)
      if (!provider) {
        return { success: false, error: 'Provider not found' }
      }

      // Support qwen-ai, minimax, zai, perplexity, deepseek, glm, and mimo providers
      if (provider.id === 'qwen-ai') {
        const { QwenAiAdapter } = await import('../proxy/adapters/qwen-ai')
        const adapter = new QwenAiAdapter(provider, account)
        const success = await adapter.deleteAllChats()
        return { success }
      } else if (provider.id === 'minimax') {
        const { MiniMaxAdapter } = await import('../proxy/adapters/minimax')
        const adapter = new MiniMaxAdapter(provider, account)
        const success = await adapter.deleteAllChats()
        return { success }
      } else if (provider.id === 'zai') {
        const { ZaiAdapter } = await import('../proxy/adapters/zai')
        const adapter = new ZaiAdapter(provider, account)
        const success = await adapter.deleteAllChats()
        return { success }
      } else if (provider.id === 'perplexity') {
        const { PerplexityAdapter } = await import('../proxy/adapters/perplexity')
        const adapter = new PerplexityAdapter(provider, account)
        const success = await adapter.deleteAllChats()
        return { success }
      } else if (provider.id === 'deepseek') {
        const { DeepSeekAdapter } = await import('../proxy/adapters/deepseek')
        const adapter = new DeepSeekAdapter(provider, account)
        const success = await adapter.deleteAllChats()
        return { success }
      } else if (provider.id === 'glm') {
        const { GLMAdapter } = await import('../proxy/adapters/glm')
        const adapter = new GLMAdapter(provider, account)
        const success = await adapter.deleteAllChats()
        return { success }
      } else if (provider.id === 'mimo') {
        const { MimoAdapter } = await import('../proxy/adapters/mimo')
        const adapter = new MimoAdapter(provider, account)
        const success = await adapter.deleteAllChats()
        return { success }
      } else {
        return { success: false, error: 'This feature is not available for this provider' }
      }
    } catch (error) {
      console.error('[IPC] Failed to clear chats:', error)
      return { 
        success: false, 
        error: error instanceof Error ? error.message : 'Failed to clear chats' 
      }
    }
  })

  ipcMain.handle(IpcChannels.OAUTH_START_LOGIN, async (_, providerId: string, providerType: ProviderVendor): Promise<OAuthResult> => {
    console.log('Starting OAuth login:', providerId, providerType)
    return await oauthManager.startLogin({
      providerId,
      providerType: providerType as ProviderType,
    })
  })

  ipcMain.handle(IpcChannels.OAUTH_CANCEL_LOGIN, async (): Promise<void> => {
    console.log('Cancel OAuth login')
    await oauthManager.cancelLogin()
  })

  ipcMain.handle(IpcChannels.OAUTH_LOGIN_WITH_TOKEN, async (_, data: { providerId: string, providerType: ProviderVendor, token: string, realUserID?: string, mimoUserId?: string, mimoPhToken?: string }): Promise<OAuthResult> => {
    return await oauthManager.loginWithToken(data.providerId, data.providerType as ProviderType, data.token, data.realUserID, data.mimoUserId, data.mimoPhToken)
  })

  ipcMain.handle(IpcChannels.OAUTH_START_IN_APP_LOGIN, async (_, data: { providerId: string, providerType: ProviderVendor, timeout?: number }): Promise<OAuthResult> => {
    console.log('Starting in-app OAuth login:', data.providerId, data.providerType)
    const config = storeManager.getConfig()
    const proxyMode = (config as any).oauthProxyMode || 'system'
    return await oauthManager.startInAppLogin(data.providerId, data.providerType as ProviderType, data.timeout, proxyMode)
  })

  ipcMain.handle(IpcChannels.OAUTH_CANCEL_IN_APP_LOGIN, async (): Promise<void> => {
    console.log('Cancel in-app OAuth login')
    oauthManager.cancelInAppLogin()
  })

  ipcMain.handle(IpcChannels.OAUTH_IN_APP_LOGIN_STATUS, async (): Promise<boolean> => {
    return oauthManager.isInAppLoginOpen()
  })

  ipcMain.handle(IpcChannels.OAUTH_VALIDATE_TOKEN, async (_, data: { providerId: string, providerType: ProviderVendor, credentials: Record<string, string> }) => {
    return await oauthManager.validateToken(data.providerId, data.providerType as ProviderType, data.credentials)
  })

  ipcMain.handle(IpcChannels.OAUTH_REFRESH_TOKEN, async (_, data: { providerId: string, providerType: ProviderVendor, credentials: Record<string, string> }) => {
    return await oauthManager.refreshToken(data.providerId, data.providerType as ProviderType, data.credentials)
  })

  ipcMain.handle(IpcChannels.OAUTH_GET_STATUS, async (): Promise<string> => {
    return oauthManager.getStatus()
  })

  ipcMain.handle(IpcChannels.LOGS_GET, async (_, filter?: {
    level?: LogLevel | 'all'
    keyword?: string
    startTime?: number
    endTime?: number
    limit?: number
    offset?: number
  }): Promise<LogEntry[]> => {
    const level = filter?.level === 'all' ? undefined : filter?.level
    return storeManager.getLogs(filter?.limit, level)
  })

  ipcMain.handle(IpcChannels.LOGS_GET_STATS, async () => {
    return storeManager.getLogStats()
  })

  ipcMain.handle(IpcChannels.LOGS_GET_TREND, async (_, days?: number) => {
    return storeManager.getLogTrend(days)
  })

  ipcMain.handle(IpcChannels.LOGS_GET_ACCOUNT_TREND, async (_, accountId: string, days?: number) => {
    return storeManager.getAccountLogTrend(accountId, days)
  })

  ipcMain.handle(IpcChannels.LOGS_CLEAR, async (): Promise<void> => {
    storeManager.clearLogs()
  })

  ipcMain.handle(IpcChannels.LOGS_EXPORT, async (_, format?: 'json' | 'txt'): Promise<string> => {
    return storeManager.exportLogs(format)
  })

  ipcMain.handle(IpcChannels.LOGS_GET_BY_ID, async (_, id: string): Promise<LogEntry | undefined> => {
    return storeManager.getLogById(id)
  })

  // ==================== Request Logs Handlers ====================

  ipcMain.handle(IpcChannels.REQUEST_LOGS_GET, async (_, filter?: {
    status?: 'success' | 'error'
    providerId?: string
    limit?: number
  }) => {
    return storeManager.getRequestLogs(filter?.limit, filter)
  })

  ipcMain.handle(IpcChannels.REQUEST_LOGS_GET_BY_ID, async (_, id: string) => {
    return storeManager.getRequestLogById(id)
  })

  ipcMain.handle(IpcChannels.REQUEST_LOGS_GET_STATS, async () => {
    return storeManager.getRequestLogStats()
  })

  ipcMain.handle(IpcChannels.REQUEST_LOGS_GET_TREND, async (_, days?: number) => {
    return storeManager.getRequestLogTrend(days)
  })

  ipcMain.handle(IpcChannels.REQUEST_LOGS_CLEAR, async (): Promise<void> => {
    storeManager.clearRequestLogs()
  })

  // ==================== Statistics Handlers ====================

  ipcMain.handle(IpcChannels.STATISTICS_GET, async () => {
    return storeManager.getStatistics()
  })

  ipcMain.handle(IpcChannels.STATISTICS_GET_TODAY, async () => {
    return storeManager.getTodayStatistics()
  })

  ipcMain.handle(IpcChannels.APP_GET_VERSION, async (): Promise<string> => {
    return app.getVersion()
  })

  ipcMain.handle(IpcChannels.APP_CHECK_UPDATE, async () => {
    try {
      const response = await axios.get('https://api.github.com/repos/xiaoY233/Chat2API/releases/latest', {
        headers: {
          'Accept': 'application/vnd.github.v3+json',
          'User-Agent': 'Chat2API-Manager',
        },
        timeout: 10000,
      })
      const data = response.data
      const latestVersion = data.tag_name?.replace(/^v/, '') || ''
      const releaseUrl = data.html_url || 'https://github.com/xiaoY233/Chat2API/releases'
      const currentVersion = app.getVersion()

      // Simple semver comparison
      const compareVersions = (v1: string, v2: string): number => {
        const parts1 = v1.split('.').map(Number)
        const parts2 = v2.split('.').map(Number)
        const maxLength = Math.max(parts1.length, parts2.length)
        for (let i = 0; i < maxLength; i++) {
          const p1 = parts1[i] || 0
          const p2 = parts2[i] || 0
          if (p1 > p2) return 1
          if (p1 < p2) return -1
        }
        return 0
      }

      const hasUpdate = latestVersion && compareVersions(latestVersion, currentVersion) > 0

      return {
        hasUpdate,
        currentVersion,
        latestVersion,
        releaseUrl,
      }
    } catch (error) {
      console.error('[App] Check update error:', error)
      return {
        hasUpdate: false,
        currentVersion: app.getVersion(),
        latestVersion: app.getVersion(),
        error: error instanceof Error ? error.message : String(error),
      }
    }
  })

  ipcMain.handle(IpcChannels.APP_DOWNLOAD_UPDATE, async (): Promise<void> => {
    await updaterManager.downloadUpdate()
  })

  ipcMain.handle(IpcChannels.APP_INSTALL_UPDATE, async (): Promise<void> => {
    updaterManager.quitAndInstall()
  })

  ipcMain.handle(IpcChannels.APP_GET_UPDATE_STATUS, async () => {
    return updaterManager.getStatus()
  })

  ipcMain.handle(IpcChannels.APP_MINIMIZE, async (): Promise<void> => {
    mainWindow?.minimize()
  })

  ipcMain.handle(IpcChannels.APP_MAXIMIZE, async (): Promise<void> => {
    if (mainWindow?.isMaximized()) {
      mainWindow.unmaximize()
    } else {
      mainWindow?.maximize()
    }
  })

  ipcMain.handle(IpcChannels.APP_CLOSE, async (): Promise<void> => {
    const config = storeManager.getConfig()
    if (config.minimizeToTray) {
      mainWindow?.hide()
    } else {
      app.isQuitting = true
      mainWindow?.close()
    }
  })

  ipcMain.handle(IpcChannels.APP_SHOW_WINDOW, async (): Promise<void> => {
    mainWindow?.show()
    mainWindow?.focus()
  })

  ipcMain.handle(IpcChannels.APP_HIDE_WINDOW, async (): Promise<void> => {
    mainWindow?.hide()
  })

  ipcMain.handle(IpcChannels.APP_OPEN_EXTERNAL, async (_, url: string): Promise<void> => {
    console.log('[APP_OPEN_EXTERNAL] Opening URL:', url)
    try {
      await shell.openExternal(url)
      console.log('[APP_OPEN_EXTERNAL] Successfully opened')
    } catch (error) {
      console.error('[APP_OPEN_EXTERNAL] Error:', error)
      throw error
    }
  })

  // ==================== System Prompts Handlers ====================

  ipcMain.handle(IpcChannels.PROMPTS_GET_ALL, async (): Promise<SystemPrompt[]> => {
    return storeManager.getSystemPrompts()
  })

  ipcMain.handle(IpcChannels.PROMPTS_GET_BUILTIN, async (): Promise<SystemPrompt[]> => {
    return storeManager.getBuiltinPrompts()
  })

  ipcMain.handle(IpcChannels.PROMPTS_GET_CUSTOM, async (): Promise<SystemPrompt[]> => {
    return storeManager.getCustomPrompts()
  })

  ipcMain.handle(IpcChannels.PROMPTS_GET_BY_ID, async (_, id: string): Promise<SystemPrompt | undefined> => {
    return storeManager.getSystemPromptById(id)
  })

  ipcMain.handle(IpcChannels.PROMPTS_ADD, async (_, prompt: Omit<SystemPrompt, 'id' | 'createdAt' | 'updatedAt'>): Promise<SystemPrompt> => {
    return storeManager.addSystemPrompt(prompt)
  })

  ipcMain.handle(IpcChannels.PROMPTS_UPDATE, async (_, id: string, updates: Partial<SystemPrompt>): Promise<SystemPrompt | null> => {
    return storeManager.updateSystemPrompt(id, updates)
  })

  ipcMain.handle(IpcChannels.PROMPTS_DELETE, async (_, id: string): Promise<boolean> => {
    return storeManager.deleteSystemPrompt(id)
  })

  ipcMain.handle(IpcChannels.PROMPTS_GET_BY_TYPE, async (_, type: SystemPrompt['type']): Promise<SystemPrompt[]> => {
    return storeManager.getSystemPromptsByType(type)
  })

  // ==================== Session Management Handlers ====================

  ipcMain.handle(IpcChannels.SESSION_GET_CONFIG, async (): Promise<SessionConfig> => {
    return sessionManager.getSessionConfig()
  })

  ipcMain.handle(IpcChannels.SESSION_UPDATE_CONFIG, async (_, updates: Partial<SessionConfig>): Promise<SessionConfig> => {
    return sessionManager.updateSessionConfig(updates)
  })

  ipcMain.handle(IpcChannels.SESSION_GET_ALL, async (): Promise<SessionRecord[]> => {
    return sessionManager.getAllSessions()
  })

  ipcMain.handle(IpcChannels.SESSION_GET_ACTIVE, async (): Promise<SessionRecord[]> => {
    return sessionManager.getAllActiveSessions()
  })

  ipcMain.handle(IpcChannels.SESSION_GET_BY_ID, async (_, id: string): Promise<SessionRecord | undefined> => {
    return sessionManager.getSession(id)
  })

  ipcMain.handle(IpcChannels.SESSION_GET_BY_ACCOUNT, async (_, accountId: string): Promise<SessionRecord[]> => {
    return sessionManager.getSessionsByAccount(accountId)
  })

  ipcMain.handle(IpcChannels.SESSION_GET_BY_PROVIDER, async (_, providerId: string): Promise<SessionRecord[]> => {
    return sessionManager.getSessionsByProvider(providerId)
  })

  ipcMain.handle(IpcChannels.SESSION_DELETE, async (_, id: string): Promise<boolean> => {
    return sessionManager.deleteSession(id)
  })

  ipcMain.handle(IpcChannels.SESSION_CLEAR_ALL, async (): Promise<void> => {
    return sessionManager.clearAllSessions()
  })

  ipcMain.handle(IpcChannels.SESSION_CLEAN_EXPIRED, async (): Promise<number> => {
    return sessionManager.cleanExpiredSessions()
  })

  // ==================== Management API Handlers ====================

  ipcMain.handle(IpcChannels.MANAGEMENT_API_GET_CONFIG, async (): Promise<ManagementApiConfig> => {
    const config = ConfigManager.get()
    return config.managementApi
  })

  ipcMain.handle(IpcChannels.MANAGEMENT_API_UPDATE_CONFIG, async (_, updates: Partial<ManagementApiConfig>): Promise<ManagementApiConfig> => {
    const config = ConfigManager.get()
    const currentManagementConfig = config.managementApi
    const newManagementConfig = { ...currentManagementConfig, ...updates }
    
    ConfigManager.update({ managementApi: newManagementConfig })
    
    return newManagementConfig
  })

  ipcMain.handle(IpcChannels.MANAGEMENT_API_GENERATE_SECRET, async (): Promise<string> => {
    const newSecret = generateManagementSecret()
    
    const config = ConfigManager.get()
    const newManagementConfig = { ...config.managementApi, managementApiSecret: newSecret }
    ConfigManager.update({ managementApi: newManagementConfig })
    
    return newSecret
  })

  // ==================== Context Management Handlers ====================

  ipcMain.handle(IpcChannels.CONTEXT_MANAGEMENT_GET_CONFIG, async () => {
    const config = ConfigManager.get()
    return config.contextManagement || {
      enabled: true,
      strategies: {
        slidingWindow: { enabled: true, maxMessages: 20 },
        tokenLimit: { enabled: false, maxTokens: 4000 },
        summary: { enabled: false, keepRecentMessages: 20 },
      },
      executionOrder: ['slidingWindow', 'tokenLimit', 'summary'],
    }
  })

  ipcMain.handle(IpcChannels.CONTEXT_MANAGEMENT_UPDATE_CONFIG, async (_, updates: Partial<any>) => {
    const config = ConfigManager.get()
    const defaultContextConfig = {
      enabled: true,
      strategies: {
        slidingWindow: { enabled: true, maxMessages: 20 },
        tokenLimit: { enabled: false, maxTokens: 4000 },
        summary: { enabled: false, keepRecentMessages: 20 },
      },
      executionOrder: ['slidingWindow', 'tokenLimit', 'summary'],
    }
    const currentContextConfig = config.contextManagement || defaultContextConfig
    const newContextConfig = {
      ...currentContextConfig,
      ...updates,
      strategies: {
        ...currentContextConfig.strategies,
        ...(updates.strategies || {}),
      },
    }
    
    ConfigManager.update({ contextManagement: newContextConfig })
    
    return newContextConfig
  })
  
  oauthManager.on('progress', (event) => {
    mainWindow?.webContents.send(IpcChannels.OAUTH_PROGRESS, event)
  })
}

export function getProxyStatus(): ProxyStatus {
  const isRunning = proxyServer !== null
  const port = proxyStatusManager.getPort()
  return {
    isRunning,
    port,
    uptime: proxyStartTime && isRunning ? Date.now() - proxyStartTime : 0,
    connections: proxyStatusManager.getStatistics().activeConnections,
  }
}

export function setProxyStatus(status: ProxyStatus): void {
  // Status is managed by proxyServer instance, only update startTime here
  if (status.isRunning && !proxyStartTime) {
    proxyStartTime = Date.now()
  } else if (!status.isRunning) {
    proxyStartTime = null
  }
}

function registerErrorRecoveryHandlers(mainWindow: BrowserWindow | null): void {
  ipcMain.handle(IpcChannels.STORE_RETRY_INIT, async (): Promise<{ success: boolean; error?: string }> => {
    try {
      await storeManager.initialize()
      if (!storeManager.hasInitializationError()) {
        mainWindow?.webContents.send(IpcChannels.STORE_INIT_ERROR, { message: null })
        return { success: true }
      }
      return { 
        success: false, 
        error: storeManager.getInitializationError()?.message || 'Unknown error' 
      }
    } catch (error) {
      return { 
        success: false, 
        error: error instanceof Error ? error.message : 'Failed to initialize storage' 
      }
    }
  })

  ipcMain.handle(IpcChannels.APP_GET_VERSION, async (): Promise<string> => {
    return app.getVersion()
  })

  ipcMain.handle(IpcChannels.APP_CLOSE, async (): Promise<void> => {
    app.isQuitting = true
    mainWindow?.close()
  })
}
