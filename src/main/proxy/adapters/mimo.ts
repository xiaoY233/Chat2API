/**
 * Mimo Adapter
 * Implements Mimo (Xiaomi AI Studio) API protocol
 */

import axios from 'axios'
import type { AxiosResponse } from 'axios'
import { PassThrough } from 'stream'
import type { Account, Provider } from '../../store/types'
import type { ChatMessage } from '../types.ts'
import { ToolStreamParser } from '../toolCalling/ToolStreamParser.ts'
import type { ToolCallingPlan } from '../toolCalling/types.ts'
import { getProviderToolProfile } from '../toolCalling/providerProfiles.ts'

const MIMO_API_BASE = 'https://aistudio.xiaomimimo.com'

function uuid(separator: boolean = true): string {
  const id = 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0
    const v = c === 'x' ? r : (r & 0x3) | 0x8
    return v.toString(16)
  })
  return separator ? id : id.replace(/-/g, '')
}

type MimoMessage = ChatMessage

interface ChatCompletionRequest {
  model: string
  originalModel?: string
  messages: MimoMessage[]
  stream?: boolean
  temperature?: number
}

interface MimoUsage {
  promptTokens: number
  completionTokens: number
  totalTokens: number
  reasoningTokens: number
}

interface MimoChunk {
  type: 'text' | 'usage' | 'dialogId' | 'finish' | 'message'
  content?: string
  usage?: MimoUsage
}

export interface ParsedToolCall {
  id: string
  name: string
  arguments: Record<string, unknown>
}

function parseXmlParam(xml: string): Record<string, unknown> {
  const result: Record<string, unknown> = {}
  const re = /<(?:parameter|arg) name="([^"]+)">((?:.|\n|\r)*?)<\/(?:parameter|arg)>/g
  let m: RegExpExecArray | null
  while ((m = re.exec(xml)) !== null) {
    const key = m[1]
    const val = m[2].trim()
    try {
      result[key] = JSON.parse(val)
    } catch {
      result[key] = val
    }
  }
  return result
}

function extractName(inner: string): string | null {
  let m = inner.match(/<name>([^<\n]+?)<\/name>/)
  if (m) return m[1].trim()
  m = inner.match(/<name=([^<>\n\/]+)/)
  if (m) return m[1].trim()
  return null
}

function parseMimoNativeToolCalls(text: string): ParsedToolCall[] {
  const calls: ParsedToolCall[] = []
  const blockRe = /<tool_callgt;([\s\S]*?)<\/tool_call>/g
  let block: RegExpExecArray | null
  while ((block = blockRe.exec(text)) !== null) {
    let inner = block[1].trim()
    if (inner.startsWith('<tool_result>')) inner = inner.slice('<tool_result>'.length).trim()
    if (inner.endsWith('</tool_result>')) inner = inner.slice(0, -'</tool_result>'.length).trim()
    if (inner.startsWith('{')) {
      try {
        const parsed = JSON.parse(inner)
        if (parsed.name) {
          calls.push({
            id: `call_${Math.random().toString(36).slice(2, 10)}`,
            name: parsed.name,
            arguments: parsed.arguments ?? parsed.parameters ?? parsed.input ?? {},
          })
        }
      } catch {
        // skip
      }
    } else if (inner.includes('<name')) {
      const name = extractName(inner)
      if (!name) continue
      const args = parseXmlParam(inner)
      calls.push({
        id: `call_${Math.random().toString(36).slice(2, 10)}`,
        name,
        arguments: args,
      })
    } else {
      const tagMatch = inner.match(/^<([a-zA-Z_][a-zA-Z0-9_]*)>/)
      if (!tagMatch) continue
      const name = tagMatch[1].trim()
      const args: Record<string, unknown> = {}
      const paramRe4 = /<([a-zA-Z_][a-zA-Z0-9_]*?)>((?:.|\n|\r)*?)<\/\1>/g
      let pm: RegExpExecArray | null
      while ((pm = paramRe4.exec(inner)) !== null) {
        if (pm[1] === name) continue
        const key = pm[1].trim()
        const val = pm[2].trim()
        try {
          args[key] = JSON.parse(val)
        } catch {
          args[key] = val
        }
      }
      calls.push({
        id: `call_${Math.random().toString(36).slice(2, 10)}`,
        name,
        arguments: args,
      })
    }
  }
  return calls
}

export function parseToolCalls(text: string): ParsedToolCall[] {
  if (text.includes('<tool_callgt;')) {
    const calls = parseMimoNativeToolCalls(text)
    return calls
  }
  const calls: ParsedToolCall[] = []
  const blockRe = /<function_calls>([\s\S]*?)<\/function_calls>/g
  let block: RegExpExecArray | null
  while ((block = blockRe.exec(text)) !== null) {
    const invokeRe = /<invoke name="([^"]+)">([\s\S]*?)<\/invoke>/g
    let inv: RegExpExecArray | null
    while ((inv = invokeRe.exec(block[1])) !== null) {
      calls.push({
        id: `call_${Math.random().toString(36).slice(2, 10)}`,
        name: inv[1],
        arguments: parseXmlParam(inv[2]),
      })
    }
  }
  return calls
}

export function hasToolCallMarker(text: string): boolean {
  return text.includes('<tool_callgt;') || text.includes('<function_calls>')
}

const CITATION_PATTERN = '(?:从)?\\(citation:\\d+\\)(?:中[：:])?'
const CITATION_PATTERN_LOOSE = 'citation:\\d+'
const CITATION_START = '(citation'

function stripCitations(text: string): string {
  return text
    .replace(/从\(citation:\d+\)中[：:]\s*/g, '')
    .replace(/-?\s*citation:\d+[：:]\s*/g, '')
    .replace(/[（\(]\s*citation:\d+(?:,\s*citation:\d+)*\s*[）\)]/g, '')
    .replace(/citation:\d+(?:,\s*citation:\d+)*/g, '')
    .replace(/\(citation:\d+\)/g, '')
    .replace(/\[\d+\]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

function stripCitationsWithBuffer(text: string, buffer: { value: string }): string {
  const combined = buffer.value + text
  
  let cleaned = combined
    .replace(/从\(citation:\d+\)中[：:]\s*/g, '')
    .replace(/-?\s*citation:\d+[：:]\s*/g, '')
    .replace(/[（\(]\s*citation:\d+(?:,\s*citation:\d+)*\s*[）\)]/g, '')
    .replace(/citation:\d+(?:,\s*citation:\d+)*/g, '')
    .replace(/\(citation:\d+\)/g, '')
    .replace(/\[\d+\]/g, '')
  
  const lastCitationStart = cleaned.lastIndexOf(CITATION_START)
  if (lastCitationStart !== -1) {
    const afterCitation = cleaned.slice(lastCitationStart)
    if (!afterCitation.includes(')')) {
      buffer.value = afterCitation
      cleaned = cleaned.slice(0, lastCitationStart)
    } else {
      buffer.value = ''
    }
  } else {
    buffer.value = ''
  }
  
  return cleaned.replace(/\s+/g, ' ').trim()
}

function stripThinkTags(text: string): string {
  text = text.replace(/\u0000/g, '')
  // Remove opening think tag (including partial ones at the beginning)
  text = text.replace(/^<think[^>]*>/, '')
  // Remove &gt; entity which might be part of a broken tag
  text = text.replace(/^&gt;/, '')
  // Also handle cases where only part of the tag is present
  text = text.replace(/^hink>/, '')
  text = text.replace(/^ink>/, '')
  text = text.replace(/^nk>/, '')
  text = text.replace(/^k>/, '')
  text = text.replace(/^>/, '')
  return text
}

function stripThink(text: string): string {
  text = text.replace(/\u0000/g, '')
  text = text.replace(/<think[\s\S]*?<\/think>/g, '')
  text = text.replace(/<think[\s\S]*?<\/thinkgt;/g, '')
  const openIdx = text.indexOf('<think')
  if (openIdx !== -1) text = text.slice(0, openIdx)
  return text.trimStart()
}

function extractThinkContent(text: string): { thinking: string; content: string } {
  let thinking = ''
  let content = text

  const thinkRegex = /<think[^>]*>([\s\S]*?)<\/think>/g
  let match
  while ((match = thinkRegex.exec(text)) !== null) {
    thinking += match[1]
  }

  const thinkRegex2 = /<think[^>]*>([\s\S]*?)<\/thinkgt;/g
  while ((match = thinkRegex2.exec(text)) !== null) {
    thinking += match[1]
  }

  content = stripThink(text)

  const openIdx = text.indexOf('<think')
  if (openIdx !== -1 && !text.includes('</think') && !text.includes('</thinkgt;')) {
    const partialThink = text.slice(openIdx)
    thinking += partialThink.replace(/<think[^>]*>/, '')
  }

  return { thinking, content }
}

function extractTextContent(content: ChatMessage['content']): string {
  if (typeof content === 'string') {
    return content
  }
  if (Array.isArray(content)) {
    return content
      .filter((part) => typeof part === 'object' && part !== null && part.type === 'text' && part.text)
      .map((part) => part.text)
      .join('\n')
  }
  return ''
}

export function buildMimoQuery(messages: MimoMessage[]): string {
  const toolProfile = getProviderToolProfile('mimo')
  const entries: Array<{ role: string; content: string }> = []

  for (const message of messages) {
    if (message.role === 'assistant' && message.tool_calls && message.tool_calls.length > 0) {
      entries.push({
        role: 'Assistant',
        content: toolProfile.formatAssistantToolCalls(message.tool_calls.map((toolCall) => ({
          id: toolCall.id,
          name: toolCall.function.name,
          arguments: toolCall.function.arguments,
        }))),
      })
      continue
    }

    if (message.role === 'tool' && message.tool_call_id) {
      entries.push({
        role: 'User',
        content: toolProfile.formatToolResult({
          toolCallId: message.tool_call_id,
          content: extractTextContent(message.content),
          isError: (message as { is_error?: boolean }).is_error === true,
        }),
      })
      continue
    }

    const content = extractTextContent(message.content).trim()
    if (!content) {
      continue
    }

    const role = message.role === 'system'
      ? 'System'
      : message.role === 'assistant'
        ? 'Assistant'
        : 'User'

    entries.push({ role, content })
  }

  if (entries.length === 1 && entries[0].role === 'User') {
    return entries[0].content
  }

  return entries.map((entry) => `${entry.role}: ${entry.content}`).join('\n\n')
}

export class MimoAdapter {
  private provider: Provider
  private account: Account

  constructor(provider: Provider, account: Account) {
    this.provider = provider
    this.account = account
  }

  private getCredentials(): { serviceToken: string; userId: string; phToken: string } {
    const credentials = this.account.credentials
    return {
      serviceToken: credentials.service_token || '',
      userId: credentials.user_id || '',
      phToken: credentials.ph_token || '',
    }
  }

  static isMimoProvider(provider: Provider): boolean {
    return provider.id === 'mimo' || provider.name?.toLowerCase().includes('mimo')
  }

  private buildUrl(path: string, phToken: string): string {
    return `${MIMO_API_BASE}${path}?xiaomichatbot_ph=${encodeURIComponent(phToken)}`
  }

  private buildHeaders(serviceToken: string, userId: string, phToken: string): Record<string, string> {
    return {
      'Content-Type': 'application/json',
      Cookie: `serviceToken=${serviceToken}; userId=${userId}; xiaomichatbot_ph=${phToken}`,
      Origin: MIMO_API_BASE,
      Referer: `${MIMO_API_BASE}/`,
      'X-Timezone': 'Asia/Shanghai',
      Accept: '*/*',
      'Accept-Encoding': 'gzip, deflate, br, zstd',
      'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
      'Cache-Control': 'no-cache',
      Pragma: 'no-cache',
      'Sec-Ch-Ua': '"Chromium";v="144", "Not(A:Brand";v="8", "Google Chrome";v="144"',
      'Sec-Ch-Ua-Mobile': '?0',
      'Sec-Ch-Ua-Platform': '"Windows"',
      'Sec-Fetch-Dest': 'empty',
      'Sec-Fetch-Mode': 'cors',
      'Sec-Fetch-Site': 'same-origin',
    }
  }

  private async saveConversation(conversationId: string): Promise<void> {
    const { serviceToken, userId, phToken } = this.getCredentials()
    const response = await axios.post(
      this.buildUrl('/open-apis/chat/conversation/save', phToken),
      {
        conversationId,
        title: '新对话',
        type: 'chat',
      },
      {
        headers: this.buildHeaders(serviceToken, userId, phToken),
        timeout: 30000,
        validateStatus: () => true,
      }
    )

    const { code, msg, message } = response.data || {}
    if (response.status !== 200 || code !== 0) {
      throw new Error(`Mimo failed to save conversation: ${msg || message || `HTTP ${response.status}`}`)
    }
  }

  async generateConversationTitle(conversationId: string, query: string, answer: string): Promise<boolean> {
    const content = `${query} ${answer}`.trim()
    if (!conversationId || !content) {
      return false
    }

    try {
      const { serviceToken, userId, phToken } = this.getCredentials()
      const response = await axios.post(
        this.buildUrl('/open-apis/chat/conversation/genTitle', phToken),
        {
          conversationId,
          content,
        },
        {
          headers: this.buildHeaders(serviceToken, userId, phToken),
          timeout: 30000,
          validateStatus: () => true,
        }
      )

      const { code } = response.data || {}
      if (response.status !== 200 || code !== 0) {
        console.warn('[Mimo] Failed to generate conversation title:', response.status, response.data)
        return false
      }
      return true
    } catch (error) {
      console.warn('[Mimo] Failed to generate conversation title:', error)
      return false
    }
  }

  async chatCompletion(request: ChatCompletionRequest): Promise<{
    response: AxiosResponse
    conversationId: string
    query: string
  }> {
    const { serviceToken, userId, phToken } = this.getCredentials()

    if (!serviceToken || !userId || !phToken) {
      throw new Error('Mimo credentials not configured. Please add service_token, user_id, and ph_token in account settings.')
    }

    const conversationId = uuid(false)
    const msgId = uuid(false).slice(0, 32)
    const query = buildMimoQuery(request.messages)
    await this.saveConversation(conversationId)

    const modelLower = request.model.toLowerCase()
    let enableThinking = false
    if (modelLower.includes('think') || modelLower.includes('r1')) {
      enableThinking = true
    }

    const requestBody = {
      msgId,
      conversationId,
      query,
      isEditedQuery: false,
      modelConfig: {
        enableThinking,
        webSearchStatus: 'disabled',
        model: request.model,
        temperature: request.temperature ?? 0.8,
        topP: 0.95,
      },
      multiMedias: [],
    }

    const response = await axios({
      method: 'POST',
      url: this.buildUrl('/open-apis/bot/chat', phToken),
      data: requestBody,
      responseType: 'stream',
      headers: this.buildHeaders(serviceToken, userId, phToken),
    })

    return { response, conversationId, query }
  }

  private async getConversationList(pageNum: number = 1, pageSize: number = 100): Promise<{
    conversationIds: string[]
    hasMore: boolean
  }> {
    const { serviceToken, userId, phToken } = this.getCredentials()

    if (!serviceToken || !userId || !phToken) {
      throw new Error('Mimo credentials not configured')
    }

    const url = `${MIMO_API_BASE}/open-apis/chat/conversation/list?xiaomichatbot_ph=${encodeURIComponent(phToken)}`

    const response = await axios.post(
      url,
      {
        pageInfo: {
          pageNum,
          pageSize,
        },
      },
      {
        headers: {
          'Content-Type': 'application/json',
          Cookie: `serviceToken=${serviceToken}; userId=${userId}; xiaomichatbot_ph=${phToken}`,
          Origin: MIMO_API_BASE,
          Referer: `${MIMO_API_BASE}/`,
        },
        timeout: 30000,
        validateStatus: () => true,
      }
    )

    console.log('[Mimo] Get conversation list page', pageNum, 'response:', JSON.stringify(response.data, null, 2))

    const { code, data } = response.data || {}
    if (response.status !== 200 || code !== 0) {
      console.error('[Mimo] Failed to get conversation list')
      return { conversationIds: [], hasMore: false }
    }

    const conversationList = data?.dataList || []
    const conversationIds = conversationList.map((c: any) => c.conversationId).filter(Boolean)
    const hasMore = conversationList.length >= pageSize

    console.log('[Mimo] Found', conversationIds.length, 'conversations, hasMore:', hasMore)
    return { conversationIds, hasMore }
  }

  private async deleteConversations(conversationIds: string[]): Promise<boolean> {
    if (conversationIds.length === 0) {
      return true
    }

    const { serviceToken, userId, phToken } = this.getCredentials()

    if (!serviceToken || !userId || !phToken) {
      throw new Error('Mimo credentials not configured')
    }

    const url = `${MIMO_API_BASE}/open-apis/chat/conversation/delete?xiaomichatbot_ph=${encodeURIComponent(phToken)}`

    const response = await axios.post(
      url,
      conversationIds,
      {
        headers: {
          'Content-Type': 'application/json',
          Cookie: `serviceToken=${serviceToken}; userId=${userId}; xiaomichatbot_ph=${phToken}`,
          Origin: MIMO_API_BASE,
          Referer: `${MIMO_API_BASE}/`,
        },
        timeout: 60000,
        validateStatus: () => true,
      }
    )

    console.log('[Mimo] Delete conversations response:', JSON.stringify(response.data, null, 2))

    const { code } = response.data || {}
    return response.status === 200 && code === 0
  }

  async deleteSession(conversationId: string): Promise<boolean> {
    if (!conversationId) {
      return false
    }
    return await this.deleteConversations([conversationId])
  }

  async deleteAllChats(): Promise<boolean> {
    try {
      const allConversationIds: string[] = []
      let pageNum = 1
      let hasMore = true

      while (hasMore) {
        const { conversationIds, hasMore: more } = await this.getConversationList(pageNum, 100)
        allConversationIds.push(...conversationIds)
        hasMore = more
        pageNum++

        if (conversationIds.length === 0) {
          break
        }
      }

      if (allConversationIds.length === 0) {
        console.log('[Mimo] No conversations to delete')
        return true
      }

      console.log('[Mimo] Found', allConversationIds.length, 'conversations to delete')

      const success = await this.deleteConversations(allConversationIds)
      if (success) {
        console.log('[Mimo] All chats deleted')
      }
      return success
    } catch (error) {
      console.error('[Mimo] Failed to delete all chats:', error)
      return false
    }
  }
}

export class MimoStreamHandler {
  private model: string
  private conversationId: string
  private content: string = ''
  private thinking: string = ''
  private usage: MimoUsage | null = null
  private dialogId: string = ''
  private toolCalls: ParsedToolCall[] = []
  private thinkingMode: 'passthrough' | 'strip' | 'separate' = 'strip'
  private lastSentContentLen: number = 0
  private lastSentThinkLen: number = 0
  private toolCallBuf: string | null = null
  private pendingText: string = ''
  private citationBuffer: { value: string } = { value: '' }
  private thinkingCitationBuffer: { value: string } = { value: '' }
  private toolStreamParser?: ToolStreamParser

  constructor(
    model: string,
    conversationId: string,
    thinkingMode: 'passthrough' | 'strip' | 'separate' = 'strip',
    toolCallingPlan?: ToolCallingPlan
  ) {
    this.model = model
    this.conversationId = conversationId
    this.thinkingMode = thinkingMode
    this.toolStreamParser = toolCallingPlan?.shouldParseResponse ? new ToolStreamParser(toolCallingPlan) : undefined
  }

  async *handleStream(stream: NodeJS.ReadableStream): AsyncGenerator<string> {
    const id = `chatcmpl-${uuid(false)}`
    const created = Math.floor(Date.now() / 1000)

    yield this.formatOpenAIChunk(id, created, { role: 'assistant', content: '' }, 'role')

    let buffer = ''
    let currentEvent = ''
    
    // Track state and content
    let state: 'init' | 'thinking' | 'content' = 'init'
    let totalContent = ''
    let lastProcessedIndex = 0
    let thinkEndTagFound = false
    const thinkEndTag1 = '</think>'
    const thinkEndTag2 = '</thinkgt;'

    for await (const chunk of stream) {
      buffer += chunk.toString()
      const lines = buffer.split('\n')
      buffer = lines.pop() || ''

      for (const line of lines) {
        const trimmed = line.trim()

        if (trimmed.startsWith('event:')) {
          currentEvent = trimmed.slice(6).trim()
        } else if (trimmed.startsWith('data:')) {
          try {
            const dataStr = trimmed.slice(5).trim()
            const data = JSON.parse(dataStr)
            const mimoChunk: MimoChunk = { type: currentEvent as any, ...data }

            if ((mimoChunk.type === 'message' || mimoChunk.type === 'text') && mimoChunk.content) {
              const newText = (mimoChunk.content ?? '').replace(/\u0000/g, '')
              totalContent += newText
              this.content = totalContent

              if (state === 'init') {
                const thinkStartIdx = totalContent.indexOf('<think')
                if (thinkStartIdx !== -1) {
                  state = 'thinking'
                  // Skip any content before <think tag
                  lastProcessedIndex = thinkStartIdx
                } else {
                  state = 'content'
                }
              }

              if (state === 'thinking') {
                if (!thinkEndTagFound) {
                  // Look for think end tag
                  let thinkEndIdx = totalContent.indexOf(thinkEndTag1, lastProcessedIndex)
                  let actualEndTag = thinkEndTag1
                  
                  if (thinkEndIdx === -1) {
                    thinkEndIdx = totalContent.indexOf(thinkEndTag2, lastProcessedIndex)
                    actualEndTag = thinkEndTag2
                  }

                  if (thinkEndIdx !== -1) {
                    // Found the end of thinking
                    thinkEndTagFound = true
                    
                    // Extract the thinking content between lastProcessedIndex and thinkEndIdx
                    const thinkContent = totalContent.slice(lastProcessedIndex, thinkEndIdx)
                    const cleanedThink = stripThinkTags(thinkContent)
                    const cleanedThinkWithCitations = stripCitationsWithBuffer(cleanedThink, this.thinkingCitationBuffer)
                    
                    if (cleanedThinkWithCitations && this.thinkingMode === 'separate') {
                      yield this.formatOpenAIChunk(id, created, { reasoning_content: cleanedThinkWithCitations })
                    }
                    
                    // Move past the end tag
                    lastProcessedIndex = thinkEndIdx + actualEndTag.length
                    state = 'content'
                  } else {
                    // Still in thinking, process new content
                    const thinkContent = totalContent.slice(lastProcessedIndex)
                    const cleanedThink = stripThinkTags(thinkContent)
                    const cleanedThinkWithCitations = stripCitationsWithBuffer(cleanedThink, this.thinkingCitationBuffer)
                    
                    if (cleanedThinkWithCitations && this.thinkingMode === 'separate') {
                      yield this.formatOpenAIChunk(id, created, { reasoning_content: cleanedThinkWithCitations })
                    }
                    
                    lastProcessedIndex = totalContent.length
                  }
                }
              }
              
              if (state === 'content' && lastProcessedIndex < totalContent.length) {
                // Process content after thinking
                const contentPart = totalContent.slice(lastProcessedIndex)
                const cleanedContent = stripCitationsWithBuffer(contentPart, this.citationBuffer)
                
                if (cleanedContent) {
                  if (this.toolStreamParser) {
                    const chunks = this.toolStreamParser.push(cleanedContent, this.createBaseChunk(id, created))
                    for (const chunk of chunks) {
                      yield `data: ${JSON.stringify(chunk)}\n\n`
                    }
                    if (chunks.length > 0 || this.toolStreamParser.isBuffering() || this.toolStreamParser.hasEmittedToolCall()) {
                      lastProcessedIndex = totalContent.length
                      continue
                    }
                  }
                  yield this.formatOpenAIChunk(id, created, { content: cleanedContent })
                }
                
                lastProcessedIndex = totalContent.length
              }
            } else if (mimoChunk.type === 'usage' && mimoChunk.usage) {
              this.usage = mimoChunk.usage
            } else if (mimoChunk.type === 'dialogId' && mimoChunk.content) {
              this.dialogId = mimoChunk.content
            }
          } catch {
            // Skip malformed SSE data
          }
        }
      }
    }

    const flushChunks = this.toolStreamParser?.flush(this.createBaseChunk(id, created)) ?? []
    const protocolError = this.toolStreamParser?.getProtocolError()
    if (protocolError) throw protocolError
    for (const chunk of flushChunks) {
      yield `data: ${JSON.stringify(chunk)}\n\n`
    }

    yield this.formatOpenAIChunk(id, created, {}, this.toolStreamParser?.hasEmittedToolCall() ? 'tool_calls' : 'stop')

    if (this.usage) {
      yield this.formatOpenAIUsageChunk(id, created, this.usage)
    }
  }

  async handleNonStream(stream: NodeJS.ReadableStream): Promise<string> {
    let buffer = ''
    let currentEvent = ''

    for await (const chunk of stream) {
      buffer += chunk.toString()
      const lines = buffer.split('\n')
      buffer = lines.pop() || ''

      for (const line of lines) {
        const trimmed = line.trim()

        if (trimmed.startsWith('event:')) {
          currentEvent = trimmed.slice(6).trim()
        } else if (trimmed.startsWith('data:')) {
          try {
            const data = JSON.parse(trimmed.slice(5).trim())
            const mimoChunk: MimoChunk = { type: currentEvent as any, ...data }

            if ((mimoChunk.type === 'message' || mimoChunk.type === 'text') && mimoChunk.content) {
              const text = (mimoChunk.content ?? '').replace(/\u0000/g, '')
              this.content += text
            } else if (mimoChunk.type === 'usage' && mimoChunk.usage) {
              this.usage = mimoChunk.usage
            } else if (mimoChunk.type === 'dialogId' && mimoChunk.content) {
              this.dialogId = mimoChunk.content
            }
          } catch {
            // Skip malformed SSE data
          }
        }
      }
    }

    // Check for tool calls
    if (hasToolCallMarker(this.content)) {
      this.toolCalls = parseToolCalls(this.content)
    }

    // Process thinking content based on mode
    let finalContent = this.content
    let reasoningContent: string | undefined

    if (this.thinkingMode === 'strip') {
      finalContent = stripThink(this.content)
    } else if (this.thinkingMode === 'separate') {
      const extracted = extractThinkContent(this.content)
      finalContent = extracted.content
      reasoningContent = extracted.thinking
    }
    
    finalContent = stripCitations(finalContent)
    if (reasoningContent) {
      reasoningContent = stripCitations(reasoningContent)
    }

    const id = `chatcmpl-${uuid(false)}`
    const created = Math.floor(Date.now() / 1000)

    const response: any = {
      id,
      object: 'chat.completion',
      created,
      model: this.model,
      choices: [
        {
          index: 0,
          message: {
            role: 'assistant',
            content: finalContent,
          },
          finish_reason: this.toolCalls.length > 0 ? 'tool_calls' : 'stop',
        },
      ],
      usage: this.usage
        ? {
            prompt_tokens: this.usage.promptTokens,
            completion_tokens: this.usage.completionTokens,
            total_tokens: this.usage.totalTokens,
          }
        : undefined,
    }

    if (this.toolCalls.length > 0) {
      response.choices[0].message.tool_calls = this.toolCalls.map((tc) => ({
        id: tc.id,
        type: 'function',
        function: {
          name: tc.name,
          arguments: JSON.stringify(tc.arguments),
        },
      }))
    }

    if (reasoningContent) {
      response.choices[0].message.reasoning_content = reasoningContent
    }

    return JSON.stringify(response)
  }

  private formatOpenAIChunk(
    id: string,
    created: number,
    delta: { role?: string; content?: string; reasoning_content?: string },
    finishReason?: string
  ): string {
    const chunk: any = {
      id,
      object: 'chat.completion.chunk',
      created,
      model: this.model,
      choices: [
        {
          index: 0,
          delta,
          finish_reason: finishReason || null,
        },
      ],
    }
    return `data: ${JSON.stringify(chunk)}\n\n`
  }

  private createBaseChunk(id: string, created: number): any {
    return {
      id,
      object: 'chat.completion.chunk',
      created,
      model: this.model,
    }
  }

  private formatOpenAIToolCallChunk(
    id: string,
    created: number,
    toolCalls: ParsedToolCall[]
  ): string {
    const chunk: any = {
      id,
      object: 'chat.completion.chunk',
      created,
      model: this.model,
      choices: [
        {
          index: 0,
          delta: {
            tool_calls: toolCalls.map((tc, index) => ({
              index,
              id: tc.id,
              type: 'function',
              function: {
                name: tc.name,
                arguments: JSON.stringify(tc.arguments),
              },
            })),
          },
          finish_reason: null,
        },
      ],
    }
    return `data: ${JSON.stringify(chunk)}\n\n`
  }

  private formatOpenAIUsageChunk(id: string, created: number, usage: MimoUsage): string {
    const chunk: any = {
      id,
      object: 'chat.completion.chunk',
      created,
      model: this.model,
      choices: [
        {
          index: 0,
          delta: {},
          finish_reason: null,
        },
      ],
      usage: {
        prompt_tokens: usage.promptTokens,
        completion_tokens: usage.completionTokens,
        total_tokens: usage.totalTokens,
      },
    }
    return `data: ${JSON.stringify(chunk)}\n\n`
  }

  getConversationId(): string {
    return this.conversationId
  }

  getAssistantContentForTitle(): string {
    let content = this.content
    if (this.thinkingMode === 'strip') {
      content = stripThink(content)
    } else if (this.thinkingMode === 'separate') {
      content = extractThinkContent(content).content
    }
    return stripCitations(content)
  }

  getDialogId(): string {
    return this.dialogId
  }

  getUsage(): MimoUsage | null {
    return this.usage
  }
}

export const mimoAdapter = {
  MimoAdapter,
  MimoStreamHandler,
}
