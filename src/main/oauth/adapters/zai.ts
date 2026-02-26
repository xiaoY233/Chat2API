/**
 * Z.ai Adapter
 * Implements Z.ai (GLM International) API protocol
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

const ZAI_API_BASE = 'https://chat.z.ai'
const X_FE_VERSION = 'prod-fe-1.0.241'

const FAKE_HEADERS = {
  Accept: '*/*',
  'Accept-Encoding': 'gzip, deflate, br, zstd',
  'Accept-Language': 'zh-CN,zh;q=0.9',
  'Cache-Control': 'no-cache',
  Origin: ZAI_API_BASE,
  Pragma: 'no-cache',
  'Sec-Ch-Ua': '"Chromium";v="144", "Not(A:Brand";v="8", "Google Chrome";v="144"',
  'Sec-Ch-Ua-Mobile': '?0',
  'Sec-Ch-Ua-Platform': '"Windows"',
  'Sec-Fetch-Dest': 'empty',
  'Sec-Fetch-Mode': 'cors',
  'Sec-Fetch-Site': 'same-origin',
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/144.0.0.0 Safari/537.36',
  'X-FE-Version': X_FE_VERSION,
}

export class ZaiAdapter extends BaseOAuthAdapter {
  constructor(config: AdapterConfig) {
    super({
      ...config,
      providerType: 'zai',
      authMethods: ['manual'],
      loginUrl: ZAI_API_BASE,
      apiUrl: ZAI_API_BASE,
    })
  }

  /**
   * Complete authentication with manually entered token
   */
  async loginWithToken(providerId: string, token: string): Promise<OAuthResult> {
    this.emitProgress('pending', 'Validating Token...')
    
    try {
      const validation = await this.validateToken({ token })
      
      if (!validation.valid) {
        return {
          success: false,
          providerId,
          providerType: 'zai',
          error: validation.error || 'Token validation failed',
        }
      }
      
      this.emitProgress('success', 'Token validation successful')
      
      return {
        success: true,
        providerId,
        credentials: { token },
        accountInfo: validation.accountInfo,
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Validation request failed'
      return {
        success: false,
        providerId,
        providerType: 'zai',
        error: errorMessage,
      }
    }
  }

  /**
   * Handle callback (Z.ai does not support)
   */
  protected async processCallback(data: OAuthCallbackData): Promise<void> {
    // Z.ai does not support OAuth callback
  }

  /**
   * Validate token validity
   */
  async validateToken(credentials: Record<string, string>): Promise<TokenValidationResult> {
    const token = credentials.token
    
    if (!token) {
      return {
        valid: false,
        error: 'Token cannot be empty',
      }
    }
    
    if (token.startsWith('eyJ') && token.split('.').length === 3) {
      try {
        const parts = token.split('.')
        const payload = JSON.parse(Buffer.from(parts[1], 'base64').toString())
        
        // Reject guest accounts
        if (payload.email && payload.email.includes('@guest.com')) {
          return {
            valid: false,
            error: 'Guest account not allowed, please login with a real account',
          }
        }
        
        if (payload && payload.id) {
          return {
            valid: true,
            tokenType: 'access',
            accountInfo: {
              userId: payload.id,
              email: payload.email || '',
              name: payload.email || payload.id,
            },
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
}
