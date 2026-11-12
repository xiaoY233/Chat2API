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

test('isAuthFailure recognizes expired-token messages from DeepSeek and Kimi', () => {
  assert.equal(isAuthFailure('Authorization Failed (invalid token)'), true)
  assert.equal(isAuthFailure('Failed to acquire token: Authorization Failed (invalid token)'), true)
  assert.equal(isAuthFailure('Token invalid or expired'), true)
  assert.equal(isAuthFailure('您的授权已过期，请重新登录'), true)
  assert.equal(isAuthFailure('Kimi API error: auth.token.invalid'), true)
  assert.equal(isAuthFailure('HTTP 429 Too Many Requests'), false)
  assert.equal(isAuthFailure(''), false)
  assert.equal(isAuthFailure(undefined), false)
})

test('isRenewableProvider only allows providers with a retained login session', () => {
  assert.equal(isRenewableProvider('deepseek'), true)
  assert.equal(isRenewableProvider('kimi'), true)
  assert.equal(isRenewableProvider('glm'), false)
  assert.equal(isRenewableProvider('qwen-ai'), false)
})

test('renewAccountCredentials returns null for a non-renewable provider', async () => {
  resetAccountRenewalForTests()
  const result = await renewAccountCredentials(makeAccount('glm'), makeProvider('glm'))
  assert.equal(result, null)
})