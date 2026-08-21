import assert from 'node:assert/strict'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import { PassThrough, Readable } from 'node:stream'
import test from 'node:test'
import { brotliCompressSync, deflateSync, gzipSync } from 'node:zlib'
import ts from 'typescript'

import { ToolStreamParser } from '../../src/main/proxy/toolCalling/ToolStreamParser.ts'
import type { ToolCallingPlan } from '../../src/main/proxy/toolCalling/types.ts'

const runtimeRequire = createRequire(import.meta.url)

function loadQwenStreamHandler(): typeof import('../../src/main/proxy/adapters/qwen.ts') {
  const source = fs.readFileSync('src/main/proxy/adapters/qwen.ts', 'utf8')
  const output = ts.transpileModule(source, {
    compilerOptions: {
      esModuleInterop: true,
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
    },
  }).outputText
  const loadedModule: { exports: any } = { exports: {} }
  const localModules: Record<string, any> = {
    '../promptToolUse': {
      hasToolUse: () => false,
      parseToolUse: () => [],
    },
    '../utils/tools': {
      toolsToSystemPrompt: () => '',
      TOOL_WRAP_HINT: '',
      hasToolPromptInjected: () => false,
      shouldInjectToolPrompt: () => false,
    },
    '../utils/toolParser': {
      parseToolCallsFromText: (content: string) => ({ content, toolCalls: [] }),
    },
    '../utils/streamToolHandler': {
      createBaseChunk: (id: string, model: string, created: number) => ({
        id,
        model,
        object: 'chat.completion.chunk',
        created,
      }),
    },
    '../toolCalling/providerProfiles': {
      getProviderToolProfile: () => ({}),
    },
    '../toolCalling/ToolStreamParser': { ToolStreamParser },
  }
  const testRequire = (specifier: string) => {
    if (Object.prototype.hasOwnProperty.call(localModules, specifier)) {
      return localModules[specifier]
    }
    if (specifier.startsWith('.')) {
      throw new Error(`Unexpected Qwen stream test import: ${specifier}`)
    }
    return runtimeRequire(specifier)
  }

  new Function('require', 'module', 'exports', output)(testRequire, loadedModule, loadedModule.exports)
  return loadedModule.exports
}

function managedToolPlan(): ToolCallingPlan {
  return {
    mode: 'managed',
    protocol: 'managed_xml',
    clientAdapterId: 'standard-openai-tools',
    providerId: 'qwen',
    tools: [{ name: 'read_file', parameters: { type: 'object' }, source: 'openai' }],
    shouldInjectPrompt: true,
    shouldParseResponse: true,
    toolChoiceMode: 'auto',
    allowedToolNames: new Set(['read_file']),
    workflowContinuation: false,
    failedToolResultPending: false,
    diagnostics: {
      clientAdapterId: 'standard-openai-tools',
      providerId: 'qwen',
      toolSource: 'openai',
      mode: 'managed',
      protocol: 'managed_xml',
      toolCount: 1,
      injected: true,
      reason: 'test',
      workflowContinuation: false,
      failedToolResultPending: false,
    },
  }
}

function qwenEvent(content: string): string {
  return `data: ${JSON.stringify({
    communication: { sessionid: 'session-test', reqid: 'response-test' },
    data: {
      messages: [{
        mime_type: 'text/plain',
        status: 'streaming',
        content,
      }],
    },
  })}\n\n`
}

async function encodeEvent(
  contentEncoding: 'gzip' | 'deflate' | 'br' | 'zstd',
  event: string,
): Promise<Buffer> {
  if (contentEncoding === 'gzip') return gzipSync(event)
  if (contentEncoding === 'deflate') return deflateSync(event)
  if (contentEncoding === 'br') return brotliCompressSync(event)

  const { ZstdCodec } = runtimeRequire('zstd-codec') as {
    ZstdCodec: { run(callback: (zstd: any) => void): void }
  }
  return new Promise((resolve, reject) => {
    try {
      ZstdCodec.run((zstd) => {
        try {
          const simple = new zstd.Simple()
          resolve(Buffer.from(simple.compress(Buffer.from(event))))
        } catch (error) {
          reject(error)
        }
      })
    } catch (error) {
      reject(error)
    }
  })
}

async function capture(stream: NodeJS.ReadableStream): Promise<{ body: string, error?: Error }> {
  let body = ''
  try {
    for await (const chunk of stream) body += String(chunk)
    return { body }
  } catch (error) {
    return { body, error: error instanceof Error ? error : new Error(String(error)) }
  }
}

async function captureWithin(
  stream: NodeJS.ReadableStream,
  timeoutMs: number = 1_000,
): Promise<{ body: string, error?: Error }> {
  let timeout: NodeJS.Timeout | undefined
  try {
    return await Promise.race([
      capture(stream),
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new Error('Qwen stream did not settle')), timeoutMs)
      }),
    ])
  } finally {
    if (timeout) clearTimeout(timeout)
  }
}

function assertWrapperProtocolFailure(result: { body: string, error?: Error }): void {
  const error = result.error as Error & { status?: number, code?: string }
  assert.ok(error)
  assert.equal(error.status, 502)
  assert.equal(error.code, 'managed_tool_result_wrapper_leak')
  assert.doesNotMatch(result.body, /CHAT2API/)
  assert.doesNotMatch(result.body, /"finish_reason":"stop"/)
  assert.doesNotMatch(result.body, /data: \[DONE\]/)
}

test('Qwen stream rejects a managed tool-result wrapper when transport ends without explicit complete', async () => {
  const { QwenStreamHandler } = loadQwenStreamHandler()
  const wrapper = '<|CHAT2API|tool_result tool_call_id="call_fake"><![CDATA[value]]></|CHAT2API|tool_result>'
  const handler = new QwenStreamHandler('qwen-test', undefined, managedToolPlan())

  const result = await capture(handler.handleStream(Readable.from([qwenEvent(wrapper)])))

  assertWrapperProtocolFailure(result)
})

test('Qwen stream rejects a detected wrapper without waiting for the upstream transport to end', async () => {
  const { QwenStreamHandler } = loadQwenStreamHandler()
  const wrapper = '<|CHAT2API|tool_result tool_call_id="call_fake"><![CDATA[value]]></|CHAT2API|tool_result>'
  const source = new PassThrough()
  const handler = new QwenStreamHandler('qwen-test', undefined, managedToolPlan())
  const resultPromise = captureWithin(handler.handleStream(source))

  source.write(qwenEvent(wrapper))
  const result = await resultPromise

  assertWrapperProtocolFailure(result)
  assert.equal(source.destroyed, true)
})

test('Qwen stream checks the final SSE block when the transport omits its trailing delimiter', async () => {
  const { QwenStreamHandler } = loadQwenStreamHandler()
  const wrapper = '<|CHAT2API|tool_result tool_call_id="call_fake"><![CDATA[value]]></|CHAT2API|tool_result>'
  const handler = new QwenStreamHandler('qwen-test', undefined, managedToolPlan())
  const finalBlockWithoutDelimiter = qwenEvent(wrapper).trimEnd()

  const result = await capture(handler.handleStream(Readable.from([finalBlockWithoutDelimiter])))

  assertWrapperProtocolFailure(result)
})

test('Qwen stream parses CRLF-delimited SSE before applying the wrapper guard', async () => {
  const { QwenStreamHandler } = loadQwenStreamHandler()
  const wrapper = '<|CHAT2API|tool_result tool_call_id="call_fake"><![CDATA[value]]></|CHAT2API|tool_result>'
  const handler = new QwenStreamHandler('qwen-test', undefined, managedToolPlan())
  const crlfEvent = qwenEvent(wrapper).replace(/\n/g, '\r\n')

  const result = await capture(handler.handleStream(Readable.from([crlfEvent])))

  assertWrapperProtocolFailure(result)
})

for (const contentEncoding of ['gzip', 'deflate', 'br', 'zstd'] as const) {
  test(`Qwen ${contentEncoding} stream applies the same managed wrapper guard`, async () => {
    const { QwenStreamHandler } = loadQwenStreamHandler()
    const wrapper = '<|CHAT2API|tool_result tool_call_id="call_fake"><![CDATA[value]]></|CHAT2API|tool_result>'
    const handler = new QwenStreamHandler('qwen-test', undefined, managedToolPlan())
    const compressedEvent = await encodeEvent(contentEncoding, qwenEvent(wrapper))

    const result = await capture(handler.handleStream(
      Readable.from([compressedEvent]),
      { headers: { 'content-encoding': contentEncoding } } as any,
    ))

    assertWrapperProtocolFailure(result)
  })
}

test('Qwen stream does not duplicate termination when a final undelimited block is complete', async () => {
  const { QwenStreamHandler } = loadQwenStreamHandler()
  const handler = new QwenStreamHandler('qwen-test', undefined, managedToolPlan())
  const finalCompleteBlock = `event: complete\n${qwenEvent('ordinary answer').trimEnd()}`

  const result = await capture(handler.handleStream(Readable.from([finalCompleteBlock])))

  assert.equal(result.error, undefined)
  assert.match(result.body, /"content":"ordinary answer"/)
  assert.equal(result.body.match(/"finish_reason":"stop"/g)?.length, 1)
  assert.equal(result.body.match(/data: \[DONE\]/g)?.length, 1)
})

test('Qwen stream preserves ordinary text when transport ends without explicit complete', async () => {
  const { QwenStreamHandler } = loadQwenStreamHandler()
  const handler = new QwenStreamHandler('qwen-test', undefined, managedToolPlan())

  const result = await capture(handler.handleStream(Readable.from([qwenEvent('ordinary answer')])))

  assert.equal(result.error, undefined)
  assert.match(result.body, /"content":"ordinary answer"/)
  assert.match(result.body, /"finish_reason":"stop"/)
  assert.equal(result.body.match(/data: \[DONE\]/g)?.length, 1)
})

test('Qwen transport errors prefer an already detected wrapper protocol error', async () => {
  const { QwenStreamHandler } = loadQwenStreamHandler()
  const wrapper = '<|CHAT2API|tool_result tool_call_id="call_fake"><![CDATA[value]]></|CHAT2API|tool_result>'
  const source = new PassThrough()
  const handler = new QwenStreamHandler('qwen-test', undefined, managedToolPlan())
  const resultPromise = capture(handler.handleStream(source))

  source.write(qwenEvent(wrapper))
  source.destroy(new Error('synthetic transport error'))

  assertWrapperProtocolFailure(await resultPromise)
})

test('Qwen transport errors preserve the original error without a protocol failure', async () => {
  const { QwenStreamHandler } = loadQwenStreamHandler()
  const source = new PassThrough()
  const handler = new QwenStreamHandler('qwen-test', undefined, managedToolPlan())
  const resultPromise = capture(handler.handleStream(source))
  const transportError = Object.assign(new Error('synthetic transport error'), {
    code: 'synthetic_transport_error',
  })

  source.destroy(transportError)
  const result = await resultPromise

  assert.equal(result.error?.message, transportError.message)
  assert.equal((result.error as Error & { code?: string }).code, transportError.code)
  assert.doesNotMatch(result.body, /"finish_reason":"stop"/)
  assert.doesNotMatch(result.body, /data: \[DONE\]/)
})

for (const contentEncoding of [undefined, 'gzip', 'zstd'] as const) {
  test(`Qwen ${contentEncoding ?? 'raw'} stream rejects close before end`, async () => {
    const { QwenStreamHandler } = loadQwenStreamHandler()
    const source = new PassThrough()
    const handler = new QwenStreamHandler('qwen-test', undefined, managedToolPlan())
    const resultPromise = captureWithin(handler.handleStream(
      source,
      contentEncoding ? { headers: { 'content-encoding': contentEncoding } } as any : undefined,
    ))

    source.destroy()
    const result = await resultPromise

    assert.equal((result.error as Error & { code?: string }).code, 'ERR_STREAM_PREMATURE_CLOSE')
    assert.doesNotMatch(result.body, /"finish_reason":"stop"/)
    assert.doesNotMatch(result.body, /data: \[DONE\]/)
  })
}
