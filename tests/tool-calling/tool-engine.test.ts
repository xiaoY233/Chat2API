import test from 'node:test'
import assert from 'node:assert/strict'
import {
  extractLatestActiveUserAttachments,
  ToolCallingEngine,
} from '../../src/main/proxy/toolCalling/ToolCallingEngine.ts'
import { MANAGED_TOOL_PROMPT_MESSAGE_NAME } from '../../src/main/proxy/toolCalling/managedPromptMetadata.ts'
import type { ChatCompletionRequest } from '../../src/main/proxy/types.ts'
import type { Provider } from '../../src/main/store/types.ts'

const provider = {
  id: 'deepseek',
  name: 'DeepSeek',
  type: 'builtin',
  authType: 'userToken',
  apiEndpoint: 'https://chat.deepseek.com',
  headers: {},
  enabled: true,
  createdAt: 0,
  updatedAt: 0,
} as Provider

const qwenAiProvider = {
  ...provider,
  id: 'qwen-ai',
  name: 'Qwen AI',
  apiEndpoint: 'https://chat.qwen.ai',
} as Provider

const tools = [
  {
    type: 'function' as const,
    function: {
      name: 'default_api:read_file',
      description: 'Read a file',
      parameters: { type: 'object', properties: { filePath: { type: 'string' } } },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'default_api:list_dir',
      description: 'List a directory',
      parameters: { type: 'object', properties: { path: { type: 'string' } } },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'default_api:write',
      description: 'Write a file',
      parameters: {
        type: 'object',
        properties: {
          filePath: { type: 'string' },
          content: { type: 'string' },
        },
        required: ['filePath', 'content'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
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
              required: ['content', 'status', 'priority'],
            },
          },
        },
        required: ['todos'],
      },
    },
  },
]

test('active user attachment extraction keeps only the current user turn', () => {
  const attachments = extractLatestActiveUserAttachments([
    {
      role: 'user',
      content: [{ type: 'image_url', image_url: { url: 'https://example.test/old.png' } }],
    },
    { role: 'assistant', content: 'old answer' },
    {
      role: 'user',
      content: [{
        type: 'image_url', image_url: { url: 'https://example.test/current.png' },
      }],
    },
    { role: 'user', content: 'Image source metadata.' },
    {
      role: 'assistant',
      content: null,
      tool_calls: [{
        id: 'call_read',
        type: 'function',
        function: { name: 'read_file', arguments: '{}' },
      }],
    },
    { role: 'tool', tool_call_id: 'call_read', content: '{}' },
  ])

  assert.deepEqual(attachments, [{
    type: 'image_url',
    image_url: { url: 'https://example.test/current.png' },
  }])
})

function request(overrides: Partial<ChatCompletionRequest> = {}): ChatCompletionRequest {
  return {
    model: 'deepseek-chat',
    messages: [{ role: 'user', content: 'read /tmp/a' }],
    tools,
    ...overrides,
  }
}

test('OpenAI tools plus DeepSeek choose managed prompt', () => {
  const result = new ToolCallingEngine().transformRequest({
    request: request(),
    provider,
    actualModel: 'deepseek-chat',
  })

  assert.equal(result.plan.mode, 'managed')
  assert.equal(result.plan.protocol, 'managed_xml')
  assert.equal(result.plan.shouldInjectPrompt, true)
  assert.equal(result.tools, undefined)
  assert.equal(result.plan.tools.length, 4)
  assert.match(result.messages[0].content as string, /<\|CHAT2API\|tool_calls>/)
  assert.match(result.messages[0].content as string, /client-declared managed tool set/)
  assert.match(result.messages[0].content as string, /undeclared provider-side tools or capabilities/)
  assert.match(result.messages[0].content as string, /Every required field must appear as its own/)
  assert.match(result.messages[0].content as string, /repeat the parameter tag once per argument/)
  assert.match(result.messages[0].content as string, /Required-parameter XML templates/)
  assert.match(result.messages[0].content as string, /<\|CHAT2API\|invoke name="default_api:write">/)
  assert.match(result.messages[0].content as string, /<\|CHAT2API\|parameter name="filePath">/)
  assert.match(result.messages[0].content as string, /<\|CHAT2API\|parameter name="content">/)
  assert.match(result.messages[0].content as string, /<\|CHAT2API\|invoke name="default_api:todowrite">/)
  assert.match(result.messages[0].content as string, /\[\{"content":"\.\.\.content\.\.\.","status":"\.\.\.status\.\.\.","priority":"\.\.\.priority\.\.\."\}\]/)
})

test('matched profile key selects Qwen Hermes for a custom provider instance', () => {
  const customProvider = {
    ...qwenAiProvider,
    id: 'custom-qwen-instance',
    type: 'custom',
  } as Provider
  const result = new ToolCallingEngine().transformRequest({
    request: request({ model: 'configured-client-model' }),
    provider: customProvider,
    providerProfileKey: 'qwen-ai',
    actualModel: 'configured-provider-model',
  })

  assert.equal(result.plan.protocol, 'qwen_hermes')
  assert.equal(result.plan.providerId, 'custom-qwen-instance')
  assert.equal(result.plan.diagnostics.providerId, 'custom-qwen-instance')
  assert.match(String(result.messages[0].content), /<tools>/)
  assert.match(String(result.messages[0].content), /chat2api_workflow_complete/)
  assert.doesNotMatch(String(result.messages[0].content), /<\|CHAT2API\|tool_calls>/)
})

test('explicit Cherry Studio MCP adapter uses managed prompt and preserves tool names', () => {
  const result = new ToolCallingEngine({ clientAdapterId: 'cherry-studio-mcp' }).transformRequest({
    request: request({
      messages: [
        { role: 'system', content: 'In this environment you have access to a set of tools' },
        { role: 'user', content: 'read /tmp/a' },
      ],
    }),
    provider,
    actualModel: 'deepseek-chat',
  })

  assert.equal(result.plan.clientAdapterId, 'cherry-studio-mcp')
  assert.equal(result.plan.mode, 'managed')
  assert.equal(result.plan.shouldInjectPrompt, true)
  assert.equal(result.plan.tools[0].name, 'default_api:read_file')
  assert.equal(result.plan.tools[0].source, 'mcp')
})

test('tool result history receives a generic continuation without mutating the request', () => {
  const messages = [
    { role: 'user' as const, content: 'complete the requested workflow' },
    { role: 'assistant' as const, content: null, tool_calls: [{
      id: 'call_1',
      type: 'function' as const,
      function: { name: 'default_api:read_file', arguments: '{"filePath":"/tmp/a"}' },
    }] },
    { role: 'tool' as const, tool_call_id: 'call_1', content: '{"ok":true}' },
  ]
  const originalMessages = [...messages]
  const result = new ToolCallingEngine().transformRequest({
    request: request({ messages }),
    provider,
    actualModel: 'deepseek-chat',
  })

  assert.deepEqual(messages, originalMessages)
  assert.equal(result.plan.workflowContinuation, true)
  assert.equal(result.plan.diagnostics.workflowContinuation, true)
  assert.equal(result.messages.at(-2)?.role, 'tool')
  assert.equal(result.messages.at(-1)?.role, 'user')
  assert.match(String(result.messages.at(-1)?.content), /next appropriate available tool call/)
  assert.doesNotMatch(String(result.messages.at(-1)?.content), /image2-p|Skill/)
})

test('bridge-split assistant text still opens a managed tool continuation', () => {
  const messages = [
    { role: 'user' as const, content: 'complete the requested workflow' },
    { role: 'assistant' as const, content: null, tool_calls: [{
      id: 'call_1',
      type: 'function' as const,
      function: { name: 'default_api:read_file', arguments: '{"filePath":"/tmp/a"}' },
    }] },
    { role: 'assistant' as const, content: 'I will inspect the file now.' },
    { role: 'tool' as const, tool_call_id: 'call_1', content: '{"ok":true}' },
  ]

  const result = new ToolCallingEngine().transformRequest({
    request: request({ messages }),
    provider,
    actualModel: 'deepseek-chat',
  })

  assert.equal(result.plan.workflowContinuation, true)
  assert.equal(result.plan.diagnostics.workflowContinuation, true)
  assert.equal(result.messages.at(-3)?.content, 'I will inspect the file now.')
  assert.equal(result.messages.at(-2)?.role, 'tool')
  assert.equal(result.messages.at(-1)?.role, 'user')
  assert.match(String(result.messages.at(-1)?.content), /next appropriate available tool call/)
})

test('unmatched or mixed trailing tool results do not open a managed continuation', () => {
  const unmatchedMessages = [
    { role: 'user' as const, content: 'complete the requested workflow' },
    { role: 'assistant' as const, content: null, tool_calls: [{
      id: 'call_1',
      type: 'function' as const,
      function: { name: 'default_api:read_file', arguments: '{}' },
    }] },
    {
      role: 'tool' as const,
      tool_call_id: 'different-call',
      content: 'failed',
      is_error: true,
    },
  ]
  const mixedMessages = [
    {
      role: 'assistant' as const,
      content: [{ type: 'tool_use', id: 'call_1', name: 'default_api:read_file', input: {} }],
    },
    {
      role: 'user' as const,
      content: [
        { type: 'tool_result', tool_use_id: 'call_1', content: 'inspection complete' },
        { type: 'text', text: 'start a separate task' },
      ],
    },
  ]

  const unmatchedResult = new ToolCallingEngine().transformRequest({
    request: request({ messages: unmatchedMessages }),
    provider,
    actualModel: 'deepseek-chat',
  })
  const mixedResult = new ToolCallingEngine().transformRequest({
    request: request({ messages: mixedMessages }),
    provider,
    actualModel: 'deepseek-chat',
  })

  assert.equal(unmatchedResult.plan.workflowContinuation, false)
  assert.equal(unmatchedResult.plan.failedToolResultPending, false)
  assert.equal(unmatchedResult.messages.at(-1)?.role, 'tool')
  assert.equal(mixedResult.plan.workflowContinuation, false)
  assert.equal(mixedResult.plan.failedToolResultPending, false)
  assert.equal(mixedResult.messages.at(-1)?.role, 'user')
  assert.ok(Array.isArray(mixedResult.messages.at(-1)?.content))
  assert.equal(
    (mixedResult.messages.at(-1)?.content as Array<{ text?: string }>).at(-1)?.text,
    'start a separate task',
  )
})

test('failed tool result state is preserved in the plan and continuation prompt', () => {
  const messages = [
    { role: 'user' as const, content: 'complete the requested workflow' },
    { role: 'assistant' as const, content: null, tool_calls: [{
      id: 'call_1',
      type: 'function' as const,
      function: { name: 'default_api:read_file', arguments: '{"filePath":"/tmp/a"}' },
    }] },
    {
      role: 'tool' as const,
      tool_call_id: 'call_1',
      content: 'the operation failed',
      is_error: true,
    },
  ]

  const result = new ToolCallingEngine().transformRequest({
    request: request({ messages }),
    provider,
    actualModel: 'deepseek-chat',
  })
  const renderedMessages = result.messages.map(message => String(message.content)).join('\n')

  assert.equal(result.plan.failedToolResultPending, true)
  assert.equal(result.plan.diagnostics.failedToolResultPending, true)
  assert.match(String(result.messages.at(-1)?.content), /previous tool result reported failure/)
  assert.match(String(result.messages.at(-1)?.content), /appropriate declared tool/)
  assert.match(String(result.messages.at(-1)?.content), /undeclared provider-side tools or capabilities/)
  assert.match(String(result.messages.at(-1)?.content), /otherwise explain the blocking failure/i)
  assert.doesNotMatch(String(result.messages.at(-1)?.content), /entire next response must be one managed tool-call XML block/)
  assert.match(renderedMessages, /Tool `default_api:read_file`[\s\S]*Tool `default_api:todowrite`/)
  assert.match(renderedMessages, /<\|CHAT2API\|invoke name="default_api:write">/)
  assert.match(renderedMessages, /<\|CHAT2API\|parameter name="filePath">/)
  assert.doesNotMatch(String(result.messages.at(-1)?.content), /the operation failed|\/tmp\/a/)
})

test('any failed result in the latest parallel tool-result batch keeps failure pending', () => {
  const messages = [
    { role: 'user' as const, content: 'complete the requested workflow' },
    { role: 'assistant' as const, content: null, tool_calls: [{
      id: 'call_1',
      type: 'function' as const,
      function: { name: 'default_api:read_file', arguments: '{"filePath":"/tmp/a"}' },
    }, {
      id: 'call_2',
      type: 'function' as const,
      function: { name: 'default_api:read_file', arguments: '{"filePath":"/tmp/b"}' },
    }] },
    { role: 'tool' as const, tool_call_id: 'call_1', content: 'success', is_error: false },
    { role: 'tool' as const, tool_call_id: 'call_2', content: 'failed', is_error: true },
  ]

  const result = new ToolCallingEngine().transformRequest({
    request: request({ messages }),
    provider,
    actualModel: 'deepseek-chat',
  })

  assert.equal(result.plan.failedToolResultPending, true)
  assert.equal(result.plan.diagnostics.failedToolResultPending, true)
  assert.match(String(result.messages.at(-1)?.content), /previous tool result reported failure/)
})

test('false and absent error flags do not mark a parallel tool-result batch as failed', () => {
  const messages = [
    { role: 'user' as const, content: 'complete the requested workflow' },
    { role: 'assistant' as const, content: null, tool_calls: [{
      id: 'call_1',
      type: 'function' as const,
      function: { name: 'default_api:read_file', arguments: '{"filePath":"/tmp/a"}' },
    }, {
      id: 'call_2',
      type: 'function' as const,
      function: { name: 'default_api:read_file', arguments: '{"filePath":"/tmp/b"}' },
    }] },
    { role: 'tool' as const, tool_call_id: 'call_1', content: 'success', is_error: false },
    { role: 'tool' as const, tool_call_id: 'call_2', content: 'legacy success' },
  ]

  const result = new ToolCallingEngine().transformRequest({
    request: request({ messages }),
    provider,
    actualModel: 'deepseek-chat',
  })

  assert.equal(result.plan.failedToolResultPending, false)
  assert.equal(result.plan.diagnostics.failedToolResultPending, false)
  assert.doesNotMatch(String(result.messages.at(-1)?.content), /previous tool result reported failure/)
})

test('a later successful tool-result batch clears pending failure state', () => {
  const messages = [
    { role: 'user' as const, content: 'complete the requested workflow' },
    { role: 'assistant' as const, content: null, tool_calls: [{
      id: 'call_1',
      type: 'function' as const,
      function: { name: 'default_api:read_file', arguments: '{"filePath":"/tmp/a"}' },
    }] },
    { role: 'tool' as const, tool_call_id: 'call_1', content: 'failed', is_error: true },
    { role: 'assistant' as const, content: null, tool_calls: [{
      id: 'call_2',
      type: 'function' as const,
      function: { name: 'default_api:read_file', arguments: '{"filePath":"/tmp/a"}' },
    }] },
    { role: 'tool' as const, tool_call_id: 'call_2', content: 'success', is_error: false },
  ]

  const result = new ToolCallingEngine().transformRequest({
    request: request({ messages }),
    provider,
    actualModel: 'deepseek-chat',
  })

  assert.equal(result.plan.failedToolResultPending, false)
  assert.equal(result.plan.diagnostics.failedToolResultPending, false)
  assert.doesNotMatch(String(result.messages.at(-1)?.content), /previous tool result reported failure/)
})

test('an independent user turn after prior tool history is not extended', () => {
  const messages = [
    { role: 'user' as const, content: 'complete the earlier workflow' },
    { role: 'assistant' as const, content: null, tool_calls: [{
      id: 'call_1',
      type: 'function' as const,
      function: { name: 'default_api:read_file', arguments: '{"filePath":"/tmp/a"}' },
    }] },
    { role: 'tool' as const, tool_call_id: 'call_1', content: '{"ok":true}' },
    { role: 'assistant' as const, content: 'The earlier workflow is complete.' },
    { role: 'user' as const, content: 'start a separate task' },
  ]
  const originalMessages = [...messages]
  const result = new ToolCallingEngine().transformRequest({
    request: request({ messages }),
    provider,
    actualModel: 'deepseek-chat',
  })

  assert.deepEqual(messages, originalMessages)
  assert.equal(result.messages.at(-1)?.content, 'start a separate task')
  assert.equal(result.plan.workflowContinuation, false)
  assert.equal(result.plan.failedToolResultPending, false)
  assert.doesNotMatch(String(result.messages.at(-1)?.content), /next appropriate available tool call/)
})

test('prose after a completed tool exchange is never interpreted as protocol state', () => {
  const texts = [
    'Understood. I will follow these instructions.',
    'continue',
    'Next I will update the implementation.',
    'Next:',
    '\u7ee7\u7eed\u5f53\u524d\u5de5\u4f5c',
    '\u63a5\u4e0b\u6765\u6211\u4f1a\u8fd0\u884c\u6d4b\u8bd5\uff1a',
  ]

  for (const content of texts) {
    const messages = [
      { role: 'user' as const, content: 'complete the requested workflow' },
      { role: 'assistant' as const, content: null, tool_calls: [{
        id: 'call_1',
        type: 'function' as const,
        function: { name: 'default_api:read_file', arguments: '{"filePath":"/tmp/a"}' },
      }] },
      { role: 'tool' as const, tool_call_id: 'call_1', content: '{"ok":true}' },
      { role: 'assistant' as const, content },
    ]
    const result = new ToolCallingEngine().transformRequest({
      request: request({ messages }),
      provider,
      actualModel: 'deepseek-chat',
    })

    assert.equal(result.plan.workflowContinuation, false, content)
    assert.equal(result.plan.failedToolResultPending, false, content)
    assert.equal(result.messages.at(-1)?.content, content)
    assert.equal('managedWorkflowActive' in result.plan, false)
    assert.equal('initialProgressRecoveryEligible' in result.plan, false)
  }
})

test('a new user turn also clears stale failed-result state from older history', () => {
  const result = new ToolCallingEngine().transformRequest({
    request: request({
      messages: [
        { role: 'user', content: 'earlier task' },
        { role: 'assistant', content: null, tool_calls: [{
          id: 'failed-call',
          type: 'function',
          function: { name: 'default_api:read_file', arguments: '{}' },
        }] },
        { role: 'tool', tool_call_id: 'failed-call', content: 'failed', is_error: true },
        { role: 'assistant', content: 'I could not finish the earlier task.' },
        { role: 'user', content: 'do something unrelated' },
      ],
    }),
    provider,
    actualModel: 'deepseek-chat',
  })

  assert.equal(result.plan.workflowContinuation, false)
  assert.equal(result.plan.failedToolResultPending, false)
  assert.equal(result.messages.at(-1)?.content, 'do something unrelated')
})

test('ordinary user turns without prior tool progress are not extended', () => {
  const result = new ToolCallingEngine().transformRequest({
    request: request(),
    provider,
    actualModel: 'deepseek-chat',
  })

  assert.equal(result.messages.at(-1)?.content, 'read /tmp/a')
  assert.equal(result.plan.workflowContinuation, false)
  assert.equal(result.plan.diagnostics.workflowContinuation, false)
  assert.doesNotMatch(String(result.messages.at(-1)?.content), /next appropriate available tool call/)
})

test('shape diagnostics are opt-in and omit message and tool values', () => {
  const envName = 'CHAT2API_TOOL_CALLING_SHAPE_DIAGNOSTICS'
  const previousEnv = process.env[envName]
  const originalInfo = console.info
  const output: string[] = []
  ;(console as any).info = (...args: unknown[]) => {
    output.push(args.map((arg) => String(arg)).join(' '))
  }
  process.env[envName] = 'true'

  try {
    new ToolCallingEngine().transformRequest({
      request: request({
        messages: [
          { role: 'system', content: 'TOP_SECRET_SYSTEM_BODY' },
          {
            role: 'assistant',
            content: [
              { type: 'text', text: 'TOP_SECRET_ASSISTANT_BODY' },
              { type: 'tool_use', id: 'uuid-secret', name: 'TOP_SECRET_TOOL', input: { path: 'C:\\secret' } },
            ] as any,
            tool_calls: [{
              id: 'uuid-secret',
              type: 'function',
              function: { name: 'TOP_SECRET_TOOL', arguments: '{"path":"C:\\secret"}' },
            }],
          },
          {
            role: 'tool',
            tool_call_id: 'uuid-secret',
            content: [{ type: 'tool_result', tool_use_id: 'uuid-secret', content: 'TOP_SECRET_RESULT_BODY' }] as any,
          },
        ],
      }),
      provider,
      actualModel: 'deepseek-chat',
    })
  } finally {
    console.info = originalInfo
    if (previousEnv === undefined) delete process.env[envName]
    else process.env[envName] = previousEnv
  }

  assert.equal(output.length, 1)
  assert.match(output[0], /request-shape/)
  assert.match(output[0], /"messageRoles":\["system","assistant","tool"\]/)
  assert.match(output[0], /"contentPartTypes":\["text","tool_use"\]/)
  assert.match(output[0], /"contentPartTypes":\["tool_result"\]/)
  assert.match(output[0], /"rawToolCount":4/)
  assert.match(output[0], /"normalizedToolCount":4/)
  assert.match(output[0], /"workflowContinuation":true/)
  assert.doesNotMatch(output[0], /managedWorkflowActive|initialProgressRecoveryEligible/)
  assert.doesNotMatch(output[0], /TOP_SECRET|uuid-secret|C:\\\\secret|TOP_SECRET_TOOL/)
})

test('client prompt signatures do not override selected adapter', () => {
  const result = new ToolCallingEngine().transformRequest({
    request: request({
      messages: [
        { role: 'system', content: 'You are Kilo, the best coding agent. Tool definitions:' },
        { role: 'user', content: 'read /tmp/a' },
      ],
    }),
    provider,
    actualModel: 'deepseek-chat',
  })

  assert.equal(result.plan.clientAdapterId, 'standard-openai-tools')
  assert.equal(result.plan.mode, 'managed')
  assert.equal(result.plan.shouldInjectPrompt, true)
})

test('No tools choose disabled', () => {
  const result = new ToolCallingEngine().transformRequest({
    request: request({ tools: undefined }),
    provider,
    actualModel: 'deepseek-chat',
  })

  assert.equal(result.plan.mode, 'disabled')
  assert.equal(result.plan.shouldInjectPrompt, false)
})

test('Store mode off chooses disabled', () => {
  const result = new ToolCallingEngine({ mode: 'off', enabled: false }).transformRequest({
    request: request(),
    provider,
    actualModel: 'deepseek-chat',
  })

  assert.equal(result.plan.mode, 'disabled')
  assert.equal(result.tools, tools)
})

test('tool_choice none chooses disabled even when tools are present', () => {
  const result = new ToolCallingEngine().transformRequest({
    request: request({ tool_choice: 'none' }),
    provider,
    actualModel: 'deepseek-chat',
  })

  assert.equal(result.plan.mode, 'disabled')
  assert.equal(result.plan.toolChoiceMode, 'none')
})

test('tool_choice required preserves required policy on the plan', () => {
  const result = new ToolCallingEngine().transformRequest({
    request: request({ tool_choice: 'required' }),
    provider,
    actualModel: 'deepseek-chat',
  })

  assert.equal(result.plan.toolChoiceMode, 'required')
  assert.deepEqual([...result.plan.allowedToolNames].sort(), ['default_api:list_dir', 'default_api:read_file', 'default_api:todowrite', 'default_api:write'])
  assert.match(result.messages[0].content as string, /a tool call is required/)
})

test('forced function choice narrows allowed tool names to the selected function', () => {
  const result = new ToolCallingEngine().transformRequest({
    request: request({ tool_choice: { type: 'function', function: { name: 'default_api:list_dir' } } }),
    provider,
    actualModel: 'deepseek-chat',
  })

  assert.equal(result.plan.toolChoiceMode, 'forced')
  assert.equal(result.plan.forcedToolName, 'default_api:list_dir')
  assert.deepEqual(result.plan.tools.map((tool) => tool.name), ['default_api:list_dir'])
  assert.match(result.messages[0].content as string, /must call `default_api:list_dir`/)
  assert.doesNotMatch(result.messages[0].content as string, /Tool `default_api:read_file`/)
})

test('non-stream parsing only accepts the selected provider protocol', () => {
  const engine = new ToolCallingEngine()
  const transformed = engine.transformRequest({
    request: request(),
    provider,
    actualModel: 'deepseek-chat',
  })
  const result: any = {
    choices: [{
      message: {
        role: 'assistant',
        content: '[function_calls][call:default_api:read_file]{"filePath":"/tmp/a"}[/call][/function_calls]',
      },
      finish_reason: 'stop',
    }],
  }

  engine.applyNonStreamResponse(result, transformed.plan)

  assert.equal(result.choices[0].message.tool_calls, undefined)
  assert.equal(result.choices[0].message.content, '[function_calls][call:default_api:read_file]{"filePath":"/tmp/a"}[/call][/function_calls]')
})

test('non-stream parsing rejects leaked managed tool-result wrappers', () => {
  const engine = new ToolCallingEngine()
  const transformed = engine.transformRequest({
    request: request(),
    provider,
    actualModel: 'deepseek-chat',
  })
  const content = [
    'verification follows ',
    '<|CHAT2API|tool_result tool_call_id="call_fake"><![CDATA[server: 200]]></|CHAT2API|tool_result>',
    ' fabricated success',
  ].join('')
  const result: any = {
    choices: [{
      message: { role: 'assistant', content },
      finish_reason: 'stop',
    }],
  }

  let error: (Error & { code?: string }) | undefined
  assert.throws(
    () => {
      try {
        engine.applyNonStreamResponse(result, transformed.plan)
      } catch (caught) {
        error = caught as Error & { code?: string }
        throw caught
      }
    },
    /internal managed tool-result wrapper/,
  )

  assert.equal(error?.code, 'managed_tool_result_wrapper_leak')
  assert.equal(result.choices[0].message.content, content)
  assert.equal(result.choices[0].message.tool_calls, undefined)
})

test('non-stream output rejects leaked wrappers when tool parsing is disabled', () => {
  const engine = new ToolCallingEngine()
  const transformed = engine.transformRequest({
    request: request({ tools: undefined }),
    provider,
    actualModel: 'deepseek-chat',
  })
  const result: any = {
    choices: [{
      message: {
        role: 'assistant',
        content: '<|CHAT2API|tool_result tool_call_id="call_fake"><![CDATA[value]]></|CHAT2API|tool_result>',
      },
      finish_reason: 'stop',
    }],
  }

  assert.equal(transformed.plan.shouldParseResponse, false)
  assert.throws(
    () => engine.applyNonStreamResponse(result, transformed.plan),
    (error: Error & { code?: string }) => error.code === 'managed_tool_result_wrapper_leak',
  )
})

test('non-stream output rejects leaked wrappers in reasoning when content is null', () => {
  const engine = new ToolCallingEngine()
  const transformed = engine.transformRequest({
    request: request({ tools: undefined }),
    provider,
    actualModel: 'deepseek-chat',
  })
  const result: any = {
    choices: [{
      message: {
        role: 'assistant',
        content: null,
        reasoning_content: '<|CHAT2API|tool_result tool_call_id="call_fake"><![CDATA[value]]></|CHAT2API|tool_result>',
      },
      finish_reason: 'stop',
    }],
  }

  assert.throws(
    () => engine.applyNonStreamResponse(result, transformed.plan),
    (error: Error & { code?: string, param?: string }) => (
      error.code === 'managed_tool_result_wrapper_leak'
      && error.param === 'reasoning_content'
    ),
  )
})

test('non-stream output scans every choice and structured assistant text block', () => {
  const engine = new ToolCallingEngine()
  const transformed = engine.transformRequest({
    request: request({ tools: undefined }),
    provider,
    actualModel: 'deepseek-chat',
  })
  const result: any = {
    choices: [
      {
        message: { role: 'assistant', content: 'safe first choice' },
        finish_reason: 'stop',
      },
      {
        message: {
          role: 'assistant',
          content: [{
            type: 'text',
            text: '<|CHAT2API|tool_result tool_call_id="call_fake"><![CDATA[value]]></|CHAT2API|tool_result>',
          }],
        },
        finish_reason: 'stop',
      },
    ],
  }

  assert.throws(
    () => engine.applyNonStreamResponse(result, transformed.plan),
    (error: Error & { code?: string, param?: string }) => (
      error.code === 'managed_tool_result_wrapper_leak'
      && error.param === 'choices[1].message.content[0].text'
    ),
  )
})

test('non-stream output does not scan structured tool-use arguments as assistant text', () => {
  const engine = new ToolCallingEngine()
  const transformed = engine.transformRequest({
    request: request({ tools: undefined }),
    provider,
    actualModel: 'deepseek-chat',
  })
  const literal = '<|CHAT2API|tool_result tool_call_id="call_fixture"><![CDATA[value]]></|CHAT2API|tool_result>'
  const result: any = {
    choices: [{
      message: {
        role: 'assistant',
        content: [{
          type: 'tool_use',
          id: 'call_fixture',
          name: 'write_fixture',
          input: { value: literal },
        }],
      },
      finish_reason: 'tool_calls',
    }],
  }

  assert.doesNotThrow(() => engine.applyNonStreamResponse(result, transformed.plan))
  assert.equal(result.choices[0].message.content[0].input.value, literal)
})

test('non-stream parsing recovers safely from malformed but complete managed XML', () => {
  const engine = new ToolCallingEngine()
  const transformed = engine.transformRequest({
    request: request({ tool_choice: 'required' }),
    provider,
    actualModel: 'deepseek-chat',
  })
  const result: any = {
    choices: [{
      message: {
        role: 'assistant',
        content: '<|CHAT2API|tool_calls><|CHAT2API|invoke name="default_api:read_file"><|CHAT2API|parameter name="filePath"><![CDATA[/tmp/a]]></|CHAT2API|parameter>',
      },
      finish_reason: 'stop',
    }],
  }

  engine.applyNonStreamResponse(result, transformed.plan)

  assert.equal(result.choices[0].message.content, null)
  assert.equal(result.choices[0].message.tool_calls[0].function.name, 'default_api:read_file')
  assert.equal(JSON.parse(result.choices[0].message.tool_calls[0].function.arguments).filePath, '/tmp/a')
  assert.equal(result.choices[0].finish_reason, 'tool_calls')
})

test('non-stream parsing assigns request-scoped tool call IDs', () => {
  const engine = new ToolCallingEngine()
  const transformed = engine.transformRequest({
    request: request({ tool_choice: 'required' }),
    provider,
    actualModel: 'deepseek-chat',
  })
  const createResult = () => ({
    choices: [{
      message: {
        role: 'assistant',
        content: '<|CHAT2API|tool_calls><|CHAT2API|invoke name="default_api:read_file"><|CHAT2API|parameter name="filePath"><![CDATA[/tmp/a]]></|CHAT2API|parameter></|CHAT2API|invoke></|CHAT2API|tool_calls>',
      },
      finish_reason: 'stop',
    }],
  })
  const first: any = createResult()
  const second: any = createResult()

  engine.applyNonStreamResponse(first, transformed.plan)
  engine.applyNonStreamResponse(second, transformed.plan)

  const firstId = first.choices[0].message.tool_calls[0].id
  const secondId = second.choices[0].message.tool_calls[0].id
  assert.match(firstId, /^call_[a-f0-9]{32}_0$/)
  assert.match(secondId, /^call_[a-f0-9]{32}_0$/)
  assert.notEqual(firstId, secondId)
})

test('non-stream parsing suppresses equivalent tool calls in one response', () => {
  const engine = new ToolCallingEngine()
  const transformed = engine.transformRequest({
    request: request({ tool_choice: 'required' }),
    provider,
    actualModel: 'deepseek-chat',
  })
  const result: any = {
    choices: [{
      message: {
        role: 'assistant',
        content: '<|CHAT2API|tool_calls><|CHAT2API|invoke name="default_api:read_file"><|CHAT2API|parameter name="filePath"><![CDATA[/tmp/a]]></|CHAT2API|parameter></|CHAT2API|invoke><|CHAT2API|invoke name="default_api:read_file"><|CHAT2API|parameter name="filePath"><![CDATA[/tmp/a]]></|CHAT2API|parameter></|CHAT2API|invoke></|CHAT2API|tool_calls>',
      },
      finish_reason: 'stop',
    }],
  }

  engine.applyNonStreamResponse(result, transformed.plan)

  assert.equal(result.choices[0].message.tool_calls.length, 1)
  assert.equal(result.choices[0].message.tool_calls[0].function.name, 'default_api:read_file')
  assert.equal(transformed.plan.diagnostics.parsedToolCallCount, 1)
  assert.equal(result.choices[0].finish_reason, 'tool_calls')
})

test('non-stream required tool call rejects malformed XML without complete parameters', () => {
  const engine = new ToolCallingEngine()
  const transformed = engine.transformRequest({
    request: request({ tool_choice: 'required' }),
    provider,
    actualModel: 'deepseek-chat',
  })
  const result: any = {
    choices: [{
      message: {
        role: 'assistant',
        content: '<|CHAT2API|tool_calls><|CHAT2API|invoke name="default_api:read_file"><|CHAT2API|parameter name="filePath"><![CDATA[/tmp/a',
      },
      finish_reason: 'stop',
    }],
  }

  assert.throws(
    () => engine.applyNonStreamResponse(result, transformed.plan),
    /malformed or empty tool call block/,
  )
  assert.equal(result.choices[0].message.tool_calls, undefined)
})

test('non-stream parsing removes malformed managed XML without fabricating optional tool calls', () => {
  const engine = new ToolCallingEngine()
  const transformed = engine.transformRequest({
    request: request(),
    provider,
    actualModel: 'deepseek-chat',
  })
  const result: any = {
    choices: [{
      message: {
        role: 'assistant',
        content: 'before <|CHAT2API|tool_calls><|CHAT2API|invoke name="default_api:read_file"><|CHAT2API|parameter name="filePath"><![CDATA[/tmp/a after',
      },
      finish_reason: 'stop',
    }],
  }

  engine.applyNonStreamResponse(result, transformed.plan)

  assert.equal(result.choices[0].message.tool_calls, undefined)
  assert.equal(result.choices[0].message.content, 'before')
  assert.equal(result.choices[0].finish_reason, 'stop')
})

test('non-stream Qwen Hermes removes a malformed optional tool block', () => {
  const engine = new ToolCallingEngine()
  const transformed = engine.transformRequest({
    request: request({
      messages: [
        { role: 'system', content: 'client system context' },
        { role: 'user', content: 'read /tmp/a' },
      ],
    }),
    provider: qwenAiProvider,
    actualModel: 'qwen3.8-max',
  })
  assert.equal(transformed.messages[0].content, 'client system context')
  assert.equal(transformed.messages[1].name, MANAGED_TOOL_PROMPT_MESSAGE_NAME)
  assert.match(String(transformed.messages[1].content), /<tools>/)
  const result: any = {
    choices: [{
      message: {
        role: 'assistant',
        content: '<tool_call>{"name":"default_api:read_file","arguments":{"filePath":"/tmp/a"}',
      },
      finish_reason: 'stop',
    }],
  }

  engine.applyNonStreamResponse(result, transformed.plan)

  assert.equal(result.choices[0].message.tool_calls, undefined)
  assert.equal(result.choices[0].message.content, null)
})
