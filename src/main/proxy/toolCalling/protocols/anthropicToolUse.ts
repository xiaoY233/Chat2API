import type { ToolProtocolAdapter } from './base.ts'
import {
  buildToolCall,
  createParseResult,
  genericToolResultBlock,
  detectMarkers,
  renderToolList,
  stripFencedCodeBlocks,
  toolNames,
} from './shared.ts'

export const anthropicToolUseProtocol: ToolProtocolAdapter = {
  id: 'anthropic_tool_use',

  renderPrompt(tools) {
    return `## Available Tools
${renderToolList(tools)}

Use Anthropic-style tool invocation only when this protocol is enabled.`
  },

  detectStart(buffer) {
    return detectMarkers(buffer, ['<antml:function_calls>'])
  },

  parse(content, context) {
    const parseable = stripFencedCodeBlocks(content)
    const allowedNames = toolNames(context.tools)
    const rawMatches: string[] = []
    const invalidToolNames: string[] = []
    const toolCalls = []
    const blockPattern = /<antml:function_calls>([\s\S]*?)<\/antml:function_calls>/g
    let blockMatch: RegExpExecArray | null

    while ((blockMatch = blockPattern.exec(parseable)) !== null) {
      rawMatches.push(blockMatch[0])
      const invokePattern = /<antml:invoke\s+name="([^"]+)"\s*>([\s\S]*?)<\/antml:invoke>/g
      let invokeMatch: RegExpExecArray | null

      while ((invokeMatch = invokePattern.exec(blockMatch[1])) !== null) {
        const name = invokeMatch[1].trim()
        if (!allowedNames.has(name)) {
          invalidToolNames.push(name)
          continue
        }

        const parameters = invokeMatch[2].match(/<antml:parameters>([\s\S]*?)<\/antml:parameters>/)
        toolCalls.push(
          buildToolCall(
            `call_${toolCalls.length}`,
            toolCalls.length,
            name,
            parameters ? parameters[1] : '{}',
            invokeMatch[0],
          ),
        )
      }
    }

    if (toolCalls.length === 0) {
      return createParseResult({
        content,
        toolCalls,
        protocol: rawMatches.length > 0 ? 'anthropic_tool_use' : 'unknown',
        rawMatches,
        invalidToolNames,
      })
    }

    return createParseResult({
      content: rawMatches.reduce((acc, raw) => acc.replace(raw, ''), parseable).trim(),
      toolCalls,
      protocol: 'anthropic_tool_use',
      rawMatches,
      invalidToolNames,
    })
  },

  formatAssistantToolCalls(calls) {
    const body = calls
      .map((call) => `<antml:invoke name="${call.name}"><antml:parameters>${call.arguments}</antml:parameters></antml:invoke>`)
      .join('')
    return `<antml:function_calls>${body}</antml:function_calls>`
  },

  formatToolResult(result) {
    return genericToolResultBlock(result)
  },
}
