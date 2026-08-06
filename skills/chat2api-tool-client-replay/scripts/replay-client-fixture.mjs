#!/usr/bin/env node

import fs from 'node:fs'

const args = parseArgs(process.argv.slice(2))
const baseUrl = (process.env.CHAT2API_BASE_URL || 'http://127.0.0.1:8080').replace(/\/$/, '')
const apiKey = process.env.CHAT2API_API_KEY || ''
const sensitiveHeaders = new Set([
  'authorization',
  'cookie',
  'x-api-key',
  'api-key',
  'proxy-authorization',
  'set-cookie',
])

function parseArgs(values) {
  const parsed = {}
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index]
    if (!value.startsWith('--')) continue
    const key = value.slice(2)
    const next = values[index + 1]
    if (!next || next.startsWith('--')) {
      parsed[key] = true
    } else {
      parsed[key] = next
      index += 1
    }
  }
  return parsed
}

function mask(value) {
  if (!value) return ''
  return value.length <= 8 ? '***' : `${value.slice(0, 3)}...${value.slice(-4)}`
}

function readProfile(id) {
  const profilePath = new URL(`../profiles/${id}.json`, import.meta.url)
  if (!fs.existsSync(profilePath)) {
    throw new Error(`Unknown profile: ${id}`)
  }
  return JSON.parse(fs.readFileSync(profilePath, 'utf8'))
}

function readFixture(file) {
  const fixture = JSON.parse(fs.readFileSync(file, 'utf8'))
  if (!Array.isArray(fixture.scenarios)) {
    throw new Error('Fixture must define a scenarios array')
  }
  return fixture
}

function getFixturePreflight(file) {
  if (!fs.existsSync(file)) {
    return {
      fixtureExists: false,
      scenarioCount: null,
    }
  }

  const fixture = readFixture(file)
  return {
    fixtureExists: true,
    scenarioCount: fixture.scenarios.length,
  }
}

function safeHeaders(headers = {}) {
  const filtered = {}
  for (const [name, value] of Object.entries(headers)) {
    if (!sensitiveHeaders.has(name.toLowerCase())) {
      filtered[name] = value
    }
  }
  return filtered
}

async function main() {
  const profileId = args.profile || 'custom-har'
  const model = args.model || process.env.CHAT2API_MODEL

  if (!args.fixture) throw new Error('--fixture is required')
  if (!model) throw new Error('--model or CHAT2API_MODEL is required')

  const profile = readProfile(profileId)

  if (args['dry-run']) {
    const fixturePreflight = getFixturePreflight(args.fixture)
    console.log(JSON.stringify({
      fixture: args.fixture,
      ...fixturePreflight,
      profile: profile.id,
      model,
      baseUrl,
      apiKey: mask(apiKey),
    }, null, 2))
    return
  }

  if (!apiKey) throw new Error('CHAT2API_API_KEY is required')

  const fixture = readFixture(args.fixture)
  const results = []

  for (const scenario of fixture.scenarios) {
    const body = { ...scenario.body, model }
    const response = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...safeHeaders(profile.headers),
        ...safeHeaders(scenario.headers),
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
    })
    const text = await response.text()
    results.push({
      kind: scenario.kind,
      status: response.status,
      ok: response.ok,
      textPreview: text.slice(0, 500),
    })
  }

  console.log(JSON.stringify({ profile: profile.id, model, results }, null, 2))
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exit(1)
})
