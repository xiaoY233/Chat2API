import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'

test('Gemini compatibility routes are registered alongside OpenAI routes', () => {
  const routeIndex = fs.readFileSync('src/main/proxy/routes/index.ts', 'utf8')
  const serverSource = fs.readFileSync('src/main/proxy/server.ts', 'utf8')

  assert.match(routeIndex, /geminiRouter/)
  assert.match(routeIndex, /from '\.\/gemini'/)
  assert.match(serverSource, /POST \/v1beta\/models\/:model:generateContent/)
  assert.match(serverSource, /POST \/upload\/v1beta\/files/)
  assert.match(serverSource, /disableBodyParser\?\: boolean/)
  assert.match(serverSource, /disableBodyParser = true/)
})

test('Gemini translator maps contents parts to OpenAI-compatible chat messages', () => {
  const source = fs.readFileSync('src/main/proxy/gemini/translator.ts', 'utf8')
  const qwenFileSource = fs.readFileSync('src/main/proxy/adapters/qwen-ai-files.ts', 'utf8')
  const typeSource = fs.readFileSync('src/main/proxy/types.ts', 'utf8')

  assert.match(source, /export function geminiToChatCompletionRequest/)
  assert.match(source, /inlineData/)
  assert.match(source, /fileData/)
  assert.match(source, /chat2api-file:\/\//)
  assert.match(source, /geminiFileStore\.getFile\(fileData\.fileUri\)/)
  assert.doesNotMatch(source, /geminiFileStore\.readFile\(fileData\.fileUri\)/)
  assert.doesNotMatch(source, /stored\.data\.toString\('base64'\)/)
  assert.match(source, /video_url/)
  assert.match(source, /image_url/)
  assert.match(source, /input_audio/)
  assert.match(source, /function chatCompletionToGeminiResponse/)
  assert.match(source, /finishReason/)
  assert.match(source, /reasoning_content/)
  assert.match(qwenFileSource, /isChat2ApiFileUrl/)
  assert.match(qwenFileSource, /extractLocalFile/)
  assert.match(qwenFileSource, /localPath\?: string/)
  assert.match(qwenFileSource, /statSync\(localPath\)/)
  assert.doesNotMatch(qwenFileSource, /readFileSync\(localPath\)/)
  assert.match(typeSource, /local_path\?\: string/)
})

test('Gemini file store supports official resumable upload flow and 48 hour ttl', () => {
  const source = fs.readFileSync('src/main/proxy/gemini/fileStore.ts', 'utf8')

  assert.match(source, /GEMINI_FILE_TTL_MS = 48 \* 60 \* 60 \* 1000/)
  assert.match(source, /X-Goog-Upload-Protocol/)
  assert.match(source, /X-Goog-Upload-Command/)
  assert.match(source, /X-Goog-Upload-URL/)
  assert.match(source, /storeUploadChunk/)
  assert.match(source, /files\/\$\{file\.id\}/)
  assert.match(source, /ctx\.origin/)
  assert.doesNotMatch(source, /X-Goog-Upload-URL', `\/upload\/v1beta\/files\/\$\{id\}`/)
  assert.doesNotMatch(source, /TODO|TBD|implement later/i)
})

test('Gemini route forwards generateContent through existing OpenAI request forwarder', () => {
  const source = fs.readFileSync('src/main/proxy/routes/gemini.ts', 'utf8')

  assert.match(source, /new Router\(\)/)
  assert.doesNotMatch(source, /router\.post\('\/v1beta\/models\/:model:generateContent'/)
  assert.doesNotMatch(source, /router\.post\('\/v1beta\/models\/:model:streamGenerateContent'/)
  assert.match(source, /generateContentRoutePattern/)
  assert.match(source, /streamGenerateContentRoutePattern/)
  assert.match(source, /ctx\.captures/)
  assert.match(source, /requestForwarder\.forwardChatCompletion/)
  assert.match(source, /geminiToChatCompletionRequest/)
  assert.match(source, /chatCompletionToGeminiResponse/)
  assert.match(source, /chatCompletionStreamToGeminiSse/)
  assert.match(source, /geminiFileStore/)
})

test('Gemini route records failures for aborted or timed out forwarding paths', () => {
  const source = fs.readFileSync('src/main/proxy/routes/gemini.ts', 'utf8')

  assert.match(source, /let statisticsRecorded = false/)
  assert.match(source, /const recordFailure = \(\) =>/)
  assert.match(source, /try \{/)
  assert.match(source, /catch \(error\)/)
  assert.match(source, /proxyStatusManager\.recordRequestFailure/)
  assert.match(source, /signal\.aborted \? 499 : 500/)
  assert.match(source, /Gemini-compatible client disconnected/)
})

test('Gemini route writes detailed request logs for generateContent calls', () => {
  const source = fs.readFileSync('src/main/proxy/routes/gemini.ts', 'utf8')

  assert.match(source, /storeManager\.addRequestLog/)
  assert.match(source, /url: ctx\.path/)
  assert.match(source, /model,\s*\n\s*actualModel/)
  assert.match(source, /providerId: provider\.id/)
  assert.match(source, /accountId: account\.id/)
  assert.match(source, /extractUserInput\(chatRequest\.messages \|\| \[\]\)/)
  assert.match(source, /responseStatus: result\.status \|\| 200/)
  assert.match(source, /isStream: stream/)
})
