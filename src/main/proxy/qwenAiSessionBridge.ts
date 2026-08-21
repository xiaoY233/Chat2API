import { createHash } from 'node:crypto'
import type { ChatCompletionRequest, ChatMessage } from './types'

/**
 * Provider state retained for one Responses API conversation edge. The values
 * are deliberately opaque to callers: they are valid only for the account
 * that created the Qwen chat.
 */
export interface QwenAiSessionBinding {
  providerId: string
  accountId: string
  requestedModel: string
  actualModel: string
  chatId: string
  parentId: string
  requestFingerprint: string
  toolProtocol?: string
}

/** Per-request bridge information passed from the Responses route to Qwen. */
export interface QwenAiSessionBridge {
  requestFingerprint: string
  continuation?: {
    binding: QwenAiSessionBinding
    inputMessages: ChatMessage[]
  }
}

/**
 * A live state source is kept only until the outgoing response completes.
 * Stream handlers learn the real parent response ID asynchronously, so it
 * must be read when the Responses conversation entry is committed.
 */
export interface QwenAiSessionState {
  providerId: string
  accountId: string
  requestedModel: string
  actualModel: string
  requestFingerprint: string
  toolProtocol?: string
  getChatId: () => string
  getParentId: () => string
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize)
  if (!value || typeof value !== 'object') {
    return typeof value === 'number' && !Number.isFinite(value)
      ? String(value)
      : value
  }

  const record = value as Record<string, unknown>
  return Object.keys(record)
    .sort()
    .reduce<Record<string, unknown>>((result, key) => {
      const child = record[key]
      if (child !== undefined) result[key] = canonicalize(child)
      return result
    }, {})
}

function leadingSystemMessages(messages: ChatMessage[]): ChatMessage[] {
  const result: ChatMessage[] = []
  for (const message of messages) {
    if (message.role !== 'system') break
    result.push(message)
  }
  return result
}

/**
 * The first Qwen turn establishes both the managed tool catalog and the
 * system-level behavior. A continuation is valid only when that contract is
 * unchanged; normal user/tool-result data intentionally stays out of this
 * fingerprint.
 */
export function createQwenAiSessionRequestFingerprint(
  request: Pick<
    ChatCompletionRequest,
    | 'model'
    | 'messages'
    | 'tools'
    | 'tool_choice'
    | 'parallel_tool_calls'
    | 'response_format'
    | 'reasoning_effort'
    | 'enable_thinking'
    | 'thinking_budget'
    | 'image_generation'
  >,
): string {
  const contract = canonicalize({
    model: request.model,
    tools: request.tools ?? [],
    tool_choice: request.tool_choice ?? null,
    parallel_tool_calls: request.parallel_tool_calls ?? null,
    response_format: request.response_format ?? null,
    reasoning_effort: request.reasoning_effort ?? null,
    enable_thinking: request.enable_thinking ?? null,
    thinking_budget: request.thinking_budget ?? null,
    image_generation: request.image_generation ?? null,
    system_messages: leadingSystemMessages(request.messages),
  })
  return createHash('sha256').update(JSON.stringify(contract)).digest('hex')
}

export function resolveQwenAiSessionBinding(
  state: QwenAiSessionState | undefined,
): QwenAiSessionBinding | undefined {
  if (!state) return undefined

  const chatId = state.getChatId().trim()
  const parentId = state.getParentId().trim()
  if (!chatId || !parentId) return undefined

  return {
    providerId: state.providerId,
    accountId: state.accountId,
    requestedModel: state.requestedModel,
    actualModel: state.actualModel,
    chatId,
    parentId,
    requestFingerprint: state.requestFingerprint,
    ...(state.toolProtocol ? { toolProtocol: state.toolProtocol } : {}),
  }
}
