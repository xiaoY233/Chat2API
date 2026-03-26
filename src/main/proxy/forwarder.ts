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
import { PerplexityAdapter } from './adapters/perplexity'
import { PerplexityStreamHandler } from './adapters/perplexity-stream'
import {
  isNativeFunctionCallingModel,
  parseToolUse,
  formatToolResult,
  hasToolUse,
} from './promptToolUse'
import { parseToolCallsFromText } from './utils/toolParser'
import { parseToolCalls } from './utils/toolParser/index'
import { promptInjectionService } from './services/promptInjectionService'
import { sessionManager } from './sessionManager'
import { cleanClientToolPrompts } from './utils/promptSignatures'

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
   * Delegates all logic to PromptInjectionService
   */
  private transformRequestForPromptToolUse(
    request: ChatCompletionRequest,
    provider?: Provider
  ): { messages: any[]; tools: undefined } | { messages: any[]; tools: ChatCompletionTool[] } {
    const { messages, tools, model } = request

    // 1. Quick check: native function calling model
    if (isNativeFunctionCallingModel(model)) {
      return { messages, tools }
    }

    // 2. Check if we have tools to inject
    const hasOpenAITools = tools && tools.length > 0
    const hasMCPTools = this.hasMCPToolDefinitions(messages)
    
    // 3. No tools at all - return as-is
    if (!hasOpenAITools && !hasMCPTools) {
      return { messages, tools: undefined }
    }

    // 4. Delegate all injection logic to PromptInjectionService
    // Pass empty array if no OpenAI tools, service will handle MCP tools
    const result = promptInjectionService.process(messages, tools || [], model, provider?.id)
    
    return { messages: result.messages, tools: undefined }
  }

  /**
   * Parse tool calls from response content
   * Supports multiple formats: bracket, XML, Anthropic, JSON
   */
  private parseToolCallsFromContent(content: string): ToolCall[] | null {
    const result = parseToolCalls(content)

    if (result.toolCalls.length > 0) {
      console.log(`[Forwarder] Parsed ${result.toolCalls.length} tool calls (format: ${result.format})`)
      return result.toolCalls
    }

    return null
  }

  /**
   * Check if messages contain MCP-style tool definitions
   * MCP tools are defined in system message using <tools><tool> XML format
   */
  private hasMCPToolDefinitions(messages: any[]): boolean {
    for (const msg of messages) {
      if (msg.role === 'system' && typeof msg.content === 'string') {
        // Check for MCP-style tool definitions
        if (msg.content.includes('<tools>') && msg.content.includes('<tool>')) {
          return true
        }
        // Also check for "Tool Use Available Tools" section (Cherry Studio format)
        if (msg.content.includes('## Tool Use Available Tools')) {
          return true
        }
      }
    }
    return false
  }

  /**
   * Transform MCP tool protocol from one format to another
   * Used when user wants to change the tool calling format
   */
  private transformMCPToolProtocol(messages: any[], targetFormat: 'bracket' | 'xml'): any[] {
    console.log(`[Forwarder] Transforming MCP tool protocol to ${targetFormat} format`)
    
    return messages.map(msg => {
      if (msg.role === 'system' && typeof msg.content === 'string') {
        console.log(`[Forwarder] Processing system message, content length: ${msg.content.length}`)
        
        // Extract tool definitions from MCP format FIRST (before cleaning)
        const tools = this.extractMCPTools(msg.content)
        
        console.log(`[Forwarder] Extracted ${tools.length} MCP tools from original content`)
        
        if (tools.length === 0) {
          return msg
        }
        
        // Clean existing tool prompt section
        const cleanedMsg = cleanClientToolPrompts([msg])[0]
        let content = msg.content
        if (typeof cleanedMsg.content === 'string' && cleanedMsg.content !== msg.content) {
          console.log(`[Forwarder] Cleaned content, new length: ${cleanedMsg.content.length}`)
          content = cleanedMsg.content
        } else {
          console.log(`[Forwarder] No cleaning performed or content unchanged`)
        }
        
        // Generate new tool prompt in target format
        const toolPrompt = this.generateToolPrompt(tools, targetFormat)
        console.log(`[Forwarder] Generated tool prompt, length: ${toolPrompt.length}`)
        
        // Inject new prompt
        const newContent = content + '\n\n' + toolPrompt
        console.log(`[Forwarder] New content length: ${newContent.length}`)
        
        return {
          ...msg,
          content: newContent
        }
      }
      return msg
    })
  }

  /**
   * Extract tool definitions from MCP format
   */
  private extractMCPTools(content: string): ChatCompletionTool[] {
    const tools: ChatCompletionTool[] = []
    
    console.log('[Forwarder] Extracting MCP tools from content')
    
    // Match <tool> blocks - more flexible regex
    const toolRegex = /<tool>[\s\S]*?<name>([^<]+)<\/name>[\s\S]*?<description>([^<]*)<\/description>[\s\S]*?<arguments>([\s\S]*?)<\/arguments>[\s\S]*?<\/tool>/g
    
    let match
    let matchCount = 0
    while ((match = toolRegex.exec(content)) !== null) {
      matchCount++
      const name = match[1].trim()
      const description = match[2].trim()
      let argumentsStr = match[3].trim()
      
      console.log(`[Forwarder] Found tool #${matchCount}: ${name}`)
      console.log(`[Forwarder] Description: ${description.substring(0, 50)}...`)
      console.log(`[Forwarder] Arguments length: ${argumentsStr.length}`)
      
      // Parse JSON schema from arguments
      let parameters = {}
      try {
        // Try to parse the arguments as JSON directly
        const argsObj = JSON.parse(argumentsStr)
        if (argsObj.jsonSchema) {
          parameters = argsObj.jsonSchema
          console.log(`[Forwarder] Parsed jsonSchema successfully`)
        }
      } catch (e) {
        // Try alternative parsing
        try {
          const jsonSchemaMatch = argumentsStr.match(/"jsonSchema"\s*:\s*(\{[\s\S]*?\})\s*}\s*$/)
          if (jsonSchemaMatch) {
            parameters = JSON.parse(jsonSchemaMatch[1])
            console.log(`[Forwarder] Parsed jsonSchema via regex`)
          }
        } catch (e2) {
          console.log('[Forwarder] Failed to parse MCP tool arguments:', e)
        }
      }
      
      tools.push({
        type: 'function',
        function: {
          name,
          description,
          parameters
        }
      })
    }
    
    console.log(`[Forwarder] Total MCP tools extracted: ${tools.length}`)
    return tools
  }

  /**
   * Generate tool prompt in specified format
   */
  private generateToolPrompt(tools: ChatCompletionTool[], format: 'bracket' | 'xml'): string {
    const toolDefinitions = tools.map(tool => {
      const params = tool.function.parameters
        ? JSON.stringify(tool.function.parameters)
        : '{}'
      return `Tool \`${tool.function.name}\`: ${tool.function.description || 'No description'}. Arguments JSON schema: ${params}`
    }).join('\n')

    if (format === 'xml') {
      return `## Available Tools
You can invoke the following developer tools. Call a tool only when it is required and follow the JSON schema exactly when providing arguments.

${toolDefinitions}

## Tool Call Protocol
When you decide to call a tool, respond with:
<tool_use>
  <name>exact_tool_name</name>
  <arguments>{"arg": "value"}</arguments>
</tool_use>`
    }

    return `## Available Tools
You can invoke the following developer tools. Call a tool only when it is required and follow the JSON schema exactly when providing arguments.

CRITICAL: Tool names are CASE-SENSITIVE. You MUST use the exact tool name as defined below.

${toolDefinitions}

## Tool Call Protocol
When you decide to call a tool, you MUST respond with NOTHING except a single [function_calls] block exactly like the template below:

[function_calls]
[call:exact_tool_name_from_list]{"argument": "value"}[/call]
[/function_calls]

CRITICAL RULES:
1. EVERY tool call MUST start with [call:exact_tool_name] and end with [/call]
2. The content between [call:...] and [/call] MUST be a raw JSON object on ONE LINE
3. Do NOT output any other text before or after the [function_calls] block`
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
      // BUT keep the system message (which contains tool definitions)
      let modifiedRequest = request
      if (sessionContext.isNew && request.messages && request.messages.length > 0) {
        const systemMessage = request.messages.find(m => m.role === 'system')
        const lastUserMessage = request.messages[request.messages.length - 1]
        const newMessages: any[] = []
        
        if (systemMessage) {
          newMessages.push(systemMessage)
        }
        newMessages.push(lastUserMessage)
        
        modifiedRequest = {
          ...request,
          messages: newMessages
        }
        console.log('[Forwarder] New session detected, sending system message + last user message')
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

    // Check if it is a Perplexity provider, use dedicated adapter
    if (PerplexityAdapter.isPerplexityProvider(provider)) {
      return this.forwardPerplexity(request, account, provider, actualModel, startTime, sessionContext)
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

      // Update parent message ID for non-stream response
      const responseId = handler.getResponseId()
      if (responseId && sessionContext.sessionId) {
        sessionManager.updateParentMessageId(sessionContext.sessionId, responseId)
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
      
      if (request.stream === true) {
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

      if (request.stream === true && stream) {
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
   * Perplexity Dedicated Forward
   * Uses Electron's net API to bypass Cloudflare protection
   */
  private async forwardPerplexity(
    request: ChatCompletionRequest,
    account: Account,
    provider: Provider,
    actualModel: string,
    startTime: number,
    sessionContext: { sessionId: string; providerSessionId?: string; parentMessageId?: string; messages: any[]; isNew: boolean }
  ): Promise<ForwardResult> {
    console.log('[forwardPerplexity] actualModel:', actualModel)
    try {
      const transformed = this.transformRequestForPromptToolUse(request, provider)
      
      const adapter = new PerplexityAdapter(provider, account)
      
      const isMultiTurn = sessionManager.isMultiTurnEnabled() && sessionContext && !sessionContext.isNew
      
      const { stream, sessionId } = await adapter.chatCompletion({
        model: actualModel,
        messages: transformed.messages as any,
        stream: request.stream,
        temperature: request.temperature,
        isMultiTurn,
        sessionId: sessionContext?.providerSessionId,
      })

      const latency = Date.now() - startTime

      if (request.stream === true) {
        const deleteSessionCallback = shouldDeleteSession()
          ? async () => {
              try {
                await adapter.deleteSession(sessionId)
              } catch (error) {
                console.error('[Perplexity] Failed to delete session:', error)
              }
            }
          : undefined

        const handler = new PerplexityStreamHandler(actualModel, sessionId, deleteSessionCallback, adapter)
        const transformedStream = await handler.handleStream(stream)
        
        return {
          success: true,
          status: 200,
          headers: {},
          stream: transformedStream as any,
          skipTransform: true,
          latency,
          providerSessionId: sessionId,
        }
      }

      const handler = new PerplexityStreamHandler(actualModel, sessionId, undefined, adapter)
      const result = await handler.handleNonStream(stream)
      
      // Parse tool calls from response content if tools were provided
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
        await adapter.deleteSession(sessionId)
      }
      
      return {
        success: true,
        status: 200,
        headers: {},
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
