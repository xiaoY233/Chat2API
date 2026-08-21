import assert from 'node:assert/strict'

const baseUrl = (process.env.CHAT2API_CLAUDE_BASE_URL || 'http://127.0.0.1:4000').replace(/\/$/, '')
const apiKey = process.env.CHAT2API_CLAUDE_API_KEY || 'sk-litellm-local'
const model = process.env.CHAT2API_CLAUDE_MODEL || 'Qwen3.8-Max'
const timeoutMs = Number(process.env.CHAT2API_CLAUDE_TEST_TIMEOUT_MS || 600_000)
const toolName = 'record_attempt'

assert.ok(Number.isSafeInteger(timeoutMs) && timeoutMs > 0, 'timeout must be a positive integer')

function requestBody({ stream, isError, suffix }) {
  const previousToolUseId = `toolu_chat2api_attempt_1_${suffix}`
  return {
    model,
    max_tokens: 2_048,
    stream,
    system: [
      'This is an end-to-end protocol test.',
      'Call record_attempt once for the requested operation.',
      'After its successful result, answer exactly TEST_DONE.',
    ].join(' '),
    messages: [
      {
        role: 'user',
        content: 'Run the requested operation using record_attempt.',
      },
      {
        role: 'assistant',
        content: [{
          type: 'tool_use',
          id: previousToolUseId,
          name: toolName,
          input: { attempt: 1 },
        }],
      },
      {
        role: 'user',
        content: [{
          type: 'tool_result',
          tool_use_id: previousToolUseId,
          content: isError ? 'attempt 1 failed' : 'attempt 1 succeeded',
          is_error: isError,
        }],
      },
    ],
    tools: [{
      name: toolName,
      description: 'Record a numbered execution attempt.',
      input_schema: {
        type: 'object',
        properties: {
          attempt: { type: 'integer', minimum: 1 },
        },
        required: ['attempt'],
        additionalProperties: false,
      },
    }],
    tool_choice: { type: 'auto' },
  }
}

function parseAnthropicStream(responseText) {
  let stopReason = null
  let text = ''
  const tools = new Map()

  for (const frame of responseText.split(/\r?\n\r?\n/)) {
    const data = frame
      .split(/\r?\n/)
      .filter(line => line.startsWith('data:'))
      .map(line => line.slice(5).trimStart())
      .join('\n')
    if (!data || data === '[DONE]') continue

    const event = JSON.parse(data)
    if (event.type === 'content_block_start' && event.content_block?.type === 'tool_use') {
      tools.set(event.index, {
        id: event.content_block.id,
        name: event.content_block.name,
        input: event.content_block.input,
        partialJson: '',
      })
    } else if (event.type === 'content_block_delta' && event.delta?.type === 'input_json_delta') {
      const tool = tools.get(event.index)
      if (tool) tool.partialJson += event.delta.partial_json || ''
    } else if (event.type === 'content_block_delta' && event.delta?.type === 'text_delta') {
      text += event.delta.text || ''
    } else if (event.type === 'message_delta') {
      stopReason = event.delta?.stop_reason ?? stopReason
    }
  }

  const toolUse = [...tools.values()][0]
  if (toolUse?.partialJson) toolUse.input = JSON.parse(toolUse.partialJson)
  return { toolUse, text, stopReason }
}

async function runCase({ stream, isError, suffix }) {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(new Error(`request exceeded ${timeoutMs}ms`)), timeoutMs)
  const startedAt = Date.now()
  let firstChunkMs
  let response
  let responseText = ''

  try {
    response = await fetch(`${baseUrl}/v1/messages`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify(requestBody({ stream, isError, suffix })),
      signal: controller.signal,
    })

    assert.ok(response.body, 'response body is missing')
    if (stream) {
      const reader = response.body.getReader()
      const decoder = new TextDecoder()
      while (true) {
        const chunk = await reader.read()
        if (chunk.done) break
        if (firstChunkMs === undefined) firstChunkMs = Date.now() - startedAt
        responseText += decoder.decode(chunk.value, { stream: true })
      }
      responseText += decoder.decode()
    } else {
      responseText = await response.text()
    }
  } finally {
    clearTimeout(timeout)
  }

  assert.ok(response, 'request did not return an HTTP response')
  assert.equal(response.ok, true, `HTTP ${response.status}: ${responseText.slice(0, 1_000)}`)

  const payload = stream ? parseAnthropicStream(responseText) : JSON.parse(responseText)
  const toolUse = stream
    ? payload.toolUse
    : payload.content?.find(block => block?.type === 'tool_use')
  const text = stream
    ? payload.text
    : payload.content
      ?.filter(block => block?.type === 'text')
      .map(block => block.text || '')
      .join('') || ''
  const stopReason = stream ? payload.stopReason : payload.stop_reason

  if (isError) {
    assert.ok(toolUse, `failed tool result was accepted as complete: ${responseText.slice(0, 2_000)}`)
    assert.equal(toolUse.name, toolName)
  } else {
    assert.equal(toolUse, undefined, `successful tool result caused an unnecessary retry: ${responseText.slice(0, 2_000)}`)
    assert.equal(text.trim(), 'TEST_DONE')
  }

  return {
    outcome: isError ? 'tool_retry' : 'success_control',
    stream,
    status: response.status,
    elapsedMs: Date.now() - startedAt,
    ...(firstChunkMs === undefined ? {} : { firstChunkMs }),
    stopReason,
    toolName: toolUse?.name,
    toolInput: toolUse?.input,
    text,
  }
}

const results = []
results.push(await runCase({ stream: false, isError: true, suffix: 'nonstream_error' }))
results.push(await runCase({ stream: true, isError: true, suffix: 'stream_error' }))
results.push(await runCase({ stream: false, isError: false, suffix: 'success_control' }))

console.log(JSON.stringify({ outcome: 'all_passed', results }, null, 2))
