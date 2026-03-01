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

const QWEN_AI_BASE = 'https://chat.qwen.ai'

const DEFAULT_HEADERS = {
  Accept: 'application/json',
  'Accept-Language': 'zh-CN,zh;q=0.9',
  'Content-Type': 'application/json',
  source: 'web',
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36',
  'sec-ch-ua': '"Not:A-Brand";v="99", "Google Chrome";v="145", "Chromium";v="145"',
  'sec-ch-ua-mobile': '?0',
  'sec-ch-ua-platform': '"macOS"',
  'Sec-Fetch-Dest': 'empty',
  'Sec-Fetch-Mode': 'cors',
  'Sec-Fetch-Site': 'same-origin',
  'bx-v': '2.5.36',
  'bx-umidtoken': 'T2gAr9z8byN8sNOmfQ3X9j61MNTNmSqDO5L1rs2jMcQCVhOKgZICcBN-UdTuJGig-NM=',
  'bx-ua': '231!lWD36kmUe5E+joKDK5gBZ48FEl2ZWfPwIPF92lBLek2KxVW/XJ2EwruCiDOX5Px4EXNhmh6EfS9eDwQGRwijIK64A4nPqeLysJcDjUACje/H3J4ZgGZpicG6K8AkiGGaEKC830+QSiSUsLRlL/EyhXTmLcJc/5iDkMuOpUhNz0e0Q/nTqjVJ3ko00Q/oyE+jauHhUHfb1GxGHkE+++3+qCS4+ItkaA6tiItCo+romzElfLFD6RIj7oHt9vffs98nLwpHnaqKjufnLFMejSlAUGiQvTofIiGhIvftAMcoFV4mrUHsqyQ/ncQihmJHkbxXjvM57FCb6b9dEIRZl7jgj0+QLNLRs0NZ4azdZ6rzbGTSO8KA5I3Aq/3gBr87X16Mj0oJtaPKmFGaP2zghfOVhxQht8YjRd50lJa+Ue4PAuPSdu2O69DKLH8VOhrsB+psaBIRxnRi5POUQ6w8s8qlb9vxvExjHNOAKWXV1by1Nz+6FPWdyTeAgcmonjCcV0dCtPj/KyeVDkeSrDkKZjnDzHEqeCdfmJ65kve+Vy3YS0vagzyHfVEnzN0ULUZtkGfJXFNm6+bIa55wmGBhUeXbHL0EdlQXMu1YXxmcwBgTaq7tlQcfv7AefanbfjGE8R1IFnNyg2/jXLbnLg5Z6l1oKqgnxZQg0DE9BJuw6s0XjGwTdSxybWxp+WFD/RsXt76uwvCBk7z+YmSFLtFj2UlTsoq+vl0DTmsVItDKf9SZ94NcuJ7mxJYI02S/2kQBfbbHG0d4hXevDrEC0cb86EvzN2ud+v6bAunNRGNFz/RH0KLusoBVeo+puCFKeeIJWEo0t1UicX5YxJwMAoV7+g0gK93y4W9sMQtso8/wY5wsBzis9dwfLvIwXpaAM1g0MZp/YIRq8T/Qc+U/8x99tam4er0IWizvrkjqhIzCWBKpJ4Y4gj3bOmiS3VCMEaoVfKCwUWENwYKuP3H5VI0n+O2vVVRrekUrwvkm6URRhVhN4eEFTCjB9nSQu++qKyDH8HPpkS3YfwF8/OQtrZo7hQXxvNmP2HcH/K7zcweD00BaoOLiYUtXRItGYbl06sVSbm04soRf1Jqpyo3XiRqBWD9rmJfr4w8NOEGVGUCKXLDLsXy+8JC4Iqf0FsIjWxjMVdraTUtCbwXRbYUownQVm6bt7LYD1SNPoWNPqUJgsLMwP33ugrb1UbHCs24roOch6Go5QHIPA8E15SZE9pkr1SkmqrNs/+KRomFJ9HyFnWUYhZIV9MRLqlOAt6XBBTash3WJnCjhx/PZGhXVvdn2jX4+0Pm55LsiNugA8vaAUJQBxD/8a1u/RvTgbj35+b7I7m8tG0hMhClNZF+tpsOmZZhUGuXH9uVbkJMlMuAmMVCHwn3O31GlLeXXzzep2WS3xN2U+p5J0I7GySnuZUkuGs1ZTVqGUvR2g4q+7ljU55Ak78yPZiQXeUeqS74azszvZvCqWxXn2eePj+gcpliOjrYKpglUP19rQrMt8PqLt8L0ghIqVCmMwl3Hgr/VUcqDpXdpPTR=',
  Timezone: 'Mon Feb 23 2026 22:06:02 GMT+0800',
  Version: '0.2.7',
  Origin: 'https://chat.qwen.ai',
}

const MODEL_MAP: Record<string, string> = {
  'Qwen3.5-Plus': 'qwen3.5-plus',
  'Qwen3.5-397B-A17B': 'qwen3.5-397b-a17b',
  'Qwen3-Max': 'qwen3-max',
  'Qwen3-235B-A22B-2507': 'qwen3-235b-a22b-2507',
  'Qwen3-Coder': 'qwen3-coder-plus',
  'Qwen3-VL-235B-A22B': 'qwen3-vl-235b-a22b',
  'Qwen3-Omni-Flash': 'qwen3-omni-flash',
  'Qwen2.5-Max': 'qwen2.5-max',
  qwen: 'qwen3-max',
  qwen3: 'qwen3-max',
  'qwen3.5': 'qwen3.5-plus',
  'qwen3-coder': 'qwen3-coder-plus',
  'qwen3-vl': 'qwen3-vl-235b-a22b',
  'qwen3-omni': 'qwen3-omni-flash',
  'qwen2.5': 'qwen2.5-max',
}

interface QwenAiMessage {
  role: 'user' | 'assistant' | 'system'
  content: string
}

interface ChatCompletionRequest {
  model: string
  messages: QwenAiMessage[]
  stream?: boolean
  temperature?: number
  enable_thinking?: boolean
  thinking_budget?: number
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

export class QwenAiAdapter {
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

  private getToken(): string {
    const credentials = this.account.credentials
    return credentials.token || credentials.accessToken || credentials.apiKey || ''
  }

  private getCookies(): string {
    const credentials = this.account.credentials
    return credentials.cookies || credentials.cookie || ''
  }

  private getHeaders(chatId?: string): Record<string, string> {
    const headers: Record<string, string> = {
      ...DEFAULT_HEADERS,
      Authorization: `Bearer ${this.getToken()}`,
      'X-Request-Id': uuid(),
    }

    if (chatId) {
      headers['Referer'] = `https://chat.qwen.ai/c/${chatId}`
    }

    const cookies = this.getCookies()
    if (cookies) {
      headers['Cookie'] = cookies
    } else {
      console.warn('[QwenAI] Warning: No cookies provided. This may cause Bad_Request error.')
      console.warn('[QwenAI] Required cookies: cnaui, aui, sca, xlly_s, cna, token, _bl_uid, x-ap')
    }

    return headers
  }

  mapModel(openaiModel: string): string {
    if (MODEL_MAP[openaiModel]) {
      return MODEL_MAP[openaiModel]
    }
    return openaiModel
  }

  async createChat(modelId: string, title: string = 'New Chat'): Promise<string> {
    const url = `${QWEN_AI_BASE}/api/v2/chats/new`
    const payload = {
      title,
      models: [modelId],
      chat_mode: 'normal',
      chat_type: 't2t',
      timestamp: Date.now(),
      project_id: '',
    }

    try {
      const response = await this.axiosInstance.post(url, payload, {
        headers: this.getHeaders(),
      })

      console.log('[QwenAI] Create chat response:', JSON.stringify(response.data, null, 2))

      if (response.data?.data?.id) {
        console.log('[QwenAI] Created chat:', response.data.data.id)
        return response.data.data.id
      }

      throw new Error('Failed to create chat: no chat ID returned')
    } catch (error) {
      console.error('[QwenAI] Failed to create chat:', error)
      throw error
    }
  }

  async deleteChat(chatId: string): Promise<boolean> {
    const url = `${QWEN_AI_BASE}/api/v2/chats/${chatId}`

    try {
      const response = await this.axiosInstance.delete(url, {
        headers: this.getHeaders(),
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

  async chatCompletion(request: ChatCompletionRequest): Promise<{
    response: AxiosResponse
    chatId: string
    parentId: string | null
  }> {
    const token = this.getToken()
    if (!token) {
      throw new Error('Qwen AI token not configured, please add token in account settings')
    }

    const modelId = this.mapModel(request.model)
    console.log('[QwenAI] Using model:', modelId)

    const chatId = await this.createChat(modelId, 'OpenAI_API_Chat')

    const messages = request.messages
    
    // Extract system message and user message
    let systemContent = ''
    let userContent = ''
    
    for (const msg of messages) {
      if (msg.role === 'system') {
        systemContent += (systemContent ? '\n\n' : '') + msg.content
      } else if (msg.role === 'user') {
        userContent = msg.content
      }
    }
    
    // If system prompt exists, prepend it to user content
    if (systemContent) {
      userContent = `${systemContent}\n\nUser: ${userContent}`
    }

    const fid = uuid()
    const childId = uuid()
    const ts = Math.floor(Date.now() / 1000)

    const featureConfig: Record<string, any> = {
      thinking_enabled: request.enable_thinking !== false,
      output_schema: 'phase',
      research_mode: 'normal',
      auto_thinking: true,
      thinking_format: 'summary',
      auto_search: true,
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
    console.log('[QwenAI] Request headers:', JSON.stringify(this.getHeaders(chatId), null, 2))

    const response = await this.axiosInstance.post(url, payload, {
      headers: {
        ...this.getHeaders(chatId),
        'x-accel-buffering': 'no',
      },
      responseType: 'stream',
      timeout: 120000,
    })

    console.log('[QwenAI] Response status:', response.status)
    console.log('[QwenAI] Response headers:', JSON.stringify(response.headers, null, 2))

    return {
      response,
      chatId,
      parentId: null,
    }
  }

  static isQwenAiProvider(provider: Provider): boolean {
    return provider.id === 'qwen-ai' || provider.apiEndpoint.includes('chat.qwen.ai')
  }
}

export class QwenAiStreamHandler {
  private chatId: string = ''
  private model: string
  private created: number
  private onEnd?: (chatId: string) => void
  private responseId: string = ''
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
            console.log('[QwenAI] hasSentReasoning:', hasSentReasoning, 'reasoningText:', reasoningText.length, 'summaryText:', summaryText.length)

            if (phase === 'think' && status !== 'finished') {
              reasoningText += content
            } else if (phase === 'thinking_summary') {
              const extra = delta.extra || {}
              console.log('[QwenAI] thinking_summary extra:', JSON.stringify(extra).substring(0, 300))
              if (extra.summary_thought?.content) {
                const newSummary = extra.summary_thought.content.join('\n')
                if (newSummary && newSummary.length > summaryText.length) {
                  summaryText = newSummary
                  console.log('[QwenAI] Updated summaryText, length:', summaryText.length)
                }
              }
            } else if (phase === 'answer') {
              sendInitialChunk()
              console.log('[QwenAI] Entering answer branch, content:', content)
              console.log('[QwenAI] hasSentReasoning:', hasSentReasoning, 'reasoningText:', reasoningText.length, 'summaryText:', summaryText.length)
              
              // Accumulate content for tool call detection
              this.content += content
              
              const reasoningContent = reasoningText || summaryText
              if (!hasSentReasoning && reasoningContent) {
                console.log('[QwenAI] Sending first chunk with reasoning, reasoning length:', reasoningContent.length)
                const chunk = {
                  id: this.responseId || this.chatId,
                  model: this.model,
                  object: 'chat.completion.chunk',
                  choices: [
                    {
                      index: 0,
                      delta: {
                        content: content,
                        reasoning_content: reasoningContent,
                      },
                      finish_reason: null,
                    },
                  ],
                  created: this.created,
                }
                const chunkStr = `data: ${JSON.stringify(chunk)}\n\n`
                console.log('[QwenAI] Writing chunk to stream, length:', chunkStr.length)
                transStream.write(chunkStr)
                hasSentReasoning = true
              } else {
                if (content) {
                  console.log('[QwenAI] Sending content chunk:', content)
                  const chunk = {
                    id: this.responseId || this.chatId,
                    model: this.model,
                    object: 'chat.completion.chunk',
                    choices: [{ index: 0, delta: { content }, finish_reason: null }],
                    created: this.created,
                  }
                  const chunkStr = `data: ${JSON.stringify(chunk)}\n\n`
                  transStream.write(chunkStr)
                  console.log('[QwenAI] Content chunk written')
                } else {
                  console.log('[QwenAI] No content to send in answer phase')
                }
              }
            } else if (phase === null && content) {
              // Accumulate content for tool call detection
              this.content += content
              
              const chunk = {
                id: this.responseId || this.chatId,
                model: this.model,
                object: 'chat.completion.chunk',
                choices: [{ index: 0, delta: { content }, finish_reason: null }],
                created: this.created,
              }
              transStream.write(`data: ${JSON.stringify(chunk)}\n\n`)
            }

            if (status === 'finished' && (phase === 'answer' || phase === null)) {
              // Check for tool calls before sending stop
              if (hasToolUse(this.content)) {
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
    console.log('[QwenAI] Starting non-stream handler...')

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
              } else if (phase === 'answer' && status !== 'finished') {
                data.choices[0].message.content += content
              }

              if (status === 'finished') {
                if (reasoningText) {
                  data.choices[0].message.reasoning_content = reasoningText
                }
                console.log('[QwenAI] Non-stream finished, content length:', data.choices[0].message.content.length)

                if (this.onEnd && this.chatId) {
                  this.onEnd(this.chatId)
                }

                resolve(data)
              }
            }
          } catch (err) {
            console.error('[QwenAI] Non-stream parse error:', err)
            reject(err)
          }
        },
      })

      stream.on('data', (buffer: Buffer) => parser.feed(buffer.toString()))
      stream.once('error', (err: Error) => {
        console.error('[QwenAI] Non-stream error:', err)
        reject(err)
      })
      stream.once('close', () => {
        console.log('[QwenAI] Non-stream closed, resolving with current data')
        if (reasoningText) {
          data.choices[0].message.reasoning_content = reasoningText
        }
        resolve(data)
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
