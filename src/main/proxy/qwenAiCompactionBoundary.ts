import type { ProviderModelCapability } from '../../shared/types'
import type { ChatCompletionRequest, ChatMessage, ChatMessageContent } from './types'

function positiveIntegerFromEnv(name: string, fallback: number): number {
  const raw = process.env[name]
  if (raw === undefined || raw.trim() === '') return fallback
  const value = Number(raw)
  return Number.isSafeInteger(value) && value > 0 ? value : fallback
}

function nonNegativeIntegerFromEnv(name: string, fallback: number): number {
  const raw = process.env[name]
  if (raw === undefined || raw.trim() === '') return fallback
  const value = Number(raw)
  return Number.isSafeInteger(value) && value >= 0 ? value : fallback
}

const UPLOADED_PAYLOAD_REFERENCE_CHARS = 64

function estimateTextTokens(value: string | undefined): number {
  if (!value) return 0
  let asciiChars = 0
  let nonAsciiCodePoints = 0
  for (const codePoint of value) {
    if ((codePoint.codePointAt(0) || 0) <= 0x7f) asciiChars += 1
    else nonAsciiCodePoints += 1
  }
  return Math.ceil(asciiChars / 3) + nonAsciiCodePoints
}

function estimateUploadReferenceTokens(value: string | undefined): number {
  if (!value) return 0
  const separator = value.indexOf(',')
  if (separator >= 0) {
    const header = value.slice(0, separator + 1)
    if (/^data:[^,]*;base64,$/i.test(header)) {
      // Qwen receives an uploaded file reference, not the inline payload.
      return estimateTextTokens(header) + Math.ceil(UPLOADED_PAYLOAD_REFERENCE_CHARS / 3)
    }
  }
  return estimateTextTokens(value)
}

function estimateCompactionContentPartTokens(part: ChatMessageContent): number {
  let tokens = estimateTextTokens(part.type)
    + estimateTextTokens(part.filename)
    + estimateTextTokens(part.mime_type)
    + estimateTextTokens(part.local_path)

  if (part.type === 'text') {
    return tokens + estimateTextTokens(part.text)
  }
  if (part.type === 'image_url') {
    return tokens
      + estimateUploadReferenceTokens(part.image_url?.url)
      + estimateTextTokens(part.image_url?.detail)
  }
  if (part.type === 'file') {
    return tokens + estimateUploadReferenceTokens(part.file_url?.url)
  }
  if (part.type === 'video_url') {
    return tokens + estimateUploadReferenceTokens(part.video_url?.url)
  }
  if (part.type === 'input_audio') {
    return tokens
      + (part.input_audio?.data ? Math.ceil(UPLOADED_PAYLOAD_REFERENCE_CHARS / 3) : 0)
      + estimateTextTokens(part.input_audio?.format)
  }
  return tokens
}

function estimateCompactionMessageTokens(message: ChatMessage): number {
  let tokens = estimateTextTokens(message.role)
    + estimateTextTokens(message.name)
    + estimateTextTokens(message.tool_call_id)
  if (message.tool_calls?.length) {
    try {
      tokens += estimateTextTokens(JSON.stringify(message.tool_calls))
    } catch {
      tokens += message.tool_calls.length * 86
    }
  }
  const content = message.content
  if (typeof content === 'string') return tokens + estimateTextTokens(content)
  if (Array.isArray(content)) {
    for (const part of content) {
      tokens += estimateCompactionContentPartTokens(part)
    }
  }
  return tokens
}

function estimateStructuredTokens(value: unknown): number {
  try {
    return estimateTextTokens(JSON.stringify(value))
  } catch {
    return 0
  }
}

/** Estimate the prompt tokens represented by the original OpenAI-compatible request. */
export function estimateQwenAiRequestInputTokens(request: ChatCompletionRequest): number {
  const messageTokens = request.messages.reduce(
    (total, message) => total + estimateCompactionMessageTokens(message),
    0,
  )
  const toolTokens = request.tools?.length
    ? estimateStructuredTokens(request.tools)
    : 0
  return Math.max(1, messageTokens + toolTokens)
}

function messageTextChars(message: ChatMessage): number {
  if (typeof message.content === 'string') return message.content.length
  if (Array.isArray(message.content)) {
    return message.content.reduce((total, part) => (
      total + (part.type === 'text' && part.text ? part.text.length : 0)
    ), 0)
  }
  return 0
}

function splitTextByTokenBudget(text: string, maxTokens: number): string[] {
  if (!text) return ['']
  const chunks: string[] = []
  let current = ''
  let asciiChars = 0
  let nonAsciiCodePoints = 0
  for (const codePoint of text) {
    const isAscii = (codePoint.codePointAt(0) || 0) <= 0x7f
    const nextAsciiChars = asciiChars + (isAscii ? 1 : 0)
    const nextNonAsciiCodePoints = nonAsciiCodePoints + (isAscii ? 0 : 1)
    const nextTokens = Math.ceil(nextAsciiChars / 3) + nextNonAsciiCodePoints
    if (current && nextTokens > maxTokens) {
      chunks.push(current)
      current = ''
      asciiChars = 0
      nonAsciiCodePoints = 0
    }
    current += codePoint
    if (isAscii) asciiChars += 1
    else nonAsciiCodePoints += 1
  }
  if (current || chunks.length === 0) chunks.push(current)
  return chunks
}

function promptReserveTokensFromEnv(budget: number): number {
  const configured = positiveIntegerFromEnv(
    'CHAT2API_QWEN_AI_COMPACTION_PROMPT_TOKEN_RESERVE',
    512,
  )
  return Math.min(
    Math.max(0, budget - 1),
    Math.max(1, Math.floor(budget / 4)),
    configured,
  )
}

function splitMessageForBudget(message: ChatMessage, sourceBudgetTokens: number): ChatMessage[] {
  if (typeof message.content === 'string') {
    const messageWithoutContent: ChatMessage = { ...message, content: '' }
    const availableTextTokens = sourceBudgetTokens - estimateCompactionMessageTokens(messageWithoutContent)
    if (availableTextTokens <= 0) return [message]
    const fragments = splitTextByTokenBudget(message.content, availableTextTokens)
    if (fragments.length <= 1) return [message]

    return fragments.map((content, index) => ({
      ...message,
      content,
      ...(index > 0 && message.tool_calls ? { tool_calls: undefined } : {}),
    }))
  }

  if (!Array.isArray(message.content)) return [message]
  const messageWithoutContent: ChatMessage = { ...message, content: [] }
  const availablePartTokens = sourceBudgetTokens - estimateCompactionMessageTokens(messageWithoutContent)
  if (availablePartTokens <= 0) return [message]

  const atoms: ChatMessageContent[] = message.content.flatMap(part => {
    if (part.type !== 'text' || !part.text) return [{ ...part }]
    const textBudget = availablePartTokens - estimateCompactionContentPartTokens({ ...part, text: '' })
    if (textBudget <= 0) return [{ ...part }]
    return splitTextByTokenBudget(part.text, textBudget)
      .map(text => ({ ...part, text }))
  })
  const fragments: ChatMessage[] = []
  let currentParts: ChatMessageContent[] = []

  const buildFragment = (parts: ChatMessageContent[], index: number): ChatMessage => ({
    ...message,
    content: parts.map(part => ({ ...part })),
    ...(index > 0 && message.tool_calls ? { tool_calls: undefined } : {}),
  })
  const flush = () => {
    if (currentParts.length === 0) return
    fragments.push(buildFragment(currentParts, fragments.length))
    currentParts = []
  }

  for (const atom of atoms) {
    const candidate = buildFragment([...currentParts, atom], fragments.length)
    if (currentParts.length > 0 && estimateCompactionMessageTokens(candidate) > sourceBudgetTokens) {
      flush()
    }
    currentParts.push({ ...atom })
    if (estimateCompactionMessageTokens(buildFragment(currentParts, fragments.length)) > sourceBudgetTokens) {
      flush()
    }
  }
  flush()
  return fragments.length > 0 ? fragments : [message]
}

export interface QwenAiCompactionChunk {
  messages: ChatCompletionRequest['messages']
  estimatedTokens: number
  sourceTextChars: number
}

export interface QwenAiCompactionPlan {
  chunks: QwenAiCompactionChunk[]
  chunkBudgetTokens: number
  promptReserveTokens: number
  chunkSource: 'metadata_conservative' | 'metadata_exact' | 'configured' | 'fallback'
  sourceMessageCount: number
  sourceTextChars: number
  coveredTextChars: number
  splitMessageCount: number
  oversizedMessageCount: number
  chunkCount: number
}

export interface QwenAiCompactionBoundary {
  /** First chronological chunk, retained for the existing single-request path. */
  messages: ChatCompletionRequest['messages']
  chunks: QwenAiCompactionChunk[]
  originalMessageCount: number
  keptMessageCount: number
  originalEstimatedTokens: number
  keptEstimatedTokens: number
  inputTokenBudget?: number
  chunkBudgetTokens: number
  promptReserveTokens: number
  chunkSource: QwenAiCompactionPlan['chunkSource']
  chunkCount: number
  splitMessageCount: number
  oversizedMessageCount: number
  sourceTextChars: number
  coveredTextChars: number
  boundarySource: 'metadata' | 'configured' | 'fallback'
  trimmed: boolean
}

function resolveChunkBudget(capability?: ProviderModelCapability): {
  budget: number
  source: QwenAiCompactionPlan['chunkSource']
  rawMetadataBudget: number
} {
  const configuredBudget = positiveIntegerFromEnv('CHAT2API_QWEN_AI_COMPACTION_INPUT_TOKEN_BUDGET', 0)
  if (configuredBudget > 0) {
    return { budget: configuredBudget, source: 'configured', rawMetadataBudget: 0 }
  }

  const rawMetadataBudget = capability?.maxContextLength
    ? capability.maxContextLength - (capability.maxSummaryGenerationLength || 0)
    : 0
  const configuredMetadataCap = nonNegativeIntegerFromEnv(
    'CHAT2API_QWEN_AI_COMPACTION_METADATA_MAX_INPUT_TOKENS',
    0,
  )
  if (rawMetadataBudget > 0) {
    const metadataCapEnabled = configuredMetadataCap > 0
    return {
      budget: metadataCapEnabled
        ? Math.min(rawMetadataBudget, configuredMetadataCap)
        : rawMetadataBudget,
      source: metadataCapEnabled && rawMetadataBudget > configuredMetadataCap
        ? 'metadata_conservative'
        : 'metadata_exact',
      rawMetadataBudget,
    }
  }

  return {
    budget: positiveIntegerFromEnv('CHAT2API_QWEN_AI_COMPACTION_FALLBACK_INPUT_TOKENS', 12000),
    source: 'fallback',
    rawMetadataBudget,
  }
}

/**
 * Plan bounded chronological requests without discarding transcript text.
 * Every source message is covered once in chronological order. Oversized
 * text is split on Unicode code-point boundaries; unsplittable messages are
 * reported so the caller can return an explicit protocol error.
 */
export function planQwenAiCompactionChunks(
  messages: ChatCompletionRequest['messages'],
  capability?: ProviderModelCapability,
): QwenAiCompactionPlan {
  const { budget, source } = resolveChunkBudget(capability)
  const promptReserveTokens = promptReserveTokensFromEnv(budget)
  const sourceBudgetTokens = Math.max(1, budget - promptReserveTokens)
  const chunks: QwenAiCompactionChunk[] = []
  let currentMessages: ChatCompletionRequest['messages'] = []
  let currentSourceTokens = 0
  let currentTextChars = 0
  let splitMessageCount = 0
  let oversizedMessageCount = 0

  const flush = () => {
    if (currentMessages.length === 0 && chunks.length > 0) return
    chunks.push({
      messages: currentMessages,
      estimatedTokens: currentSourceTokens + promptReserveTokens,
      sourceTextChars: currentTextChars,
    })
    currentMessages = []
    currentSourceTokens = 0
    currentTextChars = 0
  }

  for (const message of messages) {
    const messageTokens = estimateCompactionMessageTokens(message)
    const fragments = messageTokens > sourceBudgetTokens
      ? splitMessageForBudget(message, sourceBudgetTokens)
      : [message]
    if (fragments.length > 1) splitMessageCount += 1

    for (const fragment of fragments) {
      const fragmentTokens = estimateCompactionMessageTokens(fragment)
      if (
        currentMessages.length > 0
        && currentSourceTokens + fragmentTokens > sourceBudgetTokens
      ) {
        flush()
      }
      if (fragmentTokens > sourceBudgetTokens) oversizedMessageCount += 1
      currentMessages.push(fragment)
      currentSourceTokens += fragmentTokens
      currentTextChars += messageTextChars(fragment)
    }
  }
  flush()

  const sourceTextChars = messages.reduce((total, message) => total + messageTextChars(message), 0)
  const coveredTextChars = chunks.reduce((total, chunk) => (
    total + chunk.messages.reduce((chars, message) => chars + messageTextChars(message), 0)
  ), 0)
  return {
    chunks,
    chunkBudgetTokens: budget,
    promptReserveTokens,
    chunkSource: source,
    sourceMessageCount: messages.length,
    sourceTextChars,
    coveredTextChars,
    splitMessageCount,
    oversizedMessageCount,
    chunkCount: chunks.length,
  }
}

/** Compatibility projection for the existing single-request forward path. */
export function boundQwenAiCompactionMessages(
  messages: ChatCompletionRequest['messages'],
  capability?: ProviderModelCapability,
): QwenAiCompactionBoundary {
  const plan = planQwenAiCompactionChunks(messages, capability)
  const firstChunk = plan.chunks[0] || { messages: [], estimatedTokens: 0, sourceTextChars: 0 }
  const originalEstimatedTokens = messages.reduce(
    (total, message) => total + estimateCompactionMessageTokens(message), 0,
  )
  const keptEstimatedTokens = firstChunk.estimatedTokens
  return {
    messages: firstChunk.messages,
    chunks: plan.chunks,
    originalMessageCount: messages.length,
    keptMessageCount: firstChunk.messages.length,
    originalEstimatedTokens,
    keptEstimatedTokens,
    inputTokenBudget: plan.chunkBudgetTokens,
    chunkBudgetTokens: plan.chunkBudgetTokens,
    promptReserveTokens: plan.promptReserveTokens,
    chunkSource: plan.chunkSource,
    chunkCount: plan.chunkCount,
    splitMessageCount: plan.splitMessageCount,
    oversizedMessageCount: plan.oversizedMessageCount,
    sourceTextChars: plan.sourceTextChars,
    coveredTextChars: plan.coveredTextChars,
    boundarySource: plan.chunkSource === 'configured' ? 'configured' : plan.chunkSource === 'fallback' ? 'fallback' : 'metadata',
    trimmed: plan.chunkCount > 1 || firstChunk.messages.length < messages.length,
  }
}
