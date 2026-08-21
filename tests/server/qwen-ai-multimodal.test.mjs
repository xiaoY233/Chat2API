import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'

test('OpenAI chat content type includes file parts for multimodal clients', () => {
  const source = fs.readFileSync('src/main/proxy/types.ts', 'utf8')

  assert.match(source, /type:\s*'text'\s*\|\s*'image_url'\s*\|\s*'file'/)
  assert.match(source, /file_url\?:\s*\{/)
  assert.match(source, /filename\?:\s*string/)
})

test('OpenAI chat content type includes audio and video parts for multimodal clients', () => {
  const source = fs.readFileSync('src/main/proxy/types.ts', 'utf8')

  assert.match(source, /'input_audio'/)
  assert.match(source, /'video_url'/)
  assert.match(source, /input_audio\?:\s*\{/)
  assert.match(source, /data:\s*string/)
  assert.match(source, /format\?:\s*string/)
  assert.match(source, /video_url\?:\s*\{/)
})

test('Qwen AI has a dedicated multimodal upload helper', () => {
  const source = fs.readFileSync('src/main/proxy/adapters/qwen-ai-files.ts', 'utf8')

  assert.match(source, /class QwenAiFileUploader/)
  assert.match(source, /\/api\/v2\/files\/getstsToken/)
  assert.match(source, /\/api\/v2\/files\/parse/)
  assert.match(source, /\/api\/v2\/files\/parse\/status/)
  assert.match(source, /\.put\(sts\.filePath,\s*uploadSource,\s*uploadOptions\)/)
  assert.match(source, /\.multipartUpload\(sts\.filePath,\s*uploadSource/)
  assert.doesNotMatch(source, /console\.log\([^)]*base64/i)
})

test('Qwen AI OSS uploads use multipart upload for web-sized video files', () => {
  const source = fs.readFileSync('src/main/proxy/adapters/qwen-ai-files.ts', 'utf8')
  const types = fs.readFileSync('src/main/types/ali-oss.d.ts', 'utf8')

  assert.match(source, /OSS_SINGLE_PUT_MAX_BYTES/)
  assert.match(source, /2 \* 1024 \* 1024/)
  assert.match(source, /QWEN_AI_OSS_UPLOAD_TIMEOUT_MS/)
  assert.match(source, /QWEN_AI_OSS_UPLOAD_RETRY_MAX/)
  assert.match(source, /QWEN_AI_OSS_STS_REFRESH_INTERVAL_MS/)
  assert.match(source, /refreshSTSToken:\s*async \(\) =>/)
  assert.match(source, /const refreshed = await this\.requestSts\(file, options\)/)
  assert.match(source, /hasSameOssTarget\(sts, refreshed\)/)
  assert.match(source, /refreshSTSTokenInterval:\s*OSS_STS_REFRESH_INTERVAL_MS/)
  assert.match(source, /function qwenOssMultipartParams\(fileSize: number\)/)
  assert.match(source, /fileSize < 100 \* 1024 \* 1024/)
  assert.match(source, /parallel: 10,\s*partSize: 10 \* 1024 \* 1024/)
  assert.match(source, /function qwenOssDirectMultipartParams\(fileSize: number\)/)
  assert.match(source, /QWEN_AI_DIRECT_UPLOAD_PARALLEL/)
  assert.match(source, /QWEN_AI_DIRECT_UPLOAD_PART_SIZE_MIB/)
  assert.match(source, /if \(file\.sizeBytes < OSS_SINGLE_PUT_MAX_BYTES\)/)
  assert.match(source, /client\.multipartUpload\(sts\.filePath,\s*uploadSource,\s*\{[\s\S]*\.\.\.multipartParams/)
  assert.match(types, /multipartUpload\(name: string,\s*data: Buffer \| string \| NodeJS\.ReadableStream,\s*options\?: any\)/)
})

test('Qwen AI document upload waits for parse completion with a bounded timeout', () => {
  const source = fs.readFileSync('src/main/proxy/adapters/qwen-ai-files.ts', 'utf8')

  assert.match(source, /QWEN_AI_FILE_PARSE_POLL_INTERVAL_MS',\s*2000/)
  assert.match(source, /QWEN_AI_FILE_PARSE_TIMEOUT_MS',\s*120000/)
  assert.match(source, /while \(Date\.now\(\) < pollingDeadlineAt\)/)
  assert.match(source, /createQwenAiFileParseTimeoutError\(parseTimeoutMs, lastStatus\)/)
  assert.doesNotMatch(source, /const PARSE_POLL_ATTEMPTS = 5/)
})

test('Qwen AI long text documents add generic evidence excerpts near the user request', () => {
  const source = fs.readFileSync('src/main/proxy/adapters/qwen-ai-files.ts', 'utf8')

  assert.match(source, /QWEN_AI_DOCUMENT_EVIDENCE_MARKER/)
  assert.match(source, /createDocumentEvidence\(file,\s*evidenceQueryText\)/)
  assert.match(source, /renderDocumentEvidence\(evidences\)/)
  assert.match(source, /TEXT_DOCUMENT_MIME_TYPES/)
  assert.match(source, /TEXT_DOCUMENT_EXTENSIONS/)
  assert.match(source, /KEY_VALUE_LINE_PATTERN/)
  assert.match(source, /KEY_VALUE_CONTEXT_PATTERN/)
  assert.match(source, /PATH_VALUE_CONTEXT_PATTERN/)
  assert.match(source, /Use only values that are present in the excerpts or the attached documents/)
  assert.match(source, /content = documentEvidence\s*\?\s*`\$\{inlineContent\}\\n\\n\$\{documentEvidence\}`/)
})

test('Qwen AI document evidence is bounded and configurable instead of hard-coded to one fixture', () => {
  const source = fs.readFileSync('src/main/proxy/adapters/qwen-ai-files.ts', 'utf8')

  assert.match(source, /QWEN_AI_DOCUMENT_EVIDENCE_MAX_TEXT_BYTES/)
  assert.match(source, /QWEN_AI_DOCUMENT_EVIDENCE_MAX_TOTAL_CHARS/)
  assert.match(source, /QWEN_AI_DOCUMENT_EVIDENCE_MAX_PER_FILE_CHARS/)
  assert.match(source, /positiveIntegerFromEnv/)
  assert.match(source, /selectEvidenceSnippets\(decoded\.text,\s*queryText\)/)
  assert.doesNotMatch(source, /TARGET_PATH/)
  assert.doesNotMatch(source, /file-context-extra/)
  assert.doesNotMatch(source, /long-context-extra/)
})

test('Qwen AI does not forge or rewrite tool arguments from document evidence', () => {
  const adapterSource = fs.readFileSync('src/main/proxy/adapters/qwen-ai.ts', 'utf8')
  const filesSource = fs.readFileSync('src/main/proxy/adapters/qwen-ai-files.ts', 'utf8')

  assert.doesNotMatch(adapterSource, /filePath['"]?\s*[:=]/)
  assert.doesNotMatch(adapterSource, /arguments\s*=\s*.*preparedUserMessage/)
  assert.doesNotMatch(filesSource, /finish_reason/)
})

test('Qwen AI multimodal helper preserves full tool-call transcript instead of only the last user message', () => {
  const source = fs.readFileSync('src/main/proxy/adapters/qwen-ai-files.ts', 'utf8')

  assert.match(source, /function buildQwenAiTranscript\(messages: ChatMessage\[\]\)/)
  assert.match(source, /getProviderToolProfile\('qwen-ai'\)/)
  assert.match(source, /msg\.role === 'assistant'/)
  assert.match(source, /msg\.tool_calls\?\.length/)
  assert.match(source, /formatAssistantToolCalls\(transcriptCalls\)/)
  assert.match(source, /function nextLocalToolCallId\(rawId: string/)
  assert.match(source, /usedLocalToolCallIds/)
  assert.match(source, /`\$\{baseId\}__\$\{occurrence\}`/)
  assert.match(source, /msg\.role === 'tool'/)
  assert.match(source, /formatToolResult\(\{/)
  assert.match(source, /isError,/)
  assert.doesNotMatch(source, /Use this result to decide the next step\./)
  assert.doesNotMatch(source, /<\|CHAT2API\|tool_result/)
  assert.doesNotMatch(source, /renderCompletedToolState|Authoritative completed tool ledger|Do not repeat an already successful operation/)
  assert.match(source, /fileParts\.push\(\.\.\.messageFileParts\)/)
  assert.match(source, /buildQwenAiTranscript\(messages\)/)
  assert.doesNotMatch(source, /userContent = textFromContent\(msg\.content\)/)
  assert.doesNotMatch(source, /fileParts\.splice\(0,\s*fileParts\.length/)
})

test('Qwen AI stream converts only declared upstream native function calls without fabricated arguments', () => {
  const source = fs.readFileSync('src/main/proxy/adapters/qwen-ai.ts', 'utf8')
  const nativeToolsSource = fs.readFileSync('src/main/proxy/adapters/qwen-ai-native-tools.ts', 'utf8')

  assert.match(source, /normalizeNativeFunctionCallDelta/)
  assert.match(nativeToolsSource, /delta\.function_call/)
  assert.match(nativeToolsSource, /delta\.tool_calls/)
  assert.match(source, /toolCallingPlan\.allowedToolNames\.has\(name\)/)
  assert.match(source, /warnedUndeclaredNativeToolNames\.has\(name\)/)
  assert.match(source, /warnedUndeclaredNativeToolNames\.add\(name\)/)
  assert.match(source, /Ignoring undeclared upstream native tool call/)
  assert.match(source, /isCompleteJsonText\(state\.arguments\)/)
  assert.match(source, /mergeNativeToolArguments\(existing\?\.arguments \?\? '', fragment\.arguments\)/)
  assert.match(source, /normalizedArguments\s*=\s*normalizeArguments\(state\.arguments,\s*tool\)/)
  assert.match(source, /arguments:\s*normalizedArguments/)
  assert.match(source, /finish_reason:\s*'tool_calls'/)
  assert.doesNotMatch(source, /function:\s*\{[\s\S]{0,120}arguments:\s*['"]\{\}['"]/)
})

test('Qwen AI stream rejects malformed internal tool protocol even when tool choice is auto', () => {
  const source = fs.readFileSync('src/main/proxy/adapters/qwen-ai.ts', 'utf8')
  const policySource = fs.readFileSync('src/main/proxy/toolCalling/streamValidationPolicy.ts', 'utf8')

  assert.match(source, /hadPendingToolProtocol/)
  assert.match(source, /getToolStreamValidationFailure/)
  assert.match(policySource, /malformed_tool_call/)
  assert.doesNotMatch(source, /toolChoiceMode === 'forced' \|\| this\.toolCallingPlan\.toolChoiceMode === 'required'/)
})

test('Qwen AI stream isolates the primary upstream response branch before parsing tool calls', () => {
  const source = fs.readFileSync('src/main/proxy/adapters/qwen-ai.ts', 'utf8')

  assert.match(source, /ignoredResponseIds = new Set<string>\(\)/)
  assert.match(source, /responseBranchLocked = false/)
  assert.match(source, /processedResponseEvent = false/)
  assert.match(source, /recordResponseCreated\(created: Record<string, any>\)/)
  assert.match(source, /shouldProcessResponseEvent\(data: Record<string, any>\)/)
  assert.match(source, /response_index/)
  assert.match(source, /Ignoring secondary response branch/)
  assert.match(source, /eventResponseId !== this\.responseId/)
  assert.match(source, /if \(!this\.shouldProcessResponseEvent\(data\)\)/)
  assert.match(source, /if \(!this\.shouldProcessResponseEvent\(parsed\)\)/)
})

test('Qwen AI multimodal helper accepts audio and video inputs', () => {
  const source = fs.readFileSync('src/main/proxy/adapters/qwen-ai-files.ts', 'utf8')

  assert.match(source, /part\.type === 'input_audio'/)
  assert.match(source, /part\.type === 'video_url'/)
  assert.match(source, /coarseType:\s*'audio',\s*fileClass:\s*'audio'/)
  assert.match(source, /coarseType:\s*'video',\s*fileClass:\s*'video'/)
  assert.match(source, /input-audio-\$\{uuid\(\)\}/)
  assert.doesNotMatch(source, /audio\/video input is not supported/)
})

test('Qwen AI local Gemini files upload by path without reading full videos into memory', () => {
  const source = fs.readFileSync('src/main/proxy/adapters/qwen-ai-files.ts', 'utf8')
  const translatorSource = fs.readFileSync('src/main/proxy/gemini/translator.ts', 'utf8')

  assert.match(source, /localPath/)
  assert.match(source, /localMtimeMs:\s*stat\.mtimeMs/)
  assert.match(source, /sizeBytes:\s*stat\.size/)
  assert.match(source, /const uploadSource = file\.localPath \|\| file\.data/)
  assert.doesNotMatch(source, /data:\s*readFileSync\(localPath\)/)
  assert.match(translatorSource, /geminiFileStore\.getFile\(fileData\.fileUri\)/)
  assert.doesNotMatch(translatorSource, /geminiFileStore\.readFile\(fileData\.fileUri\)/)
})

test('Qwen AI local file uploads are cached per account to avoid repeat OSS uploads', () => {
  const source = fs.readFileSync('src/main/proxy/adapters/qwen-ai-files.ts', 'utf8')
  const adapterSource = fs.readFileSync('src/main/proxy/adapters/qwen-ai.ts', 'utf8')

  assert.match(source, /QWEN_AI_FILE_CACHE_ENABLED/)
  assert.match(source, /QWEN_AI_FILE_CACHE_TTL_MS/)
  assert.match(source, /QWEN_AI_FILE_CACHE_MAX_ENTRIES/)
  assert.match(source, /class QwenAiFileCache/)
  assert.match(source, /qwen-ai-file-cache\.json/)
  assert.match(source, /providerId:\s*scope\.providerId/)
  assert.match(source, /accountId:\s*scope\.accountId/)
  assert.match(source, /path\.resolve\(file\.localPath\)/)
  assert.match(source, /qwenAiFileUploadCoordinator\.run\(\s*cacheKey/)
  assert.match(source, /cache hit/)
  assert.match(source, /cache miss/)
  assert.match(source, /cloneCachedQwenFileItem/)
  assert.match(source, /qwen-ai-file-cache-content-v1/)
  assert.match(source, /contentHash:\s*createHash\('sha256'\)/)
  assert.match(adapterSource, /providerId:\s*this\.provider\.id,\s*accountId:\s*this\.account\.id/)
})

test('Qwen AI direct upload API avoids proxying large Gemini files through the VPS', () => {
  const filesSource = fs.readFileSync('src/main/proxy/adapters/qwen-ai-files.ts', 'utf8')
  const routeSource = fs.readFileSync('src/main/proxy/routes/gemini.ts', 'utf8')
  const translatorSource = fs.readFileSync('src/main/proxy/gemini/translator.ts', 'utf8')

  assert.match(filesSource, /QWEN_AI_DIRECT_FILE_SCHEME = 'qwen-ai-direct:\/\//)
  assert.match(filesSource, /startDirectUpload\(\s*input: QwenAiDirectUploadInput/)
  assert.match(filesSource, /completeDirectUpload\(\s*sessionId: string/)
  assert.match(filesSource, /accessKeyId: sts\.accessKeyId/)
  assert.match(filesSource, /authVersion: 'v4'/)
  assert.match(filesSource, /qwenOssDirectMultipartParams\(file\.sizeBytes\)/)
  assert.match(filesSource, /qwenAiFileCache\.setDirect/)
  assert.match(routeSource, /\/v1beta\/chat2api\/qwen-ai\/direct-upload\/start/)
  assert.match(routeSource, /\/v1beta\/chat2api\/qwen-ai\/direct-upload\/complete/)
  assert.match(translatorSource, /collectQwenDirectUploadHints/)
  assert.match(translatorSource, /preferredAccountId: directUploadHints\.accountId/)
})

test('Qwen AI file upload logs each slow stage with elapsed timings', () => {
  const source = fs.readFileSync('src/main/proxy/adapters/qwen-ai-files.ts', 'utf8')

  assert.match(source, /\[QwenAI\]\[File\] resolve start/)
  assert.match(source, /\[QwenAI\]\[File\] resolve done/)
  assert.match(source, /\[QwenAI\]\[File\] sts start/)
  assert.match(source, /\[QwenAI\]\[File\] sts done/)
  assert.match(source, /\[QwenAI\]\[File\] oss upload start/)
  assert.match(source, /\[QwenAI\]\[File\] oss upload done/)
  assert.match(source, /\[QwenAI\]\[File\] parse start/)
  assert.match(source, /\[QwenAI\]\[File\] parse done/)
  assert.match(source, /\[QwenAI\]\[File\] upload complete/)
  assert.match(source, /elapsedSeconds\(startedAt\)/)
})

test('Qwen AI Docker upload limit defaults to the web video limit of 2000 MB', () => {
  const source = fs.readFileSync('src/main/proxy/adapters/qwen-ai-files.ts', 'utf8')

  assert.match(source, /const MAX_FILE_SIZE = 2000 \* 1024 \* 1024/)
  assert.match(source, /Qwen AI file upload exceeds \$\{MAX_FILE_SIZE\} bytes/)
})

test('Qwen AI file payload preserves audio and video file types', () => {
  const source = fs.readFileSync('src/main/proxy/adapters/qwen-ai-files.ts', 'utf8')

  assert.match(source, /const type = file\.coarseType/)
  assert.match(source, /showType:\s*type/)
  assert.match(source, /filetype:\s*file\.coarseType/)
})

test('Qwen AI adapter sends prepared multimodal files instead of a fixed empty list', () => {
  const source = fs.readFileSync('src/main/proxy/adapters/qwen-ai.ts', 'utf8')
  const chatCompletionSource = source.slice(
    source.indexOf('async chatCompletion('),
    source.indexOf('async resumeChatCompletion('),
  )

  assert.match(source, /QwenAiFileUploader/)
  assert.match(source, /prepareQwenAiMultimodalMessage/)
  assert.match(chatCompletionSource, /files:\s*preparedUserMessage\.files/)
  assert.doesNotMatch(chatCompletionSource, /files:\s*\[\]/)
})

test('Qwen AI adapter measures and sends the same serialized UTF-8 request body', () => {
  const source = fs.readFileSync('src/main/proxy/adapters/qwen-ai.ts', 'utf8')
  const chatCompletionSource = source.slice(
    source.indexOf('async chatCompletion('),
    source.indexOf('async resumeChatCompletion('),
  )

  assert.match(chatCompletionSource, /serializedPayload = JSON\.stringify\(payload\)/)
  assert.match(chatCompletionSource, /Buffer\.byteLength\(serializedPayload, 'utf8'\)/)
  assert.match(chatCompletionSource, /postWithRefreshRetry\(url, serializedPayload,/)
  assert.match(chatCompletionSource, /'Content-Length': String\(payloadBytes\)/)
})

test('Qwen AI adapter request timeout is configurable for long-context document runs', () => {
  const source = fs.readFileSync('src/main/proxy/adapters/qwen-ai.ts', 'utf8')

  assert.match(source, /QWEN_AI_REQUEST_TIMEOUT_MS/)
  assert.match(source, /positiveNumberFromEnv\('QWEN_AI_REQUEST_TIMEOUT_MS',\s*840000\)/)
  assert.match(source, /return Number\.isFinite\(value\) && value > 0 \? value : fallback/)
  assert.doesNotMatch(source, /timeout:\s*120000/)
})

test('Qwen AI credential warnings require either a JWT or the session token cookie', () => {
  const source = fs.readFileSync('src/main/proxy/adapters/qwen-ai.ts', 'utf8')

  assert.match(source, /if \(!token && !hasQwenAiSessionCookie\(cookies\)\)/)
  assert.match(source, /No JWT or session token cookie provided/)
  assert.doesNotMatch(source, /if \(!token && !cookies\)/)
})

test('Docker Compose exposes Qwen timeout overrides under their runtime names', () => {
  const source = fs.readFileSync('docker-compose.yml', 'utf8')
  const dockerfile = fs.readFileSync('Dockerfile', 'utf8')
  const governorSource = fs.readFileSync('src/main/proxy/qwenAiRequestGovernor.ts', 'utf8')

  assert.match(source, /CHAT2API_QWEN_AI_QUEUE_TIMEOUT_MS:\s*\$\{CHAT2API_QWEN_AI_QUEUE_TIMEOUT_MS:-120000\}/)
  assert.match(source, /CHAT2API_QWEN_AI_RECOVERY_BUDGET_MS:\s*\$\{CHAT2API_QWEN_AI_RECOVERY_BUDGET_MS:-180000\}/)
  assert.match(source, /CHAT2API_QWEN_AI_WORKFLOW_RECOVERY_TIMEOUT_MS:\s*\$\{CHAT2API_QWEN_AI_WORKFLOW_RECOVERY_TIMEOUT_MS:-840000\}/)
  assert.match(source, /CHAT2API_QWEN_AI_REQUEST_MAX_BYTES:\s*\$\{CHAT2API_QWEN_AI_REQUEST_MAX_BYTES:-92160\}/)
  assert.match(source, /CHAT2API_QWEN_AI_HERMES_ROUTING_SUMMARY_MAX_CODE_POINTS:\s*\$\{CHAT2API_QWEN_AI_HERMES_ROUTING_SUMMARY_MAX_CODE_POINTS:-240\}/)
  assert.match(source, /CHAT2API_QWEN_AI_RETRY_COUNT:\s*\$\{CHAT2API_QWEN_AI_RETRY_COUNT:-1\}/)
  assert.match(source, /CHAT2API_QWEN_AI_BUSY_RETRY_COUNT:\s*\$\{CHAT2API_QWEN_AI_BUSY_RETRY_COUNT:-1\}/)
  assert.match(source, /CHAT2API_QWEN_AI_WORKFLOW_CONTINUATION_ATTEMPTS:\s*\$\{CHAT2API_QWEN_AI_WORKFLOW_CONTINUATION_ATTEMPTS:-1\}/)
  const transcriptEnvironmentNames = [
    'MAX_BYTES',
    'REQUEST_RESERVE_BYTES',
    'TOOL_RESULT_MAX_BYTES',
    'MESSAGE_MAX_BYTES',
    'MAX_FILE_PARTS',
  ].map((suffix) => ['CHAT2API_QWEN_AI', 'TRANSCRIPT', suffix].join('_'))
  for (const environmentName of transcriptEnvironmentNames) {
    assert.doesNotMatch(source, new RegExp(environmentName))
    assert.doesNotMatch(dockerfile, new RegExp(environmentName))
  }
  assert.match(source, /QWEN_AI_REQUEST_TIMEOUT_MS:\s*\$\{QWEN_AI_REQUEST_TIMEOUT_MS:-840000\}/)
  assert.match(source, /QWEN_AI_RESPONSE_TIMEOUT_MS:\s*\$\{QWEN_AI_RESPONSE_TIMEOUT_MS:-0\}/)
  assert.match(source, /QWEN_AI_STREAM_IDLE_TIMEOUT_MS:\s*\$\{QWEN_AI_STREAM_IDLE_TIMEOUT_MS:-180000\}/)
  assert.match(source, /QWEN_AI_FILE_PARSE_POLL_INTERVAL_MS:\s*\$\{QWEN_AI_FILE_PARSE_POLL_INTERVAL_MS:-2000\}/)
  assert.match(source, /QWEN_AI_FILE_PARSE_TIMEOUT_MS:\s*\$\{QWEN_AI_FILE_PARSE_TIMEOUT_MS:-120000\}/)
  assert.doesNotMatch(source, /QWEN_AI_REQUEST_TIMEOUT_MS:\s*\$\{CHAT2API_QWEN_AI_REQUEST_TIMEOUT_MS/)
  assert.match(dockerfile, /ENV CHAT2API_QWEN_AI_QUEUE_TIMEOUT_MS=120000/)
  assert.match(dockerfile, /ENV CHAT2API_QWEN_AI_RECOVERY_BUDGET_MS=180000/)
  assert.match(dockerfile, /ENV CHAT2API_QWEN_AI_WORKFLOW_RECOVERY_TIMEOUT_MS=840000/)
  assert.match(dockerfile, /ENV CHAT2API_QWEN_AI_REQUEST_MAX_BYTES=92160/)
  assert.match(dockerfile, /ENV CHAT2API_QWEN_AI_HERMES_ROUTING_SUMMARY_MAX_CODE_POINTS=240/)
  assert.match(dockerfile, /ENV CHAT2API_QWEN_AI_RETRY_COUNT=1/)
  assert.match(dockerfile, /ENV CHAT2API_QWEN_AI_BUSY_RETRY_COUNT=1/)
  assert.match(dockerfile, /ENV CHAT2API_QWEN_AI_WORKFLOW_CONTINUATION_ATTEMPTS=1/)
  assert.match(dockerfile, /ENV QWEN_AI_REQUEST_TIMEOUT_MS=840000/)
  assert.match(dockerfile, /ENV QWEN_AI_RESPONSE_TIMEOUT_MS=0/)
  assert.match(governorSource, /numberFromEnv\('CHAT2API_QWEN_AI_QUEUE_TIMEOUT_MS',\s*120 \* 1000\)/)
})

test('Qwen AI stream readers support an optional absolute timeout and enforce idle timeouts', () => {
  const source = fs.readFileSync('src/main/proxy/adapters/qwen-ai.ts', 'utf8')

  assert.match(source, /nonNegativeNumberFromEnv\('QWEN_AI_RESPONSE_TIMEOUT_MS',\s*0\)/)
  assert.match(source, /if \(responseTimeoutMs > 0\)/)
  assert.match(source, /QWEN_AI_STREAM_IDLE_TIMEOUT_MS/)
  assert.match(source, /response stream timed out after/)
  assert.match(source, /response stream was idle for more than/)
  assert.match(source, /destroyReadableStream\(stream/)
  assert.match(source, /options\.signal\?\.addEventListener\('abort', onAbort/)
})

test('Qwen AI stream readers reject transport close before provider completion', () => {
  const source = fs.readFileSync('src/main/proxy/adapters/qwen-ai.ts', 'utf8')

  assert.match(source, /sawUpstreamCompletion/)
  assert.match(source, /ended before an upstream completion signal/)
  assert.match(source, /closed before an upstream completion signal/)
  assert.doesNotMatch(source, /Non-stream closed before an answer finished event; returning accumulated content/)
})

test('Qwen AI adapter redacts sensitive request headers in logs', () => {
  const source = fs.readFileSync('src/main/proxy/adapters/qwen-ai.ts', 'utf8')

  assert.match(source, /sanitizeHeadersForLog/)
  assert.match(source, /sanitizePayloadForLog/)
  assert.match(source, /describeErrorForLog/)
  assert.match(source, /QWEN_AI_DOCUMENT_EVIDENCE_MARKER/)
  assert.match(source, /REDACTED_DOCUMENT_EVIDENCE/)
  assert.match(source, /JSON\.stringify\(this\.sanitizeHeadersForLog\(this\.getHeaders\(chatId\)\)/)
  assert.match(source, /JSON\.stringify\(this\.sanitizeHeadersForLog\(response\.headers\)/)
  assert.match(source, /JSON\.stringify\(this\.sanitizePayloadForLog\(payload\)/)
  assert.match(source, /'set-cookie'/)
  assert.doesNotMatch(source, /JSON\.stringify\(this\.getHeaders\(chatId\)/)
  assert.doesNotMatch(source, /JSON\.stringify\(payload,\s*null,\s*2\)/)
  assert.doesNotMatch(
    source,
    /console\.error\('\[QwenAI\][^']*',\s*(?:err|error)\)/,
  )
})

test('Qwen AI adapter rejects risk-control and non-stream upstream responses', () => {
  const source = fs.readFileSync('src/main/proxy/adapters/qwen-ai.ts', 'utf8')

  assert.match(source, /assertChatCompletionStreamResponse/)
  assert.match(source, /hasRiskControlHeaders/)
  assert.match(source, /bxpunish/)
  assert.match(source, /x5sec/)
  assert.match(source, /response\.status\s*>=\s*400/)
  assert.match(source, /qwen_ai_risk_control/)
  assert.match(source, /REDACTED_URL/)
  assert.match(source, /x5secdata\|x5sectag\|cookie\|authorization\|token/)
  assert.match(source, /returned a risk-control or challenge response instead of a chat event stream/)
  assert.match(source, /returned a non-stream response instead of a chat event stream/)
})

test('Qwen AI temporary chats are cleaned up once across every failure path', () => {
  const adapterSource = fs.readFileSync('src/main/proxy/adapters/qwen-ai.ts', 'utf8')
  const forwarderSource = fs.readFileSync('src/main/proxy/forwarder.ts', 'utf8')
  const qwenForwarderSource = forwarderSource.slice(
    forwarderSource.indexOf('private async forwardQwenAi'),
    forwarderSource.indexOf('private async forwardZai'),
  )

  assert.match(adapterSource, /private deleteChatRequests = new Map<string, Promise<boolean>>\(\)/)
  assert.match(adapterSource, /const existingRequest = this\.deleteChatRequests\.get\(chatId\)/)
  assert.match(adapterSource, /const request = this\.performDeleteChat\(chatId\)/)
  assert.match(adapterSource, /this\.deleteChatRequests\.get\(chatId\) === request[\s\S]*this\.deleteChatRequests\.delete\(chatId\)/)
  assert.match(adapterSource, /request\.then\(clearRequest, clearRequest\)/)
  assert.match(adapterSource, /catch \(error\) \{\s*if \(response\) destroyReadableStream\(response\.data\)\s*if \(chatId\) cleanupChat\(chatId\)/)
  assert.match(adapterSource, /finally \{\s*scope\.dispose\(\)/)
  assert.match(adapterSource, /onFailure\?: \(error: Error\) => void/)
  assert.match(adapterSource, /options\.onFailure\?\.\(error\)/)
  assert.match(qwenForwarderSource, /let activeChatId: string \| undefined/)
  assert.match(qwenForwarderSource, /onFailure: \(\) => cleanupChat\(activeChatId \|\| chatId\)/)
  assert.match(qwenForwarderSource, /if \(activeChatId && !activeChatIsRetained\) \{\s*cleanupChat\(activeChatId\)/)
  assert.match(qwenForwarderSource, /transformedStream\.once\('end', cleanupCompletedStream\)/)
  assert.match(qwenForwarderSource, /transformedStream\.once\('finish', cleanupCompletedStream\)/)
  assert.match(qwenForwarderSource, /transformedStream\.once\('error', cleanupCompletedStream\)/)
  assert.match(qwenForwarderSource, /transformedStream\.once\('close', cleanupCompletedStream\)/)
  assert.doesNotMatch(qwenForwarderSource, /shouldDeleteSession\(\) && transformed\.plan\.shouldParseResponse/)
  assert.doesNotMatch(qwenForwarderSource, /transformedStream\.end = function/)
})

test('Qwen AI adapter no longer hard-codes stale Baxia challenge headers', () => {
  const source = fs.readFileSync('src/main/proxy/adapters/qwen-ai.ts', 'utf8')

  assert.match(source, /Version:\s*'0\.2\.67'/)
  assert.match(source, /currentTimezoneHeader/)
  assert.match(source, /baxiaUidToken/)
  assert.match(source, /headers\['bx-umidtoken'\] = baxiaUidToken/)
  assert.doesNotMatch(source, /T2gAr9z8byN8sNOmfQ3X9j61MNTNmSqDO5L1rs2jMcQCVhOKgZICcBN/)
  assert.doesNotMatch(source, /TimeZone: 'Mon Feb 23 2026/)
  assert.doesNotMatch(source, /Timezone: 'Mon Feb 23 2026/)
  assert.doesNotMatch(source, /Version: '0\.2\.7'/)
})

test('Qwen AI adapter selects cookie-only mode only for a real session token cookie', () => {
  const adapterSource = fs.readFileSync('src/main/proxy/adapters/qwen-ai.ts', 'utf8')
  const authSource = fs.readFileSync('src/main/proxy/adapters/qwen-ai-token-refresh.ts', 'utf8')

  assert.match(adapterSource, /const cookies = this\.getCookies\(\)/)
  assert.match(adapterSource, /resolveQwenAiAuthHeaders\(token, cookies\)/)
  assert.match(authSource, /const hasSessionCookie = hasQwenAiSessionCookie\(cookies\)/)
  assert.match(authSource, /normalizedToken && !hasSessionCookie[\s\S]*Authorization:/)
  assert.match(authSource, /normalizedToken && !hasSessionCookie && !cookies \? \{ source: 'desktop' \}/)
  assert.match(authSource, /\.\.\.\(cookies \? \{ Cookie: cookies \} : \{\}\)/)
})

test('Qwen AI non-stream responses reject empty upstream output instead of returning fake success', () => {
  const source = fs.readFileSync('src/main/proxy/adapters/qwen-ai.ts', 'utf8')

  assert.match(source, /let sawAnswerFinish = false/)
  assert.match(source, /let sawUpstreamCompletion = false/)
  assert.match(source, /if \(!visibleAnswerText\.trim\(\) && !finalReasoning\.trim\(\)\)/)
  assert.match(source, /rejectOnce\(createQwenAiStreamFailure\([\s\S]*'Qwen AI returned an empty response stream without answer or reasoning content',[\s\S]*'qwen_ai_empty_stream'/)
  assert.match(source, /if \(!sawUpstreamCompletion\) \{[\s\S]*rejectOnce\(createQwenAiStreamFailure\('Qwen AI response stream closed before an upstream completion signal'\)\)/)
})

test('load balancer does not print account tokens', () => {
  const source = fs.readFileSync('src/main/proxy/loadbalancer.ts', 'utf8')

  assert.doesNotMatch(source, /credentials\.token/)
  assert.doesNotMatch(source, /Token:/)
})
