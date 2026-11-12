/**
 * LongCat Adapter
 *
 * Drives the LongCat web chat (https://longcat.ai) with the
 * `passport_token_key` cookie (or the full captured cookie jar).
 * No official API key is involved.
 *
 * Flow:
 *   POST /api/v1/session-create   -> conversationId
 *   POST /api/v1/chat-completion  -> SSE stream (OpenAI-style deltas)
 *   GET  /api/v1/session-delete   -> clean up the conversation
 */

import axios, { AxiosResponse } from 'axios'
import { PassThrough } from 'stream'
import { createParser } from 'eventsource-parser'
import { Account, Provider } from '../../store/types'
import { createBaseChunk } from '../utils/streamToolHandler'
import { ToolStreamParser } from '../toolCalling/ToolStreamParser'
import type { ToolCallingPlan } from '../toolCalling/types'
import {
  LONGCAT_API_BASE,
  LONGCAT_USER_AGENT,
  buildLongCatCookieHeader,
} from '../../providers/longcatCookie'

export { normalizeLongCatCookie } from '../../providers/longcatCookie'

const LONGCAT_HEADERS: Record<string, string> = {
  'Accept': 'text/event-stream,application/json',
  'Accept-Language': 'en-US,en;q=0.9',
  'Cache-Control': 'no-cache',
  'Content-Type': 'application/json',
  'Origin': LONGCAT_API_BASE,
  'Pragma': 'no-cache',
  'Referer': `${LONGCAT_API_BASE}/`,
  'User-Agent': LONGCAT_USER_AGENT,
  'X-Client-Language': 'en',
  'X-Requested-With': 'XMLHttpRequest',
}

export interface LongCatMessage {
  role: string
  content: string | Array<{ type?: string; text?: string }> | null
}

export interface LongCatChatRequest {
  model: string
  originalModel?: string
  messages: LongCatMessage[]
  stream?: boolean
  web_search?: boolean
  reasoning_effort?: 'low' | 'medium' | 'high' | boolean
}

export interface LongCatDelta {
  content?: string
  reasoning?: string
  error?: string
  finished?: boolean
}

function uuid(): string {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0
    const v = c === 'x' ? r : (r & 0x3) | 0x8
    return v.toString(16)
  })
}

function messageText(message: LongCatMessage): string {
  if (typeof message.content === 'string') {
    return message.content
  }
  if (Array.isArray(message.content)) {
    return message.content
      .filter((part) => part && (part.type === 'text' || typeof part.text === 'string'))
      .map((part) => part.text || '')
      .join('\n')
  }
  return ''
}

/**
 * The web API takes a single `content` string, so a conversation is flattened
 * into `role:content;role:content` pairs.
 */
export function flattenLongCatMessages(messages: LongCatMessage[]): string {
  return messages
    .map((message) => {
      const content = messageText(message)
      if (!content) {
        return null
      }
      return `${message.role || 'user'}:${content}`
    })
    .filter((value): value is string => Boolean(value))
    .join(';')
}

export function resolveLongCatOptions(request: LongCatChatRequest): {
  searchEnabled: 0 | 1
  reasonEnabled: 0 | 1
} {
  const modelName = (request.originalModel || request.model || '').toLowerCase()
  const searchEnabled = request.web_search || modelName.includes('search') ? 1 : 0
  const thinkingRequested =
    (request.reasoning_effort !== undefined &&
      request.reasoning_effort !== false &&
      request.reasoning_effort !== 'none') ||
    modelName.includes('think')
  return {
    searchEnabled,
    reasonEnabled: thinkingRequested ? 1 : 0,
  }
}

/**
 * Normalize both the legacy OpenAI-style SSE payloads and the newer AG-UI
 * events used by /api/v1/chat-completion-V2.
 */
export function extractLongCatDelta(input: any): LongCatDelta {
  if (!input || typeof input !== 'object') {
    return {}
  }
  const candidates: any[] = [input]
  if (input.data && typeof input.data === 'object') {
    candidates.push(input.data)
  }
  if (input.event && typeof input.event === 'object') {
    candidates.push(input.event)
  }

  for (const payload of candidates) {
    const choice = Array.isArray(payload.choices) ? payload.choices[0] : undefined
    if (choice) {
      const delta = choice.delta || choice.message || {}
      const content = typeof delta.content === 'string' ? delta.content : undefined
      const reasoning =
        typeof delta.reasoning_content === 'string'
          ? delta.reasoning_content
          : typeof delta.reasoning === 'string'
            ? delta.reasoning
            : undefined
      const finished =
        choice.finish_reason === 'stop' ||
        payload.lastOne === true ||
        payload.done === true
      if (content || reasoning || finished) {
        return { content, reasoning, finished }
      }
    }

    const type = typeof payload.type === 'string' ? payload.type : ''
    if (type === 'TEXT_MESSAGE_CONTENT' && typeof payload.delta === 'string') {
      return { content: payload.delta }
    }
    if (
      (type === 'REASONING_MESSAGE_CONTENT' || type === 'THINKING_TEXT_MESSAGE_CONTENT') &&
      typeof payload.delta === 'string'
    ) {
      return { reasoning: payload.delta }
    }
    if (type === 'TEXT_MESSAGE_CHUNK' && typeof payload.delta === 'string') {
      return { content: payload.delta }
    }
    if (type === 'RUN_ERROR') {
      return { error: payload.message || payload.error?.message || 'LongCat run error' }
    }
    if (type === 'RUN_FINISHED' || type === 'RUN_COMPLETED') {
      return { finished: true }
    }

    if (payload.lastOne === true || payload.done === true) {
      return { finished: true }
    }
    if (payload.error) {
      const error =
        typeof payload.error === 'string'
          ? payload.error
          : payload.error.message || payload.error.detail || JSON.stringify(payload.error)
      return { error }
    }
    if (typeof payload.delta === 'string' && payload.delta) {
      return { content: payload.delta }
    }
    if (typeof payload.content === 'string' && payload.content) {
      return { content: payload.content }
    }
  }

  return {}
}

export class LongCatAdapter {
  private provider: Provider
  private account: Account

  constructor(provider: Provider, account: Account) {
    this.provider = provider
    this.account = account
  }

  static isLongCatProvider(provider: Provider): boolean {
    return (
      provider.id === 'longcat' ||
      provider.apiEndpoint.includes('longcat.ai') ||
      provider.apiEndpoint.includes('longcat.chat')
    )
  }

  private getCookie(): string {
    const credentials = this.account.credentials || {}
    const cookie = buildLongCatCookieHeader(credentials)
    if (!cookie) {
      throw new Error('LongCat passport_token_key cookie is not configured')
    }
    return cookie
  }

  private headers(cookie: string, extra: Record<string, string> = {}): Record<string, string> {
    return {
      ...LONGCAT_HEADERS,
      Cookie: cookie,
      ...extra,
    }
  }

  async createSession(): Promise<string> {
    const cookie = this.getCookie()
    const response = await axios.post(
      `${LONGCAT_API_BASE}/api/v1/session-create`,
      { model: '', agentId: '' },
      {
        headers: this.headers(cookie, { Referer: `${LONGCAT_API_BASE}/` }),
        timeout: 20000,
        validateStatus: () => true,
      },
    )

    const data = response.data
    if (response.status >= 400 || data?.code !== 0) {
      throw new Error(
        `LongCat session creation failed: ${data?.message || `HTTP ${response.status}`}`,
      )
    }
    const conversationId =
      data?.data?.conversationId || data?.data?.conversation_id || data?.data?.id
    if (!conversationId) {
      throw new Error('LongCat session creation returned no conversationId')
    }
    return String(conversationId)
  }

  async deleteSession(conversationId: string): Promise<void> {
    const cookie = this.getCookie()
    try {
      await axios.get(`${LONGCAT_API_BASE}/api/v1/session-delete`, {
        params: { conversationId },
        headers: this.headers(cookie, {
          Referer: `${LONGCAT_API_BASE}/c/${conversationId}`,
        }),
        timeout: 15000,
        validateStatus: () => true,
      })
    } catch (error) {
      console.warn('[LongCat] Failed to delete session:', error)
    }
  }

  async chatCompletion(
    request: LongCatChatRequest,
  ): Promise<{ response: AxiosResponse; conversationId: string }> {
    const cookie = this.getCookie()
    const conversationId = await this.createSession()
    const content = flattenLongCatMessages(request.messages)
    const { searchEnabled, reasonEnabled } = resolveLongCatOptions(request)

    const body = {
      conversationId,
      content,
      reasonEnabled,
      searchEnabled,
      parentMessageId: 0,
    }

    const post = (path: string) =>
      axios.post(`${LONGCAT_API_BASE}${path}`, body, {
        headers: this.headers(cookie, {
          Referer: `${LONGCAT_API_BASE}/c/${conversationId}`,
        }),
        responseType: 'stream',
        timeout: 120000,
        validateStatus: () => true,
      })

    let response = await post('/api/v1/chat-completion')
    if (response.status === 404 || response.status === 405) {
      console.log('[LongCat] Legacy completion endpoint unavailable, trying V2')
      try {
        if (response.data && typeof response.data.destroy === 'function') {
          response.data.destroy()
        }
      } catch {
        // Ignore teardown errors
      }
      response = await post('/api/v1/chat-completion-V2')
    }

    if (response.status === 200 && response.data && typeof response.data.on === 'function') {
      // Detect JSON error bodies that were returned with a 200 status.
      const prefix = await readPrefix(response.data)
      const text = prefix.toString('utf8')
      if (text.trim().startsWith('{') && text.includes('"code"') && !text.includes('data:')) {
        try {
          const parsed = JSON.parse(text)
          if (parsed.code !== 0) {
            throw new Error(`LongCat chat failed: ${parsed.message || parsed.code}`)
          }
        } catch (error) {
          if (error instanceof Error && error.message.startsWith('LongCat chat failed')) {
            throw error
          }
        }
      }
      response.data = replayPrefix(prefix, response.data)
    }

    return { response, conversationId }
  }
}

function readPrefix(stream: any, timeoutMs = 3000): Promise<Buffer> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = []
    let settled = false
    const finish = () => {
      if (settled) {
        return
      }
      settled = true
      clearTimeout(timer)
      stream.removeListener('data', onData)
      try {
        stream.pause()
      } catch {
        // Ignore pause errors
      }
      resolve(Buffer.concat(chunks))
    }
    const onData = (chunk: Buffer) => {
      chunks.push(Buffer.from(chunk))
      const text = Buffer.concat(chunks).toString('utf8')
      if (text.includes('\n') || text.length > 4096) {
        finish()
      }
    }
    const timer = setTimeout(finish, timeoutMs)
    stream.on('data', onData)
    stream.once('end', finish)
    stream.once('error', finish)
  })
}

function replayPrefix(prefix: Buffer, stream: any): PassThrough {
  const output = new PassThrough()
  if (prefix.length > 0) {
    output.write(prefix)
  }
  stream.pipe(output)
  return output
}

export class LongCatStreamHandler {
  private model: string
  private created: number
  private conversationId: string
  private onEnd?: (conversationId: string) => void
  private parser?: ToolStreamParser
  private content = ''
  private reasoning = ''
  private sentRole = false
  private sentThinkingRole = false
  private finished = false
  private streamEnded = false

  constructor(
    model: string,
    conversationId: string = '',
    onEnd?: (conversationId: string) => void,
    toolCallingPlan?: ToolCallingPlan,
  ) {
    this.model = model
    this.created = Math.floor(Date.now() / 1000)
    this.conversationId = conversationId
    this.onEnd = onEnd
    this.parser = toolCallingPlan?.shouldParseResponse
      ? new ToolStreamParser(toolCallingPlan)
      : undefined
  }

  private baseChunk() {
    return createBaseChunk(
      `chatcmpl-${this.conversationId || uuid()}`,
      this.model,
      this.created,
    )
  }

  async handleStream(response: any): Promise<PassThrough> {
    const output = new PassThrough()
    const base = this.baseChunk()

    const write = (chunk: any) => {
      output.write(`data: ${JSON.stringify(chunk)}\n\n`)
    }

    const finish = () => {
      if (this.finished) {
        return
      }
      this.finished = true

      if (this.parser) {
        for (const chunk of this.parser.flush(base)) {
          write(chunk)
        }
      }

      write({
        ...base,
        choices: [
          {
            index: 0,
            delta: {},
            finish_reason: this.parser?.hasEmittedToolCall() ? 'tool_calls' : 'stop',
          },
        ],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      })
      output.end('data: [DONE]\n\n')
      if (this.onEnd) {
        try {
          this.onEnd(this.conversationId)
        } catch (error) {
          console.error('[LongCat] onEnd callback failed:', error)
        }
      }
    }

    const handlePayload = (payload: any) => {
      const delta = extractLongCatDelta(payload)
      if (delta.error) {
        write({
          ...base,
          choices: [
            {
              index: 0,
              delta: { content: `\nError: ${delta.error}` },
              finish_reason: 'stop',
            },
          ],
        })
        finish()
        return
      }

      if (delta.reasoning) {
        this.reasoning += delta.reasoning
        if (!this.sentThinkingRole) {
          write({
            ...base,
            choices: [
              {
                index: 0,
                delta: { role: 'assistant', reasoning_content: '' },
                finish_reason: null,
              },
            ],
          })
          this.sentThinkingRole = true
        }
        write({
          ...base,
          choices: [
            {
              index: 0,
              delta: { reasoning_content: delta.reasoning },
              finish_reason: null,
            },
          ],
        })
      }

      if (delta.content) {
        this.content += delta.content
        if (this.parser) {
          const chunks = this.parser.push(delta.content, base, !this.sentRole)
          for (const chunk of chunks) {
            write(chunk)
          }
          if (chunks.length > 0) {
            this.sentRole = true
          }
        } else {
          write({
            ...base,
            choices: [
              {
                index: 0,
                delta: {
                  ...(this.sentRole ? {} : { role: 'assistant' }),
                  content: delta.content,
                },
                finish_reason: null,
              },
            ],
          })
          this.sentRole = true
        }
      }

      if (delta.finished) {
        finish()
      }
    }

    const parser = createParser({
      onEvent: (event: any) => {
        if (!event?.data) {
          return
        }
        const data = String(event.data).trim()
        if (!data || data === '[DONE]') {
          if (data === '[DONE]') {
            finish()
          }
          return
        }
        try {
          handlePayload(JSON.parse(data))
        } catch {
          // Ignore heartbeat or non-JSON lines
        }
      },
    })

    response.on('data', (chunk: Buffer) => {
      if (!this.streamEnded) {
        parser.feed(chunk.toString('utf8'))
      }
    })
    response.once('error', (error: Error) => {
      console.error('[LongCat] Stream error:', error)
      finish()
    })
    response.once('close', () => {
      this.streamEnded = true
      finish()
    })

    return output
  }

  async handleNonStream(response: any): Promise<any> {
    return new Promise((resolve) => {
      const contentParts: string[] = []
      const reasoningParts: string[] = []
      const toolCallChunks: any[] = []
      let resolved = false

      const finish = () => {
        if (resolved) {
          return
        }
        resolved = true
        const base = this.baseChunk()
        const chunks = this.parser ? this.parser.flush(base) : []
        for (const chunk of chunks) {
          const text = chunk.choices?.[0]?.delta?.content
          if (typeof text === 'string') {
            contentParts.push(text)
          }
          const toolCalls = chunk.choices?.[0]?.delta?.tool_calls
          if (Array.isArray(toolCalls)) {
            toolCallChunks.push(...toolCalls)
          }
        }

        const toolCalls = toolCallChunks.filter(Boolean)

        const message: any = {
          role: 'assistant',
          content: contentParts.join(''),
        }
        if (reasoningParts.length > 0) {
          message.reasoning_content = reasoningParts.join('')
        }
        if (toolCalls.length > 0) {
          message.tool_calls = toolCalls
        }

        resolve({
          id: base.id,
          model: this.model,
          object: 'chat.completion',
          choices: [
            {
              index: 0,
              message,
              finish_reason: toolCalls.length > 0 ? 'tool_calls' : 'stop',
            },
          ],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
          created: this.created,
        })
        if (this.onEnd) {
          try {
            this.onEnd(this.conversationId)
          } catch (error) {
            console.error('[LongCat] onEnd callback failed:', error)
          }
        }
      }

      const handlePayload = (payload: any) => {
        const delta = extractLongCatDelta(payload)
        if (delta.error) {
          contentParts.push(`\nError: ${delta.error}`)
          finish()
          return
        }
        if (delta.reasoning) {
          reasoningParts.push(delta.reasoning)
        }
        if (delta.content) {
          if (this.parser) {
            const base = this.baseChunk()
            const chunks = this.parser.push(delta.content, base, false)
            for (const chunk of chunks) {
              const text = chunk.choices?.[0]?.delta?.content
              if (typeof text === 'string') {
                contentParts.push(text)
              }
              const toolCalls = chunk.choices?.[0]?.delta?.tool_calls
              if (Array.isArray(toolCalls)) {
                toolCallChunks.push(...toolCalls)
              }
            }
          } else {
            contentParts.push(delta.content)
          }
        }
        if (delta.finished) {
          finish()
        }
      }

      const parser = createParser({
        onEvent: (event: any) => {
          if (!event?.data) {
            return
          }
          const data = String(event.data).trim()
          if (!data) {
            return
          }
          if (data === '[DONE]') {
            finish()
            return
          }
          try {
            handlePayload(JSON.parse(data))
          } catch {
            // Ignore non-JSON lines
          }
        },
      })

      const timer = setTimeout(finish, 120000)
      response.on('data', (chunk: Buffer) => parser.feed(chunk.toString('utf8')))
      response.once('error', (error: Error) => {
        console.error('[LongCat] Non-stream error:', error)
        clearTimeout(timer)
        finish()
      })
      response.once('close', () => {
        clearTimeout(timer)
        finish()
      })
    })
  }
}

export const longCatAdapter = {
  LongCatAdapter,
  LongCatStreamHandler,
}

export { LONGCAT_API_BASE, LONGCAT_HEADERS, LONGCAT_USER_AGENT }
