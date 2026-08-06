import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

test('normal tool-calling UI exposes client adapter and managed mode controls', () => {
  const panel = readFileSync('src/renderer/src/components/models/ToolCallingPanel.tsx', 'utf8')

  assert.match(panel, /toolCallingConfig/)
  assert.match(panel, /standard-openai-tools/)
  assert.match(panel, /cherry-studio-mcp/)
  assert.match(panel, /mode.*off/s)
  assert.match(panel, /mode.*auto/s)
  assert.match(panel, /mode.*force/s)
})

test('normal UI hides protocol and prompt-template internals', () => {
  const panel = readFileSync('src/renderer/src/components/models/ToolCallingPanel.tsx', 'utf8')

  assert.doesNotMatch(panel, /defaultFormat/)
  assert.doesNotMatch(panel, /ProtocolFormat/)
  assert.doesNotMatch(panel, /provider\.protocolId/)
  assert.doesNotMatch(panel, /skipKnownClient/i)
  assert.match(panel, /advanced\.customPromptTemplate/)
})

test('provider support matrix shows display labels instead of provider ids', () => {
  const panel = readFileSync('src/renderer/src/components/models/ToolCallingPanel.tsx', 'utf8')

  assert.match(panel, /provider\.label/)
  assert.doesNotMatch(panel, /<span className="text-sm font-medium">\{provider\.providerId\}<\/span>/)
})

test('Models page delegates tool settings to ToolCallingPanel', () => {
  const models = readFileSync('src/renderer/src/pages/Models.tsx', 'utf8')

  assert.match(models, /ToolCallingPanel/)
  assert.doesNotMatch(models, /PromptTemplateCard/)
  assert.doesNotMatch(models, /InjectionConfigCard/)
})

test('model mapping UI protects built-in mappings and confirms restore defaults', () => {
  const panel = readFileSync('src/renderer/src/components/proxy/ModelMappingConfig.tsx', 'utf8')

  assert.match(panel, /DEFAULT_MODEL_MAPPINGS/)
  assert.match(panel, /isBuiltInMapping/)
  assert.match(panel, /mappingSource/)
  assert.match(panel, /builtInMapping/)
  assert.match(panel, /customMapping/)
  assert.match(panel, /restoreDefaults/)
  assert.match(panel, /confirmRestoreDefaults/)
  assert.match(panel, /handleRestoreDefaults/)
  assert.match(panel, /disabled=\{isBuiltInMapping/)
  assert.match(panel, /actualModel[\s\S]*mappingSource/)
  assert.match(panel, /whitespace-nowrap/)
})

test('model mapping UI keeps save controls above the mapping list', () => {
  const panel = readFileSync('src/renderer/src/components/proxy/ModelMappingConfig.tsx', 'utf8')

  assert.match(panel, /proxy\.saveConfig[\s\S]*proxy\.searchMappings/)
})

test('model mapping provider choices are filtered by selected actual model', () => {
  const panel = readFileSync('src/renderer/src/components/proxy/ModelMappingConfig.tsx', 'utf8')

  assert.match(panel, /modelMatchedProviders/)
  assert.match(panel, /provider\.supportedModels\?\.includes\(formData\.actualModel\)/)
  assert.match(panel, /providerOptions\.map/)
  assert.match(panel, /preferredProviderId: ''/)
  assert.match(panel, /preferredAccountId: ''/)
})

test('model mapping model selection carries provider identity', () => {
  const panel = readFileSync('src/renderer/src/components/proxy/ModelMappingConfig.tsx', 'utf8')

  assert.match(panel, /createModelOptionValue\(provider\.id, model\)/)
  assert.match(panel, /parseModelOptionValue\(value\)/)
  assert.match(panel, /actualModel: selectedModel/)
  assert.match(panel, /preferredProviderId: selectedProviderId/)
  assert.match(panel, /const selectedModelOptionValue/)
})

test('dashboard chart avoids the broken recharts dependency path', () => {
  const chart = readFileSync('src/renderer/src/components/dashboard/RequestChart.tsx', 'utf8')

  assert.doesNotMatch(chart, /from 'recharts/)
  assert.match(chart, /<svg/)
})
