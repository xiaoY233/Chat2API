import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import OSS from 'ali-oss'

import {
  prepareQwenAiMultimodalMessage,
  QwenAiFileUploader,
} from '../../src/main/proxy/adapters/qwen-ai-files.ts'
import { createManagedToolPromptMessage } from '../../src/main/proxy/toolCalling/managedPromptMetadata.ts'
import {
  decodeXml,
  parseJsonValue,
} from '../../src/main/proxy/toolCalling/protocols/shared.ts'

function assistantToolCall(id: string, name: string, round: number) {
  return {
    role: 'assistant' as const,
    content: null,
    tool_calls: [
      {
        id,
        type: 'function' as const,
        function: {
          name,
          arguments: JSON.stringify({ round }),
        },
      },
    ],
  }
}

function toolResult(toolCallId: string, round: number) {
  return {
    role: 'tool' as const,
    tool_call_id: toolCallId,
    content: `result-${round}`,
  }
}

type HermesCallMatch = {
  index: number
  raw: string
  name: string
  arguments: Record<string, unknown>
}

type HermesResponseMatch = {
  index: number
  raw: string
  content: string
}

function hermesCallMatches(content: string): HermesCallMatch[] {
  return [...content.matchAll(/<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/g)].map((match) => {
    const body = match[1].trim()
    if (body.startsWith('{')) {
      const envelope = JSON.parse(body) as {
        name: string
        arguments: Record<string, unknown>
      }
      return {
        index: match.index,
        raw: match[0],
        name: envelope.name,
        arguments: envelope.arguments,
      }
    }

    const functionMatch = /^<function=([^>]+)>\s*([\s\S]*?)\s*<\/function>$/.exec(body)
    assert.ok(functionMatch, `Expected a canonical Qwen function block, received: ${body.slice(0, 120)}`)
    const args: Record<string, unknown> = {}
    for (const parameter of functionMatch[2].matchAll(
      /<parameter=([^>]+)>\s*([\s\S]*?)\s*<\/parameter>/g,
    )) {
      args[decodeXml(parameter[1].trim())] = parseJsonValue(parameter[2])
    }
    return {
      index: match.index,
      raw: match[0],
      name: decodeXml(functionMatch[1].trim()),
      arguments: args,
    }
  })
}

function hermesResponseMatches(content: string): HermesResponseMatch[] {
  return [...content.matchAll(/<tool_response>\n([\s\S]*?)\n<\/tool_response>/g)].map((match) => ({
    index: match.index,
    raw: match[0],
    content: match[1],
  }))
}

test('Qwen AI history preserves repeated Hermes call and result ordering', async () => {
  const messages = [
    { role: 'user' as const, content: 'request-1' },
    assistantToolCall('call_0', 'first_tool', 1),
    toolResult('call_0', 1),
    { role: 'user' as const, content: 'request-2' },
    assistantToolCall('call_0', 'second_tool', 2),
    toolResult('call_0', 2),
    { role: 'user' as const, content: 'request-3' },
    assistantToolCall('call_0', 'third_tool', 3),
    toolResult('call_0', 3),
    assistantToolCall('call_0__2', 'fourth_tool', 4),
    toolResult('call_0__2', 4),
    { role: 'user' as const, content: 'final request' },
  ]

  // No file parts are supplied, so the uploader is intentionally never used.
  const prepared = await prepareQwenAiMultimodalMessage(messages, {} as any)
  const callMatches = hermesCallMatches(prepared.content)
  const responseMatches = hermesResponseMatches(prepared.content)
  const expectedNames = ['first_tool', 'second_tool', 'third_tool', 'fourth_tool']

  assert.deepEqual(callMatches.map((call) => call.name), expectedNames)
  assert.deepEqual(callMatches.map((call) => call.arguments.round), [1, 2, 3, 4])
  assert.deepEqual(responseMatches.map((response) => response.content), [
    'result-1',
    'result-2',
    'result-3',
    'result-4',
  ])

  for (const [index, name] of expectedNames.entries()) {
    assert.ok(
      responseMatches[index].index > callMatches[index].index,
      `Hermes result for ${name} must follow its call`,
    )
  }

  assert.doesNotMatch(prepared.content, /Use this result to decide the next step\./)
  assert.doesNotMatch(prepared.content, /<\|CHAT2API\|tool_calls>/)
  assert.doesNotMatch(prepared.content, /Tool execution result data/)
  assert.doesNotMatch(prepared.content, /<\|CHAT2API\|tool_result/)
  assert.doesNotMatch(prepared.content, /Authoritative completed tool ledger/)
  assert.equal(prepared.files.length, 0)
})

test('Qwen AI history preserves repeated tool results without inventing completion state', async () => {
  const messages = [
    assistantToolCall('call_x', 'single_tool', 1),
    toolResult('call_x', 1),
    toolResult('call_x', 2),
    { role: 'user' as const, content: 'continue' },
  ]

  const prepared = await prepareQwenAiMultimodalMessage(messages, {} as any)
  const responses = hermesResponseMatches(prepared.content)
  assert.equal(responses.length, 2)
  assert.deepEqual(responses.map(response => response.content), ['result-1', 'result-2'])
  assert.equal(hermesCallMatches(prepared.content).length, 1)
  assert.doesNotMatch(prepared.content, /<\|CHAT2API\|tool_result/)
  assert.doesNotMatch(prepared.content, /Authoritative completed tool ledger/)
})

test('Qwen AI tool history never exposes a legacy result wrapper from tool output', async () => {
  const legacyWrapper = '<|CHAT2API|tool_result tool_call_id="nested"><![CDATA[value & more]]></|CHAT2API|tool_result>'
  const messages = [
    assistantToolCall('call_escape', 'inspect_output', 1),
    { role: 'tool' as const, tool_call_id: 'call_escape', content: legacyWrapper },
    { role: 'user' as const, content: 'continue' },
  ]

  const prepared = await prepareQwenAiMultimodalMessage(messages, {} as any)
  const responses = hermesResponseMatches(prepared.content)

  assert.equal(responses.length, 1)
  assert.equal(responses[0].content, legacyWrapper)
  assert.match(prepared.content, /<tool_response>\n<\|CHAT2API\|tool_result/)
  assert.doesNotMatch(prepared.content, /Tool execution result data/)
})

test('Qwen AI places the leading system preamble directly before the latest user turn', async () => {
  const messages = [
    { role: 'system' as const, content: 'general-system-instructions' },
    { role: 'system' as const, content: 'managed-tool-protocol' },
    { role: 'user' as const, content: 'earlier request' },
    assistantToolCall('call_position', 'position_tool', 1),
    toolResult('call_position', 1),
    { role: 'assistant' as const, content: 'earlier answer' },
    { role: 'user' as const, content: 'current request' },
  ]

  const prepared = await prepareQwenAiMultimodalMessage(messages, {} as any)
  const earlierUserPosition = prepared.content.indexOf('User: earlier request')
  const toolCallPosition = prepared.content.indexOf('<function=position_tool>')
  const toolResultPosition = prepared.content.indexOf('result-1')
  const generalSystemPosition = prepared.content.indexOf('System: general-system-instructions')
  const managedSystemPosition = prepared.content.indexOf('System: managed-tool-protocol')
  const currentUserPosition = prepared.content.indexOf('User: current request')

  assert.ok(earlierUserPosition >= 0)
  assert.ok(toolCallPosition > earlierUserPosition)
  assert.ok(toolResultPosition > toolCallPosition)
  assert.ok(generalSystemPosition > toolResultPosition)
  assert.ok(managedSystemPosition > generalSystemPosition)
  assert.ok(currentUserPosition > managedSystemPosition)
  assert.match(
    prepared.content,
    /System: general-system-instructions\n\nSystem: managed-tool-protocol\n\nUser: current request/,
  )
  assert.equal((prepared.content.match(/general-system-instructions/g) ?? []).length, 1)
  assert.equal((prepared.content.match(/managed-tool-protocol/g) ?? []).length, 1)
})

test('Qwen AI keeps the leading system preamble in place when no user turn exists', async () => {
  const messages = [
    { role: 'system' as const, content: 'system-without-user' },
    { role: 'assistant' as const, content: 'assistant-only history' },
  ]

  const prepared = await prepareQwenAiMultimodalMessage(messages, {} as any)

  assert.ok(prepared.content.indexOf('System: system-without-user') >= 0)
  assert.ok(
    prepared.content.indexOf('Assistant: assistant-only history')
      > prepared.content.indexOf('System: system-without-user'),
  )
})

test('Qwen AI places the existing system preamble after a trailing tool result', async () => {
  const messages = [
    { role: 'system' as const, content: 'general-system-instructions' },
    { role: 'system' as const, content: 'managed-tool-protocol' },
    { role: 'user' as const, content: 'complete the workflow' },
    {
      role: 'assistant' as const,
      content: null,
      tool_calls: [
        {
          id: 'call_trailing_a',
          type: 'function' as const,
          function: { name: 'workspace:inspect-a', arguments: '{"round":1}' },
        },
        {
          id: 'call_trailing_b',
          type: 'function' as const,
          function: { name: 'workspace:inspect-b', arguments: '{"round":2}' },
        },
      ],
    },
    toolResult('call_trailing_a', 1),
    toolResult('call_trailing_b', 2),
  ]

  const prepared = await prepareQwenAiMultimodalMessage(messages, {} as any)
  const userPosition = prepared.content.indexOf('User: complete the workflow')
  const firstToolCallPosition = prepared.content.indexOf('<function=workspace:inspect-a>')
  const secondToolCallPosition = prepared.content.indexOf('<function=workspace:inspect-b>')
  const firstToolResultPosition = prepared.content.indexOf('result-1')
  const secondToolResultPosition = prepared.content.indexOf('result-2')
  const generalSystemPosition = prepared.content.indexOf('System: general-system-instructions')
  const managedSystemPosition = prepared.content.indexOf('System: managed-tool-protocol')

  assert.ok(userPosition >= 0)
  assert.ok(firstToolCallPosition > userPosition)
  assert.ok(secondToolCallPosition > firstToolCallPosition)
  assert.ok(firstToolResultPosition > secondToolCallPosition)
  assert.ok(secondToolResultPosition > firstToolResultPosition)
  assert.ok(generalSystemPosition > secondToolResultPosition)
  assert.ok(managedSystemPosition > generalSystemPosition)
  assert.equal((prepared.content.match(/general-system-instructions/g) ?? []).length, 1)
  assert.equal((prepared.content.match(/managed-tool-protocol/g) ?? []).length, 1)
  assert.doesNotMatch(prepared.content, /Continue the original request using the tool result above/)
})

test('Qwen AI keeps a generic continuation after the latest tool result', async () => {
  const messages = [
    { role: 'system' as const, content: 'tool protocol and task instructions' },
    { role: 'user' as const, content: 'Create the requested artifact.' },
    assistantToolCall('call_next', 'workspace:inspect', 1),
    toolResult('call_next', 1),
    {
      role: 'user' as const,
      content: 'Continue the original request using the tool result above. If any requested operation remains, emit the next tool call immediately. Only provide a final answer after the results have been verified by tool output.',
    },
  ]

  const prepared = await prepareQwenAiMultimodalMessage(messages, {} as any)
  const resultPosition = prepared.content.indexOf('result-1')
  const continuationPosition = prepared.content.indexOf('Continue the original request using the tool result above.')
  const systemPosition = prepared.content.indexOf('System: tool protocol and task instructions')

  assert.ok(resultPosition >= 0)
  assert.ok(continuationPosition > resultPosition)
  assert.ok(systemPosition > resultPosition)
  assert.ok(systemPosition < continuationPosition)
  assert.match(prepared.content, /Only provide a final answer after the results have been verified by tool output\./)
})

test('Qwen AI preserves a transcript larger than 512 KiB without modifying caller history', async () => {
  const firstMessage = `first-message-start ${'a'.repeat(180_000)} first-message-end`
  const middleMessage = `middle-message-start ${'b'.repeat(180_000)} middle-message-end`
  const latestMessage = `latest-message-start ${'c'.repeat(180_000)} latest-message-end`
  const longToolArgument = `argument-start ${'d'.repeat(120_000)} argument-end`
  const longToolResult = `result-start ${'e'.repeat(120_000)} result-end`
  const messages = [
    { role: 'user' as const, content: firstMessage },
    { role: 'assistant' as const, content: middleMessage },
    { role: 'user' as const, content: 'Run the large declared operation.' },
    {
      role: 'assistant' as const,
      content: null,
      tool_calls: [{
        id: 'large-history-call',
        type: 'function' as const,
        function: {
          name: 'large_history_tool',
          arguments: JSON.stringify({ payload: longToolArgument }),
        },
      }],
    },
    { role: 'tool' as const, tool_call_id: 'large-history-call', content: longToolResult },
    { role: 'user' as const, content: latestMessage },
  ]
  const snapshot = JSON.parse(JSON.stringify(messages))

  assert.ok(Buffer.byteLength(JSON.stringify(messages), 'utf8') > 512 * 1024)

  const prepared = await prepareQwenAiMultimodalMessage(messages, {} as any)

  assert.ok(prepared.content.includes(`User: ${firstMessage}`))
  assert.ok(prepared.content.includes(`Assistant: ${middleMessage}`))
  assert.ok(prepared.content.includes(`User: ${latestMessage}`))

  const calls = hermesCallMatches(prepared.content)
  assert.equal(calls.length, 1)
  assert.equal(calls[0].name, 'large_history_tool')
  assert.equal(calls[0].arguments.payload, longToolArgument)

  const responses = hermesResponseMatches(prepared.content)
  assert.equal(responses.length, 1)
  assert.equal(responses[0].content, longToolResult)
  assert.doesNotMatch(prepared.content, /<\|CHAT2API\|tool_result/)

  assert.doesNotMatch(prepared.content, /Earlier conversation omitted|\[\.\.\. truncated \.\.\.\]/)
  assert.deepEqual(messages, snapshot, 'transcript preparation must not mutate caller messages')
})

test('Qwen AI uploads every unique attachment once without mutating content', async () => {
  const parts = [
    { type: 'image_url' as const, image_url: { url: 'https://example.test/repeated.png' } },
    { type: 'image_url' as const, image_url: { url: 'https://example.test/repeated.png' } },
    ...Array.from({ length: 35 }, (_, index) => ({
      type: 'image_url' as const,
      image_url: { url: `https://example.test/image-${index}.png` },
    })),
  ]
  const messages = [{ role: 'user' as const, content: parts }]
  const snapshot = JSON.parse(JSON.stringify(messages))
  const uploadedSources: string[] = []
  const uploader = {
    uploadPart: async (part: any) => {
      uploadedSources.push(part.image_url.url)
      return { file: { id: part.image_url.url } }
    },
  }

  const prepared = await prepareQwenAiMultimodalMessage(messages, uploader as any)

  assert.deepEqual(messages, snapshot, 'attachment preparation must not mutate caller messages')
  assert.equal(uploadedSources.length, 36)
  assert.equal(new Set(uploadedSources).size, 36)
  assert.equal(
    uploadedSources.filter(source => source === 'https://example.test/repeated.png').length,
    1,
  )
  assert.deepEqual(uploadedSources, [
    'https://example.test/repeated.png',
    ...Array.from({ length: 35 }, (_, index) => `https://example.test/image-${index}.png`),
  ])
  assert.equal(prepared.files.length, 36)
})

test('Qwen AI preserves all multimodal text while uploading attachment bytes separately', async () => {
  const systemInstruction = 'system-sentinel-4f9c2d'
  const activeText = 'active-user-sentinel-a81e37'
  const earlierUserText = `earlier-user-sentinel ${'x'.repeat(5_000)}`
  const earlierAssistantText = `earlier-assistant-sentinel ${'y'.repeat(5_000)}`
  const imageDataUrl = `data:image/png;base64,${'A'.repeat(600_000)}`
  const messages = [
    { role: 'system' as const, content: systemInstruction },
    { role: 'user' as const, content: earlierUserText },
    { role: 'assistant' as const, content: earlierAssistantText },
    {
      role: 'user' as const,
      content: [
        { type: 'text' as const, text: activeText },
        { type: 'image_url' as const, image_url: { url: imageDataUrl } },
      ],
    },
  ]
  const snapshot = JSON.parse(JSON.stringify(messages))

  const uploadedSources: string[] = []
  const prepared = await prepareQwenAiMultimodalMessage(messages, {
    uploadPart: async (part: any) => {
      uploadedSources.push(part.image_url.url)
      return { file: { id: 'uploaded-image-sentinel' } }
    },
  } as any)

  assert.ok(prepared.content.includes(`System: ${systemInstruction}`))
  assert.ok(prepared.content.includes(earlierUserText))
  assert.ok(prepared.content.includes(earlierAssistantText))
  assert.ok(prepared.content.includes(activeText))
  assert.doesNotMatch(prepared.content, /data:image\/png;base64/)
  assert.deepEqual(uploadedSources, [imageDataUrl])
  assert.deepEqual(messages, snapshot, 'multimodal preparation must not mutate caller messages')
})

test('Qwen AI does not infer document transport from transcript byte size', async () => {
  const longText = `LARGE_INLINE_SENTINEL:${'x'.repeat(180_000)}:LARGE_INLINE_END`
  let uploads = 0
  const prepared = await prepareQwenAiMultimodalMessage(
    [{ role: 'user' as const, content: longText }],
    {
      uploadPart: async () => {
        uploads += 1
        return { file: { id: 'unexpected-upload' } }
      },
    } as any,
  )

  assert.equal(prepared.transport, 'inline')
  assert.equal(uploads, 0)
  assert.ok(prepared.content.includes(longText))
})

test('Qwen AI preserves all audio-turn text while uploading audio bytes separately', async () => {
  const systemInstruction = 'system-sentinel-73bd10'
  const activeText = 'active-user-sentinel-c6205a'
  const earlierUserText = `earlier-user-sentinel ${'x'.repeat(5_000)}`
  const earlierAssistantText = `earlier-assistant-sentinel ${'y'.repeat(5_000)}`
  const audioData = 'B'.repeat(600_000)
  const messages = [
    { role: 'system' as const, content: systemInstruction },
    { role: 'user' as const, content: earlierUserText },
    { role: 'assistant' as const, content: earlierAssistantText },
    {
      role: 'user' as const,
      content: [
        { type: 'text' as const, text: activeText },
        { type: 'input_audio' as const, input_audio: { data: audioData, format: 'wav' } },
      ],
    },
  ]
  const snapshot = JSON.parse(JSON.stringify(messages))

  const uploadedSources: string[] = []
  const prepared = await prepareQwenAiMultimodalMessage(messages, {
    uploadPart: async (part: any) => {
      uploadedSources.push(part.input_audio.data)
      return { file: { id: 'uploaded-audio-sentinel' } }
    },
  } as any)

  assert.ok(prepared.content.includes(`System: ${systemInstruction}`))
  assert.ok(prepared.content.includes(earlierUserText))
  assert.ok(prepared.content.includes(earlierAssistantText))
  assert.ok(prepared.content.includes(activeText))
  assert.ok(!prepared.content.includes(audioData))
  assert.deepEqual(uploadedSources, [audioData])
  assert.deepEqual(messages, snapshot, 'audio preparation must not mutate caller messages')
})

test('Qwen AI keeps Anthropic-style user tool_result blocks in the active turn', async () => {
  const messages = [
    { role: 'user' as const, content: 'Run the declared operation.' },
    assistantToolCall('nested-call', 'declared_tool', 1),
    {
      role: 'user' as const,
      content: [{
        type: 'tool_result',
        tool_use_id: 'nested-call',
        is_error: true,
        content: [{ type: 'text', text: 'nested failure' }],
      }],
    } as any,
    { role: 'user' as const, content: 'Retry after the failure.' },
  ]

  const prepared = await prepareQwenAiMultimodalMessage(messages, {} as any)
  const invokePosition = prepared.content.indexOf('<function=declared_tool>')
  const resultPosition = prepared.content.indexOf('nested failure')
  const responses = hermesResponseMatches(prepared.content)

  assert.ok(invokePosition >= 0)
  assert.ok(resultPosition > invokePosition)
  assert.deepEqual(responses.map(response => response.content), ['nested failure'])
  assert.doesNotMatch(prepared.content, /<\|CHAT2API\|tool_result/)
})

test('Qwen AI document transport uploads the complete converted transcript and keeps original attachments', async () => {
  const longHistory = `long-history-start:${'x'.repeat(160_000)}:long-history-end`
  const originalAttachmentUrl = 'data:text/plain;base64,b3JpZ2luYWwtYXR0YWNobWVudA=='
  const messages = [
    {
      role: 'system' as const,
      content: 'SYSTEM_SENTINEL\nTOOL_SCHEMA_SENTINEL: declared_dynamic_tool(input: string)',
    },
    { role: 'user' as const, content: longHistory },
    assistantToolCall('document-call', 'declared_dynamic_tool', 7),
    {
      role: 'tool' as const,
      tool_call_id: 'document-call',
      content: 'TOOL_RESULT_SENTINEL',
    },
    {
      role: 'user' as const,
      content: [
        { type: 'text' as const, text: 'FINAL_PENDING_TASK_SENTINEL' },
        {
          type: 'file' as const,
          filename: 'original.txt',
          mime_type: 'text/plain',
          file_url: { url: originalAttachmentUrl },
        },
      ],
    },
  ]
  const snapshot = structuredClone(messages)
  const uploads: Array<{
    part: any
    evidenceQueryText: string
    options: { includeEvidence?: boolean }
  }> = []
  const prepared = await prepareQwenAiMultimodalMessage(messages, {
    uploadPart: async (part: any, evidenceQueryText: string, options: { includeEvidence?: boolean }) => {
      uploads.push({ part, evidenceQueryText, options })
      return { file: { id: `uploaded-${uploads.length}`, filename: part.filename } }
    },
  } as any, { transport: 'document' })

  assert.equal(uploads.length, 2, 'the original attachment and generated transcript must both be uploaded')
  assert.equal(uploads[0].part.file_url.url, originalAttachmentUrl)
  assert.match(uploads[1].part.filename, /^chat2api-conversation-[a-f0-9]{16}\.txt$/)
  assert.ok(uploads.every(upload => upload.options.includeEvidence === false))
  assert.ok(uploads.every(upload => upload.evidenceQueryText === prepared.content))

  const transcriptUrl = uploads[1].part.file_url.url as string
  const transcript = Buffer.from(transcriptUrl.split(',', 2)[1], 'base64').toString('utf8')
  assert.match(transcript, /SYSTEM_SENTINEL/)
  assert.match(transcript, /TOOL_SCHEMA_SENTINEL/)
  assert.ok(transcript.includes(longHistory), 'the large history must be byte-for-byte present')
  assert.match(transcript, /<function=declared_dynamic_tool>/)
  assert.match(transcript, /TOOL_RESULT_SENTINEL/)
  assert.match(transcript, /FINAL_PENDING_TASK_SENTINEL/)
  assert.doesNotMatch(transcript, /Earlier conversation omitted|\[\.\.\. truncated \.\.\.\]/)

  assert.ok(prepared.content.length < 700, 'the inline prompt must remain a short attachment instruction')
  assert.match(prepared.content, /complete conversation transcript is attached/i)
  assert.doesNotMatch(prepared.content, /long-history-start|TOOL_RESULT_SENTINEL/)
  assert.equal(prepared.files.length, 2)
  assert.equal(prepared.transport, 'document')
  assert.ok(prepared.transcriptUtf8Bytes > prepared.inlineUtf8Bytes)
  assert.deepEqual(messages, snapshot, 'document transport must not mutate caller messages')
})

test('Qwen AI managed document transport keeps protocol and active tool exchange inline', async () => {
  const oldHistory = `OLD_HISTORY_START:${'x'.repeat(160_000)}:OLD_HISTORY_END`
  const messages = [
    {
      role: 'system' as const,
      content: 'ORDINARY_SYSTEM_CONTEXT_SENTINEL',
    },
    createManagedToolPromptMessage(
      'FULL_MANAGED_PROTOCOL_SENTINEL\n<tools>{"name":"declared_dynamic_tool","description":"FULL_TOOL_DESCRIPTION_SENTINEL"}</tools>',
      {
        content: 'COMPACT_MANAGED_PROTOCOL_SENTINEL\n<tools>{"name":"declared_dynamic_tool"}</tools>',
        referenceContent: 'FULL_TOOL_REFERENCE_SENTINEL\nFULL_TOOL_DESCRIPTION_SENTINEL',
      },
    ),
    { role: 'user' as const, content: oldHistory },
    { role: 'assistant' as const, content: 'Earlier work completed.' },
    { role: 'user' as const, content: 'ACTIVE_REQUEST_IN_DOCUMENT' },
    assistantToolCall('active-document-call', 'declared_dynamic_tool', 9),
    {
      role: 'tool' as const,
      tool_call_id: 'active-document-call',
      content: 'ACTIVE_TOOL_RESULT_SENTINEL',
    },
    { role: 'user' as const, content: 'ACTIVE_CONTINUATION_SENTINEL' },
  ]
  const snapshot = structuredClone(messages)
  const uploads: any[] = []

  const prepared = await prepareQwenAiMultimodalMessage(messages, {
    uploadPart: async (part: any, evidenceQueryText: string, options: { includeEvidence?: boolean }) => {
      uploads.push({ part, evidenceQueryText, options })
      return { file: { id: `uploaded-${uploads.length}`, filename: part.filename } }
    },
  } as any, {
    transport: 'document',
    managedToolCalling: true,
    workflowContinuation: true,
  })

  assert.equal(uploads.length, 2)
  const transcriptUpload = uploads.find(upload => /^chat2api-conversation-/.test(upload.part.filename))
  const toolReferenceUpload = uploads.find(upload => /^chat2api-tool-reference-/.test(upload.part.filename))
  assert.ok(transcriptUpload)
  assert.ok(toolReferenceUpload)
  const transcriptUrl = transcriptUpload.part.file_url.url as string
  const transcript = Buffer.from(transcriptUrl.split(',', 2)[1], 'base64').toString('utf8')
  const toolReferenceUrl = toolReferenceUpload.part.file_url.url as string
  const toolReference = Buffer.from(toolReferenceUrl.split(',', 2)[1], 'base64').toString('utf8')
  assert.match(transcript, /OLD_HISTORY_START/)
  assert.match(transcript, /ORDINARY_SYSTEM_CONTEXT_SENTINEL/)
  assert.doesNotMatch(
    transcript,
    /FULL_MANAGED_PROTOCOL_SENTINEL|COMPACT_MANAGED_PROTOCOL_SENTINEL|ACTIVE_REQUEST_IN_DOCUMENT|ACTIVE_TOOL_RESULT_SENTINEL|ACTIVE_CONTINUATION_SENTINEL/,
  )
  assert.match(toolReference, /FULL_TOOL_REFERENCE_SENTINEL/)
  assert.match(toolReference, /FULL_TOOL_DESCRIPTION_SENTINEL/)

  assert.match(prepared.content, /Conversation context is attached/i)
  assert.match(prepared.content, /Complete tool definitions are attached/i)
  assert.match(prepared.content, /COMPACT_MANAGED_PROTOCOL_SENTINEL/)
  assert.doesNotMatch(prepared.content, /FULL_MANAGED_PROTOCOL_SENTINEL|FULL_TOOL_DESCRIPTION_SENTINEL/)
  assert.match(prepared.content, /"name":"declared_dynamic_tool"/)
  assert.match(prepared.content, /ACTIVE_REQUEST_IN_DOCUMENT/)
  assert.match(prepared.content, /ACTIVE_TOOL_RESULT_SENTINEL/)
  assert.match(prepared.content, /ACTIVE_CONTINUATION_SENTINEL/)
  assert.doesNotMatch(
    prepared.content,
    /OLD_HISTORY_START|OLD_HISTORY_END|ORDINARY_SYSTEM_CONTEXT_SENTINEL/,
  )
  assert.equal(prepared.transport, 'document')
  assert.ok(prepared.inlineUtf8Bytes < prepared.transcriptUtf8Bytes)
  assert.deepEqual(messages, snapshot, 'managed document transport must not mutate caller messages')
})

test('Qwen AI moves an oversized active Claude tool workflow into the complete transcript document', async () => {
  const toolHistory = Array.from({ length: 94 }, (_, index) => [
    assistantToolCall(`active-call-${index}`, 'read_file', index),
    {
      role: 'tool' as const,
      tool_call_id: `active-call-${index}`,
      content: `ACTIVE_RESULT_${index}:${'x'.repeat(1800)}:ACTIVE_RESULT_END_${index}`,
    },
  ]).flat()
  const messages = [
    {
      role: 'system' as const,
      content: 'ORDINARY_COMPLETE_DOCUMENT_SYSTEM_SENTINEL',
    },
    createManagedToolPromptMessage(
      `FULL_MANAGED_PROTOCOL_SENTINEL:${'schema'.repeat(20_000)}`,
      {
        content: 'COMPACT_MANAGED_PROTOCOL_SENTINEL\n<tools>{"name":"read_file"}</tools>',
        referenceContent: 'FULL_TOOL_REFERENCE_SENTINEL',
      },
    ),
    { role: 'user' as const, content: 'ORIGINAL_PENDING_TASK_SENTINEL' },
    ...toolHistory,
  ]
  const snapshot = structuredClone(messages)
  const uploads: any[] = []

  const prepared = await prepareQwenAiMultimodalMessage(messages, {
    uploadPart: async (part: any, evidenceQueryText: string, options: { includeEvidence?: boolean }) => {
      uploads.push({ part, evidenceQueryText, options })
      return { file: { id: `uploaded-${uploads.length}`, filename: part.filename } }
    },
  } as any, {
    transport: 'document',
    managedToolCalling: true,
    workflowContinuation: true,
    requestMaxBytes: 90 * 1024,
  })

  assert.equal(prepared.transport, 'document')
  assert.equal(prepared.managedDocumentMode, 'complete')
  assert.ok(prepared.inlineUtf8Bytes < 90 * 1024)
  assert.equal(uploads.length, 2)

  const transcriptUpload = uploads.find(upload => /^chat2api-conversation-/.test(upload.part.filename))
  const toolReferenceUpload = uploads.find(upload => /^chat2api-tool-reference-/.test(upload.part.filename))
  assert.ok(transcriptUpload)
  assert.ok(toolReferenceUpload)
  const transcriptUrl = transcriptUpload.part.file_url.url as string
  const transcript = Buffer.from(transcriptUrl.split(',', 2)[1], 'base64').toString('utf8')

  assert.match(transcript, /ORDINARY_COMPLETE_DOCUMENT_SYSTEM_SENTINEL/)
  assert.match(transcript, /ORIGINAL_PENDING_TASK_SENTINEL/)
  assert.match(transcript, /ACTIVE_RESULT_0/)
  assert.match(transcript, /ACTIVE_RESULT_93/)
  assert.doesNotMatch(transcript, /FULL_MANAGED_PROTOCOL_SENTINEL|COMPACT_MANAGED_PROTOCOL_SENTINEL/)
  assert.match(prepared.content, /complete managed conversation transcript is attached/i)
  assert.match(prepared.content, /COMPACT_MANAGED_PROTOCOL_SENTINEL/)
  assert.doesNotMatch(prepared.content, /ORIGINAL_PENDING_TASK_SENTINEL|ACTIVE_RESULT_0|ACTIVE_RESULT_93/)
  assert.deepEqual(messages, snapshot, 'complete document fallback must not mutate caller messages')
})

test('Qwen AI managed document retry changes a first-turn inline payload', async () => {
  const archivedHistory = `ARCHIVED_USER_HISTORY:${'x'.repeat(160_000)}:ARCHIVED_HISTORY_END`
  const userRequest = 'FIRST_TURN_REQUEST_SENTINEL'
  const messages = [
    {
      role: 'system' as const,
      content: 'ORDINARY_SYSTEM_CONTEXT_SENTINEL',
    },
    createManagedToolPromptMessage(
      'HERMES_PROTOCOL_SENTINEL\n<tools>{"name":"read_file"}</tools>',
    ),
    { role: 'user' as const, content: archivedHistory },
    { role: 'assistant' as const, content: 'ARCHIVED_ASSISTANT_RESPONSE_SENTINEL' },
    { role: 'user' as const, content: userRequest },
  ]
  const snapshot = structuredClone(messages)
  const uploads: any[] = []

  const prepared = await prepareQwenAiMultimodalMessage(messages, {
    uploadPart: async (part: any) => {
      uploads.push(part)
      return { file: { id: `uploaded-${uploads.length}`, filename: part.filename } }
    },
  } as any, {
    transport: 'document',
    managedToolCalling: true,
  })

  assert.equal(prepared.transport, 'document')
  assert.equal(uploads.length, 1)
  const transcriptUrl = uploads[0].file_url?.url || uploads[0].part?.file_url?.url
  const transcript = Buffer.from(String(transcriptUrl).split(',', 2)[1], 'base64').toString('utf8')
  assert.match(transcript, /ORDINARY_SYSTEM_CONTEXT_SENTINEL/)
  assert.match(transcript, /ARCHIVED_USER_HISTORY/)
  assert.match(transcript, /ARCHIVED_ASSISTANT_RESPONSE_SENTINEL/)
  assert.doesNotMatch(
    transcript,
    /HERMES_PROTOCOL_SENTINEL|FIRST_TURN_REQUEST_SENTINEL/,
  )
  assert.match(prepared.content, /HERMES_PROTOCOL_SENTINEL/)
  assert.match(prepared.content, /User: FIRST_TURN_REQUEST_SENTINEL/)
  assert.match(prepared.content, /Conversation context is attached/i)
  assert.doesNotMatch(
    prepared.content,
    /ORDINARY_SYSTEM_CONTEXT_SENTINEL|ARCHIVED_USER_HISTORY|ARCHIVED_HISTORY_END|ARCHIVED_ASSISTANT_RESPONSE_SENTINEL/,
  )
  assert.ok(prepared.inlineUtf8Bytes < prepared.transcriptUtf8Bytes)
  assert.deepEqual(messages, snapshot, 'managed first-turn document retry must not mutate caller messages')
})

test('Qwen AI content-hash cache reuses an in-memory transcript upload for the same account', async () => {
  const temporaryDataDir = mkdtempSync(join(tmpdir(), 'chat2api-qwen-cache-'))
  const previousDataDir = process.env.CHAT2API_DATA_DIR
  process.env.CHAT2API_DATA_DIR = temporaryDataDir

  try {
    const uploader = new QwenAiFileUploader(
      {} as any,
      () => ({}),
      undefined,
      { providerId: 'qwen-ai-cache-test', accountId: 'account-cache-test' },
    )
    let physicalUploads = 0
    ;(uploader as any).uploadResolvedFile = async (file: any) => {
      physicalUploads += 1
      return {
        id: `physical-upload-${physicalUploads}`,
        name: file.filename,
        file: { id: `physical-upload-${physicalUploads}` },
      }
    }
    const data = Buffer.from('stable complete transcript bytes', 'utf8').toString('base64')
    const part = {
      type: 'file' as const,
      filename: 'conversation.txt',
      mime_type: 'text/plain',
      file_url: { url: `data:text/plain;base64,${data}` },
    }

    const first = await uploader.uploadPart(part, '', { includeEvidence: false })
    const second = await uploader.uploadPart(part, '', { includeEvidence: false })

    assert.equal(physicalUploads, 1)
    assert.equal(first.file.file.id, second.file.file.id)
    assert.notEqual(first.file.itemId, second.file.itemId)
  } finally {
    if (previousDataDir === undefined) delete process.env.CHAT2API_DATA_DIR
    else process.env.CHAT2API_DATA_DIR = previousDataDir
    rmSync(temporaryDataDir, { recursive: true, force: true })
  }
})

test('Qwen AI file upload rejects an expired request deadline before physical upload starts', async () => {
  const uploader = new QwenAiFileUploader({} as any, () => ({}))
  let physicalUploads = 0
  ;(uploader as any).uploadResolvedFile = async () => {
    physicalUploads += 1
    return { id: 'unexpected-upload' }
  }

  const data = Buffer.from('deadline fixture', 'utf8').toString('base64')
  await assert.rejects(
    uploader.uploadPart({
      type: 'file',
      filename: 'deadline.txt',
      mime_type: 'text/plain',
      file_url: { url: `data:text/plain;base64,${data}` },
    }, '', {
      includeEvidence: false,
      deadlineAt: Date.now() - 1,
    }),
    (error: any) => {
      assert.equal(error.status, 504)
      assert.equal(error.code, 'qwen_ai_request_timeout')
      assert.equal(error.retryable, false)
      assert.equal(error.accountFault, false)
      assert.equal(error.retryScope, undefined)
      return true
    },
  )
  assert.equal(physicalUploads, 0)
})

test('Qwen AI HTTP file download inherits the client signal and remaining request budget', async () => {
  const temporaryDataDir = mkdtempSync(join(tmpdir(), 'chat2api-qwen-http-deadline-'))
  const previousDataDir = process.env.CHAT2API_DATA_DIR
  process.env.CHAT2API_DATA_DIR = temporaryDataDir
  const controller = new AbortController()
  const deadlineAt = Date.now() + 5_000
  let requestOptions: any

  try {
    const uploader = new QwenAiFileUploader({
      get: async (_url: string, options: any) => {
        requestOptions = options
        return {
          status: 200,
          headers: { 'content-type': 'image/png' },
          data: Buffer.from('downloaded-image-bytes'),
        }
      },
    } as any, () => ({}), undefined, {
      providerId: 'qwen-ai-http-deadline-test',
      accountId: 'qwen-ai-http-deadline-account',
    })
    ;(uploader as any).uploadResolvedFile = async (file: any) => ({
      id: 'http-upload',
      file: { id: 'http-upload' },
      name: file.filename,
    })

    await uploader.uploadPart({
      type: 'image_url',
      image_url: { url: 'https://example.test/deadline-image.png' },
    }, '', {
      includeEvidence: false,
      signal: controller.signal,
      deadlineAt,
    })

    assert.equal(requestOptions.signal, controller.signal)
    assert.ok(requestOptions.timeout >= 1)
    assert.ok(requestOptions.timeout <= 5_000)
  } finally {
    if (previousDataDir === undefined) delete process.env.CHAT2API_DATA_DIR
    else process.env.CHAT2API_DATA_DIR = previousDataDir
    rmSync(temporaryDataDir, { recursive: true, force: true })
  }
})

test('Qwen AI file upload rejects a response that returns after the absolute deadline', async () => {
  let physicalUploads = 0
  const uploader = new QwenAiFileUploader({
    get: (_url: string, _options: any) => {
      const blockedUntil = Date.now() + 50
      while (Date.now() < blockedUntil) {
        // Simulate an event-loop stall between dispatch and Axios resolution.
      }
      return Promise.resolve({
        status: 200,
        headers: { 'content-type': 'image/png' },
        data: Buffer.from('late-image-bytes'),
      })
    },
  } as any, () => ({}))
  ;(uploader as any).uploadResolvedFile = async () => {
    physicalUploads += 1
    return { id: 'unexpected-late-upload' }
  }

  await assert.rejects(
    uploader.uploadPart({
      type: 'image_url',
      image_url: { url: 'https://example.test/late-image.png' },
    }, '', {
      includeEvidence: false,
      deadlineAt: Date.now() + 20,
    }),
    (error: any) => error?.status === 504 && error?.code === 'qwen_ai_request_timeout',
  )
  assert.equal(physicalUploads, 0, 'a late download must not advance to STS or OSS')
})

test('Qwen AI shared upload lets one waiter abort without cancelling the physical upload', async () => {
  const temporaryDataDir = mkdtempSync(join(tmpdir(), 'chat2api-qwen-waiter-abort-'))
  const previousDataDir = process.env.CHAT2API_DATA_DIR
  process.env.CHAT2API_DATA_DIR = temporaryDataDir
  let finishPhysicalUpload!: (value: any) => void
  const physicalUpload = new Promise<any>(resolve => {
    finishPhysicalUpload = resolve
  })

  try {
    const uploader = new QwenAiFileUploader(
      {} as any,
      () => ({}),
      undefined,
      { providerId: 'qwen-ai-shared-wait-test', accountId: 'shared-wait-account' },
    )
    let physicalUploads = 0
    ;(uploader as any).uploadResolvedFile = async () => {
      physicalUploads += 1
      return physicalUpload
    }
    const data = Buffer.from('shared upload bytes', 'utf8').toString('base64')
    const part = {
      type: 'file' as const,
      filename: 'shared.txt',
      mime_type: 'text/plain',
      file_url: { url: `data:text/plain;base64,${data}` },
    }

    const owner = uploader.uploadPart(part, '', { includeEvidence: false })
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(physicalUploads, 1)

    const waiterController = new AbortController()
    const waiter = uploader.uploadPart(part, '', {
      includeEvidence: false,
      signal: waiterController.signal,
    })
    await new Promise(resolve => setImmediate(resolve))
    waiterController.abort()

    await assert.rejects(waiter, (error: any) => {
      assert.equal(error.name, 'AbortError')
      assert.equal(error.code, 'ERR_CANCELED')
      return true
    })
    assert.equal(physicalUploads, 1, 'the waiter must reuse rather than restart the upload')

    finishPhysicalUpload({ id: 'shared-upload', file: { id: 'shared-upload' } })
    const ownerResult = await owner
    assert.equal(ownerResult.file.file.id, 'shared-upload')
    assert.equal(physicalUploads, 1, 'waiter cancellation must not cancel the upload owner')
  } finally {
    if (previousDataDir === undefined) delete process.env.CHAT2API_DATA_DIR
    else process.env.CHAT2API_DATA_DIR = previousDataDir
    rmSync(temporaryDataDir, { recursive: true, force: true })
  }
})

test('Qwen AI parse polling delay exits promptly when the client aborts', async () => {
  let statusRequests = 0
  const uploader = new QwenAiFileUploader({
    post: async () => {
      statusRequests += 1
      return { status: 200, data: { status: 'processing' } }
    },
  } as any, () => ({}))
  const controller = new AbortController()
  const startedAt = Date.now()
  const waiting = (uploader as any).waitForParse('parse-abort-file', {
    signal: controller.signal,
  })
  setTimeout(() => controller.abort(), 20)

  await assert.rejects(waiting, (error: any) => {
    assert.equal(error.name, 'AbortError')
    assert.equal(error.code, 'ERR_CANCELED')
    assert.equal(error.retryScope, undefined)
    return true
  })
  assert.ok(Date.now() - startedAt < 500, 'abort must interrupt the two-second poll delay')
  assert.equal(statusRequests, 0)
})

test('Qwen AI parse-stage timeout requests account-neutral failover', async () => {
  const previousInterval = process.env.QWEN_AI_FILE_PARSE_POLL_INTERVAL_MS
  const previousTimeout = process.env.QWEN_AI_FILE_PARSE_TIMEOUT_MS
  process.env.QWEN_AI_FILE_PARSE_POLL_INTERVAL_MS = '5'
  process.env.QWEN_AI_FILE_PARSE_TIMEOUT_MS = '250'
  let statusRequests = 0

  try {
    const fileId = 'parse-timeout-file'
    const uploader = new QwenAiFileUploader({
      post: async () => {
        statusRequests += 1
        return {
          status: 200,
          data: { data: { [fileId]: { status: 'running' } } },
        }
      },
    } as any, () => ({}))
    const startedAt = Date.now()

    await assert.rejects((uploader as any).waitForParse(fileId), (error: any) => {
      assert.equal(error.status, 504)
      assert.equal(error.code, 'qwen_ai_file_parse_timeout')
      assert.equal(error.retryable, false)
      assert.equal(error.accountFault, false)
      assert.equal(error.retryScope, 'next-account')
      assert.match(error.message, /last status: running/)
      return true
    })

    assert.ok(statusRequests > 0)
    assert.ok(Date.now() - startedAt < 1_000)
  } finally {
    if (previousInterval === undefined) delete process.env.QWEN_AI_FILE_PARSE_POLL_INTERVAL_MS
    else process.env.QWEN_AI_FILE_PARSE_POLL_INTERVAL_MS = previousInterval
    if (previousTimeout === undefined) delete process.env.QWEN_AI_FILE_PARSE_TIMEOUT_MS
    else process.env.QWEN_AI_FILE_PARSE_TIMEOUT_MS = previousTimeout
  }
})

test('Qwen AI OSS upload cancels its dedicated client on client abort or deadline', async () => {
  const originalPut = OSS.prototype.put
  const originalCancel = (OSS.prototype as any).cancel
  let putOptions: any
  let cancelCalls = 0
  OSS.prototype.put = ((_name: string, _data: any, options: any) => {
    putOptions = options
    return new Promise(() => {})
  }) as any
  ;(OSS.prototype as any).cancel = function () {
    cancelCalls += 1
  }

  try {
    const uploader = new QwenAiFileUploader({} as any, () => ({}))
    const controller = new AbortController()
    const upload = (uploader as any).uploadToOss({
      data: Buffer.from('oss-abort-bytes'),
      sizeBytes: 15,
      filename: 'abort.txt',
      mimeType: 'text/plain',
      coarseType: 'file',
      fileClass: 'document',
    }, {
      accessKeyId: 'fixture-access-key',
      accessKeySecret: 'fixture-access-secret',
      bucket: 'fixture-bucket',
      region: 'oss-cn-hangzhou',
      endpoint: 'https://oss-cn-hangzhou.aliyuncs.com',
      fileId: 'fixture-file-id',
      filePath: 'fixture/path.txt',
      fileUrl: 'https://fixture-bucket.oss-cn-hangzhou.aliyuncs.com/fixture/path.txt',
    }, {
      signal: controller.signal,
      deadlineAt: Date.now() + 5_000,
    })
    await new Promise(resolve => setImmediate(resolve))
    controller.abort()

    await assert.rejects(upload, (error: any) => {
      assert.equal(error.name, 'AbortError')
      assert.equal(error.code, 'ERR_CANCELED')
      return true
    })
    assert.equal(cancelCalls, 1)
    assert.ok(putOptions.timeout >= 1 && putOptions.timeout <= 5_000)

    const deadlineUpload = (uploader as any).uploadToOss({
      data: Buffer.from('oss-deadline-bytes'),
      sizeBytes: 18,
      filename: 'deadline.txt',
      mimeType: 'text/plain',
      coarseType: 'file',
      fileClass: 'document',
    }, {
      accessKeyId: 'fixture-access-key',
      accessKeySecret: 'fixture-access-secret',
      bucket: 'fixture-bucket',
      region: 'oss-cn-hangzhou',
      endpoint: 'https://oss-cn-hangzhou.aliyuncs.com',
      fileId: 'fixture-deadline-file-id',
      filePath: 'fixture/deadline.txt',
      fileUrl: 'https://fixture-bucket.oss-cn-hangzhou.aliyuncs.com/fixture/deadline.txt',
    }, {
      deadlineAt: Date.now() + 20,
    })
    await assert.rejects(deadlineUpload, (error: any) => {
      assert.equal(error.status, 504)
      assert.equal(error.code, 'qwen_ai_request_timeout')
      return true
    })
    assert.equal(cancelCalls, 2)
  } finally {
    OSS.prototype.put = originalPut
    ;(OSS.prototype as any).cancel = originalCancel
  }
})
