import type { ToolProtocolAdapter } from './base.ts'
import type { ToolProtocolId } from '../types.ts'
import { managedBracketProtocol } from './managedBracket.ts'
import { managedXmlProtocol } from './managedXml.ts'
import { anthropicToolUseProtocol } from './anthropicToolUse.ts'
import { codexResponsesProtocol } from './codexResponses.ts'
import { jsonToolCallsProtocol } from './jsonToolCalls.ts'
import { cherryToolUseProtocol } from './cherryToolUse.ts'
import { xmlToolTagProtocol } from './xmlToolTag.ts'

const protocols: Record<ToolProtocolId, ToolProtocolAdapter> = {
  openai_chat: managedBracketProtocol,
  managed_bracket: managedBracketProtocol,
  managed_xml: managedXmlProtocol,
  anthropic_tool_use: anthropicToolUseProtocol,
  codex_responses: codexResponsesProtocol,
  json_tool_calls: jsonToolCallsProtocol,
  cherry_tool_use: cherryToolUseProtocol,
  xml_tool_tag: xmlToolTagProtocol,
}

export function getToolProtocol(id: ToolProtocolId): ToolProtocolAdapter {
  return protocols[id]
}

export function getManagedProtocols(): ToolProtocolAdapter[] {
  return [
    managedBracketProtocol,
    managedXmlProtocol,
    anthropicToolUseProtocol,
    cherryToolUseProtocol,
    xmlToolTagProtocol,
    jsonToolCallsProtocol,
    codexResponsesProtocol,
  ]
}
