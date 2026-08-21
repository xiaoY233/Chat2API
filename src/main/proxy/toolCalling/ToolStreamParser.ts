import { randomUUID } from 'node:crypto'
import type { ToolCall } from '../types.ts'
import type { ToolCallDiagnostics, ToolCallingPlan } from './types.ts'
import { getToolProtocol } from './protocols/index.ts'
import { deduplicateEquivalentToolCalls } from './toolCallDeduplication.ts'
import {
  createManagedToolResultWrapperLeakError,
  ManagedToolResultGuard,
  stripManagedToolResultWrappers,
} from './managedToolResultGuard.ts'

export class ToolStreamParser {
  private readonly plan: ToolCallingPlan
  private readonly callIdPrefix: string
  private buffer = ''
  private isBufferingToolCall = false
  private emittedToolCall = false
  private nextToolCallIndex = 0
  private sawToolProtocolMarker = false
  private readonly toolResultGuard: ManagedToolResultGuard
  private diagnostics: ToolCallDiagnostics
  private suppressedInput = false
  private rejectedByWrapperLeak = false
  private readonly inputAlreadyGuarded: boolean

  constructor(
    plan: ToolCallingPlan,
    callIdPrefix?: string,
    options: { inputAlreadyGuarded?: boolean } = {},
  ) {
    this.plan = plan
    this.callIdPrefix = callIdPrefix ?? `call_${randomUUID().replace(/-/g, '')}`
    this.diagnostics = { ...plan.diagnostics }
    this.toolResultGuard = new ManagedToolResultGuard(plan.protocol)
    this.inputAlreadyGuarded = options.inputAlreadyGuarded === true
  }

  push(content: string, baseChunk: any, includeRole: boolean = false): any[] {
    // A response may replay a completed XML block in a later upstream delta.
    // Once a complete block was emitted, all calls for this response are known;
    // keep the first block and avoid executing a replay a second time.
    if (!content || !this.plan.shouldParseResponse || this.emittedToolCall) return []
    if (this.rejectedByWrapperLeak) {
      this.suppressedInput = true
      return []
    }

    const guarded = this.inputAlreadyGuarded
      ? { content, suppressed: false }
      : this.toolResultGuard.push(content)
    if (this.toolResultGuard.hasDetectedWrapperLeak()) {
      this.markWrapperLeakDetected()
      this.buffer = ''
      this.isBufferingToolCall = false
      this.suppressedInput = true
      return []
    }

    const chunks = this.pushGuardedContent(guarded.content, baseChunk, includeRole)
    this.suppressedInput = guarded.suppressed && chunks.length === 0
    return chunks
  }

  private pushGuardedContent(content: string, baseChunk: any, includeRole: boolean): any[] {
    if (!content) return []

    this.buffer += content
    const chunks: any[] = []
    // `includeRole` describes the first output delta, not every delta that
    // happens to be produced from one input fragment. Keep it pending until
    // the first content/tool chunk is emitted.
    let rolePending = includeRole && !this.emittedToolCall

    if (!this.isBufferingToolCall) {
      const markerStart = findMarkerStart(this.buffer, this.plan)
      if (markerStart.matched) {
        this.sawToolProtocolMarker = true
        if (markerStart.index > 0) {
          chunks.push(createContentChunk(baseChunk, this.buffer.slice(0, markerStart.index), rolePending))
          rolePending = false
        }
        this.buffer = this.buffer.slice(markerStart.index)
        this.isBufferingToolCall = true
      } else if (markerStart.partial) {
        this.sawToolProtocolMarker = true
        if (markerStart.index > 0) {
          chunks.push(createContentChunk(baseChunk, this.buffer.slice(0, markerStart.index), rolePending))
          rolePending = false
          this.buffer = this.buffer.slice(markerStart.index)
        }
        this.isBufferingToolCall = true
        return chunks
      } else {
        chunks.push(createContentChunk(baseChunk, this.buffer, rolePending))
        this.buffer = ''
        return chunks
      }
    }

    // Hermes parallel calls are adjacent, individually delimited blocks. Wait
    // for stream completion so the first block does not suppress later calls.
    if (this.plan.protocol === 'qwen_hermes') {
      return chunks
    }

    const parsed = parseFirstValidToolBlock(this.buffer, this.plan)
    if (parsed.toolCalls.length > 0) {
      for (const toolCall of uniqueResponseToolCalls(parsed.toolCalls)) {
        const indexedToolCall = {
          ...toolCall,
          index: this.nextToolCallIndex,
          id: this.scopedToolCallId(toolCall.id, this.nextToolCallIndex),
        }
        this.nextToolCallIndex += 1
        chunks.push(createToolCallChunk(baseChunk, indexedToolCall, rolePending))
        rolePending = false
      }
      if (chunks.length > 0) {
        this.emittedToolCall = true
      }
      this.isBufferingToolCall = false
      this.buffer = ''
      return chunks
    }

    if (parsed.invalidToolNames.length > 0) {
      this.isBufferingToolCall = false
      this.buffer = ''
    } else if (parsed.rawMatches.length > 0 && !mayBecomeValidToolCall(this.buffer, this.plan)) {
      this.isBufferingToolCall = false
      this.buffer = ''
    }

    return chunks
  }

  flush(baseChunk: any): any[] {
    if (this.rejectedByWrapperLeak) return []

    const guarded = this.inputAlreadyGuarded
      ? { content: '', suppressed: false }
      : this.toolResultGuard.flush()
    if (this.toolResultGuard.hasDetectedWrapperLeak()) {
      this.markWrapperLeakDetected()
      this.buffer = ''
      this.isBufferingToolCall = false
      this.suppressedInput = false
      return []
    }

    const chunks = this.pushGuardedContent(guarded.content, baseChunk, false)
    this.suppressedInput = false
    return [...chunks, ...this.flushBufferedToolCall(baseChunk)]
  }

  private flushBufferedToolCall(baseChunk: any): any[] {
    if (!this.buffer) return []

    const parsed = parseFirstValidToolBlock(this.buffer, this.plan, { allowPartial: true })
    if (parsed.toolCalls.length > 0) {
      const chunks = uniqueResponseToolCalls(parsed.toolCalls).flatMap((toolCall) => {
        const indexedToolCall = {
          ...toolCall,
          index: this.nextToolCallIndex,
          id: this.scopedToolCallId(toolCall.id, this.nextToolCallIndex),
        }
        this.nextToolCallIndex += 1
        this.emittedToolCall = true
        return [createToolCallChunk(baseChunk, indexedToolCall, false)]
      })
      this.buffer = ''
      this.isBufferingToolCall = false
      return chunks
    }

    if (this.isBufferingToolCall || parsed.rawMatches.length > 0 || parsed.invalidToolNames.length > 0) {
      this.buffer = ''
      this.isBufferingToolCall = false
      return []
    }

    const shouldReleaseText = !this.emittedToolCall
    const text = this.buffer
    this.buffer = ''
    this.isBufferingToolCall = false
    return shouldReleaseText ? [createContentChunk(baseChunk, text, false)] : []
  }

  recoverFromContent(content: string, baseChunk: any, includeRole: boolean = false): any[] {
    if (
      !content
      || this.emittedToolCall
      || this.rejectedByWrapperLeak
      || !this.plan.shouldParseResponse
    ) return []

    const guarded = this.inputAlreadyGuarded
      ? { content, suppressed: false, wrapperLeakDetected: false }
      : stripManagedToolResultWrappers(content, this.plan.protocol)
    if (guarded.wrapperLeakDetected) {
      this.markWrapperLeakDetected()
      return []
    }

    const parsed = parseFirstValidToolBlock(guarded.content, this.plan, { allowPartial: true })
    if (parsed.toolCalls.length === 0) return []

    const chunks = uniqueResponseToolCalls(parsed.toolCalls).flatMap((toolCall, index) => {
      const indexedToolCall = {
        ...toolCall,
        index: this.nextToolCallIndex,
        id: this.scopedToolCallId(toolCall.id, this.nextToolCallIndex),
      }
      this.nextToolCallIndex += 1
      return [createToolCallChunk(baseChunk, indexedToolCall, includeRole && !this.emittedToolCall && index === 0)]
    })

    if (chunks.length > 0) {
      this.emittedToolCall = true
    }
    this.isBufferingToolCall = false
    this.buffer = ''
    return chunks
  }

  hasEmittedToolCall(): boolean {
    return this.emittedToolCall
  }

  isBuffering(): boolean {
    return this.isBufferingToolCall
      || (!this.inputAlreadyGuarded && this.toolResultGuard.hasPendingCandidate())
      || this.suppressedInput
      || this.rejectedByWrapperLeak
  }

  hasPendingToolProtocol(): boolean {
    return this.rejectedByWrapperLeak
      || this.sawToolProtocolMarker
      || this.isBufferingToolCall
      || hasProtocolMarker(this.buffer, this.plan)
  }

  inspectForWrapperLeak(content: string): boolean {
    if (!content || this.rejectedByWrapperLeak) return this.rejectedByWrapperLeak
    const guarded = stripManagedToolResultWrappers(content, this.plan.protocol)
    if (guarded.wrapperLeakDetected) this.markWrapperLeakDetected()
    return this.rejectedByWrapperLeak
  }

  hasDetectedWrapperLeak(): boolean {
    return this.rejectedByWrapperLeak
  }

  getProtocolError(): Error | undefined {
    return this.rejectedByWrapperLeak
      ? createManagedToolResultWrapperLeakError()
      : undefined
  }

  getDiagnostics(): ToolCallDiagnostics {
    return { ...this.diagnostics }
  }

  private scopedToolCallId(parsedId: string | undefined, index: number): string {
    void parsedId
    return `${this.callIdPrefix}_${index}`
  }

  private markWrapperLeakDetected(): void {
    if (this.rejectedByWrapperLeak) return
    this.rejectedByWrapperLeak = true
    this.diagnostics = {
      ...this.diagnostics,
      wrapperLeakDetected: true,
    }
    console.warn('[ToolCalling] Blocked leaked managed tool-result wrapper', JSON.stringify({
      wrapperLeakDetected: true,
      requestId: this.diagnostics.requestId,
      providerId: this.diagnostics.providerId,
      model: this.diagnostics.actualModel || this.diagnostics.model,
      protocol: this.plan.protocol,
    }))
  }
}

function uniqueResponseToolCalls<T extends ToolCall>(toolCalls: readonly T[]): T[] {
  const result = deduplicateEquivalentToolCalls(toolCalls)
  if (result.duplicateCount > 0) {
    console.warn(`[ToolCalling] Suppressed ${result.duplicateCount} duplicate tool call(s) in one response`)
  }
  return result.toolCalls
}

function parseBufferedToolCall(
  buffer: string,
  plan: ToolCallingPlan,
  options: { allowPartial?: boolean } = {},
) {
  const selected = getToolProtocol(plan.protocol)
  return selected.parse(buffer, {
    tools: plan.tools,
    protocol: plan.protocol,
    allowPartial: options.allowPartial,
  })
}

/**
 * A provider can concatenate a retransmitted, complete tool block into one
 * streamed delta. Parse the first block that contains a valid call and leave
 * all calls inside that block intact, so legitimate parallel invocations are
 * not mistaken for replays.
 */
function parseFirstValidToolBlock(
  content: string,
  plan: ToolCallingPlan,
  options: { allowPartial?: boolean } = {},
) {
  const parsed = parseBufferedToolCall(content, plan, options)
  if (plan.protocol === 'qwen_hermes') {
    return parsed
  }
  if (parsed.toolCalls.length === 0 || parsed.rawMatches.length <= 1) {
    return parsed
  }

  for (const rawMatch of parsed.rawMatches) {
    const candidate = parseBufferedToolCall(rawMatch, plan, options)
    if (candidate.toolCalls.length > 0) {
      return candidate
    }
  }

  return parsed
}

function findMarkerStart(buffer: string, plan: ToolCallingPlan): { matched: boolean; partial: boolean; index: number } {
  const protocol = getToolProtocol(plan.protocol)
  const ranges = fencedRanges(buffer)
  let searchStart = 0
  let partialIndex = -1

  while (searchStart < buffer.length) {
    const detection = protocol.detectStart(buffer.slice(searchStart))
    const markerStart = detection.markerStart
    if (markerStart === undefined) break

    const index = searchStart + markerStart
    if (isInsideRange(index, ranges)) {
      const range = ranges.find((item) => index >= item.start && index < item.end)
      searchStart = range ? range.end : index + 1
      continue
    }

    if (detection.matched) {
      return { matched: true, partial: false, index }
    }

    if (detection.partial) {
      partialIndex = index
    }
    break
  }

  return partialIndex === -1
    ? { matched: false, partial: false, index: -1 }
    : { matched: false, partial: true, index: partialIndex }
}

function hasProtocolMarker(buffer: string, plan: ToolCallingPlan): boolean {
  const detection = findMarkerStart(buffer, plan)
  return detection.matched || detection.partial
}

function mayBecomeValidToolCall(buffer: string, plan: ToolCallingPlan): boolean {
  void buffer
  return plan.protocol === 'managed_xml' || plan.protocol === 'qwen_hermes'
}

function fencedRanges(content: string): Array<{ start: number; end: number }> {
  const ranges: Array<{ start: number; end: number }> = []
  let searchIndex = 0
  while (searchIndex < content.length) {
    const start = content.indexOf('```', searchIndex)
    if (start === -1) break
    const closing = content.indexOf('```', start + 3)
    if (closing === -1) {
      ranges.push({ start, end: content.length })
      break
    }
    const end = closing + 3
    ranges.push({ start, end })
    searchIndex = end
  }

  return ranges
}

function isInsideRange(index: number, ranges: Array<{ start: number; end: number }>): boolean {
  return ranges.some((range) => index >= range.start && index < range.end)
}

function createContentChunk(baseChunk: any, content: string, includeRole: boolean): any {
  return {
    ...baseChunk,
    choices: [{
      index: 0,
      delta: {
        ...(includeRole ? { role: 'assistant' } : {}),
        content,
      },
      finish_reason: null,
    }],
  }
}

function createToolCallChunk(baseChunk: any, toolCall: any, includeRole: boolean): any {
  const { rawText, ...openAiToolCall } = toolCall
  void rawText

  return {
    ...baseChunk,
    choices: [{
      index: 0,
      delta: {
        ...(includeRole ? { role: 'assistant' } : {}),
        tool_calls: [openAiToolCall],
      },
      finish_reason: null,
    }],
  }
}
