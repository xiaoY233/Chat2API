import test from 'node:test'
import assert from 'node:assert/strict'

import {
  DEFAULT_TOOL_CALLING_CONFIG,
  normalizeToolCallingConfig,
  P0_TOOL_CLIENT_ADAPTERS,
  P0_TOOL_PROVIDER_SUPPORT,
} from '../../src/shared/toolCalling.ts'

test('v2 tool calling defaults use managed standard OpenAI tools', () => {
  assert.deepEqual(DEFAULT_TOOL_CALLING_CONFIG, {
    enabled: true,
    mode: 'auto',
    clientAdapterId: 'standard-openai-tools',
    diagnosticsEnabled: false,
    advanced: {
      promptPreviewEnabled: false,
      customPromptTemplate: undefined,
    },
  })
})

test('legacy prompt config migrates to v2 shape without exposing protocol format', () => {
  assert.deepEqual(
    normalizeToolCallingConfig({
      mode: 'always',
      defaultFormat: 'bracket',
      customPromptTemplate: 'legacy {{tools}}',
      enableToolCallParsing: false,
    }),
    {
      enabled: true,
      mode: 'force',
      clientAdapterId: 'standard-openai-tools',
      diagnosticsEnabled: true,
      advanced: {
        promptPreviewEnabled: false,
        customPromptTemplate: 'legacy {{tools}}',
      },
    },
  )
})

test('legacy never mode disables v2 managed tool calling', () => {
  assert.deepEqual(normalizeToolCallingConfig({ mode: 'never' }), {
    enabled: false,
    mode: 'off',
    clientAdapterId: 'standard-openai-tools',
    diagnosticsEnabled: false,
    advanced: {
      promptPreviewEnabled: false,
      customPromptTemplate: undefined,
    },
  })
})

test('invalid values fall back to safe managed defaults', () => {
  assert.deepEqual(normalizeToolCallingConfig({
    enabled: 'yes',
    mode: 'native',
    clientAdapterId: 'auto',
    diagnosticsEnabled: 'no',
    advanced: { promptPreviewEnabled: 'yes', customPromptTemplate: 123 },
  }), DEFAULT_TOOL_CALLING_CONFIG)
})

test('P0 metadata exposes only approved clients and providers', () => {
  assert.deepEqual(P0_TOOL_CLIENT_ADAPTERS.map((adapter) => adapter.id), [
    'standard-openai-tools',
    'cherry-studio-mcp',
  ])

  assert.deepEqual(P0_TOOL_PROVIDER_SUPPORT.map((provider) => provider.providerId), [
    'deepseek',
    'kimi',
    'glm',
    'qwen',
    'mimo',
  ])

  assert.deepEqual(P0_TOOL_PROVIDER_SUPPORT.map((provider) => provider.label), [
    'DEEPSEEK',
    'KIMI',
    'GLM',
    'QWEN',
    'MIMO',
  ])
})
