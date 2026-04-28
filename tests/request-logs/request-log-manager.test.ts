import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { RequestLogEntry } from '../../src/main/store/types.ts'
import type { RequestLogConfig } from '../../src/main/requestLogs/types.ts'
import { RequestLogManager } from '../../src/main/requestLogs/manager.ts'

function createConfig(overrides: Partial<RequestLogConfig> = {}): RequestLogConfig {
  return {
    enabled: true,
    maxEntries: 2,
    includeBodies: false,
    maxBodyChars: 0,
    redactSensitiveData: true,
    ...overrides,
  }
}

function createEntry(id: string, timestamp: number): RequestLogEntry {
  return {
    id,
    timestamp,
    status: 'success',
    statusCode: 200,
    method: 'POST',
    url: '/v1/chat/completions',
    model: 'gpt-test',
    responseStatus: 200,
    latency: 100,
    isStream: false,
    requestBody: JSON.stringify({ token: `secret-${id}` }),
    responseBody: 'response-body',
    userInput: `hello-${id}`,
  }
}

function createEntryInput(timestamp: number): Omit<RequestLogEntry, 'id'> {
  const { id: _id, ...rest } = createEntry('temp', timestamp)
  return rest
}

test('RequestLogManager migrates legacy request logs into standalone storage and caps them', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'request-log-manager-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))

  const manager = new RequestLogManager({
    storageDir: root,
    config: createConfig({ maxEntries: 2 }),
  })

  await manager.initialize()
  const migrated = await manager.migrateLegacyLogs([
    createEntry('1', 1),
    createEntry('2', 2),
    createEntry('3', 3),
  ])
  manager.flushSync()

  assert.equal(migrated, true)
  assert.deepEqual(
    manager.getRequestLogs().map((entry) => entry.id),
    ['3', '2'],
  )

  const persisted = readFileSync(join(root, 'request-logs.ndjson'), 'utf-8')
  assert.match(persisted, /"id":"2"/)
  assert.match(persisted, /"id":"3"/)
  assert.doesNotMatch(persisted, /secret-3/)
})

test('RequestLogManager respects disabled persistence and keeps the file empty', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'request-log-manager-disabled-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))

  const manager = new RequestLogManager({
    storageDir: root,
    config: createConfig({ enabled: false }),
  })

  await manager.initialize()
  const entry = manager.addRequestLog(createEntryInput(1))
  manager.flushSync()

  assert.ok(entry.id)
  assert.equal(manager.getRequestLogs().length, 0)
})

test('RequestLogManager buffers writes until flush', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'request-log-manager-buffered-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))

  const manager = new RequestLogManager({
    storageDir: root,
    config: createConfig({ maxEntries: 5 }),
  })

  await manager.initialize()
  manager.addRequestLog(createEntryInput(1))
  manager.addRequestLog(createEntryInput(2))

  assert.equal(existsSync(join(root, 'request-logs.ndjson')), false)

  manager.flushSync()

  const persisted = readFileSync(join(root, 'request-logs.ndjson'), 'utf-8')
  assert.match(persisted, /"timestamp":1/)
  assert.match(persisted, /"timestamp":2/)
})
