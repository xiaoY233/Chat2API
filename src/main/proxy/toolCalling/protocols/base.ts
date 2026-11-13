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

export interface ToolPromptRenderOptions {
  coding?: boolean
}

export interface ToolProtocolAdapter {
  id: ToolProtocolId
  renderPrompt(tools: NormalizedToolDefinition[], options?: ToolPromptRenderOptions): string
  detectStart(buffer: string, tools?: NormalizedToolDefinition[]): ToolProtocolDetection
  parse(content: string, context: ToolParseContext): ToolParseResult
  formatAssistantToolCalls(calls: Array<{ id: string; name: string; arguments: string }>): string
  formatToolResult(result: NormalizedToolResult): string
}
