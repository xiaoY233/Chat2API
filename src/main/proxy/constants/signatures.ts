/**
 * Unified Signature Definitions
 * Central definition for all tool prompt signatures
 */

/**
 * Client types that may inject tool prompts
 */
export type ClientType =
  | 'cline'
  | 'rooCode'
  | 'claudeCode'
  | 'cherryStudio'
  | 'kilocode'
  | 'codexCli'
  | 'vscodeAgent'
  | 'unknown'

/**
 * Tool call output format
 */
export type ToolCallFormat = 'bracket' | 'xml' | 'anthropic' | 'json' | 'native'

/**
 * Client signature configuration
 */
export interface ClientSignatureConfig {
  id: ClientType
  name: string
  detectPatterns: string[]
  toolCallFormat: ToolCallFormat
  injectsPrompt: boolean
  promptSectionMarkers?: {
    start: string
    end: string
  }
}

/**
 * Client signature registry
 * Each client has detection patterns and tool call format
 */
export const CLIENT_SIGNATURES: Record<ClientType, ClientSignatureConfig> = {
  cline: {
    id: 'cline',
    name: 'Cline',
    detectPatterns: [
      'TOOL USE',
      'When using tools, follow this format',
      'function_calls block',
      '## Tool Use',
      'When invoking a tool',
    ],
    toolCallFormat: 'xml',
    injectsPrompt: true,
    promptSectionMarkers: {
      start: 'TOOL USE',
      end: "USER'S CURRENT REQUEST",
    },
  },
  rooCode: {
    id: 'rooCode',
    name: 'RooCode',
    detectPatterns: [
      '## Tool Use Guidelines',
      'TOOL USE',
      'You are Roo',
      '## Tool Use',
      'When invoking a tool',
    ],
    toolCallFormat: 'xml',
    injectsPrompt: true,
  },
  claudeCode: {
    id: 'claudeCode',
    name: 'Claude Code',
    detectPatterns: [
      'interactive CLI tool',
      'Claude Code',
      'You are an interactive CLI tool',
      'claude-code',
    ],
    toolCallFormat: 'anthropic',
    injectsPrompt: true,
  },
  cherryStudio: {
    id: 'cherryStudio',
    name: 'Cherry Studio',
    detectPatterns: [
      'In this environment you have access to a set of tools',
      '## Tool Use Available Tools',
      '<tool_use>',
      '<tool_use_result>',
    ],
    toolCallFormat: 'xml',
    injectsPrompt: true,
    promptSectionMarkers: {
      start: 'In this environment you have access to a set of tools',
      end: '# User Instructions',
    },
  },
  kilocode: {
    id: 'kilocode',
    name: 'Kilocode',
    detectPatterns: [
      'You are Kilo',
      'Kilo, the best coding agent',
      '## Tools',
      'Tool definitions:',
    ],
    toolCallFormat: 'native',
    injectsPrompt: true,
  },
  codexCli: {
    id: 'codexCli',
    name: 'Codex CLI',
    detectPatterns: [
      'Codex CLI',
      'terminal-based coding assistant',
      'open source project led by OpenAI',
      'apply_patch',
    ],
    toolCallFormat: 'native',
    injectsPrompt: true,
  },
  vscodeAgent: {
    id: 'vscodeAgent',
    name: 'VSCode Agent',
    detectPatterns: [
      'GitHub Copilot',
      'AI programming assistant',
      'VS Code Agent',
    ],
    toolCallFormat: 'native',
    injectsPrompt: true,
  },
  unknown: {
    id: 'unknown',
    name: 'Unknown',
    detectPatterns: [],
    toolCallFormat: 'bracket',
    injectsPrompt: false,
  },
}

/**
 * General tool prompt signatures
 * Used to detect if any tool prompt has been injected
 */
export const GENERAL_TOOL_SIGNATURES = [
  '## Available Tools',
  '## Tool Call Protocol',
  '[function_calls]',
  'TOOL_WRAP_HINT',
  'You can invoke the following developer tools',
  'Tool Call Formatting',
  'TOOL USE',
  '## Tool Use',
  '## Tools',
]

/**
 * Format-specific signatures
 * Used to detect the output format of tool calls
 */
export const FORMAT_SIGNATURES: Record<ToolCallFormat, string[]> = {
  bracket: ['[function_calls]', '[call:', '[/function_calls]', '[/call]'],
  xml: ['<tool_use>', '<name>', '<arguments>', '</tool_use>', '<tool_name>'],
  anthropic: ['<antml:function_calls>', 'antml:invoke', '</antml:function_calls>'],
  json: ['"tool_calls"', '"function"', '"arguments"'],
  native: [],
}

/**
 * Detection result with confidence level
 */
export interface DetectionResult {
  clientType: ClientType
  confidence: number
  matchedSignatures: string[]
  toolCallFormat: ToolCallFormat
  injectsPrompt: boolean
}

/**
 * Tool source type
 */
export type ToolSource = 'openai' | 'mcp' | 'none'

/**
 * Tool detection result
 */
export interface ToolDetectionResult {
  source: ToolSource
  tools: any[] | null
  hasMCPDefinitions: boolean
}

/**
 * Check if content contains any general tool prompt signature
 */
export function hasGeneralToolPromptSignature(content: string): boolean {
  return GENERAL_TOOL_SIGNATURES.some((sig) => content.includes(sig))
}

/**
 * Detect client type from content
 */
export function detectClientFromContent(content: string): DetectionResult {
  const results: Array<{
    clientType: ClientType
    confidence: number
    matchedSignatures: string[]
  }> = []

  for (const [clientType, config] of Object.entries(CLIENT_SIGNATURES)) {
    if (clientType === 'unknown') continue

    const matchedSignatures = config.detectPatterns.filter((pattern) =>
      content.includes(pattern)
    )

    if (matchedSignatures.length > 0) {
      const confidence = matchedSignatures.length / config.detectPatterns.length
      results.push({
        clientType: clientType as ClientType,
        confidence,
        matchedSignatures,
      })
    }
  }

  if (results.length === 0) {
    return {
      clientType: 'unknown',
      confidence: 0,
      matchedSignatures: [],
      toolCallFormat: 'bracket',
      injectsPrompt: false,
    }
  }

  results.sort((a, b) => b.confidence - a.confidence)
  const bestMatch = results[0]
  const config = CLIENT_SIGNATURES[bestMatch.clientType]

  return {
    ...bestMatch,
    toolCallFormat: config.toolCallFormat,
    injectsPrompt: config.injectsPrompt,
  }
}

/**
 * Detect tool call format from content
 */
export function detectToolCallFormat(content: string): ToolCallFormat {
  for (const [format, signatures] of Object.entries(FORMAT_SIGNATURES)) {
    if (signatures.some((sig) => content.includes(sig))) {
      return format as ToolCallFormat
    }
  }
  return 'bracket'
}

/**
 * Get client signature config by type
 */
export function getClientSignature(clientType: ClientType): ClientSignatureConfig {
  return CLIENT_SIGNATURES[clientType] || CLIENT_SIGNATURES.unknown
}

/**
 * Get all known client types
 */
export function getKnownClientTypes(): ClientType[] {
  return Object.keys(CLIENT_SIGNATURES).filter(
    (key) => key !== 'unknown'
  ) as ClientType[]
}

/**
 * Check if client type is known
 */
export function isKnownClient(clientType: ClientType): boolean {
  return clientType !== 'unknown'
}
