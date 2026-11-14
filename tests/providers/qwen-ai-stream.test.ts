import test from 'node:test'
import assert from 'node:assert/strict'
import { Readable } from 'node:stream'
import { QwenAiStreamHandler } from '../../src/main/proxy/adapters/qwen-ai.ts'
import type { ToolCallingPlan } from '../../src/main/proxy/toolCalling/types.ts'

function plan(): ToolCallingPlan {
  const tools = [{
    name: 'default_api:read_file',
    description: 'Read a file',
    parameters: { type: 'object', properties: { filePath: { type: 'string' } } },
    source: 'openai' as const,
  }]

  return {
    mode: 'managed',
    protocol: 'managed_bracket',
    coding: true,
    clientAdapterId: 'standard-openai-tools',
    providerId: 'qwen-ai',
    tools,
    shouldInjectPrompt: true,
    shouldParseResponse: true,
    toolChoiceMode: 'auto',
    allowedToolNames: new Set(tools.map((tool) => tool.name)),
    diagnostics: {
      clientAdapterId: 'standard-openai-tools',
      providerId: 'qwen-ai',
      toolSource: 'openai',
      mode: 'managed',
      protocol: 'managed_bracket',
      toolCount: tools.length,
      injected: true,
      reason: 'test',
      coding: true,
    },
  }
}

function sse(payload: unknown): string {
  return `data: ${JSON.stringify(payload)}\n\n`
}

async function collect(stream: NodeJS.ReadableStream): Promise<string> {
  let output = ''
  for await (const chunk of stream) {
    output += chunk.toString()
  }
  return output
}

test('Qwen AI stream emits a tool call for a bracket response', async () => {
  const handler = new QwenAiStreamHandler('qwen3.8-max', undefined, plan())
  handler.setChatId('chat-1')

  const upstream = Readable.from([
    sse({ 'response.created': { response_id: 'resp-1' } }),
    sse({
      choices: [{
        delta: {
          phase: 'answer',
          status: 'typing',
          content: '[function_calls][call:default_api:read_file]{"filePath":"/tmp/a"}[/call][/function_calls]',
        },
      }],
    }),
    sse({ choices: [{ delta: { phase: 'answer', status: 'finished', finish_reason: 'stop' } }] }),
  ])

  const output = await collect(await handler.handleStream(upstream))
  const chunks = output
    .split('\n\n')
    .filter((line) => line.startsWith('data: ') && line !== 'data: [DONE]')
    .map((line) => JSON.parse(line.slice(6)))

  const toolChunk = chunks.find((chunk) => chunk.choices[0].delta.tool_calls)
  const finishChunk = chunks.find((chunk) => chunk.choices[0].finish_reason)

  assert.equal(toolChunk.choices[0].delta.tool_calls[0].function.name, 'default_api:read_file')
  assert.equal(finishChunk.choices[0].finish_reason, 'tool_calls')
  assert.equal(
    chunks.some((chunk) => (chunk.choices[0].delta.content || '').includes('[function_calls]')),
    false,
  )
})

test('Qwen AI stream still emits plain content as text', async () => {
  const handler = new QwenAiStreamHandler('qwen3.8-max', undefined, plan())
  handler.setChatId('chat-2')

  const upstream = Readable.from([
    sse({ choices: [{ delta: { phase: 'answer', status: 'typing', content: 'Hello there' } }] }),
    sse({ choices: [{ delta: { phase: 'answer', status: 'finished', finish_reason: 'stop' } }] }),
  ])

  const output = await collect(await handler.handleStream(upstream))
  const chunks = output
    .split('\n\n')
    .filter((line) => line.startsWith('data: ') && line !== 'data: [DONE]')
    .map((line) => JSON.parse(line.slice(6)))

  const content = chunks.map((chunk) => chunk.choices[0].delta.content || '').join('')
  assert.match(content, /Hello there/)
  assert.equal(chunks.some((chunk) => chunk.choices[0].delta.tool_calls), false)
})
