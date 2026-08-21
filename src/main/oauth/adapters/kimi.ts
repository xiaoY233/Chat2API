/**
 * Kimi Authentication Adapter
 * Login using default browser, manually extract token
 */

import axios from 'axios'
import { BaseOAuthAdapter } from './base'
import { getRuntime } from '../../runtime'
import {
  OAuthResult,
  OAuthOptions,
  TokenValidationResult,
  CredentialInfo,
  AdapterConfig,
  OAuthCallbackData,
} from '../types'

const KIMI_API_BASE = 'https://www.kimi.com'

const FAKE_HEADERS = {
  Accept: '*/*',
  'Accept-Encoding': 'gzip, deflate, br, zstd',
  'Accept-Language': 'zh-CN,zh;q=0.9,en-US;q=0.8,en;q=0.7',
  'Cache-Control': 'no-cache',
  Pragma: 'no-cache',
  Origin: KIMI_API_BASE,
  'R-Timezone': 'Asia/Shanghai',
  'Sec-Ch-Ua': '"Google Chrome";v="131", "Chromium";v="131", "Not_A Brand";v="24"',
  'Sec-Ch-Ua-Mobile': '?0',
  'Sec-Ch-Ua-Platform': '"Windows"',
  'Sec-Fetch-Dest': 'empty',
  'Sec-Fetch-Mode': 'cors',
  'Sec-Fetch-Site': 'same-origin',
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  Priority: 'u=1, i',
  'X-Msh-Platform': 'web',
}

export class KimiAdapter extends BaseOAuthAdapter {
  private deviceId: string
  private sessionId: string

  constructor(config: AdapterConfig) {
    super({
      ...config,
      providerType: 'kimi',
      authMethods: ['manual'],
      loginUrl: KIMI_API_BASE,
      apiUrl: KIMI_API_BASE,
    })
    this.deviceId = this.generateDeviceId()
    this.sessionId = this.generateSessionId()
  }

  /**
   * Generate device ID
   */
  private generateDeviceId(): string {
    return `7${Array.from({ length: 18 }, () => Math.floor(Math.random() * 10)).join('')}`
  }

  /**
   * Generate session ID
   */
  private generateSessionId(): string {
    return `17${Array.from({ length: 17 }, () => Math.floor(Math.random() * 10)).join('')}`
  }

  private normalizeToken(value: unknown): string {
    return typeof value === 'string'
      ? value.trim().replace(/^Bearer\s+/i, '').trim()
      : ''
  }

  /**
   * Detect token type
   * Reference: detectTokenType function from Kimi-Free-API
   */
  detectTokenType(token: string): 'jwt' | 'refresh' {
    token = this.normalizeToken(token)
    if (token.startsWith('eyJ') && token.split('.').length === 3) {
      try {
        const payload = this.parseJWT(token)
        if (payload && payload.app_id === 'kimi' && payload.typ === 'access') {
          return 'jwt'
        }
      } catch {
        // Parse failed, treat as refresh token
      }
    }
    return 'refresh'
  }

  private getCredentialTokens(credentials: Record<string, string>): {
    accessToken: string
    refreshToken: string
  } {
    const candidates = [
      credentials.access_token,
      credentials.accessToken,
      credentials.token,
      credentials.kimiAuth,
      credentials['kimi-auth'],
    ].map((value) => this.normalizeToken(value)).filter(Boolean)
    const accessToken = candidates.find((value) => this.detectTokenType(value) === 'jwt') || ''
    const refreshToken = [credentials.refreshToken, credentials.refresh_token]
      .map((value) => this.normalizeToken(value))
      .find(Boolean)
      || candidates.find((value) => value !== accessToken && this.detectTokenType(value) === 'refresh')
      || ''

    return { accessToken, refreshToken }
  }

  private buildCanonicalCredentials(
    accessToken: string,
    refreshToken: string,
    credentials: Record<string, string> = {},
    extra: Record<string, string> = {},
  ): Record<string, string> {
    const claims = this.parseJWT(accessToken) || {}
    const deviceId = credentials.deviceId || credentials.device_id || credentials.webId
      || credentials.web_id || extra.deviceId
      || (typeof claims.device_id === 'string' ? claims.device_id : this.deviceId)
    const sessionId = credentials.sessionId || credentials.session_id || credentials.ssid
      || extra.sessionId || (typeof claims.ssid === 'string' ? claims.ssid : this.sessionId)
    const trafficId = credentials.trafficId || credentials.traffic_id || credentials.mshUserId
      || credentials.msh_user_id || credentials.userId || credentials.user_id || extra.trafficId
      || (typeof claims.sub === 'string' ? claims.sub : '')

    return {
      token: accessToken,
      accessToken,
      ...(refreshToken ? { refreshToken } : {}),
      ...(deviceId ? { deviceId } : {}),
      ...(sessionId ? { sessionId } : {}),
      ...(trafficId ? { trafficId } : {}),
    }
  }

  /**
   * Get request headers
   */
  private getHeaders(token?: string, credentials: Record<string, string> = {}): Record<string, string> {
    const normalizedToken = this.normalizeToken(token)
    // Refresh JWTs carry the same device/session claims as access JWTs. Decode
    // either token type so refresh requests can reuse the browser identity.
    const claims = normalizedToken ? this.parseJWT(normalizedToken) : null
    const deviceId = credentials.deviceId || credentials.device_id || credentials.webId
      || credentials.web_id || (typeof claims?.device_id === 'string' ? claims.device_id : this.deviceId)
    const sessionId = credentials.sessionId || credentials.session_id || credentials.ssid
      || (typeof claims?.ssid === 'string' ? claims.ssid : this.sessionId)
    const trafficId = credentials.trafficId || credentials.traffic_id || credentials.mshUserId
      || credentials.msh_user_id || credentials.userId || credentials.user_id
      || (typeof claims?.sub === 'string' ? claims.sub : '')
    const headers: Record<string, string> = {
      ...FAKE_HEADERS,
      Referer: `${KIMI_API_BASE}/`,
      'R-Timezone': Intl.DateTimeFormat().resolvedOptions().timeZone || 'Asia/Shanghai',
      'X-Msh-Version': '2.0.0',
      'X-Msh-Device-Id': deviceId,
      'X-Msh-Session-Id': sessionId,
      'X-Traffic-Id': trafficId,
      'Connect-Protocol-Version': '1',
    }
    
    if (normalizedToken) {
      headers.Authorization = `Bearer ${normalizedToken}`
    }
    
    return headers
  }

  
  private async callGrpcApi(
    token: string,
    service: string,
    body: object,
    credentials: Record<string, string> = {}
  ): Promise<any> {
    const response = await axios.post(
      `${KIMI_API_BASE}${service}`,
      body,
      {
        headers: {
          ...this.getHeaders(token, credentials),
          'Content-Type': 'application/json',
        },
        timeout: 15000,
        validateStatus: () => true,
      }
    )
    
    if (response.status !== 200) {
      return null
    }
    
    return response.data
  }

  /**
   * Start login flow - Open default browser
   */
  async startLogin(options: OAuthOptions): Promise<OAuthResult> {
    this.emitProgress('pending', 'Opening browser...')
    
    try {
      await getRuntime().openExternal(KIMI_API_BASE)
      this.emitProgress('pending', 'Please log in via browser and enter Token manually')
      
      return {
        success: false,
        providerId: options.providerId,
        providerType: 'kimi',
        error: 'Please log in via browser, extract Token from Developer Tools and enter manually',
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Failed to open browser'
      this.emitProgress('error', errorMessage)
      
      return {
        success: false,
        providerId: options.providerId,
        providerType: 'kimi',
        error: errorMessage,
      }
    }
  }

  /**
   * Complete authentication with token
   */
  async loginWithToken(providerId: string, token: string): Promise<OAuthResult> {
    this.emitProgress('pending', 'Validating Token...')

    try {
      const normalizedToken = this.normalizeToken(token)
      const tokenType = this.detectTokenType(normalizedToken)
      let accessToken = tokenType === 'jwt' ? normalizedToken : ''
      let refreshToken = tokenType === 'refresh' ? normalizedToken : ''
      let extra: Record<string, string> = {}

      if (!accessToken) {
        this.emitProgress('pending', 'Refreshing Kimi Access Token...')
        const refreshed = await this.refreshToken({ refreshToken })
        if (!refreshed) {
          return {
            success: false,
            providerId,
            providerType: 'kimi',
            error: 'Refresh Token is invalid or expired',
          }
        }
        accessToken = refreshed.value
        refreshToken = refreshed.refreshToken || refreshToken
        extra = refreshed.extra || {}
      }

      const validationCredentials = { accessToken, refreshToken, ...extra }
      const validation = await this.validateToken(validationCredentials)
      if (!validation.valid) {
        return {
          success: false,
          providerId,
          providerType: 'kimi',
          error: validation.error || 'Token is invalid or expired',
        }
      }

      this.emitProgress('success', 'Token validation successful')

      return {
        success: true,
        providerId,
        providerType: 'kimi',
        credentials: this.buildCanonicalCredentials(accessToken, refreshToken, validationCredentials, extra),
        accountInfo: validation.accountInfo,
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error'
      this.emitProgress('error', `Token validation failed: ${errorMessage}`)
      
      return {
        success: false,
        providerId,
        providerType: 'kimi',
        error: errorMessage,
      }
    }
  }

  /**
   * Handle callback (Kimi does not support)
   */
  protected async processCallback(data: OAuthCallbackData): Promise<void> {
    // Kimi does not support OAuth callback
  }

  /**
   * Validate token validity using gRPC API
   */
  async validateToken(credentials: Record<string, string>): Promise<TokenValidationResult> {
    let { accessToken, refreshToken } = this.getCredentialTokens(credentials)
    let credentialsChanged = false

    if (!accessToken && !refreshToken) {
      return {
        valid: false,
        error: 'Kimi access_token or refresh_token is required',
      }
    }

    try {
      const claims = accessToken ? this.parseJWT(accessToken) : null
      const expiresAt = typeof claims?.exp === 'number' ? claims.exp : undefined
      if ((!accessToken || (expiresAt !== undefined && expiresAt <= this.getTimestamp() + 60)) && refreshToken) {
        const refreshed = await this.refreshToken({ ...credentials, refreshToken })
        if (!refreshed) {
          return { valid: false, error: 'Refresh Token expired or invalid' }
        }
        accessToken = refreshed.value
        refreshToken = refreshed.refreshToken || refreshToken
        credentialsChanged = true
      }

      if (!accessToken) {
        return { valid: false, error: 'Access Token expired or invalid' }
      }

      let result = await this.callGrpcApi(
        accessToken,
        '/apiv2/kimi.gateway.order.v1.SubscriptionService/GetSubscription',
        {},
        credentials
      )
      let subscription = result?.subscription || result?.data?.subscription

      // The access JWT may be revoked before its exp claim.  Retry validation
      // once with the saved refresh token so the account dialog does not report
      // a healthy, refreshable account as permanently invalid.
      if (!subscription && refreshToken && !credentialsChanged) {
        const refreshed = await this.refreshToken({ ...credentials, refreshToken })
        if (refreshed) {
          accessToken = refreshed.value
          refreshToken = refreshed.refreshToken || refreshToken
          credentialsChanged = true
          result = await this.callGrpcApi(
            accessToken,
            '/apiv2/kimi.gateway.order.v1.SubscriptionService/GetSubscription',
            {},
            credentials,
          )
          subscription = result?.subscription || result?.data?.subscription
        }
      }

      if (!subscription) {
        return {
          valid: false,
          error: 'Token is invalid or expired',
        }
      }
      
      const nextCredentials = credentialsChanged
        ? this.buildCanonicalCredentials(accessToken, refreshToken, credentials)
        : undefined

      return {
        valid: true,
        tokenType: 'jwt',
        expiresAt: typeof this.parseJWT(accessToken)?.exp === 'number'
          ? this.parseJWT(accessToken)?.exp as number
          : undefined,
        accountInfo: {
          userId: subscription.userId || '',
          name: subscription.userName || '',
        },
        ...(nextCredentials ? { credentials: nextCredentials } : {}),
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Validation request failed'
      return {
        valid: false,
        error: errorMessage,
      }
    }
  }

  async refreshToken(credentials: Record<string, string>): Promise<CredentialInfo | null> {
    const { refreshToken } = this.getCredentialTokens(credentials)
    if (!refreshToken) return null

    try {
      const response = await axios.get(`${KIMI_API_BASE}/api/auth/token/refresh`, {
        headers: this.getHeaders(refreshToken, credentials),
        timeout: 15000,
        validateStatus: () => true,
      })
      const responseData = response.data?.data && typeof response.data.data === 'object'
        ? response.data.data
        : response.data
      const accessToken = this.normalizeToken(
        responseData?.access_token || responseData?.accessToken || responseData?.token,
      )
      if (response.status !== 200 || this.detectTokenType(accessToken) !== 'jwt') {
        return null
      }

      const claims = this.parseJWT(accessToken)
      const rotatedRefreshToken = this.normalizeToken(
        responseData?.refresh_token || responseData?.refreshToken,
      ) || refreshToken
      const deviceId = credentials.deviceId || credentials.device_id || credentials.webId
        || credentials.web_id || (typeof claims?.device_id === 'string' ? claims.device_id : this.deviceId)
      const sessionId = credentials.sessionId || credentials.session_id || credentials.ssid
        || (typeof claims?.ssid === 'string' ? claims.ssid : this.sessionId)
      const trafficId = credentials.trafficId || credentials.traffic_id || credentials.mshUserId
        || credentials.msh_user_id || credentials.userId || credentials.user_id
        || (typeof claims?.sub === 'string' ? claims.sub : '')

      return {
        type: 'jwt',
        value: accessToken,
        expiresAt: typeof claims?.exp === 'number' ? claims.exp : undefined,
        refreshToken: rotatedRefreshToken,
        extra: { deviceId, sessionId, trafficId },
      }
    } catch {
      return null
    }
  }

  /**
   * Get research version usage
   */
  async getResearchUsage(token: string): Promise<{ remain: number; total: number; used: number } | null> {
    try {
      const response = await axios.get(`${KIMI_API_BASE}/api/chat/research/usage`, {
        headers: this.getHeaders(token),
        timeout: 15000,
        validateStatus: () => true,
      })
      
      if (response.status !== 200 || !response.data) {
        return null
      }
      
      return response.data
    } catch {
      return null
    }
  }
}

export default KimiAdapter
