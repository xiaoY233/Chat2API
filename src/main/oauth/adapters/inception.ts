/**
 * Inception (Mercury) Authentication Adapter
 *
 * Inception is anonymous: the playground has no account system and no official
 * API key. The only credential is the Vercel clearance cookie, which the app
 * solves natively (or accepts manually via the optional `_vcrcs` field). There
 * is no login step.
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
      authMethods: ['manual'],
      loginUrl: INCEPTION_LOGIN_URL,
      apiUrl: INCEPTION_API_BASE,
    })
  }

  async startLogin(options: OAuthOptions): Promise<OAuthResult> {
    return {
      success: false,
      providerId: options.providerId,
      providerType: 'inception',
      error: 'Inception needs no login; the app solves the Vercel challenge automatically',
    }
  }

  protected async processCallback(_data: OAuthCallbackData): Promise<void> {
    // No login flow: the clearance cookie is solved natively.
  }

  async validateToken(credentials: Record<string, string>): Promise<TokenValidationResult> {
    const stored = buildInceptionCookieHeader(credentials)

    try {
      // Prefer a manually supplied cookie; if it is stale (or absent) solve a
      // fresh checkpoint natively.
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