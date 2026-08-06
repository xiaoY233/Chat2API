/**
 * Qwen Authentication Adapter
 * Login using browser, extract tongyi_sso_ticket from cookies
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

const QWEN_API_BASE = 'https://chat2-api.qianwen.com'
const QWEN_WEB_BASE = 'https://www.qianwen.com'

const DEFAULT_HEADERS = {
  Accept: 'application/json, text/plain, */*',
  'Accept-Encoding': 'gzip, deflate, br, zstd',
  'Accept-Language': 'zh-CN,zh;q=0.9',
  'Cache-Control': 'no-cache',
  Origin: QWEN_WEB_BASE,
  Pragma: 'no-cache',
  'Sec-Ch-Ua': '"Chromium";v="145", "Not(A:Brand";v="24", "Google Chrome";v="145"',
  'Sec-Ch-Ua-Mobile': '?0',
  'Sec-Ch-Ua-Platform': '"macOS"',
  'Sec-Fetch-Dest': 'empty',
  'Sec-Fetch-Mode': 'cors',
  'Sec-Fetch-Site': 'same-site',
  Referer: `${QWEN_WEB_BASE}/`,
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36',
}

export class QwenAdapter extends BaseOAuthAdapter {
  constructor(config: AdapterConfig) {
    super({
      ...config,
      providerType: 'qwen',
      authMethods: ['manual', 'cookie'],
      loginUrl: QWEN_WEB_BASE,
      apiUrl: QWEN_API_BASE,
    })
  }

  private generateCookie(ticket: string): string {
    return `tongyi_sso_ticket=${ticket}`
  }

  async startLogin(options: OAuthOptions): Promise<OAuthResult> {
    this.emitProgress('pending', 'Opening browser...')
    
    try {
      await shell.openExternal(QWEN_WEB_BASE)
      this.emitProgress('pending', 'Please log in via browser and enter Ticket manually')
      
      return {
        success: false,
        providerId: options.providerId,
        providerType: 'qwen',
        error: 'Please log in via browser, extract tongyi_sso_ticket from Developer Tools and enter manually',
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Failed to open browser'
      this.emitProgress('error', errorMessage)
      
      return {
        success: false,
        providerId: options.providerId,
        providerType: 'qwen',
        error: errorMessage,
      }
    }
  }

  async loginWithToken(providerId: string, ticket: string): Promise<OAuthResult> {
    this.emitProgress('pending', 'Validating Ticket...')
    
    try {
      const validation = await this.validateToken({ ticket })
      
      if (!validation.valid) {
        return {
          success: false,
          providerId,
          providerType: 'qwen',
          error: validation.error || 'Ticket validation failed',
        }
      }
      
      this.emitProgress('success', 'Ticket validation successful')
      
      return {
        success: true,
        providerId,
        providerType: 'qwen',
        credentials: { ticket },
        accountInfo: validation.accountInfo,
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error'
      this.emitProgress('error', `Ticket validation failed: ${errorMessage}`)
      
      return {
        success: false,
        providerId,
        providerType: 'qwen',
        error: errorMessage,
      }
    }
  }

  protected async processCallback(data: OAuthCallbackData): Promise<void> {
  }

  async validateToken(credentials: Record<string, string>): Promise<TokenValidationResult> {
    const ticket = credentials.ticket || credentials.tongyi_sso_ticket
    
    if (!ticket) {
      return {
        valid: false,
        error: 'Ticket cannot be empty',
      }
    }
    
    try {
      const response = await axios.post(
        `${QWEN_API_BASE}/api/v2/session/page/list`,
        {},
        {
          headers: {
            Cookie: this.generateCookie(ticket),
            ...DEFAULT_HEADERS,
            'X-Platform': 'pc_tongyi',
            'X-DeviceId': '5b68c267-cd8e-fd0e-148a-18345bc9a104',
          },
          params: {
            biz_id: 'ai_qwen',
            chat_client: 'h5',
            device: 'pc',
            fr: 'pc',
            pr: 'qwen',
            ut: '5b68c267-cd8e-fd0e-148a-18345bc9a104',
          },
          timeout: 15000,
          validateStatus: () => true,
        }
      )
      
      if (response.status !== 200) {
        return {
          valid: false,
          error: 'Ticket is invalid or expired',
        }
      }
      
      const { success, errorCode, errorMsg, data } = response.data
      
      if (success === false) {
        return {
          valid: false,
          error: errorMsg || `Validation failed: ${errorCode}`,
        }
      }
      
      return {
        valid: true,
        tokenType: 'cookie',
        accountInfo: {},
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
    return null
  }

  async getSessionList(ticket: string): Promise<unknown[] | null> {
    try {
      const response = await axios.post(
        `${QWEN_API_BASE}/api/v2/session/page/list`,
        {},
        {
          headers: {
            Cookie: this.generateCookie(ticket),
            ...DEFAULT_HEADERS,
            'X-Platform': 'pc_tongyi',
            'X-DeviceId': '5b68c267-cd8e-fd0e-148a-18345bc9a104',
          },
          params: {
            biz_id: 'ai_qwen',
            chat_client: 'h5',
            device: 'pc',
            fr: 'pc',
            pr: 'qwen',
            ut: '5b68c267-cd8e-fd0e-148a-18345bc9a104',
          },
          timeout: 15000,
          validateStatus: () => true,
        }
      )
      
      if (response.status !== 200 || !response.data?.success) {
        return null
      }
      
      return response.data.data
    } catch {
      return null
    }
  }

  async deleteSession(sessionId: string, ticket: string): Promise<boolean> {
    if (!sessionId || !ticket) {
      return false
    }

    try {
      const response = await axios.post(
        `${QWEN_API_BASE}/api/v2/session/delete`,
        { session_id: sessionId },
        {
          headers: {
            Cookie: this.generateCookie(ticket),
            ...DEFAULT_HEADERS,
            'X-Platform': 'pc_tongyi',
            'X-DeviceId': '5b68c267-cd8e-fd0e-148a-18345bc9a104',
          },
          params: {
            biz_id: 'ai_qwen',
            chat_client: 'h5',
            device: 'pc',
            fr: 'pc',
            pr: 'qwen',
            ut: '5b68c267-cd8e-fd0e-148a-18345bc9a104',
          },
          timeout: 15000,
          validateStatus: () => true,
        }
      )

      if (response.status !== 200) {
        console.warn(`[Qwen] Failed to delete session ${sessionId}: status ${response.status}`)
        return false
      }

      const { success, errorMsg } = response.data
      if (success === false) {
        console.warn(`[Qwen] Failed to delete session ${sessionId}: ${errorMsg}`)
        return false
      }

      console.log(`[Qwen] Session deleted successfully: ${sessionId}`)
      return true
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error'
      console.warn(`[Qwen] Failed to delete session ${sessionId}: ${errorMessage}`)
      return false
    }
  }
}

export default QwenAdapter
