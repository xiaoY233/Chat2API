import type { ChatMessage, ChatMessageContent } from '../types'
import type { QwenAiSessionBinding } from '../qwenAiSessionBridge'

export interface ResponsesConversationStoreOptions {
  ttlMs?: number
  maxEntries?: number
  maxTotalBytes?: number
  maxEntryBytes?: number
  now?: () => number
}

interface StoredConversation {
  messages: ChatMessage[]
  qwenAiSessionBinding?: QwenAiSessionBinding
  bytes: number
  expiresAt: number
}

export interface StoredResponsesConversation {
  messages: ChatMessage[]
  qwenAiSessionBinding?: QwenAiSessionBinding
}

const DEFAULT_TTL_MS = 30 * 60 * 1000
const DEFAULT_MAX_ENTRIES = 128
const DEFAULT_MAX_TOTAL_BYTES = 32 * 1024 * 1024
const DEFAULT_MAX_ENTRY_BYTES = 8 * 1024 * 1024

function positiveIntegerFromEnv(name: string, fallback: number): number {
  const raw = process.env[name]
  if (raw === undefined) return fallback
  const parsed = Number(raw)
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback
}

function cloneContent(content: ChatMessage['content']): ChatMessage['content'] {
  if (!Array.isArray(content)) return content
  return content.map((part): ChatMessageContent => ({
    ...part,
    image_url: part.image_url ? { ...part.image_url } : undefined,
    file_url: part.file_url ? { ...part.file_url } : undefined,
    input_audio: part.input_audio ? { ...part.input_audio } : undefined,
    video_url: part.video_url ? { ...part.video_url } : undefined,
  }))
}

function cloneMessages(messages: ChatMessage[]): ChatMessage[] {
  return messages.map((message) => ({
    ...message,
    content: cloneContent(message.content),
    tool_calls: message.tool_calls?.map((toolCall) => ({
      ...toolCall,
      function: { ...toolCall.function },
    })),
  }))
}

function cloneQwenAiSessionBinding(
  binding: QwenAiSessionBinding | undefined,
): QwenAiSessionBinding | undefined {
  return binding ? { ...binding } : undefined
}

function estimateConversationBytes(
  messages: ChatMessage[],
  qwenAiSessionBinding: QwenAiSessionBinding | undefined,
): number {
  return Buffer.byteLength(JSON.stringify({ messages, qwenAiSessionBinding }), 'utf8')
}

export class ResponsesConversationStore {
  private entries = new Map<string, StoredConversation>()
  private totalBytes = 0
  private readonly ttlMs: number
  private readonly maxEntries: number
  private readonly maxTotalBytes: number
  private readonly maxEntryBytes: number
  private readonly now: () => number

  constructor(options: ResponsesConversationStoreOptions = {}) {
    this.ttlMs = options.ttlMs ?? DEFAULT_TTL_MS
    this.maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES
    this.maxTotalBytes = options.maxTotalBytes ?? DEFAULT_MAX_TOTAL_BYTES
    this.maxEntryBytes = options.maxEntryBytes ?? DEFAULT_MAX_ENTRY_BYTES
    this.now = options.now ?? Date.now
  }

  get(responseId: string): ChatMessage[] | undefined {
    return this.getConversation(responseId)?.messages
  }

  getConversation(responseId: string): StoredResponsesConversation | undefined {
    this.pruneExpired()
    const entry = this.entries.get(responseId)
    if (!entry) return undefined

    // Refresh insertion order for LRU eviction without mutating the value.
    this.entries = new Map<string, StoredConversation>([
      ...Array.from(this.entries.entries()).filter(([id]) => id !== responseId),
      [responseId, entry],
    ])
    return {
      messages: cloneMessages(entry.messages),
      qwenAiSessionBinding: cloneQwenAiSessionBinding(entry.qwenAiSessionBinding),
    }
  }

  set(
    responseId: string,
    messages: ChatMessage[],
    qwenAiSessionBinding?: QwenAiSessionBinding,
  ): boolean {
    this.pruneExpired()
    const cloned = cloneMessages(messages)
    const clonedBinding = cloneQwenAiSessionBinding(qwenAiSessionBinding)
    const bytes = estimateConversationBytes(cloned, clonedBinding)
    if (bytes > this.maxEntryBytes || bytes > this.maxTotalBytes) return false

    const existing = this.entries.get(responseId)
    const entriesWithoutExisting = existing
      ? Array.from(this.entries.entries()).filter(([id]) => id !== responseId)
      : Array.from(this.entries.entries())
    this.entries = new Map(entriesWithoutExisting)
    this.totalBytes -= existing?.bytes ?? 0

    while (
      this.entries.size >= this.maxEntries
      || (this.totalBytes + bytes > this.maxTotalBytes && this.entries.size > 0)
    ) {
      const oldest = this.entries.entries().next().value as [string, StoredConversation] | undefined
      if (!oldest) break
      this.entries = new Map(Array.from(this.entries.entries()).slice(1))
      this.totalBytes -= oldest[1].bytes
    }

    const entry: StoredConversation = {
      messages: cloned,
      ...(clonedBinding ? { qwenAiSessionBinding: clonedBinding } : {}),
      bytes,
      expiresAt: this.now() + this.ttlMs,
    }
    this.entries = new Map<string, StoredConversation>([
      ...Array.from(this.entries.entries()),
      [responseId, entry],
    ])
    this.totalBytes += bytes
    return true
  }

  delete(responseId: string): void {
    const entry = this.entries.get(responseId)
    if (!entry) return
    this.entries = new Map(Array.from(this.entries.entries()).filter(([id]) => id !== responseId))
    this.totalBytes -= entry.bytes
  }

  clearQwenAiSessionBinding(responseId: string): void {
    const entry = this.entries.get(responseId)
    if (!entry?.qwenAiSessionBinding) return

    const nextEntry: StoredConversation = {
      messages: entry.messages,
      bytes: estimateConversationBytes(entry.messages, undefined),
      expiresAt: entry.expiresAt,
    }
    this.entries = new Map([
      ...Array.from(this.entries.entries()).filter(([id]) => id !== responseId),
      [responseId, nextEntry],
    ])
    this.totalBytes += nextEntry.bytes - entry.bytes
  }

  clear(): void {
    this.entries = new Map()
    this.totalBytes = 0
  }

  stats(): { entries: number; totalBytes: number } {
    this.pruneExpired()
    return { entries: this.entries.size, totalBytes: this.totalBytes }
  }

  private pruneExpired(): void {
    const now = this.now()
    const activeEntries = Array.from(this.entries.entries()).filter(([, entry]) => entry.expiresAt > now)
    if (activeEntries.length === this.entries.size) return
    this.entries = new Map(activeEntries)
    this.totalBytes = activeEntries.reduce((total, [, entry]) => total + entry.bytes, 0)
  }
}

export const responsesConversationStore = new ResponsesConversationStore({
  ttlMs: positiveIntegerFromEnv('CHAT2API_RESPONSES_STORE_TTL_MS', DEFAULT_TTL_MS),
  maxEntries: positiveIntegerFromEnv('CHAT2API_RESPONSES_STORE_MAX_ENTRIES', DEFAULT_MAX_ENTRIES),
  maxTotalBytes: positiveIntegerFromEnv(
    'CHAT2API_RESPONSES_STORE_MAX_TOTAL_BYTES',
    DEFAULT_MAX_TOTAL_BYTES,
  ),
  maxEntryBytes: positiveIntegerFromEnv(
    'CHAT2API_RESPONSES_STORE_MAX_ENTRY_BYTES',
    DEFAULT_MAX_ENTRY_BYTES,
  ),
})
