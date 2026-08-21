import type { ChatMessage } from '../types.ts'
import { stripManagedToolResultWrappers } from './managedToolResultGuard.ts'
import type { ToolProtocolId } from './types.ts'

const ASSISTANT_AUXILIARY_TEXT_FIELDS = [
  'reasoning_content',
  'reasoning',
  'thinking',
  'summary',
] as const

const VISIBLE_ASSISTANT_BLOCK_TYPES = new Set([
  'text',
  'output_text',
  'reasoning',
  'thinking',
  'summary',
])

export interface AssistantInputBoundaryResult {
  messages: ChatMessage[]
  contaminatedFieldCount: number
  removedMessageCount: number
}

/**
 * Removes legacy provider-generated tool-result envelopes before conversation
 * history is sent upstream again. Structured tool calls and their arguments
 * remain untouched; a contaminated visible text block is discarded as a
 * whole because surrounding prose belongs to the same untrusted generation.
 */
export function sanitizeAssistantInputHistory(
  messages: ChatMessage[],
  protectedToolCallProtocol: ToolProtocolId | null = 'managed_xml',
): AssistantInputBoundaryResult {
  let contaminatedFieldCount = 0
  let removedMessageCount = 0
  const sanitizedMessages: ChatMessage[] = []

  for (const message of messages) {
    if (message.role !== 'assistant') {
      sanitizedMessages.push({ ...message })
      continue
    }

    let contaminated = false
    let content: ChatMessage['content'] = message.content

    if (typeof message.content === 'string') {
      if (containsManagedToolResultWrapper(message.content, protectedToolCallProtocol)) {
        contaminated = true
        contaminatedFieldCount += 1
        content = null
      }
    } else if (Array.isArray(message.content)) {
      const sanitizedParts: unknown[] = []
      for (const part of message.content) {
        if (typeof part === 'string') {
          if (containsManagedToolResultWrapper(part, protectedToolCallProtocol)) {
            contaminated = true
            contaminatedFieldCount += 1
          } else {
            sanitizedParts.push(part)
          }
          continue
        }

        if (!part || typeof part !== 'object' || Array.isArray(part)) {
          sanitizedParts.push(part)
          continue
        }

        const record = part as unknown as Record<string, unknown>
        const type = typeof record.type === 'string' ? record.type : undefined
        if (type && !VISIBLE_ASSISTANT_BLOCK_TYPES.has(type)) {
          sanitizedParts.push(part)
          continue
        }

        const textFields = ['text', 'content'] as const
        const contaminatedPart = textFields.some(field => (
          typeof record[field] === 'string'
          && containsManagedToolResultWrapper(
            record[field] as string,
            protectedToolCallProtocol,
          )
        ))
        if (contaminatedPart) {
          contaminated = true
          contaminatedFieldCount += 1
          continue
        }
        sanitizedParts.push(part)
      }
      content = sanitizedParts.length > 0
        ? sanitizedParts as ChatMessage['content']
        : null
    }

    const sanitizedRecord: Record<string, unknown> = {
      ...message,
      content,
    }
    for (const field of ASSISTANT_AUXILIARY_TEXT_FIELDS) {
      const value = sanitizedRecord[field]
      if (
        typeof value === 'string'
        && containsManagedToolResultWrapper(value, null)
      ) {
        contaminated = true
        contaminatedFieldCount += 1
        sanitizedRecord[field] = undefined
      }
    }

    const sanitizedMessage = sanitizedRecord as unknown as ChatMessage
    if (contaminated && !hasAssistantPayload(sanitizedRecord)) {
      removedMessageCount += 1
      continue
    }
    sanitizedMessages.push(sanitizedMessage)
  }

  return {
    messages: sanitizedMessages,
    contaminatedFieldCount,
    removedMessageCount,
  }
}

function containsManagedToolResultWrapper(
  value: string,
  protectedToolCallProtocol: ToolProtocolId | null,
): boolean {
  return stripManagedToolResultWrappers(
    value,
    protectedToolCallProtocol,
  ).wrapperLeakDetected
}

function hasAssistantPayload(message: Record<string, unknown>): boolean {
  const content = message.content
  if (typeof content === 'string' && content.length > 0) return true
  if (Array.isArray(content) && content.length > 0) return true

  const toolCalls = message.tool_calls
  if (Array.isArray(toolCalls) && toolCalls.length > 0) return true

  return ASSISTANT_AUXILIARY_TEXT_FIELDS.some(field => (
    typeof message[field] === 'string' && (message[field] as string).length > 0
  ))
}
