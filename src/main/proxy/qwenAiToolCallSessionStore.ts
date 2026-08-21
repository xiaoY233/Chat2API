import { randomUUID } from 'node:crypto'
import type { ChatMessage } from './types'
import type { QwenAiSessionBinding } from './qwenAiSessionBridge'
import {
  hasTrailingMatchedToolResultBatch,
  isToolResultMessage,
} from './toolCalling/workflowHeuristics'

export interface QwenAiToolCallSessionStoreOptions {
  ttlMs?: number
  leaseMs?: number
  maxEntries?: number
  now?: () => number
}

export interface QwenAiToolResultBatch {
  toolCallIds: string[]
  messages: ChatMessage[]
}

export interface QwenAiToolCallSessionClaim {
  groupId: string
  generation: number
  token: string
}

export type QwenAiToolCallSessionClaimResult =
  | {
      status: 'claimed'
      binding: QwenAiSessionBinding
      claim: QwenAiToolCallSessionClaim
    }
  | {
      status: 'busy'
      retryAfterMs: number
    }
  | {
      status: 'missing'
    }

interface StoredQwenAiToolCallGroup {
  toolCallIds: string[]
  binding: QwenAiSessionBinding
  generation: number
  expiresAt: number
  lease?: {
    token: string
    expiresAt: number
  }
}

const DEFAULT_TTL_MS = 30 * 60 * 1000
const DEFAULT_LEASE_MS = 10 * 60 * 1000
const DEFAULT_MAX_ENTRIES = 1024

function positiveIntegerFromEnv(name: string, fallback: number): number {
  const raw = process.env[name]
  if (raw === undefined) return fallback
  const parsed = Number(raw)
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback
}

function cloneBinding(binding: QwenAiSessionBinding): QwenAiSessionBinding {
  return { ...binding }
}

function normalizeToolCallIds(ids: readonly string[]): string[] {
  const normalized: string[] = []
  const seen = new Set<string>()
  for (const id of ids) {
    const value = typeof id === 'string' ? id.trim() : ''
    if (!value || seen.has(value)) continue
    seen.add(value)
    normalized.push(value)
  }
  return normalized
}

function toolResultIds(message: ChatMessage): string[] | undefined {
  if (message.role === 'tool') {
    const id = typeof message.tool_call_id === 'string' ? message.tool_call_id.trim() : ''
    return id ? [id] : undefined
  }

  if (message.role !== 'user' || !Array.isArray(message.content)) return undefined
  const ids: string[] = []
  for (const part of message.content) {
    if (!part || typeof part !== 'object') return undefined
    const record = part as unknown as { type?: unknown; tool_use_id?: unknown }
    if (record.type !== 'tool_result' || typeof record.tool_use_id !== 'string') return undefined
    const id = record.tool_use_id.trim()
    if (!id) return undefined
    ids.push(id)
  }
  return ids.length > 0 ? ids : undefined
}

function isSyntheticToolAttachmentMessage(message: ChatMessage): boolean {
  if (message.role !== 'user' || !Array.isArray(message.content) || message.content.length < 2) {
    return false
  }
  const [label, ...attachments] = message.content
  if (label?.type !== 'text' || typeof label.text !== 'string') return false
  if (!/^Tool output attachment(?: follows\.|s follow \(\d+\)\.)$/.test(label.text)) return false
  return attachments.every(part => (
    part?.type === 'image_url'
      || part?.type === 'file'
      || part?.type === 'input_audio'
      || part?.type === 'video_url'
  ))
}

/**
 * Return the exact trailing result batch that may continue a provider chat.
 * The strict workflow validator ensures the IDs match the immediately
 * preceding assistant tool-call batch before this result is ever used.
 */
export function getTrailingQwenAiToolResultBatch(
  messages: ChatMessage[],
): QwenAiToolResultBatch | undefined {
  let resultEnd = messages.length
  while (resultEnd > 0 && isSyntheticToolAttachmentMessage(messages[resultEnd - 1])) {
    resultEnd -= 1
  }
  const messagesThroughToolResults = messages.slice(0, resultEnd)
  if (!hasTrailingMatchedToolResultBatch(messagesThroughToolResults)) return undefined

  let start = messagesThroughToolResults.length - 1
  while (start > 0 && isToolResultMessage(messagesThroughToolResults[start - 1])) start -= 1
  const resultMessages = messagesThroughToolResults.slice(start)
  const ids = resultMessages.flatMap(message => toolResultIds(message) || [])
  const uniqueIds = normalizeToolCallIds(ids)
  if (uniqueIds.length === 0 || uniqueIds.length !== ids.length) return undefined

  return {
    toolCallIds: uniqueIds,
    messages: [...resultMessages, ...messages.slice(resultEnd)],
  }
}

/**
 * Bounded, short-lived correlation from client-visible tool-call IDs to the
 * Qwen chat branch that emitted them. It deliberately has no Claude session
 * key: clients that replay a complete transcript can still continue safely.
 */
export class QwenAiToolCallSessionStore {
  private groups = new Map<string, StoredQwenAiToolCallGroup>()
  private idToGroup = new Map<string, string>()
  private nextGeneration = 1
  private readonly ttlMs: number
  private readonly leaseMs: number
  private readonly maxEntries: number
  private readonly now: () => number

  constructor(options: QwenAiToolCallSessionStoreOptions = {}) {
    this.ttlMs = options.ttlMs ?? DEFAULT_TTL_MS
    this.leaseMs = options.leaseMs ?? DEFAULT_LEASE_MS
    this.maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES
    this.now = options.now ?? Date.now
  }

  resolve(toolCallIds: readonly string[]): QwenAiSessionBinding | undefined {
    this.pruneExpired()
    const ids = normalizeToolCallIds(toolCallIds)
    const group = this.findExactGroup(ids)
    if (!group) return undefined

    this.touchGroup(group.groupId, group.value)
    return cloneBinding(group.value.binding)
  }

  claim(toolCallIds: readonly string[]): QwenAiToolCallSessionClaimResult {
    this.pruneExpired()
    const ids = normalizeToolCallIds(toolCallIds)
    const group = this.findExactGroup(ids)
    if (!group) return { status: 'missing' }

    const now = this.now()
    if (group.value.lease && group.value.lease.expiresAt > now) {
      return {
        status: 'busy',
        retryAfterMs: Math.max(1, group.value.lease.expiresAt - now),
      }
    }

    const token = randomUUID()
    const leaseExpiresAt = now + this.leaseMs
    const claimedGroup: StoredQwenAiToolCallGroup = {
      ...group.value,
      expiresAt: Math.max(group.value.expiresAt, leaseExpiresAt),
      lease: { token, expiresAt: leaseExpiresAt },
    }
    this.touchGroup(group.groupId, claimedGroup)

    return {
      status: 'claimed',
      binding: cloneBinding(group.value.binding),
      claim: {
        groupId: group.groupId,
        generation: group.value.generation,
        token,
      },
    }
  }

  release(claim: QwenAiToolCallSessionClaim): boolean {
    const group = this.activeClaimGroup(claim)
    if (!group) return false

    const releasedGroup: StoredQwenAiToolCallGroup = {
      ...group,
      lease: undefined,
    }
    const nextGroups = new Map(this.groups)
    nextGroups.set(claim.groupId, releasedGroup)
    this.groups = nextGroups
    return true
  }

  consume(claim: QwenAiToolCallSessionClaim): boolean {
    if (!this.activeClaimGroup(claim)) return false
    this.removeGroups(new Set([claim.groupId]))
    return true
  }

  set(toolCallIds: readonly string[], binding: QwenAiSessionBinding): boolean {
    this.pruneExpired()
    const ids = normalizeToolCallIds(toolCallIds)
    if (ids.length === 0 || ids.length > this.maxEntries) return false

    const conflictingGroups = new Set(
      ids.map(id => this.idToGroup.get(id)).filter((id): id is string => Boolean(id)),
    )
    const remaining = Array.from(this.groups.entries())
      .filter(([groupId]) => !conflictingGroups.has(groupId))
    let remainingEntryCount = remaining.reduce(
      (total, [, group]) => total + group.toolCallIds.length,
      0,
    )
    while (remainingEntryCount + ids.length > this.maxEntries && remaining.length > 0) {
      const removed = remaining.shift()
      remainingEntryCount -= removed?.[1].toolCallIds.length || 0
    }
    if (remainingEntryCount + ids.length > this.maxEntries) {
      return false
    }

    const generation = this.nextGeneration
    this.nextGeneration += 1
    const groupId = `${generation}:${randomUUID()}`
    const group: StoredQwenAiToolCallGroup = {
      toolCallIds: [...ids],
      binding: cloneBinding(binding),
      generation,
      expiresAt: this.now() + this.ttlMs,
    }
    this.replaceGroups(new Map([
      ...remaining,
      [groupId, group],
    ]))
    return true
  }

  delete(toolCallIds: readonly string[]): void {
    this.pruneExpired()
    const groupIds = new Set(
      normalizeToolCallIds(toolCallIds)
        .map(id => this.idToGroup.get(id))
        .filter((id): id is string => Boolean(id)),
    )
    if (groupIds.size === 0) return
    this.removeGroups(groupIds)
  }

  clear(): void {
    this.groups = new Map()
    this.idToGroup = new Map()
  }

  stats(): { entries: number } {
    this.pruneExpired()
    return {
      entries: Array.from(this.groups.values())
        .reduce((total, group) => total + group.toolCallIds.length, 0),
    }
  }

  private findExactGroup(
    ids: readonly string[],
  ): { groupId: string; value: StoredQwenAiToolCallGroup } | undefined {
    if (ids.length === 0) return undefined
    const groupId = this.idToGroup.get(ids[0])
    if (!groupId) return undefined
    if (ids.some(id => this.idToGroup.get(id) !== groupId)) return undefined

    const group = this.groups.get(groupId)
    if (!group || group.toolCallIds.length !== ids.length) return undefined
    const requestedIds = new Set(ids)
    if (group.toolCallIds.some(id => !requestedIds.has(id))) return undefined
    return { groupId, value: group }
  }

  private activeClaimGroup(
    claim: QwenAiToolCallSessionClaim,
  ): StoredQwenAiToolCallGroup | undefined {
    const group = this.groups.get(claim.groupId)
    if (
      !group
      || group.generation !== claim.generation
      || group.lease?.token !== claim.token
      || group.lease.expiresAt <= this.now()
    ) {
      return undefined
    }
    return group
  }

  private touchGroup(groupId: string, group: StoredQwenAiToolCallGroup): void {
    const touched = new Map(this.groups)
    touched.delete(groupId)
    touched.set(groupId, group)
    this.groups = touched
  }

  private removeGroups(groupIds: ReadonlySet<string>): void {
    this.replaceGroups(new Map(
      Array.from(this.groups.entries()).filter(([groupId]) => !groupIds.has(groupId)),
    ))
  }

  private replaceGroups(groups: Map<string, StoredQwenAiToolCallGroup>): void {
    const idToGroup = new Map<string, string>()
    for (const [groupId, group] of groups) {
      for (const id of group.toolCallIds) {
        idToGroup.set(id, groupId)
      }
    }
    this.groups = groups
    this.idToGroup = idToGroup
  }

  private pruneExpired(): void {
    const now = this.now()
    const expiredGroups = new Set(
      Array.from(this.groups.entries())
        .filter(([, group]) => (
          group.expiresAt <= now
          && (!group.lease || group.lease.expiresAt <= now)
        ))
        .map(([groupId]) => groupId),
    )
    if (expiredGroups.size > 0) {
      this.removeGroups(expiredGroups)
    }
  }
}

export const qwenAiToolCallSessionStore = new QwenAiToolCallSessionStore({
  ttlMs: positiveIntegerFromEnv('CHAT2API_QWEN_AI_TOOL_CALL_SESSION_TTL_MS', DEFAULT_TTL_MS),
  leaseMs: positiveIntegerFromEnv('CHAT2API_QWEN_AI_TOOL_CALL_SESSION_LEASE_MS', DEFAULT_LEASE_MS),
  maxEntries: positiveIntegerFromEnv('CHAT2API_QWEN_AI_TOOL_CALL_SESSION_MAX_ENTRIES', DEFAULT_MAX_ENTRIES),
})
