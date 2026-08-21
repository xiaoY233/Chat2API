import assert from 'node:assert/strict'
import { EventEmitter, once } from 'node:events'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import { PassThrough, Transform } from 'node:stream'
import test from 'node:test'
import ts from 'typescript'
import {
  isQwenAiAccountFault,
  qwenAiAccountRetryScope,
} from '../../src/main/proxy/qwenAiAccountPolicy.ts'

const runtimeRequire = createRequire(import.meta.url)
const QWEN_STREAM_FAILURE_EVENT = 'qwen-ai-stream-failure'

function loadAccountFailoverModule() {
  const source = fs.readFileSync('src/main/proxy/accountFailover.ts', 'utf8')
  const output = ts.transpileModule(source, {
    compilerOptions: {
      esModuleInterop: true,
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
    },
  }).outputText
  const module = { exports: {} }
  new Function('require', 'module', 'exports', output)(runtimeRequire, module, module.exports)
  return module.exports
}

const accountFailoverModule = loadAccountFailoverModule()

function loadDeferredStreamModule() {
  const source = fs.readFileSync('src/main/proxy/qwenAiDeferredStream.ts', 'utf8')
  const output = ts.transpileModule(source, {
    compilerOptions: {
      esModuleInterop: true,
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
    },
  }).outputText
  const module = { exports: {} }
  new Function('require', 'module', 'exports', output)(runtimeRequire, module, module.exports)
  return module.exports
}

const deferredStreamModule = loadDeferredStreamModule()

function loadResponsesRoute(createResult, options = {}) {
  const source = fs.readFileSync('src/main/proxy/routes/responses.ts', 'utf8')
  const output = ts.transpileModule(source, {
    compilerOptions: {
      esModuleInterop: true,
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
    },
  }).outputText

  const calls = {
    cleared: [],
    failed: [],
    usage: [],
    stats: [],
    logs: [],
    governorFailures: [],
    accountFailovers: [],
    attemptedAccountIds: [],
    failoverLimitInputs: [],
    maxFailovers: [],
    forwardContexts: [],
  }
  const qwenAiProvider = options.qwenAiProvider !== false
  const activeAccountCount = Math.max(1, options.activeAccountCount ?? 1)
  const providers = new Map([
    ['qwen-ai-initial', {
      id: 'qwen-ai-initial',
      name: 'Qwen initial',
      apiEndpoint: qwenAiProvider ? 'https://chat.qwen.ai' : 'https://api.example.test',
    }],
    ['qwen-ai-effective', {
      id: 'qwen-ai-effective',
      name: 'Qwen effective',
      apiEndpoint: 'https://chat.qwen.ai',
    }],
  ])
  const initialAccount = {
      id: 'account-initial',
      name: 'Initial account',
      providerId: 'qwen-ai-initial',
      status: 'active',
    }
  const poolAccounts = [
    initialAccount,
    ...Array.from({ length: activeAccountCount - 1 }, (_, index) => ({
      id: `account-pool-${index + 2}`,
      name: `Pool account ${index + 2}`,
      providerId: 'qwen-ai-initial',
      status: 'active',
    })),
  ]
  const accounts = new Map([
    ...poolAccounts.map(account => [account.id, account]),
    ['account-effective', {
      id: 'account-effective',
      name: 'Effective account',
      providerId: 'qwen-ai-effective',
      status: 'active',
    }],
  ])
  const poolSelections = poolAccounts.map(account => ({
    account,
    provider: providers.get('qwen-ai-initial'),
    actualModel: 'qwen-initial-model',
  }))
  const initialSelection = {
    account: initialAccount,
    provider: providers.get('qwen-ai-initial'),
    actualModel: 'qwen-initial-model',
  }

  class MockRouter {
    constructor() {
      this.stack = []
    }

    post(path, handler) {
      this.stack.push({ path, handler })
      return this
    }
  }

  class MockResponsesStream extends Transform {
    constructor(options) {
      super()
      this.options = options
      this.failed = false
    }

    _transform(_chunk, _encoding, callback) {
      callback()
    }

    _flush(callback) {
      if (!this.failed) {
        this.options.onComplete({ output: [] })
      }
      callback()
    }

    fail(error) {
      if (this.failed) return
      this.failed = true
      this.options.onFailure(error)
    }
  }

  class MockCompatibilityError extends Error {}
  class MockImageResolutionError extends Error {
    constructor(message, status = 502) {
      super(message)
      this.status = status
      this.code = 'image_resolution_error'
    }
  }

  const localModules = {
    '@koa/router': MockRouter,
    '../forwarder': {
      shouldDeferQwenAiManagedStreamCommit: request => Boolean(
        request.stream === true
        && request.tools?.length
        && request.tool_choice !== 'none'
      ),
      requestForwarder: {
        forwardChatCompletion: async (_request, account, provider, actualModel, context) => {
          calls.attemptedAccountIds.push(account.id)
          calls.forwardContexts.push(context)
          return createResult({
            account,
            provider,
            actualModel,
            attempt: calls.attemptedAccountIds.length,
          })
        },
      },
    },
    '../loadbalancer': {
      loadBalancer: {
        selectAccount: (
          _model,
          _strategy,
          _preferredProviderId,
          _preferredAccountId,
          excludedAccountIds = new Set(),
        ) => poolSelections.find(selection => !excludedAccountIds.has(selection.account.id)) ?? null,
        hasCompleteQwenAiWebSession: () => false,
        clearAccountFailure: accountId => calls.cleared.push(accountId),
        markAccountFailed: accountId => calls.failed.push(accountId),
      },
    },
    '../accountFailover': {
      forwardWithAccountFailover: options => {
        calls.maxFailovers.push(options.maxFailovers)
        return accountFailoverModule.forwardWithAccountFailover(options)
      },
      resolveAccountFailoverLimit: input => {
        calls.failoverLimitInputs.push(input)
        return accountFailoverModule.resolveAccountFailoverLimit(input)
      },
    },
    '../qwenAiDeferredStream': deferredStreamModule,
    '../qwenAiRequestGovernor': {
      qwenAiRequestGovernor: {
        reportAccountFailover: (accountId, details) => {
          calls.accountFailovers.push({ accountId, details })
        },
        reportDeferredFailure: (accountId, result) => {
          calls.governorFailures.push({ accountId, result })
        },
      },
    },
    '../adapters/qwen-ai': {
      QWEN_AI_STREAM_FAILURE_EVENT: QWEN_STREAM_FAILURE_EVENT,
      QwenAiAdapter: {
        isQwenAiProvider: provider => provider?.apiEndpoint === 'https://chat.qwen.ai',
      },
    },
    '../modelMapper': {
      modelMapper: {
        getPreferredProvider: () => undefined,
        getPreferredAccount: () => undefined,
      },
    },
    '../status': {
      proxyStatusManager: {
        recordRequestStart: () => {},
        recordRequestSuccess: () => {},
        recordRequestFailure: () => {},
      },
    },
    '../stream': {
      streamHandler: {
        createTransformStream: () => new PassThrough(),
      },
    },
    '../../store/store': {
      storeManager: {
        getConfig: () => ({
          loadBalanceStrategy: 'round-robin',
          retryCount: options.retryCount ?? 0,
        }),
        getAccountsByProviderId: providerId => [...accounts.values()]
          .filter(account => account.providerId === providerId),
        getAccountById: accountId => accounts.get(accountId),
        getProviderById: providerId => providers.get(providerId),
        incrementAccountUsage: accountId => calls.usage.push(accountId),
        recordRequestInStats: (...args) => calls.stats.push(args),
        addLog: (level, message, context) => calls.logs.push({ level, message, context }),
      },
    },
    '../utils/errors': {
      isClientCancellationError: () => false,
      sanitizeForwardedErrorHeaders: headers => headers,
    },
    '../utils/sseKeepAlive': {
      SseKeepAliveStream: class SseKeepAliveStream extends PassThrough {
        constructor() {
          super()
          this.push(': keep-alive\n\n')
        }
      },
    },
    '../responses/compat': {
      ResponsesCompatibilityError: MockCompatibilityError,
      responsesRequestToChatCompletion: request => ({
        chatRequest: {
          model: request.model,
          messages: [{ role: 'user', content: String(request.input || '') }],
          stream: request.stream === true,
          tools: request.tools,
          tool_choice: request.tool_choice,
        },
        conversationMessages: [],
      }),
      chatCompletionToResponse: async (_completion, _request, options) => ({
        id: options.id,
        model: options.model,
        output: [],
      }),
      responseOutputToChatMessages: () => [],
    },
    '../responses/store': {
      responsesConversationStore: {
        get: () => undefined,
        getConversation: () => undefined,
        set: () => true,
        clearQwenAiSessionBinding: () => {},
      },
    },
    '../responses/stream': {
      createResponsesStreamTransform: options => ({
        start: () => new MockResponsesStream(options),
      }),
    },
    '../responses/image': {
      ResponseImageResolutionError: MockImageResolutionError,
      createResponseImageResolver: () => async value => value,
    },
    '../requestIntent': {
      classifyChatRequest: () => ({
        intent: 'normal',
        reason: 'test',
        signals: [],
        messageCount: 1,
        toolCount: 0,
        textChars: 0,
        lastUserTextChars: 0,
      }),
    },
    '../qwenAiSessionBridge': {
      createQwenAiSessionRequestFingerprint: () => 'qwen-responses-test-fingerprint',
      resolveQwenAiSessionBinding: state => state ? {
        providerId: state.providerId,
        accountId: state.accountId,
        requestedModel: state.requestedModel,
        actualModel: state.actualModel,
        chatId: state.getChatId(),
        parentId: state.getParentId(),
        requestFingerprint: state.requestFingerprint,
      } : undefined,
    },
    '../qwenAiToolCallSessionStore': {
      getTrailingQwenAiToolResultBatch: () => undefined,
      qwenAiToolCallSessionStore: {
        resolve: () => undefined,
        set: () => true,
        delete: () => {},
      },
    },
    '../toolCalling/workflowHeuristics': {
      hasTrailingMatchedToolResultBatch: () => false,
    },
    '../qwenAiAccountPolicy': { isQwenAiAccountFault, qwenAiAccountRetryScope },
  }
  const testRequire = specifier => {
    if (Object.prototype.hasOwnProperty.call(localModules, specifier)) {
      return localModules[specifier]
    }
    if (specifier.startsWith('.')) throw new Error(`Unexpected import: ${specifier}`)
    return runtimeRequire(specifier)
  }
  const module = { exports: {} }
  new Function('require', 'module', 'exports', output)(testRequire, module, module.exports)
  const router = module.exports.default
  const handler = router.stack.find(layer => layer.path === '/responses')?.handler
  assert.equal(typeof handler, 'function')
  return { handler, calls }
}

function createContext(body) {
  const req = new EventEmitter()
  const res = new EventEmitter()
  res.writableEnded = false
  return {
    request: { body },
    headers: {},
    req,
    res,
    ip: '127.0.0.1',
    responseHeaders: {},
    set(name, value) {
      this.responseHeaders[name] = value
    },
  }
}

function assertEffectiveStats(calls, success) {
  assert.equal(calls.stats.length, 1)
  assert.equal(calls.stats[0][0], success)
  assert.equal(calls.stats[0][3], 'qwen-ai-effective')
  assert.equal(calls.stats[0][4], 'account-effective')
  const log = calls.logs.find(entry => entry.message === (
    success ? 'Responses request completed' : 'Responses request failed'
  ))
  assert.equal(log?.context.providerId, 'qwen-ai-effective')
  assert.equal(log?.context.accountId, 'account-effective')
  assert.equal(log?.context.actualModel, 'qwen-effective-model')
}

async function withoutQwenFailoverCap(operation) {
  const key = 'CHAT2API_QWEN_AI_MAX_ACCOUNT_FAILOVERS'
  const hadValue = Object.prototype.hasOwnProperty.call(process.env, key)
  const previousValue = process.env[key]
  delete process.env[key]
  try {
    return await operation()
  } finally {
    if (hadValue) process.env[key] = previousValue
    else delete process.env[key]
  }
}

test('Responses non-stream success charges the effective internal account', async () => {
  const { handler, calls } = loadResponsesRoute(() => ({
    success: true,
    status: 200,
    body: { choices: [] },
    effectiveAccountId: 'account-effective',
    effectiveProviderId: 'qwen-ai-effective',
    effectiveActualModel: 'qwen-effective-model',
  }))
  const ctx = createContext({ model: 'claude-client-model', input: 'compact this' })

  await handler(ctx)

  assert.deepEqual(calls.usage, ['account-effective'])
  assert.deepEqual(calls.cleared, ['account-effective'])
  assertEffectiveStats(calls, true)
  assert.equal(ctx.body.model, 'qwen-effective-model')
})

test('Responses non-stream failure penalizes and logs the effective internal account', async () => {
  const { handler, calls } = loadResponsesRoute(() => ({
    success: false,
    status: 403,
    error: 'effective account rejected the request',
    errorCode: 'qwen_ai_risk_control',
    accountFault: true,
    effectiveAccountId: 'account-effective',
    effectiveProviderId: 'qwen-ai-effective',
    effectiveActualModel: 'qwen-effective-model',
  }))
  const ctx = createContext({ model: 'claude-client-model', input: 'compact this' })

  await handler(ctx)

  assert.equal(ctx.status, 403)
  assert.deepEqual(calls.failed, ['account-effective'])
  assert.deepEqual(calls.usage, [])
  assertEffectiveStats(calls, false)
})

test('Responses stream completion reads late effective-account metadata before usage accounting', async () => {
  const rawStream = new PassThrough()
  const { handler, calls } = loadResponsesRoute(() => {
    setImmediate(() => {
      rawStream.qwenAiEffectiveAccountId = 'account-effective'
      rawStream.qwenAiEffectiveProviderId = 'qwen-ai-effective'
      rawStream.qwenAiEffectiveActualModel = 'qwen-effective-model'
      rawStream.end('data: [DONE]\n\n')
    })
    return {
      success: true,
      status: 200,
      stream: rawStream,
      skipTransform: true,
      effectiveAccountId: 'account-initial',
      effectiveProviderId: 'qwen-ai-initial',
      effectiveActualModel: 'qwen-initial-model',
    }
  })
  const ctx = createContext({ model: 'claude-client-model', input: 'compact this', stream: true })

  await handler(ctx)
  ctx.body.resume()
  await once(ctx.body, 'end')

  assert.deepEqual(calls.usage, ['account-effective'])
  assert.deepEqual(calls.cleared, ['account-effective'])
  assertEffectiveStats(calls, true)
})

test('Responses converts a source close without end into a structured failure', async () => {
  const rawStream = new PassThrough()
  const { handler, calls } = loadResponsesRoute(() => ({
    success: true,
    status: 200,
    stream: rawStream,
    skipTransform: true,
  }))
  const ctx = createContext({ model: 'claude-client-model', input: 'close without end', stream: true })

  await handler(ctx)
  ctx.body.resume()
  const ended = once(ctx.body, 'end')
  rawStream.destroy()
  await ended

  assert.equal(calls.stats.length, 1)
  assert.equal(calls.stats[0][0], false)
  assert.equal(calls.stats[0][3], 'qwen-ai-initial')
  assert.equal(calls.stats[0][4], 'account-initial')
  const failureLog = calls.logs.find(entry => entry.message === 'Responses request failed')
  assert.equal(failureLog?.context.providerId, 'qwen-ai-initial')
  assert.equal(failureLog?.context.accountId, 'account-initial')
})

test('managed Qwen Responses route returns keep-alive output before account validation completes', async () => {
  const upstream = new PassThrough()
  let resolveForward
  const pendingForward = new Promise(resolve => {
    resolveForward = resolve
  })
  const { handler, calls } = loadResponsesRoute(() => pendingForward)
  const ctx = createContext({
    model: 'claude-client-model',
    input: 'use the tool',
    stream: true,
    tools: [{ type: 'function', name: 'lookup', parameters: {} }],
  })

  const invocation = handler(ctx)
  await Promise.race([
    invocation,
    new Promise((_, reject) => setTimeout(
      () => reject(new Error('Responses route waited for managed account validation')),
      200,
    )),
  ])

  assert.equal(calls.forwardContexts.length, 1)
  assert.equal(calls.forwardContexts[0].deferManagedStreamCommit, true)
  assert.ok(ctx.body instanceof PassThrough)

  const output = []
  ctx.body.on('data', chunk => output.push(String(chunk)))
  const ended = once(ctx.body, 'end')
  resolveForward({
    success: true,
    status: 200,
    stream: upstream,
    skipTransform: true,
  })
  await new Promise(resolve => setImmediate(resolve))
  upstream.end('data: [DONE]\n\n')
  await ended

  assert.match(output.join(''), /: keep-alive/)
})

test('Responses deferred Qwen failure cools down and logs the late effective account', async () => {
  const rawStream = new PassThrough()
  const { handler, calls } = loadResponsesRoute(() => {
    setImmediate(() => {
      rawStream.qwenAiEffectiveAccountId = 'account-effective'
      rawStream.qwenAiEffectiveProviderId = 'qwen-ai-effective'
      rawStream.qwenAiEffectiveActualModel = 'qwen-effective-model'
      const error = Object.assign(new Error('Qwen capacity exhausted'), {
        status: 429,
        code: 'qwen_ai_capacity_limit',
        headers: { 'Retry-After': '19' },
        accountFault: true,
      })
      rawStream.qwenAiFailure = error
      rawStream.emit(QWEN_STREAM_FAILURE_EVENT, error)
      rawStream.end('data: [DONE]\n\n')
    })
    return {
      success: true,
      status: 200,
      stream: rawStream,
      skipTransform: true,
      effectiveAccountId: 'account-initial',
      effectiveProviderId: 'qwen-ai-initial',
      effectiveActualModel: 'qwen-initial-model',
    }
  })
  const ctx = createContext({ model: 'claude-client-model', input: 'compact this', stream: true })

  await handler(ctx)
  ctx.body.resume()
  await once(ctx.body, 'end')

  assert.deepEqual(calls.usage, [])
  assert.deepEqual(calls.failed, [])
  assertEffectiveStats(calls, false)
  assert.equal(calls.governorFailures.length, 1)
  assert.equal(calls.governorFailures[0].accountId, 'account-effective')
  assert.equal(calls.governorFailures[0].result.status, 429)
  assert.equal(calls.governorFailures[0].result.errorCode, 'qwen_ai_capacity_limit')
  assert.deepEqual(calls.governorFailures[0].result.headers, { 'Retry-After': '19' })
})

test('Responses gives a 99-account Qwen pool 98 failovers', async () => {
  await withoutQwenFailoverCap(async () => {
    const { handler, calls } = loadResponsesRoute(() => ({
      success: true,
      status: 200,
      body: { choices: [] },
    }), {
      activeAccountCount: 99,
      retryCount: 2,
    })
    const ctx = createContext({ model: 'claude-client-model', input: 'pool limit' })

    await handler(ctx)

    assert.equal(calls.failoverLimitInputs.length, 1)
    assert.deepEqual(calls.failoverLimitInputs[0], {
      configuredMaxFailovers: 2,
      qwenAiProvider: true,
      activeAccountCount: 99,
      qwenAiMaxAccountFailovers: undefined,
    })
    assert.deepEqual(calls.maxFailovers, [98])
  })
})

test('Responses keeps configured retryCount for non-Qwen providers', async () => {
  const { handler, calls } = loadResponsesRoute(() => ({
    success: true,
    status: 200,
    body: { choices: [] },
  }), {
    activeAccountCount: 99,
    qwenAiProvider: false,
    retryCount: 3,
  })
  const ctx = createContext({ model: 'generic-client-model', input: 'configured limit' })

  await handler(ctx)

  assert.equal(calls.failoverLimitInputs.length, 1)
  assert.equal(calls.failoverLimitInputs[0].qwenAiProvider, false)
  assert.equal(calls.failoverLimitInputs[0].activeAccountCount, 0)
  assert.deepEqual(calls.maxFailovers, [3])
})

test('Responses reaches account six after five Qwen 403 and 429 failures', async () => {
  await withoutQwenFailoverCap(async () => {
    const { handler, calls } = loadResponsesRoute(({ attempt }) => {
      if (attempt === 6) {
        return {
          success: true,
          status: 200,
          body: { choices: [] },
        }
      }

      const capacityLimited = attempt % 2 === 0
      return {
        success: false,
        status: capacityLimited ? 429 : 403,
        error: capacityLimited ? 'Qwen capacity exhausted' : 'Qwen risk-control challenge',
        errorCode: capacityLimited ? 'qwen_ai_capacity_limit' : 'qwen_ai_risk_control',
        retryable: false,
        accountFault: true,
        retryScope: 'next-account',
      }
    }, {
      activeAccountCount: 99,
      retryCount: 2,
    })
    const ctx = createContext({ model: 'claude-client-model', input: 'rotate through pool' })

    await handler(ctx)

    assert.deepEqual(calls.maxFailovers, [98])
    assert.deepEqual(calls.attemptedAccountIds, [
      'account-initial',
      'account-pool-2',
      'account-pool-3',
      'account-pool-4',
      'account-pool-5',
      'account-pool-6',
    ])
    assert.equal(calls.forwardContexts.length, 6)
    assert.equal(Number.isFinite(calls.forwardContexts[0].startTime), true)
    assert.deepEqual(
      [...new Set(calls.forwardContexts.map(context => context.startTime))],
      [calls.forwardContexts[0].startTime],
    )
    assert.deepEqual(calls.failed, calls.attemptedAccountIds.slice(0, 5))
    assert.deepEqual(calls.cleared, ['account-pool-6'])
    assert.deepEqual(calls.usage, ['account-pool-6'])
    assert.equal(calls.accountFailovers.length, 5)
    assert.equal(calls.stats.length, 1)
    assert.equal(calls.stats[0][0], true)
    assert.equal(calls.stats[0][4], 'account-pool-6')
  })
})

test('Responses absorbs an account-neutral Qwen file parse timeout by switching accounts', async () => {
  const { handler, calls } = loadResponsesRoute(({ attempt }) => attempt === 1
    ? {
        success: false,
        status: 504,
        error: 'Qwen AI file parse timed out',
        errorCode: 'qwen_ai_file_parse_timeout',
        retryable: false,
        accountFault: false,
        retryScope: 'next-account',
      }
    : {
        success: true,
        status: 200,
        body: { choices: [] },
      }, {
    activeAccountCount: 2,
    retryCount: 0,
  })
  const ctx = createContext({ model: 'claude-client-model', input: 'continue the request' })

  await handler(ctx)

  assert.deepEqual(calls.attemptedAccountIds, ['account-initial', 'account-pool-2'])
  assert.deepEqual(calls.failed, [], 'an unfinished parse must not penalize the account')
  assert.deepEqual(calls.cleared, ['account-pool-2'])
  assert.equal(calls.accountFailovers.length, 1)
  assert.equal(calls.accountFailovers[0].details.errorCode, 'qwen_ai_file_parse_timeout')
  assert.equal(calls.accountFailovers[0].details.accountFault, false)
  assert.equal(ctx.body.model, 'qwen-initial-model')
})
