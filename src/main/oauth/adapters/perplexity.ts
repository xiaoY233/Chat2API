/**
 * Perplexity Authentication Adapter
 * Authentication method: Cookie-based authentication with in-app browser login
 * 
 * Note: Perplexity uses Cloudflare protection, so we cannot validate tokens
 * via API calls. We accept cookies directly as valid credentials.
 */

import { BaseOAuthAdapter } from './base'
import {
  OAuthResult,
  OAuthOptions,
  TokenValidationResult,
  CredentialInfo,
  AdapterConfig,
  OAuthCallbackData,
} from '../types'

const PERPLEXITY_WEB_BASE = 'https://www.perplexity.ai'

export class PerplexityAdapter extends BaseOAuthAdapter {
  constructor(config: AdapterConfig) {
    super({
      ...config,
      providerType: 'perplexity',
      authMethods: ['manual', 'cookie'],
      loginUrl: PERPLEXITY_WEB_BASE,
      apiUrl: PERPLEXITY_WEB_BASE,
    })
  }

  async startLogin(options: OAuthOptions): Promise<OAuthResult> {
    return {
      success: false,
      providerId: options.providerId,
      providerType: 'perplexity',
      error: 'Use startInAppLogin for automatic cookie extraction',
    }
  }

  async loginWithCookies(providerId: string, cookies: Record<string, string>): Promise<OAuthResult> {
    this.emitProgress('pending', 'Validating cookies...')

    const sessionToken = cookies['__Secure-next-auth.session-token'] ||
                         cookies['next-auth.session-token'] ||
                         cookies['sessionToken']

    if (!sessionToken) {
      return {
        success: false,
        providerId,
        providerType: 'perplexity',
        error: 'Session token is required (__Secure-next-auth.session-token or next-auth.session-token)',
      }
    }

    this.emitProgress('success', 'Cookie validation successful')

    return {
      success: true,
      providerId,
      providerType: 'perplexity',
      credentials: {
        sessionToken: sessionToken,
      },
      accountInfo: {
        name: 'Perplexity User',
      },
    }
  }

  protected async processCallback(data: OAuthCallbackData): Promise<void> {
  }

  async validateToken(credentials: Record<string, string>): Promise<TokenValidationResult> {
    const sessionToken = credentials['__Secure-next-auth.session-token'] ||
                         credentials['next-auth.session-token'] ||
                         credentials['sessionToken'] ||
                         credentials['token']

    if (!sessionToken) {
      return {
        valid: false,
        error: 'Session token is required (__Secure-next-auth.session-token or next-auth.session-token)',
      }
    }

    return {
      valid: true,
      tokenType: 'cookie',
      accountInfo: {
        name: 'Perplexity User',
      },
    }
  }

  async refreshToken(credentials: Record<string, string>): Promise<CredentialInfo | null> {
    const sessionToken = credentials['__Secure-next-auth.session-token'] ||
                         credentials['next-auth.session-token'] ||
                         credentials['sessionToken'] ||
                         credentials['token']

    if (!sessionToken) {
      return null
    }

    return {
      type: 'cookie',
      value: sessionToken,
      extra: credentials,
    }
  }
}

export default PerplexityAdapter
