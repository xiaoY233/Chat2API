import type { ToolProtocolAdapter } from './base.ts'
import type { NormalizedToolDefinition, ToolParseContext } from '../types.ts'
import {
  buildToolCall,
  createParseResult,
  decodeXml,
  detectMarkers,
  escapeRegExp,
  genericToolResultBlock,
  parseJsonValue,
  removeToolBlocks,
  renderToolList,
  toolNames,
  unwrapCdata,
} from './shared.ts'

/**
 * Cline/Roo/Kilo style XML tool invocation where the tool name is the tag:
 *
 * <read_file>
 *   <path>/tmp/a</path>
 * </read_file>
 *
 * Child tags become arguments. A JSON body or a single value is also accepted.
 */
export const xmlToolTagProtocol: ToolProtocolAdapter = {
  id: 'xml_tool_tag',

  renderPrompt(tools) {
    return `## Available Tools
${renderToolList(tools)}

When calling a tool, respond with the tool name as an XML tag and one child tag per argument.`
  },

  detectStart(buffer, tools) {
    if (!tools || tools.length === 0) return { matched: false, partial: false }
    const markers = tools.flatMap((tool) => [`<${tool.name}>`, `<${tool.name} `])
    return detectMarkers(buffer, markers)
  },

  parse(content: string, context: ToolParseContext) {
    const allowedNames = toolNames(context.tools)
    const rawMatches: string[] = []
    const invalidToolNames: string[] = []
    const toolCalls = []

    for (const tool of context.tools) {
      const name = tool.name
      const pattern = new RegExp(
        `<${escapeRegExp(name)}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${escapeRegExp(name)}>`,
        'g',
      )
      let match: RegExpExecArray | null
      while ((match = pattern.exec(content)) !== null) {
        rawMatches.push(match[0])
        const args = parseTagBody(match[1], tool)
        toolCalls.push(
          buildToolCall(`call_${toolCalls.length}`, toolCalls.length, name, JSON.stringify(args), match[0]),
        )
      }
    }

    if (toolCalls.length === 0) {
      return createParseResult({
        content,
        toolCalls,
        protocol: rawMatches.length > 0 ? 'xml_tool_tag' : 'unknown',
        rawMatches,
        invalidToolNames,
      })
    }

    return createParseResult({
      content: removeToolBlocks(content, rawMatches),
      toolCalls,
      protocol: 'xml_tool_tag',
      rawMatches,
      invalidToolNames,
    })
  },

  formatAssistantToolCalls(calls) {
    return calls
      .map((call) => {
        const args = safeParseObject(call.arguments)
        const body = Object.entries(args)
          .map(([key, value]) => `<${key}>${typeof value === 'string' ? value : JSON.stringify(value)}</${key}>`)
          .join('')
        return `<${call.name}>${body}</${call.name}>`
      })
      .join('')
  },

  formatToolResult(result) {
    return genericToolResultBlock(result)
  },
}

function parseTagBody(body: string, tool: NormalizedToolDefinition): Record<string, unknown> {
  const trimmed = unwrapCdata(body).trim()
  if (!trimmed) return {}

  const direct = parseJsonValue(trimmed)
  if (direct && typeof direct === 'object' && !Array.isArray(direct)) {
    return direct as Record<string, unknown>
  }

  const args: Record<string, unknown> = {}
  const childPattern = /<([A-Za-z_][\w:.-]*)(?:\s[^>]*)?>([\s\S]*?)<\/\1>/g
  let child: RegExpExecArray | null
  while ((child = childPattern.exec(trimmed)) !== null) {
    const key = child[1]
    if (key === tool.name) continue
    args[key] = parseJsonValue(child[2])
  }

  if (Object.keys(args).length > 0) return args

  const firstProperty = firstPropertyName(tool)
  return { [firstProperty]: decodeXml(trimmed) }
}

function firstPropertyName(tool: NormalizedToolDefinition): string {
  const properties = tool.parameters?.properties
  if (properties && typeof properties === 'object') {
    const keys = Object.keys(properties as Record<string, unknown>)
    if (keys.length > 0) return keys[0]
  }
  return 'input'
}

function safeParseObject(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
  } catch {
    return {}
  }
}
