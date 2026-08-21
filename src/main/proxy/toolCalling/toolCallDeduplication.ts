import type { ToolCall } from '../types.ts'

export interface ToolCallDeduplicationResult<T extends ToolCall> {
  toolCalls: T[]
  duplicateCount: number
}

/**
 * Suppress exact semantic replays inside one model response. Different tools
 * and different arguments remain independent parallel calls.
 */
export function deduplicateEquivalentToolCalls<T extends ToolCall>(
  toolCalls: readonly T[],
): ToolCallDeduplicationResult<T> {
  const seen = new Set<string>()
  const uniqueToolCalls: T[] = []

  for (const toolCall of toolCalls) {
    const fingerprint = toolCallFingerprint(toolCall)
    if (seen.has(fingerprint)) continue

    seen.add(fingerprint)
    uniqueToolCalls.push(toolCall)
  }

  return {
    toolCalls: uniqueToolCalls,
    duplicateCount: toolCalls.length - uniqueToolCalls.length,
  }
}

function toolCallFingerprint(toolCall: ToolCall): string {
  return `${toolCall.function.name}\n${canonicalArguments(toolCall.function.arguments)}`
}

function canonicalArguments(argumentsText: string): string {
  const trimmed = argumentsText.trim()
  if (!trimmed) return '{}'

  try {
    return JSON.stringify(sortJsonValue(JSON.parse(trimmed)))
  } catch {
    return trimmed
  }
}

function sortJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortJsonValue)
  }

  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, sortJsonValue(item)]),
    )
  }

  return value
}
