import assert from 'node:assert/strict'
import test from 'node:test'

import {
  calculateQwenAiAdaptiveLimits,
  calculateQwenAiRequestReadyAt,
  parseQwenAiRetryAfterMs,
} from '../../src/main/proxy/qwenAiGovernorPolicy.ts'

const baseInput = {
  lastGlobalStartAt: 1_000,
  globalMinIntervalMs: 15_000,
  accountNextAvailableAt: 121_000,
  accountCooldownUntil: 0,
}

test('ordinary Qwen AI requests honor the per-account interval', () => {
  assert.equal(calculateQwenAiRequestReadyAt({
    ...baseInput,
    recoveryBypassAccountInterval: false,
  }), 121_000)
})

test('recovery skips only the per-account interval', () => {
  assert.equal(calculateQwenAiRequestReadyAt({
    ...baseInput,
    recoveryBypassAccountInterval: true,
  }), 16_000)
})

test('account failover can explicitly bypass aggregate pacing while preserving cooldowns', () => {
  assert.equal(calculateQwenAiRequestReadyAt({
    ...baseInput,
    recoveryBypassAccountInterval: true,
    recoveryBypassGlobalInterval: true,
  }), 1_000)
  assert.equal(calculateQwenAiRequestReadyAt({
    ...baseInput,
    recoveryBypassAccountInterval: true,
    recoveryBypassGlobalInterval: true,
    accountCooldownUntil: 301_000,
  }), 301_000)
})

test('recovery still honors account cooldowns', () => {
  assert.equal(calculateQwenAiRequestReadyAt({
    ...baseInput,
    accountCooldownUntil: 301_000,
    recoveryBypassAccountInterval: true,
  }), 301_000)
})

test('an active account remains unavailable until its stream is released', () => {
  assert.equal(calculateQwenAiRequestReadyAt({
    ...baseInput,
    recoveryBypassAccountInterval: true,
    accountActive: true,
  }), Number.POSITIVE_INFINITY)
})

const adaptiveBaseInput = {
  autoTuneEnabled: true,
  autoTuneMaxConcurrent: 100,
  autoTuneMinGlobalIntervalMs: 1_000,
  configuredMaxConcurrent: 3,
  configuredGlobalMinIntervalMs: 15_000,
  accountMinIntervalMs: 120_000,
  accountCount: 100,
  recentRiskEvents: 0,
  recentRiskAccountCount: 0,
}

test('adaptive Qwen AI limits scale conservatively with healthy accounts', () => {
  const expected = [
    { healthyAccountCount: 1, maxConcurrent: 1, globalMinIntervalMs: 15_000 },
    { healthyAccountCount: 4, maxConcurrent: 4, globalMinIntervalMs: 30_000 },
    { healthyAccountCount: 8, maxConcurrent: 8, globalMinIntervalMs: 15_000 },
    { healthyAccountCount: 20, maxConcurrent: 20, globalMinIntervalMs: 6_000 },
    { healthyAccountCount: 100, maxConcurrent: 100, globalMinIntervalMs: 1_200 },
  ]

  for (const scenario of expected) {
    const result = calculateQwenAiAdaptiveLimits({
      ...adaptiveBaseInput,
      healthyAccountCount: scenario.healthyAccountCount,
    })

    assert.equal(result.maxConcurrent, scenario.maxConcurrent)
    assert.equal(result.globalMinIntervalMs, scenario.globalMinIntervalMs)
  }
})

test('adaptive Qwen AI limits retain the configured concurrency and interval floors', () => {
  const result = calculateQwenAiAdaptiveLimits({
    ...adaptiveBaseInput,
    autoTuneMaxConcurrent: 4,
    autoTuneMinGlobalIntervalMs: 8_000,
    healthyAccountCount: 100,
  })

  assert.equal(result.maxConcurrent, 4)
  assert.equal(result.globalMinIntervalMs, 8_000)
  assert.equal(result.autoTuneReason, 'healthy_accounts_100')
})

test('isolated Qwen risk accounts do not collapse a large healthy pool', () => {
  const result = calculateQwenAiAdaptiveLimits({
    ...adaptiveBaseInput,
    autoTuneMaxConcurrent: 4,
    autoTuneMinGlobalIntervalMs: 8_000,
    healthyAccountCount: 91,
    recentRiskEvents: 20,
    recentRiskAccountCount: 9,
  })

  assert.equal(result.maxConcurrent, 4)
  assert.equal(result.globalMinIntervalMs, 8_792)
  assert.equal(result.autoTuneReason, 'risk_accounts_9_events_20_of_100')
})

test('widespread Qwen risk accounts proportionally reduce pool throughput', () => {
  const result = calculateQwenAiAdaptiveLimits({
    ...adaptiveBaseInput,
    autoTuneMaxConcurrent: 4,
    autoTuneMinGlobalIntervalMs: 8_000,
    healthyAccountCount: 50,
    recentRiskEvents: 80,
    recentRiskAccountCount: 50,
  })

  assert.equal(result.maxConcurrent, 2)
  assert.equal(result.globalMinIntervalMs, 16_000)
  assert.equal(result.autoTuneReason, 'risk_accounts_50_events_80_of_100')
})

test('manual Qwen AI limits are not changed by the adaptive policy', () => {
  const result = calculateQwenAiAdaptiveLimits({
    ...adaptiveBaseInput,
    autoTuneEnabled: false,
    healthyAccountCount: 100,
    configuredMaxConcurrent: 7,
    configuredGlobalMinIntervalMs: 2_500,
  })

  assert.equal(result.maxConcurrent, 7)
  assert.equal(result.globalMinIntervalMs, 2_500)
  assert.equal(result.autoTuneReason, 'manual')
})

test('Retry-After headers are parsed as seconds or HTTP dates', () => {
  assert.equal(parseQwenAiRetryAfterMs({ 'Retry-After': '2' }, 1_000), 2_000)
  assert.equal(
    parseQwenAiRetryAfterMs({ 'retry-after': new Date(5_000).toUTCString() }, 1_000),
    4_000,
  )
  assert.equal(parseQwenAiRetryAfterMs({ 'Retry-After': '-1' }, 1_000), undefined)
  assert.equal(parseQwenAiRetryAfterMs({ 'Retry-After': 'not-a-delay' }, 1_000), undefined)
  assert.equal(parseQwenAiRetryAfterMs(undefined, 1_000), undefined)
})
