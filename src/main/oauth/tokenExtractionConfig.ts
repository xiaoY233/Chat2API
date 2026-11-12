/**
 * Token Extraction Configuration
 * Defines how to extract tokens from different providers
 */

import { ProviderType } from './types'
import { INCEPTION_USER_AGENT } from '../providers/inception'

export type TokenSourceType = 'networkHeader' | 'localStorage' | 'cookie' | 'cookieJar'

export interface TokenSource {
  type: TokenSourceType
  key: string
  urlPattern?: string
  extractPattern?: string
  /** cookieJar: cookie domains to collect (e.g. ['longcat.ai']) */
  cookieDomains?: string[]
  /** cookieJar: endpoint used to confirm the session before emitting */
  probeUrl?: string
  /** cookieJar: dot path in the JSON response that must equal 1 */
  probeLoginStatusPath?: string
}

export interface TokenExtractionConfig {
  loginUrl: string
  tokenSources: TokenSource[]
  targetDomains: string[]
  successUrlPatterns?: RegExp[]
  windowTitle?: string
  windowWidth?: number
  windowHeight?: number
  /**
   * Optional User-Agent used by the in-app login window and the cookieJar
   * probe. Providers whose cookie is bound to a specific UA (e.g. the Vercel
   * clearance cookie) must set this so the captured cookie matches the UA the
   * proxy adapter later sends.
   */
  userAgent?: string
}

export const TOKEN_EXTRACTION_CONFIGS: Record<ProviderType, TokenExtractionConfig> = {
  kimi: {
    loginUrl: 'https://www.kimi.com',
    tokenSources: [
      {
        type: 'networkHeader',
        key: 'token',
        urlPattern: '*://*.kimi.com/*',
        extractPattern: '^Bearer\\s+(.+)$',
      },
    ],
    targetDomains: ['.kimi.com', 'kimi.com'],
    successUrlPatterns: [/kimi\.com/i],
    windowTitle: 'Kimi Login',
  },

  deepseek: {
    loginUrl: 'https://chat.deepseek.com',
    tokenSources: [
      {
        type: 'localStorage',
        key: 'userToken',
      },
    ],
    targetDomains: ['.deepseek.com', 'deepseek.com'],
    successUrlPatterns: [/chat\.deepseek\.com/i],
    windowTitle: 'DeepSeek Login',
  },

  glm: {
    loginUrl: 'https://chatglm.cn',
    tokenSources: [
      {
        type: 'cookie',
        key: 'chatglm_refresh_token',
      },
    ],
    targetDomains: ['.chatglm.cn', 'chatglm.cn'],
    successUrlPatterns: [/chatglm\.cn/i],
    windowTitle: 'GLM Login',
  },

  qwen: {
    loginUrl: 'https://www.qianwen.com',
    tokenSources: [
      {
        type: 'cookie',
        key: 'tongyi_sso_ticket',
      },
    ],
    targetDomains: ['.qianwen.com', 'qianwen.com'],
    successUrlPatterns: [/qianwen\.com/i],
    windowTitle: 'Qwen Login',
  },

  minimax: {
    loginUrl: 'https://agent.minimaxi.com',
    tokenSources: [
      {
        type: 'localStorage',
        key: '_token',
      },
      {
        type: 'localStorage',
        key: 'user_detail_agent',
      },
    ],
    targetDomains: ['.minimaxi.com', 'minimaxi.com'],
    successUrlPatterns: [/agent\.minimaxi\.com/i],
    windowTitle: 'MiniMax Login',
  },

  zai: {
    loginUrl: 'https://chat.z.ai',
    tokenSources: [
      {
        type: 'localStorage',
        key: 'token',
      },
      {
        type: 'cookie',
        key: 'token',
      },
    ],
    targetDomains: ['.z.ai', 'z.ai', 'chat.z.ai'],
    successUrlPatterns: [/chat\.z\.ai/i, /z\.ai/i],
    windowTitle: 'Z.ai Login',
  },
  mimo: {
    loginUrl: 'https://aistudio.xiaomimimo.com',
    tokenSources: [
      {
        type: 'cookie',
        key: 'serviceToken',
      },
      {
        type: 'cookie',
        key: 'userId',
      },
      {
        type: 'cookie',
        key: 'xiaomichatbot_ph',
      },
    ],
    targetDomains: ['.xiaomimimo.com', 'xiaomimimo.com'],
    successUrlPatterns: [/aistudio\.xiaomimimo\.com/i],
    windowTitle: 'Mimo AI Studio Login',
  },
  'qwen-ai': {
    loginUrl: 'https://chat.qwen.ai',
    tokenSources: [
      {
        type: 'localStorage',
        key: 'token',
      },
      {
        type: 'cookie',
        key: 'token',
      },
    ],
    targetDomains: ['.qwen.ai', 'qwen.ai', 'chat.qwen.ai'],
    successUrlPatterns: [/chat\.qwen\.ai/i, /qwen\.ai/i],
    windowTitle: 'Qwen AI Login',
  },
  longcat: {
    loginUrl: 'https://longcat.ai/chat',
    tokenSources: [
      {
        // Capture the whole longcat.ai cookie jar after login, since the
        // session needs passport_token_key plus optional _lxsdk_* cookies.
        type: 'cookieJar',
        key: 'cookieJar',
        cookieDomains: ['longcat.ai', '.longcat.ai'],
        probeUrl: 'https://longcat.ai/api/v1/user-current',
        probeLoginStatusPath: 'data.loginStatus',
      },
    ],
    targetDomains: ['.longcat.ai', 'longcat.ai', '.meituan.com', 'meituan.com', '.mykeeta.com', 'mykeeta.com'],
    successUrlPatterns: [/longcat\.ai/i],
    windowTitle: 'LongCat Login',
    windowWidth: 1000,
    windowHeight: 760,
  },
  inception: {
    loginUrl: 'https://chat.inceptionlabs.ai/',
    tokenSources: [
      {
        // Capture the whole chat.inceptionlabs.ai cookie jar after the real
        // browser solves the Vercel Security Checkpoint, which stores the
        // _vcrcs clearance cookie. GET /api/session answers { ok: true } once
        // the edge accepts the request.
        type: 'cookieJar',
        key: 'cookie',
        cookieDomains: ['chat.inceptionlabs.ai', '.inceptionlabs.ai'],
        probeUrl: 'https://chat.inceptionlabs.ai/api/session',
        probeLoginStatusPath: 'ok',
      },
    ],
    targetDomains: ['.inceptionlabs.ai', 'chat.inceptionlabs.ai', 'inceptionlabs.ai'],
    successUrlPatterns: [/chat\.inceptionlabs\.ai/i],
    windowTitle: 'Inception (Mercury) Login',
    windowWidth: 1000,
    windowHeight: 760,
    // The Vercel clearance cookie is bound to the UA that solved the
    // challenge, so the login window, the probe, and the adapter must share it.
    userAgent: INCEPTION_USER_AGENT,
  },
  perplexity: {
    loginUrl: 'https://www.perplexity.ai',
    tokenSources: [
      {
        type: 'cookie',
        key: '__Secure-next-auth.session-token',
      },
      {
        type: 'cookie',
        key: 'next-auth.session-token',
      },
    ],
    targetDomains: ['.perplexity.ai', 'perplexity.ai'],
    successUrlPatterns: [/perplexity\.ai/i],
    windowTitle: 'Perplexity Login - Please click Sign In to login',
  },
}

export function getTokenExtractionConfig(providerType: ProviderType): TokenExtractionConfig | null {
  return TOKEN_EXTRACTION_CONFIGS[providerType] || null
}
