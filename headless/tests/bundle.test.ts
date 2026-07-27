import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const headlessRoot = join(dirname(fileURLToPath(import.meta.url)), '..')

test('bundle excludes Electron and unsupported provider implementations', () => {
  const meta = JSON.parse(readFileSync(join(headlessRoot, 'dist', 'meta.json'), 'utf8'))
  const inputs = Object.keys(meta.inputs).join('\n').replaceAll('\\', '/')
  assert.doesNotMatch(inputs, /src\/main\/index\.ts/)
  assert.doesNotMatch(inputs, /src\/main\/oauth\//)
  assert.doesNotMatch(inputs, /src\/main\/proxy\/adapters\/(perplexity(?:-stream)?|qwen|qwen-ai|mimo)\.ts/)

  const bundle = readFileSync(join(headlessRoot, 'dist', 'server.js'), 'utf8')
  assert.doesNotMatch(bundle, /from ["']electron["']/)
})
