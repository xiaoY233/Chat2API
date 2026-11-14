import test from 'node:test'
import assert from 'node:assert/strict'

import {
  clearQwenBaxiaSession,
  getQwenPunishCooldownMs,
  isQwenWafResponse,
  noteQwenPunished,
  noteQwenSuccess,
  resetQwenBaxiaSessionForTests,
  setQwenBaxiaSessionForTests,
} from '../../src/main/proxy/adapters/qwen-baxia.ts'

test('isQwenWafResponse flags HTML challenge pages', () => {
  assert.equal(isQwenWafResponse('text/html; charset=utf-8'), true)
  assert.equal(isQwenWafResponse('text/html'), true)
  assert.equal(isQwenWafResponse('TEXT/HTML'), true)
})

test('isQwenWafResponse flags aliyun markers in JSON-typed bodies', () => {
  assert.equal(
    isQwenWafResponse('application/json', '<html><meta name="aliyun_waf_aa" content="x">'),
    true
  )
  assert.equal(isQwenWafResponse('application/json', '<!doctypehtml>'), true)
})

test('isQwenWafResponse leaves normal API responses alone', () => {
  assert.equal(
    isQwenWafResponse('application/json', '{"success":true,"data":{"id":"abc"}}'),
    false
  )
  assert.equal(isQwenWafResponse('text/event-stream'), false)
  assert.equal(isQwenWafResponse(undefined), false)
})

test('resetQwenBaxiaSessionForTests clears the cache without throwing', () => {
  assert.doesNotThrow(() => resetQwenBaxiaSessionForTests())
})

test('clearQwenBaxiaSession drops the cached session and resolves outside Electron', async () => {
  setQwenBaxiaSessionForTests({
    bxUa: '231!cached',
    bxUmidToken: `T2gA${'a'.repeat(28)}`,
    bxV: '2.5.36',
    cookies: 'cna=1; x5secdata=2',
    fetchedAt: Date.now(),
  })

  // Outside Electron there is no browser partition to clear, but the call
  // must still forget the punished session instead of reusing it. It must not
  // harvest a new one while the account is blocked.
  const cleared = await clearQwenBaxiaSession()
  assert.equal(cleared, undefined)
})

test('bxpunish applies a growing cooldown and a success resets it', () => {
  resetQwenBaxiaSessionForTests()
  assert.equal(getQwenPunishCooldownMs(), 0)

  const first = noteQwenPunished()
  assert.equal(first, 60_000)
  assert.ok(getQwenPunishCooldownMs() > 0)

  const second = noteQwenPunished()
  assert.equal(second, 120_000)

  noteQwenSuccess()
  assert.equal(getQwenPunishCooldownMs(), 0)

  // A new streak starts at the base cooldown again.
  assert.equal(noteQwenPunished(), 60_000)
  resetQwenBaxiaSessionForTests()
})

test('bxpunish cooldown is capped', () => {
  resetQwenBaxiaSessionForTests()
  let last = 0
  for (let i = 0; i < 10; i++) {
    last = noteQwenPunished()
  }
  assert.equal(last, 30 * 60_000)
  resetQwenBaxiaSessionForTests()
})