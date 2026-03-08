/**
 * Qwen Adapter
 * Implements Qwen (Tongyi Qianwen) web API protocol
 * Based on new chat2.qianwen.com API
 */

import axios, { AxiosResponse } from 'axios'
import { PassThrough } from 'stream'
import { createGunzip, createInflate, createBrotliDecompress } from 'zlib'
import * as ZstdCodec from 'zstd-codec'
import { createParser } from 'eventsource-parser'
import { Account, Provider } from '../../store/types'
import { hasToolUse, parseToolUse, ToolCall } from '../promptToolUse'
import { toolsToSystemPrompt, TOOL_WRAP_HINT, hasToolPromptInjected, shouldInjectToolPrompt } from '../utils/tools'
import { parseToolCallsFromText } from '../utils/toolParser'
import { 
  createToolCallState, 
  processStreamContent, 
  flushToolCallBuffer,
  createBaseChunk,
  ToolCallState 
} from '../utils/streamToolHandler'

/**
 * Check if content contains tool calls (both bracket and XML formats)
 */
function hasToolCalls(content: string): boolean {
  return content.includes('[function_calls]') || hasToolUse(content)
}

const QWEN_API_BASE = 'https://chat2.qianwen.com'

const MODEL_MAP: Record<string, string> = {
  'Qwen3': 'tongyi-qwen3-max-model-agent',
  'Qwen3-Max': 'tongyi-qwen3-max-model-agent',
  'Qwen3-Max-Thinking': 'tongyi-qwen3-max-thinking-agent',
  'Qwen3-Plus': 'tongyi-qwen-plus-agent',
  'Qwen3.5-Plus': 'Qwen3.5-Plus',
  'Qwen3-Flash': 'qwen3-flash',
  'Qwen3-Coder': 'qwen3-coder-plus',
}

const DEFAULT_HEADERS = {
  Accept: 'application/json, text/event-stream, text/plain, */*',
  'Accept-Language': 'zh-CN,zh;q=0.9',
  'Cache-Control': 'no-cache',
  Origin: 'https://www.qianwen.com',
  Pragma: 'no-cache',
  'Sec-Ch-Ua': '"Chromium";v="145", "Not(A:Brand";v="24", "Google Chrome";v="145"',
  'Sec-Ch-Ua-Mobile': '?0',
  'Sec-Ch-Ua-Platform': '"macOS"',
  'Sec-Fetch-Dest': 'empty',
  'Sec-Fetch-Mode': 'cors',
  'Sec-Fetch-Site': 'same-site',
  Referer: 'https://www.qianwen.com/',
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36',
}

interface QwenMessage {
  role: 'user' | 'assistant' | 'system'
  content: string | any[]
}

interface ChatCompletionRequest {
  model: string
  messages: QwenMessage[]
  tools?: any[]
  stream?: boolean
  temperature?: number
  session_id?: string
  isMultiTurn?: boolean
  web_search?: boolean
  reasoning_effort?: 'low' | 'medium' | 'high'
  enableThinking?: boolean
  enableWebSearch?: boolean
  sessionContext?: {
    sessionId: string
    providerSessionId?: string
    parentMessageId?: string
    messages: any[]
    isNew: boolean
  }
}

function uuid(separator: boolean = true): string {
  const id = 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0
    const v = c === 'x' ? r : (r & 0x3) | 0x8
    return v.toString(16)
  })
  return separator ? id : id.replace(/-/g, '')
}

function generateNonce(): string {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789'
  let result = ''
  for (let i = 0; i < 12; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length))
  }
  return result
}

function extractTextContent(content: string | any[]): string {
  if (typeof content === 'string') {
    return content
  }
  if (Array.isArray(content)) {
    return content
      .filter((item) => item.type === 'text')
      .map((item) => item.text || '')
      .join('\n')
  }
  return ''
}

export class QwenAdapter {
  private provider: Provider
  private account: Account
  private axiosInstance = axios.create({
    timeout: 120000,
    maxBodyLength: Infinity,
    maxContentLength: Infinity,
  })

  constructor(provider: Provider, account: Account) {
    this.provider = provider
    this.account = account
  }

  private getTicket(): string {
    const credentials = this.account.credentials
    return credentials.ticket || credentials.tongyi_sso_ticket || ''
  }

  private mapModel(model: string): string {
    if (MODEL_MAP[model]) {
      return MODEL_MAP[model]
    }
    return model
  }

  async chatCompletion(request: ChatCompletionRequest): Promise<{
    response: AxiosResponse
    sessionId: string
    reqId: string
  }> {
    const ticket = this.getTicket()
    if (!ticket) {
      throw new Error('Qwen ticket not configured, please add ticket in account settings')
    }

    // Use session context passed from forwarder
    const sessionContext = request.sessionContext
    const isMultiTurn = sessionContext && !sessionContext.isNew
    
    const reqId = uuid(false)
    // Use providerSessionId (existing session_id from Qwen) if available
    const sessionId = sessionContext?.providerSessionId || uuid(false)
    // Use parentMessageId (previous req_id) if available
    const parentReqId = sessionContext?.parentMessageId || '0'
    
    let actualModel = this.mapModel(request.model)
    
    // Determine if thinking and web search should be enabled
    // Priority: explicit parameters > model name detection
    const modelLower = request.model.toLowerCase()
    
    let enableThinking = request.enableThinking ?? false
    let enableWebSearch = request.enableWebSearch ?? false
    
    // Auto-enable based on model name (if not explicitly set)
    if (!enableThinking && (modelLower.includes('think') || modelLower.includes('r1'))) {
      enableThinking = true
      console.log('[Qwen] Thinking mode enabled (from model name)')
    }
    if (!enableWebSearch && modelLower.includes('search')) {
      enableWebSearch = true
      console.log('[Qwen] Web search enabled (from model name)')
    }

    // Map thinking mode to model
    if (enableThinking) {
      // Use thinking model if available
      if (actualModel === 'tongyi-qwen3-max-model-agent') {
        actualModel = 'tongyi-qwen3-max-thinking-agent'
        console.log('[Qwen] Using thinking model:', actualModel)
      }
    }
    
    console.log('[Qwen] Session info:', {
      isMultiTurn,
      sessionId,
      reqId,
      parentReqId,
    })
    console.log('[Qwen] Using model:', actualModel)

    // Find system message and user message
    let systemPrompt = ''
    let userContent = ''
    
    // In multi-turn mode, only process the last user message
    // Qwen will use the session_id to maintain conversation context
    const messagesToProcess = isMultiTurn && sessionId
      ? [request.messages[request.messages.length - 1]]
      : request.messages
    
    for (const msg of messagesToProcess) {
      if (msg.role === 'system') {
        systemPrompt = extractTextContent(msg.content)
      } else if (msg.role === 'user') {
        userContent = extractTextContent(msg.content)
      }
    }

    // Inject tools prompt if tools are provided and not already injected by client
    if (request.tools && request.tools.length > 0 && !hasToolPromptInjected(request.messages)) {
      const toolsPrompt = toolsToSystemPrompt(request.tools)
      systemPrompt = systemPrompt 
        ? systemPrompt + '\n\n' + toolsPrompt 
        : toolsPrompt
      // Add tool wrap hint to user content
      userContent = userContent + TOOL_WRAP_HINT
    }

    // If system prompt exists, prepend it to user content
    const finalContent = systemPrompt 
      ? `${systemPrompt}\n\nUser: ${userContent}`
      : userContent

    const timestamp = Date.now()
    const nonce = generateNonce()

    const requestBody = {
      deep_search: (enableWebSearch || enableThinking) ? '1' : '0',
      req_id: reqId,
      model: actualModel,
      scene: 'chat',
      session_id: sessionId,
      sub_scene: 'chat',
      temporary: false,
      messages: [
        {
          content: finalContent,
          mime_type: 'text/plain',
          meta_data: {
            ori_query: finalContent
          }
        }
      ],
      from: 'default',
      parent_req_id: parentReqId,
      enable_search: enableWebSearch,
      biz_data: '{"entryPoint":"tongyigw"}',
      scene_param: isMultiTurn ? 'continue_chat' : 'first_turn',
      chat_client: 'h5',
      client_tm: timestamp.toString(),
      protocol_version: 'v2',
      biz_id: 'ai_qwen'
    }

    const queryString = `biz_id=ai_qwen&chat_client=h5&device=pc&fr=pc&pr=qwen&ut=${uuid(false)}&nonce=${nonce}&timestamp=${timestamp}`
    const url = `${QWEN_API_BASE}/api/v2/chat?${queryString}`

    console.log('[Qwen] Sending request to /api/v2/chat...')

    const response = await this.axiosInstance.post(url, requestBody, {
      headers: {
        ...DEFAULT_HEADERS,
        'Content-Type': 'application/json',
        Cookie: `tongyi_sso_ticket=${ticket}`,
      },
      responseType: 'stream',
      timeout: 120000,
      decompress: false,
    })

    console.log('[Qwen] Response status:', response.status)
    console.log('[Qwen] Response headers:', JSON.stringify(response.headers, null, 2))

    return { response, sessionId, reqId }
  }

  async deleteSession(sessionId: string): Promise<boolean> {
    try {
      const ticket = this.getTicket()
      if (!ticket || !sessionId) {
        return false
      }

      const response = await axios.post(
        'https://chat2-api.qianwen.com/api/v1/session/delete/batch',
        { session_ids: [sessionId] },
        {
          headers: {
            Cookie: `tongyi_sso_ticket=${ticket}`,
            ...DEFAULT_HEADERS,
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
          timeout: 15000,
          validateStatus: () => true,
        }
      )

      if (response.status !== 200) {
        console.warn(`[Qwen] Failed to delete session ${sessionId}: status ${response.status}`)
        return false
      }

      const { success, code, msg } = response.data
      if (success === false || code !== 0) {
        console.warn(`[Qwen] Failed to delete session ${sessionId}: ${msg || 'Unknown error'}`)
        return false
      }

      console.log('[Qwen] Session deleted successfully:', sessionId)
      return true
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error'
      console.warn('[Qwen] Failed to delete session:', errorMessage)
      return false
    }
  }

  static isQwenProvider(provider: Provider): boolean {
    return provider.id === 'qwen' || provider.apiEndpoint.includes('qianwen.com') || provider.apiEndpoint.includes('aliyun.com')
  }
}

export class QwenStreamHandler {
  private sessionId: string = ''
  private model: string
  private created: number
  private onEnd?: (sessionId: string) => void
  private content: string = ''
  private responseId: string = ''
  private stopSent: boolean = false
  private toolCallsSent: boolean = false
  private hasError: boolean = false
  private toolCallState: ToolCallState
  private sentRole: boolean = false
  private thinkingContent: string = ''
  private sentThinkingRole: boolean = false

  constructor(model: string, onEnd?: (sessionId: string) => void) {
    this.model = model
    this.created = Math.floor(Date.now() / 1000)
    this.onEnd = onEnd
    this.toolCallState = createToolCallState()
  }

  hasSessionError(): boolean {
    return this.hasError
  }

  private sendToolCalls(transStream: PassThrough): void {
    if (this.toolCallsSent) return
    
    // Use the new parser that supports both bracket and XML formats
    const { toolCalls } = parseToolCallsFromText(this.content, 'default')
    
    if (toolCalls && toolCalls.length > 0) {
      this.toolCallsSent = true
      
      // Send tool_calls delta
      for (let i = 0; i < toolCalls.length; i++) {
        const tc = toolCalls[i]
        transStream.write(
          `data: ${JSON.stringify({
            id: this.responseId || this.sessionId,
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
          id: this.responseId || this.sessionId,
          model: this.model,
          object: 'chat.completion.chunk',
          choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
          created: this.created,
        })}\n\n`
      )
      transStream.end('data: [DONE]\n\n')
      this.onEnd?.(this.sessionId)
    }
  }

  handleStream(stream: any, response?: AxiosResponse): PassThrough {
    const transStream = new PassThrough()

    console.log('[Qwen] Starting stream handler...')
    
    const contentEncoding = response?.headers?.['content-encoding']
    console.log('[Qwen] Content-Encoding:', contentEncoding)

    let buffer = ''

    const processBuffer = () => {
      while (true) {
        const doubleNewlineIndex = buffer.indexOf('\n\n')
        if (doubleNewlineIndex === -1) break

        const eventBlock = buffer.substring(0, doubleNewlineIndex)
        buffer = buffer.substring(doubleNewlineIndex + 2)

        const lines = eventBlock.split('\n')
        let eventType = 'message'
        let eventData = ''

        for (const line of lines) {
          if (line.startsWith('event:')) {
            eventType = line.substring(6).trim()
          } else if (line.startsWith('data:')) {
            eventData = line.substring(5)
          }
        }

        if (eventData && eventData !== '[DONE]') {
          try {
            const result = JSON.parse(eventData)
            console.log('[Qwen] Parsed event:', eventType, 'data keys:', Object.keys(result))
            if (result.data?.messages) {
              console.log('[Qwen] Messages count:', result.data.messages.length)
              for (const msg of result.data.messages) {
                console.log('[Qwen] Message:', msg.mime_type, 'status:', msg.status, 'content length:', msg.content?.length || 0)
              }
            }

            if (result.communication) {
              if (!this.sessionId && result.communication.sessionid) {
                this.sessionId = result.communication.sessionid
              }
              if (!this.responseId && result.communication.reqid) {
                this.responseId = result.communication.reqid
              }
            }

            if (result.data?.messages) {
              for (const msg of result.data.messages) {
                console.log('[Qwen] Message detail:', JSON.stringify(msg).substring(0, 500))
                
                // Handle thinking content from meta_data.multi_load
                const metaData = msg.meta_data || {}
                const multiLoad = metaData.multi_load || []
                for (const load of multiLoad) {
                  if (load.type === 'deep_think' && load.content?.think_content) {
                    const newThinkingContent = load.content.think_content
                    // Only process if there's new content and it's not just a period
                    if (newThinkingContent.length > this.thinkingContent.length) {
                      const chunk = newThinkingContent.substring(this.thinkingContent.length)
                      this.thinkingContent = newThinkingContent
                      console.log('[Qwen] Thinking chunk, length:', chunk.length, 'content:', chunk.substring(0, 50))
                      
                      // Skip if chunk is just punctuation or whitespace
                      if (chunk.trim() && chunk.trim() !== '。' && chunk.trim() !== '.') {
                        // Send reasoning_content delta
                        if (!this.sentThinkingRole) {
                          transStream.write(`data: ${JSON.stringify({
                            id: this.responseId || this.sessionId,
                            model: this.model,
                            object: 'chat.completion.chunk',
                            choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }],
                            created: this.created,
                          })}\n\n`)
                          this.sentThinkingRole = true
                        }
                        
                        transStream.write(`data: ${JSON.stringify({
                          id: this.responseId || this.sessionId,
                          model: this.model,
                          object: 'chat.completion.chunk',
                          choices: [{ index: 0, delta: { reasoning_content: chunk }, finish_reason: null }],
                          created: this.created,
                        })}\n\n`)
                      }
                    }
                  }
                }
                
                // Filter out [(deep_think)] markers from content
                if ((msg.mime_type === 'text/plain' || msg.mime_type === 'multi_load/iframe') && msg.content) {
                  // Skip content that is just the deep_think marker
                  let newContent = msg.content
                  if (newContent === '[(deep_think)]' || newContent.trim() === '[(deep_think)]') {
                    console.log('[Qwen] Skipping deep_think marker')
                    continue
                  }
                  // Remove any deep_think markers from content
                  newContent = newContent.replace(/\[\(deep_think\)\]/g, '')
                  
                  if (!newContent.trim()) {
                    console.log('[Qwen] Skipping empty content after filtering')
                    continue
                  }
                  
                  console.log('[Qwen] newContent.length:', newContent.length, 'this.content.length:', this.content.length)
                  if (newContent.length > this.content.length) {
                    const chunk = newContent.substring(this.content.length)
                    this.content = newContent
                    console.log('[Qwen] Writing chunk, length:', chunk.length)

                    // Process tool call interception
                    const baseChunk = createBaseChunk(this.responseId || this.sessionId, this.model, this.created)
                    const { chunks: outputChunks } = processStreamContent(
                      chunk, 
                      this.toolCallState, 
                      baseChunk, 
                      !this.sentRole,
                      'qwen'
                    )

                    for (const outChunk of outputChunks) {
                      transStream.write(`data: ${JSON.stringify(outChunk)}\n\n`)
                    }

                    if (outputChunks.length > 0) this.sentRole = true
                    console.log('[Qwen] Chunk written to stream')
                  } else {
                    console.log('[Qwen] Skipping - no new content')
                  }
                }

                if (msg.status === 'complete' || msg.status === 'finished') {
                  // 只有当 multi_load/iframe 消息完成时才发送 stop
                  if (msg.mime_type === 'multi_load/iframe' && !this.stopSent) {
                    this.stopSent = true
                    console.log('[Qwen] Sending stop for multi_load/iframe, content so far:', this.content.length)
                    
                    // Flush any remaining tool calls
                    const baseChunk = createBaseChunk(this.responseId || this.sessionId, this.model, this.created)
                    const flushChunks = flushToolCallBuffer(this.toolCallState, baseChunk, 'qwen')
                    
                    for (const outChunk of flushChunks) {
                      transStream.write(`data: ${JSON.stringify(outChunk)}\n\n`)
                    }
                    
                    // Check if we emitted tool calls
                    const finishReason = this.toolCallState.hasEmittedToolCall ? 'tool_calls' : 'stop'
                    
                    transStream.write(
                      `data: ${JSON.stringify({
                        id: this.responseId || this.sessionId,
                        model: this.model,
                        object: 'chat.completion.chunk',
                        choices: [{ index: 0, delta: {}, finish_reason: finishReason }],
                        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
                        created: this.created,
                      })}\n\n`
                    )
                    transStream.end('data: [DONE]\n\n')
                    this.onEnd?.(this.sessionId)
                  }
                }
              }
            }

            if (result.error_code && result.error_code !== 0) {
              console.error('[Qwen] API error:', result.error_code, result.error_msg)
              this.hasError = true
              transStream.write(
                `data: ${JSON.stringify({
                  id: this.responseId || this.sessionId,
                  model: this.model,
                  object: 'chat.completion.chunk',
                  choices: [{ index: 0, delta: { content: `\n[Error: ${result.error_msg || result.error_code}]` }, finish_reason: 'stop' }],
                  created: this.created,
                })}\n\n`
              )
              transStream.end('data: [DONE]\n\n')
            }
          } catch (err) {
            console.error('[Qwen] Parse error:', err, 'Data:', eventData.substring(0, 200))
          }
        }

        if (eventType === 'complete') {
          console.log('[Qwen] Received complete event')
          if (!transStream.closed && !this.stopSent) {
            this.stopSent = true
            
            // Flush any remaining tool calls
            const baseChunk = createBaseChunk(this.responseId || this.sessionId, this.model, this.created)
            const flushChunks = flushToolCallBuffer(this.toolCallState, baseChunk, 'qwen')
            
            for (const outChunk of flushChunks) {
              transStream.write(`data: ${JSON.stringify(outChunk)}\n\n`)
            }
            
            // Check if we emitted tool calls
            const finishReason = this.toolCallState.hasEmittedToolCall ? 'tool_calls' : 'stop'
            
            transStream.write(
              `data: ${JSON.stringify({
                id: this.responseId || this.sessionId,
                model: this.model,
                object: 'chat.completion.chunk',
                choices: [{ index: 0, delta: {}, finish_reason: finishReason }],
                usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
                created: this.created,
              })}\n\n`
            )
            transStream.end('data: [DONE]\n\n')
          }
        }
      }
    }

    let decompressStream: any = stream
    
    if (contentEncoding === 'gzip') {
      console.log('[Qwen] Decompressing gzip stream...')
      decompressStream = stream.pipe(createGunzip())
    } else if (contentEncoding === 'deflate') {
      console.log('[Qwen] Decompressing deflate stream...')
      decompressStream = stream.pipe(createInflate())
    } else if (contentEncoding === 'br') {
      console.log('[Qwen] Decompressing brotli stream...')
      decompressStream = stream.pipe(createBrotliDecompress())
    } else if (contentEncoding === 'zstd') {
      console.log('[Qwen] Decompressing zstd stream...')
      const chunks: Buffer[] = []
      stream.on('data', (chunk: Buffer) => chunks.push(chunk))
      stream.once('end', () => {
        try {
          const compressedData = Buffer.concat(chunks)
          ZstdCodec.run((zstd) => {
            const simple = new zstd.Simple()
            const decompressed = simple.decompress(compressedData)
            const decompressedStr = Buffer.from(decompressed).toString('utf8')
            buffer = decompressedStr
            processBuffer()
            transStream.end('data: [DONE]\n\n')
          })
        } catch (err) {
          console.error('[Qwen] Zstd decompression error:', err)
          transStream.end('data: [DONE]\n\n')
        }
      })
      stream.once('error', (err: Error) => {
        console.error('[Qwen] Stream error:', err)
        transStream.end('data: [DONE]\n\n')
      })
      return transStream
    }

    decompressStream.on('data', (bufferChunk: Buffer) => {
      buffer += bufferChunk.toString()
      processBuffer()
    })
    decompressStream.once('error', (err: Error) => {
      console.error('[Qwen] Stream error:', err)
      transStream.end('data: [DONE]\n\n')
    })
    decompressStream.once('close', () => {
      console.log('[Qwen] Stream closed')
      processBuffer()
      transStream.end('data: [DONE]\n\n')
    })

    return transStream
  }

  async handleNonStream(stream: any, response?: AxiosResponse): Promise<any> {
    console.log('[Qwen] Starting non-stream handler...')

    return new Promise((resolve, reject) => {
      const data: {
        id: string
        model: string
        object: string
        choices: Array<{
          index: number
          message: { role: string; content: string | null; reasoning_content?: string; tool_calls?: any[] }
          finish_reason: string
        }>
        usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number }
        created: number
      } = {
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

      let contentAccumulator = ''
      let thinkingAccumulator = ''
      let buffer = ''
      let resolved = false

      const finalizeWithData = (content: string) => {
        const { content: cleanContent, toolCalls } = parseToolCallsFromText(content, 'qwen')
        if (toolCalls.length > 0) {
          data.choices[0].message.content = null
          data.choices[0].message.tool_calls = toolCalls
          data.choices[0].finish_reason = 'tool_calls'
        } else {
          data.choices[0].message.content = cleanContent.trim()
        }
      }

      const processBuffer = () => {
        while (true) {
          const doubleNewlineIndex = buffer.indexOf('\n\n')
          if (doubleNewlineIndex === -1) break

          const eventBlock = buffer.substring(0, doubleNewlineIndex)
          buffer = buffer.substring(doubleNewlineIndex + 2)

          const lines = eventBlock.split('\n')
          let eventType = 'message'
          let eventData = ''

          for (const line of lines) {
            if (line.startsWith('event:')) {
              eventType = line.substring(6).trim()
            } else if (line.startsWith('data:')) {
              eventData = line.substring(5)
            }
          }

          if (eventData && eventData !== '[DONE]') {
            try {
              const result = JSON.parse(eventData)
              console.log('[Qwen] Non-stream parsed event:', eventType, 'data keys:', Object.keys(result))

              if (result.communication) {
                if (!data.id && result.communication.sessionid) {
                  data.id = result.communication.sessionid
                  this.sessionId = result.communication.sessionid
                }
              }

              if (result.data?.messages) {
                for (const msg of result.data.messages) {
                  // Handle thinking content from meta_data.multi_load
                  const metaData = msg.meta_data || {}
                  const multiLoad = metaData.multi_load || []
                  for (const load of multiLoad) {
                    if (load.type === 'deep_think' && load.content?.think_content) {
                      const thinkContent = load.content.think_content
                      if (thinkContent.length > thinkingAccumulator.length) {
                        thinkingAccumulator = thinkContent
                        console.log('[Qwen] Non-stream: Thinking content length:', thinkingAccumulator.length)
                      }
                    }
                  }
                  
                  // Handle multi_load/iframe content (actual response content)
                  if (msg.mime_type === 'multi_load/iframe' && msg.content) {
                    // Filter out deep_think markers
                    let filteredContent = msg.content
                    if (filteredContent === '[(deep_think)]' || filteredContent.trim() === '[(deep_think)]') {
                      console.log('[Qwen] Non-stream: Skipping deep_think marker')
                      continue
                    }
                    filteredContent = filteredContent.replace(/\[\(deep_think\)\]/g, '')
                    if (filteredContent.length > contentAccumulator.length) {
                      contentAccumulator = filteredContent
                      console.log('[Qwen] Non-stream multi_load/iframe content length:', contentAccumulator.length)
                    }
                  }
                  
                  // Also handle text/plain content
                  if (msg.mime_type === 'text/plain' && msg.content) {
                    // Filter out deep_think markers
                    let filteredContent = msg.content.replace(/\[\(deep_think\)\]/g, '')
                    if (filteredContent.length > contentAccumulator.length) {
                      contentAccumulator = filteredContent
                    }
                  }

                  if (msg.status === 'complete' || msg.status === 'finished') {
                    if (msg.mime_type === 'multi_load/iframe') {
                      console.log('[Qwen] Non-stream finished, content length:', contentAccumulator.length)
                      this.content = contentAccumulator
                      
                      // Parse tool calls from content
                      const { content: cleanContent, toolCalls } = parseToolCallsFromText(contentAccumulator, 'qwen')
                      
                      if (toolCalls.length > 0) {
                        data.choices[0].message.content = null
                        ;(data.choices[0].message as any).tool_calls = toolCalls
                        data.choices[0].finish_reason = 'tool_calls'
                      } else {
                        data.choices[0].message.content = cleanContent.trim()
                      }
                      
                      // Add reasoning_content if available
                      if (thinkingAccumulator) {
                        data.choices[0].message.reasoning_content = thinkingAccumulator
                      }
                      
                      this.onEnd?.(this.sessionId)
                      resolved = true
                      resolve(data)
                      return
                    }
                  }
                }
              }
            } catch (err) {
              console.error('[Qwen] Non-stream parse error:', err)
            }
          }

          if (eventType === 'complete' && !resolved) {
            console.log('[Qwen] Non-stream complete event, content length:', contentAccumulator.length)
            this.content = contentAccumulator
            finalizeWithData(contentAccumulator)
            resolved = true
            resolve(data)
            return
          }
        }
      }

      let decompressStream: any = stream
      
      const contentEncoding = response?.headers?.['content-encoding']?.toLowerCase()
      if (contentEncoding === 'gzip') {
        console.log('[Qwen] Decompressing gzip stream...')
        decompressStream = stream.pipe(createGunzip())
      } else if (contentEncoding === 'deflate') {
        console.log('[Qwen] Decompressing deflate stream...')
        decompressStream = stream.pipe(createInflate())
      } else if (contentEncoding === 'br') {
        console.log('[Qwen] Decompressing brotli stream...')
        decompressStream = stream.pipe(createBrotliDecompress())
      } else if (contentEncoding === 'zstd') {
        console.log('[Qwen] Decompressing zstd stream...')
        const chunks: Buffer[] = []
        stream.on('data', (chunk: Buffer) => chunks.push(chunk))
        stream.once('end', () => {
          try {
            const compressedData = Buffer.concat(chunks)
            ZstdCodec.run((zstd) => {
              const simple = new zstd.Simple()
              const decompressed = simple.decompress(compressedData)
              const decompressedStr = Buffer.from(decompressed).toString('utf8')
              buffer = decompressedStr
              processBuffer()
              console.log('[Qwen] Zstd non-stream finished, content length:', contentAccumulator.length)
              this.content = contentAccumulator
              finalizeWithData(contentAccumulator)
              resolve(data)
            })
          } catch (err) {
            console.error('[Qwen] Zstd decompression error:', err)
            reject(err)
          }
        })
        stream.once('error', (err: Error) => {
          console.error('[Qwen] Non-stream error:', err)
          reject(err)
        })
        return
      }

      decompressStream.on('data', (chunk: Buffer) => {
        buffer += chunk.toString()
        processBuffer()
      })
      decompressStream.once('error', (err: Error) => {
        console.error('[Qwen] Non-stream error:', err)
        reject(err)
      })
      decompressStream.once('close', () => {
        console.log('[Qwen] Non-stream closed, content length:', contentAccumulator.length)
        if (!resolved) {
          processBuffer()
          this.content = contentAccumulator
          finalizeWithData(contentAccumulator)
          resolve(data)
        }
      })
      decompressStream.once('end', () => {
        console.log('[Qwen] Non-stream ended, content length:', contentAccumulator.length)
        if (!resolved) {
          processBuffer()
          this.content = contentAccumulator
          finalizeWithData(contentAccumulator)
          resolve(data)
        }
      })
    })
  }

  getSessionId(): string {
    return this.sessionId
  }
}

export const qwenAdapter = {
  QwenAdapter,
  QwenStreamHandler,
}
