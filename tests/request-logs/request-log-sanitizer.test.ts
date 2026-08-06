import test from 'node:test'
import assert from 'node:assert/strict'

import type { RequestLogEntry } from '../../src/main/store/types.ts'
import type { RequestLogConfig } from '../../src/main/requestLogs/types.ts'
import {
  sanitizeRequestLogEntry,
  sanitizeRequestLogUpdates,
  trimRequestLogsToMaxEntries,
} from '../../src/main/requestLogs/sanitizer.ts'

function createEntry(overrides: Partial<RequestLogEntry> = {}): Omit<RequestLogEntry, 'id'> {
  return {
    timestamp: 1_746_000_000_000,
    status: 'success',
    statusCode: 200,
    method: 'POST',
    url: '/v1/chat/completions',
    model: 'gpt-test',
    responseStatus: 200,
    latency: 123,
    isStream: false,
    requestBody: JSON.stringify({
      authorization: 'Bearer secret-token',
      nested: { api_key: 'super-secret' },
    }),
    responseBody: 'x'.repeat(128),
    responsePreview: 'y'.repeat(64),
    userInput: 'z'.repeat(600),
    errorMessage: 'e'.repeat(80),
    errorStack: 'very long stack trace',
    ...overrides,
  }
}

function createConfig(overrides: Partial<RequestLogConfig> = {}): RequestLogConfig {
  return {
    enabled: true,
    maxEntries: 2,
    includeBodies: true,
    maxBodyChars: 32,
    redactSensitiveData: true,
    ...overrides,
  }
}

test('sanitizeRequestLogEntry redacts and truncates persisted fields', () => {
  const sanitized = sanitizeRequestLogEntry(createEntry(), createConfig())

  assert.equal(sanitized.errorStack, undefined)
  assert.ok(sanitized.userInput?.includes('[truncated'))
  assert.ok(sanitized.requestBody?.includes('[REDACTED]'))
  assert.ok(sanitized.requestBody?.includes('[truncated'))
  assert.ok(sanitized.responseBody?.includes('[truncated'))
})

test('sanitizeRequestLogEntry drops request and response bodies when disabled', () => {
  const sanitized = sanitizeRequestLogEntry(
    createEntry(),
    createConfig({ includeBodies: false }),
  )

  assert.equal(sanitized.requestBody, undefined)
  assert.equal(sanitized.responseBody, undefined)
  assert.equal(sanitized.errorStack, undefined)
})

test('sanitizeRequestLogUpdates applies the same persistence rules to updates', () => {
  const sanitized = sanitizeRequestLogUpdates(
    {
      requestBody: JSON.stringify({ token: 'secret-token' }),
      responseBody: 'x'.repeat(128),
      errorStack: 'stack',
    },
    createConfig(),
  )

  assert.equal(sanitized.errorStack, undefined)
  assert.ok(sanitized.requestBody?.includes('[REDACTED]'))
  assert.ok(sanitized.responseBody?.includes('[truncated'))
})

test('trimRequestLogsToMaxEntries keeps the newest entries only', () => {
  const trimmed = trimRequestLogsToMaxEntries(
    [
      { id: '1', ...createEntry({ timestamp: 1 }) },
      { id: '2', ...createEntry({ timestamp: 2 }) },
      { id: '3', ...createEntry({ timestamp: 3 }) },
    ],
    createConfig({ maxEntries: 2 }),
  )

  assert.deepEqual(
    trimmed.map((entry) => entry.id),
    ['2', '3'],
  )
})
