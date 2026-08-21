import type { ToolProtocolId } from './types.ts'

const TOOL_RESULT_START = '<|CHAT2API|tool_result'
const TOOL_RESULT_END = '</|CHAT2API|tool_result>'
const DISTINCTIVE_PARTIAL_RESULT = '<|CHAT2API|tool_r'
const MARKDOWN_FENCE = '```'

const PROTECTED_TOOL_CALL_MARKERS: Partial<Record<
  ToolProtocolId,
  { starts: readonly string[]; ends: readonly string[] }
>> = {
  managed_xml: {
    starts: [
      '<|CHAT2API|tool_calls>',
      '<tool_calls>',
      '<|tool_calls>',
      '<\uFF5CQCML\uFF5Ctool_calls>',
    ],
    ends: [
      '</|CHAT2API|tool_calls>',
      '</tool_calls>',
      '</|tool_calls>',
      '</\uFF5CQCML\uFF5Ctool_calls>',
    ],
  },
  managed_bracket: {
    starts: ['[function_calls]'],
    ends: ['[/function_calls]'],
  },
  openai_chat: {
    starts: ['[function_calls]'],
    ends: ['[/function_calls]'],
  },
  qwen_hermes: {
    starts: ['<tool_call>'],
    ends: ['</tool_call>'],
  },
  anthropic_tool_use: {
    starts: ['<antml:function_calls>'],
    ends: ['</antml:function_calls>'],
  },
}

type GuardState = 'text' | 'fenced' | 'tool_call' | 'tool_result'

export interface ManagedToolResultGuardOutput {
  content: string
  suppressed: boolean
}

export interface ManagedToolResultStripResult extends ManagedToolResultGuardOutput {
  wrapperLeakDetected: boolean
}

export type ManagedToolResultWrapperLeakError = Error & {
  status: number
  code: string
  type: string
  param: string
  retryable: boolean
  accountFault: boolean
}

export function createManagedToolResultWrapperLeakError(
  param: string = 'content',
): ManagedToolResultWrapperLeakError {
  const error = new Error(
    'Provider returned an internal managed tool-result wrapper in assistant output',
  ) as ManagedToolResultWrapperLeakError
  error.status = 502
  error.code = 'managed_tool_result_wrapper_leak'
  error.type = 'upstream_protocol_error'
  error.param = param
  error.retryable = false
  error.accountFault = false
  return error
}

/**
 * Removes provider-generated copies of Chat2API tool-result envelopes while
 * preserving the same literal text inside a top-level managed tool call.
 */
export class ManagedToolResultGuard {
  private buffer = ''
  private state: GuardState = 'text'
  private resumeStateAfterToolResult: 'text' | 'fenced' = 'text'
  private wrapperLeakDetected = false
  private readonly toolCallStarts: readonly string[]
  private readonly toolCallEnds: readonly string[]
  private readonly bufferUntilFlush: boolean

  constructor(protectedToolCallProtocol: ToolProtocolId | null = 'managed_xml') {
    const markers = protectedToolCallProtocol
      ? PROTECTED_TOOL_CALL_MARKERS[protectedToolCallProtocol]
      : undefined
    this.toolCallStarts = markers?.starts ?? []
    this.toolCallEnds = markers?.ends ?? []
    // Responses-style calls are JSON rather than a delimited text protocol.
    // Hold the candidate until it can be parsed structurally so a literal
    // wrapper inside `arguments` is not mistaken for top-level assistant text.
    this.bufferUntilFlush = protectedToolCallProtocol === 'codex_responses'
  }

  push(content: string): ManagedToolResultGuardOutput {
    if (!content) return { content: '', suppressed: false }
    this.buffer += content
    if (this.bufferUntilFlush) return { content: '', suppressed: false }
    return this.drain(false)
  }

  flush(): ManagedToolResultGuardOutput {
    if (
      this.bufferUntilFlush
      && managedWrapperOccursOnlyInCodexToolArguments(this.buffer)
    ) {
      const content = this.buffer
      this.buffer = ''
      this.state = 'text'
      return { content, suppressed: false }
    }
    return this.drain(true)
  }

  hasDetectedWrapperLeak(): boolean {
    return this.wrapperLeakDetected
  }

  hasPendingCandidate(): boolean {
    return this.state !== 'text' || this.buffer.length > 0
  }

  private drain(final: boolean): ManagedToolResultGuardOutput {
    let content = ''
    let suppressed = false

    while (this.buffer) {
      if (this.state === 'tool_result') {
        suppressed = true
        const endIndex = this.buffer.indexOf(TOOL_RESULT_END)
        if (endIndex !== -1) {
          this.buffer = this.buffer.slice(endIndex + TOOL_RESULT_END.length)
          this.state = this.resumeStateAfterToolResult
          continue
        }

        if (final) {
          this.buffer = ''
          this.state = 'text'
          break
        }

        const retained = longestSuffixPrefixLength(this.buffer, [TOOL_RESULT_END])
        this.buffer = retained > 0 ? this.buffer.slice(-retained) : ''
        break
      }

      if (this.state === 'fenced') {
        const fenceIndex = this.buffer.indexOf(MARKDOWN_FENCE)
        const toolResultIndex = findToolResultStart(this.buffer, final)
        if (toolResultIndex !== undefined && (fenceIndex === -1 || toolResultIndex < fenceIndex)) {
          content += this.buffer.slice(0, toolResultIndex)
          this.buffer = this.buffer.slice(toolResultIndex + TOOL_RESULT_START.length)
          this.resumeStateAfterToolResult = 'fenced'
          this.state = 'tool_result'
          this.wrapperLeakDetected = true
          suppressed = true
          continue
        }
        if (fenceIndex !== -1) {
          const fenceEnd = fenceIndex + MARKDOWN_FENCE.length
          content += this.buffer.slice(0, fenceEnd)
          this.buffer = this.buffer.slice(fenceEnd)
          this.state = 'text'
          continue
        }

        if (final) {
          const partialResultIndex = findDistinctivePartialResultSuffix(this.buffer)
          if (partialResultIndex !== -1) {
            content += this.buffer.slice(0, partialResultIndex)
            this.wrapperLeakDetected = true
            suppressed = true
          } else {
            content += this.buffer
          }
          this.buffer = ''
          this.state = 'text'
          break
        }

        const retained = longestSuffixPrefixLength(this.buffer, [
          MARKDOWN_FENCE,
          TOOL_RESULT_START,
        ])
        const visibleLength = this.buffer.length - retained
        content += this.buffer.slice(0, visibleLength)
        this.buffer = this.buffer.slice(visibleLength)
        break
      }

      if (this.state === 'tool_call') {
        const end = findEarliestMarker(this.buffer, this.toolCallEnds)
        if (end) {
          const endOffset = end.index + end.marker.length
          content += this.buffer.slice(0, endOffset)
          this.buffer = this.buffer.slice(endOffset)
          this.state = 'text'
          continue
        }

        if (final) {
          content += this.buffer
          this.buffer = ''
          this.state = 'text'
          break
        }

        const retained = longestSuffixPrefixLength(this.buffer, this.toolCallEnds)
        const visibleLength = this.buffer.length - retained
        content += this.buffer.slice(0, visibleLength)
        this.buffer = this.buffer.slice(visibleLength)
        break
      }

      const start = findNextTopLevelStart(
        this.buffer,
        final,
        this.toolCallStarts,
      )
      if (start) {
        content += this.buffer.slice(0, start.index)
        this.buffer = this.buffer.slice(start.index + start.marker.length)

        if (start.kind === 'tool_result') {
          this.resumeStateAfterToolResult = 'text'
          this.state = 'tool_result'
          this.wrapperLeakDetected = true
          suppressed = true
        } else if (start.kind === 'fence') {
          this.state = 'fenced'
          content += start.marker
        } else {
          this.state = 'tool_call'
          content += start.marker
        }
        continue
      }

      if (final) {
        const partialResultIndex = findDistinctivePartialResultSuffix(this.buffer)
        if (partialResultIndex !== -1) {
          content += this.buffer.slice(0, partialResultIndex)
          this.wrapperLeakDetected = true
          suppressed = true
        } else {
          content += this.buffer
        }
        this.buffer = ''
        break
      }

      const retained = longestSuffixPrefixLength(this.buffer, [
        ...this.toolCallStarts,
        MARKDOWN_FENCE,
        TOOL_RESULT_START,
      ])
      const visibleLength = this.buffer.length - retained
      content += this.buffer.slice(0, visibleLength)
      this.buffer = this.buffer.slice(visibleLength)
      break
    }

    if (final) {
      this.buffer = ''
      this.state = 'text'
      this.resumeStateAfterToolResult = 'text'
    }
    return { content, suppressed }
  }
}

export function stripManagedToolResultWrappers(
  content: string,
  protectedToolCallProtocol: ToolProtocolId | null = 'managed_xml',
): ManagedToolResultStripResult {
  const guard = new ManagedToolResultGuard(protectedToolCallProtocol)
  const streamed = guard.push(content)
  const flushed = guard.flush()
  return {
    content: streamed.content + flushed.content,
    suppressed: streamed.suppressed || flushed.suppressed,
    wrapperLeakDetected: guard.hasDetectedWrapperLeak(),
  }
}

function findNextTopLevelStart(
  content: string,
  final: boolean,
  toolCallStarts: readonly string[],
): { index: number; marker: string; kind: 'fence' | 'tool_call' | 'tool_result' } | undefined {
  const toolCall = findEarliestMarker(content, toolCallStarts)
  const toolResultIndex = findToolResultStart(content, final)
  const fenceIndex = content.indexOf(MARKDOWN_FENCE)

  if (
    toolResultIndex !== undefined
    && (!toolCall || toolResultIndex < toolCall.index)
    && (fenceIndex === -1 || toolResultIndex < fenceIndex)
  ) {
    return { index: toolResultIndex, marker: TOOL_RESULT_START, kind: 'tool_result' }
  }
  if (fenceIndex !== -1 && (!toolCall || fenceIndex < toolCall.index)) {
    return { index: fenceIndex, marker: MARKDOWN_FENCE, kind: 'fence' }
  }
  if (toolCall && (fenceIndex === -1 || toolCall.index < fenceIndex)) {
    return { ...toolCall, kind: 'tool_call' }
  }
  return undefined
}

function findToolResultStart(content: string, final: boolean): number | undefined {
  let searchIndex = 0
  while (searchIndex < content.length) {
    const index = content.indexOf(TOOL_RESULT_START, searchIndex)
    if (index === -1) return undefined

    const boundaryIndex = index + TOOL_RESULT_START.length
    if (boundaryIndex === content.length) {
      return final ? index : undefined
    }
    if (/[\s>]/.test(content[boundaryIndex])) {
      return index
    }
    searchIndex = boundaryIndex
  }
  return undefined
}

function findEarliestMarker(
  content: string,
  markers: readonly string[],
): { index: number; marker: string } | undefined {
  let selected: { index: number; marker: string } | undefined
  for (const marker of markers) {
    const index = content.indexOf(marker)
    if (index === -1) continue
    if (!selected || index < selected.index) selected = { index, marker }
  }
  return selected
}

function longestSuffixPrefixLength(content: string, markers: readonly string[]): number {
  const maximum = Math.min(
    content.length,
    markers.reduce((length, marker) => Math.max(length, marker.length), 0),
  )
  for (let length = maximum; length > 0; length -= 1) {
    const suffix = content.slice(-length)
    if (markers.some((marker) => marker.startsWith(suffix))) return length
  }
  return 0
}

function findDistinctivePartialResultSuffix(content: string): number {
  const maximum = Math.min(content.length, TOOL_RESULT_START.length)
  for (let length = maximum; length >= DISTINCTIVE_PARTIAL_RESULT.length; length -= 1) {
    const suffix = content.slice(-length)
    if (TOOL_RESULT_START.startsWith(suffix)) return content.length - length
  }
  return -1
}

function managedWrapperOccursOnlyInCodexToolArguments(content: string): boolean {
  if (!content.includes(TOOL_RESULT_START)) return false

  let parsed: unknown
  try {
    parsed = JSON.parse(content)
  } catch {
    return false
  }

  let allowedOccurrence = false
  let disallowedOccurrence = false

  const inspect = (value: unknown, insideToolArguments: boolean): void => {
    if (typeof value === 'string') {
      if (!value.includes(TOOL_RESULT_START)) return
      if (insideToolArguments) allowedOccurrence = true
      else disallowedOccurrence = true
      return
    }
    if (Array.isArray(value)) {
      for (const item of value) inspect(item, insideToolArguments)
      return
    }
    if (!value || typeof value !== 'object') return

    const record = value as Record<string, unknown>
    const isFunctionCall = record.type === 'function_call'
    for (const [key, item] of Object.entries(record)) {
      if (key.includes(TOOL_RESULT_START)) {
        if (insideToolArguments) allowedOccurrence = true
        else disallowedOccurrence = true
      }
      inspect(item, insideToolArguments || (isFunctionCall && key === 'arguments'))
    }
  }

  inspect(parsed, false)
  return allowedOccurrence && !disallowedOccurrence
}
