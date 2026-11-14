import test from 'node:test'
import assert from 'node:assert/strict'

import {
  extractCookieValue,
  extractQwenAiRefreshToken,
  extractRefreshTokenFromSetCookie,
  getJwtExpiryMs,
  isJwtExpired,
  isQwenAiTokenExpiring,
  normalizeCookieHeader,
  replaceCookieValue,
} from '../../src/main/oauth/qwenAiAuth.ts'
import { refreshQwenAiToken } from '../../src/main/oauth/qwenAiRefresh.ts'
import { getTokenExtractionConfig } from '../../src/main/oauth/tokenExtractionConfig.ts'

function jwt(payload: Record<string, unknown>): string {
  const encode = (value: unknown) =>
    Buffer.from(JSON.stringify(value)).toString('base64url')
  return `${encode({ alg: 'HS256', typ: 'JWT' })}.${encode(payload)}.signature`
}

test('Qwen AI login extracts the current localStorage token state and refresh cookie', () => {
  const config = getTokenExtractionConfig('qwen-ai')
  assert.ok(config)
  const localKeys = config!.tokenSources
    .filter((source) => source.type === 'localStorage')
    .map((source) => source.key)
  const cookieKeys = config!.tokenSources
    .filter((source) => source.type === 'cookie')
    .map((source) => source.key)

  assert.ok(localKeys.includes('qwen_access_token_state'))
  assert.ok(localKeys.includes('token'))
  assert.ok(cookieKeys.includes('refresh_token'))
  assert.ok(config!.targetDomains.includes('auth.qwen.ai'))
})

test('cookie helpers normalize objects and replace a single cookie', () => {
  assert.equal(
    normalizeCookieHeader({ cna: 'abc', refresh_token: 'refresh-1' }),
    'cna=abc; refresh_token=refresh-1',
  )
  assert.equal(extractCookieValue('cna=abc; refresh_token=refresh-1', 'refresh_token'), 'refresh-1')
  assert.equal(
    replaceCookieValue('cna=abc; refresh_token=old', 'refresh_token', 'new'),
    'cna=abc; refresh_token=new',
  )
  assert.equal(
    replaceCookieValue('cna=abc', 'refresh_token', 'new'),
    'cna=abc; refresh_token=new',
  )
})

test('refresh token is found in an explicit field, cookie object or cookie string', () => {
  assert.equal(
    extractQwenAiRefreshToken({ token: 'access', refresh_token: 'explicit' }),
    'explicit',
  )
  assert.equal(
    extractQwenAiRefreshToken({ token: 'access', cookies: { refresh_token: 'object' } }),
    'object',
  )
  assert.equal(
    extractQwenAiRefreshToken({ token: 'access', cookies: 'cna=abc; refresh_token=header' }),
    'header',
  )
  assert.equal(extractQwenAiRefreshToken({ token: 'access', cookies: 'cna=abc' }), '')
})

test('a rotated refresh token is read from Set-Cookie', () => {
  assert.equal(
    extractRefreshTokenFromSetCookie({
      'set-cookie': ['acw_tc=x; Path=/', 'refresh_token=rotated; Path=/; HttpOnly; Max-Age=25920000'],
    }),
    'rotated',
  )
  assert.equal(extractRefreshTokenFromSetCookie({ 'set-cookie': 'cna=x' }), '')
})

test('expired JWTs are rejected while fresh tokens stay usable', () => {
  const nowSeconds = Math.floor(Date.now() / 1000)
  const expired = jwt({ sub: 'user', exp: nowSeconds - 60 })
  const fresh = jwt({ sub: 'user', exp: nowSeconds + 3600 })

  assert.equal(getJwtExpiryMs(expired), (nowSeconds - 60) * 1000)
  assert.equal(isJwtExpired(expired), true)
  assert.equal(isJwtExpired(fresh), false)
  assert.equal(isQwenAiTokenExpiring(fresh), false)
  assert.equal(isQwenAiTokenExpiring(jwt({ sub: 'user', exp: nowSeconds + 60 })), true)
  assert.equal(isJwtExpired('opaque-token'), false)
})

test('refresh reports no-session when neither the account nor the session has a refresh token', async () => {
  const result = await refreshQwenAiToken({ token: 'expired-access-token' })
  assert.equal(result.status, 'no-session')
})
