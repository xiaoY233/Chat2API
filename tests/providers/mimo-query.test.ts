import test from 'node:test'
import assert from 'node:assert/strict'
import { Readable } from 'node:stream'

import { buildMimoQuery, MimoStreamHandler } from '../../src/main/proxy/adapters/mimo.ts'
import { ToolCallingEngine } from '../../src/main/proxy/toolCalling/ToolCallingEngine.ts'

test('Mimo query includes injected tool prompt and the user request', () => {
  const query = buildMimoQuery([
    {
      role: 'system',
      content: '## Available Tools\nTool `weather-test:get_weather`: Get weather.',
    },
    {
      role: 'user',
      content: '请调用 get_weather 工具查询 Hangzhou 的天气，然后根据工具结果回答',
    },
  ] as any)

  assert.match(query, /System: ## Available Tools/)
  assert.match(query, /weather-test:get_weather/)
  assert.match(query, /User: 请调用 get_weather 工具查询 Hangzhou 的天气/)
})

test('Mimo query preserves managed tool call history for follow-up requests', () => {
  const query = buildMimoQuery([
    {
      role: 'user',
      content: '查询 Hangzhou 天气',
    },
    {
      role: 'assistant',
      content: null,
      tool_calls: [
        {
          id: 'call_1',
          type: 'function',
          function: {
            name: 'weather-test:get_weather',
            arguments: '{"city":"Hangzhou"}',
          },
        },
      ],
    },
    {
      role: 'tool',
      tool_call_id: 'call_1',
      content: '{"city":"Hangzhou","condition":"sunny","temperature":25}',
    },
    {
      role: 'user',
      content: '根据工具结果回答',
    },
  ] as any)

  assert.match(query, /<\|CHAT2API\|tool_calls>/)
  assert.match(query, /<\|CHAT2API\|invoke name="weather-test:get_weather">/)
  assert.match(query, /<\|CHAT2API\|tool_result tool_call_id="call_1">/)
  assert.match(query, /Hangzhou/)
  assert.match(query, /User: 根据工具结果回答/)
})

test('Mimo stream converts managed XML into OpenAI tool calls', async () => {
  const tools = [
    {
      type: 'function' as const,
      function: {
        name: 'weather-test:get_weather',
        description: 'Get weather',
        parameters: {
          type: 'object',
          properties: {
            city: { type: 'string' },
          },
        },
      },
    },
  ]
  const transformed = new ToolCallingEngine().transformRequest({
    request: {
      model: 'MiMo-V2-Flash',
      messages: [{ role: 'user', content: '查询 Hangzhou 天气' }],
      tools,
      stream: true,
    },
    provider: {
      id: 'mimo',
      name: 'Mimo',
      type: 'builtin',
      authType: 'cookie',
      apiEndpoint: 'https://aistudio.xiaomimimo.com',
      headers: {},
      enabled: true,
      createdAt: 0,
      updatedAt: 0,
    } as any,
    actualModel: 'mimo-v2-flash',
  })
  const stream = Readable.from([
    'event: message\n',
    'data: {"content":"<|CHAT2API|tool_calls><|CHAT2API|invoke name=\\"weather-test:get_weather\\"><|CHAT2API|parameter name=\\"city\\"><![CDATA[Hangzhou]]></|CHAT2API|parameter></|CHAT2API|invoke></|CHAT2API|tool_calls>"}\n\n',
  ])
  const handler = new MimoStreamHandler('mimo-v2-flash', 'conv_1', 'separate', transformed.plan)
  const chunks: string[] = []

  for await (const chunk of handler.handleStream(stream)) {
    chunks.push(chunk)
  }

  const output = chunks.join('')
  assert.match(output, /"tool_calls"/)
  assert.match(output, /"name":"weather-test:get_weather"/)
  assert.match(output, /"finish_reason":"tool_calls"/)
  assert.doesNotMatch(output, /CHAT2API/)
})
