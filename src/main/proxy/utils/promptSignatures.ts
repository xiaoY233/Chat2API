/**
 * Prompt Signature Detection Module
 * Re-exports from unified signatures module
 * 
 * This module provides backward compatibility for existing imports
 */

import { ChatMessage } from '../types'
import {
  ClientType,
  DetectionResult,
  CLIENT_SIGNATURES,
  GENERAL_TOOL_SIGNATURES,
  detectClientFromContent,
  hasGeneralToolPromptSignature,
  isKnownClient,
} from '../constants/signatures'

// Re-export types
export type { ClientType, DetectionResult }

// Re-export constants
export { CLIENT_SIGNATURES, GENERAL_TOOL_SIGNATURES }

// Re-export functions
export { detectClientFromContent, hasGeneralToolPromptSignature, isKnownClient }

/**
 * Detect client prompt type from messages
 */
export function detectClientPromptType(messages: ChatMessage[]): DetectionResult {
  const allContent = extractAllContent(messages)
  
  if (!allContent) {
    return {
      clientType: 'unknown',
      confidence: 0,
      matchedSignatures: [],
      toolCallFormat: 'bracket',
      injectsPrompt: false,
    }
  }

  return detectClientFromContent(allContent)
}

/**
 * Check if any tool prompt has been injected
 */
export function hasAnyToolPromptInjected(messages: ChatMessage[]): boolean {
  const allContent = extractAllContent(messages)
  return hasGeneralToolPromptSignature(allContent)
}

/**
 * Check if client has injected prompt
 */
export function hasClientPromptInjected(messages: ChatMessage[], clientType: ClientType): boolean {
  const allContent = extractAllContent(messages)
  const result = detectClientFromContent(allContent)
  return result.clientType === clientType && isKnownClient(clientType)
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
            parts.push((part as { text: string }).text)
          }
        }
      }
    }
  }

  return parts.join('\n')
}

/**
 * Clean tool prompts from messages (backward compatibility)
 */
export function cleanClientToolPrompts(messages: ChatMessage[]): ChatMessage[] {
  // Detection and cleaning is now handled by clientDetector
  // This function is kept for backward compatibility
  return messages
}

/**
 * Check if tool prompt is injected (backward compatibility)
 */
export function hasToolPromptInjected(messages: ChatMessage[]): boolean {
  return hasAnyToolPromptInjected(messages)
}
