/**
 * Kimi K2.5 Adapter
 * Implements Kimi web API protocol with thinking mode and web search support
 */

import axios, { AxiosResponse } from 'axios'
import { Account, Provider } from '../../store/types'
import { PassThrough } from 'stream'
import { toolsToSystemPrompt, TOOL_WRAP_HINT, hasToolPromptInjected } from '../utils/tools'
import { parseToolCallsFromText } from '../utils/toolParser'
import { 
  createToolCallState, 
  processStreamContent, 
  flushToolCallBuffer,
  createBaseChunk,
  ToolCallState 
} from '../utils/streamToolHandler'

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

interface ChatCompletionRequest {
  model: string
  messages: KimiMessage[]
  stream?: boolean
  temperature?: number
  enableThinking?: boolean
  enableWebSearch?: boolean
  tools?: any[]
  tool_choice?: any
  conversationId?: string
  parentId?: string
  isMultiTurn?: boolean
  sessionContext?: {
    sessionId: string
    providerSessionId?: string
    parentMessageId?: string
    messages: any[]
    isNew: boolean
  }
}

const accessTokenMap = new Map<string, TokenInfo>()

function unixTimestamp(): number {
  return Math.floor(Date.now() / 1000)
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

function extractUserIdFromJWT(token: string): string | undefined {
  try {
    const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64').toString())
    return payload.sub
  } catch (e) {
    return undefined
  }
}

function checkResult(result: AxiosResponse, refreshToken: string): any {
  if (result.status === 401) {
    accessTokenMap.delete(refreshToken)
    throw new Error('Token invalid or expired')
  }
  if (!result.data) {
    return null
  }
  const { error_type, message } = result.data
  if (typeof error_type !== 'string') {
    return result.data
  }
  if (error_type === 'auth.token.invalid') {
    accessTokenMap.delete(refreshToken)
  }
  throw new Error(`Kimi API error: ${message || error_type}`)
}

export class KimiAdapter {
  private provider: Provider
  private account: Account
  private token: string

  constructor(provider: Provider, account: Account) {
    this.provider = provider
    this.account = account
    this.token = account.credentials.token || account.credentials.refreshToken || ''
  }

  private async acquireToken(): Promise<{ accessToken: string; userId: string }> {
    if (!this.token) {
      throw new Error('Kimi Token not configured')
    }

    let result = accessTokenMap.get(this.token)
    if (result && result.refreshTime > unixTimestamp()) {
      console.log('[Kimi] Using cached token')
      return { accessToken: result.accessToken, userId: result.userId }
    }

    const tokenType = detectTokenType(this.token)
    console.log('[Kimi] Token type:', tokenType)

    if (tokenType === 'jwt') {
      const userId = extractUserIdFromJWT(this.token) || ''
      accessTokenMap.set(this.token, {
        accessToken: this.token,
        refreshToken: this.token,
        userId,
        refreshTime: unixTimestamp() + 300,
      })
      console.log('[Kimi] Using JWT token, userId:', userId)
      return { accessToken: this.token, userId }
    }

    console.log('[Kimi] Non-JWT token detected, attempting direct use...')
    accessTokenMap.set(this.token, {
      accessToken: this.token,
      refreshToken: this.token,
      userId: '',
      refreshTime: unixTimestamp() + 300,
    })
    return { accessToken: this.token, userId: '' }
  }

  private messagesPrepare(messages: KimiMessage[], toolsPrompt?: string, isMultiTurn: boolean = false): string {
    // Process messages including tool calls and tool responses
    const processedMessages = messages.map(msg => {
      // Handle tool calls in assistant message
      if (msg.role === 'assistant' && msg.tool_calls && msg.tool_calls.length > 0) {
        const toolCallsText = msg.tool_calls.map(tc => {
          return `[call:${tc.function.name}]${tc.function.arguments}[/call]`
        }).join('\n')
        return { ...msg, content: `[function_calls]\n${toolCallsText}\n[/function_calls]` }
      }
      // Handle tool response message
      if (msg.role === 'tool' && msg.tool_call_id) {
        return { 
          ...msg, 
          role: 'user' as const,
          content: `[TOOL_RESULT for ${msg.tool_call_id}] ${msg.content || ''}` 
        }
      }
      return msg
    })

    // Extract system message first
    let systemContent = ''
    const otherMessages = processedMessages.filter(msg => {
      if (msg.role === 'system') {
        const text = typeof msg.content === 'string' ? msg.content : ''
        systemContent = text
        return false
      }
      return true
    })

    let content = ''

    // Prepend system message if exists
    if (systemContent) {
      content = `system:${systemContent}\n`
    }

    // For multi-turn with existing session, only send the last user message
    if (isMultiTurn) {
      // Find last user message index manually (ES2021 compatible)
      let lastUserIdx = -1
      for (let i = otherMessages.length - 1; i >= 0; i--) {
        if (otherMessages[i].role === 'user') {
          lastUserIdx = i
          break
        }
      }
      
      if (lastUserIdx !== -1) {
        const lastUserMsg = otherMessages[lastUserIdx]
        const text = typeof lastUserMsg.content === 'string' ? lastUserMsg.content : ''
        content += `user:${this.wrapUrlsToTags(text)}\n`
        
        // Include any tool results after the last user message
        for (let i = lastUserIdx + 1; i < otherMessages.length; i++) {
          if (otherMessages[i].role === 'user') {
            const toolText = typeof otherMessages[i].content === 'string' ? otherMessages[i].content : ''
            content += `user:${toolText}\n`
          }
        }
        
        if (toolsPrompt) {
          content = content.trim() + "\n\n" + toolsPrompt
        }
        return content
      }
    }

    if (otherMessages.length < 2) {
      content += otherMessages.reduce((acc, msg) => {
        const text = typeof msg.content === 'string' ? msg.content : ''
        return acc + `${msg.role === 'user' ? this.wrapUrlsToTags(text) : text}\n`
      }, '')
    } else {
      const latestMessage = otherMessages[otherMessages.length - 1]
      const hasFileOrImage = Array.isArray(latestMessage.content) &&
        latestMessage.content.some((v: any) => typeof v === 'object' && ['file', 'image_url'].includes(v.type))

      if (hasFileOrImage) {
        otherMessages.splice(otherMessages.length - 1, 0, {
          content: 'Focus on the latest files and messages sent by user',
          role: 'system' as const,
        })
      } else {
        otherMessages.splice(otherMessages.length - 1, 0, {
          content: 'Focus on the latest message from user',
          role: 'system' as const,
        })
      }

      content += otherMessages.reduce((acc, msg) => {
        const text = typeof msg.content === 'string' ? msg.content : ''
        return acc + `${msg.role}:${msg.role === 'user' ? this.wrapUrlsToTags(text) : text}\n`
      }, '')
    }

    // Inject tools prompt at the VERY END of the content to maximize attention
    if (toolsPrompt) {
      content = content.trim() + "\n\n" + toolsPrompt
    }

    return content
  }

  private wrapUrlsToTags(content: string): string {
    return content.replace(
      /https?:\/\/(www\.)?[-a-zA-Z0-9@:%._\+~#=]{2,256}\.[a-z]{2,6}\b([-a-zA-Z0-9@:%_\+.~#?&//=]*)/gi,
      url => `<url id="" type="url" status="" title="" wc="">${url}</url>`
    )
  }

  async chatCompletion(request: ChatCompletionRequest): Promise<{ response: AxiosResponse; conversationId: string }> {
    const { accessToken } = await this.acquireToken()

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

    // Use session context passed from forwarder - MUST be defined before messagesPrepare
    const sessionContext = request.sessionContext
    const isMultiTurn = sessionContext && !sessionContext.isNew
    
    // Use providerSessionId (existing chat_id) if available
    const chatId = sessionContext?.providerSessionId || ''
    // Use parentMessageId (previous message id) if available
    const parentId = sessionContext?.parentMessageId || ''

    console.log(`[Kimi] Model: ${request.model}, chatId: ${chatId || '(new)'}, parentId: ${parentId || '(none)'}, isMultiTurn: ${isMultiTurn}`)

    const content = this.messagesPrepare(messages, toolsPrompt, isMultiTurn)

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

    const jsonBody = JSON.stringify({
      scenario: 'SCENARIO_K2D5',
      chat_id: chatId,
      tools: enableWebSearch ? [{ type: 'TOOL_TYPE_SEARCH', search: {} }] : [],
      message: {
        parent_id: parentId,
        role: 'user',
        blocks: [{
          message_id: '',
          text: { content }
        }],
        scenario: 'SCENARIO_K2D5'
      },
      options: {
        thinking: enableThinking
      }
    })

    // gRPC-Web frame format: 1 byte flag (0x00) + 4 bytes length (big-endian) + JSON payload
    const jsonBuffer = Buffer.from(jsonBody, 'utf8')
    const frameBuffer = Buffer.alloc(5 + jsonBuffer.length)
    frameBuffer.writeUInt8(0, 0) // flag = 0
    frameBuffer.writeUInt32BE(jsonBuffer.length, 1) // length
    jsonBuffer.copy(frameBuffer, 5)

    console.log('[Kimi] Request body length:', frameBuffer.length, 'JSON length:', jsonBuffer.length)

    const response = await axios.post(
      `${KIMI_API_BASE}/apiv2/kimi.gateway.chat.v1.ChatService/Chat`,
      frameBuffer,
      {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/connect+json',
          ...FAKE_HEADERS,
        },
        timeout: 120000,
        validateStatus: () => true,
        responseType: 'stream',
      }
    )

    console.log('[Kimi] Completion response status:', response.status)

    if (response.status === 401) {
      accessTokenMap.delete(this.token)
      throw new Error('Token invalid or expired')
    }

    if (response.status !== 200) {
      throw new Error(`Completion request failed: HTTP ${response.status}`)
    }

    // Return empty string for new conversations, real chat_id will be extracted from response
    return { response, conversationId: chatId }
  }

  async deleteConversation(conversationId: string): Promise<boolean> {
    try {
      const { accessToken } = await this.acquireToken()
      
      const response = await axios.post(
        `${KIMI_API_BASE}/apiv2/kimi.chat.v1.ChatService/DeleteChat`,
        { chat_id: conversationId },
        {
          headers: {
            Authorization: `Bearer ${accessToken}`,
            'Content-Type': 'application/json',
            ...FAKE_HEADERS,
          },
          timeout: 15000,
          validateStatus: () => true,
        }
      )

      console.log('[Kimi] Chat deleted:', conversationId, 'Status:', response.status)
      return response.status === 200
    } catch (error) {
      console.error('[Kimi] Failed to delete conversation:', error)
      return false
    }
  }

  static isKimiProvider(provider: Provider): boolean {
    return provider.id === 'kimi' || provider.apiEndpoint.includes('kimi.com')
  }
}

const STAGE_NAME_THINKING = 'STAGE_NAME_THINKING'

export class KimiStreamHandler {
  private model: string
  private conversationId: string
  private enableThinking: boolean
  private toolCallState: ToolCallState
  private realChatId: string | null = null
  private lastMessageId: string | null = null
  private hasError: boolean = false
  private currentPhase: 'thinking' | 'answer' | undefined = undefined
  private reasoningBuffer: string = ''

  constructor(model: string, conversationId: string, enableThinking: boolean = false) {
    this.model = model
    this.conversationId = conversationId
    this.enableThinking = enableThinking
    this.toolCallState = createToolCallState()
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

  private isThinkingMask(mask: string | undefined): boolean {
    if (!mask) return false
    return mask.includes('block.think')
  }

  private isAnswerMask(mask: string | undefined): boolean {
    if (!mask) return false
    return mask.includes('block.text')
  }

  private extractThinkContent(data: any): string | null {
    return data.block?.think?.content || null
  }

  private extractTextContent(data: any): string | null {
    return data.block?.text?.content || null
  }

  async handleStream(stream: any): Promise<PassThrough> {
    const transStream = new PassThrough()
    const created = unixTimestamp()
    let buffer = Buffer.alloc(0)
    let sentRole = false

    stream.on('data', (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk])
      this.processBuffer(buffer, transStream, created, (remaining) => { buffer = remaining }, () => sentRole, (v) => { sentRole = v })
    })

    stream.once('error', (err: Error) => {
      console.error('[Kimi] Stream error:', err.message)
      if (!transStream.closed) transStream.end('data: [DONE]\n\n')
    })

    stream.once('close', () => {
      console.log('[Kimi] Stream closed, realChatId:', this.realChatId, 'lastMessageId:', this.lastMessageId)
      if (!transStream.closed) transStream.end('data: [DONE]\n\n')
    })

    return transStream
  }

  private processBuffer(
    buffer: Buffer,
    transStream: PassThrough,
    created: number,
    setBuffer: (remaining: Buffer) => void,
    getSentRole: () => boolean,
    setSentRole: (v: boolean) => void
  ) {
    let offset = 0

    // gRPC-Web frame format: 1 byte flag + 4 bytes length (big-endian) + payload
    while (offset + 5 <= buffer.length) {
      const flag = buffer.readUInt8(offset)
      const length = buffer.readUInt32BE(offset + 1)

      if (offset + 5 + length > buffer.length) {
        break
      }

      const payload = buffer.slice(offset + 5, offset + 5 + length)

      try {
        const text = payload.toString('utf8')
        if (text.trim()) {
          const data = JSON.parse(text)
          
          // Check for error response
          if (data.error) {
            console.error('[Kimi] API Error:', data.error)
            this.hasError = true
            transStream.write(`data: ${JSON.stringify({
              id: this.conversationId,
              model: this.model,
              object: 'chat.completion.chunk',
              choices: [{ index: 0, delta: { content: `Error: ${data.error.message || JSON.stringify(data.error)}` }, finish_reason: null }],
              created,
            })}\n\n`)
            transStream.write(`data: ${JSON.stringify({
              id: this.conversationId,
              model: this.model,
              object: 'chat.completion.chunk',
              choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
              created,
            })}\n\n`)
            transStream.end('data: [DONE]\n\n')
            return
          }
          
          this.handleMessage(data, transStream, created, getSentRole, setSentRole)
        }
      } catch (e) {
        // Skip invalid JSON
      }

      offset += 5 + length
    }

    setBuffer(buffer.slice(offset))
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
        const thinkContent = this.extractThinkContent(data)
        if (thinkContent) {
          if (!getSentRole()) {
            transStream.write(`data: ${JSON.stringify({
              id: this.getConversationId(),
              model: this.model,
              object: 'chat.completion.chunk',
              choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }],
              created,
            })}\n\n`)
            setSentRole(true)
          }
          
          this.reasoningBuffer += thinkContent
          transStream.write(`data: ${JSON.stringify({
            id: this.getConversationId(),
            model: this.model,
            object: 'chat.completion.chunk',
            choices: [{ index: 0, delta: { reasoning_content: thinkContent }, finish_reason: null }],
            created,
          })}\n\n`)
        }
      } else if (this.isAnswerMask(mask)) {
        const textContent = this.extractTextContent(data)
        if (textContent) {
          if (!getSentRole()) {
            transStream.write(`data: ${JSON.stringify({
              id: this.getConversationId(),
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
        const content = data.block.text.content
        
        if (!getSentRole()) {
          transStream.write(`data: ${JSON.stringify({
            id: this.getConversationId(),
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
            id: this.getConversationId(),
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

    if (data.done !== undefined) {
      transStream.write(`data: ${JSON.stringify({
        id: this.getConversationId(),
        model: this.model,
        object: 'chat.completion.chunk',
        choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
        created,
      })}\n\n`)
      transStream.end('data: [DONE]\n\n')
    }
  }

  private sendChunk(transStream: PassThrough, content: string, created: number) {
    // Process tool call interception
    // Use getConversationId() to get the real chat_id if available
    const chatId = this.getConversationId() || this.conversationId
    const baseChunk = createBaseChunk(chatId, this.model, created)
    const { chunks: outputChunks } = processStreamContent(
      content, 
      this.toolCallState, 
      baseChunk, 
      false,
      'kimi'
    )

    // Check if we emitted tool calls first
    const hasToolCalls = outputChunks.some(c => c.choices?.[0]?.delta?.tool_calls)

    for (const outChunk of outputChunks) {
      transStream.write(`data: ${JSON.stringify(outChunk)}\n\n`)
    }

    // If we emitted tool calls, skip regular content output
    if (hasToolCalls) {
      // Tool calls emitted, skipping regular content
    }
  }

  async handleNonStream(stream: any): Promise<any> {
    const created = unixTimestamp()
    let content = ''
    let reasoningContent = ''
    let buffer = Buffer.alloc(0)
    let currentPhase: 'thinking' | 'answer' | undefined = undefined

    return new Promise((resolve, reject) => {
      stream.on('data', (chunk: Buffer) => {
        buffer = Buffer.concat([buffer, chunk])

        let offset = 0
        while (offset + 5 <= buffer.length) {
          const flag = buffer.readUInt8(offset)
          const length = buffer.readUInt32BE(offset + 1)

          if (offset + 5 + length > buffer.length) {
            break
          }

          const payload = buffer.slice(offset + 5, offset + 5 + length)

          try {
            const text = payload.toString('utf8')
            if (text.trim()) {
              const data = JSON.parse(text)

              if (data.error) {
                reject(new Error(`Kimi API Error: ${data.error.message || JSON.stringify(data.error)}`))
                return
              }

              if (data.chat?.id && !this.realChatId) {
                this.realChatId = data.chat.id
                console.log('[Kimi] Non-stream: Extracted real chat_id from chat.id:', this.realChatId)
              }

              if (data.message?.id && data.message?.role === 'assistant' && !this.lastMessageId) {
                this.lastMessageId = data.message.id
                console.log('[Kimi] Non-stream: Extracted assistant message id:', this.lastMessageId)
              }

              const multiStagePhase = this.detectMultiStage(data)
              if (multiStagePhase) {
                currentPhase = multiStagePhase
                console.log('[Kimi] Non-stream: Detected multiStage phase:', currentPhase)
              }

              if (data.block?.text?.flags === 'thinking') {
                currentPhase = 'thinking'
              } else if (data.block?.text?.flags === 'answer') {
                currentPhase = 'answer'
              }

              if ((data.op === 'set' || data.op === 'append')) {
                const mask = data.mask
                
                if (this.isThinkingMask(mask)) {
                  const thinkContent = this.extractThinkContent(data)
                  if (thinkContent) {
                    reasoningContent += thinkContent
                  }
                } else if (this.isAnswerMask(mask)) {
                  const textContent = this.extractTextContent(data)
                  if (textContent) {
                    content += textContent
                  }
                } else if (data.block?.text?.content) {
                  const textContent = data.block.text.content
                  if (currentPhase === 'thinking') {
                    reasoningContent += textContent
                  } else {
                    content += textContent
                  }
                }
              }

              if (data.done !== undefined) {
                const { content: cleanContent, toolCalls } = parseToolCallsFromText(content, 'kimi')

                const message: any = {
                  role: 'assistant',
                  content: toolCalls.length > 0 ? null : cleanContent.trim(),
                }

                if (reasoningContent.trim()) {
                  message.reasoning_content = reasoningContent.trim()
                }

                if (toolCalls.length > 0) {
                  message.tool_calls = toolCalls
                }

                resolve({
                  id: this.realChatId || this.conversationId,
                  model: this.model,
                  object: 'chat.completion',
                  created,
                  choices: [{
                    index: 0,
                    message,
                    finish_reason: toolCalls.length > 0 ? 'tool_calls' : 'stop',
                  }],
                  usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
                })
              }
            }
          } catch (e) {
            // Skip invalid JSON
          }

          offset += 5 + length
        }

        buffer = buffer.slice(offset)
      })

      stream.once('error', reject)
      stream.once('close', () => {
        const { content: cleanContent, toolCalls } = parseToolCallsFromText(content, 'kimi')

        const message: any = {
          role: 'assistant',
          content: toolCalls.length > 0 ? null : cleanContent.trim(),
        }

        if (reasoningContent.trim()) {
          message.reasoning_content = reasoningContent.trim()
        }

        if (toolCalls.length > 0) {
          message.tool_calls = toolCalls
        }

        resolve({
          id: this.conversationId,
          model: this.model,
          object: 'chat.completion',
          created,
          choices: [{
            index: 0,
            message,
            finish_reason: toolCalls.length > 0 ? 'tool_calls' : 'stop',
          }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        })
      })
    })
  }
}

export const kimiAdapter = {
  KimiAdapter,
  KimiStreamHandler,
}
