import type { ToolProtocolAdapter } from './base.ts'
import type { ToolProtocolId } from '../types.ts'
import { managedBracketProtocol } from './managedBracket.ts'
import { managedXmlProtocol } from './managedXml.ts'
import { qwenHermesProtocol } from './qwenHermes.ts'
import { anthropicToolUseProtocol } from './anthropicToolUse.ts'
import { codexResponsesProtocol } from './codexResponses.ts'

const protocols: Record<ToolProtocolId, ToolProtocolAdapter> = {
  openai_chat: managedBracketProtocol,
  managed_bracket: managedBracketProtocol,
  managed_xml: managedXmlProtocol,
  qwen_hermes: qwenHermesProtocol,
  anthropic_tool_use: anthropicToolUseProtocol,
  codex_responses: codexResponsesProtocol,
}

export function getToolProtocol(id: ToolProtocolId): ToolProtocolAdapter {
  return protocols[id]
}

export function getManagedProtocols(): ToolProtocolAdapter[] {
  return [
    managedBracketProtocol,
    managedXmlProtocol,
    qwenHermesProtocol,
    anthropicToolUseProtocol,
    codexResponsesProtocol,
  ]
}
