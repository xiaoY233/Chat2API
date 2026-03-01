/**
 * GLM Adapter
 * Implements GLM (Zhipu Qingyan) web API protocol
 */

import axios, { AxiosResponse } from 'axios'
import crypto from 'crypto'
import { Account, Provider } from '../../store/types'
import { storeManager } from '../../store/store'
import { PassThrough } from 'stream'
import { createParser } from 'eventsource-parser'
import FormData from 'form-data'
import mime from 'mime-types'
import path from 'path'
import { toolsToSystemPrompt, TOOL_WRAP_HINT } from '../utils/tools'
import { parseToolCallsFromText } from '../utils/toolParser'
import { 
  createToolCallState, 
  processStreamContent, 
  flushToolCallBuffer,
  createBaseChunk,
  ToolCallState 
} from '../utils/streamToolHandler'

const GLM_API_BASE = 'https://chatglm.cn/chatglm'
const DEFAULT_ASSISTANT_ID = '65940acff94777010aa6b796'
const SIGN_SECRET = '8a1317a7468aa3ad86e997d08f3f31cb'
const ACCESS_TOKEN_EXPIRES = 3600
const FILE_MAX_SIZE = 100 * 1024 * 1024 // 100MB

const FAKE_HEADERS = {
  Accept: 'text/event-stream',
  'Accept-Encoding': 'gzip, deflate, br, zstd',
  'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8,en-GB;q=0.7,en-US;q=0.6',
  'App-Name': 'chatglm',
  'Cache-Control': 'no-cache',
  'Content-Type': 'application/json',
  Origin: 'https://chatglm.cn',
  Pragma: 'no-cache',
  Priority: 'u=1, i',
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
  'X-Lang': 'zh',
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36 Edg/143.0.0.0',
}

interface TokenInfo {
  accessToken: string
  refreshToken: string
  expiresAt: number
}

interface GLMMessage {
  role: 'user' | 'assistant' | 'system' | 'tool'
  content: string | any[] | null
  tool_call_id?: string
  tool_calls?: any[]
}

interface ChatCompletionRequest {
  model: string
  messages: GLMMessage[]
  stream?: boolean
  temperature?: number
  web_search?: boolean
  reasoning_effort?: 'low' | 'medium' | 'high'
  deep_research?: boolean
  tools?: any[]
  tool_choice?: any
}

const tokenCache = new Map<string, TokenInfo>()

function uuid(): string {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0
    const v = c === 'x' ? r : (r & 0x3) | 0x8
    return v.toString(16)
  })
}

function md5(str: string): string {
  return crypto.createHash('md5').update(str).digest('hex')
}

function generateSign(): { timestamp: string; nonce: string; sign: string } {
  const e = Date.now()
  const A = e.toString()
  const t = A.length
  const o = A.split('').map((c) => Number(c))
  const i = o.reduce((acc, val) => acc + val, 0) - o[t - 2]
  const a = i % 10
  const timestamp = A.substring(0, t - 2) + a + A.substring(t - 1, t)
  const nonce = uuid()
  const sign = md5(`${timestamp}-${nonce}-${SIGN_SECRET}`)
  return { timestamp, nonce, sign }
}

export class GLMAdapter {
  private provider: Provider
  private account: Account

  constructor(provider: Provider, account: Account) {
    this.provider = provider
    this.account = account
  }

  private getRefreshToken(): string {
    const credentials = this.account.credentials
    return credentials.refresh_token || credentials.token || ''
  }

  private async acquireToken(): Promise<string> {
    const refreshToken = this.getRefreshToken()
    const cached = tokenCache.get(refreshToken)
    if (cached && Date.now() < cached.expiresAt) {
      return cached.accessToken
    }

    console.log('[GLM] Refreshing Token...')
    const sign = generateSign()
    const response = await axios.post(
      `${GLM_API_BASE}/user-api/user/refresh`,
      {},
      {
        headers: {
          Authorization: `Bearer ${refreshToken}`,
          ...FAKE_HEADERS,
          'X-Device-Id': uuid(),
          'X-Nonce': sign.nonce,
          'X-Request-Id': uuid(),
          'X-Sign': sign.sign,
          'X-Timestamp': sign.timestamp,
        },
        timeout: 15000,
        validateStatus: () => true,
      }
    )

    console.log('[GLM] Token response:', JSON.stringify(response.data, null, 2))
    const { code, status, message } = response.data || {}
    const isSuccess = code === 0 || status === 0
    if (response.status !== 200 || !isSuccess) {
      const errorMsg = message || `HTTP ${response.status}`
      throw new Error(`Token refresh failed: ${errorMsg}`)
    }

    const { access_token, refresh_token } = response.data.result
    const tokenInfo: TokenInfo = {
      accessToken: access_token,
      refreshToken: refresh_token,
      expiresAt: Date.now() + ACCESS_TOKEN_EXPIRES * 1000,
    }
    tokenCache.set(refreshToken, tokenInfo)

    if (refresh_token !== refreshToken) {
      console.log('[GLM] Token updated, saving new token')
      const decryptedCredentials = {
        refresh_token,
      }
      await storeManager.updateAccount(this.account.id, {
        credentials: decryptedCredentials,
      })
    }

    console.log('[GLM] Token refresh successful')
    return access_token
  }

  /**
   * Check if URL is base64 data
   */
  private isBase64Data(url: string): boolean {
    return url.startsWith('data:')
  }

  /**
   * Extract MIME type from base64 data URL
   */
  private extractBase64Format(url: string): string {
    const match = url.match(/^data:([^;]+);/)
    return match ? match[1] : 'application/octet-stream'
  }

  /**
   * Remove base64 data header
   */
  private removeBase64Header(url: string): string {
    return url.replace(/^data:[^;]+;base64,/, '')
  }

  /**
   * Upload file to GLM
   */
  private async uploadFile(fileUrl: string): Promise<{ source_id: string; file_url?: string }> {
    console.log('[GLM] Uploading file:', fileUrl.substring(0, 50) + '...')
    
    let filename: string
    let fileData: Buffer
    let mimeType: string

    if (this.isBase64Data(fileUrl)) {
      mimeType = this.extractBase64Format(fileUrl)
      const ext = mime.extension(mimeType) || 'bin'
      filename = `${uuid()}.${ext}`
      fileData = Buffer.from(this.removeBase64Header(fileUrl), 'base64')
    } else {
      filename = path.basename(fileUrl.split('?')[0])
      const response = await axios.get(fileUrl, {
        responseType: 'arraybuffer',
        maxContentLength: FILE_MAX_SIZE,
        timeout: 60000,
      })
      fileData = Buffer.from(response.data)
      mimeType = response.headers['content-type'] || mime.lookup(filename) || 'application/octet-stream'
    }

    const formData = new FormData()
    formData.append('file', fileData, {
      filename,
      contentType: mimeType,
    })

    const token = await this.acquireToken()
    const response = await axios.post(
      `${GLM_API_BASE}/backend-api/assistant/file_upload`,
      formData,
      {
        headers: {
          Authorization: `Bearer ${token}`,
          Referer: 'https://chatglm.cn/',
          ...FAKE_HEADERS,
          ...formData.getHeaders(),
        },
        maxBodyLength: FILE_MAX_SIZE,
        timeout: 60000,
        validateStatus: () => true,
      }
    )

    if (response.status !== 200 || !response.data?.result) {
      throw new Error(`File upload failed: HTTP ${response.status}`)
    }

    console.log('[GLM] File uploaded successfully:', response.data.result.source_id)
    return response.data.result
  }

  /**
   * Extract file URLs from message content
   */
  private extractFileUrls(messages: GLMMessage[]): { fileUrls: string[]; imageUrls: string[] } {
    const fileUrls: string[] = []
    const imageUrls: string[] = []

    for (const msg of messages) {
      if (Array.isArray(msg.content)) {
        for (const part of msg.content) {
          if (part.type === 'image_url' && part.image_url?.url) {
            imageUrls.push(part.image_url.url)
          } else if (part.type === 'file' && part.file_url?.url) {
            fileUrls.push(part.file_url.url)
          }
        }
      }
    }

    return { fileUrls, imageUrls }
  }

  private messagesToPrompt(messages: GLMMessage[], refs: any[] = [], toolsPrompt?: string): { role: string; content: any[] }[] {
    // Separate image refs and file refs
    const imageRefs = refs.filter((ref) => ref.width !== undefined || ref.height !== undefined || ref.image_url)
    const fileRefs = refs.filter((ref) => !ref.width && !ref.height && !ref.image_url)

    // Build content array
    const content: any[] = []

    // Add file references first
    if (fileRefs.length > 0) {
      content.push({
        type: 'file',
        file: fileRefs.map((ref) => ({
          source_id: ref.source_id,
          file_url: ref.file_url,
        })),
      })
    }

    // Add image references
    for (const imageRef of imageRefs) {
      content.push({
        type: 'image_url',
        image_url: {
          url: imageRef.image_url || imageRef.source_id,
        },
      })
    }

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

    // Extract text from messages
    if (processedMessages.length < 2) {
      let textContent = processedMessages.reduce((acc, msg) => {
        if (typeof msg.content === 'string') {
          return acc + msg.content + '\n'
        } else if (Array.isArray(msg.content)) {
          const textParts = msg.content.filter((c) => c.type === 'text').map((c) => c.text)
          return acc + textParts.join('') + '\n'
        }
        return acc
      }, '')

      // Inject tools prompt at the VERY END
      if (toolsPrompt) {
        textContent = textContent.trim() + "\n\n" + toolsPrompt
      }

      content.push({ type: 'text', text: textContent })
      return [{ role: 'user', content }]
    }

    let textContent = processedMessages.reduce((acc, msg) => {
      const role = msg.role
        .replace('system', 'System')
        .replace('assistant', 'Assistant')
        .replace('user', 'User')
        .replace('tool', 'User')
      if (typeof msg.content === 'string') {
        return acc + `${role}: ${msg.content}\n\n`
      } else if (Array.isArray(msg.content)) {
        const text = msg.content.filter((c) => c.type === 'text').map((c) => c.text).join('')
        return acc + `${role}: ${text}\n\n`
      }
      return acc
    }, '')

    // Inject tools prompt at the VERY END
    if (toolsPrompt) {
      textContent = textContent.trim() + "\n\n" + toolsPrompt
    }

    content.push({ type: 'text', text: textContent + 'Assistant: ' })
    return [{ role: 'user', content }]
  }

  async chatCompletion(request: ChatCompletionRequest): Promise<{ response: AxiosResponse; conversationId: string }> {
    const token = await this.acquireToken()
    const sign = generateSign()

    // Clone messages to avoid modifying original request
    const messages = [...request.messages]

    // Inject tools definition into prompt if tools are provided
    let toolsPrompt = ''
    if (request.tools && request.tools.length > 0) {
      const glmStrictHint = `

GLM STRICT RULES:
- If user asks to create/modify code or files, you MUST call tools instead of replying with plain text.
- You MUST output ONLY one [function_calls] block when calling tools.
- Use exact tool names from list, case-sensitive, do not rename.`
      toolsPrompt = toolsToSystemPrompt(request.tools) + glmStrictHint

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

    // Extract and upload files
    const { fileUrls, imageUrls } = this.extractFileUrls(messages)
    const refs: any[] = []

    // Upload files
    for (const fileUrl of fileUrls) {
      try {
        const result = await this.uploadFile(fileUrl)
        refs.push({
          source_id: result.source_id,
          file_url: result.file_url || fileUrl,
        })
      } catch (error) {
        console.error('[GLM] Failed to upload file:', error)
      }
    }

    // Upload images
    for (const imageUrl of imageUrls) {
      try {
        const result = await this.uploadFile(imageUrl)
        refs.push({
          source_id: result.source_id,
          image_url: result.file_url || imageUrl,
          width: 0,
          height: 0,
        })
      } catch (error) {
        console.error('[GLM] Failed to upload image:', error)
      }
    }

    const preparedMessages = this.messagesToPrompt(messages, refs, toolsPrompt)

    let assistantId = DEFAULT_ASSISTANT_ID
    let chatMode = ''
    let isNetworking = false

    // Use request parameters for mode control (OpenAI compatible)
    if (request.reasoning_effort) {
      chatMode = 'zero'
      console.log('[GLM] Using reasoning mode, effort:', request.reasoning_effort)
    }
    
    if (request.web_search) {
      isNetworking = true
      console.log('[GLM] Web search enabled')
    }
    
    if (request.deep_research) {
      chatMode = 'deep_research'
      console.log('[GLM] Using deep research mode')
    }

    // Fallback: check model name for backward compatibility
    const modelLower = request.model.toLowerCase()
    if (!chatMode && (modelLower.includes('think') || modelLower.includes('zero'))) {
      chatMode = 'zero'
      console.log('[GLM] Using reasoning mode (from model name)')
    }
    if (!chatMode && modelLower.includes('deepresearch')) {
      chatMode = 'deep_research'
      console.log('[GLM] Using deep research mode (from model name)')
    }
    
    // Check if model is an assistant ID (24+ alphanumeric characters)
    if (/^[a-z0-9]{24,}$/.test(request.model)) {
      assistantId = request.model
    }

    console.log('[GLM] Sending chat request...')
    const response = await axios.post(
      `${GLM_API_BASE}/backend-api/assistant/stream`,
      {
        assistant_id: assistantId,
        conversation_id: '',
        project_id: '',
        chat_type: 'user_chat',
        messages: preparedMessages,
        meta_data: {
          channel: '',
          chat_mode: chatMode || undefined,
          draft_id: '',
          if_plus_model: true,
          input_question_type: 'xxxx',
          is_networking: isNetworking,
          is_test: false,
          platform: 'pc',
          quote_log_id: '',
          cogview: {
            rm_label_watermark: false,
          },
        },
      },
      {
        headers: {
          Authorization: `Bearer ${token}`,
          ...FAKE_HEADERS,
          'X-Device-Id': uuid(),
          'X-Request-Id': uuid(),
          'X-Sign': sign.sign,
          'X-Timestamp': sign.timestamp,
          'X-Nonce': sign.nonce,
        },
        timeout: 120000,
        validateStatus: () => true,
        responseType: 'stream',
      }
    )

    return { response, conversationId: '' }
  }

  async deleteConversation(conversationId: string): Promise<boolean> {
    try {
      const token = await this.acquireToken()
      const sign = generateSign()
      await axios.post(
        `${GLM_API_BASE}/backend-api/assistant/conversation/delete`,
        {
          assistant_id: DEFAULT_ASSISTANT_ID,
          conversation_id: conversationId,
        },
        {
          headers: {
            Authorization: `Bearer ${token}`,
            Referer: 'https://chatglm.cn/main/alltoolsdetail',
            'X-Device-Id': uuid(),
            'X-Request-Id': uuid(),
            'X-Sign': sign.sign,
            'X-Timestamp': sign.timestamp,
            'X-Nonce': sign.nonce,
            ...FAKE_HEADERS,
          },
          timeout: 15000,
          validateStatus: () => true,
        }
      )
      console.log('[GLM] Conversation deleted:', conversationId)
      return true
    } catch (error) {
      console.error('[GLM] Failed to delete conversation:', error)
      return false
    }
  }

  static isGLMProvider(provider: Provider): boolean {
    return provider.id === 'glm' || provider.apiEndpoint.includes('chatglm.cn')
  }
}

export class GLMStreamHandler {
  private conversationId: string = ''
  private model: string
  private created: number
  private onEnd?: () => void
  private toolCallState: ToolCallState

  constructor(model: string, onEnd?: () => void) {
    this.model = model
    this.created = Math.floor(Date.now() / 1000)
    this.onEnd = onEnd
    this.toolCallState = createToolCallState()
  }

  async handleStream(stream: any): Promise<PassThrough> {
    const transStream = new PassThrough()
    const cachedParts: any[] = []
    let sentContent = ''
    let sentReasoning = ''
    let sentRole = false

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
          const result = JSON.parse(event.data)

          if (!this.conversationId && result.conversation_id) {
            this.conversationId = result.conversation_id
          }

          if (result.status !== 'finish' && result.status !== 'intervene') {
            if (result.parts) {
              result.parts.forEach((part: any) => {
                const index = cachedParts.findIndex((p) => p.logic_id === part.logic_id)
                if (index !== -1) {
                  cachedParts[index] = part
                } else {
                  cachedParts.push(part)
                }
              })
            }

            const searchMap = new Map<string, any>()
            cachedParts.forEach((part) => {
              if (!part.content || !Array.isArray(part.content)) return
              const { meta_data } = part
              part.content.forEach((item: any) => {
                if (item.type === 'tool_result' && meta_data?.tool_result_extra?.search_results) {
                  meta_data.tool_result_extra.search_results.forEach((res: any) => {
                    if (res.match_key) {
                      searchMap.set(res.match_key, res)
                    }
                  })
                }
              })
            })

            const keyToIdMap = new Map<string, number>()
            let counter = 1
            let fullText = ''
            let fullReasoning = ''

            cachedParts.forEach((part) => {
              const { content, meta_data } = part
              if (!Array.isArray(content)) return

              let partText = ''
              let partReasoning = ''

              content.forEach((value: any) => {
                const { type, text, think, image, code, content: innerContent } = value

                if (type === 'text') {
                  let txt = text
                  if (searchMap.size > 0) {
                    txt = txt.replace(/【?(turn\d+[a-zA-Z]+\d+)】?/g, (match: string, key: string) => {
                      const searchInfo = searchMap.get(key)
                      if (!searchInfo) return match
                      if (!keyToIdMap.has(key)) {
                        keyToIdMap.set(key, counter++)
                      }
                      return ` [${keyToIdMap.get(key)}](${searchInfo.url})`
                    })
                  }
                  partText += txt
                } else if (type === 'think') {
                  partReasoning += think
                } else if (type === 'image' && Array.isArray(image) && part.status === 'finish') {
                  const imageText =
                    image.reduce((imgs: string, v: any) => {
                      return imgs + (/^(http|https):\/\//.test(v.image_url) ? `![image](${v.image_url})` : '')
                    }, '') + '\n'
                  partText += imageText
                } else if (type === 'code') {
                  partText += '```python\n' + code + (part.status === 'finish' ? '\n```\n' : '')
                } else if (type === 'execution_output' && typeof innerContent === 'string' && part.status === 'finish') {
                  partText += innerContent + '\n'
                }
              })

              if (partText) fullText += (fullText.length > 0 ? '\n' : '') + partText
              if (partReasoning) fullReasoning += (fullReasoning.length > 0 ? '\n' : '') + partReasoning
            })

            const reasoningChunk = fullReasoning.substring(sentReasoning.length)
            if (reasoningChunk) {
              sentReasoning += reasoningChunk
              transStream.write(
                `data: ${JSON.stringify({
                  id: this.conversationId,
                  model: this.model,
                  object: 'chat.completion.chunk',
                  choices: [{ index: 0, delta: { reasoning_content: reasoningChunk }, finish_reason: null }],
                  created: this.created,
                })}\n\n`
              )
            }

            const chunk = fullText.substring(sentContent.length)
            if (chunk) {
              sentContent += chunk

              // Process tool call interception
              const baseChunk = createBaseChunk(this.conversationId, this.model, this.created)
              const { chunks: outputChunks } = processStreamContent(
                chunk, 
                this.toolCallState, 
                baseChunk, 
                !sentRole,
                'glm'
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

              if (outputChunks.length > 0) sentRole = true
            }
          } else {
            // Flush any remaining tool call buffer before finishing
            const baseChunk = createBaseChunk(this.conversationId, this.model, this.created)
            const flushChunks = flushToolCallBuffer(this.toolCallState, baseChunk, 'glm')
            for (const outChunk of flushChunks) {
              transStream.write(`data: ${JSON.stringify(outChunk)}\n\n`)
            }

            // Determine finish_reason based on whether we had tool calls
            const finishReason = this.toolCallState.hasEmittedToolCall ? 'tool_calls' : 'stop'

            transStream.write(
              `data: ${JSON.stringify({
                id: this.conversationId,
                model: this.model,
                object: 'chat.completion.chunk',
                choices: [
                  {
                    index: 0,
                    delta:
                      result.status === 'intervene' && result.last_error?.intervene_text
                        ? { content: '\n\n' + result.last_error.intervene_text }
                        : {},
                    finish_reason: finishReason,
                  },
                ],
                usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
                created: this.created,
              })}\n\n`
            )
            transStream.end('data: [DONE]\n\n')
            this.onEnd?.()
          }
        } catch (err) {
          console.error('[GLM] Stream parse error:', err)
        }
      },
    })

    const decoder = new TextDecoder('utf-8')
    stream.on('data', (buffer: Buffer) => parser.feed(decoder.decode(buffer, { stream: true })))

    // Handle stream errors - ensure proper cleanup
    stream.once('error', (err: Error) => {
      console.error('[GLM] Stream error:', err.message)
      // Flush any remaining tool call buffer
      const baseChunk = createBaseChunk(this.conversationId, this.model, this.created)
      const flushChunks = flushToolCallBuffer(this.toolCallState, baseChunk, 'glm')
      for (const outChunk of flushChunks) {
        transStream.write(`data: ${JSON.stringify(outChunk)}\n\n`)
      }
      const finishReason = this.toolCallState.hasEmittedToolCall ? 'tool_calls' : 'stop'
      transStream.write(
        `data: ${JSON.stringify({
          id: this.conversationId,
          model: this.model,
          object: 'chat.completion.chunk',
          choices: [{ index: 0, delta: {}, finish_reason: finishReason }],
          created: this.created,
        })}\n\n`
      )
      transStream.end('data: [DONE]\n\n')
      this.onEnd?.()
    })

    // Handle stream close - ensure proper cleanup if not already finished
    stream.once('close', () => {
      console.log('[GLM] Stream closed')
      // Only send finish if we haven't already
      if (!transStream.closed) {
        const baseChunk = createBaseChunk(this.conversationId, this.model, this.created)
        const flushChunks = flushToolCallBuffer(this.toolCallState, baseChunk, 'glm')
        for (const outChunk of flushChunks) {
          transStream.write(`data: ${JSON.stringify(outChunk)}\n\n`)
        }
        const finishReason = this.toolCallState.hasEmittedToolCall ? 'tool_calls' : 'stop'
        transStream.write(
          `data: ${JSON.stringify({
            id: this.conversationId,
            model: this.model,
            object: 'chat.completion.chunk',
            choices: [{ index: 0, delta: {}, finish_reason: finishReason }],
            created: this.created,
          })}\n\n`
        )
        transStream.end('data: [DONE]\n\n')
        this.onEnd?.()
      }
    })

    return transStream
  }

  async handleNonStream(stream: any): Promise<any> {
    return new Promise((resolve, reject) => {
      const cachedParts: any[] = []
      let conversationId = ''

      const parser = createParser({
        onEvent: (event: any) => {
          try {
            const result = JSON.parse(event.data)

            if (!conversationId && result.conversation_id) {
              conversationId = result.conversation_id
            }

            if (result.status !== 'finish') {
              if (result.parts) {
                cachedParts.length = 0
                cachedParts.push(...result.parts)
              }
            } else {
              const searchMap = new Map<string, any>()
              cachedParts.forEach((part) => {
                if (!part.content || !Array.isArray(part.content)) return
                const { meta_data } = part
                part.content.forEach((item: any) => {
                  if (item.type === 'tool_result' && meta_data?.tool_result_extra?.search_results) {
                    meta_data.tool_result_extra.search_results.forEach((res: any) => {
                      if (res.match_key) {
                        searchMap.set(res.match_key, res)
                      }
                    })
                  }
                })
              })

              const keyToIdMap = new Map<string, number>()
              let counter = 1
              let fullText = ''
              let fullReasoning = ''

              cachedParts.forEach((part) => {
                const { content, meta_data } = part
                if (!Array.isArray(content)) return

                let partText = ''
                let partReasoning = ''

                content.forEach((value: any) => {
                  const { type, text, think, image, code, content: innerContent } = value

                  if (type === 'text') {
                    let txt = text
                    if (searchMap.size > 0) {
                      txt = txt.replace(/【?(turn\d+[a-zA-Z]+\d+)】?/g, (match: string, key: string) => {
                        const searchInfo = searchMap.get(key)
                        if (!searchInfo) return match
                        if (!keyToIdMap.has(key)) {
                          keyToIdMap.set(key, counter++)
                        }
                        return ` [${keyToIdMap.get(key)}](${searchInfo.url})`
                      })
                    }
                    partText += txt
                  } else if (type === 'think') {
                    partReasoning += think
                  } else if (type === 'image' && Array.isArray(image) && part.status === 'finish') {
                    const imageText =
                      image.reduce((imgs: string, v: any) => {
                        return imgs + (/^(http|https):\/\//.test(v.image_url) ? `![image](${v.image_url})` : '')
                      }, '') + '\n'
                    partText += imageText
                  } else if (type === 'code') {
                    partText += '```python\n' + code + '\n```\n'
                  } else if (type === 'execution_output' && typeof innerContent === 'string' && part.status === 'finish') {
                    partText += innerContent + '\n'
                  }
                })

                if (partText) fullText += (fullText.length > 0 ? '\n' : '') + partText
                if (partReasoning) fullReasoning += (fullReasoning.length > 0 ? '\n' : '') + partReasoning
              })

              const { content: cleanContent, toolCalls } = parseToolCallsFromText(fullText, 'glm')

              resolve({
                id: conversationId,
                model: this.model,
                object: 'chat.completion',
                choices: [
                  {
                    index: 0,
                    message: {
                      role: 'assistant',
                      content: toolCalls.length > 0 ? null : cleanContent.trim(),
                      reasoning_content: fullReasoning || null,
                      ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {})
                    },
                    finish_reason: toolCalls.length > 0 ? 'tool_calls' : 'stop',
                  },
                ],
                usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
                created: Math.floor(Date.now() / 1000),
              })
            }
          } catch (err) {
            reject(err)
          }
        },
      })

      stream.on('data', (buffer: Buffer) => parser.feed(buffer.toString()))
      stream.once('error', reject)
      stream.once('close', () => {
        resolve({
          id: conversationId,
          model: this.model,
          object: 'chat.completion',
          choices: [
            {
              index: 0,
              message: { role: 'assistant', content: '', reasoning_content: null },
              finish_reason: 'stop',
            },
          ],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
          created: Math.floor(Date.now() / 1000),
        })
      })
    })
  }

  getConversationId(): string {
    return this.conversationId
  }
}

export const glmAdapter = {
  GLMAdapter,
  GLMStreamHandler,
}
