import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

const script = 'skills/chat2api-tool-client-replay/scripts/replay-client-fixture.mjs'

test('client profiles define prompt and tools expectations', () => {
  const cherry = JSON.parse(fs.readFileSync('skills/chat2api-tool-client-replay/profiles/cherry-studio.json', 'utf8'))
  assert.equal(cherry.id, 'cherry-studio')
  assert.equal(cherry.promptProtocol.visibleToolUseRequired, true)
  assert.equal(cherry.toolsProtocol.finishReason, 'tool_calls')

  const openai = JSON.parse(fs.readFileSync('skills/chat2api-tool-client-replay/profiles/openai-tools.json', 'utf8'))
  assert.equal(openai.id, 'openai-tools')
  assert.equal(openai.promptProtocol.visibleToolUseRequired, false)
})

test('replay dry-run reports selected fixture and model', () => {
  const result = spawnSync('node', [script, '--fixture', 'sample.json', '--profile', 'cherry-studio', '--model', 'deepseek-v4-flash', '--dry-run'], {
    env: {
      ...process.env,
      CHAT2API_API_KEY: 'sk-secret-value',
    },
    encoding: 'utf8',
  })

  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /cherry-studio/)
  assert.match(result.stdout, /deepseek-v4-flash/)
  assert.doesNotMatch(result.stdout, /sk-secret-value/)
})

test('replay dry-run does not require fixture file', () => {
  const result = spawnSync('node', [script, '--fixture', 'missing-fixture.json', '--profile', 'openai-tools', '--model', 'deepseek-v4-flash', '--dry-run'], {
    encoding: 'utf8',
  })

  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /missing-fixture\.json/)
  assert.match(result.stdout, /openai-tools/)
  const output = JSON.parse(result.stdout)
  assert.equal(output.fixtureExists, false)
  assert.equal(output.scenarioCount, null)
})

test('replay dry-run reports schema details when fixture exists without requiring api key', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chat2api-replay-'))
  const fixture = path.join(dir, 'fixture.json')
  fs.writeFileSync(fixture, JSON.stringify({
    scenarios: [
      { kind: 'stream', body: { messages: [], tools: [] } },
      { kind: 'non-stream', body: { messages: [], tools: [] } },
    ],
  }))

  const result = spawnSync('node', [script, '--fixture', fixture, '--profile', 'openai-tools', '--model', 'deepseek-v4-flash', '--dry-run'], {
    env: {
      ...process.env,
      CHAT2API_API_KEY: '',
    },
    encoding: 'utf8',
  })

  assert.equal(result.status, 0, result.stderr)
  const output = JSON.parse(result.stdout)
  assert.equal(output.fixtureExists, true)
  assert.equal(output.scenarioCount, 2)
  assert.equal(output.apiKey, '')
})

test('non-dry-run filters captured sensitive headers and runtime authorization wins', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chat2api-replay-'))
  const fixture = path.join(dir, 'fixture.json')
  const capture = path.join(dir, 'request.json')
  const mock = path.join(dir, 'mock-fetch.mjs')

  fs.writeFileSync(fixture, JSON.stringify({
    scenarios: [{
      kind: 'non-stream',
      headers: {
        Authorization: 'Bearer captured-key',
        Cookie: 'captured-cookie=value',
        'x-api-key': 'captured-x-api-key',
        'api-key': 'captured-api-key',
        'proxy-authorization': 'Basic captured-proxy',
        'x-scenario': 'kept',
      },
      body: {
        model: 'fixture-model',
        messages: [{ role: 'user', content: 'hello' }],
      },
    }],
  }))
  fs.writeFileSync(mock, `
import fs from 'node:fs'

globalThis.fetch = async (url, options) => {
  fs.writeFileSync(${JSON.stringify(capture)}, JSON.stringify({
    url,
    headers: options.headers,
    body: JSON.parse(options.body),
  }))
  return new Response(JSON.stringify({ ok: true }), { status: 200 })
}
`)

  const result = spawnSync('node', [script, '--fixture', fixture, '--profile', 'cherry-studio', '--model', 'deepseek-v4-flash'], {
    env: {
      ...process.env,
      NODE_OPTIONS: `--import=file://${mock}`,
      CHAT2API_BASE_URL: 'http://127.0.0.1:8080',
      CHAT2API_API_KEY: 'runtime-secret',
    },
    encoding: 'utf8',
  })

  assert.equal(result.status, 0, result.stderr)
  const captured = JSON.parse(fs.readFileSync(capture, 'utf8'))
  assert.equal(captured.headers.Authorization, 'Bearer runtime-secret')
  assert.equal(captured.headers.Cookie, undefined)
  assert.equal(captured.headers['x-api-key'], undefined)
  assert.equal(captured.headers['api-key'], undefined)
  assert.equal(captured.headers['proxy-authorization'], undefined)
  assert.equal(captured.headers['x-scenario'], 'kept')
  assert.equal(captured.body.model, 'deepseek-v4-flash')
})

test('missing model exits nonzero without leaking key', () => {
  const result = spawnSync('node', [script, '--fixture', 'sample.json', '--profile', 'cherry-studio', '--dry-run'], {
    env: {
      ...process.env,
      CHAT2API_MODEL: '',
      CHAT2API_API_KEY: 'sk-secret-value',
    },
    encoding: 'utf8',
  })

  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /--model or CHAT2API_MODEL is required/)
  assert.doesNotMatch(result.stderr, /sk-secret-value/)
  assert.doesNotMatch(result.stdout, /sk-secret-value/)
})
