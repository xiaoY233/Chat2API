import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'
import ts from 'typescript'

import {
  DEFAULT_QWEN_AI_GOVERNOR_CONFIG,
  DEFAULT_QWEN_AI_SESSION_MODE,
  MAX_QWEN_AI_CONCURRENCY,
  normalizeQwenAiConcurrency,
  normalizeQwenAiGovernorConfig,
  normalizeQwenAiSessionMode,
} from '../../src/main/store/types.ts'

type ConfigManagerShape = {
  validate(config: Record<string, unknown>): { valid: boolean; errors: string[] }
}

function loadConfigManagerForValidation(): ConfigManagerShape {
  const source = fs.readFileSync('src/main/store/config.ts', 'utf8')
  const output = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true,
    },
  }).outputText
  const module = { exports: {} as Record<string, unknown> }
  const testRequire = (specifier: string) => {
    if (specifier === './store') return { storeManager: {} }
    if (specifier === './types') {
      return {
        DEFAULT_CONFIG: {},
        MAX_QWEN_AI_CONCURRENCY,
      }
    }
    if (specifier === '../../shared/toolCalling') {
      return { normalizeToolCallingConfig: (value: unknown) => value }
    }
    throw new Error(`Unexpected config test import: ${specifier}`)
  }

  new Function('require', 'module', 'exports', output)(testRequire, module, module.exports)
  return module.exports.default as ConfigManagerShape
}

test('Qwen governor exposes a bounded concurrency ceiling and fast new-install defaults', () => {
  assert.equal(MAX_QWEN_AI_CONCURRENCY, 100)
  assert.equal(DEFAULT_QWEN_AI_GOVERNOR_CONFIG.autoTuneMaxConcurrent, 100)
  assert.equal(DEFAULT_QWEN_AI_GOVERNOR_CONFIG.autoTuneMinGlobalIntervalMs, 1000)
  assert.equal(DEFAULT_QWEN_AI_GOVERNOR_CONFIG.maxConcurrent, 1)
})

test('Qwen tool session mode defaults to binding and preserves both supported modes', () => {
  assert.equal(DEFAULT_QWEN_AI_SESSION_MODE, 'tool-call-binding')
  assert.equal(normalizeQwenAiSessionMode(undefined), 'tool-call-binding')
  assert.equal(normalizeQwenAiSessionMode('legacy'), 'legacy')
  assert.equal(normalizeQwenAiSessionMode('tool-call-binding'), 'tool-call-binding')
  assert.equal(normalizeQwenAiSessionMode('invalid'), 'tool-call-binding')
})

test('Qwen concurrency normalization preserves valid persisted values and clamps unsafe ones', () => {
  assert.equal(normalizeQwenAiConcurrency(20, 100), 20)
  assert.equal(normalizeQwenAiConcurrency(100, 1), 100)
  assert.equal(normalizeQwenAiConcurrency(101, 1), 100)
  assert.equal(normalizeQwenAiConcurrency(0, 7), 1)
  assert.equal(normalizeQwenAiConcurrency('20', 7), 7)
  assert.equal(normalizeQwenAiConcurrency(Number.NaN, 7), 7)
})

test('Qwen governor config normalization keeps old explicit pacing values', () => {
  const normalized = normalizeQwenAiGovernorConfig({
    autoTuneMaxConcurrent: 4,
    autoTuneMinGlobalIntervalMs: 8000,
    maxConcurrent: 3,
  })

  assert.equal(normalized.autoTuneMaxConcurrent, 4)
  assert.equal(normalized.autoTuneMinGlobalIntervalMs, 8000)
  assert.equal(normalized.maxConcurrent, 3)
})

test('Qwen governor config normalization bounds persisted concurrency values', () => {
  const normalized = normalizeQwenAiGovernorConfig({
    autoTuneMaxConcurrent: 1000,
    maxConcurrent: -5,
  })

  assert.equal(normalized.autoTuneMaxConcurrent, 100)
  assert.equal(normalized.maxConcurrent, 1)
})

test('Qwen governor config normalization repairs unsafe pacing and cooldown values', () => {
  const normalized = normalizeQwenAiGovernorConfig({
    autoTuneEnabled: 'yes' as unknown as boolean,
    autoTuneMinGlobalIntervalMs: -1,
    globalMinIntervalMs: Number.NaN,
    accountMinIntervalMs: Number.POSITIVE_INFINITY,
    riskCooldownMs: 60_000,
    maxRiskCooldownMs: 1_000,
    globalRiskCooldownMs: 120_000,
    maxGlobalRiskCooldownMs: -1,
    riskWindowMs: 0,
    globalRiskThreshold: 101,
  })

  assert.equal(normalized.autoTuneEnabled, true)
  assert.equal(normalized.autoTuneMinGlobalIntervalMs, 0)
  assert.equal(normalized.globalMinIntervalMs, DEFAULT_QWEN_AI_GOVERNOR_CONFIG.globalMinIntervalMs)
  assert.equal(normalized.accountMinIntervalMs, DEFAULT_QWEN_AI_GOVERNOR_CONFIG.accountMinIntervalMs)
  assert.equal(normalized.riskCooldownMs, 60_000)
  assert.equal(normalized.maxRiskCooldownMs, 60_000)
  assert.equal(normalized.globalRiskCooldownMs, 120_000)
  assert.equal(normalized.maxGlobalRiskCooldownMs, 120_000)
  assert.equal(normalized.riskWindowMs, 1_000)
  assert.equal(normalized.globalRiskThreshold, 100)
})

test('Qwen governor API validation accepts 100 concurrent requests', () => {
  const ConfigManager = loadConfigManagerForValidation()
  const result = ConfigManager.validate({
    qwenAiGovernorConfig: {
      autoTuneMaxConcurrent: 100,
      maxConcurrent: 100,
    },
  })

  assert.deepEqual(result, { valid: true, errors: [] })
})

test('Qwen governor API validation rejects concurrency above the safety ceiling', () => {
  const ConfigManager = loadConfigManagerForValidation()
  const result = ConfigManager.validate({
    qwenAiGovernorConfig: {
      autoTuneMaxConcurrent: 101,
      maxConcurrent: 101,
    },
  })

  assert.equal(result.valid, false)
  assert.deepEqual(result.errors, [
    'qwenAiGovernorConfig.autoTuneMaxConcurrent must be between 1-100',
    'qwenAiGovernorConfig.maxConcurrent must be between 1-100',
  ])
})

test('Qwen tool session mode validation rejects unknown values', () => {
  const ConfigManager = loadConfigManagerForValidation()
  const valid = ConfigManager.validate({ qwenAiSessionMode: 'legacy' })
  const invalid = ConfigManager.validate({ qwenAiSessionMode: 'unknown' })

  assert.deepEqual(valid, { valid: true, errors: [] })
  assert.deepEqual(invalid, {
    valid: false,
    errors: ['qwenAiSessionMode must be one of: legacy, tool-call-binding'],
  })
})

test('Qwen queue admission defaults stay at 120 seconds across Docker and source', () => {
  const governorSource = fs.readFileSync('src/main/proxy/qwenAiRequestGovernor.ts', 'utf8')
  const dockerfile = fs.readFileSync('Dockerfile', 'utf8')
  const compose = fs.readFileSync('docker-compose.yml', 'utf8')
  const dockerDocs = fs.readFileSync('docs/docker.md', 'utf8')

  assert.match(governorSource, /numberFromEnv\('CHAT2API_QWEN_AI_QUEUE_TIMEOUT_MS',\s*120\s*\*\s*1000\)/)
  assert.match(dockerfile, /ENV CHAT2API_QWEN_AI_QUEUE_TIMEOUT_MS=120000/)
  assert.match(compose, /CHAT2API_QWEN_AI_QUEUE_TIMEOUT_MS:\s*\$\{CHAT2API_QWEN_AI_QUEUE_TIMEOUT_MS:-120000\}/)
  assert.match(dockerDocs, /CHAT2API_QWEN_AI_QUEUE_TIMEOUT_MS=120000/)
})
