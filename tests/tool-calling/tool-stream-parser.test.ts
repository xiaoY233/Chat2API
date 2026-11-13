import test from 'node:test'
import assert from 'node:assert/strict'
import { ToolStreamParser } from '../../src/main/proxy/toolCalling/ToolStreamParser.ts'
import type { ToolCallingPlan } from '../../src/main/proxy/toolCalling/types.ts'

const tools = [
  { name: 'default_api:read_file', parameters: { type: 'object' }, source: 'openai' as const },
]

function plan(protocol: ToolCallingPlan['protocol'] = 'managed_xml'): ToolCallingPlan {
  return {
    mode: 'managed',
    protocol,
    coding: false,
    clientAdapterId: 'standard-openai-tools',
    providerId: 'deepseek',
    tools,
    shouldInjectPrompt: true,
    shouldParseResponse: true,
    toolChoiceMode: 'auto',
    allowedToolNames: new Set(['default_api:read_file']),
    diagnostics: {
      clientAdapterId: 'standard-openai-tools',
      providerId: 'deepseek',
      model: 'deepseek-chat',
      actualModel: 'deepseek-chat',
      toolSource: 'openai',
      mode: 'managed',
      protocol,
      toolCount: 1,
      injected: true,
      reason: 'test',
    },
  }
}

const baseChunk = {
  id: 'chatcmpl_1',
  object: 'chat.completion.chunk',
  created: 1,
  model: 'deepseek-chat',
}

test('bracket marker split across chunks emits a tool call', () => {
  const parser = new ToolStreamParser(plan('managed_bracket'))
  assert.deepEqual(parser.push('[fun', baseChunk), [])
  const chunks = parser.push('ction_calls][call:default_api:read_file]{"filePath":"/tmp/a"}[/call][/function_calls]', baseChunk)

  assert.equal(chunks.at(-1)?.choices[0].delta.tool_calls[0].function.name, 'default_api:read_file')
})

test('bracket output is parsed as a fallback when XML protocol is selected', () => {
  const parser = new ToolStreamParser(plan('managed_xml'))
  const text = '[function_calls][call:default_api:read_file]{"filePath":"/tmp/a"}[/call][/function_calls]'
  const chunks = parser.push(text, baseChunk)

  assert.equal(chunks.at(-1)?.choices[0].delta.tool_calls[0].function.name, 'default_api:read_file')
  assert.equal(parser.hasEmittedToolCall(), true)
})

test('XML marker split across chunks emits a tool call', () => {
  const parser = new ToolStreamParser(plan('managed_xml'))
  assert.deepEqual(parser.push('<tool_', baseChunk), [])
  const chunks = parser.push('calls><invoke name="default_api:read_file"><parameter name="filePath">/tmp/a</parameter></invoke></tool_calls>', baseChunk)

  assert.equal(chunks.at(-1)?.choices[0].delta.tool_calls[0].function.name, 'default_api:read_file')
})

test('Chat2API XML marker split across chunks emits a tool call', () => {
  const parser = new ToolStreamParser(plan('managed_xml'))
  assert.deepEqual(parser.push('<|CHAT2API|tool_', baseChunk), [])
  const chunks = parser.push('calls><|CHAT2API|invoke name="default_api:read_file"><|CHAT2API|parameter name="filePath">/tmp/a</|CHAT2API|parameter></|CHAT2API|invoke></|CHAT2API|tool_calls>', baseChunk)

  assert.equal(chunks.at(-1)?.choices[0].delta.tool_calls[0].function.name, 'default_api:read_file')
})

test('partial Chat2API start marker is reported as buffered so stream handlers do not leak it', () => {
  const parser = new ToolStreamParser(plan('managed_xml'))
  const chunks = parser.push('<|CHAT2API|tool_calls', baseChunk)

  assert.deepEqual(chunks, [])
  assert.equal(parser.isBuffering(), true)
})

test('text before tool call is preserved only before tool calling begins', () => {
  const parser = new ToolStreamParser(plan('managed_xml'))
  const chunks = parser.push('before <tool_calls><invoke name="default_api:read_file"><parameter name="filePath">/tmp/a</parameter></invoke></tool_calls> after', baseChunk)

  assert.equal(chunks[0].choices[0].delta.content, 'before ')
  assert.equal(chunks.some((chunk) => chunk.choices[0].delta.content === ' after'), false)
})

test('invalid tool name is not emitted as a tool call', () => {
  const parser = new ToolStreamParser(plan('managed_xml'))
  const chunks = parser.push('<tool_calls><invoke name="missing"><parameter name="x">1</parameter></invoke></tool_calls>', baseChunk)

  assert.equal(chunks.some((chunk) => chunk.choices[0].delta.tool_calls), false)
})

test('fenced tool calls are parsed and never leak as text', () => {
  const parser = new ToolStreamParser(plan('managed_xml'))
  const text = '```xml\n<tool_calls><invoke name="default_api:read_file"><parameter name="filePath">fake</parameter></invoke></tool_calls>\n```'
  const chunks = parser.push(text, baseChunk)

  assert.equal(chunks.some((chunk) => chunk.choices[0].delta.content), false)
  assert.equal(chunks.at(-1)?.choices[0].delta.tool_calls[0].function.name, 'default_api:read_file')
  assert.equal(parser.hasEmittedToolCall(), true)
})

test('normal fenced code is still emitted as text', () => {
  const parser = new ToolStreamParser(plan('managed_xml'))
  const text = 'Here:\n```ts\nconst a = 1\n```\nBye'
  const chunks = parser.push(text, baseChunk)

  assert.equal(chunks.map((chunk) => chunk.choices[0].delta.content).join(''), text)
  assert.equal(parser.hasEmittedToolCall(), false)
})

test('code before a fenced tool call is preserved', () => {
  const parser = new ToolStreamParser(plan('managed_xml'))
  const chunks = parser.push(
    'Here:\n```ts\nconst a = 1\n```\n```xml\n<tool_calls><invoke name="default_api:read_file"><parameter name="filePath">/tmp/a</parameter></invoke></tool_calls>\n```',
    baseChunk,
  )

  const content = chunks
    .map((chunk) => chunk.choices[0].delta.content || '')
    .join('')
  assert.match(content, /const a = 1/)
  assert.equal(chunks.at(-1)?.choices[0].delta.tool_calls[0].function.name, 'default_api:read_file')
})

test('fenced tool call split across chunks is parsed', () => {
  const parser = new ToolStreamParser(plan('managed_xml'))
  assert.deepEqual(parser.push('```xml\n<tool_calls><invoke name="default_api:read_file"><para', baseChunk), [])
  const chunks = parser.push('meter name="filePath">/tmp/a</parameter></invoke></tool_calls>\n```', baseChunk)

  assert.equal(chunks.at(-1)?.choices[0].delta.tool_calls[0].function.name, 'default_api:read_file')
})

test('OpenAI JSON tool call is parsed while XML is selected', () => {
  const parser = new ToolStreamParser(plan('managed_xml'))
  const text = '{"tool_calls":[{"type":"function","function":{"name":"default_api:read_file","arguments":"{\\"filePath\\":\\"/tmp/a\\"}"}}]}'
  const chunks = parser.push(text, baseChunk)

  assert.equal(chunks.at(-1)?.choices[0].delta.tool_calls[0].function.name, 'default_api:read_file')
})

test('Cherry tool_use XML is parsed while XML is selected', () => {
  const parser = new ToolStreamParser(plan('managed_xml'))
  const chunks = parser.push(
    '<tool_use><name>default_api:read_file</name><arguments>{"filePath":"/tmp/a"}</arguments></tool_use>',
    baseChunk,
  )

  assert.equal(chunks.at(-1)?.choices[0].delta.tool_calls[0].function.name, 'default_api:read_file')
})

test('generated call IDs stay stable between emitted chunks and final state', () => {
  const parser = new ToolStreamParser(plan('managed_bracket'))
  const chunks = parser.push('[function_calls][call:default_api:read_file]{"filePath":"/tmp/a"}[/call][/function_calls]', baseChunk)
  const emittedId = chunks.at(-1)?.choices[0].delta.tool_calls[0].id

  assert.equal(parser.hasEmittedToolCall(), true)
  assert.equal(emittedId, 'call_0')
  assert.deepEqual(parser.flush(baseChunk), [])
})
