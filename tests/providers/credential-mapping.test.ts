import test from 'node:test'
import assert from 'node:assert/strict'

import { normalizeRenewedCredentials } from '../../src/main/oauth/credentialMapping.ts'

test('DeepSeek login token is stored under the key the adapter reads', () => {
  const out = normalizeRenewedCredentials('deepseek', { userToken: 'new-token' })
  assert.equal(out.token, 'new-token')
  assert.equal(out.userToken, 'new-token')
})

test('GLM refresh token is normalized to refresh_token', () => {
  const out = normalizeRenewedCredentials('glm', { chatglm_refresh_token: 'new-refresh' })
  assert.equal(out.refresh_token, 'new-refresh')
})

test('Qwen CN ticket is normalized to ticket', () => {
  const out = normalizeRenewedCredentials('qwen', { tongyi_sso_ticket: 'new-ticket' })
  assert.equal(out.ticket, 'new-ticket')
})

test('Qwen AI and Kimi tokens pass through', () => {
  assert.equal(normalizeRenewedCredentials('qwen-ai', { token: 'qwen' }).token, 'qwen')
  assert.equal(normalizeRenewedCredentials('kimi', { token: 'kimi' }).token, 'kimi')
})

test('MiniMax realUserID is preserved', () => {
  const out = normalizeRenewedCredentials('minimax', {
    token: 'jwt',
    realUserID: 'user-1',
  })
  assert.equal(out.token, 'jwt')
  assert.equal(out.realUserID, 'user-1')

  const fromDetail = normalizeRenewedCredentials('minimax', {
    token: 'jwt',
    user_detail_agent: JSON.stringify({ realUserID: 'user-2' }),
  })
  assert.equal(fromDetail.realUserID, 'user-2')
})

test('Mimo cookies are normalized to snake_case keys', () => {
  const out = normalizeRenewedCredentials('mimo', {
    serviceToken: 'service',
    userId: 'user',
    xiaomichatbot_ph: 'ph',
  })
  assert.equal(out.service_token, 'service')
  assert.equal(out.user_id, 'user')
  assert.equal(out.ph_token, 'ph')
})

test('Perplexity session cookie is normalized to sessionToken', () => {
  const out = normalizeRenewedCredentials('perplexity', {
    '__Secure-next-auth.session-token': 'session',
  })
  assert.equal(out.sessionToken, 'session')
})

test('LongCat cookie jar becomes cookie and clears a stale passport', () => {
  const out = normalizeRenewedCredentials('longcat', {
    cookieJar: 'passport_token_key=fresh; _lxsdk_cuid=abc',
    passport_token_key: 'stale',
  })
  assert.equal(out.cookie, 'passport_token_key=fresh; _lxsdk_cuid=abc')
  assert.equal(out.passport_token_key, 'fresh')
})

test('unknown providers keep their credentials unchanged', () => {
  const raw = { token: 'value', extra: 'kept' }
  const out = normalizeRenewedCredentials('custom', raw)
  assert.deepEqual(out, raw)
})
