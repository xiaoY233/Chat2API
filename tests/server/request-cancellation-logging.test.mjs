import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'
import ts from 'typescript'

function loadCancellationClassifier() {
  const source = fs.readFileSync('src/main/proxy/utils/errors.ts', 'utf8')
  const output = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
    },
  }).outputText
  const module = { exports: {} }
  new Function('require', 'module', 'exports', output)(
    () => {
      throw new Error('Unexpected dependency in error classifier test')
    },
    module,
    module.exports,
  )
  return module.exports.isClientCancellationError
}

test('client cancellation classifier separates expected disconnects from upstream failures', () => {
  const isClientCancellationError = loadCancellationClassifier()

  assert.equal(isClientCancellationError({ status: 499 }), true)
  assert.equal(isClientCancellationError({ name: 'CanceledError', code: 'ERR_CANCELED' }), true)
  assert.equal(isClientCancellationError(new Error('Qwen AI response stream aborted because the client disconnected.')), true)
  assert.equal(isClientCancellationError(new Error('Qwen AI downstream stream closed before upstream completed.')), true)

  assert.equal(isClientCancellationError(new Error('Qwen AI response stream timed out after 300s.')), false)
  assert.equal(isClientCancellationError(new Error('Qwen AI response stream closed before an upstream completion signal')), false)
  assert.equal(isClientCancellationError(new Error('Upstream request aborted by peer')), false)
  assert.equal(isClientCancellationError(new Error('Provider cancelled generation due to policy')), false)
})

test('proxy logging keeps cancellation below warning/error while preserving timeout errors', () => {
  const chatSource = fs.readFileSync('src/main/proxy/routes/chat.ts', 'utf8')
  const serverSource = fs.readFileSync('src/main/proxy/server.ts', 'utf8')
  const qwenSource = fs.readFileSync('src/main/proxy/adapters/qwen-ai.ts', 'utf8')

  assert.match(chatSource, /requestFailureLogLevel\(status: number \| undefined\)/)
  assert.match(chatSource, /if \(status === 499\) return 'debug'/)
  assert.match(chatSource, /Stream response cancelled/)
  assert.match(chatSource, /isClientCancellationError\(err\)/)
  assert.match(serverSource, /const accessLogLevel = ctx\.status === 499/)
  assert.match(serverSource, /ctx\.status >= 500[\s\S]*?['"]error['"]/)
  assert.match(serverSource, /ctx\.status >= 400[\s\S]*?['"]warn['"]/)
  assert.match(serverSource, /['"]info['"]/)
  assert.match(serverSource, /Slow successful generations are expected for long-context models/)
  assert.match(qwenSource, /isClientCancellationError\(error\)/)
  assert.match(qwenSource, /\[QwenAI\] Stream cancelled/)
  assert.match(qwenSource, /\[QwenAI\] Non-stream cancelled/)
})

test('synthesized errors only forward retry metadata from upstream headers', () => {
  const errorsSource = fs.readFileSync('src/main/proxy/utils/errors.ts', 'utf8')
  const chatSource = fs.readFileSync('src/main/proxy/routes/chat.ts', 'utf8')

  assert.match(errorsSource, /sanitizeForwardedErrorHeaders/)
  assert.match(errorsSource, /retry-after\|x-ratelimit-/)
  assert.match(errorsSource, /set-cookie|content-encoding|transfer-encoding/)
  assert.match(chatSource, /const safeErrorHeaders = sanitizeForwardedErrorHeaders\(result\.headers\)/)
})

test('chat failures preserve machine-readable error codes in responses and logs', () => {
  const chatSource = fs.readFileSync('src/main/proxy/routes/chat.ts', 'utf8')
  const requestLogTypes = fs.readFileSync('src/main/store/types.ts', 'utf8')
  const requestLogSanitizer = fs.readFileSync('src/main/requestLogs/sanitizer.ts', 'utf8')

  assert.equal(
    chatSource.match(/code: result\.errorCode \?\? null/g)?.length,
    2,
  )
  assert.match(chatSource, /errorCode: result\.errorCode/)
  assert.match(chatSource, /errorCode: failureCode/)
  assert.match(chatSource, /updateRequestLog\(logEntryId,[\s\S]*?errorCode: failureCode/)
  assert.match(requestLogTypes, /interface RequestLogEntry[\s\S]*?errorCode\?: string/)
  assert.match(requestLogSanitizer, /errorCode: truncateText\(entry\.errorCode, 200\)/)
  assert.match(requestLogSanitizer, /errorCode: truncateText\(updates\.errorCode, 200\)/)
})
