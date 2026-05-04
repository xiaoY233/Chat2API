/**
 * Utility to convert an array of chat messages into a single prompt string
 * that can be sent to any API, preserving full conversation context.
 *
 * This approach ensures multi-turn conversation works across all providers
 * without relying on provider-specific session management.
 */

import type { ChatMessage } from '../types'

export interface MessageContent {
  type: string
  text?: string
}

/**
 * Extract plain text content from a message, regardless of format
 */
export function extractTextContent(content: string | MessageContent[] | null | undefined): string {
  if (!content) return ''
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .filter(part => part.type === 'text' && part.text)
      .map(part => part.text)
      .join(' ')
  }
  return ''
}

/**
 * Convert an array of messages into a single prompt string.
 * Format:
 *   System: <system message>
 *
 *   User: <user message>
 *   Assistant: <assistant response>
 *   User: <next user message>
 *   ...
 */
export function messagesToPrompt(messages: ChatMessage[]): string {
  const parts: string[] = []

  for (const msg of messages) {
    const content = extractTextContent(msg.content)
    if (!content) continue

    switch (msg.role) {
      case 'system':
        parts.push(`System: ${content}`)
        break
      case 'user':
        parts.push(`User: ${content}`)
        break
      case 'assistant':
        parts.push(`Assistant: ${content}`)
        break
      case 'tool':
        // Tool responses are typically handled separately; include as user context
        parts.push(`Tool result: ${content}`)
        break
      default:
        // Unknown role, treat as user message to be safe
        parts.push(`User: ${content}`)
        break
    }
  }

  // Join with double newline for clear separation
  return parts.join('\n\n')
}

/**
 * Convert messages to prompt but preserve a system message separately
 * for providers that have a dedicated system prompt field.
 * Returns { systemPrompt: string, userPrompt: string }
 */
export function splitSystemAndUserMessages(messages: ChatMessage[]): {
  systemPrompt: string
  userPrompt: string
} {
  let systemPrompt = ''
  const userParts: string[] = []

  for (const msg of messages) {
    const content = extractTextContent(msg.content)
    if (!content) continue

    if (msg.role === 'system') {
      systemPrompt = systemPrompt ? `${systemPrompt}\n\n${content}` : content
    } else if (msg.role === 'user') {
      userParts.push(`User: ${content}`)
    } else if (msg.role === 'assistant') {
      userParts.push(`Assistant: ${content}`)
    } else if (msg.role === 'tool') {
      userParts.push(`Tool result: ${content}`)
    } else {
      userParts.push(`User: ${content}`)
    }
  }

  return {
    systemPrompt,
    userPrompt: userParts.join('\n\n'),
  }
}

/**
 * Estimate token count for a prompt string (rough approximation: 3 chars per token)
 */
export function estimatePromptTokens(prompt: string): number {
  return Math.ceil(prompt.length / 3)
}
