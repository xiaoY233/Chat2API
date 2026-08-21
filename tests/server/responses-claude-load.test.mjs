import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import fs from 'node:fs'
import http from 'node:http'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

const repoRoot = process.cwd()
const serverEntry = path.join(repoRoot, 'out-server/server/index.js')
const managementSecret = 'mgmt_responses_claude_load_test'
const providerId = 'responses-claude-offline-mock'
const clientModel = 'responses-claude-load-model'
const upstreamModel = 'offline-upstream-model'
const upstreamToken = 'sk-offline-upstream-not-real'
const stressConcurrency = 80
const longContextConcurrency = 24
const oneMiB = 1024 * 1024
const onePixelPngBase64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII='

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function waitFor(predicate, timeoutMs, message) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return
    await delay(20)
  }
  assert.fail(message)
}

function captureOutput(child, maxLength = 64 * 1024) {
  let output = ''
  const append = (chunk) => {
    output = `${output}${chunk.toString()}`.slice(-maxLength)
  }
  child.stdout?.on('data', append)
  child.stderr?.on('data', append)
  return () => output
}

async function reservePort() {
  const server = net.createServer()
  server.unref()
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  assert.ok(address && typeof address === 'object')
  const port = address.port
  await new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve())
  })
  return port
}

async function stopChild(child, timeoutMs = 5_000) {
  if (!child || child.exitCode !== null) return

  const exited = once(child, 'exit')
  child.kill('SIGTERM')
  const stopped = await Promise.race([
    exited.then(() => true),
    delay(timeoutMs).then(() => false),
  ])
  if (!stopped && child.exitCode === null) {
    child.kill('SIGKILL')
    await Promise.race([once(child, 'exit'), delay(2_000)])
  }
}

async function waitForHttp(url, child, output) {
  const deadline = Date.now() + 15_000
  let lastError = ''
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`Chat2API exited before becoming ready (${child.exitCode}):\n${output()}`)
    }
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(2_000) })
      if (response.ok) return
      lastError = `HTTP ${response.status}: ${await response.text()}`
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error)
    }
    await delay(100)
  }
  throw new Error(`Chat2API did not become ready: ${lastError}\n${output()}`)
}

async function requestJson(url, init = {}) {
  const response = await fetch(url, init)
  const text = await response.text()
  let body
  try {
    body = text ? JSON.parse(text) : null
  } catch {
    body = text
  }
  return { response, body, text }
}

function parseSse(text) {
  return text
    .split(/\r?\n\r?\n/)
    .map((block) => block.trim())
    .filter(Boolean)
    .map((block) => {
      let event
      const dataLines = []
      for (const line of block.split(/\r?\n/)) {
        if (line.startsWith('event:')) event = line.slice('event:'.length).trim()
        if (line.startsWith('data:')) dataLines.push(line.slice('data:'.length).trimStart())
      }
      const rawData = dataLines.join('\n')
      let data = rawData
      try {
        data = JSON.parse(rawData)
      } catch {
        // Preserve markers such as [DONE] for protocol assertions.
      }
      return { event, data, rawData }
    })
}

function responseOutputText(response) {
  return (response?.output || [])
    .filter((item) => item?.type === 'message')
    .flatMap((item) => item.content || [])
    .filter((part) => part?.type === 'output_text')
    .map((part) => part.text || '')
    .join('')
}

function responseStreamText(events) {
  return events
    .filter((entry) => entry.data?.type === 'response.output_text.delta')
    .map((entry) => entry.data.delta || '')
    .join('')
}

function chatStreamText(events) {
  return events
    .filter((entry) => entry.data && typeof entry.data === 'object')
    .map((entry) => entry.data.choices?.[0]?.delta?.content || '')
    .join('')
}

function assertEventSubsequence(events, expectedTypes) {
  let cursor = -1
  for (const type of expectedTypes) {
    cursor = events.findIndex((entry, index) => index > cursor && entry.data?.type === type)
    assert.notEqual(cursor, -1, `Missing or out-of-order Responses event: ${type}`)
  }
}

function scalarText(value) {
  if (typeof value === 'string') return value
  if (value === null || value === undefined) return ''
  if (Array.isArray(value)) return value.map(scalarText).join('\n')
  if (typeof value !== 'object') return String(value)
  if (typeof value.text === 'string') return value.text
  if (typeof value.output === 'string') return value.output
  if (value.content !== undefined) return scalarText(value.content)
  return ''
}

function messageText(messages = []) {
  return messages.map((message) => scalarText(message?.content)).join('\n')
}

function chatCompletion(model, content) {
  return {
    id: `chatcmpl-offline-${Date.now().toString(36)}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{
      index: 0,
      message: { role: 'assistant', content },
      finish_reason: 'stop',
    }],
    usage: {
      prompt_tokens: 17,
      completion_tokens: 5,
      total_tokens: 22,
    },
  }
}

function toolCompletion(model) {
  return {
    id: 'chatcmpl-offline-tool-call',
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{
      index: 0,
      message: {
        role: 'assistant',
        content: null,
        tool_calls: [{
          id: 'call_offline_read_1',
          type: 'function',
          function: {
            name: 'read_file',
            arguments: JSON.stringify({ path: 'README.md' }),
          },
        }],
      },
      finish_reason: 'tool_calls',
    }],
    usage: {
      prompt_tokens: 21,
      completion_tokens: 9,
      total_tokens: 30,
    },
  }
}

function imageCompletion(model) {
  return {
    id: 'chatcmpl-offline-image-call',
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{
      index: 0,
      message: {
        role: 'assistant',
        content: null,
        images: [{
          type: 'image',
          image_url: `data:image/png;base64,${onePixelPngBase64}`,
          source: 'qwen-ai',
          revised_prompt: 'A one-pixel offline fixture.',
        }],
      },
      finish_reason: 'stop',
    }],
    usage: {
      prompt_tokens: 12,
      completion_tokens: 1,
      total_tokens: 13,
    },
  }
}

function writeChatStream(response, model, content) {
  const id = `chatcmpl-offline-stream-${Date.now().toString(36)}`
  const base = {
    id,
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model,
  }
  const midpoint = Math.max(1, Math.floor(content.length / 2))
  const chunks = [
    { ...base, choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }] },
    { ...base, choices: [{ index: 0, delta: { content: content.slice(0, midpoint) }, finish_reason: null }] },
    { ...base, choices: [{ index: 0, delta: { content: content.slice(midpoint) }, finish_reason: null }] },
    { ...base, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
    {
      ...base,
      choices: [],
      usage: { prompt_tokens: 17, completion_tokens: 5, total_tokens: 22 },
    },
  ]

  response.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'close',
  })
  for (const chunk of chunks) response.write(`data: ${JSON.stringify(chunk)}\n\n`)
  response.end('data: [DONE]\n\n')
}

async function writeBackpressureStream(response, model, state) {
  const id = 'chatcmpl-offline-backpressure'
  const base = {
    id,
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model,
  }
  response.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'close',
  })
  response.write(`data: ${JSON.stringify({
    ...base,
    choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }],
  })}\n\n`)
  state.backpressureStarted = true

  const payload = 'B'.repeat(16 * 1024)
  for (let index = 0; index < 512; index += 1) {
    if (response.destroyed) return
    const chunk = `data: ${JSON.stringify({
      ...base,
      choices: [{ index: 0, delta: { content: payload }, finish_reason: null }],
    })}\n\n`
    state.backpressurePayloadBytes += payload.length
    if (!response.write(chunk)) {
      state.backpressureHits += 1
      await once(response, 'drain').catch(() => {})
    }
  }
  if (response.destroyed) return
  response.write(`data: ${JSON.stringify({
    ...base,
    choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
  })}\n\n`)
  response.end('data: [DONE]\n\n')
}

async function startMockUpstream() {
  const state = {
    calls: [],
    activeRequests: 0,
    maxActiveRequests: 0,
    preHeaderStarted: false,
    preHeaderCancelled: false,
    midStreamStarted: false,
    midStreamCancelled: false,
    backpressureStarted: false,
    backpressureHits: 0,
    backpressurePayloadBytes: 0,
  }

  const server = http.createServer(async (request, response) => {
    const chunks = []
    for await (const chunk of request) chunks.push(chunk)

    let body
    try {
      body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
    } catch {
      response.writeHead(400, { 'Content-Type': 'application/json' })
      response.end(JSON.stringify({ error: { message: 'Invalid JSON from Chat2API' } }))
      return
    }

    const text = messageText(body.messages)
    state.calls.push({
      method: request.method,
      url: request.url,
      headers: { ...request.headers },
      body,
      text,
    })
    state.activeRequests += 1
    state.maxActiveRequests = Math.max(state.maxActiveRequests, state.activeRequests)
    let active = true
    const finishActive = () => {
      if (!active) return
      active = false
      state.activeRequests -= 1
    }
    response.once('finish', finishActive)
    response.once('close', finishActive)

    if (request.method !== 'POST' || request.url !== '/v1/chat/completions') {
      response.writeHead(404, { 'Content-Type': 'application/json' })
      response.end(JSON.stringify({ error: { message: 'Mock route not found' } }))
      return
    }

    if (text.includes('PREHEADER_CANCEL_CASE')) {
      state.preHeaderStarted = true
      const observeCancellation = () => {
        if (!response.writableEnded) state.preHeaderCancelled = true
      }
      request.once('aborted', observeCancellation)
      response.once('close', observeCancellation)
      const timer = setTimeout(() => {
        if (response.destroyed) return
        response.writeHead(200, { 'Content-Type': 'application/json' })
        response.end(JSON.stringify(chatCompletion(body.model || upstreamModel, 'too late')))
      }, 5_000)
      timer.unref()
      return
    }

    if (text.includes('MIDSTREAM_CANCEL_CASE')) {
      state.midStreamStarted = true
      response.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'close',
      })
      const base = {
        id: 'chatcmpl-offline-cancel',
        object: 'chat.completion.chunk',
        created: Math.floor(Date.now() / 1000),
        model: body.model || upstreamModel,
      }
      response.write(`data: ${JSON.stringify({
        ...base,
        choices: [{ index: 0, delta: { content: 'first' }, finish_reason: null }],
      })}\n\n`)
      const timer = setInterval(() => {
        if (response.destroyed) return
        response.write(`data: ${JSON.stringify({
          ...base,
          choices: [{ index: 0, delta: { content: 'more' }, finish_reason: null }],
        })}\n\n`)
      }, 25)
      timer.unref()
      response.once('close', () => {
        clearInterval(timer)
        if (!response.writableEnded) state.midStreamCancelled = true
      })
      return
    }

    if (text.includes('MIDSTREAM_ERROR_CASE')) {
      response.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'close',
      })
      response.end([
        `data: ${JSON.stringify({
          error: { message: 'synthetic midstream failure', code: 'synthetic_midstream_error' },
        })}\n\n`,
        'data: [DONE]\n\n',
      ].join(''))
      return
    }

    if (text.includes('TRUNCATED_STREAM_CASE')) {
      response.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'close',
      })
      response.end(`data: ${JSON.stringify({
        id: 'chatcmpl-truncated',
        object: 'chat.completion.chunk',
        created: Math.floor(Date.now() / 1000),
        model: body.model || upstreamModel,
        choices: [{ index: 0, delta: { content: 'partial' }, finish_reason: null }],
      })}\n\n`)
      return
    }

    if (text.includes('BACKPRESSURE_CASE')) {
      await writeBackpressureStream(response, body.model || upstreamModel, state)
      return
    }

    const loadMarker = text.match(/LOAD_CASE_\d+/)?.[0]
    const longLoadMarker = text.match(/LONG_(?:RESPONSES|CLAUDE)_LOAD_\d+/)?.[0]
    // Keep synthetic load requests open long enough for the client burst to
    // overlap even when the complete server suite is CPU-scheduled together.
    if (loadMarker || longLoadMarker) await delay(100)

    let content = loadMarker ? `reply:${loadMarker}` : 'offline compatibility reply'
    if (text.startsWith('LONG_RESPONSES_CONTEXT:')) {
      content = `responses-bytes:${Buffer.byteLength(text)}`
    } else if (text.startsWith('LONG_CLAUDE_CONTEXT:')) {
      content = `claude-bytes:${Buffer.byteLength(text)}`
    } else if (text.startsWith('LONG_RESPONSES_LOAD_')) {
      content = `responses-load-bytes:${Buffer.byteLength(text)}`
    } else if (text.startsWith('LONG_CLAUDE_LOAD_')) {
      content = `claude-load-bytes:${Buffer.byteLength(text)}`
    } else if (text.includes('STATEFUL_FOLLOWUP')) {
      content = 'stateful continuation accepted'
    } else if (text.includes('FUNCTION_OUTPUT_CONTINUATION')) {
      content = 'function output accepted'
    }

    if (
      !text.includes('FUNCTION_OUTPUT_CONTINUATION')
      && (text.includes('RESPONSES_TOOL_CASE') || text.includes('CLAUDE_TOOL_CASE'))
    ) {
      response.writeHead(200, { 'Content-Type': 'application/json' })
      response.end(JSON.stringify(toolCompletion(body.model || upstreamModel)))
      return
    }

    if (text.includes('IMAGE_GENERATION_CASE')) {
      response.writeHead(200, { 'Content-Type': 'application/json' })
      response.end(JSON.stringify(imageCompletion(body.model || upstreamModel)))
      return
    }

    if (body.stream) {
      writeChatStream(response, body.model || upstreamModel, content)
      return
    }

    response.writeHead(200, { 'Content-Type': 'application/json' })
    response.end(JSON.stringify(chatCompletion(body.model || upstreamModel, content)))
  })

  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  assert.ok(address && typeof address === 'object')
  return { server, port: address.port, state }
}

function managementHeaders() {
  return {
    Authorization: `Bearer ${managementSecret}`,
    'Content-Type': 'application/json',
  }
}

function apiHeaders(apiKey, extra = {}) {
  return {
    Authorization: `Bearer ${apiKey}`,
    'Content-Type': 'application/json',
    ...extra,
  }
}

async function configureOfflineProvider(baseUrl, mockPort) {
  const providerResult = await requestJson(`${baseUrl}/v0/management/providers`, {
    method: 'POST',
    headers: managementHeaders(),
    body: JSON.stringify({
      id: providerId,
      name: 'Responses and Claude Offline Mock',
      type: 'custom',
      authType: 'token',
      apiEndpoint: `http://127.0.0.1:${mockPort}`,
      chatPath: '/v1/chat/completions',
      headers: { 'X-Offline-Compatibility-Test': 'true' },
      supportedModels: [clientModel],
      modelMappings: { [clientModel]: upstreamModel },
      credentialFields: [{
        name: 'token',
        label: 'Token',
        type: 'password',
        required: true,
      }],
    }),
  })
  assert.equal(providerResult.response.status, 201, providerResult.text)

  const accountResult = await requestJson(`${baseUrl}/v0/management/accounts`, {
    method: 'POST',
    headers: managementHeaders(),
    body: JSON.stringify({
      providerId,
      name: 'Responses and Claude Offline Account',
      credentials: { token: upstreamToken },
    }),
  })
  assert.equal(accountResult.response.status, 201, accountResult.text)

  const keyResult = await requestJson(`${baseUrl}/v0/management/api-keys`, {
    method: 'POST',
    headers: managementHeaders(),
    body: JSON.stringify({ name: 'Responses and Claude compatibility test' }),
  })
  assert.equal(keyResult.response.status, 201, keyResult.text)
  const apiKey = keyResult.body?.data?.key
  assert.match(apiKey || '', /^sk-mgmt-/)

  const configResult = await requestJson(`${baseUrl}/v0/management/config`, {
    method: 'PUT',
    headers: managementHeaders(),
    body: JSON.stringify({
      enableApiKey: true,
      retryCount: 0,
      requestTimeout: 30_000,
    }),
  })
  assert.equal(configResult.response.status, 200, configResult.text)
  return apiKey
}

function postRawPaused(url, headers, body) {
  const target = new URL(url)
  const payload = JSON.stringify(body)
  let responseResolve
  let responseReject
  const responsePromise = new Promise((resolve, reject) => {
    responseResolve = resolve
    responseReject = reject
  })
  const request = http.request({
    hostname: target.hostname,
    port: Number(target.port),
    path: target.pathname,
    method: 'POST',
    headers: {
      ...headers,
      'Content-Length': Buffer.byteLength(payload),
    },
  }, (response) => responseResolve(response))
  request.once('error', responseReject)
  request.end(payload)
  return { request, responsePromise }
}

test('Responses API and Claude/LiteLLM boundary survive compatibility, load, and context stress', { timeout: 75_000 }, async (t) => {
  if (!fs.existsSync(serverEntry)) {
    t.skip('run npm run build:server before this test')
    return
  }

  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'chat2api-responses-load-'))
  const port = await reservePort()
  const mock = await startMockUpstream()
  let child

  t.after(async () => {
    await stopChild(child)
    if (mock.server.listening) {
      await new Promise((resolve) => mock.server.close(resolve))
    }
    fs.rmSync(dataDir, { recursive: true, force: true })
  })

  child = spawn(process.execPath, [serverEntry], {
    cwd: repoRoot,
    env: {
      ...process.env,
      NODE_ENV: 'test',
      CHAT2API_HOST: '127.0.0.1',
      CHAT2API_PORT: String(port),
      CHAT2API_DATA_DIR: dataDir,
      CHAT2API_ENABLE_MANAGEMENT_API: 'true',
      CHAT2API_MANAGEMENT_SECRET: managementSecret,
      CHAT2API_ENABLE_API_KEY: 'false',
      CHAT2API_LOG_LEVEL: 'error',
      HTTP_PROXY: '',
      HTTPS_PROXY: '',
      ALL_PROXY: '',
      http_proxy: '',
      https_proxy: '',
      all_proxy: '',
      NO_PROXY: '127.0.0.1,localhost',
      no_proxy: '127.0.0.1,localhost',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  })
  const output = captureOutput(child)
  const baseUrl = `http://127.0.0.1:${port}`
  await waitForHttp(`${baseUrl}/health`, child, output)
  const apiKey = await configureOfflineProvider(baseUrl, mock.port)
  const headers = apiHeaders(apiKey)

  await t.test('returns an SDK-shaped non-streaming Responses object', async () => {
    const result = await requestJson(`${baseUrl}/v1/responses`, {
      method: 'POST',
      headers,
      signal: AbortSignal.timeout(10_000),
      body: JSON.stringify({
        model: clientModel,
        instructions: 'Keep the offline answer concise.',
        input: 'RESPONSES_NON_STREAM_CASE',
        max_output_tokens: 64,
        reasoning: { effort: 'low' },
        store: false,
      }),
    })

    assert.equal(result.response.status, 200, result.text)
    assert.match(result.response.headers.get('content-type') || '', /^application\/json/)
    assert.match(result.body?.id || '', /^resp_/)
    assert.equal(result.body?.object, 'response')
    assert.equal(result.body?.status, 'completed')
    assert.equal(result.body?.error, null)
    assert.equal(Number.isInteger(result.body?.created_at), true)
    assert.equal(responseOutputText(result.body), 'offline compatibility reply')
    assert.equal(result.body?.output?.[0]?.role, 'assistant')
    assert.equal(result.body?.output?.[0]?.status, 'completed')
    assert.deepEqual(result.body?.output?.[0]?.content?.[0]?.annotations, [])
    assert.equal(Number.isInteger(result.body?.usage?.input_tokens), true)
    assert.equal(Number.isInteger(result.body?.usage?.output_tokens), true)

    const call = mock.state.calls.at(-1)
    assert.equal(call.url, '/v1/chat/completions')
    assert.equal(call.body.model, upstreamModel)
    assert.equal(call.body.stream, false)
    assert.equal(call.body.max_tokens, 64)
    assert.equal(call.body.reasoning_effort, 'low')
    assert.equal(call.body.messages[0]?.role, 'system')
    assert.equal(call.body.messages.at(-1)?.role, 'user')
  })

  await t.test('emits the ordered typed SSE sequence expected by Responses clients', async () => {
    const response = await fetch(`${baseUrl}/v1/responses`, {
      method: 'POST',
      headers,
      signal: AbortSignal.timeout(10_000),
      body: JSON.stringify({
        model: clientModel,
        input: [{
          role: 'user',
          content: [{ type: 'input_text', text: 'RESPONSES_STREAM_CASE' }],
        }],
        stream: true,
      }),
    })
    const text = await response.text()
    assert.equal(response.status, 200, text)
    assert.match(response.headers.get('content-type') || '', /^text\/event-stream/)
    const events = parseSse(text).filter((entry) => entry.rawData !== '[DONE]')
    assertEventSubsequence(events, [
      'response.created',
      'response.in_progress',
      'response.output_item.added',
      'response.content_part.added',
      'response.output_text.delta',
      'response.output_text.done',
      'response.content_part.done',
      'response.output_item.done',
      'response.completed',
    ])
    for (const entry of events.filter((candidate) => candidate.data?.type)) {
      assert.equal(entry.event, entry.data.type, `SSE event field mismatch for ${entry.data.type}`)
    }
    assert.equal(responseStreamText(events), 'offline compatibility reply')
    const completed = events.find((entry) => entry.data?.type === 'response.completed')?.data
    assert.equal(completed?.response?.status, 'completed')
    assert.equal(responseOutputText(completed?.response), 'offline compatibility reply')
    assert.equal(completed?.response?.usage?.input_tokens, 17)
    assert.equal(completed?.response?.usage?.output_tokens, 5)
    assert.equal(completed?.response?.usage?.total_tokens, 22)
  })

  await t.test('records an SSE error once and releases the active Responses connection', async () => {
    const before = await requestJson(`${baseUrl}/v0/management/proxy/statistics`, {
      headers: managementHeaders(),
    })
    assert.equal(before.response.status, 200, before.text)

    const response = await fetch(`${baseUrl}/v1/responses`, {
      method: 'POST',
      headers,
      signal: AbortSignal.timeout(10_000),
      body: JSON.stringify({
        model: clientModel,
        input: 'MIDSTREAM_ERROR_CASE',
        stream: true,
      }),
    })
    const text = await response.text()
    assert.equal(response.status, 200, text)
    const events = parseSse(text)
    const failed = events.filter((entry) => entry.data?.type === 'response.failed')
    assert.equal(failed.length, 1)
    assert.equal(failed[0].data.response.status, 'failed')
    assert.equal(failed[0].data.response.error.code, 'synthetic_midstream_error')
    assert.equal(events.some((entry) => entry.data?.type === 'response.completed'), false)

    const after = await requestJson(`${baseUrl}/v0/management/proxy/statistics`, {
      headers: managementHeaders(),
    })
    assert.equal(after.response.status, 200, after.text)
    assert.equal(after.body.data.failedRequests, before.body.data.failedRequests + 1)
    assert.equal(after.body.data.successRequests, before.body.data.successRequests)
    assert.equal(after.body.data.activeConnections, before.body.data.activeConnections)
  })

  await t.test('does not synthesize success for an upstream stream that ends before [DONE]', async () => {
    const response = await fetch(`${baseUrl}/v1/responses`, {
      method: 'POST',
      headers,
      signal: AbortSignal.timeout(10_000),
      body: JSON.stringify({
        model: clientModel,
        input: 'TRUNCATED_STREAM_CASE',
        stream: true,
      }),
    })
    const text = await response.text()
    assert.equal(response.status, 200, text)
    const events = parseSse(text)
    const terminal = events.at(-1)?.data
    assert.equal(terminal?.type, 'response.failed')
    assert.equal(terminal?.response?.error?.code, 'incomplete_upstream_stream')
    assert.equal(events.some((entry) => entry.data?.type === 'response.completed'), false)
  })

  await t.test('continues a stored response by previous_response_id', async () => {
    const first = await requestJson(`${baseUrl}/v1/responses`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: clientModel,
        input: 'STATEFUL_FIRST_TURN',
        store: true,
      }),
    })
    assert.equal(first.response.status, 200, first.text)
    assert.match(first.body?.id || '', /^resp_/)

    const second = await requestJson(`${baseUrl}/v1/responses`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: clientModel,
        previous_response_id: first.body.id,
        input: 'STATEFUL_FOLLOWUP',
        store: true,
      }),
    })
    assert.equal(second.response.status, 200, second.text)
    assert.equal(second.body?.previous_response_id, first.body.id)
    assert.equal(responseOutputText(second.body), 'stateful continuation accepted')

    const upstream = mock.state.calls.at(-1)
    assert.deepEqual(upstream.body.messages.map((message) => message.role), [
      'user',
      'assistant',
      'user',
    ])
    assert.equal(upstream.body.messages[0].content, 'STATEFUL_FIRST_TURN')
    assert.equal(upstream.body.messages[1].content, 'offline compatibility reply')
    assert.equal(upstream.body.messages[2].content, 'STATEFUL_FOLLOWUP')
  })

  await t.test('maps Responses function tools and function outputs for a Codex tool loop', async () => {
    const toolResult = await requestJson(`${baseUrl}/v1/responses`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: clientModel,
        input: 'RESPONSES_TOOL_CASE: read the project file.',
        tools: [{
          type: 'function',
          name: 'read_file',
          description: 'Read one project file.',
          parameters: {
            type: 'object',
            properties: { path: { type: 'string' } },
            required: ['path'],
            additionalProperties: false,
          },
          strict: true,
        }],
        tool_choice: 'auto',
      }),
    })
    assert.equal(toolResult.response.status, 200, toolResult.text)
    const functionCall = toolResult.body?.output?.find((item) => item.type === 'function_call')
    assert.ok(functionCall, toolResult.text)
    assert.equal(functionCall.call_id, 'call_offline_read_1')
    assert.equal(functionCall.name, 'read_file')
    assert.deepEqual(JSON.parse(functionCall.arguments), { path: 'README.md' })
    assert.equal(functionCall.status, 'completed')

    const toolUpstream = mock.state.calls.at(-1)
    assert.equal(toolUpstream.body.tools?.[0]?.type, 'function')
    assert.equal(toolUpstream.body.tools?.[0]?.function?.name, 'read_file')
    assert.equal(toolUpstream.body.tools?.[0]?.function?.strict, true)

    const continuation = await requestJson(`${baseUrl}/v1/responses`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: clientModel,
        input: [
          {
            type: 'function_call',
            id: functionCall.id,
            call_id: functionCall.call_id,
            name: functionCall.name,
            arguments: functionCall.arguments,
          },
          {
            type: 'function_call_output',
            call_id: functionCall.call_id,
            output: 'FUNCTION_OUTPUT_CONTINUATION: file contents',
          },
        ],
      }),
    })
    assert.equal(continuation.response.status, 200, continuation.text)
    assert.equal(responseOutputText(continuation.body), 'function output accepted')
    const continuationUpstream = mock.state.calls.at(-1)
    assert.ok(continuationUpstream.body.messages.some((message) =>
      message.role === 'assistant'
      && message.tool_calls?.[0]?.id === functionCall.call_id
    ), JSON.stringify(continuationUpstream.body.messages))
    assert.ok(continuationUpstream.body.messages.some((message) =>
      message.role === 'tool'
      && message.tool_call_id === functionCall.call_id
      && String(message.content).includes('FUNCTION_OUTPUT_CONTINUATION')
    ), JSON.stringify(continuationUpstream.body.messages))
  })

  await t.test('returns generated image data as an image_generation_call item', async () => {
    const result = await requestJson(`${baseUrl}/v1/responses`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: clientModel,
        input: 'IMAGE_GENERATION_CASE: create the fixture image.',
        tools: [{
          type: 'image_generation',
          size: '1024x1024',
          quality: 'medium',
        }],
        tool_choice: 'auto',
      }),
    })
    assert.equal(result.response.status, 200, result.text)
    const imageCall = result.body?.output?.find((item) => item.type === 'image_generation_call')
    assert.ok(imageCall, result.text)
    assert.match(imageCall.id || '', /^ig_/)
    assert.equal(imageCall.status, 'completed')
    assert.equal(imageCall.result, onePixelPngBase64)
    assert.equal(imageCall.revised_prompt, 'A one-pixel offline fixture.')
    assert.equal(responseOutputText(result.body), '')
  })

  await t.test('keeps the Claude/LiteLLM Chat Completions tool boundary intact', async () => {
    const toolRequest = {
      model: clientModel,
      messages: [{ role: 'user', content: 'CLAUDE_TOOL_CASE: read README.md' }],
      tools: [{
        type: 'function',
        function: {
          name: 'read_file',
          description: 'Read one file.',
          parameters: {
            type: 'object',
            properties: { path: { type: 'string' } },
            required: ['path'],
          },
        },
      }],
      tool_choice: 'auto',
      stream: false,
    }
    const toolResult = await requestJson(`${baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: apiHeaders(apiKey, { 'User-Agent': 'litellm/1.93.0 offline-test' }),
      body: JSON.stringify(toolRequest),
    })
    assert.equal(toolResult.response.status, 200, toolResult.text)
    const call = toolResult.body?.choices?.[0]?.message?.tool_calls?.[0]
    assert.equal(call?.id, 'call_offline_read_1')
    assert.equal(call?.function?.name, 'read_file')

    const continuation = await requestJson(`${baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: apiHeaders(apiKey, { 'User-Agent': 'litellm/1.93.0 offline-test' }),
      body: JSON.stringify({
        model: clientModel,
        messages: [
          toolRequest.messages[0],
          { role: 'assistant', content: null, tool_calls: [call] },
          {
            role: 'tool',
            tool_call_id: call.id,
            content: 'FUNCTION_OUTPUT_CONTINUATION: Claude tool result',
          },
        ],
        stream: false,
      }),
    })
    assert.equal(continuation.response.status, 200, continuation.text)
    assert.equal(continuation.body?.choices?.[0]?.message?.content, 'function output accepted')
  })

  await t.test('preserves one MiB contexts on both Codex and Claude paths', async () => {
    const responsesInput = `LONG_RESPONSES_CONTEXT:${'R'.repeat(oneMiB)}`
    const responsesResult = await requestJson(`${baseUrl}/v1/responses`, {
      method: 'POST',
      headers,
      signal: AbortSignal.timeout(20_000),
      body: JSON.stringify({ model: clientModel, input: responsesInput }),
    })
    assert.equal(responsesResult.response.status, 200, responsesResult.text.slice(0, 1_000))
    assert.equal(
      responseOutputText(responsesResult.body),
      `responses-bytes:${Buffer.byteLength(responsesInput)}`,
    )
    const responsesCall = mock.state.calls.at(-1)
    assert.equal(responsesCall.text, responsesInput)

    const claudeInput = `LONG_CLAUDE_CONTEXT:${'C'.repeat(oneMiB)}`
    const claudeResult = await requestJson(`${baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: apiHeaders(apiKey, { 'User-Agent': 'litellm/1.93.0 offline-test' }),
      signal: AbortSignal.timeout(20_000),
      body: JSON.stringify({
        model: clientModel,
        messages: [{ role: 'user', content: claudeInput }],
        stream: false,
      }),
    })
    assert.equal(claudeResult.response.status, 200, claudeResult.text.slice(0, 1_000))
    assert.equal(
      claudeResult.body?.choices?.[0]?.message?.content,
      `claude-bytes:${Buffer.byteLength(claudeInput)}`,
    )
    assert.equal(mock.state.calls.at(-1).text, claudeInput)
  })

  await t.test(`preserves ${longContextConcurrency} concurrent one MiB Codex and Claude contexts`, async () => {
    mock.state.maxActiveRequests = 0
    const tasks = Array.from({ length: longContextConcurrency }, async (_, index) => {
      const useResponses = index % 2 === 0
      const prefix = useResponses
        ? `LONG_RESPONSES_LOAD_${index}:`
        : `LONG_CLAUDE_LOAD_${index}:`
      const input = `${prefix}${(useResponses ? 'R' : 'C').repeat(oneMiB)}`
      const response = await requestJson(
        useResponses ? `${baseUrl}/v1/responses` : `${baseUrl}/v1/chat/completions`,
        {
          method: 'POST',
          headers: apiHeaders(apiKey, useResponses ? {} : { 'User-Agent': 'litellm/1.93.0 long-load-test' }),
          signal: AbortSignal.timeout(30_000),
          body: JSON.stringify(useResponses
            ? { model: clientModel, input }
            : { model: clientModel, messages: [{ role: 'user', content: input }] }),
        },
      )
      assert.equal(response.response.status, 200, response.text.slice(0, 500))
      const expected = `${useResponses ? 'responses' : 'claude'}-load-bytes:${Buffer.byteLength(input)}`
      const actual = useResponses
        ? responseOutputText(response.body)
        : response.body?.choices?.[0]?.message?.content
      assert.equal(actual, expected)
    })

    await Promise.all(tasks)
    assert.ok(mock.state.maxActiveRequests >= 12,
      `Expected concurrent long contexts, observed only ${mock.state.maxActiveRequests} active upstream requests`)
    assert.equal(mock.state.activeRequests, 0)
    t.diagnostic(
      `${longContextConcurrency} one MiB requests preserved; `
      + `peak upstream concurrency ${mock.state.maxActiveRequests}`,
    )
  })

  await t.test(`handles ${stressConcurrency} mixed stream and non-stream requests concurrently`, async () => {
    const startedAt = Date.now()
    const tasks = Array.from({ length: stressConcurrency }, async (_, index) => {
      const marker = `LOAD_CASE_${index}`
      const useResponses = index % 2 === 0
      const stream = index % 4 >= 2
      const url = useResponses
        ? `${baseUrl}/v1/responses`
        : `${baseUrl}/v1/chat/completions`
      const body = useResponses
        ? { model: clientModel, input: marker, stream }
        : {
            model: clientModel,
            messages: [{ role: 'user', content: marker }],
            stream,
          }
      const response = await fetch(url, {
        method: 'POST',
        headers: apiHeaders(apiKey, useResponses ? {} : { 'User-Agent': 'litellm/1.93.0 load-test' }),
        signal: AbortSignal.timeout(20_000),
        body: JSON.stringify(body),
      })
      const text = await response.text()
      assert.equal(response.status, 200, `${marker}: ${text.slice(0, 500)}`)
      if (stream) {
        const events = parseSse(text)
        const actual = useResponses ? responseStreamText(events) : chatStreamText(events)
        assert.equal(actual, `reply:${marker}`)
        if (useResponses) {
          assert.ok(events.some((entry) => entry.data?.type === 'response.completed'))
        } else {
          assert.ok(events.some((entry) => entry.rawData === '[DONE]'))
        }
      } else {
        const parsed = JSON.parse(text)
        const actual = useResponses
          ? responseOutputText(parsed)
          : parsed.choices?.[0]?.message?.content
        assert.equal(actual, `reply:${marker}`)
      }
    })

    await Promise.all(tasks)
    const elapsedMs = Date.now() - startedAt
    assert.ok(mock.state.maxActiveRequests >= 25,
      `Expected real concurrency, observed only ${mock.state.maxActiveRequests} active upstream requests`)
    assert.ok(elapsedMs < 20_000, `Mixed local load took ${elapsedMs}ms`)
    t.diagnostic(
      `${stressConcurrency} mixed requests completed in ${elapsedMs}ms; `
      + `peak upstream concurrency ${mock.state.maxActiveRequests}`,
    )
  })

  await t.test('propagates cancellation before upstream headers and during a stream', async () => {
    const beforeHeadersController = new AbortController()
    const beforeHeadersPromise = fetch(`${baseUrl}/v1/responses`, {
      method: 'POST',
      headers,
      signal: beforeHeadersController.signal,
      body: JSON.stringify({ model: clientModel, input: 'PREHEADER_CANCEL_CASE' }),
    })
    await waitFor(
      () => mock.state.preHeaderStarted,
      2_000,
      'Pre-header cancellation request did not reach upstream',
    )
    beforeHeadersController.abort()
    await assert.rejects(beforeHeadersPromise, (error) => error?.name === 'AbortError')
    await waitFor(
      () => mock.state.preHeaderCancelled,
      2_000,
      'Pre-header client cancellation did not close the upstream request',
    )

    const midStreamController = new AbortController()
    const response = await fetch(`${baseUrl}/v1/responses`, {
      method: 'POST',
      headers,
      signal: midStreamController.signal,
      body: JSON.stringify({
        model: clientModel,
        input: 'MIDSTREAM_CANCEL_CASE',
        stream: true,
      }),
    })
    assert.equal(response.status, 200)
    const reader = response.body.getReader()
    const first = await reader.read()
    assert.equal(first.done, false)
    midStreamController.abort()
    await assert.rejects(reader.read(), (error) => error?.name === 'AbortError')
    await waitFor(
      () => mock.state.midStreamCancelled,
      2_000,
      'Mid-stream client cancellation did not close the upstream stream',
    )
  })

  await t.test('honors downstream backpressure while keeping health checks responsive', async () => {
    const paused = postRawPaused(`${baseUrl}/v1/responses`, headers, {
      model: clientModel,
      input: 'BACKPRESSURE_CASE',
      stream: true,
    })
    const response = await paused.responsePromise
    assert.equal(response.statusCode, 200)
    assert.match(String(response.headers['content-type'] || ''), /^text\/event-stream/)
    response.pause()

    await waitFor(
      () => mock.state.backpressureStarted,
      2_000,
      'Backpressure fixture did not begin writing',
    )
    await delay(250)
    const healthStartedAt = Date.now()
    const health = await fetch(`${baseUrl}/health`, { signal: AbortSignal.timeout(2_000) })
    const healthElapsedMs = Date.now() - healthStartedAt
    assert.equal(health.status, 200, await health.text())
    assert.ok(healthElapsedMs < 2_000, `Health check took ${healthElapsedMs}ms under backpressure`)

    let receivedBytes = 0
    response.on('data', (chunk) => {
      receivedBytes += chunk.length
    })
    response.resume()
    await Promise.race([
      once(response, 'end'),
      delay(20_000).then(() => assert.fail('Paused Responses stream did not complete after resume')),
    ])
    assert.ok(mock.state.backpressureHits > 0,
      'The upstream socket never observed backpressure while the client was paused')
    assert.ok(receivedBytes >= mock.state.backpressurePayloadBytes,
      `Received ${receivedBytes} bytes for ${mock.state.backpressurePayloadBytes} bytes of payload`)
  })

  assert.equal(child.exitCode, null, `Chat2API exited unexpectedly:\n${output()}`)
})
