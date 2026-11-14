import test from 'node:test'
import assert from 'node:assert/strict'

import { QwenAiAdapter } from '../../src/main/proxy/adapters/qwen-ai.ts'
import {
  noteQwenPunished,
  resetQwenBaxiaSessionForTests,
} from '../../src/main/proxy/adapters/qwen-baxia.ts'

test('an active Qwen captcha cooldown fails fast without touching the network', async () => {
  resetQwenBaxiaSessionForTests()
  noteQwenPunished()

  // A stale/invalid token must not matter: the cooldown check runs first, so a
  // blocked account answers immediately instead of waiting on the upstream.
  const adapter = new QwenAiAdapter(
    { id: 'qwen-ai', name: 'Qwen AI (International)' } as any,
    {
      id: 'acc-cooldown',
      providerId: 'qwen-ai',
      name: 'cooldown',
      credentials: { token: 'expired-token' },
      status: 'active',
    } as any,
  )

  await assert.rejects(
    adapter.chatCompletion({
      model: 'Qwen3.8-Max',
      originalModel: 'Qwen3.8-Max',
      messages: [{ role: 'user', content: 'hi' }],
      stream: false,
    } as any),
    (error: any) => {
      assert.equal(error.name, 'QwenWafCaptchaError')
      assert.equal(error.code, 'waf_captcha')
      assert.equal(error.status, 503)
      assert.ok(error.retryAfter >= 60)
      assert.match(error.message, /cooling down/i)
      return true
    },
  )

  resetQwenBaxiaSessionForTests()
})
