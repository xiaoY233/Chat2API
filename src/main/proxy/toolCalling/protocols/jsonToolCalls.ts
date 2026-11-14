import type { ToolProtocolAdapter } from './base.ts'
import type { NormalizedToolDefinition, ToolParseContext } from '../types.ts'
import {
  buildToolCall,
  collectJsonCandidates,
  createParseResult,
  detectMarkers,
  findFencedRanges,
  genericToolResultBlock,
  normalizeArguments,
  removeToolBlocks,
  renderToolList,
  repairJson,
  toolNames,
} from './shared.ts'

interface JsonCall {
  name: string
  args: unknown
  id?: string
}

/**
 * Parses the common JSON tool-call shapes models emit when they ignore the
 * managed prompt:
 *
 * - {"tool_calls":[{"type":"function","function":{"name":..,"arguments":..}}]}
 * - [{"name":"..","arguments":{..}}]
 * - {"name":"..","parameters":{..}}
 * - {"type":"tool_use","name":"..","input":{..}}
 * - {"type":"function_call","call_id":"..","name":"..","arguments":".."}
 * - Hermes/Qwen <tool_call>{...}</tool_call>
 * - Mistral [TOOL_CALLS] [...]
 */
export const jsonToolCallsProtocol: ToolProtocolAdapter = {
  id: 'json_tool_calls',

  renderPrompt(tools) {
    return `## Available Tools
${renderToolList(tools)}

When calling tools, respond with JSON:
{"tool_calls":[{"type":"function","function":{"name":"exact_tool_name","arguments":{"argument":"value"}}}]}`
  },

  detectStart(buffer, tools) {
    const strongKeyPattern = /\{\s*"(?:tool_calls|tool_call|function_call|tool_use|tool_name)"\s*:/
    const strongMatch = strongKeyPattern.exec(buffer)
    if (strongMatch) {
      return { matched: true, partial: false, markerStart: strongMatch.index }
    }

    const namedMatch = /\{\s*"name"\s*:\s*"([^"]+)"/.exec(buffer)
    if (namedMatch && tools?.some((tool) => tool.name === namedMatch[1])) {
      return { matched: true, partial: false, markerStart: namedMatch.index }
    }

    const wrapperMatch = /<(?:tool_call|tool_calls|function_call)>/i.exec(buffer)
    if (wrapperMatch) {
      return { matched: true, partial: false, markerStart: wrapperMatch.index }
    }

    const mistralMatch = buffer.indexOf('[TOOL_CALLS]')
    if (mistralMatch !== -1) {
      return { matched: true, partial: false, markerStart: mistralMatch }
    }

    const pythonTagMatch = buffer.search(/<\|python_tag\|>|<\|tool_call\|>/)
    if (pythonTagMatch !== -1) {
      return { matched: true, partial: false, markerStart: pythonTagMatch }
    }

    const partial = findPartialJsonStart(buffer, tools)
    if (partial !== -1) {
      return { matched: false, partial: true, markerStart: partial }
    }

    return { matched: false, partial: false }
  },

  parse(content: string, context: ToolParseContext) {
    const allowedNames = toolNames(context.tools)
    const rawMatches: string[] = []
    const invalidToolNames: string[] = []
    const toolCalls = []
    const seenCalls = new Set<string>()

    for (const candidate of collectJsonCandidates(content)) {
      const parsed = parseJson(candidate.text)
      if (parsed === undefined) continue

      const calls: JsonCall[] = []
      collectJsonCalls(parsed, calls)
      if (calls.length === 0) continue

      const strongKey = /"(?:tool_calls|tool_call|function_call|tool_use|tool_name)"\s*:/.test(candidate.text)
      let used = false
      for (const call of calls) {
        const name = call.name.trim()
        if (!name) continue
        if (!allowedNames.has(name)) {
          if (strongKey) invalidToolNames.push(name)
          continue
        }

        const args = normalizeArguments(call.args)
        const key = `${call.id || ''}:${name}:${args}`
        if (seenCalls.has(key)) continue
        seenCalls.add(key)

        used = true
        toolCalls.push(
          buildToolCall(
            call.id || `call_${toolCalls.length}`,
            toolCalls.length,
            name,
            args,
            candidate.raw,
          ),
        )
      }

      if (used) rawMatches.push(candidate.raw)
    }

    if (toolCalls.length === 0) {
      return createParseResult({
        content,
        toolCalls,
        protocol: rawMatches.length > 0 || invalidToolNames.length > 0 ? 'json_tool_calls' : 'unknown',
        rawMatches,
        invalidToolNames,
        malformedReason: invalidToolNames.length > 0 ? 'json_tool_name_not_declared' : undefined,
      })
    }

    return createParseResult({
      content: removeToolBlocks(content, rawMatches),
      toolCalls,
      protocol: 'json_tool_calls',
      rawMatches,
      invalidToolNames,
    })
  },

  formatAssistantToolCalls(calls) {
    return JSON.stringify({
      tool_calls: calls.map((call) => ({
        type: 'function',
        id: call.id,
        function: {
          name: call.name,
          arguments: call.arguments,
        },
      })),
    })
  },

  formatToolResult(result) {
    return genericToolResultBlock(result)
  },
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return repairJson(text)
  }
}

function collectJsonCalls(value: unknown, calls: JsonCall[], depth = 0): void {
  if (depth > 8 || value === null || value === undefined) return

  if (Array.isArray(value)) {
    for (const item of value) collectJsonCalls(item, calls, depth + 1)
    return
  }

  if (typeof value !== 'object') return
  const record = value as Record<string, unknown>
  let pushed = false

  if (record.type === 'function_call' && typeof record.name === 'string') {
    calls.push({
      name: record.name,
      args: record.arguments ?? record.parameters ?? record.input ?? {},
      id: typeof record.call_id === 'string' ? record.call_id : typeof record.id === 'string' ? record.id : undefined,
    })
    pushed = true
  } else if (record.type === 'tool_use' && typeof record.name === 'string') {
    calls.push({
      name: record.name,
      args: record.input ?? record.arguments ?? record.parameters ?? {},
      id: typeof record.id === 'string' ? record.id : undefined,
    })
    pushed = true
  } else if (record.function && typeof record.function === 'object') {
    const fn = record.function as Record<string, unknown>
    if (typeof fn.name === 'string') {
      calls.push({
        name: fn.name,
        args: fn.arguments ?? fn.parameters ?? fn.input ?? {},
        id: typeof record.id === 'string' ? record.id : undefined,
      })
      pushed = true
    }
  }

  if (!pushed && typeof record.name === 'string') {
    const args = record.arguments ?? record.parameters ?? record.input ?? record.args
    if (args !== undefined) {
      calls.push({
        name: record.name,
        args,
        id: typeof record.id === 'string' ? record.id : undefined,
      })
      pushed = true
    }
  }

  if (!pushed && typeof record.tool === 'string') {
    const args = record.parameters ?? record.arguments ?? record.input
    if (args !== undefined) {
      calls.push({ name: record.tool, args })
      pushed = true
    }
  }

  if (!pushed && typeof record.tool_name === 'string') {
    const args = record.tool_args ?? record.arguments ?? record.parameters ?? record.input
    if (args !== undefined) {
      calls.push({ name: record.tool_name, args })
    }
  }

  for (const key of ['tool_calls', 'tool_call', 'function_call', 'output', 'items', 'content', 'message']) {
    if (record[key] !== undefined) {
      collectJsonCalls(record[key], calls, depth + 1)
    }
  }
}

function findPartialJsonStart(buffer: string, tools?: NormalizedToolDefinition[]): number {
  const lastBrace = buffer.lastIndexOf('{')
  if (lastBrace === -1) return -1

  const suffix = buffer.slice(lastBrace).trim()
  if (!suffix.startsWith('{')) return -1

  // A lone opening brace or a partial key at the end of the buffer.
  if (suffix === '{') return lastBrace
  if (suffix.length < 64 && /^\{\s*"?[A-Za-z_]*$/.test(suffix)) return lastBrace

  // A fenced JSON block that has not closed yet.
  const openFence = findFencedRanges(buffer).find((range) => range.unclosed)
  if (openFence) {
    const body = buffer.slice(openFence.openEnd).trimStart()
    if (body.startsWith('{') || body.startsWith('[') || body === '') return openFence.start
  }

  void tools
  return -1
}
