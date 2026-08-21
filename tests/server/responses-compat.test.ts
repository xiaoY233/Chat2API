import assert from 'node:assert/strict'
import { once } from 'node:events'
import { Readable } from 'node:stream'
import test from 'node:test'
import {
  chatCompletionToResponse,
  responseOutputToChatMessages,
  responsesRequestToChatCompletion,
  type ResponseCreateRequest,
} from '../../src/main/proxy/responses/compat.ts'
import { ResponsesConversationStore } from '../../src/main/proxy/responses/store.ts'
import { createResponsesStreamTransform } from '../../src/main/proxy/responses/stream.ts'
import {
  createResponseImageResolver,
  isPublicImageAddress,
} from '../../src/main/proxy/responses/image.ts'

const ONE_PIXEL_PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Z3xkAAAAASUVORK5CYII='

async function collectResponseEvents(
  chunks: string[],
  request?: Partial<ResponseCreateRequest>,
  callbacks?: {
    onComplete?: (response: any) => void
    onIncomplete?: (response: any) => void
    onFailure?: (error: Error, response: any) => void
  },
) {
  const transform = createResponsesStreamTransform({
    request: {
      model: 'test-model',
      input: 'hello',
      stream: true,
      ...request,
    },
    responseId: 'resp_test',
    model: 'test-model',
    createdAt: 123,
    ...callbacks,
  }).start()
  let output = ''
  transform.on('data', (chunk: Buffer) => {
    output += chunk.toString()
  })
  Readable.from(chunks).pipe(transform)
  await once(transform, 'end')
  return output
    .split('\n\n')
    .filter(Boolean)
    .map((block) => JSON.parse(block.split('\n').find((line) => line.startsWith('data: '))!.slice(6)))
}

test('Responses request translates Codex messages, function history, strict tools, and image config', () => {
  const request: ResponseCreateRequest = {
    model: 'gpt-compatible',
    instructions: 'current instructions',
    input: [
      { role: 'developer', content: [{ type: 'input_text', text: 'repo rules' }] },
      {
        type: 'additional_tools',
        role: 'developer',
        tools: [{
          type: 'function',
          name: 'read_file',
          parameters: { type: 'object', properties: { path: { type: 'string' } } },
          strict: true,
        }],
      },
      { role: 'user', content: [{ type: 'input_text', text: 'weather?' }] },
      {
        type: 'function_call',
        id: 'fc_prior',
        call_id: 'call_prior',
        name: 'weather',
        arguments: '{"city":"Shanghai"}',
      },
      { type: 'function_call_output', call_id: 'call_prior', output: '{"temp":31}', is_error: true },
      { role: 'assistant', content: [{ type: 'output_text', text: 'It is warm.' }] },
    ],
    tools: [{
      type: 'function',
      name: 'weather',
      description: 'Get weather',
      parameters: { type: 'object', properties: { city: { type: 'string' } } },
      strict: true,
    }],
    additional_tools: [{ type: 'image_generation', size: '1024x1024', output_format: 'png' }],
    tool_choice: 'auto',
    max_output_tokens: 1024,
    reasoning: { effort: 'high', summary: 'auto' },
    parallel_tool_calls: false,
    text: { format: { type: 'json_object' } },
  }

  const previous = [{ role: 'user' as const, content: 'previous turn' }]
  const { chatRequest, conversationMessages } = responsesRequestToChatCompletion(request, previous)

  assert.equal(chatRequest.messages[0].role, 'system')
  assert.equal(chatRequest.messages[0].content, 'current instructions')
  assert.equal(chatRequest.messages[1].content, 'previous turn')
  assert.equal(chatRequest.messages[2].role, 'system')
  assert.equal(chatRequest.messages[4].tool_calls?.[0].id, 'call_prior')
  assert.deepEqual(chatRequest.messages[5], {
    role: 'tool',
    tool_call_id: 'call_prior',
    content: '{"temp":31}',
    is_error: true,
  })
  assert.equal((chatRequest.tools?.[0].function as any).strict, true)
  assert.deepEqual(chatRequest.tools?.map(tool => tool.function.name), ['weather', 'read_file'])
  assert.equal(chatRequest.max_tokens, 1024)
  assert.equal(chatRequest.reasoning_effort, 'high')
  assert.equal(chatRequest.parallel_tool_calls, false)
  assert.deepEqual(chatRequest.response_format, { type: 'json_object' })
  assert.deepEqual(chatRequest.image_generation, {
    enabled: true,
    size: '1024x1024',
    model: undefined,
    quality: undefined,
    format: 'png',
    action: undefined,
  })
  assert.equal(conversationMessages[0].content, 'previous turn')
  assert.equal(conversationMessages.some((message) => message.content === 'current instructions'), false)
})

test('Responses preserves compaction protocol metadata for the shared intent classifier', () => {
  const { chatRequest } = responsesRequestToChatCompletion({
    model: 'gpt-compatible',
    input: 'opaque protocol payload',
    metadata: { purpose: 'context_compaction' },
    context_management: { edits: [{ type: 'clear_tool_uses_20250919' }] },
  })

  assert.deepEqual(chatRequest.metadata, { purpose: 'context_compaction' })
  assert.deepEqual((chatRequest as any).context_management, {
    edits: [{ type: 'clear_tool_uses_20250919' }],
  })
})

test('Responses image generation remains off when tool_choice is none or another function', () => {
  const base = {
    model: 'test',
    input: 'draw',
    tools: [
      { type: 'image_generation' as const },
      { type: 'function' as const, name: 'other', parameters: { type: 'object' } },
    ],
  }
  assert.equal(responsesRequestToChatCompletion({ ...base, tool_choice: 'none' }).chatRequest.image_generation, undefined)
  assert.equal(responsesRequestToChatCompletion({
    ...base,
    tool_choice: { type: 'function', name: 'other' },
  }).chatRequest.image_generation, undefined)
})

test('Codex custom tools map through internal functions and preserve multimodal tool output', () => {
  const rawPatch = '*** Begin Patch\n*** Update File: example.txt\n@@\n-old\n+new\n*** End Patch'
  const request: ResponseCreateRequest = {
    model: 'gpt-compatible',
    input: [
      {
        type: 'additional_tools',
        role: 'developer',
        tools: [{ type: 'custom', name: 'view_image', description: 'Inspect an image' }],
      },
      {
        type: 'custom_tool_call',
        id: 'ctc_patch',
        call_id: 'call_patch',
        name: 'apply_patch',
        input: rawPatch,
      },
      {
        type: 'custom_tool_call',
        id: 'ctc_view',
        call_id: 'call_view',
        name: 'view_image',
        input: 'C:\\repo\\screenshot.png',
      },
      {
        // Codex currently uses function_call_output for some custom tools.
        type: 'function_call_output',
        call_id: 'call_patch',
        output: 'Exit code: 0',
      },
      {
        type: 'custom_tool_call_output',
        call_id: 'call_view',
        output: [{
          type: 'input_image',
          image_url: `data:image/png;base64,${ONE_PIXEL_PNG}`,
          detail: 'high',
        }],
      },
    ],
    tools: [{ type: 'custom', name: 'apply_patch', description: 'Apply a patch' }],
    tool_choice: { type: 'custom', name: 'apply_patch' },
    reasoning: { effort: 'xhigh' },
  }

  const { chatRequest } = responsesRequestToChatCompletion(request)
  assert.deepEqual(chatRequest.messages.map(message => message.role), [
    'assistant',
    'tool',
    'tool',
    'user',
  ])
  assert.deepEqual(chatRequest.messages[0].tool_calls, [
    {
      id: 'call_patch',
      type: 'function',
      function: { name: 'apply_patch', arguments: JSON.stringify({ input: rawPatch }) },
    },
    {
      id: 'call_view',
      type: 'function',
      function: { name: 'view_image', arguments: JSON.stringify({ input: 'C:\\repo\\screenshot.png' }) },
    },
  ])
  assert.equal(chatRequest.messages[1].content, 'Exit code: 0')
  assert.equal(JSON.stringify(chatRequest.messages[2]).includes(ONE_PIXEL_PNG), false)
  assert.deepEqual(chatRequest.messages[3].content, [
    { type: 'text', text: 'Tool output attachment follows.' },
    {
      type: 'image_url',
      image_url: {
        url: `data:image/png;base64,${ONE_PIXEL_PNG}`,
        detail: 'high',
      },
    },
  ])
  assert.deepEqual(chatRequest.tools?.map(tool => tool.function.name), ['apply_patch', 'view_image'])
  assert.deepEqual(chatRequest.tools?.[0].function.parameters, {
    type: 'object',
    properties: {
      input: {
        type: 'string',
        description: 'Complete raw input for the custom tool.',
      },
    },
    required: ['input'],
    additionalProperties: false,
  })
  assert.equal(chatRequest.tools?.[0].function.strict, true)
  assert.deepEqual(chatRequest.tool_choice, {
    type: 'function',
    function: { name: 'apply_patch' },
  })
  assert.equal(chatRequest.reasoning_effort, 'xhigh')
})

test('large view_image output is kept out of ordinary tool text', () => {
  const largeImage = `data:image/png;base64,${'A'.repeat(2 * 1024 * 1024)}`
  const { chatRequest } = responsesRequestToChatCompletion({
    model: 'test',
    input: [
      {
        type: 'custom_tool_call',
        call_id: 'call_view',
        name: 'view_image',
        input: 'large.png',
      },
      {
        type: 'custom_tool_call_output',
        call_id: 'call_view',
        output: [{ type: 'input_image', image_url: largeImage }],
      },
    ],
    tools: [{ type: 'custom', name: 'view_image' }],
  })

  const toolResult = chatRequest.messages.find(message => message.role === 'tool')
  assert.equal(toolResult?.content, 'Tool output attachment follows.')
  assert.ok(Buffer.byteLength(String(toolResult?.content), 'utf8') < 100)
  const imageMessage = chatRequest.messages.find(message => message.role === 'user')
  assert.equal(Array.isArray(imageMessage?.content), true)
  assert.equal((imageMessage?.content as any[])[1].image_url.url, largeImage)
})

test('standard function output preserves text and image attachments', () => {
  const imageUrl = `data:image/png;base64,${ONE_PIXEL_PNG}`
  const { chatRequest } = responsesRequestToChatCompletion({
    model: 'test',
    input: [
      {
        type: 'function_call',
        call_id: 'call_read_image',
        name: 'Read',
        arguments: JSON.stringify({ file_path: 'screenshot.png' }),
      },
      {
        type: 'function_call_output',
        call_id: 'call_read_image',
        output: [
          { type: 'input_text', text: 'Screenshot captured.' },
          { type: 'input_image', image_url: imageUrl },
        ],
        is_error: false,
      },
    ],
  })

  assert.deepEqual(chatRequest.messages.map(message => message.role), [
    'assistant',
    'tool',
    'user',
  ])
  assert.equal(chatRequest.messages[1].tool_call_id, 'call_read_image')
  assert.equal(chatRequest.messages[1].content, 'Screenshot captured.')
  assert.equal(chatRequest.messages[1].is_error, false)
  assert.equal(JSON.stringify(chatRequest.messages[1]).includes(ONE_PIXEL_PNG), false)
  assert.deepEqual(chatRequest.messages[2].content, [
    { type: 'text', text: 'Tool output attachment follows.' },
    {
      type: 'image_url',
      image_url: { url: imageUrl, detail: undefined },
    },
  ])
})

test('custom tool calls restore on non-stream output and previous-response history', async () => {
  const rawPatch = '*** Begin Patch\n*** End Patch'
  const request: ResponseCreateRequest = {
    model: 'test',
    input: 'update the file',
    tools: [
      { type: 'custom', name: 'apply_patch' },
      { type: 'function', name: 'save', parameters: { type: 'object' } },
    ],
  }
  const response = await chatCompletionToResponse({
    model: 'test',
    choices: [{
      message: {
        role: 'assistant',
        content: null,
        tool_calls: [
          {
            id: 'call_patch',
            type: 'function',
            function: {
              name: 'apply_patch',
              arguments: JSON.stringify({ input: rawPatch }),
            },
          },
          {
            id: 'call_save',
            type: 'function',
            function: { name: 'save', arguments: '{"path":"example.txt"}' },
          },
        ],
      },
    }],
  }, request, {
    id: 'resp_custom',
    model: 'test',
    createdAt: 123,
  })

  assert.deepEqual(response.output.map(item => item.type), [
    'custom_tool_call',
    'function_call',
  ])
  assert.equal(response.output[0].id, 'ctc_custom_0')
  assert.equal(response.output[0].call_id, 'call_patch')
  assert.equal(response.output[0].input, rawPatch)
  assert.equal(response.output[0].arguments, undefined)

  const history = responseOutputToChatMessages(response.output)
  assert.deepEqual(history[0].tool_calls?.map(call => call.function), [
    { name: 'apply_patch', arguments: JSON.stringify({ input: rawPatch }) },
    { name: 'save', arguments: '{"path":"example.txt"}' },
  ])

  const functionRequest = { ...request, tools: [{ type: 'function', name: 'apply_patch' }] }
  const functionResponse = await chatCompletionToResponse({
    model: 'test',
    choices: [{
      message: {
        role: 'assistant',
        content: null,
        tool_calls: [{
          id: 'call_function',
          type: 'function',
          function: { name: 'apply_patch', arguments: '{"path":"x"}' },
        }],
      },
    }],
  }, functionRequest, {
    id: 'resp_function',
    model: 'test',
    createdAt: 123,
  })
  assert.equal(functionResponse.output[0].type, 'function_call')
})

test('Responses preserves minimal and xhigh reasoning effort values', () => {
  for (const effort of ['minimal', 'xhigh'] as const) {
    const translated = responsesRequestToChatCompletion({
      model: 'test',
      input: 'reason',
      reasoning: { effort },
    })
    assert.equal(translated.chatRequest.reasoning_effort, effort)
  }
  assert.equal(responsesRequestToChatCompletion({
    model: 'test',
    input: 'reason',
    reasoning: { effort: 'unsupported' },
  }).chatRequest.reasoning_effort, undefined)
})

test('non-stream truncation and content filtering produce incomplete Responses', async () => {
  for (const [finishReason, expectedReason] of [
    ['length', 'max_output_tokens'],
    ['content_filter', 'content_filter'],
  ] as const) {
    const response = await chatCompletionToResponse({
      model: 'test',
      choices: [{
        message: {
          role: 'assistant',
          content: 'partial output',
          tool_calls: [{
            id: 'call_partial',
            type: 'function',
            function: {
              name: 'apply_patch',
              arguments: JSON.stringify({ input: 'partial patch' }),
            },
          }],
        },
        finish_reason: finishReason,
      }],
    }, {
      model: 'test',
      input: 'update',
      tools: [{ type: 'custom', name: 'apply_patch' }],
    }, {
      id: `resp_${finishReason}`,
      model: 'test',
      createdAt: 123,
    })

    assert.equal(response.status, 'incomplete')
    assert.deepEqual(response.incomplete_details, { reason: expectedReason })
    assert.equal(response.completed_at, null)
    assert.deepEqual(response.output.map(item => item.status), ['incomplete', 'incomplete'])
    assert.deepEqual(response.output.map(item => item.type), ['message', 'custom_tool_call'])
  }
})

test('non-stream Chat response maps text, function calls, and image payloads to output items', async () => {
  const response = await chatCompletionToResponse({
    id: 'chatcmpl_test',
    object: 'chat.completion',
    created: 123,
    model: 'upstream-model',
    choices: [{
      index: 0,
      message: {
        role: 'assistant',
        content: `Generated image: ![image](data:image/png;base64,${ONE_PIXEL_PNG})`,
        tool_calls: [{
          id: 'call_1',
          type: 'function',
          function: { name: 'save', arguments: '{"path":"x"}' },
        }],
        images: [{
          type: 'image_url',
          image_url: { url: `data:image/png;base64,${ONE_PIXEL_PNG}` },
          source: 'qwen-ai',
        }],
      },
      finish_reason: 'tool_calls',
    }],
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
  }, {
    model: 'requested-model',
    input: 'draw',
    tools: [{ type: 'image_generation' }],
  }, {
    id: 'resp_nonstream',
    model: 'requested-model',
    createdAt: 123,
  })

  assert.deepEqual(response.output.map((item) => item.type), [
    'message',
    'function_call',
    'image_generation_call',
  ])
  assert.equal(response.output[1].call_id, 'call_1')
  assert.equal(response.output[2].result, ONE_PIXEL_PNG)
  assert.equal(response.output[2].result_url, undefined)
  assert.equal(response.usage?.total_tokens, 15)
})

test('bounded image resolver converts an HTTPS image URL to the official base64 result', async () => {
  const imageResolver = createResponseImageResolver({
    remoteImageLoader: async () => Buffer.from(ONE_PIXEL_PNG, 'base64'),
  })
  const response = await chatCompletionToResponse({
    model: 'test',
    choices: [{
      message: {
        role: 'assistant',
        content: '![image](https://example.test/generated.png)',
        images: [{
          type: 'image_url',
          image_url: { url: 'https://example.test/generated.png' },
          source: 'qwen-ai',
        }],
      },
    }],
  }, { model: 'test', input: 'draw' }, {
    id: 'resp_url',
    model: 'test',
    createdAt: 123,
    imageResolver,
  })

  const image = response.output.find((item) => item.type === 'image_generation_call')!
  assert.equal(image.result, ONE_PIXEL_PNG)
  assert.equal(image.result_url, undefined)
})

test('bounded image resolver rejects non-public and non-HTTPS image targets', async () => {
  const resolver = createResponseImageResolver({ timeoutMs: 100 })
  await assert.rejects(
    resolver({ image_url: { url: 'http://example.com/generated.png' } }),
    /public HTTPS/i,
  )
  await assert.rejects(
    resolver({ image_url: { url: 'https://127.0.0.1/generated.png' } }),
    /public address/i,
  )
  assert.equal(isPublicImageAddress('127.0.0.1'), false)
  assert.equal(isPublicImageAddress('8.8.8.8'), true)
  assert.equal(isPublicImageAddress('2001:db8::1'), false)
})

test('text streaming emits the official typed event sequence and complete response', async () => {
  const events = await collectResponseEvents([
    'data: {"choices":[{"delta":{"role":"assistant","content":"Hel"}}]}\r',
    '\n\r\ndata: {"choices":[{"delta":{"content":"lo"}}]}\r\n\r\n',
    'data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":2,"completion_tokens":1,"total_tokens":3}}\n\n',
    'data: [DONE]\n\n',
  ])

  assert.deepEqual(events.map((event) => event.type), [
    'response.created',
    'response.in_progress',
    'response.output_item.added',
    'response.content_part.added',
    'response.output_text.delta',
    'response.output_text.delta',
    'response.output_text.done',
    'response.content_part.done',
    'response.output_item.done',
    'response.completed',
  ])
  assert.deepEqual(events.map((event) => event.sequence_number), events.map((_, index) => index))
  assert.equal(events.at(-1).response.output[0].content[0].text, 'Hello')
  assert.equal(events.at(-1).response.usage.total_tokens, 3)
})

test('reasoning streaming emits live Responses deltas before answer text', async () => {
  const events = await collectResponseEvents([
    'data: {"choices":[{"delta":{"role":"assistant","reasoning_content":"first "}}]}\n\n',
    'data: {"choices":[{"delta":{"reasoning_content":"second"}}]}\n\n',
    'data: {"choices":[{"delta":{"content":"final"}}]}\n\n',
    'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n',
    'data: [DONE]\n\n',
  ])

  assert.deepEqual(events.map((event) => event.type), [
    'response.created',
    'response.in_progress',
    'response.output_item.added',
    'response.reasoning_summary_text.delta',
    'response.reasoning_summary_text.delta',
    'response.reasoning_summary_text.done',
    'response.reasoning_summary_part.done',
    'response.output_item.done',
    'response.output_item.added',
    'response.content_part.added',
    'response.output_text.delta',
    'response.output_text.done',
    'response.content_part.done',
    'response.output_item.done',
    'response.completed',
  ])
  assert.deepEqual(events.map((event) => event.sequence_number), events.map((_, index) => index))
  assert.equal(events[3].delta, 'first ')
  assert.equal(events[4].delta, 'second')
  assert.equal(events[5].text, 'first second')
  assert.equal(events.at(-1).response.output[0].type, 'reasoning')
  assert.equal(events.at(-1).response.output[0].summary[0].text, 'first second')
  assert.equal(events.at(-1).response.output[1].content[0].text, 'final')
})

test('function streaming merges cumulative arguments and emits argument events', async () => {
  const events = await collectResponseEvents([
    'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_weather","type":"function","function":{"name":"weather","arguments":"{\\"city\\""}}]}}]}\n\n',
    'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\\"city\\":\\"Shanghai\\"}"}}]}}]}\n\n',
    'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}\n\n',
    'data: [DONE]\n\n',
  ])

  assert.deepEqual(events.map((event) => event.type), [
    'response.created',
    'response.in_progress',
    'response.output_item.added',
    'response.function_call_arguments.delta',
    'response.function_call_arguments.delta',
    'response.function_call_arguments.done',
    'response.output_item.done',
    'response.completed',
  ])
  const completed = events.at(-1).response
  assert.equal(completed.output[0].type, 'function_call')
  assert.equal(completed.output[0].call_id, 'call_weather')
  assert.equal(completed.output[0].arguments, '{"city":"Shanghai"}')
})

test('custom tool streaming restores raw input and official custom events', async () => {
  const rawInput = '*** Begin Patch\n*** Update File: example.txt\n@@\n-old\n+new\n*** End Patch'
  const wrapped = JSON.stringify({ input: rawInput })
  const splitAt = Math.floor(wrapped.length / 2)
  const first = {
    choices: [{
      delta: {
        tool_calls: [{
          index: 0,
          id: 'call_patch',
          type: 'function',
          function: { name: 'apply_', arguments: wrapped.slice(0, splitAt) },
        }],
      },
      finish_reason: null,
    }],
  }
  const second = {
    choices: [{
      delta: {
        tool_calls: [{
          index: 0,
          function: { name: 'patch', arguments: wrapped.slice(splitAt) },
        }],
      },
      finish_reason: null,
    }],
  }
  const events = await collectResponseEvents([
    `data: ${JSON.stringify(first)}\n\n`,
    `data: ${JSON.stringify(second)}\n\n`,
    'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}\n\n',
    'data: [DONE]\n\n',
  ], {
    tools: [{ type: 'custom', name: 'apply_patch', description: 'Apply a patch' }],
  })

  assert.equal(events.some((event) => event.type === 'response.function_call_arguments.delta'), false)
  const delta = events.find((event) => event.type === 'response.custom_tool_call_input.delta')
  assert.equal(delta.delta, rawInput)
  const done = events.find((event) => event.type === 'response.custom_tool_call_input.done')
  assert.equal(done.input, rawInput)
  const completed = events.at(-1).response
  assert.deepEqual(completed.output[0], {
    id: 'ctc_test_0',
    type: 'custom_tool_call',
    status: 'completed',
    call_id: 'call_patch',
    name: 'apply_patch',
    input: rawInput,
  })
})

test('streaming upstream errors fail exactly once and never report completion', async () => {
  let failures = 0
  let completions = 0
  const events = await collectResponseEvents([
    'data: {"choices":[{"delta":{"content":"partial"},"finish_reason":null}]}\n\n',
    'data: {"error":{"message":"synthetic boom","code":"synthetic_error"}}\n\n',
    'data: [DONE]\n\n',
  ], undefined, {
    onComplete: () => { completions += 1 },
    onFailure: () => { failures += 1 },
  })

  assert.equal(failures, 1)
  assert.equal(completions, 0)
  assert.equal(events.filter((event) => event.type === 'response.failed').length, 1)
  assert.equal(events.some((event) => event.type === 'response.completed'), false)
  const failed = events.find((event) => event.type === 'response.failed')
  assert.equal(failed.response.status, 'failed')
  assert.equal(failed.response.error.code, 'synthetic_error')
})

test('lifecycle callback failures cannot remove Responses terminal events', async () => {
  const completed = await collectResponseEvents([
    'data: {"choices":[{"delta":{"content":"complete"},"finish_reason":"stop"}]}\n\n',
    'data: [DONE]\n\n',
  ], undefined, {
    onComplete: () => { throw new Error('synthetic completion callback failure') },
  })
  assert.equal(completed.filter((event) => event.type === 'response.completed').length, 1)
  assert.equal(completed.some((event) => event.type === 'response.failed'), false)

  const failed = await collectResponseEvents([
    'data: {"error":{"message":"synthetic upstream failure","code":"synthetic_error"}}\n\n',
    'data: [DONE]\n\n',
  ], undefined, {
    onFailure: () => { throw new Error('synthetic failure callback failure') },
  })
  assert.equal(failed.filter((event) => event.type === 'response.failed').length, 1)
  assert.equal(failed.some((event) => event.type === 'response.completed'), false)
})

test('length and content filtering produce official incomplete terminal responses', async () => {
  for (const [finishReason, expectedReason] of [
    ['length', 'max_output_tokens'],
    ['content_filter', 'content_filter'],
  ] as const) {
    let incompleteCalls = 0
    const events = await collectResponseEvents([
      `data: {"choices":[{"delta":{"content":"partial"},"finish_reason":"${finishReason}"}]}\n\n`,
      'data: [DONE]\n\n',
    ], undefined, {
      onIncomplete: () => { incompleteCalls += 1 },
    })

    assert.equal(incompleteCalls, 1)
    assert.equal(events.some((event) => event.type === 'response.completed'), false)
    const terminal = events.find((event) => event.type === 'response.incomplete')
    assert.equal(terminal.response.status, 'incomplete')
    assert.equal(terminal.response.incomplete_details.reason, expectedReason)
    assert.equal(terminal.response.output[0].status, 'incomplete')
  }
})

test('malformed SSE JSON and premature EOF fail instead of completing', async () => {
  const malformed = await collectResponseEvents([
    'data: {not-json}\n\n',
    'data: [DONE]\n\n',
  ])
  assert.equal(malformed.some((event) => event.type === 'response.failed'), true)
  assert.equal(malformed.some((event) => event.type === 'response.completed'), false)

  const truncated = await collectResponseEvents([
    'data: {"choices":[{"delta":{"content":"partial"},"finish_reason":null}]}\n\n',
  ])
  const failed = truncated.find((event) => event.type === 'response.failed')
  assert.equal(failed.response.error.code, 'incomplete_upstream_stream')
  assert.equal(truncated.some((event) => event.type === 'response.completed'), false)

  const missingFinishReason = await collectResponseEvents([
    'data: {"choices":[{"delta":{"content":"partial"},"finish_reason":null}]}\n\n',
    'data: [DONE]\n\n',
  ])
  assert.equal(missingFinishReason.at(-1).type, 'response.failed')
  assert.equal(missingFinishReason.at(-1).response.error.code, 'invalid_upstream_stream')
})

test('one-megabyte input remains intact and the previous-response store is byte bounded', () => {
  const longInput = 'x'.repeat(1024 * 1024)
  const translated = responsesRequestToChatCompletion({ model: 'test', input: longInput })
  assert.equal(translated.chatRequest.messages[0].content, longInput)

  let now = 1000
  const store = new ResponsesConversationStore({
    ttlMs: 100,
    maxEntries: 4,
    maxEntryBytes: 2 * 1024 * 1024,
    maxTotalBytes: 1500 * 1024,
    now: () => now,
  })
  assert.equal(store.set('resp_1', translated.conversationMessages), true)
  assert.equal(store.set('resp_2', [{ role: 'user', content: 'y'.repeat(1024 * 1024) }]), true)
  assert.equal(store.get('resp_1'), undefined)
  assert.equal(store.stats().entries, 1)
  now += 101
  assert.equal(store.get('resp_2'), undefined)
  assert.deepEqual(store.stats(), { entries: 0, totalBytes: 0 })
})
