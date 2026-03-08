/**
 * Prompt Adapter Registry
 * Central registry for managing prompt adapters
 */

import { ChatMessage, ChatCompletionTool, ToolCall } from '../../types'
import { PromptAdapter, PromptVariant, TransformResult, ParseResult } from './BasePromptAdapter'
import { DefaultPromptAdapter, defaultPromptAdapter } from './DefaultPromptAdapter'
import { CherryStudioPromptAdapter, cherryStudioPromptAdapter } from './CherryStudioPromptAdapter'
import { KiloCodePromptAdapter, kiloCodePromptAdapter } from './KiloCodePromptAdapter'
import { detectClientPromptType, ClientType, hasAnyToolPromptInjected } from '../../utils/promptSignatures'

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
   * Unregister a prompt adapter
   */
  unregister(name: string): boolean {
    return this.adapters.delete(name)
  }

  /**
   * Get adapter by name
   */
  getAdapter(name: string): PromptAdapter | undefined {
    return this.adapters.get(name)
  }

  /**
   * Get all registered adapters
   */
  getAllAdapters(): PromptAdapter[] {
    return Array.from(this.adapters.values())
  }

  /**
   * Detect which client has injected the prompt
   * Returns the most appropriate adapter
   */
  detect(messages: ChatMessage[]): PromptAdapter | null {
    const detectionResult = detectClientPromptType(messages)
    
    if (detectionResult.clientType === 'unknown') {
      return null
    }

    const adapter = this.findAdapterByClientType(detectionResult.clientType)
    
    if (adapter) {
      console.log(`[PromptAdapterRegistry] Detected client: ${detectionResult.clientType} (confidence: ${detectionResult.confidence.toFixed(2)})`)
    }
    
    return adapter
  }

  /**
   * Check if any known client has injected the prompt
   */
  hasPromptInjected(messages: ChatMessage[]): boolean {
    return hasAnyToolPromptInjected(messages)
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

    console.log('[PromptAdapterRegistry] Using default adapter')
    return this.defaultAdapter.transformRequest(messages, tools, model, provider)
  }

  /**
   * Parse tool calls using appropriate adapter
   */
  parseToolCalls(content: string, adapterName?: string): ParseResult {
    const adapter = adapterName 
      ? this.adapters.get(adapterName) 
      : this.detectAdapterFromContent(content)

    if (adapter) {
      return adapter.parseToolCalls(content)
    }

    return this.defaultAdapter.parseToolCalls(content)
  }

  /**
   * Get prompt variant for a specific model
   */
  getPromptVariant(model: string, provider?: string, adapterName?: string): PromptVariant | null {
    const adapter = adapterName 
      ? this.adapters.get(adapterName) 
      : this.defaultAdapter

    return adapter?.getPromptVariant(model, provider) || null
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
}

export const promptAdapterRegistry = new PromptAdapterRegistry()
