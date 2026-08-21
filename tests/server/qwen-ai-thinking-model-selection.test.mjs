import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'

test('load balancer matches Qwen AI mode aliases against the base model', () => {
  const source = fs.readFileSync('src/main/proxy/loadbalancer.ts', 'utf8')
  const optionsSource = fs.readFileSync('src/main/proxy/adapters/providerModelOptions.ts', 'utf8')

  assert.match(source, /normalizeModelForProviderMatch/)
  assert.match(source, /normalizeProviderModelForMatch\(model\)/)
  assert.match(optionsSource, /normalizeQwenAiModelModeName/)
  assert.match(source, /m\.actualModelId/)
  assert.match(source, /const normalizedModel = this\.normalizeModelForProviderMatch\(model\)\.toLowerCase\(\)/)
  assert.match(source, /const normalizedActualModel = this\.normalizeModelForProviderMatch\(actualModel\)\.toLowerCase\(\)/)
})

test('Qwen AI resolves explicit model modes before translated client thinking parameters', () => {
  const source = fs.readFileSync('src/main/proxy/adapters/qwen-ai.ts', 'utf8')

  assert.doesNotMatch(source, /THINKING_REQUIRED_MODEL_IDS/)
  assert.match(source, /findModelCapability\(this\.provider, modelForThinking, modelId\)/)
  assert.match(source, /capability\?\.thinkingSkippable === false/)
  assert.match(source, /resolveQwenThinkingEnabled\(/)
  assert.match(source, /resolveQwenAiFeatureMode/)
  assert.match(source, /resolveQwenAiModelMode\(requestedModel\)/)
  assert.match(source, /if \(modelMode\.thinkingEnabled !== undefined\)/)
  assert.match(source, /thinkingEnabled:\s*modelMode\.thinkingEnabled/)
  assert.match(source, /autoThinking:\s*modelMode\.autoThinking \?\? modelMode\.thinkingEnabled/)
})

test('load balancer avoids a failed Qwen AI account on the next selection', () => {
  const source = fs.readFileSync('src/main/proxy/loadbalancer.ts', 'utf8')

  assert.match(source, /FAIL_THRESHOLD = 1/)
  assert.match(source, /RECOVERY_TIME = 60000/)
  assert.match(source, /let candidates = this\.getAvailableAccounts\(\s*model,\s*preferredProviderId,\s*true,/)
  assert.match(source, /candidates = this\.getAvailableAccounts\(\s*model,\s*preferredProviderId,\s*false,/)
})
