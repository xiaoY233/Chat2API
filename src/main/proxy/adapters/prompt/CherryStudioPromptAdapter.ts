/**
 * Cherry Studio Prompt Adapter
 * Handles prompt detection and transformation for Cherry Studio client
 */

import { ChatMessage, ChatCompletionTool, ToolCall } from '../../types'
import { BasePromptAdapter, PromptVariant, TransformResult, ParseResult, ToolCallFormat } from './BasePromptAdapter'
import { ClientType } from '../../utils/promptSignatures'
import { parseToolCallsFromText } from '../../utils/toolParser'

/**
 * Cherry Studio prompt variant
 */
const CHERRY_STUDIO_VARIANT: PromptVariant = {
  id: 'cherry-studio',
  name: 'Cherry Studio',
  description: 'Prompt variant for Cherry Studio client',
  modelPatterns: ['.*'],
  systemPrompt: 'You are a helpful AI assistant.',
  toolPromptTemplate: `## Available Tools
You can invoke the following developer tools. Call a tool only when it is required and follow the JSON schema exactly when providing arguments.

CRITICAL: Tool names are CASE-SENSITIVE. You MUST use the exact tool name as defined below, including any prefixes like 'default_api:'.

{{TOOL_DEFINITIONS}}

## Tool Call Protocol
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
8. If you are writing code or regular expressions, you MUST properly escape all backslashes and quotes inside the JSON string.

When you receive a tool result, it will be in the format:
[TOOL_RESULT for call_id] result_content`,
  toolCallFormat: 'bracket',
}

/**
 * Cherry Studio Prompt Adapter
 * Supports both bracket format and XML format tool calls
 */
export class CherryStudioPromptAdapter extends BasePromptAdapter {
  name = 'cherryStudio'
  clientType: ClientType = 'cherryStudio'
  detectSignatures: string[] = [
    '## Available Tools',
    'Tool Call Protocol',
    '[function_calls]',
    '<tool_use>',
    'TOOL_WRAP_HINT',
    'You can invoke the following developer tools',
    'Tool Call Formatting',
  ]

  constructor() {
    super()
    this.registerVariant(CHERRY_STUDIO_VARIANT)
  }

  hasPromptInjected(messages: ChatMessage[]): boolean {
    const allContent = this.extractAllContent(messages)
    
    for (const sig of this.detectSignatures) {
      if (allContent.includes(sig)) {
        console.log('[CherryStudioAdapter] Detected existing tool prompt injection, skipping')
        return true
      }
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

    const template = variant?.toolPromptTemplate || CHERRY_STUDIO_VARIANT.toolPromptTemplate
    return template.replace('{{TOOL_DEFINITIONS}}', toolDefinitions)
  }

  parseToolCalls(content: string): ParseResult {
    let format: ToolCallFormat = 'bracket'
    let toolCalls: ToolCall[] = []

    if (content.includes('<tool_use>')) {
      format = 'xml'
      toolCalls = this.parseXmlToolCalls(content)
    } else if (content.includes('[function_calls]')) {
      format = 'bracket'
      const result = parseToolCallsFromText(content, 'default')
      toolCalls = result.toolCalls.map(tc => ({
        index: tc.index,
        id: tc.id,
        type: tc.type,
        function: tc.function,
      }))
    }

    return {
      content,
      toolCalls,
      format,
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
        console.warn('[CherryStudioAdapter] Failed to parse XML tool arguments:', argsStr)
      }
    }
    
    return toolCalls
  }

  getPromptVariant(_model: string, _provider?: string): PromptVariant | null {
    return CHERRY_STUDIO_VARIANT
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
    const toolsPrompt = this.toolsToPrompt(tools, variant)
    const transformedMessages = this.injectPrompt(messages, toolsPrompt)

    return {
      messages: transformedMessages,
      tools: undefined,
      injected: true,
      variant,
    }
  }
}

export const cherryStudioPromptAdapter = new CherryStudioPromptAdapter()
