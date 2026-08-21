import type { ChatMessage } from '../types.ts'

const TOOL_CALL_CONTENT_TYPES = new Set([
  'tool_use',
  'server_tool_use',
  'bash_code_execution',
  'text_editor_code_execution',
  'computer_use',
])

const TOOL_RESULT_CONTENT_TYPES = new Set([
  'tool_result',
  'web_search_tool_result',
  'bash_code_execution_tool_result',
  'text_editor_code_execution_tool_result',
  'code_execution_tool_result',
])

/** Return true when a message contains an OpenAI or Anthropic tool call. */
export function isToolCallMessage(message: ChatMessage): boolean {
  if (Array.isArray(message.tool_calls) && message.tool_calls.length > 0) return true
  const legacyFunctionCall = (message as ChatMessage & { function_call?: unknown }).function_call
  if (legacyFunctionCall && typeof legacyFunctionCall === 'object') return true
  if (!Array.isArray(message.content)) return false

  return message.content.some((part) => {
    if (!part || typeof part !== 'object' || Array.isArray(part)) return false
    return TOOL_CALL_CONTENT_TYPES.has(String((part as { type?: unknown }).type || ''))
  })
}

/** Return true for OpenAI and Anthropic-style tool result messages. */
export function isToolResultMessage(message: ChatMessage): boolean {
  if (message.role === 'tool' || Boolean(message.tool_call_id)) return true
  if (!Array.isArray(message.content)) return false

  return message.content.some((part) => {
    if (!part || typeof part !== 'object' || Array.isArray(part)) return false
    return TOOL_RESULT_CONTENT_TYPES.has(String((part as { type?: unknown }).type || ''))
  })
}

/**
 * Validate the protocol boundary that opens a new model turn after client tool
 * execution. Results must form the trailing batch and match every ID in the
 * preceding call batch exactly once. A protocol bridge may split assistant
 * text from its tool calls and place that text between the call and result.
 */
export function hasTrailingMatchedToolResultBatch(messages: ChatMessage[]): boolean {
  const lastIndex = messages.length - 1
  if (lastIndex < 1 || !isToolResultMessage(messages[lastIndex])) return false

  let batchStartIndex = lastIndex
  while (batchStartIndex > 0 && isToolResultMessage(messages[batchStartIndex - 1])) {
    batchStartIndex -= 1
  }

  let callMessageIndex = batchStartIndex - 1
  while (
    callMessageIndex >= 0
    && isStrictAssistantTextOnlyMessage(messages[callMessageIndex])
  ) {
    callMessageIndex -= 1
  }

  const callMessage = messages[callMessageIndex]
  if (!callMessage) return false
  const callIds = getStrictManagedToolCallIds(callMessage)
  if (!callIds || callIds.length === 0) return false

  const resultIds: string[] = []
  const seenResultIds = new Set<string>()
  for (let index = batchStartIndex; index <= lastIndex; index += 1) {
    const ids = getStrictManagedToolResultIds(messages[index])
    if (!ids || ids.length === 0) return false
    for (const id of ids) {
      if (seenResultIds.has(id)) return false
      seenResultIds.add(id)
      resultIds.push(id)
    }
  }

  if (resultIds.length !== callIds.length) return false
  const callIdSet = new Set(callIds)
  return resultIds.every(resultId => callIdSet.has(resultId))
}

function isStrictAssistantTextOnlyMessage(message: ChatMessage): boolean {
  if (message.role !== 'assistant') return false
  const candidate = message as ChatMessage & {
    function_call?: unknown
    tool_calls?: unknown
    tool_call_id?: unknown
  }
  if (
    candidate.function_call !== undefined
    || candidate.tool_calls !== undefined
    || candidate.tool_call_id !== undefined
  ) {
    return false
  }

  if (typeof message.content === 'string') return true
  if (!Array.isArray(message.content) || message.content.length === 0) return false
  return message.content.every((part) => (
    Boolean(part)
    && typeof part === 'object'
    && !Array.isArray(part)
    && (part as { type?: unknown }).type === 'text'
    && typeof (part as { text?: unknown }).text === 'string'
  ))
}

function getStrictManagedToolCallIds(message: ChatMessage): string[] | undefined {
  if (message.role !== 'assistant') return undefined
  const legacyFunctionCall = (message as ChatMessage & { function_call?: unknown }).function_call
  if (legacyFunctionCall !== undefined) return undefined
  const rawToolCalls = (message as ChatMessage & { tool_calls?: unknown }).tool_calls
  if (rawToolCalls !== undefined && !Array.isArray(rawToolCalls)) return undefined

  const openAiIds: string[] = []
  if (Array.isArray(message.tool_calls)) {
    for (const call of message.tool_calls) {
      if (
        !call
        || call.type !== 'function'
        || typeof call.id !== 'string'
        || !call.id.trim()
        || !call.function
        || typeof call.function.name !== 'string'
        || !call.function.name.trim()
        || typeof call.function.arguments !== 'string'
      ) {
        return undefined
      }
      openAiIds.push(call.id)
    }
  }
  if (!hasUniqueIds(openAiIds)) return undefined

  if (!Array.isArray(message.content)) {
    if (message.content !== undefined && message.content !== null && typeof message.content !== 'string') {
      return undefined
    }
    return openAiIds
  }

  const anthropicIds: string[] = []
  for (const part of message.content) {
    if (!part || typeof part !== 'object' || Array.isArray(part)) return undefined
    const record = part as { type?: unknown; id?: unknown; name?: unknown; input?: unknown }
    const type = String(record.type || '')
    if (type !== 'tool_use') {
      if (TOOL_CALL_CONTENT_TYPES.has(type)) return undefined
      continue
    }
    if (
      typeof record.id !== 'string'
      || !record.id.trim()
      || typeof record.name !== 'string'
      || !record.name.trim()
      || !record.input
      || typeof record.input !== 'object'
      || Array.isArray(record.input)
    ) {
      return undefined
    }
    anthropicIds.push(record.id)
  }
  if (!hasUniqueIds(anthropicIds)) return undefined
  if (openAiIds.length === 0) return anthropicIds
  if (anthropicIds.length === 0) return openAiIds
  if (openAiIds.length !== anthropicIds.length) return undefined
  const anthropicIdSet = new Set(anthropicIds)
  return openAiIds.every(id => anthropicIdSet.has(id)) ? openAiIds : undefined
}

function getStrictManagedToolResultIds(message: ChatMessage): string[] | undefined {
  const legacyFunctionCall = (message as ChatMessage & { function_call?: unknown }).function_call
  const rawToolCalls = (message as ChatMessage & { tool_calls?: unknown }).tool_calls
  if (legacyFunctionCall !== undefined || rawToolCalls !== undefined) return undefined

  if (message.role === 'tool') {
    if (typeof message.tool_call_id !== 'string' || !message.tool_call_id.trim()) return undefined
    if (isToolCallMessage(message)) return undefined
    return [message.tool_call_id]
  }

  if (message.role !== 'user' || message.tool_call_id !== undefined) return undefined
  if (isToolCallMessage(message)) return undefined
  if (!Array.isArray(message.content) || message.content.length === 0) return undefined

  const ids: string[] = []
  for (const part of message.content) {
    if (!part || typeof part !== 'object' || Array.isArray(part)) return undefined
    const record = part as { type?: unknown; tool_use_id?: unknown }
    if (record.type !== 'tool_result') return undefined
    if (typeof record.tool_use_id !== 'string' || !record.tool_use_id.trim()) return undefined
    ids.push(record.tool_use_id)
  }
  return hasUniqueIds(ids) ? ids : undefined
}

function hasUniqueIds(ids: string[]): boolean {
  return new Set(ids).size === ids.length
}
