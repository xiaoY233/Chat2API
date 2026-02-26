/**
 * MiniMax Authentication Adapter
 * Login using default browser, manually extract token
 */

import axios from 'axios'
import { shell } from 'electron'
import crypto from 'crypto'
import { BaseOAuthAdapter } from './base'
import {
  OAuthResult,
  OAuthOptions,
  TokenValidationResult,
  CredentialInfo,
  AdapterConfig,
  OAuthCallbackData,
} from '../types'

const MINIMAX_API_BASE = 'https://agent.minimaxi.com'

const FAKE_HEADERS = {
  Accept: 'application/json, text/plain, */*',
  'Accept-Encoding': 'gzip, deflate, br, zstd',
  'Accept-Language': 'zh-CN,zh;q=0.9',
  'Cache-Control': 'no-cache',
  Origin: MINIMAX_API_BASE,
  Pragma: 'no-cache',
  'Sec-Ch-Ua': '"Not:A-Brand";v="99", "Google Chrome";v="145", "Chromium";v="145"',
  'Sec-Ch-Ua-Mobile': '?0',
  'Sec-Ch-Ua-Platform': '"macOS"',
  'Sec-Fetch-Dest': 'empty',
  'Sec-Fetch-Mode': 'cors',
  'Sec-Fetch-Site': 'same-origin',
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36',
}

const FAKE_USER_DATA: Record<string, any> = {
  device_platform: 'web',
  biz_id: '3',
  app_id: '3001',
  version_code: '22201',
  uuid: null,
  device_id: null,
  os_name: 'Mac',
  browser_name: 'chrome',
  device_memory: 8,
  cpu_core_num: 11,
  browser_language: 'zh-CN',
  browser_platform: 'MacIntel',
  user_id: null,
  screen_width: 1920,
  screen_height: 1080,
  unix: null,
  lang: 'zh',
  token: null,
}

function md5(input: string): string {
  return crypto.createHash('md5').update(input).digest('hex')
}

function unixTimestamp(): number {
  return Math.floor(Date.now() / 1000)
}

export class MiniMaxAdapter extends BaseOAuthAdapter {
  constructor(config: AdapterConfig) {
    super({
      ...config,
      providerType: 'minimax',
      authMethods: ['manual'],
      loginUrl: MINIMAX_API_BASE,
      apiUrl: MINIMAX_API_BASE,
    })
  }

  /**
   * Start login flow - Open default browser
   */
  async startLogin(options: OAuthOptions): Promise<OAuthResult> {
    this.emitProgress('pending', 'Opening browser...')
    
    try {
      await shell.openExternal(MINIMAX_API_BASE)
      this.emitProgress('pending', 'Please log in via browser and enter Token manually')
      
      return {
        success: false,
        providerId: options.providerId,
        providerType: 'minimax',
        error: 'Please log in via browser, extract Token from Developer Tools and enter manually',
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Failed to open browser'
      this.emitProgress('error', errorMessage)
      
      return {
        success: false,
        providerId: options.providerId,
        providerType: 'minimax',
        error: errorMessage,
      }
    }
  }

  /**
   * Complete authentication with token
   * Supports both:
   * - token: JWT token only (realUserID will be extracted from JWT)
   * - token + realUserID: Will be combined as "realUserID+JWTtoken"
   */
  async loginWithToken(providerId: string, token: string, realUserID?: string): Promise<OAuthResult> {
    this.emitProgress('pending', 'Validating Token...')
    
    try {
      // If realUserID is provided, combine with token
      let finalToken = token
      if (realUserID && realUserID.trim()) {
        finalToken = `${realUserID.trim()}+${token}`
        console.log('[MiniMax] Combining realUserID with token')
      }
      
      const validation = await this.validateToken({ token: finalToken })
      
      if (!validation.valid) {
        return {
          success: false,
          providerId,
          providerType: 'minimax',
          error: validation.error || 'Token validation failed',
        }
      }

      this.emitProgress('success', 'Token validation successful')
      
      return {
        success: true,
        providerId,
        providerType: 'minimax',
        credentials: { token: finalToken },
        accountInfo: validation.accountInfo,
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error'
      this.emitProgress('error', `Token validation failed: ${errorMessage}`)
      
      return {
        success: false,
        providerId,
        providerType: 'minimax',
        error: errorMessage,
      }
    }
  }

  /**
   * Handle callback (MiniMax does not support)
   */
  protected async processCallback(data: OAuthCallbackData): Promise<void> {
    // MiniMax does not support OAuth callback
  }

  /**
   * Validate token validity
   * Uses the same request format as proxy adapter
   */
  async validateToken(credentials: Record<string, string>): Promise<TokenValidationResult> {
    const token = credentials.token

    if (!token) {
      return {
        valid: false,
        error: 'Token cannot be empty',
      }
    }

    console.log('[MiniMax OAuth] Validating token:', token.substring(0, 50) + '...')

    try {
      // Parse token to extract realUserID and JWT
      let jwtToken: string
      let realUserID: string

      if (token.includes('+')) {
        const parts = token.split('+')
        realUserID = parts[0]
        jwtToken = parts[1]
      } else {
        jwtToken = token
        realUserID = this.extractUserIdFromToken(token) || ''
      }

      console.log('[MiniMax OAuth] realUserID:', realUserID, 'jwtToken:', jwtToken.substring(0, 30) + '...')

      // Build request with proper signatures (same as proxy adapter)
      const unix = `${Date.now()}`
      const timestamp = unixTimestamp()
      const userData = { ...FAKE_USER_DATA }
      userData.uuid = realUserID
      userData.device_id = undefined
      userData.user_id = realUserID
      userData.unix = unix
      userData.token = jwtToken

      let queryStr = ''
      for (const key in userData) {
        if (userData[key] === undefined) continue
        queryStr += `&${key}=${userData[key]}`
      }
      queryStr = queryStr.substring(1)

      const uri = '/v1/api/user/info'
      const fullUri = `${uri}?${queryStr}`
      const dataJson = '{}'
      const yy = md5(`${encodeURIComponent(fullUri)}_${dataJson}${md5(unix)}ooui`)
      const signature = md5(`${timestamp}${jwtToken}${dataJson}`)

      console.log('[MiniMax OAuth] Request - uuid:', realUserID, 'user_id:', realUserID)

      const response = await axios.request({
        method: 'GET',
        url: `${MINIMAX_API_BASE}${fullUri}`,
        timeout: 15000,
        validateStatus: () => true,
        headers: {
          Referer: `${MINIMAX_API_BASE}/`,
          token: jwtToken,
          ...FAKE_HEADERS,
          'Content-Type': 'application/json',
          'x-timestamp': String(timestamp),
          'x-signature': signature,
          yy: yy,
        },
      })

      console.log('[MiniMax OAuth] Validation response status:', response.status)
      console.log('[MiniMax OAuth] Validation response data:', JSON.stringify(response.data))

      if (response.status !== 200 || response.data?.statusInfo?.code !== 0) {
        const errorMsg = response.data?.statusInfo?.message || 'Token is invalid or expired'
        console.log('[MiniMax OAuth] Validation failed:', errorMsg)
        return {
          valid: false,
          error: errorMsg,
        }
      }

      const userInfo = response.data.data?.userInfo || response.data.data

      return {
        valid: true,
        tokenType: 'jwt',
        accountInfo: {
          userId: realUserID || userInfo?.id,
          name: userInfo?.name || userInfo?.nickname,
          email: userInfo?.email,
        },
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Validation request failed'
      console.error('[MiniMax OAuth] Validation error:', errorMessage)
      return {
        valid: false,
        error: errorMessage,
      }
    }
  }

  /**
   * Refresh token (MiniMax uses JWT, no refresh mechanism)
   */
  async refreshToken(credentials: Record<string, string>): Promise<CredentialInfo | null> {
    // MiniMax uses JWT tokens that don't need refresh
    return null
  }

  /**
   * Extract user ID from JWT token
   */
  private extractUserIdFromToken(token: string): string | undefined {
    try {
      const payload = this.parseJWT(token)
      return payload?.user?.id as string | undefined || payload?.sub as string | undefined
    } catch {
      return undefined
    }
  }

  /**
   * Get user credits/balance
   */
  async getCredits(token: string): Promise<{
    totalCredits: number
    usedCredits: number
    remainingCredits: number
  } | null> {
    try {
      const response = await axios.get(`${MINIMAX_API_BASE}/v1/api/user/credit`, {
        headers: {
          ...FAKE_HEADERS,
          'token': token,
          Referer: `${MINIMAX_API_BASE}/`,
        },
        timeout: 15000,
        validateStatus: () => true,
      })
      
      if (response.status === 200 && response.data?.statusInfo?.code === 0) {
        const data = response.data.data
        return {
          totalCredits: data?.totalCredit || data?.total_credits || 0,
          usedCredits: data?.usedCredit || data?.used_credits || 0,
          remainingCredits: data?.remainCredit || data?.remaining_credits || 0,
        }
      }
      
      return null
    } catch {
      return null
    }
  }
}

export default MiniMaxAdapter
