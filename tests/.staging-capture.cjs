const fs = require('node:fs')
const http = require('node:http')

const output = process.argv[2]
if (!output) throw new Error('capture output path is required')

const server = http.createServer((request, response) => {
  const chunks = []
  request.on('data', (chunk) => chunks.push(chunk))
  request.on('end', () => {
    fs.writeFileSync(output, Buffer.concat(chunks))
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(JSON.stringify({
      id: 'capture-response',
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model: 'capture',
      choices: [{
        index: 0,
        message: { role: 'assistant', content: 'captured' },
        finish_reason: 'stop',
      }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    }))
  })
})

server.listen(18083, '127.0.0.1')
