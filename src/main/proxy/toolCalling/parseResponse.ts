import { getToolProtocol } from './protocols/index.ts'
import type { ToolCallingPlan, ToolParseResult, ToolProtocolId } from './types.ts'

const FALLBACK_PROTOCOLS: ToolProtocolId[] = [
  'managed_xml',
  'managed_bracket',
  'anthropic_tool_use',
  'cherry_tool_use',
  'xml_tool_tag',
  'json_tool_calls',
  'codex_responses',
]

/**
 * Protocol order for a request: the selected protocol first, then every known
 * fallback. Models frequently ignore the injected prompt and answer in a
 * format they know from their training data, so parsing must be tolerant.
 */
export function getProtocolCandidates(plan: ToolCallingPlan): ToolProtocolId[] {
  const candidates: ToolProtocolId[] = [plan.protocol]
  for (const protocol of FALLBACK_PROTOCOLS) {
    if (!candidates.includes(protocol)) candidates.push(protocol)
  }
  return candidates
}

export function parseToolResponse(content: string, plan: ToolCallingPlan): ToolParseResult {
  let diagnostic: ToolParseResult | undefined

  for (const protocol of getProtocolCandidates(plan)) {
    const result = getToolProtocol(protocol).parse(content, {
      tools: plan.tools,
      protocol,
    })

    if (result.toolCalls.length > 0) {
      return {
        ...result,
        protocol,
      }
    }

    if (
      !diagnostic &&
      (result.rawMatches.length > 0 || result.invalidToolNames.length > 0 || result.malformedReason)
    ) {
      diagnostic = result
    }
  }

  return diagnostic ?? {
    content,
    toolCalls: [],
    protocol: 'unknown',
    rawMatches: [],
    invalidToolNames: [],
  }
}
