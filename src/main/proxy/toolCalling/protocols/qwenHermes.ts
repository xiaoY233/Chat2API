import type { ToolProtocolAdapter } from './base.ts'
import type {
  NormalizedToolDefinition,
  NormalizedToolResult,
  ToolParseContext,
} from '../types.ts'
import {
  addParameter,
  buildToolCall,
  createParseResult,
  decodeXml,
  detectMarkers,
  escapeXmlAttribute,
  hasToolArgumentValidationIssues,
  parseJsonValue,
  stripFencedCodeBlocks,
  toolNames,
} from './shared.ts'

const TOOL_CALL_START = '<tool_call>'
const TOOL_CALL_END = '</tool_call>'
const TOOL_RESPONSE_START = '<tool_response>'
const TOOL_RESPONSE_END = '</tool_response>'
const FUNCTION_START = '<function='
const FUNCTION_END = '</function>'
const PARAMETER_START = '<parameter='
const PARAMETER_END = '</parameter>'
const FUNCTION_INVOCATION_START = '<function_invocation>'
const FUNCTION_INVOCATION_END = '</function_invocation>'

const QWEN_HERMES_PROTOCOL_ID = 'qwen_hermes' as const
const QWEN_HERMES_ROUTING_SUMMARY_DEFAULT_CODE_POINTS = 240

const JSON_SCHEMA_ANNOTATION_KEYS = new Set([
  '$comment',
  'default',
  'deprecated',
  'description',
  'example',
  'examples',
  'readOnly',
  'title',
  'writeOnly',
])

const JSON_SCHEMA_MAP_KEYWORDS = new Set([
  '$defs',
  'definitions',
  'dependentSchemas',
  'patternProperties',
  'properties',
])

const JSON_SCHEMA_ARRAY_KEYWORDS = new Set([
  'allOf',
  'anyOf',
  'oneOf',
  'prefixItems',
])

const JSON_SCHEMA_SINGLE_KEYWORDS = new Set([
  'additionalItems',
  'additionalProperties',
  'contains',
  'contentSchema',
  'else',
  'if',
  'not',
  'propertyNames',
  'then',
  'unevaluatedItems',
  'unevaluatedProperties',
])

interface JsonObjectBoundary {
  start: number
  end: number
  text: string
}

interface ParsedEnvelope {
  name: string
  arguments: Record<string, unknown>
}

interface QwenManagedCallStart {
  index: number
  kind: 'hermes_json_or_xml' | 'bare_xml'
}

interface QwenXmlFunctionBoundary {
  start: number
  end: number
  text: string
}

interface ParsedQwenCall {
  end: number
  rawText: string
  envelope?: ParsedEnvelope
  envelopes?: ParsedEnvelope[]
  malformedReason?: string
}

// Qwen variants sometimes wrap several complete functions in one envelope.
// Only structural tags are accepted here; prose still invalidates the batch.
const QWEN_XML_WRAPPER_TAGS = [
  FUNCTION_INVOCATION_START,
  FUNCTION_INVOCATION_END,
  FUNCTION_END,
]

export interface QwenHermesDocumentPrompt {
  compactPrompt: string
  referenceContent: string
}

export interface QwenHermesDocumentPromptOptions {
  routingSummaryMaxCodePoints?: number
}

export function qwenHermesRoutingSummaryMaxCodePointsFromEnv(): number {
  const raw = process.env.CHAT2API_QWEN_AI_HERMES_ROUTING_SUMMARY_MAX_CODE_POINTS
  if (raw === undefined || raw.trim() === '') {
    return QWEN_HERMES_ROUTING_SUMMARY_DEFAULT_CODE_POINTS
  }

  const value = Number(raw)
  return Number.isSafeInteger(value) && value >= 0
    ? value
    : QWEN_HERMES_ROUTING_SUMMARY_DEFAULT_CODE_POINTS
}

export const qwenHermesProtocol: ToolProtocolAdapter = {
  id: QWEN_HERMES_PROTOCOL_ID,

  renderPrompt(tools) {
    const definitions = tools.map(renderToolDefinition).join('\n')
    return renderQwenHermesPrompt(definitions)
  },

  renderRecoveryPrompt(tools) {
    return `Return only one or more Qwen function calls with no prose before or after them.
Available function names: ${serializeHermesJson(tools.map((tool) => tool.name))}
Exact format:
<tool_call>
<function=exact_function_name>
<parameter=exact_parameter_name>
parameter_value
</parameter>
</function>
</tool_call>
Repeat the parameter block for every argument required by the selected function's JSON schema. Encode object and array values as JSON.`
  },

  detectStart(buffer) {
    return detectQwenManagedStart(buffer)
  },

  parse(content: string, context: ToolParseContext) {
    const parseable = stripFencedCodeBlocks(content)
    const allowedNames = toolNames(context.tools)
    const toolDefinitions = new Map(context.tools.map((tool) => [tool.name, tool]))
    const rawMatches: string[] = []
    const invalidToolNames: string[] = []
    const toolCalls: ReturnType<typeof buildToolCall>[] = []
    let malformedReason: string | undefined
    let searchIndex = 0

    while (searchIndex < parseable.length) {
      const callStart = findNextQwenManagedCallStart(parseable, searchIndex)
      if (!callStart) break

      const parsedCall = callStart.kind === 'bare_xml'
        ? parseBareQwenXmlCall(parseable, callStart.index, toolDefinitions)
        : parseWrappedQwenCall(
            parseable,
            callStart.index,
            context.allowPartial === true,
            toolDefinitions,
          )

      if (!parsedCall) {
        if (context.allowPartial) {
          rawMatches.push(parseable.slice(callStart.index))
          malformedReason ??= callStart.kind === 'bare_xml'
            ? 'qwen_xml_function_incomplete'
            : 'qwen_hermes_partial_json_incomplete'
        }
        break
      }

      rawMatches.push(parsedCall.rawText)
      searchIndex = parsedCall.end
      if (parsedCall.malformedReason) {
        malformedReason ??= parsedCall.malformedReason
        continue
      }

      const envelopes = parsedCall.envelopes
        ?? (parsedCall.envelope ? [parsedCall.envelope] : [])
      if (envelopes.length === 0) {
        malformedReason ??= 'qwen_hermes_invalid_envelope'
        continue
      }

      for (const envelope of envelopes) {
        if (!allowedNames.has(envelope.name)) {
          invalidToolNames.push(envelope.name)
          continue
        }

        const tool = toolDefinitions.get(envelope.name)
        if (hasToolArgumentValidationIssues(envelope.arguments, tool)) {
          malformedReason ??= 'qwen_hermes_schema_validation_failed'
          continue
        }

        toolCalls.push(
          buildToolCall(
            `call_${toolCalls.length}`,
            toolCalls.length,
            envelope.name,
            envelope.arguments,
            parsedCall.rawText,
            tool,
          ),
        )
      }
    }

    if (rawMatches.length === 0) {
      return createParseResult({
        content,
        toolCalls,
        protocol: 'unknown',
        rawMatches,
        invalidToolNames,
        malformedReason,
      })
    }

    const cleanContent = rawMatches
      .reduce((current, raw) => current.replace(raw, ''), parseable)
      .trim()
    const atomicToolCalls = malformedReason || invalidToolNames.length > 0
      ? []
      : toolCalls

    return createParseResult({
      content: cleanContent,
      toolCalls: atomicToolCalls,
      protocol: QWEN_HERMES_PROTOCOL_ID,
      rawMatches,
      invalidToolNames,
      malformedReason,
    })
  },

  formatAssistantToolCalls(calls) {
    return calls
      .map((call) => formatQwenXmlFunctionCall(
        call.name,
        parseHistoryArguments(call.arguments),
      ))
      .join('\n')
  },

  formatToolResult(result) {
    return formatToolResponse(result)
  },
}

/**
 * Build a smaller inline Hermes prompt for Qwen's document transport. Schema
 * assertions stay inline, while complete model-facing annotations remain
 * available in a separate, cacheable reference document. The original tool
 * definitions are never modified and remain authoritative for validation.
 */
export function createQwenHermesDocumentPrompt(
  tools: NormalizedToolDefinition[],
  options: QwenHermesDocumentPromptOptions = {},
): QwenHermesDocumentPrompt {
  const routingSummaryMaxCodePoints = options.routingSummaryMaxCodePoints
    ?? qwenHermesRoutingSummaryMaxCodePointsFromEnv()
  const orderedTools = stableSortQwenHermesTools(tools)
  const compactDefinitions = orderedTools
    .map(tool => renderCompactToolDefinition(tool, routingSummaryMaxCodePoints))
    .join('\n')
  const referenceDefinitions = orderedTools
    .map(renderToolDefinition)
    .join('\n')

  return {
    compactPrompt: renderQwenHermesPrompt(
      compactDefinitions,
      'Complete tool descriptions and schema annotations are in the attached managed tool reference. Treat that reference as authoritative and read the relevant entry before choosing or calling a function.',
    ),
    referenceContent: [
      '# Qwen Hermes Managed Tool Reference',
      'These complete function definitions are authoritative for tool selection and arguments.',
      '<tools>',
      referenceDefinitions,
      '</tools>',
    ].join('\n'),
  }
}

function renderQwenHermesPrompt(definitions: string, referenceInstruction?: string): string {
  return `# Tools

You may call one or more functions to assist with the user query.

You are provided with function signatures within <tools></tools> XML tags:
<tools>
${definitions}
</tools>${referenceInstruction ? `\n\n${referenceInstruction}` : ''}

If you choose to call a function, use this exact format with no suffix:
<tool_call>
<function=example_function_name>
<parameter=example_parameter_name>
parameter_value
</parameter>
</function>
</tool_call>

Use only function and parameter names declared above. Include every required parameter and satisfy the selected function's JSON schema. Encode object and array parameter values as JSON. Emit one <tool_call> block per function call. You may provide reasoning before the first function call, but never add text after a function call. If completing the request requires a tool, emit the tool call in this response instead of describing or promising a later action. When no function is needed, answer normally without tool-call tags.`
}

function renderToolDefinition(tool: NormalizedToolDefinition): string {
  return serializeHermesJson({
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description || '',
      parameters: tool.parameters ?? {},
    },
  })
}

function renderCompactToolDefinition(
  tool: NormalizedToolDefinition,
  routingSummaryMaxCodePoints: number,
): string {
  const description = createQwenHermesRoutingSummary(
    tool.description,
    routingSummaryMaxCodePoints,
  )
  return serializeHermesJson({
    type: 'function',
    function: {
      name: tool.name,
      ...(description ? { description } : {}),
      parameters: compactQwenHermesSchema(tool.parameters ?? {}),
    },
  })
}

function stableSortQwenHermesTools(
  tools: NormalizedToolDefinition[],
): NormalizedToolDefinition[] {
  return tools
    .map((tool, index) => ({ tool, index }))
    .sort((left, right) => {
      if (left.tool.name < right.tool.name) return -1
      if (left.tool.name > right.tool.name) return 1
      return left.index - right.index
    })
    .map(entry => entry.tool)
}

function createQwenHermesRoutingSummary(
  description: string | undefined,
  maxCodePoints: number,
): string | undefined {
  if (!description?.trim() || maxCodePoints === 0) return undefined

  const normalized = description.trim().replace(/\s+/g, ' ')
  const codePoints = Array.from(normalized)
  if (codePoints.length <= maxCodePoints) {
    return normalized
  }

  if (maxCodePoints <= 3) {
    return codePoints.slice(0, maxCodePoints).join('')
  }

  const prefixBudget = maxCodePoints - 3
  const rawPrefix = codePoints.slice(0, prefixBudget).join('')
  const lastWhitespace = rawPrefix.lastIndexOf(' ')
  const minimumUsefulPrefix = Math.floor(prefixBudget * 0.6)
  const prefix = lastWhitespace >= minimumUsefulPrefix
    ? rawPrefix.slice(0, lastWhitespace)
    : rawPrefix
  return `${prefix.trimEnd()}...`
}

function compactQwenHermesSchema(value: unknown): unknown {
  if (typeof value === 'boolean') return value
  if (!isObjectRecord(value)) return cloneQwenHermesJsonValue(value)

  return Object.fromEntries(
    Object.entries(value).flatMap(([key, entryValue]) => {
      if (JSON_SCHEMA_ANNOTATION_KEYS.has(key)) return []

      if (JSON_SCHEMA_MAP_KEYWORDS.has(key) && isObjectRecord(entryValue)) {
        return [[key, Object.fromEntries(
          Object.entries(entryValue).map(([name, schema]) => [
            name,
            compactQwenHermesSchema(schema),
          ]),
        )]]
      }

      if (JSON_SCHEMA_ARRAY_KEYWORDS.has(key) && Array.isArray(entryValue)) {
        return [[key, entryValue.map(compactQwenHermesSchema)]]
      }

      if (key === 'items') {
        return [[key, Array.isArray(entryValue)
          ? entryValue.map(compactQwenHermesSchema)
          : compactQwenHermesSchema(entryValue)]]
      }

      if (key === 'dependencies' && isObjectRecord(entryValue)) {
        return [[key, Object.fromEntries(
          Object.entries(entryValue).map(([name, dependency]) => [
            name,
            Array.isArray(dependency)
              ? cloneQwenHermesJsonValue(dependency)
              : compactQwenHermesSchema(dependency),
          ]),
        )]]
      }

      if (JSON_SCHEMA_SINGLE_KEYWORDS.has(key)) {
        return [[key, compactQwenHermesSchema(entryValue)]]
      }

      return [[key, cloneQwenHermesJsonValue(entryValue)]]
    }),
  )
}

function cloneQwenHermesJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(cloneQwenHermesJsonValue)
  if (!isObjectRecord(value)) return value
  return Object.fromEntries(
    Object.entries(value).map(([key, entryValue]) => [
      key,
      cloneQwenHermesJsonValue(entryValue),
    ]),
  )
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

function extractJsonObject(content: string, fromIndex: number): JsonObjectBoundary | undefined {
  let start = fromIndex
  while (start < content.length && /\s/.test(content[start])) start += 1
  if (content[start] !== '{') return undefined

  const stack: string[] = ['}']
  let inString = false
  let escaped = false

  for (let index = start + 1; index < content.length; index += 1) {
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
      continue
    }

    if (char === '{') {
      stack.push('}')
      continue
    }

    if (char === '[') {
      stack.push(']')
      continue
    }

    if (char !== '}' && char !== ']') continue
    if (stack.pop() !== char) return undefined

    if (stack.length === 0) {
      return {
        start,
        end: index + 1,
        text: content.slice(start, index + 1),
      }
    }
  }

  return undefined
}

function parseWrappedQwenCall(
  content: string,
  markerStart: number,
  allowPartial: boolean,
  toolDefinitions: Map<string, NormalizedToolDefinition>,
): ParsedQwenCall | undefined {
  const bodyStart = markerStart + TOOL_CALL_START.length
  const jsonBoundary = extractJsonObject(content, bodyStart)
  if (jsonBoundary) {
    const close = findClosingTag(content, jsonBoundary.end)
    if (!close.complete && !allowPartial) {
      return undefined
    }

    if (!close.complete && !close.partialAtEnd) {
      const closeIndex = content.indexOf(TOOL_CALL_END, jsonBoundary.end)
      if (closeIndex !== -1) {
        const end = closeIndex + TOOL_CALL_END.length
        return {
          end,
          rawText: content.slice(markerStart, end),
          malformedReason: 'qwen_hermes_unexpected_content_after_json',
        }
      }

      return allowPartial
        ? {
            end: content.length,
            rawText: content.slice(markerStart),
            malformedReason: 'qwen_hermes_end_tag_missing',
          }
        : undefined
    }

    const end = close.complete ? close.end : content.length
    return {
      end,
      rawText: content.slice(markerStart, end),
      envelope: parseEnvelope(jsonBoundary.text),
    }
  }

  const closeIndex = content.indexOf(TOOL_CALL_END, bodyStart)
  const bodyEnd = closeIndex === -1 ? content.length : closeIndex
  const hasXmlFunction = content.indexOf(FUNCTION_START, bodyStart) !== -1
    && content.indexOf(FUNCTION_START, bodyStart) < bodyEnd
  const xmlWrapper = hasXmlFunction
    ? parseQwenXmlWrapperBody(
        content,
        bodyStart,
        bodyEnd,
        toolDefinitions,
      )
    : undefined
  if (xmlWrapper) {
    if (xmlWrapper.malformedReason) {
      if (closeIndex === -1 && !allowPartial) return undefined
      const end = closeIndex === -1 ? content.length : closeIndex + TOOL_CALL_END.length
      return {
        end,
        rawText: content.slice(markerStart, end),
        malformedReason: xmlWrapper.malformedReason,
      }
    }

    if (xmlWrapper.nextCallStart !== undefined) {
      return {
        end: xmlWrapper.nextCallStart,
        rawText: content.slice(markerStart, xmlWrapper.nextCallStart),
        envelopes: xmlWrapper.envelopes,
      }
    }

    const end = closeIndex === -1
      ? consumeQwenXmlDriftSuffix(content, xmlWrapper.end)
      : closeIndex + TOOL_CALL_END.length
    if (closeIndex === -1 && !allowPartial) return undefined
    return {
      end,
      rawText: content.slice(markerStart, end),
      envelopes: xmlWrapper.envelopes,
    }
  }

  if (closeIndex !== -1) {
    const end = closeIndex + TOOL_CALL_END.length
    return {
      end,
      rawText: content.slice(markerStart, end),
      malformedReason: 'qwen_managed_call_parse_failed',
    }
  }

  return undefined
}

function parseBareQwenXmlCall(
  content: string,
  functionStart: number,
  toolDefinitions: Map<string, NormalizedToolDefinition>,
): ParsedQwenCall | undefined {
  const xmlBoundary = extractQwenXmlFunction(content, functionStart, content.length)
  if (!xmlBoundary) return undefined

  const end = consumeQwenXmlDriftSuffix(content, xmlBoundary.end)
  const nextCall = findNextQwenManagedCallStart(content, end)
  const trailingEnd = nextCall?.index ?? content.length
  if (content.slice(end, trailingEnd).trim()) {
    return {
      end: trailingEnd,
      rawText: content.slice(functionStart, trailingEnd),
      malformedReason: 'qwen_xml_unexpected_suffix_content',
    }
  }
  return {
    end,
    rawText: content.slice(functionStart, end),
    envelope: parseQwenXmlEnvelope(xmlBoundary.text, toolDefinitions),
  }
}

function extractQwenXmlFunction(
  content: string,
  fromIndex: number,
  limit: number,
): QwenXmlFunctionBoundary | undefined {
  const start = content.indexOf(FUNCTION_START, fromIndex)
  if (start === -1 || start >= limit) return undefined
  const nameEnd = content.indexOf('>', start + FUNCTION_START.length)
  if (nameEnd === -1 || nameEnd >= limit) return undefined
  const endTag = content.indexOf(FUNCTION_END, nameEnd + 1)
  if (endTag === -1 || endTag >= limit) return undefined
  const end = endTag + FUNCTION_END.length
  return {
    start,
    end,
    text: content.slice(start, end),
  }
}

/**
 * Parse the XML body of a Hermes envelope without treating arbitrary text as
 * wrapper syntax. Some Qwen responses put parallel functions in one
 * `<tool_call>` block, while the canonical form uses one block per function.
 * Both forms share the same function grammar and are safe to normalize as one
 * atomic batch.
 */
function parseQwenXmlWrapperBody(
  content: string,
  bodyStart: number,
  bodyEnd: number,
  toolDefinitions: Map<string, NormalizedToolDefinition>,
): {
  end: number
  envelopes: ParsedEnvelope[]
  nextCallStart?: number
  malformedReason?: string
} | undefined {
  let cursor = bodyStart
  const envelopes: ParsedEnvelope[] = []

  while (cursor < bodyEnd) {
    while (cursor < bodyEnd && /\s/.test(content[cursor])) cursor += 1
    if (cursor >= bodyEnd) break

    const functionStart = content.indexOf(FUNCTION_START, cursor)
    if (functionStart === cursor) {
      const boundary = extractQwenXmlFunction(content, cursor, bodyEnd)
      if (!boundary) {
        return {
          end: bodyEnd,
          envelopes,
          malformedReason: 'qwen_xml_function_incomplete',
        }
      }

      const envelope = parseQwenXmlEnvelope(boundary.text, toolDefinitions)
      if (!envelope) {
        return {
          end: boundary.end,
          envelopes,
          malformedReason: 'qwen_managed_call_parse_failed',
        }
      }
      envelopes.push(envelope)
      cursor = boundary.end
      continue
    }

    // Qwen can emit adjacent XML calls with a fresh opening delimiter while
    // omitting the previous closing delimiter. A complete function followed
    // immediately by the next opener is an unambiguous call boundary. Leave
    // the opener for the outer parser so a truncated next call still rejects
    // the complete batch atomically.
    if (envelopes.length > 0 && content.startsWith(TOOL_CALL_START, cursor)) {
      return {
        end: cursor,
        envelopes,
        nextCallStart: cursor,
      }
    }

    // Before the first function only an opening invocation wrapper is valid.
    // After a function, known duplicate/closing drift tokens are tolerated.
    const wrapperTags = envelopes.length === 0
      ? [FUNCTION_INVOCATION_START]
      : QWEN_XML_WRAPPER_TAGS
    const wrapperTag = wrapperTags.find(tag => content.startsWith(tag, cursor))
    if (wrapperTag) {
      cursor += wrapperTag.length
      continue
    }

    // Do not scan past prose to find a later function.
    return {
      end: bodyEnd,
      envelopes,
      malformedReason: 'qwen_xml_unexpected_wrapper_content',
    }
  }

  return envelopes.length > 0
    ? { end: cursor, envelopes }
    : undefined
}

function parseQwenXmlEnvelope(
  text: string,
  toolDefinitions: Map<string, NormalizedToolDefinition>,
): ParsedEnvelope | undefined {
  if (!text.startsWith(FUNCTION_START)) return undefined
  const nameEnd = text.indexOf('>', FUNCTION_START.length)
  if (nameEnd === -1) return undefined
  const name = decodeXml(text.slice(FUNCTION_START.length, nameEnd).trim())
  if (!name) return undefined

  const functionEnd = text.lastIndexOf(FUNCTION_END)
  if (functionEnd === -1 || functionEnd < nameEnd) return undefined
  const body = text.slice(nameEnd + 1, functionEnd)
  const tool = toolDefinitions.get(name)
  const args: Record<string, unknown> = {}
  let cursor = 0

  while (cursor < body.length) {
    const parameterStart = body.indexOf(PARAMETER_START, cursor)
    if (parameterStart === -1) {
      if (body.slice(cursor).trim()) return undefined
      break
    }
    if (body.slice(cursor, parameterStart).trim()) return undefined

    const parameterNameEnd = body.indexOf('>', parameterStart + PARAMETER_START.length)
    if (parameterNameEnd === -1) return undefined
    const parameterName = decodeXml(
      body.slice(parameterStart + PARAMETER_START.length, parameterNameEnd).trim(),
    )
    if (!parameterName) return undefined

    const parameterEnd = body.indexOf(PARAMETER_END, parameterNameEnd + 1)
    if (parameterEnd === -1) return undefined
    const value = unwrapQwenXmlParameterText(
      body.slice(parameterNameEnd + 1, parameterEnd),
    )
    const parameterSchema = qwenXmlParameterSchema(tool, parameterName)
    addParameter(
      args,
      parameterName,
      schemaAcceptsQwenRawString(parameterSchema) ? decodeXml(value) : parseJsonValue(value),
    )
    cursor = parameterEnd + PARAMETER_END.length
  }

  return { name, arguments: args }
}

function unwrapQwenXmlParameterText(value: string): string {
  let result = value
  if (result.startsWith('\r\n')) result = result.slice(2)
  else if (result.startsWith('\n')) result = result.slice(1)

  if (result.endsWith('\r\n')) result = result.slice(0, -2)
  else if (result.endsWith('\n')) result = result.slice(0, -1)
  return result
}

function qwenXmlParameterSchema(
  tool: NormalizedToolDefinition | undefined,
  parameterName: string,
): unknown {
  if (!isObjectRecord(tool?.parameters)) return undefined
  const properties = tool.parameters.properties
  return isObjectRecord(properties) ? properties[parameterName] : undefined
}

function schemaAcceptsQwenRawString(schema: unknown): boolean {
  if (!isObjectRecord(schema)) return false
  if (schema.type === 'string') return true
  if (Array.isArray(schema.type) && schema.type.includes('string')) return true
  if (typeof schema.const === 'string') return true
  if (Array.isArray(schema.enum) && schema.enum.some(value => typeof value === 'string')) return true
  return ['anyOf', 'oneOf'].some((key) => (
    Array.isArray(schema[key]) && schema[key].some(schemaAcceptsQwenRawString)
  ))
}

function consumeQwenXmlDriftSuffix(content: string, fromIndex: number): number {
  let cursor = fromIndex
  const driftClosers = [FUNCTION_END, FUNCTION_INVOCATION_END, TOOL_CALL_END]
  while (cursor < content.length) {
    while (cursor < content.length && /\s/.test(content[cursor])) cursor += 1
    const closer = driftClosers.find(tag => content.startsWith(tag, cursor))
    if (!closer) break
    cursor += closer.length
  }
  return cursor
}

function findNextQwenManagedCallStart(
  content: string,
  fromIndex: number,
): QwenManagedCallStart | undefined {
  const wrapped = content.indexOf(TOOL_CALL_START, fromIndex)
  const bare = findNextBareFunctionStart(content, fromIndex)
  if (wrapped === -1 && bare === -1) return undefined
  if (wrapped !== -1 && (bare === -1 || wrapped <= bare)) {
    return { index: wrapped, kind: 'hermes_json_or_xml' }
  }
  return { index: bare, kind: 'bare_xml' }
}

function findNextBareFunctionStart(content: string, fromIndex: number): number {
  let searchIndex = fromIndex
  while (searchIndex < content.length) {
    const index = content.indexOf(FUNCTION_START, searchIndex)
    if (index === -1) return -1
    const lineStart = content.lastIndexOf('\n', index - 1) + 1
    const indentation = content.slice(lineStart, index)
    if (/^ {0,3}$/.test(indentation)) return index
    searchIndex = index + FUNCTION_START.length
  }
  return -1
}

function detectQwenManagedStart(buffer: string) {
  const wrapped = detectMarkers(buffer, [TOOL_CALL_START])
  const completeBare = findNextBareFunctionStart(buffer, 0)
  if (completeBare !== -1) {
    if (wrapped.markerStart === undefined || completeBare < wrapped.markerStart) {
      return { matched: true, partial: false, markerStart: completeBare }
    }
  }

  const partialBare = detectTrailingBareFunctionPrefix(buffer)
  if (wrapped.markerStart === undefined) {
    return partialBare ?? wrapped
  }
  if (partialBare?.markerStart !== undefined && partialBare.markerStart < wrapped.markerStart) {
    return partialBare
  }
  return wrapped
}

function detectTrailingBareFunctionPrefix(buffer: string): {
  matched: false
  partial: true
  markerStart: number
} | undefined {
  const maxLength = Math.min(buffer.length, FUNCTION_START.length - 1)
  for (let length = maxLength; length > 0; length -= 1) {
    const index = buffer.length - length
    if (!FUNCTION_START.startsWith(buffer.slice(index))) continue
    const lineStart = buffer.lastIndexOf('\n', index - 1) + 1
    if (/^ {0,3}$/.test(buffer.slice(lineStart, index))) {
      return { matched: false, partial: true, markerStart: index }
    }
  }
  return undefined
}

function findClosingTag(content: string, fromIndex: number): {
  complete: boolean
  partialAtEnd: boolean
  end: number
} {
  let index = fromIndex
  while (index < content.length && /\s/.test(content[index])) index += 1

  if (content.startsWith(TOOL_CALL_END, index)) {
    return {
      complete: true,
      partialAtEnd: false,
      end: index + TOOL_CALL_END.length,
    }
  }

  const remainder = content.slice(index)
  return {
    complete: false,
    partialAtEnd: remainder.length === 0 || TOOL_CALL_END.startsWith(remainder),
    end: content.length,
  }
}

function findNextCallStart(content: string, fromIndex: number): number {
  const index = content.indexOf(TOOL_CALL_START, fromIndex)
  return index === -1 ? content.length : index
}

function parseEnvelope(jsonText: string): ParsedEnvelope | undefined {
  let value: unknown
  try {
    value = JSON.parse(jsonText)
  } catch {
    return undefined
  }

  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const record = value as Record<string, unknown>
  if (typeof record.name !== 'string' || !record.name.trim()) return undefined
  if (!Object.prototype.hasOwnProperty.call(record, 'arguments')) return undefined
  const normalizedArguments = normalizeEnvelopeArguments(record.arguments)
  if (!normalizedArguments) return undefined

  return {
    name: record.name.trim(),
    arguments: normalizedArguments,
  }
}

function normalizeEnvelopeArguments(value: unknown): Record<string, unknown> | undefined {
  let candidate = value
  if (typeof candidate === 'string') {
    const trimmed = candidate.trim()
    if (!trimmed) return undefined

    try {
      candidate = JSON.parse(trimmed)
    } catch {
      return undefined
    }
  }

  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return undefined
  return candidate as Record<string, unknown>
}

function parseHistoryArguments(argumentsJson: string): unknown {
  const trimmed = argumentsJson.trim()
  if (!trimmed) return {}

  try {
    return JSON.parse(trimmed)
  } catch {
    return argumentsJson
  }
}

function formatQwenXmlFunctionCall(name: string, args: unknown): string {
  const parameters = isObjectRecord(args)
    ? Object.entries(args).map(([parameterName, value]) => [
        `${PARAMETER_START}${escapeXmlAttribute(parameterName)}>`,
        serializeQwenXmlParameterValue(value),
        PARAMETER_END,
      ].join('\n'))
    : []

  return [
    TOOL_CALL_START,
    `${FUNCTION_START}${escapeXmlAttribute(name)}>`,
    ...parameters,
    FUNCTION_END,
    TOOL_CALL_END,
  ].join('\n')
}

function serializeQwenXmlParameterValue(value: unknown): string {
  if (value !== null && typeof value === 'object') {
    return JSON.stringify(value)
      .replace(/</g, '\\u003c')
      .replace(/>/g, '\\u003e')
  }
  return escapeXmlAttribute(String(value))
}

function formatToolResponse(result: NormalizedToolResult): string {
  return `${TOOL_RESPONSE_START}\n${escapeHermesTextBoundaries(result.content)}\n${TOOL_RESPONSE_END}`
}

function serializeHermesJson(value: unknown): string {
  return escapeHermesJsonBoundaries(JSON.stringify(value))
}

function escapeHermesJsonBoundaries(content: string): string {
  return content.replace(/<\/?(?:tools|tool_call|tool_response)>/gi, boundary => (
    boundary.replace('<', '\\u003c').replace('>', '\\u003e')
  ))
}

function escapeHermesTextBoundaries(content: string): string {
  return content.replace(/<\/?(?:tools|tool_call|tool_response)>/gi, boundary => (
    boundary.replace('<', '&lt;').replace('>', '&gt;')
  ))
}
