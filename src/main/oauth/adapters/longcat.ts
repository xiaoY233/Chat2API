/**
 * LongCat Authentication Adapter
 * Authentication method: in-app browser login on https://longcat.ai/chat,
 * then reuse the web session cookie (no official API key).
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
import {
  LONGCAT_API_BASE,
  LONGCAT_LOGIN_URL,
  buildLongCatCookieHeader,
  longCatHeaders,
} from '../../providers/longcatCookie'

const CHECK_TIMEOUT = 15000

interface LongCatUserInfo {
  name?: string
  email?: string
}

function readUserInfo(payload: any): LongCatUserInfo {
  const data = payload?.data && typeof payload.data === 'object' ? payload.data : payload
  return {
    name: data?.name || data?.nickname || data?.userName || data?.user_name,
    email: data?.email,
  }
}

function loginStatusOf(payload: any): number | null {
  const data = payload?.data && typeof payload.data === 'object' ? payload.data : payload
  const value = data?.loginStatus ?? data?.login_status
  if (value === undefined || value === null) {
    return null
  }
  return Number(value)
}

export class LongCatAdapter extends BaseOAuthAdapter {
  constructor(config: AdapterConfig) {
    super({
      ...config,
      providerType: 'longcat',
      authMethods: ['manual', 'cookie'],
      loginUrl: LONGCAT_LOGIN_URL,
      apiUrl: LONGCAT_API_BASE,
    })
  }

  async startLogin(options: OAuthOptions): Promise<OAuthResult> {
    return {
      success: false,
      providerId: options.providerId,
      providerType: 'longcat',
      error: 'Use startInAppLogin for automatic cookie extraction',
    }
  }

  protected async processCallback(_data: OAuthCallbackData): Promise<void> {
    // LongCat login happens entirely in the in-app browser window.
  }

  async validateToken(credentials: Record<string, string>): Promise<TokenValidationResult> {
    const cookie = buildLongCatCookieHeader(credentials)
    if (!cookie) {
      return {
        valid: false,
        error: 'LongCat passport_token_key cookie is required',
      }
    }

    try {
      const response = await axios.get(`${LONGCAT_API_BASE}/api/v1/user-current`, {
        params: { t: Date.now() },
        headers: longCatHeaders(cookie),
        timeout: CHECK_TIMEOUT,
        validateStatus: () => true,
      })

      if (response.status === 401 || response.status === 403) {
        return { valid: false, error: 'LongCat cookie expired or invalid, please log in again' }
      }
      if (response.status < 200 || response.status >= 300) {
        return { valid: false, error: `LongCat returned HTTP ${response.status}` }
      }

      const payload = response.data
      if (payload?.code !== undefined && Number(payload.code) !== 0) {
        return { valid: false, error: payload?.message || 'LongCat session is not logged in' }
      }

      if (loginStatusOf(payload) !== 1) {
        return { valid: false, error: 'LongCat session is not logged in' }
      }

      const userInfo = readUserInfo(payload)
      return {
        valid: true,
        tokenType: 'cookie',
        accountInfo: {
          name: userInfo.name || 'LongCat User',
          email: userInfo.email,
        },
      }
    } catch (error) {
      return {
        valid: false,
        error: error instanceof Error ? error.message : 'Connection failed',
      }
    }
  }

  async refreshToken(credentials: Record<string, string>): Promise<CredentialInfo | null> {
    const cookie = buildLongCatCookieHeader(credentials)
    if (!cookie) {
      return null
    }
    return {
      type: 'cookie',
      value: cookie,
      extra: credentials,
    }
  }
}

export default LongCatAdapter
