import test from 'node:test'
import assert from 'node:assert/strict'

import {
  isAuthFailure,
  isRenewableProvider,
  renewAccountCredentials,
  resetAccountRenewalForTests,
} from '../../src/main/proxy/accountRenewal.ts'
import type { Account, Provider } from '../../src/main/store/types.ts'

function makeAccount(providerId: string): Account {
  return {
    id: 'acc-1',
    providerId,
    name: 'test',
    credentials: { token: 'old-token' },
    status: 'active',
    createdAt: 0,
    updatedAt: 0,
  }
}

function makeProvider(id: string): Provider {
  return {
    id,
    name: id,
    type: 'builtin',
    authType: 'userToken',
    apiEndpoint: 'https://example.com',
    headers: {},
    enabled: true,
    createdAt: 0,
    updatedAt: 0,
  }
}

test('isAuthFailure recognizes expired-token messages from every renewable provider', () => {
  assert.equal(isAuthFailure('Authorization Failed (invalid token)'), true)
  assert.equal(isAuthFailure('Failed to acquire token: Authorization Failed (invalid token)'), true)
  assert.equal(isAuthFailure('Token invalid or expired'), true)
  assert.equal(isAuthFailure('Token expired or invalid'), true)
  assert.equal(isAuthFailure('Token refresh failed: Invalid refresh token'), true)
  assert.equal(isAuthFailure('HTTP 401 Unauthorized'), true)
  assert.equal(isAuthFailure('LongCat cookie expired or invalid, please log in again'), true)
  assert.equal(isAuthFailure('LongCat session is not logged in'), true)
  assert.equal(isAuthFailure('session token is invalid'), true)
  assert.equal(
    isAuthFailure('Failed to create chat: Your session has expired, or the token is no longer valid. Please sign in again to proceed.'),
    true
  )
  assert.equal(isAuthFailure('您的授权已过期，请重新登录'), true)
  assert.equal(isAuthFailure('登录已失效'), true)
  assert.equal(isAuthFailure('Kimi API error: auth.token.invalid'), true)
  assert.equal(isAuthFailure('HTTP 429 Too Many Requests'), false)
  assert.equal(isAuthFailure('Failed to create chat: HTTP 500'), false)
  assert.equal(isAuthFailure(''), false)
  assert.equal(isAuthFailure(undefined), false)
})

test('isRenewableProvider allows every provider with an in-app login session', () => {
  for (const providerId of [
    'deepseek',
    'glm',
    'kimi',
    'qwen',
    'qwen-ai',
    'zai',
    'minimax',
    'mimo',
    'perplexity',
    'longcat',
  ]) {
    assert.equal(isRenewableProvider(providerId), true, providerId)
  }
  assert.equal(isRenewableProvider('inception'), false)
  assert.equal(isRenewableProvider('custom'), false)
})

test('renewAccountCredentials returns null for a non-renewable provider', async () => {
  resetAccountRenewalForTests()
  const result = await renewAccountCredentials(makeAccount('custom'), makeProvider('custom'))
  assert.equal(result, null)
})