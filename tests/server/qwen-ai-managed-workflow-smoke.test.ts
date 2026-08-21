import assert from 'node:assert/strict'
import test from 'node:test'

import { prepareQwenAiMultimodalMessage } from '../../src/main/proxy/adapters/qwen-ai-files.ts'
import { createQwenAiFeatureConfig } from '../../src/main/proxy/adapters/qwen-ai-feature-config.ts'
import { ToolCallingEngine } from '../../src/main/proxy/toolCalling/ToolCallingEngine.ts'
import { ToolStreamParser } from '../../src/main/proxy/toolCalling/ToolStreamParser.ts'
import {
  hasManagedWorkflowCompletionMarker,
  requiresManagedWorkflowCompletionMarker,
  stripManagedWorkflowCompletionMarker,
} from '../../src/main/proxy/toolCalling/workflowCompletion.ts'
import type { Provider } from '../../src/main/store/types.ts'
import type { ChatCompletionRequest, ChatMessage } from '../../src/main/proxy/types.ts'

const provider = {
  id: 'qwen-ai',
  name: 'Qwen AI',
  type: 'builtin',
  authType: 'jwt',
  apiEndpoint: 'https://chat.qwen.ai',
  headers: {},
  enabled: true,
  createdAt: 0,
  updatedAt: 0,
} as Provider

const tools = [{
  type: 'function' as const,
  function: {
    name: 'Read',
    description: 'Read one local text file',
    parameters: {
      type: 'object',
      properties: { file_path: { type: 'string' } },
      required: ['file_path'],
      additionalProperties: false,
    },
  },
}]

test('Qwen managed workflow smoke: tool call, tool result, final answer', async () => {
  const engine = new ToolCallingEngine()
  const initialRequest: ChatCompletionRequest = {
    model: 'Qwen3.8-Max',
    messages: [{ role: 'user', content: 'Read README.md and report its title.' }],
    tools,
    tool_choice: 'auto',
  }
  const firstTurn = engine.transformRequest({
    request: initialRequest,
    provider,
    actualModel: 'qwen3.8-max',
  })

  assert.equal(firstTurn.plan.protocol, 'qwen_hermes')
  assert.equal(firstTurn.plan.workflowContinuation, false)
  assert.equal(requiresManagedWorkflowCompletionMarker(firstTurn.plan), true)
  assert.match(String(firstTurn.messages[0].content), /<tools>/)
  assert.match(String(firstTurn.messages[0].content), /chat2api_workflow_complete/)
  assert.deepEqual(createQwenAiFeatureConfig({
    thinkingEnabled: false,
    autoThinking: false,
    thinkingBudget: 8192,
  }), {
    thinking_enabled: false,
    output_schema: 'phase',
    research_mode: 'normal',
    auto_thinking: false,
    auto_search: false,
  })

  const parser = new ToolStreamParser(firstTurn.plan, 'smoke')
  const baseChunk = {
    id: 'smoke-response',
    model: 'qwen3.8-max',
    object: 'chat.completion.chunk',
    created: 1,
  }
  assert.deepEqual(parser.push('<tool_ca', baseChunk, true), [])
  assert.deepEqual(parser.push(
    'll>{"name":"Read","arguments":{"file_path":"README.md"}}</tool_call>',
    baseChunk,
  ), [])
  const parsedChunks = parser.flush(baseChunk)
  const parsedCall = parsedChunks[0].choices[0].delta.tool_calls[0]
  assert.equal(parsedCall.function.name, 'Read')
  assert.deepEqual(JSON.parse(parsedCall.function.arguments), { file_path: 'README.md' })

  const toolResultMessage = {
    role: 'user',
    content: [{
      type: 'tool_result',
      tool_use_id: parsedCall.id,
      content: '# Chat2API\n',
      is_error: false,
    }],
  } as unknown as ChatMessage
  const resultRequest: ChatCompletionRequest = {
    ...initialRequest,
    messages: [
      initialRequest.messages[0],
      {
        role: 'assistant',
        content: null,
        tool_calls: [parsedCall],
      },
      toolResultMessage,
    ],
  }
  const finalTurn = engine.transformRequest({
    request: resultRequest,
    provider,
    actualModel: 'qwen3.8-max',
  })

  assert.equal(finalTurn.plan.workflowContinuation, true)
  assert.equal(requiresManagedWorkflowCompletionMarker(finalTurn.plan), false)
  const prepared = await prepareQwenAiMultimodalMessage(finalTurn.messages, {} as never)
  assert.match(prepared.content, /<tool_call>/)
  assert.match(prepared.content, /"name":"Read"/)
  assert.match(prepared.content, /<tool_response>\n# Chat2API\n\n<\/tool_response>/)
  assert.doesNotMatch(prepared.content, /<\|CHAT2API\|tool_calls>/)

  const finalContent = 'The title is Chat2API.<chat2api_workflow_complete/>'
  assert.equal(hasManagedWorkflowCompletionMarker(finalContent, finalTurn.plan), true)
  assert.equal(
    stripManagedWorkflowCompletionMarker(finalContent, finalTurn.plan),
    'The title is Chat2API.',
  )
})

test('Qwen feature config keeps thinking and auto-thinking as independent switches', () => {
  for (const { thinkingEnabled, autoThinking } of [
    { thinkingEnabled: false, autoThinking: false },
    { thinkingEnabled: true, autoThinking: false },
    { thinkingEnabled: true, autoThinking: true },
    { thinkingEnabled: false, autoThinking: true },
  ]) {
    const featureConfig = createQwenAiFeatureConfig({
      thinkingEnabled,
      autoThinking,
    })

    assert.equal(featureConfig.thinking_enabled, thinkingEnabled)
    assert.equal(featureConfig.auto_thinking, autoThinking)
    assert.equal('thinking_format' in featureConfig, thinkingEnabled)
  }
})

test('custom Qwen provider instance keeps Hermes prompt and serialized tool history aligned', async () => {
  const customProvider = {
    ...provider,
    id: 'custom-qwen-instance',
    type: 'custom',
  } as Provider
  const engine = new ToolCallingEngine()
  const transformed = engine.transformRequest({
    request: {
      model: 'client-configured-model',
      messages: [
        { role: 'user', content: 'Read README.md.' },
        {
          role: 'assistant',
          content: null,
          tool_calls: [{
            id: 'custom-call',
            type: 'function',
            function: {
              name: 'Read',
              arguments: JSON.stringify({ file_path: 'README.md' }),
            },
          }],
        },
        {
          role: 'tool',
          tool_call_id: 'custom-call',
          content: '# Chat2API',
        },
      ],
      tools,
      tool_choice: 'auto',
    },
    provider: customProvider,
    providerProfileKey: 'qwen-ai',
    actualModel: 'provider-configured-model',
  })
  const prepared = await prepareQwenAiMultimodalMessage(transformed.messages, {} as never)

  assert.equal(transformed.plan.protocol, 'qwen_hermes')
  assert.equal(transformed.plan.diagnostics.providerId, 'custom-qwen-instance')
  assert.match(prepared.content, /<tools>/)
  assert.match(prepared.content, /<tool_call>/)
  assert.match(prepared.content, /<tool_response>\n# Chat2API\n<\/tool_response>/)
  assert.doesNotMatch(prepared.content, /chat2api_workflow_complete/)
  assert.doesNotMatch(prepared.content, /<\|CHAT2API\|tool_calls>/)
})

test('Qwen large managed workflow offloads history and complete tool references before first chat payload', async () => {
  const engine = new ToolCallingEngine()
  const fullDescriptionMarker = `${'documentation '.repeat(280)}:FULL_DESCRIPTION_MARKER`
  const largeTools = Array.from({ length: 35 }, (_, index) => ({
    type: 'function' as const,
    function: {
      name: `fixture_tool_${String(index).padStart(2, '0')}`,
      description: `${fullDescriptionMarker}:tool-${index}`,
      parameters: {
        type: 'object',
        description: `schema annotation ${'details '.repeat(120)}`,
        properties: {
          input: {
            type: 'string',
            description: `input annotation ${'details '.repeat(120)}`,
            minLength: 1,
          },
        },
        required: ['input'],
        additionalProperties: false,
      },
    },
  }))
  const oldHistory = `ARCHIVED_HISTORY_START:${'h'.repeat(110_000)}:ARCHIVED_HISTORY_END`
  const activeTask = 'ACTIVE_USER_TASK_SENTINEL'
  const activeResult = `ACTIVE_TOOL_RESULT_SENTINEL:${'r'.repeat(12_000)}`
  const request: ChatCompletionRequest = {
    model: 'client-configured-model',
    messages: [
      { role: 'system', content: 'ORDINARY_SYSTEM_SENTINEL' },
      { role: 'user', content: oldHistory },
      { role: 'assistant', content: 'Archived answer.' },
      { role: 'user', content: activeTask },
      {
        role: 'assistant',
        content: null,
        tool_calls: [{
          id: 'active-call',
          type: 'function',
          function: {
            name: 'fixture_tool_00',
            arguments: JSON.stringify({ input: 'fixture' }),
          },
        }],
      },
      {
        role: 'tool',
        tool_call_id: 'active-call',
        content: activeResult,
      },
    ],
    tools: largeTools,
    tool_choice: 'auto',
  }
  const requestSnapshot = structuredClone(request)
  const transformed = engine.transformRequest({
    request,
    provider,
    actualModel: 'provider-selected-model',
  })
  const uploads: any[] = []
  const prepared = await prepareQwenAiMultimodalMessage(transformed.messages, {
    uploadPart: async (part: any) => {
      uploads.push(part)
      return { file: { id: `fixture-upload-${uploads.length}`, filename: part.filename } }
    },
  } as never, {
    requestMaxBytes: 90 * 1024,
    managedToolCalling: true,
    workflowContinuation: transformed.plan.workflowContinuation,
  })

  assert.equal(prepared.transport, 'document')
  assert.ok(prepared.inlineUtf8Bytes < 90 * 1024)
  assert.match(prepared.content, /ACTIVE_USER_TASK_SENTINEL/)
  assert.match(prepared.content, /ACTIVE_TOOL_RESULT_SENTINEL/)
  assert.match(prepared.content, /fixture_tool_00/)
  assert.doesNotMatch(prepared.content, /ARCHIVED_HISTORY_START|FULL_DESCRIPTION_MARKER/)

  const decodeUpload = (prefix: string): string => {
    const upload = uploads.find(part => String(part.filename).startsWith(prefix))
    assert.ok(upload, `missing ${prefix} upload`)
    return Buffer.from(String(upload.file_url.url).split(',', 2)[1], 'base64').toString('utf8')
  }
  const archivedTranscript = decodeUpload('chat2api-conversation-')
  const completeToolReference = decodeUpload('chat2api-tool-reference-')
  assert.match(archivedTranscript, /ARCHIVED_HISTORY_START/)
  assert.doesNotMatch(archivedTranscript, /ACTIVE_USER_TASK_SENTINEL|ACTIVE_TOOL_RESULT_SENTINEL/)
  assert.match(completeToolReference, /FULL_DESCRIPTION_MARKER/)
  assert.match(completeToolReference, /fixture_tool_34/)
  assert.deepEqual(request, requestSnapshot)
})
