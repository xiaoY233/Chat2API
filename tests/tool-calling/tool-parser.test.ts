import test from 'node:test'
import assert from 'node:assert/strict'
import { managedBracketProtocol } from '../../src/main/proxy/toolCalling/protocols/managedBracket.ts'
import { managedXmlProtocol } from '../../src/main/proxy/toolCalling/protocols/managedXml.ts'
import { anthropicToolUseProtocol } from '../../src/main/proxy/toolCalling/protocols/anthropicToolUse.ts'
import { codexResponsesProtocol } from '../../src/main/proxy/toolCalling/protocols/codexResponses.ts'
import { jsonToolCallsProtocol } from '../../src/main/proxy/toolCalling/protocols/jsonToolCalls.ts'
import { cherryToolUseProtocol } from '../../src/main/proxy/toolCalling/protocols/cherryToolUse.ts'
import { xmlToolTagProtocol } from '../../src/main/proxy/toolCalling/protocols/xmlToolTag.ts'

const tools = [
  {
    name: 'default_api:read_file',
    description: 'Read a file',
    parameters: { type: 'object' },
    source: 'openai' as const,
  },
]

test('managed bracket parses valid tool call', () => {
  const result = managedBracketProtocol.parse(
    '[function_calls]\n[call:default_api:read_file]{"filePath":"/tmp/a"}[/call]\n[/function_calls]',
    { tools, protocol: 'managed_bracket' },
  )

  assert.equal(result.toolCalls.length, 1)
  assert.equal(result.toolCalls[0].function.name, 'default_api:read_file')
  assert.equal(result.content, '')
})

test('managed xml parses valid Chat2API tool call', () => {
  const result = managedXmlProtocol.parse(
    '<|CHAT2API|tool_calls><|CHAT2API|invoke name="default_api:read_file"><|CHAT2API|parameter name="filePath"><![CDATA[/tmp/a]]></|CHAT2API|parameter></|CHAT2API|invoke></|CHAT2API|tool_calls>',
    { tools, protocol: 'managed_xml' },
  )

  assert.equal(result.toolCalls.length, 1)
  assert.equal(result.toolCalls[0].function.name, 'default_api:read_file')
})

test('managed xml parses canonical XML compatibility form', () => {
  const result = managedXmlProtocol.parse(
    '<tool_calls><invoke name="default_api:read_file"><parameter name="filePath">/tmp/a</parameter></invoke></tool_calls>',
    { tools, protocol: 'managed_xml' },
  )

  assert.equal(result.toolCalls.length, 1)
  assert.equal(JSON.parse(result.toolCalls[0].function.arguments).filePath, '/tmp/a')
})

test('managed xml parses fenced tool calls and removes the fence', () => {
  const result = managedXmlProtocol.parse(
    '```xml\n<|CHAT2API|tool_calls><|CHAT2API|invoke name="default_api:read_file"><|CHAT2API|parameter name="filePath">/tmp/a</|CHAT2API|parameter></|CHAT2API|invoke></|CHAT2API|tool_calls>\n```',
    { tools, protocol: 'managed_xml' },
  )

  assert.equal(result.toolCalls.length, 1)
  assert.equal(result.content, '')
})

test('fenced tool call preserves unrelated code in the same fence', () => {
  const result = managedXmlProtocol.parse(
    '```xml\nconst before = 1\n<tool_calls><invoke name="default_api:read_file"><parameter name="filePath">/tmp/a</parameter></invoke></tool_calls>\nconst after = 2\n```',
    { tools, protocol: 'managed_xml' },
  )

  assert.equal(result.toolCalls.length, 1)
  assert.match(result.content, /const before = 1/)
  assert.match(result.content, /const after = 2/)
  assert.match(result.content, /```xml/)
})

test('tool call after a code fence keeps the code block in content', () => {
  const result = managedXmlProtocol.parse(
    'Here is the code:\n```ts\nconst a = 1\n```\n<tool_calls><invoke name="default_api:read_file"><parameter name="filePath">/tmp/a</parameter></invoke></tool_calls>',
    { tools, protocol: 'managed_xml' },
  )

  assert.equal(result.toolCalls.length, 1)
  assert.equal(result.content, 'Here is the code:\n```ts\nconst a = 1\n```')
})

test('fenced bracket tool call is parsed', () => {
  const result = managedBracketProtocol.parse(
    '```\n[function_calls][call:default_api:read_file]{"filePath":"/tmp/a"}[/call][/function_calls]\n```',
    { tools, protocol: 'managed_bracket' },
  )

  assert.equal(result.toolCalls.length, 1)
  assert.equal(result.content, '')
})

test('unknown tool name is rejected', () => {
  const result = managedBracketProtocol.parse(
    '[function_calls][call:missing_tool]{"x":1}[/call][/function_calls]',
    { tools, protocol: 'managed_bracket' },
  )

  assert.equal(result.toolCalls.length, 0)
  assert.deepEqual(result.invalidToolNames, ['missing_tool'])
})

test('managed XML parser rejects undeclared tool names and records invalid names', () => {
  const result = managedXmlProtocol.parse(
    '<|CHAT2API|tool_calls><|CHAT2API|invoke name="missing_tool">{}</|CHAT2API|invoke></|CHAT2API|tool_calls>',
    { tools, protocol: 'managed_xml' },
  )

  assert.equal(result.toolCalls.length, 0)
  assert.deepEqual(result.invalidToolNames, ['missing_tool'])
})

test('anthropic adapter parses antml function calls', () => {
  const result = anthropicToolUseProtocol.parse(
    '<antml:function_calls><antml:invoke name="default_api:read_file"><antml:parameters>{"filePath":"/tmp/a"}</antml:parameters></antml:invoke></antml:function_calls>',
    { tools, protocol: 'anthropic_tool_use' },
  )

  assert.equal(result.toolCalls.length, 1)
})

test('codex responses adapter parses response item function call', () => {
  const result = codexResponsesProtocol.parse(
    JSON.stringify({
      type: 'function_call',
      call_id: 'call_1',
      name: 'default_api:read_file',
      arguments: '{"filePath":"/tmp/a"}',
    }),
    { tools, protocol: 'codex_responses' },
  )

  assert.equal(result.toolCalls.length, 1)
  assert.equal(result.toolCalls[0].id, 'call_1')
})

test('OpenAI JSON tool_calls shape is parsed', () => {
  const result = jsonToolCallsProtocol.parse(
    JSON.stringify({
      tool_calls: [{
        type: 'function',
        function: { name: 'default_api:read_file', arguments: '{"filePath":"/tmp/a"}' },
      }],
    }),
    { tools, protocol: 'json_tool_calls' },
  )

  assert.equal(result.toolCalls.length, 1)
  assert.equal(result.toolCalls[0].function.name, 'default_api:read_file')
  assert.equal(result.content, '')
})

test('simple JSON tool call is parsed', () => {
  const result = jsonToolCallsProtocol.parse(
    '{"name":"default_api:read_file","arguments":{"filePath":"/tmp/a"}}',
    { tools, protocol: 'json_tool_calls' },
  )

  assert.equal(result.toolCalls.length, 1)
  assert.equal(JSON.parse(result.toolCalls[0].function.arguments).filePath, '/tmp/a')
})

test('Hermes-style tool_call JSON wrapper is parsed', () => {
  const result = jsonToolCallsProtocol.parse(
    '<tool_call>\n{"name":"default_api:read_file","arguments":{"filePath":"/tmp/a"}}\n</tool_call>',
    { tools, protocol: 'json_tool_calls' },
  )

  assert.equal(result.toolCalls.length, 1)
  assert.equal(result.content, '')
})

test('fenced JSON tool call is parsed and the fence removed', () => {
  const result = jsonToolCallsProtocol.parse(
    '```json\n{"tool_calls":[{"type":"function","function":{"name":"default_api:read_file","arguments":{"filePath":"/tmp/a"}}}]}\n```',
    { tools, protocol: 'json_tool_calls' },
  )

  assert.equal(result.toolCalls.length, 1)
  assert.equal(result.content, '')
})

test('Cherry Studio tool_use XML is parsed', () => {
  const result = cherryToolUseProtocol.parse(
    '<tool_use><name>default_api:read_file</name><arguments>{"filePath":"/tmp/a"}</arguments></tool_use>',
    { tools, protocol: 'cherry_tool_use' },
  )

  assert.equal(result.toolCalls.length, 1)
  assert.equal(result.content, '')
})

test('Cline-style tool tag XML is parsed', () => {
  const result = xmlToolTagProtocol.parse(
    '<default_api:read_file><filePath>/tmp/a</filePath></default_api:read_file>',
    { tools, protocol: 'xml_tool_tag' },
  )

  assert.equal(result.toolCalls.length, 1)
  assert.equal(JSON.parse(result.toolCalls[0].function.arguments).filePath, '/tmp/a')
})

test('anthropic function calls parse inside a fence', () => {
  const result = anthropicToolUseProtocol.parse(
    '```xml\n<antml:function_calls><antml:invoke name="default_api:read_file"><antml:parameters>{"filePath":"/tmp/a"}</antml:parameters></antml:invoke></antml:function_calls>\n```',
    { tools, protocol: 'anthropic_tool_use' },
  )

  assert.equal(result.toolCalls.length, 1)
  assert.equal(result.content, '')
})

test('JSON repair accepts trailing commas and single-quoted keys', () => {
  const result = jsonToolCallsProtocol.parse(
    "{'name':'default_api:read_file','arguments':{'filePath':'/tmp/a',},}",
    { tools, protocol: 'json_tool_calls' },
  )

  assert.equal(result.toolCalls.length, 1)
  assert.equal(JSON.parse(result.toolCalls[0].function.arguments).filePath, '/tmp/a')
})
