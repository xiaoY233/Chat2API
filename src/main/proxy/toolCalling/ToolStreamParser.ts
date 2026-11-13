import type { ToolCallingPlan, ToolParseResult, ToolProtocolId } from './types.ts'
import { getToolProtocol } from './protocols/index.ts'
import { getProtocolCandidates, parseToolResponse } from './parseResponse.ts'
import { findFencedRanges, mapToFenceStart } from './protocols/shared.ts'

interface StartMatch {
  matched: boolean
  partial: boolean
  index: number
  protocol?: ToolProtocolId
}

interface ClosedFence {
  end: number
}

export class ToolStreamParser {
  private readonly plan: ToolCallingPlan
  private buffer = ''
  private isBufferingToolCall = false
  private isBufferingFence = false
  private emittedToolCall = false
  private sentRole = false
  private nextToolCallIndex = 0
  private activeProtocol?: ToolProtocolId

  constructor(plan: ToolCallingPlan) {
    this.plan = plan
  }

  push(content: string, baseChunk: any, includeRole: boolean = false): any[] {
    if (!content || !this.plan.shouldParseResponse || this.emittedToolCall) return []

    this.buffer += content
    const chunks: any[] = []
    let guard = 0

    const emitContent = (text: string): void => {
      if (!text) return
      const role = includeRole && !this.sentRole
      if (role) this.sentRole = true
      chunks.push(createContentChunk(baseChunk, text, role))
    }

    while (guard < 1000 && !this.emittedToolCall) {
      guard += 1

      if (this.isBufferingToolCall) {
        const parsed = parseToolResponse(this.buffer, this.plan)
        if (parsed.toolCalls.length > 0) {
          this.emitParsed(parsed, baseChunk, includeRole, chunks, emitContent)
          this.buffer = ''
          this.isBufferingToolCall = false
          this.activeProtocol = undefined
          this.emittedToolCall = true
          break
        }

        if (isCompleteToolPayload(this.buffer, this.activeProtocol, this.plan)) {
          if (containsExplicitToolMarker(this.buffer, this.plan) || parsed.invalidToolNames.length > 0) {
            // The wrapper is complete but unusable. Drop it rather than leaking
            // a raw tool-call wrapper into the coding client's content.
            this.buffer = ''
          } else {
            // A JSON object that merely looked like a tool call. Release it as
            // normal content instead of swallowing the model's answer.
            const role = includeRole && !this.sentRole
            if (role) this.sentRole = true
            chunks.push(createContentChunk(baseChunk, this.buffer, role))
            this.buffer = ''
          }
          this.isBufferingToolCall = false
          this.activeProtocol = undefined
        }
        break
      }

      if (this.isBufferingFence) {
        const fence = findClosedFenceAtStart(this.buffer)
        if (!fence) break

        const fenceText = this.buffer.slice(0, fence.end)
        const parsed = parseToolResponse(fenceText, this.plan)
        if (parsed.toolCalls.length > 0) {
          this.emitParsed(parsed, baseChunk, includeRole, chunks, emitContent)
          this.buffer = this.buffer.slice(fence.end)
          this.isBufferingFence = false
          this.activeProtocol = undefined
          this.emittedToolCall = true
          break
        }

        emitContent(fenceText)
        this.buffer = this.buffer.slice(fence.end)
        this.isBufferingFence = false
        this.activeProtocol = undefined
        continue
      }

      const start = findToolStart(this.buffer, this.plan)
      const fenceStart = findUnclosedFenceStart(this.buffer)

      if (start.matched || start.partial) {
        const useFence = fenceStart !== -1 && fenceStart <= start.index
        const startIndex = useFence ? fenceStart : start.index

        if (startIndex > 0) {
          emitContent(this.buffer.slice(0, startIndex))
          this.buffer = this.buffer.slice(startIndex)
        }

        this.activeProtocol = start.protocol
        if (useFence) {
          this.isBufferingFence = true
        } else {
          this.isBufferingToolCall = true
        }

        if (start.partial && !useFence) break
        continue
      }

      if (fenceStart !== -1) {
        if (fenceStart > 0) {
          emitContent(this.buffer.slice(0, fenceStart))
          this.buffer = this.buffer.slice(fenceStart)
        }
        this.isBufferingFence = true
        continue
      }

      emitContent(this.buffer)
      this.buffer = ''
      break
    }

    return chunks
  }

  flush(baseChunk: any): any[] {
    if (!this.buffer || this.emittedToolCall) {
      this.buffer = ''
      return []
    }

    const chunks: any[] = []
    const parsed = parseToolResponse(this.buffer, this.plan)

    if (parsed.toolCalls.length > 0) {
      const emitContent = (text: string): void => {
        if (text) chunks.push(createContentChunk(baseChunk, text, false))
      }
      this.emitParsed(parsed, baseChunk, false, chunks, emitContent)
      this.emittedToolCall = true
    } else if (parsed.invalidToolNames.length === 0 && !containsExplicitToolMarker(this.buffer, this.plan)) {
      chunks.push(createContentChunk(baseChunk, this.buffer, false))
    }

    this.buffer = ''
    this.isBufferingToolCall = false
    this.isBufferingFence = false
    this.activeProtocol = undefined
    return chunks
  }

  hasEmittedToolCall(): boolean {
    return this.emittedToolCall
  }

  isBuffering(): boolean {
    return this.isBufferingToolCall || this.isBufferingFence
  }

  private emitParsed(
    parsed: ToolParseResult,
    baseChunk: any,
    includeRole: boolean,
    chunks: any[],
    emitContent: (text: string) => void,
  ): void {
    if (parsed.content.trim()) {
      emitContent(parsed.content)
    }

    for (const toolCall of parsed.toolCalls) {
      const indexedToolCall = {
        ...toolCall,
        index: this.nextToolCallIndex,
        id: toolCall.id || `call_${this.nextToolCallIndex}`,
      }
      this.nextToolCallIndex += 1

      const role = includeRole && !this.sentRole
      if (role) this.sentRole = true
      chunks.push(createToolCallChunk(baseChunk, indexedToolCall, role))
    }
  }
}

function findToolStart(buffer: string, plan: ToolCallingPlan): StartMatch {
  const ranges = findFencedRanges(buffer)
  let matchedIndex = -1
  let matchedProtocol: ToolProtocolId | undefined
  let partialIndex = -1
  let partialProtocol: ToolProtocolId | undefined

  for (const protocolId of getProtocolCandidates(plan)) {
    const detection = getToolProtocol(protocolId).detectStart(buffer, plan.tools)
    if (detection.markerStart === undefined) continue

    const index = mapToFenceStart(buffer, detection.markerStart, ranges)
    if (detection.matched && (matchedIndex === -1 || index < matchedIndex)) {
      matchedIndex = index
      matchedProtocol = protocolId
    }
    if (detection.partial && (partialIndex === -1 || index < partialIndex)) {
      partialIndex = index
      partialProtocol = protocolId
    }
  }

  if (partialIndex !== -1 && (matchedIndex === -1 || partialIndex <= matchedIndex)) {
    return { matched: false, partial: true, index: partialIndex, protocol: partialProtocol }
  }
  if (matchedIndex !== -1) {
    return { matched: true, partial: false, index: matchedIndex, protocol: matchedProtocol }
  }

  return { matched: false, partial: false, index: -1 }
}

function findUnclosedFenceStart(buffer: string): number {
  const unclosed = findFencedRanges(buffer).find((range) => range.unclosed)
  if (unclosed) return unclosed.start

  // A fence opening split across chunks, e.g. "`" or "``".
  const partial = buffer.match(/(^|\n)[ \t]*(`{1,2}|~{1,2})$/)
  if (partial) {
    return partial.index! + partial[1].length + (partial[0].length - partial[1].length - partial[2].length)
  }

  return -1
}

function findClosedFenceAtStart(buffer: string): ClosedFence | undefined {
  const fence = findFencedRanges(buffer).find((range) => range.start === 0 && !range.unclosed)
  if (!fence) return undefined

  let end = fence.end
  if (buffer.slice(end, end + 2) === '\r\n') end += 2
  else if (buffer[end] === '\n') end += 1

  return { end }
}

function isCompleteToolPayload(
  buffer: string,
  protocol: ToolProtocolId | undefined,
  plan: ToolCallingPlan,
): boolean {
  if (hasClosingFence(buffer)) return true
  if (protocol === 'json_tool_calls' || protocol === 'codex_responses') {
    return hasBalancedJson(buffer)
  }
  if (protocol === 'xml_tool_tag') {
    const names = plan.tools.map((tool) => escapeRegExp(tool.name)).join('|')
    if (names && new RegExp(`</(?:${names})>`).test(buffer)) return true
  }

  return /\[\/function_calls\]|<\/\|CHAT2API\|tool_calls>|<\/tool_calls>|<\/antml:function_calls>|<\/function_calls>|<\/tool_use>|<\/tool_name>|<\/(?:tool_call|tool_calls|function_call)>/i.test(buffer)
}

function containsExplicitToolMarker(buffer: string, plan: ToolCallingPlan): boolean {
  if (
    /\[function_calls\]|<\|CHAT2API\|tool_calls>|<tool_calls>|<antml:function_calls>|<function_calls>|<tool_use>|<tool_call>|\[TOOL_CALLS\]|<\|python_tag\|>|<\|tool_call\|>/i.test(buffer)
  ) {
    return true
  }

  for (const tool of plan.tools) {
    if (buffer.includes(`<${tool.name}>`) || buffer.includes(`<${tool.name} `)) return true
  }

  return false
}

function hasClosingFence(buffer: string): boolean {
  return findFencedRanges(buffer).some((range) => !range.unclosed)
}

function hasBalancedJson(buffer: string): boolean {
  const start = buffer.search(/[{\[]/)
  if (start === -1) return false

  let depth = 0
  let inString = false
  let escaped = false

  for (let index = start; index < buffer.length; index += 1) {
    const char = buffer[index]
    if (inString) {
      if (escaped) {
        escaped = false
      } else if (char === '\\') {
        escaped = true
      } else if (char === '"') {
        inString = false
      }
      continue
    }

    if (char === '"') {
      inString = true
    } else if (char === '{' || char === '[') {
      depth += 1
    } else if (char === '}' || char === ']') {
      depth -= 1
      if (depth === 0) return true
    }
  }

  return false
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
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
