import type { ToolProtocolAdapter } from './base.ts'
import type { NormalizedToolDefinition, ToolParseContext } from '../types.ts'
import {
  addParameter,
  buildToolCall,
  createParseResult,
  detectMarkers,
  escapeXmlAttribute,
  getMissingRequiredArguments,
  parseJsonValue,
  renderToolList,
  stripFencedCodeBlocks,
  toolNames,
} from './shared.ts'

const CHAT2API_START = '<|CHAT2API|tool_calls>'
const CHAT2API_END = '</|CHAT2API|tool_calls>'
const XML_START = '<tool_calls>'
const XML_END = '</tool_calls>'
const LOOSE_XML_START = '<|tool_calls>'
const LOOSE_XML_END = '</|tool_calls>'
const QCML_START = '<\uFF5CQCML\uFF5Ctool_calls>'
const QCML_END = '</\uFF5CQCML\uFF5Ctool_calls>'
const TOOL_RESULT_DATA_PREFIX = 'Tool execution result data (already executed by the client):'

interface XmlSyntax {
  startMarkers: string[]
  endMarkers: string[]
  blockPattern: RegExp
  invokePattern: RegExp
  parameterOpenPattern: RegExp
  invokeCloseTags: string[]
  parameterCloseTags: string[]
}

const MANAGED_XML_SYNTAX: XmlSyntax = {
  startMarkers: [CHAT2API_START, XML_START, LOOSE_XML_START, QCML_START],
  endMarkers: [CHAT2API_END, XML_END, LOOSE_XML_END, QCML_END],
  blockPattern: /(?:<\|CHAT2API\|tool_calls>|<\uFF5CQCML\uFF5Ctool_calls>|<tool_calls>|<\|tool_calls>)([\s\S]*?)(?:<\/\|CHAT2API\|tool_calls>|<\/\uFF5CQCML\uFF5Ctool_calls>|<\/tool_calls>|<\/\|tool_calls>)/g,
  invokePattern: /(?:<\|CHAT2API\|invoke\s+name=["']([^"']+)["'](?:\s+tool_call_id=["'][^"']+["'])?\s*>|<\uFF5CQCML\uFF5Cinvoke\s+name=["']([^"']+)["'](?:\s+tool_call_id=["'][^"']+["'])?\s*>|<invoke\s+name=["']([^"']+)["'](?:\s+tool_call_id=["'][^"']+["'])?\s*>|<\|?tool_call\s+name=["']([^"']+)["'](?:\s+tool_call_id=["'][^"']+["'])?\s*>|<\|?tool_call_id=["']([^"']+)["']\s*>)/g,
  parameterOpenPattern: /(?:<\|CHAT2API\|parameter\s+name=["']([^"']+)["']\s*>|<\uFF5CQCML\uFF5Cparameter\s+name=["']([^"']+)["']\s*>|<parameter\s+name=["']([^"']+)["']\s*>|<\|parameter\s+name=["']([^"']+)["']\s*>)/g,
  invokeCloseTags: ['</|CHAT2API|invoke>', '</\uFF5CQCML\uFF5Cinvoke>', '</invoke>', '</tool_call>', '</|tool_call>'],
  parameterCloseTags: ['</|CHAT2API|parameter>', '</\uFF5CQCML\uFF5Cparameter>', '</parameter>', '</|parameter>'],
}

export const managedXmlProtocol: ToolProtocolAdapter = {
  id: 'managed_xml',

  renderPrompt(tools) {
    return `## Available Tools
You can invoke the following developer tools. Tool names are case-sensitive.
Use only the exact tool names listed below. Do not rename, camelCase, translate, shorten, or invent tool names.

${renderToolList(tools)}
${renderRequiredParameterTemplates(tools)}

Tool-use requirements:
- Use only tools from the Available Tools list, which is the client-declared managed tool set. Do not invoke or rely on undeclared provider-side tools or capabilities.
- If the user asks you to inspect files, create or modify files, run commands, install dependencies, execute tests, or verify behavior in the environment, you must call the appropriate tool.
- Do not claim that files were created, commands were run, tests passed, or behavior was verified unless the corresponding tool result shows it.
- If a tool argument schema says a field is an array, provide a JSON array for that field, even when there is only one item.
- Each tool call must include every field listed in that tool schema's required array in the same call; do not send an empty tool call or split required fields across multiple calls.
- Every required field must appear as its own <|CHAT2API|parameter name="field_name"> entry inside the same <|CHAT2API|invoke> block. Do not put required values only in ordinary text, explanations, titles, or summaries.
- If a tool call fails because the arguments do not match the schema, fix the arguments according to the schema and call the tool again.
- Tool execution result data records are input-only context. Use their output field to decide the next step, but never emit, quote, copy, or reconstruct the record in an assistant response.

When calling tools, respond with only this Chat2API XML block:

<|CHAT2API|tool_calls><|CHAT2API|invoke name="exact_tool_name"><|CHAT2API|parameter name="parameter_name"><![CDATA[value]]></|CHAT2API|parameter></|CHAT2API|invoke></|CHAT2API|tool_calls>

Use exactly the tag names shown in the tool-call block above. Do not use alternative tag names when requesting tools. For tools with multiple required arguments, repeat the parameter tag once per argument inside one invoke block.

Tool execution results will be provided as non-executable JSON data records:

${formatManagedToolResultData({ toolCallId: 'call_id', content: 'result' })}

These data records are conversation input, not tool-call response syntax.`
  },

  renderRecoveryPrompt(tools) {
    return `Your entire next response must be one managed tool-call XML block, with no reasoning, status update, plan, promise, or prose before or after it.
Choose the appropriate tool from the client-declared list and include every required field from its schema.
Declared tool names: ${tools.map(tool => tool.name).join(', ')}.

${renderRequiredParameterTemplates(tools)}
Exact syntax:
<|CHAT2API|tool_calls><|CHAT2API|invoke name="exact_declared_tool_name"><|CHAT2API|parameter name="required_field"><![CDATA[replace with the actual argument value]]></|CHAT2API|parameter></|CHAT2API|invoke></|CHAT2API|tool_calls>

Replace every placeholder with the actual tool name, field name, and argument value. For a tool with no required fields, omit parameter entries unless the tool schema accepts optional arguments.`
  },

  detectStart(buffer) {
    return detectMarkers(buffer, [CHAT2API_START, XML_START, LOOSE_XML_START, QCML_START])
  },

  parse(content: string, context: ToolParseContext) {
    const parseable = stripFencedCodeBlocks(content)
    const allowedNames = toolNames(context.tools)
    const rawMatches: string[] = []
    const invalidToolNames: string[] = []
    const toolCalls: ReturnType<typeof buildToolCall>[] = []
    const toolDefinitions = new Map(context.tools.map((tool) => [tool.name, tool]))

    parseBlocks(parseable, {
      syntax: MANAGED_XML_SYNTAX,
      rawMatches,
      invalidToolNames,
      allowedNames,
      toolDefinitions,
      toolCalls,
    })

    if (toolCalls.length === 0 && context.allowPartial) {
      parsePartialBlocks(parseable, {
        syntax: MANAGED_XML_SYNTAX,
        rawMatches,
        invalidToolNames,
        allowedNames,
        toolDefinitions,
        toolCalls,
      })
    }

    if (toolCalls.length === 0) {
      const cleanContent = rawMatches.length > 0
        ? rawMatches.reduce((acc, raw) => acc.replace(raw, ''), parseable).trim()
        : content
      return createParseResult({
        content: cleanContent,
        toolCalls,
        protocol: rawMatches.length > 0 ? 'managed_xml' : 'unknown',
        rawMatches,
        invalidToolNames,
      })
    }

    const cleanContent = rawMatches.reduce((acc, raw) => acc.replace(raw, ''), parseable).trim()
    return createParseResult({
      content: cleanContent,
      toolCalls,
      protocol: 'managed_xml',
      rawMatches,
      invalidToolNames,
    })
  },

  formatAssistantToolCalls(calls) {
    const invokes = calls.map((call) => {
      const args = safeParseObject(call.arguments)
      const params = Object.entries(args)
        .map(([name, value]) => {
          const text = typeof value === 'string' ? value : JSON.stringify(value)
          return `<|CHAT2API|parameter name="${escapeXmlAttribute(name)}"><![CDATA[${text}]]></|CHAT2API|parameter>`
        })
        .join('')
      return `<|CHAT2API|invoke name="${escapeXmlAttribute(call.name)}" tool_call_id="${escapeXmlAttribute(call.id)}">${params}</|CHAT2API|invoke>`
    })
    return `${CHAT2API_START}${invokes.join('')}${CHAT2API_END}`
  },

  formatToolResult(result) {
    return formatManagedToolResultData(result)
  },
}

function formatManagedToolResultData(result: {
  toolCallId: string
  content: string
  isError?: boolean
}): string {
  const data = JSON.stringify({
    call_id: result.toolCallId,
    status: result.isError ? 'error' : 'success',
    output: result.content,
  })
    .replace(/&/g, '\\u0026')
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029')

  return `${TOOL_RESULT_DATA_PREFIX} ${data}`
}

function renderRequiredParameterTemplates(tools: NormalizedToolDefinition[]): string {
  const templates = tools
    .map((tool) => {
      const requiredFields = getRequiredFields(tool.parameters)
      if (requiredFields.length === 0) return undefined

      const parameters = requiredFields
        .map((field) => `<|CHAT2API|parameter name="${escapeXmlAttribute(field)}"><![CDATA[${renderParameterPlaceholder(tool.parameters, field)}]]></|CHAT2API|parameter>`)
        .join('')
      return `Tool \`${tool.name}\`:\n<|CHAT2API|tool_calls><|CHAT2API|invoke name="${escapeXmlAttribute(tool.name)}">${parameters}</|CHAT2API|invoke></|CHAT2API|tool_calls>`
    })
    .filter((template): template is string => Boolean(template))

  if (templates.length === 0) return ''

  return `Required-parameter XML templates. When invoking one of these tools, keep every shown parameter tag and replace each placeholder with the actual argument value:\n${templates.join('\n')}\n`
}

function getRequiredFields(schema: unknown): string[] {
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) return []

  const required = (schema as Record<string, unknown>).required
  return Array.isArray(required) ? required.filter((field): field is string => typeof field === 'string') : []
}

function renderParameterPlaceholder(parameters: unknown, field: string): string {
  const schema = getSchemaObjectProperties(parameters)?.[field]
  return renderSchemaPlaceholder(schema, field)
}

function renderSchemaPlaceholder(schema: unknown, name: string): string {
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) return `...${name}...`

  const schemaObject = schema as Record<string, unknown>
  if (schemaTypeIncludes(schemaObject, 'array') || schemaObject.items) {
    return `[${renderSchemaPlaceholder(schemaObject.items, singularizeName(name))}]`
  }

  if (schemaTypeIncludes(schemaObject, 'object') || getSchemaObjectProperties(schemaObject)) {
    const properties = getSchemaObjectProperties(schemaObject) ?? {}
    const fields = getRequiredFields(schemaObject)
    const selectedFields = fields.length > 0 ? fields : Object.keys(properties).slice(0, 3)
    const entries = selectedFields.map((field) => `"${field}":${JSON.stringify(renderSchemaPlaceholder(properties[field], field))}`)
    return `{${entries.join(',')}}`
  }

  if (schemaTypeIncludes(schemaObject, 'number') || schemaTypeIncludes(schemaObject, 'integer')) return '0'
  if (schemaTypeIncludes(schemaObject, 'boolean')) return 'true'

  return `...${name}...`
}

function getSchemaObjectProperties(schema: unknown): Record<string, unknown> | undefined {
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) return undefined

  const properties = (schema as Record<string, unknown>).properties
  return properties && typeof properties === 'object' && !Array.isArray(properties)
    ? properties as Record<string, unknown>
    : undefined
}

function schemaTypeIncludes(schema: Record<string, unknown>, type: string): boolean {
  const schemaType = schema.type
  return schemaType === type || (Array.isArray(schemaType) && schemaType.includes(type))
}

function singularizeName(name: string): string {
  return name.endsWith('s') && name.length > 1 ? name.slice(0, -1) : name
}

interface ParseBlockOptions {
  syntax: XmlSyntax
  rawMatches: string[]
  invalidToolNames: string[]
  allowedNames: Set<string>
  toolDefinitions: Map<string, NormalizedToolDefinition>
  toolCalls: ReturnType<typeof buildToolCall>[]
}

function parseBlocks(content: string, options: ParseBlockOptions): void {
  let blockMatch: RegExpExecArray | null
  options.syntax.blockPattern.lastIndex = 0

  while ((blockMatch = options.syntax.blockPattern.exec(content)) !== null) {
    options.rawMatches.push(blockMatch[0])
    parseInvokes(blockMatch[1], {
      ...options,
      allowPartialInvoke: false,
    })
  }
}

function parsePartialBlocks(content: string, options: ParseBlockOptions): void {
  let searchIndex = 0

  while (searchIndex < content.length) {
    const start = findNextMarker(content, options.syntax.startMarkers, searchIndex)
    if (!start) return

    const innerStart = start.index + start.marker.length
    const end = findNextMarker(content, options.syntax.endMarkers, innerStart)
    const rawEnd = end ? end.index + end.marker.length : content.length
    const innerEnd = end ? end.index : content.length
    const rawMatch = content.slice(start.index, rawEnd)
    const blockInner = content.slice(innerStart, innerEnd)

    if (!options.rawMatches.includes(rawMatch)) {
      options.rawMatches.push(rawMatch)
    }

    parseInvokes(blockInner, {
      ...options,
      allowPartialInvoke: true,
    })

    searchIndex = Math.max(rawEnd, start.index + start.marker.length)
  }
}

interface ParseInvokeOptions extends ParseBlockOptions {
  allowPartialInvoke: boolean
}

function parseInvokes(content: string, options: ParseInvokeOptions): void {
  const invokes = collectMatches(options.syntax.invokePattern, content)

  for (let index = 0; index < invokes.length; index += 1) {
    const invokeMatch = invokes[index]
    const name = getCapturedName(invokeMatch)
    if (!options.allowedNames.has(name)) {
      options.invalidToolNames.push(name)
      continue
    }

    const bodyStart = invokeMatch.index + invokeMatch[0].length
    const nextInvokeIndex = invokes[index + 1]?.index ?? content.length
    const close = findNextMarker(content, options.syntax.invokeCloseTags, bodyStart, nextInvokeIndex)
    const bodyEnd = close ? close.index : nextInvokeIndex
    const body = content.slice(bodyStart, bodyEnd)
    const parsedArgs = parseArguments(
      body,
      options.syntax,
      options.allowPartialInvoke,
      options.toolDefinitions.get(name),
    )

    if (!close) {
      if (!options.allowPartialInvoke || !parsedArgs.hadArgumentContent) {
        continue
      }
    }

    const rawEnd = close ? close.index + close.marker.length : bodyEnd
    const rawText = content.slice(invokeMatch.index, rawEnd)
    const tool = options.toolDefinitions.get(name)
    if (getMissingRequiredArguments(parsedArgs.args, tool).length > 0) {
      continue
    }

    options.toolCalls.push(
      buildToolCall(
        `call_${options.toolCalls.length}`,
        options.toolCalls.length,
        name,
        JSON.stringify(parsedArgs.args),
        rawText,
        tool,
      ),
    )
  }
}

function collectMatches(pattern: RegExp, content: string): RegExpExecArray[] {
  const matches: RegExpExecArray[] = []
  let match: RegExpExecArray | null
  pattern.lastIndex = 0

  while ((match = pattern.exec(content)) !== null) {
    matches.push(match)
  }

  return matches
}

function parseArguments(
  body: string,
  syntax: XmlSyntax,
  allowPartial: boolean,
  tool?: NormalizedToolDefinition,
): { args: Record<string, unknown>; hadArgumentContent: boolean } {
  const args: Record<string, unknown> = {}
  const parameters = collectMatches(syntax.parameterOpenPattern, body)
  let parameterCount = 0

  for (let index = 0; index < parameters.length; index += 1) {
    const parameterMatch = parameters[index]
    const name = getCapturedName(parameterMatch)
    const valueStart = parameterMatch.index + parameterMatch[0].length
    const nextParameterIndex = parameters[index + 1]?.index ?? body.length
    const close = findNextMarker(body, syntax.parameterCloseTags, valueStart, nextParameterIndex)

    if (close) {
      addParsedParameter(args, name, parseJsonValue(body.slice(valueStart, close.index)), tool)
      parameterCount += 1
      continue
    }

    if (allowPartial) {
      const partialValue = extractCompletePartialValue(body.slice(valueStart, nextParameterIndex))
      if (partialValue !== undefined) {
        addParsedParameter(args, name, parseJsonValue(partialValue), tool)
        parameterCount += 1
      }
    }
  }

  if (parameterCount > 0) {
    return { args, hadArgumentContent: true }
  }

  const bodyArgs = parseObjectBodyArgument(body)
  if (bodyArgs) {
    return { args: bodyArgs, hadArgumentContent: true }
  }

  return { args, hadArgumentContent: false }
}

function addParsedParameter(
  args: Record<string, unknown>,
  name: string,
  value: unknown,
  tool?: NormalizedToolDefinition,
): void {
  const unwrappedValue = unwrapRedundantNamedArgument(name, value, tool)
  if (unwrappedValue !== value) {
    addParameter(args, name, unwrappedValue)
    return
  }

  if (shouldFlattenWrapperArgument(name, value, tool)) {
    for (const [key, nestedValue] of Object.entries(value as Record<string, unknown>)) {
      addParameter(args, key, nestedValue)
    }
    return
  }

  addParameter(args, name, value)
}

function unwrapRedundantNamedArgument(
  name: string,
  value: unknown,
  tool?: NormalizedToolDefinition,
): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value

  const entries = Object.entries(value as Record<string, unknown>)
  if (entries.length !== 1 || entries[0][0] !== name) return value

  const properties = getSchemaProperties(tool)
  if (!properties.has(name)) return value

  return entries[0][1]
}

function shouldFlattenWrapperArgument(
  name: string,
  value: unknown,
  tool?: NormalizedToolDefinition,
): boolean {
  if (name !== 'argument' && name !== 'arguments') return false
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false

  const properties = getSchemaProperties(tool)
  if (properties.has(name)) return false
  return true
}

function getSchemaProperties(tool?: NormalizedToolDefinition): Set<string> {
  const parameters = tool?.parameters
  if (!parameters || typeof parameters !== 'object' || Array.isArray(parameters)) return new Set()

  const properties = (parameters as Record<string, unknown>).properties
  if (!properties || typeof properties !== 'object' || Array.isArray(properties)) return new Set()

  return new Set(Object.keys(properties))
}

function findNextMarker(
  content: string,
  markers: string[],
  fromIndex: number,
  beforeIndex: number = content.length,
): { index: number; marker: string } | undefined {
  let selected: { index: number; marker: string } | undefined

  for (const marker of markers) {
    const index = content.indexOf(marker, fromIndex)
    if (index === -1 || index >= beforeIndex) continue
    if (!selected || index < selected.index) {
      selected = { index, marker }
    }
  }

  return selected
}

function getCapturedName(match: RegExpExecArray): string {
  const captures = match.slice(1)
  for (let index = captures.length - 1; index >= 0; index -= 1) {
    const value = captures[index]
    if (typeof value === 'string' && value.trim() && value !== '"' && value !== "'") {
      return value.trim()
    }
  }
  return ''
}

function extractCompletePartialValue(value: string): string | undefined {
  const trimmed = value.trim()
  if (!trimmed) return undefined

  const cdataEnd = trimmed.indexOf(']]>')
  if (trimmed.startsWith('<![CDATA[') && cdataEnd !== -1) {
    return trimmed.slice(0, cdataEnd + 3)
  }

  if (isCompleteJsonValue(trimmed)) {
    return trimmed
  }

  return undefined
}

function isCompleteJsonValue(value: string): boolean {
  if (!/^[\[{"\-0-9tfn]/.test(value)) return false

  try {
    JSON.parse(value)
    return true
  } catch {
    return false
  }
}

function parseObjectBodyArgument(body: string): Record<string, unknown> | undefined {
  const parsed = parseJsonValue(body)
  return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
    ? parsed as Record<string, unknown>
    : undefined
}

function safeParseObject(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
  } catch {
    return {}
  }
}
