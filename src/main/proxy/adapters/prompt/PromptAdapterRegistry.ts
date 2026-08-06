/**
 * Prompt Adapter Registry
 * Central registry for managing prompt adapters
 * Simplified to focus on adapter registration and lookup
 */

import { ChatMessage, ChatCompletionTool } from '../../types'
import { PromptAdapter, PromptVariant, TransformResult, ParseResult } from './BasePromptAdapter'
import { DefaultPromptAdapter, defaultPromptAdapter } from './DefaultPromptAdapter'
import { CherryStudioPromptAdapter, cherryStudioPromptAdapter } from './CherryStudioPromptAdapter'
import { KiloCodePromptAdapter, kiloCodePromptAdapter } from './KiloCodePromptAdapter'
import { detectClientPromptType, ClientType, hasAnyToolPromptInjected } from '../../utils/promptSignatures'
import { hasGeneralToolPromptSignature } from '../../constants/signatures'

/**
 * Registry for prompt adapters
 * Manages adapter registration, detection, and selection
 */
export class PromptAdapterRegistry {
  private adapters: Map<string, PromptAdapter> = new Map()
  private defaultAdapter: PromptAdapter

  constructor() {
    this.defaultAdapter = defaultPromptAdapter
    this.register(defaultPromptAdapter)
    this.register(cherryStudioPromptAdapter)
    this.register(kiloCodePromptAdapter)
  }

  /**
   * Register a prompt adapter
   */
  register(adapter: PromptAdapter): void {
    this.adapters.set(adapter.name, adapter)
    console.log(`[PromptAdapterRegistry] Registered adapter: ${adapter.name}`)
  }

  /**
   * Get adapter by name
   */
  get(name: string): PromptAdapter | undefined {
    return this.adapters.get(name)
  }

  /**
   * Get all registered adapters
   */
  getAll(): PromptAdapter[] {
    return Array.from(this.adapters.values())
  }

  /**
   * Check if any prompt has been injected
   * Uses unified signature detection
   */
  hasPromptInjected(messages: ChatMessage[]): boolean {
    const allContent = this.extractAllContent(messages)
    return hasGeneralToolPromptSignature(allContent)
  }

  /**
   * Detect client type from messages
   */
  detectClient(messages: ChatMessage[]): ClientType {
    const result = detectClientPromptType(messages)
    return result.clientType
  }

  /**
   * Transform request using appropriate adapter
   */
  transformRequest(
    messages: ChatMessage[],
    tools: ChatCompletionTool[] | undefined,
    model: string,
    provider?: string
  ): TransformResult {
    if (!tools || tools.length === 0) {
      return { messages, tools: undefined, injected: false }
    }

    const detectedAdapter = this.detect(messages)
    
    if (detectedAdapter) {
      console.log(`[PromptAdapterRegistry] Using detected adapter: ${detectedAdapter.name}`)
      return detectedAdapter.transformRequest(messages, tools, model, provider)
    }
    
    return this.defaultAdapter.transformRequest(messages, tools, model, provider)
  }

  /**
   * Transform request with specific format
   * Used by PromptInjectionService for controlled injection
   */
  transformRequestWithFormat(
    messages: ChatMessage[],
    tools: ChatCompletionTool[] | undefined,
    model: string,
    format: 'bracket' | 'xml',
    provider?: string,
    skipDetection: boolean = false
  ): TransformResult {
    if (!tools || tools.length === 0) {
      return { messages, tools: undefined, injected: false }
    }

    if (this.defaultAdapter instanceof DefaultPromptAdapter) {
      return this.defaultAdapter.transformRequestWithFormat(messages, tools, model, format, provider, skipDetection)
    }

    return this.defaultAdapter.transformRequest(messages, tools, model, provider)
  }

  /**
   * Parse tool calls from response content
   */
  parseToolCalls(content: string, adapterName?: string): ParseResult {
    const adapter = adapterName ? this.adapters.get(adapterName) : this.detectAdapterFromContent(content)
    
    if (adapter) {
      return adapter.parseToolCalls(content)
    }
    
    return this.defaultAdapter.parseToolCalls(content)
  }

  /**
   * Get prompt variant for model
   */
  getPromptVariant(model: string, provider?: string): PromptVariant | null {
    return this.defaultAdapter.getPromptVariant(model, provider)
  }

  /**
   * Detect adapter from messages
   */
  private detect(messages: ChatMessage[]): PromptAdapter | undefined {
    const clientType = this.detectClient(messages)
    
    if (clientType !== 'unknown') {
      const adapter = this.findAdapterByClientType(clientType)
      if (adapter) {
        return adapter
      }
    }
    
    return undefined
  }

  /**
   * Find adapter by client type
   */
  private findAdapterByClientType(clientType: ClientType): PromptAdapter | undefined {
    for (const adapter of this.adapters.values()) {
      if (adapter.clientType === clientType) {
        return adapter
      }
    }
    return undefined
  }

  /**
   * Detect adapter from response content
   */
  private detectAdapterFromContent(content: string): PromptAdapter | undefined {
    if (content.includes('<tool_use>')) {
      return this.adapters.get('cherryStudio')
    }
    
    if (content.includes('[function_calls]')) {
      return this.defaultAdapter
    }

    if (content.includes('<antml:function_calls>')) {
      return undefined
    }

    return undefined
  }

  /**
   * Extract all text content from messages
   */
  private extractAllContent(messages: ChatMessage[]): string {
    const parts: string[] = []

    for (const msg of messages) {
      if (msg.role === 'system' || msg.role === 'user' || msg.role === 'assistant') {
        if (typeof msg.content === 'string') {
          parts.push(msg.content)
        } else if (Array.isArray(msg.content)) {
          for (const part of msg.content) {
            if (typeof part === 'string') {
              parts.push(part)
            } else if (part && typeof part === 'object' && 'text' in part) {
              parts.push(part.text)
            }
          }
        }
      }
    }

    return parts.join('\n')
  }
}

export const promptAdapterRegistry = new PromptAdapterRegistry()
