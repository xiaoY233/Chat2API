import type { ToolProtocolAdapter } from './base.ts'
import type { ToolParseContext } from '../types.ts'
import {
  buildToolCall,
  createParseResult,
  genericToolResultBlock,
  detectMarkers,
  getMissingRequiredArguments,
  renderToolList,
  stripFencedCodeBlocks,
  toolNames,
} from './shared.ts'

const START_MARKER = '[function_calls]'
const END_MARKER = '[/function_calls]'

export const managedBracketProtocol: ToolProtocolAdapter = {
  id: 'managed_bracket',

  renderPrompt(tools) {
    return `## Available Tools
You can invoke the following developer tools. Tool names are case-sensitive.

${renderToolList(tools)}

Tool-use requirements:
- Use only tools from the Available Tools list, which is the client-declared managed tool set. Do not invoke or rely on undeclared provider-side tools or capabilities.
- If the user asks you to inspect files, create or modify files, run commands, install dependencies, execute tests, or verify behavior in the environment, you must call the appropriate tool.
- Do not claim that files were created, commands were run, tests passed, or behavior was verified unless the corresponding tool result shows it.
- If a tool argument schema says a field is an array, provide a JSON array for that field, even when there is only one item.
- Each tool call must include every field listed in that tool schema's required array in the same call; do not send an empty tool call or split required fields across multiple calls.
- If a tool call fails because the arguments do not match the schema, fix the arguments according to the schema and call the tool again.

When calling tools, respond with only this block:

[function_calls]
[call:exact_tool_name]{"argument":"value"}[/call]
[/function_calls]`
  },

  detectStart(buffer) {
    return detectMarkers(buffer, [START_MARKER])
  },

  parse(content: string, context: ToolParseContext) {
    const parseable = stripFencedCodeBlocks(content)
    const allowedNames = toolNames(context.tools)
    const rawMatches: string[] = []
    const invalidToolNames: string[] = []
    const toolCalls = []
    const toolDefinitions = new Map(context.tools.map((tool) => [tool.name, tool]))
    const blockPattern = /\[function_calls\]([\s\S]*?)\[\/function_calls\]/g
    let blockMatch: RegExpExecArray | null

    while ((blockMatch = blockPattern.exec(parseable)) !== null) {
      rawMatches.push(blockMatch[0])
      const callPattern = /\[call:([^\]]+)\]([\s\S]*?)\[\/call\]/g
      let callMatch: RegExpExecArray | null

      while ((callMatch = callPattern.exec(blockMatch[1])) !== null) {
        const name = callMatch[1].trim()
        if (!allowedNames.has(name)) {
          invalidToolNames.push(name)
          continue
        }

        const tool = toolDefinitions.get(name)
        if (getMissingRequiredArguments(callMatch[2], tool).length > 0) {
          continue
        }

        toolCalls.push(
          buildToolCall(
            `call_${toolCalls.length}`,
            toolCalls.length,
            name,
            callMatch[2],
            callMatch[0],
            tool,
          ),
        )
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

    const cleanContent = rawMatches.reduce((acc, raw) => acc.replace(raw, ''), parseable).trim()
    return createParseResult({
      content: cleanContent,
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
