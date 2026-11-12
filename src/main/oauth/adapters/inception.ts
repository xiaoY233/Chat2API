/**
 * Inception (Mercury) Authentication Adapter
 * Authentication method: in-app browser login on https://chat.inceptionlabs.ai,
 * then reuse the anonymous web session's Vercel clearance cookie (no official
 * API key, no account).
 */

import {
  BaseOAuthAdapter,
} from './base'
import {
  OAuthResult,
  OAuthOptions,
  TokenValidationResult,
  CredentialInfo,
  AdapterConfig,
  OAuthCallbackData,
} from '../types'
import {
  INCEPTION_API_BASE,
  INCEPTION_LOGIN_URL,
  buildInceptionCookieHeader,
  fetchInceptionSessionToken,
  getInceptionClearance,
} from '../../providers/inception'

export class InceptionAdapter extends BaseOAuthAdapter {
  constructor(config: AdapterConfig) {
    super({
      ...config,
      providerType: 'inception',
      authMethods: ['manual', 'cookie'],
      loginUrl: INCEPTION_LOGIN_URL,
      apiUrl: INCEPTION_API_BASE,
    })
  }

  async startLogin(options: OAuthOptions): Promise<OAuthResult> {
    return {
      success: false,
      providerId: options.providerId,
      providerType: 'inception',
      error: 'Use startInAppLogin for automatic clearance extraction',
    }
  }

  protected async processCallback(_data: OAuthCallbackData): Promise<void> {
    // Inception login happens entirely in the in-app browser window.
  }

  async validateToken(credentials: Record<string, string>): Promise<TokenValidationResult> {
    const stored = buildInceptionCookieHeader(credentials)

    try {
      // Prefer the captured browser cookie; if it is stale (or absent) solve a
      // fresh checkpoint natively so validation does not depend on the window.
      let cookie = stored
      let token: string | null = null

      if (cookie) {
        try {
          token = await fetchInceptionSessionToken(cookie)
        } catch {
          cookie = ''
        }
      }

      if (!token) {
        cookie = await getInceptionClearance()
        token = await fetchInceptionSessionToken(cookie)
      }

      if (!token) {
        return { valid: false, error: 'Inception session could not be created' }
      }

      return {
        valid: true,
        tokenType: 'cookie',
        accountInfo: {
          name: 'Inception Mercury',
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
    const cookie = buildInceptionCookieHeader(credentials)
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

export default InceptionAdapter