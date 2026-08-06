import test from 'node:test'
import assert from 'node:assert/strict'
import {
  normalizeToolChoicePolicy,
  ToolChoicePolicyError,
} from '../../src/main/proxy/toolCalling/toolChoicePolicy.ts'

const tools = [
  { name: 'default_api:read_file', parameters: { type: 'object' }, source: 'openai' as const },
  { name: 'default_api:list_dir', parameters: { type: 'object' }, source: 'openai' as const },
]

test('auto allows every declared tool', () => {
  const policy = normalizeToolChoicePolicy('auto', tools)

  assert.equal(policy.mode, 'auto')
  assert.deepEqual([...policy.allowedToolNames].sort(), ['default_api:list_dir', 'default_api:read_file'])
})

test('none disables tool calling', () => {
  const policy = normalizeToolChoicePolicy('none', tools)

  assert.equal(policy.mode, 'none')
  assert.equal(policy.allowedToolNames.size, 0)
})

test('required requires a non-empty declared tool list', () => {
  assert.equal(normalizeToolChoicePolicy('required', tools).mode, 'required')
  assert.throws(
    () => normalizeToolChoicePolicy('required', []),
    (error) => error instanceof ToolChoicePolicyError && error.code === 'tool_choice_required_without_tools',
  )
})

test('forced function choice requires name to exist in declared tools', () => {
  const policy = normalizeToolChoicePolicy(
    { type: 'function', function: { name: 'default_api:read_file' } },
    tools,
  )

  assert.equal(policy.mode, 'forced')
  assert.equal(policy.forcedName, 'default_api:read_file')
  assert.deepEqual([...policy.allowedToolNames], ['default_api:read_file'])
})

test('unsupported choices produce a structured error', () => {
  assert.throws(
    () => normalizeToolChoicePolicy({ type: 'function', function: { name: 'missing' } }, tools),
    (error) => error instanceof ToolChoicePolicyError && error.code === 'tool_choice_forced_tool_not_found',
  )
  assert.throws(
    () => normalizeToolChoicePolicy('unexpected' as never, tools),
    (error) => error instanceof ToolChoicePolicyError && error.code === 'tool_choice_unsupported',
  )
})
