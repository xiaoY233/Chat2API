import assert from 'node:assert/strict'
import test from 'node:test'
import {
  builtinProviderMap,
  builtinProviders,
  getBuiltinProvider,
} from '../src/shims/selectedProviders.ts'

test('headless registry exposes only validated providers', () => {
  const expected = ['deepseek', 'glm', 'kimi', 'minimax', 'zai']
  assert.deepEqual(builtinProviders.map(provider => provider.id).sort(), expected)
  assert.deepEqual(Object.keys(builtinProviderMap).sort(), expected)
  assert.equal(getBuiltinProvider('perplexity'), undefined)
})
