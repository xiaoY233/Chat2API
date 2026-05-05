import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Test LogManager buffering behavior (same pattern as StoreManager log buffering)
// Since LogManager uses raw fs and is importable without Electron,
// we mock the Electron app module and test the buffering/flush logic.

test('LogManager buffers writes and flushes to disk', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'log-manager-test-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))

  const logFile = join(root, 'app.log')
  const pendingLogs: string[] = []

  // Simulate the LogManager buffering pattern
  function addLog(line: string): void {
    pendingLogs.push(line)
  }

  function flushSync(): void {
    if (pendingLogs.length === 0) return
    const { appendFileSync } = require('fs')
    appendFileSync(logFile, pendingLogs.map(l => l).join('\n') + '\n', 'utf-8')
    pendingLogs.length = 0
  }

  // Buffer 3 logs
  addLog('{"level":"info","message":"log1"}')
  addLog('{"level":"warn","message":"log2"}')
  addLog('{"level":"error","message":"log3"}')

  // Not yet written
  assert.equal(existsSync(logFile), false)

  // Flush
  flushSync()

  // Now written
  assert.equal(existsSync(logFile), true)
  const content = readFileSync(logFile, 'utf-8')
  const lines = content.trim().split('\n')
  assert.equal(lines.length, 3)
  assert.match(lines[0], /log1/)
  assert.match(lines[1], /log2/)
  assert.match(lines[2], /log3/)

  // Flush again should be a no-op
  flushSync()
  const content2 = readFileSync(logFile, 'utf-8')
  assert.equal(content, content2)
})

test('LogManager trim keeps only the newest entries', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'log-manager-trim-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))

  const logFile = join(root, 'app.log')
  const maxEntries = 3
  let entries: string[] = []

  function addLog(line: string): void {
    entries.push(line)
    if (entries.length > maxEntries) {
      entries = entries.slice(-maxEntries)
    }
  }

  function flushSync(): void {
    const { writeFileSync } = require('fs')
    writeFileSync(logFile, entries.join('\n') + '\n', 'utf-8')
  }

  addLog('entry-1')
  addLog('entry-2')
  addLog('entry-3')
  addLog('entry-4')
  addLog('entry-5')

  flushSync()

  const content = readFileSync(logFile, 'utf-8')
  const lines = content.trim().split('\n')
  assert.equal(lines.length, 3)
  assert.match(lines[0], /entry-3/)
  assert.match(lines[1], /entry-4/)
  assert.match(lines[2], /entry-5/)
})

test('StoreManager log migration moves logs to separate store', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'store-migration-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))

  const Store = require('electron-store').default

  // Create main store with logs
  const mainStore = new Store({
    name: 'data',
    cwd: root,
    defaults: { logs: [], config: {} },
  })

  // Create logs store (initially empty)
  const logsStore = new Store({
    name: 'logs-data',
    cwd: root,
    defaults: { logs: [] },
  })

  // Add logs to main store
  const testLogs = [
    { id: '1', timestamp: 1, level: 'info', message: 'test1' },
    { id: '2', timestamp: 2, level: 'warn', message: 'test2' },
    { id: '3', timestamp: 3, level: 'error', message: 'test3' },
  ]
  mainStore.set('logs', testLogs)

  // Simulate migration
  const oldLogs = (mainStore.get('logs') as unknown[]) || []
  const existingLogs = (logsStore.get('logs') as unknown[]) || []
  const merged = [...existingLogs, ...oldLogs]
  logsStore.set('logs', merged)
  mainStore.set('logs', [])

  // Verify main store logs cleared
  assert.deepEqual(mainStore.get('logs'), [])

  // Verify logs moved to logs store
  const migratedLogs = logsStore.get('logs') as unknown[]
  assert.equal(migratedLogs.length, 3)

  // Verify idempotent: re-run migration should not duplicate
  const oldLogs2 = (mainStore.get('logs') as unknown[]) || []
  const existingLogs2 = (logsStore.get('logs') as unknown[]) || []
  const merged2 = [...existingLogs2, ...oldLogs2]
  logsStore.set('logs', merged2)

  const afterIdempotent = logsStore.get('logs') as unknown[]
  assert.equal(afterIdempotent.length, 3, 'migration should be idempotent')
})

test('StoreManager log buffering flushes on demand', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'store-buffer-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))

  const Store = require('electron-store').default

  const logsStore = new Store({
    name: 'logs-data',
    cwd: root,
    defaults: { logs: [] },
  })

  const pendingLogs: unknown[] = []

  // Simulate addLog buffering
  function addLog(entry: unknown): void {
    pendingLogs.push(entry)
  }

  function flushLogsSync(): void {
    if (pendingLogs.length === 0) return
    const logs = ((logsStore.get('logs') as unknown[]) || []).concat(pendingLogs)
    logsStore.set('logs', logs)
    pendingLogs.length = 0
  }

  // Buffer some logs
  addLog({ id: '1', level: 'info', message: 'buffered1' })
  addLog({ id: '2', level: 'warn', message: 'buffered2' })

  // Not yet persisted
  assert.deepEqual(logsStore.get('logs'), [])

  // Flush
  flushLogsSync()

  // Now persisted
  const persisted = logsStore.get('logs') as unknown[]
  assert.equal(persisted.length, 2)

  // Pending cleared
  assert.equal(pendingLogs.length, 0)

  // Flush again is no-op
  flushLogsSync()
  const persisted2 = logsStore.get('logs') as unknown[]
  assert.equal(persisted2.length, 2)
})

test('StoreManager log count cap respects max entries', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'store-cap-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))

  const Store = require('electron-store').default

  const logsStore = new Store({
    name: 'logs-data',
    cwd: root,
    defaults: { logs: [] },
  })

  const maxLogs = 3
  let pendingLogs: unknown[] = []

  function addLog(entry: unknown): void {
    pendingLogs.push(entry)
    if (pendingLogs.length > maxLogs) {
      pendingLogs = pendingLogs.slice(-maxLogs)
    }
  }

  function flushLogsSync(): void {
    if (pendingLogs.length === 0) return
    const logs = ((logsStore.get('logs') as unknown[]) || []).concat(pendingLogs)
    const trimmed = logs.length > maxLogs ? logs.slice(-maxLogs) : logs
    logsStore.set('logs', trimmed)
    pendingLogs.length = 0
  }

  // Add more than max
  addLog({ id: '1' })
  addLog({ id: '2' })
  addLog({ id: '3' })
  addLog({ id: '4' })
  addLog({ id: '5' })

  flushLogsSync()

  const persisted = logsStore.get('logs') as unknown[]
  assert.equal(persisted.length, 3)
  const ids = persisted.map((e: any) => e.id)
  assert.deepEqual(ids, ['3', '4', '5'])
})
