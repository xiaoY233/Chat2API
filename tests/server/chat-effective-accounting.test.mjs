import assert from 'node:assert/strict'
import { EventEmitter, once } from 'node:events'
import fs from 'node:fs'
import { PassThrough } from 'node:stream'
import test from 'node:test'
import ts from 'typescript'
import { createAssistantOutputBoundaryStream } from '../../src/main/proxy/toolCalling/assistantOutputBoundary.ts'
import {
  isQwenAiAccountFault,
  qwenAiAccountRetryScope,
} from '../../src/main/proxy/qwenAiAccountPolicy.ts'

const QWEN_AI_STREAM_FAILURE_EVENT = 'qwen-ai-stream-failure'

function loadChatRoute({
  stream,
  forwardResult,
  activeAccountCount = 2,
  configuredMaxFailovers = 0,
  qwenAiProvider = true,
  deferManagedStreamCommit = false,
}) {
  const source = fs.readFileSync('src/main/proxy/routes/chat.ts', 'utf8')
  const output = ts.transpileModule(source, {
    compilerOptions: {
      esModuleInterop: true,
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
    },
  }).outputText
  const module = { exports: {} }
  let routeHandler

  const initialProvider = {
    id: 'provider-initial',
    name: 'Initial Qwen',
    apiEndpoint: qwenAiProvider
      ? 'https://chat.qwen.ai/initial'
      : 'https://api.example.com/initial',
  }
  const effectiveProvider = {
    id: 'provider-effective',
    name: 'Effective Qwen',
    apiEndpoint: qwenAiProvider
      ? 'https://chat.qwen.ai/effective'
      : 'https://api.example.com/effective',
  }
  const initialAccount = {
    id: 'account-initial',
    providerId: initialProvider.id,
    name: 'Initial Account',
  }
  const effectiveAccount = {
    id: 'account-effective',
    providerId: effectiveProvider.id,
    name: 'Effective Account',
  }
  const accounts = new Map([
    [initialAccount.id, initialAccount],
    [effectiveAccount.id, effectiveAccount],
  ])
  const providers = new Map([
    [initialProvider.id, initialProvider],
    [effectiveProvider.id, effectiveProvider],
  ])
  const initialSelection = {
    account: initialAccount,
    provider: initialProvider,
    actualModel: 'qwen-initial-model',
  }
  const calls = {
    cleared: [],
    failed: [],
    riskControlled: [],
    usage: [],
    stats: [],
    logs: [],
    requestLogs: [],
    requestLogUpdates: [],
    maxFailovers: [],
    governorFailures: [],
    statusSuccesses: [],
    statusFailures: [],
    forwardContexts: [],
  }

  class MockRouter {
    post(_path, handler) {
      routeHandler = handler
    }
  }

  class MockQwenAiAdapter {
    static isQwenAiProvider(provider) {
      return provider?.apiEndpoint?.includes('qwen.ai') === true
    }
  }

  class MockKimiAdapter {
    static isKimiProvider() {
      return false
    }
  }

  class MockSseKeepAliveStream extends PassThrough {}

  const storeManager = {
    getConfig: () => ({ retryCount: configuredMaxFailovers, loadBalanceStrategy: 'round-robin' }),
    getAccountsByProviderId: () => [
      ...Array.from({ length: activeAccountCount }, (_, index) => ({
        id: `active-account-${index + 1}`,
        providerId: initialProvider.id,
        status: 'active',
      })),
      { id: 'inactive-account', providerId: initialProvider.id, status: 'inactive' },
    ],
    getAccountById: id => accounts.get(id),
    getProviderById: id => providers.get(id),
    addLog: (level, message, metadata) => {
      calls.logs.push({ level, message, metadata })
    },
    addRequestLog: entry => {
      const stored = { id: `request-log-${calls.requestLogs.length + 1}`, ...entry }
      calls.requestLogs.push(stored)
      return stored
    },
    updateRequestLog: (id, updates) => {
      calls.requestLogUpdates.push({ id, updates })
      const index = calls.requestLogs.findIndex(entry => entry.id === id)
      if (index < 0) return false
      calls.requestLogs[index] = { ...calls.requestLogs[index], ...updates }
      return true
    },
    incrementAccountUsage: accountId => calls.usage.push(accountId),
    recordRequestInStats: (success, latency, model, providerId, accountId) => {
      calls.stats.push({ success, latency, model, providerId, accountId })
    },
  }

  const localModules = {
    'node:stream': { PassThrough },
    '@koa/router': MockRouter,
    '../types': {},
    '../loadbalancer': {
      loadBalancer: {
        selectAccount: () => initialSelection,
        hasCompleteQwenAiWebSession: () => false,
        clearAccountFailure: accountId => calls.cleared.push(accountId),
        markAccountFailed: accountId => calls.failed.push(accountId),
        markQwenAiRiskControl: accountId => calls.riskControlled.push(accountId),
      },
    },
    '../forwarder': {
      requestForwarder: {
        forwardChatCompletion: async (...args) => {
          calls.forwardContexts.push(args.at(-1))
          return forwardResult
        },
      },
      shouldDeferQwenAiManagedStreamCommit: () => deferManagedStreamCommit,
    },
    '../qwenAiDeferredStream': {
      createDeferredQwenAiFailoverStream: outcomePromise => {
        const deferred = new PassThrough()
        void outcomePromise.then(outcome => {
          deferred.qwenAiEffectiveAccountId = outcome.selection.account.id
          deferred.qwenAiEffectiveProviderId = outcome.selection.provider.id
          deferred.qwenAiEffectiveActualModel = outcome.selection.actualModel
          if (!outcome.result.success || !outcome.result.stream) {
            deferred.destroy(new Error(outcome.result.error || 'deferred failure'))
            return
          }
          outcome.result.stream.pipe(deferred)
        })
        return deferred
      },
    },
    '../accountFailover': {
      forwardWithAccountFailover: async options => {
        calls.maxFailovers.push(options.maxFailovers)
        return {
          selection: options.initialSelection,
          result: await options.forward({ selection: options.initialSelection }),
          failoverCount: 0,
        }
      },
      resolveAccountFailoverLimit: input => {
        if (!input.qwenAiProvider) return input.configuredMaxFailovers
        const poolLimit = Math.max(0, input.activeAccountCount - 1)
        const deploymentLimit = Number(input.qwenAiMaxAccountFailovers)
        return Number.isSafeInteger(deploymentLimit) && deploymentLimit > 0
          ? Math.min(poolLimit, deploymentLimit)
          : poolLimit
      },
    },
    '../qwenAiRequestGovernor': {
      qwenAiRequestGovernor: {
        reportAccountFailover: () => {},
        reportDeferredFailure: (accountId, result) => {
          calls.governorFailures.push({ accountId, result })
        },
      },
    },
    '../adapters/kimi': { KimiAdapter: MockKimiAdapter },
    '../adapters/qwen-ai': {
      QwenAiAdapter: MockQwenAiAdapter,
      QWEN_AI_STREAM_FAILURE_EVENT,
    },
    '../stream': {
      streamHandler: {
        createTransformStream: () => new PassThrough(),
      },
    },
    '../status': {
      proxyStatusManager: {
        recordRequestStart: () => {},
        recordRequestSuccess: latency => calls.statusSuccesses.push(latency),
        recordRequestFailure: latency => calls.statusFailures.push(latency),
      },
    },
    '../modelMapper': {
      modelMapper: {
        getPreferredProvider: () => undefined,
        getPreferredAccount: () => undefined,
      },
    },
    '../../store/store': { storeManager },
    '../utils/toolFormatConverter': {
      isAnthropicToolFormat: () => false,
      transformResponseToAnthropic: value => value,
      transformChunkToAnthropic: value => value,
    },
    '../utils/errors': {
      isClientCancellationError: error => error?.status === 499,
      sanitizeForwardedErrorHeaders: headers => headers,
    },
    '../utils/sseKeepAlive': { SseKeepAliveStream: MockSseKeepAliveStream },
    '../requestIntent': {
      classifyChatRequest: () => ({
        intent: 'context_compaction',
        reason: 'test',
        messageCount: 2,
        toolCount: 0,
        textChars: 100,
        lastUserTextChars: 20,
        lastUserTextPrefix: 'compact',
      }),
    },
    '../qwenAiSessionBridge': {
      createQwenAiSessionRequestFingerprint: () => 'qwen-chat-test-fingerprint',
      resolveQwenAiSessionBinding: () => undefined,
    },
    '../qwenAiToolCallSessionStore': {
      getTrailingQwenAiToolResultBatch: () => undefined,
      qwenAiToolCallSessionStore: {
        resolve: () => undefined,
        set: () => true,
        delete: () => {},
      },
    },
    '../toolCalling/assistantOutputBoundary': { createAssistantOutputBoundaryStream },
    '../qwenAiAccountPolicy': { isQwenAiAccountFault, qwenAiAccountRetryScope },
  }
  const testRequire = specifier => {
    if (specifier in localModules) return localModules[specifier]
    throw new Error(`Unexpected chat route test import: ${specifier}`)
  }

  new Function('require', 'module', 'exports', output)(testRequire, module, module.exports)
  assert.equal(typeof routeHandler, 'function')

  return {
    calls,
    effectiveAccount,
    effectiveProvider,
    initialAccount,
    routeHandler,
    stream,
  }
}

async function invokeChatRoute(harness) {
  const req = new EventEmitter()
  const res = new EventEmitter()
  res.writableEnded = false
  const responseHeaders = {}
  const ctx = {
    headers: {},
    ip: '127.0.0.1',
    req,
    res,
    request: {
      body: {
        model: 'claude-test-model',
        messages: [{ role: 'user', content: 'compact this conversation' }],
        stream: harness.stream,
      },
    },
    set: (name, value) => {
      responseHeaders[name] = value
    },
  }

  await harness.routeHandler(ctx)
  return { ctx, responseHeaders }
}

function setEffectiveStreamSelection(stream) {
  stream.qwenAiEffectiveAccountId = 'account-effective'
  stream.qwenAiEffectiveProviderId = 'provider-effective'
  stream.qwenAiEffectiveActualModel = 'qwen-effective-model'
}

async function withQwenFailoverLimit(value, operation) {
  const previous = process.env.CHAT2API_QWEN_AI_MAX_ACCOUNT_FAILOVERS
  if (value === undefined) {
    delete process.env.CHAT2API_QWEN_AI_MAX_ACCOUNT_FAILOVERS
  } else {
    process.env.CHAT2API_QWEN_AI_MAX_ACCOUNT_FAILOVERS = value
  }

  try {
    return await operation()
  } finally {
    if (previous === undefined) {
      delete process.env.CHAT2API_QWEN_AI_MAX_ACCOUNT_FAILOVERS
    } else {
      process.env.CHAT2API_QWEN_AI_MAX_ACCOUNT_FAILOVERS = previous
    }
  }
}

test('chat route uses all 99 active Qwen accounts while non-Qwen keeps retryCount', async () => {
  await withQwenFailoverLimit('0', async () => {
    const harness = loadChatRoute({
      stream: false,
      activeAccountCount: 99,
      configuredMaxFailovers: 3,
      forwardResult: { success: true, status: 200, body: { choices: [] } },
    })
    await invokeChatRoute(harness)
    assert.deepEqual(harness.calls.maxFailovers, [98])
  })

  await withQwenFailoverLimit('80', async () => {
    const harness = loadChatRoute({
      stream: false,
      activeAccountCount: 99,
      configuredMaxFailovers: 3,
      qwenAiProvider: false,
      forwardResult: { success: true, status: 200, body: { choices: [] } },
    })
    await invokeChatRoute(harness)
    assert.deepEqual(harness.calls.maxFailovers, [3])
  })
})

test('managed Qwen route returns its client stream before atomic account validation finishes', async () => {
  let resolveForward
  const pendingForward = new Promise(resolve => {
    resolveForward = resolve
  })
  const upstream = new PassThrough()
  const harness = loadChatRoute({
    stream: true,
    deferManagedStreamCommit: true,
    forwardResult: pendingForward,
  })

  const invocation = invokeChatRoute(harness)
  const { ctx } = await Promise.race([
    invocation,
    new Promise((_, reject) => setTimeout(
      () => reject(new Error('route waited for managed account validation before returning the SSE stream')),
      200,
    )),
  ])

  assert.equal(harness.calls.forwardContexts.length, 1)
  assert.equal(harness.calls.forwardContexts[0].deferManagedStreamCommit, true)
  assert.ok(ctx.body instanceof PassThrough)

  ctx.body.resume()
  const ended = once(ctx.body, 'end')
  resolveForward({
    success: true,
    status: 200,
    stream: upstream,
    skipTransform: true,
  })
  await new Promise(resolve => setImmediate(resolve))
  upstream.end('data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n')
  await ended
})

test('non-stream chat accounting uses ForwardResult effective selection', async () => {
  const harness = loadChatRoute({
    stream: false,
    forwardResult: {
      success: true,
      status: 200,
      body: { choices: [{ message: { role: 'assistant', content: 'summary' } }] },
      effectiveAccountId: 'account-effective',
      effectiveProviderId: 'provider-effective',
      effectiveActualModel: 'qwen-effective-model',
    },
  })

  await invokeChatRoute(harness)

  assert.deepEqual(harness.calls.cleared, ['account-effective'])
  assert.deepEqual(harness.calls.usage, ['account-effective'])
  assert.deepEqual(
    harness.calls.stats.map(({ success, providerId, accountId }) => ({ success, providerId, accountId })),
    [{ success: true, providerId: 'provider-effective', accountId: 'account-effective' }],
  )
  assert.equal(harness.calls.requestLogs[0].providerId, 'provider-effective')
  assert.equal(harness.calls.requestLogs[0].accountId, 'account-effective')
  assert.equal(harness.calls.requestLogs[0].actualModel, 'qwen-effective-model')
})

test('deferred stream success reads effective selection when the stream ends', async () => {
  const upstream = new PassThrough()
  const harness = loadChatRoute({
    stream: true,
    forwardResult: {
      success: true,
      status: 200,
      stream: upstream,
      skipTransform: true,
      effectiveAccountId: 'account-initial',
      effectiveProviderId: 'provider-initial',
      effectiveActualModel: 'qwen-initial-model',
    },
  })
  const { ctx } = await invokeChatRoute(harness)
  ctx.body.resume()
  const ended = once(ctx.body, 'end')

  assert.equal(harness.calls.requestLogs[0].accountId, 'account-initial')
  setEffectiveStreamSelection(upstream)
  upstream.end('data: {"choices":[{"delta":{"content":"summary"}}]}\n\ndata: [DONE]\n\n')
  await ended

  assert.deepEqual(harness.calls.cleared, ['account-effective'])
  assert.deepEqual(harness.calls.usage, ['account-effective'])
  assert.deepEqual(
    harness.calls.stats.map(({ success, providerId, accountId }) => ({ success, providerId, accountId })),
    [{ success: true, providerId: 'provider-effective', accountId: 'account-effective' }],
  )
  const completionLog = harness.calls.logs.find(entry => entry.message === 'Stream response completed')
  assert.equal(completionLog.metadata.providerId, 'provider-effective')
  assert.equal(completionLog.metadata.accountId, 'account-effective')
  assert.equal(completionLog.metadata.actualModel, 'qwen-effective-model')
  assert.equal(harness.calls.requestLogs[0].providerId, 'provider-effective')
  assert.equal(harness.calls.requestLogs[0].accountId, 'account-effective')
  assert.equal(harness.calls.requestLogs[0].actualModel, 'qwen-effective-model')
})

test('deferred stream failure applies governor, cooldown, stats, and logs to effective account', async () => {
  const upstream = new PassThrough()
  const harness = loadChatRoute({
    stream: true,
    forwardResult: {
      success: true,
      status: 200,
      stream: upstream,
      skipTransform: true,
      effectiveAccountId: 'account-initial',
      effectiveProviderId: 'provider-initial',
      effectiveActualModel: 'qwen-initial-model',
    },
  })
  const { ctx } = await invokeChatRoute(harness)
  const output = []
  ctx.body.on('data', chunk => output.push(chunk))
  const ended = once(ctx.body, 'end')
  setEffectiveStreamSelection(upstream)
  const failure = Object.assign(new Error('FAIL_SYS_USER_VALIDATE risk-control challenge'), {
    status: 403,
    code: 'qwen_ai_risk_control',
    accountFault: true,
  })
  upstream.qwenAiFailure = failure
  upstream.emit(QWEN_AI_STREAM_FAILURE_EVENT, failure)
  upstream.destroy(failure)
  await ended

  const body = Buffer.concat(output).toString()
  assert.match(body, /event: error/)
  assert.match(body, /"status":403/)
  assert.match(body, /"code":"qwen_ai_risk_control"/)
  assert.doesNotMatch(body, /\[Error:/)

  assert.deepEqual(
    harness.calls.governorFailures.map(entry => entry.accountId),
    ['account-effective'],
  )
  assert.deepEqual(harness.calls.riskControlled, ['account-effective'])
  assert.deepEqual(harness.calls.failed, [])
  assert.deepEqual(harness.calls.usage, [])
  assert.deepEqual(
    harness.calls.stats.map(({ success, providerId, accountId }) => ({ success, providerId, accountId })),
    [{ success: false, providerId: 'provider-effective', accountId: 'account-effective' }],
  )
  const failureLog = harness.calls.logs.find(entry => entry.message.startsWith('Stream response failed:'))
  assert.equal(failureLog.metadata.providerId, 'provider-effective')
  assert.equal(failureLog.metadata.accountId, 'account-effective')
  assert.equal(failureLog.metadata.actualModel, 'qwen-effective-model')
  assert.equal(harness.calls.requestLogs[0].status, 'error')
  assert.equal(harness.calls.requestLogs[0].providerId, 'provider-effective')
  assert.equal(harness.calls.requestLogs[0].accountId, 'account-effective')
  assert.equal(harness.calls.requestLogs[0].actualModel, 'qwen-effective-model')
})

test('generic protocol stream failure stays structured and is recorded as a failure', async () => {
  const upstream = new PassThrough()
  const harness = loadChatRoute({
    stream: true,
    qwenAiProvider: false,
    forwardResult: {
      success: true,
      status: 200,
      stream: upstream,
      skipTransform: true,
    },
  })
  const { ctx } = await invokeChatRoute(harness)
  const output = []
  ctx.body.on('data', chunk => output.push(chunk))
  const ended = once(ctx.body, 'end')
  const failure = Object.assign(new Error('internal managed wrapper reached the response boundary'), {
    status: 502,
    code: 'managed_tool_result_wrapper_leak',
    type: 'upstream_protocol_error',
    param: 'content',
    retryable: false,
    accountFault: false,
  })

  upstream.destroy(failure)
  await ended

  const body = Buffer.concat(output).toString()
  assert.match(body, /event: error/)
  assert.match(body, /"status":502/)
  assert.match(body, /"code":"managed_tool_result_wrapper_leak"/)
  assert.match(body, /"type":"upstream_protocol_error"/)
  assert.match(body, /"param":"content"/)
  assert.match(body, /"retryable":false/)
  assert.match(body, /"accountFault":false/)
  assert.doesNotMatch(body, /finish_reason|\[DONE\]|\[Error:/)
  assert.deepEqual(harness.calls.usage, [])
  assert.deepEqual(harness.calls.failed, [])
  assert.deepEqual(
    harness.calls.stats.map(({ success, providerId, accountId }) => ({ success, providerId, accountId })),
    [{ success: false, providerId: 'provider-initial', accountId: 'account-initial' }],
  )
  assert.equal(harness.calls.requestLogs[0].status, 'error')
  assert.equal(harness.calls.requestLogs[0].statusCode, 502)
  assert.equal(harness.calls.requestLogs[0].errorCode, 'managed_tool_result_wrapper_leak')
})

test('route boundary blocks a reasoning wrapper emitted as otherwise successful SSE', async () => {
  const upstream = new PassThrough()
  const harness = loadChatRoute({
    stream: true,
    qwenAiProvider: false,
    forwardResult: {
      success: true,
      status: 200,
      stream: upstream,
      skipTransform: true,
    },
  })
  const { ctx } = await invokeChatRoute(harness)
  const output = []
  ctx.body.on('data', chunk => output.push(chunk))
  const ended = once(ctx.body, 'end')
  const chunk = value => `data: ${JSON.stringify({
    id: 'chatcmpl-route-boundary',
    object: 'chat.completion.chunk',
    created: 1,
    model: 'fixture-model',
    choices: [{ index: 0, delta: { reasoning_content: value }, finish_reason: null }],
  })}\n\n`

  upstream.write(chunk('checking <|CHAT2API|tool_'))
  upstream.write(chunk('result tool_call_id="call_fake"><![CDATA[value]]></|CHAT2API|tool_result>'))
  upstream.end('data: [DONE]\n\n')
  await ended

  const body = Buffer.concat(output).toString()
  assert.match(body, /event: error/)
  assert.match(body, /"status":502/)
  assert.match(body, /"code":"managed_tool_result_wrapper_leak"/)
  assert.match(body, /"param":"reasoning_content"/)
  assert.doesNotMatch(body, /CHAT2API\|tool_result|"finish_reason":"(?:stop|tool_calls)"|data: \[DONE\]|\[Error:/)
  assert.deepEqual(harness.calls.usage, [])
  assert.deepEqual(
    harness.calls.stats.map(({ success, providerId, accountId }) => ({ success, providerId, accountId })),
    [{ success: false, providerId: 'provider-initial', accountId: 'account-initial' }],
  )
  assert.equal(harness.calls.requestLogs[0].status, 'error')
  assert.equal(harness.calls.requestLogs[0].errorCode, 'managed_tool_result_wrapper_leak')
})
