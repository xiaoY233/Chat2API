import assert from 'node:assert/strict'
import path from 'node:path'
import test from 'node:test'

test('node runtime uses CHAT2API_DATA_DIR for data directory', async () => {
  const expected = path.resolve('tmp-chat2api-data')
  process.env.CHAT2API_DATA_DIR = expected

  const { nodeRuntime } = await import('../../out-server/main/runtime/nodeRuntime.js')

  assert.equal(nodeRuntime.getDataDir(), expected)
})

test('node runtime encrypts and decrypts when storage key is configured', async () => {
  process.env.CHAT2API_STORAGE_ENCRYPTION_KEY = 'test-secret'

  const { nodeRuntime } = await import('../../out-server/main/runtime/nodeRuntime.js')
  const encrypted = nodeRuntime.encryptString('secret-value')

  assert.notEqual(encrypted, 'secret-value')
  assert.equal(nodeRuntime.decryptString(encrypted), 'secret-value')
})
