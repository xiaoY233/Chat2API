import type {
  NormalizedToolDefinition,
  NormalizedToolResult,
  ToolParseContext,
  ToolParseResult,
  ToolProtocolId,
} from '../types.ts'

export interface ToolProtocolDetection {
  matched: boolean
  partial: boolean
  markerStart?: number
}

export interface ToolProtocolAdapter {
  id: ToolProtocolId
  renderPrompt(tools: NormalizedToolDefinition[]): string
  detectStart(buffer: string): ToolProtocolDetection
  parse(content: string, context: ToolParseContext): ToolParseResult
  formatAssistantToolCalls(calls: Array<{ id: string; name: string; arguments: string }>): string
  formatToolResult(result: NormalizedToolResult): string
}
