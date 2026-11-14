import type { ToolProtocolAdapter } from './base.ts'
import type { ToolParseContext } from '../types.ts'
import {
  buildToolCall,
  createParseResult,
  detectMarkers,
  genericToolResultBlock,
  removeToolBlocks,
  renderToolList,
  toolNames,
} from './shared.ts'

/**
 * Cherry Studio / generic XML tool invocation:
 *
 * <tool_use>
 *   <name>read_file</name>
 *   <arguments>{"path":"/tmp/a"}</arguments>
 * </tool_use>
 *
 * Also accepts the attribute form:
 *
 * <tool_use name="read_file">{"path":"/tmp/a"}</tool_use>
 */
export const cherryToolUseProtocol: ToolProtocolAdapter = {
  id: 'cherry_tool_use',

  renderPrompt(tools) {
    return `## Available Tools
${renderToolList(tools)}

When calling a tool, respond with:

<tool_use>
<name>exact_tool_name</name>
<arguments>{"argument":"value"}</arguments>
</tool_use>`
  },

  detectStart(buffer) {
    return detectMarkers(buffer, ['<tool_use>', '<tool_use '])
  },

  parse(content: string, context: ToolParseContext) {
    const allowedNames = toolNames(context.tools)
    const rawMatches: string[] = []
    const invalidToolNames: string[] = []
    const toolCalls = []

    const patterns: Array<{
      pattern: RegExp
      nameIndex: number
      argsIndex: number
    }> = [
      {
        pattern: /<tool_use>\s*<name>([^<]+)<\/name>\s*<arguments>([\s\S]*?)<\/arguments>\s*<\/tool_use>/gi,
        nameIndex: 1,
        argsIndex: 2,
      },
      {
        pattern: /<tool_use\s+name="([^"]+)"\s*>([\s\S]*?)<\/tool_use>/gi,
        nameIndex: 1,
        argsIndex: 2,
      },
      {
        pattern: /<tool_name>([^<]+)<\/tool_name>\s*<tool_args>([\s\S]*?)<\/tool_args>/gi,
        nameIndex: 1,
        argsIndex: 2,
      },
    ]

    for (const { pattern, nameIndex, argsIndex } of patterns) {
      let match: RegExpExecArray | null
      while ((match = pattern.exec(content)) !== null) {
        rawMatches.push(match[0])
        const name = match[nameIndex].trim()
        if (!allowedNames.has(name)) {
          invalidToolNames.push(name)
          continue
        }

        let args = match[argsIndex].trim()
        const nested = args.match(/<arguments>([\s\S]*?)<\/arguments>/i)
        if (nested) args = nested[1]

        toolCalls.push(
          buildToolCall(`call_${toolCalls.length}`, toolCalls.length, name, args, match[0]),
        )
      }
    }

    if (toolCalls.length === 0) {
      return createParseResult({
        content,
        toolCalls,
        protocol: rawMatches.length > 0 ? 'cherry_tool_use' : 'unknown',
        rawMatches,
        invalidToolNames,
      })
    }

    return createParseResult({
      content: removeToolBlocks(content, rawMatches),
      toolCalls,
      protocol: 'cherry_tool_use',
      rawMatches,
      invalidToolNames,
    })
  },

  formatAssistantToolCalls(calls) {
    const body = calls
      .map((call) => `<tool_use><name>${call.name}</name><arguments>${call.arguments}</arguments></tool_use>`)
      .join('')
    return body
  },

  formatToolResult(result) {
    return genericToolResultBlock(result)
  },
}
