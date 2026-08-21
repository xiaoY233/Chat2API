import assert from 'node:assert/strict'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import test from 'node:test'
import ts from 'typescript'

const require = createRequire(import.meta.url)

function loadTypeScriptModule(path, localModules = {}) {
  const source = fs.readFileSync(path, 'utf8')
  const output = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText
  const loaded = { exports: {} }
  const testRequire = specifier => {
    if (Object.prototype.hasOwnProperty.call(localModules, specifier)) {
      return localModules[specifier]
    }
    return require(specifier)
  }
  new Function('require', 'module', 'exports', output)(testRequire, loaded, loaded.exports)
  return loaded.exports
}

test('Qwen built-in fallback advertises only the current website catalogue', () => {
  const { qwenAiConfig } = loadTypeScriptModule('src/main/providers/builtin/qwen-ai.ts')

  assert.deepEqual(qwenAiConfig.supportedModels, [
    'Qwen3.8-Max',
    'Qwen3.8-Max_Fast',
    'Qwen3.8-Max_Auto',
    'Qwen3.8-Max_Thinking',
    'Qwen3.7-Plus',
    'Qwen3.7-Max',
  ])
  assert.equal(qwenAiConfig.modelMappings['Qwen3.8-Max'], 'qwen3.8-max')
  assert.equal(qwenAiConfig.modelMappings['Qwen3.8-Max_Fast'], 'qwen3.8-max')
  assert.equal(qwenAiConfig.modelMappings['Qwen3.8-Max_Auto'], 'qwen3.8-max')
  assert.equal(qwenAiConfig.modelMappings['Qwen3.8-Max_Thinking'], 'qwen3.8-max')
  assert.equal(
    qwenAiConfig.modelMappings['Qwen3.8-Max-Preview'],
    'qwen3.8-max-preview',
    'the old request name remains a compatibility mapping without being advertised',
  )
})

test('Qwen3.8-Max aliases resolve two independent switches and normalize upstream names', () => {
  const {
    normalizeQwenAiModelModeName,
    resolveQwenAiModelMode,
    withQwenAiModelModeAliases,
  } = loadTypeScriptModule('src/main/providers/qwen-ai-model-mode.ts')

  const cases = [
    ['Qwen3.8-Max', true, false, false],
    ['Qwen3.8-Max_Fast', false, false, true],
    ['Qwen3.8-Max_Auto', true, true, true],
    ['Qwen3.8-Max_Thinking', true, false, true],
    ['Qwen3.8-Max_TeT_AtT', true, true, true],
    ['Qwen3.8-Max_TeF_AtT', false, true, true],
    ['Qwen3.8-Max_TeT_AtF', true, false, true],
    ['Qwen3.8-Max_TeF_AtF', false, false, true],
  ]

  for (const [model, thinkingEnabled, autoThinking, isExplicit] of cases) {
    assert.deepEqual(resolveQwenAiModelMode(model), {
      baseModel: 'Qwen3.8-Max',
      thinkingEnabled,
      autoThinking,
      isExplicit,
    }, model)
    assert.equal(normalizeQwenAiModelModeName(model), 'Qwen3.8-Max', model)
  }

  const expanded = withQwenAiModelModeAliases({
    supportedModels: ['Qwen3.8-Max', 'Qwen3.7-Plus'],
    modelMappings: {
      'Qwen3.8-Max': 'qwen3.8-max',
      'Qwen3.7-Plus': 'qwen3.7-plus',
    },
  })

  assert.deepEqual(expanded.supportedModels.slice(0, 2), ['Qwen3.8-Max', 'Qwen3.7-Plus'])
  assert.ok(expanded.supportedModels.includes('Qwen3.8-Max_Fast'))
  assert.ok(expanded.supportedModels.includes('Qwen3.8-Max_Auto'))
  assert.ok(expanded.supportedModels.includes('Qwen3.8-Max_Thinking'))
  assert.equal(expanded.modelMappings['Qwen3.8-Max_Fast'], 'qwen3.8-max')
  assert.equal(expanded.modelMappings['Qwen3.8-Max_Auto'], 'qwen3.8-max')
  assert.equal(expanded.modelMappings['Qwen3.8-Max_Thinking'], 'qwen3.8-max')
})

test('Qwen live catalogue keeps distinct capabilities for Max and Preview', () => {
  const { parseProviderModelsResponse } = loadTypeScriptModule('src/main/providers/modelSync.ts')
  const parsed = parseProviderModelsResponse({
    data: [
      {
        id: 'qwen3.8-max',
        name: 'Qwen3.8-Max',
        info: {
          meta: {
            think_skip: { enable: true },
            max_context_length: 1_000_000,
            max_summary_generation_length: 131_072,
          },
        },
      },
      {
        id: 'qwen3.8-max-preview',
        name: 'Qwen3.8-Max-Preview',
        info: {
          meta: {
            think_skip: { enable: false },
            max_context_length: 1_000_000,
            max_summary_generation_length: 65_536,
          },
        },
      },
    ],
  })

  assert.deepEqual(parsed.supportedModels, ['Qwen3.8-Max', 'Qwen3.8-Max-Preview'])
  assert.equal(parsed.modelMappings['Qwen3.8-Max'], 'qwen3.8-max')
  assert.deepEqual(parsed.modelCapabilities['qwen3.8-max'], {
    thinkingSkippable: true,
    maxContextLength: 1_000_000,
    maxSummaryGenerationLength: 131_072,
  })
  assert.deepEqual(parsed.modelCapabilities['qwen3.8-max-preview'], {
    thinkingSkippable: false,
    maxContextLength: 1_000_000,
    maxSummaryGenerationLength: 65_536,
  })
})

test('server startup refreshes dynamic model catalogues before accepting traffic', () => {
  const serverSource = fs.readFileSync('src/server/index.ts', 'utf8')
  const initializeAt = serverSource.indexOf('await storeManager.initialize()')
  const syncAt = serverSource.indexOf('await storeManager.syncDynamicBuiltinProviderModels()')
  const startAt = serverSource.indexOf('await proxyServer.start(')

  assert.ok(initializeAt >= 0)
  assert.ok(syncAt > initializeAt)
  assert.ok(startAt > syncAt)
})

test('server shutdown is idempotent and drains HTTP streams before destroying sessions', () => {
  const serverSource = fs.readFileSync('src/main/proxy/server.ts', 'utf8')
  const entrySource = fs.readFileSync('src/server/index.ts', 'utf8')
  const composeSource = fs.readFileSync('docker-compose.yml', 'utf8')
  assert.match(serverSource, /private draining = false/)
  assert.match(serverSource, /private activeResponses = new Set/)
  assert.match(serverSource, /server\.closeIdleConnections\?\./)
  assert.match(serverSource, /server\.closeAllConnections\?\./)
  assert.match(serverSource, /waitForActiveResponses\(drainTimeoutMs\)/)
  assert.ok(serverSource.indexOf('waitForActiveResponses') < serverSource.indexOf('sessionManager.destroy()'))
  assert.match(entrySource, /shutdownPromise \?\?= shutdown\(signal\)/)
  assert.match(composeSource, /stop_grace_period:\s*\$\{CHAT2API_STOP_GRACE_PERIOD:-10m\}/)
  assert.match(composeSource, /CHAT2API_SHUTDOWN_DRAIN_TIMEOUT_MS:\s*\$\{CHAT2API_SHUTDOWN_DRAIN_TIMEOUT_MS:-540000\}/)
})

test('dynamic catalogue startup preserves persisted models until refresh succeeds', () => {
  const storeSource = fs.readFileSync('src/main/store/store.ts', 'utf8')

  assert.match(storeSource, /preservesDynamicModelCatalogue/)
  assert.match(storeSource, /\.\.\.\(p\.supportedModels \|\| \[\]\)/)
  assert.match(storeSource, /sync failed; keeping persisted models/)
})
