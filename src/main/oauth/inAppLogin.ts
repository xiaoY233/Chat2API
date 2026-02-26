/**
 * In-App Login Manager
 * Manages in-app browser window for OAuth login and token extraction
 */

import { BrowserWindow, session, Session } from 'electron'
import { EventEmitter } from 'events'
import { ProviderType } from './types'
import { TokenExtractionConfig, getTokenExtractionConfig, TokenSource } from './tokenExtractionConfig'

export interface InAppLoginResult {
  success: boolean
  credentials?: Record<string, string>
  error?: string
}

export interface TokenFoundEvent {
  key: string
  value: string
}

export interface InAppLoginOptions {
  providerId: string
  providerType: ProviderType
  timeout?: number
  proxyMode?: 'system' | 'none'
}

const DEFAULT_TIMEOUT = 300000 // 5 minutes
const MIN_LOGIN_TIME = 5000 // Minimum time before checking tokens (5 seconds)

export class InAppLoginManager extends EventEmitter {
  private loginWindow: BrowserWindow | null = null
  private loginSession: Session | null = null
  private foundTokens: Map<string, string> = new Map()
  private config: TokenExtractionConfig | null = null
  private isCompleted: boolean = false
  private timeoutId: NodeJS.Timeout | null = null
  private resolvePromise: ((result: InAppLoginResult) => void) | null = null
  private loginStartTime: number = 0
  private lastTokenCheckTime: number = 0
  private options: InAppLoginOptions | null = null

  constructor() {
    super()
  }

  async startLogin(options: InAppLoginOptions): Promise<InAppLoginResult> {
    if (this.loginWindow) {
      return {
        success: false,
        error: 'A login window is already open',
      }
    }

    this.config = getTokenExtractionConfig(options.providerType)
    if (!this.config) {
      return {
        success: false,
        error: `No token extraction config found for provider: ${options.providerType}`,
      }
    }

    this.foundTokens.clear()
    this.isCompleted = false
    this.loginStartTime = Date.now()
    this.lastTokenCheckTime = 0
    this.options = options

    return new Promise((resolve) => {
      this.resolvePromise = resolve

      this.timeoutId = setTimeout(() => {
        this.complete({
          success: false,
          error: 'Login timeout',
        })
      }, options.timeout || DEFAULT_TIMEOUT)

      this.emit('status', { status: 'starting', message: 'Opening login window...' })

      this.createLoginWindow()
      this.setupTokenInterception()
    })
  }

  private createLoginWindow(): void {
    if (!this.config) return

    const partition = `persist:oauth-${Date.now()}`
    this.loginSession = session.fromPartition(partition)

    if (this.options?.proxyMode === 'none') {
      this.loginSession.setProxy({ mode: 'direct' }).catch((error) => {
        console.error('[InAppLogin] Failed to set direct proxy:', error)
      })
    }

    this.loginWindow = new BrowserWindow({
      width: 500,
      height: 700,
      show: false,
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        partition,
        webSecurity: true,
        javascript: true,
      },
      title: this.config.windowTitle || 'Login',
      autoHideMenuBar: true,
    })

    this.loginWindow.once('ready-to-show', () => {
      this.loginWindow?.show()
      this.emit('status', { status: 'ready', message: 'Login window ready - please log in' })
    })

    this.loginWindow.on('closed', () => {
      if (!this.isCompleted) {
        this.complete({
          success: false,
          error: 'Login window was closed',
        })
      }
    })

    this.loginWindow.loadURL(this.config.loginUrl).catch((error) => {
      this.complete({
        success: false,
        error: `Failed to load login page: ${error.message}`,
      })
    })
  }

  private setupTokenInterception(): void {
    if (!this.loginSession || !this.config) return

    this.loginSession.webRequest.onBeforeSendHeaders((details, callback) => {
      if (this.isCompleted) {
        callback({ requestHeaders: details.requestHeaders })
        return
      }

      if (!this.hasMinTimePassed()) {
        callback({ requestHeaders: details.requestHeaders })
        return
      }

      const authHeader = details.requestHeaders['Authorization'] || details.requestHeaders['authorization']
      if (authHeader) {
        for (const source of this.config!.tokenSources) {
          if (source.type === 'networkHeader') {
            let token = authHeader
            if (source.extractPattern) {
              const match = authHeader.match(new RegExp(source.extractPattern))
              if (match && match[1]) {
                token = match[1]
              }
            } else if (authHeader.startsWith('Bearer ')) {
              token = authHeader.substring(7)
            }
            if (this.isValidToken(token)) {
              this.emit('tokenFound', { key: source.key, value: token })
            }
          }
        }
      }

      callback({ requestHeaders: details.requestHeaders })
    })

    this.loginSession.cookies.on('changed', async (_event, cookie, _cause, removed) => {
      if (this.isCompleted || removed) return

      console.log('[InAppLogin] Cookie changed:', { name: cookie.name, value: cookie.value ? cookie.value.substring(0, 50) + '...' : 'null', removed })

      if (!this.hasMinTimePassed()) {
        console.log('[InAppLogin] Min time not passed, skipping cookie check')
        return
      }

      for (const source of this.config!.tokenSources) {
        if (source.type === 'cookie' && cookie.name === source.key) {
          console.log('[InAppLogin] Cookie matches source key:', source.key)
          if (this.isValidToken(cookie.value)) {
            console.log('[InAppLogin] Cookie token is valid, emitting tokenFound')
            this.emit('tokenFound', { key: source.key, value: cookie.value })
          } else {
            console.log('[InAppLogin] Cookie token is invalid:', cookie.value ? cookie.value.substring(0, 50) : 'null')
          }
        }
      }

      console.log('[InAppLogin] Checking all cookies after change')
      await this.checkForTokens()
    })

    this.loginWindow?.webContents.on('did-finish-load', () => {
      console.log('[InAppLogin] Page finished loading, starting token checks')
      this.delayedTokenCheck()
    })

    this.loginWindow?.webContents.on('did-navigate-in-page', () => {
      console.log('[InAppLogin] Page navigated, starting delayed token check')
      this.delayedTokenCheck()
    })
  }

  private hasMinTimePassed(): boolean {
    return Date.now() - this.loginStartTime >= MIN_LOGIN_TIME
  }

  private delayedTokenCheck(): void {
    const now = Date.now()
    if (now - this.lastTokenCheckTime < 2000) return
    this.lastTokenCheckTime = now

    setTimeout(() => {
      if (this.isCompleted) return
      if (!this.loginWindow || this.loginWindow.isDestroyed()) return
      if (this.loginWindow.webContents.isDestroyed()) return
      if (this.hasMinTimePassed()) {
        this.checkForTokens()
      }
    }, 1000)
  }

  private isValidToken(value: string): boolean {
    console.log('[InAppLogin] Checking token validity:', value.length, value.substring(0, 20))
    
    if (!value || value.length < 20) {
      console.log('[InAppLogin] Token rejected: too short or empty')
      return false
    }
    
    if (value.startsWith('eyJ') && value.split('.').length === 3) {
      try {
        const parts = value.split('.')
        if (parts.length === 3) {
          const payload = JSON.parse(Buffer.from(parts[1], 'base64').toString())
          console.log('[InAppLogin] JWT payload:', payload)
          
          // Reject guest accounts
          if (payload.email && payload.email.includes('@guest.com')) {
            console.log('[InAppLogin] Token rejected: guest account')
            return false
          }
          
          if (payload && (payload.app_id || payload.sub || payload.exp || payload.id || payload.user_id || payload.uid || payload.email)) {
            console.log('[InAppLogin] Token accepted as valid JWT')
            return true
          }
        }
      } catch {
        console.log('[InAppLogin] Token rejected: invalid JWT')
        return false
      }
    }
    
    // Accept long tokens (>= 64 chars) - includes base64 chars like / + and *
    if (value.length >= 64 && /^[a-zA-Z0-9_\-+/*]+$/.test(value)) {
      console.log('[InAppLogin] Token accepted as long token')
      return true
    }
    
    // Accept medium tokens (32-63 chars) - includes base64 chars and *
    if (value.length >= 32 && value.length < 64 && /^[a-zA-Z0-9_\-+/*]+$/.test(value)) {
      console.log('[InAppLogin] Token accepted as medium token')
      return true
    }
    
    console.log('[InAppLogin] Token rejected: does not match any pattern')
    return false
  }

  private async checkForTokens(): Promise<void> {
    if (!this.loginWindow || this.isCompleted || !this.config) return

    if (this.loginWindow.isDestroyed()) {
      console.log('[InAppLogin] Window is destroyed, skipping token check')
      return
    }

    const webContents = this.loginWindow.webContents
    if (webContents.isDestroyed()) {
      console.log('[InAppLogin] webContents is destroyed, skipping token check')
      return
    }

    const localStorageSources = this.config.tokenSources.filter((s) => s.type === 'localStorage')
    const cookieSources = this.config.tokenSources.filter((s) => s.type === 'cookie')

    if (localStorageSources.length === 0 && cookieSources.length === 0) return

    console.log('[InAppLogin] Checking tokens, localStorage:', localStorageSources.map(s => s.key), 'cookies:', cookieSources.map(s => s.key))

    try {
      for (const source of localStorageSources) {
        if (webContents.isDestroyed() || this.isCompleted) {
          console.log('[InAppLogin] webContents destroyed or login completed, stopping token check')
          return
        }
        const script = `
          (function() {
            try {
              const value = localStorage.getItem('${source.key}');
              console.log('[InAppLogin] localStorage.getItem("${source.key}"):', value);
              return value || null;
            } catch (e) {
              console.error('[InAppLogin] Error reading localStorage:', e);
              return null;
            }
          })()
        `
        const value = await webContents.executeJavaScript(script)
        console.log('[InAppLogin] Got value from localStorage:', source.key, value ? value.substring(0, 50) + '...' : 'null')

        // Handle user_detail_agent specially - it's a JSON object containing user info
        if (source.key === 'user_detail_agent' && value) {
          try {
            const parsed = JSON.parse(value)
            // Use realUserID field if available, fallback to id field
            const realUserID = parsed.realUserID || parsed.id
            if (realUserID) {
              console.log('[InAppLogin] Found realUserID from user_detail_agent:', realUserID)
              this.emit('tokenFound', { key: 'realUserID', value: String(realUserID) })
            }
          } catch (e) {
            console.error('[InAppLogin] Error parsing user_detail_agent:', e)
          }
          continue
        }

        let tokenValue = value
        if (value && value.startsWith('{') && value.endsWith('}')) {
          try {
            const parsed = JSON.parse(value)
            if (parsed.value) {
              tokenValue = parsed.value
              console.log('[InAppLogin] Extracted token from JSON:', tokenValue.substring(0, 50) + '...')
            }
          } catch (e) {
            console.error('[InAppLogin] Error parsing JSON token:', e)
          }
        }

        if (tokenValue && typeof tokenValue === 'string' && this.isValidToken(tokenValue)) {
          console.log('[InAppLogin] Token found and valid from localStorage:', source.key)
          // Map _token to token for consistency
          const emitKey = source.key === '_token' ? 'token' : source.key
          this.emit('tokenFound', { key: emitKey, value: tokenValue })
        }
      }

      for (const source of cookieSources) {
        if (!this.loginSession) continue

        const cookies = await this.loginSession.cookies.get({})
        console.log('[InAppLogin] All cookies:', cookies.map(c => c.name))

        const cookie = cookies.find(c => c.name === source.key)
        if (cookie) {
          console.log('[InAppLogin] Found cookie:', source.key, cookie.value ? cookie.value.substring(0, 50) + '...' : 'null')

          if (cookie.value && this.isValidToken(cookie.value)) {
            console.log('[InAppLogin] Token found and valid from cookie:', source.key)
            this.emit('tokenFound', { key: source.key, value: cookie.value })
          } else {
            console.log('[InAppLogin] Cookie token is invalid:', source.key, cookie.value ? cookie.value.substring(0, 50) : 'null')
          }
        } else {
          console.log('[InAppLogin] Cookie not found:', source.key)
        }
      }
    } catch (error) {
      console.error('[InAppLogin] Error in checkForTokens:', error)
    }
  }

  completeWithSuccess(credentials: Record<string, string>): void {
    this.complete({
      success: true,
      credentials,
    })
  }

  private complete(result: InAppLoginResult): void {
    if (this.isCompleted) return
    this.isCompleted = true

    if (this.timeoutId) {
      clearTimeout(this.timeoutId)
      this.timeoutId = null
    }

    if (this.loginWindow && !this.loginWindow.isDestroyed()) {
      this.loginWindow.close()
    }

    this.cleanup()

    if (this.resolvePromise) {
      this.resolvePromise(result)
      this.resolvePromise = null
    }

    this.emit('complete', result)
  }

  private cleanup(): void {
    if (this.loginSession) {
      try {
        this.loginSession.webRequest.onBeforeSendHeaders(() => {})
        this.loginSession.cookies.removeAllListeners()
      } catch (error) {
        console.error('[InAppLogin] Error cleaning up session:', error)
      }
      this.loginSession = null
    }

    this.loginWindow = null
    this.config = null
  }

  cancel(): void {
    if (!this.isCompleted) {
      this.complete({
        success: false,
        error: 'Login cancelled by user',
      })
    }
  }

  isWindowOpen(): boolean {
    return this.loginWindow !== null && !this.loginWindow.isDestroyed()
  }

  destroy(): void {
    this.cancel()
    this.removeAllListeners()
  }
}

export const inAppLoginManager = new InAppLoginManager()

export default InAppLoginManager
