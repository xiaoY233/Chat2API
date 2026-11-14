import test from 'node:test'
import assert from 'node:assert/strict'

import {
  buildQwenAiMediaPayload,
  buildQwenMediaContent,
  extractMediaPrompt,
  extractQwenMediaTaskId,
  extractQwenMediaUrl,
  parseQwenAiMediaResponse,
  qwenAiMediaKind,
} from '../../src/main/proxy/adapters/qwen-ai-media.ts'
import { buildTtsMessages, MimoAdapter } from '../../src/main/proxy/adapters/mimo.ts'
import { mimoConfig } from '../../src/main/providers/builtin/mimo.ts'

test('Qwen AI media models are classified as image or video', () => {
  assert.equal(qwenAiMediaKind('qwen-image-3.0'), 'image')
  assert.equal(qwenAiMediaKind('Qwen-Image-3.0'), 'image')
  assert.equal(qwenAiMediaKind('wan3.0-video'), 'video')
  assert.equal(qwenAiMediaKind('qwen3.8-max'), null)
  assert.equal(qwenAiMediaKind(undefined), null)
})

test('Qwen AI image payload uses t2i chat and generation model metadata', () => {
  const payload = buildQwenAiMediaPayload({
    chatId: 'chat-1',
    prompt: 'a red fox',
    kind: 'image',
    size: '1024x1024',
    generationModel: 'qwen-image-3.0',
    fid: 'fid-1',
    childId: 'child-1',
    timestamp: 123,
  })

  assert.equal(payload.chat_type, undefined)
  assert.equal(payload.model, 'qwen3.8-max')
  assert.equal(payload.chat_id, 'chat-1')
  assert.equal(payload.stream, true)
  assert.equal(payload.size, '1024x1024')

  const message = (payload.messages as any[])[0]
  assert.equal(message.chat_type, 't2i')
  assert.equal(message.sub_chat_type, 't2i')
  assert.equal(message.content, 'a red fox')
  assert.deepEqual(message.extra.meta, {
    subChatType: 't2i',
    size: '1024x1024',
    model: 'qwen-image-3.0',
  })
})

test('Qwen AI video payload uses t2v chat and non-streaming submission', () => {
  const payload = buildQwenAiMediaPayload({
    chatId: 'chat-2',
    prompt: 'waves at sunset',
    kind: 'video',
    size: '16:9',
    generationModel: 'wan3.0-video',
    timestamp: 456,
  })

  assert.equal(payload.stream, false)
  assert.equal(payload.size, '16:9')
  const message = (payload.messages as any[])[0]
  assert.equal(message.chat_type, 't2v')
  assert.deepEqual(message.extra.meta, {
    subChatType: 't2v',
    size: '16:9',
    model: 'wan3.0-video',
  })
})

test('Qwen AI media SSE parsing extracts image URL and dimensions', () => {
  const raw = [
    'data: {"choices":[{"delta":{"phase":"answer","content":"Here it is ![img](https://cdn.qwen.ai/out/abc.png)"}}]}',
    'data: {"choices":[{"delta":{"content":""}}],"usage":{"width":1024,"height":1024}}',
    'data: [DONE]',
  ].join('\n\n')

  const parsed = parseQwenAiMediaResponse(raw, 'image')
  assert.equal(parsed.url, 'https://cdn.qwen.ai/out/abc.png')
  assert.equal(parsed.width, 1024)
  assert.equal(parsed.height, 1024)
})

test('Qwen AI video response parsing extracts task id and downstream status URL', () => {
  const raw = JSON.stringify({
    data: {
      messages: [
        {
          extra: {
            wanx: { task_id: 'task-abc' },
          },
        },
      ],
    },
  })

  const parsed = parseQwenAiMediaResponse(raw, 'video')
  assert.equal(parsed.taskId, 'task-abc')
  assert.equal(extractQwenMediaTaskId(JSON.parse(raw)), 'task-abc')
  assert.equal(
    extractQwenMediaUrl({ data: { video_url: 'https://cdn.qwen.ai/video/out.mp4' } }, 'video'),
    'https://cdn.qwen.ai/video/out.mp4'
  )
})

test('Qwen AI media content and prompt helpers', () => {
  assert.equal(
    buildQwenMediaContent('image', 'https://x/y.png'),
    '![Generated image](https://x/y.png)'
  )
  assert.equal(
    buildQwenMediaContent('video', 'https://x/y.mp4'),
    '[Generated video](https://x/y.mp4)'
  )
  assert.equal(
    extractMediaPrompt([
      { role: 'system', content: 'ignore' },
      { role: 'user', content: 'draw a cat' },
    ]),
    'draw a cat'
  )
})

test('MiMo TTS models are detected and require an API key credential field', () => {
  assert.equal(MimoAdapter.isTtsModel('mimo-v2.5-tts'), true)
  assert.equal(MimoAdapter.isTtsModel('MiMo-V2.5-TTS-VoiceDesign'), true)
  assert.equal(MimoAdapter.isTtsModel('mimo-v2.6-pro'), false)

  assert.ok(
    mimoConfig.credentialFields.some((field) => field.name === 'api_key' && field.required === false)
  )
})

test('MiMo TTS messages put the target text in an assistant message', () => {
  assert.deepEqual(
    buildTtsMessages([{ role: 'user', content: 'Hello there' }] as any),
    [{ role: 'assistant', content: 'Hello there' }]
  )

  assert.deepEqual(
    buildTtsMessages([
      { role: 'user', content: 'Speak warmly' },
      { role: 'user', content: 'Hello there' },
    ] as any),
    [
      { role: 'user', content: 'Speak warmly' },
      { role: 'assistant', content: 'Hello there' },
    ]
  )

  const explicit = [
    { role: 'user', content: 'Speak warmly' },
    { role: 'assistant', content: 'Hello there' },
  ]
  assert.deepEqual(buildTtsMessages(explicit as any), explicit)

  assert.throws(() => buildTtsMessages([] as any), /text to synthesize/)
})
