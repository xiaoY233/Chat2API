const test = require('node:test')
const assert = require('node:assert/strict')
const { readFileSync } = require('node:fs')
const { join } = require('node:path')

const root = join(__dirname, '..', '..')

test('IPC handlers use a static provider adapter registry instead of dynamic adapter imports', () => {
  const source = readFileSync(join(root, 'src/main/ipc/handlers.ts'), 'utf8')

  assert.doesNotMatch(source, /await import\('\.\.\/proxy\/adapters\//)
  assert.match(source, /const clearChatsHandlers/)
  assert.match(source, /minimax: async/)
})
