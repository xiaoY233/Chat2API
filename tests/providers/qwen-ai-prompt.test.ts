import test from 'node:test'
import assert from 'node:assert/strict'
import { buildQwenAiPrompt } from '../../src/main/proxy/adapters/qwen-ai.ts'

test('Qwen AI prompt keeps system and user turns', () => {
  const { systemContent, userContent } = buildQwenAiPrompt([
    { role: 'system', content: 'Be concise' },
    { role: 'user', content: 'Hello' },
  ])

  assert.equal(systemContent, 'Be concise')
  assert.equal(userContent, 'User: Hello')
})

test('Qwen AI prompt flattens tool calls and tool results', () => {
  const { userContent } = buildQwenAiPrompt(
    [
      { role: 'user', content: 'read /tmp/a' },
      {
        role: 'assistant',
        content: null,
        tool_calls: [{
          id: 'call_1',
          function: { name: 'default_api:read_file', arguments: '{"filePath":"/tmp/a"}' },
        }],
      },
      { role: 'tool', tool_call_id: 'call_1', content: 'file body' },
    ],
    'managed_bracket',
  )

  assert.match(userContent, /\[function_calls\]/)
  assert.match(userContent, /\[call:default_api:read_file\]/)
  assert.match(userContent, /\[TOOL_RESULT for call_1\] file body/)
})
