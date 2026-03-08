/**
 * Prompt Signature Detection Module
 * Detects if tool prompts have been injected by various AI clients
 */

import { ChatMessage } from '../types'

/**
 * Client types that may inject tool prompts
 */
export type ClientType =
  | 'cline'
  | 'kilocode'
  | 'rooCode'
  | 'vscodeCopilot'
  | 'cherryStudio'
  | 'anthropic'
  | 'openai'
  | 'unknown'

/**
 * Signature patterns for different clients
 * Each client has unique patterns in their injected prompts
 */
export const CLIENT_PROMPT_SIGNATURES: Record<ClientType, string[]> = {
  cline: [
    'TOOL USE',
    'When using tools, follow this format',
    'function_calls block',
    '## Tool Use',
    'When invoking a tool',
    'tool_use_format',
    '## Available Tools',
    'Tool Call Protocol',
    '[function_calls]',
    'TOOL_WRAP_HINT',
  ],
  kilocode: [
    'You are Kilo',
    '## Tools',
    'Tool definitions:',
    'You are an expert software engineer',
    '## Tool Use',
    'When using tools',
  ],
  rooCode: [
    '## Tool Use Guidelines',
    'TOOL USE',
    'You have access to tools',
    '## Tool Use',
    'When invoking a tool',
    'tool_use_format',
    '## Capabilities',
    '## Rules',
    '## Objective',
  ],
  vscodeCopilot: [
    'You are an AI programming assistant',
    'Copilot',
    'tool_use_format',
    'You have access to tools',
    'When using tools',
    '## Tools',
    'VS Code',
  ],
  cherryStudio: [
    '## Available Tools',
    'Tool Call Protocol',
    '[function_calls]',
    '<tool_use>',
    'TOOL_WRAP_HINT',
    'You can invoke the following developer tools',
    'Tool Call Formatting',
  ],
  anthropic: [
    'In this environment you have access to tools',
    '<antml:function_calls>',
    'antml:function_calls',
    'In this environment',
    'you have access to a set of tools',
  ],
  openai: [
    'You are a helpful assistant',
    'function_call',
    'tool_calls',
    'You have access to functions',
  ],
  unknown: [],
}

/**
 * Detection result with confidence level
 */
export interface DetectionResult {
  clientType: ClientType
  confidence: number
  matchedSignatures: string[]
}

/**
 * Detect which client type has injected the prompt
 * Returns the most likely client with confidence score
 */
export function detectClientPromptType(messages: ChatMessage[]): DetectionResult {
  const allContent = extractAllContent(messages)
  
  if (!allContent) {
    return { clientType: 'unknown', confidence: 0, matchedSignatures: [] }
  }

  const results: DetectionResult[] = []

  for (const [clientType, signatures] of Object.entries(CLIENT_PROMPT_SIGNATURES)) {
    if (clientType === 'unknown') continue

    const matchedSignatures: string[] = []
    
    for (const sig of signatures) {
      if (allContent.includes(sig)) {
        matchedSignatures.push(sig)
      }
    }

    if (matchedSignatures.length > 0) {
      const confidence = matchedSignatures.length / signatures.length
      results.push({
        clientType: clientType as ClientType,
        confidence,
        matchedSignatures,
      })
    }
  }

  if (results.length === 0) {
    return { clientType: 'unknown', confidence: 0, matchedSignatures: [] }
  }

  results.sort((a, b) => b.confidence - a.confidence)

  return results[0]
}

/**
 * Check if any tool prompt has been injected by any known client
 */
export function hasAnyToolPromptInjected(messages: ChatMessage[]): boolean {
  const result = detectClientPromptType(messages)
  return result.clientType !== 'unknown' && result.confidence > 0
}

/**
 * Check if a specific client has injected the prompt
 */
export function hasClientPromptInjected(
  messages: ChatMessage[],
  clientType: ClientType
): boolean {
  const allContent = extractAllContent(messages)
  
  if (!allContent) {
    return false
  }

  const signatures = CLIENT_PROMPT_SIGNATURES[clientType]
  
  for (const sig of signatures) {
    if (allContent.includes(sig)) {
      return true
    }
  }

  return false
}

/**
 * Get all matched signatures from messages
 */
export function getMatchedSignatures(messages: ChatMessage[]): Map<ClientType, string[]> {
  const allContent = extractAllContent(messages)
  const result = new Map<ClientType, string[]>()

  if (!allContent) {
    return result
  }

  for (const [clientType, signatures] of Object.entries(CLIENT_PROMPT_SIGNATURES)) {
    if (clientType === 'unknown') continue

    const matched: string[] = []
    
    for (const sig of signatures) {
      if (allContent.includes(sig)) {
        matched.push(sig)
      }
    }

    if (matched.length > 0) {
      result.set(clientType as ClientType, matched)
    }
  }

  return result
}

/**
 * Extract all text content from messages
 */
function extractAllContent(messages: ChatMessage[]): string {
  const parts: string[] = []

  for (const msg of messages) {
    if (msg.role === 'system' || msg.role === 'user' || msg.role === 'assistant') {
      if (typeof msg.content === 'string') {
        parts.push(msg.content)
      } else if (Array.isArray(msg.content)) {
        for (const part of msg.content) {
          if (typeof part === 'string') {
            parts.push(part)
          } else if (part && typeof part === 'object' && 'text' in part) {
            parts.push(part.text)
          }
        }
      }
    }
  }

  return parts.join('\n')
}

/**
 * Legacy function for backward compatibility
 * Uses the same signature patterns as the original tools.ts
 */
export const TOOL_PROMPT_SIGNATURES = [
  '## Available Tools',
  '## Tool Call Protocol',
  '[function_calls]',
  'TOOL_WRAP_HINT',
  'You can invoke the following developer tools',
  'Tool Call Formatting',
]

/**
 * Legacy function for backward compatibility
 */
export function hasToolPromptInjected(messages: ChatMessage[]): boolean {
  return hasAnyToolPromptInjected(messages)
}
