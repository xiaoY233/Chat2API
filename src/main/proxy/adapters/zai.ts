/**
 * Z.ai Adapter
 * Implements Z.ai (GLM International) API protocol
 */

import axios, { AxiosResponse } from 'axios'
import crypto from 'crypto'
import { PassThrough } from 'stream'
import { createParser } from 'eventsource-parser'
import FormData from 'form-data'
import { Account, Provider } from '../../store/types'
import { hasToolUse, parseToolUse, ToolCall } from '../promptToolUse'

const ZAI_API_BASE = 'https://chat.z.ai'
const X_FE_VERSION = 'prod-fe-1.0.241'

const FAKE_HEADERS = {
  Accept: '*/*',
  'Accept-Encoding': 'gzip, deflate, br, zstd',
  'Accept-Language': 'zh-CN,zh;q=0.9',
  'Cache-Control': 'no-cache',
  Origin: ZAI_API_BASE,
  Pragma: 'no-cache',
  'Sec-Ch-Ua': '"Chromium";v="144", "Not(A:Brand";v="8", "Google Chrome";v="144"',
  'Sec-Ch-Ua-Mobile': '?0',
  'Sec-Ch-Ua-Platform': '"Windows"',
  'Sec-Fetch-Dest': 'empty',
  'Sec-Fetch-Mode': 'cors',
  'Sec-Fetch-Site': 'same-origin',
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/144.0.0.0 Safari/537.36',
  'X-FE-Version': X_FE_VERSION,
}

interface ZaiMessage {
  role: 'user' | 'assistant' | 'system'
  content: string | any[]
}

interface ChatCompletionRequest {
  model: string
  messages: ZaiMessage[]
  stream?: boolean
  temperature?: number
  web_search?: boolean
  reasoning_effort?: 'low' | 'medium' | 'high'
}

function uuid(separator: boolean = true): string {
  const id = 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0
    const v = c === 'x' ? r : (r & 0x3) | 0x8
    return v.toString(16)
  })
  return separator ? id : id.replace(/-/g, '')
}

export class ZaiAdapter {
  private provider: Provider
  private account: Account
  private token: string | null = null

  constructor(provider: Provider, account: Account) {
    this.provider = provider
    this.account = account
  }

  private getToken(): string {
    const credentials = this.account.credentials
    return credentials.token || credentials.accessToken || credentials.jwt || ''
  }

  private async ensureToken(): Promise<string> {
    const token = this.getToken()
    if (token) {
      return token
    }
    throw new Error('Z.ai token not configured, please add token in account settings')
  }

  private extractLastUserMessage(messages: ZaiMessage[]): string {
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === 'user') {
        const content = messages[i].content
        if (typeof content === 'string') {
          return content
        }
        if (Array.isArray(content)) {
          const textParts: string[] = []
          for (const part of content) {
            if (typeof part === 'object' && part !== null && part.type === 'text' && part.text) {
              textParts.push(part.text)
            }
          }
          if (textParts.length > 0) {
            return textParts.join('\n')
          }
        }
        return ''
      }
    }
    return ''
  }

  private extractUserIDFromToken(token: string): string {
    try {
      const parts = token.split('.')
      if (parts.length < 2) {
        return 'guest'
      }
      let payload = parts[1]
      const padding = payload.length % 4
      if (padding > 0) {
        payload += '='.repeat(4 - padding)
      }
      payload = payload.replace(/-/g, '+').replace(/_/g, '/')
      const decoded = Buffer.from(payload, 'base64').toString('utf8')
      const data = JSON.parse(decoded)
      return data.id || data.user_id || data.uid || data.sub || 'guest'
    } catch {
      return 'guest'
    }
  }

  private generateSignature(messageText: string, requestId: string, timestampMs: number, userId: string): string {
    const secret = 'key-@@@@)))()((9))-xxxx&&&%%%%%'
    const r = timestampMs
    const i = String(timestampMs)
    const e = `requestId,${requestId},timestamp,${timestampMs},user_id,${userId}`
    
    // a = message text UTF-8 bytes
    const a = Buffer.from(messageText, 'utf-8')
    // w = base64 encode of message text
    const w = a.toString('base64')
    // c = canonical string: metadata | base64_message | timestamp_string
    const canonicalString = `${e}|${w}|${i}`

    // E = window index (5 minute window)
    const windowIndex = Math.floor(r / (5 * 60 * 1000))
    
    // Layer1: A = HMAC(secret, window_index) -> hex string
    const derivedKeyHex = crypto.createHmac('sha256', secret).update(String(windowIndex)).digest('hex')
    
    // Layer2: k = HMAC(A_hex, canonical_string) -> hex string
    const signature = crypto.createHmac('sha256', derivedKeyHex).update(canonicalString).digest('hex')

    return signature
  }

  async createChat(model: string = 'glm-5', firstMessageContent: string = ''): Promise<{ chatId: string; messageId: string }> {
    const token = await this.ensureToken()
    const timestamp = Math.floor(Date.now() / 1000)
    const messageId = uuid()
    
    console.log('[Z.ai] Creating chat with model:', model)
    
    const requestBody = {
      chat: {
        id: '',
        title: 'New Chat',
        models: [model],
        params: {},
        history: {
          messages: firstMessageContent ? {
            [messageId]: {
              id: messageId,
              parentId: null,
              childrenIds: [],
              role: 'user',
              content: firstMessageContent,
              timestamp,
              models: [model],
            },
          } : {},
          currentId: firstMessageContent ? messageId : '',
        },
        tags: [],
        flags: [],
        features: [
          {
            type: 'tool_selector',
            server: 'tool_selector_h',
            status: 'hidden',
          },
        ],
        mcp_servers: [],
        enable_thinking: false,
        auto_web_search: false,
        message_version: 1,
        extra: {},
        timestamp: Date.now(),
      },
    }
    
    const response = await axios.post(
      `${ZAI_API_BASE}/api/v1/chats/new`,
      requestBody,
      {
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
          'X-FE-Version': X_FE_VERSION,
          'Cookie': `token=${token}`,
          Origin: ZAI_API_BASE,
          Referer: `${ZAI_API_BASE}/`,
          'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/144.0.0.0 Safari/537.36',
        },
        timeout: 15000,
        validateStatus: () => true,
      }
    )

    if (response.status !== 200 && response.status !== 201) {
      console.error('[Z.ai] Create chat response:', response.status, response.data)
      throw new Error(`Failed to create chat: HTTP ${response.status}`)
    }

    console.log('[Z.ai] Chat created:', response.data.id)
    return { chatId: response.data.id, messageId }
  }

  async deleteChat(chatId: string): Promise<boolean> {
    try {
      const token = await this.ensureToken()
      
      const response = await axios.delete(
        `${ZAI_API_BASE}/api/v1/chats/${chatId}`,
        {
          headers: {
            Authorization: `Bearer ${token}`,
            ...FAKE_HEADERS,
            Referer: `${ZAI_API_BASE}/`,
          },
          timeout: 15000,
          validateStatus: () => true,
        }
      )

      console.log('[Z.ai] Chat deleted:', chatId, 'Status:', response.status)
      return response.status === 200 || response.status === 204
    } catch (error) {
      console.error('[Z.ai] Failed to delete chat:', error)
      return false
    }
  }

  async chatCompletion(request: ChatCompletionRequest): Promise<{ response: AxiosResponse; chatId: string }> {
    const token = await this.ensureToken()
    const userId = this.extractUserIDFromToken(token)
    
    console.log('[Z.ai] chatCompletion called with request.model:', request.model)
    
    const modelMapping: Record<string, string> = {
      'GLM-5': 'glm-5',
      'GLM-4.7': 'glm-4.7',
      'GLM-4.6V': 'glm-4.6v',
      'GLM-4.6': 'glm-4.6v',
      'glm-5': 'glm-5',
      'glm-4.7': 'glm-4.7',
      'glm-4.6v': 'glm-4.6v',
      'glm-4.6': 'glm-4.6v',
    }
    const mappedModel = modelMapping[request.model] || request.model
    
    console.log('[Z.ai] Original model:', request.model, '-> Mapped model:', mappedModel)
    
    // Extract system message and merge with user message
    let systemContent = ''
    let processedMessages = []
    
    for (const msg of request.messages) {
      if (msg.role === 'system') {
        systemContent += (systemContent ? '\n\n' : '') + (typeof msg.content === 'string' ? msg.content : '')
      } else {
        processedMessages.push(msg)
      }
    }
    
    // If system prompt exists, prepend it to the first user message
    if (systemContent && processedMessages.length > 0) {
      const firstUserIdx = processedMessages.findIndex(m => m.role === 'user')
      if (firstUserIdx !== -1) {
        const firstUserMsg = processedMessages[firstUserIdx]
        const originalContent = typeof firstUserMsg.content === 'string' 
          ? firstUserMsg.content 
          : (Array.isArray(firstUserMsg.content) 
              ? firstUserMsg.content.find((p: any) => p.type === 'text')?.text || '' 
              : '')
        
        processedMessages[firstUserIdx] = {
          ...firstUserMsg,
          content: `${systemContent}\n\nUser: ${originalContent}`
        }
      }
    }
    
    const signaturePrompt = this.extractLastUserMessage(processedMessages)
    const { chatId, messageId } = await this.createChat(mappedModel, signaturePrompt)
    const requestId = uuid()
    const timestamp = Date.now()
    const signature = this.generateSignature(signaturePrompt, requestId, timestamp, userId)

    const features = {
      image_generation: false,
      web_search: request.web_search || false,
      auto_web_search: false,
      preview_mode: true,
      flags: [],
      enable_thinking: !!request.reasoning_effort,
    }

    const requestBody = {
      stream: request.stream !== false,
      model: mappedModel,
      messages: processedMessages,
      signature_prompt: signaturePrompt,
      params: {},
      extra: {},
      features,
      variables: {
        '{{USER_NAME}}': 'User',
        '{{USER_LOCATION}}': 'Unknown',
        '{{CURRENT_DATETIME}}': new Date().toISOString().replace('T', ' ').substring(0, 19),
        '{{CURRENT_DATE}}': new Date().toISOString().substring(0, 10),
        '{{CURRENT_TIME}}': new Date().toISOString().substring(11, 19),
        '{{CURRENT_WEEKDAY}}': ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][new Date().getDay()],
        '{{CURRENT_TIMEZONE}}': 'UTC',
        '{{USER_LANGUAGE}}': 'en-US',
      },
      chat_id: chatId,
      id: requestId,
      current_user_message_id: messageId,
      current_user_message_parent_id: null,
      background_tasks: {
        title_generation: true,
        tags_generation: true,
      },
    }

    console.log('[Z.ai] Sending chat request...')
    console.log('[Z.ai] Model:', request.model)
    console.log('[Z.ai] ChatId:', chatId)
    console.log('[Z.ai] MessageId (current_user_message_id):', messageId)
    console.log('[Z.ai] Features:', JSON.stringify(features))

    const queryParams = new URLSearchParams({
      timestamp: String(timestamp),
      requestId,
      user_id: userId,
      version: '0.0.1',
      platform: 'web',
      token,
      user_agent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/144.0.0.0 Safari/537.36',
      language: 'zh-CN',
      languages: 'zh-CN,zh',
      timezone: 'Asia/Shanghai',
      cookie_enabled: 'true',
      screen_width: '1512',
      screen_height: '982',
      screen_resolution: '1512x982',
      viewport_height: '945',
      viewport_width: '923',
      viewport_size: '923x945',
      color_depth: '30',
      pixel_ratio: '2',
      current_url: `${ZAI_API_BASE}/c/${chatId}`,
      pathname: `/c/${chatId}`,
      search: '',
      hash: '',
      host: 'chat.z.ai',
      hostname: 'chat.z.ai',
      protocol: 'https:',
      referrer: '',
      title: 'Z.ai - Free AI Chatbot & Agent powered by GLM-5 & GLM-4.7',
      timezone_offset: '-480',
      local_time: new Date().toISOString(),
      utc_time: new Date().toUTCString(),
      is_mobile: 'false',
      is_touch: 'false',
      max_touch_points: '0',
      browser_name: 'Chrome',
      os_name: 'Mac OS',
      signature_timestamp: String(timestamp),
    })

    const response = await axios.post(
      `${ZAI_API_BASE}/api/v2/chat/completions?${queryParams.toString()}`,
      requestBody,
      {
        headers: {
          'Accept': '*/*',
          'Accept-Encoding': 'gzip, deflate, br, zstd',
          'Accept-Language': 'zh-CN',
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
          'X-Signature': signature,
          'X-FE-Version': X_FE_VERSION,
          'Cookie': `token=${token}`,
          Origin: ZAI_API_BASE,
          Referer: `${ZAI_API_BASE}/c/${chatId}`,
          'Sec-Fetch-Dest': 'empty',
          'Sec-Fetch-Mode': 'cors',
          'Sec-Fetch-Site': 'same-origin',
          'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/144.0.0.0 Safari/537.36',
          'sec-ch-ua': '"Not(A:Brand";v="8", "Chromium";v="144", "Google Chrome";v="144"',
          'sec-ch-ua-mobile': '?0',
          'sec-ch-ua-platform': '"macOS"',
          Priority: 'u=1, i',
        },
        responseType: request.stream !== false ? 'stream' : 'json',
        timeout: 120000,
        validateStatus: () => true,
      }
    )

    console.log('[Z.ai] Response status:', response.status)
    if (response.status !== 200) {
      console.log('[Z.ai] Request body:', JSON.stringify(requestBody, null, 2))
      console.log('[Z.ai] Signature:', signature)
      console.log('[Z.ai] Timestamp:', timestamp)
      console.log('[Z.ai] RequestId:', requestId)
      console.log('[Z.ai] UserId:', userId)
      if (response.data && typeof response.data.on === 'function') {
        const chunks: Buffer[] = []
        response.data.on('data', (chunk: Buffer) => chunks.push(chunk))
        await new Promise<void>((resolve) => {
          response.data.on('end', () => resolve())
          response.data.on('error', () => resolve())
        })
        const errorBody = Buffer.concat(chunks).toString('utf8')
        console.log('[Z.ai] Error response body:', errorBody)
      } else if (response.data) {
        console.log('[Z.ai] Error response data:', JSON.stringify(response.data, null, 2))
      }
    }

    return { response, chatId }
  }

  static isZaiProvider(provider: Provider): boolean {
    return provider.id === 'zai' || provider.apiEndpoint.includes('z.ai') || provider.apiEndpoint.includes('chat.z.ai')
  }
}

export class ZaiStreamHandler {
  private chatId: string = ''
  private model: string
  private created: number
  private onEnd?: (chatId: string) => void
  private content: string = ''
  private toolCallsSent: boolean = false

  constructor(model: string, onEnd?: (chatId: string) => void) {
    this.model = model
    this.created = Math.floor(Date.now() / 1000)
    this.onEnd = onEnd
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
            id: this.chatId,
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
          id: this.chatId,
          model: this.model,
          object: 'chat.completion.chunk',
          choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
          created: this.created,
        })}\n\n`
      )
      transStream.end('data: [DONE]\n\n')
      if (this.onEnd) {
        try {
          this.onEnd(this.chatId)
        } catch (e) {
          console.error('[Z.ai] onEnd callback error:', e)
        }
      }
    }
  }

  async handleStream(stream: any): Promise<PassThrough> {
    const transStream = new PassThrough()

    console.log('[Z.ai] Starting stream handler...')

    transStream.write(
      `data: ${JSON.stringify({
        id: '',
        model: this.model,
        object: 'chat.completion.chunk',
        choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }],
        created: this.created,
      })}\n\n`
    )

    const parser = createParser({
      onEvent: (event: any) => {
        try {
          if (event.data === '[DONE]') return

          const data = JSON.parse(event.data)
          
          if (data.type !== 'chat:completion') return
          
          const result = data.data
          if (!result) return

          if (result.phase === 'answer' && result.delta_content) {
            this.content += result.delta_content
            transStream.write(
              `data: ${JSON.stringify({
                id: this.chatId,
                model: this.model,
                object: 'chat.completion.chunk',
                choices: [{ index: 0, delta: { content: result.delta_content }, finish_reason: null }],
                created: this.created,
              })}\n\n`
            )
          } else if (result.phase === 'done' && result.done) {
            console.log('[Z.ai] Stream finished, content length:', this.content.length)
            
            // Check for tool calls before sending stop
            if (hasToolUse(this.content)) {
              console.log('[Z.ai] Found tool_use in stream, sending tool_calls')
              this.sendToolCalls(transStream)
              return
            }
            
            const usage = result.usage || { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }
            
            transStream.write(
              `data: ${JSON.stringify({
                id: this.chatId,
                model: this.model,
                object: 'chat.completion.chunk',
                choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
                usage,
                created: this.created,
              })}\n\n`
            )
            transStream.end('data: [DONE]\n\n')
            if (this.onEnd) {
              try {
                this.onEnd(this.chatId)
              } catch (e) {
                console.error('[Z.ai] onEnd callback error:', e)
              }
            }
          } else if (result.error || data.error) {
            const error = result.error || data.error
            console.error('[Z.ai] Stream error:', error)
            transStream.write(
              `data: ${JSON.stringify({
                id: this.chatId,
                model: this.model,
                object: 'chat.completion.chunk',
                choices: [{ index: 0, delta: { content: `\nError: ${error.detail || JSON.stringify(error)}` }, finish_reason: 'stop' }],
                created: this.created,
              })}\n\n`
            )
            transStream.end('data: [DONE]\n\n')
          }
        } catch (err) {
          console.error('[Z.ai] Stream parse error:', err)
        }
      },
    })

    stream.on('data', (buffer: Buffer) => parser.feed(buffer.toString()))
    stream.once('error', (err: Error) => {
      console.error('[Z.ai] Stream error:', err)
      transStream.end('data: [DONE]\n\n')
    })
    stream.once('close', () => {
      console.log('[Z.ai] Stream closed')
      transStream.end('data: [DONE]\n\n')
    })

    return transStream
  }

  async handleNonStream(response: any): Promise<any> {
    console.log('[Z.ai] Starting non-stream handler...')
    
    return new Promise((resolve, reject) => {
      const data = {
        id: '',
        model: this.model,
        object: 'chat.completion',
        choices: [
          {
            index: 0,
            message: { role: 'assistant', content: '' },
            finish_reason: 'stop',
          },
        ],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        created: this.created,
      }

      // Check if response.data is a stream or JSON
      if (response.data && typeof response.data.on === 'function') {
        // Stream response
        const parser = createParser({
          onEvent: (event: any) => {
            try {
              if (event.data === '[DONE]') return

              const eventData = JSON.parse(event.data)
              
              if (eventData.type !== 'chat:completion') return
              
              const result = eventData.data
              if (!result) return

              if (result.phase === 'answer' && result.delta_content) {
                data.choices[0].message.content += result.delta_content
              } else if (result.phase === 'done' && result.done) {
                console.log('[Z.ai] Non-stream finished, content length:', data.choices[0].message.content.length)
                if (result.usage) {
                  data.usage = result.usage
                }
                resolve(data)
              } else if (result.error || eventData.error) {
                const error = result.error || eventData.error
                data.choices[0].message.content += `\nError: ${error.detail || JSON.stringify(error)}`
                resolve(data)
              }
            } catch (err) {
              console.error('[Z.ai] Non-stream parse error:', err)
              reject(err)
            }
          },
        })

        response.data.on('data', (buffer: Buffer) => parser.feed(buffer.toString()))
        response.data.once('error', reject)
        response.data.once('close', () => resolve(data))
      } else if (response.data) {
        // JSON response - parse directly
        try {
          const responseData = response.data
          
          // Handle SSE format in JSON response
          if (typeof responseData === 'string') {
            let content = ''
            const lines = responseData.split('\n')
            for (const line of lines) {
              if (line.startsWith('data:')) {
                const jsonStr = line.substring(5).trim()
                if (jsonStr === '[DONE]') continue
                try {
                  const event = JSON.parse(jsonStr)
                  if (event.type === 'chat:completion' && event.data) {
                    if (event.data.phase === 'answer' && event.data.delta_content) {
                      content += event.data.delta_content
                    } else if (event.data.phase === 'done' && event.data.done) {
                      if (event.data.usage) {
                        data.usage = event.data.usage
                      }
                    }
                  }
                } catch (e) {
                  // Ignore parse errors for individual lines
                }
              }
            }
            data.choices[0].message.content = content
          } else {
            // Direct JSON object
            data.choices[0].message.content = responseData.choices?.[0]?.message?.content || ''
          }
          
          console.log('[Z.ai] Non-stream JSON finished, content length:', data.choices[0].message.content.length)
          resolve(data)
        } catch (err) {
          console.error('[Z.ai] Non-stream JSON parse error:', err)
          reject(err)
        }
      } else {
        resolve(data)
      }
    })
  }

  getChatId(): string {
    return this.chatId
  }
}

export const zaiAdapter = {
  ZaiAdapter,
  ZaiStreamHandler,
}
