/**
 * GLM (Zhipu) Authentication Adapter
 * Authentication method: Login using default browser, manually extract refresh_token
 */

import axios from 'axios'
import { shell } from 'electron'
import { BaseOAuthAdapter } from './base'
import {
  OAuthResult,
  OAuthOptions,
  TokenValidationResult,
  CredentialInfo,
  AdapterConfig,
  OAuthCallbackData,
} from '../types'

const GLM_API_BASE = 'https://chatglm.cn'

const FAKE_HEADERS = {
  Accept: 'text/event-stream',
  'Accept-Encoding': 'gzip, deflate, br, zstd',
  'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8,en-GB;q=0.7,en-US;q=0.6',
  'App-Name': 'chatglm',
  'Cache-Control': 'no-cache',
  'Content-Type': 'application/json',
  Origin: GLM_API_BASE,
  Pragma: 'no-cache',
  Priority: 'u=1, i',
  'Sec-Ch-Ua': '"Microsoft Edge";v="143", "Chromium";v="143", "Not A(Brand";v="24"',
  'Sec-Ch-Ua-Mobile': '?0',
  'Sec-Ch-Ua-Platform': '"Windows"',
  'Sec-Fetch-Dest': 'empty',
  'Sec-Fetch-Mode': 'cors',
  'Sec-Fetch-Site': 'same-origin',
  'X-App-Fr': 'browser_extension',
  'X-App-Platform': 'pc',
  'X-App-Version': '0.0.1',
  'X-Device-Brand': '',
  'X-Device-Model': '',
  'X-Lang': 'zh',
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36',
}

const SIGN_SECRET = '8a1317a7468aa3ad86e997d08f3f31cb'

export class GLMAdapter extends BaseOAuthAdapter {
  private pendingResolve: ((result: OAuthResult) => void) | null = null

  constructor(config: AdapterConfig) {
    super({
      ...config,
      providerType: 'glm',
      authMethods: ['manual'],
      loginUrl: GLM_API_BASE,
      apiUrl: GLM_API_BASE,
    })
  }

  /**
   * Generate signature
   * GLM timestamp signature algorithm
   */
  private generateSign(): { timestamp: string; nonce: string; sign: string } {
    const e = Date.now()
    const A = e.toString()
    const t = A.length
    const o = A.split('').map((c) => Number(c))
    const i = o.reduce((sum, digit) => sum + digit, 0) - o[t - 2]
    const a = i % 10
    const timestamp = A.substring(0, t - 2) + a + A.substring(t - 1, t)
    const nonce = this.generateUUID().replace(/-/g, '')
    const sign = this.md5(`${timestamp}-${nonce}-${SIGN_SECRET}`)
    
    return { timestamp, nonce, sign }
  }

  /**
   * Start login flow - Open default browser
   */
  async startLogin(options: OAuthOptions): Promise<OAuthResult> {
    this.emitProgress('pending', 'Opening browser...')
    
    try {
      await shell.openExternal(GLM_API_BASE)
      this.emitProgress('pending', 'Please log in via browser and enter Token manually')
      
      return {
        success: false,
        providerId: options.providerId,
        providerType: 'glm',
        error: 'Please log in via browser, extract Token from Developer Tools and enter manually',
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Failed to open browser'
      this.emitProgress('error', errorMessage)
      
      return {
        success: false,
        providerId: options.providerId,
        providerType: 'glm',
        error: errorMessage,
      }
    }
  }

  /**
   * Complete authentication with refresh_token
   */
  async loginWithToken(providerId: string, refreshToken: string): Promise<OAuthResult> {
    this.emitProgress('pending', 'Validating Refresh Token...')
    
    try {
      const tokens = await this.refreshToken({ refreshToken })
      
      if (!tokens) {
        return {
          success: false,
          providerId,
          providerType: 'glm',
          error: 'Refresh Token is invalid or expired',
        }
      }
      
      const validation = await this.validateToken({ 
        refreshToken,
        accessToken: tokens.value,
      })
      
      this.emitProgress('success', 'Token validation successful')
      
      return {
        success: true,
        providerId,
        providerType: 'glm',
        credentials: {
          refreshToken,
          accessToken: tokens.value,
        },
        accountInfo: validation.accountInfo,
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error'
      this.emitProgress('error', `Token validation failed: ${errorMessage}`)
      
      return {
        success: false,
        providerId,
        providerType: 'glm',
        error: errorMessage,
      }
    }
  }

  /**
   * Handle callback (GLM does not support)
   */
  protected async processCallback(data: OAuthCallbackData): Promise<void> {
    // GLM does not support OAuth callback
  }

  /**
   * Validate token validity
   */
  async validateToken(credentials: Record<string, string>): Promise<TokenValidationResult> {
    const refreshToken = credentials.chatglm_refresh_token || credentials.refreshToken || credentials.refresh_token || credentials.token
    
    if (!refreshToken) {
      return {
        valid: false,
        error: 'Refresh Token cannot be empty',
      }
    }
    
    try {
      const sign = this.generateSign()
      const deviceId = this.generateUUID().replace(/-/g, '')
      
      const response = await axios.post(
        `${GLM_API_BASE}/chatglm/user-api/user/refresh`,
        {},
        {
          headers: {
            Authorization: `Bearer ${refreshToken}`,
            'X-Device-Id': deviceId,
            'X-Nonce': sign.nonce,
            'X-Request-Id': this.generateUUID().replace(/-/g, ''),
            'X-Sign': sign.sign,
            'X-Timestamp': sign.timestamp,
            ...FAKE_HEADERS,
          },
          timeout: 15000,
          validateStatus: () => true,
        }
      )
      
      console.log('[GLM OAuth] Response:', response.status, response.data)
      
      if (response.status !== 200) {
        return {
          valid: false,
          error: `Refresh Token is invalid or expired (status: ${response.status})`,
        }
      }
      
      if (!response.data) {
        return {
          valid: false,
          error: 'Refresh Token is invalid or expired (no response data)',
        }
      }
      
      const result = response.data.result || response.data
      
      if (!result.access_token) {
        return {
          valid: false,
          error: 'Token validation failed: Unable to get access_token',
        }
      }
      
      if (result.is_guest === true) {
        return {
          valid: false,
          error: 'Guest account not allowed, please login with a real account',
        }
      }
      
      const userInfo = await this.getUserInfo(result.access_token)
      console.log('[GLM OAuth] User info:', userInfo)
      
      if (userInfo) {
        const email = userInfo.email as string | undefined
        const phone = userInfo.phone as string | undefined
        const nickname = userInfo.nickname as string | undefined
        const isGuest = userInfo.is_guest as boolean | undefined
        
        if (isGuest === true) {
          return {
            valid: false,
            error: 'Guest account not allowed, please login with a real account',
          }
        }
        
        if (nickname && nickname.includes('访客')) {
          return {
            valid: false,
            error: 'Guest account not allowed, please login with a real account',
          }
        }
        
        if (email && email.includes('@guest')) {
          return {
            valid: false,
            error: 'Guest account not allowed, please login with a real account',
          }
        }
        
        if (!phone && !email) {
          return {
            valid: false,
            error: 'Guest account not allowed, please login with a real account',
          }
        }
        
        return {
          valid: true,
          tokenType: 'refresh',
          accountInfo: {
            userId: result.user_id,
            email: email || '',
            name: nickname || phone || email || result.user_id,
          },
        }
      }
      
      return {
        valid: true,
        tokenType: 'refresh',
        accountInfo: {
          userId: result.user_id,
        },
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Validation request failed'
      return {
        valid: false,
        error: errorMessage,
      }
    }
  }

  /**
   * Refresh token
   * Get new access_token using refresh_token
   */
  async refreshToken(credentials: Record<string, string>): Promise<CredentialInfo | null> {
    const refreshToken = credentials.refreshToken || credentials.token
    
    if (!refreshToken) {
      return null
    }
    
    try {
      const sign = this.generateSign()
      const deviceId = this.generateUUID().replace(/-/g, '')
      
      const response = await axios.post(
        `${GLM_API_BASE}/chatglm/user-api/user/refresh`,
        {},
        {
          headers: {
            Authorization: `Bearer ${refreshToken}`,
            'X-Device-Id': deviceId,
            'X-Nonce': sign.nonce,
            'X-Request-Id': this.generateUUID().replace(/-/g, ''),
            'X-Sign': sign.sign,
            'X-Timestamp': sign.timestamp,
            ...FAKE_HEADERS,
          },
          timeout: 15000,
          validateStatus: () => true,
        }
      )
      
      if (response.status !== 200 || !response.data?.result) {
        return null
      }
      
      const { result } = response.data
      
      return {
        type: 'access',
        value: result.access_token,
        refreshToken: result.refresh_token,
        expiresAt: this.getTimestamp() + 3600,
      }
    } catch {
      return null
    }
  }

  /**
   * Get user info
   */
  async getUserInfo(accessToken: string): Promise<Record<string, unknown> | null> {
    try {
      const sign = this.generateSign()
      const deviceId = this.generateUUID().replace(/-/g, '')
      
      const response = await axios.get(`${GLM_API_BASE}/chatglm/user-api/user/info`, {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'X-Device-Id': deviceId,
          'X-Request-Id': this.generateUUID().replace(/-/g, ''),
          'X-Sign': sign.sign,
          'X-Timestamp': sign.timestamp,
          'X-Nonce': sign.nonce,
          ...FAKE_HEADERS,
        },
        timeout: 15000,
        validateStatus: () => true,
      })
      
      if (response.status !== 200 || !response.data?.result) {
        return null
      }
      
      return response.data.result
    } catch {
      return null
    }
  }
}

export default GLMAdapter
