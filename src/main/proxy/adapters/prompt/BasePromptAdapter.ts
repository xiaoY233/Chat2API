/**
 * Prompt Adapter Module - Base Interface and Types
 * Provides abstraction for different client prompt formats
 */

import { ChatMessage, ChatCompletionTool, ToolCall } from '../../types'
import { ClientType } from '../../utils/promptSignatures'

/**
 * Tool call output format
 */
export type ToolCallFormat = 'bracket' | 'xml' | 'anthropic' | 'json' | 'native'

/**
 * Prompt variant configuration
 */
export interface PromptVariant {
  id: string
  name: string
  description?: string
  modelPatterns: string[]
  systemPrompt: string
  toolPromptTemplate: string
  toolCallFormat: ToolCallFormat
  examples?: string[]
}

/**
 * Result of prompt transformation
 */
export interface TransformResult {
  messages: ChatMessage[]
  tools: ChatCompletionTool[] | undefined
  injected: boolean
  variant?: PromptVariant
}

/**
 * Result of tool call parsing
 */
export interface ParseResult {
  content: string
  toolCalls: ToolCall[]
  format: ToolCallFormat
}

/**
 * Base interface for prompt adapters
 */
export interface PromptAdapter {
  name: string
  clientType: ClientType
  detectSignatures: string[]

  hasPromptInjected(messages: ChatMessage[]): boolean
  toolsToPrompt(tools: ChatCompletionTool[], variant?: PromptVariant): string
  parseToolCalls(content: string): ParseResult
  getPromptVariant(model: string, provider?: string): PromptVariant | null
  transformRequest(
    messages: ChatMessage[],
    tools: ChatCompletionTool[] | undefined,
    model: string,
    provider?: string
  ): TransformResult
}

/**
 * Abstract base class for prompt adapters
 */
export abstract class BasePromptAdapter implements PromptAdapter {
  abstract name: string
  abstract clientType: ClientType
  abstract detectSignatures: string[]

  protected variants: PromptVariant[] = []

  hasPromptInjected(messages: ChatMessage[]): boolean {
    const allContent = this.extractAllContent(messages)
    
    for (const sig of this.detectSignatures) {
      if (allContent.includes(sig)) {
        console.log(`[${this.name}] Detected existing prompt injection with signature: ${sig}`)
        return true
      }
    }
    
    return false
  }

  abstract toolsToPrompt(tools: ChatCompletionTool[], variant?: PromptVariant): string
  abstract parseToolCalls(content: string): ParseResult

  getPromptVariant(model: string, provider?: string): PromptVariant | null {
    const lowerModel = model.toLowerCase()
    
    for (const variant of this.variants) {
      for (const pattern of variant.modelPatterns) {
        if (lowerModel.includes(pattern.toLowerCase())) {
          return variant
        }
      }
    }
    
    return null
  }

  transformRequest(
    messages: ChatMessage[],
    tools: ChatCompletionTool[] | undefined,
    model: string,
    provider?: string
  ): TransformResult {
    if (!tools || tools.length === 0) {
      return { messages, tools: undefined, injected: false }
    }

    if (this.hasPromptInjected(messages)) {
      return { messages, tools: undefined, injected: false }
    }

    const variant = this.getPromptVariant(model, provider)
    const toolsPrompt = this.toolsToPrompt(tools, variant)
    
    const transformedMessages = this.injectPrompt(messages, toolsPrompt)

    return {
      messages: transformedMessages,
      tools: undefined,
      injected: true,
      variant,
    }
  }

  protected injectPrompt(messages: ChatMessage[], prompt: string): ChatMessage[] {
    const result: ChatMessage[] = []
    let systemInjected = false

    for (const msg of messages) {
      if (msg.role === 'system' && !systemInjected) {
        const enhancedContent = typeof msg.content === 'string'
          ? `${msg.content}\n\n${prompt}`
          : msg.content
        result.push({ ...msg, content: enhancedContent })
        systemInjected = true
      } else {
        result.push(msg)
      }
    }

    if (!systemInjected) {
      result.unshift({ role: 'system', content: prompt })
    }

    return result
  }

  protected extractAllContent(messages: ChatMessage[]): string {
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

  protected registerVariant(variant: PromptVariant): void {
    this.variants.push(variant)
  }
}
