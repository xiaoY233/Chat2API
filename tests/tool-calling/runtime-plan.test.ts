import test from 'node:test'
import assert from 'node:assert/strict'

import { buildToolCallingRuntimePlan } from '../../src/main/proxy/toolCalling/runtimePlan.ts'
import type { NormalizedToolDefinition } from '../../src/main/proxy/toolCalling/types.ts'

const tools: NormalizedToolDefinition[] = [{
  name: 'weather-test:get_weather',
  description: 'Get weather',
  parameters: { type: 'object' },
  source: 'mcp',
}]

test('off mode disables managed processing', () => {
  const plan = buildToolCallingRuntimePlan({
    requestId: 'r1',
    providerId: 'deepseek',
    actualModel: 'deepseek-chat',
    config: {
      enabled: true,
      mode: 'off',
      clientAdapterId: 'cherry-studio-mcp',
      diagnosticsEnabled: false,
      advanced: { promptPreviewEnabled: false },
    },
    clientRequest: {
      clientAdapterId: 'cherry-studio-mcp',
      toolSource: 'mcp',
      tools,
      toolChoice: { mode: 'auto' },
      diagnostics: { rawToolCount: 1, normalizedToolNames: ['weather-test:get_weather'] },
    },
  })

  assert.equal(plan.mode, 'disabled')
  assert.equal(plan.shouldInjectPrompt, false)
  assert.equal(plan.diagnostics.reason, 'mode_off')
})

test('auto mode manages P0 provider requests with tools', () => {
  const plan = buildToolCallingRuntimePlan({
    requestId: 'r2',
    providerId: 'kimi',
    actualModel: 'kimi-k2',
    config: {
      enabled: true,
      mode: 'auto',
      clientAdapterId: 'cherry-studio-mcp',
      diagnosticsEnabled: false,
      advanced: { promptPreviewEnabled: false },
    },
    clientRequest: {
      clientAdapterId: 'cherry-studio-mcp',
      toolSource: 'mcp',
      tools,
      toolChoice: { mode: 'auto' },
      diagnostics: { rawToolCount: 1, normalizedToolNames: ['weather-test:get_weather'] },
    },
  })

  assert.equal(plan.mode, 'managed')
  assert.equal(plan.protocol, 'managed_xml')
  assert.equal(plan.clientAdapterId, 'cherry-studio-mcp')
  assert.deepEqual([...plan.allowedToolNames], ['weather-test:get_weather'])
})

test('tool_choice none disables prompt injection and parsing', () => {
  const plan = buildToolCallingRuntimePlan({
    requestId: 'r3',
    providerId: 'glm',
    actualModel: 'glm-5',
    config: {
      enabled: true,
      mode: 'force',
      clientAdapterId: 'standard-openai-tools',
      diagnosticsEnabled: false,
      advanced: { promptPreviewEnabled: false },
    },
    clientRequest: {
      clientAdapterId: 'standard-openai-tools',
      toolSource: 'openai',
      tools,
      toolChoice: { mode: 'none' },
      diagnostics: { rawToolCount: 1, normalizedToolNames: ['weather-test:get_weather'] },
    },
  })

  assert.equal(plan.mode, 'disabled')
  assert.equal(plan.diagnostics.reason, 'tool_choice_none')
})

test('forced missing tool name is rejected before provider call', () => {
  assert.throws(() => buildToolCallingRuntimePlan({
    requestId: 'r4',
    providerId: 'qwen',
    actualModel: 'qwen3-coder',
    config: {
      enabled: true,
      mode: 'force',
      clientAdapterId: 'standard-openai-tools',
      diagnosticsEnabled: false,
      advanced: { promptPreviewEnabled: false },
    },
    clientRequest: {
      clientAdapterId: 'standard-openai-tools',
      toolSource: 'openai',
      tools,
      toolChoice: { mode: 'forced', forcedName: 'missing_tool' },
      diagnostics: { rawToolCount: 1, normalizedToolNames: ['weather-test:get_weather'] },
    },
  }), /Forced tool missing_tool is not declared/)
})
