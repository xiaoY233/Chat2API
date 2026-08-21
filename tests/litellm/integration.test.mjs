import assert from 'node:assert/strict'
import { execFile, spawn } from 'node:child_process'
import { once } from 'node:events'
import fs from 'node:fs'
import http from 'node:http'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import test from 'node:test'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

const LITELLM_BASE_IMAGE = process.env.LITELLM_TEST_BASE_IMAGE
  || 'docker.litellm.ai/berriai/litellm:v1.93.0'
const LITELLM_IMAGE = 'chat2api-litellm:integration-test'
const LITELLM_MASTER_KEY = 'sk-litellm-offline-integration-test'
const MANAGEMENT_SECRET = 'mgmt_litellm_offline_integration_test'
const SYNTHETIC_CLIENT_MODEL = 'client-connectivity-probe'
const ADAPTIVE_MODEL_ALIAS = 'chat2api-adaptive-mock'
const RESPONSES_MODEL_ALIAS = 'chat2api-responses-mock'
const MOCK_PROVIDER_ID = 'litellm-offline-openai-mock'
const MOCK_MODEL_ALIAS = 'chat2api-mock'
const MOCK_UPSTREAM_MODEL = 'mock-model'
const MOCK_UPSTREAM_KEY = 'sk-mock-upstream-not-real'
const MIDSTREAM_ERROR_MODEL = 'litellm-midstream-error-mock'
const ONE_PIXEL_PNG_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII='
const GENERATED_IMAGE_URL = 'https://images.example.invalid/qwen-generated.png'
const GENERATED_IMAGE_MARKDOWN = `![Generated image 1](${GENERATED_IMAGE_URL})`

test('bundled LiteLLM configuration keeps client probe and protocol bridge configurable', () => {
  const config = fs.readFileSync('deploy/litellm/config.yaml', 'utf8')
  const compose = fs.readFileSync('docker-compose.litellm.yml', 'utf8')
  const dockerfile = fs.readFileSync('deploy/litellm/Dockerfile', 'utf8')
  const docs = fs.readFileSync('docs/litellm.md', 'utf8')
  const patcher = fs.readFileSync(
    'deploy/litellm/apply-anthropic-midstream-error-patch.py',
    'utf8',
  )

  assert.match(config, /router_settings:\s*\r?\n\s+num_retries:\s*0\b/)
  assert.match(config, /litellm_params:[\s\S]*?num_retries:\s*0\b/)
  assert.match(config, /general_settings:[\s\S]*?pass_through_request_timeout:\s*os\.environ\/REQUEST_TIMEOUT/)
  assert.match(config, /cancel_on_disconnect:\s*true\b/)
  assert.match(config, /use_chat_completions_url_for_anthropic_messages:\s*os\.environ\/LITELLM_USE_CHAT_COMPLETIONS_URL_FOR_ANTHROPIC_MESSAGES/)
  assert.match(config, /model_name:\s*["']\*["']/)
  assert.match(config, /model:\s*["']openai\/\*["']/)
  assert.match(config, /allowed_openai_params:\s*\[["']reasoning_effort["']\]/)
  assert.match(config, /model_info:\s*\r?\n(?:\s*#.*\r?\n)*\s+supports_native_streaming:\s*true\b/)
  assert.doesNotMatch(config, /api\.anthropic\.com|claude-[\w-]+/i)
  assert.match(docs, /"CLAUDE_ENABLE_STREAM_WATCHDOG": "false"/)
  assert.match(docs, /independent of `API_FORCE_IDLE_TIMEOUT`/)

  assert.doesNotMatch(config, /CHAT2API_CONNECTIVITY_MODEL/)
  assert.doesNotMatch(compose, /CHAT2API_CONNECTIVITY_MODEL/)
  assert.doesNotMatch(compose, /Qwen3\.8-Max-Preview/)
  assert.match(compose, /LITELLM_USE_CHAT_COMPLETIONS_URL_FOR_ANTHROPIC_MESSAGES:\s*"\$\{LITELLM_USE_CHAT_COMPLETIONS_URL_FOR_ANTHROPIC_MESSAGES:-false\}"/)
  assert.match(compose, /REQUEST_TIMEOUT:\s*"\$\{LITELLM_REQUEST_TIMEOUT:-900\}"/)
  assert.match(compose, /LITELLM_ANTHROPIC_SSE_HEARTBEAT_INTERVAL_MS:\s*"\$\{LITELLM_ANTHROPIC_SSE_HEARTBEAT_INTERVAL_MS:-15000\}"/)
  assert.match(compose, /LITELLM_ANTHROPIC_COUNT_TOKENS_LOCAL_ONLY:\s*"\$\{LITELLM_ANTHROPIC_COUNT_TOKENS_LOCAL_ONLY:-true\}"/)
  assert.match(compose, /CHAT2API_BASE_URL:\s*"\$\{CHAT2API_BASE_URL:-http:\/\/host\.docker\.internal:8080\/v1\}"/)
  assert.match(compose, /extra_hosts:/)
  assert.match(compose, /urlsplit\(os\.environ\['CHAT2API_BASE_URL'\]\)/)
  assert.match(compose, /path='\/health'/)
  assert.match(docs, /Compose health check verifies both LiteLLM's own liveness endpoint and the/)
  assert.match(docs, /native setup defaults to `18080`/)
  assert.match(compose, /LITELLM_BASE_IMAGE:\s*"\$\{LITELLM_BASE_IMAGE:-docker\.litellm\.ai\/berriai\/litellm:v1\.93\.0\}"/)
  assert.match(compose, /image:\s*"\$\{LITELLM_IMAGE:-chat2api-litellm:v1\.93\.0-anthropic-stream-guard\}"/)
  const serverCompose = fs.readFileSync('docker-compose.yml', 'utf8')
  const serverDockerfile = fs.readFileSync('Dockerfile', 'utf8')
  assert.match(serverCompose, /CHAT2API_QWEN_AI_STREAM_PREFLIGHT_MAX_HOLD_MS:\s*\$\{CHAT2API_QWEN_AI_STREAM_PREFLIGHT_MAX_HOLD_MS-\}/)
  assert.doesNotMatch(serverCompose, /CHAT2API_QWEN_AI_STREAM_PREFLIGHT_MAX_HOLD_MS:\s*\$\{[^}\r\n]*:-/)
  assert.match(serverCompose, /CHAT2API_QWEN_AI_STREAM_RESUME_ATTEMPTS:\s*\$\{CHAT2API_QWEN_AI_STREAM_RESUME_ATTEMPTS:-3\}/)
  assert.match(serverCompose, /CHAT2API_QWEN_AI_STREAM_RESUME_DELAY_MS:\s*\$\{CHAT2API_QWEN_AI_STREAM_RESUME_DELAY_MS:-1000\}/)
  assert.match(serverCompose, /CHAT2API_QWEN_AI_RECOVERY_BUDGET_MS:\s*\$\{CHAT2API_QWEN_AI_RECOVERY_BUDGET_MS:-180000\}/)
  assert.match(serverCompose, /CHAT2API_QWEN_AI_WORKFLOW_RECOVERY_TIMEOUT_MS:\s*\$\{CHAT2API_QWEN_AI_WORKFLOW_RECOVERY_TIMEOUT_MS:-840000\}/)
  assert.match(serverCompose, /CHAT2API_QWEN_AI_REQUEST_MAX_BYTES:\s*\$\{CHAT2API_QWEN_AI_REQUEST_MAX_BYTES:-92160\}/)
  assert.match(serverCompose, /CHAT2API_QWEN_AI_HERMES_ROUTING_SUMMARY_MAX_CODE_POINTS:\s*\$\{CHAT2API_QWEN_AI_HERMES_ROUTING_SUMMARY_MAX_CODE_POINTS:-240\}/)
  assert.match(serverCompose, /CHAT2API_QWEN_AI_RETRY_COUNT:\s*\$\{CHAT2API_QWEN_AI_RETRY_COUNT:-1\}/)
  assert.match(serverCompose, /CHAT2API_QWEN_AI_BUSY_RETRY_COUNT:\s*\$\{CHAT2API_QWEN_AI_BUSY_RETRY_COUNT:-1\}/)
  assert.match(serverCompose, /CHAT2API_QWEN_AI_WORKFLOW_CONTINUATION_ATTEMPTS:\s*\$\{CHAT2API_QWEN_AI_WORKFLOW_CONTINUATION_ATTEMPTS:-1\}/)
  const transcriptEnvironmentNames = [
    'MAX_BYTES',
    'REQUEST_RESERVE_BYTES',
    'TOOL_RESULT_MAX_BYTES',
    'MESSAGE_MAX_BYTES',
    'MAX_FILE_PARTS',
  ].map((suffix) => ['CHAT2API_QWEN_AI', 'TRANSCRIPT', suffix].join('_'))
  for (const environmentName of transcriptEnvironmentNames) {
    assert.doesNotMatch(serverCompose, new RegExp(environmentName))
    assert.doesNotMatch(serverDockerfile, new RegExp(environmentName))
  }
  assert.match(serverCompose, /CHAT2API_QWEN_AI_CHAT_IN_PROGRESS_RETRY_ATTEMPTS:\s*\$\{CHAT2API_QWEN_AI_CHAT_IN_PROGRESS_RETRY_ATTEMPTS-\}/)
  assert.match(serverCompose, /CHAT2API_QWEN_AI_CHAT_IN_PROGRESS_RETRY_DELAY_MS:\s*\$\{CHAT2API_QWEN_AI_CHAT_IN_PROGRESS_RETRY_DELAY_MS:-1000\}/)
  assert.match(serverCompose, /CHAT2API_QWEN_AI_CHAT_IN_PROGRESS_RETRY_BUDGET_MS:\s*\$\{CHAT2API_QWEN_AI_CHAT_IN_PROGRESS_RETRY_BUDGET_MS:-300000\}/)
  assert.match(serverCompose, /CHAT2API_QWEN_AI_RESPONSES_CONTINUATION_RETRY_ATTEMPTS:\s*\$\{CHAT2API_QWEN_AI_RESPONSES_CONTINUATION_RETRY_ATTEMPTS:-0\}/)
  assert.match(serverDockerfile, /ENV CHAT2API_QWEN_AI_STREAM_RESUME_ATTEMPTS=3/)
  assert.match(serverDockerfile, /ENV CHAT2API_QWEN_AI_STREAM_RESUME_DELAY_MS=1000/)
  assert.match(serverDockerfile, /ENV CHAT2API_QWEN_AI_RECOVERY_BUDGET_MS=180000/)
  assert.match(serverDockerfile, /ENV CHAT2API_QWEN_AI_WORKFLOW_RECOVERY_TIMEOUT_MS=840000/)
  assert.match(serverDockerfile, /ENV CHAT2API_QWEN_AI_REQUEST_MAX_BYTES=92160/)
  assert.match(serverDockerfile, /ENV CHAT2API_QWEN_AI_HERMES_ROUTING_SUMMARY_MAX_CODE_POINTS=240/)
  assert.match(serverDockerfile, /ENV CHAT2API_QWEN_AI_RETRY_COUNT=1/)
  assert.match(serverDockerfile, /ENV CHAT2API_QWEN_AI_BUSY_RETRY_COUNT=1/)
  assert.match(serverDockerfile, /ENV CHAT2API_QWEN_AI_WORKFLOW_CONTINUATION_ATTEMPTS=1/)
  assert.match(serverDockerfile, /CHAT2API_QWEN_AI_CHAT_IN_PROGRESS_RETRY_BUDGET_MS=300000/)
  assert.match(serverDockerfile, /ENV CHAT2API_QWEN_AI_CHAT_IN_PROGRESS_RETRY_DELAY_MS=1000/)
  assert.match(serverDockerfile, /ENV CHAT2API_QWEN_AI_RESPONSES_CONTINUATION_RETRY_ATTEMPTS=0/)
  assert.doesNotMatch(serverDockerfile, /ENV CHAT2API_QWEN_AI_STREAM_PREFLIGHT_MAX_HOLD_MS=/)
  assert.match(dockerfile, /apply-anthropic-midstream-error-patch\.py/)
  assert.match(patcher, /Expected exactly one .*Refusing to apply a potentially unsafe patch/s)
  assert.match(patcher, /event: error\\\\ndata:/)
  assert.match(patcher, /event: ping\\\\ndata: \{\"type\":\"ping\"\}/)
  assert.match(patcher, /RESPONSES_MODULE_PATH/)
  assert.match(patcher, /RESPONSES_STREAMING_ITERATOR_MODULE_PATH/)
  assert.match(patcher, /_CHAT2API_RESPONSES_ERROR_STATUS_FIELDS/)
  assert.match(patcher, /_annotate_error_exception/)
  assert.match(patcher, /patch_responses_iterator_source/)
  assert.match(patcher, /RESPONSES_MAIN_MODULE_PATH/)
  assert.match(patcher, /responses_adapters/)
  assert.match(patcher, /RESPONSES_PATCHED_WRAPPER/)
  assert.match(patcher, /_anthropic_responses_error_event/)
  assert.match(patcher, /_queue_terminal_error/)
  assert.match(patcher, /Upstream Responses stream ended before response\.completed/)
  assert.match(patcher, /supports_native_streaming/)
  assert.match(patcher, /ANTHROPIC_ADAPTER_MODULE_PATH/)
  assert.match(patcher, /tool_result_error_by_id/)
  assert.match(patcher, /\["is_error"\] = tool_result_error_by_id/)
  assert.match(patcher, /ANTHROPIC_RESPONSES_TRANSFORMATION_MODULE_PATH/)
  assert.match(patcher, /tool_result_item\["is_error"\] = is_error/)
  assert.match(patcher, /Preserve structured Anthropic tool-result images/)
  assert.match(patcher, /ANTHROPIC_RESPONSES_ASSISTANT_ORDER_MARKER/)
  assert.match(patcher, /Flush buffered assistant text before the top-level tool call/)
  assert.match(patcher, /TOKEN_COUNTER_MODULE_PATH/)
  assert.match(patcher, /PROXY_SERVER_MODULE_PATH/)
  assert.match(patcher, /ANTHROPIC_ENDPOINTS_MODULE_PATH/)
  assert.match(patcher, /_chat2api_anthropic_image_url/)
  assert.match(patcher, /_chat2api_count_anthropic_value/)
  assert.match(patcher, /_CHAT2API_ANTHROPIC_MAX_TOKENIZED_CHARS/)
  assert.match(patcher, /_CHAT2API_ANTHROPIC_STRUCTURAL_FALLBACK_TOKENS/)
  assert.match(patcher, /_CHAT2API_ANTHROPIC_STRUCTURAL_FIELDS = frozenset\(\{"type", "cache_control"\}\)/)
  assert.match(patcher, /if \"citations\" in c/)
  assert.match(patcher, /asyncio\.to_thread/)
  assert.match(patcher, /LITELLM_ANTHROPIC_COUNT_TOKENS_LOCAL_ONLY/)
})

test('LiteLLM Anthropic patch preserves nested stream status, code, and message', async () => {
  const script = String.raw`
import importlib.util
import json

spec = importlib.util.spec_from_file_location(
    "chat2api_litellm_patch",
    "deploy/litellm/apply-anthropic-midstream-error-patch.py",
)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)

def wrapped(message, status=None, code=None):
    inner = Exception(message)
    if status is not None:
        inner.status_code = status
    if code is not None:
        inner.code = code
    outer = Exception("litellm.MidStreamFallbackError: Response API in-stream error")
    outer.status_code = 503
    outer.original_exception = inner
    return module._chat2api_anthropic_error_details(outer)

print(json.dumps([
    wrapped("Qwen recovery budget exhausted", 504, "qwen_ai_recovery_timeout"),
    wrapped("Qwen returned an undeclared native tool", 422, "malformed_tool_call"),
    wrapped("upstream socket reset ECONNRESET"),
]))
`

  const { stdout } = await execFileAsync('python', ['-c', script], {
    cwd: process.cwd(),
    windowsHide: true,
  })
  const details = JSON.parse(stdout)
  assert.deepEqual(details.map(({ status, code }) => ({ status, code })), [
    { status: 504, code: 'qwen_ai_recovery_timeout' },
    { status: 422, code: 'malformed_tool_call' },
    { status: 502, code: 'ECONNRESET' },
  ])
  assert.match(details[0].message, /recovery budget exhausted/i)
  assert.match(details[1].message, /undeclared native tool/i)
  assert.match(details[2].message, /ECONNRESET/)
})

test('LiteLLM Responses iterator patch preserves event status and codes', async () => {
  const script = String.raw`
import importlib.util
import json
from typing import Optional

spec = importlib.util.spec_from_file_location(
    "chat2api_litellm_patch",
    "deploy/litellm/apply-anthropic-midstream-error-patch.py",
)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
module.Optional = Optional
module._CLIENT_ERROR_CODES = frozenset({
    "invalid_request_error",
    "context_length_exceeded",
    "content_policy_violation",
    "model_not_found",
})
exec(module.RESPONSES_ITERATOR_ERROR_HELPERS, module.__dict__)
specs = [
    ({"type": "error", "status": 504, "code": "qwen_ai_recovery_timeout", "message": "timeout"}),
    ({"type": "response.failed", "response": {"error": {"status_code": 502, "code": "CHAT_NOT_FOUND", "message": "missing"}}}),
]
print(json.dumps([
    module._error_event_fields(
        item.get("error") or item.get("response", {}).get("error"),
        item,
    )
    for item in specs
]))
`
  const { stdout } = await execFileAsync('python', ['-c', script], {
    cwd: process.cwd(),
    windowsHide: true,
  })
  assert.deepEqual(JSON.parse(stdout), [
    ['timeout', null, 'qwen_ai_recovery_timeout', 504],
    ['missing', null, 'CHAT_NOT_FOUND', 502],
  ])
})

function captureOutput(child, maxLength = 64 * 1024) {
  let output = ''
  const append = (chunk) => {
    output = `${output}${chunk.toString()}`.slice(-maxLength)
  }

  child.stdout?.on('data', append)
  child.stderr?.on('data', append)
  return () => output
}

async function reservePorts(count) {
  const servers = []
  try {
    for (let index = 0; index < count; index += 1) {
      const server = net.createServer()
      server.unref()
      server.listen(0, '127.0.0.1')
      await once(server, 'listening')
      servers.push(server)
    }

    return servers.map((server) => {
      const address = server.address()
      assert.ok(address && typeof address === 'object')
      return address.port
    })
  } finally {
    await Promise.all(servers.map((server) => new Promise((resolve) => server.close(resolve))))
  }
}

async function stopChild(child, timeoutMs = 5_000) {
  if (!child || child.exitCode !== null) return

  const exited = once(child, 'exit')
  child.kill('SIGTERM')
  const stopped = await Promise.race([
    exited.then(() => true),
    new Promise((resolve) => setTimeout(() => resolve(false), timeoutMs)),
  ])

  if (!stopped && child.exitCode === null) {
    child.kill('SIGKILL')
    await Promise.race([
      once(child, 'exit'),
      new Promise((resolve) => setTimeout(resolve, 2_000)),
    ])
  }
}

async function waitForHttp({ url, headers, child, output, timeoutMs, serviceName }) {
  const deadline = Date.now() + timeoutMs
  let lastError = ''

  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`${serviceName} exited before becoming ready (${child.exitCode}):\n${output()}`)
    }

    try {
      const response = await fetch(url, { headers, signal: AbortSignal.timeout(2_000) })
      if (response.ok) return
      lastError = `HTTP ${response.status}: ${await response.text()}`
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error)
    }

    await new Promise((resolve) => setTimeout(resolve, 150))
  }

  throw new Error(
    `${serviceName} did not become ready: ${lastError}\n${output()}`,
  )
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

function managementHeaders() {
  return {
    Authorization: `Bearer ${MANAGEMENT_SECRET}`,
    'Content-Type': 'application/json',
  }
}

function anthropicHeaders(apiKey = LITELLM_MASTER_KEY) {
  return {
    'Content-Type': 'application/json',
    'anthropic-version': '2023-06-01',
    'x-api-key': apiKey,
  }
}

function anthropicRequest(overrides = {}) {
  return {
    model: MOCK_MODEL_ALIAS,
    max_tokens: 64,
    messages: [{ role: 'user', content: 'Reply from the offline mock.' }],
    ...overrides,
  }
}

function messageText(messages = []) {
  return messages.map((message) => {
    if (typeof message.content === 'string') return message.content
    if (!Array.isArray(message.content)) return ''
    return message.content
      .filter((part) => part?.type === 'text')
      .map((part) => part.text || '')
      .join(' ')
  }).join('\n')
}

function responsesInputText(input = []) {
  if (typeof input === 'string') return input
  if (!Array.isArray(input)) return ''
  return input.flatMap((item) => {
    if (typeof item === 'string') return [item]
    if (!item || typeof item !== 'object') return []
    const directText = [item.text, item.output]
      .filter((value) => typeof value === 'string')
    const contentText = Array.isArray(item.content)
      ? item.content
          .filter((part) => part && typeof part === 'object' && typeof part.text === 'string')
          .map((part) => part.text)
      : []
    return [...directText, ...contentText]
  }).join('\n')
}

function openAiResponse(model, content, images = undefined) {
  return {
    id: 'chatcmpl-offline-mock',
    object: 'chat.completion',
    created: 1,
    model,
    choices: [{
      index: 0,
      message: {
        role: 'assistant',
        content,
        ...(images ? { images } : {}),
      },
      finish_reason: 'stop',
    }],
    usage: {
      prompt_tokens: 11,
      completion_tokens: 5,
      total_tokens: 16,
    },
  }
}

function openAiToolResponse(model) {
  return {
    id: 'chatcmpl-offline-tool-mock',
    object: 'chat.completion',
    created: 1,
    model,
    choices: [{
      index: 0,
      message: {
        role: 'assistant',
        content: null,
        tool_calls: [{
          id: 'call_offline_weather_1',
          type: 'function',
          function: {
            name: 'get_weather',
            arguments: JSON.stringify({ city: 'Shanghai' }),
          },
        }],
      },
      finish_reason: 'tool_calls',
    }],
    usage: {
      prompt_tokens: 17,
      completion_tokens: 8,
      total_tokens: 25,
    },
  }
}

function writeOpenAiStream(response, model) {
  const base = {
    id: 'chatcmpl-offline-stream-mock',
    object: 'chat.completion.chunk',
    created: 1,
    model,
  }
  const chunks = [
    {
      ...base,
      choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }],
    },
    {
      ...base,
      choices: [{ index: 0, delta: { content: 'offline ' }, finish_reason: null }],
    },
    {
      ...base,
      choices: [{ index: 0, delta: { content: 'stream reply' }, finish_reason: null }],
    },
    {
      ...base,
      choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
    },
  ]

  response.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'close',
  })
  for (const chunk of chunks) {
    response.write(`data: ${JSON.stringify(chunk)}\n\n`)
  }
  response.end('data: [DONE]\n\n')
}

function writeOpenAiDelayedStream(response, model, delayMs = 450) {
  const base = {
    id: 'chatcmpl-offline-delayed-stream-mock',
    object: 'chat.completion.chunk',
    created: 1,
    model,
  }
  const writeChunk = (delta, finishReason = null) => {
    response.write(`data: ${JSON.stringify({
      ...base,
      choices: [{ index: 0, delta, finish_reason: finishReason }],
    })}\n\n`)
  }

  response.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'close',
  })
  writeChunk({ role: 'assistant' })
  writeChunk({ content: 'before pause ' })

  setTimeout(() => {
    if (response.destroyed) return
    writeChunk({ content: 'after pause' })
    writeChunk({}, 'stop')
    response.end('data: [DONE]\n\n')
  }, delayMs).unref()
}

function writeOpenAiResponsesDelayedStream(response, model, delayMs = 450) {
  const writeEvent = (event) => {
    response.write(`data: ${JSON.stringify(event)}\n\n`)
  }

  response.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'close',
  })

  writeEvent({
    type: 'response.created',
    response: {
      id: 'resp-offline-thinking-mock',
      object: 'response',
      model,
      status: 'in_progress',
      output: [],
    },
  })
  writeEvent({
    type: 'response.output_item.added',
    item: { type: 'reasoning', id: 'rs_offline_1' },
  })
  writeEvent({
    type: 'response.reasoning_summary_text.delta',
    item_id: 'rs_offline_1',
    delta: 'before pause',
  })

  setTimeout(() => {
    if (response.destroyed) return

    writeEvent({
      type: 'response.output_item.done',
      item: { type: 'reasoning', id: 'rs_offline_1' },
    })
    writeEvent({
      type: 'response.output_item.added',
      item: { type: 'message', id: 'msg_offline_1' },
    })
    writeEvent({
      type: 'response.output_text.delta',
      item_id: 'msg_offline_1',
      delta: 'after pause',
    })
    writeEvent({
      type: 'response.output_item.done',
      item: { type: 'message', id: 'msg_offline_1' },
    })
    writeEvent({
      type: 'response.completed',
      response: {
        id: 'resp-offline-thinking-mock',
        object: 'response',
        model,
        status: 'completed',
        output: [],
        usage: { input_tokens: 11, output_tokens: 5 },
      },
    })
    response.end()
  }, delayMs).unref()
}

function writeOpenAiResponsesMidstreamError(response, model) {
  const writeEvent = (event) => {
    response.write(`data: ${JSON.stringify(event)}\n\n`)
  }

  response.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'close',
  })
  writeEvent({
    type: 'response.created',
    response: {
      id: 'resp-offline-midstream-error',
      object: 'response',
      model,
      status: 'in_progress',
      output: [],
    },
  })
  writeEvent({
    type: 'response.output_item.added',
    output_index: 0,
    item: {
      type: 'message',
      id: 'msg_offline_midstream_error',
      status: 'in_progress',
      role: 'assistant',
      content: [],
    },
  })
  writeEvent({
    type: 'response.output_text.delta',
    item_id: 'msg_offline_midstream_error',
    output_index: 0,
    content_index: 0,
    delta: 'partial reply',
  })
  writeEvent({
    type: 'error',
    code: 'server_error',
    message: 'synthetic upstream ECONNRESET aborted',
    param: null,
  })
  response.end()
}

function writeOpenAiResponsesFailed(response, model) {
  const writeEvent = (event) => {
    response.write(`data: ${JSON.stringify(event)}\n\n`)
  }

  response.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'close',
  })
  writeEvent({
    type: 'response.created',
    response: {
      id: 'resp-offline-failed-event',
      object: 'response',
      model,
      status: 'in_progress',
      output: [],
    },
  })
  writeEvent({
    type: 'response.output_item.added',
    output_index: 0,
    item: {
      type: 'message',
      id: 'msg_offline_failed_event',
      status: 'in_progress',
      role: 'assistant',
      content: [],
    },
  })
  writeEvent({
    type: 'response.output_text.delta',
    item_id: 'msg_offline_failed_event',
    output_index: 0,
    content_index: 0,
    delta: 'partial reply',
  })
  writeEvent({
    type: 'response.failed',
    response: {
      id: 'resp-offline-failed-event',
      object: 'response',
      model,
      status: 'failed',
      output: [],
      error: {
        code: 'server_error',
        message: 'synthetic response.failed terminal',
      },
      usage: null,
    },
  })
  response.end()
}

function writeOpenAiResponsesTransportFailure(response, model) {
  const writeEvent = (event) => {
    response.write(`data: ${JSON.stringify(event)}\n\n`)
  }

  response.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'close',
  })
  writeEvent({
    type: 'response.created',
    response: {
      id: 'resp-offline-transport-error',
      object: 'response',
      model,
      status: 'in_progress',
      output: [],
    },
  })
  writeEvent({
    type: 'response.output_item.added',
    output_index: 0,
    item: {
      type: 'message',
      id: 'msg_offline_transport_error',
      status: 'in_progress',
      role: 'assistant',
      content: [],
    },
  })
  writeEvent({
    type: 'response.output_text.delta',
    item_id: 'msg_offline_transport_error',
    output_index: 0,
    content_index: 0,
    delta: 'partial reply',
  })
  setTimeout(() => response.socket?.destroy(), 25).unref()
}

function writeOpenAiMidstreamError(response, model) {
  const base = {
    id: 'chatcmpl-offline-midstream-error',
    object: 'chat.completion.chunk',
    created: 1,
    model,
  }
  const chunks = [
    {
      ...base,
      choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }],
    },
    {
      ...base,
      choices: [{ index: 0, delta: { content: 'partial reply' }, finish_reason: null }],
    },
  ]

  response.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'close',
  })
  for (const chunk of chunks) {
    response.write(`data: ${JSON.stringify(chunk)}\n\n`)
  }
  response.end([
    'event: error',
    `data: ${JSON.stringify({
      error: {
        message: 'synthetic upstream ECONNRESET aborted',
        type: 'upstream_stream_error',
        code: 'ECONNRESET',
        status: 502,
      },
    })}`,
    '',
    'data: [DONE]',
    '',
    '',
  ].join('\n'))
}

async function startMockUpstream() {
  const calls = []
  const server = http.createServer(async (request, response) => {
    const chunks = []
    for await (const chunk of request) chunks.push(chunk)

    let body = {}
    try {
      body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
    } catch {
      response.writeHead(400, { 'Content-Type': 'application/json' })
      response.end(JSON.stringify({ error: { message: 'Invalid JSON from Chat2API' } }))
      return
    }

    calls.push({
      method: request.method,
      url: request.url,
      headers: { ...request.headers },
      body,
    })

    if (
      request.method !== 'POST'
      || !['/v1/chat/completions', '/v1/responses'].includes(request.url)
    ) {
      response.writeHead(404, { 'Content-Type': 'application/json' })
      response.end(JSON.stringify({ error: { message: 'Mock route not found' } }))
      return
    }

    if (request.url === '/v1/responses') {
      const text = responsesInputText(body.input)
      if (text.includes('UPSTREAM_ERROR')) {
        response.writeHead(429, { 'Content-Type': 'application/json' })
        response.end(JSON.stringify({
          error: {
            message: 'synthetic offline rate limit',
            type: 'rate_limit_error',
            code: 'rate_limit',
          },
        }))
        return
      }

      if (body.stream && text.includes('RESPONSES_FAILED_EVENT')) {
        writeOpenAiResponsesFailed(response, body.model || MIDSTREAM_ERROR_MODEL)
        return
      }

      if (body.stream && text.includes('RESPONSES_TRANSPORT_ERROR')) {
        writeOpenAiResponsesTransportFailure(response, body.model || MIDSTREAM_ERROR_MODEL)
        return
      }

      if (body.stream && text.includes('MIDSTREAM_ERROR')) {
        writeOpenAiResponsesMidstreamError(response, body.model || MIDSTREAM_ERROR_MODEL)
        return
      }

      if (body.stream) {
        writeOpenAiResponsesDelayedStream(response, body.model || MOCK_UPSTREAM_MODEL)
        return
      }

      response.writeHead(200, { 'Content-Type': 'application/json' })
      response.end(JSON.stringify({
        id: 'resp-offline-thinking-mock',
        object: 'response',
        model: body.model || MOCK_UPSTREAM_MODEL,
        status: 'completed',
        output: [{ type: 'message', content: [{ type: 'output_text', text: 'offline response reply' }] }],
        usage: { input_tokens: 11, output_tokens: 5 },
      }))
      return
    }

    const text = messageText(body.messages)
    if (text.includes('UPSTREAM_ERROR')) {
      response.writeHead(429, { 'Content-Type': 'application/json' })
      response.end(JSON.stringify({
        error: {
          message: 'synthetic offline rate limit',
          type: 'rate_limit_error',
          code: 'rate_limit',
        },
      }))
      return
    }

    if (body.stream && text.includes('MIDSTREAM_ERROR')) {
      writeOpenAiMidstreamError(response, body.model || MIDSTREAM_ERROR_MODEL)
      return
    }

    if (body.stream && text.includes('HEARTBEAT_CASE')) {
      writeOpenAiDelayedStream(response, body.model || MOCK_UPSTREAM_MODEL)
      return
    }

    if (body.stream) {
      writeOpenAiStream(response, body.model || MOCK_UPSTREAM_MODEL)
      return
    }

    const responseBody = text.includes('TOOL_CASE')
      ? openAiToolResponse(body.model || MOCK_UPSTREAM_MODEL)
      : text.includes('IMAGE_MARKDOWN_CASE')
        ? openAiResponse(
            body.model || MOCK_UPSTREAM_MODEL,
            GENERATED_IMAGE_MARKDOWN,
            [{
              type: 'image_url',
              image_url: { url: `data:image/png;base64,${ONE_PIXEL_PNG_BASE64}` },
              source: 'qwen-ai',
            }],
          )
        : openAiResponse(body.model || MOCK_UPSTREAM_MODEL, 'offline non-stream reply')

    response.writeHead(200, { 'Content-Type': 'application/json' })
    response.end(JSON.stringify(responseBody))
  })

  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  assert.ok(address && typeof address === 'object')

  return { server, port: address.port, calls }
}

async function startRecordingProxy(targetPort) {
  const calls = []
  const server = http.createServer(async (request, response) => {
    const chunks = []
    for await (const chunk of request) chunks.push(chunk)
    const rawBody = Buffer.concat(chunks)

    let body = rawBody.toString('utf8')
    try {
      body = body ? JSON.parse(body) : null
    } catch {
      // Preserve malformed or non-JSON request bodies for diagnostics.
    }

    calls.push({
      method: request.method,
      url: request.url,
      headers: { ...request.headers },
      body,
    })

    const headers = { ...request.headers, host: `127.0.0.1:${targetPort}` }
    delete headers.connection
    delete headers['proxy-connection']

    const upstreamRequest = http.request({
      host: '127.0.0.1',
      port: targetPort,
      method: request.method,
      path: request.url,
      headers,
    }, (upstreamResponse) => {
      const responseHeaders = { ...upstreamResponse.headers }
      delete responseHeaders.connection
      response.writeHead(upstreamResponse.statusCode || 502, responseHeaders)
      upstreamResponse.pipe(response)
    })

    upstreamRequest.on('error', (error) => {
      if (response.headersSent) {
        response.destroy(error)
        return
      }
      response.writeHead(502, { 'Content-Type': 'application/json' })
      response.end(JSON.stringify({ error: { message: error.message } }))
    })
    response.on('close', () => {
      if (!response.writableEnded) upstreamRequest.destroy()
    })
    upstreamRequest.end(rawBody)
  })

  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  assert.ok(address && typeof address === 'object')

  return { server, port: address.port, calls }
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
        // Keep non-JSON markers available to assertions.
      }
      return { event, data, rawData }
    })
}

function createLiteLlmConfig(chat2ApiPort, chat2ApiKey, mockPort) {
  return [
    'model_list:',
    `  - model_name: ${JSON.stringify(MIDSTREAM_ERROR_MODEL)}`,
    '    litellm_params:',
    `      model: ${JSON.stringify(`openai/${MIDSTREAM_ERROR_MODEL}`)}`,
    `      api_base: ${JSON.stringify(`http://host.docker.internal:${mockPort}/v1`)}`,
    `      api_key: ${JSON.stringify(MOCK_UPSTREAM_KEY)}`,
    '      num_retries: 0',
    `  - model_name: ${JSON.stringify(ADAPTIVE_MODEL_ALIAS)}`,
    '    litellm_params:',
    `      model: ${JSON.stringify(`openai/${ADAPTIVE_MODEL_ALIAS}`)}`,
    `      api_base: ${JSON.stringify(`http://host.docker.internal:${mockPort}/v1`)}`,
    `      api_key: ${JSON.stringify(MOCK_UPSTREAM_KEY)}`,
    '      num_retries: 0',
    '      allowed_openai_params: ["reasoning_effort"]',
    '    model_info:',
    '      supports_reasoning: true',
    `  - model_name: ${JSON.stringify(RESPONSES_MODEL_ALIAS)}`,
    '    litellm_params:',
    `      model: ${JSON.stringify(`openai/${RESPONSES_MODEL_ALIAS}`)}`,
    `      api_base: ${JSON.stringify(`http://host.docker.internal:${mockPort}/v1`)}`,
    `      api_key: ${JSON.stringify(MOCK_UPSTREAM_KEY)}`,
    '      num_retries: 0',
    '      allowed_openai_params: ["reasoning_effort"]',
    '    model_info:',
    '      supports_reasoning: true',
    '  - model_name: "*"',
    '    litellm_params:',
    '      model: "openai/*"',
    `      api_base: ${JSON.stringify(`http://host.docker.internal:${chat2ApiPort}/v1`)}`,
    `      api_key: ${JSON.stringify(chat2ApiKey)}`,
    '      num_retries: 0',
    '      allowed_openai_params: ["reasoning_effort"]',
    '      timeout: 20',
    '    model_info:',
    '      supports_native_streaming: true',
    'general_settings:',
    `  master_key: ${JSON.stringify(LITELLM_MASTER_KEY)}`,
    '  cancel_on_disconnect: true',
    'router_settings:',
    '  num_retries: 0',
    'litellm_settings:',
    '  drop_params: false',
    '  set_verbose: false',
    // Exercise the same Responses route enabled by docker-compose.litellm.yml.
    '  use_chat_completions_url_for_anthropic_messages: false',
    '',
  ].join('\n')
}

test('patched LiteLLM v1.93.0 exposes Anthropic Messages over Chat2API completely offline', {
  timeout: 240_000,
}, async (t) => {
  const repoRoot = process.cwd()
  const serverEntry = path.join(repoRoot, 'out-server/server/index.js')
  assert.ok(
    fs.existsSync(serverEntry),
    'Missing out-server/server/index.js; run npm run build:server first',
  )

  try {
    await execFileAsync('docker', ['image', 'inspect', LITELLM_BASE_IMAGE], {
      windowsHide: true,
      timeout: 15_000,
    })
  } catch (error) {
    throw new Error(
      `The exact offline image is required. Run: docker pull ${LITELLM_BASE_IMAGE}`,
      { cause: error },
    )
  }

  await execFileAsync('docker', [
    'build',
    '--pull=false',
    '--build-arg', `LITELLM_BASE_IMAGE=${LITELLM_BASE_IMAGE}`,
    '--file', 'deploy/litellm/Dockerfile',
    '--tag', LITELLM_IMAGE,
    'deploy/litellm',
  ], {
    cwd: repoRoot,
    windowsHide: true,
    timeout: 120_000,
  })

  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'chat2api-litellm-integration-'))
  const chat2ApiDataDir = path.join(tempRoot, 'chat2api-data')
  const liteLlmConfigPath = path.join(tempRoot, 'litellm-config.yaml')
  fs.mkdirSync(chat2ApiDataDir, { recursive: true })

  const [chat2ApiPort, liteLlmPort] = await reservePorts(2)
  const containerName = `chat2api-litellm-test-${process.pid}-${Date.now()}`
  let mock
  let chat2ApiIngress
  let chat2ApiChild
  let liteLlmChild

  t.after(async () => {
    try {
      await execFileAsync('docker', ['rm', '-f', containerName], {
        windowsHide: true,
        timeout: 15_000,
      })
    } catch {
      // The --rm container may already be gone.
    }

    await stopChild(liteLlmChild)
    await stopChild(chat2ApiChild)
    if (chat2ApiIngress?.server.listening) {
      await new Promise((resolve) => chat2ApiIngress.server.close(resolve))
    }
    if (mock?.server.listening) {
      await new Promise((resolve) => mock.server.close(resolve))
    }
    fs.rmSync(tempRoot, { recursive: true, force: true })
  })

  mock = await startMockUpstream()

  chat2ApiChild = spawn(process.execPath, [serverEntry], {
    cwd: repoRoot,
    env: {
      ...process.env,
      NODE_ENV: 'test',
      CHAT2API_HOST: '0.0.0.0',
      CHAT2API_PORT: String(chat2ApiPort),
      CHAT2API_DATA_DIR: chat2ApiDataDir,
      CHAT2API_ENABLE_MANAGEMENT_API: 'true',
      CHAT2API_MANAGEMENT_SECRET: MANAGEMENT_SECRET,
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
  const chat2ApiOutput = captureOutput(chat2ApiChild)
  const chat2ApiBaseUrl = `http://127.0.0.1:${chat2ApiPort}`
  await waitForHttp({
    url: `${chat2ApiBaseUrl}/health`,
    child: chat2ApiChild,
    output: chat2ApiOutput,
    timeoutMs: 15_000,
    serviceName: 'Chat2API',
  })

  const providerResult = await requestJson(`${chat2ApiBaseUrl}/v0/management/providers`, {
    method: 'POST',
    headers: managementHeaders(),
    body: JSON.stringify({
      id: MOCK_PROVIDER_ID,
      name: 'LiteLLM Offline OpenAI Mock',
      type: 'custom',
      authType: 'token',
      apiEndpoint: `http://127.0.0.1:${mock.port}`,
      chatPath: '/v1/chat/completions',
      headers: { 'X-Offline-Integration': 'litellm' },
      supportedModels: [MOCK_MODEL_ALIAS],
      modelMappings: { [MOCK_MODEL_ALIAS]: MOCK_UPSTREAM_MODEL },
      credentialFields: [{
        name: 'token',
        label: 'Token',
        type: 'password',
        required: true,
      }],
    }),
  })
  assert.equal(providerResult.response.status, 201, providerResult.text)

  const accountResult = await requestJson(`${chat2ApiBaseUrl}/v0/management/accounts`, {
    method: 'POST',
    headers: managementHeaders(),
    body: JSON.stringify({
      providerId: MOCK_PROVIDER_ID,
      name: 'LiteLLM Offline Mock Account',
      credentials: { token: MOCK_UPSTREAM_KEY },
    }),
  })
  assert.equal(accountResult.response.status, 201, accountResult.text)

  const syntheticMappingResult = await requestJson(`${chat2ApiBaseUrl}/v0/management/model-mappings`, {
    method: 'POST',
    headers: managementHeaders(),
    body: JSON.stringify({
      requestModel: SYNTHETIC_CLIENT_MODEL,
      actualModel: MOCK_MODEL_ALIAS,
      preferredProviderId: MOCK_PROVIDER_ID,
    }),
  })
  assert.equal(syntheticMappingResult.response.status, 201, syntheticMappingResult.text)

  const keyResult = await requestJson(`${chat2ApiBaseUrl}/v0/management/api-keys`, {
    method: 'POST',
    headers: managementHeaders(),
    body: JSON.stringify({ name: 'LiteLLM offline integration' }),
  })
  assert.equal(keyResult.response.status, 201, keyResult.text)
  const chat2ApiKey = keyResult.body?.data?.key
  assert.match(chat2ApiKey || '', /^sk-mgmt-/)

  const configResult = await requestJson(`${chat2ApiBaseUrl}/v0/management/config`, {
    method: 'PUT',
    headers: managementHeaders(),
    body: JSON.stringify({
      enableApiKey: true,
      retryCount: 0,
      requestTimeout: 20_000,
    }),
  })
  assert.equal(configResult.response.status, 200, configResult.text)

  chat2ApiIngress = await startRecordingProxy(chat2ApiPort)

  fs.writeFileSync(
    liteLlmConfigPath,
    createLiteLlmConfig(chat2ApiIngress.port, chat2ApiKey, mock.port),
    'utf8',
  )

  liteLlmChild = spawn('docker', [
    'run',
    '--rm',
    '--pull=never',
    '--name', containerName,
    '--add-host', 'host.docker.internal:host-gateway',
    '-p', `127.0.0.1:${liteLlmPort}:4000`,
    '-v', `${liteLlmConfigPath}:/app/config.yaml:ro`,
    '-e', 'LITELLM_ANTHROPIC_SSE_HEARTBEAT_INTERVAL_MS=100',
    '-e', 'LITELLM_ANTHROPIC_COUNT_TOKENS_LOCAL_ONLY=true',
    LITELLM_IMAGE,
    '--config', '/app/config.yaml',
    '--host', '0.0.0.0',
    '--port', '4000',
    '--num_workers', '1',
  ], {
    cwd: repoRoot,
    env: { ...process.env },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  })
  const liteLlmOutput = captureOutput(liteLlmChild)
  const liteLlmBaseUrl = `http://127.0.0.1:${liteLlmPort}`
  await waitForHttp({
    url: `${liteLlmBaseUrl}/health/liveliness`,
    child: liteLlmChild,
    output: liteLlmOutput,
    // The upstream image can spend over a minute importing/compiling its
    // provider catalog on a cold Docker Desktop filesystem.
    timeoutMs: 150_000,
    serviceName: 'LiteLLM',
  })

  await t.test('loads zero retries into the live LiteLLM router', async () => {
    const result = await requestJson(`${liteLlmBaseUrl}/router/settings`, {
      headers: { Authorization: `Bearer ${LITELLM_MASTER_KEY}` },
    })
    assert.equal(result.response.status, 200, result.text)
    assert.equal(result.body?.current_values?.num_retries, 0, result.text)
  })

  await t.test('enforces LiteLLM and Chat2API API keys', async () => {
    const callsBefore = mock.calls.length
    const missingKey = await requestJson(`${liteLlmBaseUrl}/v1/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify(anthropicRequest()),
    })
    assert.equal(missingKey.response.status, 401, missingKey.text)
    assert.equal(typeof missingKey.body?.error?.message, 'string')

    const invalidKey = await requestJson(`${liteLlmBaseUrl}/v1/messages`, {
      method: 'POST',
      headers: anthropicHeaders('sk-invalid-offline-key'),
      body: JSON.stringify(anthropicRequest()),
    })
    // With only general_settings.master_key and no database, LiteLLM 1.93.0
    // treats an unknown key as a virtual-key lookup and reports no_db_connection
    // instead of returning the 401 used for a missing key.
    assert.equal(invalidKey.response.status, 400, invalidKey.text)
    assert.equal(invalidKey.body?.error?.type, 'no_db_connection')
    assert.equal(invalidKey.body?.error?.code, '400')
    assert.equal(mock.calls.length, callsBefore, 'Authentication failures must not reach upstream')

    const directMissingKey = await fetch(`${chat2ApiBaseUrl}/v1/models`)
    assert.equal(directMissingKey.status, 401)
    const directValidKey = await fetch(`${chat2ApiBaseUrl}/v1/models`, {
      headers: { Authorization: `Bearer ${chat2ApiKey}` },
    })
    assert.equal(directValidKey.status, 200)
  })

  await t.test('maps a client connectivity probe through Chat2API model mappings', async () => {
    const result = await requestJson(`${liteLlmBaseUrl}/v1/messages`, {
      method: 'POST',
      headers: anthropicHeaders(),
      body: JSON.stringify(anthropicRequest({
        model: SYNTHETIC_CLIENT_MODEL,
        messages: [{ role: 'user', content: 'SYNTHETIC_CONNECTIVITY_CHECK' }],
      })),
    })

    assert.equal(result.response.status, 200, result.text)
    assert.equal(result.body.type, 'message')
    assert.equal(result.body.model, SYNTHETIC_CLIENT_MODEL)
    assert.equal(mock.calls.at(-1)?.body?.model, MOCK_UPSTREAM_MODEL)
  })

  await t.test('converts a non-streaming Anthropic message through both proxies', async () => {
    const ingressCallsBefore = chat2ApiIngress.calls.length
    const result = await requestJson(`${liteLlmBaseUrl}/v1/messages`, {
      method: 'POST',
      headers: anthropicHeaders(),
      body: JSON.stringify(anthropicRequest({
        system: 'You are an offline integration test.',
        messages: [{ role: 'user', content: 'NON_STREAM_CASE' }],
      })),
    })

    assert.equal(result.response.status, 200, result.text)
    assert.equal(result.body.type, 'message')
    assert.equal(result.body.role, 'assistant')
    assert.equal(result.body.model, MOCK_MODEL_ALIAS)
    assert.equal(result.body.content?.[0]?.type, 'text')
    assert.equal(result.body.content?.[0]?.text, 'offline non-stream reply')
    assert.equal(result.body.stop_reason, 'end_turn')
    assert.equal(result.body.usage?.input_tokens, 11)
    assert.equal(result.body.usage?.output_tokens, 5)

    const ingressCalls = chat2ApiIngress.calls
      .slice(ingressCallsBefore)
      .filter((candidate) => candidate.url === '/v1/responses')
    assert.equal(ingressCalls.length, 1, JSON.stringify(chat2ApiIngress.calls.slice(ingressCallsBefore)))
    const ingressCall = ingressCalls[0]
    assert.equal(ingressCall.method, 'POST')
    assert.equal(ingressCall.headers.authorization, `Bearer ${chat2ApiKey}`)
    assert.equal(ingressCall.body.model, MOCK_MODEL_ALIAS)
    assert.notEqual(ingressCall.body.stream, true)
    assert.equal(ingressCall.body.instructions, 'You are an offline integration test.')
    assert.match(JSON.stringify(ingressCall.body.input), /NON_STREAM_CASE/)

    const call = mock.calls.at(-1)
    assert.equal(call.url, '/v1/chat/completions')
    assert.equal(call.headers.authorization, `Bearer ${MOCK_UPSTREAM_KEY}`)
    assert.equal(call.headers['x-offline-integration'], 'litellm')
    assert.equal(call.body.model, MOCK_UPSTREAM_MODEL)
    assert.equal(call.body.stream, false)
    assert.ok(call.body.messages.some((message) => message.role === 'system'))
  })

  await t.test('keeps generated-image Markdown visible to Anthropic clients', async () => {
    const ingressCallsBefore = chat2ApiIngress.calls.length
    const result = await requestJson(`${liteLlmBaseUrl}/v1/messages`, {
      method: 'POST',
      headers: anthropicHeaders(),
      body: JSON.stringify(anthropicRequest({
        messages: [{ role: 'user', content: 'IMAGE_MARKDOWN_CASE' }],
      })),
    })

    assert.equal(result.response.status, 200, result.text)
    const text = result.body.content
      ?.filter((block) => block.type === 'text')
      .map((block) => block.text || '')
      .join('')
    assert.equal(text, GENERATED_IMAGE_MARKDOWN)

    const ingressCalls = chat2ApiIngress.calls
      .slice(ingressCallsBefore)
      .filter((candidate) => candidate.url === '/v1/responses')
    assert.equal(ingressCalls.length, 1, JSON.stringify(chat2ApiIngress.calls.slice(ingressCallsBefore)))
    assert.match(JSON.stringify(ingressCalls[0].body.input), /IMAGE_MARKDOWN_CASE/)

    const upstreamCall = mock.calls.at(-1)
    assert.equal(upstreamCall.url, '/v1/chat/completions')
    assert.match(messageText(upstreamCall.body.messages), /IMAGE_MARKDOWN_CASE/)
  })

  await t.test('emits Anthropic streaming SSE events', async () => {
    const ingressCallsBefore = chat2ApiIngress.calls.length
    const response = await fetch(`${liteLlmBaseUrl}/v1/messages`, {
      method: 'POST',
      headers: anthropicHeaders(),
      body: JSON.stringify(anthropicRequest({
        stream: true,
        messages: [{ role: 'user', content: 'STREAM_CASE' }],
      })),
    })
    const text = await response.text()
    assert.equal(response.status, 200, text)
    assert.match(response.headers.get('content-type') || '', /^text\/event-stream/)

    const events = parseSse(text)
    const eventTypes = events.map((event) => event.event || event.data?.type)
    assert.ok(eventTypes.includes('message_start'), text)
    assert.ok(eventTypes.includes('content_block_start'), text)
    assert.ok(eventTypes.includes('content_block_delta'), text)
    assert.ok(eventTypes.includes('message_delta'), text)
    assert.ok(eventTypes.includes('message_stop'), text)
    assert.equal(eventTypes.filter((type) => type === 'message_start').length, 1, text)
    assert.equal(eventTypes.at(-1), 'message_stop', text)

    const ingressCalls = chat2ApiIngress.calls
      .slice(ingressCallsBefore)
      .filter((candidate) => candidate.url === '/v1/responses')
    assert.equal(ingressCalls.length, 1, JSON.stringify(chat2ApiIngress.calls.slice(ingressCallsBefore)))
    assert.equal(ingressCalls[0].body.stream, true, JSON.stringify(ingressCalls[0]))
    assert.match(JSON.stringify(ingressCalls[0].body.input), /STREAM_CASE/)
    const upstreamCall = mock.calls.at(-1)
    assert.equal(upstreamCall.body.stream, true, JSON.stringify(upstreamCall))

    const streamedText = events
      .filter((event) => (event.event || event.data?.type) === 'content_block_delta')
      .map((event) => event.data?.delta?.text || '')
      .join('')
    assert.equal(streamedText, 'offline stream reply', JSON.stringify(upstreamCall))
  })

  await t.test('emits Anthropic ping events while an upstream stream is quiet', async () => {
    const response = await fetch(`${liteLlmBaseUrl}/v1/messages`, {
      method: 'POST',
      headers: anthropicHeaders(),
      body: JSON.stringify(anthropicRequest({
        model: ADAPTIVE_MODEL_ALIAS,
        stream: true,
        thinking: { type: 'adaptive', display: 'omitted' },
        output_config: { effort: 'high' },
        messages: [{ role: 'user', content: 'HEARTBEAT_CASE' }],
      })),
      signal: AbortSignal.timeout(10_000),
    })
    const text = await response.text()
    assert.equal(response.status, 200, text)

    const call = mock.calls.at(-1)
    assert.equal(call?.url, '/v1/responses', JSON.stringify(call))
    assert.equal(call?.body?.reasoning?.effort, 'high', JSON.stringify(call))

    const events = parseSse(text)
    const pingEvents = events.filter((event) => event.event === 'ping')
    assert.ok(pingEvents.length >= 1, text)
    assert.ok(pingEvents.every((event) => event.data?.type === 'ping'), text)

    const streamedText = events
      .filter((event) => (event.event || event.data?.type) === 'content_block_delta')
      .map((event) => event.data?.delta?.text || '')
      .join('')
    assert.equal(streamedText, 'after pause')
    assert.ok(
      events.some((event) => (
        event.event === 'content_block_delta'
        && event.data?.delta?.type === 'thinking_delta'
      )),
      text,
    )
    assert.ok(
      events.findIndex((event) => event.event === 'ping')
        < events.findIndex((event) => (event.event || event.data?.type) === 'message_stop'),
      text,
    )
  })

  await t.test('emits Anthropic ping events for thinking Responses streams', async () => {
    const response = await fetch(`${liteLlmBaseUrl}/v1/messages`, {
      method: 'POST',
      headers: anthropicHeaders(),
      body: JSON.stringify(anthropicRequest({
        model: RESPONSES_MODEL_ALIAS,
        max_tokens: 256,
        stream: true,
        thinking: { type: 'enabled', budget_tokens: 64 },
        messages: [{ role: 'user', content: 'RESPONSES_HEARTBEAT_CASE' }],
      })),
      signal: AbortSignal.timeout(10_000),
    })
    const text = await response.text()
    assert.equal(response.status, 200, text)

    const call = mock.calls.at(-1)
    assert.equal(call?.url, '/v1/responses', JSON.stringify(call))

    const events = parseSse(text)
    const pingEvents = events.filter((event) => event.event === 'ping')
    assert.ok(pingEvents.length >= 1, text)
    assert.ok(pingEvents.every((event) => event.data?.type === 'ping'), text)
    assert.ok(
      events.some((event) => (
        event.event === 'content_block_delta'
        && event.data?.delta?.type === 'thinking_delta'
      )),
      text,
    )
    assert.ok(
      events.some((event) => (
        event.event === 'content_block_delta'
        && event.data?.delta?.text === 'after pause'
      )),
      text,
    )
    assert.equal(events.at(-1)?.event, 'message_stop', text)
  })

  await t.test('terminates every Responses failure mode with an Anthropic error event', async (failureTest) => {
    const cases = [
      {
        name: 'type:error event',
        prompt: 'MIDSTREAM_ERROR',
        messagePattern: /synthetic upstream ECONNRESET aborted|Response API in-stream error|MidStreamFallbackError/i,
      },
      {
        name: 'response.failed event',
        prompt: 'RESPONSES_FAILED_EVENT',
        messagePattern: /synthetic response.failed terminal|Response API in-stream error|MidStreamFallbackError/i,
      },
      {
        name: 'transport failure',
        prompt: 'RESPONSES_TRANSPORT_ERROR',
        messagePattern: /transport|connection|complete|ended|closed/i,
      },
    ]

    for (const failureCase of cases) {
      await failureTest.test(failureCase.name, async () => {
        const response = await fetch(`${liteLlmBaseUrl}/v1/messages`, {
          method: 'POST',
          headers: anthropicHeaders(),
          body: JSON.stringify(anthropicRequest({
            model: MIDSTREAM_ERROR_MODEL,
            stream: true,
            messages: [{ role: 'user', content: failureCase.prompt }],
          })),
          signal: AbortSignal.timeout(10_000),
        })
        const text = await response.text()
        assert.equal(response.status, 200, text)

        const events = parseSse(text)
        const errorEvents = events.filter((event) => event.event === 'error')
        assert.equal(errorEvents.length, 1, text)
        assert.equal(events.at(-1)?.event, 'error', text)
        assert.equal(errorEvents[0].data?.type, 'error', text)
        assert.equal(errorEvents[0].data?.error?.type, 'api_error', text)
        assert.match(errorEvents[0].data?.error?.message || '', failureCase.messagePattern)
        assert.equal(events.filter((event) => event.event === 'message_start').length, 1, text)
        assert.equal(events.some((event) => event.event === 'message_stop'), false, text)
        assert.ok(
          events.some((event) => (
            event.event === 'content_block_delta'
            && event.data?.delta?.text === 'partial reply'
          )),
          text,
        )
      })
    }
  })

  await t.test('maps tools and a forced tool_choice to Anthropic tool_use', async () => {
    const ingressCallsBefore = chat2ApiIngress.calls.length
    const result = await requestJson(`${liteLlmBaseUrl}/v1/messages`, {
      method: 'POST',
      headers: anthropicHeaders(),
      body: JSON.stringify(anthropicRequest({
        messages: [{ role: 'user', content: 'TOOL_CASE: weather in Shanghai' }],
        tools: [{
          name: 'get_weather',
          description: 'Get the current weather for a city.',
          input_schema: {
            type: 'object',
            properties: { city: { type: 'string' } },
            required: ['city'],
          },
        }],
        tool_choice: { type: 'tool', name: 'get_weather' },
      })),
    })

    assert.equal(result.response.status, 200, result.text)
    assert.equal(result.body.stop_reason, 'tool_use')
    const toolUse = result.body.content?.find((block) => block.type === 'tool_use')
    assert.ok(toolUse, result.text)
    assert.equal(toolUse.id, 'call_offline_weather_1')
    assert.equal(toolUse.name, 'get_weather')
    assert.deepEqual(toolUse.input, { city: 'Shanghai' })

    const ingressCalls = chat2ApiIngress.calls
      .slice(ingressCallsBefore)
      .filter((candidate) => candidate.url === '/v1/responses')
    assert.equal(ingressCalls.length, 1, JSON.stringify(chat2ApiIngress.calls.slice(ingressCallsBefore)))
    const ingressCall = ingressCalls[0]
    assert.equal(ingressCall.body.tools?.[0]?.type, 'function')
    assert.equal(ingressCall.body.tools?.[0]?.name, 'get_weather')
    assert.deepEqual(ingressCall.body.tool_choice, {
      type: 'function',
      name: 'get_weather',
    })

    const call = mock.calls.at(-1)
    assert.equal(call.body.tools?.[0]?.function?.name, 'get_weather')
    assert.deepEqual(call.body.tool_choice, {
      type: 'function',
      function: { name: 'get_weather' },
    })
  })

  await t.test('preserves assistant text, tool_use, and tool_result order through Responses', async () => {
    const toolUseId = 'call_offline_weather_previous'
    const ingressCallsBefore = chat2ApiIngress.calls.length
    const result = await requestJson(`${liteLlmBaseUrl}/v1/messages`, {
      method: 'POST',
      headers: anthropicHeaders(),
      body: JSON.stringify(anthropicRequest({
        messages: [
          { role: 'user', content: 'Check the weather with the available tool.' },
          {
            role: 'assistant',
            content: [
              { type: 'text', text: 'I will check the weather now.' },
              {
                type: 'tool_use',
                id: toolUseId,
                name: 'get_weather',
                input: { city: 'Shanghai' },
              },
            ],
          },
          {
            role: 'user',
            content: [{
              type: 'tool_result',
              tool_use_id: toolUseId,
              content: 'Sunny, 25 C',
              is_error: true,
            }],
          },
        ],
        tools: [{
          name: 'get_weather',
          description: 'Get the current weather for a city.',
          input_schema: {
            type: 'object',
            properties: { city: { type: 'string' } },
            required: ['city'],
          },
        }],
      })),
    })

    assert.equal(result.response.status, 200, result.text)
    assert.equal(result.body.content?.[0]?.text, 'offline non-stream reply')

    const ingressCalls = chat2ApiIngress.calls
      .slice(ingressCallsBefore)
      .filter((candidate) => candidate.url === '/v1/responses')
    assert.equal(ingressCalls.length, 1, JSON.stringify(chat2ApiIngress.calls.slice(ingressCallsBefore)))
    const ingressInput = ingressCalls[0].body.input
    const assistantTextIndex = ingressInput.findIndex((item) => (
      item.type === 'message'
      && item.role === 'assistant'
      && item.content?.some((part) => (
        part.type === 'output_text' && part.text === 'I will check the weather now.'
      ))
    ))
    const functionCallIndex = ingressInput.findIndex((item) => item.type === 'function_call')
    const functionOutputIndex = ingressInput.findIndex((item) => item.type === 'function_call_output')
    assert.ok(assistantTextIndex >= 0, JSON.stringify(ingressInput))
    assert.ok(assistantTextIndex < functionCallIndex, JSON.stringify(ingressInput))
    assert.ok(functionCallIndex < functionOutputIndex, JSON.stringify(ingressInput))
    const functionCall = ingressInput[functionCallIndex]
    assert.ok(functionCall, JSON.stringify(ingressInput))
    assert.equal(functionCall.call_id, toolUseId)
    assert.equal(functionCall.name, 'get_weather')
    assert.deepEqual(JSON.parse(functionCall.arguments || '{}'), { city: 'Shanghai' })
    const functionOutput = ingressInput[functionOutputIndex]
    assert.ok(functionOutput, JSON.stringify(ingressInput))
    assert.equal(functionOutput.call_id, toolUseId)
    assert.equal(functionOutput.output, 'Sunny, 25 C')
    assert.equal(functionOutput.is_error, true)

    const call = mock.calls.at(-1)
    const assistantMessage = call.body.messages.find((message) =>
      message.role === 'assistant' && Array.isArray(message.tool_calls)
    )
    assert.ok(assistantMessage, JSON.stringify(call.body.messages))
    assert.equal(assistantMessage.tool_calls[0]?.id, toolUseId)
    assert.equal(assistantMessage.tool_calls[0]?.type, 'function')
    assert.equal(assistantMessage.tool_calls[0]?.function?.name, 'get_weather')
    assert.deepEqual(
      JSON.parse(assistantMessage.tool_calls[0]?.function?.arguments || '{}'),
      { city: 'Shanghai' },
    )

    const toolMessage = call.body.messages.find((message) => message.role === 'tool')
    assert.ok(toolMessage, JSON.stringify(call.body.messages))
    assert.equal(toolMessage.tool_call_id, toolUseId)
    assert.equal(toolMessage.content, 'Sunny, 25 C')
    assert.equal(toolMessage.is_error, true)
  })

  await t.test('preserves tool_result call IDs and contents through Responses', async () => {
    for (const isError of [true, false, undefined]) {
      const toolUseId = `call_offline_error_state_${String(isError)}`
      const expectedOutput = `tool result state ${String(isError)}`
      const toolResult = {
        type: 'tool_result',
        tool_use_id: toolUseId,
        content: expectedOutput,
        ...(isError === undefined ? {} : { is_error: isError }),
      }
      const ingressCallsBefore = chat2ApiIngress.calls.length
      const result = await requestJson(`${liteLlmBaseUrl}/v1/messages`, {
        method: 'POST',
        headers: anthropicHeaders(),
        body: JSON.stringify(anthropicRequest({
          messages: [
            { role: 'user', content: 'Exercise the declared tool.' },
            {
              role: 'assistant',
              content: [{
                type: 'tool_use',
                id: toolUseId,
                name: 'get_weather',
                input: { city: 'Shanghai' },
              }],
            },
            { role: 'user', content: [toolResult] },
          ],
          tools: [{
            name: 'get_weather',
            description: 'Get the current weather for a city.',
            input_schema: {
              type: 'object',
              properties: { city: { type: 'string' } },
              required: ['city'],
            },
          }],
        })),
      })

      assert.equal(result.response.status, 200, result.text)
      const ingressCalls = chat2ApiIngress.calls
        .slice(ingressCallsBefore)
        .filter((candidate) => candidate.url === '/v1/responses')
      assert.equal(ingressCalls.length, 1, JSON.stringify(chat2ApiIngress.calls.slice(ingressCallsBefore)))
      const functionOutput = ingressCalls[0].body.input.find((item) => (
        item.type === 'function_call_output' && item.call_id === toolUseId
      ))
      assert.ok(functionOutput, JSON.stringify(ingressCalls[0].body.input))
      assert.equal(functionOutput.output, expectedOutput)
      if (isError === undefined) {
        assert.equal(Object.prototype.hasOwnProperty.call(functionOutput, 'is_error'), false)
      } else {
        assert.equal(functionOutput.is_error, isError)
      }

      const toolMessage = mock.calls.at(-1)?.body?.messages?.find((message) =>
        message.role === 'tool' && message.tool_call_id === toolUseId
      )
      assert.ok(toolMessage, JSON.stringify(mock.calls.at(-1)?.body?.messages))
      assert.equal(toolMessage.content, expectedOutput)
      if (isError === undefined) {
        assert.equal(Object.prototype.hasOwnProperty.call(toolMessage, 'is_error'), false)
      } else {
        assert.equal(toolMessage.is_error, isError)
      }
    }
  })

  await t.test('preserves image content inside Anthropic tool_result through Responses', async () => {
    const toolUseId = 'call_offline_read_screenshot'
    const imageUrl = `data:image/png;base64,${ONE_PIXEL_PNG_BASE64}`
    const ingressCallsBefore = chat2ApiIngress.calls.length
    const mockCallsBefore = mock.calls.length
    const result = await requestJson(`${liteLlmBaseUrl}/v1/messages`, {
      method: 'POST',
      headers: anthropicHeaders(),
      body: JSON.stringify(anthropicRequest({
        messages: [
          { role: 'user', content: 'Inspect the screenshot with the available tool.' },
          {
            role: 'assistant',
            content: [{
              type: 'tool_use',
              id: toolUseId,
              name: 'Read',
              input: { file_path: 'screenshot.png' },
            }],
          },
          {
            role: 'user',
            content: [{
              type: 'tool_result',
              tool_use_id: toolUseId,
              is_error: false,
              content: [
                { type: 'text', text: 'Screenshot captured.' },
                {
                  type: 'image',
                  source: {
                    type: 'base64',
                    media_type: 'image/png',
                    data: ONE_PIXEL_PNG_BASE64,
                  },
                },
              ],
            }],
          },
        ],
        tools: [{
          name: 'Read',
          description: 'Read a local file.',
          input_schema: {
            type: 'object',
            properties: { file_path: { type: 'string' } },
            required: ['file_path'],
          },
        }],
      })),
    })

    assert.equal(result.response.status, 200, result.text)
    const ingressCalls = chat2ApiIngress.calls
      .slice(ingressCallsBefore)
      .filter((candidate) => candidate.url === '/v1/responses')
    assert.equal(ingressCalls.length, 1, JSON.stringify(chat2ApiIngress.calls.slice(ingressCallsBefore)))
    const functionOutput = ingressCalls[0].body.input.find((item) => (
      item.type === 'function_call_output' && item.call_id === toolUseId
    ))
    assert.deepEqual(functionOutput, {
      type: 'function_call_output',
      call_id: toolUseId,
      output: [
        { type: 'input_text', text: 'Screenshot captured.' },
        { type: 'input_image', image_url: imageUrl },
      ],
      is_error: false,
    })

    const upstreamCall = mock.calls.slice(mockCallsBefore).at(-1)
    assert.ok(upstreamCall, JSON.stringify(mock.calls.slice(mockCallsBefore)))
    const toolMessageIndex = upstreamCall.body.messages.findIndex((message) => (
      message.role === 'tool' && message.tool_call_id === toolUseId
    ))
    const imageMessageIndex = upstreamCall.body.messages.findIndex((message) => (
      message.role === 'user'
      && Array.isArray(message.content)
      && message.content.some((part) => part?.type === 'image_url')
    ))
    assert.ok(toolMessageIndex >= 0, JSON.stringify(upstreamCall.body.messages))
    assert.ok(imageMessageIndex > toolMessageIndex, JSON.stringify(upstreamCall.body.messages))
    const toolMessage = upstreamCall.body.messages[toolMessageIndex]
    assert.equal(toolMessage.content, 'Screenshot captured.')
    assert.equal(toolMessage.is_error, false)
    assert.equal(JSON.stringify(toolMessage).includes(ONE_PIXEL_PNG_BASE64), false)
    const imageMessage = upstreamCall.body.messages[imageMessageIndex]
    const imagePart = imageMessage.content.find((part) => part?.type === 'image_url')
    assert.equal(imagePart?.image_url?.url, imageUrl)
  })

  await t.test('counts Anthropic text, system, and tools locally without an upstream probe', async () => {
    const callsBefore = mock.calls.length
    const baseline = await requestJson(`${liteLlmBaseUrl}/v1/messages/count_tokens`, {
      method: 'POST',
      headers: anthropicHeaders(),
      body: JSON.stringify({
        model: MOCK_MODEL_ALIAS,
        messages: [{ role: 'user', content: 'Count these tokens without an upstream call.' }],
      }),
    })

    const result = await requestJson(`${liteLlmBaseUrl}/v1/messages/count_tokens`, {
      method: 'POST',
      headers: anthropicHeaders(),
      body: JSON.stringify({
        model: MOCK_MODEL_ALIAS,
        system: 'Offline token counting system prompt.',
        messages: [{ role: 'user', content: 'Count these tokens without an upstream call.' }],
        tools: [{
          name: 'get_weather',
          description: 'Get weather.',
          input_schema: {
            type: 'object',
            properties: { city: { type: 'string' } },
          },
        }],
      }),
    })

    assert.equal(baseline.response.status, 200, baseline.text)
    assert.equal(result.response.status, 200, result.text)
    assert.equal(Number.isInteger(baseline.body?.input_tokens), true, baseline.text)
    assert.equal(Number.isInteger(result.body?.input_tokens), true, result.text)
    assert.ok(result.body.input_tokens > baseline.body.input_tokens, result.text)
    assert.equal(mock.calls.length, callsBefore)
  })

  await t.test('estimates a 512k-scale ASCII Anthropic request in Qwen token units', async () => {
    const callsBefore = mock.calls.length
    const corpus = 'A'.repeat(3 * 512 * 1024)
    const result = await requestJson(`${liteLlmBaseUrl}/v1/messages/count_tokens`, {
      method: 'POST',
      headers: anthropicHeaders(),
      signal: AbortSignal.timeout(30_000),
      body: JSON.stringify({
        model: MOCK_MODEL_ALIAS,
        messages: [{ role: 'user', content: corpus }],
      }),
    })

    assert.equal(result.response.status, 200, result.text)
    assert.equal(Number.isInteger(result.body?.input_tokens), true, result.text)
    assert.ok(result.body.input_tokens >= 500_000, result.text)
    assert.ok(result.body.input_tokens <= 550_000, result.text)
    assert.equal(mock.calls.length, callsBefore)
  })

  await t.test('counts Anthropic base64 images locally', async () => {
    const callsBefore = mock.calls.length
    const result = await requestJson(`${liteLlmBaseUrl}/v1/messages/count_tokens`, {
      method: 'POST',
      headers: anthropicHeaders(),
      body: JSON.stringify({
        model: MOCK_MODEL_ALIAS,
        messages: [{
          role: 'user',
          content: [{
            type: 'image',
            source: {
              type: 'base64',
              media_type: 'image/png',
              data: ONE_PIXEL_PNG_BASE64,
            },
          }],
        }],
      }),
    })

    assert.equal(result.response.status, 200, result.text)
    assert.equal(Number.isInteger(result.body?.input_tokens), true, result.text)
    assert.ok(result.body.input_tokens > 0, result.text)
    assert.equal(mock.calls.length, callsBefore)
  })

  await t.test('counts Anthropic file images without resolving opaque file IDs', async () => {
    const callsBefore = mock.calls.length
    const countFileImage = async (content) => {
      const result = await requestJson(`${liteLlmBaseUrl}/v1/messages/count_tokens`, {
        method: 'POST',
        headers: anthropicHeaders(),
        body: JSON.stringify({
          model: MOCK_MODEL_ALIAS,
          messages: [{ role: 'user', content }],
        }),
      })

      assert.equal(result.response.status, 200, result.text)
      assert.equal(Number.isInteger(result.body?.input_tokens), true, result.text)
      assert.ok(result.body.input_tokens > 0, result.text)
      return result.body.input_tokens
    }

    const emptyTokens = await countFileImage([])
    const base64Tokens = await countFileImage([{
      type: 'image',
      source: {
        type: 'base64',
        media_type: 'image/png',
        data: ONE_PIXEL_PNG_BASE64,
      },
    }])
    const urlTokens = await countFileImage([{
      type: 'image',
      source: { type: 'url', url: 'https://example.invalid/image.png' },
    }])
    const shortFileTokens = await countFileImage([{
      type: 'image',
      source: { type: 'file', file_id: 'file_image_short' },
    }])
    const longFileTokens = await countFileImage([{
      type: 'image',
      source: { type: 'file', file_id: `file_${'opaque'.repeat(4096)}` },
    }])
    const nestedFileTokens = await countFileImage([{
      type: 'tool_result',
      tool_use_id: 'tool_file_image',
      content: [{
        type: 'image',
        source: { type: 'file', file_id: 'file_image_nested' },
      }],
    }])
    const nestedEmptyTokens = await countFileImage([{
      type: 'tool_result',
      tool_use_id: 'tool_file_image',
      content: [],
    }])

    assert.ok(shortFileTokens > emptyTokens)
    assert.equal(shortFileTokens, base64Tokens)
    assert.equal(shortFileTokens, urlTokens)
    assert.equal(longFileTokens, shortFileTokens)
    assert.ok(nestedFileTokens > nestedEmptyTokens)
    assert.equal(mock.calls.length, callsBefore)
  })

  await t.test('counts extended Anthropic blocks with bounded conservative fallbacks', async () => {
    const callsBefore = mock.calls.length
    const countBlock = async (name, content) => {
      const result = await requestJson(`${liteLlmBaseUrl}/v1/messages/count_tokens`, {
        method: 'POST',
        headers: anthropicHeaders(),
        body: JSON.stringify({
          model: MOCK_MODEL_ALIAS,
          messages: [{ role: 'user', content: [content] }],
        }),
      })

      assert.equal(result.response.status, 200, `${name}: ${result.text}`)
      assert.equal(Number.isInteger(result.body?.input_tokens), true, `${name}: ${result.text}`)
      assert.ok(result.body.input_tokens > 0, `${name}: ${result.text}`)
      return result.body.input_tokens
    }

    const shortDocumentTokens = await countBlock('short document', {
      type: 'document',
      source: {
        type: 'base64',
        media_type: 'application/pdf',
        data: 'JVBERiQ=',
      },
      title: 'Offline document',
      context: 'Reference material.',
    })
    const longDocumentTokens = await countBlock('long document', {
      type: 'document',
      source: {
        type: 'base64',
        media_type: 'application/pdf',
        data: 'A'.repeat(1024 * 1024),
      },
      title: 'Offline document',
      context: 'Reference material.',
    })
    assert.ok(longDocumentTokens > shortDocumentTokens)

    const textDocumentTokens = await countBlock('text document', {
      type: 'document',
      source: {
        type: 'text',
        media_type: 'text/plain',
        data: 'This source text must contribute to the count.',
      },
    })
    assert.ok(textDocumentTokens > 0)

    const shortCitationTokens = await countBlock('short citation', {
      type: 'text',
      text: 'Answer with a cited source.',
      citations: [{
        type: 'char_location',
        cited_text: 'Short cited passage.',
        document_index: 0,
        document_title: 'Offline source',
        start_char_index: 0,
        end_char_index: 21,
      }],
    })
    const longCitationTokens = await countBlock('long citation', {
      type: 'text',
      text: 'Answer with a cited source.',
      citations: [{
        type: 'char_location',
        cited_text: 'A'.repeat(4096),
        document_index: 0,
        document_title: 'Offline source',
        start_char_index: 0,
        end_char_index: 4096,
      }],
    })
    assert.ok(longCitationTokens > shortCitationTokens)

    const fileDocumentTokens = await countBlock('file document', {
      type: 'document',
      source: {
        type: 'file',
        file_id: 'file_document_opaque_identifier',
      },
    })
    assert.ok(fileDocumentTokens > textDocumentTokens)
    const urlDocumentTokens = await countBlock('url document', {
      type: 'document',
      source: {
        type: 'url',
        url: 'https://example.invalid/reference.pdf',
      },
    })
    assert.ok(urlDocumentTokens > textDocumentTokens)

    const emptyServerToolTokens = await countBlock('empty server tool use', {
      type: 'server_tool_use',
      id: 'server_tool_opaque_id',
      name: 'web_search',
      input: {},
    })
    const serverToolTokens = await countBlock('scalar server tool use', {
      type: 'server_tool_use',
      id: 'server_tool_opaque_id',
      name: 'web_search',
      input: { attempts: 123456789, enabled: true },
    })
    const longKeyServerToolTokens = await countBlock('long-key server tool use', {
      type: 'server_tool_use',
      id: 'server_tool_opaque_id',
      name: 'web_search',
      input: { ['query_key_'.repeat(1024)]: false },
    })
    assert.ok(serverToolTokens > emptyServerToolTokens)
    assert.ok(longKeyServerToolTokens > serverToolTokens)

    const shortToolUseTokens = await countBlock('short tool use', {
      type: 'tool_use',
      id: 'tool_use_opaque_id',
      name: 'web_search',
      input: { query: 'short' },
    })
    const longToolUseTokens = await countBlock('long tool use', {
      type: 'tool_use',
      id: 'tool_use_opaque_id',
      name: 'web_search',
      input: { query: 'A'.repeat(1024 * 1024) },
    })
    assert.ok(longToolUseTokens > shortToolUseTokens)

    const shortToolResultTokens = await countBlock('short tool result', {
      type: 'tool_result',
      tool_use_id: 'tool_use_opaque_id',
      content: [{ type: 'text', text: 'short result' }],
    })
    const longToolResultTokens = await countBlock('long tool result', {
      type: 'tool_result',
      tool_use_id: 'tool_use_opaque_id',
      content: [{ type: 'text', text: 'A'.repeat(1024 * 1024) }],
    })
    assert.ok(longToolResultTokens > shortToolResultTokens)

    const webSearchTokens = await countBlock('web search result', {
      type: 'web_search_tool_result',
      tool_use_id: 'server_tool_opaque_id',
      content: [{
        type: 'web_search_result',
        title: 'Offline result title',
        url: 'https://example.invalid/result',
        encrypted_content: 'A'.repeat(32 * 1024),
      }],
    })
    const shortEncryptedWebSearchTokens = await countBlock('short encrypted web search result', {
      type: 'web_search_tool_result',
      tool_use_id: 'server_tool_opaque_id',
      content: [{
        type: 'web_search_result',
        title: 'Offline result title',
        url: 'https://example.invalid/result',
        encrypted_content: 'opaque',
      }],
    })
    assert.equal(webSearchTokens, shortEncryptedWebSearchTokens)

    const shortSearchSourceTokens = await countBlock('short search source', {
      type: 'search_result',
      source: 's',
      title: 'Offline search result',
      content: [{ type: 'text', text: 'Result body.' }],
    })
    const longSearchSourceTokens = await countBlock('long search source', {
      type: 'search_result',
      source: 'source-value-'.repeat(1024),
      title: 'Offline search result',
      content: [{ type: 'text', text: 'Result body.' }],
    })
    assert.ok(longSearchSourceTokens > shortSearchSourceTokens)

    const shortRedactedTokens = await countBlock('short redacted thinking', {
      type: 'redacted_thinking',
      data: 'opaque',
    })
    const longRedactedTokens = await countBlock('long redacted thinking', {
      type: 'redacted_thinking',
      data: 'A'.repeat(32 * 1024),
    })
    assert.equal(longRedactedTokens, shortRedactedTokens)
    assert.ok(textDocumentTokens > shortRedactedTokens)
    assert.ok(serverToolTokens > shortRedactedTokens)
    assert.ok(webSearchTokens > shortRedactedTokens)

    const containerUploadTokens = await countBlock('container upload', {
      type: 'container_upload',
      file_id: 'file_opaque_identifier',
    })
    assert.ok(containerUploadTokens > shortRedactedTokens)

    const smallFuturePayloadTokens = await countBlock('small bounded future payload', {
      type: 'future_payload',
      payload: 'A'.repeat(64 * 1024),
    })
    const futurePayloadTokens = await countBlock('bounded future payload', {
      type: 'future_payload',
      payload: 'A'.repeat(1024 * 1024),
    })
    assert.ok(futurePayloadTokens > smallFuturePayloadTokens)
    assert.ok(futurePayloadTokens > 0)

    let deeplyNested = { type: 'future_nested', content: 'Counted before the depth guard.' }
    for (let index = 0; index < 80; index += 1) {
      deeplyNested = { type: 'future_nested', content: [deeplyNested] }
    }
    const deeplyNestedTokens = await countBlock('deeply nested future payload', deeplyNested)
    assert.ok(deeplyNestedTokens > 0)

    const manyNodes = Object.fromEntries(
      Array.from({ length: 20_050 }, (_, index) => [`field_${index}`, index]),
    )
    const manyNodeTokens = await countBlock('node-bounded future payload', {
      type: 'future_nodes',
      payload: manyNodes,
    })
    assert.ok(manyNodeTokens > 0)
    assert.equal(mock.calls.length, callsBefore)
  })

  await t.test('keeps the event loop responsive during large local token counts', async () => {
    const countPromise = requestJson(`${liteLlmBaseUrl}/v1/messages/count_tokens`, {
      method: 'POST',
      headers: anthropicHeaders(),
      signal: AbortSignal.timeout(30_000),
      body: JSON.stringify({
        model: MOCK_MODEL_ALIAS,
        messages: [{ role: 'user', content: '测'.repeat(64 * 1024) }],
      }),
    })

    await new Promise((resolve) => setTimeout(resolve, 50))
    const startedAt = Date.now()
    const liveliness = await fetch(`${liteLlmBaseUrl}/health/liveliness`, {
      signal: AbortSignal.timeout(2_000),
    })
    const elapsedMs = Date.now() - startedAt
    assert.equal(liveliness.status, 200, await liveliness.text())
    assert.ok(elapsedMs < 2_000, `liveliness took ${elapsedMs}ms`)

    const countResult = await countPromise
    assert.equal(countResult.response.status, 200, countResult.text)
    assert.equal(Number.isInteger(countResult.body?.input_tokens), true, countResult.text)
  })

  await t.test('records the LiteLLM v1.93.0 upstream error envelope', async () => {
    const result = await requestJson(`${liteLlmBaseUrl}/v1/messages`, {
      method: 'POST',
      headers: anthropicHeaders(),
      body: JSON.stringify(anthropicRequest({
        messages: [{ role: 'user', content: 'UPSTREAM_ERROR' }],
      })),
    })

    assert.equal(result.response.status, 429, result.text)
    // LiteLLM 1.93.0 maps successful /v1/messages responses to Anthropic but
    // its generic ProxyException handler still emits this OpenAI-style error
    // envelope. Keep the black-box assertion explicit so a future upgrade that
    // fixes the wire format is visible rather than silently changing behavior.
    assert.deepEqual(Object.keys(result.body), ['error'])
    assert.equal(result.body.error?.type, 'throttling_error', result.text)
    assert.equal(result.body.error?.code, '429', result.text)
    assert.match(result.body.error?.message || '', /synthetic offline rate limit/i)
  })

  t.diagnostic(`LiteLLM image: ${LITELLM_IMAGE}`)
  t.diagnostic(`Offline OpenAI upstream calls: ${mock.calls.length}`)
  t.diagnostic('LiteLLM 1.93.0 without a DB returns 400/no_db_connection for unknown keys')
  t.diagnostic('LiteLLM 1.93.0 emits an OpenAI-style error envelope for /v1/messages upstream errors')
})
