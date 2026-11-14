import test from 'node:test'
import assert from 'node:assert/strict'

import {
  isQwenWafResponse,
  resetQwenBaxiaSessionForTests,
} from '../../src/main/proxy/adapters/qwen-baxia.ts'

test('isQwenWafResponse flags HTML challenge pages', () => {
  assert.equal(isQwenWafResponse('text/html; charset=utf-8'), true)
  assert.equal(isQwenWafResponse('text/html'), true)
  assert.equal(isQwenWafResponse('TEXT/HTML'), true)
})

test('isQwenWafResponse flags aliyun markers in JSON-typed bodies', () => {
  assert.equal(
    isQwenWafResponse('application/json', '<html><meta name="aliyun_waf_aa" content="x">'),
    true
  )
  assert.equal(isQwenWafResponse('application/json', '<!doctypehtml>'), true)
})

test('isQwenWafResponse leaves normal API responses alone', () => {
  assert.equal(
    isQwenWafResponse('application/json', '{"success":true,"data":{"id":"abc"}}'),
    false
  )
  assert.equal(isQwenWafResponse('text/event-stream'), false)
  assert.equal(isQwenWafResponse(undefined), false)
})

test('resetQwenBaxiaSessionForTests clears the cache without throwing', () => {
  assert.doesNotThrow(() => resetQwenBaxiaSessionForTests())
})