import type { ToolProtocolAdapter } from './base.ts'
import type { ToolParseContext } from '../types.ts'
import {
  addParameter,
  buildToolCall,
  createParseResult,
  detectMarkers,
  escapeXmlAttribute,
  parseJsonValue,
  renderToolList,
  stripFencedCodeBlocks,
  toolNames,
} from './shared.ts'

const CHAT2API_START = '<|CHAT2API|tool_calls>'
const CHAT2API_END = '</|CHAT2API|tool_calls>'
const XML_START = '<tool_calls>'

const DSML_MARKERS = [
  '<｜｜DSML',
  '<｜DSML',
  '<|DSML',
  '< | DSML',
  '<||DSML',
  '< |DSML',
  '<｜ DSML',
]

const DSML_STRIP_REGEX = /<\/[|\s｜]*DSML[|\s｜]*(?:calls|tool_calls|invoke|parameter)>|<[|\s｜]*DSML[|\s｜]*(?:calls|tool_calls)>/gi

export const managedXmlProtocol: ToolProtocolAdapter = {
  id: 'managed_xml',

  renderPrompt(tools) {
    return `## Available Tools
You can invoke the following developer tools. Tool names are case-sensitive.
Use only the exact tool names listed below. Do not rename, camelCase, translate, shorten, or invent tool names.

${renderToolList(tools)}

When calling tools, respond with only this Chat2API XML block:

<|CHAT2API|tool_calls><|CHAT2API|invoke name="exact_tool_name"><|CHAT2API|parameter name="argument"><![CDATA[value]]></|CHAT2API|parameter></|CHAT2API|invoke></|CHAT2API|tool_calls>

Tool results will be provided as Chat2API XML result blocks:

<|CHAT2API|tool_result tool_call_id="call_id"><![CDATA[result]]></|CHAT2API|tool_result>`
  },

  detectStart(buffer) {
    if (/^[|\s｜]*<[|\s｜]*DSML/i.test(buffer)) {
      return { matched: true, partial: false, markerStart: 0 }
    }
    return detectMarkers(buffer, [CHAT2API_START, XML_START, ...DSML_MARKERS])
  },

  parse(content: string, context: ToolParseContext) {
    const parseable = stripFencedCodeBlocks(content)
    const allowedNames = toolNames(context.tools)
    const rawMatches: string[] = []
    const invalidToolNames: string[] = []
    const toolCalls = []

    parseBlocks(parseable, {
      blockPattern: /<[|\s｜]*DSML[|\s｜]*(?:calls|tool_calls)>([\s\S]*?)<\/[|\s｜]*DSML[|\s｜]*(?:calls|tool_calls)>/gi,
      invokePattern: /<[|\s｜]*DSML[|\s｜]*invoke\s+name="([^"]+)"\s*>([\s\S]*?)<\/[|\s｜]*DSML[|\s｜]*invoke>/gi,
      parameterPattern: /<[|\s｜]*DSML[|\s｜]*parameter\s+name="([^"]+)"(?:\s+[^>]*)?>([\s\S]*?)<\/[|\s｜]*DSML[|\s｜]*parameter>/gi,
      rawMatches,
      invalidToolNames,
      allowedNames,
      toolCalls,
    })

    parseBlocks(parseable, {
      blockPattern: /<\|CHAT2API\|tool_calls>([\s\S]*?)<\/\|CHAT2API\|tool_calls>/g,
      invokePattern: /<\|CHAT2API\|invoke\s+name="([^"]+)"\s*>([\s\S]*?)<\/\|CHAT2API\|invoke>/g,
      parameterPattern: /<\|CHAT2API\|parameter\s+name="([^"]+)"\s*>([\s\S]*?)<\/\|CHAT2API\|parameter>/g,
      rawMatches,
      invalidToolNames,
      allowedNames,
      toolCalls,
    })

    parseBlocks(parseable, {
      blockPattern: /<tool_calls>([\s\S]*?)<\/tool_calls>/g,
      invokePattern: /<invoke\s+name="([^"]+)"\s*>([\s\S]*?)<\/invoke>/g,
      parameterPattern: /<parameter\s+name="([^"]+)"\s*>([\s\S]*?)<\/parameter>/g,
      rawMatches,
      invalidToolNames,
      allowedNames,
      toolCalls,
    })

    const standalonePattern = /<[|\s｜]*DSML[|\s｜]*invoke\s+name="([^"]+)"\s*>([\s\S]*?)<\/[|\s｜]*DSML[|\s｜]*invoke>/gi
    let standaloneMatch: RegExpExecArray | null
    while ((standaloneMatch = standalonePattern.exec(parseable)) !== null) {
      if (rawMatches.some((raw) => raw.includes(standaloneMatch![0]))) continue
      rawMatches.push(standaloneMatch[0])
      let name = standaloneMatch[1].trim()
      if (allowedNames.size > 0 && !allowedNames.has(name)) {
        if (name === 'shell' && allowedNames.has('bash')) {
          name = 'bash'
        } else if (name === 'bash' && allowedNames.has('shell')) {
          name = 'shell'
        } else {
          const found = Array.from(allowedNames).find((n) => n.toLowerCase() === name.toLowerCase())
          if (found) {
            name = found
          } else {
            invalidToolNames.push(name)
            continue
          }
        }
      }
      const args: Record<string, unknown> = {}
      const paramPattern = /<[|\s｜]*DSML[|\s｜]*parameter\s+name="([^"]+)"(?:\s+[^>]*)?>([\s\S]*?)<\/[|\s｜]*DSML[|\s｜]*parameter>/gi
      let parameterMatch: RegExpExecArray | null
      while ((parameterMatch = paramPattern.exec(standaloneMatch[2])) !== null) {
        addParameter(args, parameterMatch[1].trim(), parseJsonValue(parameterMatch[2]))
      }
      toolCalls.push(
        buildToolCall(`call_${toolCalls.length}`, toolCalls.length, name, JSON.stringify(args), standaloneMatch[0]),
      )
    }

    if (toolCalls.length === 0) {
      const strippedContent = content.replace(DSML_STRIP_REGEX, '').trim()
      return createParseResult({
        content: strippedContent,
        toolCalls,
        protocol: rawMatches.length > 0 ? 'managed_xml' : 'unknown',
        rawMatches,
        invalidToolNames,
      })
    }

    const cleanContent = rawMatches
      .reduce((acc, raw) => acc.replace(raw, ''), parseable)
      .replace(DSML_STRIP_REGEX, '')
      .trim()

    return createParseResult({
      content: cleanContent,
      toolCalls,
      protocol: 'managed_xml',
      rawMatches,
      invalidToolNames,
    })
  },

  formatAssistantToolCalls(calls) {
    const invokes = calls.map((call) => {
      const args = safeParseObject(call.arguments)
      const params = Object.entries(args)
        .map(([name, value]) => {
          const text = typeof value === 'string' ? value : JSON.stringify(value)
          return `<|CHAT2API|parameter name="${escapeXmlAttribute(name)}"><![CDATA[${text}]]></|CHAT2API|parameter>`
        })
        .join('')
      return `<|CHAT2API|invoke name="${escapeXmlAttribute(call.name)}">${params}</|CHAT2API|invoke>`
    })
    return `${CHAT2API_START}${invokes.join('')}${CHAT2API_END}`
  },

  formatToolResult(result) {
    return `<|CHAT2API|tool_result tool_call_id="${escapeXmlAttribute(result.toolCallId)}"><![CDATA[${result.content}]]></|CHAT2API|tool_result>`
  },
}

interface ParseBlockOptions {
  blockPattern: RegExp
  invokePattern: RegExp
  parameterPattern: RegExp
  rawMatches: string[]
  invalidToolNames: string[]
  allowedNames: Set<string>
  toolCalls: ReturnType<typeof buildToolCall>[]
}

function parseBlocks(content: string, options: ParseBlockOptions): void {
  let blockMatch: RegExpExecArray | null

  while ((blockMatch = options.blockPattern.exec(content)) !== null) {
    options.rawMatches.push(blockMatch[0])
    let invokeMatch: RegExpExecArray | null

    while ((invokeMatch = options.invokePattern.exec(blockMatch[1])) !== null) {
      let name = invokeMatch[1].trim()
      if (options.allowedNames.size > 0 && !options.allowedNames.has(name)) {
        if (name === 'shell' && options.allowedNames.has('bash')) {
          name = 'bash'
        } else if (name === 'bash' && options.allowedNames.has('shell')) {
          name = 'shell'
        } else {
          const found = Array.from(options.allowedNames).find(
            (n) => n.toLowerCase() === name.toLowerCase(),
          )
          if (found) {
            name = found
          } else {
            options.invalidToolNames.push(name)
            continue
          }
        }
      }

      const args: Record<string, unknown> = {}
      let parameterMatch: RegExpExecArray | null
      options.parameterPattern.lastIndex = 0
      while ((parameterMatch = options.parameterPattern.exec(invokeMatch[2])) !== null) {
        addParameter(args, parameterMatch[1].trim(), parseJsonValue(parameterMatch[2]))
      }

      options.toolCalls.push(
        buildToolCall(`call_${options.toolCalls.length}`, options.toolCalls.length, name, JSON.stringify(args), invokeMatch[0]),
      )
    }
  }
}

function safeParseObject(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
  } catch {
    return {}
  }
}
