#!/usr/bin/env node

import fs from 'node:fs'

const args = parseArgs(process.argv.slice(2))
const baseUrl = (process.env.CHAT2API_BASE_URL || 'http://127.0.0.1:8080').replace(/\/$/, '')
const managementSecret = process.env.CHAT2API_MGMT_SECRET || ''
const apiKey = process.env.CHAT2API_API_KEY || ''
const runId = new Date().toISOString().replace(/[:.]/g, '-')
const profile = args.profile || 'custom-har'
const modelSource = 'v1/models'
const modelsEndpoint = `${baseUrl}/v1/models`
const providerAliases = new Map([
  ['deepseek', new Set(['deepseek'])],
  ['deep-seek', new Set(['deepseek'])],
  ['deepseekai', new Set(['deepseek'])],
  ['deepseek-ai', new Set(['deepseek'])],
  ['moonshotai', new Set(['kimi', 'moonshot'])],
  ['moonshot', new Set(['kimi', 'moonshot'])],
  ['kimi', new Set(['kimi', 'moonshot'])],
  ['zai', new Set(['zai', 'z-ai', 'glm'])],
  ['z-ai', new Set(['zai', 'z-ai', 'glm'])],
  ['zhipuai', new Set(['zai', 'z-ai', 'glm'])],
  ['glm', new Set(['zai', 'z-ai', 'glm'])],
  ['minimax', new Set(['minimax'])],
  ['qwen', new Set(['qwen', 'tongyi'])],
  ['tongyi', new Set(['qwen', 'tongyi'])],
  ['perplexity', new Set(['perplexity'])],
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

function buildRunShape(extra = {}) {
  return {
    runId,
    modelSource: 'v1/models',
    modelsEndpoint,
    fixture: args.fixture,
    profile,
    provider: args.provider,
    model: args.model,
    failFastProvider: args['fail-fast-provider'] || false,
    ...extra,
  }
}

function requireFixtureArg() {
  if (!args.fixture) throw new Error('--fixture is required')
}

function requireLiveInputs() {
  if (!managementSecret) throw new Error('CHAT2API_MGMT_SECRET is required')
  if (!apiKey) throw new Error('CHAT2API_API_KEY is required')
  if (!fs.existsSync(args.fixture)) throw new Error(`Fixture file not found: ${args.fixture}`)
}

async function getModels() {
  const response = await fetch(modelsEndpoint, {
    headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
  })
  const text = await response.text()
  let body
  try {
    body = text ? JSON.parse(text) : {}
  } catch {
    throw new Error(`GET /v1/models returned non-JSON response: ${response.status}`)
  }
  if (!response.ok) throw new Error(`GET /v1/models failed: ${response.status}`)
  return Array.isArray(body.data) ? body.data : []
}

function selectModels(models) {
  return models.filter((model) => {
    if (args.model && model.id !== args.model) return false
    if (args.provider && !matchesProvider(model, args.provider)) return false
    return true
  })
}

function normalizeProvider(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '')
}

function providerCandidates(model) {
  return [
    model.owned_by,
    model.provider,
    model.providerId,
    model.provider_id,
    model.providerName,
    model.provider_name,
  ]
    .filter(Boolean)
    .map(normalizeProvider)
}

function matchesProvider(model, provider) {
  const requested = normalizeProvider(provider)
  const accepted = new Set([requested, ...(providerAliases.get(requested) || [])].map(normalizeProvider))
  return providerCandidates(model).some((candidate) => {
    if (accepted.has(candidate)) return true
    const aliases = providerAliases.get(candidate)
    return aliases ? [...aliases].some((alias) => accepted.has(normalizeProvider(alias))) : false
  })
}

function dryRun() {
  console.log(JSON.stringify(buildRunShape({ dryRun: true }), null, 2))
}

async function main() {
  requireFixtureArg()

  if (args['dry-run']) {
    dryRun()
    return
  }

  requireLiveInputs()

  const models = await getModels()
  const selectedModels = selectModels(models)
  const report = buildRunShape({
    baseUrl,
    dryRun: false,
    discoveredModelCount: models.length,
    selectedModelCount: selectedModels.length,
    selectedModels,
  })

  fs.mkdirSync('backup/har', { recursive: true })
  const reportPath = `backup/har/chat2api-model-matrix-${runId}.json`
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2))
  console.log(JSON.stringify({
    modelSource,
    modelsEndpoint,
    reportPath,
    discoveredModelCount: report.discoveredModelCount,
    selectedModelCount: report.selectedModelCount,
  }, null, 2))
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exit(1)
})
