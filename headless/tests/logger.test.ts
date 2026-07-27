import assert from 'node:assert/strict'
import test from 'node:test'
import { sanitizeLogArguments } from '../src/logger.ts'

test('log sanitizer removes labeled secrets and sensitive object fields', () => {
  const error = Object.assign(new Error('request failed with token=abc123'), {
    config: {
      headers: { Authorization: 'Bearer provider-token', Cookie: 'session=secret' },
    },
  })
  const [message, sanitizedError, object] = sanitizeLogArguments([
    'Authorization: Bearer provider-token',
    error,
    { credentials: { token: 'provider-token' }, safe: 'visible' },
  ]) as [string, Record<string, unknown>, Record<string, unknown>]

  assert.equal(message, 'Authorization: [REDACTED]')
  assert.deepEqual(sanitizedError, { name: 'Error', message: 'request failed with token=[REDACTED]' })
  assert.deepEqual(object, { credentials: '[REDACTED]', safe: 'visible' })
})

test('log sanitizer redacts JSON token values', () => {
  const [value] = sanitizeLogArguments([
    '{\n  "access_token": "access-value",\n  "refresh_token": "refresh-value"\n}',
  ]) as [string]
  assert.doesNotMatch(value, /access-value|refresh-value/)
  assert.match(value, /\[REDACTED\]/)
})
