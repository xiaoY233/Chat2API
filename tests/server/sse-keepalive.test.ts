import assert from 'node:assert/strict'
import { once } from 'node:events'
import test from 'node:test'

import { SseKeepAliveStream } from '../../src/main/proxy/utils/sseKeepAlive.ts'

const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

test('SSE keep-alive emits an immediate legal comment and remains protocol-neutral', async () => {
  const stream = new SseKeepAliveStream({ intervalMs: 10 })
  const chunks: string[] = []
  stream.setEncoding('utf8')
  stream.on('data', chunk => chunks.push(chunk))

  await new Promise(resolve => setImmediate(resolve))
  const keepAliveOutput = chunks.join('')
  // Under a loaded test runner the first interval tick can run before the
  // setImmediate callback. Every frame is still required to be a legal
  // protocol comment; the exact number of ticks is scheduler-dependent.
  assert.ok(keepAliveOutput.length >= ': keep-alive\n\n'.length)
  assert.match(keepAliveOutput, /^(?:\: keep-alive\n\n)+$/)
  assert.doesNotMatch(keepAliveOutput, /^data:/m)

  stream.end('data: [DONE]\n\n')
  await once(stream, 'close')
})

test('real SSE writes reset the keep-alive quiet period', async () => {
  const stream = new SseKeepAliveStream({ intervalMs: 30 })
  const chunks: string[] = []
  stream.setEncoding('utf8')
  stream.on('data', chunk => chunks.push(chunk))

  await new Promise(resolve => setImmediate(resolve))
  chunks.length = 0
  stream.write('data: progress\n\n')
  await wait(15)
  assert.equal(chunks.join(''), 'data: progress\n\n')

  await wait(50)
  assert.match(chunks.join(''), /: keep-alive\n\n/)
  stream.destroy()
  await once(stream, 'close')
})

test('zero disables SSE keep-alive', async () => {
  const stream = new SseKeepAliveStream({ intervalMs: 0 })
  const chunks: string[] = []
  stream.setEncoding('utf8')
  stream.on('data', chunk => chunks.push(chunk))

  await wait(35)
  assert.equal(chunks.length, 0)
  stream.end()
  await once(stream, 'close')
})
