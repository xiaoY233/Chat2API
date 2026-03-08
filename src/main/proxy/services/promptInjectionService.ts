/**
 * Prompt Injection Service
 * Central service for managing tool prompt injection and parsing
 */

import { ChatMessage, ChatCompletionTool, ToolCall } from '../types'
import { promptAdapterRegistry } from '../adapters/prompt'
import { parseToolCallsUnified, detectToolCallFormat, ToolCallFormat } from '../utils/unifiedToolParser'
import { detectClientPromptType, hasAnyToolPromptInjected, ClientType } from '../utils/promptSignatures'
import { storeManager } from '../../store/store'

/**
 * Injection configuration
 */
export interface InjectionConfig {
  mode: 'always' | 'smart' | 'never' | 'auto'
  smartThreshold: number
  keywords: string[]
  clientDetection: boolean
  skipKnownClients: string[]
}

/**
 * Default injection configuration
 */
export const DEFAULT_INJECTION_CONFIG: InjectionConfig = {
  mode: 'smart',
  smartThreshold: 50,
  keywords: ['search', 'find', 'get', 'call', 'use', 'tool', 'query', 'fetch', 'read', 'write', 'list', 'delete', 'update', 'create'],
  clientDetection: true,
  skipKnownClients: ['cline', 'kilocode', 'rooCode', 'vscodeCopilot', 'cherryStudio'],
}

/**
 * Prompt Injection Service
 * Handles tool prompt injection and response parsing
 */
export class PromptInjectionService {
  private config: InjectionConfig

  constructor(config: Partial<InjectionConfig> = {}) {
    this.config = { ...DEFAULT_INJECTION_CONFIG, ...config }
  }

  /**
   * Update configuration
   */
  updateConfig(config: Partial<InjectionConfig>): void {
    this.config = { ...this.config, ...config }
  }

  /**
   * Get current configuration
   */
  getConfig(): InjectionConfig {
    return { ...this.config }
  }

  /**
   * Check if tool prompt should be injected
   */
  shouldInject(
    messages: ChatMessage[],
    tools: ChatCompletionTool[] | undefined,
    model: string
  ): boolean {
    if (!tools || tools.length === 0) {
      return false
    }

    if (this.config.mode === 'never') {
      console.log('[PromptInjectionService] Injection disabled (mode=never)')
      return false
    }

    if (this.config.clientDetection && this.shouldSkipForClient(messages)) {
      console.log('[PromptInjectionService] Skipping injection for known client')
      return false
    }

    if (this.config.mode === 'always') {
      return true
    }

    if (this.config.mode === 'smart') {
      return this.isComplexQuery(messages)
    }

    return true
  }

  /**
   * Inject tool prompt into messages
   */
  inject(
    messages: ChatMessage[],
    tools: ChatCompletionTool[],
    model: string,
    provider?: string
  ): { messages: ChatMessage[]; injected: boolean } {
    if (!this.shouldInject(messages, tools, model)) {
      return { messages, injected: false }
    }

    const result = promptAdapterRegistry.transformRequest(messages, tools, model, provider)

    console.log(`[PromptInjectionService] Injection result: injected=${result.injected}`)

    return {
      messages: result.messages,
      injected: result.injected,
    }
  }

  /**
   * Parse tool calls from response content
   */
  parseResponse(content: string): { content: string; toolCalls: ToolCall[]; format: ToolCallFormat } {
    const result = parseToolCallsUnified(content)
    
    if (result.toolCalls.length > 0) {
      console.log(`[PromptInjectionService] Parsed ${result.toolCalls.length} tool calls (format: ${result.format})`)
    }

    return {
      content: result.content,
      toolCalls: result.toolCalls,
      format: result.format,
    }
  }

  /**
   * Detect client type from messages
   */
  detectClient(messages: ChatMessage[]): ClientType {
    const result = detectClientPromptType(messages)
    return result.clientType
  }

  /**
   * Check if injection should be skipped for detected client
   */
  private shouldSkipForClient(messages: ChatMessage[]): boolean {
    const detectionResult = detectClientPromptType(messages)
    
    if (detectionResult.clientType === 'unknown') {
      return false
    }

    if (this.config.skipKnownClients.includes(detectionResult.clientType)) {
      console.log(`[PromptInjectionService] Detected client: ${detectionResult.clientType}, skipping injection`)
      return true
    }

    return false
  }

  /**
   * Check if the query is complex enough to warrant tool prompt injection
   */
  private isComplexQuery(messages: ChatMessage[]): boolean {
    const lastUserMsg = [...messages].reverse().find(m => m.role === 'user')
    if (!lastUserMsg) return false

    const content = typeof lastUserMsg.content === 'string' 
      ? lastUserMsg.content 
      : ''

    if (content.length > this.config.smartThreshold) {
      return true
    }

    const lowerContent = content.toLowerCase()
    for (const keyword of this.config.keywords) {
      if (lowerContent.includes(keyword.toLowerCase())) {
        return true
      }
    }

    if (content.includes('?') || content.includes('？')) {
      return true
    }

    if (content.includes('```') || content.includes('code')) {
      return true
    }

    const actionPatterns = [
      /help me (\w+)/i,
      /can you (\w+)/i,
      /please (\w+)/i,
      /i need to (\w+)/i,
      /i want to (\w+)/i,
    ]

    for (const pattern of actionPatterns) {
      if (pattern.test(content)) {
        return true
      }
    }

    return false
  }
}

/**
 * Create prompt injection service from store config
 */
export function createPromptInjectionService(): PromptInjectionService {
  const config = storeManager.getConfig()
  
  return new PromptInjectionService({
    mode: config.toolPromptConfig?.mode || 'smart',
    smartThreshold: config.toolPromptConfig?.smartThreshold || 50,
    keywords: config.toolPromptConfig?.keywords || DEFAULT_INJECTION_CONFIG.keywords,
    clientDetection: true,
    skipKnownClients: ['cline', 'kilocode', 'rooCode', 'vscodeCopilot', 'cherryStudio'],
  })
}

export const promptInjectionService = createPromptInjectionService()
