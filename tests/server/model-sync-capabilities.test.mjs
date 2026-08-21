import assert from 'node:assert/strict'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import test from 'node:test'
import ts from 'typescript'

const source = fs.readFileSync('src/main/providers/modelSync.ts', 'utf8')
const require = createRequire(import.meta.url)
const output = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText
const module = { exports: {} }
new Function('require', 'module', 'exports', output)(require, module, module.exports)
const { parseProviderModelsResponse } = module.exports

test('model catalogue preserves context and summary generation limits', () => {
  const result = parseProviderModelsResponse({
    data: [{
      id: 'qwen-test',
      name: 'Qwen Test',
      info: {
        meta: {
          max_context_length: 131072,
          max_summary_generation_length: 8192,
        },
      },
    }],
  })

  assert.deepEqual(result.modelCapabilities['qwen-test'], {
    maxContextLength: 131072,
    maxSummaryGenerationLength: 8192,
  })
  assert.deepEqual(result.modelCapabilities['Qwen Test'], result.modelCapabilities['qwen-test'])
})
