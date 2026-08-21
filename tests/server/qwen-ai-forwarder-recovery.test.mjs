import assert from 'node:assert/strict'
import { getEventListeners, once } from 'node:events'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import { PassThrough } from 'node:stream'
import test from 'node:test'
import ts from 'typescript'
import {
  createToolWorkflowContinuationMessage as createRealToolWorkflowContinuationMessage,
  extractLatestActiveUserRequest as extractRealLatestActiveUserRequest,
} from '../../src/main/proxy/toolCalling/ToolCallingEngine.ts'
import {
  sanitizeAssistantInputHistory as sanitizeRealAssistantInputHistory,
} from '../../src/main/proxy/toolCalling/assistantInputBoundary.ts'

const runtimeRequire = createRequire(import.meta.url)

function loadTypeScriptModule(path, localModules = {}) {
  const source = fs.readFileSync(path, 'utf8')
  const output = ts.transpileModule(source, {
    compilerOptions: {
      esModuleInterop: true,
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
    },
  }).outputText
  const module = { exports: {} }
  const testRequire = specifier => {
    if (Object.prototype.hasOwnProperty.call(localModules, specifier)) return localModules[specifier]
    if (specifier.startsWith('.')) throw new Error(`Unexpected policy test import: ${specifier}`)
    return runtimeRequire(specifier)
  }
  new Function('require', 'module', 'exports', output)(testRequire, module, module.exports)
  return module.exports
}

const qwenAiAccountPolicy = loadTypeScriptModule('src/main/proxy/qwenAiAccountPolicy.ts')

function adapterWithMatcher(name, matches = false) {
  const Adapter = class {}
  Adapter[name] = () => matches
  return Adapter
}

function loadRequestForwarder(overrides = {}) {
  const source = fs.readFileSync('src/main/proxy/forwarder.ts', 'utf8')
  const output = ts.transpileModule(source, {
    compilerOptions: {
      esModuleInterop: true,
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
    },
  }).outputText
  const module = { exports: {} }
  const StreamHandler = class {}
  const localModules = {
    axios: { create: () => ({}) },
    http2: {},
    '../store/types': {},
    './types': {},
    './status': { proxyStatusManager: {} },
    '../store/store': {
      storeManager: {
        getConfig: () => overrides.storeConfig || ({
          retryCount: 3,
          contextManagement: { enabled: false },
          toolCallingConfig: {},
        }),
      },
    },
    './loadbalancer': {
      loadBalancer: {
        selectAccount: () => null,
        markAccountFailed: () => {},
      },
    },
    './adapters/deepseek': { DeepSeekAdapter: adapterWithMatcher('isDeepSeekProvider') },
    './adapters/deepseek-stream': { DeepSeekStreamHandler: StreamHandler },
    './adapters/glm': {
      GLMAdapter: adapterWithMatcher('isGLMProvider'),
      GLMStreamHandler: StreamHandler,
    },
    './adapters/kimi': {
      KimiAdapter: adapterWithMatcher('isKimiProvider'),
      KimiStreamHandler: StreamHandler,
    },
    './adapters/mimo': {
      MimoAdapter: adapterWithMatcher('isMimoProvider'),
      MimoStreamHandler: StreamHandler,
    },
    './adapters/qwen': {
      QwenAdapter: adapterWithMatcher('isQwenProvider'),
      QwenStreamHandler: StreamHandler,
    },
    './adapters/qwen-ai': {
      describeErrorForLog: error => error?.message || String(error),
      QWEN_AI_STREAM_FAILURE_EVENT: 'qwen-ai-stream-failure',
      createQwenAiResumableStream: overrides.createQwenAiResumableStream || (stream => stream),
      QwenAiAdapter: overrides.QwenAiAdapter || adapterWithMatcher('isQwenAiProvider', true),
      QwenAiStreamHandler: overrides.QwenAiStreamHandler || StreamHandler,
      findQwenAiModelCapability: overrides.findQwenAiModelCapability || (() => undefined),
      findModelCapability: overrides.findModelCapability || (() => undefined),
      isQwenAiStaleSessionError: overrides.isQwenAiStaleSessionError || (value => Boolean(
        value && (
          value.code === 'qwen_ai_session_stale'
          || value.errorCode === 'qwen_ai_session_stale'
          || value.status === 404
          || value.status === 409
          || ((value.status === 400 || value.status === 422)
            && /^(chat|conversation|parent|response|session)[_-]?id$/i.test(String(value.param || '')))
          || /chat(?:id)?[^\n]*not[ _-]?found|parent[^\n]*not[ _-]?found/i.test(String(value.message || value.error || ''))
        )
      )),
      isQwenAiTransientTransportError: overrides.isQwenAiTransientTransportError || (() => false),
      isQwenAiUpstreamBusyMessage: value => /qwen_ai_upstream_busy/i.test(String(value || '')),
      qwenAiRequestTimeoutMsFromEnv: () => overrides.qwenAiRequestTimeoutMs ?? 600_000,
      qwenAiResponsesContinuationRetryAttemptsFromEnv: () => 0,
    },
    './adapters/zai': {
      ZaiAdapter: adapterWithMatcher('isZaiProvider'),
      ZaiStreamHandler: StreamHandler,
    },
    './adapters/minimax': {
      MiniMaxAdapter: adapterWithMatcher('isMiniMaxProvider'),
      MiniMaxStreamHandler: StreamHandler,
    },
    './adapters/perplexity': { PerplexityAdapter: adapterWithMatcher('isPerplexityProvider') },
    './adapters/perplexity-stream': { PerplexityStreamHandler: StreamHandler },
    './toolCalling/ToolCallingEngine': {
      ToolCallingEngine: overrides.ToolCallingEngine || class {},
      createToolWorkflowContinuationMessage: overrides.createToolWorkflowContinuationMessage
        || (() => ({ role: 'user', content: 'generic workflow continuation' })),
      extractLatestActiveUserRequest: overrides.extractLatestActiveUserRequest
        || extractRealLatestActiveUserRequest,
    },
    './toolCalling/assistantInputBoundary': {
      sanitizeAssistantInputHistory: sanitizeRealAssistantInputHistory,
    },
    './qwenAiRequestGovernor': {
      qwenAiRequestGovernor: overrides.qwenAiRequestGovernor
        || { run: (_accountId, operation) => operation() },
    },
    './qwenAiAccountPolicy': qwenAiAccountPolicy,
    './utils/validatedSseStream': {
      BufferedSseError: class BufferedSseError extends Error {},
      bufferValidatedSseStream: overrides.bufferValidatedSseStream || (async stream => stream),
    },
    './utils/errors': {
      isClientCancellationError: () => false,
      sanitizeForwardedErrorHeaders: () => undefined,
    },
    './sessionManager': {
      sessionManager: { shouldDeleteAfterChat: () => true },
    },
    './services/contextManagementService': {
      createContextManagementService: () => ({
        process: overrides.processContextMessages || (async messages => ({
          messages,
          originalCount: messages.length,
          finalCount: messages.length,
          strategyResults: [],
        })),
      }),
    },
    './requestIntent': {
      classifyChatRequest: () => ({
        intent: 'normal',
        textChars: 0,
      }),
    },
    './qwenAiCompactionBoundary': {
      estimateQwenAiRequestInputTokens: overrides.estimateQwenAiRequestInputTokens
        || (() => 1),
      boundQwenAiCompactionMessages: messages => ({
        messages,
        chunks: [{ messages, estimatedTokens: 0, sourceTextChars: 0 }],
        originalMessageCount: messages.length,
        keptMessageCount: messages.length,
        originalEstimatedTokens: 0,
        keptEstimatedTokens: 0,
        inputTokenBudget: 12000,
        chunkBudgetTokens: 12000,
        chunkSource: 'fallback',
        chunkCount: 1,
        splitMessageCount: 0,
        sourceTextChars: 0,
        coveredTextChars: 0,
        boundarySource: 'fallback',
        trimmed: false,
      }),
      planQwenAiCompactionChunks: messages => ({
        chunks: [{ messages, estimatedTokens: 0, sourceTextChars: 0 }],
        chunkBudgetTokens: 12000,
        chunkSource: 'fallback',
        sourceMessageCount: messages.length,
        sourceTextChars: 0,
        coveredTextChars: 0,
        splitMessageCount: 0,
        chunkCount: 1,
      }),
    },
  }

  const testRequire = specifier => {
    if (Object.prototype.hasOwnProperty.call(localModules, specifier)) {
      return localModules[specifier]
    }
    if (specifier.startsWith('.')) {
      throw new Error(`Unexpected forwarder recovery test import: ${specifier}`)
    }
    return runtimeRequire(specifier)
  }

  new Function('require', 'module', 'exports', output)(testRequire, module, module.exports)
  return module.exports.RequestForwarder
}

test('adapter registry passes the Qwen profile key for a custom provider id', () => {
  let capturedInput
  class EndpointMatchedQwenAdapter {
    static isQwenAiProvider(provider) {
      return provider.apiEndpoint.includes('chat.qwen.ai')
    }
  }
  class CapturingToolCallingEngine {
    transformRequest(input) {
      capturedInput = input
      return {
        messages: input.request.messages,
        tools: input.request.tools,
        plan: {},
      }
    }
  }
  const RequestForwarder = loadRequestForwarder({
    QwenAiAdapter: EndpointMatchedQwenAdapter,
    ToolCallingEngine: CapturingToolCallingEngine,
  })
  const forwarder = new RequestForwarder()
  const provider = {
    id: 'custom-qwen-instance',
    apiEndpoint: 'https://chat.qwen.ai',
  }

  forwarder.transformRequestForPromptToolUse({
    model: 'configured-model',
    messages: [{ role: 'user', content: 'complete the task' }],
    tools: [{ type: 'function', function: { name: 'read_file', parameters: {} } }],
  }, provider)

  assert.equal(capturedInput.providerProfileKey, 'qwen-ai')
  assert.equal(capturedInput.provider.id, 'custom-qwen-instance')
})

function createHarness(results) {
  const RequestForwarder = loadRequestForwarder()
  const forwarder = new RequestForwarder()
  const attempts = []

  forwarder.delay = async () => true
  forwarder.doForward = async (...args) => {
    attempts.push(args.at(-1))
    const result = results[attempts.length - 1]
    if (result instanceof Error) throw result
    return result
  }

  const execute = request => forwarder.forwardChatCompletion(
    request,
    { id: 'account-1' },
    { id: 'provider-1', apiEndpoint: 'https://provider.invalid' },
    'model-1',
    { signal: new AbortController().signal },
  )

  return { attempts, execute }
}

test('context management preserves tool metadata while rebuilding a trimmed request', async () => {
  let forwardedRequest
  const RequestForwarder = loadRequestForwarder({
    storeConfig: {
      retryCount: 0,
      contextManagement: { enabled: true },
      toolCallingConfig: {},
    },
    processContextMessages: async messages => ({
      messages: messages.slice(-3),
      originalCount: messages.length,
      finalCount: 3,
      strategyResults: [],
    }),
  })
  const forwarder = new RequestForwarder()
  forwarder.doForward = async request => {
    forwardedRequest = request
    return { success: true, status: 200, body: { choices: [] } }
  }

  const request = {
    model: 'model-1',
    messages: [
      { role: 'user', content: 'old context' },
      {
        role: 'assistant',
        content: null,
        name: 'assistant-name',
        tool_calls: [{
          id: 'call_1',
          type: 'function',
          function: { name: 'write_file', arguments: '{"path":"a.png"}' },
        }],
      },
      {
        role: 'tool',
        content: 'download failed',
        tool_call_id: 'call_1',
        is_error: true,
        name: 'write_file',
      },
      { role: 'user', content: 'continue' },
    ],
  }
  const originalMessages = structuredClone(request.messages)

  const result = await forwarder.forwardChatCompletion(
    request,
    { id: 'account-1' },
    { id: 'provider-1', apiEndpoint: 'https://provider.invalid' },
    'model-1',
    { signal: new AbortController().signal },
  )

  assert.equal(result.success, true)
  assert.deepEqual(request.messages, originalMessages)
  assert.notEqual(forwardedRequest.messages[0], request.messages[1])
  assert.deepEqual(forwardedRequest.messages, originalMessages.slice(-3))
})

test('forwarder removes contaminated assistant history before adapter dispatch', async () => {
  let forwardedRequest
  const RequestForwarder = loadRequestForwarder()
  const forwarder = new RequestForwarder()
  forwarder.doForward = async request => {
    forwardedRequest = request
    return { success: true, status: 200, body: { choices: [] } }
  }

  const legacyWrapper = '<|CHAT2API|tool_result tool_call_id="call_fake"><![CDATA[fabricated result]]></|CHAT2API|tool_result>'
  const request = {
    model: 'model-1',
    messages: [
      { role: 'user', content: 'start' },
      { role: 'assistant', content: `fabricated preface ${legacyWrapper}` },
      {
        role: 'assistant',
        content: null,
        tool_calls: [{
          id: 'call_real',
          type: 'function',
          function: { name: 'inspect', arguments: '{"path":"src"}' },
        }],
      },
      { role: 'tool', tool_call_id: 'call_real', content: 'inspection complete' },
      { role: 'user', content: 'continue' },
    ],
  }
  const originalMessages = structuredClone(request.messages)

  const result = await forwarder.forwardChatCompletion(
    request,
    { id: 'account-1' },
    { id: 'provider-1', apiEndpoint: 'https://provider.invalid' },
    'model-1',
    { signal: new AbortController().signal },
  )

  assert.equal(result.success, true)
  assert.deepEqual(request.messages, originalMessages)
  assert.equal(forwardedRequest.messages.length, 4)
  assert.doesNotMatch(JSON.stringify(forwardedRequest.messages), /fabricated result|fabricated preface/)
  assert.equal(forwardedRequest.messages[1].tool_calls[0].id, 'call_real')
  assert.equal(forwardedRequest.messages[2].tool_call_id, 'call_real')
})

test('managed-tool buffered stream validation failure recovers once before bytes are committed', async () => {
  const previousBuffer = process.env.CHAT2API_QWEN_AI_BUFFER_MANAGED_STREAMS
  process.env.CHAT2API_QWEN_AI_BUFFER_MANAGED_STREAMS = 'true'
  try {
    const { attempts, execute } = createHarness([
      {
        success: false,
        status: 502,
        error: 'buffered upstream stream ended early',
        errorCode: 'qwen_ai_stream_incomplete',
        retryable: false,
        recoveryHint: 'managed_tool_stream_validation',
      },
      { success: true, status: 200, body: { choices: [] } },
    ])

    const result = await execute({
      model: 'model-1',
      messages: [],
      stream: true,
      tools: [{ type: 'function', function: { name: 'lookup', parameters: {} } }],
    })

    assert.equal(result.success, true)
    assert.equal(attempts.length, 2)
    assert.equal(attempts[0].qwenAiRecoveryBypassAccountInterval, false)
    assert.equal(attempts[1].qwenAiRecoveryBypassAccountInterval, true)
  } finally {
    if (previousBuffer === undefined) delete process.env.CHAT2API_QWEN_AI_BUFFER_MANAGED_STREAMS
    else process.env.CHAT2API_QWEN_AI_BUFFER_MANAGED_STREAMS = previousBuffer
  }
})

test('managed-tool streams stay live and do not retry when buffering is disabled', async () => {
  const previousBuffer = process.env.CHAT2API_QWEN_AI_BUFFER_MANAGED_STREAMS
  const previousRetries = process.env.CHAT2API_QWEN_AI_RETRY_COUNT
  process.env.CHAT2API_QWEN_AI_BUFFER_MANAGED_STREAMS = 'false'
  process.env.CHAT2API_QWEN_AI_RETRY_COUNT = '3'
  try {
    const { attempts, execute } = createHarness([{
      success: false,
      status: 502,
      error: 'late managed stream failure',
      recoveryHint: 'managed_tool_stream_validation',
    }, { success: true, status: 200, body: { choices: [] } }])
    const result = await execute({
      model: 'model-1',
      messages: [],
      stream: true,
      tools: [{ type: 'function', function: { name: 'lookup', parameters: {} } }],
    })

    assert.equal(result.success, false)
    assert.equal(attempts.length, 1)
  } finally {
    if (previousBuffer === undefined) delete process.env.CHAT2API_QWEN_AI_BUFFER_MANAGED_STREAMS
    else process.env.CHAT2API_QWEN_AI_BUFFER_MANAGED_STREAMS = previousBuffer
    if (previousRetries === undefined) delete process.env.CHAT2API_QWEN_AI_RETRY_COUNT
    else process.env.CHAT2API_QWEN_AI_RETRY_COUNT = previousRetries
  }
})

test('ordinary streams and unrelated failures do not use managed-tool recovery', async () => {
  const scenarios = [
    {
      request: { model: 'model-1', messages: [], stream: true },
      failure: { success: false, status: 502, error: 'stream ended early' },
    },
    {
      request: {
        model: 'model-1',
        messages: [],
        stream: true,
        tools: [{ type: 'function', function: { name: 'lookup', parameters: {} } }],
      },
      failure: { success: false, status: 429, error: 'queue full', retryable: false },
    },
    {
      request: {
        model: 'model-1',
        messages: [],
        stream: true,
        tools: [{ type: 'function', function: { name: 'lookup', parameters: {} } }],
      },
      failure: {
        success: false,
        status: 504,
        error: 'response timed out',
        retryable: false,
        recoveryHint: 'managed_tool_stream_validation',
      },
    },
    {
      request: {
        model: 'model-1',
        messages: [],
        stream: true,
        tools: [{ type: 'function', function: { name: 'lookup', parameters: {} } }],
      },
      failure: {
        success: false,
        status: 403,
        error: 'risk control',
        errorCode: 'qwen_ai_risk_control',
        retryable: false,
      },
    },
    {
      request: {
        model: 'model-1',
        messages: [],
        stream: true,
        tools: [{ type: 'function', function: { name: 'lookup', parameters: {} } }],
      },
      failure: { success: false, status: 499, error: 'client disconnected', retryable: false },
    },
  ]

  for (const { request, failure } of scenarios) {
    const { attempts, execute } = createHarness([failure])
    const result = await execute(request)
    assert.equal(result.success, false)
    assert.equal(attempts.length, 1)
  }
})

test('outer Qwen forwarding preserves account-neutral failures from results and thrown errors', async () => {
  const failures = [
    {
      success: false,
      status: 502,
      error: 'account-neutral result',
      retryable: false,
      accountFault: false,
    },
    Object.assign(new Error('account-neutral exception'), {
      status: 502,
      retryable: false,
      accountFault: false,
    }),
  ]

  for (const failure of failures) {
    const { attempts, execute } = createHarness([failure])
    const result = await execute({
      model: 'model-1',
      messages: [],
      stream: true,
    })

    assert.equal(result.success, false)
    assert.equal(result.status, 502)
    assert.equal(result.accountFault, false)
    assert.equal(attempts.length, 1)
  }
})

test('outer Qwen forwarding preserves parse-stage next-account classification', async () => {
  const parseTimeout = Object.assign(new Error('Qwen AI file parse timed out'), {
    status: 504,
    code: 'qwen_ai_file_parse_timeout',
    retryable: false,
    accountFault: false,
    retryScope: 'next-account',
  })
  const { attempts, execute } = createHarness([parseTimeout])

  const result = await execute({
    model: 'model-1',
    messages: [],
    stream: true,
  })

  assert.equal(result.success, false)
  assert.equal(result.status, 504)
  assert.equal(result.errorCode, 'qwen_ai_file_parse_timeout')
  assert.equal(result.retryable, false)
  assert.equal(result.accountFault, false)
  assert.equal(result.retryScope, 'next-account')
  assert.equal(attempts.length, 1, 'the same account must not replay the upload')
})

test('outer Qwen forwarding clears account classification when the client aborts', async () => {
  for (const upstreamStatus of [502, 499]) {
    const RequestForwarder = loadRequestForwarder()
    const forwarder = new RequestForwarder()
    const controller = new AbortController()

    forwarder.doForward = async () => {
      controller.abort()
      return {
        success: false,
        status: upstreamStatus,
        error: 'protocol failure overtaken by client cancellation',
        retryable: false,
        accountFault: false,
      }
    }

    const result = await forwarder.forwardChatCompletion(
      { model: 'model-1', messages: [], stream: true },
      { id: 'account-1' },
      { id: 'provider-1', apiEndpoint: 'https://provider.invalid' },
      'model-1',
      { signal: controller.signal },
    )

    assert.equal(result.success, false)
    assert.equal(result.status, 499)
    assert.equal(result.accountFault, undefined)
  }
})

test('an explicit zero retry count disables managed-tool recovery', async () => {
  const previous = process.env.CHAT2API_QWEN_AI_RETRY_COUNT
  const previousBuffer = process.env.CHAT2API_QWEN_AI_BUFFER_MANAGED_STREAMS
  process.env.CHAT2API_QWEN_AI_RETRY_COUNT = '0'
  process.env.CHAT2API_QWEN_AI_BUFFER_MANAGED_STREAMS = 'true'
  try {
    const { attempts, execute } = createHarness([{
      success: false,
      status: 502,
      error: 'buffered upstream stream ended early',
      recoveryHint: 'managed_tool_stream_validation',
    }])
    const result = await execute({
      model: 'model-1',
      messages: [],
      stream: true,
      tools: [{ type: 'function', function: { name: 'lookup', parameters: {} } }],
    })

    assert.equal(result.success, false)
    assert.equal(attempts.length, 1)
  } finally {
    if (previous === undefined) delete process.env.CHAT2API_QWEN_AI_RETRY_COUNT
    else process.env.CHAT2API_QWEN_AI_RETRY_COUNT = previous
    if (previousBuffer === undefined) delete process.env.CHAT2API_QWEN_AI_BUFFER_MANAGED_STREAMS
    else process.env.CHAT2API_QWEN_AI_BUFFER_MANAGED_STREAMS = previousBuffer
  }
})

test('managed-tool recovery honors the configured retry count', async () => {
  const previous = process.env.CHAT2API_QWEN_AI_RETRY_COUNT
  const previousBuffer = process.env.CHAT2API_QWEN_AI_BUFFER_MANAGED_STREAMS
  process.env.CHAT2API_QWEN_AI_RETRY_COUNT = '2'
  process.env.CHAT2API_QWEN_AI_BUFFER_MANAGED_STREAMS = 'true'
  try {
    const failure = {
      success: false,
      status: 502,
      error: 'buffered upstream stream ended early',
      recoveryHint: 'managed_tool_stream_validation',
    }
    const { attempts, execute } = createHarness([failure, failure, {
      success: true,
      status: 200,
      body: { choices: [] },
    }])
    const result = await execute({
      model: 'model-1',
      messages: [],
      stream: true,
      tools: [{ type: 'function', function: { name: 'lookup', parameters: {} } }],
    })

    assert.equal(result.success, true)
    assert.equal(attempts.length, 3)
  } finally {
    if (previous === undefined) delete process.env.CHAT2API_QWEN_AI_RETRY_COUNT
    else process.env.CHAT2API_QWEN_AI_RETRY_COUNT = previous
    if (previousBuffer === undefined) delete process.env.CHAT2API_QWEN_AI_BUFFER_MANAGED_STREAMS
    else process.env.CHAT2API_QWEN_AI_BUFFER_MANAGED_STREAMS = previousBuffer
  }
})

test('an explicit retry count does not enable ordinary Qwen stream retries', async () => {
  const previous = process.env.CHAT2API_QWEN_AI_RETRY_COUNT
  process.env.CHAT2API_QWEN_AI_RETRY_COUNT = '1'
  try {
    const { attempts, execute } = createHarness([{
      success: false,
      status: 502,
      error: 'ordinary upstream stream ended early',
    }])
    const result = await execute({
      model: 'model-1',
      messages: [],
      stream: true,
    })

    assert.equal(result.success, false)
    assert.equal(attempts.length, 1)
  } finally {
    if (previous === undefined) delete process.env.CHAT2API_QWEN_AI_RETRY_COUNT
    else process.env.CHAT2API_QWEN_AI_RETRY_COUNT = previous
  }
})

test('Qwen upstream busy retries the same account and can recover within the request budget', async () => {
  const RequestForwarder = loadRequestForwarder({ qwenAiRequestTimeoutMs: 600_000 })
  const forwarder = new RequestForwarder()
  const attempts = []
  const delays = []
  forwarder.delay = async delayMs => {
    delays.push(delayMs)
    return true
  }
  forwarder.doForward = async (...args) => {
    attempts.push(args.at(-1))
    if (attempts.length === 1) {
      return {
        success: false,
        status: 503,
        error: 'Qwen AI upstream is busy',
        errorCode: 'qwen_ai_upstream_busy',
        retryable: true,
        accountFault: false,
      }
    }
    return { success: true, status: 200, body: { choices: [] } }
  }

  const result = await forwarder.forwardChatCompletion(
    { model: 'model-1', messages: [], stream: true },
    { id: 'account-1' },
    { id: 'qwen-ai', apiEndpoint: 'https://chat.qwen.ai' },
    'model-1',
    { signal: new AbortController().signal },
  )

  assert.equal(result.success, true)
  assert.equal(attempts.length, 2)
  assert.deepEqual(attempts.map(item => item.attempt), [1, 2])
  assert.deepEqual(
    attempts.map(item => item.qwenAiMessageTransport),
    ['inline', 'document'],
    'only a real upstream-busy result should switch the complete request to document transport',
  )
  assert.deepEqual(
    attempts.map(item => item.qwenAiRecoveryBypassAccountInterval),
    [false, true],
    'the one transport fallback must not wait behind the completed inline attempt account interval',
  )
  assert.ok(attempts.every(item => item.qwenAiRequestTimeoutMs > 0))
  assert.ok(attempts[1].qwenAiRequestTimeoutMs <= attempts[0].qwenAiRequestTimeoutMs)
  assert.deepEqual(delays, [1000])
})

test('Qwen upstream busy recovery honors the configured retry count', async () => {
  const previous = process.env.CHAT2API_QWEN_AI_BUSY_RETRY_COUNT
  process.env.CHAT2API_QWEN_AI_BUSY_RETRY_COUNT = '2'
  try {
    const RequestForwarder = loadRequestForwarder({ qwenAiRequestTimeoutMs: 600_000 })
    const forwarder = new RequestForwarder()
    let attempts = 0
    let delayCalls = 0
    forwarder.delay = async () => {
      delayCalls += 1
      return true
    }
    forwarder.doForward = async () => {
      attempts += 1
      return {
        success: false,
        status: 503,
        error: 'Qwen AI upstream is busy',
        errorCode: 'qwen_ai_upstream_busy',
        retryable: true,
        accountFault: false,
      }
    }

    const result = await forwarder.forwardChatCompletion(
      { model: 'model-1', messages: [], stream: true },
      { id: 'account-1' },
      { id: 'qwen-ai', apiEndpoint: 'https://chat.qwen.ai' },
      'model-1',
      { signal: new AbortController().signal },
    )

    assert.equal(result.success, false)
    assert.equal(result.errorCode, 'qwen_ai_upstream_busy')
    assert.equal(attempts, 3)
    assert.equal(delayCalls, 2)
  } finally {
    if (previous === undefined) delete process.env.CHAT2API_QWEN_AI_BUSY_RETRY_COUNT
    else process.env.CHAT2API_QWEN_AI_BUSY_RETRY_COUNT = previous
  }
})

test('Qwen managed-tool busy retry switches to hybrid document transport', async () => {
  const RequestForwarder = loadRequestForwarder({ qwenAiRequestTimeoutMs: 600_000 })
  const forwarder = new RequestForwarder()
  const attempts = []
  forwarder.delay = async () => true
  forwarder.doForward = async (...args) => {
    attempts.push(args.at(-1))
    if (attempts.length === 1) {
      return {
        success: false,
        status: 503,
        error: 'Qwen AI upstream is busy',
        errorCode: 'qwen_ai_upstream_busy',
        retryable: true,
        accountFault: false,
      }
    }
    return { success: true, status: 200, body: { choices: [] } }
  }

  const result = await forwarder.forwardChatCompletion(
    {
      model: 'configured-model',
      messages: [{ role: 'user', content: 'read the requested file' }],
      stream: true,
      tools: [{
        type: 'function',
        function: { name: 'read_file', parameters: { type: 'object' } },
      }],
    },
    { id: 'account-1' },
    { id: 'qwen-ai', apiEndpoint: 'https://chat.qwen.ai' },
    'configured-model',
    { signal: new AbortController().signal },
  )

  assert.equal(result.success, true)
  assert.equal(attempts.length, 2)
  assert.deepEqual(
    attempts.map(item => item.qwenAiMessageTransport),
    ['inline', 'document'],
  )
  assert.deepEqual(
    attempts.map(item => item.qwenAiRecoveryBypassAccountInterval),
    [false, true],
  )
})

test('Qwen large managed-tool request stays inline until the provider reports busy', async () => {
  const RequestForwarder = loadRequestForwarder({
    qwenAiRequestTimeoutMs: 600_000,
    estimateQwenAiRequestInputTokens: () => 120_000,
  })
  const forwarder = new RequestForwarder()
  const attempts = []
  forwarder.doForward = async (...args) => {
    attempts.push(args.at(-1))
    return { success: true, status: 200, body: { choices: [] } }
  }

  const result = await forwarder.forwardChatCompletion(
    {
      model: 'configured-model',
      messages: [{ role: 'user', content: 'continue the current task' }],
      stream: true,
      tools: [{
        type: 'function',
        function: { name: 'read_file', parameters: { type: 'object' } },
      }],
    },
    { id: 'account-1' },
    { id: 'qwen-ai', apiEndpoint: 'https://chat.qwen.ai' },
    'configured-model',
    { signal: new AbortController().signal },
  )

  assert.equal(result.success, true)
  assert.equal(attempts.length, 1)
  assert.equal(attempts[0].qwenAiMessageTransport, 'inline')
})

test('Qwen upstream busy stops at the cumulative request budget', async () => {
  const RequestForwarder = loadRequestForwarder({ qwenAiRequestTimeoutMs: 500 })
  const forwarder = new RequestForwarder()
  let attempts = 0
  let delayCalls = 0
  forwarder.delay = async () => {
    delayCalls += 1
    return true
  }
  forwarder.doForward = async () => {
    attempts += 1
    return {
      success: false,
      status: 503,
      error: 'Qwen AI upstream is busy',
      errorCode: 'qwen_ai_upstream_busy',
      retryable: true,
      accountFault: false,
    }
  }

  const result = await forwarder.forwardChatCompletion(
    { model: 'model-1', messages: [], stream: true },
    { id: 'account-1' },
    { id: 'qwen-ai', apiEndpoint: 'https://chat.qwen.ai' },
    'model-1',
    { signal: new AbortController().signal },
  )

  assert.equal(result.success, false)
  assert.equal(result.errorCode, 'qwen_ai_upstream_busy')
  assert.equal(result.accountFault, false)
  assert.equal(attempts, 1)
  assert.equal(delayCalls, 0)
})

test('Qwen upstream busy retry stops immediately when the client aborts', async () => {
  const RequestForwarder = loadRequestForwarder({ qwenAiRequestTimeoutMs: 600_000 })
  const forwarder = new RequestForwarder()
  const controller = new AbortController()
  let attempts = 0
  forwarder.delay = async () => {
    controller.abort()
    return false
  }
  forwarder.doForward = async () => {
    attempts += 1
    return {
      success: false,
      status: 503,
      error: 'Qwen AI upstream is busy',
      errorCode: 'qwen_ai_upstream_busy',
      retryable: true,
      accountFault: false,
    }
  }

  const result = await forwarder.forwardChatCompletion(
    { model: 'model-1', messages: [], stream: true },
    { id: 'account-1' },
    { id: 'qwen-ai', apiEndpoint: 'https://chat.qwen.ai' },
    'model-1',
    { signal: controller.signal },
  )

  assert.equal(result.status, 499)
  assert.equal(attempts, 1)
})

test('Qwen request deadline stays absolute across governor queue time and account attempts', async (t) => {
  const originalNow = Date.now
  let now = 1_000_000
  let governorAdvanceMs = 30
  Date.now = () => now
  t.after(() => {
    Date.now = originalNow
  })

  const adapterRequests = []
  const governorDeadlines = []
  const resumableOptions = []
  const streamHandlingOptions = []
  const nonStreamHandlingOptions = []
  const streams = []

  class QwenAiAdapter {
    static isQwenAiProvider() { return true }

    async chatCompletion(request) {
      adapterRequests.push(request)
      const stream = new PassThrough()
      streams.push(stream)
      stream.end('data: {"choices":[{"delta":{"content":"ready"}}]}\n\n')
      return {
        response: { status: 200, data: stream, headers: {} },
        chatId: `deadline-chat-${adapterRequests.length}`,
        parentId: null,
      }
    }

    async deleteChat() { return true }
  }

  class QwenAiStreamHandler {
    setChatId() {}
    getResponseId() { return '' }
    getPendingSemanticRecoveryError() { return undefined }
    isComplete() { return true }
    async handleStream(stream, options) {
      streamHandlingOptions.push(options)
      return stream
    }
    async handleNonStream(_stream, options) {
      nonStreamHandlingOptions.push(options)
      return {
        choices: [{ message: { role: 'assistant', content: 'ready' } }],
      }
    }
  }

  const RequestForwarder = loadRequestForwarder({
    QwenAiAdapter,
    QwenAiStreamHandler,
    qwenAiRequestTimeoutMs: 100,
    qwenAiRequestGovernor: {
      async run(_accountId, operation, options) {
        governorDeadlines.push(options.deadlineAt)
        now += governorAdvanceMs
        return operation()
      },
    },
    createQwenAiResumableStream(stream, options) {
      resumableOptions.push(options)
      return stream
    },
  })
  const forwarder = new RequestForwarder()
  forwarder.transformRequestForPromptToolUse = request => ({
    messages: request.messages,
    plan: { shouldParseResponse: false },
  })
  forwarder.applyToolCallsToResponse = () => {}
  const firstStartedAt = now
  const context = {
    signal: new AbortController().signal,
    startTime: firstStartedAt,
  }
  const first = await forwarder.forwardChatCompletion(
    { model: 'model-1', messages: [], stream: true },
    { id: 'account-1' },
    { id: 'qwen-ai', apiEndpoint: 'https://chat.qwen.ai' },
    'model-1',
    context,
  )

  assert.equal(first.success, true)
  assert.equal(adapterRequests[0].timeoutMs, 70)
  assert.equal(adapterRequests[0].deadlineAt, firstStartedAt + 100)
  assert.equal(resumableOptions[0].workflowRecoveryDeadlineAt, firstStartedAt + 100)
  assert.equal(streamHandlingOptions[0].requestDeadlineAt, firstStartedAt + 100)

  const second = await forwarder.forwardChatCompletion(
    { model: 'model-1', messages: [], stream: false },
    { id: 'account-2' },
    { id: 'qwen-ai', apiEndpoint: 'https://chat.qwen.ai' },
    'model-1',
    context,
  )

  assert.equal(second.success, true)
  assert.equal(adapterRequests[1].timeoutMs, 40)
  assert.equal(adapterRequests[1].deadlineAt, firstStartedAt + 100)
  assert.equal(resumableOptions[1].workflowRecoveryDeadlineAt, firstStartedAt + 100)
  assert.equal(nonStreamHandlingOptions[0].requestDeadlineAt, firstStartedAt + 100)

  governorAdvanceMs = 50
  const expired = await forwarder.forwardChatCompletion(
    { model: 'model-1', messages: [], stream: true },
    { id: 'account-3' },
    { id: 'qwen-ai', apiEndpoint: 'https://chat.qwen.ai' },
    'model-1',
    context,
  )

  assert.equal(expired.success, false)
  assert.equal(expired.status, 504)
  assert.equal(expired.errorCode, 'qwen_ai_request_timeout')
  assert.equal(expired.retryable, false)
  assert.equal(expired.accountFault, false)
  assert.deepEqual(governorDeadlines, [
    firstStartedAt + 100,
    firstStartedAt + 100,
    firstStartedAt + 100,
  ])
  assert.equal(adapterRequests.length, 2)
  assert.equal(resumableOptions.length, 2)

  for (const stream of streams) stream.destroy()
})

test('Qwen context management cannot outlive the cumulative request deadline', async () => {
  const controller = new AbortController()
  const RequestForwarder = loadRequestForwarder({
    qwenAiRequestTimeoutMs: 60,
    storeConfig: {
      retryCount: 0,
      contextManagement: { enabled: true },
      toolCallingConfig: {},
    },
    processContextMessages: async () => new Promise(() => {}),
  })
  const forwarder = new RequestForwarder()
  let forwardCalls = 0
  forwarder.doForward = async () => {
    forwardCalls += 1
    return { success: true, status: 200, body: { choices: [] } }
  }
  const startedAt = Date.now()

  const result = await forwarder.forwardChatCompletion(
    { model: 'model-1', messages: [{ role: 'user', content: 'long context' }], stream: false },
    { id: 'account-1' },
    { id: 'qwen-ai', apiEndpoint: 'https://chat.qwen.ai' },
    'model-1',
    { signal: controller.signal, startTime: startedAt },
  )

  assert.equal(result.success, false)
  assert.equal(result.status, 504)
  assert.equal(result.errorCode, 'qwen_ai_request_timeout')
  assert.equal(result.retryable, false)
  assert.equal(result.accountFault, false)
  assert.equal(forwardCalls, 0)
  assert.ok(Date.now() - startedAt < 500)
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0)
})

test('Qwen standard retry backoff is clamped to the remaining route deadline', async (t) => {
  const originalNow = Date.now
  let now = 2_000_000
  Date.now = () => now
  t.after(() => {
    Date.now = originalNow
  })

  const RequestForwarder = loadRequestForwarder({ qwenAiRequestTimeoutMs: 100 })
  const forwarder = new RequestForwarder()
  const delayCalls = []
  let forwardCalls = 0
  forwarder.delay = async (ms) => {
    delayCalls.push(ms)
    now += ms
    return true
  }
  forwarder.doForward = async () => {
    forwardCalls += 1
    now += 90
    return {
      success: false,
      status: 502,
      error: 'managed validation failed',
      retryable: true,
      recoveryHint: 'managed_tool_stream_validation',
    }
  }

  const result = await forwarder.forwardChatCompletion(
    {
      model: 'model-1',
      messages: [{ role: 'user', content: 'use a tool' }],
      stream: true,
      tools: [{ type: 'function', function: { name: 'work', parameters: {} } }],
      tool_choice: 'auto',
    },
    { id: 'account-1' },
    { id: 'qwen-ai', apiEndpoint: 'https://chat.qwen.ai' },
    'model-1',
    { signal: new AbortController().signal, startTime: now },
  )

  assert.equal(result.success, false)
  assert.equal(result.status, 504)
  assert.equal(result.errorCode, 'qwen_ai_request_timeout')
  assert.equal(result.retryable, false)
  assert.equal(result.accountFault, false)
  assert.equal(forwardCalls, 1)
  assert.deepEqual(delayCalls, [10])
})

test('Qwen AI handler usage is estimated from the original request before tool prompt injection', async () => {
  let estimatedRequest
  let handlerPromptTokens

  class QwenAiAdapter {
    static isQwenAiProvider() { return true }

    async chatCompletion() {
      return {
        response: { status: 200, data: new PassThrough(), headers: {} },
        chatId: 'usage-source-chat',
        parentId: null,
      }
    }

    async deleteChat() { return true }
  }

  class QwenAiStreamHandler {
    constructor(_model, _onEnd, _plan, promptTokens) {
      handlerPromptTokens = promptTokens
    }

    setChatId() {}

    async handleNonStream() {
      return {
        choices: [{ message: { role: 'assistant', content: 'ready' } }],
      }
    }
  }

  const RequestForwarder = loadRequestForwarder({
    QwenAiAdapter,
    QwenAiStreamHandler,
    estimateQwenAiRequestInputTokens(request) {
      estimatedRequest = request
      return request.messages[0].content.length + JSON.stringify(request.tools).length
    },
  })
  const forwarder = new RequestForwarder()
  forwarder.transformRequestForPromptToolUse = request => ({
    messages: [
      { role: 'system', content: 'injected managed tool prompt '.repeat(10_000) },
      ...request.messages,
    ],
    plan: { shouldParseResponse: false },
  })
  forwarder.applyToolCallsToResponse = () => {}
  const request = {
    model: 'model-1',
    messages: [{ role: 'user', content: 'original request text' }],
    stream: false,
    tools: [{
      type: 'function',
      function: {
        name: 'lookup',
        description: 'original tool schema',
        parameters: { type: 'object', properties: { query: { type: 'string' } } },
      },
    }],
  }
  const expectedPromptTokens = request.messages[0].content.length
    + JSON.stringify(request.tools).length

  const result = await forwarder.forwardQwenAi(
    request,
    { id: 'account-1' },
    { id: 'qwen-ai', apiEndpoint: 'https://chat.qwen.ai' },
    'model-1',
    Date.now(),
    { signal: new AbortController().signal },
  )

  assert.equal(result.success, true)
  assert.equal(estimatedRequest, request)
  assert.equal(handlerPromptTokens, expectedPromptTokens)
})

test('live managed-tool forwarding deletes its temporary chat only after stream termination', async (t) => {
  const previousBuffer = process.env.CHAT2API_QWEN_AI_BUFFER_MANAGED_STREAMS
  process.env.CHAT2API_QWEN_AI_BUFFER_MANAGED_STREAMS = 'false'
  t.after(() => {
    if (previousBuffer === undefined) delete process.env.CHAT2API_QWEN_AI_BUFFER_MANAGED_STREAMS
    else process.env.CHAT2API_QWEN_AI_BUFFER_MANAGED_STREAMS = previousBuffer
  })
  const output = new PassThrough()
  const deleteCalls = []
  const handlingOptions = []

  class QwenAiAdapter {
    static isQwenAiProvider() { return true }

    async chatCompletion() {
      return {
        response: { status: 200, data: new PassThrough(), headers: {} },
        chatId: 'temporary-chat-1',
        parentId: null,
      }
    }

    async deleteChat(chatId) {
      deleteCalls.push(chatId)
      return true
    }
  }

  class QwenAiStreamHandler {
    setChatId() {}
    async handleStream(_stream, options) {
      handlingOptions.push(options)
      return output
    }
  }

  const RequestForwarder = loadRequestForwarder({ QwenAiAdapter, QwenAiStreamHandler })
  const forwarder = new RequestForwarder()
  forwarder.transformRequestForPromptToolUse = request => ({
    messages: request.messages,
    plan: { shouldParseResponse: true },
  })

  const resultPromise = forwarder.forwardQwenAi(
    {
      model: 'model-1',
      messages: [],
      stream: true,
      tools: [{ type: 'function', function: { name: 'lookup', parameters: {} } }],
    },
    { id: 'account-1' },
    { id: 'qwen-ai', apiEndpoint: 'https://chat.qwen.ai' },
    'model-1',
    Date.now(),
    { signal: new AbortController().signal },
  )

  const firstChunk = 'data: {"choices":[{"delta":{"content":"ready"}}]}\n\n'
  output.write(firstChunk)
  const result = await resultPromise

  assert.equal(result.success, true)
  assert.equal(result.stream, output)
  assert.equal(handlingOptions[0]?.bufferManagedBranch, false)
  assert.deepEqual(deleteCalls, [])

  const received = []
  output.on('data', chunk => received.push(chunk))
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(Buffer.concat(received).toString(), firstChunk)

  const finished = once(output, 'finish')
  output.end('data: [DONE]\n\n')
  await finished
  assert.deepEqual(deleteCalls, ['temporary-chat-1'])

  output.destroy()
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(deleteCalls, ['temporary-chat-1'])
})

test('Qwen non-stream success does not wait for temporary chat deletion', async () => {
  const deleteCalls = []

  class QwenAiAdapter {
    static isQwenAiProvider() { return true }

    async chatCompletion() {
      return {
        response: { status: 200, data: new PassThrough(), headers: {} },
        chatId: 'temporary-chat-non-stream',
        parentId: null,
      }
    }

    async deleteChat(chatId) {
      deleteCalls.push(chatId)
      return new Promise(() => {})
    }
  }

  class QwenAiStreamHandler {
    setChatId() {}

    async handleNonStream() {
      return {
        choices: [{ message: { role: 'assistant', content: 'ready' } }],
      }
    }
  }

  const RequestForwarder = loadRequestForwarder({ QwenAiAdapter, QwenAiStreamHandler })
  const forwarder = new RequestForwarder()
  forwarder.transformRequestForPromptToolUse = request => ({
    messages: request.messages,
    plan: { shouldParseResponse: false },
  })
  forwarder.applyToolCallsToResponse = () => {}

  let timeout
  const result = await Promise.race([
    forwarder.forwardQwenAi(
      { model: 'model-1', messages: [], stream: false },
      { id: 'account-1' },
      { id: 'qwen-ai', apiEndpoint: 'https://chat.qwen.ai' },
      'model-1',
      Date.now(),
      { signal: new AbortController().signal },
    ),
    new Promise((_, reject) => {
      timeout = setTimeout(() => reject(new Error('non-stream response waited for deleteChat')), 250)
    }),
  ]).finally(() => clearTimeout(timeout))

  assert.equal(result.success, true, JSON.stringify(result))
  assert.equal(result.status, 200)
  assert.equal(result.providerSessionId, 'temporary-chat-non-stream')
  assert.equal(result.body.choices[0].message.content, 'ready')
  assert.deepEqual(deleteCalls, ['temporary-chat-non-stream'])
})

test('deferred managed-tool validation has no time-based release threshold', async (t) => {
  const previousBuffer = process.env.CHAT2API_QWEN_AI_BUFFER_MANAGED_STREAMS
  const previousHold = process.env.CHAT2API_VALIDATED_SSE_MAX_HOLD_MS
  process.env.CHAT2API_QWEN_AI_BUFFER_MANAGED_STREAMS = 'true'
  process.env.CHAT2API_VALIDATED_SSE_MAX_HOLD_MS = '12345'
  t.after(() => {
    if (previousBuffer === undefined) delete process.env.CHAT2API_QWEN_AI_BUFFER_MANAGED_STREAMS
    else process.env.CHAT2API_QWEN_AI_BUFFER_MANAGED_STREAMS = previousBuffer
    if (previousHold === undefined) delete process.env.CHAT2API_VALIDATED_SSE_MAX_HOLD_MS
    else process.env.CHAT2API_VALIDATED_SSE_MAX_HOLD_MS = previousHold
  })

  const output = new PassThrough()
  const validationOptions = []

  class QwenAiAdapter {
    static isQwenAiProvider() { return true }

    async chatCompletion() {
      return {
        response: { status: 200, data: new PassThrough(), headers: {} },
        chatId: 'temporary-chat-atomic',
        parentId: null,
      }
    }

    async deleteChat() { return true }
  }

  class QwenAiStreamHandler {
    setChatId() {}
    async handleStream() { return output }
  }

  const RequestForwarder = loadRequestForwarder({
    QwenAiAdapter,
    QwenAiStreamHandler,
    bufferValidatedSseStream: async (stream, options) => {
      validationOptions.push(options)
      return stream
    },
  })
  const forwarder = new RequestForwarder()
  forwarder.transformRequestForPromptToolUse = request => ({
    messages: request.messages,
    plan: { shouldParseResponse: true },
  })

  const resultPromise = forwarder.forwardQwenAi(
    {
      model: 'model-1',
      messages: [],
      stream: true,
      tools: [{ type: 'function', function: { name: 'lookup', parameters: {} } }],
    },
    { id: 'account-1' },
    { id: 'qwen-ai', apiEndpoint: 'https://chat.qwen.ai' },
    'model-1',
    Date.now(),
    {
      signal: new AbortController().signal,
      deferManagedStreamCommit: true,
    },
  )

  output.write('data: {"choices":[{"delta":{"content":"validated"}}]}\n\n')
  const result = await resultPromise

  assert.equal(result.success, true)
  assert.equal(validationOptions.length, 1)
  assert.equal(
    Object.prototype.hasOwnProperty.call(validationOptions[0], 'maxHoldMs'),
    false,
  )

  output.destroy()
})

test('Qwen AI forwarder keeps malformed-tool recovery in the same chat', async (t) => {
  const previousBuffer = process.env.CHAT2API_QWEN_AI_BUFFER_MANAGED_STREAMS
  process.env.CHAT2API_QWEN_AI_BUFFER_MANAGED_STREAMS = 'true'
  t.after(() => {
    if (previousBuffer === undefined) delete process.env.CHAT2API_QWEN_AI_BUFFER_MANAGED_STREAMS
    else process.env.CHAT2API_QWEN_AI_BUFFER_MANAGED_STREAMS = previousBuffer
  })
  const output = new PassThrough()
  const initialUpstream = new PassThrough()
  const continuedUpstream = new PassThrough()
  const continuationCalls = []
  const continuationMessageOptions = []
  const resumeCalls = []
  const bridgeOptions = []
  const handlingOptions = []
  let resetCalls = 0

  class QwenAiAdapter {
    static isQwenAiProvider() { return true }

    async chatCompletion() {
      return {
        response: { status: 200, data: initialUpstream, headers: {} },
        chatId: 'temporary-chat-continuation',
        parentId: 'placeholder-parent',
      }
    }

    async resumeChatCompletion(_chatId, responseId) {
      resumeCalls.push(responseId)
      return { data: continuedUpstream }
    }

    async continueChatCompletion(request) {
      continuationCalls.push(request)
      return { data: continuedUpstream }
    }

    async deleteChat() { return true }
  }

  class QwenAiStreamHandler {
    setChatId() {}
    getResponseId() { return 'latest-response-id' }
    isComplete() { return false }
    prepareForWorkflowContinuation() { resetCalls += 1 }
    async handleStream(_stream, options) {
      handlingOptions.push(options)
      return output
    }
  }

  const RequestForwarder = loadRequestForwarder({
    QwenAiAdapter,
    QwenAiStreamHandler,
    createQwenAiResumableStream: (stream, options) => {
      bridgeOptions.push(options)
      return stream
    },
    createToolWorkflowContinuationMessage: options => {
      continuationMessageOptions.push(options)
      return {
        role: 'user',
        content: 'generic workflow continuation',
      }
    },
  })
  const forwarder = new RequestForwarder()
  forwarder.transformRequestForPromptToolUse = request => ({
    messages: request.messages,
    plan: {
      protocol: 'managed_xml',
      tools: [],
      shouldParseResponse: true,
      allowedToolNames: new Set(['lookup']),
      toolChoiceMode: 'auto',
      workflowContinuation: false,
      failedToolResultPending: false,
    },
  })

  const resultPromise = forwarder.forwardQwenAi(
    {
      model: 'model-1',
      messages: [{ role: 'user', content: 'original request must not be replayed' }],
      stream: true,
      tools: [{ type: 'function', function: { name: 'lookup', parameters: {} } }],
    },
    { id: 'account-1' },
    { id: 'qwen-ai', apiEndpoint: 'https://chat.qwen.ai' },
    'model-1',
    Date.now(),
    { signal: new AbortController().signal },
  )

  output.write('data: {"choices":[{"delta":{"content":"ready"}}]}\n\n')
  const result = await resultPromise
  assert.equal(result.success, true)
  assert.equal(bridgeOptions.length, 1)
  assert.equal(handlingOptions[0]?.bufferManagedBranch, true)

  const options = bridgeOptions[0]
  assert.equal(typeof options.continueWorkflow, 'function')
  assert.equal(typeof options.onWorkflowContinuation, 'function')
  assert.equal(typeof options.resume, 'function')
  assert.equal(continuationMessageOptions.length, 0)

  const recoveryError = Object.assign(new Error('managed tool call needs correction'), {
    code: 'malformed_tool_call',
  })
  const continuation = await options.continueWorkflow('response-parent-42', recoveryError)
  assert.equal(continuation.data, continuedUpstream)
  assert.equal(continuationCalls.length, 1)
  assert.equal(continuationCalls[0].chatId, 'temporary-chat-continuation')
  assert.equal(continuationCalls[0].parentId, 'response-parent-42')
  assert.equal(continuationCalls[0].content, 'generic workflow continuation')
  assert.equal(continuationCalls[0].messages, undefined)
  assert.equal(continuationMessageOptions.length, 1)
  assert.equal(continuationMessageOptions[0].requireManagedToolCall, true)

  options.onWorkflowContinuation()
  assert.equal(resetCalls, 1)
  await options.resume('response-parent-42')
  assert.deepEqual(resumeCalls, ['response-parent-42'])

  output.destroy()
  initialUpstream.destroy()
  continuedUpstream.destroy()
})

test('Qwen AI forwarder keeps only structural recovery cases tool-only', async (t) => {
  const scenarios = [
    {
      name: 'required tool choice',
      toolChoiceMode: 'required',
      failedToolResultPending: false,
      recoveryCode: 'qwen_ai_semantic_incomplete',
      requireManagedToolCall: true,
    },
    {
      name: 'failed tool result',
      toolChoiceMode: 'auto',
      failedToolResultPending: true,
      recoveryCode: 'qwen_ai_semantic_incomplete',
      requireManagedToolCall: false,
    },
    {
      name: 'invalid tool arguments',
      toolChoiceMode: 'auto',
      failedToolResultPending: false,
      recoveryCode: 'qwen_ai_invalid_tool_arguments',
      requireManagedToolCall: true,
    },
    {
      name: 'managed tool-result wrapper leak',
      toolChoiceMode: 'auto',
      failedToolResultPending: false,
      recoveryCode: 'qwen_ai_wrapper_leak',
      freshChat: true,
      requireManagedToolCall: true,
    },
  ]

  for (const scenario of scenarios) {
    await t.test(scenario.name, async () => {
      const output = new PassThrough()
      const initialUpstream = new PassThrough()
      const continuedUpstream = new PassThrough()
      const bridgeOptions = []
      const continuationMessageOptions = []
      const chatCompletionCalls = []
      const continuationCalls = []

      class QwenAiAdapter {
        static isQwenAiProvider() { return true }

        async chatCompletion(request) {
          chatCompletionCalls.push(request)
          return {
            response: { status: 200, data: initialUpstream, headers: {} },
            chatId: `chat-${scenario.name}-${chatCompletionCalls.length}`,
            parentId: null,
          }
        }

        async continueChatCompletion(request) {
          continuationCalls.push(request)
          return { data: continuedUpstream }
        }

        async deleteChat() { return true }
      }

      class QwenAiStreamHandler {
        setChatId() {}
        getResponseId() { return 'mandatory-recovery-response' }
        isComplete() { return false }
        prepareForWorkflowContinuation() {}
        async handleStream() { return output }
      }

      const RequestForwarder = loadRequestForwarder({
        QwenAiAdapter,
        QwenAiStreamHandler,
        createQwenAiResumableStream: (stream, options) => {
          bridgeOptions.push(options)
          return stream
        },
        createToolWorkflowContinuationMessage: options => {
          continuationMessageOptions.push(options)
          return { role: 'user', content: 'mandatory workflow continuation' }
        },
      })
      const forwarder = new RequestForwarder()
      forwarder.transformRequestForPromptToolUse = request => ({
        messages: request.messages,
        plan: {
          protocol: 'managed_xml',
          tools: [],
          shouldParseResponse: true,
          allowedToolNames: new Set(['lookup']),
          toolChoiceMode: scenario.toolChoiceMode,
          workflowContinuation: false,
          failedToolResultPending: scenario.failedToolResultPending,
        },
      })

      const resultPromise = forwarder.forwardQwenAi(
        {
          model: 'model-1',
          messages: [{ role: 'user', content: 'finish the active operation' }],
          stream: true,
          tools: [{ type: 'function', function: { name: 'lookup', parameters: {} } }],
        },
        { id: 'account-1' },
        { id: 'qwen-ai', apiEndpoint: 'https://chat.qwen.ai' },
        'model-1',
        Date.now(),
        { signal: new AbortController().signal },
      )

      output.write('data: {"choices":[{"delta":{"content":"ready"}}]}\n\n')
      const result = await resultPromise
      assert.equal(result.success, true)

      const recoveryError = Object.assign(new Error('managed branch did not complete'), {
        code: scenario.recoveryCode,
      })
      await bridgeOptions[0].continueWorkflow('mandatory-recovery-response', recoveryError)

      assert.equal(continuationMessageOptions.length, 1)
      assert.equal(
        continuationMessageOptions[0].requireManagedToolCall,
        scenario.requireManagedToolCall,
      )
      assert.equal(
        continuationMessageOptions[0].completionProofMissing,
        scenario.recoveryCode === 'qwen_ai_semantic_incomplete'
          && !scenario.requireManagedToolCall,
      )
      assert.equal(chatCompletionCalls.length, scenario.freshChat ? 2 : 1)
      assert.equal(continuationCalls.length, scenario.freshChat ? 0 : 1)
      if (scenario.freshChat) {
        assert.equal(
          chatCompletionCalls[1].messages.at(-1).content,
          'mandatory workflow continuation',
        )
      }

      output.destroy()
      initialUpstream.destroy()
      continuedUpstream.destroy()
    })
  }
})

test('Qwen AI forwarder continues auto semantic-empty recovery without replaying the transcript', async () => {
  const output = new PassThrough()
  const initialUpstream = new PassThrough()
  const restartedUpstream = new PassThrough()
  const chatCalls = []
  const continuationCalls = []
  const deleteCalls = []
  const bridgeOptions = []
  const plan = {
    protocol: 'managed_xml',
    tools: [{
      name: 'lookup',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string' } },
        required: ['path'],
      },
      source: 'openai',
    }],
    shouldParseResponse: true,
    allowedToolNames: new Set(['lookup']),
    toolChoiceMode: 'auto',
    workflowContinuation: true,
    failedToolResultPending: false,
  }
  const originallyInjectedContinuation = createRealToolWorkflowContinuationMessage({
    failedToolResultPending: false,
    plan,
  })
  const completionCapableRecovery = createRealToolWorkflowContinuationMessage({
    failedToolResultPending: false,
    requireManagedToolCall: false,
    plan,
  })
  assert.equal(
    originallyInjectedContinuation.content,
    completionCapableRecovery.content,
    'auto recovery must preserve the option to return a verified final answer',
  )
  const anchoredCompletionCapableRecovery = createRealToolWorkflowContinuationMessage({
    activeUserRequest: 'create the requested artifact',
    failedToolResultPending: false,
    requireManagedToolCall: false,
    plan,
  })

  class QwenAiAdapter {
    static isQwenAiProvider() { return true }

    async chatCompletion(request) {
      chatCalls.push(request)
      const isRestart = chatCalls.length > 1
      return {
        response: {
          status: 200,
          data: isRestart ? restartedUpstream : initialUpstream,
          headers: {},
        },
        chatId: isRestart ? 'fresh-recovery-chat' : 'initial-chat',
        parentId: null,
      }
    }

    async continueChatCompletion(request) {
      continuationCalls.push(request)
      return { data: restartedUpstream }
    }

    async deleteChat(chatId) {
      deleteCalls.push(chatId)
      return true
    }
  }

  class QwenAiStreamHandler {
    setChatId() {}
    getResponseId() { return 'semantic-empty-response' }
    isComplete() { return false }
    prepareForWorkflowContinuation() {}
    async handleStream() { return output }
  }

  const RequestForwarder = loadRequestForwarder({
    QwenAiAdapter,
    QwenAiStreamHandler,
    createQwenAiResumableStream: (stream, options) => {
      bridgeOptions.push(options)
      return stream
    },
    createToolWorkflowContinuationMessage: createRealToolWorkflowContinuationMessage,
  })
  const forwarder = new RequestForwarder()
  forwarder.transformRequestForPromptToolUse = request => ({
    messages: [
      ...request.messages,
      originallyInjectedContinuation,
    ],
    plan,
  })

  const resultPromise = forwarder.forwardQwenAi(
    {
      model: 'model-1',
      messages: [
        { role: 'user', content: 'create the requested artifact' },
        {
          role: 'assistant',
          content: null,
          tool_calls: [{
            id: 'inspect-call',
            type: 'function',
            function: { name: 'lookup', arguments: '{}' },
          }],
        },
        { role: 'tool', tool_call_id: 'inspect-call', content: 'folder inspected' },
      ],
      stream: true,
      tools: [{ type: 'function', function: { name: 'lookup', parameters: {} } }],
    },
    { id: 'account-1' },
    { id: 'qwen-ai', apiEndpoint: 'https://chat.qwen.ai' },
    'model-1',
    Date.now(),
    { signal: new AbortController().signal },
  )

  output.write('data: {"choices":[{"delta":{"content":"ready"}}]}\n\n')
  const result = await resultPromise
  assert.equal(result.success, true)
  assert.equal(chatCalls.length, 1)
  assert.equal(bridgeOptions.length, 1)

  const recoveryError = Object.assign(new Error('reasoning ended without a tool call'), {
    code: 'qwen_ai_semantic_empty',
  })
  const continued = await bridgeOptions[0].continueWorkflow('semantic-empty-response', recoveryError)
  assert.equal(continued.data, restartedUpstream)
  assert.equal(chatCalls.length, 1)
  assert.equal(continuationCalls.length, 1)
  assert.equal(continuationCalls[0].chatId, 'initial-chat')
  assert.equal(continuationCalls[0].parentId, 'semantic-empty-response')
  assert.equal(continuationCalls[0].content, anchoredCompletionCapableRecovery.content)
  assert.equal(continuationCalls[0].messages, undefined)

  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(deleteCalls, [])
  output.destroy()
  initialUpstream.destroy()
  restartedUpstream.destroy()
})

test('Qwen AI forwarder continues semantic recovery without replaying an unflagged transcript', async () => {
  const output = new PassThrough()
  const initialUpstream = new PassThrough()
  const restartedUpstream = new PassThrough()
  const chatCalls = []
  const continuationCalls = []
  const deleteCalls = []
  const bridgeOptions = []
  const plan = {
    protocol: 'qwen_hermes',
    tools: [{
      name: 'lookup',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string' } },
        required: ['path'],
      },
      source: 'openai',
    }],
    shouldParseResponse: true,
    toolChoiceMode: 'auto',
    allowedToolNames: new Set(['lookup']),
    workflowContinuation: false,
    failedToolResultPending: false,
  }
  const transformedMessages = [
    { role: 'user', content: 'OLD_TASK_A' },
    {
      role: 'assistant',
      content: null,
      tool_calls: [{
        id: 'inspect-call',
        type: 'function',
        function: { name: 'lookup', arguments: '{}' },
      }],
    },
    { role: 'tool', tool_call_id: 'inspect-call', content: 'folder inspected' },
    { role: 'assistant', content: 'OLD_ANSWER_A' },
    {
      role: 'user',
      content: [
        { type: 'text', text: 'ACTIVE_TASK_B_SENTINEL' },
        {
          type: 'image_url',
          image_url: { url: 'data:image/png;base64,ATTACHMENT_MUST_NOT_LEAK' },
        },
      ],
    },
  ]

  class QwenAiAdapter {
    static isQwenAiProvider() { return true }

    async chatCompletion(request) {
      chatCalls.push(request)
      const isRestart = chatCalls.length > 1
      return {
        response: {
          status: 200,
          data: isRestart ? restartedUpstream : initialUpstream,
          headers: {},
        },
        chatId: isRestart ? 'fresh-active-chat' : 'initial-active-chat',
        parentId: null,
      }
    }

    async continueChatCompletion(request) {
      continuationCalls.push(request)
      return { data: restartedUpstream }
    }

    async deleteChat(chatId) {
      deleteCalls.push(chatId)
      return true
    }
  }

  class QwenAiStreamHandler {
    setChatId() {}
    getResponseId() { return 'active-workflow-response' }
    isComplete() { return false }
    prepareForWorkflowContinuation() {}
    async handleStream() { return output }
  }

  const RequestForwarder = loadRequestForwarder({
    QwenAiAdapter,
    QwenAiStreamHandler,
    createQwenAiResumableStream: (stream, options) => {
      bridgeOptions.push(options)
      return stream
    },
    createToolWorkflowContinuationMessage: createRealToolWorkflowContinuationMessage,
  })
  const forwarder = new RequestForwarder()
  forwarder.transformRequestForPromptToolUse = () => ({
    messages: transformedMessages,
    plan,
  })

  const resultPromise = forwarder.forwardQwenAi(
    {
      model: 'model-1',
      messages: transformedMessages,
      stream: true,
      tools: [{ type: 'function', function: { name: 'lookup', parameters: {} } }],
    },
    { id: 'account-1' },
    { id: 'qwen-ai', apiEndpoint: 'https://chat.qwen.ai' },
    'model-1',
    Date.now(),
    { signal: new AbortController().signal },
  )

  output.write('data: {"choices":[{"delta":{"content":"ready"}}]}\n\n')
  const result = await resultPromise
  assert.equal(result.success, true)
  assert.equal(chatCalls.length, 1)
  assert.equal(bridgeOptions.length, 1)

  const recoveryError = Object.assign(new Error('progress text ended the managed branch'), {
    code: 'qwen_ai_semantic_incomplete',
  })
  const continued = await bridgeOptions[0].continueWorkflow(
    'active-workflow-response',
    recoveryError,
  )
  assert.equal(continued.data, restartedUpstream)
  assert.equal(chatCalls.length, 1)
  assert.equal(continuationCalls.length, 1)
  assert.equal(continuationCalls[0].chatId, 'initial-active-chat')
  assert.equal(continuationCalls[0].parentId, 'active-workflow-response')
  assert.equal(continuationCalls[0].messages, undefined)
  assert.match(continuationCalls[0].content, /ACTIVE_TASK_B_SENTINEL/)
  assert.match(continuationCalls[0].content, /preceding assistant branch was rejected.*omitted/i)
  assert.doesNotMatch(continuationCalls[0].content, /OLD_TASK_A/)
  assert.doesNotMatch(continuationCalls[0].content, /OLD_ANSWER_A/)
  assert.doesNotMatch(continuationCalls[0].content, /ATTACHMENT_MUST_NOT_LEAK|data:image/)

  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(deleteCalls, [])
  output.destroy()
  initialUpstream.destroy()
  restartedUpstream.destroy()
})

test('Qwen AI preflight releases a quiet stream after the configured hold', async () => {
  const previous = process.env.CHAT2API_QWEN_AI_STREAM_PREFLIGHT_MAX_HOLD_MS
  process.env.CHAT2API_QWEN_AI_STREAM_PREFLIGHT_MAX_HOLD_MS = '10'
  const output = new PassThrough()

  class QwenAiAdapter {
    static isQwenAiProvider() { return true }

    async chatCompletion() {
      return {
        response: { status: 200, data: new PassThrough(), headers: {} },
        chatId: 'temporary-chat-preflight',
        parentId: null,
      }
    }

    async deleteChat() { return true }
  }

  class QwenAiStreamHandler {
    setChatId() {}
    async handleStream() { return output }
  }

  try {
    const RequestForwarder = loadRequestForwarder({ QwenAiAdapter, QwenAiStreamHandler })
    const forwarder = new RequestForwarder()
    forwarder.transformRequestForPromptToolUse = request => ({
      messages: request.messages,
      plan: { shouldParseResponse: false },
    })

    const startedAt = Date.now()
    const result = await forwarder.forwardQwenAi(
      { model: 'model-1', messages: [], stream: true },
      { id: 'account-1' },
      { id: 'qwen-ai', apiEndpoint: 'https://chat.qwen.ai' },
      'model-1',
      Date.now(),
      { signal: new AbortController().signal },
    )

    assert.equal(result.success, true)
    assert.equal(result.stream, output)
    assert.ok(Date.now() - startedAt < 500, 'quiet preflight should be bounded')
    output.end('data: [DONE]\n\n')
  } finally {
    output.destroy()
    if (previous === undefined) delete process.env.CHAT2API_QWEN_AI_STREAM_PREFLIGHT_MAX_HOLD_MS
    else process.env.CHAT2API_QWEN_AI_STREAM_PREFLIGHT_MAX_HOLD_MS = previous
  }
})

test('Qwen AI preflight keeps a delayed pre-output capacity failure as HTTP 429 by default', async (t) => {
  const previous = process.env.CHAT2API_QWEN_AI_STREAM_PREFLIGHT_MAX_HOLD_MS
  const originalSetTimeout = globalThis.setTimeout
  const scheduledDelays = []
  const output = new PassThrough()
  const deleteCalls = []
  delete process.env.CHAT2API_QWEN_AI_STREAM_PREFLIGHT_MAX_HOLD_MS
  globalThis.setTimeout = (callback, delay, ...args) => {
    scheduledDelays.push(delay)
    return originalSetTimeout(callback, delay, ...args)
  }
  t.after(() => {
    output.destroy()
    globalThis.setTimeout = originalSetTimeout
    if (previous === undefined) delete process.env.CHAT2API_QWEN_AI_STREAM_PREFLIGHT_MAX_HOLD_MS
    else process.env.CHAT2API_QWEN_AI_STREAM_PREFLIGHT_MAX_HOLD_MS = previous
  })

  class QwenAiAdapter {
    static isQwenAiProvider() { return true }

    async chatCompletion() {
      return {
        response: { status: 200, data: new PassThrough(), headers: {} },
        chatId: 'temporary-chat-delayed-capacity',
        parentId: null,
      }
    }

    async deleteChat(chatId) {
      deleteCalls.push(chatId)
      return true
    }
  }

  class QwenAiStreamHandler {
    setChatId() {}
    async handleStream() { return output }
  }

  const RequestForwarder = loadRequestForwarder({ QwenAiAdapter, QwenAiStreamHandler })
  const forwarder = new RequestForwarder()
  forwarder.transformRequestForPromptToolUse = request => ({
    messages: request.messages,
    plan: { shouldParseResponse: false },
  })

  const resultPromise = forwarder.forwardQwenAi(
    { model: 'model-1', messages: [], stream: true },
    { id: 'account-1' },
    { id: 'qwen-ai', apiEndpoint: 'https://chat.qwen.ai' },
    'model-1',
    Date.now(),
    { signal: new AbortController().signal },
  )
  await new Promise(resolve => originalSetTimeout(resolve, 30))
  const capacityError = Object.assign(new Error('Qwen AI capacity limit'), {
    status: 429,
    code: 'qwen_ai_capacity_limit',
    retryable: false,
  })
  output.qwenAiFailure = capacityError
  output.emit('qwen-ai-stream-failure', capacityError)
  output.end()

  const result = await resultPromise
  assert.equal(result.success, false)
  assert.equal(result.status, 429)
  assert.equal(result.errorCode, 'qwen_ai_capacity_limit')
  assert.equal(result.stream, undefined)
  assert.deepEqual(deleteCalls, ['temporary-chat-delayed-capacity'])
  assert.deepEqual(scheduledDelays, [], 'the default preflight must not create a release timer')
  assert.equal(output.listenerCount('qwen-ai-stream-failure'), 0)
})

test('Qwen AI preflight preserves the explicit zero deadline override', async (t) => {
  const previous = process.env.CHAT2API_QWEN_AI_STREAM_PREFLIGHT_MAX_HOLD_MS
  const output = new PassThrough()
  process.env.CHAT2API_QWEN_AI_STREAM_PREFLIGHT_MAX_HOLD_MS = '0'
  t.after(() => {
    output.destroy()
    if (previous === undefined) delete process.env.CHAT2API_QWEN_AI_STREAM_PREFLIGHT_MAX_HOLD_MS
    else process.env.CHAT2API_QWEN_AI_STREAM_PREFLIGHT_MAX_HOLD_MS = previous
  })

  class QwenAiAdapter {
    static isQwenAiProvider() { return true }
    async chatCompletion() {
      return {
        response: { status: 200, data: new PassThrough(), headers: {} },
        chatId: 'temporary-chat-zero-preflight',
        parentId: null,
      }
    }
    async deleteChat() { return true }
  }

  class QwenAiStreamHandler {
    setChatId() {}
    async handleStream() { return output }
  }

  const RequestForwarder = loadRequestForwarder({ QwenAiAdapter, QwenAiStreamHandler })
  const forwarder = new RequestForwarder()
  forwarder.transformRequestForPromptToolUse = request => ({
    messages: request.messages,
    plan: { shouldParseResponse: false },
  })

  const result = await forwarder.forwardQwenAi(
    { model: 'model-1', messages: [], stream: true },
    { id: 'account-1' },
    { id: 'qwen-ai', apiEndpoint: 'https://chat.qwen.ai' },
    'model-1',
    Date.now(),
    { signal: new AbortController().signal },
  )
  assert.equal(result.success, true)
  assert.equal(result.stream, output)
})

test('Qwen AI preflight ignores blank and overflowing deadline overrides', async (t) => {
  const previous = process.env.CHAT2API_QWEN_AI_STREAM_PREFLIGHT_MAX_HOLD_MS
  const originalSetTimeout = globalThis.setTimeout
  const scheduledDelays = []
  globalThis.setTimeout = (callback, delay, ...args) => {
    scheduledDelays.push(delay)
    return originalSetTimeout(callback, delay, ...args)
  }
  t.after(() => {
    globalThis.setTimeout = originalSetTimeout
    if (previous === undefined) delete process.env.CHAT2API_QWEN_AI_STREAM_PREFLIGHT_MAX_HOLD_MS
    else process.env.CHAT2API_QWEN_AI_STREAM_PREFLIGHT_MAX_HOLD_MS = previous
  })

  for (const raw of ['', 'invalid', '2147483648']) {
    process.env.CHAT2API_QWEN_AI_STREAM_PREFLIGHT_MAX_HOLD_MS = raw
    const output = new PassThrough()

    class QwenAiAdapter {
      static isQwenAiProvider() { return true }
      async chatCompletion() {
        return {
          response: { status: 200, data: new PassThrough(), headers: {} },
          chatId: `temporary-chat-invalid-preflight-${raw}`,
          parentId: null,
        }
      }
      async deleteChat() { return true }
    }

    class QwenAiStreamHandler {
      setChatId() {}
      async handleStream() { return output }
    }

    const RequestForwarder = loadRequestForwarder({ QwenAiAdapter, QwenAiStreamHandler })
    const forwarder = new RequestForwarder()
    forwarder.transformRequestForPromptToolUse = request => ({
      messages: request.messages,
      plan: { shouldParseResponse: false },
    })
    const resultPromise = forwarder.forwardQwenAi(
      { model: 'model-1', messages: [], stream: true },
      { id: 'account-1' },
      { id: 'qwen-ai', apiEndpoint: 'https://chat.qwen.ai' },
      'model-1',
      Date.now(),
      { signal: new AbortController().signal },
    )
    await new Promise(resolve => setImmediate(resolve))
    output.write('data: {"choices":[{"delta":{"content":"ok"}}]}\n\n')
    const result = await resultPromise
    assert.equal(result.success, true)
    output.end('data: [DONE]\n\n')
  }

  assert.deepEqual(scheduledDelays, [], 'invalid overrides must behave like an unset deadline')
})

test('Qwen AI preflight does not treat an empty readable event as output', async () => {
  const output = new PassThrough()
  const deleteCalls = []

  class QwenAiAdapter {
    static isQwenAiProvider() { return true }

    async chatCompletion() {
      return {
        response: { status: 200, data: new PassThrough(), headers: {} },
        chatId: 'temporary-chat-empty',
        parentId: null,
      }
    }

    async deleteChat(chatId) {
      deleteCalls.push(chatId)
      return true
    }
  }

  class QwenAiStreamHandler {
    setChatId() {}
    async handleStream() { return output }
  }

  const RequestForwarder = loadRequestForwarder({ QwenAiAdapter, QwenAiStreamHandler })
  const forwarder = new RequestForwarder()
  forwarder.transformRequestForPromptToolUse = request => ({
    messages: request.messages,
    plan: { shouldParseResponse: false },
  })

  const resultPromise = forwarder.forwardQwenAi(
    { model: 'model-1', messages: [], stream: true },
    { id: 'account-1' },
    { id: 'qwen-ai', apiEndpoint: 'https://chat.qwen.ai' },
    'model-1',
    Date.now(),
    { signal: new AbortController().signal },
  )
  setImmediate(() => output.end())

  const result = await resultPromise
  assert.equal(result.success, false)
  assert.equal(result.status, 502)
  assert.equal(result.errorCode, 'qwen_ai_stream_incomplete')
  assert.deepEqual(deleteCalls, ['temporary-chat-empty'])
  output.destroy()
})

test('Qwen AI preflight rejects a stream destroyed before listener registration', { timeout: 1000 }, async (t) => {
  const previous = process.env.CHAT2API_QWEN_AI_STREAM_PREFLIGHT_MAX_HOLD_MS
  const output = new PassThrough()
  const deleteCalls = []
  delete process.env.CHAT2API_QWEN_AI_STREAM_PREFLIGHT_MAX_HOLD_MS
  output.destroy()
  await new Promise(resolve => setImmediate(resolve))
  t.after(() => {
    if (previous === undefined) delete process.env.CHAT2API_QWEN_AI_STREAM_PREFLIGHT_MAX_HOLD_MS
    else process.env.CHAT2API_QWEN_AI_STREAM_PREFLIGHT_MAX_HOLD_MS = previous
  })

  class QwenAiAdapter {
    static isQwenAiProvider() { return true }

    async chatCompletion() {
      return {
        response: { status: 200, data: new PassThrough(), headers: {} },
        chatId: 'temporary-chat-preflight-destroyed',
        parentId: null,
      }
    }

    async deleteChat(chatId) {
      deleteCalls.push(chatId)
      return true
    }
  }

  class QwenAiStreamHandler {
    setChatId() {}
    async handleStream() { return output }
  }

  const RequestForwarder = loadRequestForwarder({ QwenAiAdapter, QwenAiStreamHandler })
  const forwarder = new RequestForwarder()
  forwarder.transformRequestForPromptToolUse = request => ({
    messages: request.messages,
    plan: { shouldParseResponse: false },
  })

  const result = await forwarder.forwardQwenAi(
    { model: 'model-1', messages: [], stream: true },
    { id: 'account-1' },
    { id: 'qwen-ai', apiEndpoint: 'https://chat.qwen.ai' },
    'model-1',
    Date.now(),
    { signal: new AbortController().signal },
  )
  assert.equal(result.success, false)
  assert.equal(result.status, 502)
  assert.equal(result.errorCode, 'qwen_ai_stream_incomplete')
  assert.deepEqual(deleteCalls, ['temporary-chat-preflight-destroyed'])
})

test('Qwen AI forwarding returns a structured failure before the first visible stream event', async () => {
  const output = new PassThrough()
  const deleteCalls = []

  class QwenAiAdapter {
    static isQwenAiProvider() { return true }

    async chatCompletion() {
      return {
        response: { status: 200, data: new PassThrough(), headers: {} },
        chatId: 'temporary-chat-capacity',
        parentId: null,
      }
    }

    async deleteChat(chatId) {
      deleteCalls.push(chatId)
      return true
    }
  }

  class QwenAiStreamHandler {
    setChatId() {}
    async handleStream() { return output }
  }

  const RequestForwarder = loadRequestForwarder({ QwenAiAdapter, QwenAiStreamHandler })
  const forwarder = new RequestForwarder()
  forwarder.transformRequestForPromptToolUse = request => ({
    messages: request.messages,
    plan: { shouldParseResponse: false },
  })

  const resultPromise = forwarder.forwardQwenAi(
    { model: 'model-1', messages: [], stream: true },
    { id: 'account-1' },
    { id: 'qwen-ai', apiEndpoint: 'https://chat.qwen.ai' },
    'model-1',
    Date.now(),
    { signal: new AbortController().signal },
  )
  const capacityError = Object.assign(new Error('Qwen AI capacity limit'), {
    status: 429,
    code: 'qwen_ai_capacity_limit',
    retryable: false,
  })
  output.qwenAiFailure = capacityError
  output.emit('qwen-ai-stream-failure', capacityError)
  output.end()

  const result = await resultPromise
  assert.equal(result.success, false)
  assert.equal(result.status, 429)
  assert.equal(result.errorCode, 'qwen_ai_capacity_limit')
  assert.equal(result.retryable, false)
  assert.equal(result.stream, undefined)
  assert.deepEqual(deleteCalls, ['temporary-chat-capacity'])
})

function qwenResponsesBridgeContext(overrides = {}) {
  const binding = {
    providerId: 'qwen-ai',
    accountId: 'account-pinned',
    requestedModel: 'Qwen3.8-Max_Auto',
    actualModel: 'qwen3.8-max',
    chatId: 'chat-pinned',
    parentId: 'response-pinned',
    requestFingerprint: 'bridge-fingerprint',
    toolProtocol: 'managed_xml',
  }
  return {
    signal: new AbortController().signal,
    qwenAiSessionBridge: {
      requestFingerprint: binding.requestFingerprint,
      continuation: {
        binding,
        inputMessages: [{
          role: 'tool',
          tool_call_id: 'call_read',
          content: '{"name":"chat2api"}',
        }],
      },
    },
    ...overrides,
  }
}

function qwenResponsesBridgePlan() {
  return {
    protocol: 'managed_xml',
    tools: [],
    shouldParseResponse: true,
    allowedToolNames: new Set(['read_file']),
    toolChoiceMode: 'auto',
    workflowContinuation: true,
    failedToolResultPending: false,
  }
}

function qwenResponsesBridgeRequest() {
  return {
    model: 'Qwen3.8-Max_Auto',
    stream: true,
    tools: [{ type: 'function', function: { name: 'read_file', parameters: {} } }],
    tool_choice: 'auto',
    enable_thinking: true,
    messages: [
      { role: 'system', content: 'Original system instructions.' },
      { role: 'user', content: 'Read package.json.' },
      {
        role: 'assistant',
        content: null,
        tool_calls: [{
          id: 'call_read',
          type: 'function',
          function: { name: 'read_file', arguments: '{"path":"package.json"}' },
        }],
      },
      { role: 'tool', tool_call_id: 'call_read', content: '{"name":"chat2api"}' },
    ],
  }
}

test('Qwen Responses bridge continues the pinned chat with only the tool-result delta', async () => {
  const output = new PassThrough()
  const continuationCalls = []
  const freshChatCalls = []
  let handlerChatId = ''

  class QwenAiAdapter {
    static isQwenAiProvider() { return true }

    async chatCompletion(request) {
      freshChatCalls.push(request)
      return {
        response: { status: 200, headers: {}, data: new PassThrough() },
        chatId: 'unexpected-fresh-chat',
        parentId: null,
      }
    }

    async continueChatCompletion(request) {
      continuationCalls.push(request)
      return { status: 200, headers: {}, data: new PassThrough() }
    }

    async deleteChat() { return true }
  }

  class QwenAiStreamHandler {
    setChatId(chatId) { handlerChatId = chatId }
    getChatId() { return handlerChatId }
    getResponseId() { return 'response-next' }
    isComplete() { return false }
    async handleStream() { return output }
  }

  const RequestForwarder = loadRequestForwarder({ QwenAiAdapter, QwenAiStreamHandler })
  const forwarder = new RequestForwarder()
  forwarder.transformRequestForPromptToolUse = request => ({
    messages: request.messages,
    plan: qwenResponsesBridgePlan(),
  })

  const resultPromise = forwarder.forwardQwenAi(
    qwenResponsesBridgeRequest(),
    { id: 'account-pinned' },
    { id: 'qwen-ai', apiEndpoint: 'https://chat.qwen.ai' },
    'qwen3.8-max',
    Date.now(),
    qwenResponsesBridgeContext(),
  )
  output.write('data: {"choices":[{"delta":{"content":"continued"}}]}\n\n')
  const result = await resultPromise

  assert.equal(result.success, true)
  assert.equal(freshChatCalls.length, 0)
  assert.equal(continuationCalls.length, 1)
  assert.equal(continuationCalls[0].chatId, 'chat-pinned')
  assert.equal(continuationCalls[0].parentId, 'response-pinned')
  assert.equal(continuationCalls[0].messages.length, 2)
  assert.deepEqual(continuationCalls[0].messages[0], {
    role: 'tool',
    tool_call_id: 'call_read',
    content: '{"name":"chat2api"}',
  })
  assert.doesNotMatch(JSON.stringify(continuationCalls[0].messages), /Original system instructions|Read package\.json/)
  assert.equal(continuationCalls[0].managedToolWorkflowContinuation, true)
  assert.equal(result.qwenAiSessionState?.getChatId(), 'chat-pinned')
  assert.equal(result.qwenAiSessionState?.getParentId(), 'response-next')

  output.destroy()
})

test('Qwen Responses bridge replays full history on the same account after stale chat state', async () => {
  const output = new PassThrough()
  const continuationCalls = []
  const freshChatCalls = []
  const deletedChats = []
  let handlerChatId = ''

  class QwenAiAdapter {
    static isQwenAiProvider() { return true }

    async continueChatCompletion(request) {
      continuationCalls.push(request)
      throw Object.assign(new Error('Qwen chat parent is no longer available'), { status: 404 })
    }

    async chatCompletion(request) {
      freshChatCalls.push(request)
      return {
        response: { status: 200, headers: {}, data: new PassThrough() },
        chatId: 'chat-replayed',
        parentId: null,
      }
    }

    async deleteChat(chatId) {
      deletedChats.push(chatId)
      return true
    }
  }

  class QwenAiStreamHandler {
    setChatId(chatId) { handlerChatId = chatId }
    getChatId() { return handlerChatId }
    getResponseId() { return 'response-replayed' }
    isComplete() { return false }
    async handleStream() { return output }
  }

  const RequestForwarder = loadRequestForwarder({ QwenAiAdapter, QwenAiStreamHandler })
  const forwarder = new RequestForwarder()
  forwarder.transformRequestForPromptToolUse = request => ({
    messages: request.messages,
    plan: qwenResponsesBridgePlan(),
  })

  const request = qwenResponsesBridgeRequest()
  const resultPromise = forwarder.forwardQwenAi(
    request,
    { id: 'account-pinned' },
    { id: 'qwen-ai', apiEndpoint: 'https://chat.qwen.ai' },
    'qwen3.8-max',
    Date.now(),
    qwenResponsesBridgeContext(),
  )
  output.write('data: {"choices":[{"delta":{"content":"replayed"}}]}\n\n')
  const result = await resultPromise

  assert.equal(result.success, true)
  assert.equal(continuationCalls.length, 1)
  assert.equal(freshChatCalls.length, 1)
  assert.deepEqual(freshChatCalls[0].messages, request.messages)
  assert.deepEqual(deletedChats, ['chat-pinned'])
  assert.equal(result.providerSessionId, 'chat-replayed')
  assert.equal(result.qwenAiSessionState?.getChatId(), 'chat-replayed')
  assert.equal(result.qwenAiSessionState?.getParentId(), 'response-replayed')

  output.destroy()
})

test('Qwen Responses bridge keeps CHAT_IN_PROGRESS account-neutral but forwards account faults', async (t) => {
  const scenarios = [
    {
      name: 'busy chat',
      error: Object.assign(new Error('chat is still in progress'), {
        status: 429,
        code: 'CHAT_IN_PROGRESS',
        accountFault: false,
        retryable: true,
      }),
      expectedAccountFault: false,
      expectedRetryScope: undefined,
    },
    {
      name: 'credential 401',
      error: Object.assign(new Error('token expired'), {
        status: 401,
        code: 'qwen_ai_auth_failed',
        accountFault: true,
        retryScope: 'next-account',
      }),
      expectedAccountFault: true,
      expectedRetryScope: 'next-account',
    },
    {
      name: 'risk-control 403',
      error: Object.assign(new Error('risk control'), {
        status: 403,
        code: 'qwen_ai_risk_control',
        accountFault: true,
        retryScope: 'next-account',
      }),
      expectedAccountFault: true,
      expectedRetryScope: 'next-account',
    },
    {
      name: 'capacity 429',
      error: Object.assign(new Error('capacity limit'), {
        status: 429,
        code: 'qwen_ai_capacity_limit',
        accountFault: true,
        retryScope: 'next-account',
      }),
      expectedAccountFault: true,
      expectedRetryScope: 'next-account',
    },
  ]

  for (const scenario of scenarios) {
    await t.test(scenario.name, async () => {
      const freshChatCalls = []
      const deletedChats = []
      class QwenAiAdapter {
        static isQwenAiProvider() { return true }
        async continueChatCompletion() { throw scenario.error }
        async chatCompletion(request) {
          freshChatCalls.push(request)
          if (scenario.name === 'busy chat') throw scenario.error
          throw new Error('a non-stale continuation must not replay on the same account')
        }
        async deleteChat(chatId) {
          deletedChats.push(chatId)
          return true
        }
      }
      class QwenAiStreamHandler {}

      const RequestForwarder = loadRequestForwarder({ QwenAiAdapter, QwenAiStreamHandler })
      const forwarder = new RequestForwarder()
      forwarder.transformRequestForPromptToolUse = request => ({
        messages: request.messages,
        plan: qwenResponsesBridgePlan(),
      })

      const result = await forwarder.forwardQwenAi(
        qwenResponsesBridgeRequest(),
        { id: 'account-pinned' },
        { id: 'qwen-ai', apiEndpoint: 'https://chat.qwen.ai' },
        'qwen3.8-max',
        Date.now(),
        qwenResponsesBridgeContext(),
      )

      assert.equal(result.success, false)
      assert.equal(result.status, scenario.error.status)
      assert.equal(result.errorCode, scenario.error.code)
      assert.equal(result.accountFault, scenario.expectedAccountFault)
      assert.equal(result.retryScope, scenario.expectedRetryScope)
      if (scenario.name === 'busy chat') {
        assert.equal(freshChatCalls.length, 1)
        assert.deepEqual(freshChatCalls[0].messages, qwenResponsesBridgeRequest().messages)
        assert.deepEqual(deletedChats, ['chat-pinned'])
      } else {
        assert.equal(freshChatCalls.length, 0)
        assert.deepEqual(deletedChats, [])
      }
    })
  }
})
