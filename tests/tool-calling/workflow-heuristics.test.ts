import test from 'node:test'
import assert from 'node:assert/strict'
import type { ChatMessage } from '../../src/main/proxy/types.ts'
import {
  hasTrailingMatchedToolResultBatch,
  isToolCallMessage,
  isToolResultMessage,
} from '../../src/main/proxy/toolCalling/workflowHeuristics.ts'

function openAiCall(id: string, name = 'inspect'): ChatMessage {
  return {
    role: 'assistant',
    content: null,
    tool_calls: [{
      id,
      type: 'function',
      function: { name, arguments: '{}' },
    }],
  }
}

function openAiResult(id: string): ChatMessage {
  return { role: 'tool', tool_call_id: id, content: 'result' }
}

test('recognizes OpenAI and Anthropic tool message shapes', () => {
  assert.equal(isToolCallMessage(openAiCall('call-a')), true)
  assert.equal(isToolCallMessage({
    role: 'assistant',
    content: [{ type: 'tool_use', id: 'call-a', name: 'inspect', input: {} }],
  }), true)
  assert.equal(isToolCallMessage({ role: 'assistant', content: 'ordinary answer' }), false)

  assert.equal(isToolResultMessage(openAiResult('call-a')), true)
  assert.equal(isToolResultMessage({
    role: 'user',
    content: [{ type: 'tool_result', tool_use_id: 'call-a', content: 'result' }],
  }), true)
  assert.equal(isToolResultMessage({ role: 'user', content: 'ordinary request' }), false)
})

test('accepts a complete OpenAI result batch with exact IDs', () => {
  const messages = [
    {
      role: 'assistant',
      content: null,
      tool_calls: [
        { id: 'call-a', type: 'function', function: { name: 'inspect', arguments: '{}' } },
        { id: 'call-b', type: 'function', function: { name: 'edit', arguments: '{}' } },
      ],
    },
    openAiResult('call-b'),
    openAiResult('call-a'),
  ] as ChatMessage[]

  assert.equal(hasTrailingMatchedToolResultBatch(messages), true)
})

test('accepts a complete Anthropic result batch with exact IDs', () => {
  const messages = [
    {
      role: 'assistant',
      content: [
        { type: 'text', text: 'Calling tools.' },
        { type: 'tool_use', id: 'call-a', name: 'inspect', input: {} },
        { type: 'tool_use', id: 'call-b', name: 'edit', input: {} },
      ],
    },
    {
      role: 'user',
      content: [
        { type: 'tool_result', tool_use_id: 'call-b', content: 'second' },
        { type: 'tool_result', tool_use_id: 'call-a', content: 'first' },
      ],
    },
  ] as ChatMessage[]

  assert.equal(hasTrailingMatchedToolResultBatch(messages), true)
})

test('accepts OpenAI tool calls whose content field is omitted', () => {
  const messages = [
    {
      role: 'assistant',
      tool_calls: [{
        id: 'call-a',
        type: 'function',
        function: { name: 'inspect', arguments: '{}' },
      }],
    },
    openAiResult('call-a'),
  ] as ChatMessage[]

  assert.equal(hasTrailingMatchedToolResultBatch(messages), true)
})

test('accepts bridge-split assistant text between a call and its matching result', () => {
  const messages = [
    openAiCall('call-a'),
    { role: 'assistant', content: 'I will inspect the export directory.' },
    openAiResult('call-a'),
  ] as ChatMessage[]

  assert.equal(hasTrailingMatchedToolResultBatch(messages), true)
})

test('only skips structurally valid assistant text before trailing results', () => {
  const invalidInterveningMessages = [
    { role: 'user', content: 'start a different task' },
    { role: 'assistant', content: 'text', tool_calls: {} },
    { role: 'assistant', content: [{ type: 'image_url', image_url: { url: 'https://example.test/a.png' } }] },
    openAiCall('call-b', 'unrelated'),
  ] as unknown as ChatMessage[]

  for (const interveningMessage of invalidInterveningMessages) {
    assert.equal(
      hasTrailingMatchedToolResultBatch([
        openAiCall('call-a'),
        interveningMessage,
        openAiResult('call-a'),
      ]),
      false,
    )
  }
})

test('rejects incomplete, duplicate, mismatched, and non-adjacent result batches', () => {
  const callBatch = {
    role: 'assistant',
    content: null,
    tool_calls: [
      { id: 'call-a', type: 'function', function: { name: 'inspect', arguments: '{}' } },
      { id: 'call-b', type: 'function', function: { name: 'edit', arguments: '{}' } },
    ],
  } as ChatMessage

  const invalidBatches = [
    [callBatch, openAiResult('call-a')],
    [callBatch, openAiResult('call-a'), openAiResult('call-a')],
    [callBatch, openAiResult('call-a'), openAiResult('call-c')],
    [callBatch, openAiResult('call-a'), { role: 'assistant', content: 'boundary' }, openAiResult('call-b')],
    [
      callBatch,
      openAiResult('call-a'),
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call-b', content: 'result' }, { type: 'text', text: 'mixed payload' }] },
    ],
  ] as ChatMessage[][]

  for (const messages of invalidBatches) {
    assert.equal(hasTrailingMatchedToolResultBatch(messages), false)
  }
})

test('rejects malformed call and result metadata', () => {
  const malformedBatches = [
    [
      { role: 'assistant', content: null, tool_calls: [{ id: '', type: 'function', function: { name: 'inspect', arguments: '{}' } }] },
      { role: 'tool', tool_call_id: '', content: 'result' },
    ],
    [
      { role: 'assistant', content: null, tool_calls: [{ id: 'call-a', type: 'function', function: { name: '', arguments: '{}' } }] },
      openAiResult('call-a'),
    ],
    [
      { role: 'assistant', content: null, tool_calls: [{ id: 'call-a', type: 'function', function: { name: 'inspect', arguments: {} } }] },
      openAiResult('call-a'),
    ],
    [
      { role: 'assistant', content: [{ type: 'tool_use', id: 'call-a', name: 'inspect', input: null }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call-a', content: 'result' }] },
    ],
    [
      openAiCall('call-a'),
      { role: 'tool', tool_call_id: 'call-a', content: 'result', function_call: { name: 'inspect', arguments: '{}' } },
    ],
  ] as unknown as ChatMessage[][]

  for (const messages of malformedBatches) {
    assert.equal(hasTrailingMatchedToolResultBatch(messages), false)
  }
})

test('ordinary prose never becomes a structural continuation signal', () => {
  const completedExchange = [openAiCall('call-a'), openAiResult('call-a')]
  const terminalTexts = [
    'Understood. I will follow these instructions.',
    'continue',
    'I will inspect the folder next.',
    'Next:',
    '\u7ee7\u7eed\u5f53\u524d\u5de5\u4f5c',
    '\u63a5\u4e0b\u6765\u6211\u4f1a\u8fd0\u884c\u6d4b\u8bd5\uff1a',
  ]

  for (const content of terminalTexts) {
    assert.equal(
      hasTrailingMatchedToolResultBatch([
        ...completedExchange,
        { role: 'assistant', content },
      ]),
      false,
      content,
    )
    assert.equal(
      hasTrailingMatchedToolResultBatch([
        ...completedExchange,
        { role: 'user', content },
      ]),
      false,
      content,
    )
  }
})
