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
  /**
   * Render a compact, tool-call-only reminder for an unresolved failed tool
   * result. It is sent as a fresh provider turn, so it must restate the exact
   * protocol without copying tool-result content or request-specific values.
   */
  renderRecoveryPrompt?(tools: NormalizedToolDefinition[]): string
  detectStart(buffer: string): ToolProtocolDetection
  parse(content: string, context: ToolParseContext): ToolParseResult
  formatAssistantToolCalls(calls: Array<{ id: string; name: string; arguments: string }>): string
  formatToolResult(result: NormalizedToolResult): string
}
