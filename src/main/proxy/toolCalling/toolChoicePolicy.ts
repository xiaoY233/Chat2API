import type { ChatCompletionToolChoice } from '../types.ts'
import type { NormalizedToolDefinition } from './types.ts'

export type ToolChoiceMode = 'auto' | 'none' | 'required' | 'forced'

export interface NormalizedToolChoicePolicy {
  mode: ToolChoiceMode
  allowedToolNames: Set<string>
  forcedName?: string
}

export class ToolChoicePolicyError extends Error {
  code: string

  constructor(code: string, message: string) {
    super(message)
    this.name = 'ToolChoicePolicyError'
    this.code = code
  }
}

export function normalizeToolChoicePolicy(
  toolChoice: ChatCompletionToolChoice | undefined,
  tools: NormalizedToolDefinition[],
): NormalizedToolChoicePolicy {
  const allToolNames = new Set(tools.map((tool) => tool.name))

  if (toolChoice === undefined || toolChoice === 'auto') {
    return { mode: 'auto', allowedToolNames: allToolNames }
  }

  if (toolChoice === 'none') {
    return { mode: 'none', allowedToolNames: new Set() }
  }

  if (toolChoice === 'required') {
    if (tools.length === 0) {
      throw new ToolChoicePolicyError(
        'tool_choice_required_without_tools',
        'tool_choice "required" requires at least one declared tool',
      )
    }
    return { mode: 'required', allowedToolNames: allToolNames }
  }

  if (
    toolChoice &&
    typeof toolChoice === 'object' &&
    toolChoice.type === 'function' &&
    typeof toolChoice.function?.name === 'string'
  ) {
    const forcedName = toolChoice.function.name
    if (!allToolNames.has(forcedName)) {
      throw new ToolChoicePolicyError(
        'tool_choice_forced_tool_not_found',
        `tool_choice forced function "${forcedName}" is not present in declared tools`,
      )
    }

    return {
      mode: 'forced',
      allowedToolNames: new Set([forcedName]),
      forcedName,
    }
  }

  throw new ToolChoicePolicyError('tool_choice_unsupported', 'Unsupported tool_choice value')
}
