import test from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'

import {
  buildInceptionCookieHeader,
  buildInceptionMessages,
  buildInceptionRequestBody,
  parseInceptionEvent,
  solveVercelChallenge,
} from '../../src/main/providers/inception.ts'
import { inceptionConfig } from '../../src/main/providers/builtin/inception.ts'
import { getSupportedAuthMethods, createAdapter } from '../../src/main/oauth/adapters/index.ts'
import { getTokenExtractionConfig } from '../../src/main/oauth/tokenExtractionConfig.ts'

// ---------------------------------------------------------------------------
// Vercel Security Checkpoint v2 proof of work
// ---------------------------------------------------------------------------

const MULTIPLIERS = [498787, 533737, 619763, 708403, 828071]

/** Build a synthetic (unsigned) challenge token the solver accepts. */
function makeToken(seed: number, prefix: string, target: string, rounds: number): string {
  const payload = `id;${prefix};${target};${rounds};0`
  const b64 = Buffer.from(payload, 'utf8').toString('base64')
  return `2.${seed}.60.${b64}.signature`
}

test('Inception solves the Vercel challenge and the solution chains to the token', () => {
  const seed = 12345
  const prefix = 'abcd1234'
  const rounds = 3
  const target = 'f'.repeat(64)
  const token = makeToken(seed, prefix, target, rounds)

  const solution = solveVercelChallenge(token)
  const parts = solution.split(';')
  assert.equal(parts.length, rounds)
  for (const part of parts) {
    assert.match(part, /^[0-9a-f]{16}$/)
  }

  // Independently verify the digest-prefix chain the server checks.
  const mul = BigInt(MULTIPLIERS[((seed % 5) + 5) % 5])
  const key = Number((((BigInt(seed) * mul) % 36n) + 36n) % 36n)
  let current = target.slice(key, key + 4)
  for (let round = 0; round < rounds; round++) {
    const digest = crypto
      .createHash('sha256')
      .update(prefix + parts[round])
      .digest('hex')
    assert.equal(digest.slice(0, 4), current, `round ${round} prefix mismatch`)
    const off = Number((((BigInt(seed) * BigInt(MULTIPLIERS[round % 5])) % 60n) + 60n) % 60n)
    current = digest.slice(off, off + 4)
  }

  // The solver is deterministic.
  assert.equal(solveVercelChallenge(token), solution)
})

test('Inception rejects malformed challenge tokens', () => {
  assert.throws(() => solveVercelChallenge('not-a-token'))
  const badPayload = `id;abcd;${'f'.repeat(64)};0;0`
  const bad = `2.1.60.${Buffer.from(badPayload).toString('base64')}.sig`
  assert.throws(() => solveVercelChallenge(bad))
})

// ---------------------------------------------------------------------------
// Cookie header
// ---------------------------------------------------------------------------

test('Inception builds a Cookie header from the jar or a bare clearance value', () => {
  assert.equal(
    buildInceptionCookieHeader({ cookie: '_vcrcs=abc; other=1' }),
    '_vcrcs=abc; other=1',
  )
  assert.equal(buildInceptionCookieHeader({ '_vcrcs': 'abc' }), '_vcrcs=abc')
  assert.equal(buildInceptionCookieHeader({ '_vcrcs': '_vcrcs=abc' }), '_vcrcs=abc')
  // A fresh explicit _vcrcs overrides the value inside a stale jar but keeps
  // the rest of the jar.
  assert.equal(
    buildInceptionCookieHeader({ cookie: 'other=1; _vcrcs=old', '_vcrcs': '_vcrcs=new' }),
    '_vcrcs=new; other=1',
  )
  assert.equal(buildInceptionCookieHeader({}), '')
  assert.equal(buildInceptionCookieHeader(undefined), '')
})

// ---------------------------------------------------------------------------
// Message conversion
// ---------------------------------------------------------------------------

test('Inception folds system prompts, flattens tools, and coalesces roles', () => {
  const messages = buildInceptionMessages([
    { role: 'system', content: 'Be terse.' },
    { role: 'user', content: 'Hello' },
    { role: 'tool', content: '{"temp":20}', tool_call_id: 'call-1' },
    { role: 'assistant', content: null, tool_calls: [{ function: { name: 'get_weather', arguments: '{}' } }] },
    { role: 'assistant', content: 'Bye' },
  ])

  assert.ok(messages.length >= 1)
  assert.equal(messages[messages.length - 1].role, 'user')
  for (const message of messages) {
    assert.match(message.id, /^m-/)
    assert.ok(['user', 'assistant'].includes(message.role))
  }

  const joined = messages.map((m) => m.parts.map((p) => p.text).join('')).join('\n')
  assert.match(joined, /\[System Instructions\]/)
  assert.match(joined, /Be terse\./)
  assert.match(joined, /Hello/)
  assert.match(joined, /Tool Execution Result/)
  assert.match(joined, /get_weather/)
})

test('Inception guarantees a final user turn and handles empty input', () => {
  const only = buildInceptionMessages([{ role: 'assistant', content: 'hi' }])
  assert.equal(only[only.length - 1].role, 'user')
  const empty = buildInceptionMessages([])
  assert.equal(empty.length, 1)
  assert.equal(empty[0].role, 'user')
})

test('Inception builds a useChat request body with a resolved reasoning effort', () => {
  const body = buildInceptionRequestBody(
    [{ role: 'user', content: 'Hi' }],
    { reasoningEffort: 'instant', webSearch: false },
  )
  assert.match(String(body.id), /^c-/)
  assert.equal(body.trigger, 'submit-message')
  assert.equal(body.reasoningEffort, 'instant')
  assert.equal(body.webSearchEnabled, false)
  assert.equal(body.voiceMode, false)
  assert.equal(body.language, 'en-US')
  assert.equal(typeof body.messageId, 'string')
  assert.ok(Array.isArray(body.messages))
  assert.equal((body.messages as unknown[]).length, 1)

  const auto = buildInceptionRequestBody([{ role: 'user', content: 'Hi' }], { reasoningEffort: 'auto' })
  assert.equal(auto.reasoningEffort, 'medium')
})

// ---------------------------------------------------------------------------
// Stream event parsing
// ---------------------------------------------------------------------------

test('Inception parses Vercel AI data-stream events', () => {
  assert.deepEqual(parseInceptionEvent({ type: 'text-delta', delta: 'hi' }), { content: 'hi' })
  assert.deepEqual(parseInceptionEvent({ type: 'text-start', text: 'seed' }), { content: 'seed' })
  assert.deepEqual(parseInceptionEvent({ type: 'reasoning-delta', delta: 'think' }), { reasoning: 'think' })
  assert.deepEqual(parseInceptionEvent({ type: 'text-delta', delta: '' }), {})
  assert.deepEqual(
    parseInceptionEvent({ type: 'source-url', url: 'https://example.com', title: 'Example' }),
    { sources: [{ url: 'https://example.com', title: 'Example' }] },
  )
  assert.deepEqual(parseInceptionEvent({ type: 'source-url', url: '__searching__' }), {})
  assert.deepEqual(parseInceptionEvent({ type: 'source-url', url: 'javascript:alert(1)' }), {})
  assert.deepEqual(parseInceptionEvent({ type: 'error', error: 'boom' }), { error: 'boom' })
  assert.deepEqual(parseInceptionEvent({ type: 'error', error: { message: 'nested' } }), { error: 'nested' })
  assert.deepEqual(parseInceptionEvent({ type: 'finish', finishReason: 'stop' }), { finished: true })
  assert.deepEqual(parseInceptionEvent({ type: 'start' }), {})
  assert.deepEqual(parseInceptionEvent(null), {})
})

// ---------------------------------------------------------------------------
// Builtin provider config, OAuth wiring, extraction config
// ---------------------------------------------------------------------------

test('Inception builtin uses the anonymous clearance cookie and mercury-3', () => {
  assert.equal(inceptionConfig.id, 'inception')
  assert.equal(inceptionConfig.authType, 'cookie')
  assert.equal(inceptionConfig.apiEndpoint, 'https://chat.inceptionlabs.ai')
  assert.equal(inceptionConfig.chatPath, '/api/chat')
  assert.deepEqual(inceptionConfig.supportedModels, ['mercury-3'])
  assert.deepEqual(inceptionConfig.modelMappings, { 'mercury-3': 'mercury-3' })
  assert.equal(inceptionConfig.credentialFields?.[0]?.name, '_vcrcs')
  assert.equal(inceptionConfig.credentialFields?.[0]?.required, false)
  assert.equal(inceptionConfig.tokenCheckEndpoint, '/api/session')
})

test('Inception OAuth adapter is registered as manual-only (no login flow)', () => {
  assert.deepEqual(getSupportedAuthMethods('inception'), ['manual'])
  const adapter = createAdapter('inception', { providerType: 'inception' } as any)
  assert.equal(adapter.getProviderType(), 'inception')
})

test('Inception has no in-app login token-extraction config', () => {
  // Inception is anonymous, so there is no login window and no cookieJar
  // capture; the native Vercel solver handles clearance.
  assert.equal(getTokenExtractionConfig('inception'), null)
})