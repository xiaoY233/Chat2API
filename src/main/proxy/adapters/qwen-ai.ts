/**
 * Qwen AI International Adapter
 * Implements chat.qwen.ai API protocol
 * Based on qwen3-reverse project
 */

import axios, { AxiosResponse } from 'axios'
import { PassThrough } from 'stream'
import { createParser } from 'eventsource-parser'
import { Account, Provider } from '../../store/types'
import { hasToolUse, parseToolUse, ToolCall } from '../promptToolUse'
import { ToolStreamParser } from '../toolCalling/ToolStreamParser'
import { getProviderToolProfile } from '../toolCalling/providerProfiles'
import type { ToolCallingPlan } from '../toolCalling/types'
import {
  QWEN_MEDIA_CHAT_MODEL,
  buildQwenAiMediaPayload,
  extractQwenMediaTaskId,
  extractQwenMediaUrl,
  mediaChatType,
  parseQwenAiMediaResponse,
  type QwenMediaKind,
} from './qwen-ai-media'
import {
  getQwenBaxiaSession,
  isQwenWafResponse,
  type QwenBaxiaSession,
} from './qwen-baxia'
import { storeManager } from '../../store/store'
import {
  isQwenAiTokenExpiring,
  normalizeCookieHeader,
} from '../../oauth/qwenAiAuth'

const QWEN_AI_BASE = 'https://chat.qwen.ai'

const DEFAULT_HEADERS = {
  Accept: 'application/json',
  'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
  'Content-Type': 'application/json',
  source: 'web',
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36',
  'sec-ch-ua': '"Not:A-Brand";v="99", "Google Chrome";v="145", "Chromium";v="145"',
  'sec-ch-ua-mobile': '?0',
  'sec-ch-ua-platform': '"macOS"',
  'Sec-Fetch-Dest': 'empty',
  'Sec-Fetch-Mode': 'cors',
  'Sec-Fetch-Site': 'same-origin',
  Timezone: 'Mon Feb 23 2026 22:06:02 GMT+0800',
  Version: '0.3.41',
  Origin: 'https://chat.qwen.ai',
}

const WAF_ERROR_MESSAGE =
  'Qwen AI refused the request with an Aliyun anti-bot (WAF) challenge. ' +
  'Chat2API could not mint a fresh browser signature for this account. ' +
  'Make sure Chat2API runs with a display, or retry in a moment.'

function mergeCookieHeader(...parts: Array<string | undefined>): string {
  const seen = new Set<string>()
  const pairs: string[] = []
  for (const part of parts) {
    if (!part) continue
    for (const pair of part.split(';')) {
      const trimmed = pair.trim()
      if (!trimmed) continue
      const name = trimmed.split('=')[0]
      if (seen.has(name)) continue
      seen.add(name)
      pairs.push(trimmed)
    }
  }
  return pairs.join('; ')
}

const MODEL_ALIASES: Record<string, string> = {
  qwen: 'qwen3.8-max',
  qwen3: 'qwen3.8-max',
  qwen4: 'qwen4.0-max-preview',
  'qwen4-max': 'qwen4.0-max-preview',
  'qwen4.0': 'qwen4.0-max-preview',
  'qwen4.0-max-preview': 'qwen4.0-max-preview',
  'qwen3.8': 'qwen3.8-max',
  'qwen3.8-max': 'qwen3.8-max',
  'qwen3.8-plus': 'qwen3.8-plus',
  'qwen3.8-flash': 'qwen3.8-flash',
  'qwen3.8-omni-flash': 'qwen3.8-omni-flash',
  'qwen-image-3.0': 'qwen-image-3.0',
  'wan3.0-video': 'wan3.0-video',
}

interface QwenAiMessage {
  role: 'user' | 'assistant' | 'system' | 'tool'
  content: string | Array<{ type?: string; text?: string }> | null
  tool_calls?: Array<{ id?: string; function?: { name?: string; arguments?: string } }>
  tool_call_id?: string
}

interface ChatCompletionRequest {
  model: string
  /** Original model name before mapping (used for feature detection like thinking mode) */
  originalModel?: string
  messages: QwenAiMessage[]
  stream?: boolean
  temperature?: number
  enable_thinking?: boolean
  thinking_budget?: number
  chatId?: string
}

function uuid(): string {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0
    const v = c === 'x' ? r : (r & 0x3) | 0x8
    return v.toString(16)
  })
}

function timestamp(): number {
  return Date.now()
}

function messageText(content: QwenAiMessage['content']): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .filter((part) => typeof part === 'object' && part !== null && 'text' in part)
      .map((part) => String(part.text ?? ''))
      .join('\n')
  }
  return ''
}

/**
 * The Qwen AI web endpoint accepts a single user message. Flatten the OpenAI
 * conversation (including tool calls and tool results) into a transcript so a
 * coding client's follow-up request still carries the tool history.
 */
export function buildQwenAiPrompt(
  messages: QwenAiMessage[],
  protocol?: ToolCallingPlan['protocol'],
): { systemContent: string; userContent: string } {
  const toolProfile = getProviderToolProfile('qwen-ai', protocol)
  let systemContent = ''
  const turns: string[] = []

  for (const message of messages) {
    if (message.role === 'system') {
      const text = messageText(message.content)
      if (text) systemContent += (systemContent ? '\n\n' : '') + text
      continue
    }

    if (message.role === 'assistant' && message.tool_calls && message.tool_calls.length > 0) {
      turns.push(
        `Assistant: ${toolProfile.formatAssistantToolCalls(message.tool_calls.map((call) => ({
          id: call.id || 'call_0',
          name: call.function?.name || 'unknown',
          arguments: call.function?.arguments || '{}',
        })))}`,
      )
      continue
    }

    if (message.role === 'tool' && message.tool_call_id) {
      turns.push(
        `Tool: ${toolProfile.formatToolResult({
          toolCallId: message.tool_call_id,
          content: messageText(message.content),
        })}`,
      )
      continue
    }

    const text = messageText(message.content)
    if (!text) continue
    turns.push(`${message.role === 'assistant' ? 'Assistant' : 'User'}: ${text}`)
  }

  return { systemContent, userContent: turns.join('\n\n') }
}

export class QwenAiAdapter {
  private provider: Provider
  private account: Account
  private toolCallingPlan?: ToolCallingPlan
  private axiosInstance = axios.create({
    timeout: 120000,
    maxBodyLength: Infinity,
    maxContentLength: Infinity,
  })

  constructor(provider: Provider, account: Account, toolCallingPlan?: ToolCallingPlan) {
    this.provider = provider
    this.account = account
    this.toolCallingPlan = toolCallingPlan
  }

  private getToken(): string {
    const credentials = this.account.credentials
    return credentials.token || credentials.accessToken || credentials.apiKey || ''
  }

  private getCookies(): string {
    const credentials = this.account.credentials
    return normalizeCookieHeader(credentials.cookies || credentials.cookie)
  }

  /**
   * Qwen AI access tokens expire after ~15 minutes. Refresh them a few minutes
   * early through auth.qwen.ai using the long-lived refresh_token cookie, so a
   * long-lived proxy session never sends an expired token upstream.
   */
  async ensureValidToken(force = false): Promise<string> {
    const current = this.getToken()
    if (!force && !isQwenAiTokenExpiring(current)) {
      return current
    }

    const { refreshQwenAiToken } = await import('../../oauth/qwenAiRefresh')
    const refreshed = await refreshQwenAiToken(this.account.credentials)
    if (refreshed.status !== 'success') {
      if (force) {
        console.warn('[QwenAI] Forced token refresh failed:', refreshed.status, refreshed.reason || '')
      }
      return current
    }

    const nextCredentials = {
      ...this.account.credentials,
      token: refreshed.token,
      refresh_token: refreshed.refreshToken,
      cookies: refreshed.cookies,
    }
    this.account.credentials = nextCredentials

    try {
      storeManager.updateAccount(this.account.id, { credentials: nextCredentials })
      console.log('[QwenAI] Refreshed access token persisted for account', this.account.id)
    } catch (error) {
      console.warn('[QwenAI] Failed to persist refreshed access token:', error)
    }

    return refreshed.token
  }

  private async buildHeaders(chatId?: string, session?: QwenBaxiaSession | null): Promise<Record<string, string>> {
    const baxia = session === undefined ? await getQwenBaxiaSession() : session
    const headers: Record<string, string> = {
      ...DEFAULT_HEADERS,
      Authorization: `Bearer ${this.getToken()}`,
      'X-Request-Id': uuid(),
    }

    if (baxia) {
      headers['bx-ua'] = baxia.bxUa
      headers['bx-umidtoken'] = baxia.bxUmidToken
      headers['bx-v'] = baxia.bxV
    }

    if (chatId) {
      headers['Referer'] = `https://chat.qwen.ai/c/${chatId}`
    }

    const cookies = mergeCookieHeader(baxia?.cookies, this.getCookies())
    if (cookies) {
      headers['Cookie'] = cookies
    } else {
      console.warn('[QwenAI] Warning: No cookies available. Requests may be rejected by the anti-bot layer.')
    }

    return headers
  }

  private isWafResponse(response: AxiosResponse): boolean {
    const contentType = response.headers?.['content-type'] as string | undefined
    return isQwenWafResponse(contentType, typeof response.data === 'string' ? response.data : undefined)
  }

  mapModel(openaiModel: string): string {
    let model = openaiModel
    let forceThinking: boolean | undefined
    
    if (model.endsWith('-thinking')) {
      forceThinking = true
      model = model.slice(0, -9)
    } else if (model.endsWith('-fast')) {
      forceThinking = false
      model = model.slice(0, -5)
    }
    
    ;(this as any)._forceThinking = forceThinking
    
    const lowerModel = model.toLowerCase()
    
    if (MODEL_ALIASES[lowerModel]) {
      return MODEL_ALIASES[lowerModel]
    }
    
    if (this.provider.modelMappings) {
      for (const [key, value] of Object.entries(this.provider.modelMappings)) {
        if (key.toLowerCase() === lowerModel) {
          return value
        }
      }
    }
    
    return model
  }

  async createChat(
    modelId: string,
    title: string = 'New Chat',
    chatType: 't2t' | 't2i' | 't2v' = 't2t'
  ): Promise<string> {
    await this.ensureValidToken()

    const url = `${QWEN_AI_BASE}/api/v2/chats/new`
    const payload = {
      title,
      models: [modelId],
      chat_mode: 'normal',
      chat_type: chatType,
      timestamp: Date.now(),
      project_id: '',
    }

    let session = await getQwenBaxiaSession()
    let wafRetried = false
    let tokenRefreshed = false

    for (let attempt = 0; attempt < 4; attempt++) {
      try {
        const response = await this.axiosInstance.post(url, payload, {
          headers: await this.buildHeaders(undefined, session),
          validateStatus: () => true,
        })

        if (this.isWafResponse(response)) {
          if (!wafRetried) {
            wafRetried = true
            console.warn('[QwenAI] Create chat hit the Aliyun WAF, refreshing baxia session...')
            session = await getQwenBaxiaSession(true)
            continue
          }
          throw new Error(WAF_ERROR_MESSAGE)
        }

        if (response.data?.data?.id) {
          console.log('[QwenAI] Created chat:', response.data.data.id)
          return response.data.data.id
        }

        const detail =
          response.data?.data?.details ||
          response.data?.data?.message ||
          response.data?.msg ||
          response.data?.message ||
          response.data?.data?.code
        const detailText = String(detail || '')
        const code = String(response.data?.data?.code || '').toLowerCase()

        // The server may reject a token that still looks valid locally (clock
        // skew or early revocation). Force a refresh and retry once.
        if (
          !tokenRefreshed &&
          (code === 'unauthorized' ||
            code === 'invalid token' ||
            /token has expired|token is invalid|session has expired/i.test(detailText))
        ) {
          tokenRefreshed = true
          const previousToken = this.getToken()
          const refreshedToken = await this.ensureValidToken(true)
          if (refreshedToken && refreshedToken !== previousToken) {
            console.log('[QwenAI] Create chat unauthorized, retrying with the refreshed token')
            continue
          }
        }

        const status = response.status && response.status !== 200 ? `HTTP ${response.status}: ` : ''
        throw new Error(
          `Failed to create chat: ${status}${detail || 'no chat ID returned'}`
        )
      } catch (error) {
        console.error('[QwenAI] Failed to create chat:', error)
        throw error
      }
    }

    throw new Error('Failed to create chat: too many retries')
  }

  async deleteChat(chatId: string): Promise<boolean> {
    const url = `${QWEN_AI_BASE}/api/v2/chats/${chatId}`

    try {
      const response = await this.axiosInstance.delete(url, {
        headers: await this.buildHeaders(),
      })

      if (response.data?.success) {
        console.log('[QwenAI] Deleted chat:', chatId)
        return true
      }

      console.warn('[QwenAI] Failed to delete chat:', response.data)
      return false
    } catch (error) {
      console.error('[QwenAI] Failed to delete chat:', error)
      return false
    }
  }

  /**
   * Delete all chats for the current account
   * @returns Promise<boolean> - true if deletion was successful
   */
  async deleteAllChats(): Promise<boolean> {
    const url = `${QWEN_AI_BASE}/api/v2/chats/`

    try {
      console.log('[QwenAI] Deleting all chats for account')
      
      const response = await this.axiosInstance.delete(url, {
        headers: await this.buildHeaders(),
      })

      if (response.data?.success) {
        console.log('[QwenAI] All chats deleted successfully')
        return true
      }

      console.warn('[QwenAI] Failed to delete all chats:', response.data)
      return false
    } catch (error) {
      console.error('[QwenAI] Failed to delete all chats:', error)
      return false
    }
  }

  async chatCompletion(request: ChatCompletionRequest): Promise<{
    response: AxiosResponse
    chatId: string
    parentId: string | null
  }> {
    await this.ensureValidToken()
    const token = this.getToken()
    if (!token) {
      throw new Error('Qwen AI token not configured, please add token in account settings')
    }

    const modelId = this.mapModel(request.model)
    
    // Get forced thinking mode setting from originalModel (preserves user's intent before mapping)
    // If originalModel exists, use it for thinking detection; otherwise fall back to request.model
    const modelForThinking = request.originalModel || request.model
    const modelLower = modelForThinking.toLowerCase()
    let forceThinking: boolean | undefined
    if (modelForThinking.endsWith('-thinking')) {
      forceThinking = true
    } else if (modelForThinking.endsWith('-fast')) {
      forceThinking = false
    } else if (modelLower.includes('think') || modelLower.includes('r1')) {
      // Auto-enable thinking based on model name keywords (e.g. "Qwen3.8-Plus-AI-Think-Search")
      forceThinking = true
      console.log('[QwenAI] Thinking mode enabled (from model name keyword)')
    } else if (modelLower.includes('qwen4')) {
      // chat.qwen.ai reports auto_thinking with think_skip disabled for Qwen4,
      // so thinking is part of the model's normal behavior.
      forceThinking = true
      console.log('[QwenAI] Thinking mode enabled (Qwen4 auto thinking)')
    } else {
      // Use the forceThinking from mapModel if no originalModel-specific detection
      forceThinking = (this as any)._forceThinking
    }

    // Always create a new chat (single-turn mode only)
    const chatId = await this.createChat(modelId, 'OpenAI_API_Chat')
    console.log('[QwenAI] Created new chat:', chatId)

    const messages = request.messages
    
    // The web endpoint is single-turn, so flatten the conversation.
    const { systemContent, userContent: conversationContent } = buildQwenAiPrompt(
      messages,
      this.toolCallingPlan?.protocol,
    )
    let userContent = conversationContent
    
    // If system prompt exists, prepend it to user content
    if (systemContent) {
      userContent = `${systemContent}\n\n${userContent}`
    }

    const fid = uuid()
    const childId = uuid()
    const ts = Math.floor(Date.now() / 1000)

    // Default to disable thinking mode to avoid automatic reasoning trigger
    // Users can control thinking via:
    // 1. Model name suffix: -thinking (force thinking), -fast (force fast mode)
    // 2. enable_thinking parameter for explicit control
    // 3. If neither is specified, thinking mode is disabled by default (fast mode)
    const shouldEnableThinking = forceThinking !== undefined 
      ? forceThinking 
      : request.enable_thinking === true
    
    const featureConfig: Record<string, any> = {
      thinking_enabled: shouldEnableThinking,
      output_schema: 'phase',
      research_mode: 'normal',
      auto_thinking: shouldEnableThinking,
      thinking_format: 'summary',
      auto_search: false, // Default to disable auto search
    }

    if (request.thinking_budget) {
      featureConfig.thinking_budget = request.thinking_budget
    }

    const payload = {
      stream: true,
      version: '2.1',
      incremental_output: true,
      chat_id: chatId,
      chat_mode: 'normal',
      model: modelId,
      parent_id: null,
      messages: [
        {
          fid,
          parentId: null,
          childrenIds: [childId],
          role: 'user',
          content: userContent,
          user_action: 'chat',
          files: [],
          timestamp: ts,
          models: [modelId],
          chat_type: 't2t',
          feature_config: featureConfig,
          extra: { meta: { subChatType: 't2t' } },
          sub_chat_type: 't2t',
          parent_id: null,
        },
      ],
      timestamp: ts + 1,
    }

    const url = `${QWEN_AI_BASE}/api/v2/chat/completions?chat_id=${chatId}`

    console.log('[QwenAI] Sending request to /api/v2/chat/completions...')
    console.log('[QwenAI] Request URL:', url)
    console.log('[QwenAI] Request payload:', JSON.stringify(payload, null, 2))

    const session = await getQwenBaxiaSession()
    const response = await this.axiosInstance.post(url, payload, {
      headers: {
        ...(await this.buildHeaders(chatId, session)),
        'x-accel-buffering': 'no',
      },
      responseType: 'stream',
      timeout: 120000,
      validateStatus: () => true,
    })

    if (this.isWafResponse(response)) {
      try { (response.data as any)?.destroy?.() } catch { /* ignore */ }
      throw new Error(WAF_ERROR_MESSAGE)
    }

    console.log('[QwenAI] Response status:', response.status)
    console.log('[QwenAI] Response headers:', JSON.stringify(response.headers, null, 2))

    return {
      response,
      chatId,
      parentId: null,
    }
  }

  /**
   * Generates an image or video through the Qwen AI chat media pipeline.
   * Video generation may block while the upstream task is polled.
   */
  async mediaCompletion(request: {
    model: string
    prompt: string
    kind: QwenMediaKind
    size?: string
    timeoutMs?: number
  }): Promise<{
    chatId: string
    url?: string
    taskId?: string
    width?: number
    height?: number
  }> {
    await this.ensureValidToken()
    const token = this.getToken()
    if (!token) {
      throw new Error('Qwen AI token not configured, please add token in account settings')
    }
    if (!request.prompt.trim()) {
      throw new Error('A non-empty prompt is required for media generation')
    }

    const generationModel = this.mapModel(request.model)
    const chatModel = QWEN_MEDIA_CHAT_MODEL
    const chatType = mediaChatType(request.kind)
    const title = request.kind === 'image' ? 'Image Generation' : 'Video Generation'
    const chatId = await this.createChat(chatModel, title, chatType)

    const payload = buildQwenAiMediaPayload({
      chatId,
      prompt: request.prompt,
      kind: request.kind,
      size: request.size,
      generationModel,
      chatModel,
    })

    const url = `${QWEN_AI_BASE}/api/v2/chat/completions?chat_id=${encodeURIComponent(chatId)}`
    const timeout = request.timeoutMs ?? (request.kind === 'video' ? 300000 : 180000)

    console.log(`[QwenAI] Sending ${request.kind} generation request...`)
    const response = await this.axiosInstance.post(url, payload, {
      headers: {
        ...(await this.buildHeaders(chatId)),
        'x-accel-buffering': 'no',
      },
      responseType: 'text',
      timeout,
      transformResponse: [(data) => data],
      validateStatus: () => true,
    })

    const raw = typeof response.data === 'string'
      ? response.data
      : JSON.stringify(response.data)

    if (this.isWafResponse(response)) {
      throw new Error(WAF_ERROR_MESSAGE)
    }

    if (response.status >= 400) {
      throw new Error(
        `Qwen ${request.kind} generation failed: HTTP ${response.status} ${raw.slice(0, 300)}`
      )
    }

    const parsed = parseQwenAiMediaResponse(raw, request.kind)

    if (parsed.url) {
      return {
        chatId,
        url: parsed.url,
        taskId: parsed.taskId,
        width: parsed.width,
        height: parsed.height,
      }
    }

    if (request.kind === 'video') {
      const taskId =
        parsed.taskId ||
        extractQwenMediaTaskId(safeJsonParse(raw))
      if (taskId) {
        const status = await this.pollVideoTask(taskId)
        return { chatId, url: status.url, taskId }
      }
    }

    throw new Error(
      `No ${request.kind} URL or task id found in Qwen response: ${raw.slice(0, 300)}`
    )
  }

  private async pollVideoTask(taskId: string): Promise<{ url: string }> {
    const deadline = Date.now() + 300000
    const pollUrl = `${QWEN_AI_BASE}/api/v1/tasks/status/${encodeURIComponent(taskId)}`

    while (Date.now() < deadline) {
      const response = await this.axiosInstance.get(pollUrl, {
        headers: await this.buildHeaders(),
        timeout: 30000,
        validateStatus: () => true,
      })

      const json = safeJsonParse(
        typeof response.data === 'string' ? response.data : JSON.stringify(response.data)
      ) as Record<string, any> | null
      if (!json) {
        await sleep(5000)
        continue
      }

      const status = String(json.task_status || json.status || 'running').toLowerCase()
      const url =
        json.video_url ||
        json.data?.video_url ||
        json.output?.video_url ||
        extractQwenMediaUrl(json, 'video') ||
        undefined

      if (status === 'completed' || status === 'success') {
        if (!url) {
          throw new Error('Qwen video task completed without a video URL')
        }
        return { url }
      }
      if (status === 'failed' || status === 'error') {
        const error = json.error || json.data?.error || 'unknown error'
        throw new Error(`Qwen video task failed: ${error}`)
      }

      await sleep(5000)
    }

    throw new Error(`Qwen video task did not finish within 5 minutes: ${taskId}`)
  }

  static isQwenAiProvider(provider: Provider): boolean {
    return provider.id === 'qwen-ai' || provider.apiEndpoint.includes('chat.qwen.ai')
  }
}

function safeJsonParse(raw: string): unknown {
  try {
    return JSON.parse(raw)
  } catch {
    return null
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export class QwenAiStreamHandler {
  private chatId: string = ''
  private model: string
  private created: number
  private onEnd?: (chatId: string) => void
  private responseId: string = ''
  private content: string = ''
  private toolCallsSent: boolean = false
  private toolStreamParser?: ToolStreamParser

  constructor(model: string, onEnd?: (chatId: string) => void, toolCallingPlan?: ToolCallingPlan) {
    this.model = model
    this.created = Math.floor(Date.now() / 1000)
    this.onEnd = onEnd
    this.toolStreamParser = toolCallingPlan?.shouldParseResponse
      ? new ToolStreamParser(toolCallingPlan)
      : undefined
  }

  private baseChunk(): any {
    return {
      id: this.responseId || this.chatId,
      model: this.model,
      object: 'chat.completion.chunk',
      created: this.created,
    }
  }

  setChatId(chatId: string) {
    this.chatId = chatId
  }

  private sendToolCalls(transStream: PassThrough): void {
    if (this.toolCallsSent) return
    
    const toolCalls = parseToolUse(this.content)
    if (toolCalls && toolCalls.length > 0) {
      this.toolCallsSent = true
      
      // Send tool_calls delta
      for (let i = 0; i < toolCalls.length; i++) {
        const tc = toolCalls[i]
        transStream.write(
          `data: ${JSON.stringify({
            id: this.responseId || this.chatId,
            model: this.model,
            object: 'chat.completion.chunk',
            choices: [{
              index: 0,
              delta: {
                tool_calls: [{
                  index: i,
                  id: tc.id,
                  type: 'function',
                  function: {
                    name: tc.function.name,
                    arguments: tc.function.arguments,
                  },
                }],
              },
              finish_reason: null,
            }],
            created: this.created,
          })}\n\n`
        )
      }
      
      // Send finish with tool_calls
      transStream.write(
        `data: ${JSON.stringify({
          id: this.responseId || this.chatId,
          model: this.model,
          object: 'chat.completion.chunk',
          choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
          created: this.created,
        })}\n\n`
      )
      transStream.end('data: [DONE]\n\n')
      if (this.onEnd && this.chatId) {
        this.onEnd(this.chatId)
      }
    }
  }

  async handleStream(stream: any): Promise<PassThrough> {
    const transStream = new PassThrough()

    console.log('[QwenAI] Starting stream handler...')

    let reasoningText = ''
    let hasSentReasoning = false
    let summaryText = ''
    let initialChunkSent = false

    const sendInitialChunk = () => {
      if (!initialChunkSent) {
        const initialChunk = `data: ${JSON.stringify({
          id: '',
          model: this.model,
          object: 'chat.completion.chunk',
          choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }],
          created: this.created,
        })}\n\n`
        transStream.write(initialChunk)
        initialChunkSent = true
        console.log('[QwenAI] Initial chunk written')
      }
    }

    const parser = createParser({
      onEvent: (event: any) => {
        try {
          console.log('[QwenAI] Parsed event:', event.event, 'data:', event.data?.substring(0, 200))
          
          if (event.data === '[DONE]') {
            console.log('[QwenAI] Received [DONE] signal')
            return
          }

          const data = JSON.parse(event.data)
          console.log('[QwenAI] Parsed JSON data keys:', Object.keys(data))

          if (data['response.created']?.response_id) {
            this.responseId = data['response.created'].response_id
            console.log('[QwenAI] Got response_id:', this.responseId)
          }

          if (data.choices && data.choices.length > 0) {
            const choice = data.choices[0]
            const delta = choice.delta || {}
            const phase = delta.phase
            const status = delta.status
            const content = delta.content || ''

            console.log('[QwenAI] Phase:', phase, 'Status:', status, 'Content:', content.substring(0, 50))

            if (phase === 'think') {
              if (status !== 'finished') {
                // Stream thinking content as reasoning_content in real-time
                reasoningText += content
                if (!hasSentReasoning) {
                  transStream.write(
                    `data: ${JSON.stringify({
                      id: this.responseId || this.chatId,
                      model: this.model,
                      object: 'chat.completion.chunk',
                      choices: [{ index: 0, delta: { role: 'assistant', reasoning_content: '' }, finish_reason: null }],
                      created: this.created,
                    })}\n\n`
                  )
                  hasSentReasoning = true
                  console.log('[QwenAI] Sent reasoning role chunk')
                }
                if (content) {
                  transStream.write(
                    `data: ${JSON.stringify({
                      id: this.responseId || this.chatId,
                      model: this.model,
                      object: 'chat.completion.chunk',
                      choices: [{ index: 0, delta: { reasoning_content: content }, finish_reason: null }],
                      created: this.created,
                    })}\n\n`
                  )
                }
              }
              // When status === 'finished', the think phase is done
            } else if (phase === 'thinking_summary') {
              const extra = delta.extra || {}
              console.log('[QwenAI] thinking_summary extra:', JSON.stringify(extra).substring(0, 300))
              if (extra.summary_thought?.content) {
                const newSummary = extra.summary_thought.content.join('\n')
                if (newSummary && newSummary.length > summaryText.length) {
                  // Send only the incremental diff as reasoning_content
                  const diff = newSummary.substring(summaryText.length)
                  if (diff) {
                    if (!hasSentReasoning) {
                      transStream.write(
                        `data: ${JSON.stringify({
                          id: this.responseId || this.chatId,
                          model: this.model,
                          object: 'chat.completion.chunk',
                          choices: [{ index: 0, delta: { role: 'assistant', reasoning_content: '' }, finish_reason: null }],
                          created: this.created,
                        })}\n\n`
                      )
                      hasSentReasoning = true
                    }
                    transStream.write(
                      `data: ${JSON.stringify({
                        id: this.responseId || this.chatId,
                        model: this.model,
                        object: 'chat.completion.chunk',
                        choices: [{ index: 0, delta: { reasoning_content: diff }, finish_reason: null }],
                        created: this.created,
                      })}\n\n`
                    )
                  }
                  summaryText = newSummary
                  console.log('[QwenAI] Updated summaryText, length:', summaryText.length)
                }
              }
            } else if (phase === 'answer') {
              if (!initialChunkSent) {
                sendInitialChunk()
              }
              console.log('[QwenAI] Entering answer branch, content:', content)
              
              // Accumulate content for tool call detection
              this.content += content
              
              if (content) {
                console.log('[QwenAI] Sending content chunk:', content)
                if (this.toolStreamParser) {
                  const chunks = this.toolStreamParser.push(content, this.baseChunk(), !initialChunkSent)
                  for (const chunk of chunks) {
                    transStream.write(`data: ${JSON.stringify(chunk)}\n\n`)
                    initialChunkSent = true
                  }
                  if (this.toolStreamParser.isBuffering() || this.toolStreamParser.hasEmittedToolCall()) {
                    console.log('[QwenAI] Tool call buffering active')
                  }
                } else {
                  const chunk = {
                    id: this.responseId || this.chatId,
                    model: this.model,
                    object: 'chat.completion.chunk',
                    choices: [{ index: 0, delta: { content }, finish_reason: null }],
                    created: this.created,
                  }
                  transStream.write(`data: ${JSON.stringify(chunk)}\n\n`)
                  console.log('[QwenAI] Content chunk written')
                }
              }
            } else if (phase === null && content) {
              if (!initialChunkSent) {
                sendInitialChunk()
              }
              // Accumulate content for tool call detection
              this.content += content

              if (this.toolStreamParser) {
                const chunks = this.toolStreamParser.push(content, this.baseChunk(), false)
                for (const chunk of chunks) {
                  transStream.write(`data: ${JSON.stringify(chunk)}\n\n`)
                }
              } else {
                const chunk = {
                  id: this.responseId || this.chatId,
                  model: this.model,
                  object: 'chat.completion.chunk',
                  choices: [{ index: 0, delta: { content }, finish_reason: null }],
                  created: this.created,
                }
                transStream.write(`data: ${JSON.stringify(chunk)}\n\n`)
              }
            }

            if (status === 'finished' && (phase === 'answer' || phase === null)) {
              if (this.toolStreamParser) {
                const flushChunks = this.toolStreamParser.flush(this.baseChunk())
                for (const chunk of flushChunks) {
                  transStream.write(`data: ${JSON.stringify(chunk)}\n\n`)
                  initialChunkSent = true
                }

                if (this.toolStreamParser.hasEmittedToolCall()) {
                  console.log('[QwenAI] Tool stream parser emitted tool calls')
                  const toolFinishChunk = {
                    id: this.responseId || this.chatId,
                    model: this.model,
                    object: 'chat.completion.chunk',
                    choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }],
                    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
                    created: this.created,
                  }
                  transStream.write(`data: ${JSON.stringify(toolFinishChunk)}\n\n`)
                  transStream.end('data: [DONE]\n\n')
                  if (this.onEnd && this.chatId) {
                    this.onEnd(this.chatId)
                  }
                  return
                }
              } else if (hasToolUse(this.content)) {
                console.log('[QwenAI] Found tool_use in stream, sending tool_calls')
                this.sendToolCalls(transStream)
                return
              }
              
              const finishReason = delta.finish_reason || 'stop'
              const finalChunk = {
                id: this.responseId || this.chatId,
                model: this.model,
                object: 'chat.completion.chunk',
                choices: [{ index: 0, delta: {}, finish_reason: finishReason }],
                created: this.created,
              }
              transStream.write(`data: ${JSON.stringify(finalChunk)}\n\n`)
              transStream.end('data: [DONE]\n\n')

              if (this.onEnd && this.chatId) {
                this.onEnd(this.chatId)
              }
            }
          }
        } catch (err) {
          console.error('[QwenAI] Stream parse error:', err)
        }
      },
    })

    stream.on('data', (buffer: Buffer) => {
      const text = buffer.toString()
      console.log('[QwenAI] Raw stream data:', text.substring(0, 500))
      parser.feed(text)
    })
    stream.once('error', (err: Error) => {
      console.error('[QwenAI] Stream error:', err)
      transStream.end('data: [DONE]\n\n')
    })
    stream.once('close', () => {
      console.log('[QwenAI] Stream closed')
      transStream.end('data: [DONE]\n\n')
    })

    return transStream
  }

  async handleNonStream(stream: any): Promise<any> {
    return new Promise((resolve, reject) => {
      const data = {
        id: '',
        model: this.model,
        object: 'chat.completion',
        choices: [
          {
            index: 0,
            message: { role: 'assistant', content: '', reasoning_content: '' },
            finish_reason: 'stop',
          },
        ],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        created: this.created,
      }

      let reasoningText = ''
      let summaryText = ''
      let resolved = false

      const resolveOnce = (value: any) => {
        if (!resolved) {
          resolved = true
          resolve(value)
        }
      }

      const rejectOnce = (reason: any) => {
        if (!resolved) {
          resolved = true
          reject(reason)
        }
      }

      const parser = createParser({
        onEvent: (event: any) => {
          try {
            if (event.data === '[DONE]') return

            const parsed = JSON.parse(event.data)

            if (parsed['response.created']?.response_id) {
              this.responseId = parsed['response.created'].response_id
              data.id = this.responseId
            }

            if (parsed.choices && parsed.choices.length > 0) {
              const delta = parsed.choices[0].delta || {}
              const phase = delta.phase
              const status = delta.status
              const content = delta.content || ''

              if (phase === 'think' && status !== 'finished') {
                reasoningText += content
              } else if (phase === 'thinking_summary') {
                // Handle thinking_summary phase - extract summary content
                const extra = delta.extra || {}
                if (extra.summary_thought?.content) {
                  const newSummary = extra.summary_thought.content.join('\n')
                  if (newSummary && newSummary.length > summaryText.length) {
                    summaryText = newSummary
                  }
                }
              } else if (phase === 'answer') {
                if (content) {
                  data.choices[0].message.content += content
                }
                if (status === 'finished') {
                  // Use reasoningText or summaryText for reasoning_content
                  const finalReasoning = reasoningText || summaryText
                  if (finalReasoning) {
                    data.choices[0].message.reasoning_content = finalReasoning
                  }

                  if (this.onEnd && this.chatId) {
                    this.onEnd(this.chatId)
                  }

                  resolveOnce(data)
                }
              } else if (phase === null && content) {
                data.choices[0].message.content += content
              }
            }
          } catch (err) {
            console.error('[QwenAI] Non-stream parse error:', err)
            rejectOnce(err)
          }
        },
      })

      stream.on('data', (buffer: Buffer) => parser.feed(buffer.toString()))
      stream.once('error', (err: Error) => {
        console.error('[QwenAI] Non-stream error:', err)
        rejectOnce(err)
      })
      stream.once('close', () => {
        // Use reasoningText or summaryText for reasoning_content
        const finalReasoning = reasoningText || summaryText
        if (finalReasoning) {
          data.choices[0].message.reasoning_content = finalReasoning
        }
        resolveOnce(data)
      })
    })
  }

  getChatId(): string {
    return this.chatId
  }

  getResponseId(): string {
    return this.responseId
  }
}

export const qwenAiAdapter = {
  QwenAiAdapter,
  QwenAiStreamHandler,
}
