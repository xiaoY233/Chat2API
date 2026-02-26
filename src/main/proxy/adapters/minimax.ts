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
}

interface MiniMaxMessage {
  role: 'user' | 'assistant' | 'system'
  content: string | any[]
}

interface ChatCompletionRequest {
  model: string
  messages: MiniMaxMessage[]
  stream?: boolean
  temperature?: number
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

  private messagesPrepare(messages: MiniMaxMessage[]): any {
    let content = ''
    
    if (messages.length < 2) {
      content = messages.reduce((acc, msg) => {
        const text = typeof msg.content === 'string' ? msg.content : ''
        return acc + `${text}\n`
      }, '')
    } else {
      const latestMessage = messages[messages.length - 1]
      const hasFileOrImage = Array.isArray(latestMessage.content) &&
        latestMessage.content.some((v: any) => typeof v === 'object' && ['file', 'image_url'].includes(v.type))
      
      if (hasFileOrImage) {
        const newFileMessage: MiniMaxMessage = {
          content: '关注用户最新发送文件和消息',
          role: 'system',
        }
        messages = [...messages.slice(0, -1), newFileMessage, messages[messages.length - 1]]
      }
      
      content = messages.reduce((acc, msg) => {
        const text = typeof msg.content === 'string' ? msg.content : ''
        return acc + `${msg.role}:${text}\n`
      }, '') + 'assistant:\n'
      
      content = content.trim().replace(/\!\[.+\]\(.+\)/g, '')
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
    
    // Update model from request
    this.model = request.model || 'MiniMax-M2.5'
    this.created = unixTimestamp()
    
    const deviceInfo = await this.requestDeviceInfo()
    const requestBody = this.messagesPrepare(request.messages)
    
    // Step 1: Send message
    const sendResponse = await this.request('POST', '/matrix/api/v1/chat/send_msg', requestBody, deviceInfo)
    
    console.log('[MiniMax] Send response status:', sendResponse.status)
    
    if (sendResponse.status !== 200) {
      console.error('[MiniMax] Error response:', JSON.stringify(sendResponse.data))
      throw new Error(`MiniMax API error: HTTP ${sendResponse.status} - ${JSON.stringify(sendResponse.data)}`)
    }
    
    const { chat_id, msg_id, base_resp } = sendResponse.data
    
    if (base_resp?.status_code !== 0) {
      throw new Error(`Send message failed: ${base_resp?.status_msg || 'Unknown error'}`)
    }
    
    console.log('[MiniMax] Message sent, chat_id:', chat_id, 'msg_id:', msg_id)
    
    // For streaming, use polling mechanism to simulate stream
    if (request.stream !== false) {
      const transStream = this.createPollingStream(chat_id, deviceInfo, this.model)
      // Return a mock stream object for compatibility
      return { 
        response: null, 
        stream: { session: null as any, stream: transStream as any }, 
        chatId: chat_id 
      }
    }
    
    // For non-streaming, poll until complete
    const aiMessage = await this.pollForResponse(chat_id, deviceInfo)
    
    // Construct OpenAI-compatible response
    const response = {
      status: 200,
      statusText: 'OK',
      headers: {},
      config: {} as any,
      data: {
        id: chat_id.toString(),
        model: this.model,
        object: 'chat.completion',
        choices: [{
          index: 0,
          message: {
            role: 'assistant',
            content: aiMessage?.msg_content || '',
          },
          finish_reason: 'stop',
        }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        created: this.created,
      },
    }
    
    return { response, stream: null, chatId: chat_id }
  }

  private async pollForResponse(chatId: string, deviceInfo: DeviceInfo, maxPolls = 60, pollInterval = 1000): Promise<any> {
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

  private createPollingStream(chatId: string, deviceInfo: DeviceInfo, model: string): PassThrough {
    const transStream = new PassThrough()
    const created = this.created
    let lastContent = ''
    let pollCount = 0
    const maxPolls = 60
    const pollInterval = 500
    
    // Send initial chunk
    transStream.write(
      `data: ${JSON.stringify({
        id: '',
        model,
        object: 'chat.completion.chunk',
        choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }],
        created,
      })}\n\n`
    )
    
    // Start polling
    const poll = async () => {
      try {
        while (pollCount < maxPolls) {
          await new Promise(resolve => setTimeout(resolve, pollInterval))
          pollCount++
          
          const detailResponse = await this.request('POST', '/matrix/api/v1/chat/get_chat_detail', { chat_id: chatId }, deviceInfo)
          
          if (detailResponse.status !== 200) continue
          
          const { messages, base_resp } = detailResponse.data
          if (base_resp?.status_code !== 0) continue
          
          const aiMessage = messages?.find((msg: any) => msg.msg_type === 2)
          
          if (aiMessage && aiMessage.msg_content) {
            const currentContent = aiMessage.msg_content
            
            // Send new content
            if (currentContent.length > lastContent.length) {
              const newChunk = currentContent.substring(lastContent.length)
              transStream.write(
                `data: ${JSON.stringify({
                  id: chatId.toString(),
                  model,
                  object: 'chat.completion.chunk',
                  choices: [{ index: 0, delta: { content: newChunk }, finish_reason: null }],
                  created,
                })}\n\n`
              )
              lastContent = currentContent
            }
            
            // Check if complete (content stopped growing)
            if (pollCount > 5 && currentContent === lastContent && lastContent.length > 0) {
              console.log('[MiniMax] Stream completed after', pollCount, 'polls')
              
              // Send finish chunk
              transStream.write(
                `data: ${JSON.stringify({
                  id: chatId.toString(),
                  model,
                  object: 'chat.completion.chunk',
                  choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
                  created,
                })}\n\n`
              )
              transStream.end('data: [DONE]\n\n')
              return
            }
          }
        }
        
        // Timeout
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
    try {
      const deviceInfo = await this.requestDeviceInfo()
      const response = await this.request('DELETE', `/v1/api/chat/history/${chatId}`, {}, deviceInfo)
      console.log('[MiniMax] Chat deleted:', chatId, 'Status:', response.status)
      return response.status === 200 || response.status === 204
    } catch (error) {
      console.error('[MiniMax] Failed to delete chat:', error)
      return false
    }
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
      const response = await this.request('GET', '/v1/api/user/credit', {}, deviceInfo)
      if (response.status === 200 && response.data?.statusInfo?.code === 0) {
        const data = response.data.data
        return {
          totalCredits: data?.totalCredit || 0,
          usedCredits: data?.usedCredit || 0,
          remainingCredits: data?.remainCredit || 0,
        }
      }
      const userInfo = await this.getUserInfo()
      return {
        totalCredits: userInfo?.creditInfo?.totalCredit || 0,
        usedCredits: userInfo?.creditInfo?.usedCredit || 0,
        remainingCredits: userInfo?.creditInfo?.remainCredit || 0,
      }
    } catch (error) {
      console.error('[MiniMax] Failed to get credits:', error)
      return { totalCredits: 0, usedCredits: 0, remainingCredits: 0 }
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

  constructor(model: string, onEnd?: (chatId: string) => void) {
    this.model = model
    this.created = Math.floor(Date.now() / 1000)
    this.onEnd = onEnd
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

    transStream.write(
      `data: ${JSON.stringify({
        id: '',
        model: this.model,
        object: 'chat.completion.chunk',
        choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }],
        created: this.created,
      })}\n\n`
    )

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

  async handleNonStream(response: any): Promise<any> {
    return new Promise((resolve, reject) => {
      const data = {
        id: '',
        model: this.model,
        object: 'chat.completion',
        choices: [{ index: 0, message: { role: 'assistant', content: '' }, finish_reason: 'stop' }],
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
              const { chatID, chat_id, isEnd, content: text } = messageResult
              const finalChatId = chat_id || chatID
              if (!data.id && finalChatId) data.id = finalChatId
              if (isEnd !== 0 && text) data.choices[0].message.content += text
              if (isEnd === 0) resolve(data)
            }
          } catch (err) {
            reject(err)
          }
        },
      })

      response.data.on('data', (buffer: Buffer) => parser.feed(buffer.toString()))
      response.data.once('error', reject)
      response.data.once('close', () => resolve(data))
    })
  }
}

export const minimaxAdapter = {
  MiniMaxAdapter,
  MiniMaxStreamHandler,
}
