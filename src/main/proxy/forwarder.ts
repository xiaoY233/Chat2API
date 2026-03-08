/**
 * Proxy Service Module - Request Forwarder
 * Forwards requests to corresponding API based on provider configuration
 */

import axios, { AxiosRequestConfig, AxiosResponse, AxiosError } from 'axios'
import http2 from 'http2'
import { PassThrough } from 'stream'
import { Account, Provider } from '../store/types'
import { ForwardResult, ChatCompletionRequest, ProxyContext, ChatCompletionTool, ToolCall } from './types'
import { proxyStatusManager } from './status'
import { storeManager } from '../store/store'
import { DeepSeekAdapter } from './adapters/deepseek'
import { DeepSeekStreamHandler } from './adapters/deepseek-stream'
import { GLMAdapter, GLMStreamHandler } from './adapters/glm'
import { KimiAdapter, KimiStreamHandler } from './adapters/kimi'
import { QwenAdapter, QwenStreamHandler } from './adapters/qwen'
import { QwenAiAdapter, QwenAiStreamHandler } from './adapters/qwen-ai'
import { ZaiAdapter, ZaiStreamHandler } from './adapters/zai'
import { MiniMaxAdapter, MiniMaxStreamHandler } from './adapters/minimax'
import {
  isNativeFunctionCallingModel,
  parseToolUse,
  formatToolResult,
  hasToolUse,
} from './promptToolUse'
import { toolsToSystemPrompt, TOOL_WRAP_HINT, hasToolPromptInjected } from './utils/tools'
import { parseToolCallsFromText } from './utils/toolParser'
import { parseToolCallsUnified } from './utils/unifiedToolParser'
import { promptAdapterRegistry } from './adapters/prompt'
import { sessionManager } from './sessionManager'

function shouldDeleteSession(): boolean {
  return sessionManager.shouldDeleteAfterChat()
}

/**
 * Request Forwarder
 */
export class RequestForwarder {
  private axiosInstance = axios.create({
    timeout: 120000,
    maxBodyLength: Infinity,
    maxContentLength: Infinity,
  })

  /**
   * Transform request for prompt-based tool calling
   * For models that don't support native function calling
   * Uses the new PromptAdapterRegistry for enhanced client detection
   */
  private transformRequestForPromptToolUse(
    request: ChatCompletionRequest,
    provider?: Provider
  ): { messages: any[]; tools: undefined } | { messages: any[]; tools: ChatCompletionTool[] } {
    const { messages, tools, model } = request

    if (!tools || tools.length === 0) {
      return { messages, tools: undefined }
    }

    if (isNativeFunctionCallingModel(model)) {
      return { messages, tools }
    }

    const config = storeManager.getConfig()
    const injectionMode = config.toolPromptConfig?.mode || 'smart'
    
    if (injectionMode === 'never') {
      console.log('[Forwarder] Tool prompt injection disabled (mode=never), skipping transformation')
      return { messages, tools: undefined }
    }

    if (promptAdapterRegistry.hasPromptInjected(messages)) {
      console.log('[Forwarder] Tool prompt already injected by known client, skipping transformation')
      return { messages, tools: undefined }
    }

    const result = promptAdapterRegistry.transformRequest(
      messages,
      tools,
      model,
      provider?.id
    )

    if (result.injected) {
      console.log('[Forwarder] Tool prompt injected successfully using adapter registry')
      return { messages: result.messages, tools: undefined }
    }

    console.log('[Forwarder] Using legacy tool prompt injection')
    let systemPrompt = 'You are a helpful AI assistant.'
    const otherMessages: any[] = []

    for (const msg of messages) {
      if (msg.role === 'system') {
        systemPrompt = msg.content as string
      } else {
        otherMessages.push(msg)
      }
    }

    const toolsPrompt = toolsToSystemPrompt(tools as any[])
    const enhancedSystemPrompt = systemPrompt 
      ? `${systemPrompt}\n\n${toolsPrompt}` 
      : toolsPrompt

    return {
      messages: [
        { role: 'system', content: enhancedSystemPrompt },
        ...otherMessages,
      ],
      tools: undefined,
    }
  }

  /**
   * Parse tool calls from response content
   * Supports multiple formats: bracket, XML, Anthropic, JSON
   */
  private parseToolCallsFromContent(content: string): ToolCall[] | null {
    const result = parseToolCallsUnified(content)
    
    if (result.toolCalls.length > 0) {
      console.log(`[Forwarder] Parsed ${result.toolCalls.length} tool calls (format: ${result.format})`)
      return result.toolCalls
    }
    
    return null
  }

  /**
   * Forward Chat Completions Request
   */
  async forwardChatCompletion(
    request: ChatCompletionRequest,
    account: Account,
    provider: Provider,
    actualModel: string,
    context: ProxyContext
  ): Promise<ForwardResult> {
    const startTime = Date.now()
    const config = storeManager.getConfig()
    const maxRetries = config.retryCount

    const sessionContext = sessionManager.getOrCreateSession({
      providerId: provider.id,
      accountId: account.id,
      model: actualModel,
    })

    let lastError: string | undefined

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      if (attempt > 0) {
        await this.delay(5000)
      }

      // When starting a new session, only send the last user message
      // This prevents sending conversation history from the previous session
      let modifiedRequest = request
      if (sessionContext.isNew && request.messages && request.messages.length > 0) {
        const lastUserMessage = request.messages[request.messages.length - 1]
        modifiedRequest = {
          ...request,
          messages: [lastUserMessage]
        }
        console.log('[Forwarder] New session detected, sending only last user message')
      }

      // Save user message to session (only for multi-turn mode and first attempt)
      const isMultiTurnEnabled = sessionManager.isMultiTurnEnabled()
      if (isMultiTurnEnabled && attempt === 0 && sessionContext.sessionId && request.messages && request.messages.length > 0) {
        const lastUserMessage = request.messages[request.messages.length - 1]
        if (lastUserMessage.role === 'user') {
          sessionManager.addMessage(sessionContext.sessionId, {
            role: lastUserMessage.role,
            content: lastUserMessage.content || '',
            timestamp: Date.now(),
          })
        }
      }

      try {
        const result = await this.doForward(modifiedRequest, account, provider, actualModel, context, sessionContext)

        if (result.success) {
          if (result.providerSessionId) {
            sessionManager.updateProviderSessionId(
              sessionContext.sessionId,
              result.providerSessionId
            )
          }
          if (result.parentMessageId) {
            sessionManager.updateParentMessageId(
              sessionContext.sessionId,
              result.parentMessageId
            )
          }
          return result
        }

        lastError = result.error

        if (result.status && result.status < 500 && result.status !== 429) {
          break
        }
      } catch (error) {
        lastError = error instanceof Error ? error.message : 'Unknown error'
      }
    }

    return {
      success: false,
      error: lastError || 'Request failed after retries',
      latency: Date.now() - startTime,
    }
  }

  /**
   * Execute Forward
   */
  private async doForward(
    request: ChatCompletionRequest,
    account: Account,
    provider: Provider,
    actualModel: string,
    context: ProxyContext,
    sessionContext: { sessionId: string; providerSessionId?: string; parentMessageId?: string; messages: any[]; isNew: boolean }
  ): Promise<ForwardResult> {
    const startTime = Date.now()

    // Check if it is a DeepSeek provider, use dedicated adapter
    if (DeepSeekAdapter.isDeepSeekProvider(provider)) {
      return this.forwardDeepSeek(request, account, provider, actualModel, startTime, sessionContext)
    }

    // Check if it is a GLM provider, use dedicated adapter
    if (GLMAdapter.isGLMProvider(provider)) {
      return this.forwardGLM(request, account, provider, actualModel, startTime, sessionContext)
    }

    // Check if it is a Kimi provider, use dedicated adapter
    if (KimiAdapter.isKimiProvider(provider)) {
      return this.forwardKimi(request, account, provider, actualModel, startTime, sessionContext)
    }

    // Check if it is a Qwen provider, use dedicated adapter
    if (QwenAdapter.isQwenProvider(provider)) {
      return this.forwardQwen(request, account, provider, actualModel, startTime, sessionContext)
    }

    // Check if it is a Qwen AI (International) provider, use dedicated adapter
    if (QwenAiAdapter.isQwenAiProvider(provider)) {
      return this.forwardQwenAi(request, account, provider, actualModel, startTime, sessionContext)
    }

    // Check if it is a Z.ai provider, use dedicated adapter
    if (ZaiAdapter.isZaiProvider(provider)) {
      return this.forwardZai(request, account, provider, actualModel, startTime, sessionContext)
    }

    // Check if it is a MiniMax provider, use dedicated adapter
    if (MiniMaxAdapter.isMiniMaxProvider(provider)) {
      return this.forwardMiniMax(request, account, provider, actualModel, startTime, sessionContext)
    }

    try {
      const chatPath = provider.chatPath || '/chat/completions'
      const url = this.buildUrl(provider, chatPath)
      const headers = this.buildHeaders(provider, account)
      const body = this.buildRequestBody(request, actualModel, account)

      const axiosConfig: AxiosRequestConfig = {
        method: 'POST',
        url,
        headers,
        data: body,
        timeout: proxyStatusManager.getConfig().timeout,
        responseType: request.stream ? 'stream' : 'json',
        validateStatus: () => true,
      }

      const response: AxiosResponse = await this.axiosInstance.request(axiosConfig)
      const latency = Date.now() - startTime

      if (response.status >= 400) {
        return {
          success: false,
          status: response.status,
          error: this.extractErrorMessage(response),
          latency,
        }
      }

      if (request.stream) {
        return {
          success: true,
          status: response.status,
          headers: this.extractHeaders(response.headers),
          stream: response.data,
          latency,
        }
      }

      return {
        success: true,
        status: response.status,
        headers: this.extractHeaders(response.headers),
        body: response.data,
        latency,
      }
    } catch (error) {
      const latency = Date.now() - startTime

      if (error instanceof AxiosError) {
        return {
          success: false,
          status: error.response?.status,
          error: error.message,
          latency,
        }
      }

      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
        latency,
      }
    }
  }

  /**
   * DeepSeek Dedicated Forward
   */
  private async forwardDeepSeek(
    request: ChatCompletionRequest,
    account: Account,
    provider: Provider,
    actualModel: string,
    startTime: number,
    sessionContext: { sessionId: string; providerSessionId?: string; parentMessageId?: string; messages: any[]; isNew: boolean }
  ): Promise<ForwardResult> {
    try {
      const transformed = this.transformRequestForPromptToolUse(request, provider)
      const transformedRequest = {
        ...request,
        messages: transformed.messages,
        tools: transformed.tools,
      }

      const adapter = new DeepSeekAdapter(provider, account)
      
      // Determine if we should reuse session
      const isMultiTurn = sessionManager.isMultiTurnEnabled() && sessionContext && !sessionContext.isNew
      const existingSessionId = sessionContext?.providerSessionId || ''
      const parentMessageId = sessionContext?.parentMessageId || ''
      
      const { response, sessionId } = await adapter.chatCompletion({
        model: request.model,
        messages: transformedRequest.messages as any,
        stream: transformedRequest.stream,
        temperature: transformedRequest.temperature,
        web_search: transformedRequest.web_search,
        reasoning_effort: transformedRequest.reasoning_effort,
        isMultiTurn,
        sessionId: existingSessionId,
        parentMessageId,
      })

      const latency = Date.now() - startTime

      if (response.status >= 400) {
        let errorMessage = `HTTP ${response.status}`
        if (response.data) {
          if (typeof response.data === 'string') {
            errorMessage = response.data
          } else if (response.data.msg) {
            errorMessage = response.data.msg
          } else if (response.data.error?.message) {
            errorMessage = response.data.error.message
          }
        }
        return {
          success: false,
          status: response.status,
          error: errorMessage,
          latency,
        }
      }

      // Prepare callback for deleting session
      const deleteSessionCallback = shouldDeleteSession()
        ? async () => {
            try {
              await adapter.deleteSession(sessionId)
            } catch (error) {
              console.error('[DeepSeek] Failed to delete session:', error)
            }
          }
        : undefined

      // DeepSeek always returns streaming response
      const handler = new DeepSeekStreamHandler(
        actualModel,
        sessionId,
        deleteSessionCallback,
        transformedRequest.web_search,
        transformedRequest.reasoning_effort
      )
      
      if (request.stream) {
        const transformedStream = await handler.handleStream(response.data)
        
        // Listen for stream end to update parent message ID
        transformedStream.on('end', () => {
          const lastMessageId = handler.getLastMessageId()
          if (lastMessageId && sessionContext.sessionId) {
            sessionManager.updateParentMessageId(sessionContext.sessionId, lastMessageId)
          }
        })
        
        return {
          success: true,
          status: response.status,
          headers: this.extractHeaders(response.headers),
          stream: transformedStream,
          skipTransform: true,
          latency,
          providerSessionId: sessionId,
        }
      }

      // Non-streaming requests need to collect stream data and convert
      const result = await handler.handleNonStream(response.data)
      
      // Update parent message ID for non-stream response
      const lastMessageId = handler.getLastMessageId()
      if (lastMessageId && sessionContext.sessionId) {
        sessionManager.updateParentMessageId(sessionContext.sessionId, lastMessageId)
      }
      
      // Parse tool calls from response content if using prompt-based tool calling
      if (request.tools && request.tools.length > 0 && !isNativeFunctionCallingModel(request.model)) {
        const content = result?.choices?.[0]?.message?.content || ''
        const toolCalls = this.parseToolCallsFromContent(content)
        
        if (toolCalls && toolCalls.length > 0) {
          // Found tool calls in response, add them to the response
          result.choices[0].message.tool_calls = toolCalls
          result.choices[0].message.content = null
          result.choices[0].finish_reason = 'tool_calls'
        }
      }
      
      // Delete session after non-streaming request ends
      if (deleteSessionCallback) {
        await deleteSessionCallback()
      }

      return {
        success: true,
        status: response.status,
        headers: this.extractHeaders(response.headers),
        body: result,
        latency,
        providerSessionId: sessionId,
        parentMessageId: lastMessageId,
      }
    } catch (error) {
      const latency = Date.now() - startTime
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
        latency,
      }
    }
  }

  /**
   * GLM Dedicated Forward
   */
  private async forwardGLM(
    request: ChatCompletionRequest,
    account: Account,
    provider: Provider,
    actualModel: string,
    startTime: number,
    sessionContext: { sessionId: string; providerSessionId?: string; parentMessageId?: string; messages: any[]; isNew: boolean }
  ): Promise<ForwardResult> {
    try {
      const transformed = this.transformRequestForPromptToolUse(request, provider)
      const transformedRequest = {
        ...request,
        messages: transformed.messages,
        tools: transformed.tools,
      }

      const adapter = new GLMAdapter(provider, account)
      const { response, conversationId } = await adapter.chatCompletion({
        model: actualModel,
        messages: transformedRequest.messages,
        stream: transformedRequest.stream,
        temperature: transformedRequest.temperature,
        web_search: transformedRequest.web_search,
        reasoning_effort: transformedRequest.reasoning_effort,
        deep_research: transformedRequest.deep_research,
        sessionContext: {
          sessionId: sessionContext.sessionId,
          providerSessionId: sessionContext.providerSessionId,
          parentMessageId: sessionContext.parentMessageId,
          messages: sessionContext.messages,
          isNew: sessionContext.isNew,
        },
      })

      const latency = Date.now() - startTime

      if (response.status >= 400) {
        let errorMessage = `HTTP ${response.status}`
        if (response.data) {
          if (typeof response.data === 'string') {
            errorMessage = response.data
          } else if (response.data.msg) {
            errorMessage = response.data.msg
          } else if (response.data.message) {
            errorMessage = response.data.message
          } else if (response.data.error?.message) {
            errorMessage = response.data.error.message
          }
        }
        return {
          success: false,
          status: response.status,
          error: errorMessage,
          latency,
        }
      }

      const handler = new GLMStreamHandler(actualModel)
      
      if (request.stream) {
        const transformedStream = await handler.handleStream(response.data)
        
        // Listen for stream end to update provider session ID
        transformedStream.on('end', () => {
          const convId = handler.getConversationId()
          if (convId && sessionContext.sessionId) {
            sessionManager.updateProviderSessionId(sessionContext.sessionId, convId)
          }
        })
        
        // If delete session after chat is enabled, we need to handle it after stream ends
        if (shouldDeleteSession()) {
          const originalEnd = transformedStream.end.bind(transformedStream)
          transformedStream.end = function(chunk?: any, encoding?: any, callback?: any) {
            const convId = handler.getConversationId()
            if (convId) {
              adapter.deleteConversation(convId).catch(err => {
                console.error('[GLM] Failed to delete session:', err)
              })
            }
            return originalEnd(chunk, encoding, callback)
          }
        }
        
        return {
          success: true,
          status: response.status,
          headers: this.extractHeaders(response.headers),
          stream: transformedStream,
          skipTransform: true,
          latency,
          providerSessionId: sessionContext.providerSessionId || handler.getConversationId(),
        }
      }

      const result = await handler.handleNonStream(response.data)
      
      // Update provider session ID for non-stream response
      const convId = handler.getConversationId()
      if (convId && sessionContext.sessionId) {
        sessionManager.updateProviderSessionId(sessionContext.sessionId, convId)
      }
      
      // Parse tool calls from response content if using prompt-based tool calling
      if (request.tools && request.tools.length > 0 && !isNativeFunctionCallingModel(request.model)) {
        const content = result?.choices?.[0]?.message?.content || ''
        const toolCalls = this.parseToolCallsFromContent(content)
        
        if (toolCalls && toolCalls.length > 0) {
          result.choices[0].message.tool_calls = toolCalls
          result.choices[0].message.content = null
          result.choices[0].finish_reason = 'tool_calls'
        }
      }
      
      // Delete session after non-stream response
      if (shouldDeleteSession()) {
        const convId = handler.getConversationId()
        if (convId) {
          await adapter.deleteConversation(convId)
        }
      }

      return {
        success: true,
        status: response.status,
        headers: this.extractHeaders(response.headers),
        body: result,
        latency,
        providerSessionId: handler.getConversationId() ?? undefined,
      }
    } catch (error) {
      const latency = Date.now() - startTime
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
        latency,
      }
    }
  }

  private async forwardKimi(
    request: ChatCompletionRequest,
    account: Account,
    provider: Provider,
    actualModel: string,
    startTime: number,
    sessionContext: { sessionId: string; providerSessionId?: string; parentMessageId?: string; messages: any[]; isNew: boolean }
  ): Promise<ForwardResult> {
    try {
      const transformed = this.transformRequestForPromptToolUse(request, provider)
      
      const adapter = new KimiAdapter(provider, account)
      const { response, conversationId } = await adapter.chatCompletion({
        model: actualModel,
        messages: transformed.messages,
        stream: request.stream,
        temperature: request.temperature,
        enableThinking: !!request.reasoning_effort,
        enableWebSearch: !!request.web_search,
        sessionContext: {
          sessionId: sessionContext.sessionId,
          providerSessionId: sessionContext.providerSessionId,
          parentMessageId: sessionContext.parentMessageId,
          messages: sessionContext.messages,
          isNew: sessionContext.isNew,
        },
      })

      const latency = Date.now() - startTime

      if (response.status >= 400) {
        let errorMessage = `HTTP ${response.status}`
        return {
          success: false,
          status: response.status,
          error: errorMessage,
          latency,
        }
      }

      const handler = new KimiStreamHandler(actualModel, conversationId, !!request.reasoning_effort)
      
      if (request.stream) {
        const transformedStream = await handler.handleStream(response.data)
        
        // Listen for stream end to update parent message ID and provider session ID
        transformedStream.on('end', () => {
          const lastMessageId = handler.getLastMessageId()
          const realChatId = handler.getConversationId()
          console.log('[Kimi] Stream end event, realChatId:', realChatId, 'lastMessageId:', lastMessageId, 'sessionId:', sessionContext.sessionId)
          if (lastMessageId && sessionContext.sessionId) {
            sessionManager.updateParentMessageId(sessionContext.sessionId, lastMessageId)
          }
          // Update provider session ID with real chat_id from response
          // Only update if realChatId is valid (not null, not empty, and not a temporary ID)
          if (realChatId && sessionContext.sessionId) {
            sessionManager.updateProviderSessionId(sessionContext.sessionId, realChatId)
          }
        })
        
        // Add delete conversation callback if needed
        if (shouldDeleteSession()) {
          const originalEnd = transformedStream.end.bind(transformedStream)
          transformedStream.end = function(chunk?: any, encoding?: any, callback?: any) {
            const realChatId = handler.getConversationId()
            if (realChatId && realChatId.startsWith('kimi-') === false) {
              adapter.deleteConversation(realChatId).catch(err => {
                console.error('[Kimi] Failed to delete conversation:', err)
              })
            }
            return originalEnd(chunk, encoding, callback)
          }
        }
        
        return {
          success: true,
          status: response.status,
          headers: this.extractHeaders(response.headers),
          stream: transformedStream,
          skipTransform: true,
          latency,
          // Use existing providerSessionId if available, otherwise wait for stream to extract real chat_id
          providerSessionId: sessionContext.providerSessionId || undefined,
        }
      }

      const result = await handler.handleNonStream(response.data)
      
      // Update parent message ID and provider session ID for non-stream response
      const lastMessageId = handler.getLastMessageId()
      const realChatId = handler.getConversationId()
      if (lastMessageId && sessionContext.sessionId) {
        sessionManager.updateParentMessageId(sessionContext.sessionId, lastMessageId)
      }
      // Update provider session ID with real chat_id from response
      if (realChatId && sessionContext.sessionId && !realChatId.startsWith('kimi-')) {
        sessionManager.updateProviderSessionId(sessionContext.sessionId, realChatId)
      }

      // Parse tool calls from response content if using prompt-based tool calling
      if (request.tools && request.tools.length > 0 && !isNativeFunctionCallingModel(request.model)) {
        const content = result?.choices?.[0]?.message?.content || ''
        const toolCalls = this.parseToolCallsFromContent(content)
        
        if (toolCalls && toolCalls.length > 0) {
          result.choices[0].message.tool_calls = toolCalls
          result.choices[0].message.content = null
          result.choices[0].finish_reason = 'tool_calls'
        }
      }

      // Delete conversation if needed
      if (shouldDeleteSession()) {
        const realChatId = handler.getConversationId()
        if (realChatId && realChatId.startsWith('kimi-') === false) {
          await adapter.deleteConversation(realChatId)
        }
      }

      return {
        success: true,
        status: response.status,
        headers: this.extractHeaders(response.headers),
        body: result,
        latency,
        providerSessionId: handler.getConversationId() ?? undefined,
      }
    } catch (error) {
      const latency = Date.now() - startTime
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
        latency,
      }
    }
  }

  /**
   * Qwen Dedicated Forward
   */
  private async forwardQwen(
    request: ChatCompletionRequest,
    account: Account,
    provider: Provider,
    actualModel: string,
    startTime: number,
    sessionContext: { sessionId: string; providerSessionId?: string; parentMessageId?: string; messages: any[]; isNew: boolean }
  ): Promise<ForwardResult> {
    try {
      const transformed = this.transformRequestForPromptToolUse(request, provider)
      const transformedRequest = {
        ...request,
        messages: transformed.messages,
        tools: transformed.tools,
      }

      const adapter = new QwenAdapter(provider, account)
      const { response, sessionId, reqId } = await adapter.chatCompletion({
        model: actualModel,
        messages: transformedRequest.messages as any,
        stream: request.stream,
        temperature: request.temperature,
        enableThinking: !!request.reasoning_effort,
        enableWebSearch: !!request.web_search,
        sessionContext: {
          sessionId: sessionContext.sessionId,
          providerSessionId: sessionContext.providerSessionId,
          parentMessageId: sessionContext.parentMessageId,
          messages: sessionContext.messages,
          isNew: sessionContext.isNew,
        },
      })

      const latency = Date.now() - startTime

      if (response.status >= 400) {
        let errorMessage = `HTTP ${response.status}`
        return {
          success: false,
          status: response.status,
          error: errorMessage,
          latency,
        }
      }

      const deleteSessionCallback = shouldDeleteSession()
        ? async (sid: string) => {
            try {
              await adapter.deleteSession(sid)
            } catch (err) {
              console.error('[Qwen] Failed to delete session:', err)
            }
          }
        : undefined

      const handler = new QwenStreamHandler(actualModel, deleteSessionCallback)

      if (request.stream) {
        const transformedStream = await handler.handleStream(response.data, response)
        
        // Listen for stream end to update parent message ID using the reqId
        // IMPORTANT: parentMessageId should be the reqId of the previous request
        transformedStream.on('end', () => {
          if (reqId && sessionContext.sessionId) {
            // Update parent message ID using the reqId for the next request
            sessionManager.updateParentMessageId(sessionContext.sessionId, reqId)
          }
        })

        return {
          success: true,
          status: response.status,
          headers: this.extractHeaders(response.headers),
          stream: transformedStream,
          skipTransform: true,
          latency,
          providerSessionId: sessionId,
        }
      }

      const result = await handler.handleNonStream(response.data, response)

      // Parse tool calls from response content if using prompt-based tool calling
      if (request.tools && request.tools.length > 0 && !isNativeFunctionCallingModel(request.model)) {
        const content = result?.choices?.[0]?.message?.content || ''
        const toolCalls = this.parseToolCallsFromContent(content)
        
        if (toolCalls && toolCalls.length > 0) {
          result.choices[0].message.tool_calls = toolCalls
          result.choices[0].message.content = null
          result.choices[0].finish_reason = 'tool_calls'
        }
      }

      // Update parent message ID for non-stream response using the reqId
      if (reqId && sessionContext.sessionId) {
        sessionManager.updateParentMessageId(sessionContext.sessionId, reqId)
      }

      const sid = handler.getSessionId()
      if (deleteSessionCallback && sid) {
        await deleteSessionCallback(sid)
      }

      return {
        success: true,
        status: response.status,
        headers: this.extractHeaders(response.headers),
        body: result,
        latency,
        providerSessionId: sessionId,
      }
    } catch (error) {
      const latency = Date.now() - startTime
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
        latency,
      }
    }
  }

  /**
   * Qwen AI (International) Dedicated Forward
   */
  private async forwardQwenAi(
    request: ChatCompletionRequest,
    account: Account,
    provider: Provider,
    actualModel: string,
    startTime: number,
    sessionContext: { sessionId: string; providerSessionId?: string; parentMessageId?: string; messages: any[]; isNew: boolean }
  ): Promise<ForwardResult> {
    try {
      const transformed = this.transformRequestForPromptToolUse(request, provider)
      
      const adapter = new QwenAiAdapter(provider, account)
      const { response, chatId, parentId } = await adapter.chatCompletion({
        model: actualModel,
        messages: transformed.messages as any,
        stream: request.stream,
        temperature: request.temperature,
        enable_thinking: !!request.reasoning_effort,
        sessionContext: {
          sessionId: sessionContext.sessionId,
          providerSessionId: sessionContext.providerSessionId,
          parentMessageId: sessionContext.parentMessageId,
          messages: sessionContext.messages,
          isNew: sessionContext.isNew,
        },
      })

      const latency = Date.now() - startTime

      if (response.status >= 400) {
        let errorMessage = `HTTP ${response.status}`
        return {
          success: false,
          status: response.status,
          error: errorMessage,
          latency,
        }
      }

      const deleteChatCallback = shouldDeleteSession()
        ? async (cid: string) => {
            try {
              await adapter.deleteChat(cid)
            } catch (err) {
              console.error('[QwenAI] Failed to delete chat:', err)
            }
          }
        : undefined

      const handler = new QwenAiStreamHandler(actualModel, deleteChatCallback)
      handler.setChatId(chatId)

      if (request.stream) {
        const transformedStream = await handler.handleStream(response.data)

        // Listen for stream end to get the response ID and update parent message ID
        transformedStream.on('end', () => {
          const responseId = handler.getResponseId()
          if (responseId && sessionContext.sessionId) {
            // Update parent message ID using the existing session context
            sessionManager.updateParentMessageId(sessionContext.sessionId, responseId)
          }
        })

        return {
          success: true,
          status: response.status,
          headers: this.extractHeaders(response.headers),
          stream: transformedStream,
          skipTransform: true,
          latency,
          providerSessionId: chatId,
        }
      }

      const result = await handler.handleNonStream(response.data)

      // Parse tool calls from response content if using prompt-based tool calling
      if (request.tools && request.tools.length > 0 && !isNativeFunctionCallingModel(request.model)) {
        const content = result?.choices?.[0]?.message?.content || ''
        const toolCalls = this.parseToolCallsFromContent(content)
        
        if (toolCalls && toolCalls.length > 0) {
          result.choices[0].message.tool_calls = toolCalls
          result.choices[0].message.content = null
          result.choices[0].finish_reason = 'tool_calls'
        }
      }

      if (deleteChatCallback) {
        await deleteChatCallback(chatId)
      }

      return {
        success: true,
        status: response.status,
        headers: this.extractHeaders(response.headers),
        body: result,
        latency,
        providerSessionId: chatId,
      }
    } catch (error) {
      const latency = Date.now() - startTime
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
        latency,
      }
    }
  }

  /**
   * Z.ai Dedicated Forward
   */
  private async forwardZai(
    request: ChatCompletionRequest,
    account: Account,
    provider: Provider,
    actualModel: string,
    startTime: number,
    sessionContext: { sessionId: string; providerSessionId?: string; parentMessageId?: string; messages: any[]; isNew: boolean }
  ): Promise<ForwardResult> {
    console.log('[forwardZai] actualModel:', actualModel)
    console.log('[forwardZai] provider.modelMappings:', provider.modelMappings)
    try {
      const transformed = this.transformRequestForPromptToolUse(request, provider)
      
      const adapter = new ZaiAdapter(provider, account)
      const { response, chatId, requestId } = await adapter.chatCompletion({
        model: actualModel,
        messages: transformed.messages as any,
        stream: request.stream,
        temperature: request.temperature,
        web_search: request.web_search,
        reasoning_effort: request.reasoning_effort,
        sessionContext: {
          sessionId: sessionContext.sessionId,
          providerSessionId: sessionContext.providerSessionId,
          parentMessageId: sessionContext.parentMessageId,
          messages: sessionContext.messages,
          isNew: sessionContext.isNew,
        },
      })

      const latency = Date.now() - startTime

      if (response.status >= 400) {
        let errorMessage = `HTTP ${response.status}`
        return {
          success: false,
          status: response.status,
          error: errorMessage,
          latency,
        }
      }

      const deleteChatCallback = shouldDeleteSession()
        ? async (cid: string) => {
            try {
              await adapter.deleteChat(cid)
            } catch (error) {
              console.error('[Z.ai] Failed to delete chat:', error)
            }
          }
        : undefined

      const handler = new ZaiStreamHandler(actualModel, deleteChatCallback)
      handler.setChatId(chatId)
      
      if (request.stream !== false) {
        const transformedStream = await handler.handleStream(response.data)
        
        // Listen for stream end to update parent message ID using the requestId
        // IMPORTANT: parentMessageId should be the requestId of the previous request, not the assistant message ID
        transformedStream.on('end', () => {
          if (requestId && sessionContext.sessionId) {
            // Update parent message ID using the requestId for the next request
            sessionManager.updateParentMessageId(sessionContext.sessionId, requestId)
          }
        })
        
        return {
          success: true,
          status: response.status,
          headers: this.extractHeaders(response.headers),
          stream: transformedStream,
          skipTransform: true,
          latency,
          providerSessionId: chatId,
        }
      }

      const result = await handler.handleNonStream(response)

      // Parse tool calls from response content if using prompt-based tool calling
      if (request.tools && request.tools.length > 0 && !isNativeFunctionCallingModel(request.model)) {
        const content = result?.choices?.[0]?.message?.content || ''
        const toolCalls = this.parseToolCallsFromContent(content)
        
        if (toolCalls && toolCalls.length > 0) {
          result.choices[0].message.tool_calls = toolCalls
          result.choices[0].message.content = null
          result.choices[0].finish_reason = 'tool_calls'
        }
      }
      
      // Update parent message ID for non-stream response using the requestId
      // IMPORTANT: parentMessageId should be the requestId of the previous request, not the assistant message ID
      if (requestId && sessionContext.sessionId) {
        sessionManager.updateParentMessageId(sessionContext.sessionId, requestId)
      }
      
      if (deleteChatCallback) {
        await deleteChatCallback(chatId)
      }

      return {
        success: true,
        status: response.status,
        headers: this.extractHeaders(response.headers),
        body: result,
        latency,
        providerSessionId: chatId,
      }
    } catch (error) {
      const latency = Date.now() - startTime
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
        latency,
      }
    }
  }

  /**
   * MiniMax Dedicated Forward
   */
  private async forwardMiniMax(
    request: ChatCompletionRequest,
    account: Account,
    provider: Provider,
    actualModel: string,
    startTime: number,
    sessionContext: { sessionId: string; providerSessionId?: string; parentMessageId?: string; messages: any[]; isNew: boolean }
  ): Promise<ForwardResult> {
    console.log('[forwardMiniMax] actualModel:', actualModel)
    console.log('[forwardMiniMax] provider.modelMappings:', provider.modelMappings)
    try {
      const transformed = this.transformRequestForPromptToolUse(request, provider)
      
      const adapter = new MiniMaxAdapter(provider, account)
      const { response, stream, chatId } = await adapter.chatCompletion({
        model: actualModel,
        messages: transformed.messages as any,
        stream: request.stream,
        temperature: request.temperature,
        sessionContext: {
          sessionId: sessionContext.sessionId,
          providerSessionId: sessionContext.providerSessionId,
          parentMessageId: sessionContext.parentMessageId,
          messages: sessionContext.messages,
          isNew: sessionContext.isNew,
        },
      })

      const latency = Date.now() - startTime

      if (response && response.status >= 400) {
        let errorMessage = `HTTP ${response.status}`
        return {
          success: false,
          status: response.status,
          error: errorMessage,
          latency,
        }
      }

      const deleteChatCallback = shouldDeleteSession()
        ? async (cid: string) => {
            try {
              await adapter.deleteChat(cid)
            } catch (error) {
              console.error('[MiniMax] Failed to delete chat:', error)
            }
          }
        : undefined

      if (request.stream !== false && stream) {
        console.log('[forwardMiniMax] Using polling stream')
        
        if (deleteChatCallback) {
          const originalStream = stream.stream as unknown as PassThrough
          const originalEnd = originalStream.end.bind(originalStream)
          originalStream.end = function(chunk?: any, encoding?: any, callback?: any) {
            deleteChatCallback(chatId).catch(err => {
              console.error('[MiniMax] Failed to delete chat:', err)
            })
            return originalEnd(chunk, encoding, callback)
          }
        }
        
        return {
          success: true,
          status: 200,
          headers: {},
          stream: stream.stream as any,
          skipTransform: true,
          latency,
          providerSessionId: chatId,
        }
      }

      if (response) {
        // Parse tool calls from response content if using prompt-based tool calling
        if (request.tools && request.tools.length > 0 && !isNativeFunctionCallingModel(request.model)) {
          const content = response.data?.choices?.[0]?.message?.content || ''
          const toolCalls = this.parseToolCallsFromContent(content)
          
          if (toolCalls && toolCalls.length > 0) {
            response.data.choices[0].message.tool_calls = toolCalls
            response.data.choices[0].message.content = null
            response.data.choices[0].finish_reason = 'tool_calls'
          }
        }
        
        // Response is already formatted as OpenAI-compatible format
        if (deleteChatCallback) {
          await deleteChatCallback(chatId)
        }

        return {
          success: true,
          status: response.status,
          headers: this.extractHeaders(response.headers),
          body: response.data,
          latency,
          providerSessionId: chatId,
        }
      }

      return {
        success: false,
        error: 'No response or stream received',
        latency,
      }
    } catch (error) {
      const latency = Date.now() - startTime
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
        latency,
      }
    }
  }

  /**
   * Build URL
   */
  private buildUrl(provider: Provider, path: string): string {
    let baseUrl = provider.apiEndpoint

    if (baseUrl.endsWith('/')) {
      baseUrl = baseUrl.slice(0, -1)
    }

    if (!path.startsWith('/')) {
      path = '/' + path
    }

    if (baseUrl.includes('/v1') && path.startsWith('/v1')) {
      path = path.slice(3)
    }

    return `${baseUrl}${path}`
  }

  /**
   * Build Request Headers
   */
  private buildHeaders(provider: Provider, account: Account): Record<string, string> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      ...provider.headers,
    }

    const credentials = account.credentials

    if (credentials.token) {
      headers['Authorization'] = `Bearer ${credentials.token}`
    } else if (credentials.apiKey) {
      headers['Authorization'] = `Bearer ${credentials.apiKey}`
    } else if (credentials.accessToken) {
      headers['Authorization'] = `Bearer ${credentials.accessToken}`
    } else if (credentials.refreshToken) {
      headers['Authorization'] = `Bearer ${credentials.refreshToken}`
    }

    if (credentials.cookie) {
      headers['Cookie'] = credentials.cookie
    }

    if (credentials.sessionKey) {
      headers['X-Session-Key'] = credentials.sessionKey
    }

    return headers
  }

  /**
   * Build Request Body
   */
  private buildRequestBody(
    request: ChatCompletionRequest,
    actualModel: string,
    account: Account
  ): any {
    const body: any = {
      model: actualModel,
      messages: request.messages,
      stream: request.stream || false,
    }

    if (request.temperature !== undefined) {
      body.temperature = request.temperature
    }

    if (request.top_p !== undefined) {
      body.top_p = request.top_p
    }

    if (request.n !== undefined) {
      body.n = request.n
    }

    if (request.stop !== undefined) {
      body.stop = request.stop
    }

    if (request.max_tokens !== undefined) {
      body.max_tokens = request.max_tokens
    }

    if (request.presence_penalty !== undefined) {
      body.presence_penalty = request.presence_penalty
    }

    if (request.frequency_penalty !== undefined) {
      body.frequency_penalty = request.frequency_penalty
    }

    if (request.logit_bias !== undefined) {
      body.logit_bias = request.logit_bias
    }

    if (request.user !== undefined) {
      body.user = request.user
    }

    return body
  }

  /**
   * Extract Response Headers
   */
  private extractHeaders(headers: any): Record<string, string> {
    const result: Record<string, string> = {}

    for (const [key, value] of Object.entries(headers)) {
      if (typeof value === 'string') {
        result[key] = value
      } else if (Array.isArray(value)) {
        result[key] = value.join(', ')
      }
    }

    return result
  }

  /**
   * Extract Error Message
   */
  private extractErrorMessage(response: AxiosResponse): string {
    if (response.data) {
      if (typeof response.data === 'string') {
        return response.data
      }

      if (response.data.error?.message) {
        return response.data.error.message
      }

      if (response.data.message) {
        return response.data.message
      }

      if (response.data.msg) {
        return response.data.msg
      }

      try {
        return JSON.stringify(response.data)
      } catch {
        return 'Unknown error'
      }
    }

    return `HTTP ${response.status}`
  }

  /**
   * Delay
   */
  private delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms))
  }

  /**
   * Forward Request to Specified URL
   */
  async forwardToUrl(
    url: string,
    method: string,
    headers: Record<string, string>,
    body: any,
    isStream: boolean = false
  ): Promise<ForwardResult> {
    const startTime = Date.now()

    try {
      const config: AxiosRequestConfig = {
        method,
        url,
        headers,
        data: body,
        timeout: proxyStatusManager.getConfig().timeout,
        responseType: isStream ? 'stream' : 'json',
        validateStatus: () => true,
      }

      const response: AxiosResponse = await this.axiosInstance.request(config)
      const latency = Date.now() - startTime

      if (response.status >= 400) {
        return {
          success: false,
          status: response.status,
          error: this.extractErrorMessage(response),
          latency,
        }
      }

      if (isStream) {
        return {
          success: true,
          status: response.status,
          headers: this.extractHeaders(response.headers),
          stream: response.data,
          latency,
        }
      }

      return {
        success: true,
        status: response.status,
        headers: this.extractHeaders(response.headers),
        body: response.data,
        latency,
      }
    } catch (error) {
      const latency = Date.now() - startTime

      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
        latency,
      }
    }
  }
}

export const requestForwarder = new RequestForwarder()
export default requestForwarder
