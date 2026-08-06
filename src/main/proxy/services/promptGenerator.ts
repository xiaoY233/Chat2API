/**
 * Prompt Generator
 * Unified prompt generation for all protocol formats
 * Supports custom templates with variable substitution
 */

import { ChatCompletionTool } from '../types'

/**
 * Protocol format type
 */
export type ProtocolFormat = 'bracket' | 'xml'

/**
 * Prompt generation options
 */
export interface PromptGenerationOptions {
  format: ProtocolFormat
  customTemplate?: string
  provider?: string
}

/**
 * Template variables that can be used in custom templates
 */
export interface TemplateVariables {
  tools: string
  toolNames: string
  format: string
}

/**
 * Generate tool definitions string
 */
function generateToolDefinitions(tools: ChatCompletionTool[]): string {
  return tools
    .map((tool) => {
      const params = tool.function.parameters
        ? JSON.stringify(tool.function.parameters)
        : '{}'

      return `Tool \`${tool.function.name}\`: ${tool.function.description || 'No description'}. Arguments JSON schema: ${params}`
    })
    .join('\n')
}

/**
 * Generate tool names list
 */
function generateToolNames(tools: ChatCompletionTool[]): string {
  return tools.map((tool) => tool.function.name).join(', ')
}

/**
 * Generate bracket format example
 */
function generateBracketFormatExample(): string {
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
7. JSON arguments MUST be compact, all on one line, NO pretty printing, NO newlines`
}

/**
 * Generate XML format example
 */
function generateXmlFormatExample(): string {
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
6. JSON arguments MUST be valid JSON format`
}

/**
 * Get format example based on protocol format
 */
function getFormatExample(format: ProtocolFormat): string {
  return format === 'xml' ? generateXmlFormatExample() : generateBracketFormatExample()
}

/**
 * Substitute template variables
 */
function substituteTemplateVariables(template: string, variables: TemplateVariables): string {
  return template
    .replace(/\{\{tools\}\}/g, variables.tools)
    .replace(/\{\{tool_names\}\}/g, variables.toolNames)
    .replace(/\{\{format\}\}/g, variables.format)
}

/**
 * Generate bracket format prompt
 */
function generateBracketPrompt(tools: ChatCompletionTool[]): string {
  const toolDefinitions = generateToolDefinitions(tools)

  return `## Available Tools
You can invoke the following developer tools. Call a tool only when it is required and follow the JSON schema exactly when providing arguments.

CRITICAL: Tool names are CASE-SENSITIVE. You MUST use the exact tool name as defined below, including any prefixes like 'default_api:'.

${toolDefinitions}

${generateBracketFormatExample()}

EXAMPLE with multiple tools - NOTE THE JSON IS ALL ON ONE LINE:
[function_calls]
[call:default_api:read_file]{"filePath":"/path/to/file"}[/call]
[call:default_api:list_dir]{"target_directory":"/path/to/dir"}[/call]
[/function_calls]

When you receive a tool result, it will be in the format:
[TOOL_RESULT for call_id] result_content`
}

/**
 * Generate XML format prompt
 */
function generateXmlPrompt(tools: ChatCompletionTool[]): string {
  const toolDefinitions = generateToolDefinitions(tools)

  return `## Available Tools
You can invoke the following developer tools. Call a tool only when it is required and follow the JSON schema exactly when providing arguments.

CRITICAL: Tool names are CASE-SENSITIVE. You MUST use the exact tool name as defined below, including any prefixes like 'default_api:'.

${toolDefinitions}

${generateXmlFormatExample()}

EXAMPLE with multiple tools:
<tool_use>
  <name>default_api:read_file</name>
  <arguments>{"filePath":"/path/to/file"}</arguments>
</tool_use>
<tool_use>
  <name>default_api:list_dir</name>
  <arguments>{"target_directory":"/path/to/dir"}</arguments>
</tool_use>

When you receive a tool result, it will be in the format:
[TOOL_RESULT for call_id] result_content`
}

/**
 * Generate Perplexity-specific prompt with enforced tool call format
 * Disables web search and forces XML tool call output
 */
function generatePerplexityPrompt(tools: ChatCompletionTool[]): string {
  const toolDefinitions = generateToolDefinitions(tools)

  return `## CRITICAL INSTRUCTIONS - MUST FOLLOW

You are in TOOL CALL MODE. Your ONLY allowed response format is XML tool calls.

### PROHIBITED ACTIONS (MUST NOT DO):
- DO NOT perform web searches or internet searches
- DO NOT use your built-in search functionality
- DO NOT return search results or web content
- DO NOT answer questions directly with text
- DO NOT provide explanations, reasoning, or commentary
- DO NOT say things like "Let me search for..." or "I'll help you find..."

### REQUIRED BEHAVIOR (MUST DO):
- You MUST respond ONLY with <tool_use> blocks
- You MUST call the appropriate tool from the available tools list below
- You MUST use the exact tool name as defined (case-sensitive)
- You MUST provide valid JSON arguments inside <arguments> tags

## Available Tools
You can invoke the following developer tools. Call a tool only when it is required and follow the JSON schema exactly when providing arguments.

CRITICAL: Tool names are CASE-SENSITIVE. You MUST use the exact tool name as defined below, including any prefixes like 'mcp__'.

${toolDefinitions}

${generateXmlFormatExample()}

## RESPONSE FORMAT ENFORCEMENT
- If you are thinking about searching the web, STOP and call a tool instead
- If you are thinking about providing a text answer, STOP and call a tool instead
- Your response MUST start with <tool_use> and contain ONLY tool calls
- Any other response format is FORBIDDEN`
}

/**
 * Generate tool wrap hint for appending to user message
 */
function generateToolWrapHint(): string {
  return `

IMPORTANT: If you need to use a tool, you MUST wrap the tool call inside a [function_calls] block exactly like:
[function_calls]
[call:exact_tool_name]{"argument":"value"}[/call]
[/function_calls]

CRITICAL - MUST FOLLOW:
- Start with [call:exact_tool_name] (MUST include prefixes like default_api: if present in the tool name)
- Then the JSON arguments ALL ON ONE LINE - NO NEWLINES
- Example: [call:default_api:read_file]{"filePath":"/path/to/file"}[/call]
- Then CLOSE with [/call]
- Respond with NOTHING else if you are calling a tool`
}

/**
 * Prompt Generator class
 * Single entry point for all prompt generation
 */
export class PromptGenerator {
  /**
   * Generate tool prompt based on format and options
   * Supports custom templates with variable substitution
   */
  static generate(tools: ChatCompletionTool[], options: PromptGenerationOptions): string {
    if (!tools || tools.length === 0) {
      return ''
    }

    const { format, customTemplate, provider } = options

    // Use Perplexity-specific prompt if provider is Perplexity
    if (provider === 'perplexity') {
      return generatePerplexityPrompt(tools)
    }

    // Use custom template if provided
    if (customTemplate) {
      const variables: TemplateVariables = {
        tools: generateToolDefinitions(tools),
        toolNames: generateToolNames(tools),
        format: getFormatExample(format),
      }
      return substituteTemplateVariables(customTemplate, variables)
    }

    // Use default templates
    switch (format) {
      case 'xml':
        return generateXmlPrompt(tools)
      case 'bracket':
      default:
        return generateBracketPrompt(tools)
    }
  }

  /**
   * Generate tool definitions only (without protocol instructions)
   */
  static generateToolDefinitions(tools: ChatCompletionTool[]): string {
    return generateToolDefinitions(tools)
  }

  /**
   * Generate tool names list
   */
  static generateToolNames(tools: ChatCompletionTool[]): string {
    return generateToolNames(tools)
  }

  /**
   * Generate tool wrap hint
   */
  static generateWrapHint(): string {
    return generateToolWrapHint()
  }

  /**
   * Get format example for a given protocol format
   */
  static getFormatExample(format: ProtocolFormat): string {
    return getFormatExample(format)
  }
}

/**
 * Convenience function for direct usage
 */
export function generateToolPrompt(
  tools: ChatCompletionTool[],
  format: ProtocolFormat = 'bracket'
): string {
  return PromptGenerator.generate(tools, { format })
}
