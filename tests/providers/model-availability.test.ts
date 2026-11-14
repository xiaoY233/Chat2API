import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { gateKey, isVerifiedReply } from '../../src/main/proxy/modelAvailability.ts'
import { qwenAiConfig } from '../../src/main/providers/builtin/qwen-ai.ts'
import type { ForwardResult } from '../../src/main/proxy/types.ts'

const root = join(dirname(fileURLToPath(import.meta.url)), '../..')

function reply(content: unknown, extra: Record<string, unknown> = {}): ForwardResult {
  return {
    success: true,
    body: {
      choices: [{ message: { role: 'assistant', content, ...extra } }],
    },
  }
}

test('Qwen4-Max-Preview is gated while its route and catalog entry stay wired', () => {
  assert.ok(qwenAiConfig.supportedModels?.includes('Qwen4-Max-Preview'))
  assert.equal(
    qwenAiConfig.modelMappings?.['Qwen4-Max-Preview'],
    'qwen4.0-max-preview'
  )
  assert.deepEqual(qwenAiConfig.temporarilyUnavailableModels, ['Qwen4-Max-Preview'])
})

test('a successful but empty answer does not clear the gate', () => {
  assert.equal(isVerifiedReply(reply('')), false)
  assert.equal(isVerifiedReply(reply('   \n\t')), false)
  assert.equal(isVerifiedReply(reply(undefined)), false)
  assert.equal(isVerifiedReply(reply([])), false)
  assert.equal(isVerifiedReply({ success: false, error: 'upstream failed' }), false)
})

test('a non-empty answer or a real tool call proves recovery', () => {
  assert.equal(isVerifiedReply(reply('pong')), true)
  assert.equal(isVerifiedReply(reply([{ type: 'text', text: 'pong' }])), true)
  assert.equal(
    isVerifiedReply(reply('', { tool_calls: [{ id: 'call-1', type: 'function' }] })),
    true
  )
})

test('gate matching ignores case and whitespace', () => {
  assert.equal(gateKey('  Qwen4-Max-Preview '), 'qwen4-max-preview')
  assert.equal(gateKey('qwen4.0-max-preview'), 'qwen4.0-max-preview')
})

test('the proxy returns the established 503 shape for a gated model', () => {
  const chat = readFileSync(join(root, 'src/main/proxy/routes/chat.ts'), 'utf8')
  const completions = readFileSync(join(root, 'src/main/proxy/routes/completions.ts'), 'utf8')

  for (const source of [chat, completions]) {
    assert.match(source, /modelAvailability\.findGate\(request\.model\)/)
    assert.match(source, /type: 'service_unavailable_error'/)
    assert.match(source, /code: 'model_unavailable'/)
    assert.match(source, /ctx\.set\('Retry-After', '60'\)/)
  }
})

test('recovery probes use a bare no-system call and a real answer check', () => {
  const source = readFileSync(join(root, 'src/main/proxy/modelAvailability.ts'), 'utf8')

  assert.match(source, /const PROBE_PROMPT = 'ping'/)
  assert.match(source, /messages: \[\{ role: 'user', content: PROBE_PROMPT \}\]/)
  assert.match(source, /stream: false/)
  assert.match(source, /isVerifiedReply\(result\)/)
  assert.match(source, /const PERIODIC_CHECK_MS = 10 \* 60_000/)
  assert.match(source, /const PROBE_COOLDOWN_MS = 60_000/)
  assert.match(source, /deleteSession: true/)
  assert.match(source, /temporarilyUnavailableModels: remaining/)
  assert.match(source, /async verifyGatedModels\(\): Promise<void>/)

  const forwarder = readFileSync(join(root, 'src/main/proxy/forwarder.ts'), 'utf8')
  assert.match(
    forwarder,
    /const deleteSession = request\.deleteSession === true \|\| shouldDeleteSession\(\)/
  )
})

test('the recovery sweep runs with the proxy and a lifted gate survives restarts', () => {
  const server = readFileSync(join(root, 'src/main/proxy/server.ts'), 'utf8')
  const store = readFileSync(join(root, 'src/main/store/store.ts'), 'utf8')

  assert.match(server, /modelAvailability\.start\(\)/)
  assert.match(server, /modelAvailability\.stop\(\)/)
  assert.match(
    store,
    /temporarilyUnavailableModels:\s*p\.temporarilyUnavailableModels \?\? builtinConfig\.temporarilyUnavailableModels/
  )
  assert.match(store, /temporarilyUnavailableModels: builtinConfig\.temporarilyUnavailableModels/)
})
