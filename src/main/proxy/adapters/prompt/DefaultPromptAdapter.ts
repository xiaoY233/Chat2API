/**
 * Default Prompt Adapter
 * Maintains backward compatibility with existing tool prompt injection logic
 */

import { ChatMessage, ChatCompletionTool, ToolCall } from '../../types'
import { BasePromptAdapter, PromptVariant, TransformResult, ParseResult, ToolCallFormat } from './BasePromptAdapter'
import { ClientType } from '../../utils/promptSignatures'
import { parseToolCallsFromText } from '../../utils/toolParser'

/**
 * Default prompt variant for generic models
 */
const DEFAULT_VARIANT: PromptVariant = {
  id: 'default',
  name: 'Default',
  description: 'Default prompt variant for generic models',
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
2. You MUST use the EXACT tool name as defined in the Available Tools list (e.g., if the tool is named \`default_api:read_file\`, you MUST use \`[call:default_api:read_file]\`, NOT \`[call:read_file]\`).
3. The content between [call:...] and [/call] MUST be a raw JSON object on ONE LINE - NO LINE BREAKS inside the JSON
4. Do NOT wrap JSON in \`\`\`json blocks
5. Do NOT output any other text, explanation, or reasoning before or after the [function_calls] block
6. If you need to call multiple tools, put them all inside the same [function_calls] block, each with its own [call:...]...[/call] wrapper
7. JSON arguments MUST be compact, all on one line, NO pretty printing, NO newlines
8. If you are writing code or regular expressions, you MUST properly escape all backslashes and quotes inside the JSON string.

EXAMPLE with multiple tools - NOTE THE JSON IS ALL ON ONE LINE:
[function_calls]
[call:default_api:read_file]{"filePath":"/path/to/file"}[/call]
[call:default_api:list_dir]{"target_directory":"/path/to/dir"}[/call]
[call:default_api:search_content]{"pattern":"example","directory":"/path/to/dir"}[/call]
[/function_calls]

When you receive a tool result, it will be in the format:
[TOOL_RESULT for call_id] result_content`,
  toolCallFormat: 'bracket',
}

/**
 * Default Prompt Adapter
 * Implements the current tool prompt injection behavior
 */
export class DefaultPromptAdapter extends BasePromptAdapter {
  name = 'default'
  clientType: ClientType = 'unknown'
  detectSignatures: string[] = [
    '## Available Tools',
    '## Tool Call Protocol',
    '[function_calls]',
    'TOOL_WRAP_HINT',
    'You can invoke the following developer tools',
    'Tool Call Formatting',
  ]

  constructor() {
    super()
    this.registerVariant(DEFAULT_VARIANT)
  }

  hasPromptInjected(messages: ChatMessage[]): boolean {
    const allContent = this.extractAllContent(messages)
    
    for (const sig of this.detectSignatures) {
      if (allContent.includes(sig)) {
        console.log('[DefaultAdapter] Detected existing tool prompt injection, skipping')
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

    const template = variant?.toolPromptTemplate || DEFAULT_VARIANT.toolPromptTemplate
    return template.replace('{{TOOL_DEFINITIONS}}', toolDefinitions)
  }

  parseToolCalls(content: string): ParseResult {
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

  getPromptVariant(model: string, _provider?: string): PromptVariant | null {
    return DEFAULT_VARIANT
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

export const defaultPromptAdapter = new DefaultPromptAdapter()
