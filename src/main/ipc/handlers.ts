import { ipcMain, app, BrowserWindow, shell } from 'electron'
import { IpcChannels } from './channels'
import { storeManager } from '../store/store'
import { ProviderManager } from '../store/providers'
import { AccountManager } from '../store/accounts'
import { ProviderChecker } from '../providers/checker'
import { CustomProviderManager } from '../providers/custom'
import { getBuiltinProviders } from '../providers/builtin'
import { oauthManager } from '../oauth/manager'
import { ProxyServer } from '../proxy/server'
import { proxyStatusManager } from '../proxy/status'
import type { Provider, Account, ProxyStatus, ProviderCheckResult, OAuthResult, AuthType, CredentialField, LogLevel, LogEntry, ProviderVendor, AppConfig } from '../../shared/types'
import type { SystemPrompt } from '../store/types'

let proxyServer: ProxyServer | null = null
let proxyStartTime: number | null = null

export async function registerIpcHandlers(mainWindow: BrowserWindow | null): Promise<void> {
  await storeManager.initialize()
  
  storeManager.setMainWindow(mainWindow)
  
  if (mainWindow) {
    oauthManager.setMainWindow(mainWindow)
  }

  // Check if auto-start proxy is needed
  const config = storeManager.getConfig()
  if (config.autoStartProxy) {
    console.log('[App] Auto-starting proxy service...')
    const proxyPort = config.proxyPort
    try {
      proxyServer = new ProxyServer()
      const success = await proxyServer.start(proxyPort)
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

      proxyServer = new ProxyServer()
      const success = await proxyServer.start(proxyPort)
      
      if (success) {
        proxyStartTime = Date.now()
        const status: ProxyStatus = {
          isRunning: true,
          port: proxyPort,
          uptime: 0,
          connections: 0,
        }
        mainWindow?.webContents.send(IpcChannels.PROXY_STATUS_CHANGED, status)
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
    const currentConfig = storeManager.getConfig()
    const newConfig = { ...currentConfig, ...updates }
    storeManager.setConfig(newConfig)
    return true
  })

  ipcMain.handle(IpcChannels.STORE_GET, async (_, key: string): Promise<unknown> => {
    const store = storeManager.getStore()
    return store?.get(key)
  })

  ipcMain.handle(IpcChannels.STORE_SET, async (_, key: string, value: unknown): Promise<void> => {
    const store = storeManager.getStore()
    store?.set(key as 'providers' | 'accounts' | 'config' | 'logs', value as never)
  })

  ipcMain.handle(IpcChannels.STORE_DELETE, async (_, key: string): Promise<void> => {
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
    const provider = ProviderManager.getById(providerId)
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
    const account = AccountManager.getById(accountId)
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

  ipcMain.handle(IpcChannels.OAUTH_START_LOGIN, async (_, providerId: string, providerType: ProviderVendor): Promise<OAuthResult> => {
    console.log('Starting OAuth login:', providerId, providerType)
    return await oauthManager.startLogin({
      providerId,
      providerType,
    })
  })

  ipcMain.handle(IpcChannels.OAUTH_CANCEL_LOGIN, async (): Promise<void> => {
    console.log('Cancel OAuth login')
    await oauthManager.cancelLogin()
  })

  ipcMain.handle(IpcChannels.OAUTH_LOGIN_WITH_TOKEN, async (_, data: { providerId: string, providerType: ProviderVendor, token: string, realUserID?: string }): Promise<OAuthResult> => {
    return await oauthManager.loginWithToken(data.providerId, data.providerType, data.token, data.realUserID)
  })

  ipcMain.handle(IpcChannels.OAUTH_START_IN_APP_LOGIN, async (_, data: { providerId: string, providerType: ProviderVendor, timeout?: number }): Promise<OAuthResult> => {
    console.log('Starting in-app OAuth login:', data.providerId, data.providerType)
    const config = storeManager.getConfig()
    const proxyMode = (config as any).oauthProxyMode || 'system'
    return await oauthManager.startInAppLogin(data.providerId, data.providerType, data.timeout, proxyMode)
  })

  ipcMain.handle(IpcChannels.OAUTH_CANCEL_IN_APP_LOGIN, async (): Promise<void> => {
    console.log('Cancel in-app OAuth login')
    oauthManager.cancelInAppLogin()
  })

  ipcMain.handle(IpcChannels.OAUTH_IN_APP_LOGIN_STATUS, async (): Promise<boolean> => {
    return oauthManager.isInAppLoginOpen()
  })

  ipcMain.handle(IpcChannels.OAUTH_VALIDATE_TOKEN, async (_, data: { providerId: string, providerType: ProviderVendor, credentials: Record<string, string> }) => {
    return await oauthManager.validateToken(data.providerId, data.providerType, data.credentials)
  })

  ipcMain.handle(IpcChannels.OAUTH_REFRESH_TOKEN, async (_, data: { providerId: string, providerType: ProviderVendor, credentials: Record<string, string> }) => {
    return await oauthManager.refreshToken(data.providerId, data.providerType, data.credentials)
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

  ipcMain.handle(IpcChannels.APP_GET_VERSION, async (): Promise<string> => {
    return app.getVersion()
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
