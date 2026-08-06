#!/usr/bin/env node

import fs from 'node:fs'

const baseUrl = (process.env.CHAT2API_BASE_URL || 'http://127.0.0.1:8080').replace(/\/$/, '')
const managementSecret = process.env.CHAT2API_MGMT_SECRET || ''
const command = process.argv[2] || 'help'
const args = parseArgs(process.argv.slice(3))

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

function maskSecret(value) {
  if (!value) return ''
  if (value.length <= 8) return '***'
  return `${value.slice(0, 4)}...${value.slice(-4)}`
}

function redact(value) {
  if (Array.isArray(value)) {
    return value.map(item => redact(item))
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => {
      if (isSensitiveKey(key)) return [key, '[REDACTED]']
      return [key, redact(entry)]
    }))
  }
  if (typeof value === 'string') {
    return value
      .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [REDACTED]')
      .replace(/sk-[A-Za-z0-9._-]+/g, 'sk-[REDACTED]')
  }
  return value
}

function isSensitiveKey(key) {
  return /^(authorization|key|apiKey|token|managementApiSecret|credentials)$/i.test(key)
}

function bodyPreview(body) {
  const text = typeof body === 'string' ? body : JSON.stringify(redact(body))
  return text.length > 500 ? `${text.slice(0, 500)}...` : text
}

function dryRun(label, extra = {}) {
  console.log(JSON.stringify({
    command: label,
    baseUrl,
    managementSecret: maskSecret(managementSecret),
    ...extra,
  }, null, 2))
}

async function request(path, options = {}) {
  if (!managementSecret) throw new Error('CHAT2API_MGMT_SECRET is required')
  const response = await fetch(`${baseUrl}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${managementSecret}`,
      'Content-Type': 'application/json',
      ...options.headers,
    },
  })
  const text = await response.text()
  let body
  try {
    body = text ? JSON.parse(text) : null
  } catch {
    body = text
  }
  return { ok: response.ok, status: response.status, body }
}

async function snapshot() {
  if (args['dry-run']) return dryRun('snapshot')
  const [health, proxy, config, providers, accounts, sessions] = await Promise.all([
    fetch(`${baseUrl}/health`).then(async response => ({ status: response.status, body: await response.text() })),
    request('/v0/management/proxy/status'),
    request('/v0/management/config'),
    request('/v0/management/providers/'),
    request('/v0/management/accounts'),
    request('/v0/management/sessions'),
  ])
  const output = { health, proxy, config, providers, accounts, sessions }
  if (args['include-logs']) {
    output.logs = await request('/v0/management/logs?type=request&limit=20')
  }
  console.log(JSON.stringify(redact(output), null, 2))
}

async function createApiKey() {
  if (args['dry-run']) return dryRun('create-api-key', { name: args.name || 'codex-live-test' })
  const result = await request('/v0/management/api-keys', {
    method: 'POST',
    body: JSON.stringify({
      name: args.name || `codex-live-test-${Date.now()}`,
      description: 'temporary key created by Chat2API testing skill',
    }),
  })
  if (!result.ok) throw new Error(`create-api-key failed: ${result.status}`)
  console.error('Warning: create-api-key prints a one-time API key. Do not write this output to durable logs.')
  console.log(JSON.stringify({
    id: result.body.data.id,
    key: result.body.data.key,
  }, null, 2))
}

async function deleteApiKey() {
  if (!args.id) throw new Error('--id is required')
  if (args['dry-run']) return dryRun('delete-api-key', { id: args.id })
  const result = await request(`/v0/management/api-keys/${encodeURIComponent(args.id)}`, { method: 'DELETE' })
  console.log(JSON.stringify(result, null, 2))
}

async function restoreToolConfig() {
  if (!args.file) throw new Error('--file is required')
  if (args['dry-run']) return dryRun('restore-tool-config', { file: args.file })
  const value = JSON.parse(await fs.promises.readFile(args.file, 'utf8'))
  const result = await request('/v0/management/config/toolCallingConfig', {
    method: 'PUT',
    body: JSON.stringify({ value }),
  })
  if (!result.ok) {
    throw new Error(`restore-tool-config failed: ${result.status} ${bodyPreview(result.body)}`)
  }
  console.log(JSON.stringify(result, null, 2))
}

async function main() {
  if (command === 'snapshot') return snapshot()
  if (command === 'create-api-key') return createApiKey()
  if (command === 'delete-api-key') return deleteApiKey()
  if (command === 'restore-tool-config') return restoreToolConfig()
  console.log('Commands: snapshot, create-api-key, delete-api-key, restore-tool-config')
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exit(1)
})
