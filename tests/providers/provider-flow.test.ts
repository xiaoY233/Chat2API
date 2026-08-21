import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

import { deepseekConfig } from '../../src/main/providers/builtin/deepseek.ts'
import { glmConfig } from '../../src/main/providers/builtin/glm.ts'
import { kimiConfig } from '../../src/main/providers/builtin/kimi.ts'
import { minimaxConfig } from '../../src/main/providers/builtin/minimax.ts'
import { mimoConfig } from '../../src/main/providers/builtin/mimo.ts'
import { perplexityConfig } from '../../src/main/providers/builtin/perplexity.ts'
import { qwenConfig } from '../../src/main/providers/builtin/qwen.ts'
import { qwenAiConfig } from '../../src/main/providers/builtin/qwen-ai.ts'
import { zaiConfig } from '../../src/main/providers/builtin/zai.ts'
import {
  DEEPSEEK_PRIMARY_MODELS,
  DEFAULT_DEEPSEEK_MODEL_MAPPINGS,
  createDefaultModelMappings,
  isDefaultModelMapping,
  normalizeModelMappingsWithDefaults,
  sanitizeDeepSeekModelOverrides,
} from '../../src/main/store/types.ts'
import {
  createKimiChatPayload,
  encodeKimiGrpcFrame,
  normalizeProviderModelForMatch,
  resolveDeepSeekChatOptions,
  resolveKimiScenario,
} from '../../src/main/proxy/adapters/providerModelOptions.ts'
import { mergeProviderModelCapabilities } from '../../src/main/providers/modelSync.ts'

const root = dirname(dirname(dirname(fileURLToPath(import.meta.url))))

test('DeepSeek exposes two primary models and keeps feature aliases in default mappings', () => {
  assert.deepEqual(DEEPSEEK_PRIMARY_MODELS, ['deepseek-v4-flash', 'deepseek-v4-pro'])
  assert.deepEqual(deepseekConfig.supportedModels, DEEPSEEK_PRIMARY_MODELS)
  assert.deepEqual(deepseekConfig.modelMappings, {
    'deepseek-v4-flash': 'deepseek-v4-flash',
    'deepseek-v4-pro': 'deepseek-v4-pro',
  })

  assert.deepEqual(
    resolveDeepSeekChatOptions({ model: 'deepseek-v4-flash' }),
    { modelType: 'default', searchEnabled: false, thinkingEnabled: false },
  )
  assert.deepEqual(
    resolveDeepSeekChatOptions({ model: 'deepseek-v4-pro' }),
    { modelType: 'expert', searchEnabled: false, thinkingEnabled: false },
  )
  assert.deepEqual(
    resolveDeepSeekChatOptions({ model: 'deepseek-v4-pro-think-search' }),
    { modelType: 'expert', searchEnabled: true, thinkingEnabled: true },
  )
  assert.deepEqual(
    resolveDeepSeekChatOptions({ model: 'deepseek-v4-flash-search' }),
    { modelType: 'default', searchEnabled: true, thinkingEnabled: false },
  )
  assert.deepEqual(
    resolveDeepSeekChatOptions({ model: 'deepseek-reasoner' }),
    { modelType: 'default', searchEnabled: false, thinkingEnabled: true },
  )
  assert.deepEqual(
    resolveDeepSeekChatOptions({ model: 'DeepSeek-R1-Search' }),
    { modelType: 'default', searchEnabled: true, thinkingEnabled: true },
  )
  assert.deepEqual(
    resolveDeepSeekChatOptions({ model: 'deepseek-v4-pro', web_search: true, reasoning_effort: 'high' }),
    { modelType: 'expert', searchEnabled: true, thinkingEnabled: true },
  )
  assert.deepEqual(
    resolveDeepSeekChatOptions({ model: 'deepseek-v4-flash' }, 'please use deep thinking if helpful'),
    { modelType: 'default', searchEnabled: false, thinkingEnabled: false },
  )
})

test('DeepSeek persisted model overrides are migrated away from old built-in aliases', () => {
  assert.deepEqual(
    sanitizeDeepSeekModelOverrides({
      addedModels: [
        { displayName: 'deepseek-v4-flash-search', actualModelId: 'deepseek-v4-flash' },
        { displayName: 'DeepSeek-R1', actualModelId: 'deepseek-v4-flash' },
        { displayName: 'custom-deepseek-web', actualModelId: 'custom-upstream-model' },
        { displayName: 'my-flash-alias', actualModelId: 'deepseek-v4-flash' },
      ],
      excludedModels: ['DeepSeek-R1', 'deepseek-v4-flash'],
    }),
    {
      addedModels: [
        { displayName: 'custom-deepseek-web', actualModelId: 'custom-upstream-model' },
        { displayName: 'my-flash-alias', actualModelId: 'deepseek-v4-flash' },
      ],
      excludedModels: ['deepseek-v4-flash'],
    },
  )

  const storeSource = readFileSync(
    join(root, 'src/main/store/store.ts'),
    'utf8',
  )

  assert.match(storeSource, /p\.id === 'deepseek'/)
  assert.match(storeSource, /sanitizeDeepSeekModelOverrides/)
  assert.match(storeSource, /supportedModels: builtinConfig\.supportedModels/)
  assert.match(storeSource, /modelMappings: builtinConfig\.modelMappings/)
})

test('DeepSeek feature aliases are seeded as global model mappings', () => {
  assert.deepEqual(Object.keys(DEFAULT_DEEPSEEK_MODEL_MAPPINGS), [
    'deepseek-v4-flash-think',
    'deepseek-v4-flash-search',
    'deepseek-v4-flash-think-search',
    'deepseek-v4-pro-think',
    'deepseek-v4-pro-search',
    'deepseek-v4-pro-think-search',
  ])
  assert.deepEqual(DEFAULT_DEEPSEEK_MODEL_MAPPINGS['deepseek-v4-flash-think'], {
    requestModel: 'deepseek-v4-flash-think',
    actualModel: 'deepseek-v4-flash',
    preferredProviderId: 'deepseek',
  })
  assert.deepEqual(DEFAULT_DEEPSEEK_MODEL_MAPPINGS['deepseek-v4-pro-search'], {
    requestModel: 'deepseek-v4-pro-search',
    actualModel: 'deepseek-v4-pro',
    preferredProviderId: 'deepseek',
  })
  assert.equal(DEFAULT_DEEPSEEK_MODEL_MAPPINGS['deepseek-chat'], undefined)
  assert.equal(DEFAULT_DEEPSEEK_MODEL_MAPPINGS['deepseek-reasoner'], undefined)
  assert.equal(DEFAULT_DEEPSEEK_MODEL_MAPPINGS['DeepSeek-R1'], undefined)
  assert.equal(DEFAULT_DEEPSEEK_MODEL_MAPPINGS['DeepSeek-R1-Search'], undefined)
})

test('built-in model mappings are restored and cannot be replaced by custom config', () => {
  assert.equal(isDefaultModelMapping('deepseek-v4-flash-search'), true)
  assert.equal(isDefaultModelMapping('deepseek-chat'), false)

  assert.deepEqual(
    normalizeModelMappingsWithDefaults({
      'deepseek-v4-flash-search': {
        requestModel: 'deepseek-v4-flash-search',
        actualModel: 'tampered',
        preferredProviderId: 'custom',
      },
      'custom-alias': {
        requestModel: 'custom-alias',
        actualModel: 'deepseek-v4-flash',
      },
    }),
    {
      ...createDefaultModelMappings(),
      'custom-alias': {
        requestModel: 'custom-alias',
        actualModel: 'deepseek-v4-flash',
      },
    },
  )
})

test('DeepSeek default model mapping seeding preserves editable replacement semantics', () => {
  const first = createDefaultModelMappings()
  first['deepseek-v4-flash-search'].actualModel = 'mutated'
  assert.equal(createDefaultModelMappings()['deepseek-v4-flash-search'].actualModel, 'deepseek-v4-flash')

  const storeSource = readFileSync(
    join(root, 'src/main/store/store.ts'),
    'utf8',
  )

  assert.match(storeSource, /initializeDefaultModelMappings\(\)/)
  assert.match(storeSource, /normalizeModelMappingsWithDefaults/)
  assert.doesNotMatch(storeSource, /modelMappings:\s*this\.normalizeModelMappings\(rawConfig\.modelMappings\)/)
})

test('DeepSeek provider config uses Web 2.0 browser headers', () => {
  assert.equal(deepseekConfig.headers['X-App-Version'], '2.0.0')
  assert.equal(deepseekConfig.headers['X-Client-Version'], '2.0.0')
  assert.equal(deepseekConfig.headers['X-Client-Locale'], 'zh_CN')
  assert.match(deepseekConfig.headers['User-Agent'], /Chrome\/148\.0\.0\.0/)
  assert.match(deepseekConfig.headers['Sec-Ch-Ua'], /Chromium";v="148/)
})

test('GLM, Kimi, and MiniMax built-in default models match current web providers', () => {
  assert.deepEqual(glmConfig.supportedModels, ['GLM-5.1'])
  assert.equal(glmConfig.modelMappings?.['GLM-5.1'], 'glm-5.1')

  assert.deepEqual(kimiConfig.supportedModels, ['Kimi-K2.6', 'Kimi-K3'])
  assert.equal(kimiConfig.modelMappings?.['Kimi-K2.6'], 'k2d6')
  assert.equal(kimiConfig.modelMappings?.['Kimi-K3'], 'k3')
  assert.equal(kimiConfig.modelMappings?.['Kimi-K2.5'], undefined)

  assert.deepEqual(minimaxConfig.supportedModels, ['MiniMax-M2.7'])
  assert.deepEqual(minimaxConfig.modelMappings, {
    'MiniMax-M2.7': 'MiniMax-M2.7',
  })

  const minimaxAdapterSource = readFileSync(
    join(root, 'src/main/proxy/adapters/minimax.ts'),
    'utf8',
  )
  assert.match(minimaxAdapterSource, /this\.model = 'MiniMax-M2\.7'/)
  assert.match(minimaxAdapterSource, /request\.model \|\| 'MiniMax-M2\.7'/)
  assert.doesNotMatch(minimaxAdapterSource, /MiniMax-M2\.5/)
})

test('Kimi K2.6 and K3 model mappings reach current web chat payloads', () => {
  assert.deepEqual(kimiConfig.supportedModels, ['Kimi-K2.6', 'Kimi-K3'])
  assert.deepEqual(kimiConfig.modelMappings, {
    'Kimi-K2.6': 'k2d6',
    'Kimi-K3': 'k3',
  })
  assert.equal(resolveKimiScenario('k2d5'), 'SCENARIO_K2D5')
  assert.equal(resolveKimiScenario('k2d6'), 'SCENARIO_K2D5')
  assert.equal(resolveKimiScenario('k3'), 'SCENARIO_OK_COMPUTER')
  assert.equal(normalizeProviderModelForMatch('Kimi-K2.5-think-search'), 'Kimi-K2.6')
  assert.equal(normalizeProviderModelForMatch('Kimi-K2.6-thinking-search'), 'Kimi-K2.6')
  assert.equal(normalizeProviderModelForMatch('kimi-k2.6'), 'Kimi-K2.6')
  assert.equal(normalizeProviderModelForMatch('k2d5'), 'Kimi-K2.6')
  assert.equal(normalizeProviderModelForMatch('k2d6'), 'Kimi-K2.6')
  assert.equal(normalizeProviderModelForMatch('Qwen3.8-Max-Preview[1m]'), 'Qwen3.8-Max-Preview')
  assert.equal(normalizeProviderModelForMatch('Qwen3.8-Max-Preview-thinking[1m]'), 'Qwen3.8-Max-Preview')

  const k2Payload = createKimiChatPayload({
    model: 'k2d5',
    content: 'hello',
    enableWebSearch: true,
    enableThinking: true,
  })

  assert.equal(k2Payload.scenario, 'SCENARIO_K2D5')
  assert.equal(k2Payload.message.scenario, 'SCENARIO_K2D5')
  assert.deepEqual(k2Payload.tools, [{ type: 'TOOL_TYPE_SEARCH', search: { force: true } }])
  assert.equal(k2Payload.options.thinking, true)
  assert.equal(k2Payload.options.reasoning_effort, 'REASONING_EFFORT_LOW')
  assert.equal(k2Payload.project_id, '')

  const frame = encodeKimiGrpcFrame(k2Payload)
  assert.equal(frame.readUInt8(0), 0)
  assert.equal(frame.readUInt32BE(1), frame.length - 5)
  assert.equal(JSON.parse(frame.subarray(5).toString('utf8')).scenario, 'SCENARIO_K2D5')

  const k3Payload = createKimiChatPayload({
    model: 'k3',
    content: 'hello from K3',
    enableWebSearch: false,
    enableThinking: false,
  })
  assert.equal(k3Payload.scenario, 'SCENARIO_OK_COMPUTER')
  assert.equal(k3Payload.message.scenario, 'SCENARIO_OK_COMPUTER')
  assert.equal(k3Payload.kimiplus_id, 'ok-computer')
  assert.equal(k3Payload.options.reasoning_effort, 'REASONING_EFFORT_HIGH')
  assert.equal(k3Payload.options.context_length, 'CONTEXT_LENGTH_L')
})

test('Kimi forwarder preserves feature aliases and provider conversation identifiers', () => {
  const forwarderSource = readFileSync(join(root, 'src/main/proxy/forwarder.ts'), 'utf8')

  assert.match(forwarderSource, /request\.reasoning_effort \?\? request\.reasoningEffort/)
  assert.match(forwarderSource, /request\.web_search \?\? Boolean\(request\.web_search_options\)/)
  assert.match(forwarderSource, /originalModel: request\.originalModel \|\| request\.model/)
  assert.match(forwarderSource, /request\.conversationId \|\| request\.conversation_id/)
  assert.match(forwarderSource, /accessToken: responseAccessToken/)
  assert.match(forwarderSource, /invalidateAccessToken\(responseAccessToken\)/)
  assert.match(forwarderSource, /request\.parentMessageId \|\| request\.parent_message_id/)
  assert.match(forwarderSource, /providerSessionId: handler\.getConversationId\(\) \?\? undefined/)
  assert.match(forwarderSource, /parentMessageId: handler\.getLastMessageId\(\) \?\? undefined/)
})

test('Kimi and domestic Qwen support account-level chat cleanup', () => {
  const handlersSource = readFileSync(join(root, 'src/main/ipc/handlers.ts'), 'utf8')
  const accountListSource = readFileSync(join(root, 'src/renderer/src/components/providers/AccountList.tsx'), 'utf8')
  const kimiAdapterSource = readFileSync(join(root, 'src/main/proxy/adapters/kimi.ts'), 'utf8')
  const qwenAdapterSource = readFileSync(join(root, 'src/main/proxy/adapters/qwen.ts'), 'utf8')

  assert.match(handlersSource, /import \{ KimiAdapter \} from '\.\.\/proxy\/adapters\/kimi'/)
  assert.match(handlersSource, /import \{ QwenAdapter \} from '\.\.\/proxy\/adapters\/qwen'/)
  assert.match(handlersSource, /kimi: async \(provider, account\) => new KimiAdapter\(provider, account\)\.deleteAllChats\(\)/)
  assert.match(handlersSource, /qwen: async \(provider, account\) => new QwenAdapter\(provider, account\)\.deleteAllChats\(\)/)
  assert.match(accountListSource, /providerId === 'kimi'/)
  assert.match(accountListSource, /providerId === 'qwen'/)

  assert.match(kimiAdapterSource, /async deleteAllChats\(\): Promise<boolean>/)
  assert.match(kimiAdapterSource, /kimi\.chat\.v1\.ChatService\/ListChats/)
  assert.match(kimiAdapterSource, /kimi\.chat\.v1\.ChatService\/BatchDeleteChats/)
  assert.match(kimiAdapterSource, /chat_ids/)

  assert.match(qwenAdapterSource, /async deleteAllChats\(\): Promise<boolean>/)
  assert.match(qwenAdapterSource, /api\/v2\/session\/page\/list/)
  assert.match(qwenAdapterSource, /api\/v1\/session\/delete\/batch/)
  assert.match(qwenAdapterSource, /api\/v2\/file\/record\/delete/)
  assert.match(qwenAdapterSource, /session_ids/)
  assert.match(qwenAdapterSource, /sessionIds/)
})

test('domestic Qwen models match the web chat model ids captured from HAR', () => {
  const expectedModels = [
    'Qwen3.6',
    'Qwen3.7-Max',
    'Qwen3.5-Flash',
    'Qwen3-Max',
    'Qwen3-Max-Thinking-Preview',
    'Qwen3-Coder',
  ]
  const expectedMappings = {
    'Qwen3.6': 'Qwen',
    'Qwen3.7-Max': 'Qwen3.7-Max',
    'Qwen3.5-Flash': 'Qwen3.5-Flash',
    'Qwen3-Max': 'Qwen3-Max',
    'Qwen3-Max-Thinking-Preview': 'Qwen3-Max-Thinking-Preview',
    'Qwen3-Coder': 'Qwen3-Coder',
  }

  assert.deepEqual(qwenConfig.supportedModels, expectedModels)
  assert.deepEqual(qwenConfig.modelMappings, expectedMappings)

  const qwenAdapterSource = readFileSync(join(root, 'src/main/proxy/adapters/qwen.ts'), 'utf8')
  const zh = JSON.parse(readFileSync(join(root, 'src/renderer/src/i18n/locales/zh-CN.json'), 'utf8'))
  const en = JSON.parse(readFileSync(join(root, 'src/renderer/src/i18n/locales/en-US.json'), 'utf8'))

  assert.match(qwenAdapterSource, /'Qwen3\.6': 'Qwen'/)
  assert.match(qwenAdapterSource, /'Qwen3-Coder': 'Qwen3-Coder'/)
  assert.doesNotMatch(qwenAdapterSource, /qwen3-coder-plus|tongyi-qwen3-max-model-agent|tongyi-qwen-plus-agent/)
  assert.deepEqual(zh.qwen.models, expectedMappings)
  assert.deepEqual(en.qwen.models, expectedMappings)
})

test('Qwen AI defaults prefer the configured stable model while retaining explicit compatibility mappings', () => {
  const expectedModels = [
    'Qwen3.8-Max',
    'Qwen3.8-Max_Fast',
    'Qwen3.8-Max_Auto',
    'Qwen3.8-Max_Thinking',
    'Qwen3.7-Plus',
    'Qwen3.7-Max',
  ]
  const expectedMappings = {
    'Qwen3.8-Max': 'qwen3.8-max',
    'Qwen3.8-Max_Fast': 'qwen3.8-max',
    'Qwen3.8-Max_Auto': 'qwen3.8-max',
    'Qwen3.8-Max_Thinking': 'qwen3.8-max',
    'Qwen3.8-Max-Preview': 'qwen3.8-max-preview',
    'Qwen3.7-Plus': 'qwen3.7-plus',
    'Qwen3.7-Max': 'qwen3.7-max',
    'Qwen3.6-Plus': 'qwen3.6-plus',
  }

  assert.deepEqual(qwenAiConfig.supportedModels, expectedModels)
  assert.deepEqual(qwenAiConfig.modelMappings, expectedMappings)
  assert.deepEqual(qwenAiConfig.modelCapabilities, {
    'Qwen3.8-Max-Preview': { thinkingSkippable: false },
    'qwen3.8-max-preview': { thinkingSkippable: false },
  })

  for (const removedModel of [
    'Qwen3.7-Max-Preview',
    'Qwen3.7-Plus-Preview',
    'Qwen3.6-Max-Preview',
    'Qwen3.6-Plus-Preview',
    'Qwen3.5-Plus',
    'Qwen3-Max',
    'Qwen3-235B-A22B-2507',
    'Qwen3-VL-235B-A22B',
    'Qwen3-Omni-Flash',
    'Qwen2.5-Max',
  ]) {
    assert.equal(qwenAiConfig.modelMappings?.[removedModel], undefined, removedModel)
  }

  const qwenAiAdapterSource = readFileSync(join(root, 'src/main/proxy/adapters/qwen-ai.ts'), 'utf8')
  assert.match(qwenAiAdapterSource, /'qwen3\.8':\s*'qwen3\.8-max'/)
  assert.match(qwenAiAdapterSource, /'qwen3\.8-max-preview':\s*'qwen3\.8-max-preview'/)
  assert.match(qwenAiAdapterSource, /qwen:\s*'qwen3\.7-max'/)
  assert.match(qwenAiAdapterSource, /qwen3:\s*'qwen3\.7-max'/)
  assert.match(qwenAiAdapterSource, /'qwen3\.7':\s*'qwen3\.7-max'/)
  assert.match(qwenAiAdapterSource, /'qwen3\.7-plus':\s*'qwen3\.7-plus'/)
  assert.match(qwenAiAdapterSource, /'qwen3\.6':\s*'qwen3\.6-plus'/)
  assert.equal(qwenAiConfig.modelMappings?.['Qwen3-Coder'], undefined)
  assert.doesNotMatch(qwenAiAdapterSource, /'qwen3\.5':/)
  assert.doesNotMatch(qwenAiAdapterSource, /'qwen3-vl':/)
  assert.doesNotMatch(qwenAiAdapterSource, /'qwen3-omni':/)
  assert.doesNotMatch(qwenAiAdapterSource, /'qwen2\.5':/)

  assert.equal(normalizeProviderModelForMatch('Qwen3.8-Max_Fast'), 'Qwen3.8-Max')
  assert.equal(normalizeProviderModelForMatch('Qwen3.8-Max_Auto'), 'Qwen3.8-Max')
  assert.equal(normalizeProviderModelForMatch('Qwen3.8-Max_Thinking'), 'Qwen3.8-Max')
  assert.equal(normalizeProviderModelForMatch('Qwen3.8-Max_TeF_AtT'), 'Qwen3.8-Max')
})

test('model capability metadata merges live values without inventing unknown fallbacks', () => {
  const existing = {
    'Qwen3.8-Max-Preview': { thinkingSkippable: false },
  }
  const reported = {
    'Qwen3.8-Max-Preview': { thinkingSkippable: false },
  }

  const merged = mergeProviderModelCapabilities(existing, reported)
  assert.deepEqual(merged, reported)
  assert.notEqual(merged, existing)
  assert.notEqual(merged?.['Qwen3.8-Max-Preview'], existing['Qwen3.8-Max-Preview'])
  assert.equal(mergeProviderModelCapabilities(undefined, undefined), undefined)
  assert.equal(mergeProviderModelCapabilities(undefined, {}), undefined)
})

test('Z.ai default models match the latest chat.z.ai HAR model ids', () => {
  const expectedModels = [
    'GLM-5.1',
    'GLM-5-Turbo',
    'GLM-5V-Turbo',
    'GLM-5',
    'GLM-4.7',
  ]
  const expectedMappings = {
    'GLM-5.1': 'GLM-5.1',
    'GLM-5-Turbo': 'GLM-5-Turbo',
    'GLM-5V-Turbo': 'GLM-5v-Turbo',
    'GLM-5': 'glm-5',
    'GLM-4.7': 'glm-4.7',
  }

  assert.deepEqual(zaiConfig.supportedModels, expectedModels)
  assert.deepEqual(zaiConfig.modelMappings, expectedMappings)

  for (const removedModel of ['glm-4.6v', 'glm-4.6', 'glm-4.5v', 'glm-4.5-air']) {
    assert.equal(zaiConfig.modelMappings?.[removedModel], undefined, removedModel)
  }

  const zaiAdapterSource = readFileSync(join(root, 'src/main/proxy/adapters/zai.ts'), 'utf8')
  assert.match(zaiAdapterSource, /'glm-5\.1': 'GLM-5\.1'/)
  assert.match(zaiAdapterSource, /'glm-5v-turbo': 'GLM-5v-Turbo'/)
  assert.match(zaiAdapterSource, /'GLM-5V-Turbo': 'GLM-5v-Turbo'/)
  assert.match(zaiAdapterSource, /const X_FE_VERSION = 'prod-fe-1\.1\.37'/)
  assert.match(zaiAdapterSource, /'X-Region': 'domestic'/)
  assert.match(zaiAdapterSource, /captcha_verify_param/)
  assert.match(zaiAdapterSource, /new URLSearchParams\(\{[\s\S]*token,/)
  assert.match(zaiAdapterSource, /api\/v2\/chat\/completions\?\$\{queryParams\.toString\(\)\}/)
  assert.match(zaiAdapterSource, /Authorization: `Bearer \$\{token\}`/)
  assert.match(zaiAdapterSource, /'Cookie': `token=\$\{token\}`/)
  assert.doesNotMatch(zaiAdapterSource, /'glm-4\.6v':/)
  assert.doesNotMatch(zaiAdapterSource, /'glm-4\.5-air':/)
})

test('Z.ai docs mark provider temporarily unavailable due to captcha risk control', () => {
  const readme = readFileSync(join(root, 'README.md'), 'utf8')
  const readmeCn = readFileSync(join(root, 'README_CN.md'), 'utf8')
  const doc = readFileSync(join(root, 'docs/providers/zai.md'), 'utf8')

  assert.match(readme, /Z\.ai[^\n]*Temporarily unavailable due to frontend captcha risk control/)
  assert.match(readmeCn, /Z\.ai[^\n]*受前端验证码风控限制，暂不可用/)
  assert.match(doc, /当前状态 \| 受前端验证码风控限制，暂不可用/)
  assert.match(doc, /FRONTEND_CAPTCHA_REQUIRED/)
  assert.match(doc, /captcha_verify_param.*调试字段/)
})

test('provider docs cover every built-in provider and Qwen AI manual model additions', () => {
  const providerDocs = [
    'deepseek',
    'glm',
    'kimi',
    'minimax',
    'mimo',
    'perplexity',
    'qwen',
    'qwen-ai',
    'zai',
  ]

  for (const providerId of providerDocs) {
    const doc = readFileSync(join(root, 'docs/providers', `${providerId}.md`), 'utf8')
    assert.match(doc, new RegExp(`Provider ID.*${providerId}|供应商 ID.*${providerId}`))
    assert.match(doc, /默认模型|Default models/)
    assert.match(doc, /适配|Tutorial|教程/)
  }

  const index = readFileSync(join(root, 'docs/providers/README.md'), 'utf8')
  for (const providerId of providerDocs) {
    assert.match(index, new RegExp(`\\(${providerId}\\.md\\)`))
  }

  const qwenAiDoc = readFileSync(join(root, 'docs/providers/qwen-ai.md'), 'utf8')
  const manualModels = {
    'Qwen3.7-Max-Preview': 'qwen-latest-series-invite-beta-v24',
    'Qwen3.7-Plus-Preview': 'qwen-latest-series-invite-beta-v16',
    'Qwen3.6-Max-Preview': 'qwen3.6-max-preview',
    'Qwen3.6-Plus-Preview': 'qwen3.6-plus-preview',
    'Qwen3.5-Plus': 'qwen3.5-plus',
    'Qwen3.5-Omni-Plus': 'qwen3.5-omni-plus',
    'Qwen3.5-Flash': 'qwen3.5-flash',
    'Qwen3.5-Max-Preview': 'qwen3.5-max-2026-03-08',
    'Qwen3.5-397B-A17B': 'qwen3.5-397b-a17b',
    'Qwen3.5-122B-A10B': 'qwen3.5-122b-a10b',
    'Qwen3.5-Omni-Flash': 'qwen3.5-omni-flash',
    'Qwen3.5-27B': 'qwen3.5-27b',
    'Qwen3.5-35B-A3B': 'qwen3.5-35b-a3b',
    'Qwen3-Max': 'qwen3-max-2026-01-23',
    'Qwen3-235B-A22B-2507 / Qwen2.5-Plus': 'qwen-plus-2025-07-28',
    'Qwen3-VL-235B-A22B': 'qwen3-vl-plus',
    'Qwen3-Omni-Flash': 'qwen3-omni-flash-2025-12-01',
    'Qwen2.5-Max': 'qwen-max-latest',
  }

  assert.match(qwenAiDoc, /供应商管理/)
  assert.match(qwenAiDoc, /模型管理/)
  for (const [displayName, actualModelId] of Object.entries(manualModels)) {
    assert.match(qwenAiDoc, new RegExp(displayName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
    assert.match(qwenAiDoc, new RegExp(actualModelId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
  }
})

test('README Supported Providers model lists mirror current defaults with Perplexity Free mode only', () => {
  const readme = readFileSync(join(root, 'README.md'), 'utf8')
  const readmeCn = readFileSync(join(root, 'README_CN.md'), 'utf8')
  const expectedRows = [
    ['DeepSeek', deepseekConfig.supportedModels?.join(', ')],
    ['GLM', glmConfig.supportedModels?.join(', ')],
    ['Kimi', kimiConfig.supportedModels?.join(', ')],
    ['MiniMax', minimaxConfig.supportedModels?.join(', ')],
    ['Mimo', mimoConfig.supportedModels?.join(', ')],
    ['Perplexity', 'Auto'],
    ['Qwen', qwenConfig.supportedModels?.join(', ')],
    ['Qwen AI', qwenAiConfig.supportedModels?.join(', ')],
  ]

  assert.deepEqual(perplexityConfig.supportedModels, ['Auto'])
  assert.deepEqual(perplexityConfig.modelMappings, { Auto: 'auto' })

  for (const [provider, models] of expectedRows) {
    assert.match(readme, new RegExp(`\\| ${provider.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[^\\n]*\\| ${models?.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\|`))
    assert.match(readmeCn, new RegExp(`\\| ${provider.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[^\\n]*\\| ${models?.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\|`))
  }

  assert.match(readme, /Z\.ai[^\n]*Temporarily unavailable due to frontend captcha risk control/)
  assert.match(readmeCn, /Z\.ai[^\n]*受前端验证码风控限制，暂不可用/)

  assert.doesNotMatch(readme, /Perplexity[^\n]*(Turbo|PPLX-Pro|GPT-5|Gemini-2\.5-Pro|Claude-Sonnet-4|Claude-Opus-4|Nemotron)/)
  assert.doesNotMatch(readmeCn, /Perplexity[^\n]*(Turbo|PPLX-Pro|GPT-5|Gemini-2\.5-Pro|Claude-Sonnet-4|Claude-Opus-4|Nemotron)/)
  assert.doesNotMatch(
    readFileSync(join(root, 'docs/providers/perplexity.md'), 'utf8'),
    /\| (Turbo|PPLX-Pro|GPT-5|Gemini-2\.5-Pro|Claude-Sonnet-4|Claude-Opus-4|Nemotron) \|/,
  )
})

test('Mimo model names and conversation flow match Xiaomi AI Studio web requests', () => {
  assert.deepEqual(mimoConfig.supportedModels, ['MiMo-V2.5-Pro', 'MiMo-V2.5', 'MiMo-V2-Flash'])
  assert.equal(mimoConfig.modelMappings?.['MiMo-V2.5-Pro'], 'mimo-v2.5-pro')
  assert.equal(mimoConfig.modelMappings?.['MiMo-V2.5'], 'mimo-v2.5')
  assert.equal(mimoConfig.modelMappings?.['MiMo-V2-Flash'], 'mimo-v2-flash')

  const forwarderSource = readFileSync(
    join(root, 'src/main/proxy/forwarder.ts'),
    'utf8',
  )
  const forwardMimoStart = forwarderSource.indexOf('private async forwardMimo')
  const forwardMimoEnd = forwarderSource.indexOf('private async forwardPerplexity')
  const forwardMimoSource = forwarderSource.slice(forwardMimoStart, forwardMimoEnd)

  assert.match(forwardMimoSource, /model:\s*actualModel/)
  assert.doesNotMatch(forwardMimoSource, /model:\s*request\.model/)
  assert.match(forwardMimoSource, /const transformed = this\.transformRequestForPromptToolUse\(request, provider\)/)
  assert.match(forwardMimoSource, /messages:\s*transformedRequest\.messages/)
  assert.match(forwardMimoSource, /new MimoStreamHandler\(actualModel, conversationId, 'separate', transformed\.plan\)/)
  assert.match(forwardMimoSource, /this\.applyToolCallsToResponse\(.*transformed/s)

  const mimoAdapterSource = readFileSync(
    join(root, 'src/main/proxy/adapters/mimo.ts'),
    'utf8',
  )

  assert.match(mimoAdapterSource, /open-apis\/chat\/conversation\/save/)
  assert.match(mimoAdapterSource, /open-apis\/chat\/conversation\/genTitle/)
  assert.match(mimoAdapterSource, /async deleteSession\(conversationId: string\)/)
  assert.match(mimoAdapterSource, /await this\.deleteConversations\(\[conversationId\]\)/)
  assert.match(mimoAdapterSource, /await this\.saveConversation\([^)]*conversationId/)
  assert.match(forwardMimoSource, /await adapter\.generateConversationTitle\(/)
  assert.match(forwardMimoSource, /handler\.getAssistantContentForTitle\(\)/)
  assert.match(forwardMimoSource, /const deleteSessionCallback = shouldDeleteSession\(\)/)
  assert.match(forwardMimoSource, /await deleteSessionCallback\(conversationId\)/)
})

test('Add provider dialog uses IPC built-in providers instead of duplicated model templates', () => {
  const source = readFileSync(
    join(root, 'src/renderer/src/components/providers/AddProviderDialog.tsx'),
    'utf8',
  )

  assert.match(source, /const providers = builtinProviders/)
  assert.doesNotMatch(source, /DEFAULT_BUILTIN_PROVIDERS/)
  assert.doesNotMatch(source, /supportedModels:\s*\[/)
  assert.doesNotMatch(source, /DeepSeek-V3\.2|DeepSeek-R1|deepseek-reasoner|Kimi-K2\.5|MiniMax-M2\.5/)
})

test('built-in model reset restores source defaults instead of stale persisted provider models', () => {
  const source = readFileSync(
    join(root, 'src/main/store/store.ts'),
    'utf8',
  )

  assert.doesNotMatch(source, /shouldUseBuiltinModels/)
  assert.match(source, /supportedModels: builtinConfig\.supportedModels/)
  assert.match(source, /modelMappings: builtinConfig\.modelMappings/)
  assert.match(source, /resetModels\(providerId: string\): EffectiveModel\[\][\s\S]*BUILTIN_PROVIDERS\.find/)
  assert.match(source, /resetModels\(providerId: string\): EffectiveModel\[\][\s\S]*this\.store!\.set\('providers', providers\)/)
})

test('DeepSeek locale model labels only describe primary provider models', () => {
  const zh = readFileSync(join(root, 'src/renderer/src/i18n/locales/zh-CN.json'), 'utf8')
  const en = readFileSync(join(root, 'src/renderer/src/i18n/locales/en-US.json'), 'utf8')
  const zhData = JSON.parse(zh)
  const enData = JSON.parse(en)

  assert.deepEqual(zhData.deepseek.models, {
    'deepseek-v4-flash': 'DeepSeek V4 Flash',
    'deepseek-v4-pro': 'DeepSeek V4 Pro',
  })
  assert.deepEqual(enData.deepseek.models, {
    'deepseek-v4-flash': 'DeepSeek V4 Flash',
    'deepseek-v4-pro': 'DeepSeek V4 Pro',
  })
  assert.equal('DeepSeek-R1' in zhData.deepseek.models, false)
  assert.equal('deepseek-reasoner' in enData.deepseek.models, false)
})

test('forwarder delegates managed tool transformation to ToolCallingEngine', () => {
  const source = readFileSync(
    join(root, 'src/main/proxy/forwarder.ts'),
    'utf8',
  )

  assert.match(source, /import \{ ToolCallingEngine \} from '\.\/toolCalling\/ToolCallingEngine'/)
  assert.match(source, /engine\.transformRequest\(/)
  assert.match(source, /engine\.applyNonStreamResponse\(result, transformed\.plan\)/)
  assert.doesNotMatch(source, /promptInjectionService\.process\(/)
  assert.doesNotMatch(source, /transformMCPToolProtocol\(/)
  assert.doesNotMatch(source, /generateToolPrompt\(/)
  assert.match(source, /tools: transformed\.tools/)
  assert.match(source, /messages: transformed\.messages/)
})

test('forwarder reads toolCallingConfig and does not use legacy prompt config for P0 tool calls', () => {
  const source = readFileSync(
    join(root, 'src/main/proxy/forwarder.ts'),
    'utf8',
  )

  assert.match(source, /toolCallingConfig/)
  assert.match(source, /new ToolCallingEngine\(/)
  assert.doesNotMatch(source, /toolPromptConfig\.defaultFormat/)
  assert.doesNotMatch(source, /promptInjectionService\.process\(/)
})

test('built-in provider sync keeps credential field updates on existing providers', () => {
  const source = readFileSync(
    join(root, 'src/main/store/store.ts'),
    'utf8',
  )

  assert.match(source, /credentialFields: builtinConfig\.credentialFields/)
})

test('DeepSeek forwarder preserves requested model aliases for response parsing semantics', () => {
  const source = readFileSync(
    join(root, 'src/main/proxy/forwarder.ts'),
    'utf8',
  )

  assert.match(source, /new DeepSeekStreamHandler\(\s*actualModel,[\s\S]*transformed\.plan,\s*request\.model\s*\)/)
})

test('active source no longer exposes DS2API or DSML tool protocol markers', () => {
  const activeFiles = [
    'src/main/proxy/toolCalling/ToolCallingEngine.ts',
    'src/main/proxy/toolCalling/providerProfiles.ts',
    'src/main/proxy/toolCalling/protocols/managedXml.ts',
    'src/renderer/src/pages/Models.tsx',
  ]

  for (const file of activeFiles) {
    const source = readFileSync(join(root, file), 'utf8')
    assert.doesNotMatch(source, /DS2API|DSML/i, file)
  }
})

test('tool calling UI copy hides internal managed protocol ids', () => {
  const localeFiles = [
    'src/renderer/src/i18n/locales/zh-CN.json',
    'src/renderer/src/i18n/locales/en-US.json',
  ]

  for (const file of localeFiles) {
    const source = readFileSync(join(root, file), 'utf8')
    assert.doesNotMatch(source, /managed_xml/, file)
  }
})
