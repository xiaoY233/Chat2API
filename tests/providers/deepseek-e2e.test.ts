import dotenv from 'dotenv'
import assert from 'node:assert/strict'
import http from 'node:http'
import test, { before, describe } from 'node:test'
dotenv.config()

const PROXY_HOST = process.env.CHAT2API_HOST || '127.0.0.1'
const PROXY_PORT = parseInt(process.env.CHAT2API_PORT || '10701', 10)
const PROXY_BASE = `http://${PROXY_HOST}:${PROXY_PORT}`
const PROMPT = 'hello'

let proxyAvailable = false

function request(
  method: string,
  path: string,
  body?: unknown,
): Promise<{
  status: number
  headers: http.IncomingHttpHeaders
  data: string
}> {
  return new Promise((resolve, reject) => {
    const url = new URL(path, PROXY_BASE)
    const options: http.RequestOptions = {
      hostname: url.hostname,
      port: url.port,
      path: url.pathname + url.search,
      method,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${process.env.CHAT2API_API_KEY || ''}`,
      },
      timeout: 60000,
    }

    const req = http.request(options, (res) => {
      const chunks: Buffer[] = []
      res.on('data', (chunk: Buffer) => chunks.push(chunk))
      res.on('end', () => {
        resolve({
          status: res.statusCode || 0,
          headers: res.headers,
          data: Buffer.concat(chunks).toString(),
        })
      })
    })

    req.on('timeout', () => {
      req.destroy()
      reject(new Error('Request timed out'))
    })
    req.on('error', reject)

    if (body) {
      req.write(JSON.stringify(body))
    }
    req.end()
  })
}

describe('DeepSeek E2E', () => {
  before(async () => {
    try {
      const { status } = await request('GET', '/health')
      if (status === 200) {
        proxyAvailable = true
        console.log(`[E2E] Proxy is running at ${PROXY_BASE}`)
      } else {
        console.log(`[E2E] Proxy health check returned status ${status}`)
      }
    } catch (err) {
      console.log(
        `[E2E] Proxy is not available at ${PROXY_BASE}: ${err instanceof Error ? err.message : err}`,
      )
      console.log(
        '[E2E] Start Chat2API and ensure a DeepSeek account is configured before running E2E tests.',
      )
    }
  })

  // test('deepseek-v4-pro-think-search: non-stream chat with prompt "hello"', async (t) => {
  //   if (!proxyAvailable) {
  //     t.skip();
  //     return;
  //   }

  //   const { status, data } = await request("POST", "/v1/chat/completions", {
  //     model: "deepseek-v4-pro-think-search",
  //     messages: [{ role: "user", content: PROMPT }],
  //     stream: false,
  //   });

  //   if (status === 401) {
  //     console.log(
  //       "[E2E] API key required - set CHAT2API_API_KEY env var or disable API key in config",
  //     );
  //   }

  //   assert.equal(
  //     status,
  //     200,
  //     `Expected 200, got ${status}: ${data.slice(0, 500)}`,
  //   );

  //   const body = JSON.parse(data);
  //   assert.ok(body.id, "Response should have an id");
  //   assert.equal(body.object, "chat.completion");
  //   assert.equal(body.model, "deepseek-v4-pro-think-search");
  //   assert.ok(
  //     Array.isArray(body.choices) && body.choices.length > 0,
  //     "Response should have choices",
  //   );
  //   assert.equal(body.choices[0].message.role, "assistant");
  //   assert.ok(
  //     typeof body.choices[0].message.content === "string",
  //     "Response should have text content",
  //   );
  //   assert.ok(
  //     body.choices[0].message.content.length > 0,
  //     "Response content should not be empty",
  //   );
  //   assert.ok(body.usage, "Response should include usage info");
  // });

  // test('deepseek-v4-flash-think: non-stream chat with prompt "hello"', async (t) => {
  //   if (!proxyAvailable) {
  //     t.skip();
  //     return;
  //   }

  //   const { status, data } = await request("POST", "/v1/chat/completions", {
  //     model: "deepseek-v4-flash-think",
  //     messages: [{ role: "user", content: PROMPT }],
  //     stream: false,
  //   });

  //   if (status === 401) {
  //     console.log(
  //       "[E2E] API key required - set CHAT2API_API_KEY env var or disable API key in config",
  //     );
  //   }

  //   assert.equal(
  //     status,
  //     200,
  //     `Expected 200, got ${status}: ${data.slice(0, 500)}`,
  //   );

  //   const body = JSON.parse(data);
  //   assert.ok(body.id, "Response should have an id");
  //   assert.equal(body.object, "chat.completion");
  //   assert.equal(body.model, "deepseek-v4-flash-think");
  //   assert.ok(
  //     Array.isArray(body.choices) && body.choices.length > 0,
  //     "Response should have choices",
  //   );
  //   assert.equal(body.choices[0].message.role, "assistant");
  //   assert.ok(
  //     typeof body.choices[0].message.content === "string",
  //     "Response should have text content",
  //   );
  //   assert.ok(
  //     body.choices[0].message.content.length > 0,
  //     "Response content should not be empty",
  //   );
  //   assert.ok(body.usage, "Response should include usage info");
  // });

  test('deepseek-v4-pro-think-search: stream chat with prompt "hello"', async (t) => {
    if (!proxyAvailable) {
      t.skip()
      return
    }

    const { status, headers, data } = await request('POST', '/v1/chat/completions', {
      model: 'deepseek-v4-pro-think-search',
      messages: [{ role: 'user', content: 'hello. stream. pro' }],
      stream: true,
    })

    if (status === 401) {
      console.log(
        '[E2E] API key required - set CHAT2API_API_KEY env var or disable API key in config',
      )
    }

    assert.equal(status, 200, `Expected 200, got ${status}`)
    assert.ok(
      headers['content-type']?.includes('text/event-stream'),
      'Response should be SSE',
    )

    console.log('=== DeepSeek E2E Response ===')
    // console.log("Response:", data);

    const lines = data.split('\n').filter((l) => l.startsWith('data:'))
    assert.ok(lines.length > 0, 'SSE stream should contain data lines')

    const lastLine = lines[lines.length - 1].trim()
    assert.equal(lastLine, 'data: [DONE]', 'Stream should end with [DONE]')

    let hasContent = false
    for (let i = 0; i < lines.length - 1; i++) {
      const json = lines[i].slice(5).trim()
      if (!json) continue
      try {
        const chunk = JSON.parse(json)
        assert.ok(chunk.id, 'Chunk should have an id')
        assert.equal(chunk.object, 'chat.completion.chunk')
        assert.equal(chunk.model, 'deepseek-v4-pro-think-search')
        assert.ok(
          Array.isArray(chunk.choices) && chunk.choices.length > 0,
          'Chunk should have choices',
        )
        if (chunk.choices[0].delta?.content) {
          hasContent = true
        }
      } catch {
        // skip unparseable lines
      }
    }
    assert.ok(hasContent, 'At least one chunk should contain content')
  })

  // test('deepseek-v4-flash-think: stream chat with prompt "hello"', async (t) => {
  //   if (!proxyAvailable) {
  //     t.skip();
  //     return;
  //   }

  //   const { status, headers, data } = await request(
  //     "POST",
  //     "/v1/chat/completions",
  //     {
  //       model: "deepseek-v4-flash-think",
  //       messages: [{ role: "user", content: "hello. stream. flash" }],
  //       stream: true,
  //     },
  //   );

  //   if (status === 401) {
  //     console.log(
  //       "[E2E] API key required - set CHAT2API_API_KEY env var or disable API key in config",
  //     );
  //   }

  //   assert.equal(status, 200, `Expected 200, got ${status}`);
  //   assert.ok(
  //     headers["content-type"]?.includes("text/event-stream"),
  //     "Response should be SSE",
  //   );

  //   const lines = data.split("\n").filter((l) => l.startsWith("data:"));
  //   assert.ok(lines.length > 0, "SSE stream should contain data lines");

  //   const lastLine = lines[lines.length - 1].trim();
  //   assert.equal(lastLine, "data: [DONE]", "Stream should end with [DONE]");

  //   let hasContent = false;
  //   for (let i = 0; i < lines.length - 1; i++) {
  //     const json = lines[i].slice(5).trim();
  //     if (!json) continue;
  //     try {
  //       const chunk = JSON.parse(json);
  //       assert.ok(chunk.id, "Chunk should have an id");
  //       assert.equal(chunk.object, "chat.completion.chunk");
  //       assert.equal(chunk.model, "deepseek-v4-flash-think");
  //       assert.ok(
  //         Array.isArray(chunk.choices) && chunk.choices.length > 0,
  //         "Chunk should have choices",
  //       );
  //       if (chunk.choices[0].delta?.content) {
  //         hasContent = true;
  //       }
  //     } catch {
  //       // skip unparseable lines
  //     }
  //   }
  //   assert.ok(hasContent, "At least one chunk should contain content");
  // });
})
