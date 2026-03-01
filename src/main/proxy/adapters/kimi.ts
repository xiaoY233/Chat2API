/**
 * Kimi K2.5 Adapter
 * Implements Kimi web API protocol with thinking mode and web search support
 */

import axios, { AxiosResponse } from 'axios'
import { Account, Provider } from '../../store/types'
import { PassThrough } from 'stream'
import { toolsToSystemPrompt, TOOL_WRAP_HINT } from '../utils/tools'
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

  private messagesPrepare(messages: KimiMessage[], toolsPrompt?: string): string {
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

    // Clone messages to avoid modifying original request
    const messages = [...request.messages]

    let toolsPrompt = ''
    // Inject tools definition into prompt if tools are provided
    if (request.tools && request.tools.length > 0) {
      // Use simple prompt for Kimi to avoid confusion with prefixes
      toolsPrompt = toolsToSystemPrompt(request.tools, true)

      // Append tool hint to the last user message
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

    const content = this.messagesPrepare(messages, toolsPrompt)

    const enableThinking = request.enableThinking ?? false
    const enableWebSearch = request.enableWebSearch ?? false

    console.log(`[Kimi] Model: ${request.model}, thinking: ${enableThinking}, webSearch: ${enableWebSearch}`)

    const jsonBody = JSON.stringify({
      scenario: 'SCENARIO_K2D5',
      tools: enableWebSearch ? [{ type: 'TOOL_TYPE_SEARCH', search: {} }] : [],
      message: {
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

    return { response, conversationId: `kimi-${Date.now()}` }
  }

  static isKimiProvider(provider: Provider): boolean {
    return provider.id === 'kimi' || provider.apiEndpoint.includes('kimi.com')
  }
}

export class KimiStreamHandler {
  private model: string
  private conversationId: string
  private enableThinking: boolean
  private toolCallState: ToolCallState

  constructor(model: string, conversationId: string, enableThinking: boolean = false) {
    this.model = model
    this.conversationId = conversationId
    this.enableThinking = enableThinking
    this.toolCallState = createToolCallState()
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

    // Send role on first content
    if (!getSentRole() && (data.op === 'set' || data.op === 'append') && data.block?.text?.content) {
      transStream.write(`data: ${JSON.stringify({
        id: this.conversationId,
        model: this.model,
        object: 'chat.completion.chunk',
        choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }],
        created,
      })}\n\n`)
      setSentRole(true)
    }

    // Handle text content
    if (data.op === 'set' && data.block?.text?.content) {
      const content = data.block.text.content
      this.sendChunk(transStream, content, created)
    }

    if (data.op === 'append' && data.block?.text?.content) {
      const content = data.block.text.content
      this.sendChunk(transStream, content, created)
    }

    // Handle completion
    if (data.done !== undefined) {
      transStream.write(`data: ${JSON.stringify({
        id: this.conversationId,
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
    const baseChunk = createBaseChunk(this.conversationId, this.model, created)
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
    let buffer = Buffer.alloc(0)

    return new Promise((resolve, reject) => {
      stream.on('data', (chunk: Buffer) => {
        buffer = Buffer.concat([buffer, chunk])

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
                reject(new Error(`Kimi API Error: ${data.error.message || JSON.stringify(data.error)}`))
                return
              }

              if (data.op === 'set' && data.block?.text?.content) {
                content += data.block.text.content
              }

              if (data.op === 'append' && data.block?.text?.content) {
                content += data.block.text.content
              }

              if (data.done !== undefined) {
                // Parse tool calls from accumulated content
                const { content: cleanContent, toolCalls } = parseToolCallsFromText(content, 'kimi')

                resolve({
                  id: this.conversationId,
                  model: this.model,
                  object: 'chat.completion',
                  created,
                  choices: [{
                    index: 0,
                    message: { 
                      role: 'assistant', 
                      content: toolCalls.length > 0 ? null : cleanContent.trim(),
                      ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {})
                    },
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
        // Parse tool calls from accumulated content
        const { content: cleanContent, toolCalls } = parseToolCallsFromText(content, 'kimi')

        resolve({
          id: this.conversationId,
          model: this.model,
          object: 'chat.completion',
          created,
          choices: [{
            index: 0,
            message: { 
              role: 'assistant', 
              content: toolCalls.length > 0 ? null : cleanContent.trim(),
              ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {})
            },
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
