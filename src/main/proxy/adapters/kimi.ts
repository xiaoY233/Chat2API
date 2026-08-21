/**
 * Kimi web adapter
 * Implements Kimi web API protocol with thinking mode and web search support
 */

import axios, { AxiosResponse } from 'axios'
import { randomUUID } from 'crypto'
import { Account, Provider } from '../../store/types'
import { storeManager } from '../../store/store'
import { PassThrough } from 'stream'
import { toolsToSystemPrompt, TOOL_WRAP_HINT, hasToolPromptInjected } from '../utils/tools'
import { parseToolCallsFromText } from '../utils/toolParser'
import { createBaseChunk } from '../utils/streamToolHandler'
import { createKimiChatPayload, encodeKimiGrpcFrame } from './providerModelOptions'
import { getProviderToolProfile } from '../toolCalling/providerProfiles'
import { ToolStreamParser } from '../toolCalling/ToolStreamParser'
import type { ToolCallingPlan } from '../toolCalling/types'

const KIMI_API_BASE = 'https://www.kimi.com'

const FAKE_HEADERS: Record<string, string> = {
  Accept: '*/*',
  'Accept-Encoding': 'gzip, deflate, br, zstd',
  'Accept-Language': 'zh-CN,zh;q=0.9,en-US;q=0.8,en;q=0.7',
  'Cache-Control': 'no-cache',
  Pragma: 'no-cache',
  Origin: KIMI_API_BASE,
  'Sec-Ch-Ua': '"Google Chrome";v="131", "Chromium";v="131", "Not_A Brand";v="24"',
  'Sec-Ch-Ua-Mobile': '?0',
  'Sec-Ch-Ua-Platform': '"Windows"',
  'Sec-Fetch-Dest': 'empty',
  'Sec-Fetch-Mode': 'cors',
  'Sec-Fetch-Site': 'same-origin',
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  Priority: 'u=1, i',
}

interface TokenInfo {
  accessToken: string
  refreshToken: string
  userId: string
  refreshTime: number
}

interface KimiMessage {
  role: 'user' | 'assistant' | 'system' | 'tool'
  content: string | any[] | null
  tool_call_id?: string
  tool_calls?: any[]
}

type PreparedKimiMessage = KimiMessage & {
  sourceRole: KimiMessage['role']
}

interface ChatCompletionRequest {
  model: string
  originalModel?: string
  messages: KimiMessage[]
  stream?: boolean
  temperature?: number
  enableThinking?: boolean
  enableWebSearch?: boolean
  reasoningEffort?: 'low' | 'medium' | 'high'
  tools?: any[]
  tool_choice?: any
  conversationId?: string
  parentId?: string
  projectId?: string
  signal?: AbortSignal
}

const accessTokenMap = new Map<string, TokenInfo>()
// Keep the account revision that produced each cached token.  Account
// objects are selected before a request enters the forwarder and can be
// stale by the time token acquisition starts; this metadata lets us avoid
// replacing a freshly rotated token with that stale snapshot.
const accessTokenRevisionMap = new Map<string, { accountUpdatedAt: number; cachedAt: number }>()
const invalidatedAccessTokenMap = new Map<string, string>()
const refreshPromiseMap = new Map<string, Promise<TokenInfo>>()
const recentRefreshMap = new Map<string, { result: TokenInfo; expiresAt: number }>()
const RECENT_REFRESH_TTL_MS = 30_000
const RECENT_REFRESH_LIMIT = 128

function unixTimestamp(): number {
  return Math.floor(Date.now() / 1000)
}

function normalizeToken(value: unknown): string {
  return typeof value === 'string'
    ? value.trim().replace(/^Bearer\s+/i, '').trim()
    : ''
}

function hasOwn(object: object, key: PropertyKey): boolean {
  return Object.prototype.hasOwnProperty.call(object, key)
}

function cleanupRecentRefreshes(): void {
  const now = Date.now()
  recentRefreshMap.forEach((entry, token) => {
    if (entry.expiresAt <= now) recentRefreshMap.delete(token)
  })
  if (recentRefreshMap.size > RECENT_REFRESH_LIMIT) {
    const oldest = Array.from(recentRefreshMap.entries())
      .sort(([, left], [, right]) => left.expiresAt - right.expiresAt)
      .slice(0, recentRefreshMap.size - RECENT_REFRESH_LIMIT)
    oldest.forEach(([token]) => recentRefreshMap.delete(token))
  }
}

export function detectTokenType(token: string): 'jwt' | 'refresh' {
  if (token.startsWith('eyJ') && token.split('.').length === 3) {
    try {
      const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64').toString())
      if (payload.app_id === 'kimi' && payload.typ === 'access') {
        return 'jwt'
      }
    } catch (e) {
      // Parse failed, treat as refresh token
    }
  }
  return 'refresh'
}

function parseJWTPayload(token: string): Record<string, unknown> | undefined {
  try {
    return JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'))
  } catch {
    return undefined
  }
}

function extractUserIdFromJWT(token: string): string | undefined {
  const userId = parseJWTPayload(token)?.sub
  return typeof userId === 'string' ? userId : undefined
}

function getAccessTokenRefreshTime(token: string): number {
  const exp = parseJWTPayload(token)?.exp
  if (typeof exp === 'number' && Number.isFinite(exp)) {
    return Math.max(unixTimestamp(), exp - 60)
  }
  return unixTimestamp() + 300
}

function isAccessTokenUsable(token: string): boolean {
  if (detectTokenType(token) !== 'jwt') return false
  const exp = parseJWTPayload(token)?.exp
  return typeof exp !== 'number' || exp > unixTimestamp() + 60
}

function checkResult(result: AxiosResponse, onAuthError?: () => void): any {
  if (result.status === 401) {
    onAuthError?.()
    const error = new Error('Token invalid or expired')
    Object.assign(error, { status: 401, retryable: false })
    throw error
  }
  if (!result.data) {
    return null
  }
  const { error_type, message } = result.data
  if (typeof error_type !== 'string') {
    return result.data
  }
  if (error_type === 'auth.token.invalid') {
    onAuthError?.()
  }
  const error = new Error(`Kimi API error: ${message || error_type}`)
  Object.assign(error, {
    status: typeof result.status === 'number' && result.status >= 400 ? result.status : undefined,
    retryable: result.status >= 500 || result.status === 429,
  })
  throw error
}

export class KimiAdapter {
  private provider: Provider
  private account: Account

  constructor(provider: Provider, account: Account) {
    this.provider = provider
    this.account = account
  }

  private refreshAccountSnapshot(): void {
    // Forwarder instances hold an account snapshot.  A parallel request may
    // rotate credentials while this instance is waiting, so re-read the
    // decrypted account immediately before token selection.  The fallback is
    // intentional for isolated adapter tests and custom in-memory stores.
    try {
      const current = storeManager.getAccountById(this.account.id, true)
      if (current) {
        this.account = {
          ...this.account,
          ...current,
          credentials: { ...current.credentials },
        }
      }
    } catch {
      // Storage may not be initialized in a standalone adapter invocation.
    }
  }

  private clearCachedToken(): void {
    accessTokenMap.delete(this.account.id)
    accessTokenRevisionMap.delete(this.account.id)
  }

  private getCredentialTokens(): { accessToken: string; refreshToken: string } {
    const credentials = this.account.credentials
    // Browser imports can contain all of access_token, token, kimi-auth and
    // refresh_token at once. Prefer explicitly named access credentials, then
    // select the first JWT-shaped value; never let an opaque cookie hide it.
    const candidates = [
      credentials.access_token,
      credentials.accessToken,
      credentials.token,
      credentials.kimiAuth,
      credentials['kimi-auth'],
    ].map(normalizeToken).filter(Boolean)
    const explicitRefresh = [
      credentials.refreshToken,
      credentials.refresh_token,
    ].map(normalizeToken).find(Boolean) || ''

    const accessToken = candidates.find((candidate) => detectTokenType(candidate) === 'jwt') || ''
    let refreshToken = explicitRefresh
    if (!refreshToken) {
      refreshToken = candidates.find((candidate) => candidate !== accessToken
        && detectTokenType(candidate) === 'refresh') || ''
    }

    return { accessToken, refreshToken }
  }

  private getRequestHeaders(accessToken?: string): Record<string, string> {
    const credentials = this.account.credentials
    const claims = accessToken ? parseJWTPayload(accessToken) : undefined
    const deviceId = credentials.deviceId
      || credentials.device_id
      || credentials.webId
      || credentials.web_id
      || (typeof claims?.device_id === 'string' ? claims.device_id : '')
    const sessionId = credentials.sessionId
      || credentials.session_id
      || credentials.ssid
      || (typeof claims?.ssid === 'string' ? claims.ssid : '')
    const userId = credentials.trafficId
      || credentials.traffic_id
      || credentials.mshUserId
      || credentials.msh_user_id
      || credentials.userId
      || credentials.user_id
      || (typeof claims?.sub === 'string' ? claims.sub : '')

    return {
      ...FAKE_HEADERS,
      'Connect-Protocol-Version': '1',
      'x-msh-version': '2.0.0',
      'x-msh-platform': 'web',
      'x-msh-device-id': deviceId,
      'x-msh-session-id': sessionId,
      'X-Traffic-Id': userId,
      'R-Timezone': Intl.DateTimeFormat().resolvedOptions().timeZone || 'Asia/Shanghai',
      Referer: `${KIMI_API_BASE}/`,
      ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
    }
  }

  private async requestRefreshedToken(refreshToken: string): Promise<TokenInfo> {
    const response = await axios.get(`${KIMI_API_BASE}/api/auth/token/refresh`, {
      headers: this.getRequestHeaders(refreshToken),
      timeout: 15000,
      validateStatus: () => true,
    })

    const responseData = response.data?.data && typeof response.data.data === 'object'
      ? response.data.data
      : response.data
    const accessToken = normalizeToken(
      responseData?.access_token || responseData?.accessToken || responseData?.token,
    )
    const rotatedRefreshToken = normalizeToken(
      responseData?.refresh_token || responseData?.refreshToken,
    ) || refreshToken

    if (response.status !== 200 || !isAccessTokenUsable(accessToken)) {
      const detail = response.data?.message || response.data?.detail || `HTTP ${response.status}`
      throw new Error(`Kimi token refresh failed: ${detail}`)
    }

    return {
      accessToken,
      refreshToken: rotatedRefreshToken,
      userId: extractUserIdFromJWT(accessToken) || '',
      refreshTime: getAccessTokenRefreshTime(accessToken),
    }
  }

  private persistRefreshedToken(result: TokenInfo, sourceRefreshToken?: string): TokenInfo {
    const normalizedSourceRefreshToken = normalizeToken(sourceRefreshToken)

    // A refresh started with an older snapshot can finish after another
    // request has already rotated the account credentials.  Never let that
    // older result roll the account back.  The cache check also covers test
    // and Docker stores that cannot expose a live account snapshot.
    const cached = accessTokenMap.get(this.account.id)
    if (
      cached
      && cached.accessToken !== result.accessToken
      && normalizedSourceRefreshToken
      && cached.refreshToken
      && cached.refreshToken !== normalizedSourceRefreshToken
    ) {
      return cached
    }

    const currentCredentials = this.account.credentials
    const claims = parseJWTPayload(result.accessToken)
    const nextCredentials: Record<string, string> = {
      ...currentCredentials,
      token: result.accessToken,
      refreshToken: result.refreshToken,
      ...(hasOwn(currentCredentials, 'accessToken') ? { accessToken: result.accessToken } : {}),
      ...(hasOwn(currentCredentials, 'access_token') ? { access_token: result.accessToken } : {}),
      ...(hasOwn(currentCredentials, 'refresh_token') ? { refresh_token: result.refreshToken } : {}),
      ...(typeof claims?.device_id === 'string' && !currentCredentials.deviceId
        ? { deviceId: claims.device_id }
        : {}),
      ...(typeof claims?.ssid === 'string' && !currentCredentials.sessionId
        ? { sessionId: claims.ssid }
        : {}),
    }

    this.account = { ...this.account, credentials: nextCredentials }
    let accountUpdatedAt = this.account.updatedAt || Date.now()
    try {
      const updated = storeManager.updateAccount(this.account.id, { credentials: nextCredentials })
      accountUpdatedAt = updated?.updatedAt || Date.now()
      if (updated) {
        this.account = {
          ...this.account,
          ...updated,
          credentials: { ...nextCredentials },
        }
      }
    } catch (error) {
      console.warn('[Kimi] Token refreshed but could not be persisted:', error)
    }

    // Each account needs its own cache and persistence update even when the
    // network refresh was shared with another adapter instance.
    accessTokenMap.set(this.account.id, result)
    invalidatedAccessTokenMap.delete(this.account.id)
    accessTokenRevisionMap.set(this.account.id, {
      accountUpdatedAt,
      cachedAt: Date.now(),
    })
    return result
  }

  private async refreshAccessToken(refreshToken: string, forceNetwork: boolean = false): Promise<TokenInfo> {
    // Re-read immediately before joining/starting a refresh.  A request can
    // carry an account snapshot from before a previous refresh rotated the
    // refresh token; using the newer token avoids an intermittent 401.
    this.refreshAccountSnapshot()
    const latestCredentials = this.getCredentialTokens()
    if (latestCredentials.refreshToken && latestCredentials.refreshToken !== refreshToken) {
      const latestCached = accessTokenMap.get(this.account.id)
      if (latestCached && isAccessTokenUsable(latestCached.accessToken)) {
        return latestCached
      }
      refreshToken = latestCredentials.refreshToken
    }

    cleanupRecentRefreshes()
    const recent = recentRefreshMap.get(refreshToken)
    if (!forceNetwork && recent && recent.expiresAt > Date.now()) {
      return this.persistRefreshedToken(recent.result, refreshToken)
    }

    let refreshPromise = refreshPromiseMap.get(refreshToken)
    if (!refreshPromise) {
      refreshPromise = this.requestRefreshedToken(refreshToken)
      refreshPromiseMap.set(refreshToken, refreshPromise)
    }

    try {
      const result = await refreshPromise
      recentRefreshMap.set(refreshToken, {
        result,
        expiresAt: Date.now() + RECENT_REFRESH_TTL_MS,
      })
      cleanupRecentRefreshes()
      return this.persistRefreshedToken(result, refreshToken)
    } catch (error) {
      this.clearCachedToken()
      throw error
    } finally {
      if (refreshPromiseMap.get(refreshToken) === refreshPromise) {
        refreshPromiseMap.delete(refreshToken)
      }
    }
  }

  private async acquireToken(forceRefresh: boolean = false): Promise<{ accessToken: string; userId: string }> {
    this.refreshAccountSnapshot()
    const credentials = this.getCredentialTokens()
    if (!credentials.accessToken && !credentials.refreshToken) {
      throw new Error('Kimi Token not configured')
    }

    const invalidatedAccessToken = invalidatedAccessTokenMap.get(this.account.id)
    if (invalidatedAccessToken !== undefined) {
      if (invalidatedAccessToken && credentials.accessToken && invalidatedAccessToken !== credentials.accessToken) {
        invalidatedAccessTokenMap.delete(this.account.id)
      } else {
        forceRefresh = true
      }
    }

    const cached = accessTokenMap.get(this.account.id)
    const cacheMatchesCredentials = cached
      && ((Boolean(credentials.accessToken) && cached.accessToken === credentials.accessToken)
        || (Boolean(credentials.refreshToken) && cached.refreshToken === credentials.refreshToken))
    if (!forceRefresh && cached && cacheMatchesCredentials && cached.refreshTime > unixTimestamp()) {
      console.log('[Kimi] Using cached token')
      return { accessToken: cached.accessToken, userId: cached.userId }
    }

    // If the account snapshot is older than a cached rotated token, prefer
    // the cache.  Without this guard a delayed request can write its still
    // usable (but revoked/old) access token back over the fresh token.
    const cachedRevision = accessTokenRevisionMap.get(this.account.id)
    const snapshotUpdatedAt = this.account.updatedAt || 0
    const cacheWasProducedAtOrAfterSnapshot = !cachedRevision
      || cachedRevision.accountUpdatedAt >= snapshotUpdatedAt
    if (!forceRefresh && cached && isAccessTokenUsable(cached.accessToken)
      && cached.refreshTime > unixTimestamp()
      && credentials.accessToken !== cached.accessToken
      && cacheWasProducedAtOrAfterSnapshot
      && (
        !credentials.refreshToken
        || !cached.refreshToken
        || cached.refreshToken !== credentials.refreshToken
      )) {
      return { accessToken: cached.accessToken, userId: cached.userId }
    }

    if (!forceRefresh && credentials.accessToken && isAccessTokenUsable(credentials.accessToken)) {
      const userId = extractUserIdFromJWT(credentials.accessToken) || ''
      accessTokenMap.set(this.account.id, {
        accessToken: credentials.accessToken,
        refreshToken: credentials.refreshToken,
        userId,
        refreshTime: getAccessTokenRefreshTime(credentials.accessToken),
      })
      accessTokenRevisionMap.set(this.account.id, {
        accountUpdatedAt: this.account.updatedAt || Date.now(),
        cachedAt: Date.now(),
      })
      return { accessToken: credentials.accessToken, userId }
    }

    if (!credentials.refreshToken) {
      throw new Error('Kimi access token expired; import a refresh token or log in again')
    }

    const refreshed = await this.refreshAccessToken(credentials.refreshToken, forceRefresh)
    return { accessToken: refreshed.accessToken, userId: refreshed.userId }
  }

  invalidateAccessToken(rejectedAccessToken: string): boolean {
    const rejectedToken = normalizeToken(rejectedAccessToken)
    if (!rejectedToken) return false

    this.refreshAccountSnapshot()
    const cached = accessTokenMap.get(this.account.id)
    const cachedRevision = accessTokenRevisionMap.get(this.account.id)
    const credentialAccessToken = this.getCredentialTokens().accessToken
    const snapshotUpdatedAt = this.account.updatedAt || 0
    const cacheIsCurrent = Boolean(
      cached
      && (
        !credentialAccessToken
        || cached.accessToken === credentialAccessToken
        || !cachedRevision
        || cachedRevision.accountUpdatedAt >= snapshotUpdatedAt
      )
    )
    const currentAccessToken = cacheIsCurrent
      ? cached?.accessToken || ''
      : credentialAccessToken

    // A delayed response from a request sent with an older token must not
    // invalidate credentials that another request has already refreshed.
    if (currentAccessToken && currentAccessToken !== rejectedToken) {
      return false
    }

    invalidatedAccessTokenMap.set(this.account.id, rejectedToken)
    if (cached?.accessToken === rejectedToken) {
      this.clearCachedToken()
    }
    return true
  }

  private messageContentToText(content: KimiMessage['content']): string {
    if (typeof content === 'string') return content
    if (content === null || content === undefined) return ''
    if (!Array.isArray(content)) return String(content)

    const textParts: string[] = []
    const unsupportedTypes = new Set<string>()
    for (const part of content) {
      if (typeof part === 'string') {
        textParts.push(part)
        continue
      }
      if (!part || typeof part !== 'object') continue

      const type = typeof part.type === 'string' ? part.type : ''
      if ((type === 'text' || type === 'input_text' || !type) && typeof part.text === 'string') {
        textParts.push(part.text)
        continue
      }
      unsupportedTypes.add(type || 'unknown')
    }

    if (unsupportedTypes.size > 0) {
      throw new Error(
        `Kimi web adapter does not support message content parts: ${Array.from(unsupportedTypes).join(', ')}`,
      )
    }
    return textParts.join('\n')
  }

  private messagesPrepare(messages: KimiMessage[], toolsPrompt?: string, isMultiTurn: boolean = false): string {
    const toolProfile = getProviderToolProfile('kimi')
    // Process messages including tool calls and tool responses
    const processedMessages: PreparedKimiMessage[] = messages.map(msg => {
      // Handle tool calls in assistant message
      if (msg.role === 'assistant' && msg.tool_calls && msg.tool_calls.length > 0) {
        return {
          ...msg,
          sourceRole: msg.role,
          content: toolProfile.formatAssistantToolCalls(msg.tool_calls.map(tc => ({
            id: tc.id,
            name: tc.function.name,
            arguments: tc.function.arguments,
          }))),
        }
      }
      // Handle tool response message
      if (msg.role === 'tool' && msg.tool_call_id) {
        return { 
          ...msg, 
          sourceRole: msg.role,
          role: 'user' as const,
          content: toolProfile.formatToolResult({
            toolCallId: msg.tool_call_id,
            content: this.messageContentToText(msg.content),
            isError: (msg as { is_error?: boolean }).is_error === true,
          }),
        }
      }
      return { ...msg, sourceRole: msg.role }
    })

    // Extract system message first
    const systemParts: string[] = []
    const otherMessages = processedMessages.filter(msg => {
      if (msg.sourceRole === 'system') {
        const text = this.messageContentToText(msg.content)
        if (text) systemParts.push(text)
        return false
      }
      return true
    })

    const systemContent = systemParts.join('\n')
    let content = systemContent ? `system:${systemContent}\n` : ''

    // With an existing upstream chat, send the newest user turn.  If that
    // turn produced multiple tool calls, all following tool results belong to
    // the same continuation and must be kept together.
    if (isMultiTurn) {
      let lastUserIdx = -1
      for (let i = otherMessages.length - 1; i >= 0; i--) {
        if (otherMessages[i].sourceRole === 'user') {
          lastUserIdx = i
          break
        }
      }

      if (lastUserIdx !== -1) {
        const lastUserMsg = otherMessages[lastUserIdx]
        const toolResults = otherMessages
          .slice(lastUserIdx + 1)
          .filter(msg => msg.sourceRole === 'tool')

        if (toolResults.length > 0) {
          for (const toolResult of toolResults) {
            content += `user:${this.messageContentToText(toolResult.content)}\n`
          }
        } else {
          const text = this.messageContentToText(lastUserMsg.content)
          content += `user:${this.wrapUrlsToTags(text)}\n`
        }

        if (toolsPrompt) {
          content = `${content.trim()}\n\n${toolsPrompt}`
        }
        return content
      }
    }

    if (otherMessages.length < 2) {
      content += otherMessages.reduce((acc, msg) => {
        const text = this.messageContentToText(msg.content)
        return acc + `${msg.sourceRole === 'user' ? this.wrapUrlsToTags(text) : text}\n`
      }, '')
    } else {
      const latestMessage = otherMessages[otherMessages.length - 1]
      const hasFileOrImage = Array.isArray(latestMessage.content) &&
        latestMessage.content.some((v: any) => typeof v === 'object' && ['file', 'image_url'].includes(v.type))

      const focusMessage: PreparedKimiMessage = {
        content: hasFileOrImage
          ? 'Focus on the latest files and messages sent by user'
          : 'Focus on the latest message from user',
        role: 'system',
        sourceRole: 'system',
      }
      const messagesWithFocus = [
        ...otherMessages.slice(0, -1),
        focusMessage,
        latestMessage,
      ]

      content += messagesWithFocus.reduce((acc, msg) => {
        const text = this.messageContentToText(msg.content)
        const rendered = msg.sourceRole === 'user' ? this.wrapUrlsToTags(text) : text
        return acc + `${msg.role}:${rendered}\n`
      }, '')
    }

    // Inject tools prompt at the VERY END of the content to maximize attention
    if (toolsPrompt) {
      content = `${content.trim()}\n\n${toolsPrompt}`
    }

    return content
  }

  private wrapUrlsToTags(content: string): string {
    return content.replace(
      /https?:\/\/(www\.)?[-a-zA-Z0-9@:%._\+~#=]{2,256}\.[a-z]{2,6}\b([-a-zA-Z0-9@:%_\+.~#?&//=]*)/gi,
      url => `<url id="" type="url" status="" title="" wc="">${url}</url>`
    )
  }

  async chatCompletion(request: ChatCompletionRequest): Promise<{
    response: AxiosResponse
    conversationId: string
    accessToken: string
  }> {
    let { accessToken } = await this.acquireToken()

    const messages = [...request.messages]

    // Check if tool prompt has already been injected by client
    const toolPromptExists = hasToolPromptInjected(messages)

    let toolsPrompt = ''
    if (request.tools && request.tools.length > 0 && !toolPromptExists) {
      toolsPrompt = toolsToSystemPrompt(request.tools, true)

      for (let i = messages.length - 1; i >= 0; i--) {
        if (messages[i].role === 'user') {
          const currentContent = messages[i].content
          if (typeof currentContent === 'string') {
            messages[i] = { ...messages[i], content: currentContent + TOOL_WRAP_HINT }
          } else if (Array.isArray(currentContent)) {
            messages[i] = {
              ...messages[i],
              content: [...currentContent, { type: 'text', text: TOOL_WRAP_HINT }],
            }
          }
          break
        }
      }
    }

    const content = this.messagesPrepare(messages, toolsPrompt, Boolean(request.conversationId))

    // Determine if thinking and web search should be enabled
    // Priority: explicit parameters > model name detection
    // Use originalModel for feature detection (preserves user's intent before mapping)
    const modelForDetection = request.originalModel || request.model
    const modelLower = modelForDetection.toLowerCase()
    
    let enableThinking = request.enableThinking ?? false
    let enableWebSearch = request.enableWebSearch ?? false
    
    // Auto-enable based on model name (if not explicitly set)
    if (!enableThinking && (modelLower.includes('think') || modelLower.includes('r1'))) {
      enableThinking = true
      console.log('[Kimi] Thinking mode enabled (from model name)')
    }
    if (!enableWebSearch && modelLower.includes('search')) {
      enableWebSearch = true
      console.log('[Kimi] Web search enabled (from model name)')
    }

    const payload = createKimiChatPayload({
      model: request.model,
      content,
      enableWebSearch,
      enableThinking,
      reasoningEffort: request.reasoningEffort,
      chatId: request.conversationId,
      parentId: request.parentId,
      projectId: request.projectId,
    })
    const frameBuffer = encodeKimiGrpcFrame(payload)

    console.log('[Kimi] Request body length:', frameBuffer.length, 'JSON length:', frameBuffer.length - 5)

    const sendRequest = (token: string) => axios.post(
      `${KIMI_API_BASE}/apiv2/kimi.gateway.chat.v1.ChatService/Chat`,
      frameBuffer,
      {
        headers: {
          ...this.getRequestHeaders(token),
          'Content-Type': 'application/connect+json',
        },
        timeout: 120000,
        validateStatus: () => true,
        responseType: 'stream',
        signal: request.signal,
      }
    )

    let response = await sendRequest(accessToken)

    if (response.status === 401 && this.getCredentialTokens().refreshToken) {
      response.data?.destroy?.()
      const invalidatedCurrentToken = this.invalidateAccessToken(accessToken)
      const refreshed = await this.acquireToken(invalidatedCurrentToken)
      accessToken = refreshed.accessToken
      response = await sendRequest(accessToken)
    }

    console.log('[Kimi] Completion response status:', response.status)

    if (response.status === 401) {
      this.invalidateAccessToken(accessToken)
      response.data?.destroy?.()
      const error = new Error('Token invalid or expired')
      Object.assign(error, { status: 401, retryable: false })
      throw error
    }

    if (response.status !== 200) {
      response.data?.destroy?.()
      const error = new Error(`Completion request failed: HTTP ${response.status}`)
      Object.assign(error, {
        status: response.status,
        retryable: response.status >= 500 || response.status === 429,
      })
      throw error
    }

    return { response, conversationId: request.conversationId || '', accessToken }
  }

  private async postAuthenticatedJson(
    path: string,
    data: Record<string, unknown>,
    timeout: number,
  ): Promise<AxiosResponse> {
    let { accessToken } = await this.acquireToken()
    const sendRequest = (token: string) => axios.post(
      `${KIMI_API_BASE}${path}`,
      data,
      {
        headers: {
          ...this.getRequestHeaders(token),
          'Content-Type': 'application/json',
        },
        timeout,
        validateStatus: () => true,
      },
    )
    const isAuthFailure = (response: AxiosResponse) => response.status === 401
      || response.data?.error_type === 'auth.token.invalid'

    let response = await sendRequest(accessToken)
    if (isAuthFailure(response) && this.getCredentialTokens().refreshToken) {
      const invalidatedCurrentToken = this.invalidateAccessToken(accessToken)
      const refreshed = await this.acquireToken(invalidatedCurrentToken)
      accessToken = refreshed.accessToken
      response = await sendRequest(accessToken)
    }
    if (isAuthFailure(response)) {
      this.invalidateAccessToken(accessToken)
    }
    return response
  }

  async deleteConversation(conversationId: string): Promise<boolean> {
    try {
      const response = await this.postAuthenticatedJson(
        '/apiv2/kimi.chat.v1.ChatService/DeleteChat',
        { chat_id: conversationId },
        15000,
      )

      checkResult(response)
      console.log('[Kimi] Chat deleted:', conversationId, 'Status:', response.status)
      return true
    } catch (error) {
      console.error('[Kimi] Failed to delete conversation:', error)
      return false
    }
  }

  private async listChats(pageToken?: string): Promise<{ chatIds: string[]; nextPageToken: string }> {
    const response = await this.postAuthenticatedJson(
      '/apiv2/kimi.chat.v1.ChatService/ListChats',
      {
        page_size: 100,
        ...(pageToken ? { page_token: pageToken } : {}),
        query: '',
      },
      15000,
    )

    const data = checkResult(response)
    const chats = Array.isArray(data?.chats) ? data.chats : []
    const chatIds = chats
      .map((chat: any) => typeof chat?.id === 'string' ? chat.id : '')
      .filter(Boolean)

    return {
      chatIds,
      nextPageToken: typeof data?.nextPageToken === 'string' ? data.nextPageToken : '',
    }
  }

  private async batchDeleteChats(chatIds: string[]): Promise<boolean> {
    if (chatIds.length === 0) {
      return true
    }

    const response = await this.postAuthenticatedJson(
      '/apiv2/kimi.chat.v1.ChatService/BatchDeleteChats',
      { chat_ids: chatIds },
      30000,
    )

    checkResult(response)
    return response.status === 200
  }

  async deleteAllChats(): Promise<boolean> {
    try {
      let allChatIds: string[] = []
      let pageToken = ''

      for (let page = 0; page < 100; page++) {
        const result = await this.listChats(pageToken || undefined)
        allChatIds = [...allChatIds, ...result.chatIds]

        if (!result.nextPageToken || result.chatIds.length === 0) {
          break
        }

        pageToken = result.nextPageToken
      }

      if (allChatIds.length === 0) {
        console.log('[Kimi] No chats to delete')
        return true
      }

      console.log('[Kimi] Found', allChatIds.length, 'chats to delete')

      for (let i = 0; i < allChatIds.length; i += 100) {
        const batch = allChatIds.slice(i, i + 100)
        const success = await this.batchDeleteChats(batch)
        if (!success) {
          return false
        }
      }

      console.log('[Kimi] All chats deleted successfully')
      return true
    } catch (error) {
      console.error('[Kimi] Failed to delete all chats:', error)
      return false
    }
  }

  static isKimiProvider(provider: Provider): boolean {
    return provider.id === 'kimi' || provider.apiEndpoint.includes('kimi.com')
  }
}

const STAGE_NAME_THINKING = 'STAGE_NAME_THINKING'
const CONNECT_END_STREAM_FLAG = 0x02
const CONNECT_COMPRESSED_FLAG = 0x01
const MAX_CONNECT_FRAME_SIZE = 64 * 1024 * 1024

interface KimiConnectEnvelope {
  flag: number
  data: any
}

function kimiConnectStatus(code: string): number | undefined {
  switch (code) {
    case 'invalid_argument': return 400
    case 'unauthenticated': return 401
    case 'permission_denied': return 403
    case 'not_found': return 404
    case 'already_exists': return 409
    case 'resource_exhausted': return 429
    case 'failed_precondition': return 400
    case 'aborted': return 409
    case 'out_of_range': return 400
    case 'unimplemented': return 501
    case 'unavailable': return 503
    case 'deadline_exceeded': return 504
    default: return undefined
  }
}

function consumeKimiConnectFrames(buffer: Buffer): {
  envelopes: KimiConnectEnvelope[]
  remaining: Buffer
} {
  const envelopes: KimiConnectEnvelope[] = []
  let offset = 0

  while (offset + 5 <= buffer.length) {
    const flag = buffer.readUInt8(offset)
    const length = buffer.readUInt32BE(offset + 1)
    if (length > MAX_CONNECT_FRAME_SIZE) {
      throw new Error(`Kimi Connect frame is too large: ${length} bytes`)
    }
    if (offset + 5 + length > buffer.length) break
    if ((flag & CONNECT_COMPRESSED_FLAG) !== 0) {
      throw new Error('Kimi returned an unsupported compressed Connect envelope')
    }

    const payload = buffer.subarray(offset + 5, offset + 5 + length)
    let data: any = {}
    if (payload.length > 0) {
      try {
        data = JSON.parse(payload.toString('utf8'))
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error)
        throw new Error(`Kimi returned invalid JSON in a Connect envelope: ${detail}`)
      }
    }
    envelopes.push({ flag, data })
    offset += 5 + length
  }

  return { envelopes, remaining: buffer.subarray(offset) }
}

function getKimiConnectError(envelope: KimiConnectEnvelope): Error | undefined {
  const error = envelope.data?.error
    || ((envelope.flag & CONNECT_END_STREAM_FLAG) !== 0 && envelope.data?.code
      ? envelope.data
      : undefined)
  if (!error) return undefined

  const rawCode = typeof error.code === 'string' ? error.code : ''
  const code = rawCode.toLowerCase()
  const rawDetails = error.details ?? error.detail
  const details = Array.isArray(rawDetails)
    ? rawDetails
    : rawDetails && typeof rawDetails === 'object'
      ? [rawDetails]
      : []
  let reason = ''
  let message = typeof error.message === 'string' ? error.message : ''
  const directLocalized = error.localizedMessage || error.localized_message
  if (!message && directLocalized && typeof directLocalized.message === 'string') {
    message = directLocalized.message
  }

  // Connect errors commonly put the user-facing text in
  // details[].debug.localizedMessage rather than error.message. Keep the
  // fallback readable so an anonymous/login denial is actionable to clients.
  for (const detail of details) {
    if (!detail || typeof detail !== 'object') continue
    const debug = detail.debug && typeof detail.debug === 'object' ? detail.debug : detail
    if (!reason && typeof debug.reason === 'string') reason = debug.reason
    const localized = debug.localizedMessage || debug.localized_message
    if (!message && localized && typeof localized.message === 'string') {
      message = localized.message
    }
    if (!message && typeof debug.message === 'string') message = debug.message
    if (!message && typeof detail.message === 'string') message = detail.message
    if (message && reason) break
  }

  if (!message) {
    message = reason || (typeof rawDetails === 'string' ? rawDetails : '')
  }
  if (!message) {
    try {
      message = JSON.stringify(error)
    } catch {
      message = String(error)
    }
  }

  const errorObject = new Error(`Kimi API Error${rawCode ? ` (${rawCode})` : ''}: ${message}`)
  return Object.assign(
    errorObject,
    {
      status: kimiConnectStatus(code),
      reason: reason || undefined,
      retryable: ![
        'invalid_argument',
        'unauthenticated',
        'permission_denied',
        'failed_precondition',
        'unimplemented',
      ].includes(code),
    },
  )
}

function hasKimiDoneEvent(data: any): boolean {
  // The web proto encodes `done` as a message (`{}` in Connect JSON), while
  // older fixtures used boolean true.  Treat a present non-null/non-false
  // value as the terminal event, but do not finish on `done: false`.
  return Boolean(
    data
    && Object.prototype.hasOwnProperty.call(data, 'done')
    && data.done !== false
    && data.done !== null
    && data.done !== undefined,
  )
}

interface KimiStreamOptions {
  signal?: AbortSignal
}

function destroyKimiUpstream(stream: any): void {
  if (!stream) return
  try {
    if (typeof stream.destroy === 'function' && !stream.destroyed) {
      // Keep the client-side error on the transformed stream; passing it to
      // the source can cause Axios to emit the same error twice.
      stream.destroy()
    } else if (typeof stream.abort === 'function') {
      stream.abort()
    }
  } catch {
    // The source may already have closed while cancellation propagated.
  }
}

function createKimiAbortError(): Error {
  const error = new Error('Kimi response stream aborted because the client disconnected.')
  Object.assign(error, { status: 499, retryable: false })
  return error
}

export class KimiStreamHandler {
  private model: string
  private conversationId: string
  private readonly responseId: string
  private enableThinking: boolean
  private toolStreamParser?: ToolStreamParser
  private toolCallingPlan?: ToolCallingPlan
  private realChatId: string | null = null
  private lastMessageId: string | null = null
  private hasError: boolean = false
  private currentPhase: 'thinking' | 'answer' | undefined = undefined
  private reasoningBuffer: string = ''
  private sawDone: boolean = false
  private thinkingSnapshot: string = ''
  private answerSnapshot: string = ''
  private authErrorNotified: boolean = false
  private onAuthError?: () => void

  constructor(
    model: string,
    conversationId: string,
    enableThinking: boolean = false,
    toolCallingPlan?: ToolCallingPlan,
    onAuthError?: () => void,
  ) {
    this.model = model
    const initialConversationId = typeof conversationId === 'string' ? conversationId.trim() : ''
    this.conversationId = initialConversationId
    this.responseId = initialConversationId && !initialConversationId.startsWith('kimi-')
      ? initialConversationId
      : `chatcmpl-${randomUUID()}`
    this.enableThinking = enableThinking
    this.toolCallingPlan = toolCallingPlan
    this.toolStreamParser = toolCallingPlan?.shouldParseResponse ? new ToolStreamParser(toolCallingPlan) : undefined
    this.onAuthError = onAuthError
  }

  getConversationId(): string | null {
    // Return realChatId if available, otherwise return null (not empty string)
    // to prevent saving invalid session IDs
    if (this.realChatId) {
      return this.realChatId
    }
    // Only return conversationId if it's a valid ID (not empty and not a temporary ID)
    if (this.conversationId && this.conversationId.length > 0 && !this.conversationId.startsWith('kimi-')) {
      return this.conversationId
    }
    return null
  }

  getLastMessageId(): string | null {
    return this.lastMessageId
  }

  getResponseId(): string {
    return this.responseId
  }

  hasSessionError(): boolean {
    return this.hasError
  }

  private detectMultiStage(data: any): 'thinking' | 'answer' | undefined {
    if (!data.block?.multiStage?.stages || !Array.isArray(data.block.multiStage.stages)) {
      return undefined
    }
    
    const stages = data.block.multiStage.stages
    if (stages.length === 0) {
      return undefined
    }
    
    const firstStage = stages[0]
    if (firstStage?.name === STAGE_NAME_THINKING) {
      return firstStage.status === 'completed' ? 'answer' : 'thinking'
    }
    
    return undefined
  }

  private getMaskPaths(mask: unknown): string[] {
    if (typeof mask === 'string') return mask.split(',')
    if (Array.isArray((mask as { paths?: unknown })?.paths)) {
      return (mask as { paths: unknown[] }).paths.filter((path): path is string => typeof path === 'string')
    }
    return []
  }

  private isThinkingMask(mask: unknown): boolean {
    return this.getMaskPaths(mask).some(path => path.includes('block.think'))
  }

  private isAnswerMask(mask: unknown): boolean {
    return this.getMaskPaths(mask).some(path => path.includes('block.text'))
  }

  private extractThinkContent(data: any): string | null {
    return data.block?.think?.content || null
  }

  private extractTextContent(data: any): string | null {
    return data.block?.text?.content || null
  }

  async handleStream(stream: any, options: KimiStreamOptions = {}): Promise<PassThrough> {
    this.sawDone = false
    this.hasError = false
    this.thinkingSnapshot = ''
    this.answerSnapshot = ''
    this.authErrorNotified = false
    const transStream = new PassThrough()
    const created = unixTimestamp()
    let buffer: Buffer = Buffer.alloc(0)
    let sentRole = false
    let sourceEnded = false
    let finalized = false

    const cleanup = () => {
      options.signal?.removeEventListener('abort', onAbort)
    }

    const fail = (error: Error) => {
      if (finalized) return
      finalized = true
      this.hasError = true
      if ((error as { status?: unknown }).status === 401 && !this.authErrorNotified) {
        this.authErrorNotified = true
        this.onAuthError?.()
      }
      console.error('[Kimi] Stream error:', error.message)
      cleanup()
      destroyKimiUpstream(stream)
      transStream.destroy(error)
    }

    const finish = () => {
      if (finalized) return
      if (buffer.length > 0) {
        fail(new Error(`Kimi stream ended with ${buffer.length} incomplete Connect frame bytes`))
        return
      }
      if (!this.sawDone) {
        fail(new Error('Kimi stream ended before the upstream done event'))
        return
      }

      const baseChunk = createBaseChunk(this.responseId, this.model, created)
      const flushChunks = this.toolStreamParser?.flush(baseChunk) ?? []
      const protocolError = this.toolStreamParser?.getProtocolError()
      if (protocolError) {
        fail(protocolError)
        return
      }
      finalized = true
      cleanup()
      for (const outChunk of flushChunks) {
        transStream.write(`data: ${JSON.stringify(outChunk)}\n\n`)
      }
      transStream.write(`data: ${JSON.stringify({
        id: this.responseId,
        model: this.model,
        object: 'chat.completion.chunk',
        ...this.getSessionMetadata(),
        choices: [{
          index: 0,
          delta: {},
          finish_reason: this.toolStreamParser?.hasEmittedToolCall() ? 'tool_calls' : 'stop',
        }],
        created,
      })}\n\n`)
      transStream.end('data: [DONE]\n\n')
    }

    const onAbort = () => {
      fail(createKimiAbortError())
    }

    if (options.signal?.aborted) {
      // Defer emission until the caller has a chance to attach its listener.
      setImmediate(onAbort)
      return transStream
    }
    options.signal?.addEventListener('abort', onAbort, { once: true })

    stream.on('data', (chunk: Buffer) => {
      if (finalized) return
      try {
        buffer = Buffer.concat([buffer, chunk])
        const parsed = consumeKimiConnectFrames(buffer)
        buffer = parsed.remaining

        for (const envelope of parsed.envelopes) {
          const connectError = getKimiConnectError(envelope)
          if (connectError) {
            fail(connectError)
            return
          }
          if ((envelope.flag & CONNECT_END_STREAM_FLAG) !== 0) {
            if (hasKimiDoneEvent(envelope.data)) this.sawDone = true
            continue
          }
          this.handleMessage(
            envelope.data,
            transStream,
            created,
            () => sentRole,
            (value) => { sentRole = value },
          )
        }
      } catch (error) {
        fail(error instanceof Error ? error : new Error(String(error)))
      }
    })

    stream.once('error', (err: Error) => {
      fail(err)
    })

    stream.once('end', () => {
      sourceEnded = true
      console.log('[Kimi] Stream ended, realChatId:', this.realChatId, 'lastMessageId:', this.lastMessageId)
      finish()
    })

    stream.once('close', () => {
      if (!sourceEnded && !finalized) {
        fail(new Error('Kimi upstream stream closed before completion'))
      }
    })

    return transStream
  }

  private getSessionMetadata(): Record<string, string> {
    const conversationId = this.getConversationId()
    return {
      ...(conversationId ? {
        conversation_id: conversationId,
        chat_id: conversationId,
      } : {}),
      ...(this.lastMessageId ? {
        parent_message_id: this.lastMessageId,
        parent_id: this.lastMessageId,
      } : {}),
    }
  }

  private handleMessage(
    data: any,
    transStream: PassThrough,
    created: number,
    getSentRole: () => boolean,
    setSentRole: (v: boolean) => void
  ) {
    if (data.heartbeat) return

    if (data.chat?.id && !this.realChatId) {
      this.realChatId = data.chat.id
      console.log('[Kimi] Extracted real chat_id from chat.id:', this.realChatId)
    }

    if (data.message?.id && data.message?.role === 'assistant' && !this.lastMessageId) {
      this.lastMessageId = data.message.id
      console.log('[Kimi] Extracted assistant message id:', this.lastMessageId)
    }

    const multiStagePhase = this.detectMultiStage(data)
    if (multiStagePhase) {
      this.currentPhase = multiStagePhase
      console.log('[Kimi] Detected multiStage phase:', this.currentPhase)
    }

    if (data.block?.text?.flags === 'thinking') {
      this.currentPhase = 'thinking'
    } else if (data.block?.text?.flags === 'answer') {
      this.currentPhase = 'answer'
    }

    if ((data.op === 'set' || data.op === 'append')) {
      const mask = data.mask
      
      if (this.isThinkingMask(mask)) {
        const thinkContent = this.applyStreamPatch(
          data.op,
          this.extractThinkContent(data),
          'thinking',
        )
        if (thinkContent) {
          if (!getSentRole()) {
            transStream.write(`data: ${JSON.stringify({
              id: this.responseId,
              model: this.model,
              object: 'chat.completion.chunk',
              choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }],
              created,
            })}\n\n`)
            setSentRole(true)
          }
          
          this.reasoningBuffer += thinkContent
          transStream.write(`data: ${JSON.stringify({
            id: this.responseId,
            model: this.model,
            object: 'chat.completion.chunk',
            choices: [{ index: 0, delta: { reasoning_content: thinkContent }, finish_reason: null }],
            created,
          })}\n\n`)
        }
      } else if (this.isAnswerMask(mask)) {
        const textContent = this.applyStreamPatch(
          data.op,
          this.extractTextContent(data),
          'answer',
        )
        if (textContent) {
          if (!getSentRole()) {
            transStream.write(`data: ${JSON.stringify({
              id: this.responseId,
              model: this.model,
              object: 'chat.completion.chunk',
              choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }],
              created,
            })}\n\n`)
            setSentRole(true)
          }
          
          this.sendChunk(transStream, textContent, created)
        }
      } else if (data.block?.text?.content) {
        const content = this.applyStreamPatch(data.op, data.block.text.content, 'answer')
        
        if (!getSentRole()) {
          transStream.write(`data: ${JSON.stringify({
            id: this.responseId,
            model: this.model,
            object: 'chat.completion.chunk',
            choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }],
            created,
          })}\n\n`)
          setSentRole(true)
        }
        
        if (this.currentPhase === 'thinking') {
          this.reasoningBuffer += content
          transStream.write(`data: ${JSON.stringify({
            id: this.responseId,
            model: this.model,
            object: 'chat.completion.chunk',
            choices: [{ index: 0, delta: { reasoning_content: content }, finish_reason: null }],
            created,
          })}\n\n`)
        } else {
          this.sendChunk(transStream, content, created)
        }
      }
    }

    if (hasKimiDoneEvent(data)) {
      this.sawDone = true
    }
  }

  private applyStreamPatch(
    operation: unknown,
    value: unknown,
    channel: 'thinking' | 'answer',
  ): string {
    const next = typeof value === 'string' ? value : ''
    if (!next) return ''
    const previous = channel === 'thinking' ? this.thinkingSnapshot : this.answerSnapshot

    if (operation === 'append') {
      if (channel === 'thinking') this.thinkingSnapshot = previous + next
      else this.answerSnapshot = previous + next
      return next
    }

    // `set` carries a snapshot.  Emit only the new suffix when the snapshot
    // extends what was already sent; a replacement cannot be represented by
    // an OpenAI delta, so avoid duplicating the whole prior answer.
    if (channel === 'thinking') this.thinkingSnapshot = next
    else this.answerSnapshot = next
    if (!previous) return next
    if (next === previous) return ''
    if (next.startsWith(previous)) return next.slice(previous.length)
    return ''
  }

  private sendChunk(transStream: PassThrough, content: string, created: number) {
    // Process tool call interception
    const baseChunk = createBaseChunk(this.responseId, this.model, created)
    const outputChunks = this.toolStreamParser?.push(content, baseChunk, false) ?? []

    // Check if we emitted tool calls first
    const hasToolCalls = outputChunks.some(c => c.choices?.[0]?.delta?.tool_calls)

    for (const outChunk of outputChunks) {
      transStream.write(`data: ${JSON.stringify(outChunk)}\n\n`)
    }

    if (!this.toolStreamParser || (!this.toolStreamParser.isBuffering() && !this.toolStreamParser.hasEmittedToolCall() && !hasToolCalls && outputChunks.length === 0)) {
      transStream.write(`data: ${JSON.stringify({
        ...baseChunk,
        choices: [{ index: 0, delta: { content }, finish_reason: null }],
      })}\n\n`)
    }
  }

  private createNonStreamResponse(content: string, reasoningContent: string, created: number): any {
    const parsed = this.toolCallingPlan?.shouldParseResponse
      ? { content, toolCalls: [] }
      : parseToolCallsFromText(content, 'kimi')
    const message: any = {
      role: 'assistant',
      content: parsed.toolCalls.length > 0 ? null : parsed.content.trim(),
    }

    if (reasoningContent.trim()) message.reasoning_content = reasoningContent.trim()
    if (parsed.toolCalls.length > 0) message.tool_calls = parsed.toolCalls

    return {
      id: this.realChatId || this.conversationId || this.responseId,
      model: this.model,
      object: 'chat.completion',
      created,
      ...this.getSessionMetadata(),
      choices: [{
        index: 0,
        message,
        finish_reason: parsed.toolCalls.length > 0 ? 'tool_calls' : 'stop',
      }],
      usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    }
  }

  async handleNonStream(stream: any, options: KimiStreamOptions = {}): Promise<any> {
    this.sawDone = false
    this.hasError = false
    this.thinkingSnapshot = ''
    this.answerSnapshot = ''
    this.authErrorNotified = false
    const created = unixTimestamp()
    let content = ''
    let reasoningContent = ''
    let buffer: Buffer = Buffer.alloc(0)
    let currentPhase: 'thinking' | 'answer' | undefined = undefined
    let sourceEnded = false
    let settled = false

    return new Promise((resolve, reject) => {
      const cleanup = () => {
        options.signal?.removeEventListener('abort', onAbort)
      }

      const fail = (error: Error) => {
        if (settled) return
        settled = true
        this.hasError = true
        if ((error as { status?: unknown }).status === 401 && !this.authErrorNotified) {
          this.authErrorNotified = true
          this.onAuthError?.()
        }
        cleanup()
        destroyKimiUpstream(stream)
        reject(error)
      }

      const finish = () => {
        if (settled) return
        if (buffer.length > 0) {
          fail(new Error(`Kimi stream ended with ${buffer.length} incomplete Connect frame bytes`))
          return
        }
        if (!this.sawDone) {
          fail(new Error('Kimi stream ended before the upstream done event'))
          return
        }
        settled = true
        cleanup()
        resolve(this.createNonStreamResponse(content, reasoningContent, created))
      }

      const onAbort = () => {
        fail(createKimiAbortError())
      }

      if (options.signal?.aborted) {
        onAbort()
        return
      }
      options.signal?.addEventListener('abort', onAbort, { once: true })

      stream.on('data', (chunk: Buffer) => {
        if (settled) return
        try {
          buffer = Buffer.concat([buffer, chunk])
          const parsed = consumeKimiConnectFrames(buffer)
          buffer = parsed.remaining

          for (const envelope of parsed.envelopes) {
            const connectError = getKimiConnectError(envelope)
            if (connectError) {
              fail(connectError)
              return
            }
            if ((envelope.flag & CONNECT_END_STREAM_FLAG) !== 0) {
              if (hasKimiDoneEvent(envelope.data)) this.sawDone = true
              continue
            }

            const data = envelope.data
            if (data.chat?.id && !this.realChatId) {
              this.realChatId = data.chat.id
              console.log('[Kimi] Non-stream: Extracted real chat_id from chat.id:', this.realChatId)
            }

            if (data.message?.id && data.message?.role === 'assistant' && !this.lastMessageId) {
              this.lastMessageId = data.message.id
              console.log('[Kimi] Non-stream: Extracted assistant message id:', this.lastMessageId)
            }

            const multiStagePhase = this.detectMultiStage(data)
            if (multiStagePhase) currentPhase = multiStagePhase
            if (data.block?.text?.flags === 'thinking') currentPhase = 'thinking'
            if (data.block?.text?.flags === 'answer') currentPhase = 'answer'

            if (data.op === 'set' || data.op === 'append') {
              if (this.isThinkingMask(data.mask)) {
                reasoningContent = this.applyNonStreamPatch(
                  data.op,
                  reasoningContent,
                  this.extractThinkContent(data),
                )
              } else if (this.isAnswerMask(data.mask)) {
                content = this.applyNonStreamPatch(
                  data.op,
                  content,
                  this.extractTextContent(data),
                )
              } else if (data.block?.text?.content) {
                if (currentPhase === 'thinking') {
                  reasoningContent = this.applyNonStreamPatch(data.op, reasoningContent, data.block.text.content)
                } else {
                  content = this.applyNonStreamPatch(data.op, content, data.block.text.content)
                }
              }
            }

            if (hasKimiDoneEvent(data)) this.sawDone = true
          }
        } catch (error) {
          fail(error instanceof Error ? error : new Error(String(error)))
        }
      })

      stream.once('error', (error: Error) => fail(error))
      stream.once('end', () => {
        sourceEnded = true
        finish()
      })
      stream.once('close', () => {
        if (!sourceEnded && !settled) {
          fail(new Error('Kimi upstream stream closed before completion'))
        }
      })
    })
  }

  private applyNonStreamPatch(operation: unknown, previous: string, value: unknown): string {
    const next = typeof value === 'string' ? value : ''
    return operation === 'set' ? next : previous + next
  }
}

export const kimiAdapter = {
  KimiAdapter,
  KimiStreamHandler,
}
