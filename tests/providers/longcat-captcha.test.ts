import test from 'node:test'
import assert from 'node:assert/strict'

import {
  buildQueryString,
  computeCaptchaVerifyParam,
  encryptCaptchaPayload,
  generateAliyunSignature,
  generateArg,
  zaiCaptchaConstants,
} from '../../src/main/proxy/adapters/zai-captcha.ts'
import {
  extractLongCatDelta,
  flattenLongCatMessages,
  normalizeLongCatCookie,
  resolveLongCatOptions,
} from '../../src/main/proxy/adapters/longcat.ts'

test('Z.ai captcha helpers generate deterministic Aliyun signatures and payloads', () => {
  const params = {
    AccessKeyId: zaiCaptchaConstants.accessKeyId,
    Action: 'InitCaptchaV3',
    Timestamp: '2026-01-01T00:00:00Z',
  }
  const signature = generateAliyunSignature(params, 'test-secret')
  assert.equal(signature, generateAliyunSignature(params, 'test-secret'))
  assert.match(buildQueryString({ b: '2', a: '1' }), /^a=1&b=2$/)

  const arg = generateArg('certify-id-value')
  assert.equal(arg, generateArg('certify-id-value'))
  assert.ok(arg.length > 0)
  assert.equal(
    encryptCaptchaPayload('hello'),
    encryptCaptchaPayload(Buffer.from('hello', 'utf8')),
  )
})

test('Z.ai captcha verification returns no parameter when verification is rejected', async () => {
  const transport = {
    postForm: async () => JSON.stringify({ CertifyId: 'certify-id' }),
  }
  assert.equal(await computeCaptchaVerifyParam('', transport as any), null)
})

test('LongCat flattens messages and normalizes cookie input', () => {
  assert.equal(
    flattenLongCatMessages([
      { role: 'system', content: 'Be concise' },
      { role: 'user', content: [{ type: 'text', text: 'Hello' }] },
      { role: 'assistant', content: null },
    ]),
    'system:Be concise;user:Hello',
  )

  assert.equal(normalizeLongCatCookie('token-value'), 'passport_token_key=token-value')
  assert.equal(
    normalizeLongCatCookie('passport_token_key=abc'),
    'passport_token_key=abc',
  )
  assert.equal(normalizeLongCatCookie('a=1; b=2'), 'a=1; b=2')
  assert.equal(normalizeLongCatCookie(''), '')
})

test('LongCat model selection toggles search and reasoning flags', () => {
  assert.deepEqual(
    resolveLongCatOptions({ model: 'LongCat', messages: [] }),
    { searchEnabled: 0, reasonEnabled: 0 },
  )
  assert.deepEqual(
    resolveLongCatOptions({ model: 'LongCat-Search', messages: [] }),
    { searchEnabled: 1, reasonEnabled: 0 },
  )
  assert.deepEqual(
    resolveLongCatOptions({
      model: 'LongCat',
      messages: [],
      reasoning_effort: 'high',
    }),
    { searchEnabled: 0, reasonEnabled: 1 },
  )
})

test('LongCat delta extraction handles legacy SSE and AG-UI events', () => {
  assert.deepEqual(
    extractLongCatDelta({ choices: [{ delta: { content: 'hi' } }] }),
    { content: 'hi', reasoning: undefined, finished: false },
  )
  assert.deepEqual(
    extractLongCatDelta({ choices: [{ delta: { reasoning_content: 'think' } }] }),
    { content: undefined, reasoning: 'think', finished: false },
  )
  assert.deepEqual(
    extractLongCatDelta({ type: 'TEXT_MESSAGE_CONTENT', delta: 'hello' }),
    { content: 'hello' },
  )
  assert.deepEqual(
    extractLongCatDelta({ type: 'RUN_FINISHED' }),
    { finished: true },
  )
  assert.deepEqual(
    extractLongCatDelta({ type: 'RUN_ERROR', message: 'boom' }),
    { error: 'boom' },
  )
})
