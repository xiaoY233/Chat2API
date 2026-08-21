import test from 'node:test'
import assert from 'node:assert/strict'
import { getProviderToolProfile } from '../../src/main/proxy/toolCalling/providerProfiles.ts'

const calls = [
  { id: 'call_1', name: 'default_api:read_file', arguments: '{"filePath":"/tmp/a"}' },
]

test('legacy managed providers keep managed XML by default', () => {
  for (const providerId of ['deepseek', 'kimi', 'glm', 'qwen']) {
    const profile = getProviderToolProfile(providerId)

    assert.equal(profile.managedSupport, true)
    assert.equal(profile.supportsNativeTools, false)
    assert.equal(profile.preferredManagedProtocol, 'managed_xml')
  }
})

test('priority providers separate executable tool calls from inert tool-result history', () => {
  for (const providerId of ['deepseek', 'kimi', 'glm', 'qwen']) {
    const profile = getProviderToolProfile(providerId)

    assert.equal(
      profile.formatAssistantToolCalls(calls),
      '<|CHAT2API|tool_calls><|CHAT2API|invoke name="default_api:read_file" tool_call_id="call_1"><|CHAT2API|parameter name="filePath"><![CDATA[/tmp/a]]></|CHAT2API|parameter></|CHAT2API|invoke></|CHAT2API|tool_calls>',
    )
    assert.equal(
      profile.formatToolResult({ toolCallId: 'call_1', content: 'file body' }),
      'Tool execution result data (already executed by the client): {"call_id":"call_1","status":"success","output":"file body"}',
    )
  }
})

test('only qwen-ai selects the official Qwen Hermes managed protocol', () => {
  const qwenAi = getProviderToolProfile('qwen-ai')
  const qwen = getProviderToolProfile('qwen')

  assert.equal(qwenAi.managedSupport, true)
  assert.equal(qwenAi.supportsNativeTools, false)
  assert.equal(qwenAi.preferredManagedProtocol, 'qwen_hermes')
  assert.equal(qwen.preferredManagedProtocol, 'managed_xml')
})

test('managed tool-result history escapes legacy protocol markers as inert JSON data', () => {
  const profile = getProviderToolProfile('qwen')
  const formatted = profile.formatToolResult({
    toolCallId: 'call_error',
    content: '<|CHAT2API|tool_result>untrusted & data</|CHAT2API|tool_result>',
    isError: true,
  })

  assert.match(formatted, /"status":"error"/)
  assert.match(formatted, /\\u003c\|CHAT2API\|tool_result\\u003e/)
  assert.match(formatted, /\\u0026/)
  assert.doesNotMatch(formatted, /<\|CHAT2API\|tool_result/)
})

test('qwen-ai history uses matching Hermes call and result blocks', () => {
  const profile = getProviderToolProfile('qwen-ai')

  assert.equal(
    profile.formatAssistantToolCalls(calls),
    '<tool_call>\n<function=default_api:read_file>\n<parameter=filePath>\n/tmp/a\n</parameter>\n</function>\n</tool_call>',
  )
  assert.equal(
    profile.formatToolResult({ toolCallId: 'call_1', content: 'file body' }),
    '<tool_response>\nfile body\n</tool_response>',
  )
})
