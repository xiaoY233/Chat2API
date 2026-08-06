import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

const script = 'skills/chat2api-provider-model-matrix/scripts/run-model-matrix.mjs'
const scriptPath = path.resolve(script)

function makeTempRunDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chat2api-model-matrix-'))
  fs.writeFileSync(path.join(dir, 'fixture.json'), JSON.stringify({ scenarios: [] }))
  return dir
}

function writeMockFetch(dir, source) {
  const file = path.join(dir, 'mock-fetch.mjs')
  fs.writeFileSync(file, source)
  return `--import=file://${file}`
}

test('matrix runner defaults to /v1/models discovery', () => {
  const text = fs.readFileSync(script, 'utf8')
  assert.match(text, /\/v1\/models/)
  assert.match(text, /modelSource: 'v1\/models'/)
  assert.match(text, /fail-fast-provider/)
})

test('matrix runner dry-run does not require secrets and reports filters', () => {
  const result = spawnSync('node', [script, '--fixture', 'fixture.json', '--profile', 'cherry-studio', '--provider', 'deepseek', '--dry-run'], {
    encoding: 'utf8',
  })

  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /v1\/models/)
  assert.match(result.stdout, /deepseek/)
  assert.match(result.stdout, /cherry-studio/)
})

test('matrix runner dry-run does not leak configured secrets', () => {
  const result = spawnSync('node', [script, '--fixture', 'fixture.json', '--dry-run'], {
    env: {
      ...process.env,
      CHAT2API_API_KEY: 'sk_super_secret_value',
      CHAT2API_MGMT_SECRET: 'mgmt_super_secret_value',
    },
    encoding: 'utf8',
  })

  assert.equal(result.status, 0, result.stderr)
  assert.doesNotMatch(result.stdout, /sk_super_secret_value/)
  assert.doesNotMatch(result.stdout, /mgmt_super_secret_value/)
})

test('matrix runner selects provider id when /v1/models uses display owned_by', () => {
  const cwd = makeTempRunDir()
  const capture = path.join(cwd, 'fetch.json')
  const nodeOptions = writeMockFetch(cwd, `
import fs from 'node:fs'

globalThis.fetch = async (url, options) => {
  fs.writeFileSync(${JSON.stringify(capture)}, JSON.stringify({ url, headers: options.headers }))
  return new Response(JSON.stringify({
    data: [
      { id: 'deepseek-chat', object: 'model', owned_by: 'DeepSeek' },
      { id: 'kimi-k2', object: 'model', owned_by: 'Moonshot AI' }
    ]
  }), { status: 200, headers: { 'Content-Type': 'application/json' } })
}
`)
  const result = spawnSync('node', [scriptPath, '--fixture', 'fixture.json', '--provider', 'deepseek'], {
    cwd,
    env: {
      ...process.env,
      NODE_OPTIONS: nodeOptions,
      CHAT2API_BASE_URL: 'http://127.0.0.1:8080',
      CHAT2API_API_KEY: 'sk_super_secret_value',
      CHAT2API_MGMT_SECRET: 'mgmt_super_secret_value',
    },
    encoding: 'utf8',
  })

  assert.equal(result.status, 0, result.stderr)
  assert.doesNotMatch(result.stdout, /sk_super_secret_value/)
  assert.doesNotMatch(result.stdout, /mgmt_super_secret_value/)

  const fetchCall = JSON.parse(fs.readFileSync(capture, 'utf8'))
  assert.equal(fetchCall.url, 'http://127.0.0.1:8080/v1/models')
  assert.equal(fetchCall.headers.Authorization, 'Bearer sk_super_secret_value')

  const output = JSON.parse(result.stdout)
  assert.match(output.reportPath, /^backup\/har\/chat2api-model-matrix-.+\.json$/)

  const report = JSON.parse(fs.readFileSync(path.join(cwd, output.reportPath), 'utf8'))
  assert.equal(report.selectedModelCount, 1)
  assert.equal(report.selectedModels[0].id, 'deepseek-chat')
  assert.equal(report.selectedModels[0].owned_by, 'DeepSeek')
  assert.doesNotMatch(JSON.stringify(report), /sk_super_secret_value/)
  assert.doesNotMatch(JSON.stringify(report), /mgmt_super_secret_value/)
})

test('matrix runner exits nonzero when /v1/models fails', () => {
  const cwd = makeTempRunDir()
  const nodeOptions = writeMockFetch(cwd, `
globalThis.fetch = async () => new Response(JSON.stringify({ error: 'failed' }), {
  status: 500,
  headers: { 'Content-Type': 'application/json' }
})
`)
  const result = spawnSync('node', [scriptPath, '--fixture', 'fixture.json'], {
    cwd,
    env: {
      ...process.env,
      NODE_OPTIONS: nodeOptions,
      CHAT2API_BASE_URL: 'http://127.0.0.1:8080',
      CHAT2API_API_KEY: 'sk_super_secret_value',
      CHAT2API_MGMT_SECRET: 'mgmt_super_secret_value',
    },
    encoding: 'utf8',
  })

  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /GET \/v1\/models failed: 500/)
  assert.doesNotMatch(result.stderr, /sk_super_secret_value/)
  assert.doesNotMatch(result.stderr, /mgmt_super_secret_value/)
})
