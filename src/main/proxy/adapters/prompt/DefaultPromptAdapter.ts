/**
 * Default Prompt Adapter
 * Maintains backward compatibility with existing tool prompt injection logic
 * 
 * Uses variants from prompt/variants/ directory for unified variant definitions
 */

import { ChatMessage, ChatCompletionTool, ToolCall } from '../../types'
import { BasePromptAdapter, PromptVariant, TransformResult, ParseResult, ToolCallFormat } from './BasePromptAdapter'
import { ClientType } from '../../utils/promptSignatures'
import { parseToolCallsFromText } from '../../utils/toolParser'
import { TOOL_PROMPT_SIGNATURES, hasGeneralToolPromptSignature } from '../../constants/signatures'
import { DEFAULT_VARIANT, XML_VARIANT } from '../../prompt/variants'

/**
 * Default Prompt Adapter
 * Implements the current tool prompt injection behavior
 */
export class DefaultPromptAdapter extends BasePromptAdapter {
  name = 'default'
  clientType: ClientType = 'unknown'
  
  detectSignatures = TOOL_PROMPT_SIGNATURES.general

  constructor() {
    super()
    this.registerVariant(DEFAULT_VARIANT)
    this.registerVariant(XML_VARIANT)
  }

  hasPromptInjected(messages: ChatMessage[]): boolean {
    const allContent = this.extractAllContent(messages)
    
    if (hasGeneralToolPromptSignature(allContent)) {
      console.log('[DefaultAdapter] Detected existing tool prompt injection, skipping')
      return true
    }
    
    return false
  }

  toolsToPrompt(tools: ChatCompletionTool[], variant?: PromptVariant): string {
    if (!tools || tools.length === 0) {
      return ''
    }

    const toolDefinitions = tools.map(tool => {
      const params = tool.function.parameters
        ? JSON.stringify(tool.function.parameters)
        : '{}'

      return `Tool \`${tool.function.name}\`: ${tool.function.description || 'No description'}. Arguments JSON schema: ${params}`
    }).join('\n')

    const template = variant?.toolPromptTemplate || DEFAULT_VARIANT.toolPromptTemplate
    return template.replace('{{TOOL_DEFINITIONS}}', toolDefinitions)
  }

  parseToolCalls(content: string): ParseResult {
    if (content.includes('<tool_use>')) {
      return {
        content,
        toolCalls: this.parseXmlToolCalls(content),
        format: 'xml' as ToolCallFormat,
      }
    }

    const { toolCalls } = parseToolCallsFromText(content, 'default')
    
    return {
      content,
      toolCalls: toolCalls.map(tc => ({
        index: tc.index,
        id: tc.id,
        type: tc.type,
        function: tc.function,
      })),
      format: 'bracket' as ToolCallFormat,
    }
  }

  private parseXmlToolCalls(content: string): ToolCall[] {
    const toolCalls: ToolCall[] = []
    
    const toolUseRegex = /<tool_use>\s*<name>([^<]+)<\/name>\s*<arguments>([\s\S]*?)<\/arguments>\s*<\/tool_use>/g
    
    let match
    let index = 0
    
    while ((match = toolUseRegex.exec(content)) !== null) {
      const name = match[1].trim()
      let argsStr = match[2].trim()
      
      if (argsStr.startsWith('```')) {
        argsStr = argsStr.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')
      }
      
      try {
        const parsed = JSON.parse(argsStr)
        toolCalls.push({
          index: index++,
          id: `call_${Date.now()}_${index}`,
          type: 'function',
          function: {
            name,
            arguments: JSON.stringify(parsed),
          },
        })
      } catch {
        console.warn('[DefaultAdapter] Failed to parse XML tool arguments:', argsStr)
      }
    }
    
    return toolCalls
  }

  getPromptVariant(model: string, _provider?: string): PromptVariant | null {
    return DEFAULT_VARIANT
  }

  getVariantByFormat(format: 'bracket' | 'xml'): PromptVariant {
    return format === 'xml' ? XML_VARIANT : DEFAULT_VARIANT
  }

  transformRequest(
    messages: ChatMessage[],
    tools: ChatCompletionTool[] | undefined,
    model: string,
    _provider?: string
  ): TransformResult {
    if (!tools || tools.length === 0) {
      return { messages, tools: undefined, injected: false }
    }

    if (this.hasPromptInjected(messages)) {
      return { messages, tools: undefined, injected: false }
    }

    const variant = this.getPromptVariant(model)
    const toolsPrompt = this.toolsToPrompt(tools, variant ?? undefined)
    const transformedMessages = this.injectPrompt(messages, toolsPrompt)

    return {
      messages: transformedMessages,
      tools: undefined,
      injected: true,
      variant: variant ?? undefined,
    }
  }

  transformRequestWithFormat(
    messages: ChatMessage[],
    tools: ChatCompletionTool[] | undefined,
    model: string,
    format: 'bracket' | 'xml',
    _provider?: string,
    skipDetection: boolean = false
  ): TransformResult {
    if (!tools || tools.length === 0) {
      console.log('[DefaultAdapter] No tools to inject')
      return { messages, tools: undefined, injected: false }
    }

    if (!skipDetection && this.hasPromptInjected(messages)) {
      console.log('[DefaultAdapter] Detected existing prompt, skipping injection')
      return { messages, tools: undefined, injected: false }
    }

    const variant = this.getVariantByFormat(format)
    console.log(`[DefaultAdapter] Injecting ${format} format prompt, variant=${variant.id}`)
    const toolsPrompt = this.toolsToPrompt(tools, variant)
    console.log(`[DefaultAdapter] Tools prompt length: ${toolsPrompt.length}`)
    const transformedMessages = this.injectPrompt(messages, toolsPrompt)
    console.log(`[DefaultAdapter] Transformed ${transformedMessages.length} messages`)

    return {
      messages: transformedMessages,
      tools: undefined,
      injected: true,
      variant,
    }
  }
}

export const defaultPromptAdapter = new DefaultPromptAdapter()
