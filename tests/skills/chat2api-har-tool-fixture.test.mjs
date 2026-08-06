import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

const script = 'skills/chat2api-har-tool-fixture/scripts/extract-har-fixtures.mjs'
const absoluteScript = path.resolve(script)

function writeHar(file) {
  const har = {
    log: {
      entries: [{
        request: {
          method: 'POST',
          url: 'http://127.0.0.1:8080/v1/chat/completions',
          headers: [
            { name: 'Authorization', value: 'Bearer secret' },
            { name: 'x-title', value: 'Cherry Studio' },
            { name: 'User-Agent', value: 'CherryStudio/1.9.6' },
          ],
          postData: {
            text: JSON.stringify({
              model: 'deepseek-v4-flash',
              stream: true,
              messages: [{ role: 'user', content: 'Use weather' }],
              tools: [{
                type: 'function',
                function: {
                  name: 'mcp__weatherTest__getWeather',
                  description: 'weather',
                  parameters: { type: 'object' },
                },
              }],
              tool_choice: 'auto',
            }),
          },
        },
      }],
    },
  }
  fs.writeFileSync(file, JSON.stringify(har))
}

test('extracts sanitized tool fixture from HAR', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chat2api-har-'))
  const har = path.join(dir, 'client.har')
  const out = path.join(dir, 'fixture.json')
  writeHar(har)

  const result = spawnSync('node', [script, '--har', har, '--out', out, '--client', 'cherry-studio'], {
    encoding: 'utf8',
  })

  assert.equal(result.status, 0, result.stderr)
  const fixture = JSON.parse(fs.readFileSync(out, 'utf8'))
  assert.equal(fixture.clientProfile, 'cherry-studio')
  assert.equal(fixture.toolNames[0], 'mcp__weatherTest__getWeather')
  assert.equal(fixture.scenarios[0].kind, 'tools_stream')
  assert.deepEqual(fixture.scenarios[0].headers, {
    'User-Agent': 'CherryStudio/1.9.6',
    'x-title': 'Cherry Studio',
  })
  assert.doesNotMatch(JSON.stringify(fixture), /secret/)
})

test('uses env fallback, exact chat path selection, and body secret redaction', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chat2api-har-'))
  const har = path.join(dir, 'client.har')
  const out = path.join(dir, 'fixture.json')
  const harBody = {
    log: {
      entries: [
        {
          request: {
            method: 'POST',
            url: 'http://127.0.0.1:8080/v1/chat/completions-extra',
            headers: [{ name: 'User-Agent', value: 'Ignored/1.0' }],
            postData: { text: JSON.stringify({ messages: [{ role: 'user', content: 'ignore' }] }) },
          },
        },
        {
          request: {
            method: 'POST',
            url: 'http://127.0.0.1:8080/v1/chat/completions',
            headers: [
              { name: 'Cookie', value: 'sid=secret-cookie' },
              { name: 'Accept-Language', value: 'zh-CN' },
            ],
            postData: {
              text: JSON.stringify({
                stream: false,
                api_key: 'secret-api-key',
                nested: {
                  token: 'secret-token',
                  password: 'secret-password',
                },
                messages: [
                  { role: 'assistant', content: 'calling tool' },
                  { role: 'tool', content: 'secret tool result' },
                ],
              }),
            },
          },
        },
      ],
    },
  }
  fs.writeFileSync(har, JSON.stringify(harBody))

  const result = spawnSync('node', [script, '--out', out], {
    encoding: 'utf8',
    env: {
      ...process.env,
      CHAT2API_HAR: har,
      CHAT2API_CLIENT_PROFILE: 'env-client',
    },
  })

  assert.equal(result.status, 0, result.stderr)
  const fixture = JSON.parse(fs.readFileSync(out, 'utf8'))
  assert.equal(fixture.clientProfile, 'env-client')
  assert.equal(fixture.scenarios.length, 1)
  assert.equal(fixture.scenarios[0].kind, 'tool_result_followup')
  assert.deepEqual(fixture.scenarios[0].headers, { 'Accept-Language': 'zh-CN' })
  assert.equal(fixture.scenarios[0].body.api_key, '[REDACTED]')
  assert.equal(fixture.scenarios[0].body.nested.token, '[REDACTED]')
  assert.equal(fixture.scenarios[0].body.nested.password, '[REDACTED]')
  assert.doesNotMatch(JSON.stringify(fixture), /secret-api-key|secret-token|secret-password|secret-cookie/)
})

test('redacts secret values from retained allowed headers', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chat2api-har-'))
  const har = path.join(dir, 'client.har')
  const out = path.join(dir, 'fixture.json')
  const harBody = {
    log: {
      entries: [{
        request: {
          method: 'POST',
          url: 'http://127.0.0.1:8080/v1/chat/completions',
          headers: [
            { name: 'x-title', value: 'Bearer header-secret-token' },
            { name: 'User-Agent', value: 'CherryStudio/1.9.6' },
          ],
          postData: {
            text: JSON.stringify({ messages: [{ role: 'user', content: 'hello' }] }),
          },
        },
      }],
    },
  }
  fs.writeFileSync(har, JSON.stringify(harBody))

  const result = spawnSync('node', [script, '--har', har, '--out', out, '--client', 'cherry-studio'], {
    encoding: 'utf8',
  })

  assert.equal(result.status, 0, result.stderr)
  const fixture = JSON.parse(fs.readFileSync(out, 'utf8'))
  assert.equal(fixture.scenarios[0].headers['x-title'], '[REDACTED]')
  assert.equal(fixture.scenarios[0].headers['User-Agent'], 'CherryStudio/1.9.6')
  assert.doesNotMatch(JSON.stringify(fixture), /header-secret-token/)
})

test('redacts token-like strings in request bodies', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chat2api-har-'))
  const har = path.join(dir, 'client.har')
  const out = path.join(dir, 'fixture.json')
  const jwt = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c'
  const hyphenKey = ['sk', 'abcdefghijklmnopqrstuvwxyz123456'].join('-')
  const dashLiveKey = ['sk', 'live', 'abcdefghijklmnopqrstuvwxyz123456'].join('-')
  const underscoreKey = ['sk', 'live', 'abcdefghijklmnopqrstuvwxyz123456'].join('_')
  const harBody = {
    log: {
      entries: [{
        request: {
          method: 'POST',
          url: 'http://127.0.0.1:8080/v1/chat/completions',
          headers: [],
          postData: {
            text: JSON.stringify({
              messages: [{
                role: 'user',
                content: `Use ${hyphenKey}, ${dashLiveKey} and ${jwt}`,
              }],
              tool_args: JSON.stringify({ apiKey: underscoreKey }),
            }),
          },
        },
      }],
    },
  }
  fs.writeFileSync(har, JSON.stringify(harBody))

  const result = spawnSync('node', [script, '--har', har, '--out', out, '--client', 'cherry-studio'], {
    encoding: 'utf8',
  })

  assert.equal(result.status, 0, result.stderr)
  const fixtureText = fs.readFileSync(out, 'utf8')
  const fixture = JSON.parse(fixtureText)
  assert.equal(fixture.scenarios[0].body.messages[0].content, '[REDACTED]')
  assert.equal(fixture.scenarios[0].body.tool_args, '[REDACTED]')
  assert.doesNotMatch(
    fixtureText,
    new RegExp(`${['sk', 'abcdefghijklmnopqrstuvwxyz'].join('-')}|${['sk', 'live'].join('-')}-|${['sk', 'live'].join('_')}_|eyJhbGciOi`),
  )
})

test('default output path slugifies path-like client profile', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chat2api-har-'))
  const har = path.join(dir, 'client.har')
  writeHar(har)

  const result = spawnSync('node', [absoluteScript, '--har', har, '--client', '../../leak'], {
    cwd: dir,
    encoding: 'utf8',
  })

  assert.equal(result.status, 0, result.stderr)
  const outputPath = result.stdout.trim()
  assert.match(outputPath, /^backup\/har\//)
  assert.doesNotMatch(outputPath, /\.\./)
  assert.equal(path.dirname(path.resolve(dir, outputPath)), path.join(dir, 'backup', 'har'))
  const fixture = JSON.parse(fs.readFileSync(path.resolve(dir, outputPath), 'utf8'))
  assert.equal(fixture.clientProfile, '../../leak')
})
