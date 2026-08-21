import type { ChatCompletionRequest, ChatMessage } from './types'

/**
 * Intent detected at the OpenAI-compatible boundary. This is an internal
 * routing hint and is never sent to an upstream provider.
 */
export type ChatRequestIntent = 'normal' | 'context_compaction'

export interface ChatRequestIntentInfo {
  intent: ChatRequestIntent
  reason: string
  /** Non-sensitive structural signals used to explain the classification. */
  signals: string[]
  messageCount: number
  toolCount: number
  toolResultCount: number
  textChars: number
  lastUserTextChars: number
  lastUserTextPrefix?: string
}

function contentToText(content: ChatMessage['content']): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''

  return content
    .map(part => {
      if (!part || typeof part !== 'object') return ''
      const value = part as Record<string, unknown>
      if (typeof value.text === 'string') return value.text
      if (typeof value.content === 'string') return value.content
      return ''
    })
    .filter(Boolean)
    .join('\n')
}

function messageText(message: ChatMessage): string {
  return contentToText(message.content)
}

function messageToolResultCount(message: ChatMessage): number {
  const nestedCount = Array.isArray(message.content)
    ? message.content.filter(part => (
        Boolean(part)
        && typeof part === 'object'
        && (part as { type?: unknown }).type === 'tool_result'
      )).length
    : 0
  if (nestedCount > 0) return nestedCount
  return message.role === 'tool' || Boolean(message.tool_call_id) ? 1 : 0
}

function redactPrefix(value: string): string {
  return value
    .replace(/Bearer\s+[^\s]+/gi, 'Bearer [REDACTED]')
    .replace(/(?:token|secret|password|authorization)\s*[:=]\s*[^\s,;]+/gi, '$1=[REDACTED]')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120)
}

function readDetectionMode(): 'auto' | 'off' {
  const raw = process.env.CHAT2API_COMPACTION_DETECTION
  return raw && /^(?:0|false|off|disabled|no)$/i.test(raw.trim()) ? 'off' : 'auto'
}

function readCustomPattern(): RegExp | undefined {
  const raw = process.env.CHAT2API_COMPACTION_PATTERN?.trim()
  if (!raw) return undefined

  try {
    return new RegExp(raw, 'is')
  } catch {
    console.warn('[RequestIntent] Ignoring invalid CHAT2API_COMPACTION_PATTERN')
    return undefined
  }
}

type UnknownRecord = Record<string, unknown>

function isRecord(value: unknown): value is UnknownRecord {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

function normalizedProtocolKey(value: string): string {
  return value.replace(/[^a-z0-9]/gi, '').toLowerCase()
}

function isCompactionProtocolKey(value: string): boolean {
  return /^(?:contextmanagement|anthropiccontextmanagement|compaction|compact|compactrequest|autocompact|contextedit|summaryrequest|truncatecontext)$/i
    .test(normalizedProtocolKey(value))
}

function protocolFieldEnabled(value: unknown): boolean {
  if (value === undefined || value === null || value === false) return false
  if (typeof value === 'string') {
    const normalized = value.trim()
    return normalized.length > 0 && !/^(?:false|0|off|disabled|no|none)$/i.test(normalized)
  }
  if (typeof value === 'number') return value !== 0
  if (Array.isArray(value)) return value.length > 0
  if (isRecord(value)) return Object.keys(value).length > 0
  return value === true
}

function hasNestedProtocolCompactionField(value: unknown, depth = 0): boolean {
  if (depth > 5) return false
  if (Array.isArray(value)) {
    return value.some(item => hasNestedProtocolCompactionField(item, depth + 1))
  }
  if (!isRecord(value)) return false

  for (const [key, child] of Object.entries(value)) {
    if (isCompactionProtocolKey(key) && protocolFieldEnabled(child)) return true

    // Prompt-bearing fields can contain ordinary uses of words such as
    // "summary". Only recurse through protocol envelopes, never message text.
    if (/^(?:messages?|input|prompt|tools?|system)$/i.test(key)) continue
    if (hasNestedProtocolCompactionField(child, depth + 1)) return true
  }
  return false
}

function systemCompactionMarker(request: ChatCompletionRequest): boolean {
  const requestRecord = request as ChatCompletionRequest & UnknownRecord
  const systemValues: unknown[] = [requestRecord.system]
  for (const message of request.messages || []) {
    if (message.role === 'system') systemValues.push(message.content)
  }

  const texts: string[] = []
  const collectText = (value: unknown): void => {
    if (typeof value === 'string') {
      texts.push(value)
      return
    }
    if (Array.isArray(value)) {
      for (const item of value) {
        if (typeof item === 'string') collectText(item)
        else if (isRecord(item)) collectText(item.text ?? item.content)
      }
    }
  }
  for (const value of systemValues) collectText(value)

  return texts.some(text => (
    /\b(?:compact|compress|condense|summar(?:ize|ise))\b[\s\S]{0,160}\b(?:conversation|message)\s+(?:context|history)\b/i.test(text)
    || /\bcontext\s+(?:compaction|compression|summary)\b/i.test(text)
    || /(?:压缩|总结|精简).{0,80}(?:对话|消息)(?:上下文|历史)/i.test(text)
  ))
}

function explicitCompactionMarker(
  request: ChatCompletionRequest,
  text: string,
): { matched: boolean; signals: string[] } {
  const requestRecord = request as ChatCompletionRequest & UnknownRecord
  const signals: string[] = []
  const metadata = isRecord(requestRecord.metadata) ? requestRecord.metadata : undefined
  const metadataValues = [
    metadata?.purpose,
    metadata?.operation,
    metadata?.task,
    metadata?.request_type,
    metadata?.requestType,
    metadata?.event,
    metadata?.kind,
  ]
  if (metadataValues.some(value => typeof value === 'string' && (
    /(?:^|[^a-z])(?:context[_ -]?(?:compaction|compression|summary)|auto[_ -]?compact|compact(?:ion)?|prompt[_ -]?too[_ -]?long)(?:[^a-z]|$)/i
      .test(value)
  ))) {
    signals.push('metadata_compaction_marker')
  }

  const protocolFields = [
    'context_management',
    'contextManagement',
    'compaction',
    'compact',
    'auto_compact',
    'autoCompact',
    'context_edit',
    'contextEdit',
    'anthropic_context_management',
  ]
  if (protocolFields.some(field => protocolFieldEnabled(requestRecord[field]))) {
    signals.push('protocol_compaction_field')
  }

  // LiteLLM can move unknown Anthropic fields under metadata or a nested
  // request envelope. Inspect protocol keys without scanning prompt text.
  const protocolEnvelopes = [
    requestRecord.anthropic,
    requestRecord.extra_body,
    requestRecord.extraBody,
    requestRecord.provider_fields,
    requestRecord.providerFields,
  ]
  if (protocolEnvelopes.some(value => hasNestedProtocolCompactionField(value))) {
    signals.push('nested_protocol_compaction_marker')
  }

  if (systemCompactionMarker(request)) signals.push('system_compaction_marker')

  const customPattern = readCustomPattern()
  if (customPattern?.test(text)) signals.push('custom_compaction_pattern')

  // Claude Code's ordinary system prompt describes context compaction as one
  // of the client's capabilities. Keep that marker for diagnostics, but do
  // not let documentation in a system prompt turn a normal tool-enabled turn
  // into a compaction request. Protocol/metadata fields, an operator-supplied
  // custom pattern, or the complete terminal instruction remain decisive.
  const decisiveSignals = signals.filter(signal => signal !== 'system_compaction_marker')
  return { matched: decisiveSignals.length > 0, signals }
}

function isShortContinuation(text: string): boolean {
  const normalized = text.trim().replace(/[.!?。！？]+$/g, '').toLowerCase()
  return /^(?:continue|continuing|go on|keep going|resume|next|proceed|again|继续|接着|继续吧|往下|下一步)$/.test(normalized)
}

function compactionInstructionSignals(text: string): string[] {
  if (!text) return []
  const textOnly = /\b(?:respond|reply|output|return|provide)\b[\s\S]{0,500}\b(?:plain\s+)?text\s+only\b/i.test(text)
    || /(?:仅|只|只需|仅需)\s*(?:输出|回复|返回).{0,40}(?:文本|文字)/i.test(text)
  const toolProhibited = /\b(?:do\s+not|don't|never|without)\b[\s\S]{0,500}\b(?:call|use|invoke|execute|run)\b[\s\S]{0,160}\btools?\b/i.test(text)
    || /\b(?:no|without)\s+tools?\b/i.test(text)
    || /(?:不要|无需|禁止|不能)\s*(?:调用|使用|执行).{0,30}(?:工具|函数)/i.test(text)
  const summaryRequested = /\b(?:summar(?:y|ize|ise)|recap|compress(?:ion)?|condense|context\s+window|conversation\s+context|conversation\s+history|message\s+history)\b/i.test(text)
    || /(?:总结|摘要|压缩|精简).{0,80}(?:对话|上下文|历史|消息)/i.test(text)

  return [
    ...(textOnly ? ['terminal_text_only'] : []),
    ...(toolProhibited ? ['terminal_tools_prohibited'] : []),
    ...(summaryRequested ? ['terminal_summary_requested'] : []),
  ]
}

function isCompleteCompactionInstruction(signals: string[]): boolean {
  return signals.includes('terminal_text_only')
    && signals.includes('terminal_tools_prohibited')
    && signals.includes('terminal_summary_requested')
}

function classifyTerminalText(
  messages: ChatMessage[],
  toolResultCount: number,
): { matched: boolean; signals: string[] } {
  const terminal = messages.slice(-4)
  const lastUserText = [...messages].reverse().find(message => message.role === 'user')
  const lastUser = lastUserText ? messageText(lastUserText) : ''
  const signals = compactionInstructionSignals(lastUser)
  const hasTerminalCompactionInstruction = isCompleteCompactionInstruction(signals)
  const hasToolHistorySummaryInstruction = toolResultCount > 0
    && signals.includes('terminal_text_only')
    && signals.includes('terminal_summary_requested')
  if (hasToolHistorySummaryInstruction) signals.push('terminal_tool_history')
  const continuationAfterInstruction = isShortContinuation(lastUser)
    && terminal.slice(0, -1).some(message => (
      isCompleteCompactionInstruction(compactionInstructionSignals(messageText(message)))
    ))

  if (continuationAfterInstruction) signals.push('continuation_after_compaction_instruction')
  return {
    matched: hasTerminalCompactionInstruction
      || hasToolHistorySummaryInstruction
      || continuationAfterInstruction,
    signals,
  }
}

/**
 * Detect the protocol-level context summary request emitted by Claude Code
 * through LiteLLM. The classifier uses structural instructions and tool-result
 * history rather than a fixed prompt or a fixed message/token count.
 * Deployments can disable it or add a pattern with environment configuration.
 */
export function classifyChatRequest(request: ChatCompletionRequest): ChatRequestIntentInfo {
  const messages = Array.isArray(request.messages) ? request.messages : []
  const messageTexts = messages.map(messageText)
  const allText = messageTexts.join('\n')
  const lastUser = [...messages]
    .reverse()
    .find(message => message.role === 'user')
  const lastUserText = lastUser ? messageText(lastUser) : ''
  const toolCount = Array.isArray(request.tools) ? request.tools.length : 0
  const toolResultCount = messages.reduce(
    (total, message) => total + messageToolResultCount(message),
    0,
  )
  const textChars = messageTexts.reduce((total, value) => total + value.length, 0)
  const signals: string[] = []

  if (readDetectionMode() === 'off') {
    return {
      intent: 'normal',
      reason: 'detection_disabled',
      signals,
      messageCount: messages.length,
      toolCount,
      toolResultCount,
      textChars,
      lastUserTextChars: lastUserText.length,
      lastUserTextPrefix: redactPrefix(lastUserText),
    }
  }

  const explicit = explicitCompactionMarker(request, allText)
  const terminal = classifyTerminalText(messages, toolResultCount)
  signals.push(...explicit.signals, ...terminal.signals)

  const isCompaction = explicit.matched || terminal.matched
  const reason = explicit.matched
    ? explicit.signals[0] === 'protocol_compaction_field'
      ? 'protocol_compaction_marker'
      : 'explicit_compaction_marker'
    : terminal.matched
      ? terminal.signals.includes('continuation_after_compaction_instruction')
        ? 'continuation_after_compaction_instruction'
        : terminal.signals.includes('terminal_tool_history')
          ? 'text_only_summary_with_tool_history'
          : 'text_only_tool_prohibition_summary'
      : 'no_compaction_signal'

  return {
    intent: isCompaction ? 'context_compaction' : 'normal',
    reason,
    signals,
    messageCount: messages.length,
    toolCount,
    toolResultCount,
    textChars,
    lastUserTextChars: lastUserText.length,
    lastUserTextPrefix: redactPrefix(lastUserText),
  }
}

export function isContextCompactionRequest(request: ChatCompletionRequest): boolean {
  return classifyChatRequest(request).intent === 'context_compaction'
}
