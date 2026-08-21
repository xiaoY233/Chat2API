import http from 'node:http'
import { spawn } from 'node:child_process'

const port = Number.parseInt(process.env.PORT || '18081', 10)
const contentDelayMs = Number.parseInt(process.env.CONTENT_DELAY_MS || '2500', 10)
const pingIntervalMs = Number.parseInt(process.env.PING_INTERVAL_MS || '200', 10)
const progressMode = process.env.PROGRESS_MODE || 'ping'
const runClaude = process.env.RUN_CLAUDE === '1'
let requestCount = 0

function writeEvent(response, event, data) {
  response.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
}

const server = http.createServer((request, response) => {
  if (request.method !== 'POST' || !request.url?.startsWith('/v1/messages')) {
    response.writeHead(404).end()
    return
  }

  let body = ''
  request.setEncoding('utf8')
  request.on('data', chunk => { body += chunk })
  request.on('end', () => {
    if (request.url?.includes('count_tokens')) {
      response.writeHead(200, { 'Content-Type': 'application/json' })
      response.end(JSON.stringify({ input_tokens: 1 }))
      return
    }

    const parsed = JSON.parse(body || '{}')
    requestCount += 1
    const currentRequestCount = requestCount
    const lastMessage = Array.isArray(parsed.messages) ? parsed.messages.at(-1) : undefined
    const lastContent = typeof lastMessage?.content === 'string'
      ? lastMessage.content
      : JSON.stringify(lastMessage?.content ?? '')
    process.stdout.write(
      `fixture request ${currentRequestCount}: stream=${parsed.stream === true}`
      + ` messages=${Array.isArray(parsed.messages) ? parsed.messages.length : 0}`
      + ` last=${lastContent.slice(0, 120).replace(/[\r\n]+/g, ' ')}\n`,
    )
    if (parsed.stream !== true) {
      response.writeHead(400, { 'Content-Type': 'application/json' })
      response.end(JSON.stringify({ error: { type: 'invalid_request_error', message: 'stream=true required' } }))
      return
    }

    response.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    })
    writeEvent(response, 'message_start', {
      type: 'message_start',
      message: {
        id: 'msg_idle_fixture',
        type: 'message',
        role: 'assistant',
        model: parsed.model || 'fixture-model',
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 1, output_tokens: 0 },
      },
    })

    const hasOpenTextBlock = progressMode === 'empty-text'
    const hasOpenThinkingBlock = progressMode === 'empty-thinking'
    if (hasOpenTextBlock) {
      writeEvent(response, 'content_block_start', {
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'text', text: '' },
      })
    } else if (hasOpenThinkingBlock) {
      writeEvent(response, 'content_block_start', {
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'thinking', thinking: '', signature: '' },
      })
    }

    const pingTimer = setInterval(() => {
      if (response.destroyed) return
      if (progressMode === 'empty-text') {
        writeEvent(response, 'content_block_delta', {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'text_delta', text: '' },
        })
      } else if (progressMode === 'empty-thinking') {
        writeEvent(response, 'content_block_delta', {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'thinking_delta', thinking: '' },
        })
      } else if (progressMode === 'message-delta') {
        writeEvent(response, 'message_delta', {
          type: 'message_delta',
          delta: { stop_reason: null, stop_sequence: null },
          usage: { output_tokens: 0 },
        })
      } else if (progressMode !== 'none') {
        writeEvent(response, 'ping', { type: 'ping' })
      }
    }, pingIntervalMs)

    const contentTimer = setTimeout(() => {
      if (response.destroyed) return
      clearInterval(pingTimer)
      if (hasOpenThinkingBlock) {
        writeEvent(response, 'content_block_stop', { type: 'content_block_stop', index: 0 })
      }
      const textIndex = hasOpenThinkingBlock ? 1 : 0
      if (!hasOpenTextBlock) {
        writeEvent(response, 'content_block_start', {
          type: 'content_block_start',
          index: textIndex,
          content_block: { type: 'text', text: '' },
        })
      }
      writeEvent(response, 'content_block_delta', {
        type: 'content_block_delta',
        index: textIndex,
        delta: { type: 'text_delta', text: 'fixture complete' },
      })
      writeEvent(response, 'content_block_stop', { type: 'content_block_stop', index: textIndex })
      writeEvent(response, 'message_delta', {
        type: 'message_delta',
        delta: { stop_reason: 'end_turn', stop_sequence: null },
        usage: { output_tokens: 2 },
      })
      writeEvent(response, 'message_stop', { type: 'message_stop' })
      response.end()
    }, contentDelayMs)

    response.once('close', () => {
      clearInterval(pingTimer)
      clearTimeout(contentTimer)
      process.stdout.write(`fixture response ${currentRequestCount} closed\n`)
    })
  })
})

server.listen(port, '127.0.0.1', () => {
  process.stdout.write(`claude-stream-idle-fixture listening on ${port}\n`)
  if (!runClaude) return

  const clientEnv = {
    ...process.env,
    ANTHROPIC_BASE_URL: `http://127.0.0.1:${port}`,
    ANTHROPIC_API_KEY: 'fixture-key',
    CLAUDE_STREAM_IDLE_TIMEOUT_MS: process.env.CLIENT_IDLE_TIMEOUT_MS || '1000',
    API_TIMEOUT_MS: process.env.CLIENT_API_TIMEOUT_MS || '10000',
    CLAUDE_CODE_DISABLE_NONSTREAMING_FALLBACK: '1',
    DISABLE_AUTOUPDATER: '1',
  }
  delete clientEnv.ANTHROPIC_AUTH_TOKEN

  const executable = process.env.CLAUDE_EXE
    || 'C:\\nvm4w\\nodejs\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe'
  const child = spawn(executable, [
    '--bare',
    '--print',
    'Return one short reply.',
    '--model',
    'fixture-model',
    '--tools',
    '',
    '--output-format',
    'json',
  ], {
    env: clientEnv,
    stdio: 'inherit',
    windowsHide: true,
  })

  child.once('error', error => {
    process.stderr.write(`${error.stack || error.message}\n`)
    server.close(() => process.exit(1))
  })
  child.once('exit', (code, signal) => {
    process.stdout.write(`claude exit: code=${code} signal=${signal || 'none'}\n`)
    server.close(() => process.exit(code ?? 1))
  })
})

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => server.close(() => process.exit(0)))
}
