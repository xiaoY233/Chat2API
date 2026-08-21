import axios, { AxiosError } from 'axios'
import { getBuiltinProvider } from './builtin'
import { parseProviderModelsResponse } from './modelSync'
import { withQwenAiModelModeAliases } from './qwen-ai-model-mode'
import type { Provider, ProviderCheckResult, Account, ProviderModelCapability } from '../../shared/types'
import type { BuiltinProviderConfig } from '../store/types'

const CHECK_TIMEOUT = 15000

export interface TokenCheckResult {
  valid: boolean
  error?: string
  /** Canonical credentials returned after a provider rotates or normalizes tokens. */
  credentials?: Record<string, string>
  userInfo?: {
    name?: string
    email?: string
    quota?: number
    used?: number
  }
}

export class ProviderChecker {
  static async checkProviderStatus(provider: Provider): Promise<ProviderCheckResult> {
    const startTime = Date.now()
    
    try {
      const builtinConfig = provider.type === 'builtin' 
        ? getBuiltinProvider(provider.id) 
        : null
      
      if (builtinConfig) {
        return await this.checkBuiltinProvider(builtinConfig)
      }
      
      return await this.checkCustomProvider(provider)
    } catch (error) {
      return {
        providerId: provider.id,
        status: 'offline',
        latency: Date.now() - startTime,
        error: error instanceof Error ? error.message : 'Unknown error',
      }
    }
  }

  private static async checkBuiltinProvider(config: BuiltinProviderConfig): Promise<ProviderCheckResult> {
    const startTime = Date.now()
    
    try {
      const checkUrl = `${config.apiEndpoint.replace('/api', '')}${config.tokenCheckEndpoint || '/health'}`
      
      const response = await axios({
        method: 'GET',
        url: checkUrl,
        timeout: CHECK_TIMEOUT,
        validateStatus: () => true,
      })
      
      const latency = Date.now() - startTime
      
      if (response.status >= 200 && response.status < 500) {
        return {
          providerId: config.id,
          status: 'online',
          latency,
        }
      }
      
      return {
        providerId: config.id,
        status: 'offline',
        latency,
        error: `HTTP ${response.status}`,
      }
    } catch (error) {
      return {
        providerId: config.id,
        status: 'offline',
        latency: Date.now() - startTime,
        error: error instanceof Error ? error.message : 'Connection failed',
      }
    }
  }

  private static async checkCustomProvider(provider: Provider): Promise<ProviderCheckResult> {
    const startTime = Date.now()
    
    try {
      const response = await axios({
        method: 'GET',
        url: `${provider.apiEndpoint}/models`,
        headers: provider.headers,
        timeout: CHECK_TIMEOUT,
        validateStatus: () => true,
      })
      
      const latency = Date.now() - startTime
      
      if (response.status >= 200 && response.status < 500) {
        return {
          providerId: provider.id,
          status: 'online',
          latency,
        }
      }
      
      return {
        providerId: provider.id,
        status: 'offline',
        latency,
        error: `HTTP ${response.status}`,
      }
    } catch (error) {
      return {
        providerId: provider.id,
        status: 'offline',
        latency: Date.now() - startTime,
        error: error instanceof Error ? error.message : 'Connection failed',
      }
    }
  }

  static async checkAccountToken(
    provider: Provider,
    account: Account
  ): Promise<TokenCheckResult> {
    const builtinConfig = provider.type === 'builtin' 
      ? getBuiltinProvider(provider.id) 
      : null
    
    if (!builtinConfig) {
      return this.checkCustomAccountToken(provider, account)
    }
    
    switch (provider.id) {
      case 'deepseek':
        return this.checkDeepSeekToken(account.credentials.token)
      case 'glm':
        return this.checkGLMToken(account.credentials.refresh_token)
      case 'kimi':
        return this.checkKimiToken(account.credentials)
      case 'minimax':
        return this.checkMiniMaxToken(
          account.credentials.realUserID || '',
          account.credentials.token
        )
      case 'qwen':
        return this.checkQwenToken(account.credentials.ticket)
      case 'qwen-ai':
        return this.checkQwenAiToken(account.credentials)
      case 'perplexity':
        return this.checkPerplexityToken(account.credentials.sessionToken || account.credentials.token)
      case 'mimo':
        return this.checkMimoToken(
          account.credentials.service_token,
          account.credentials.user_id,
          account.credentials.ph_token
        )
      default:
        if (!builtinConfig.tokenCheckEndpoint) {
          return { valid: true }
        }
        return this.checkGenericToken(builtinConfig, account)
    }
  }

  private static checkMimoToken(
    serviceToken: string,
    userId: string,
    phToken: string
  ): TokenCheckResult {
    if (!serviceToken || !userId || !phToken) {
      return { valid: false, error: 'Missing required credentials: service_token, user_id, ph_token' }
    }

    return {
      valid: true,
      userInfo: {
        name: 'Mimo User',
      },
    }
  }

  private static async checkDeepSeekToken(token: string): Promise<TokenCheckResult> {
    try {
      console.log('[DeepSeek] Validating Token:', token.substring(0, 20) + '...')
      
      const response = await axios.get(
        'https://chat.deepseek.com/api/v0/users/current',
        {
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
            'Accept': '*/*',
            'Origin': 'https://chat.deepseek.com',
            'Referer': 'https://chat.deepseek.com/',
          },
          timeout: CHECK_TIMEOUT,
          validateStatus: () => true,
        }
      )
      
      console.log('[DeepSeek] Response status:', response.status)
      console.log('[DeepSeek] Response data:', JSON.stringify(response.data, null, 2))
      
      // Response format: { code: 0, data: { biz_data: { ... } } }
      if (response.status === 200 && response.data?.code === 0 && response.data?.data?.biz_data) {
        const bizData = response.data.data.biz_data
        return {
          valid: true,
          userInfo: {
            name: bizData.id_profile?.name,
            email: bizData.email,
          },
        }
      }
      
      if (response.status === 401 || response.data?.code === 40003 || response.data?.data?.biz_code === 40003) {
        return { valid: false, error: 'Token expired or invalid' }
      }
      
      return { valid: false, error: `Validation failed: ${response.data?.msg || response.data?.message || JSON.stringify(response.data)}` }
    } catch (error) {
      console.error('[DeepSeek] Validation error:', error)
      return {
        valid: false,
        error: error instanceof AxiosError 
          ? error.message 
          : 'Connection failed',
      }
    }
  }

  private static async checkGLMToken(refreshToken: string): Promise<TokenCheckResult> {
    try {
      console.log('[GLM] Validating Token:', refreshToken.substring(0, 20) + '...')
      
      const sign = await this.generateGLMSignV2()
      
      const response = await axios.post(
        'https://chatglm.cn/chatglm/user-api/user/refresh',
        {},
        {
          headers: {
            'Accept': 'text/event-stream',
            'Accept-Encoding': 'gzip, deflate, br, zstd',
            'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8,en-GB;q=0.7,en-US;q=0.6',
            'App-Name': 'chatglm',
            'Cache-Control': 'no-cache',
            'Content-Type': 'application/json',
            'Origin': 'https://chatglm.cn',
            'Pragma': 'no-cache',
            'Priority': 'u=1, i',
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
            'X-Exp-Groups': 'na_android_config:exp:NA,na_4o_config:exp:4o_A,tts_config:exp:tts_config_a,na_glm4plus_config:exp:open,mainchat_server_app:exp:A,mobile_history_daycheck:exp:a,desktop_toolbar:exp:A,chat_drawing_server:exp:A,drawing_server_cogview:exp:cogview4,app_welcome_v2:exp:A,chat_drawing_streamv2:exp:A,mainchat_rm_fc:exp:add,mainchat_dr:exp:open,chat_auto_entrance:exp:A,drawing_server_hi_dream:control:A,homepage_square:exp:close,assistant_recommend_prompt:exp:3,app_home_regular_user:exp:A,memory_common:exp:enable,mainchat_moe:exp:300,assistant_greet_user:exp:greet_user,app_welcome_personalize:exp:A,assistant_model_exp_group:exp:glm4.5,ai_wallet:exp:ai_wallet_enable',
            'X-Lang': 'zh',
            'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36',
            Authorization: `Bearer ${refreshToken}`,
            'X-Device-Id': this.generateUUID().replace(/-/g, ''),
            'X-Nonce': sign.nonce,
            'X-Request-Id': this.generateUUID().replace(/-/g, ''),
            'X-Sign': sign.sign,
            'X-Timestamp': `${sign.timestamp}`,
          },
          timeout: CHECK_TIMEOUT,
          validateStatus: () => true,
        }
      )
      
      console.log('[GLM] Response status:', response.status)
      console.log('[GLM] Response data:', JSON.stringify(response.data, null, 2))
      
      if (response.status === 200 && response.data?.result?.access_token) {
        return {
          valid: true,
          userInfo: {
            name: response.data.result.user?.name,
          },
        }
      }
      
      if (response.status === 401 || response.data?.status === 40001) {
        return { valid: false, error: 'Token expired or invalid' }
      }
      
      return { valid: false, error: `Validation failed: ${response.data?.message || response.data?.msg || JSON.stringify(response.data)}` }
    } catch (error) {
      console.error('[GLM] Validation error:', error)
      return {
        valid: false,
        error: error instanceof AxiosError 
          ? error.message 
          : 'Connection failed',
      }
    }
  }
  
  private static async generateGLMSignV2(): Promise<{ timestamp: string; nonce: string; sign: string }> {
    const crypto = await import('crypto')
    const secret = '8a1317a7468aa3ad86e997d08f3f31cb'
    
    // GLM timestamp algorithm
    const now = Date.now()
    const timestampStr = now.toString()
    const len = timestampStr.length
    const digits = timestampStr.split('').map(d => parseInt(d))
    const sum = digits.reduce((a, b) => a + b, 0) - digits[len - 2]
    const checkDigit = sum % 10
    const timestamp = timestampStr.substring(0, len - 2) + checkDigit + timestampStr.substring(len - 1)
    
    // Random UUID (no separators)
    const nonce = this.generateUUID().replace(/-/g, '')
    
    // Signature
    const sign = crypto.createHash('md5').update(`${timestamp}-${nonce}-${secret}`).digest('hex')
    
    return { timestamp, nonce, sign }
  }

  private static normalizeKimiToken(value: unknown): string {
    return typeof value === 'string'
      ? value.trim().replace(/^Bearer\s+/i, '').trim()
      : ''
  }

  private static parseKimiAccessToken(token: string): Record<string, unknown> | null {
    if (!token.startsWith('eyJ') || token.split('.').length !== 3) return null

    try {
      const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'))
      return payload?.app_id === 'kimi' && payload?.typ === 'access' ? payload : null
    } catch {
      return null
    }
  }

  private static parseKimiTokenClaims(token: string): Record<string, unknown> | null {
    if (!token.startsWith('eyJ') || token.split('.').length !== 3) return null

    try {
      const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'))
      return payload && typeof payload === 'object' ? payload : null
    } catch {
      return null
    }
  }

  private static getKimiHeaders(
    credentials: Record<string, string>,
    token: string
  ): Record<string, string> {
    const claims = this.parseKimiTokenClaims(token)
    const deviceId = credentials.deviceId || credentials.device_id || credentials.webId
      || credentials.web_id || (typeof claims?.device_id === 'string' ? claims.device_id : '')
    const sessionId = credentials.sessionId || credentials.session_id || credentials.ssid
      || (typeof claims?.ssid === 'string' ? claims.ssid : '')
    const trafficId = credentials.trafficId || credentials.traffic_id || credentials.mshUserId
      || credentials.msh_user_id || credentials.userId || credentials.user_id
      || (typeof claims?.sub === 'string' ? claims.sub : '')

    return {
      Authorization: `Bearer ${token}`,
      Accept: '*/*',
      Origin: 'https://www.kimi.com',
      Referer: 'https://www.kimi.com/',
      'R-Timezone': Intl.DateTimeFormat().resolvedOptions().timeZone || 'Asia/Shanghai',
      'Connect-Protocol-Version': '1',
      'x-msh-version': '2.0.0',
      'x-msh-platform': 'web',
      'x-msh-device-id': deviceId,
      'x-msh-session-id': sessionId,
      'X-Traffic-Id': trafficId,
    }
  }

  private static async checkKimiToken(credentials: Record<string, string>): Promise<TokenCheckResult> {
    try {
      const accessCandidates = [
        credentials.access_token,
        credentials.accessToken,
        credentials.token,
        credentials.kimiAuth,
        credentials['kimi-auth'],
      ].map((value) => this.normalizeKimiToken(value)).filter(Boolean)
      let accessToken = accessCandidates.find((value) => Boolean(this.parseKimiAccessToken(value))) || ''
      let refreshToken = [credentials.refreshToken, credentials.refresh_token]
        .map((value) => this.normalizeKimiToken(value))
        .find(Boolean)
        || accessCandidates.find((value) => value !== accessToken && !this.parseKimiAccessToken(value))
        || ''
      let credentialsChanged = false

      const accessClaims = accessToken ? this.parseKimiAccessToken(accessToken) : null
      const accessExpired = typeof accessClaims?.exp === 'number'
        && accessClaims.exp <= Math.floor(Date.now() / 1000) + 60
      if ((!accessToken || accessExpired) && refreshToken) {
        const refreshResponse = await axios.get(
          'https://www.kimi.com/api/auth/token/refresh',
          {
            headers: this.getKimiHeaders(credentials, refreshToken),
            timeout: CHECK_TIMEOUT,
            validateStatus: () => true,
          }
        )
        const refreshData = refreshResponse.data?.data && typeof refreshResponse.data.data === 'object'
          ? refreshResponse.data.data
          : refreshResponse.data
        const refreshedAccessToken = this.normalizeKimiToken(
          refreshData?.access_token || refreshData?.accessToken || refreshData?.token,
        )
        if (refreshResponse.status !== 200 || !this.parseKimiAccessToken(refreshedAccessToken)) {
          return { valid: false, error: 'Refresh Token expired or invalid' }
        }
        accessToken = refreshedAccessToken
        refreshToken = this.normalizeKimiToken(
          refreshData?.refresh_token || refreshData?.refreshToken,
        ) || refreshToken
        credentialsChanged = true
      }

      if (!accessToken || (accessExpired && !refreshToken)) {
        return { valid: false, error: 'Kimi access_token or refresh_token is required' }
      }

      const requestSubscription = (token: string) => axios.post(
        'https://www.kimi.com/apiv2/kimi.gateway.order.v1.SubscriptionService/GetSubscription',
        {},
        {
          headers: {
            ...this.getKimiHeaders(credentials, token),
            'Content-Type': 'application/json',
          },
          timeout: CHECK_TIMEOUT,
          validateStatus: () => true,
        },
      )

      let response = await requestSubscription(accessToken)
      let subscription = response.data?.subscription || response.data?.data?.subscription

      // An access JWT can be revoked before its exp claim.  Give the saved
      // refresh token one chance to rotate it before reporting the account as
      // invalid, matching the runtime adapter's 401 recovery behavior.
      if ((!subscription || response.status === 401) && refreshToken && !credentialsChanged) {
        const refreshResponse = await axios.get(
          'https://www.kimi.com/api/auth/token/refresh',
          {
            headers: this.getKimiHeaders(credentials, refreshToken),
            timeout: CHECK_TIMEOUT,
            validateStatus: () => true,
          },
        )
        const refreshData = refreshResponse.data?.data && typeof refreshResponse.data.data === 'object'
          ? refreshResponse.data.data
          : refreshResponse.data
        const refreshedAccessToken = this.normalizeKimiToken(
          refreshData?.access_token || refreshData?.accessToken || refreshData?.token,
        )
        if (refreshResponse.status === 200 && this.parseKimiAccessToken(refreshedAccessToken)) {
          accessToken = refreshedAccessToken
          refreshToken = this.normalizeKimiToken(
            refreshData?.refresh_token || refreshData?.refreshToken,
          ) || refreshToken
          credentialsChanged = true
          response = await requestSubscription(accessToken)
          subscription = response.data?.subscription || response.data?.data?.subscription
        }
      }

      if (response.status === 200 && subscription) {
        const nextCredentials = credentialsChanged
          ? {
              token: accessToken,
              accessToken,
              ...(Object.prototype.hasOwnProperty.call(credentials, 'access_token')
                ? { access_token: accessToken }
                : {}),
              ...(refreshToken ? { refreshToken } : {}),
              ...(refreshToken && Object.prototype.hasOwnProperty.call(credentials, 'refresh_token')
                ? { refresh_token: refreshToken }
                : {}),
              ...(credentials.deviceId || credentials.device_id || credentials.webId || credentials.web_id
                ? { deviceId: credentials.deviceId || credentials.device_id || credentials.webId || credentials.web_id }
                : {}),
              ...(credentials.sessionId || credentials.session_id || credentials.ssid
                ? { sessionId: credentials.sessionId || credentials.session_id || credentials.ssid }
                : {}),
              ...(credentials.trafficId || credentials.traffic_id || credentials.mshUserId || credentials.msh_user_id
                || credentials.userId || credentials.user_id
                ? {
                    trafficId: credentials.trafficId || credentials.traffic_id || credentials.mshUserId
                      || credentials.msh_user_id || credentials.userId || credentials.user_id,
                  }
                : {}),
            }
          : undefined
        return {
          valid: true,
          ...(nextCredentials ? { credentials: nextCredentials } : {}),
          userInfo: {
            name: subscription.userName,
          },
        }
      }
      
      return { valid: false, error: 'Token expired or invalid' }
    } catch (error) {
      console.error('[Kimi] Validation error:', error)
      return {
        valid: false,
        error: error instanceof AxiosError 
          ? error.message 
          : 'Connection failed',
      }
    }
  }

  private static async checkMiniMaxToken(
    _realUserID: string,
    token: string
  ): Promise<TokenCheckResult> {
    try {
      console.log('[MiniMax] Validating Token:', token.substring(0, 30) + '...')
      
      const crypto = await import('crypto')
      
      let realUserID = ''
      let jwtToken = token
      
      if (token.includes('+')) {
        const parts = token.split('+')
        realUserID = parts[0]
        jwtToken = parts[1]
      } else {
        try {
          const parts = token.split('.')
          if (parts.length >= 2) {
            let payload = parts[1]
            const padding = payload.length % 4
            if (padding > 0) {
              payload += '='.repeat(4 - padding)
            }
            payload = payload.replace(/-/g, '+').replace(/_/g, '/')
            const decoded = Buffer.from(payload, 'base64').toString('utf8')
            const data = JSON.parse(decoded)
            realUserID = data.user?.id || data.id || data.sub || ''
            console.log('[MiniMax] Extracted userId from token:', realUserID)
          }
        } catch (e) {
          console.log('[MiniMax] Failed to parse JWT:', e)
        }
      }
      
      if (!realUserID) {
        return { valid: false, error: 'Cannot extract user ID from token' }
      }
      
      const uuid = realUserID
      const unix = Date.now().toString()
      const timestamp = Math.floor(Date.now() / 1000)
      const dataJson = JSON.stringify({ uuid })
      
      const signature = crypto.createHash('md5').update(`${timestamp}${jwtToken}${dataJson}`).digest('hex')
      
      const queryParams = new URLSearchParams({
        device_platform: 'web',
        biz_id: '3',
        app_id: '3001',
        version_code: '22201',
        uuid: uuid,
        user_id: realUserID,
      }).toString()
      
      const fullUri = `/v1/api/user/device/register?${queryParams}`
      const yy = crypto.createHash('md5').update(`${encodeURIComponent(fullUri)}_${dataJson}${crypto.createHash('md5').update(unix).digest('hex')}ooui`).digest('hex')
      
      const response = await axios.post(
        `https://agent.minimaxi.com${fullUri}`,
        { uuid },
        {
          headers: {
            'Accept': 'application/json, text/plain, */*',
            'Accept-Encoding': 'gzip, deflate, br, zstd',
            'Accept-Language': 'zh-CN,zh;q=0.9',
            'Cache-Control': 'no-cache',
            'Content-Type': 'application/json',
            'Origin': 'https://agent.minimaxi.com',
            'Pragma': 'no-cache',
            'Referer': 'https://agent.minimaxi.com/',
            'Sec-Ch-Ua': '"Not:A-Brand";v="99", "Google Chrome";v="145", "Chromium";v="145"',
            'Sec-Ch-Ua-Mobile': '?0',
            'Sec-Ch-Ua-Platform': '"macOS"',
            'Sec-Fetch-Dest': 'empty',
            'Sec-Fetch-Mode': 'cors',
            'Sec-Fetch-Site': 'same-origin',
            'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36',
            'token': jwtToken,
            'x-timestamp': String(timestamp),
            'x-signature': signature,
            'yy': yy,
          },
          timeout: CHECK_TIMEOUT,
          validateStatus: () => true,
        }
      )
      
      console.log('[MiniMax] Response status:', response.status)
      console.log('[MiniMax] Response data:', JSON.stringify(response.data, null, 2))
      
      if (response.status === 200 && response.data?.data?.deviceIDStr) {
        const userInfo = response.data.data.userInfo
        return {
          valid: true,
          userInfo: {
            name: userInfo?.name || userInfo?.nickname,
            email: userInfo?.email,
          },
        }
      }
      
      if (response.data?.statusInfo?.code === 1001) {
        return { valid: false, error: 'Token expired or invalid' }
      }
      
      return { valid: false, error: `Validation failed: ${response.data?.statusInfo?.message || 'Unknown error'}` }
    } catch (error) {
      console.error('[MiniMax] Validation error:', error)
      return {
        valid: false,
        error: error instanceof AxiosError 
          ? error.message 
          : 'Connection failed',
      }
    }
  }

  private static async checkQwenToken(ticket: string): Promise<TokenCheckResult> {
    try {
      const response = await axios.post(
        'https://chat2-api.qianwen.com/api/v2/session/page/list',
        {},
        {
          headers: {
            Cookie: `tongyi_sso_ticket=${ticket}`,
            'Content-Type': 'application/json',
            'Accept': '*/*',
            'Origin': 'https://www.qianwen.com',
            'Referer': 'https://www.qianwen.com/',
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
          timeout: CHECK_TIMEOUT,
          validateStatus: () => true,
        }
      )
      
      if (response.status === 200 && response.data?.success) {
        return {
          valid: true,
        }
      }
      
      if (!response.data?.success) {
        return { valid: false, error: 'SSO ticket expired or invalid' }
      }
      
      return { valid: false, error: `Validation failed: ${response.data?.errorMsg || 'Unknown error'}` }
    } catch (error) {
      return {
        valid: false,
        error: error instanceof AxiosError 
          ? error.message 
          : 'Connection failed',
      }
    }
  }

  private static getQwenAiCookieHeader(cookies: unknown): string {
    if (typeof cookies === 'string') {
      return cookies
    }

    if (cookies && typeof cookies === 'object' && !Array.isArray(cookies)) {
      return Object.entries(cookies as Record<string, unknown>)
        .filter(([, value]) => typeof value === 'string' && value)
        .map(([key, value]) => `${key}=${value}`)
        .join('; ')
    }

    return ''
  }

  private static async checkQwenAiToken(credentials: Record<string, unknown>): Promise<TokenCheckResult> {
    const token = typeof credentials.token === 'string' ? credentials.token : ''

    if (!token) {
      return { valid: false, error: 'Token is required' }
    }

    try {
      const headers: Record<string, string> = {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
        source: 'web',
        Version: '0.2.67',
        Timezone: new Date().toString().replace(/\s*\(.+\)$/, ''),
      }
      const cookieHeader = this.getQwenAiCookieHeader(credentials.cookies || credentials.cookie)
      if (cookieHeader) {
        headers.Cookie = cookieHeader
      }

      const response = await axios.get(
        'https://chat.qwen.ai/api/v2/users/user/settings',
        {
          headers,
          timeout: CHECK_TIMEOUT,
          validateStatus: () => true,
        }
      )

      if (response.status === 200 && response.data?.success !== false && response.data?.data) {
        const userInfo = response.data.data.user || response.data.data.user_info || response.data.data
        return {
          valid: true,
          userInfo: {
            name: userInfo.name || userInfo.email,
            email: userInfo.email,
          },
        }
      }

      if (response.status === 401) {
        return { valid: false, error: 'Token expired or invalid' }
      }

      const upstreamError = response.data?.message || response.data?.msg || response.data?.data?.details || response.data?.data?.code
      return { valid: false, error: `Validation failed: HTTP ${response.status}${upstreamError ? ` ${upstreamError}` : ''}` }
    } catch (error) {
      return {
        valid: false,
        error: error instanceof AxiosError
          ? error.message
          : 'Connection failed',
      }
    }
  }

  private static checkPerplexityToken(sessionToken: string): TokenCheckResult {
    if (!sessionToken) {
      return { valid: false, error: 'Session token is required' }
    }

    if (sessionToken.length < 100) {
      return { valid: false, error: 'Session token appears to be invalid (too short)' }
    }

    return {
      valid: true,
      userInfo: {
        name: 'Perplexity User',
      },
    }
  }

  private static async checkGenericToken(
    config: BuiltinProviderConfig,
    account: Account
  ): Promise<TokenCheckResult> {
    try {
      const headers: Record<string, string> = {
        ...config.headers,
      }
      
      const credentials = account.credentials
      if (credentials.token) {
        headers['Authorization'] = `Bearer ${credentials.token}`
      } else if (credentials.apiKey) {
        headers['Authorization'] = `Bearer ${credentials.apiKey}`
      }
      
      const response = await axios({
        method: config.tokenCheckMethod || 'GET',
        url: `${config.apiEndpoint.replace('/api', '')}${config.tokenCheckEndpoint}`,
        headers,
        timeout: CHECK_TIMEOUT,
        validateStatus: () => true,
      })
      
      if (response.status >= 200 && response.status < 300) {
        return { valid: true }
      }
      
      if (response.status === 401) {
        return { valid: false, error: 'Authentication failed, please check credentials' }
      }
      
      return { valid: false, error: `Validation failed: HTTP ${response.status}` }
    } catch (error) {
      return {
        valid: false,
        error: error instanceof AxiosError 
          ? error.message 
          : 'Connection failed',
      }
    }
  }

  private static async checkCustomAccountToken(
    provider: Provider,
    account: Account
  ): Promise<TokenCheckResult> {
    try {
      const headers: Record<string, string> = {
        ...provider.headers,
      }
      
      const credentials = account.credentials
      if (credentials.token) {
        headers['Authorization'] = `Bearer ${credentials.token}`
      } else if (credentials.apiKey) {
        headers['Authorization'] = `Bearer ${credentials.apiKey}`
      }
      
      const response = await axios({
        method: 'GET',
        url: `${provider.apiEndpoint}/models`,
        headers,
        timeout: CHECK_TIMEOUT,
        validateStatus: () => true,
      })
      
      if (response.status >= 200 && response.status < 300) {
        return { valid: true }
      }
      
      if (response.status === 401) {
        return { valid: false, error: 'Authentication failed, please check credentials' }
      }
      
      return { valid: false, error: `Validation failed: HTTP ${response.status}` }
    } catch (error) {
      return {
        valid: false,
        error: error instanceof AxiosError 
          ? error.message 
          : 'Connection failed',
      }
    }
  }

  private static generateUUID(): string {
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
      const r = (Math.random() * 16) | 0
      const v = c === 'x' ? r : (r & 0x3) | 0x8
      return v.toString(16)
    })
  }

  private static async generateGLMSign(timestamp: string, nonce: string): Promise<string> {
    const crypto = await import('crypto')
    const secret = '8a1317a7468aa3ad86e997d08f3f31cb'
    return crypto.createHash('md5').update(`${timestamp}-${nonce}-${secret}`).digest('hex')
  }

  static async fetchProviderModels(
    providerId: string
  ): Promise<{
    supportedModels: string[]
    modelMappings: Record<string, string>
    modelCapabilities: Record<string, ProviderModelCapability>
  }> {
    const builtinConfig = getBuiltinProvider(providerId)
    
    if (!builtinConfig) {
      throw new Error(`Provider ${providerId} not found`)
    }

    if (!builtinConfig.modelsApiEndpoint) {
      throw new Error(`Provider ${providerId} does not support dynamic model fetching`)
    }

    try {
      const headers: Record<string, string> = {
        ...(builtinConfig.modelsApiHeaders || builtinConfig.headers),
      }

      const response = await axios.get(builtinConfig.modelsApiEndpoint, {
        headers,
        timeout: CHECK_TIMEOUT,
        validateStatus: () => true,
      })

      if (response.status !== 200) {
        throw new Error(`Failed to fetch models: HTTP ${response.status}`)
      }

      const parsedModels = parseProviderModelsResponse(response.data)
      const { supportedModels, modelMappings, modelCapabilities } = providerId === 'qwen-ai'
        ? withQwenAiModelModeAliases(parsedModels)
        : parsedModels

      return { supportedModels, modelMappings, modelCapabilities }
    } catch (error) {
      console.error(`[ProviderChecker] Failed to fetch models for ${providerId}:`, error)
      throw error
    }
  }
}

export default ProviderChecker
