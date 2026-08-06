/**
 * Tool Format Converter
 * Converts between OpenAI tool_calls and Anthropic tool_use formats
 */

import { ToolCall } from '../types'

/**
 * Anthropic-style tool use block
 */
export interface AnthropicToolUse {
  type: 'tool_use'
  id: string
  name: string
  input: Record<string, any>
}

/**
 * Anthropic-style tool result block
 */
export interface AnthropicToolResult {
  type: 'tool_result'
  tool_use_id: string
  content: string | any[]
}

/**
 * Check if the request expects Anthropic-style tool format
 */
export function isAnthropicToolFormat(toolFormat?: string): boolean {
  return toolFormat === 'native'
}

/**
 * Convert OpenAI tool_calls to Anthropic tool_use format
 */
export function openaiToAnthropicToolCalls(toolCalls: ToolCall[]): AnthropicToolUse[] {
  return toolCalls.map(tc => ({
    type: 'tool_use' as const,
    id: tc.id,
    name: tc.function.name,
    input: JSON.parse(tc.function.arguments),
  }))
}

/**
 * Convert Anthropic tool_use to OpenAI tool_calls format
 */
export function anthropicToOpenAIToolCalls(toolUses: AnthropicToolUse[]): ToolCall[] {
  return toolUses.map((tu, index) => ({
    index,
    id: tu.id,
    type: 'function' as const,
    function: {
      name: tu.name,
      arguments: JSON.stringify(tu.input),
    },
  }))
}

/**
 * Convert OpenAI streaming tool_calls delta to Anthropic format
 */
export function openaiDeltaToAnthropic(delta: any): any {
  if (!delta.tool_calls || !Array.isArray(delta.tool_calls)) {
    return delta
  }

  return {
    ...delta,
    tool_use: delta.tool_calls.map((tc: any) => {
      const result: any = {
        type: 'tool_use',
        id: tc.id,
        name: tc.function?.name,
      }
      
      if (tc.function?.arguments) {
        try {
          result.input = JSON.parse(tc.function.arguments)
        } catch {
          result.input = tc.function.arguments
        }
      }
      
      return result
    }),
  }
}

/**
 * Format tool calls based on the requested format
 */
export function formatToolCalls(
  toolCalls: ToolCall[],
  format: 'native' | 'json' | 'auto' = 'auto'
): ToolCall[] | AnthropicToolUse[] {
  if (format === 'native') {
    return openaiToAnthropicToolCalls(toolCalls)
  }
  return toolCalls
}

/**
 * Create Anthropic-style content block for response
 */
export function createAnthropicContent(
  content: string | null,
  toolCalls: ToolCall[] | undefined
): (string | AnthropicToolUse)[] {
  const blocks: (string | AnthropicToolUse)[] = []
  
  if (content) {
    blocks.push(content)
  }
  
  if (toolCalls && toolCalls.length > 0) {
    blocks.push(...openaiToAnthropicToolCalls(toolCalls))
  }
  
  return blocks
}

/**
 * Transform response body to Anthropic format if needed
 */
export function transformResponseToAnthropic(response: any): any {
  if (!response.choices || !Array.isArray(response.choices)) {
    return response
  }

  const transformedChoices = response.choices.map((choice: any) => {
    if (!choice.message) {
      return choice
    }

    const message = choice.message
    const toolCalls = message.tool_calls

    if (!toolCalls || !Array.isArray(toolCalls) || toolCalls.length === 0) {
      return choice
    }

    const content: any[] = []
    
    if (message.content) {
      content.push({ type: 'text', text: message.content })
    }
    
    const toolUseBlocks = openaiToAnthropicToolCalls(toolCalls)
    content.push(...toolUseBlocks.map(tu => ({
      type: 'tool_use',
      id: tu.id,
      name: tu.name,
      input: tu.input,
    })))

    return {
      ...choice,
      message: {
        role: message.role,
        content,
      },
      finish_reason: choice.finish_reason,
    }
  })

  return {
    ...response,
    choices: transformedChoices,
  }
}

/**
 * Transform streaming chunk to Anthropic format if needed
 */
export function transformChunkToAnthropic(chunk: any): any {
  if (!chunk.choices || !Array.isArray(chunk.choices)) {
    return chunk
  }

  const transformedChoices = chunk.choices.map((choice: any) => {
    if (!choice.delta) {
      return choice
    }

    const delta = choice.delta
    const toolCalls = delta.tool_calls

    if (!toolCalls || !Array.isArray(toolCalls) || toolCalls.length === 0) {
      return choice
    }

    const content: any[] = []
    
    if (delta.content) {
      content.push({ type: 'text', text: delta.content })
    }
    
    const toolUseBlocks = toolCalls.map((tc: any) => {
      const result: any = {
        type: 'tool_use',
        id: tc.id,
      }
      
      if (tc.function?.name) {
        result.name = tc.function.name
      }
      
      if (tc.function?.arguments) {
        try {
          result.input = JSON.parse(tc.function.arguments)
        } catch {
          result.input = tc.function.arguments
        }
      }
      
      return result
    })
    
    content.push(...toolUseBlocks)

    return {
      ...choice,
      delta: {
        role: delta.role,
        content,
      },
      finish_reason: choice.finish_reason,
    }
  })

  return {
    ...chunk,
    choices: transformedChoices,
  }
}
