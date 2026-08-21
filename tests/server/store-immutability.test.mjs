import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'

test('lazy provider creation avoids in-place array mutation', () => {
  const source = fs.readFileSync('src/main/store/store.ts', 'utf8')
  const match = source.match(/ensureProviderExists\(providerId: string\): void \{[\s\S]*?\n  \}/)

  assert.ok(match, 'ensureProviderExists method should exist')
  assert.equal(match[0].includes('.push('), false)
  assert.equal(match[0].includes('.splice('), false)
})
