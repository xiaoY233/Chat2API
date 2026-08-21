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

  let partialStart = -1
  for (const marker of markers) {
    const maxPrefixLength = Math.min(buffer.length, marker.length - 1)
    for (let length = maxPrefixLength; length > 0; length -= 1) {
      const index = buffer.length - length
      if (marker.startsWith(buffer.slice(index))) {
        if (partialStart === -1 || index < partialStart) {
          partialStart = index
        }
        break
      }
    }
  }

  return partialStart === -1
    ? { matched: false, partial: false }
    : { matched: false, partial: true, markerStart: partialStart }
}

export function stripFencedCodeBlocks(content: string): string {
  return content.replace(/```[\s\S]*?(?:```|$)/g, '')
}

export function toolNames(tools: NormalizedToolDefinition[]): Set<string> {
  return new Set(tools.map((tool) => tool.name))
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
  args: unknown,
  rawText?: string,
  tool?: NormalizedToolDefinition,
): ToolCall {
  return {
    id,
    index,
    type: 'function',
    function: {
      name,
      arguments: normalizeArguments(args, tool),
    },
    ...(rawText ? { rawText } : {}),
  } as ToolCall
}

export function normalizeArguments(args: unknown, tool?: NormalizedToolDefinition): string {
  if (typeof args === 'string') {
    const trimmed = args.trim()
    if (!trimmed) return '{}'
    try {
      return JSON.stringify(normalizeArgumentsForSchema(JSON.parse(trimmed), tool))
    } catch {
      const recovered = recoverJsonValueFromMalformedSnapshots(trimmed)
      if (recovered !== undefined) {
        return JSON.stringify(normalizeArgumentsForSchema(recovered, tool))
      }
      return trimmed
    }
  }

  return JSON.stringify(normalizeArgumentsForSchema(args === undefined ? {} : args, tool))
}

export interface ToolArgumentValidationIssues {
  missingRequired: string[]
  unexpected: string[]
  typeMismatches: string[]
  valueMismatches?: string[]
}

/**
 * Validate the parts of a tool schema that must hold before a provider-native
 * call is exposed to the client.  This intentionally does not attempt to be
 * a complete JSON-Schema validator: type coercion remains owned by
 * normalizeArgumentsForSchema(), while this check catches structural errors
 * that downstream tool validators cannot recover from after execution.
 */
export function getToolArgumentValidationIssues(
  args: unknown,
  tool?: NormalizedToolDefinition,
): ToolArgumentValidationIssues {
  if (!tool) return { missingRequired: [], unexpected: [], typeMismatches: [] }

  const parsed = parseArgumentCandidate(args)
  if (!parsed.ok) return { missingRequired: [], unexpected: [], typeMismatches: [] }

  const normalized = normalizeArgumentsForSchema(
    parsed.value === undefined ? {} : parsed.value,
    tool,
  )
  const issues = collectSchemaValidationIssues(normalized, tool.parameters)
  return {
    missingRequired: issues.missingRequired,
    unexpected: issues.unexpected,
    typeMismatches: issues.typeMismatches,
    ...(issues.valueMismatches.length > 0 ? { valueMismatches: issues.valueMismatches } : {}),
  }
}

export function hasToolArgumentValidationIssues(
  args: unknown,
  tool?: NormalizedToolDefinition,
): boolean {
  const issues = getToolArgumentValidationIssues(args, tool)
  return issues.missingRequired.length > 0
    || issues.unexpected.length > 0
    || issues.typeMismatches.length > 0
    || (issues.valueMismatches?.length ?? 0) > 0
}

export function getMissingRequiredArguments(args: unknown, tool?: NormalizedToolDefinition): string[] {
  return getToolArgumentValidationIssues(args, tool).missingRequired
}

export function parseJsonValue(value: string): unknown {
  const trimmed = unwrapCdata(value).trim()
  if (!trimmed) return ''

  try {
    return JSON.parse(trimmed)
  } catch {
    const recovered = recoverJsonValueFromMalformedSnapshots(trimmed)
    if (recovered !== undefined) {
      return recovered
    }
    return decodeXml(trimmed)
  }
}

function recoverJsonValueFromMalformedSnapshots(value: string): unknown | undefined {
  const trimmed = decodeXml(unwrapCdata(value)).trim()
  if (!trimmed || !/^[\[{]/.test(trimmed)) return undefined

  const candidates: Array<{ index: number; value: unknown }> = []
  for (let index = 0; index < trimmed.length; index += 1) {
    const char = trimmed[index]
    if (char !== '{' && char !== '[') continue

    const jsonText = extractBalancedJson(trimmed, index)
    if (!jsonText) continue

    try {
      candidates.push({ index, value: JSON.parse(jsonText) })
    } catch {
      // Keep scanning later positions; repeated snapshots may become valid there.
    }
  }

  if (candidates.length === 0) return undefined

  const candidate = candidates[candidates.length - 1]
  if (candidate.index === 0) return undefined

  if (hasRepeatedSnapshotPrefix(trimmed.slice(0, candidate.index), candidate.value)) {
    return candidate.value
  }

  return undefined
}

function extractBalancedJson(value: string, start: number): string | undefined {
  const opener = value[start]
  const closer = opener === '{' ? '}' : ']'
  const stack: string[] = [closer]
  let inString = false
  let escaped = false

  for (let index = start + 1; index < value.length; index += 1) {
    const char = value[index]

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

    if (char === '}' || char === ']') {
      if (stack.pop() !== char) {
        return undefined
      }

      if (stack.length === 0) {
        return value.slice(start, index + 1)
      }
    }
  }

  return undefined
}

function hasRepeatedSnapshotPrefix(prefix: string, value: unknown): boolean {
  if (Array.isArray(value)) {
    return prefix.trimStart().startsWith('[')
  }

  if (!value || typeof value !== 'object') {
    return false
  }

  const keys = Object.keys(value as Record<string, unknown>)
  return keys.some((key) => prefix.includes(JSON.stringify(key)))
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

export function normalizeArgumentsForSchema(
  value: unknown,
  tool?: NormalizedToolDefinition,
): unknown {
  return normalizeValueForSchema(value, tool?.parameters)
}

function normalizeValueForSchema(value: unknown, schema: unknown): unknown {
  if (!isPlainObject(schema)) return normalizeUntypedValue(value)

  let normalized = normalizeDirectValueForSchema(value, schema)

  // allOf adds constraints; each branch must be applied to the same value.
  for (const branch of getSchemaArray(schema, 'allOf')) {
    normalized = normalizeValueForSchema(normalized, branch)
  }

  // oneOf/anyOf are alternatives. Select one complete branch instead of
  // mixing array handling from one branch with object/scalar rules from another.
  for (const key of ['oneOf', 'anyOf'] as const) {
    const branches = getSchemaArray(schema, key)
    if (branches.length > 0) {
      normalized = normalizeBestSchemaVariant(normalized, branches, schema)
    }
  }

  return normalized
}

function normalizeDirectValueForSchema(value: unknown, schema: Record<string, unknown>): unknown {
  const structuredValue = restoreStructuredJsonValue(value, schema)
  const expectsArray = schemaExpectsArray(schema)
  const expectsObject = schemaExpectsObject(schema)

  if (Array.isArray(structuredValue) && expectsArray) {
    const itemSchema = getSchemaProperty(schema, 'items')
    return structuredValue.map((item) => normalizeValueForSchema(item, itemSchema))
  }

  if (isPlainObject(structuredValue) && expectsObject) {
    return normalizeObjectProperties(structuredValue, schema)
  }

  if (isPlainObject(structuredValue) && expectsArray && !expectsObject) {
    const itemSchema = getSchemaProperty(schema, 'items')
    return [normalizeValueForSchema(structuredValue, itemSchema)]
  }

  const scalar = normalizeScalarForSchema(structuredValue, [schema])
  if (scalar !== structuredValue) return scalar
  return normalizeUntypedValue(structuredValue)
}

function normalizeUntypedValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => normalizeValueForSchema(item, undefined))
  }
  if (isPlainObject(value)) return normalizeObjectProperties(value, undefined)
  return value
}

function restoreStructuredJsonValue(value: unknown, schema: Record<string, unknown>): unknown {
  if (typeof value !== 'string' || schemaAcceptsStringValue(schema, value)) return value

  const trimmed = value.trim()
  const expectsArray = schemaExpectsArray(schema)
  const expectsObject = schemaExpectsObject(schema)
  const couldBeArray = expectsArray && trimmed.startsWith('[') && trimmed.endsWith(']')
  const couldBeObject = (expectsObject || expectsArray)
    && trimmed.startsWith('{')
    && trimmed.endsWith('}')
  if (!couldBeArray && !couldBeObject) return value

  try {
    const parsed = JSON.parse(trimmed)
    if (Array.isArray(parsed) && expectsArray) return parsed
    if (isPlainObject(parsed) && (expectsObject || expectsArray)) return parsed
  } catch {
    // Only exact JSON is eligible here. Malformed-snapshot recovery belongs to
    // the outer tool-call parser and must not guess nested argument values.
  }
  return value
}

function schemaAcceptsStringValue(schema: Record<string, unknown>, value: string): boolean {
  if (schemaTypeIncludes(schema, 'string')) return true
  if (Object.prototype.hasOwnProperty.call(schema, 'const') && schema.const === value) return true
  const enumValues = Array.isArray(schema.enum) ? schema.enum : []
  return enumValues.some((candidate) => candidate === value)
}

function normalizeBestSchemaVariant(
  value: unknown,
  branches: unknown[],
  parentSchema: Record<string, unknown>,
): unknown {
  const candidates = branches.map((branch, index) => {
    const originalIssues = collectSchemaValidationIssues(value, parentSchema)
    const normalized = normalizeValueForSchema(value, branch)
    const normalizedIssues = collectSchemaValidationIssues(normalized, parentSchema)
    return {
      index,
      normalized,
      issueCount: schemaIssueCount(normalizedIssues),
      originalWasValid: schemaIssueCount(originalIssues) === 0,
      changedKind: jsonValueKind(value) !== jsonValueKind(normalized),
    }
  })

  candidates.sort((left, right) => {
    if (left.issueCount !== right.issueCount) return left.issueCount - right.issueCount
    if (left.originalWasValid !== right.originalWasValid) return left.originalWasValid ? -1 : 1
    if (left.changedKind !== right.changedKind) return left.changedKind ? 1 : -1
    return left.index - right.index
  })
  return candidates[0]?.normalized ?? value
}

function normalizeScalarForSchema(value: unknown, variants: unknown[]): unknown {
  if (value === null) return value

  // Models sometimes emit a structured JSON value for a field declared as a
  // string (for example, a file body). Preserve the value losslessly as JSON
  // so downstream tool validators receive the declared primitive type. Keep
  // object/array schemas ahead of this function so unions that explicitly
  // accept structured values retain their native shape.
  if (typeof value === 'object') {
    if (variants.some((variant) => schemaTypeIncludes(variant, 'string'))) {
      try {
        return JSON.stringify(value)
      } catch {
        return value
      }
    }
    return value
  }

  // Preserve a value when it already matches one of the declared scalar types.
  // This matters for unions such as `string | number`.
  if (variants.some((variant) => schemaAcceptsScalar(variant, value))) return value

  if (variants.some((variant) => schemaTypeIncludes(variant, 'string'))) {
    if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  }

  if (typeof value === 'string') {
    const trimmed = value.trim()
    if (/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(trimmed)) {
      const numericValue = Number(trimmed)
      if (Number.isFinite(numericValue) && variants.some((variant) => {
        if (schemaTypeIncludes(variant, 'integer')) return Number.isInteger(numericValue)
        return schemaTypeIncludes(variant, 'number')
      })) {
        return numericValue
      }
    }

    if (trimmed === 'true' || trimmed === 'false') {
      const booleanValue = trimmed === 'true'
      if (variants.some((variant) => schemaTypeIncludes(variant, 'boolean'))) return booleanValue
    }
  }

  return value
}

function schemaAcceptsScalar(schema: unknown, value: unknown): boolean {
  if (typeof value === 'string') return schemaTypeIncludes(schema, 'string')
  if (typeof value === 'number') {
    return schemaTypeIncludes(schema, 'number') ||
      (schemaTypeIncludes(schema, 'integer') && Number.isInteger(value))
  }
  if (typeof value === 'boolean') return schemaTypeIncludes(schema, 'boolean')
  return false
}

function normalizeObjectProperties(
  value: Record<string, unknown>,
  schema: Record<string, unknown> | undefined,
): Record<string, unknown> {
  const properties = getObjectSchemaProperties(schema)
  const patternProperties = getSchemaProperty(schema, 'patternProperties')
  const additionalProperties = getSchemaProperty(schema, 'additionalProperties')
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => {
      const propertySchema = properties?.[key]
      const patternSchemas = getMatchingPatternSchemas(key, patternProperties)
      let normalized = propertySchema === undefined
        ? item
        : normalizeValueForSchema(item, propertySchema)
      for (const patternSchema of patternSchemas) {
        normalized = normalizeValueForSchema(normalized, patternSchema)
      }
      if (propertySchema === undefined && patternSchemas.length === 0 && isPlainObject(additionalProperties)) {
        normalized = normalizeValueForSchema(normalized, additionalProperties)
      }
      if (propertySchema === undefined && patternSchemas.length === 0 && !isPlainObject(additionalProperties)) {
        normalized = normalizeValueForSchema(normalized, undefined)
      }
      return [key, normalized]
    }),
  )
}

function schemaExpectsArray(schema: unknown): boolean {
  return schemaTypeIncludes(schema, 'array') || Boolean(getSchemaProperty(schema, 'items'))
}

function schemaExpectsObject(schema: unknown): boolean {
  return schemaTypeIncludes(schema, 'object')
    || Boolean(getObjectSchemaProperties(schema))
    || isPlainObject(getSchemaProperty(schema, 'patternProperties'))
    || isPlainObject(getSchemaProperty(schema, 'additionalProperties'))
    || getRequiredFields(schema).length > 0
}

function schemaTypeIncludes(schema: unknown, type: string): boolean {
  const schemaType = getSchemaProperty(schema, 'type')
  return schemaType === type || (Array.isArray(schemaType) && schemaType.includes(type))
}

function getObjectSchemaProperties(schema: unknown): Record<string, unknown> | undefined {
  const properties = getSchemaProperty(schema, 'properties')
  return isPlainObject(properties) ? properties : undefined
}

function getSchemaProperty(schema: unknown, key: string): unknown {
  return isPlainObject(schema) ? schema[key] : undefined
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

export function renderToolList(tools: NormalizedToolDefinition[]): string {
  return tools
    .map((tool) => {
      const parameters = JSON.stringify(tool.parameters ?? {})
      const requiredFields = getRequiredFields(tool.parameters)
      const requiredText = requiredFields.length > 0
        ? ` Required fields that must be provided in the same call: ${requiredFields.map((field) => `\`${field}\``).join(', ')}.`
        : ''
      return `Tool \`${tool.name}\`: ${tool.description || 'No description'}. Arguments JSON schema: ${parameters}.${requiredText}`
    })
    .join('\n')
}

function parseArgumentCandidate(args: unknown): { ok: true; value: unknown } | { ok: false } {
  if (typeof args !== 'string') {
    return { ok: true, value: args }
  }

  const trimmed = args.trim()
  if (!trimmed) return { ok: true, value: {} }

  try {
    return { ok: true, value: JSON.parse(trimmed) }
  } catch {
    const recovered = recoverJsonValueFromMalformedSnapshots(trimmed)
    return recovered === undefined ? { ok: false } : { ok: true, value: recovered }
  }
}

interface SchemaValidationIssueSet {
  missingRequired: string[]
  unexpected: string[]
  typeMismatches: string[]
  valueMismatches: string[]
}

function collectSchemaValidationIssues(
  value: unknown,
  schema: unknown,
  path: string = '',
): SchemaValidationIssueSet {
  if (!isPlainObject(schema)) return emptySchemaValidationIssues()

  let issues = collectDirectSchemaValidationIssues(value, schema, path)
  for (const branch of getSchemaArray(schema, 'allOf')) {
    issues = mergeSchemaValidationIssues(issues, collectSchemaValidationIssues(value, branch, path))
  }

  for (const key of ['oneOf', 'anyOf'] as const) {
    const branches = getSchemaArray(schema, key)
    if (branches.length === 0) continue
    const branchIssues = branches.map((branch) => collectSchemaValidationIssues(value, branch, path))
    const matchingBranches = branchIssues.filter(branch => schemaIssueCount(branch) === 0).length
    if (key === 'oneOf' && matchingBranches > 1) {
      issues.valueMismatches.push(`${displaySchemaPath(path)} (value matches multiple oneOf branches)`)
    } else {
      issues = mergeSchemaValidationIssues(issues, bestSchemaValidationIssues(branchIssues))
    }
  }

  return uniqueSchemaValidationIssues(issues)
}

function collectDirectSchemaValidationIssues(
  value: unknown,
  schema: Record<string, unknown>,
  path: string,
): SchemaValidationIssueSet {
  let issues = emptySchemaValidationIssues()
  const expectedTypes = expectedSchemaTypes(schema)
  const actualType = jsonValueKind(value)
  if (expectedTypes.length > 0 && !expectedTypes.some((type) => valueMatchesSchemaType(value, type))) {
    issues.typeMismatches.push(
      `${displaySchemaPath(path)} (expected ${expectedTypes.join(' or ')}, received ${actualType})`,
    )
  }

  if (Object.prototype.hasOwnProperty.call(schema, 'const') && !jsonValuesEqual(value, schema.const)) {
    issues.valueMismatches.push(`${displaySchemaPath(path)} (value does not match const)`)
  }
  if (Array.isArray(schema.enum) && !schema.enum.some((candidate) => jsonValuesEqual(value, candidate))) {
    issues.valueMismatches.push(`${displaySchemaPath(path)} (value is not in enum)`)
  }
  issues.valueMismatches.push(...collectSchemaConstraintIssues(value, schema, path))

  if (Array.isArray(value)) {
    const itemSchema = getSchemaProperty(schema, 'items')
    if (itemSchema !== undefined) {
      for (let index = 0; index < value.length; index += 1) {
        issues = mergeSchemaValidationIssues(
          issues,
          collectSchemaValidationIssues(value[index], itemSchema, `${path}[${index}]`),
        )
      }
    }
    return issues
  }

  if (!isPlainObject(value)) return issues

  const properties = getObjectSchemaProperties(schema)
  const required = getRequiredFields(schema)
  issues.missingRequired.push(
    ...required
      .filter((field) => !Object.prototype.hasOwnProperty.call(value, field))
      .map((field) => joinRequiredPath(path, field)),
  )

  const additionalProperties = getSchemaProperty(schema, 'additionalProperties')
  const patternProperties = getSchemaProperty(schema, 'patternProperties')
  for (const [field, fieldValue] of Object.entries(value)) {
    const fieldPath = joinRequiredPath(path, field)
    const propertySchema = properties?.[field]
    const patternSchemas = getMatchingPatternSchemas(field, patternProperties)

    if (propertySchema !== undefined) {
      issues = mergeSchemaValidationIssues(
        issues,
        collectSchemaValidationIssues(fieldValue, propertySchema, fieldPath),
      )
    }
    for (const patternSchema of patternSchemas) {
      issues = mergeSchemaValidationIssues(
        issues,
        collectSchemaValidationIssues(fieldValue, patternSchema, fieldPath),
      )
    }

    const declared = propertySchema !== undefined || patternSchemas.length > 0
    if (!declared && additionalProperties === false) {
      issues.unexpected.push(fieldPath)
    } else if (!declared && isPlainObject(additionalProperties)) {
      issues = mergeSchemaValidationIssues(
        issues,
        collectSchemaValidationIssues(fieldValue, additionalProperties, fieldPath),
      )
    }
  }

  return issues
}

/**
 * Check the finite-value JSON Schema constraints that are most commonly used
 * by client tools.  This remains deliberately small and deterministic rather
 * than attempting to become a general-purpose schema engine.
 */
function collectSchemaConstraintIssues(
  value: unknown,
  schema: Record<string, unknown>,
  path: string,
): string[] {
  const label = displaySchemaPath(path)
  const mismatches: string[] = []

  if (Array.isArray(value)) {
    const minItems = nonNegativeIntegerSchemaValue(schema.minItems)
    if (minItems !== undefined && value.length < minItems) {
      mismatches.push(`${label} (array has ${value.length} items, minimum is ${minItems})`)
    }

    const maxItems = nonNegativeIntegerSchemaValue(schema.maxItems)
    if (maxItems !== undefined && value.length > maxItems) {
      mismatches.push(`${label} (array has ${value.length} items, maximum is ${maxItems})`)
    }

    if (schema.uniqueItems === true) {
      outer: for (let left = 0; left < value.length; left += 1) {
        for (let right = left + 1; right < value.length; right += 1) {
          if (jsonValuesEqual(value[left], value[right])) {
            mismatches.push(`${label} (array items must be unique)`)
            break outer
          }
        }
      }
    }
  }

  if (typeof value === 'string') {
    // JSON Schema string lengths are measured in Unicode code points, rather
    // than UTF-16 code units, so astral characters count as one character.
    const length = [...value].length
    const minLength = nonNegativeIntegerSchemaValue(schema.minLength)
    if (minLength !== undefined && length < minLength) {
      mismatches.push(`${label} (string has length ${length}, minimum is ${minLength})`)
    }

    const maxLength = nonNegativeIntegerSchemaValue(schema.maxLength)
    if (maxLength !== undefined && length > maxLength) {
      mismatches.push(`${label} (string has length ${length}, maximum is ${maxLength})`)
    }

    if (typeof schema.pattern === 'string') {
      try {
        if (!new RegExp(schema.pattern).test(value)) {
          mismatches.push(`${label} (string does not match pattern)`)
        }
      } catch {
        // Ignore malformed provider-supplied patterns. Other schema rules
        // remain enforceable without rejecting every otherwise valid call.
      }
    }
  }

  if (typeof value === 'number' && Number.isFinite(value)) {
    const minimum = finiteSchemaNumber(schema.minimum)
    const maximum = finiteSchemaNumber(schema.maximum)
    const exclusiveMinimum = finiteSchemaNumber(schema.exclusiveMinimum)
    const exclusiveMaximum = finiteSchemaNumber(schema.exclusiveMaximum)

    if (exclusiveMinimum !== undefined && value <= exclusiveMinimum) {
      mismatches.push(`${label} (number must be greater than ${exclusiveMinimum})`)
    } else if (schema.exclusiveMinimum === true && minimum !== undefined && value <= minimum) {
      mismatches.push(`${label} (number must be greater than ${minimum})`)
    } else if (minimum !== undefined && value < minimum) {
      mismatches.push(`${label} (number is below minimum ${minimum})`)
    }

    if (exclusiveMaximum !== undefined && value >= exclusiveMaximum) {
      mismatches.push(`${label} (number must be less than ${exclusiveMaximum})`)
    } else if (schema.exclusiveMaximum === true && maximum !== undefined && value >= maximum) {
      mismatches.push(`${label} (number must be less than ${maximum})`)
    } else if (maximum !== undefined && value > maximum) {
      mismatches.push(`${label} (number is above maximum ${maximum})`)
    }

    const multipleOf = finiteSchemaNumber(schema.multipleOf)
    if (multipleOf !== undefined && multipleOf > 0) {
      const quotient = value / multipleOf
      const nearestInteger = Math.round(quotient)
      const tolerance = Number.EPSILON * Math.max(1, Math.abs(quotient)) * 8
      if (Math.abs(quotient - nearestInteger) > tolerance) {
        mismatches.push(`${label} (number is not a multiple of ${multipleOf})`)
      }
    }
  }

  if (isPlainObject(value)) {
    const propertyCount = Object.keys(value).length
    const minProperties = nonNegativeIntegerSchemaValue(schema.minProperties)
    if (minProperties !== undefined && propertyCount < minProperties) {
      mismatches.push(`${label} (object has ${propertyCount} properties, minimum is ${minProperties})`)
    }

    const maxProperties = nonNegativeIntegerSchemaValue(schema.maxProperties)
    if (maxProperties !== undefined && propertyCount > maxProperties) {
      mismatches.push(`${label} (object has ${propertyCount} properties, maximum is ${maxProperties})`)
    }
  }

  return mismatches
}

function nonNegativeIntegerSchemaValue(value: unknown): number | undefined {
  return typeof value === 'number'
    && Number.isInteger(value)
    && Number.isFinite(value)
    && value >= 0
    ? value
    : undefined
}

function finiteSchemaNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function expectedSchemaTypes(schema: Record<string, unknown>): string[] {
  const declared = typeof schema.type === 'string'
    ? [schema.type]
    : Array.isArray(schema.type)
      ? schema.type.filter((type): type is string => typeof type === 'string')
      : []
  const inferred = declared.length > 0
    ? declared
    : schemaExpectsArray(schema)
      ? ['array']
      : schemaExpectsObject(schema)
        ? ['object']
        : []
  if (inferred.length === 0) return []

  return uniqueStrings([
    ...inferred,
    ...(schema.nullable === true && !inferred.includes('null') ? ['null'] : []),
  ])
}

function valueMatchesSchemaType(value: unknown, type: string): boolean {
  if (type === 'null') return value === null
  if (type === 'array') return Array.isArray(value)
  if (type === 'object') return isPlainObject(value)
  if (type === 'string') return typeof value === 'string'
  if (type === 'boolean') return typeof value === 'boolean'
  if (type === 'number') return typeof value === 'number' && Number.isFinite(value)
  if (type === 'integer') return typeof value === 'number' && Number.isInteger(value)
  return true
}

function emptySchemaValidationIssues(): SchemaValidationIssueSet {
  return { missingRequired: [], unexpected: [], typeMismatches: [], valueMismatches: [] }
}

function mergeSchemaValidationIssues(
  left: SchemaValidationIssueSet,
  right: SchemaValidationIssueSet,
): SchemaValidationIssueSet {
  return {
    missingRequired: [...left.missingRequired, ...right.missingRequired],
    unexpected: [...left.unexpected, ...right.unexpected],
    typeMismatches: [...left.typeMismatches, ...right.typeMismatches],
    valueMismatches: [...left.valueMismatches, ...right.valueMismatches],
  }
}

function uniqueSchemaValidationIssues(issues: SchemaValidationIssueSet): SchemaValidationIssueSet {
  return {
    missingRequired: uniqueStrings(issues.missingRequired),
    unexpected: uniqueStrings(issues.unexpected),
    typeMismatches: uniqueStrings(issues.typeMismatches),
    valueMismatches: uniqueStrings(issues.valueMismatches),
  }
}

function bestSchemaValidationIssues(issueSets: SchemaValidationIssueSet[]): SchemaValidationIssueSet {
  if (issueSets.length === 0) return emptySchemaValidationIssues()
  return issueSets.reduce((best, candidate) => (
    schemaIssueCount(candidate) < schemaIssueCount(best) ? candidate : best
  ))
}

function schemaIssueCount(issues: SchemaValidationIssueSet): number {
  return issues.missingRequired.length
    + issues.unexpected.length
    + issues.typeMismatches.length
    + issues.valueMismatches.length
}

function displaySchemaPath(path: string): string {
  return path || '$'
}

function jsonValueKind(value: unknown): string {
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'array'
  if (isPlainObject(value)) return 'object'
  if (typeof value === 'number' && Number.isInteger(value)) return 'integer'
  return typeof value
}

function jsonValuesEqual(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left)
      && Array.isArray(right)
      && left.length === right.length
      && left.every((item, index) => jsonValuesEqual(item, right[index]))
  }

  if (!isPlainObject(left) || !isPlainObject(right)) return false
  const leftKeys = Object.keys(left)
  const rightKeys = Object.keys(right)
  return leftKeys.length === rightKeys.length
    && leftKeys.every(key => Object.prototype.hasOwnProperty.call(right, key)
      && jsonValuesEqual(left[key], right[key]))
}

function getMatchingPatternSchemas(key: string, patternProperties: unknown): unknown[] {
  if (!isPlainObject(patternProperties)) return []

  return Object.entries(patternProperties).flatMap(([pattern, patternSchema]) => {
    try {
      return new RegExp(pattern).test(key) ? [patternSchema] : []
    } catch {
      // Ignore malformed provider-supplied patterns. The rest of the schema
      // remains enforceable and the invalid pattern is not a reason to reject
      // every otherwise valid call.
      return []
    }
  })
}

function getSchemaArray(schema: Record<string, unknown>, key: string): unknown[] {
  const value = schema[key]
  return Array.isArray(value) ? value : []
}

function getRequiredFields(schema: unknown): string[] {
  const required = getSchemaProperty(schema, 'required')
  return Array.isArray(required) ? required.filter((field): field is string => typeof field === 'string') : []
}

function joinRequiredPath(path: string, field: string): string {
  return path ? `${path}.${field}` : field
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values)]
}

export function genericToolResultBlock(result: NormalizedToolResult): string {
  return `[TOOL_RESULT for ${result.toolCallId}] ${result.content}`
}
