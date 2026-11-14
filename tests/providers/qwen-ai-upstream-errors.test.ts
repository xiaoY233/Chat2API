import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { extractQwenUpstreamError } from '../../src/main/proxy/adapters/qwen-ai.ts'

const root = join(dirname(fileURLToPath(import.meta.url)), '../..')

test('Qwen upstream JSON errors are recognized instead of becoming empty answers', () => {
  assert.deepEqual(
    extractQwenUpstreamError({
      success: false,
      data: { code: 'Not_Found', details: 'Model not found' },
    }),
    { message: 'Model not found', code: 'Not_Found' }
  )

  assert.deepEqual(
    extractQwenUpstreamError({
      error: { code: 'invalid_request', message: 'bad request' },
    }),
    { message: 'bad request', code: 'invalid_request' }
  )

  assert.deepEqual(
    extractQwenUpstreamError({ success: false }),
    { message: 'Qwen upstream returned an error', code: undefined }
  )
})

test('Aliyun WAF captcha challenges are surfaced instead of empty answers', () => {
  const challenge = extractQwenUpstreamError({
    ret: ['FAIL_SYS_USER_VALIDATE', 'RGV587_ERROR::SM::blocked'],
    data: {
      url: 'https://chat.qwen.ai:443//api/v2/chat/completions/_____tmd_____/punish?x5secdata=x&action=captcha',
    },
  })
  assert.equal(challenge?.code, 'waf_captcha')
  assert.match(challenge?.message ?? '', /captcha/i)
  assert.match(challenge?.message ?? '', /rate-limited/i)
})

test('successful Qwen payloads are not treated as errors', () => {
  assert.equal(extractQwenUpstreamError({ success: true, data: { code: 'OK' } }), null)
  assert.equal(
    extractQwenUpstreamError({
      choices: [{ delta: { content: 'hello' } }],
    }),
    null
  )
  assert.equal(extractQwenUpstreamError(null), null)
  assert.equal(extractQwenUpstreamError('not json'), null)
})

test('both streaming and non-streaming handlers surface upstream JSON errors', () => {
  const source = readFileSync(
    join(root, 'src/main/proxy/adapters/qwen-ai.ts'),
    'utf8'
  )

  // Stream: error SSE event before the terminal [DONE], guarded against
  // writing after the stream has already ended.
  assert.match(source, /const failStream = \(error: QwenUpstreamError\)/)
  assert.match(source, /type: 'api_error'/)
  assert.match(source, /code: error\.code \?\? 'upstream_error'/)
  assert.match(source, /let streamEnded = false/)
  assert.match(source, /if \(streamEnded\) return/)

  // Non-stream: reject so the proxy returns an error instead of empty content.
  assert.match(source, /rejectOnce\(new Error\(`Qwen AI: \$\{upstreamError\.message\}`\)\)/)

  // Raw application/json bodies are checked before the SSE parser, which
  // ignores lines that do not start with `data:`.
  assert.match(source, /if \(trimmed\.startsWith\('\{'\)\)/)

  // Aliyun bxpunish is detected from the response header so the client gets
  // a clear captcha error instead of an empty 200 answer.
  assert.match(source, /private isPunishedResponse\(response: AxiosResponse\)/)
  assert.match(source, /WAF_CAPTCHA_MESSAGE/)
  assert.match(source, /this\.isPunishedResponse\(response\)/)
})
