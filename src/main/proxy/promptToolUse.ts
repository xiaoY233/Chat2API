/**
 * Prompt Tool Use - Tool Calling Simulation
 * Enables tool calling for models without native function calling support
 * 
 * This module provides a fallback XML-based tool calling format for custom providers.
 * For built-in providers (DeepSeek, GLM, Kimi, Qwen, etc.), use the new utils module:
 * 
 *   - utils/tools.ts: Convert OpenAI tools to system prompt
 *   - utils/toolParser.ts: Parse tool calls from model output
 *   - utils/streamToolHandler.ts: Handle tool calls in streaming responses
 * 
 * Protocol Format (New):
 *   [function_calls]
 *   [call:tool_name]{"arg": "value"}[/call]
 *   [/function_calls]
 * 
 * Protocol Format (Legacy XML):
 *   <tool_use>
 *     <name>tool_name</name>
 *     <arguments>{"arg": "value"}</arguments>
 *   </tool_use>
 * 
 * Reference: Cherry Studio (https://github.com/CherryHQ/cherry-studio)
 */

/**
 * Tool Definition Interface
 */
export interface ToolDefinition {
  type: 'function'
  function: {
    name: string
    description?: string
    parameters?: {
      type: 'object'
      properties: Record<string, {
        type: string
        description?: string
        enum?: string[]
      }>
      required?: string[]
    }
  }
}

/**
 * Tool Call Interface
 */
export interface ToolCall {
  id: string
  type: 'function'
  function: {
    name: string
    arguments: string
  }
}

/**
 * Tool Use Tag Configuration
 */
const TOOL_USE_TAG_CONFIG = {
  startTag: '<tool_use>',
  endTag: '</tool_use>',
  nameTag: 'name',
  argumentsTag: 'arguments',
}

/**
 * Default System Prompt for Tool Use
 */
const DEFAULT_TOOL_USE_PROMPT = `In this environment you have access to a set of tools you can use to answer the user's question. You can use one or more tools per message, and will receive the result of that tool use in the user's response. You use tools step-by-step to accomplish a given task, with each tool use informed by the result of the previous tool use.

## Tool Use Formatting

Tool use is formatted using XML-style tags. The tool name is enclosed in opening and closing tags, and each parameter is similarly enclosed within its own set of tags. Here's the structure:

<tool_use>
  <name>{tool_name}</name>
  <arguments>{json_arguments}</arguments>
</tool_use>

The tool name should be the exact name of the tool you are using, and the arguments should be a JSON object containing the parameters required by that tool. IMPORTANT: When writing JSON inside the <arguments> tag, any double quotes inside string values must be escaped with a backslash ("). For example:
<tool_use>
  <name>search</name>
  <arguments>{ "query": "browser,fetch" }</arguments>
</tool_use>

<tool_use>
  <name>exec</name>
  <arguments>{ "code": "const page = await CherryBrowser_fetch({ url: \\"https://example.com\\" })\\nreturn page" }</arguments>
</tool_use>

The user will respond with the result of the tool use, which should be formatted as follows:

<tool_use_result>
  <name>{tool_name}</name>
  <result>{result}</result>
</tool_use_result>

The result should be a string, which can represent a file or any other output type. You can use this result as input for the next action.
For example, if the result of the tool use is an image file, you can use it in the next action like this:

<tool_use>
  <name>image_transformer</name>
  <arguments>{"image": "image_1.jpg"}</arguments>
</tool_use>

Always adhere to this format for the tool use to ensure proper parsing and execution.

## Tool Use Rules
Here are the rules you should always follow to solve your task:
1. Always use the right arguments for the tools. Never use variable names as the action arguments, use the value instead.
2. Call a tool only when needed: do not call the search agent if you do not need information, try to solve the task yourself.
3. If no tool call is needed, just answer the question directly.
4. Never re-do a tool call that you previously did with the exact same parameters.
5. For tool use, MAKE SURE use XML tag format as shown in the examples above. Do not use any other format.

{{ TOOLS_INFO }}

## Response rules

Respond in the language of the user's query, unless the user instructions specify additional requirements for the language to be used.

{{ USER_SYSTEM_PROMPT }}
`

/**
 * Build available tools information string
 */
export function buildAvailableTools(tools: ToolDefinition[]): string {
  if (!tools || tools.length === 0) {
    return ''
  }

  const toolsInfo = tools.map((tool) => {
    const { name, description, parameters } = tool.function
    
    let paramInfo = ''
    if (parameters?.properties) {
      const props = Object.entries(parameters.properties)
        .map(([key, value]) => {
          const required = parameters.required?.includes(key) ? ' (required)' : ''
          return `  - ${key}${required}: ${value.description || value.type}`
        })
        .join('\n')
      paramInfo = `\nParameters:\n${props}`
    }

    return `<tool>
<name>${name}</name>
<description>${description}</description>${paramInfo}
</tool>`
  }).join('\n\n')

  return `## Available Tools

${toolsInfo}`
}

/**
 * Build system prompt with tool definitions
 */
export function buildSystemPromptWithTools(
  userPrompt: string,
  tools: ToolDefinition[]
): string {
  const toolsInfo = buildAvailableTools(tools)
  
  return DEFAULT_TOOL_USE_PROMPT
    .replace('{{ TOOLS_INFO }}', toolsInfo)
    .replace('{{ USER_SYSTEM_PROMPT }}', userPrompt || 'You are a helpful AI assistant.')
}

/**
 * Parse tool use from model output
 * Extracts tool calls from XML-style tags
 */
export function parseToolUse(content: string): ToolCall[] {
  const toolCalls: ToolCall[] = []
  
  // Regex to match <tool_use>...</tool_use> blocks (allow missing opening bracket)
  const toolUseRegex = /<?tool_use>\s*([\s\S]*?)\s*<\/tool_use>/gi
  
  let match
  while ((match = toolUseRegex.exec(content)) !== null) {
    const toolUseContent = match[1]
    
    // Extract name
    const nameMatch = /<name>\s*([^<]*)\s*<\/name>/i.exec(toolUseContent)
    const name = nameMatch ? nameMatch[1].trim() : ''
    
    // Extract arguments
    const argsMatch = /<arguments>\s*([\s\S]*?)\s*<\/arguments>/i.exec(toolUseContent)
    const args = argsMatch ? argsMatch[1].trim() : '{}'
    
    if (name) {
      toolCalls.push({
        id: `call_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
        type: 'function',
        function: {
          name,
          arguments: args,
        },
      })
    }
  }
  
  return toolCalls
}

/**
 * Format tool result for injection
 */
export function formatToolResult(toolName: string, result: string): string {
  return `<tool_use_result>
<name>${toolName}</name>
<result>${result}</result>
</tool_use_result>`
}

/**
 * Check if content contains tool use
 */
export function hasToolUse(content: string): boolean {
  return /<?tool_use>/i.test(content)
}

/**
 * Remove tool use tags from content
 * Returns cleaned content for display
 */
export function cleanToolUseFromContent(content: string): string {
  return content
    .replace(/<tool_use>[\s\S]*?<\/tool_use>/gi, '')
    .replace(/<tool_use_result>[\s\S]*?<\/tool_use_result>/gi, '')
    .trim()
}

/**
 * Models that support native function Calling
 */
export const NATIVE_FUNCTION_CALLING_MODELS = [
  'gpt-4',
  'gpt-4-turbo',
  'gpt-4o',
  'gpt-4o-mini',
  'gpt-3.5-turbo',
  'claude-3',
  'claude-3.5',
  'claude-sonnet',
  'claude-opus',
  'claude-haiku',
  'gemini-1.5',
  'gemini-2.0',
]

/**
 * Check if model supports native function calling
 */
export function isNativeFunctionCallingModel(model: string): boolean {
  const lowerModel = model.toLowerCase()
  return NATIVE_FUNCTION_CALLING_MODELS.some(m => lowerModel.includes(m.toLowerCase()))
}

/**
 * Transform OpenAI tools to prompt format
 * For models that don't support native function calling
 */
export function transformToolsToPrompt(
  systemPrompt: string,
  tools: ToolDefinition[] | undefined,
  model: string
): { systemPrompt: string; tools: undefined } | { systemPrompt: string; tools: ToolDefinition[] } {
  if (!tools || tools.length === 0) {
    return { systemPrompt, tools: undefined }
  }
  
  // If model supports native function calling, keep tools as is
  if (isNativeFunctionCallingModel(model)) {
    return { systemPrompt, tools }
  }
  
  // Otherwise, transform tools to prompt format
  const enhancedPrompt = buildSystemPromptWithTools(systemPrompt, tools)
  
  return { systemPrompt: enhancedPrompt, tools: undefined }
}

export default {
  buildSystemPromptWithTools,
  buildAvailableTools,
  parseToolUse,
  formatToolResult,
  hasToolUse,
  cleanToolUseFromContent,
  isNativeFunctionCallingModel,
  transformToolsToPrompt,
}
