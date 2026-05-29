/**
 * Qwen AI (International) Authentication Adapter
 * Implements chat.qwen.ai API authentication
 */

import axios from 'axios'
import { BaseOAuthAdapter } from './base'
import {
  OAuthResult,
  OAuthOptions,
  TokenValidationResult,
  CredentialInfo,
  AdapterConfig,
  OAuthCallbackData,
} from '../types'

const QWEN_AI_API_BASE = 'https://chat.qwen.ai'

const FAKE_HEADERS = {
  Accept: 'application/json',
  'Accept-Encoding': 'gzip, deflate, br, zstd',
  'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
  'Cache-Control': 'no-cache',
  Origin: QWEN_AI_API_BASE,
  Pragma: 'no-cache',
  'Sec-Ch-Ua': '"Chromium";v="144", "Not(A:Brand";v="8", "Google Chrome";v="144"',
  'Sec-Ch-Ua-Mobile': '?0',
  'Sec-Ch-Ua-Platform': '"Windows"',
  'Sec-Fetch-Dest': 'empty',
  'Sec-Fetch-Mode': 'cors',
  'Sec-Fetch-Site': 'same-origin',
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/144.0.0.0 Safari/537.36',
  source: 'web',
}

export class QwenAiAdapter extends BaseOAuthAdapter {
  constructor(config: AdapterConfig) {
    super({
      ...config,
      providerType: 'qwen-ai',
      authMethods: ['manual'],
      loginUrl: QWEN_AI_API_BASE,
      apiUrl: QWEN_AI_API_BASE,
    })
  }

  private getCookieHeader(credentials: Record<string, string>): string {
    const cookies = (credentials.cookies || credentials.cookie || '') as unknown
    if (typeof cookies === 'string') {
      return cookies
    }
    if (cookies && typeof cookies === 'object') {
      return Object.entries(cookies)
        .filter(([, value]) => value)
        .map(([key, value]) => `${key}=${value}`)
        .join('; ')
    }
    const token = credentials.token
    return token ? `token=${token}` : ''
  }

  async loginWithToken(providerId: string, token: string): Promise<OAuthResult> {
    this.emitProgress('pending', 'Validating credentials...')

    // 区分凭据类型：JWT token 以 "eyJ" 开头且有三段，否则视为完整 Cookie Header 字符串
    // （注意：当前 UI 的 LoginDialog 中没有 qwen-ai 入口，此路径暂不可达，
    //   此处修复是为防止未来接入时出现 Cookie 被误存为 token 的问题）
    const isJwt = token.startsWith('eyJ') && token.split('.').length === 3
    const credentials: Record<string, string> = isJwt ? { token } : { cookies: token }

    try {
      const validation = await this.validateToken(credentials)

      if (!validation.valid) {
        return {
          success: false,
          providerId,
          providerType: 'qwen-ai',
          error: validation.error || 'Token validation failed',
        }
      }

      this.emitProgress('success', 'Validation successful')

      return {
        success: true,
        providerId,
        providerType: 'qwen-ai',
        credentials,
        accountInfo: validation.accountInfo,
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Validation request failed'
      return {
        success: false,
        providerId,
        providerType: 'qwen-ai',
        error: errorMessage,
      }
    }
  }

  protected async processCallback(data: OAuthCallbackData): Promise<void> {
    // Qwen AI does not support OAuth callback
  }

  async validateToken(credentials: Record<string, string>): Promise<TokenValidationResult> {
    const token = credentials.token
    const rawCookies = credentials.cookies || credentials.cookie
    const cookieHeader = this.getCookieHeader(credentials)
    
    if (cookieHeader) {
      try {
        const response = await axios.post(
          `${QWEN_AI_API_BASE}/api/v2/users/status`,
          {
            typarms: {
              typarm1: 'web',
              typarm3: 'prod',
              typarm4: 'qwen_chat',
              typarm5: 'product',
              orgid: 'tongyi',
              cdn_version: '0.2.45',
              domain: 'chat.qwen.ai',
            },
          },
          {
            headers: {
              Cookie: cookieHeader,
              ...FAKE_HEADERS,
              Accept: 'application/json, text/plain, */*',
              Referer: 'https://chat.qwen.ai/c/new-chat',
              Version: '0.2.45',
            },
            timeout: 15000,
            validateStatus: () => true,
          }
        )

        if (response.status === 200 && response.data?.success && response.data?.data === true) {
          return {
            valid: true,
            tokenType: 'cookie',
            accountInfo: {
              name: 'Qwen AI User',
            },
          }
        }

        if (rawCookies) {
          return {
            valid: false,
            error: response.data?.errorMsg || `Validation failed: HTTP ${response.status}`,
          }
        }
      } catch (error) {
        return {
          valid: false,
          error: error instanceof Error ? error.message : 'Validation request failed',
        }
      }
    }

    if (!token) {
      return {
        valid: false,
        error: 'Cookies cannot be empty',
      }
    }
    
    if (token.startsWith('eyJ') && token.split('.').length === 3) {
      try {
        const parts = token.split('.')
        const payload = JSON.parse(Buffer.from(parts[1], 'base64').toString())
        
        if (payload.email && payload.email.includes('@guest.com')) {
          return {
            valid: false,
            error: 'Guest account not allowed, please login with a real account',
          }
        }
        
        if (payload && (payload.sub || payload.id || payload.user_id || payload.uid)) {
          const userId = payload.sub || payload.id || payload.user_id || payload.uid
          
          try {
            const userInfo = await this.getUserInfo(token)
            console.log('[QwenAi OAuth] User info:', userInfo)
            
            if (userInfo && userInfo.is_guest === true) {
              return {
                valid: false,
                error: 'Guest account not allowed, please login with a real account',
              }
            }
            
            return {
              valid: true,
              tokenType: 'access',
              accountInfo: {
                userId: userId,
                email: payload.email || userInfo?.email || '',
                name: payload.name || userInfo?.name || payload.email || userId,
              },
            }
          } catch (apiError) {
            console.log('[QwenAi OAuth] API validation failed, using JWT payload only:', apiError)
            return {
              valid: true,
              tokenType: 'access',
              accountInfo: {
                userId: userId,
                email: payload.email || '',
                name: payload.name || payload.email || userId,
              },
            }
          }
        }
      } catch {
        return {
          valid: false,
          error: 'Invalid JWT token',
        }
      }
    }
    
    return {
      valid: false,
      error: 'Token is invalid',
    }
  }

  async getUserInfo(token: string): Promise<Record<string, unknown> | null> {
    try {
      const response = await axios.get(`${QWEN_AI_API_BASE}/api/v2/user/info`, {
        headers: {
          Authorization: `Bearer ${token}`,
          ...FAKE_HEADERS,
        },
        timeout: 15000,
        validateStatus: () => true,
      })
      
      if (response.status !== 200 || !response.data?.success) {
        return null
      }
      
      return response.data.data
    } catch {
      return null
    }
  }

  async refreshToken(credentials: Record<string, string>): Promise<CredentialInfo | null> {
    return null
  }
}

export default QwenAiAdapter
