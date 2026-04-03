/**
 * Prompt Injection Service
 * Single entry point for all tool prompt injection logic
 * 
 * Responsibilities:
 * 1. Read configuration
 * 2. Detect client and tool source
 * 3. Decide whether to inject based on mode
 * 4. Generate and inject prompt
 */

import { ChatMessage, ChatCompletionTool } from '../types'
import { storeManager } from '../../store/store'
import { PromptGenerator, ProtocolFormat } from './promptGenerator'
import {
  detectClient,
  hasToolPromptInjected,
  cleanToolPrompts,
  ClientDetectionResult,
} from '../utils/clientDetector'

/**
 * Injection mode type (simplified)
 */
export type InjectionMode = 'auto' | 'always' | 'never'

/**
 * Injection result
 */
export interface InjectionResult {
  messages: ChatMessage[]
  injected: boolean
  tools: ChatCompletionTool[] | null
  shouldParseToolCalls: boolean
  reason?: string
}

/**
 * Injection configuration
 */
interface InjectionConfig {
  mode: InjectionMode
  defaultFormat: ProtocolFormat
  customPromptTemplate?: string
  enableToolCallParsing: boolean
}

/**
 * Default configuration
 */
const DEFAULT_CONFIG: InjectionConfig = {
  mode: 'auto',
  defaultFormat: 'bracket',
  customPromptTemplate: undefined,
  enableToolCallParsing: true,
}

/**
 * Generate generic tool call protocol prompt
 * Used when we have MCP tools but no OpenAI tools
 */
function generateGenericToolCallPrompt(format: ProtocolFormat): string {
  if (format === 'xml') {
    return `## Tool Call Protocol
When you decide to call a tool, you MUST respond with NOTHING except a single <tool_use> block exactly like the template below:

<tool_use>
  <name>exact_tool_name_from_list</name>
  <arguments>{"argument": "value"}</arguments>
</tool_use>

CRITICAL RULES:
1. You MUST use the EXACT tool name as defined in the Available Tools list
2. The content inside <arguments> MUST be a raw JSON object
3. Do NOT wrap JSON in \`\`\`json blocks
4. Do NOT output any other text, explanation, or reasoning before or after the <tool_use> block
5. If you need to call multiple tools, output multiple <tool_use> blocks sequentially
6. JSON arguments MUST be valid JSON format

When you receive a tool result, it will be in the format:
[TOOL_RESULT for call_id] result_content`
  }

  return `## Tool Call Protocol
When you decide to call a tool, you MUST respond with NOTHING except a single [function_calls] block exactly like the template below:

[function_calls]
[call:exact_tool_name_from_list]{"argument": "value"}[/call]
[/function_calls]

CRITICAL RULES:
1. EVERY tool call MUST start with [call:exact_tool_name] and end with [/call]
2. You MUST use the EXACT tool name as defined in the Available Tools list
3. The content between [call:...] and [/call] MUST be a raw JSON object on ONE LINE - NO LINE BREAKS inside the JSON
4. Do NOT wrap JSON in \`\`\`json blocks
5. Do NOT output any other text, explanation, or reasoning before or after the [function_calls] block
6. If you need to call multiple tools, put them all inside the same [function_calls] block, each with its own [call:...]...[/call] wrapper
7. JSON arguments MUST be compact, all on one line, NO pretty printing, NO newlines

When you receive a tool result, it will be in the format:
[TOOL_RESULT for call_id] result_content`
}

/**
 * Prompt Injection Service
 */
export class PromptInjectionService {
  /**
   * Process messages and inject tool prompt if needed
   * This is the SINGLE ENTRY POINT for all injection logic
   */
  process(
    messages: ChatMessage[],
    tools: ChatCompletionTool[],
    model: string,
    provider?: string
  ): InjectionResult {
    const config = this.getConfig()

    console.log(`[PromptInjectionService] Processing: mode=${config.mode}, format=${config.defaultFormat}, tools=${tools?.length || 0}`)

    // Detect client and tool source
    const detection = detectClient(messages, tools)

    console.log(`[PromptInjectionService] Detection: client=${detection.clientType}, toolSource=${detection.toolSource}, isKnownClient=${detection.isKnownClient}`)

    // Decide whether to inject
    const decision = this.shouldInject(detection, config)

    if (!decision.shouldInject) {
      console.log(`[PromptInjectionService] Skip injection: ${decision.reason}`)
      return {
        messages,
        injected: false,
        tools: detection.tools,
        shouldParseToolCalls: config.enableToolCallParsing && detection.toolSource !== 'none',
        reason: decision.reason,
      }
    }

    // Generate prompt
    const prompt = this.generatePrompt(messages, detection, config, provider)

    if (!prompt) {
      console.log('[PromptInjectionService] No prompt generated')
      return {
        messages,
        injected: false,
        tools: detection.tools,
        shouldParseToolCalls: config.enableToolCallParsing && detection.toolSource !== 'none',
        reason: 'no_prompt',
      }
    }

    // Inject prompt to messages
    const injectedMessages = this.injectToMessages(messages, prompt)

    console.log('[PromptInjectionService] Injection complete')
    return {
      messages: injectedMessages,
      injected: true,
      tools: detection.tools,
      shouldParseToolCalls: true,
    }
  }

  /**
   * Get configuration from store
   */
  private getConfig(): InjectionConfig {
    const storeConfig = storeManager.getConfig()
    const toolConfig = storeConfig.toolPromptConfig

    return {
      mode: (toolConfig?.mode as InjectionMode) || DEFAULT_CONFIG.mode,
      defaultFormat: (toolConfig?.defaultFormat as ProtocolFormat) || DEFAULT_CONFIG.defaultFormat,
      customPromptTemplate: toolConfig?.customPromptTemplate,
      enableToolCallParsing: toolConfig?.enableToolCallParsing ?? DEFAULT_CONFIG.enableToolCallParsing,
    }
  }

  /**
   * Decide whether to inject
   * Simplified logic based on mode
   */
  private shouldInject(
    detection: ClientDetectionResult,
    config: InjectionConfig
  ): { shouldInject: boolean; reason: string } {
    // Mode: never
    if (config.mode === 'never') {
      return { shouldInject: false, reason: 'mode_never' }
    }

    // No tools at all
    if (detection.toolSource === 'none') {
      return { shouldInject: false, reason: 'no_tools' }
    }

    // Mode: always - always inject
    if (config.mode === 'always') {
      return { shouldInject: true, reason: 'mode_always' }
    }

    // Mode: auto - detect client
    if (config.mode === 'auto') {
      // Known client - skip injection (client already injected)
      if (detection.isKnownClient) {
        return { shouldInject: false, reason: `known_client_${detection.clientType}` }
      }

      // Unknown client with existing injection - skip
      if (detection.injectsPrompt) {
        return { shouldInject: false, reason: 'existing_injection' }
      }

      // Unknown client - inject
      return { shouldInject: true, reason: 'auto_unknown_client' }
    }

    // Default: inject if has tools
    return { shouldInject: true, reason: 'default' }
  }

  /**
   * Generate prompt based on detection result
   */
  private generatePrompt(
    messages: ChatMessage[],
    detection: ClientDetectionResult,
    config: InjectionConfig,
    provider?: string
  ): string {
    // Has OpenAI tools - generate full prompt
    if (detection.toolSource === 'openai' && detection.tools) {
      return PromptGenerator.generate(detection.tools, {
        format: config.defaultFormat,
        customTemplate: config.customPromptTemplate,
        provider,
      })
    }

    // Has MCP tools only - generate protocol prompt
    if (detection.toolSource === 'mcp') {
      // For Perplexity, generate specialized prompt
      if (provider === 'perplexity') {
        return this.generatePerplexityPromptFromMCP(messages, detection.tools || [], config)
      }

      // For other providers, generate generic protocol prompt
      // The MCP tool definitions are already in the system message
      return generateGenericToolCallPrompt(config.defaultFormat)
    }

    return ''
  }

  /**
   * Generate Perplexity-specific prompt from MCP tool definitions
   */
  private generatePerplexityPromptFromMCP(
    messages: ChatMessage[],
    tools: ChatCompletionTool[],
    config: InjectionConfig
  ): string {
    if (tools.length === 0) {
      return generateGenericToolCallPrompt(config.defaultFormat)
    }

    return PromptGenerator.generate(tools, {
      format: 'xml', // Perplexity always uses XML
      customTemplate: config.customPromptTemplate,
      provider: 'perplexity',
    })
  }

  /**
   * Inject prompt to messages
   */
  private injectToMessages(messages: ChatMessage[], prompt: string): ChatMessage[] {
    if (!prompt) {
      return messages
    }

    const result: ChatMessage[] = []
    let systemInjected = false

    for (const msg of messages) {
      if (msg.role === 'system' && !systemInjected) {
        const enhancedContent =
          typeof msg.content === 'string' ? `${msg.content}\n\n${prompt}` : msg.content
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
}

/**
 * Singleton instance
 */
export const promptInjectionService = new PromptInjectionService()
