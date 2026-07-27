import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, test } from 'node:test'
import ElectronStore from '../src/shims/electron-store.ts'
import { resetKeyCacheForTests } from '../src/keyManager.ts'

let root: string
let storeDirectory: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'chat2api-headless-store-'))
  storeDirectory = join(root, 'store')
  process.env.CHAT2API_DATA_DIR = join(root, 'security')
  resetKeyCacheForTests()
})

afterEach(() => {
  resetKeyCacheForTests()
  delete process.env.CHAT2API_DATA_DIR
  rmSync(root, { recursive: true, force: true })
})

test('store preserves defaults and values across instances', () => {
  const defaults = { config: { port: 8080 }, accounts: [] as string[] }
  const first = new ElectronStore({ name: 'data', cwd: storeDirectory, defaults })
  first.set('accounts', ['account-1'])

  resetKeyCacheForTests()
  const second = new ElectronStore({ name: 'data', cwd: storeDirectory, defaults })
  assert.deepEqual(second.get('config'), { port: 8080 })
  assert.deepEqual(second.get('accounts'), ['account-1'])
})

test('store data cannot be opened with a different master key', () => {
  const first = new ElectronStore({ name: 'data', cwd: storeDirectory, defaults: { value: '' } })
  first.set('value', 'persisted-secret')

  process.env.CHAT2API_DATA_DIR = join(root, 'different-security')
  resetKeyCacheForTests()
  assert.throws(() => new ElectronStore({ name: 'data', cwd: storeDirectory }))
})
