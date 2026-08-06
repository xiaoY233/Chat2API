import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

const script = 'skills/chat2api-management-api/scripts/management-api.mjs'
const skill = 'skills/chat2api-management-api/SKILL.md'

test('management helper has documented commands', () => {
  const text = fs.readFileSync(script, 'utf8')
  assert.match(text, /command === 'snapshot'/)
  assert.match(text, /command === 'create-api-key'/)
  assert.match(text, /command === 'delete-api-key'/)
  assert.match(text, /command === 'restore-tool-config'/)
  assert.match(text, /maskSecret/)
})

test('management helper prints safe dry-run output without leaking secret', () => {
  const result = spawnSync('node', [script, 'snapshot', '--dry-run'], {
    env: {
      ...process.env,
      CHAT2API_BASE_URL: 'http://127.0.0.1:8080',
      CHAT2API_MGMT_SECRET: 'mgmt_super_secret_value',
    },
    encoding: 'utf8',
  })

  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /snapshot/)
  assert.doesNotMatch(result.stdout, /mgmt_super_secret_value/)
})

test('management helper dry-run commands do not need network and do not leak secret', () => {
  const commands = [
    ['snapshot', '--dry-run'],
    ['create-api-key', '--dry-run'],
    ['delete-api-key', '--id', 'k', '--dry-run'],
    ['restore-tool-config', '--file', 'f', '--dry-run'],
  ]

  for (const command of commands) {
    const result = spawnSync('node', [script, ...command], {
      env: {
        ...process.env,
        CHAT2API_BASE_URL: 'http://127.0.0.1:1',
        CHAT2API_MGMT_SECRET: 'mgmt_super_secret_value',
      },
      encoding: 'utf8',
    })

    assert.equal(result.status, 0, `${command.join(' ')} failed: ${result.stderr}`)
    assert.doesNotMatch(result.stdout, /mgmt_super_secret_value/)
    assert.doesNotMatch(result.stderr, /mgmt_super_secret_value/)
  }
})

test('restore-tool-config exits nonzero on non-2xx response', async () => {
  const configFile = path.join(os.tmpdir(), `toolCallingConfig-${process.pid}.json`)
  const mockFile = path.join(os.tmpdir(), `mock-fetch-${process.pid}.mjs`)
  fs.writeFileSync(configFile, JSON.stringify({ enabled: true }))
  fs.writeFileSync(mockFile, `
globalThis.fetch = async (url, options = {}) => {
  if (!String(url).endsWith('/v0/management/config/toolCallingConfig')) {
    throw new Error('unexpected url ' + url)
  }
  if (options.method !== 'PUT') {
    throw new Error('unexpected method ' + options.method)
  }
  return new Response(JSON.stringify({ error: 'restore rejected' }), {
    status: 500,
    headers: { 'Content-Type': 'application/json' },
  })
}
`)

  try {
    const result = await runScript([
      'restore-tool-config',
      '--file',
      configFile,
    ], {
      CHAT2API_BASE_URL: 'http://mock.local',
      CHAT2API_MGMT_SECRET: 'mgmt_super_secret_value',
    }, {
      nodeArgs: ['--import', mockFile],
    })

    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /restore-tool-config failed/)
    assert.match(result.stderr, /500/)
    assert.match(result.stderr, /restore rejected/)
    assert.doesNotMatch(result.stderr, /mgmt_super_secret_value/)
  } finally {
    fs.rmSync(configFile, { force: true })
    fs.rmSync(mockFile, { force: true })
  }
})

test('management skill documents every helper command', () => {
  const text = fs.readFileSync(skill, 'utf8')
  const commandsSection = text.split('## Commands')[1]?.split('\n## ')[0] || ''

  assert.match(commandsSection, /management-api\.mjs snapshot/)
  assert.match(commandsSection, /management-api\.mjs create-api-key/)
  assert.match(commandsSection, /management-api\.mjs delete-api-key/)
  assert.match(commandsSection, /management-api\.mjs restore-tool-config/)
})

test('management skill documents one-time key warning and explicit log inclusion', () => {
  const text = fs.readFileSync(skill, 'utf8')

  assert.match(text, /one-time API key/i)
  assert.match(text, /durable logs/i)
  assert.match(text, /--include-logs/)
})

function runScript(args, env, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn('node', [...(options.nodeArgs || []), script, ...args], {
      env: {
        ...process.env,
        ...env,
      },
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', chunk => {
      stdout += chunk
    })
    child.stderr.on('data', chunk => {
      stderr += chunk
    })
    child.on('error', reject)
    child.on('close', status => {
      resolve({ status, stdout, stderr })
    })
  })
}
