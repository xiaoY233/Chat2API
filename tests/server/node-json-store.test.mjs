import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

test('node json store persists values under configured directory', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'chat2api-store-'))
  const { NodeJsonStore } = await import('../../out-server/main/store/storage/nodeJsonStore.js')

  const store = new NodeJsonStore({
    name: 'data',
    cwd: tempDir,
    defaults: {
      providers: [],
      accounts: [],
      config: { proxyPort: 8080 },
    },
  })

  store.set('config', { proxyPort: 18080 })

  const secondStore = new NodeJsonStore({
    name: 'data',
    cwd: tempDir,
    defaults: {},
  })

  assert.equal(secondStore.get('config').proxyPort, 18080)
  assert.ok(fs.existsSync(path.join(tempDir, 'data.json')))
})
