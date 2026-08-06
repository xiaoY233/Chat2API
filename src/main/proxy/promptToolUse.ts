/**
 * Prompt Tool Use - Tool Calling Parsing
 * Parses XML-style tool calling format from clients like Cherry Studio
 * 
 * For built-in providers (DeepSeek, GLM, Kimi, Qwen, etc.), use the new utils module:
 *   - utils/tools.ts: Convert OpenAI tools to system prompt
 *   - utils/toolParser.ts: Parse tool calls from model output
 *   - utils/streamToolHandler.ts: Handle tool calls in streaming responses
 * 
 * This module only handles parsing of legacy XML format from external clients.
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
 * Parse tool use from model output
 * Extracts tool calls from XML-style tags (used by Cherry Studio and other clients)
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
 * Check if content contains tool use (XML format from external clients)
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
 * Models that support native Function Calling
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

export default {
  parseToolUse,
  formatToolResult,
  hasToolUse,
  cleanToolUseFromContent,
  isNativeFunctionCallingModel,
}
