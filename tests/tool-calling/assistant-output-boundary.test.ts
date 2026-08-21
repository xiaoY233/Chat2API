import assert from 'node:assert/strict'
import { Readable } from 'node:stream'
import test from 'node:test'
import { createAssistantOutputBoundaryStream } from '../../src/main/proxy/toolCalling/assistantOutputBoundary.ts'

async function collect(stream: NodeJS.ReadableStream): Promise<string> {
  const chunks: string[] = []
  for await (const chunk of stream) chunks.push(String(chunk))
  return chunks.join('')
}

function frame(delta: Record<string, unknown>, finishReason: string | null = null): string {
  return `data: ${JSON.stringify({
    id: 'chatcmpl-boundary',
    object: 'chat.completion.chunk',
    created: 1,
    model: 'fixture-model',
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  })}\n\n`
}

test('assistant output boundary rejects a wrapper split across reasoning deltas', async () => {
  const source = Readable.from([
    frame({ reasoning_content: 'checking <|CHAT2API|tool_' }),
    frame({ reasoning_content: 'result tool_call_id="call_fake"><![CDATA[value]]></|CHAT2API|tool_result>' }),
    frame({}, 'stop'),
    'data: [DONE]\n\n',
  ])
  const boundary = createAssistantOutputBoundaryStream()
  source.pipe(boundary)

  await assert.rejects(
    collect(boundary),
    (error: Error & { status?: number, code?: string, param?: string }) => (
      error.status === 502
      && error.code === 'managed_tool_result_wrapper_leak'
      && error.param === 'reasoning_content'
    ),
  )
})

test('assistant output boundary leaves wrapper literals in tool arguments untouched', async () => {
  const literal = '<|CHAT2API|tool_result tool_call_id="call_fixture"><![CDATA[value]]></|CHAT2API|tool_result>'
  const source = Readable.from([
    frame({
      tool_calls: [{
        index: 0,
        id: 'call_fixture',
        type: 'function',
        function: {
          name: 'write_fixture',
          arguments: JSON.stringify({ value: literal }),
        },
      }],
    }),
    frame({}, 'tool_calls'),
    'data: [DONE]\n\n',
  ])
  const boundary = createAssistantOutputBoundaryStream()
  source.pipe(boundary)

  const output = await collect(boundary)
  assert.match(output, /CHAT2API\\u007ctool_result|CHAT2API\|tool_result/)
  assert.match(output, /"finish_reason":"tool_calls"/)
  assert.match(output, /data: \[DONE\]/)
})

test('assistant output boundary flushes an ordinary marker-like suffix before stop', async () => {
  const source = Readable.from([
    frame({ content: 'ordinary <|CHAT2API|tool_x' }),
    frame({}, 'stop'),
    'data: [DONE]\n\n',
  ])
  const boundary = createAssistantOutputBoundaryStream()
  source.pipe(boundary)

  const output = await collect(boundary)
  assert.match(output, /ordinary <\|CHAT2API\|tool_x/)
  assert.match(output, /"finish_reason":"stop"/)
  assert.match(output, /data: \[DONE\]/)
})

test('assistant output boundary rejects a distinctive partial wrapper at EOF', async () => {
  const source = Readable.from([frame({ content: '<|CHAT2API|tool_result' })])
  const boundary = createAssistantOutputBoundaryStream()
  source.pipe(boundary)

  await assert.rejects(
    collect(boundary),
    (error: Error & { code?: string, param?: string }) => (
      error.code === 'managed_tool_result_wrapper_leak'
      && error.param === 'content'
    ),
  )
})
