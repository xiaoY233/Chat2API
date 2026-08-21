import assert from 'node:assert/strict'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import { PassThrough } from 'node:stream'
import test from 'node:test'
import ts from 'typescript'
import {
  sanitizeAssistantInputHistory as sanitizeRealAssistantInputHistory,
} from '../../src/main/proxy/toolCalling/assistantInputBoundary.ts'
import {
  isQwenAiAccountFault,
  qwenAiAccountRetryScope,
} from '../../src/main/proxy/qwenAiAccountPolicy.ts'

const runtimeRequire = createRequire(import.meta.url)

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
  const calls = overrides.calls || []
  const deletedChats = overrides.deletedChats || []
  const accountCount = overrides.accountCount || 8
  const accounts = Array.from({ length: accountCount }, (_, index) => ({
    id: `account-${index + 1}`,
    providerId: 'qwen-ai',
    name: `Account ${index + 1}`,
    status: 'active',
    credentials: {},
  }))
  const providers = [{
    id: 'qwen-ai',
    name: 'Qwen AI',
    enabled: true,
    apiEndpoint: 'https://chat.qwen.ai',
  }]
  const activeGovernorAccounts = new Set()
  const governorMetrics = {
    activeRequests: 0,
    completedRequests: 0,
    maxActiveRequests: 0,
    maxQueueSize: 0,
    statusReads: 0,
    duplicateActiveAccounts: [],
    starts: [],
    events: [],
  }

  const requestSegment = request => {
    for (let index = request.messages.length - 1; index >= 0; index -= 1) {
      const content = request.messages[index]?.content
      if (typeof content !== 'string') continue
      const match = content.match(/^Segment: (.+)$/m)
      if (match) return match[1]
    }
    return 'unknown'
  }

  const governorCap = () => {
    if (typeof overrides.governorCap === 'function') {
      return overrides.governorCap({
        completedRequests: governorMetrics.completedRequests,
        activeRequests: governorMetrics.activeRequests,
        calls,
      })
    }
    return overrides.governorCap || 2
  }
  let summaryPlanCalls = 0

  const partitionMessages = (messages, count) => Array.from({ length: count }, (_, index) => {
    const start = Math.floor((index * messages.length) / count)
    const end = Math.floor(((index + 1) * messages.length) / count)
    const group = messages.slice(start, end)
    return group.length > 0
      ? group
      : [{ role: 'user', content: `fixture source chunk ${index + 1}` }]
  })

  const createPlan = (messages, count) => ({
    chunks: partitionMessages(messages, count).map(group => ({
      messages: group,
      estimatedTokens: 10,
      sourceTextChars: 20,
    })),
    chunkBudgetTokens: 30,
    promptReserveTokens: 5,
    chunkSource: 'configured',
    sourceMessageCount: messages.length,
    sourceTextChars: 20 * count,
    coveredTextChars: 20 * count,
    splitMessageCount: 0,
    oversizedMessageCount: 0,
    chunkCount: count,
  })

  class MockQwenAiAdapter {
    static isQwenAiProvider() { return true }

    constructor(_provider, account) {
      this.account = account
    }

    async chatCompletion(request) {
      const index = calls.length + 1
      const segment = requestSegment(request)
      calls.push({ request, accountId: this.account.id, segment })
      governorMetrics.events.push({ type: 'upstream-start', segment, accountId: this.account.id })
      const delayMs = overrides.delayBySegment?.[segment]
        ?? (typeof overrides.delayForCall === 'function'
          ? overrides.delayForCall({ index, segment })
          : 0)
      if (delayMs > 0) {
        await new Promise(resolve => setTimeout(resolve, delayMs))
      }
      if (overrides.failAt === index || overrides.failSegments?.includes(segment)) {
        const error = new Error(`mock upstream failure at ${index}`)
        error.status = 503
        error.retryable = true
        governorMetrics.events.push({ type: 'upstream-fail', segment, accountId: this.account.id })
        throw error
      }
      const responseFailure = typeof overrides.responseFailure === 'function'
        ? overrides.responseFailure({ accountId: this.account.id, segment, index })
        : undefined
      if (responseFailure) {
        const status = responseFailure.status || 403
        const code = responseFailure.code || 'qwen_ai_risk_control'
        const message = responseFailure.message || 'mock response failure'
        governorMetrics.events.push({ type: 'upstream-fail', segment, accountId: this.account.id })
        return {
          response: {
            status,
            headers: responseFailure.headers || {},
            data: {
              error: {
                message,
                code,
                ...(responseFailure.accountFault === undefined
                  ? {}
                  : { accountFault: responseFailure.accountFault }),
              },
            },
          },
          chatId: `chat-${index}`,
          parentId: null,
        }
      }
      const failAccount = typeof overrides.failAccount === 'function'
        ? overrides.failAccount({ accountId: this.account.id, segment, index })
        : overrides.failAccountIds?.includes(this.account.id)
      if (failAccount) {
        const error = new Error(`mock risk-control failure for ${this.account.id}`)
        error.status = 403
        error.code = 'qwen_ai_risk_control'
        error.retryScope = 'next-account'
        error.accountFault = true
        governorMetrics.events.push({ type: 'upstream-fail', segment, accountId: this.account.id })
        throw error
      }
      governorMetrics.events.push({ type: 'upstream-end', segment, accountId: this.account.id })
      return {
        response: {
          status: 200,
          headers: {},
          data: { index, segment, accountId: this.account.id },
        },
        chatId: `chat-${index}`,
        parentId: null,
      }
    }

    async deleteChat(chatId) {
      deletedChats.push(chatId)
      return true
    }
  }

  class MockQwenAiStreamHandler {
    constructor() {}
    setChatId() {}
    getResponseId() { return '' }
    getPendingSemanticRecoveryError() { return undefined }
    isComplete() { return true }
    async handleNonStream(stream) {
      return {
        id: `response-${stream.index}`,
        object: 'chat.completion',
        choices: [{
          index: 0,
          message: { role: 'assistant', content: `summary:${stream.segment}` },
          finish_reason: 'stop',
        }],
      }
    }
    async handleStream(stream) {
      const output = new PassThrough()
      process.nextTick(() => {
        const streamFailure = typeof overrides.streamFailure === 'function'
          ? overrides.streamFailure(stream)
          : overrides.streamFailureAccountIds?.includes(stream.accountId)
            && stream.segment === 'final context summary'
        if (streamFailure) {
          output.write('data: {"choices":[{"delta":{"role":"assistant","content":""},"finish_reason":null}]}\n\n')
          process.nextTick(() => {
            const error = new Error(`mock stream risk-control failure for ${stream.accountId}`)
            error.status = 403
            error.code = 'qwen_ai_risk_control'
            error.retryable = false
            error.retryScope = 'next-account'
            error.accountFault = true
            output.qwenAiFailure = error
            output.emit('qwen-ai-stream-failure', error)
            output.end()
          })
          return
        }
        output.write('data: {"choices":[{"delta":{"content":"final"},"finish_reason":null}]}\n\n')
        output.end('data: [DONE]\n\n')
      })
      return output
    }
  }

  class MockToolCallingEngine {
    constructor() {}
    transformRequest({ request }) {
      return {
        messages: request.messages,
        tools: request.tools,
        plan: {
          shouldParseResponse: false,
          allowedToolNames: new Set(),
          failedToolResultPending: false,
          workflowContinuation: false,
        },
      }
    }
    applyNonStreamResponse() {}
  }

  const localModules = {
    axios: { create: () => ({}) },
    http2: {},
    '../store/types': {},
    './types': {},
    './status': { proxyStatusManager: { getConfig: () => ({ timeout: 120000 }) } },
    '../store/store': {
      storeManager: {
        getConfig: () => ({
          retryCount: 0,
          contextManagement: { enabled: false },
          toolCallingConfig: {},
        }),
        getAccounts: () => accounts,
        getProviders: () => providers,
        getAccountsByProviderId: providerId => accounts.filter(account => account.providerId === providerId),
      },
    },
    './loadbalancer': {
      loadBalancer: {
        selectAccount: (_model, _strategy, providerId, _preferredAccountId, excluded) => {
          for (let index = 2; index <= accountCount; index += 1) {
            const accountId = `account-${index}`
            if (!excluded.has(accountId)) {
              return {
                account: accounts[index - 1],
                provider: { ...providers[0], id: providerId },
                actualModel: 'qwen3.7-plus',
              }
            }
          }
          return null
        },
        markAccountFailed: () => {},
        getAccountFailureSnapshot: () => ({}),
        getAvailableAccountCount: () => overrides.availableAccountCount ?? accounts.length,
      },
    },
    './adapters/deepseek': { DeepSeekAdapter: class { static isDeepSeekProvider() { return false } } },
    './adapters/deepseek-stream': { DeepSeekStreamHandler: class {} },
    './adapters/glm': { GLMAdapter: class { static isGLMProvider() { return false } }, GLMStreamHandler: class {} },
    './adapters/kimi': { KimiAdapter: class { static isKimiProvider() { return false } }, KimiStreamHandler: class {} },
    './adapters/mimo': { MimoAdapter: class { static isMimoProvider() { return false } }, MimoStreamHandler: class {} },
    './adapters/qwen': { QwenAdapter: class { static isQwenProvider() { return false } }, QwenStreamHandler: class {} },
    './adapters/qwen-ai': {
      describeErrorForLog: error => error?.message || String(error),
      QWEN_AI_STREAM_FAILURE_EVENT: 'qwen-ai-stream-failure',
      QwenAiAdapter: MockQwenAiAdapter,
      QwenAiStreamHandler: MockQwenAiStreamHandler,
      createQwenAiResumableStream: stream => stream,
      findModelCapability: () => ({ maxContextLength: 100, maxSummaryGenerationLength: 10 }),
      isQwenAiStaleSessionError: () => false,
      isQwenAiTransientTransportError: () => false,
      isQwenAiUpstreamBusyMessage: () => false,
      qwenAiRequestTimeoutMsFromEnv: () => 600_000,
      qwenAiResponsesContinuationRetryAttemptsFromEnv: () => 0,
    },
    './adapters/zai': { ZaiAdapter: class { static isZaiProvider() { return false } }, ZaiStreamHandler: class {} },
    './adapters/minimax': { MiniMaxAdapter: class { static isMiniMaxProvider() { return false } }, MiniMaxStreamHandler: class {} },
    './adapters/perplexity': { PerplexityAdapter: class { static isPerplexityProvider() { return false } } },
    './adapters/perplexity-stream': { PerplexityStreamHandler: class {} },
    './toolCalling/ToolCallingEngine': {
      ToolCallingEngine: MockToolCallingEngine,
      createToolWorkflowContinuationMessage: () => ({ role: 'user', content: 'continue' }),
      extractLatestActiveUserRequest: () => undefined,
    },
    './toolCalling/assistantInputBoundary': {
      sanitizeAssistantInputHistory: sanitizeRealAssistantInputHistory,
    },
    './qwenAiRequestGovernor': {
      qwenAiRequestGovernor: {
        getStatus: () => {
          governorMetrics.statusReads += 1
          const maxConcurrent = Math.max(1, governorCap())
          const globalNextAvailableInMs = typeof overrides.globalNextAvailableInMs === 'function'
            ? overrides.globalNextAvailableInMs(governorMetrics)
            : overrides.globalNextAvailableInMs || 0
          const queueSize = typeof overrides.queueSize === 'function'
            ? overrides.queueSize(governorMetrics)
            : overrides.queueSize || 0
          return {
            effectiveConfig: {
              maxConcurrent,
              healthyAccountCount: overrides.healthyAccountCount ?? accounts.length,
            },
            queueSize,
            compactionMaxConcurrent: overrides.compactionMaxConcurrent ?? maxConcurrent,
            compactionActiveRequests: governorMetrics.activeRequests,
            activeRequests: governorMetrics.activeRequests,
            globalNextAvailableInMs,
            accounts: accounts.map(account => {
              const active = overrides.forceAllAccountsBusy === true
                || activeGovernorAccounts.has(account.id)
              return {
                accountId: account.id,
                accountName: account.name,
                providerId: account.providerId,
                providerName: providers[0].name,
                status: account.status,
                queuedRequests: 0,
                activeRequests: active ? 1 : 0,
                nextAvailableInMs: active && overrides.forceAllAccountsBusy !== true
                  ? 1
                  : globalNextAvailableInMs,
                governorCooldownInMs: 0,
                governorFailures: 0,
                loadBalancerCooldownInMs: 0,
                loadBalancerRecoveryInMs: 0,
                loadBalancerFailures: 0,
              }
            }),
          }
        },
        isAccountImmediatelyAvailable: accountId => !activeGovernorAccounts.has(accountId),
        run: async (accountId, operation, options = {}) => {
          if (overrides.simulateGovernorAdmission === true) {
            const cap = Math.max(1, governorCap())
            const requestLimit = options.requestClass === 'context_compaction'
              ? Math.max(1, cap - 1)
              : cap
            if (governorMetrics.activeRequests >= requestLimit) {
              if (options.allowQueue === false) {
                return {
                  success: false,
                  status: 429,
                  headers: { 'Retry-After': '0' },
                  error: 'mock admission deferred',
                  errorCode: 'qwen_ai_compaction_admission_deferred',
                  retryable: true,
                  accountFault: false,
                }
              }
              governorMetrics.maxQueueSize = Math.max(
                governorMetrics.maxQueueSize,
                1,
              )
            }
          }
          if (activeGovernorAccounts.has(accountId)) {
            governorMetrics.duplicateActiveAccounts.push(accountId)
          }
          const capAtStart = governorCap()
          governorMetrics.starts.push({
            accountId,
            capAtStart,
            completedRequestsAtStart: governorMetrics.completedRequests,
            recoveryBypassGlobalInterval: options.recoveryBypassGlobalInterval === true,
            waitForActiveSettlementOnAbort: options.waitForActiveSettlementOnAbort === true,
          })
          activeGovernorAccounts.add(accountId)
          governorMetrics.activeRequests += 1
          governorMetrics.maxActiveRequests = Math.max(
            governorMetrics.maxActiveRequests,
            governorMetrics.activeRequests,
          )
          try {
            return await operation()
          } finally {
            activeGovernorAccounts.delete(accountId)
            governorMetrics.activeRequests -= 1
            governorMetrics.completedRequests += 1
          }
        },
        reportAccountFailover: () => {},
      },
    },
    './qwenAiAccountPolicy': {
      isQwenAiAccountFault,
      qwenAiAccountRetryScope,
      qwenAiAccountFailureDetails: value => ({
        accountFault: isQwenAiAccountFault(value),
        retryScope: qwenAiAccountRetryScope(value),
      }),
      qwenAiSafeExplicitRetryScope: () => undefined,
    },
    './utils/validatedSseStream': {
      BufferedSseError: class BufferedSseError extends Error {},
      bufferValidatedSseStream: async stream => stream,
    },
    './utils/errors': {
      isClientCancellationError: () => false,
      sanitizeForwardedErrorHeaders: headers => headers,
    },
    './sessionManager': {
      sessionManager: { shouldDeleteAfterChat: () => true },
    },
    './services/contextManagementService': {
      createContextManagementService: () => ({
        process: async messages => ({
          messages,
          originalCount: messages.length,
          finalCount: messages.length,
          strategyResults: [],
        }),
      }),
    },
    './requestIntent': {
      classifyChatRequest: () => ({
        intent: 'context_compaction',
        reason: 'test',
        messageCount: 2,
        toolCount: 0,
        textChars: 100,
        lastUserTextChars: 100,
      }),
    },
    './qwenAiCompactionBoundary': {
      estimateQwenAiRequestInputTokens: () => 1,
      boundQwenAiCompactionMessages: messages => ({
        messages: messages.slice(0, 1),
        chunks: [],
        originalMessageCount: messages.length,
        keptMessageCount: 1,
        originalEstimatedTokens: 100,
        keptEstimatedTokens: 50,
        inputTokenBudget: 30,
        chunkBudgetTokens: 30,
        promptReserveTokens: 5,
        chunkSource: 'configured',
        chunkCount: overrides.chunkCount || 2,
        splitMessageCount: 1,
        oversizedMessageCount: 0,
        sourceTextChars: 100,
        coveredTextChars: 100,
        boundarySource: 'configured',
        trimmed: true,
      }),
      planQwenAiCompactionChunks: messages => {
        const isSummary = messages.every(message => (
          typeof message.content === 'string' && message.content.includes('[Partial summary')
        ))
        if (isSummary) {
          const count = summaryPlanCalls === 0
            ? overrides.reduceChunkCount || 1
            : 1
          summaryPlanCalls += 1
          return createPlan(messages, count)
        }
        return createPlan(messages, overrides.chunkCount || 2)
      },
    },
  }

  const testRequire = specifier => {
    if (Object.prototype.hasOwnProperty.call(localModules, specifier)) return localModules[specifier]
    if (specifier.startsWith('.')) throw new Error(`Unexpected import: ${specifier}`)
    return runtimeRequire(specifier)
  }

  new Function('require', 'module', 'exports', output)(testRequire, module, module.exports)
  return {
    RequestForwarder: module.exports.RequestForwarder,
    calculateQwenAiCompactionDispatchCapacity:
      module.exports.calculateQwenAiCompactionDispatchCapacity,
    calls,
    deletedChats,
    governorMetrics,
  }
}

function createRequest(stream) {
  return {
    model: 'qwen3.7-plus',
    stream,
    messages: [
      { role: 'user', content: 'source-a' },
      { role: 'assistant', content: 'source-b' },
      { role: 'user', content: 'source-c' },
      { role: 'user', content: 'summarize this conversation as plain text only and do not use tools' },
    ],
  }
}

function createContext(stream) {
  return {
    requestId: 'compaction-test',
    model: 'qwen3.7-plus',
    startTime: Date.now(),
    isStream: stream,
    requestIntent: 'context_compaction',
    signal: new AbortController().signal,
  }
}

test('chunked compaction finishes map stages and validates final output before returning success', async () => {
  const harness = loadRequestForwarder({
    delayBySegment: {
      'chunk 1/2': 20,
      'chunk 2/2': 20,
    },
  })
  const forwarder = new harness.RequestForwarder()
  const startedAt = Date.now()
  const result = await forwarder.forwardChatCompletion(
    createRequest(true),
    { id: 'account-1', credentials: {} },
    { id: 'qwen-ai', apiEndpoint: 'https://chat.qwen.ai' },
    'qwen3.7-plus',
    createContext(true),
  )

  assert.equal(result.success, true)
  assert.ok(Date.now() - startedAt >= 15)
  assert.equal(harness.calls.length, 3)

  for await (const _chunk of result.stream) {
    // Consume the final stream so cleanup and preflight are exercised.
  }
  assert.equal(harness.calls.length, 3)
  assert.deepEqual(harness.calls.map(call => call.request.stream), [false, false, true])
  assert.deepEqual(harness.calls.map(call => call.accountId), ['account-2', 'account-3', 'account-1'])
  assert.ok(harness.calls[0].request.messages.at(-1).content.includes('chunk 1/2'))
  assert.ok(harness.calls[1].request.messages.at(-1).content.includes('chunk 2/2'))
  assert.ok(harness.calls[2].request.messages.at(-2).content.includes('final context summary'))
  assert.deepEqual(
    harness.calls[2].request.messages.at(-1),
    createRequest(true).messages.at(-1),
  )
  assert.equal(harness.deletedChats.length, 3)
})

test('final compaction ignores an empty role frame and changes account after a pre-output 403', async () => {
  const harness = loadRequestForwarder({
    streamFailureAccountIds: ['account-1'],
  })
  const forwarder = new harness.RequestForwarder()
  const result = await forwarder.forwardChatCompletion(
    createRequest(true),
    { id: 'account-1', credentials: {} },
    { id: 'qwen-ai', apiEndpoint: 'https://chat.qwen.ai' },
    'qwen3.7-plus',
    createContext(true),
  )

  assert.equal(result.success, true)
  assert.equal(result.effectiveAccountId, 'account-4')
  assert.deepEqual(
    harness.calls.filter(call => call.segment === 'final context summary').map(call => call.accountId),
    ['account-1', 'account-4'],
  )
  const chunks = []
  for await (const chunk of result.stream) chunks.push(chunk.toString())
  assert.match(chunks.join(''), /"content":"final"/)
  assert.doesNotMatch(chunks.join(''), /"role":"assistant"/)
})

test('direct compaction HTTP 403 responses retain account failover metadata', async () => {
  const harness = loadRequestForwarder({
    responseFailure: ({ accountId, segment }) => (
      segment === 'final context summary' && accountId === 'account-1'
        ? { status: 403, code: 'qwen_ai_risk_control', message: 'risk control' }
        : undefined
    ),
  })
  const forwarder = new harness.RequestForwarder()
  const result = await forwarder.forwardChatCompletion(
    createRequest(true),
    { id: 'account-1', credentials: {} },
    { id: 'qwen-ai', apiEndpoint: 'https://chat.qwen.ai' },
    'qwen3.7-plus',
    createContext(true),
  )

  assert.equal(result.success, true)
  assert.equal(result.effectiveAccountId, 'account-4')
  assert.deepEqual(
    harness.calls.filter(call => call.segment === 'final context summary').map(call => call.accountId),
    ['account-1', 'account-4'],
  )
  const chunks = []
  for await (const chunk of result.stream) chunks.push(chunk.toString())
  assert.match(chunks.join(''), /"content":"final"/)
})

test('chunked compaction returns a real 403 when every final account fails before content', async () => {
  const harness = loadRequestForwarder({
    accountCount: 4,
    streamFailure: stream => stream.segment === 'final context summary',
  })
  const forwarder = new harness.RequestForwarder()
  const result = await forwarder.forwardChatCompletion(
    createRequest(true),
    { id: 'account-1', credentials: {} },
    { id: 'qwen-ai', apiEndpoint: 'https://chat.qwen.ai' },
    'qwen3.7-plus',
    createContext(true),
  )

  assert.equal(result.success, false)
  assert.equal(result.status, 403)
  assert.equal(result.errorCode, 'qwen_ai_risk_control')
  assert.equal(result.stream, undefined)
  assert.equal(
    harness.calls.filter(call => call.segment === 'final context summary').length,
    4,
  )
})

test('chunked compaction returns the first upstream failure and does not send a final request', async () => {
  const harness = loadRequestForwarder({ failAt: 2 })
  const forwarder = new harness.RequestForwarder()
  const result = await forwarder.forwardChatCompletion(
    createRequest(false),
    { id: 'account-1', credentials: {} },
    { id: 'qwen-ai', apiEndpoint: 'https://chat.qwen.ai' },
    'qwen3.7-plus',
    createContext(false),
  )

  assert.equal(result.success, false)
  assert.equal(result.status, 503)
  assert.equal(harness.calls.length, 2)
})

test('chunked compaction keeps a bounded multimodal turn instead of rejecting the pipeline', async () => {
  const harness = loadRequestForwarder()
  const forwarder = new harness.RequestForwarder()
  const request = createRequest(false)
  const imageUrl = `data:image/png;base64,${'A'.repeat(1000)}`
  request.messages[0] = {
    role: 'user',
    content: [
      { type: 'text', text: 'source-a' },
      { type: 'image_url', image_url: { url: imageUrl } },
    ],
  }

  const result = await forwarder.forwardChatCompletion(
    request,
    { id: 'account-1', credentials: {} },
    { id: 'qwen-ai', apiEndpoint: 'https://chat.qwen.ai' },
    'qwen3.7-plus',
    createContext(false),
  )

  assert.equal(result.success, true)
  assert.equal(harness.calls.length, 3)
  const retainedImages = harness.calls.slice(0, 2).flatMap(call => (
    call.request.messages.flatMap(message => (
      Array.isArray(message.content)
        ? message.content.filter(part => part.type === 'image_url')
        : []
    ))
  ))
  assert.equal(retainedImages.length, 1)
  assert.equal(retainedImages[0].image_url.url, imageUrl)
})

test('chunked compaction maps concurrently, reserves unique accounts, and restores source order', async () => {
  const harness = loadRequestForwarder({
    chunkCount: 4,
    governorCap: 3,
    delayBySegment: {
      'chunk 1/4': 40,
      'chunk 2/4': 5,
      'chunk 3/4': 20,
      'chunk 4/4': 1,
    },
  })
  const forwarder = new harness.RequestForwarder()
  const result = await forwarder.forwardChatCompletion(
    createRequest(false),
    { id: 'account-1', credentials: {} },
    { id: 'qwen-ai', apiEndpoint: 'https://chat.qwen.ai' },
    'qwen3.7-plus',
    createContext(false),
  )

  assert.equal(result.success, true)
  assert.equal(harness.governorMetrics.maxActiveRequests, 3)
  assert.deepEqual(harness.governorMetrics.duplicateActiveAccounts, [])

  const mapCalls = harness.calls.filter(call => call.segment.startsWith('chunk '))
  assert.equal(mapCalls.length, 4)
  assert.equal(new Set(mapCalls.map(call => call.accountId)).size, 4)

  const completedSegments = harness.governorMetrics.events
    .filter(event => event.type === 'upstream-end' && event.segment.startsWith('chunk '))
    .map(event => event.segment)
  assert.notDeepEqual(completedSegments, [
    'chunk 1/4',
    'chunk 2/4',
    'chunk 3/4',
    'chunk 4/4',
  ])

  const finalCall = harness.calls.find(call => call.segment === 'final context summary')
  assert.ok(finalCall)
  const partialSummaries = finalCall.request.messages
    .map(message => message.content)
    .filter(content => typeof content === 'string' && content.startsWith('[Partial summary'))
  assert.deepEqual(partialSummaries, [
    '[Partial summary 1/4]\nsummary:chunk 1/4',
    '[Partial summary 2/4]\nsummary:chunk 2/4',
    '[Partial summary 3/4]\nsummary:chunk 3/4',
    '[Partial summary 4/4]\nsummary:chunk 4/4',
  ])
})

test('chunked compaction fans out pre-output risk failover across free governor slots', async () => {
  const harness = loadRequestForwarder({
    chunkCount: 2,
    governorCap: 3,
    delayBySegment: {
      'chunk 1/2': 20,
      'chunk 2/2': 50,
    },
    failAccount: ({ accountId, segment }) => (
      segment === 'chunk 1/2'
      && (accountId === 'account-2' || accountId === 'account-3')
    ),
  })
  const forwarder = new harness.RequestForwarder()
  const result = await forwarder.forwardChatCompletion(
    createRequest(false),
    { id: 'account-1', credentials: {} },
    { id: 'qwen-ai', apiEndpoint: 'https://chat.qwen.ai' },
    'qwen3.7-plus',
    createContext(false),
  )

  assert.equal(result.success, true)
  assert.ok(harness.governorMetrics.maxActiveRequests >= 3)
  assert.deepEqual(harness.governorMetrics.duplicateActiveAccounts, [])
  const chunkOneAccounts = harness.calls
    .filter(call => call.segment === 'chunk 1/2')
    .map(call => call.accountId)
  assert.ok(chunkOneAccounts.includes('account-2'))
  assert.ok(chunkOneAccounts.includes('account-4'))
  assert.ok(chunkOneAccounts.includes('account-5'))
  const chunkOneStarts = harness.governorMetrics.starts.filter(start => (
    harness.calls.find(call => call.accountId === start.accountId)?.segment === 'chunk 1/2'
  ))
  assert.ok(chunkOneStarts.length >= 3)
  assert.ok(chunkOneStarts.filter(start => start.recoveryBypassGlobalInterval).length >= 2)
})

test('compaction failover burst is bounded to one wave and final generation stays paced', async () => {
  const harness = loadRequestForwarder({
    chunkCount: 2,
    governorCap: 3,
    failAccount: ({ accountId, segment }) => (
      segment === 'chunk 1/2'
      && ['account-2', 'account-3', 'account-4'].includes(accountId)
    ),
  })
  const forwarder = new harness.RequestForwarder()
  const result = await forwarder.forwardChatCompletion(
    createRequest(false),
    { id: 'account-1', credentials: {} },
    { id: 'qwen-ai', apiEndpoint: 'https://chat.qwen.ai' },
    'qwen3.7-plus',
    createContext(false),
  )

  assert.equal(result.success, true)
  const chunkOneStarts = harness.governorMetrics.starts.filter(start => (
    harness.calls.find(call => call.accountId === start.accountId)?.segment === 'chunk 1/2'
  ))
  assert.ok(chunkOneStarts.some(start => start.recoveryBypassGlobalInterval))
  const finalStart = harness.governorMetrics.starts.find(start => (
    harness.calls.find(call => call.accountId === start.accountId)?.segment === 'final context summary'
  ))
  assert.ok(finalStart)
  assert.equal(finalStart.recoveryBypassGlobalInterval, false)
})

test('compaction failover wave retries admission-deferred candidates after a slot frees', async () => {
  const harness = loadRequestForwarder({
    chunkCount: 2,
    governorCap: 3,
    simulateGovernorAdmission: true,
    delayBySegment: {
      'chunk 1/2': 1,
      'chunk 2/2': 45,
    },
    failAccount: ({ accountId, segment }) => (
      segment === 'chunk 1/2' && accountId === 'account-2'
    ),
  })
  const forwarder = new harness.RequestForwarder()
  const result = await forwarder.forwardChatCompletion(
    createRequest(false),
    { id: 'account-1', credentials: {} },
    { id: 'qwen-ai', apiEndpoint: 'https://chat.qwen.ai' },
    'qwen3.7-plus',
    createContext(false),
  )

  assert.equal(result.success, true)
  assert.equal(harness.governorMetrics.maxQueueSize, 0)
  const chunkOneAccounts = harness.calls
    .filter(call => call.segment === 'chunk 1/2')
    .map(call => call.accountId)
  assert.ok(chunkOneAccounts.includes('account-2'))
  assert.ok(chunkOneAccounts.includes('account-4'))
  assert.ok(chunkOneAccounts.includes('account-5'))
})

test('chunked compaction stops dispatching after the first failure and waits for started cleanup', async () => {
  const harness = loadRequestForwarder({
    chunkCount: 6,
    governorCap: 2,
    failSegments: ['chunk 2/6'],
    delayBySegment: {
      'chunk 1/6': 40,
      'chunk 2/6': 5,
    },
  })
  const forwarder = new harness.RequestForwarder()
  const startedAt = Date.now()
  const result = await forwarder.forwardChatCompletion(
    createRequest(false),
    { id: 'account-1', credentials: {} },
    { id: 'qwen-ai', apiEndpoint: 'https://chat.qwen.ai' },
    'qwen3.7-plus',
    createContext(false),
  )

  assert.equal(result.success, false)
  assert.equal(result.status, 503)
  assert.ok(Date.now() - startedAt >= 30)
  assert.deepEqual(
    harness.calls.map(call => call.segment),
    ['chunk 1/6', 'chunk 2/6'],
  )
  assert.equal(harness.governorMetrics.activeRequests, 0)
  assert.deepEqual(harness.deletedChats, ['chat-1'])

  await new Promise(resolve => setTimeout(resolve, 20))
  assert.equal(harness.calls.length, 2)
})

test('chunked compaction stops dispatching after client abort and drains started stages', async () => {
  const harness = loadRequestForwarder({
    chunkCount: 6,
    governorCap: 2,
    delayBySegment: {
      'chunk 1/6': 30,
      'chunk 2/6': 30,
    },
  })
  const forwarder = new harness.RequestForwarder()
  const controller = new AbortController()
  const context = { ...createContext(false), signal: controller.signal }
  const pending = forwarder.forwardChatCompletion(
    createRequest(false),
    { id: 'account-1', credentials: {} },
    { id: 'qwen-ai', apiEndpoint: 'https://chat.qwen.ai' },
    'qwen3.7-plus',
    context,
  )

  while (harness.calls.length < 2) {
    await new Promise(resolve => setTimeout(resolve, 1))
  }
  controller.abort()
  const result = await pending

  assert.equal(result.success, false)
  assert.equal(result.status, 499)
  assert.deepEqual(
    harness.calls.map(call => call.segment),
    ['chunk 1/6', 'chunk 2/6'],
  )
  assert.equal(harness.governorMetrics.activeRequests, 0)
  assert.equal(harness.deletedChats.length, 2)
  assert.ok(harness.governorMetrics.starts.every(start => start.waitForActiveSettlementOnAbort))
})

test('chunked compaction re-reads the governor cap while dispatching', async () => {
  const harness = loadRequestForwarder({
    chunkCount: 5,
    governorCap: ({ completedRequests }) => completedRequests === 0 ? 1 : 3,
    delayBySegment: {
      'chunk 1/5': 10,
      'chunk 2/5': 20,
      'chunk 3/5': 20,
      'chunk 4/5': 20,
      'chunk 5/5': 1,
    },
  })
  const forwarder = new harness.RequestForwarder()
  const result = await forwarder.forwardChatCompletion(
    createRequest(false),
    { id: 'account-1', credentials: {} },
    { id: 'qwen-ai', apiEndpoint: 'https://chat.qwen.ai' },
    'qwen3.7-plus',
    createContext(false),
  )

  assert.equal(result.success, true)
  const mapStarts = harness.governorMetrics.starts.slice(0, 5)
  assert.equal(mapStarts[0].capAtStart, 1)
  assert.equal(mapStarts[0].completedRequestsAtStart, 0)
  assert.ok(mapStarts.slice(1).some(start => start.capAtStart === 3))
  assert.ok(mapStarts.slice(1).some(start => start.completedRequestsAtStart === 1))
  assert.equal(harness.governorMetrics.maxActiveRequests, 3)
})

test('chunked compaction reduces each round concurrently and keeps reduction order', async () => {
  const harness = loadRequestForwarder({
    chunkCount: 4,
    reduceChunkCount: 2,
    governorCap: 2,
    delayBySegment: {
      'reduction 1, group 1/2': 30,
      'reduction 1, group 2/2': 5,
    },
  })
  const forwarder = new harness.RequestForwarder()
  const result = await forwarder.forwardChatCompletion(
    createRequest(false),
    { id: 'account-1', credentials: {} },
    { id: 'qwen-ai', apiEndpoint: 'https://chat.qwen.ai' },
    'qwen3.7-plus',
    createContext(false),
  )

  assert.equal(result.success, true)
  const eventLabels = harness.governorMetrics.events.map(event => `${event.type}:${event.segment}`)
  assert.ok(
    eventLabels.indexOf('upstream-start:reduction 1, group 2/2')
      < eventLabels.indexOf('upstream-end:reduction 1, group 1/2'),
  )

  const finalCall = harness.calls.find(call => call.segment === 'final context summary')
  const partialSummaries = finalCall.request.messages
    .map(message => message.content)
    .filter(content => typeof content === 'string' && content.startsWith('[Partial summary'))
  assert.deepEqual(partialSummaries, [
    '[Partial summary 1/2]\nsummary:reduction 1, group 1/2',
    '[Partial summary 2/2]\nsummary:reduction 1, group 2/2',
  ])
})

test('compaction dispatch capacity uses free slots even when the governor has queued work', () => {
  const harness = loadRequestForwarder()
  const base = {
    remainingStages: 8,
    runningStages: 1,
    providerReadyAccountCount: 6,
    effectiveMaxConcurrent: 4,
    healthyAccountCount: 6,
    activeRequests: 1,
    queueSize: 0,
    globalNextAvailableInMs: 0,
  }

  assert.equal(harness.calculateQwenAiCompactionDispatchCapacity(base), 3)
  assert.equal(harness.calculateQwenAiCompactionDispatchCapacity({ ...base, queueSize: 1 }), 3)
  assert.equal(harness.calculateQwenAiCompactionDispatchCapacity({
    ...base,
    globalNextAvailableInMs: 25,
  }), 0)
})

test('chunked compaction returns no_available_account without polling forever', async () => {
  const harness = loadRequestForwarder({
    chunkCount: 3,
    availableAccountCount: 0,
  })
  const forwarder = new harness.RequestForwarder()
  const result = await forwarder.forwardChatCompletion(
    createRequest(false),
    { id: 'account-1', credentials: {} },
    { id: 'qwen-ai', apiEndpoint: 'https://chat.qwen.ai' },
    'qwen3.7-plus',
    createContext(false),
  )

  assert.equal(result.success, false)
  assert.equal(result.status, 503)
  assert.equal(result.errorCode, 'no_available_account')
  assert.equal(harness.calls.length, 0)
  assert.ok(harness.governorMetrics.statusReads <= 1)
})

test('chunked compaction is not blocked by unrelated queued governor work', async () => {
  const harness = loadRequestForwarder({
    chunkCount: 3,
    governorCap: 3,
    queueSize: 1,
  })
  const forwarder = new harness.RequestForwarder()
  const result = await forwarder.forwardChatCompletion(
    createRequest(false),
    { id: 'account-1', credentials: {} },
    { id: 'qwen-ai', apiEndpoint: 'https://chat.qwen.ai' },
    'qwen3.7-plus',
    createContext(false),
  )

  assert.equal(result.success, true)
  assert.equal(harness.calls.filter(call => call.segment.startsWith('chunk ')).length, 3)
})

test('chunked compaction backs off while all eligible accounts are busy', async () => {
  const harness = loadRequestForwarder({
    chunkCount: 3,
    forceAllAccountsBusy: true,
  })
  const forwarder = new harness.RequestForwarder()
  const controller = new AbortController()
  const pending = forwarder.forwardChatCompletion(
    createRequest(false),
    { id: 'account-1', credentials: {} },
    { id: 'qwen-ai', apiEndpoint: 'https://chat.qwen.ai' },
    'qwen3.7-plus',
    { ...createContext(false), signal: controller.signal },
  )

  await new Promise(resolve => setTimeout(resolve, 100))
  const callsBeforeAbort = harness.calls.length
  const statusReadsBeforeAbort = harness.governorMetrics.statusReads
  controller.abort()
  const result = await pending

  assert.equal(callsBeforeAbort, 0)
  assert.ok(statusReadsBeforeAbort <= 2)
  assert.equal(result.status, 499)
})

test('421k-character compaction keeps sixteen chunks out of the governor queue', async () => {
  const harness = loadRequestForwarder({
    accountCount: 24,
    chunkCount: 16,
    governorCap: 4,
    compactionMaxConcurrent: 3,
    simulateGovernorAdmission: true,
    delayForCall: () => 2,
    failAccount: ({ accountId, segment }) => (
      segment === 'chunk 1/16' && accountId === 'account-2'
    ),
  })
  const forwarder = new harness.RequestForwarder()
  const request = createRequest(false)
  request.messages[0].content = 'source-'.repeat(60_000) // ~420k source chars
  const result = await forwarder.forwardChatCompletion(
    request,
    { id: 'account-1', credentials: {} },
    { id: 'qwen-ai', apiEndpoint: 'https://chat.qwen.ai' },
    'qwen3.7-plus',
    createContext(false),
  )

  assert.equal(result.success, true)
  assert.equal(harness.governorMetrics.maxQueueSize, 0)
  assert.ok(harness.governorMetrics.maxActiveRequests <= 3)
  assert.equal(
    harness.calls.filter(call => call.segment.startsWith('chunk ')).length,
    17,
  )
  assert.ok(request.messages[0].content.length > 400_000)
})
