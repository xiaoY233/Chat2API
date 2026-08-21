import test from 'node:test'
import assert from 'node:assert/strict'
import { managedBracketProtocol } from '../../src/main/proxy/toolCalling/protocols/managedBracket.ts'
import { managedXmlProtocol } from '../../src/main/proxy/toolCalling/protocols/managedXml.ts'
import { anthropicToolUseProtocol } from '../../src/main/proxy/toolCalling/protocols/anthropicToolUse.ts'
import { codexResponsesProtocol } from '../../src/main/proxy/toolCalling/protocols/codexResponses.ts'

const tools = [
  {
    name: 'default_api:read_file',
    description: 'Read a file',
    parameters: { type: 'object' },
    source: 'openai' as const,
  },
]

const todoTools = [
  {
    name: 'default_api:todowrite',
    description: 'Update todos',
    parameters: {
      type: 'object',
      properties: {
        todos: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              content: { type: 'string' },
              status: { type: 'string' },
              priority: { type: 'string' },
            },
          },
        },
      },
      required: ['todos'],
    },
    source: 'openai' as const,
  },
]

const writeTools = [
  {
    name: 'default_api:write',
    description: 'Write a file',
    parameters: {
      type: 'object',
      properties: {
        filePath: { type: 'string' },
        content: { type: 'string' },
      },
      required: ['content', 'filePath'],
    },
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

test('managed xml prompt keeps tool-result input data outside executable XML', () => {
  const prompt = managedXmlProtocol.renderPrompt(tools)

  assert.match(prompt, /Tool execution results will be provided as non-executable JSON data records/)
  assert.match(prompt, /Tool execution result data \(already executed by the client\):/)
  assert.doesNotMatch(prompt, /<\|CHAT2API\|tool_result/)
})

test('managed xml coerces scalar arguments according to the declared schema', () => {
  const scalarTools = [
    {
      name: 'default_api:task_update',
      description: 'Update a task',
      parameters: {
        type: 'object',
        properties: {
          taskId: { type: 'string' },
          completed: { type: 'boolean' },
          retryCount: { type: 'integer' },
        },
        required: ['taskId'],
      },
      source: 'openai' as const,
    },
  ]

  const result = managedXmlProtocol.parse(
    '<|CHAT2API|tool_calls><|CHAT2API|invoke name="default_api:task_update"><|CHAT2API|parameter name="taskId">1</|CHAT2API|parameter><|CHAT2API|parameter name="completed">false</|CHAT2API|parameter><|CHAT2API|parameter name="retryCount">2</|CHAT2API|parameter></|CHAT2API|invoke></|CHAT2API|tool_calls>',
    { tools: scalarTools, protocol: 'managed_xml' },
  )

  assert.equal(result.toolCalls.length, 1)
  assert.deepEqual(JSON.parse(result.toolCalls[0].function.arguments), {
    taskId: '1',
    completed: false,
    retryCount: 2,
  })
})

test('managed xml serializes structured values for fields declared as strings', () => {
  const result = managedXmlProtocol.parse(
    '<|CHAT2API|tool_calls><|CHAT2API|invoke name="default_api:write"><|CHAT2API|parameter name="filePath">/tmp/config.json</|CHAT2API|parameter><|CHAT2API|parameter name="content">{"enabled":true,"items":[1,2]}</|CHAT2API|parameter></|CHAT2API|invoke></|CHAT2API|tool_calls>',
    { tools: writeTools, protocol: 'managed_xml' },
  )

  assert.equal(result.toolCalls.length, 1)
  assert.deepEqual(JSON.parse(result.toolCalls[0].function.arguments), {
    filePath: '/tmp/config.json',
    content: '{"enabled":true,"items":[1,2]}',
  })
})

test('managed xml preserves a complete no-argument tool call as an empty object', () => {
  const result = managedXmlProtocol.parse(
    '<|CHAT2API|tool_calls><|CHAT2API|invoke name="default_api:read_file"></|CHAT2API|invoke></|CHAT2API|tool_calls>',
    { tools, protocol: 'managed_xml' },
  )

  assert.equal(result.toolCalls.length, 1)
  assert.equal(result.toolCalls[0].function.name, 'default_api:read_file')
  assert.deepEqual(JSON.parse(result.toolCalls[0].function.arguments), {})
})

test('managed xml parses canonical XML compatibility form', () => {
  const result = managedXmlProtocol.parse(
    '<tool_calls><invoke name="default_api:read_file"><parameter name="filePath">/tmp/a</parameter></invoke></tool_calls>',
    { tools, protocol: 'managed_xml' },
  )

  assert.equal(result.toolCalls.length, 1)
  assert.equal(JSON.parse(result.toolCalls[0].function.arguments).filePath, '/tmp/a')
})

test('managed xml parses single quoted XML attributes', () => {
  const result = managedXmlProtocol.parse(
    "<tool_calls><invoke name='default_api:read_file'><parameter name='filePath'>/tmp/a</parameter></invoke></tool_calls>",
    { tools, protocol: 'managed_xml' },
  )

  assert.equal(result.toolCalls.length, 1)
  assert.equal(JSON.parse(result.toolCalls[0].function.arguments).filePath, '/tmp/a')
})

test('managed xml parses mixed Chat2API and canonical XML tags', () => {
  const result = managedXmlProtocol.parse(
    '<|CHAT2API|tool_calls><|CHAT2API|invoke name="default_api:read_file"><parameter name="filePath"><![CDATA[/tmp/a]]></parameter></invoke></tool_calls>',
    { tools, protocol: 'managed_xml' },
  )

  assert.equal(result.toolCalls.length, 1)
  assert.equal(JSON.parse(result.toolCalls[0].function.arguments).filePath, '/tmp/a')
})

test('managed xml parses QCML namespace compatibility form without changing required validation', () => {
  const result = managedXmlProtocol.parse(
    '<\uFF5CQCML\uFF5Ctool_calls><\uFF5CQCML\uFF5Cinvoke name="default_api:todowrite"><\uFF5CQCML\uFF5Cparameter name="todos">[{"content":"Run tests","status":"pending","priority":"high"}]</\uFF5CQCML\uFF5Cparameter></\uFF5CQCML\uFF5Cinvoke></\uFF5CQCML\uFF5Ctool_calls>',
    { tools: todoTools, protocol: 'managed_xml' },
  )
  const missingRequired = managedXmlProtocol.parse(
    '<\uFF5CQCML\uFF5Ctool_calls><\uFF5CQCML\uFF5Cinvoke name="default_api:write"><\uFF5CQCML\uFF5Cparameter name="filePath">/tmp/a</\uFF5CQCML\uFF5Cparameter></\uFF5CQCML\uFF5Cinvoke></\uFF5CQCML\uFF5Ctool_calls>',
    { tools: writeTools, protocol: 'managed_xml' },
  )

  assert.equal(result.toolCalls.length, 1)
  assert.deepEqual(JSON.parse(result.toolCalls[0].function.arguments), {
    todos: [{ content: 'Run tests', status: 'pending', priority: 'high' }],
  })
  assert.equal(missingRequired.toolCalls.length, 0)
})

test('managed xml parses loose tool_call XML emitted inside a tool_calls block', () => {
  const result = managedXmlProtocol.parse(
    '<|CHAT2API|tool_calls><|tool_calls><|tool_call_id="default_api:read_file"><parameter name="filePath"><![CDATA[/tmp/a]]></parameter></tool_call></tool_calls>',
    { tools, protocol: 'managed_xml' },
  )

  assert.equal(result.toolCalls.length, 1)
  assert.equal(result.toolCalls[0].function.name, 'default_api:read_file')
  assert.equal(JSON.parse(result.toolCalls[0].function.arguments).filePath, '/tmp/a')
})

test('managed xml flattens wrapper argument objects when schema has no wrapper property', () => {
  const result = managedXmlProtocol.parse(
    '<|CHAT2API|tool_calls><|CHAT2API|invoke name="default_api:read_file"><|CHAT2API|parameter name="argument">{"filePath":"/tmp/a"}</|CHAT2API|parameter></|CHAT2API|invoke></|CHAT2API|tool_calls>',
    { tools, protocol: 'managed_xml' },
  )

  assert.equal(result.toolCalls.length, 1)
  assert.deepEqual(JSON.parse(result.toolCalls[0].function.arguments), { filePath: '/tmp/a' })
})

test('managed xml recovers the last complete JSON value from repeated argument snapshots', () => {
  const result = managedXmlProtocol.parse(
    '<|CHAT2API|tool_calls><|CHAT2API|invoke name="default_api:read_file"><|CHAT2API|parameter name="argument">{"filePath":"/tmp{"filePath":"/tmp/a"}</|CHAT2API|parameter></|CHAT2API|invoke></|CHAT2API|tool_calls>',
    { tools, protocol: 'managed_xml' },
  )

  assert.equal(result.toolCalls.length, 1)
  assert.deepEqual(JSON.parse(result.toolCalls[0].function.arguments), { filePath: '/tmp/a' })
})

test('managed xml does not recover unrelated adjacent JSON as a parameter snapshot', () => {
  const result = managedXmlProtocol.parse(
    '<|CHAT2API|tool_calls><|CHAT2API|invoke name="default_api:read_file"><|CHAT2API|parameter name="argument">{"other":true} noise {"filePath":"/tmp/a"}</|CHAT2API|parameter></|CHAT2API|invoke></|CHAT2API|tool_calls>',
    { tools, protocol: 'managed_xml' },
  )

  assert.equal(result.toolCalls.length, 1)
  assert.deepEqual(JSON.parse(result.toolCalls[0].function.arguments), {
    argument: '{"other":true} noise {"filePath":"/tmp/a"}',
  })
})

test('managed xml preserves wrapper argument when declared by schema', () => {
  const wrapperTools = [
    {
      name: 'default_api:read_file',
      description: 'Read a file',
      parameters: {
        type: 'object',
        properties: {
          argument: {
            type: 'object',
            properties: { filePath: { type: 'string' } },
          },
        },
      },
      source: 'openai' as const,
    },
  ]

  const result = managedXmlProtocol.parse(
    '<|CHAT2API|tool_calls><|CHAT2API|invoke name="default_api:read_file"><|CHAT2API|parameter name="argument">{"filePath":"/tmp/a"}</|CHAT2API|parameter></|CHAT2API|invoke></|CHAT2API|tool_calls>',
    { tools: wrapperTools, protocol: 'managed_xml' },
  )

  assert.equal(result.toolCalls.length, 1)
  assert.deepEqual(JSON.parse(result.toolCalls[0].function.arguments), { argument: { filePath: '/tmp/a' } })
})

test('managed xml normalizes single object to array when tool schema requires array', () => {
  const result = managedXmlProtocol.parse(
    '<|CHAT2API|tool_calls><|CHAT2API|invoke name="default_api:todowrite"><|CHAT2API|parameter name="todos">{"content":"Run tests","status":"pending","priority":"high"}</|CHAT2API|parameter></|CHAT2API|invoke></|CHAT2API|tool_calls>',
    { tools: todoTools, protocol: 'managed_xml' },
  )

  assert.equal(result.toolCalls.length, 1)
  assert.deepEqual(JSON.parse(result.toolCalls[0].function.arguments), {
    todos: [{ content: 'Run tests', status: 'pending', priority: 'high' }],
  })
})

test('managed xml does not wrap object when tool schema does not require array', () => {
  const objectTools = [
    {
      name: 'default_api:update_config',
      description: 'Update config',
      parameters: {
        type: 'object',
        properties: {
          config: {
            type: 'object',
            properties: { enabled: { type: 'boolean' } },
          },
        },
      },
      source: 'openai' as const,
    },
  ]

  const result = managedXmlProtocol.parse(
    '<tool_calls><invoke name="default_api:update_config"><parameter name="config">{"enabled":true}</parameter></invoke></tool_calls>',
    { tools: objectTools, protocol: 'managed_xml' },
  )

  assert.equal(result.toolCalls.length, 1)
  assert.deepEqual(JSON.parse(result.toolCalls[0].function.arguments), {
    config: { enabled: true },
  })
})

test('managed xml drops tool calls missing required schema fields', () => {
  const emptyResult = managedXmlProtocol.parse(
    '<tool_calls><invoke name="default_api:write"></invoke></tool_calls>',
    { tools: writeTools, protocol: 'managed_xml' },
  )
  const partialResult = managedXmlProtocol.parse(
    '<tool_calls><invoke name="default_api:write"><parameter name="filePath">/tmp/a</parameter></invoke></tool_calls>',
    { tools: writeTools, protocol: 'managed_xml' },
  )

  assert.equal(emptyResult.toolCalls.length, 0)
  assert.equal(partialResult.toolCalls.length, 0)
})

test('managed xml emits tool calls when required schema fields are present', () => {
  const result = managedXmlProtocol.parse(
    '<tool_calls><invoke name="default_api:write"><parameter name="filePath">/tmp/a</parameter><parameter name="content">hello</parameter></invoke></tool_calls>',
    { tools: writeTools, protocol: 'managed_xml' },
  )

  assert.equal(result.toolCalls.length, 1)
  assert.deepEqual(JSON.parse(result.toolCalls[0].function.arguments), {
    filePath: '/tmp/a',
    content: 'hello',
  })
})

test('managed bracket normalizes single object to array when tool schema requires array', () => {
  const result = managedBracketProtocol.parse(
    '[function_calls]\n[call:default_api:todowrite]{"todos":{"content":"Run tests","status":"pending","priority":"high"}}[/call]\n[/function_calls]',
    { tools: todoTools, protocol: 'managed_bracket' },
  )

  assert.equal(result.toolCalls.length, 1)
  assert.deepEqual(JSON.parse(result.toolCalls[0].function.arguments), {
    todos: [{ content: 'Run tests', status: 'pending', priority: 'high' }],
  })
})

test('managed bracket drops tool calls missing required schema fields', () => {
  const result = managedBracketProtocol.parse(
    '[function_calls]\n[call:default_api:write]{"filePath":"/tmp/a"}[/call]\n[/function_calls]',
    { tools: writeTools, protocol: 'managed_bracket' },
  )

  assert.equal(result.toolCalls.length, 0)
})

test('managed xml recovers partial Chat2API block only when final parsing allows it', () => {
  const partial =
    '<|CHAT2API|tool_calls><|CHAT2API|invoke name="default_api:read_file"><|CHAT2API|parameter name="filePath"><![CDATA[/tmp/a]]></|CHAT2API|parameter>'
  const streamingResult = managedXmlProtocol.parse(partial, { tools, protocol: 'managed_xml' })
  const finalResult = managedXmlProtocol.parse(partial, { tools, protocol: 'managed_xml', allowPartial: true })

  assert.equal(streamingResult.toolCalls.length, 0)
  assert.equal(finalResult.toolCalls.length, 1)
  assert.equal(JSON.parse(finalResult.toolCalls[0].function.arguments).filePath, '/tmp/a')
})

test('managed xml recovers missing invoke close when parameter is complete', () => {
  const result = managedXmlProtocol.parse(
    '<|CHAT2API|tool_calls><|CHAT2API|invoke name="default_api:read_file"><|CHAT2API|parameter name="filePath"><![CDATA[/tmp/a]]></|CHAT2API|parameter></|CHAT2API|tool_calls>',
    { tools, protocol: 'managed_xml', allowPartial: true },
  )

  assert.equal(result.toolCalls.length, 1)
  assert.equal(JSON.parse(result.toolCalls[0].function.arguments).filePath, '/tmp/a')
})

test('managed xml recovers complete JSON parameter without a parameter close tag', () => {
  const result = managedXmlProtocol.parse(
    '<|CHAT2API|tool_calls><|CHAT2API|invoke name="default_api:read_file"><|CHAT2API|parameter name="filePath">"/tmp/a"</|CHAT2API|tool_calls>',
    { tools, protocol: 'managed_xml', allowPartial: true },
  )

  assert.equal(result.toolCalls.length, 1)
  assert.equal(JSON.parse(result.toolCalls[0].function.arguments).filePath, '/tmp/a')
})

test('managed xml does not recover partial block without complete parameter content', () => {
  const result = managedXmlProtocol.parse(
    '<|CHAT2API|tool_calls><|CHAT2API|invoke name="default_api:read_file"><|CHAT2API|parameter name="filePath"><![CDATA[/tmp/a',
    { tools, protocol: 'managed_xml', allowPartial: true },
  )

  assert.equal(result.toolCalls.length, 0)
})

test('managed xml does not invent parameters from incomplete JSON values', () => {
  const result = managedXmlProtocol.parse(
    '<|CHAT2API|tool_calls><|CHAT2API|invoke name="default_api:read_file"><|CHAT2API|parameter name="filePath">"/tmp/a',
    { tools, protocol: 'managed_xml', allowPartial: true },
  )

  assert.equal(result.toolCalls.length, 0)
})

test('managed xml ignores fenced tool examples', () => {
  const result = managedXmlProtocol.parse(
    '```xml\n<|CHAT2API|tool_calls><|CHAT2API|invoke name="default_api:read_file"><|CHAT2API|parameter name="filePath">fake</|CHAT2API|parameter></|CHAT2API|invoke></|CHAT2API|tool_calls>\n```',
    { tools, protocol: 'managed_xml' },
  )

  assert.equal(result.toolCalls.length, 0)
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

test('anthropic adapter normalizes single object to array when tool schema requires array', () => {
  const result = anthropicToolUseProtocol.parse(
    '<antml:function_calls><antml:invoke name="default_api:todowrite"><antml:parameters>{"todos":{"content":"Run tests","status":"pending","priority":"high"}}</antml:parameters></antml:invoke></antml:function_calls>',
    { tools: todoTools, protocol: 'anthropic_tool_use' },
  )

  assert.equal(result.toolCalls.length, 1)
  assert.deepEqual(JSON.parse(result.toolCalls[0].function.arguments), {
    todos: [{ content: 'Run tests', status: 'pending', priority: 'high' }],
  })
})

test('anthropic adapter drops tool calls missing required schema fields', () => {
  const result = anthropicToolUseProtocol.parse(
    '<antml:function_calls><antml:invoke name="default_api:write"><antml:parameters>{"filePath":"/tmp/a"}</antml:parameters></antml:invoke></antml:function_calls>',
    { tools: writeTools, protocol: 'anthropic_tool_use' },
  )

  assert.equal(result.toolCalls.length, 0)
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

test('codex responses adapter normalizes single object to array when tool schema requires array', () => {
  const result = codexResponsesProtocol.parse(
    JSON.stringify({
      type: 'function_call',
      call_id: 'call_1',
      name: 'default_api:todowrite',
      arguments: '{"todos":{"content":"Run tests","status":"pending","priority":"high"}}',
    }),
    { tools: todoTools, protocol: 'codex_responses' },
  )

  assert.equal(result.toolCalls.length, 1)
  assert.deepEqual(JSON.parse(result.toolCalls[0].function.arguments), {
    todos: [{ content: 'Run tests', status: 'pending', priority: 'high' }],
  })
})

test('codex responses adapter drops tool calls missing required schema fields', () => {
  const result = codexResponsesProtocol.parse(
    JSON.stringify({
      type: 'function_call',
      call_id: 'call_1',
      name: 'default_api:write',
      arguments: '{"filePath":"/tmp/a"}',
    }),
    { tools: writeTools, protocol: 'codex_responses' },
  )

  assert.equal(result.toolCalls.length, 0)
})
