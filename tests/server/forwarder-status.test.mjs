import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'

test('forwarder preserves provider error status after retry loop', () => {
  const source = fs.readFileSync('src/main/proxy/forwarder.ts', 'utf8')

  assert.match(source, /let lastStatus: number \| undefined/)
  assert.match(source, /lastStatus = result\.status/)
  assert.match(source, /lastStatus = statusFromError\(error\)/)
  assert.match(source, /status: lastStatus/)
})

test('forwarder does not retry cancellations or completed response timeouts', () => {
  const source = fs.readFileSync('src/main/proxy/forwarder.ts', 'utf8')

  assert.match(source, /result\.status === 499/)
  assert.match(source, /lastStatus === 499[\s\S]*isQwenAiProvider && lastStatus === 504[\s\S]*\? false/)
  assert.match(source, /lastRetryable === false[\s\S]*lastStatus === 499/)
  assert.match(source, /if \(context\.signal\?\.aborted\) \{[\s\S]*lastAccountFault = undefined[\s\S]*if \(result\.status !== 499\) \{[\s\S]*lastStatus = 499/)
})

test('forwarder leaves ordinary Qwen account failover to the route instead of requeueing the same account', () => {
  const source = fs.readFileSync('src/main/proxy/forwarder.ts', 'utf8')

  assert.match(source, /const maxRetries = QwenAiAdapter\.isQwenAiProvider\(provider\)[\s\S]*requestIntent === 'context_compaction'[\s\S]*\? 0[\s\S]*recoverManagedToolStream[\s\S]*qwenAiRetryCountFromEnv\(recoverManagedToolStream\)[\s\S]*: 0[\s\S]*: config\.retryCount/)
  assert.match(source, /lastRetryScope = result\.retryScope/)
  assert.match(source, /retryScope: lastRetryScope/)
})

test('forwarder retry backoff stops promptly when the client aborts', () => {
  const source = fs.readFileSync('src/main/proxy/forwarder.ts', 'utf8')

  assert.match(source, /this\.delay\(\s*Math\.min\(nextRetryDelayMs, remainingBudgetMs\),\s*context\.signal,?\s*\)/)
  assert.match(source, /if \(!delayCompleted\) \{[\s\S]*lastStatus = 499/)
  assert.match(source, /if \(!delayCompleted\)[\s\S]*lastStatus = 499[\s\S]*lastRetryable = false/)
  assert.match(source, /private delay\(ms: number, signal\?: AbortSignal\): Promise<boolean>/)
  assert.match(source, /signal\?\.addEventListener\('abort', onAbort, \{ once: true \}\)/)
  assert.match(source, /if \(timer\) clearTimeout\(timer\)/)
  assert.match(source, /signal\?\.removeEventListener\('abort', onAbort\)/)
})
