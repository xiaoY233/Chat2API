import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

test('management route exposes tool calling status and smoke endpoint', () => {
  const source = readFileSync('src/main/proxy/routes/management/toolCalling.ts', 'utf8')

  assert.match(source, /prefix: '\/v0\/management\/tool-calling'/)
  assert.match(source, /router\.get\('\/status'/)
  assert.match(source, /router\.post\('\/smoke'/)
  assert.match(source, /managementAuthMiddleware/)
})

test('management index registers tool calling route', () => {
  const source = readFileSync('src/main/proxy/routes/management/index.ts', 'utf8')

  assert.match(source, /toolCallingRouter/)
  assert.match(source, /toolCallingRouter,/)
})
