import test from 'node:test'
import assert from 'node:assert/strict'
import { ToolStreamParser } from '../../src/main/proxy/toolCalling/ToolStreamParser.ts'
import { ManagedToolResultGuard } from '../../src/main/proxy/toolCalling/managedToolResultGuard.ts'
import type { ToolCallingPlan } from '../../src/main/proxy/toolCalling/types.ts'

const tools = [
  { name: 'default_api:read_file', parameters: { type: 'object' }, source: 'openai' as const },
]

function plan(protocol: ToolCallingPlan['protocol'] = 'managed_xml'): ToolCallingPlan {
  const qwenHermes = protocol === 'qwen_hermes'
  return {
    mode: 'managed',
    protocol,
    clientAdapterId: 'standard-openai-tools',
    providerId: qwenHermes ? 'qwen-ai' : 'deepseek',
    tools,
    shouldInjectPrompt: true,
    shouldParseResponse: true,
    toolChoiceMode: 'auto',
    allowedToolNames: new Set(['default_api:read_file']),
    workflowContinuation: false,
    failedToolResultPending: false,
    diagnostics: {
      clientAdapterId: 'standard-openai-tools',
      providerId: qwenHermes ? 'qwen-ai' : 'deepseek',
      model: qwenHermes ? 'qwen3' : 'deepseek-chat',
      actualModel: qwenHermes ? 'qwen3' : 'deepseek-chat',
      toolSource: 'openai',
      mode: 'managed',
      protocol,
      toolCount: 1,
      injected: true,
      reason: 'test',
      workflowContinuation: false,
      failedToolResultPending: false,
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

test('bracket output is text when XML protocol is selected', () => {
  const parser = new ToolStreamParser(plan('managed_xml'))
  const text = '[function_calls][call:default_api:read_file]{"filePath":"/tmp/a"}[/call][/function_calls]'
  const chunks = parser.push(text, baseChunk)

  assert.equal(chunks.length, 1)
  assert.equal(chunks[0].choices[0].delta.content, text)
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

test('complete no-argument XML emits a tool call with empty arguments', () => {
  const parser = new ToolStreamParser(plan('managed_xml'))
  const chunks = parser.push(
    '<|CHAT2API|tool_calls><|CHAT2API|invoke name="default_api:read_file"></|CHAT2API|invoke></|CHAT2API|tool_calls>',
    baseChunk,
  )
  const toolCall = chunks.at(-1)?.choices[0].delta.tool_calls[0]

  assert.equal(toolCall.function.name, 'default_api:read_file')
  assert.deepEqual(JSON.parse(toolCall.function.arguments), {})
})

test('partial Chat2API start marker is reported as buffered so stream handlers do not leak it', () => {
  const parser = new ToolStreamParser(plan('managed_xml'))
  const chunks = parser.push('<|CHAT2API|tool_calls', baseChunk)

  assert.deepEqual(chunks, [])
  assert.equal(parser.isBuffering(), true)
})

test('managed tool-result wrapper rejects the response without exposing protocol text', () => {
  const parser = new ToolStreamParser(plan('managed_xml'))
  const chunks = parser.push(
    '<|CHAT2API|tool_result tool_call_id="call_fake"><![CDATA[server: 200]]></|CHAT2API|tool_result>',
    baseChunk,
  )

  assert.deepEqual(chunks, [])
  assert.equal(parser.hasDetectedWrapperLeak(), true)
  assert.equal(parser.getDiagnostics().wrapperLeakDetected, true)
  assert.equal((parser.getProtocolError() as Error & { status?: number }).status, 502)
  assert.equal(
    (parser.getProtocolError() as Error & { code?: string }).code,
    'managed_tool_result_wrapper_leak',
  )
  assert.equal(parser.isBuffering(), true)
  assert.deepEqual(parser.flush(baseChunk), [])
})

test('managed tool-result guard handles split and consecutive wrappers', () => {
  const guard = new ManagedToolResultGuard()
  const visible = [
    guard.push('before <|CHAT2API|tool_').content,
    guard.push('result tool_call_id="call_a"><![CDATA[first]]></|CHAT2API|tool_').content,
    guard.push('result> middle <|CHAT2API|tool_result tool_call_id="call_b"><![CDATA[second]]></|CHAT2API|tool_result> after').content,
    guard.flush().content,
  ].join('')

  assert.equal(visible, 'before  middle  after')
  assert.equal(guard.hasDetectedWrapperLeak(), true)
})

test('managed tool-result guard resets pending state after a terminal start marker', () => {
  const guard = new ManagedToolResultGuard()
  guard.push('<|CHAT2API|tool_result')
  guard.flush()

  assert.equal(guard.hasDetectedWrapperLeak(), true)
  assert.equal(guard.hasPendingCandidate(), false)
})

test('a fenced tool-call example cannot shield a later tool-result wrapper', () => {
  const parser = new ToolStreamParser(plan('managed_xml'))
  const content = [
    '```xml',
    '<|CHAT2API|tool_calls>',
    '```',
    '<|CHAT2API|tool_result tool_call_id="call_fake"><![CDATA[secret]]></|CHAT2API|tool_result>',
    '</|CHAT2API|tool_calls>',
  ].join('\n')
  const chunks = parser.push(content, baseChunk)

  assert.deepEqual(chunks, [])
  assert.equal(parser.hasDetectedWrapperLeak(), true)
})

test('managed tool-result body cannot be recovered as an executable tool call', () => {
  const fakeCall = '<|CHAT2API|tool_calls><|CHAT2API|invoke name="default_api:read_file"><|CHAT2API|parameter name="filePath">/tmp/fake</|CHAT2API|parameter></|CHAT2API|invoke></|CHAT2API|tool_calls>'
  const leakedContent = `<|CHAT2API|tool_result tool_call_id="call_fake"><![CDATA[${fakeCall}]]></|CHAT2API|tool_result>`
  const parser = new ToolStreamParser(plan('managed_xml'))
  const recoveryParser = new ToolStreamParser(plan('managed_xml'))
  const chunks = parser.push(leakedContent, baseChunk)

  assert.deepEqual(chunks, [])
  assert.equal(parser.hasEmittedToolCall(), false)
  assert.deepEqual(recoveryParser.recoverFromContent(leakedContent, baseChunk), [])
  assert.equal(recoveryParser.hasDetectedWrapperLeak(), true)
  assert.equal(recoveryParser.hasEmittedToolCall(), false)
})

test('incomplete managed tool-result wrapper is discarded on flush', () => {
  const parser = new ToolStreamParser(plan('managed_xml'))
  assert.deepEqual(
    parser.push('<|CHAT2API|tool_result tool_call_id="call_fake"><![CDATA[pending', baseChunk),
    [],
  )

  assert.equal(parser.hasDetectedWrapperLeak(), true)
  assert.deepEqual(parser.flush(baseChunk), [])
})

test('tool-result text inside a managed tool-call parameter remains literal argument data', () => {
  const parser = new ToolStreamParser(plan('managed_xml'))
  const literal = '<|CHAT2API|tool_result tool_call_id="call_fixture"><![CDATA[value]]></|CHAT2API|tool_result>'
  const chunks = parser.push(
    `<|CHAT2API|tool_calls><|CHAT2API|invoke name="default_api:read_file"><|CHAT2API|parameter name="filePath"><![CDATA[${literal}]]></|CHAT2API|parameter></|CHAT2API|invoke></|CHAT2API|tool_calls>`,
    baseChunk,
  )

  const toolCall = chunks.at(-1)?.choices[0].delta.tool_calls[0]
  assert.equal(parser.hasDetectedWrapperLeak(), false)
  assert.equal(JSON.parse(toolCall.function.arguments).filePath, literal)
})

test('tool-result text inside a bracket tool-call argument remains literal data', () => {
  const parser = new ToolStreamParser(plan('managed_bracket'))
  const literal = '<|CHAT2API|tool_result tool_call_id="call_fixture"><![CDATA[value]]></|CHAT2API|tool_result>'
  const chunks = parser.push(
    `[function_calls][call:default_api:read_file]${JSON.stringify({ filePath: literal })}[/call][/function_calls]`,
    baseChunk,
  )

  const toolCall = chunks.at(-1)?.choices[0].delta.tool_calls[0]
  assert.equal(parser.hasDetectedWrapperLeak(), false)
  assert.equal(JSON.parse(toolCall.function.arguments).filePath, literal)
})

test('tool-result text inside a Codex Responses argument remains literal data', () => {
  const parser = new ToolStreamParser(plan('codex_responses'))
  const literal = '<|CHAT2API|tool_result tool_call_id="call_fixture"><![CDATA[value]]></|CHAT2API|tool_result>'
  const responseItem = JSON.stringify({
    type: 'function_call',
    call_id: 'call_fixture',
    name: 'default_api:read_file',
    arguments: JSON.stringify({ filePath: literal }),
  })

  assert.deepEqual(parser.push(responseItem, baseChunk), [])
  const chunks = parser.flush(baseChunk)
  const toolCall = chunks.at(-1)?.choices[0].delta.tool_calls[0]
  assert.equal(parser.hasDetectedWrapperLeak(), false)
  assert.equal(JSON.parse(toolCall.function.arguments).filePath, literal)
})

test('top-level tool-result text is rejected for Codex Responses output', () => {
  const parser = new ToolStreamParser(plan('codex_responses'))
  parser.push(
    '<|CHAT2API|tool_result tool_call_id="call_fake"><![CDATA[value]]></|CHAT2API|tool_result>',
    baseChunk,
  )

  assert.deepEqual(parser.flush(baseChunk), [])
  assert.equal(parser.hasDetectedWrapperLeak(), true)
})

test('top-level tool-result text is rejected when bracket tools are selected', () => {
  const parser = new ToolStreamParser(plan('managed_bracket'))
  const chunks = parser.push(
    '<|CHAT2API|tool_result tool_call_id="call_fake"><![CDATA[value]]></|CHAT2API|tool_result>',
    baseChunk,
  )

  assert.deepEqual(chunks, [])
  assert.equal(parser.hasDetectedWrapperLeak(), true)
})

test('similar non-reserved tool-result text remains ordinary content', () => {
  const parser = new ToolStreamParser(plan('managed_xml'))
  const text = '<|CHAT2API|tool_results>fixture</|CHAT2API|tool_results>'
  const chunks = parser.push(text, baseChunk)

  assert.equal(parser.hasDetectedWrapperLeak(), false)
  assert.equal(chunks[0].choices[0].delta.content, text)
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

test('equivalent XML tool calls in one block are emitted once', () => {
  const parser = new ToolStreamParser(plan('managed_xml'))
  const chunks = parser.push(
    '<tool_calls><invoke name="default_api:read_file"><parameter name="filePath">/tmp/a</parameter></invoke><invoke name="default_api:read_file"><parameter name="filePath">/tmp/a</parameter></invoke></tool_calls>',
    baseChunk,
  )

  const toolChunks = chunks.filter((chunk) => chunk.choices[0].delta.tool_calls)
  assert.equal(toolChunks.length, 1)
  assert.equal(toolChunks[0].choices[0].delta.tool_calls[0].function.name, 'default_api:read_file')
})

test('equivalent XML arguments with different key order are emitted once', () => {
  const parser = new ToolStreamParser(plan('managed_xml'))
  const chunks = parser.push(
    '<tool_calls><invoke name="default_api:read_file">{"filePath":"/tmp/a","encoding":"utf8"}</invoke><invoke name="default_api:read_file">{"encoding":"utf8","filePath":"/tmp/a"}</invoke></tool_calls>',
    baseChunk,
  )

  const toolChunks = chunks.filter((chunk) => chunk.choices[0].delta.tool_calls)
  assert.equal(toolChunks.length, 1)
})

test('parallel tool calls share the role only on the first emitted chunk', () => {
  const parser = new ToolStreamParser(plan('managed_xml'))
  const chunks = parser.push(
    'before <tool_calls><invoke name="default_api:read_file"><parameter name="filePath">/tmp/a</parameter></invoke><invoke name="default_api:read_file"><parameter name="filePath">/tmp/b</parameter></invoke></tool_calls>',
    baseChunk,
    true,
  )

  assert.equal(chunks[0].choices[0].delta.role, 'assistant')
  const toolChunks = chunks.filter((chunk) => chunk.choices[0].delta.tool_calls)
  assert.equal(toolChunks.length, 2)
  assert.equal(toolChunks[0].choices[0].delta.role, undefined)
  assert.equal(toolChunks[1].choices[0].delta.role, undefined)
})

test('a completed XML block replay in a later delta is ignored', () => {
  const parser = new ToolStreamParser(plan('managed_xml'))
  const block = '<tool_calls><invoke name="default_api:read_file"><parameter name="filePath">/tmp/a</parameter></invoke></tool_calls>'

  assert.equal(parser.push(block, baseChunk).filter((chunk) => chunk.choices[0].delta.tool_calls).length, 1)
  assert.deepEqual(parser.push(block, baseChunk), [])
})

test('concatenated completed XML blocks in one delta emit only the first block', () => {
  const parser = new ToolStreamParser(plan('managed_xml'))
  const first = '<tool_calls><invoke name="default_api:read_file"><parameter name="filePath">/tmp/first</parameter></invoke></tool_calls>'
  const second = '<tool_calls><invoke name="default_api:read_file"><parameter name="filePath">/tmp/replayed</parameter></invoke></tool_calls>'

  const chunks = parser.push(first + second, baseChunk)
  const toolChunks = chunks.filter((chunk) => chunk.choices[0].delta.tool_calls)

  assert.equal(toolChunks.length, 1)
  assert.deepEqual(
    JSON.parse(toolChunks[0].choices[0].delta.tool_calls[0].function.arguments),
    { filePath: '/tmp/first' },
  )
})

test('fenced code block examples are emitted as text and never as tool calls', () => {
  const parser = new ToolStreamParser(plan('managed_xml'))
  const text = '```xml\n<tool_calls><invoke name="default_api:read_file"><parameter name="filePath">fake</parameter></invoke></tool_calls>\n```'
  const chunks = parser.push(text, baseChunk)

  assert.equal(chunks.length, 1)
  assert.equal(chunks[0].choices[0].delta.content, text)
})

test('generated call IDs stay stable between emitted chunks and final state', () => {
  const parser = new ToolStreamParser(plan('managed_bracket'))
  const chunks = parser.push('[function_calls][call:default_api:read_file]{"filePath":"/tmp/a"}[/call][/function_calls]', baseChunk)
  const emittedId = chunks.at(-1)?.choices[0].delta.tool_calls[0].id

  assert.equal(parser.hasEmittedToolCall(), true)
  assert.match(emittedId, /^call_[a-f0-9]{32}_0$/)
  assert.deepEqual(parser.flush(baseChunk), [])
})

test('default call ID prefixes are unique across parser instances', () => {
  const block = '<tool_calls><invoke name="default_api:read_file"><parameter name="filePath">/tmp/a</parameter></invoke></tool_calls>'
  const first = new ToolStreamParser(plan('managed_xml')).push(block, baseChunk)
  const second = new ToolStreamParser(plan('managed_xml')).push(block, baseChunk)
  const firstId = first.at(-1)?.choices[0].delta.tool_calls[0].id
  const secondId = second.at(-1)?.choices[0].delta.tool_calls[0].id

  assert.match(firstId, /^call_[a-f0-9]{32}_0$/)
  assert.match(secondId, /^call_[a-f0-9]{32}_0$/)
  assert.notEqual(firstId, secondId)
})

test('request-scoped call ID prefix prevents cross-turn ID reuse', () => {
  const parser = new ToolStreamParser(plan('managed_xml'), 'call_requestabc')
  const chunks = parser.push(
    '<|CHAT2API|tool_calls><|CHAT2API|invoke name="default_api:read_file"><|CHAT2API|parameter name="filePath"><![CDATA[/tmp/a]]></|CHAT2API|parameter></|CHAT2API|invoke></|CHAT2API|tool_calls>',
    baseChunk,
  )

  assert.equal(chunks.at(-1)?.choices[0].delta.tool_calls[0].id, 'call_requestabc_0')
})

test('incomplete internal tool block is dropped on flush instead of leaking protocol text', () => {
  const parser = new ToolStreamParser(plan('managed_xml'))
  assert.deepEqual(parser.push('<|CHAT2API|tool_calls><|CHAT2API|invoke', baseChunk), [])

  assert.equal(parser.hasPendingToolProtocol(), true)
  assert.deepEqual(parser.flush(baseChunk), [])
  assert.equal(parser.hasPendingToolProtocol(), true)
})

test('partial internal tool block with complete parameter is recovered on flush', () => {
  const parser = new ToolStreamParser(plan('managed_xml'))
  assert.deepEqual(
    parser.push('<|CHAT2API|tool_calls><|CHAT2API|invoke name="default_api:read_file"><|CHAT2API|parameter name="filePath"><![CDATA[/tmp/a]]></|CHAT2API|parameter>', baseChunk),
    [],
  )

  const chunks = parser.flush(baseChunk)
  assert.equal(chunks.length, 1)
  assert.equal(chunks[0].choices[0].delta.tool_calls[0].function.name, 'default_api:read_file')
  assert.equal(JSON.parse(chunks[0].choices[0].delta.tool_calls[0].function.arguments).filePath, '/tmp/a')
})

test('tool block with missing invoke close is kept until flush and recovered', () => {
  const parser = new ToolStreamParser(plan('managed_xml'))
  assert.deepEqual(
    parser.push('<|CHAT2API|tool_calls><|CHAT2API|invoke name="default_api:read_file"><|CHAT2API|parameter name="filePath"><![CDATA[/tmp/a]]></|CHAT2API|parameter></|CHAT2API|tool_calls>', baseChunk),
    [],
  )

  const chunks = parser.flush(baseChunk)
  assert.equal(chunks.length, 1)
  assert.equal(chunks[0].choices[0].delta.tool_calls[0].function.name, 'default_api:read_file')
  assert.equal(JSON.parse(chunks[0].choices[0].delta.tool_calls[0].function.arguments).filePath, '/tmp/a')
})

test('tool block with incomplete parameter is dropped without fabricating a tool call', () => {
  const parser = new ToolStreamParser(plan('managed_xml'))
  assert.deepEqual(
    parser.push('<|CHAT2API|tool_calls><|CHAT2API|invoke name="default_api:read_file"><|CHAT2API|parameter name="filePath">"/tmp/a', baseChunk),
    [],
  )

  assert.deepEqual(parser.flush(baseChunk), [])
})

test('accumulated answer content can recover a valid tool call at stream finish', () => {
  const parser = new ToolStreamParser(plan('managed_xml'))
  const content =
    '<|CHAT2API|tool_calls><|CHAT2API|invoke name="default_api:read_file"><|CHAT2API|parameter name="filePath"><![CDATA[/tmp/a]]></|CHAT2API|parameter></|CHAT2API|invoke></|CHAT2API|tool_calls>'

  const chunks = parser.recoverFromContent(content, baseChunk, true)
  assert.equal(chunks.length, 1)
  assert.equal(chunks[0].choices[0].delta.role, 'assistant')
  assert.equal(chunks[0].choices[0].delta.tool_calls[0].function.name, 'default_api:read_file')
  assert.equal(JSON.parse(chunks[0].choices[0].delta.tool_calls[0].function.arguments).filePath, '/tmp/a')
  assert.deepEqual(parser.recoverFromContent(content, baseChunk), [])
})

test('accumulated answer content does not fabricate a call from incomplete arguments', () => {
  const parser = new ToolStreamParser(plan('managed_xml'))
  const content =
    '<|CHAT2API|tool_calls><|CHAT2API|invoke name="default_api:read_file"><|CHAT2API|parameter name="filePath"><![CDATA[/tmp/a'

  assert.deepEqual(parser.recoverFromContent(content, baseChunk), [])
})

test('mixed XML dialect tool block emits a tool call', () => {
  const parser = new ToolStreamParser(plan('managed_xml'))
  const chunks = parser.push(
    '<|CHAT2API|tool_calls><|CHAT2API|invoke name="default_api:read_file"><parameter name="filePath"><![CDATA[/tmp/a]]></parameter></invoke></tool_calls>',
    baseChunk,
  )

  assert.equal(chunks.at(-1)?.choices[0].delta.tool_calls[0].function.name, 'default_api:read_file')
  assert.equal(JSON.parse(chunks.at(-1)?.choices[0].delta.tool_calls[0].function.arguments).filePath, '/tmp/a')
})

test('QCML namespace marker split across chunks emits a tool call without leaking text', () => {
  const parser = new ToolStreamParser(plan('managed_xml'))
  assert.deepEqual(parser.push('<\uFF5CQCML\uFF5Ctool_', baseChunk), [])
  const chunks = parser.push(
    'calls><\uFF5CQCML\uFF5Cinvoke name="default_api:read_file"><\uFF5CQCML\uFF5Cparameter name="filePath"><![CDATA[/tmp/qcml]]></\uFF5CQCML\uFF5Cparameter></\uFF5CQCML\uFF5Cinvoke></\uFF5CQCML\uFF5Ctool_calls>',
    baseChunk,
  )

  assert.equal(chunks.some((chunk) => chunk.choices[0].delta.content?.includes('QCML')), false)
  assert.equal(chunks.at(-1)?.choices[0].delta.tool_calls[0].function.name, 'default_api:read_file')
  assert.equal(JSON.parse(chunks.at(-1)?.choices[0].delta.tool_calls[0].function.arguments).filePath, '/tmp/qcml')
})

test('invalid internal tool block is dropped on flush instead of leaking protocol text', () => {
  const parser = new ToolStreamParser(plan('managed_xml'))
  assert.deepEqual(
    parser.push('<|CHAT2API|tool_calls><|CHAT2API|invoke name="missing"></|CHAT2API|invoke></|CHAT2API|tool_calls>', baseChunk),
    [],
  )

  assert.deepEqual(parser.flush(baseChunk), [])
})

test('large streamed context before a tool block still emits the later tool call', () => {
  const parser = new ToolStreamParser(plan('managed_xml'))
  const longContext = 'context line with no tool marker\n'.repeat(60_000)

  const contextChunks = parser.push(longContext, baseChunk)
  assert.equal(contextChunks.length, 1)
  assert.equal(contextChunks[0].choices[0].delta.content, longContext)

  const chunks = parser.push(
    '<|CHAT2API|tool_calls><|CHAT2API|invoke name="default_api:read_file"><|CHAT2API|parameter name="filePath"><![CDATA[/tmp/large-context.txt]]></|CHAT2API|parameter></|CHAT2API|invoke></|CHAT2API|tool_calls>',
    baseChunk,
  )

  assert.equal(chunks.length, 1)
  assert.equal(chunks[0].choices[0].delta.tool_calls[0].function.name, 'default_api:read_file')
  assert.deepEqual(JSON.parse(chunks[0].choices[0].delta.tool_calls[0].function.arguments), {
    filePath: '/tmp/large-context.txt',
  })
})

test('large accumulated content can recover a final tool call without fabricating arguments', () => {
  const parser = new ToolStreamParser(plan('managed_xml'))
  const longContext = 'background token block without a valid marker\n'.repeat(60_000)
  const content = `${longContext}<|CHAT2API|tool_calls><|CHAT2API|invoke name="default_api:read_file"><|CHAT2API|parameter name="filePath"><![CDATA[/tmp/recovered-large-context.txt]]></|CHAT2API|parameter></|CHAT2API|invoke></|CHAT2API|tool_calls>`

  const chunks = parser.recoverFromContent(content, baseChunk, true)

  assert.equal(chunks.length, 1)
  assert.equal(chunks[0].choices[0].delta.role, 'assistant')
  assert.equal(chunks[0].choices[0].delta.tool_calls[0].function.name, 'default_api:read_file')
  assert.deepEqual(JSON.parse(chunks[0].choices[0].delta.tool_calls[0].function.arguments), {
    filePath: '/tmp/recovered-large-context.txt',
  })
})

test('Qwen Hermes marker split across chunks is buffered and emitted on stream flush', () => {
  const parser = new ToolStreamParser(plan('qwen_hermes'))

  assert.deepEqual(parser.push('<tool_', baseChunk), [])
  assert.deepEqual(
    parser.push('call>{"name":"default_api:read_file","arguments":{"filePath":"/tmp/a"}}</tool_call>', baseChunk),
    [],
  )

  const chunks = parser.flush(baseChunk)
  assert.equal(chunks.length, 1)
  assert.equal(chunks[0].choices[0].delta.tool_calls[0].function.name, 'default_api:read_file')
  assert.deepEqual(JSON.parse(chunks[0].choices[0].delta.tool_calls[0].function.arguments), {
    filePath: '/tmp/a',
  })
})

test('Qwen Hermes stream preserves adjacent parallel calls across input chunks', () => {
  const parser = new ToolStreamParser(plan('qwen_hermes'))

  assert.deepEqual(
    parser.push('<tool_call>{"name":"default_api:read_file","arguments":{"filePath":"/tmp/a"}}</tool_call>', baseChunk),
    [],
  )
  assert.deepEqual(
    parser.push('\n<tool_call>{"name":"default_api:read_file","arguments":{"filePath":"/tmp/b"}}</tool_call>', baseChunk),
    [],
  )

  const chunks = parser.flush(baseChunk)
  const toolChunks = chunks.filter((chunk) => chunk.choices[0].delta.tool_calls)
  assert.equal(toolChunks.length, 2)
  assert.deepEqual(
    toolChunks.map((chunk) => JSON.parse(chunk.choices[0].delta.tool_calls[0].function.arguments).filePath),
    ['/tmp/a', '/tmp/b'],
  )
})

test('Qwen Hermes stream recovers open-only XML calls split across chunks on flush', () => {
  const parser = new ToolStreamParser(plan('qwen_hermes'))

  assert.deepEqual(
    parser.push(
      '<tool_call>\n<function=default_api:read_file>\n<parameter=filePath>/tmp/a</parameter>\n</function>\n<tool_',
      baseChunk,
    ),
    [],
  )
  assert.deepEqual(
    parser.push(
      'call>\n<function=default_api:read_file>\n<parameter=filePath>/tmp/b</parameter>\n</function>\n',
      baseChunk,
    ),
    [],
  )

  const chunks = parser.flush(baseChunk)
  const toolChunks = chunks.filter(chunk => chunk.choices[0].delta.tool_calls)
  assert.deepEqual(
    toolChunks.map(chunk => JSON.parse(chunk.choices[0].delta.tool_calls[0].function.arguments).filePath),
    ['/tmp/a', '/tmp/b'],
  )
})

test('Qwen Hermes stream rejects a trailing open-only delimiter after a complete XML call', () => {
  const parser = new ToolStreamParser(plan('qwen_hermes'))
  parser.push(
    '<tool_call><function=default_api:read_file><parameter=filePath>/tmp/a</parameter></function><tool_call>',
    baseChunk,
  )

  assert.deepEqual(parser.flush(baseChunk), [])
  assert.equal(parser.hasEmittedToolCall(), false)
  assert.equal(parser.hasPendingToolProtocol(), true)
})

test('Qwen Hermes stream recovers complete JSON with a missing end tag only on flush', () => {
  const parser = new ToolStreamParser(plan('qwen_hermes'))
  assert.deepEqual(
    parser.push('<tool_call>{"name":"default_api:read_file","arguments":{"filePath":"/tmp/partial"}}', baseChunk),
    [],
  )

  const chunks = parser.flush(baseChunk)
  assert.equal(chunks.length, 1)
  assert.equal(
    JSON.parse(chunks[0].choices[0].delta.tool_calls[0].function.arguments).filePath,
    '/tmp/partial',
  )
})

test('Qwen Hermes stream drops truncated JSON instead of inventing arguments', () => {
  const parser = new ToolStreamParser(plan('qwen_hermes'))
  assert.deepEqual(
    parser.push('<tool_call>{"name":"default_api:read_file","arguments":{"filePath":"/tmp/a', baseChunk),
    [],
  )

  assert.deepEqual(parser.flush(baseChunk), [])
  assert.equal(parser.hasPendingToolProtocol(), true)
})

test('Qwen Hermes stream rejects an entire mixed valid and invalid batch', () => {
  const parser = new ToolStreamParser(plan('qwen_hermes'))
  const batch = [
    '<tool_call>{"name":"default_api:read_file","arguments":{"filePath":"/tmp/a"}}</tool_call>',
    '<tool_call>{"name":"undeclared_tool","arguments":{}}</tool_call>',
  ].join('\n')

  assert.deepEqual(parser.push(batch, baseChunk), [])
  assert.deepEqual(parser.flush(baseChunk), [])
  assert.equal(parser.hasEmittedToolCall(), false)
  assert.equal(parser.hasPendingToolProtocol(), true)
})

test('Qwen Hermes guard preserves managed-result marker text inside tool arguments', () => {
  const parser = new ToolStreamParser(plan('qwen_hermes'))
  const literal = '<|CHAT2API|tool_result tool_call_id="fixture">value</|CHAT2API|tool_result>'
  const block = `<tool_call>${JSON.stringify({
    name: 'default_api:read_file',
    arguments: { filePath: literal },
  })}</tool_call>`

  assert.deepEqual(parser.push(block, baseChunk), [])
  const chunks = parser.flush(baseChunk)
  assert.equal(parser.hasDetectedWrapperLeak(), false)
  assert.equal(JSON.parse(chunks[0].choices[0].delta.tool_calls[0].function.arguments).filePath, literal)
})

test('Qwen Hermes guard still rejects a top-level managed-result wrapper', () => {
  const parser = new ToolStreamParser(plan('qwen_hermes'))
  assert.deepEqual(
    parser.push('<|CHAT2API|tool_result tool_call_id="fake">value</|CHAT2API|tool_result>', baseChunk),
    [],
  )

  assert.equal(parser.hasDetectedWrapperLeak(), true)
  assert.deepEqual(parser.flush(baseChunk), [])
})

test('fenced Qwen Hermes examples remain ordinary streamed text', () => {
  const parser = new ToolStreamParser(plan('qwen_hermes'))
  const text = '```xml\n<tool_call>{"name":"default_api:read_file","arguments":{"filePath":"fake"}}</tool_call>\n```'
  const chunks = parser.push(text, baseChunk)

  assert.equal(chunks.length, 1)
  assert.equal(chunks[0].choices[0].delta.content, text)
  assert.deepEqual(parser.flush(baseChunk), [])
})
