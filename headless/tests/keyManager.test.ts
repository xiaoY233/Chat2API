import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, test } from 'node:test'
import {
  decryptCredential,
  encryptCredential,
  getManagementSecret,
  resetKeyCacheForTests,
} from '../src/keyManager.ts'

let dataDirectory: string

beforeEach(() => {
  dataDirectory = mkdtempSync(join(tmpdir(), 'chat2api-headless-key-'))
  process.env.CHAT2API_DATA_DIR = dataDirectory
  delete process.env.CHAT2API_MASTER_KEY_FILE
  delete process.env.CHAT2API_MANAGEMENT_SECRET_FILE
  resetKeyCacheForTests()
})

afterEach(() => {
  resetKeyCacheForTests()
  delete process.env.CHAT2API_DATA_DIR
  rmSync(dataDirectory, { recursive: true, force: true })
})

test('credentials survive key cache resets', () => {
  const encrypted = encryptCredential('secret-token-value')
  assert.notEqual(encrypted.toString('utf8'), 'secret-token-value')

  resetKeyCacheForTests()
  assert.equal(decryptCredential(encrypted), 'secret-token-value')
  assert.equal(readFileSync(join(dataDirectory, 'master.key')).length, 32)
})

test('credential tampering is rejected', () => {
  const encrypted = encryptCredential('secret-token-value')
  encrypted[encrypted.length - 1] ^= 0xff
  assert.throws(() => decryptCredential(encrypted))
})

test('management secret is generated once and persisted', () => {
  const first = getManagementSecret()
  const second = getManagementSecret()
  assert.match(first, /^mgmt_[0-9a-f-]{36}$/)
  assert.equal(second, first)
})

test('missing master key never resets existing data', () => {
  writeFileSync(join(dataDirectory, 'data.json'), 'persisted data')
  assert.throws(() => encryptCredential('value'), /Master key is missing/)
})
