import type { NormalizedToolDefinition, NormalizedToolResult, ToolParseResult, ToolProtocolId } from '../types.ts'
import type { ToolProtocolDetection } from './base.ts'
import type { ToolCall } from '../../types.ts'

export function detectMarkers(buffer: string, markers: string[]): ToolProtocolDetection {
  let earliest = -1
  for (const marker of markers) {
    const index = buffer.indexOf(marker)
    if (index !== -1 && (earliest === -1 || index < earliest)) {
      earliest = index
    }
  }

  if (earliest !== -1) {
    return { matched: true, partial: false, markerStart: earliest }
  }

  for (let index = 0; index < buffer.length; index += 1) {
    const suffix = buffer.slice(index)
    if (markers.some((marker) => marker.startsWith(suffix))) {
      return { matched: false, partial: true, markerStart: index }
    }
  }

  return { matched: false, partial: false }
}

export interface FencedRange {
  /** Index of the opening fence marker. */
  start: number
  /** Index just past the closing fence marker (or end of content when unclosed). */
  end: number
  /** Index just past the opening fence line. */
  openEnd: number
  /** Index of the closing fence line (or end of content when unclosed). */
  closeStart: number
  marker: string
  unclosed: boolean
}

/**
 * Find ``` and ~~~ fenced code blocks. Unlike a simple regex this keeps track
 * of unclosed fences, which lets the streaming parser wait for the closing
 * fence instead of leaking a fenced tool call as plain text.
 */
export function findFencedRanges(content: string): FencedRange[] {
  const ranges: FencedRange[] = []
  let open: { start: number; marker: string; openEnd: number } | null = null
  let offset = 0

  for (const line of content.split('\n')) {
    const trimmed = line.trimStart()
    const markerMatch = trimmed.match(/^(`{3,}|~{3,})/)
    if (!open && markerMatch) {
      open = {
        start: offset,
        marker: markerMatch[1],
        openEnd: Math.min(content.length, offset + line.length + 1),
      }
    } else if (open && markerMatch) {
      const closes =
        markerMatch[1][0] === open.marker[0] &&
        markerMatch[1].length >= open.marker.length
      if (closes) {
        ranges.push({
          start: open.start,
          end: offset + line.length,
          openEnd: open.openEnd,
          closeStart: offset,
          marker: open.marker,
          unclosed: false,
        })
        open = null
      }
    }
    offset += line.length + 1
  }

  if (open) {
    ranges.push({
      start: open.start,
      end: content.length,
      openEnd: open.openEnd,
      closeStart: content.length,
      marker: open.marker,
      unclosed: true,
    })
  }

  return ranges
}

export function findEnclosingFence(
  content: string,
  index: number,
  ranges: FencedRange[] = findFencedRanges(content),
): FencedRange | undefined {
  return ranges.find((range) => index >= range.start && index < range.end)
}

export function mapToFenceStart(content: string, index: number, ranges?: FencedRange[]): number {
  const fence = findEnclosingFence(content, index, ranges)
  return fence ? fence.start : index
}

export function isInsideFence(content: string, index: number, ranges?: FencedRange[]): boolean {
  return Boolean(findEnclosingFence(content, index, ranges))
}

/**
 * Remove parsed tool blocks from response content.
 *
 * Tool calls wrapped in their own fenced block remove the whole fence. A tool
 * call embedded in a larger code block removes only the call, leaving the
 * unrelated code (and its fence) intact.
 */
export function removeToolBlocks(content: string, rawMatches: string[]): string {
  let result = content

  for (const raw of rawMatches) {
    if (!raw) continue
    const index = result.indexOf(raw)
    if (index === -1) continue

    const ranges = findFencedRanges(result)
    const fence = findEnclosingFence(result, index, ranges)

    if (fence && fenceContainsOnlyToolBlocks(result, fence, rawMatches)) {
      const trailing = result.slice(fence.end).match(/^\r?\n/)
      result = result.slice(0, fence.start) + result.slice(fence.end + (trailing?.[0].length ?? 0))
    } else {
      result = result.slice(0, index) + result.slice(index + raw.length)
    }
  }

  result = result
    .replace(/(^|\n)[ \t]*(?:`{3,}|~{3,})[^\n]*\r?\n[ \t]*(?:`{3,}|~{3,})[ \t]*(?=\r?\n|$)/g, '$1')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()

  return result
}

function fenceContainsOnlyToolBlocks(content: string, fence: FencedRange, rawMatches: string[]): boolean {
  if (fence.unclosed) return false

  let remainder = content.slice(fence.openEnd, fence.closeStart)
  for (const raw of rawMatches) {
    if (!raw) continue
    let index = remainder.indexOf(raw)
    while (index !== -1) {
      remainder = remainder.slice(0, index) + remainder.slice(index + raw.length)
      index = remainder.indexOf(raw)
    }
  }

  return remainder.trim() === ''
}

export function stripFencedCodeBlocks(content: string): string {
  return content.replace(/```[\s\S]*?```/g, '')
}

export function toolNames(tools: NormalizedToolDefinition[]): Set<string> {
  return new Set(tools.map((tool) => tool.name))
}

export function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

export function createParseResult(input: {
  content: string
  toolCalls: ToolCall[]
  protocol: ToolProtocolId | 'unknown'
  rawMatches: string[]
  invalidToolNames?: string[]
  malformedReason?: string
}): ToolParseResult {
  return {
    content: input.content,
    toolCalls: input.toolCalls,
    protocol: input.protocol,
    rawMatches: input.rawMatches,
    malformedReason: input.malformedReason,
    invalidToolNames: input.invalidToolNames ?? [],
  }
}

export function buildToolCall(
  id: string,
  index: number,
  name: string,
  args: string,
  rawText?: string,
): ToolCall {
  return {
    id,
    index,
    type: 'function',
    function: {
      name,
      arguments: normalizeArguments(args),
    },
    ...(rawText ? { rawText } : {}),
  } as ToolCall
}

export function normalizeArguments(args: unknown): string {
  if (typeof args === 'string') {
    const trimmed = stripCodeFence(args).trim()
    if (!trimmed) return '{}'
    try {
      return JSON.stringify(JSON.parse(trimmed))
    } catch {
      const repaired = repairJson(trimmed)
      if (repaired !== undefined) return JSON.stringify(repaired)
      const xmlArgs = parseSimpleXmlArguments(trimmed)
      if (xmlArgs) return JSON.stringify(xmlArgs)
      return trimmed
    }
  }

  return JSON.stringify(args ?? {})
}

function parseSimpleXmlArguments(value: string): Record<string, unknown> | undefined {
  if (!value.startsWith('<')) return undefined

  const args: Record<string, unknown> = {}
  const pattern = /<([A-Za-z_][\w:.-]*)(?:\s[^>]*)?>([\s\S]*?)<\/\1>/g
  let match: RegExpExecArray | null
  while ((match = pattern.exec(value)) !== null) {
    addParameter(args, match[1], parseJsonValue(match[2]))
  }

  return Object.keys(args).length > 0 ? args : undefined
}

export function parseJsonValue(value: string): unknown {
  const trimmed = unwrapCdata(value).trim()
  if (!trimmed) return ''

  try {
    return JSON.parse(trimmed)
  } catch {
    const repaired = repairJson(trimmed)
    if (repaired !== undefined) return repaired
    return decodeXml(trimmed)
  }
}

export function unwrapCdata(value: string): string {
  const cdata = value.match(/^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/)
  return cdata ? cdata[1] : value
}

export function decodeXml(value: string): string {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
}

export function escapeXmlAttribute(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

export function addParameter(target: Record<string, unknown>, name: string, value: unknown): void {
  const existing = target[name]
  if (existing === undefined) {
    target[name] = value
  } else if (Array.isArray(existing)) {
    target[name] = [...existing, value]
  } else {
    target[name] = [existing, value]
  }
}

export function renderToolList(tools: NormalizedToolDefinition[]): string {
  return tools
    .map((tool) => {
      const parameters = JSON.stringify(tool.parameters ?? {})
      return `Tool \`${tool.name}\`: ${tool.description || 'No description'}. Arguments JSON schema: ${parameters}`
    })
    .join('\n')
}

export function renderCompactToolList(tools: NormalizedToolDefinition[]): string {
  return tools
    .map((tool) => {
      const parameters = JSON.stringify(tool.parameters ?? {})
      return `- ${tool.name}: ${tool.description || 'No description'} | args: ${parameters}`
    })
    .join('\n')
}

export function genericToolResultBlock(result: NormalizedToolResult): string {
  return `[TOOL_RESULT for ${result.toolCallId}] ${result.content}`
}

export function stripCodeFence(value: string): string {
  const match = value.match(/^\s*(?:`{3,}|~{3,})[^\n]*\r?\n([\s\S]*?)\r?\n?\s*(?:`{3,}|~{3,})\s*$/)
  return match ? match[1] : value
}

export interface JsonCandidate {
  text: string
  raw: string
}

/**
 * Collect JSON payloads that may contain tool calls. Handles whole-response
 * JSON, fenced JSON, Hermes/Qwen <tool_call> wrappers and balanced JSON objects
 * embedded in prose.
 */
export function collectJsonCandidates(content: string): JsonCandidate[] {
  const candidates: JsonCandidate[] = []
  const trimmed = content.trim()

  if (trimmed) {
    const fenced = trimmed.match(/^(?:`{3,}|~{3,})[^\n]*\r?\n([\s\S]*?)\r?\n?\s*(?:`{3,}|~{3,})\s*$/)
    if (fenced) {
      candidates.push({ text: fenced[1], raw: trimmed })
    } else if (looksLikeJson(trimmed)) {
      candidates.push({ text: trimmed, raw: trimmed })
    }
  }

  const fencedPattern = /(?:^|\n)([ \t]*(?:`{3,}|~{3,})[^\n]*\r?\n[\s\S]*?\r?\n?[ \t]*(?:`{3,}|~{3,}))/g
  let fencedMatch: RegExpExecArray | null
  while ((fencedMatch = fencedPattern.exec(content)) !== null) {
    const raw = fencedMatch[1]
    const inner = raw.match(/^[ \t]*(?:`{3,}|~{3,})[^\n]*\r?\n([\s\S]*?)\r?\n?[ \t]*(?:`{3,}|~{3,})[ \t]*$/)
    if (inner && looksLikeJson(inner[1].trim())) {
      candidates.push({ text: inner[1], raw })
    }
  }

  const wrapperPattern = /<(tool_call|tool_calls|function_call)>\s*([\s\S]*?)\s*<\/\1>/gi
  let wrapperMatch: RegExpExecArray | null
  while ((wrapperMatch = wrapperPattern.exec(content)) !== null) {
    if (looksLikeJson(wrapperMatch[2].trim())) {
      candidates.push({ text: wrapperMatch[2], raw: wrapperMatch[0] })
    }
  }

  const mistralMarker = content.indexOf('[TOOL_CALLS]')
  if (mistralMarker !== -1) {
    const jsonText = content.slice(mistralMarker + '[TOOL_CALLS]'.length).trim()
    if (looksLikeJson(jsonText)) {
      candidates.push({ text: jsonText, raw: content.slice(mistralMarker) })
    }
  }

  for (const marker of ['<|python_tag|>', '<|tool_call|>']) {
    const markerIndex = content.indexOf(marker)
    if (markerIndex === -1) continue
    const jsonText = content.slice(markerIndex + marker.length).trim()
    if (looksLikeJson(jsonText)) {
      candidates.push({ text: jsonText, raw: content.slice(markerIndex) })
    }
  }

  for (const objectText of findBalancedJsonObjects(content)) {
    if (containsToolKey(objectText)) {
      candidates.push({ text: objectText, raw: objectText })
    }
  }

  return dedupeCandidates(candidates)
}

function dedupeCandidates(candidates: JsonCandidate[]): JsonCandidate[] {
  const seen = new Set<string>()
  return candidates.filter((candidate) => {
    const key = `${candidate.text.length}:${candidate.raw}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

function looksLikeJson(value: string): boolean {
  return value.startsWith('{') || value.startsWith('[')
}

function containsToolKey(value: string): boolean {
  return /"(?:tool_calls|tool_call|function_call|tool_use|name|tool|tool_name)"\s*:/.test(value)
}

function findBalancedJsonObjects(content: string): string[] {
  const objects: string[] = []

  for (let start = 0; start < content.length; start += 1) {
    if (content[start] !== '{') continue
    const end = findBalancedEnd(content, start)
    if (end === -1) continue
    const candidate = content.slice(start, end)
    if (candidate.length >= 8 && containsToolKey(candidate)) {
      objects.push(candidate)
    }
  }

  return objects
}

function findBalancedEnd(content: string, start: number): number {
  let depth = 0
  let inString = false
  let escaped = false

  for (let index = start; index < content.length; index += 1) {
    const char = content[index]
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
      if (depth === 0) return index + 1
    }
  }

  return -1
}

/**
 * Best-effort repair for JSON emitted by models: trailing commas, smart quotes,
 * single-quoted strings and unquoted keys.
 */
export function repairJson(value: string): unknown {
  let text = stripCodeFence(value).trim()
  text = text
    .replace(/^\uFEFF/, '')
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'")
    .replace(/,\s*([}\]])/g, '$1')

  const attempts = [
    text,
    text.replace(/([{,]\s*)'([^']*)'\s*:/g, '$1"$2":'),
    text.replace(/([{,]\s*)([A-Za-z_$][\w$]*)\s*:/g, '$1"$2":'),
    text
      .replace(/([{,]\s*)'([^']*)'\s*:/g, '$1"$2":')
      .replace(/:\s*'([^']*)'/g, ': "$1"')
      .replace(/([{,]\s*)([A-Za-z_$][\w$]*)\s*:/g, '$1"$2":'),
  ]

  for (const attempt of attempts) {
    try {
      return JSON.parse(attempt)
    } catch {
      // Try the next repair strategy.
    }
  }

  return undefined
}
