/**
 * MiniMax Adapter
 * Based on MiniMax-Free-API implementation
 * https://github.com/LLM-Red-Team/MiniMax-Free-API
 */

import { PassThrough } from 'stream'
import http2, { ClientHttp2Session, ClientHttp2Stream } from 'http2'
import axios, { AxiosResponse } from 'axios'
import crypto from 'crypto'
import { createParser, EventSourceMessage } from 'eventsource-parser'
import FormData from 'form-data'
import { Account, Provider } from '../../store/types'
import { toolsToSystemPrompt, TOOL_WRAP_HINT, hasToolPromptInjected, shouldInjectToolPrompt } from '../utils/tools'
import { parseToolCallsFromText } from '../utils/toolParser'
import { 
  createToolCallState, 
  processStreamContent, 
  flushToolCallBuffer,
  createBaseChunk,
  ToolCallState 
} from '../utils/streamToolHandler'

const AGENT_BASE_URL = 'https://agent.minimaxi.com'

const FAKE_HEADERS = {
  Accept: 'application/json, text/plain, */*',
  'Accept-Encoding': 'gzip, deflate, br, zstd',
  'Accept-Language': 'zh-CN,zh;q=0.9',
  'Cache-Control': 'no-cache',
  Origin: 'https://agent.minimaxi.com',
  Pragma: 'no-cache',
  'Sec-Ch-Ua': '"Chromium";v="142", "Google Chrome";v="142", "Not_A Brand";v="99"',
  'Sec-Ch-Ua-Mobile': '?0',
  'Sec-Ch-Ua-Platform': '"macOS"',
  'Sec-Fetch-Dest': 'empty',
  'Sec-Fetch-Mode': 'cors',
  'Sec-Fetch-Site': 'same-origin',
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36',
}

const FAKE_USER_DATA: Record<string, any> = {
  device_platform: 'web',
  biz_id: '3',
  app_id: '3001',
  version_code: '22201',
  uuid: null,
  device_id: null,
  os_name: 'Mac',
  browser_name: 'chrome',
  device_memory: 8,
  cpu_core_num: 11,
  browser_language: 'zh-CN',
  browser_platform: 'MacIntel',
  user_id: null,
  screen_width: 1920,
  screen_height: 1080,
  unix: null,
  lang: 'zh',
  token: null,
  timezone_offset: 28800,
  sys_language: 'zh',
  client: 'web',
}

interface MiniMaxMessage {
  role: 'user' | 'assistant' | 'system' | 'tool'
  content: string | any[] | null
  tool_call_id?: string
  tool_calls?: any[]
}

interface ChatCompletionRequest {
  model: string
  messages: MiniMaxMessage[]
  stream?: boolean
  temperature?: number
  tools?: any[]
  tool_choice?: any
  chatId?: string
  isMultiTurn?: boolean
  sessionContext?: {
    sessionId: string
    providerSessionId?: string
    parentMessageId?: string
    messages: any[]
    isNew: boolean
  }
}

interface DeviceInfo {
  deviceId: string
  userId: string
  realUserID: string
  jwtToken: string
  refreshTime: number
  uuid: string // Device registration uuid
}

interface CreditInfo {
  totalCredits: number
  usedCredits: number
  remainingCredits: number
  expiresAt?: number // Credit reset timestamp (milliseconds)
}

interface ChatListItem {
  chat_id: number
  chat_name: string
  update_time: number
  create_time: number
}

const deviceInfoMap = new Map<string, DeviceInfo>()
const DEVICE_INFO_EXPIRES = 10800

function uuid(): string {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0
    const v = c === 'x' ? r : (r & 0x3) | 0x8
    return v.toString(16)
  })
}

function md5(input: string): string {
  return crypto.createHash('md5').update(input).digest('hex')
}

function unixTimestamp(): number {
  return Math.floor(Date.now() / 1000)
}

function tokenSplit(authorization: string): string[] {
  const token = authorization.replace('Bearer ', '')
  
  // Check if it's realUserID+JWTtoken format (contains +)
  if (token.includes('+')) {
    // Return the full token for parsing in constructor
    return [token]
  }
  
  // If no +, use the JWT token directly
  return [token]
}

/**
 * Parse JWT token to extract user ID
 * MiniMax JWT payload contains: { user: { id: string, name: string, ... } }
 */
function parseJWTUserID(jwtToken: string): string {
  try {
    // JWT format: header.payload.signature
    const parts = jwtToken.split('.')
    if (parts.length !== 3) {
      console.log('[MiniMax] Invalid JWT format, expected 3 parts, got:', parts.length)
      return ''
    }
    
    // Base64 decode the payload
    const payload = parts[1]
    // Add padding if needed
    const padding = 4 - (payload.length % 4)
    const paddedPayload = padding !== 4 ? payload + '='.repeat(padding) : payload
    
    const decoded = Buffer.from(paddedPayload, 'base64').toString('utf8')
    const payloadObj = JSON.parse(decoded)
    
    // MiniMax JWT contains user.id
    const userID = payloadObj?.user?.id || ''
    console.log('[MiniMax] Parsed userID from JWT:', userID)
    return userID
  } catch (error) {
    console.error('[MiniMax] Failed to parse JWT:', error)
    return ''
  }
}

function checkResult(result: AxiosResponse): any {
  if (!result.data) return null
  const { statusInfo, data } = result.data
  if (typeof statusInfo !== 'object') return result.data
  const { code, message } = statusInfo as any
  if (code === 0) return data
  throw new Error(`[请求hailuo失败]: ${message}`)
}

export class MiniMaxAdapter {
  private provider: Provider
  private account: Account
  private rawToken: string
  private jwtToken: string
  private realUserID: string
  private model: string
  private created: number

  constructor(provider: Provider, account: Account) {
    this.provider = provider
    this.account = account
    this.rawToken = account.credentials.token || ''
    this.model = 'MiniMax-M2.5'
    this.created = unixTimestamp()

    // Check if realUserID is provided separately in credentials
    const providedRealUserID = account.credentials.realUserID as string | undefined
    
    if (providedRealUserID && providedRealUserID.trim()) {
      // User provided realUserID separately, use it directly
      this.realUserID = providedRealUserID.trim()
      this.jwtToken = this.rawToken
      console.log('[MiniMax] Using provided realUserID:', this.realUserID)
    } else {
      // No separate realUserID, check if token is in realUserID+JWTtoken format
      const tokens = tokenSplit(this.rawToken)
      const fullToken = tokens[0]

      // Check if token is in realUserID+JWTtoken format
      if (fullToken.includes('+')) {
        const parts = fullToken.split('+')
        this.realUserID = parts[0]
        this.jwtToken = parts[1]
        console.log('[MiniMax] Token contains realUserID+JWT format, realUserID:', this.realUserID)
      } else {
        // Just JWT token, parse userID from it
        this.jwtToken = fullToken
        this.realUserID = parseJWTUserID(this.jwtToken)
        console.log('[MiniMax] Parsed realUserID from JWT:', this.realUserID)
      }
    }

    console.log('[MiniMax] Token parsed - realUserID:', this.realUserID, 'jwtToken:', this.jwtToken.substring(0, 30) + '...')
  }

  private async requestDeviceInfo(): Promise<DeviceInfo> {
    const cacheKey = this.rawToken
    let result = deviceInfoMap.get(cacheKey)
    
    if (result && result.refreshTime > unixTimestamp()) {
      return result
    }

    const randomUuid = uuid()
    const unix = `${Date.now()}`
    const timestamp = unixTimestamp()
    
    const userData = { ...FAKE_USER_DATA }
    userData.uuid = randomUuid
    userData.user_id = this.realUserID
    userData.unix = unix
    userData.token = this.jwtToken
    
    let queryStr = ''
    for (const key in userData) {
      if (userData[key] === undefined) continue
      queryStr += `&${key}=${userData[key]}`
    }
    queryStr = queryStr.substring(1)
    
    const dataJson = JSON.stringify({ uuid: randomUuid })
    const fullUri = `/v1/api/user/device/register?${queryStr}`
    const yy = md5(`${encodeURIComponent(fullUri)}_${dataJson}${md5(unix)}ooui`)
    const signature = md5(`${timestamp}${this.jwtToken}${dataJson}`)

    console.log('[MiniMax] Registering device - randomUuid:', randomUuid, 'realUserID:', this.realUserID)

    const response = await axios.post(
      `${AGENT_BASE_URL}${fullUri}`,
      { uuid: randomUuid },
      {
        headers: {
          ...FAKE_HEADERS,
          'Content-Type': 'application/json',
          'Referer': `${AGENT_BASE_URL}/`,
          'token': this.jwtToken,
          'x-timestamp': String(timestamp),
          'x-signature': signature,
          'yy': yy,
        },
        timeout: 15000,
        validateStatus: () => true,
      }
    )

    console.log('[MiniMax] Device register response:', response.status, JSON.stringify(response.data))

    if (response.status !== 200 || response.data?.statusInfo?.code !== 0) {
      throw new Error(`Failed to register device: ${response.data?.statusInfo?.message || response.status}`)
    }

    const data = checkResult(response)

    result = {
      deviceId: data?.deviceIDStr || '',
      userId: this.realUserID,
      realUserID: data?.realUserID || this.realUserID,
      jwtToken: this.jwtToken,
      refreshTime: unixTimestamp() + DEVICE_INFO_EXPIRES,
      uuid: randomUuid,
    }

    deviceInfoMap.set(cacheKey, result)
    console.log('[MiniMax] Device info cached:', { deviceId: result.deviceId, userId: result.userId, realUserID: result.realUserID, uuid: result.uuid })
    return result
  }

  private async request(
    method: string,
    uri: string,
    data: any,
    deviceInfo: DeviceInfo
  ): Promise<AxiosResponse> {
    const unix = `${Date.now()}`
    const timestamp = unixTimestamp()
    
    const userData = { ...FAKE_USER_DATA }
    const realUserID = deviceInfo.realUserID || deviceInfo.userId
    userData.uuid = realUserID
    userData.device_id = deviceInfo.deviceId || undefined
    userData.user_id = realUserID
    userData.unix = unix
    userData.token = this.jwtToken
    
    let queryStr = ''
    for (const key in userData) {
      if (userData[key] === undefined) continue
      queryStr += `&${key}=${userData[key]}`
    }
    queryStr = queryStr.substring(1)
    
    const dataJson = JSON.stringify(data || {})
    const fullUri = `${uri}${uri.lastIndexOf('?') != -1 ? '&' : '?'}${queryStr}`
    const yy = md5(`${encodeURIComponent(fullUri)}_${dataJson}${md5(unix)}ooui`)
    const signature = md5(`${timestamp}${this.jwtToken}${dataJson}`)

    console.log('[MiniMax] Request - uuid:', realUserID, 'user_id:', realUserID, 'device_id:', deviceInfo.deviceId)

    return await axios.request({
      method,
      url: `${AGENT_BASE_URL}${fullUri}`,
      data,
      timeout: 15000,
      validateStatus: () => true,
      headers: {
        Referer: `${AGENT_BASE_URL}/`,
        token: this.jwtToken,
        ...FAKE_HEADERS,
        'Content-Type': 'application/json',
        'x-timestamp': String(timestamp),
        'x-signature': signature,
        yy: yy,
      },
    })
  }

  private async requestStream(
    method: string,
    uri: string,
    requestBody: any,
    deviceInfo: DeviceInfo
  ): Promise<{ session: ClientHttp2Session; stream: ClientHttp2Stream }> {
    const unix = `${Date.now()}`
    const timestamp = unixTimestamp()

    const userData = { ...FAKE_USER_DATA }
    // Both uuid and user_id should use realUserID (matching reference implementation)
    const realUserID = deviceInfo.realUserID || deviceInfo.userId
    userData.uuid = realUserID
    userData.device_id = deviceInfo.deviceId || undefined
    userData.user_id = realUserID
    userData.unix = unix
    userData.token = this.jwtToken

    let queryStr = ''
    for (const key in userData) {
      if (userData[key] === undefined) continue
      queryStr += `&${key}=${userData[key]}`
    }
    queryStr = queryStr.substring(1)

    const dataJson = JSON.stringify(requestBody)
    const yy = md5(`${encodeURIComponent(`${uri}?${queryStr}`)}_${dataJson}${md5(unix)}ooui`)
    const signature = md5(`${timestamp}${this.jwtToken}${dataJson}`)

    console.log('[MiniMax] Stream Request - uuid:', realUserID, 'user_id:', realUserID, 'device_id:', deviceInfo.deviceId)
    console.log('[MiniMax] Request body:', dataJson)
    console.log('[MiniMax] Query string:', queryStr)
    console.log('[MiniMax] Headers - timestamp:', timestamp, 'signature:', signature.substring(0, 16) + '...', 'yy:', yy.substring(0, 16) + '...')

    const session = await new Promise<ClientHttp2Session>((resolve, reject) => {
      const session = http2.connect(AGENT_BASE_URL)
      session.on('connect', () => resolve(session))
      session.on('error', reject)
    })

    // Use lowercase headers to match reference implementation
    // Important: Accept header must be set after FAKE_HEADERS to override it
    // Order matters: FAKE_HEADERS -> x-timestamp -> x-signature -> Accept -> yy
    const headers: any = {
      ':method': method,
      ':path': `${uri}?${queryStr}`,
      ':scheme': 'https',
      'content-type': 'application/json',
      Referer: 'https://agent.minimaxi.com/',
      token: this.jwtToken,
      ...FAKE_HEADERS,
      'x-timestamp': `${timestamp}`,
      'x-signature': signature,
      Accept: 'text/event-stream', // Must be after FAKE_HEADERS to override
      yy: yy,
    }

    const stream = session.request(headers)
    stream.setTimeout(120000)
    stream.setEncoding('utf8')

    stream.on('response', (respHeaders) => {
      console.log('[MiniMax] HTTP/2 response headers:', JSON.stringify(respHeaders))
    })

    stream.on('data', (chunk) => {
      console.log('[MiniMax] HTTP/2 data chunk:', chunk.toString().substring(0, 200))
    })

    stream.on('error', (err) => {
      console.error('[MiniMax] HTTP/2 stream error:', err)
    })

    stream.on('close', () => {
      console.log('[MiniMax] HTTP/2 stream closed')
    })

    stream.end(Buffer.from(dataJson, 'utf8'))

    return { session, stream }
  }

  private messagesPrepare(messages: MiniMaxMessage[], toolsPrompt?: string, isMultiTurn: boolean = false): any {
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
        content += `user:${text}\n`
        
        // Include any tool results after the last user message
        for (let i = lastUserIdx + 1; i < otherMessages.length; i++) {
          if (otherMessages[i].role === 'user') {
            const toolText = typeof otherMessages[i].content === 'string' ? otherMessages[i].content : ''
            content += `user:${toolText}\n`
          }
        }
        
        if (toolsPrompt) {
          content = content.trim() + '\n\n' + toolsPrompt
        }
        return {
          msg_type: 1,
          text: content,
          chat_type: 1,
          attachments: [],
          selected_mcp_tools: [],
          backend_config: {},
          sub_agent_ids: [],
        }
      }
    }
    
    if (otherMessages.length < 2) {
      content += otherMessages.reduce((acc, msg) => {
        const text = typeof msg.content === 'string' ? msg.content : ''
        return acc + `${msg.role}:${text}\n`
      }, '')
    } else {
      const latestMessage = otherMessages[otherMessages.length - 1]
      const hasFileOrImage = Array.isArray(latestMessage.content) &&
        latestMessage.content.some((v: any) => typeof v === 'object' && ['file', 'image_url'].includes(v.type))
      
      if (hasFileOrImage) {
        const newFileMessage: MiniMaxMessage = {
          content: '关注用户最新发送文件和消息',
          role: 'system',
        }
        otherMessages.push(newFileMessage)
      }
      
      content += otherMessages.reduce((acc, msg) => {
        const text = typeof msg.content === 'string' ? msg.content : ''
        return acc + `${msg.role}:${text}\n`
      }, '') + 'assistant:\n'
      
      content = content.trim().replace(/\!\[.+\]\(.+\)/g, '')
    }

    // Append tools prompt at the end if provided
    if (toolsPrompt) {
      content = content.trim() + '\n\n' + toolsPrompt
    }

    return {
      msg_type: 1,
      text: content,
      chat_type: 1,
      attachments: [],
      selected_mcp_tools: [],
      backend_config: {},
      sub_agent_ids: [],
    }
  }

  async chatCompletion(request: ChatCompletionRequest): Promise<{ response: AxiosResponse | null; stream: { session: ClientHttp2Session; stream: ClientHttp2Stream } | null; chatId: string }> {
    console.log('[MiniMax] chatCompletion called with model:', request.model, 'stream:', request.stream)
    
    this.model = request.model || 'MiniMax-M2.5'
    this.created = unixTimestamp()
    
    const deviceInfo = await this.requestDeviceInfo()
    
    // Use session context passed from forwarder
    const sessionContext = request.sessionContext
    const isMultiTurn = sessionContext && !sessionContext.isNew
    
    // Use providerSessionId (existing chat_id) if available
    let chatId: string = sessionContext?.providerSessionId || ''
    
    console.log('[MiniMax] Session info:', {
      isMultiTurn,
      chatId: chatId || '(new)',
    })
    
    // In multi-turn mode, only send the last user message
    // MiniMax will use the chat_id to maintain conversation context
    const messages = isMultiTurn && chatId 
      ? [request.messages[request.messages.length - 1]] 
      : [...request.messages]
    
    let toolsPrompt = ''
    // Only inject if tools are provided and not already injected by client
    if (request.tools && request.tools.length > 0 && !hasToolPromptInjected(request.messages)) {
      toolsPrompt = toolsToSystemPrompt(request.tools)
      
      // Find and update the last user message
      for (let i = messages.length - 1; i >= 0; i--) {
        if (messages[i].role === 'user') {
          const currentContent = messages[i].content
          if (typeof currentContent === 'string') {
            messages[i] = { ...messages[i], content: currentContent + TOOL_WRAP_HINT }
          }
          break
        }
      }
    }
    
    const requestBody = this.messagesPrepare(messages, toolsPrompt, isMultiTurn)
    
    let msgId: string = ''
    
    if (chatId) {
      console.log('[MiniMax] Using existing chat:', chatId)
      const sendResponse = await this.request('POST', '/matrix/api/v1/chat/send_msg', {
        ...requestBody,
        chat_id: chatId,
      }, deviceInfo)
      
      if (sendResponse.status !== 200) {
        throw new Error(`MiniMax API error: HTTP ${sendResponse.status}`)
      }
      
      const { msg_id, base_resp } = sendResponse.data
      if (base_resp?.status_code !== 0) {
        throw new Error(`Send message failed: ${base_resp?.status_msg || 'Unknown error'}`)
      }
      msgId = msg_id
    } else {
      const sendResponse = await this.request('POST', '/matrix/api/v1/chat/send_msg', requestBody, deviceInfo)
      
      console.log('[MiniMax] Send response status:', sendResponse.status)
      
      if (sendResponse.status !== 200) {
        console.error('[MiniMax] Error response:', JSON.stringify(sendResponse.data))
        throw new Error(`MiniMax API error: HTTP ${sendResponse.status} - ${JSON.stringify(sendResponse.data)}`)
      }
      
      const result = sendResponse.data
      const base_resp = result.base_resp
      
      if (base_resp?.status_code !== 0) {
        throw new Error(`Send message failed: ${base_resp?.status_msg || 'Unknown error'}`)
      }
      
      chatId = result.chat_id
      msgId = result.msg_id
      console.log('[MiniMax] Message sent, chat_id:', chatId, 'msg_id:', msgId)
    }
    
    if (request.stream === true) {
      // Only delete chat in single-turn mode with deleteAfterChat enabled
      // Import shouldDeleteSession from forwarder
      const shouldDeleteSession = () => {
        const config = (global as any).storeManager?.getConfig()
        return config?.mode === 'single' && config?.deleteAfterTimeout
      }
      
      const onEnd = shouldDeleteSession() ? async (chatId: string) => {
        await this.deleteChat(chatId)
      } : undefined
      
      const transStream = this.createPollingStream(chatId, deviceInfo, this.model, onEnd)
      return { 
        response: null, 
        stream: { session: null as any, stream: transStream as any }, 
        chatId 
      }
    }
    
    const aiMessage = await this.pollForResponse(chatId, deviceInfo)
    
    // Delete chat after response if in single-turn mode with deleteAfterChat enabled
    const shouldDeleteSession = () => {
      const config = (global as any).storeManager?.getConfig()
      return config?.mode === 'single' && config?.deleteAfterTimeout
    }
    
    if (shouldDeleteSession()) {
      await this.deleteChat(chatId).catch(err => console.error('[MiniMax] Failed to delete chat:', err))
    }
    
    const content = aiMessage?.msg_content || ''
    const thinkingContent = aiMessage?.extra_info?.thinking_content || ''
    const { content: cleanContent, toolCalls } = parseToolCallsFromText(content, 'minimax')
    
    const response = {
      status: 200,
      statusText: 'OK',
      headers: {},
      config: {} as any,
      data: {
        id: String(chatId),
        model: this.model,
        object: 'chat.completion',
        choices: [{
          index: 0,
          message: {
            role: 'assistant',
            content: toolCalls.length > 0 ? null : cleanContent,
            ...(thinkingContent ? { reasoning_content: thinkingContent } : {}),
            ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {})
          },
          finish_reason: toolCalls.length > 0 ? 'tool_calls' : 'stop',
        }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        created: this.created,
      },
    }
    
    return { response, stream: null, chatId }
  }

  private async pollForResponse(chatId: string, deviceInfo: DeviceInfo, maxPolls = 120, pollInterval = 1000): Promise<any> {
    let pollCount = 0
    
    while (pollCount < maxPolls) {
      await new Promise(resolve => setTimeout(resolve, pollInterval))
      pollCount++
      
      const detailResponse = await this.request('POST', '/matrix/api/v1/chat/get_chat_detail', { chat_id: chatId }, deviceInfo)
      
      if (detailResponse.status !== 200) {
        console.log('[MiniMax] Poll failed, status:', detailResponse.status)
        continue
      }
      
      const { messages, base_resp } = detailResponse.data
      
      if (base_resp?.status_code !== 0) {
        console.log('[MiniMax] Poll failed, status_code:', base_resp?.status_code)
        continue
      }
      
      // Find AI response (msg_type === 2)
      const aiMessage = messages?.find((msg: any) => msg.msg_type === 2)
      
      if (aiMessage && aiMessage.msg_content) {
        console.log('[MiniMax] AI response received after', pollCount, 'polls')
        return aiMessage
      }
    }
    
    throw new Error(`No AI response after ${maxPolls} polls`)
  }

  private createPollingStream(chatId: string, deviceInfo: DeviceInfo, model: string, onEnd?: (chatId: string) => Promise<void>): PassThrough {
    const transStream = new PassThrough()
    const created = this.created
    let lastContent = ''
    let lastThinkingContent = ''
    let pollCount = 0
    const maxPolls = 60
    const pollInterval = 500
    const toolCallState = createToolCallState()
    let sentRole = false
    let sentThinkingRole = false
    
    const poll = async () => {
      try {
        while (pollCount < maxPolls) {
          await new Promise(resolve => setTimeout(resolve, pollInterval))
          pollCount++
          
          const detailResponse = await this.request('POST', '/matrix/api/v1/chat/get_chat_detail', { chat_id: chatId }, deviceInfo)
          
          if (detailResponse.status !== 200) {
            console.log('[MiniMax] Poll status:', detailResponse.status)
            continue
          }
          
          const { messages, base_resp } = detailResponse.data
          if (base_resp?.status_code !== 0) {
            console.log('[MiniMax] Poll base_resp:', base_resp)
            continue
          }
          
          if (pollCount <= 3 || pollCount % 10 === 0) {
            console.log('[MiniMax] Poll messages count:', messages?.length, 'first msg_type:', messages?.[0]?.msg_type)
            if (messages && messages.length > 0) {
              console.log('[MiniMax] All message types:', messages.map((m: any) => ({ msg_type: m.msg_type, has_content: !!m.msg_content, content_preview: m.msg_content?.substring?.(0, 50) })))
            }
          }
          
          const aiMessage = messages?.find((msg: any) => msg.msg_type === 2)
          
          if (aiMessage && aiMessage.msg_content) {
            const currentContent = aiMessage.msg_content
            const currentThinkingContent = aiMessage?.extra_info?.thinking_content || ''
            
            // Handle thinking content
            if (currentThinkingContent && currentThinkingContent.length > lastThinkingContent.length) {
              const newThinkingChunk = currentThinkingContent.substring(lastThinkingContent.length)
              
              if (newThinkingChunk.trim()) {
                // Send role for thinking content first
                if (!sentThinkingRole) {
                  transStream.write(`data: ${JSON.stringify({
                    id: chatId.toString(),
                    model,
                    object: 'chat.completion.chunk',
                    choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }],
                    created,
                  })}\n\n`)
                  sentThinkingRole = true
                }
                
                // Send thinking content as reasoning_content
                transStream.write(`data: ${JSON.stringify({
                  id: chatId.toString(),
                  model,
                  object: 'chat.completion.chunk',
                  choices: [{ index: 0, delta: { reasoning_content: newThinkingChunk }, finish_reason: null }],
                  created,
                })}\n\n`)
              }
              
              lastThinkingContent = currentThinkingContent
            }
            
            if (currentContent.length > lastContent.length) {
              const newChunk = currentContent.substring(lastContent.length)
              
              // Process tool call interception
              const baseChunk = createBaseChunk(chatId.toString(), model, created)
              const { chunks: outputChunks } = processStreamContent(
                newChunk, 
                toolCallState, 
                baseChunk, 
                !sentRole,
                'minimax'
              )

              for (const outChunk of outputChunks) {
                transStream.write(`data: ${JSON.stringify(outChunk)}\n\n`)
              }

              if (outputChunks.length > 0) sentRole = true
              
              lastContent = currentContent
            }
            
            if (pollCount > 5 && currentContent === lastContent && lastContent.length > 0) {
              console.log('[MiniMax] Stream completed after', pollCount, 'polls, content length:', lastContent.length)
              
              // Flush any remaining tool calls
              const baseChunk = createBaseChunk(chatId.toString(), model, created)
              const flushChunks = flushToolCallBuffer(toolCallState, baseChunk, 'minimax')
              
              for (const outChunk of flushChunks) {
                transStream.write(`data: ${JSON.stringify(outChunk)}\n\n`)
              }
              
              const finishReason = toolCallState.hasEmittedToolCall ? 'tool_calls' : 'stop'
              
              transStream.write(
                `data: ${JSON.stringify({
                  id: chatId.toString(),
                  model,
                  object: 'chat.completion.chunk',
                  choices: [{ index: 0, delta: {}, finish_reason: finishReason }],
                  created,
                })}\n\n`
              )
              transStream.end('data: [DONE]\n\n')
              if (onEnd) {
                onEnd(chatId).catch(err => console.error('[MiniMax] Failed to delete chat:', err))
              }
              return
            }
          }
        }
        
        console.log('[MiniMax] Stream timeout after', maxPolls, 'polls')
        transStream.end('data: [DONE]\n\n')
      } catch (err) {
        console.error('[MiniMax] Polling error:', err)
        transStream.end('data: [DONE]\n\n')
      }
    }
    
    poll()
    
    return transStream
  }

  async deleteChat(chatId: string): Promise<boolean> {
    const maxRetries = 3
    const retryDelay = 2000
    
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        const deviceInfo = await this.requestDeviceInfo()
        const response = await this.request('POST', '/matrix/api/v1/chat/delete_chat', { chat_id: parseInt(chatId, 10) }, deviceInfo)
        console.log('[MiniMax] Chat deleted attempt', attempt, ':', chatId, 'Status:', response.status, 'Response:', JSON.stringify(response.data))
        
        if (response.status === 200 && response.data?.base_resp?.status_code === 0) {
          return true
        }
        
        const errorMsg = response.data?.base_resp?.status_msg || 'Unknown error'
        
        if (errorMsg.includes('chat is running') && attempt < maxRetries) {
          console.log(`[MiniMax] Chat still running, waiting ${retryDelay}ms before retry...`)
          await new Promise(resolve => setTimeout(resolve, retryDelay))
          continue
        }
        
        console.warn('[MiniMax] Delete chat failed:', errorMsg)
        return false
      } catch (error) {
        console.error('[MiniMax] Failed to delete chat:', error)
        if (attempt < maxRetries) {
          await new Promise(resolve => setTimeout(resolve, retryDelay))
          continue
        }
        return false
      }
    }
    
    return false
  }

  async getUserInfo(): Promise<any> {
    const deviceInfo = await this.requestDeviceInfo()
    const response = await this.request('GET', '/v1/api/user/info', {}, deviceInfo)
    if (response.status !== 200 || response.data?.statusInfo?.code !== 0) {
      throw new Error(`Failed to get user info: ${response.data?.statusInfo?.message || response.status}`)
    }
    return response.data.data
  }

  async getCredits(): Promise<CreditInfo> {
    try {
      const deviceInfo = await this.requestDeviceInfo()
      
      const response = await this.request('POST', '/matrix/api/v1/commerce/get_membership_info', {}, deviceInfo)
      
      console.log('[MiniMax] get_membership_info status:', response.status)
      
      if (response.status === 200 && response.data?.base_resp?.status_code === 0) {
        const data = response.data
        const remainingCredits = data?.daily_login_gift_credit_remaining || 0
        
        // Get credit expires timestamp (resets at next day 00:00)
        let expiresAt: number | undefined = undefined
        const creditsData = data?.credits?.['4']?.[0]
        if (creditsData?.expires_at) {
          // expires_at is in milliseconds, use it directly
          expiresAt = creditsData.expires_at
        }
        
        if (expiresAt) {
          console.log('[MiniMax] Credit expires at:', new Date(expiresAt).toISOString())
        }
        console.log('[MiniMax] Credits:', { remainingCredits, expiresAt: expiresAt ? new Date(expiresAt).toISOString() : undefined })
        
        return {
          totalCredits: 0, // Not available
          usedCredits: 0, // Not available
          remainingCredits,
          expiresAt,
        }
      }
      
      console.warn('[MiniMax] Failed to get membership info, token may be expired or invalid')
      return { totalCredits: 0, usedCredits: 0, remainingCredits: 0 }
    } catch (error) {
      console.error('[MiniMax] Failed to get credits:', error instanceof Error ? error.message : 'Unknown error')
      return { totalCredits: 0, usedCredits: 0, remainingCredits: 0 }
    }
  }

  async getChatList(): Promise<ChatListItem[]> {
    const allChats: ChatListItem[] = []
    let nextPageIndexId: number | undefined = undefined
    const pageSize = 100
    
    try {
      const deviceInfo = await this.requestDeviceInfo()
      
      while (true) {
        const requestBody: any = {
          page_size: pageSize,
          workspace_storage_mode: 0,
        }
        
        if (nextPageIndexId !== undefined) {
          requestBody.next_page_index_id = nextPageIndexId
        }
        
        const response = await this.request('POST', '/matrix/api/v1/chat/list_chat', requestBody, deviceInfo)
        
        console.log('[MiniMax] list_chat response status:', response.status)
        
        if (response.status !== 200 || response.data?.base_resp?.status_code !== 0) {
          console.error('[MiniMax] Failed to get chat list:', response.data?.base_resp?.status_msg)
          break
        }
        
        const chatList = response.data?.chats || response.data?.chat_list || []
        console.log('[MiniMax] Received chats count:', chatList.length)
        if (chatList.length === 0) {
          break
        }
        
        allChats.push(...chatList)
        
        if (chatList.length < pageSize) {
          break
        }
        
        nextPageIndexId = chatList[chatList.length - 1]?.chat_id
      }
      
      console.log('[MiniMax] Got chat list, total:', allChats.length)
      return allChats
    } catch (error) {
      console.error('[MiniMax] Failed to get chat list:', error)
      return []
    }
  }

  async deleteAllChats(): Promise<boolean> {
    try {
      console.log('[MiniMax] Starting to delete all chats...')
      
      const chatList = await this.getChatList()
      if (chatList.length === 0) {
        console.log('[MiniMax] No chats to delete')
        return true
      }
      
      console.log('[MiniMax] Found', chatList.length, 'chats to delete')
      
      let successCount = 0
      let failCount = 0
      
      for (const chat of chatList) {
        const result = await this.deleteChat(String(chat.chat_id))
        if (result) {
          successCount++
        } else {
          failCount++
        }
        
        if (successCount % 10 === 0) {
          console.log(`[MiniMax] Deleted ${successCount}/${chatList.length} chats...`)
        }
      }
      
      console.log(`[MiniMax] Delete all chats completed. Success: ${successCount}, Failed: ${failCount}`)
      return failCount === 0
    } catch (error) {
      console.error('[MiniMax] Failed to delete all chats:', error)
      return false
    }
  }

  static isMiniMaxProvider(provider: Provider): boolean {
    return provider.id === 'minimax' || 
           provider.apiEndpoint.includes('minimaxi.com') ||
           provider.apiEndpoint.includes('hailuoai.com')
  }
}

export class MiniMaxStreamHandler {
  private chatId: string = ''
  private model: string
  private created: number
  private onEnd?: (chatId: string) => void
  private toolCallState: ToolCallState
  private sentRole: boolean = false

  constructor(model: string, onEnd?: (chatId: string) => void) {
    this.model = model
    this.created = Math.floor(Date.now() / 1000)
    this.onEnd = onEnd
    this.toolCallState = createToolCallState()
  }

  setChatId(chatId: string) {
    this.chatId = chatId
  }

  getChatId(): string {
    return this.chatId
  }

  handleStream(stream: ClientHttp2Stream): PassThrough {
    const transStream = new PassThrough()
    let content = ''
    let hasReceivedData = false
    let httpStatus: number | null = null
    let buffer = ''

    console.log('[MiniMax] Starting stream handler...')

    // Listen for HTTP/2 response headers to check status code
    stream.once('response', (headers: http2.IncomingHttpHeaders) => {
      const statusValue = headers[':status']
      httpStatus = 200
      if (typeof statusValue === 'string') {
        httpStatus = parseInt(statusValue, 10)
      } else if (typeof statusValue === 'number') {
        httpStatus = statusValue
      }

      console.log('[MiniMax] HTTP/2 response status:', httpStatus)

      // If status is not 200, emit error and close stream
      if (httpStatus >= 400) {
        const errorMessage = `MiniMax API error: HTTP ${httpStatus}`
        console.error('[MiniMax]', errorMessage)

        // Emit error event on the transform stream for the client to handle
        transStream.emit('error', new Error(errorMessage))
        transStream.end()
        return
      }
    })

    // Use SSE parser for event stream format
    const parser = createParser({
      onEvent: (event: EventSourceMessage) => {
        try {
          hasReceivedData = true
          const eventName = event.event
          if (event.data === '[DONE]') return

          console.log('[MiniMax] SSE event:', eventName, 'data:', event.data?.substring(0, 100))

          const result = JSON.parse(event.data)
          const { type, base_resp, statusInfo, data: _data } = result

          if (type === 8) {
            // Flush any remaining tool calls
            const baseChunk = createBaseChunk(this.chatId, this.model, this.created)
            const flushChunks = flushToolCallBuffer(this.toolCallState, baseChunk, 'minimax')
            
            for (const outChunk of flushChunks) {
              transStream.write(`data: ${JSON.stringify(outChunk)}\n\n`)
            }
            
            const finishReason = this.toolCallState.hasEmittedToolCall ? 'tool_calls' : 'stop'
            transStream.write(
              `data: ${JSON.stringify({
                id: this.chatId,
                model: this.model,
                object: 'chat.completion.chunk',
                choices: [{ index: 0, delta: {}, finish_reason: finishReason }],
                created: this.created,
              })}\n\n`
            )
            transStream.end('data: [DONE]\n\n')
            if (this.onEnd) this.onEnd(this.chatId)
            return
          }

          const respCode = base_resp?.status_code ?? statusInfo?.code
          const respMessage = base_resp?.status_msg ?? statusInfo?.message
          if (respCode !== 0 && respCode !== undefined && type !== 3) {
            throw new Error(`Stream response error: ${respMessage}`)
          }

          const { messageResult } = _data || {}
          if (eventName === 'message_result' && messageResult) {
            const { chatID, chat_id, isEnd, content: text } = messageResult
            const finalChatId = chat_id || chatID

            if (isEnd !== 0 && !text) return

            if (!this.chatId && finalChatId) this.chatId = finalChatId

            const exceptCharIndex = text.indexOf('')
            const chunk = text.substring(
              exceptCharIndex !== -1
                ? Math.min(content.length, exceptCharIndex)
                : content.length,
              exceptCharIndex === -1 ? text.length : exceptCharIndex
            )
            content += chunk

            console.log('[MiniMax] Stream chunk:', chunk.substring(0, 50), 'isEnd:', isEnd)

            // Process tool call interception
            const baseChunk = createBaseChunk(this.chatId, this.model, this.created)
            const { chunks: outputChunks } = processStreamContent(
              chunk, 
              this.toolCallState, 
              baseChunk, 
              !this.sentRole,
              'minimax'
            )

            for (const outChunk of outputChunks) {
              transStream.write(`data: ${JSON.stringify(outChunk)}\n\n`)
            }

            if (outputChunks.length > 0) this.sentRole = true

            if (isEnd === 0) {
              // Flush any remaining tool calls
              const flushChunks = flushToolCallBuffer(this.toolCallState, baseChunk, 'minimax')
              
              for (const outChunk of flushChunks) {
                transStream.write(`data: ${JSON.stringify(outChunk)}\n\n`)
              }
              
              const finishReason = this.toolCallState.hasEmittedToolCall ? 'tool_calls' : 'stop'
              transStream.write(
                `data: ${JSON.stringify({
                  id: this.chatId,
                  model: this.model,
                  object: 'chat.completion.chunk',
                  choices: [{ index: 0, delta: {}, finish_reason: finishReason }],
                  created: this.created,
                })}\n\n`
              )
              transStream.end('data: [DONE]\n\n')
              if (this.onEnd) this.onEnd(this.chatId)
            }
          }
        } catch (err) {
          console.error('[MiniMax] Stream parse error:', err)
          transStream.emit('error', err instanceof Error ? err : new Error(String(err)))
          transStream.end()
        }
      }
    })

    stream.on('data', (chunk: Buffer) => {
      hasReceivedData = true
      const chunkStr = chunk.toString()
      console.log('[MiniMax] Raw chunk:', chunkStr.substring(0, 200))

      // Try to parse as SSE first
      if (chunkStr.includes('event:') || chunkStr.includes('data:')) {
        parser.feed(chunkStr)
      } else {
        // Try to parse as direct JSON (non-SSE format)
        buffer += chunkStr
        const lines = buffer.split('\n')
        buffer = lines.pop() || '' // Keep incomplete line in buffer

        for (const line of lines) {
          if (!line.trim()) continue
          try {
            const result = JSON.parse(line)
            console.log('[MiniMax] Parsed JSON:', result)

            const { type, base_resp, statusInfo, data: _data, chat_id, msg_id } = result

            // Handle initial response with chat_id
            if (chat_id && !this.chatId) {
              this.chatId = chat_id
              console.log('[MiniMax] Set chatId:', this.chatId)
              continue
            }

            // Handle type 8 (end of stream)
            if (type === 8) {
              transStream.write(
                `data: ${JSON.stringify({
                  id: this.chatId,
                  model: this.model,
                  object: 'chat.completion.chunk',
                  choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
                  created: this.created,
                })}\n\n`
              )
              transStream.end('data: [DONE]\n\n')
              if (this.onEnd) this.onEnd(this.chatId)
              return
            }

            // Check for errors
            const respCode = base_resp?.status_code ?? statusInfo?.code
            const respMessage = base_resp?.status_msg ?? statusInfo?.message
            if (respCode !== 0 && respCode !== undefined && type !== 3) {
              console.error('[MiniMax] Stream response error:', respMessage)
              continue
            }

            // Handle message result
            const { messageResult } = _data || {}
            if (messageResult) {
              const { chatID, chat_id: agentChatId, isEnd, content: text } = messageResult
              const finalChatId = agentChatId || chatID

              if (isEnd !== 0 && !text) continue

              if (!this.chatId && finalChatId) this.chatId = finalChatId

              const exceptCharIndex = text.indexOf('')
              const chunk = text.substring(
                exceptCharIndex !== -1
                  ? Math.min(content.length, exceptCharIndex)
                  : content.length,
                exceptCharIndex === -1 ? text.length : exceptCharIndex
              )
              content += chunk

              console.log('[MiniMax] Stream chunk:', chunk.substring(0, 50), 'isEnd:', isEnd)

              transStream.write(
                `data: ${JSON.stringify({
                  id: this.chatId,
                  model: this.model,
                  object: 'chat.completion.chunk',
                  choices: [{ index: 0, delta: { content: chunk }, finish_reason: isEnd === 0 ? 'stop' : null }],
                  created: this.created,
                })}\n\n`
              )

              if (isEnd === 0) {
                transStream.end('data: [DONE]\n\n')
                if (this.onEnd) this.onEnd(this.chatId)
              }
            }
          } catch (err) {
            // Not valid JSON, might be SSE format
            parser.feed(line + '\n')
          }
        }
      }
    })

    stream.once('error', (err: Error) => {
      console.error('[MiniMax] Stream error:', err)
      transStream.emit('error', err)
      transStream.end()
    })

    stream.once('close', () => {
      console.log('[MiniMax] Stream closed, hasReceivedData:', hasReceivedData, 'httpStatus:', httpStatus)
      // Process any remaining data in buffer
      if (buffer.trim()) {
        try {
          const result = JSON.parse(buffer.trim())
          console.log('[MiniMax] Processing remaining buffer:', result)
        } catch (e) {
          parser.feed(buffer)
        }
      }
      // Only end gracefully if we received data successfully
      if (hasReceivedData || (httpStatus && httpStatus < 400)) {
        transStream.end('data: [DONE]\n\n')
      }
    })

    return transStream
  }

  async handleNonStream(stream: any): Promise<any> {
    // Parameter 'stream' is response.data from forwarder.ts (the actual stream/data)
    return new Promise((resolve, reject) => {
      const data = {
        id: '',
        model: this.model,
        object: 'chat.completion',
        choices: [{ 
          index: 0, 
          message: { 
            role: 'assistant', 
            content: '', 
            reasoning_content: '' 
          }, 
          finish_reason: 'stop' 
        }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        created: this.created,
      }

      const parser = createParser({
        onEvent: (event: EventSourceMessage) => {
          try {
            if (event.data === '[DONE]') return
            const result = JSON.parse(event.data)
            const { type, base_resp, statusInfo, data: _data } = result
            const respCode = base_resp?.status_code ?? statusInfo?.code
            const respMessage = base_resp?.status_msg ?? statusInfo?.message
            if (respCode !== 0 && respCode !== undefined && type !== 3) {
              throw new Error(`Stream response error: ${respMessage}`)
            }
            const { messageResult } = _data || {}
            if (event.event === 'message_result' && messageResult) {
              const { chatID, chat_id, isEnd, content: text, extra_info } = messageResult
              const finalChatId = chat_id || chatID
              if (!data.id && finalChatId) data.id = finalChatId
              if (isEnd !== 0 && text) data.choices[0].message.content += text
              // Extract thinking_content from extra_info
              if (extra_info?.thinking_content) {
                data.choices[0].message.reasoning_content = extra_info.thinking_content
              }
              if (isEnd === 0) resolve(data)
            }
          } catch (err) {
            reject(err)
          }
        },
      })

      stream.on('data', (buffer: Buffer) => parser.feed(buffer.toString()))
      stream.once('error', reject)
      stream.once('close', () => resolve(data))
    })
  }
}

export const minimaxAdapter = {
  MiniMaxAdapter,
  MiniMaxStreamHandler,
}
