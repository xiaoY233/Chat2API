/**
 * Inception (Mercury) Adapter
 *
 * Drives the anonymous Inception Mercury playground (chat.inceptionlabs.ai)
 * with the `_vcrcs` Vercel clearance cookie. No official API key is involved.
 *
 * Flow:
 *   GET  /api/session                       -> { ok, token }
 *   POST /api/chat  (x-session-token)       -> Vercel AI data-stream SSE
 *
 * The clearance cookie can come from the in-app login window (captured in the
 * Electron session) or be solved natively; when a request is challenged the
 * adapter re-acquires clearance and replays once or twice.
 */

import axios, { AxiosResponse } from 'axios'
import { PassThrough } from 'stream'
import { createParser } from 'eventsource-parser'
import { Account, Provider } from '../../store/types'
import { createBaseChunk } from '../utils/streamToolHandler'
import { ToolStreamParser } from '../toolCalling/ToolStreamParser'
import type { ToolCallingPlan } from '../toolCalling/types'
import {
  INCEPTION_API_BASE,
  INCEPTION_USER_AGENT,
  buildInceptionRequestBody,
  buildInceptionCookieHeader,
  fetchInceptionSessionToken,
  getInceptionClearance,
  invalidateInceptionClearance,
  parseInceptionEvent,
  randomId,
  type InceptionMessage,
} from '../../providers/inception'

export {
  solveVercelChallenge,
  buildInceptionCookieHeader,
  buildInceptionMessages,
  buildInceptionRequestBody,
  parseInceptionEvent,
} from '../../providers/inception'

export interface InceptionChatRequest {
  model: string
  originalModel?: string
  messages: InceptionMessage[]
  stream?: boolean
  web_search?: boolean
  reasoning_effort?: 'low' | 'medium' | 'high' | 'instant' | boolean | string
}

function resolveEffort(request: InceptionChatRequest): string {
  const value = request.reasoning_effort
  if (typeof value === 'string') {
    const lowered = value.toLowerCase()
    if (['instant', 'low', 'medium', 'high'].includes(lowered)) return lowered
    if (lowered === 'none' || lowered === 'auto' || lowered === 'minimal') return 'instant'
  }
  if (value === true) return 'high'
  if (value === false) return 'instant'
  return 'medium'
}

export class InceptionAdapter {
  private provider: Provider
  private account: Account

  constructor(provider: Provider, account: Account) {
    this.provider = provider
    this.account = account
  }

  static isInceptionProvider(provider: Provider): boolean {
    return (
      provider.id === 'inception' ||
      provider.apiEndpoint.includes('chat.inceptionlabs.ai') ||
      provider.apiEndpoint.includes('inceptionlabs.ai')
    )
  }

  private async postChat(cookie: string, token: string, body: Record<string, unknown>): Promise<AxiosResponse> {
    return axios.post(`${INCEPTION_API_BASE}/api/chat`, body, {
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'text/event-stream, application/json',
        'Accept-Language': 'en-US,en;q=0.9',
        'x-session-token': token,
        'Origin': INCEPTION_API_BASE,
        'Referer': `${INCEPTION_API_BASE}/`,
        'User-Agent': INCEPTION_USER_AGENT,
        'Cookie': cookie,
      },
      responseType: 'stream',
      timeout: 120000,
      maxRedirects: 0,
      validateStatus: () => true,
    })
  }

  async chatCompletion(request: InceptionChatRequest): Promise<{ response: AxiosResponse; cookie: string }> {
    const body = buildInceptionRequestBody(request.messages, {
      reasoningEffort: resolveEffort(request),
      webSearch: request.web_search,
    })

    const stored = buildInceptionCookieHeader(this.account.credentials)
    let cookie = stored
    let last: AxiosResponse | null = null

    for (let attempt = 0; attempt < 3; attempt++) {
      if (!cookie) {
        cookie = await getInceptionClearance()
      }

      let token: string
      try {
        token = await fetchInceptionSessionToken(cookie)
      } catch (error) {
        // A stored cookie may be stale: drop it and let the next attempt solve
        // a fresh clearance natively.
        if (attempt < 2) {
          console.warn('[Inception] session creation failed, refreshing clearance:', error instanceof Error ? error.message : error)
          cookie = ''
          invalidateInceptionClearance()
          continue
        }
        throw error
      }

      const response = await this.postChat(cookie, token, body)
      last = response

      if (response.status === 200) {
        return { response, cookie }
      }

      // Discard the error body and retry with a freshly solved clearance.
      if (response.data && typeof response.data.destroy === 'function') {
        try {
          response.data.destroy()
        } catch {
          // ignore teardown errors
        }
      }

      if (response.status === 429 || response.status === 403) {
        console.warn(`[Inception] upstream challenged (HTTP ${response.status}); refreshing clearance`)
        cookie = ''
        invalidateInceptionClearance()
        continue
      }

      break
    }

    if (!last) {
      throw new Error('Inception: no response from upstream')
    }
    return { response: last, cookie }
  }
}

export class InceptionStreamHandler {
  private model: string
  private created: number
  private parser?: ToolStreamParser
  private content = ''
  private reasoning = ''
  private sentRole = false
  private sentThinkingRole = false
  private finished = false
  private streamEnded = false

  constructor(model: string, toolCallingPlan?: ToolCallingPlan) {
    this.model = model
    this.created = Math.floor(Date.now() / 1000)
    this.parser = toolCallingPlan?.shouldParseResponse ? new ToolStreamParser(toolCallingPlan) : undefined
  }

  private baseChunk() {
    return createBaseChunk(`chatcmpl-${randomId('c')}`, this.model, this.created)
  }

  async handleStream(response: any): Promise<PassThrough> {
    const output = new PassThrough()
    const base = this.baseChunk()
    const write = (chunk: any) => output.write(`data: ${JSON.stringify(chunk)}\n\n`)

    const finish = () => {
      if (this.finished) return
      this.finished = true
      if (this.parser) {
        for (const chunk of this.parser.flush(base)) write(chunk)
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
    }

    const handlePayload = (payload: any) => {
      const delta = parseInceptionEvent(payload)
      if (delta.error) {
        write({
          ...base,
          choices: [{ index: 0, delta: { content: `\nError: ${delta.error}` }, finish_reason: 'stop' }],
        })
        finish()
        return
      }
      if (delta.reasoning) {
        this.reasoning += delta.reasoning
        if (!this.sentThinkingRole) {
          write({
            ...base,
            choices: [{ index: 0, delta: { role: 'assistant', reasoning_content: '' }, finish_reason: null }],
          })
          this.sentThinkingRole = true
        }
        write({
          ...base,
          choices: [{ index: 0, delta: { reasoning_content: delta.reasoning }, finish_reason: null }],
        })
      }
      if (delta.content) {
        this.content += delta.content
        if (this.parser) {
          const chunks = this.parser.push(delta.content, base, !this.sentRole)
          for (const chunk of chunks) write(chunk)
          if (chunks.length > 0) this.sentRole = true
        } else {
          write({
            ...base,
            choices: [
              {
                index: 0,
                delta: { ...(this.sentRole ? {} : { role: 'assistant' }), content: delta.content },
                finish_reason: null,
              },
            ],
          })
          this.sentRole = true
        }
      }
      if (delta.finished) finish()
    }

    const parser = createParser({
      onEvent: (event: any) => {
        if (!event?.data) return
        const data = String(event.data).trim()
        if (!data) return
        if (data === '[DONE]') {
          finish()
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
      if (!this.streamEnded) parser.feed(chunk.toString('utf8'))
    })
    response.once('error', (error: Error) => {
      console.error('[Inception] Stream error:', error)
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
        if (resolved) return
        resolved = true
        const base = this.baseChunk()
        const chunks = this.parser ? this.parser.flush(base) : []
        for (const chunk of chunks) {
          const text = chunk.choices?.[0]?.delta?.content
          if (typeof text === 'string') contentParts.push(text)
          const toolCalls = chunk.choices?.[0]?.delta?.tool_calls
          if (Array.isArray(toolCalls)) toolCallChunks.push(...toolCalls)
        }
        const toolCalls = toolCallChunks.filter(Boolean)
        const message: any = { role: 'assistant', content: contentParts.join('') }
        if (reasoningParts.length > 0) message.reasoning_content = reasoningParts.join('')
        if (toolCalls.length > 0) message.tool_calls = toolCalls
        resolve({
          id: base.id,
          model: this.model,
          object: 'chat.completion',
          choices: [
            { index: 0, message, finish_reason: toolCalls.length > 0 ? 'tool_calls' : 'stop' },
          ],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
          created: this.created,
        })
      }

      const handlePayload = (payload: any) => {
        const delta = parseInceptionEvent(payload)
        if (delta.error) {
          contentParts.push(`\nError: ${delta.error}`)
          finish()
          return
        }
        if (delta.reasoning) reasoningParts.push(delta.reasoning)
        if (delta.content) {
          if (this.parser) {
            const base = this.baseChunk()
            const chunks = this.parser.push(delta.content, base, false)
            for (const chunk of chunks) {
              const text = chunk.choices?.[0]?.delta?.content
              if (typeof text === 'string') contentParts.push(text)
              const toolCalls = chunk.choices?.[0]?.delta?.tool_calls
              if (Array.isArray(toolCalls)) toolCallChunks.push(...toolCalls)
            }
          } else {
            contentParts.push(delta.content)
          }
        }
        if (delta.finished) finish()
      }

      const parser = createParser({
        onEvent: (event: any) => {
          if (!event?.data) return
          const data = String(event.data).trim()
          if (!data) return
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
        console.error('[Inception] Non-stream error:', error)
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

export const inceptionAdapter = {
  InceptionAdapter,
  InceptionStreamHandler,
}

export { INCEPTION_API_BASE, INCEPTION_USER_AGENT }