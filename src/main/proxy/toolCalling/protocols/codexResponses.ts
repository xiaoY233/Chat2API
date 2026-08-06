import type { ToolProtocolAdapter } from './base.ts'
import {
  buildToolCall,
  createParseResult,
  genericToolResultBlock,
  detectMarkers,
  normalizeArguments,
  renderToolList,
  stripFencedCodeBlocks,
  toolNames,
} from './shared.ts'

export const codexResponsesProtocol: ToolProtocolAdapter = {
  id: 'codex_responses',

  renderPrompt(tools) {
    return `## Available Tools
${renderToolList(tools)}

When Codex Responses compatibility is enabled, emit response items with type "function_call".`
  },

  detectStart(buffer) {
    return detectMarkers(buffer, ['"type":"function_call"', '"type": "function_call"', '{"type"'])
  },

  parse(content, context) {
    const parseable = stripFencedCodeBlocks(content).trim()
    const allowedNames = toolNames(context.tools)
    const rawMatches: string[] = []
    const invalidToolNames: string[] = []
    const toolCalls = []

    let parsed: unknown
    try {
      parsed = JSON.parse(parseable)
    } catch {
      return createParseResult({
        content,
        toolCalls,
        protocol: 'unknown',
        rawMatches,
        malformedReason: 'codex_responses_json_parse_failed',
      })
    }

    const items = extractResponseItems(parsed)
    for (const item of items) {
      if (!item || typeof item !== 'object') continue
      const record = item as Record<string, unknown>
      if (record.type !== 'function_call') continue

      const name = typeof record.name === 'string' ? record.name : ''
      if (!allowedNames.has(name)) {
        if (name) invalidToolNames.push(name)
        continue
      }

      const id =
        typeof record.call_id === 'string'
          ? record.call_id
          : typeof record.id === 'string'
            ? record.id
            : `call_${toolCalls.length}`

      toolCalls.push(buildToolCall(id, toolCalls.length, name, normalizeArguments(record.arguments), parseable))
    }

    if (toolCalls.length > 0) rawMatches.push(parseable)

    return createParseResult({
      content: toolCalls.length > 0 ? '' : content,
      toolCalls,
      protocol: toolCalls.length > 0 || invalidToolNames.length > 0 ? 'codex_responses' : 'unknown',
      rawMatches,
      invalidToolNames,
    })
  },

  formatAssistantToolCalls(calls) {
    return JSON.stringify(
      calls.map((call) => ({
        type: 'function_call',
        call_id: call.id,
        name: call.name,
        arguments: call.arguments,
      })),
    )
  },

  formatToolResult(result) {
    return genericToolResultBlock(result)
  },
}

function extractResponseItems(value: unknown): unknown[] {
  if (Array.isArray(value)) return value
  if (!value || typeof value !== 'object') return []

  const record = value as Record<string, unknown>
  if (record.type === 'function_call') return [record]
  if (Array.isArray(record.output)) return record.output
  if (Array.isArray(record.items)) return record.items
  return []
}
