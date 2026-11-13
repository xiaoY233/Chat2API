import type { ToolProtocolAdapter } from './base.ts'
import type { ToolParseContext } from '../types.ts'
import {
  buildToolCall,
  createParseResult,
  genericToolResultBlock,
  detectMarkers,
  removeToolBlocks,
  renderCompactToolList,
  renderToolList,
  toolNames,
} from './shared.ts'

const START_MARKER = '[function_calls]'
const END_MARKER = '[/function_calls]'

export const managedBracketProtocol: ToolProtocolAdapter = {
  id: 'managed_bracket',

  renderPrompt(tools, options) {
    if (options?.coding) {
      return `## Tool Calling (Coding Mode)
You are operating as a coding agent. Use the tools below to inspect and modify the workspace.

${renderCompactToolList(tools)}

To call one or more tools, reply with exactly one compact block and nothing else:

[function_calls]
[call:exact_tool_name]{"argument":"value"}[/call]
[/function_calls]

Rules:
- Use the exact tool name from the list above. Do not translate, shorten, rename, or invent tool names.
- Arguments must be valid compact JSON on one line, matching the tool's schema.
- Put every call for this step inside the same [function_calls] block, one [call:...]...[/call] per tool.
- Do not wrap the block in markdown code fences. Do not print it as an example. Emit it to actually run the tool.
- Do not add text before or after the block when calling a tool.
- Ignore any earlier instructions that describe a different tool-call format. This format overrides them.
- After a tool result arrives, continue the task and call the next tool if needed.`
    }

    return `## Available Tools
You can invoke the following developer tools. Tool names are case-sensitive.

${renderToolList(tools)}

When calling tools, respond with only this block:

[function_calls]
[call:exact_tool_name]{"argument":"value"}[/call]
[/function_calls]`
  },

  detectStart(buffer) {
    return detectMarkers(buffer, [START_MARKER])
  },

  parse(content: string, context: ToolParseContext) {
    const allowedNames = toolNames(context.tools)
    const rawMatches: string[] = []
    const invalidToolNames: string[] = []
    const toolCalls = []
    const blockPattern = /\[function_calls\]([\s\S]*?)\[\/function_calls\]/g
    let blockMatch: RegExpExecArray | null

    while ((blockMatch = blockPattern.exec(content)) !== null) {
      rawMatches.push(blockMatch[0])
      const callPattern = /\[call:([^\]]+)\]([\s\S]*?)\[\/call\]/g
      let callMatch: RegExpExecArray | null

      while ((callMatch = callPattern.exec(blockMatch[1])) !== null) {
        const name = callMatch[1].trim()
        if (!allowedNames.has(name)) {
          invalidToolNames.push(name)
          continue
        }

        toolCalls.push(buildToolCall(`call_${toolCalls.length}`, toolCalls.length, name, callMatch[2], callMatch[0]))
      }
    }

    if (toolCalls.length === 0) {
      return createParseResult({
        content,
        toolCalls,
        protocol: rawMatches.length > 0 ? 'managed_bracket' : 'unknown',
        rawMatches,
        invalidToolNames,
      })
    }

    return createParseResult({
      content: removeToolBlocks(content, rawMatches),
      toolCalls,
      protocol: 'managed_bracket',
      rawMatches,
      invalidToolNames,
    })
  },

  formatAssistantToolCalls(calls) {
    const body = calls.map((call) => `[call:${call.name}]${call.arguments}[/call]`).join('\n')
    return `${START_MARKER}\n${body}\n${END_MARKER}`
  },

  formatToolResult(result) {
    return genericToolResultBlock(result)
  },
}
