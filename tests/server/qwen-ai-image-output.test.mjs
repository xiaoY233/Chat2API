import assert from 'node:assert/strict'
import { once } from 'node:events'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import { PassThrough } from 'node:stream'
import test from 'node:test'
import ts from 'typescript'
import {
  ManagedToolResultGuard as RealManagedToolResultGuard,
  stripManagedToolResultWrappers as realStripManagedToolResultWrappers,
} from '../../src/main/proxy/toolCalling/managedToolResultGuard.ts'
import {
  normalizeQwenAiModelModeName as realNormalizeQwenAiModelModeName,
  resolveQwenAiModelMode as realResolveQwenAiModelMode,
} from '../../src/main/providers/qwen-ai-model-mode.ts'

const runtimeRequire = createRequire(import.meta.url)
const ONE_PIXEL_PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Z3xkAAAAASUVORK5CYII='

function loadQwenAiModule() {
  const source = fs.readFileSync('src/main/proxy/adapters/qwen-ai.ts', 'utf8')
  const output = ts.transpileModule(source, {
    compilerOptions: {
      esModuleInterop: true,
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
    },
  }).outputText
  const module = { exports: {} }
  const localModules = {
    axios: {
      create: () => ({}),
    },
    '../../store/types': {},
    '../promptToolUse': {
      hasToolUse: () => false,
      parseToolUse: () => [],
    },
    './qwen-ai-token-refresh': {
      QwenAiTokenRefresher: class {
        async refreshIfNeeded(account) { return account }
        async refreshAfterUnauthorized(account) { return account }
      },
      hasQwenAiSessionCookie: cookies => /(?:^|;\s*)token=[^;]+/.test(cookies || ''),
      resolveQwenAiAuthHeaders: (token, cookies) => ({
        ...(token && !/(?:^|;\s*)token=[^;]+/.test(cookies || '')
          ? { Authorization: `Bearer ${token}` }
          : {}),
        ...(cookies ? { Cookie: cookies } : {}),
      }),
    },
    './qwen-ai-files': {
      QwenAiFileUploader: class {},
      QWEN_AI_DOCUMENT_EVIDENCE_MARKER: '[Attached document evidence]',
      prepareQwenAiMultimodalMessage: async messages => ({
        content: String(messages.at(-1)?.content || ''),
        files: [],
      }),
    },
    '../utils/streamToolHandler': {
      createBaseChunk: (id, model, created) => ({
        id,
        model,
        object: 'chat.completion.chunk',
        created,
      }),
    },
    '../utils/errors': {
      isClientCancellationError: () => false,
      sanitizeForwardedErrorHeaders: () => undefined,
    },
    '../toolCalling/ToolStreamParser': {
      ToolStreamParser: class {},
    },
    '../toolCalling/managedToolResultGuard': {
      ManagedToolResultGuard: RealManagedToolResultGuard,
      stripManagedToolResultWrappers: realStripManagedToolResultWrappers,
    },
    '../toolCalling/protocols': {
      getToolProtocol: () => ({ parse: () => ({ toolCalls: [] }) }),
    },
    '../toolCalling/workflowCompletion': {
      hasManagedWorkflowCompletionMarker: () => false,
      parseManagedWorkflowCompletionProof: content => ({ complete: false, content }),
      requiresManagedWorkflowCompletionMarker: () => false,
      stripManagedWorkflowCompletionMarker: content => content,
    },
    '../toolCalling/streamValidationPolicy': {
      getToolStreamValidationFailure: () => undefined,
    },
    '../toolCalling/protocols/shared': {
      normalizeArguments: value => value,
      getToolArgumentValidationIssues: () => ({ missingRequired: [], unexpected: [] }),
    },
    './qwen-ai-native-tools': {
      isCompleteJsonText: () => true,
      mergeNativeToolArguments: (_current, next) => next,
      normalizeNativeFunctionCallDelta: () => [],
    },
    './qwen-ai-feature-config': {
      createQwenAiFeatureConfig: ({ thinkingEnabled, autoThinking, thinkingBudget }) => ({
        thinking_enabled: thinkingEnabled,
        output_schema: 'phase',
        research_mode: 'normal',
        auto_thinking: autoThinking,
        auto_search: false,
        ...(thinkingEnabled ? {
          thinking_format: 'summary',
          ...(thinkingBudget ? { thinking_budget: thinkingBudget } : {}),
        } : {}),
      }),
    },
    '../../providers/qwen-ai-model-mode': {
      normalizeQwenAiModelModeName: realNormalizeQwenAiModelModeName,
      resolveQwenAiModelMode: realResolveQwenAiModelMode,
    },
  }
  const testRequire = specifier => {
    if (Object.prototype.hasOwnProperty.call(localModules, specifier)) {
      return localModules[specifier]
    }
    if (specifier.startsWith('.')) {
      throw new Error(`Unexpected Qwen AI image test import: ${specifier}`)
    }
    return runtimeRequire(specifier)
  }

  new Function('require', 'module', 'exports', output)(testRequire, module, module.exports)
  return module.exports
}

function event(delta) {
  return `data: ${JSON.stringify({ choices: [{ delta }] })}\n\n`
}

function parseCompletionChunks(serialized) {
  return serialized
    .split('\n\n')
    .filter(frame => frame.startsWith('data: {'))
    .map(frame => JSON.parse(frame.slice('data: '.length)))
}

async function collectStreamingResult(deltas, includeDone = true) {
  const { QwenAiStreamHandler } = loadQwenAiModule()
  const upstream = new PassThrough()
  const handler = new QwenAiStreamHandler('test-model')
  const output = await handler.handleStream(upstream, {
    responseTimeoutMs: 1_000,
    idleTimeoutMs: 1_000,
  })
  const chunks = []
  output.on('data', chunk => chunks.push(chunk))
  const ended = once(output, 'end')
  upstream.end(`${deltas.map(event).join('')}${includeDone ? 'data: [DONE]\n\n' : ''}`)
  await ended
  return parseCompletionChunks(Buffer.concat(chunks).toString())
}

test('Qwen AI image extractor accepts official image_list/tool_result shapes and raster base64', () => {
  const { extractQwenAiGeneratedImages } = loadQwenAiModule()
  const firstUrl = 'https://cdn.example.test/generated/a.png?token=abc'
  const secondUrl = 'https://cdn.example.test/generated/no-extension?id=2'
  const images = extractQwenAiGeneratedImages({
    image_list: [
      { image: firstUrl },
      { image: firstUrl },
      { image: 'javascript:alert(1)' },
      null,
    ],
    tool_result: JSON.stringify({
      results: [
        { image_url: { url: secondUrl } },
        { b64_json: ONE_PIXEL_PNG },
      ],
      internal_log: 'provider tool trace must stay private',
    }),
  })

  assert.equal(images.length, 3)
  assert.deepEqual(images.slice(0, 2).map(image => image.image_url.url), [firstUrl, secondUrl])
  assert.equal(images[2].image_url.url, `data:image/png;base64,${ONE_PIXEL_PNG}`)
  assert.ok(images.every(image => image.source === 'qwen-ai'))
})

test('Qwen AI image extractor bounds malformed and duplicate tool-result input', () => {
  const { extractQwenAiGeneratedImages } = loadQwenAiModule()
  const url = 'https://cdn.example.test/generated/b.webp'
  const startedAt = performance.now()
  const images = extractQwenAiGeneratedImages({
    image_list: Array.from({ length: 20_000 }, () => ({ image: url })),
    tool_result: '{malformed-json-with-private-noise',
  })

  assert.deepEqual(images.map(image => image.image_url.url), [url])
  assert.ok(performance.now() - startedAt < 1_000)
})

test('Qwen AI image extractor rejects generic tool URLs, malformed padding, and oversized inline data', () => {
  const { extractQwenAiGeneratedImages } = loadQwenAiModule()
  assert.deepEqual(extractQwenAiGeneratedImages({
    tool_result: [{ url: 'https://example.test/article' }],
  }), [])
  assert.deepEqual(extractQwenAiGeneratedImages({
    image_list: [{ image: `data:image/png;base64,${ONE_PIXEL_PNG}===` }],
  }), [])

  const oversized = `${ONE_PIXEL_PNG.slice(0, 32)}${'A'.repeat(16 * 1024 * 1024)}`
  assert.deepEqual(extractQwenAiGeneratedImages({
    image_list: [{ image: oversized }],
  }), [])
})

test('Qwen AI stream emits mixed text and de-duplicated image metadata as Chat Completions', async () => {
  const firstUrl = 'https://cdn.example.test/generated/one.png?sig=1'
  const secondUrl = 'https://cdn.example.test/generated/two.jpg?sig=2'
  const chunks = await collectStreamingResult([
    { phase: 'answer', status: 'typing', content: 'Generated files:' },
    {
      phase: 'image_gen_tool',
      status: 'typing',
      content: '',
      extra: { image_list: [{ image: firstUrl }, { image: firstUrl }] },
    },
    {
      phase: 'image_gen_tool',
      status: 'finished',
      content: '',
      extra: {
        image_list: [{ image: firstUrl }],
        tool_result: [{ image: secondUrl }, { image: 'not-an-image' }],
      },
    },
  ])
  const deltas = chunks.map(chunk => chunk.choices[0].delta)
  const visibleContent = deltas.map(delta => delta.content || '').join('')
  const imageDeltas = deltas.filter(delta => Array.isArray(delta.images))

  assert.match(visibleContent, /^Generated files:/)
  assert.match(visibleContent, /!\[Generated image 1\]/)
  assert.match(visibleContent, /!\[Generated image 2\]/)
  assert.equal(imageDeltas.length, 2)
  assert.deepEqual(
    imageDeltas.flatMap(delta => delta.images.map(image => image.image_url.url)),
    [firstUrl, secondUrl],
  )
  assert.doesNotMatch(JSON.stringify(chunks), /not-an-image|tool_result|private/)
  assert.equal(chunks.at(-1).choices[0].finish_reason, 'stop')
})

test('Qwen AI pure-image stream is usable without an answer phase or DONE marker', async () => {
  const url = 'https://cdn.example.test/generated/pure.png'
  const chunks = await collectStreamingResult([{
    phase: 'image_gen_tool',
    status: 'finished',
    content: '',
    extra: { tool_result: [{ image: url }] },
  }], false)
  const deltas = chunks.map(chunk => chunk.choices[0].delta)

  assert.match(deltas.map(delta => delta.content || '').join(''), /Generated image 1/)
  assert.deepEqual(deltas.find(delta => delta.images)?.images, [{
    type: 'image_url',
    image_url: { url },
    source: 'qwen-ai',
  }])
  assert.equal(chunks.at(-1).choices[0].finish_reason, 'stop')
})

test('Qwen AI cumulative finished image frame completes after the image was emitted earlier', async () => {
  const url = 'https://cdn.example.test/generated/cumulative.png'
  const chunks = await collectStreamingResult([
    {
      phase: 'image_gen_tool',
      status: 'typing',
      content: '',
      extra: { image_list: [{ image: url }] },
    },
    {
      phase: 'image_gen_tool',
      status: 'finished',
      content: '',
      extra: { image_list: [{ image: url }] },
    },
  ], false)

  assert.equal(chunks.filter(chunk => Array.isArray(chunk.choices[0].delta.images)).length, 1)
  assert.equal(chunks.at(-1).choices[0].finish_reason, 'stop')
})

test('Qwen AI ignores image-shaped data outside the image generation phase', async () => {
  const chunks = await collectStreamingResult([
    {
      phase: 'web_search',
      status: 'finished',
      content: '',
      extra: { tool_result: [{ image: 'https://example.test/article' }] },
    },
    { phase: 'answer', status: 'finished', content: 'Search complete.' },
  ], false)
  const serialized = JSON.stringify(chunks)

  assert.doesNotMatch(serialized, /Generated image|"images"|example\.test\/article/)
  assert.match(serialized, /Search complete/)
})

test('Qwen AI non-stream pure-image output includes Markdown and structured metadata', async () => {
  const { QwenAiStreamHandler } = loadQwenAiModule()
  const upstream = new PassThrough()
  const handler = new QwenAiStreamHandler('test-model')
  const resultPromise = handler.handleNonStream(upstream, {
    responseTimeoutMs: 1_000,
    idleTimeoutMs: 1_000,
  })
  upstream.end(event({
    phase: 'image_gen_tool',
    status: 'finished',
    content: '',
    extra: {
      tool_result: JSON.stringify([{ image: `data:image/png;base64,${ONE_PIXEL_PNG}` }]),
    },
  }))

  const result = await resultPromise
  const message = result.choices[0].message
  assert.match(message.content, /^!\[Generated image 1\]/)
  assert.equal(message.images.length, 1)
  assert.equal(message.images[0].image_url.url, `data:image/png;base64,${ONE_PIXEL_PNG}`)
  assert.doesNotMatch(JSON.stringify(message), /tool_result/)
})

test('Qwen AI non-stream cumulative finished image frame resolves successfully', async () => {
  const { QwenAiStreamHandler } = loadQwenAiModule()
  const upstream = new PassThrough()
  const handler = new QwenAiStreamHandler('test-model')
  const resultPromise = handler.handleNonStream(upstream, {
    responseTimeoutMs: 1_000,
    idleTimeoutMs: 1_000,
  })
  const url = 'https://cdn.example.test/generated/nonstream-cumulative.png'
  upstream.end([
    event({
      phase: 'image_gen_tool',
      status: 'typing',
      content: '',
      extra: { image_list: [{ image: url }] },
    }),
    event({
      phase: 'image_gen_tool',
      status: 'finished',
      content: '',
      extra: { image_list: [{ image: url }] },
    }),
  ].join(''))

  const result = await resultPromise
  assert.equal(result.choices[0].message.images.length, 1)
  assert.match(result.choices[0].message.content, /Generated image 1/)
})

async function captureQwenPayload(image_generation) {
  const { QwenAiAdapter } = loadQwenAiModule()
  const adapter = new QwenAiAdapter(
    { id: 'qwen-ai', apiEndpoint: 'https://chat.qwen.ai' },
    { id: 'account-1', credentials: { token: 'test-token' } },
  )
  const requests = []
  adapter.postWithRefreshRetry = async (url, payload) => {
    requests.push({ url, payload })
    if (url.endsWith('/api/v2/chats/new')) {
      return { status: 200, data: { data: { id: 'chat-1' } }, headers: {} }
    }
    return {
      status: 200,
      data: new PassThrough(),
      headers: { 'content-type': 'text/event-stream' },
    }
  }
  adapter.assertChatCompletionStreamResponse = async () => {}

  await adapter.chatCompletion({
    model: 'qwen3.8-max-preview',
    messages: [{ role: 'user', content: 'draw a lighthouse' }],
    ...(image_generation ? { image_generation } : {}),
  })
  return requests.map(request => (
    typeof request.payload === 'string' ? JSON.parse(request.payload) : request.payload
  ))
}

test('Qwen AI explicit image_generation switches create-chat and message payloads to t2i', async () => {
  const [createPayload, completionPayload] = await captureQwenPayload({
    enabled: true,
    size: '1536x1024',
  })
  const message = completionPayload.messages[0]

  assert.equal(createPayload.chat_type, 't2i')
  assert.equal(message.chat_type, 't2i')
  assert.equal(message.sub_chat_type, 't2i')
  assert.deepEqual(message.extra.meta, {
    subChatType: 't2i',
    size: '4:3',
    model: 'qwen-image-2.0-pro',
  })
  assert.equal(completionPayload.size, '4:3')
})

test('Qwen AI ordinary Chat Completions retain t2t without image-generation metadata', async () => {
  const [createPayload, completionPayload] = await captureQwenPayload(undefined)
  const message = completionPayload.messages[0]

  assert.equal(createPayload.chat_type, 't2t')
  assert.equal(message.chat_type, 't2t')
  assert.equal(message.sub_chat_type, 't2t')
  assert.deepEqual(message.extra.meta, { subChatType: 't2t' })
  assert.equal(Object.prototype.hasOwnProperty.call(completionPayload, 'size'), false)
})

test('Qwen AI forwarder preserves the internal Responses image-generation hint', () => {
  const source = fs.readFileSync('src/main/proxy/forwarder.ts', 'utf8')
  assert.match(source, /if \(intent !== 'context_compaction'\) return request/)
  assert.match(source, /image_generation:\s*providerRequest\.image_generation/)
})
