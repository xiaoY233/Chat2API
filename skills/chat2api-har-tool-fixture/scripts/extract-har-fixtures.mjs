#!/usr/bin/env node

import fs from 'node:fs'
import path from 'node:path'

const SAFE_HEADER_ORDER = ['user-agent', 'x-title', 'accept-language']
const SECRET_KEY_PATTERN = /authorization|api[-_]?key|access[-_]?key|token|secret|password|cookie|session/i
const SECRET_VALUE_PATTERN = /bearer\s+[a-z0-9._~+/=-]+|sk[-_](?:(?:live|test|proj)[-_])?[a-z0-9_-]{16,}|eyJ[a-z0-9_-]{10,}\.[a-z0-9_-]{10,}\.[a-z0-9_-]{10,}|api[-_]?key|token|secret|password|cookie|session=/i

function parseArgs(values) {
  const parsed = {}

  for (let index = 0; index < values.length; index += 1) {
    const value = values[index]
    if (!value.startsWith('--')) continue

    const key = value.slice(2)
    const next = values[index + 1]
    if (!next || next.startsWith('--')) {
      parsed[key] = true
      continue
    }

    parsed[key] = next
    index += 1
  }

  return parsed
}

function safeHeaders(headers = []) {
  const byLowerName = new Map()
  for (const header of headers) {
    if (!header?.name) continue
    byLowerName.set(header.name.toLowerCase(), header)
  }

  const result = {}
  for (const lowerName of SAFE_HEADER_ORDER) {
    const header = byLowerName.get(lowerName)
    if (header) result[header.name] = redactSecrets(header.value)
  }
  return result
}

function slugifyClientProfile(clientProfile) {
  const slug = String(clientProfile)
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')

  return slug || 'custom-har'
}

function redactSecrets(value, parentKey = '') {
  if (SECRET_KEY_PATTERN.test(parentKey)) return '[REDACTED]'

  if (Array.isArray(value)) {
    return value.map((item) => redactSecrets(item))
  }

  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, redactSecrets(item, key)]),
    )
  }

  if (typeof value === 'string' && SECRET_VALUE_PATTERN.test(value)) {
    return '[REDACTED]'
  }

  return value
}

function parseBody(postData) {
  const text = postData?.text
  if (!text) return {}
  return JSON.parse(text)
}

function isChatCompletionPost(request) {
  if (request?.method !== 'POST' || !request.url) return false

  try {
    return new URL(request.url).pathname === '/v1/chat/completions'
  } catch {
    return false
  }
}

function hasSystemMessage(body) {
  return Array.isArray(body.messages) && body.messages.some((message) => message?.role === 'system')
}

function hasToolResultMessage(body) {
  return Array.isArray(body.messages) && body.messages.some((message) => message?.role === 'tool')
}

function classifyScenario(body) {
  const hasTools = Array.isArray(body.tools)

  if (body.stream === true && hasTools) return 'tools_stream'
  if (body.stream !== true && hasTools) return 'tools_nonstream'
  if (body.stream === true && hasSystemMessage(body)) return 'prompt_stream'
  if (body.stream !== true && hasSystemMessage(body)) return 'prompt_nonstream'
  if (hasToolResultMessage(body)) return 'tool_result_followup'
  return 'chat'
}

function collectToolNames(body, toolNames) {
  if (!Array.isArray(body.tools)) return

  for (const tool of body.tools) {
    const name = tool?.function?.name
    if (typeof name === 'string' && name) toolNames.add(name)
  }
}

function extractFixtures(harPath, clientProfile) {
  const har = JSON.parse(fs.readFileSync(harPath, 'utf8'))
  const scenarios = []
  const toolNames = new Set()

  for (const entry of har.log?.entries || []) {
    const request = entry.request
    if (!isChatCompletionPost(request)) continue

    const body = parseBody(request.postData)
    collectToolNames(body, toolNames)

    scenarios.push({
      kind: classifyScenario(body),
      headers: safeHeaders(request.headers),
      body: redactSecrets(body),
    })
  }

  if (scenarios.length === 0) {
    throw new Error('No POST /v1/chat/completions requests found in HAR')
  }

  return {
    schemaVersion: 1,
    sourceHar: harPath,
    clientProfile,
    toolNames: [...toolNames],
    scenarios,
  }
}

function main() {
  const args = parseArgs(process.argv.slice(2))
  const clientProfile = args.client || process.env.CHAT2API_CLIENT_PROFILE || 'custom-har'
  const harPath = args.har || process.env.CHAT2API_HAR
  const outPath = args.out || `backup/har/${slugifyClientProfile(clientProfile)}-tool-fixtures-${Date.now()}.json`

  if (!harPath) {
    throw new Error('--har or CHAT2API_HAR is required')
  }

  const fixture = extractFixtures(harPath, clientProfile)
  fs.mkdirSync(path.dirname(outPath), { recursive: true })
  fs.writeFileSync(outPath, `${JSON.stringify(fixture, null, 2)}\n`)
  console.log(outPath)
}

try {
  main()
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
}
