/**
 * OAuth Adapter Base Class
 * Defines common interface and base implementation for all provider authentication adapters
 */

import { BrowserWindow, shell } from 'electron'
import http from 'http'
import crypto from 'crypto'
import {
  ProviderType,
  AuthMethod,
  OAuthResult,
  OAuthOptions,
  OAuthCallbackData,
  TokenValidationResult,
  CredentialInfo,
  AdapterConfig,
  OAuthProgressEvent,
} from './types'

/**
 * OAuth adapter abstract base class
 */
export abstract class BaseOAuthAdapter {
  protected config: AdapterConfig
  protected callbackServer: http.Server | null = null
  protected callbackPort: number
  protected state: string = ''
  protected mainWindow: BrowserWindow | null = null
  protected progressCallback: ((event: OAuthProgressEvent) => void) | null = null

  constructor(config: AdapterConfig) {
    this.config = config
    this.callbackPort = config.callbackPort || 8311
  }

  /**
   * Get provider type
   */
  getProviderType(): ProviderType {
    return this.config.providerType
  }

  /**
   * Get supported authentication methods
   */
  getSupportedAuthMethods(): AuthMethod[] {
    return this.config.authMethods
  }

  /**
   * Set main window reference
   */
  setMainWindow(window: BrowserWindow): void {
    this.mainWindow = window
  }

  /**
   * Set progress callback
   */
  setProgressCallback(callback: (event: OAuthProgressEvent) => void): void {
    this.progressCallback = callback
  }

  /**
   * Emit progress event
   */
  protected emitProgress(status: OAuthProgressEvent['status'], message: string, data?: Record<string, unknown>): void {
    if (this.progressCallback) {
      this.progressCallback({ status, message, data })
    }
  }

  /**
   * Generate random state string
   */
  protected generateState(): string {
    this.state = crypto.randomBytes(16).toString('hex')
    return this.state
  }

  /**
   * Validate state string
   */
  protected validateState(state: string): boolean {
    return state === this.state
  }

  /**
   * Create local callback server
   */
  protected async createCallbackServer(): Promise<number> {
    return new Promise((resolve, reject) => {
      this.callbackServer = http.createServer((req, res) => {
        this.handleCallback(req, res)
      })

      this.callbackServer.listen(this.callbackPort, () => {
        resolve(this.callbackPort)
      })

      this.callbackServer.on('error', (error: NodeJS.ErrnoException) => {
        if (error.code === 'EADDRINUSE') {
          this.callbackPort++
          this.callbackServer?.listen(this.callbackPort)
        } else {
          reject(error)
        }
      })
    })
  }

  /**
   * Close callback server
   */
  protected closeCallbackServer(): void {
    if (this.callbackServer) {
      this.callbackServer.close()
      this.callbackServer = null
    }
  }

  /**
   * Handle OAuth callback
   */
  protected handleCallback(req: http.IncomingMessage, res: http.ServerResponse): void {
    const url = new URL(req.url || '/', `http://localhost:${this.callbackPort}`)
    const data: OAuthCallbackData = {
      code: url.searchParams.get('code') || undefined,
      token: url.searchParams.get('token') || undefined,
      state: url.searchParams.get('state') || undefined,
      error: url.searchParams.get('error') || undefined,
      errorDescription: url.searchParams.get('error_description') || undefined,
    }

    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    res.end(`
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="utf-8">
        <title>OAuth Callback</title>
        <style>
          body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            display: flex;
            justify-content: center;
            align-items: center;
            height: 100vh;
            margin: 0;
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            color: white;
          }
          .container {
            text-align: center;
            padding: 40px;
            background: rgba(255,255,255,0.1);
            border-radius: 16px;
            backdrop-filter: blur(10px);
          }
          .success { color: #4ade80; }
          .error { color: #f87171; }
        </style>
      </head>
      <body>
        <div class="container">
          ${data.error 
            ? `<h1 class="error">❌ Login Failed</h1><p>${data.errorDescription || data.error}</p>`
            : `<h1 class="success">✅ Login Successful</h1><p>Processing, please wait...</p>`
          }
          <p style="font-size: 12px; opacity: 0.7;">This window can be closed</p>
        </div>
        <script>
          if (window.electronAPI) {
            window.electronAPI.send('oauth:callback', ${JSON.stringify(data)});
          }
          setTimeout(() => window.close(), 2000);
        </script>
      </body>
      </html>
    `)

    this.processCallback(data)
  }

  /**
   * Open URL in system browser
   */
  protected async openBrowser(url: string): Promise<void> {
    await shell.openExternal(url)
  }

  /**
   * Start OAuth login flow
   */
  async startLogin(options: OAuthOptions): Promise<OAuthResult> {
    throw new Error('Subclass must implement startLogin method')
  }

  /**
   * Cancel login flow
   */
  async cancelLogin(): Promise<void> {
    this.closeCallbackServer()
    this.emitProgress('cancelled', 'Login cancelled')
  }

  /**
   * Process callback data
   */
  protected async processCallback(data: OAuthCallbackData): Promise<void> {
    throw new Error('Subclass must implement processCallback method')
  }

  /**
   * Validate token validity
   */
  async validateToken(credentials: Record<string, string>): Promise<TokenValidationResult> {
    throw new Error('Subclass must implement validateToken method')
  }

  /**
   * Refresh token
   */
  async refreshToken(credentials: Record<string, string>): Promise<CredentialInfo | null> {
    throw new Error('Subclass must implement refreshToken method')
  }

  /**
   * Get login URL
   */
  protected getLoginUrl(): string {
    return this.config.loginUrl || ''
  }

  /**
   * Get API URL
   */
  protected getApiUrl(): string {
    return this.config.apiUrl || ''
  }

  /**
   * Generate UUID
   */
  protected generateUUID(): string {
    return crypto.randomUUID()
  }

  /**
   * Generate MD5 hash
   */
  protected md5(input: string): string {
    return crypto.createHash('md5').update(input).digest('hex')
  }

  /**
   * Get current timestamp (seconds)
   */
  protected getTimestamp(): number {
    return Math.floor(Date.now() / 1000)
  }

  /**
   * Get current timestamp (milliseconds)
   */
  protected getTimestampMs(): number {
    return Date.now()
  }

  /**
   * Parse JWT token
   */
  protected parseJWT(token: string): Record<string, unknown> | null {
    try {
      const parts = token.split('.')
      if (parts.length !== 3) return null
      
      const payload = Buffer.from(parts[1], 'base64').toString('utf-8')
      return JSON.parse(payload)
    } catch {
      return null
    }
  }

  /**
   * Check if it is a JWT token
   */
  protected isJWT(token: string): boolean {
    return token.startsWith('eyJ') && token.split('.').length === 3
  }

  /**
   * Clean up resources
   */
  destroy(): void {
    this.closeCallbackServer()
    this.mainWindow = null
    this.progressCallback = null
  }
}

export default BaseOAuthAdapter
