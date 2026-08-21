import assert from 'node:assert/strict'
import { PassThrough, Readable } from 'node:stream'
import test from 'node:test'

import {
  BufferedSseError,
  bufferValidatedSseStream,
} from '../../src/main/proxy/utils/validatedSseStream.ts'

async function collect(stream: NodeJS.ReadableStream): Promise<string> {
  let output = ''
  for await (const chunk of stream as Readable) {
    output += chunk.toString()
  }
  return output
}

test('validated SSE buffering replays a complete stream byte-for-byte', async () => {
  const input = [
    'data: {"choices":[{"delta":{"role":"assistant"}}]}\n\n',
    'data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\n',
    'data: [DONE]\n\n',
  ].join('')

  const replay = await bufferValidatedSseStream(Readable.from([input]))

  assert.equal(await collect(replay), input)
})

test('validated SSE buffering rejects an upstream error before replay', async () => {
  const input = [
    'data: {"choices":[{"delta":{"reasoning_content":"partial"}}]}\n\n',
    'event: error\n',
    'data: {"error":{"message":"malformed tool block","type":"tool_call_parse_error","code":"malformed_tool_call","accountFault":false}}\n\n',
    'data: [DONE]\n\n',
  ].join('')

  await assert.rejects(
    bufferValidatedSseStream(Readable.from([input])),
    (error) => {
      assert.ok(error instanceof BufferedSseError)
      assert.equal(error.message, 'malformed tool block')
      assert.equal(error.type, 'tool_call_parse_error')
      assert.equal(error.code, 'malformed_tool_call')
      assert.equal(error.status, 502)
      assert.equal(error.accountFault, false)
      return true
    },
  )
})

test('validated SSE buffering enforces its configured memory limit', async () => {
  await assert.rejects(
    bufferValidatedSseStream(Readable.from(['data: 123456789\n\n']), { maxBytes: 8 }),
    (error) => (
      error instanceof BufferedSseError
      && error.code === 'validated_stream_too_large'
      && error.status === 502
    ),
  )
})

test('validated SSE buffering rejects a stream without DONE', async () => {
  const input = 'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n'

  await assert.rejects(
    bufferValidatedSseStream(Readable.from([input])),
    (error) => (
      error instanceof BufferedSseError
      && error.code === 'validated_stream_missing_done'
      && error.status === 502
    ),
  )
})

test('validated SSE buffering rejects DONE without a finish reason', async () => {
  const input = [
    'data: {"choices":[{"delta":{"content":"partial"},"finish_reason":null}]}\n\n',
    'data: [DONE]\n\n',
  ].join('')

  await assert.rejects(
    bufferValidatedSseStream(Readable.from([input])),
    (error) => (
      error instanceof BufferedSseError
      && error.code === 'validated_stream_missing_finish'
      && error.status === 502
    ),
  )
})

test('validated SSE buffering preserves timeout and client cancellation status', async () => {
  const timeoutInput = [
    'event: error\n',
    'data: {"error":{"message":"Qwen AI response stream timed out after 600s.","type":"upstream_stream_error"}}\n\n',
    'data: [DONE]\n\n',
  ].join('')

  await assert.rejects(
    bufferValidatedSseStream(Readable.from([timeoutInput])),
    (error) => error instanceof BufferedSseError && error.status === 504,
  )

  const controller = new AbortController()
  const input = new Readable({ read() {} })
  const pending = bufferValidatedSseStream(input, { signal: controller.signal })
  controller.abort()

  await assert.rejects(
    pending,
    (error) => error instanceof BufferedSseError && error.code === 'ERR_CANCELED' && error.status === 499,
  )
  input.destroy()
})

test('validated SSE buffering preserves Qwen incomplete and empty stream codes', async () => {
  for (const code of ['qwen_ai_stream_incomplete', 'qwen_ai_empty_stream']) {
    const input = [
      'event: error\n',
      `data: {"error":{"message":"upstream stream validation failed","type":"upstream_stream_error","code":"${code}"}}\n\n`,
      'data: [DONE]\n\n',
    ].join('')

    await assert.rejects(
      bufferValidatedSseStream(Readable.from([input])),
      (error) => (
        error instanceof BufferedSseError
        && error.code === code
        && error.status === 502
      ),
    )
  }
})

test('validated SSE buffering preserves controlled Qwen status and retry metadata', async () => {
  const cases = [
    { status: 403, code: 'qwen_ai_risk_control', message: 'risk control', retryable: false },
    { status: 429, code: 'qwen_ai_stream_error', message: 'rate limit', retryable: false },
    { status: 503, code: 'upstream_unavailable', message: 'upstream unavailable', retryable: true },
    { status: 503, code: 'qwen_ai_upstream_busy', message: 'RGV587 请稍后重试', retryable: true },
  ]

  for (const item of cases) {
    const input = [
      'event: error\n',
      `data: {"error":{"message":"${item.message}","type":"upstream_stream_error","code":"${item.code}","status":${item.status},"retryable":${item.retryable}}}\n\n`,
      'data: [DONE]\n\n',
    ].join('')

    await assert.rejects(
      bufferValidatedSseStream(Readable.from([input])),
      (error) => (
        error instanceof BufferedSseError
        && error.code === item.code
        && error.status === item.status
        && error.retryable === item.retryable
      ),
    )
  }
})

test('validated SSE buffering releases a long response after the hold deadline', async () => {
  const input = new PassThrough() as PassThrough & { upstreamFailure?: Error }
  const first = 'data: {"choices":[{"delta":{"content":"first"},"finish_reason":null}]}\n\n'
  const last = [
    'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n',
    'data: [DONE]\n\n',
  ].join('')

  const startedAt = Date.now()
  const pending = bufferValidatedSseStream(input, {
    maxHoldMs: 20,
    forwardEvents: ['upstream-failure'],
    forwardProperties: ['upstreamFailure'],
  })
  input.write(first)

  const live = await pending as PassThrough & { upstreamFailure?: Error }
  assert.ok(Date.now() - startedAt < 500, 'live stream should be exposed before the source ends')

  const failure = new Error('late upstream failure')
  const eventPromise = onceEvent(live, 'upstream-failure')
  input.upstreamFailure = failure
  input.emit('upstream-failure', failure)
  input.end(last)

  assert.equal((await eventPromise)[0], failure)
  assert.equal(live.upstreamFailure, failure)
  assert.equal(await collect(live), `${first}${last}`)
})

test('validated SSE buffering emits a legal SSE keep-alive when the hold has no data', async () => {
  const input = new PassThrough()
  const pending = bufferValidatedSseStream(input, { maxHoldMs: 10 })
  const live = await pending
  input.end([
    'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n',
    'data: [DONE]\n\n',
  ].join(''))

  assert.match(await collect(live), /^: keep-alive\n\n/)
})

test('validated SSE live release destroys its source when the downstream closes early', async () => {
  const input = new PassThrough({ autoDestroy: false })
  const pending = bufferValidatedSseStream(input, { maxHoldMs: 10 })
  const live = await pending
  const sourceClosed = onceEvent(input, 'close')

  live.destroy()
  await sourceClosed

  assert.equal(input.destroyed, true)
})

test('validated SSE live release does not cancel a source that ended normally', async () => {
  const input = new PassThrough({ autoDestroy: false })
  const pending = bufferValidatedSseStream(input, { maxHoldMs: 10 })
  const live = await pending
  const completed = collect(live)

  input.end([
    'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n',
    'data: [DONE]\n\n',
  ].join(''))

  await completed
  assert.equal(input.destroyed, false)
  input.destroy()
})

test('validated SSE live release propagates a late source error', async () => {
  const input = new PassThrough()
  const pending = bufferValidatedSseStream(input, { maxHoldMs: 10 })
  const live = await pending
  const outputError = onceEvent(live, 'error')
  live.resume()

  const failure = new Error('late source failure')
  input.destroy(failure)

  assert.equal((await outputError)[0], failure)
})

test('validated SSE live release aborts both streams with a 499 cancellation', async () => {
  const controller = new AbortController()
  const input = new PassThrough()
  const pending = bufferValidatedSseStream(input, {
    maxHoldMs: 10,
    signal: controller.signal,
  })
  const live = await pending
  const outputError = onceEvent(live, 'error')
  live.resume()

  controller.abort()
  const [failure] = await outputError

  assert.ok(failure instanceof BufferedSseError)
  assert.equal(failure.status, 499)
  assert.equal(failure.code, 'ERR_CANCELED')
  assert.equal(input.destroyed, true)
  assert.equal((live as Readable).destroyed, true)
})

function onceEvent(stream: NodeJS.EventEmitter, event: string): Promise<unknown[]> {
  return new Promise(resolve => stream.once(event, (...args: unknown[]) => resolve(args)))
}
