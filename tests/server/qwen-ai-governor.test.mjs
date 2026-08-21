import assert from 'node:assert/strict'
import { getEventListeners, once } from 'node:events'
import fs from 'node:fs'
import { Readable } from 'node:stream'
import test from 'node:test'
import ts from 'typescript'
import { isQwenAiAccountFault } from '../../src/main/proxy/qwenAiAccountPolicy.ts'

function deferred() {
  let resolve
  let reject
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

function loadGovernorForRuntimeTest(queueTimeoutMs = 1_000, configOverrides = {}, accountPool = {}) {
  const source = fs.readFileSync('src/main/proxy/qwenAiRequestGovernor.ts', 'utf8')
  const output = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
    },
  }).outputText
  const module = { exports: {} }
  const storeManager = {
    getConfig: () => ({
      qwenAiGovernorConfig: {
        autoTuneEnabled: false,
        maxConcurrent: 1,
        globalMinIntervalMs: 0,
        accountMinIntervalMs: 0,
        ...configOverrides,
      },
    }),
    getProviders: () => accountPool.providers || [],
    getAccounts: () => accountPool.accounts || [],
  }
  const calculateQwenAiRequestReadyAt = input => Math.max(
    input.accountActive ? Number.POSITIVE_INFINITY : 0,
    input.recoveryBypassGlobalInterval
      ? input.lastGlobalStartAt
      : input.lastGlobalStartAt + input.globalMinIntervalMs,
    input.recoveryBypassAccountInterval ? 0 : input.accountNextAvailableAt,
    input.accountCooldownUntil,
  )
  const calculateQwenAiAdaptiveLimits = input => ({
    maxConcurrent: input.configuredMaxConcurrent,
    globalMinIntervalMs: input.configuredGlobalMinIntervalMs,
    autoTuneReason: 'manual',
  })
  const parseQwenAiRetryAfterMs = headers => {
    const value = Object.entries(headers || {})
      .find(([key]) => key.toLowerCase() === 'retry-after')?.[1]
    const seconds = Number(value)
    return Number.isFinite(seconds) && seconds >= 0 ? Math.ceil(seconds * 1000) : undefined
  }
  const testRequire = specifier => {
    if (specifier === '../store/store') return { storeManager }
    if (specifier === '../store/types') {
      return { normalizeQwenAiGovernorConfig: config => config }
    }
    if (specifier === './qwenAiGovernorPolicy') {
      return { calculateQwenAiAdaptiveLimits, calculateQwenAiRequestReadyAt, parseQwenAiRetryAfterMs }
    }
    if (specifier === './qwenAiAccountPolicy') return { isQwenAiAccountFault }
    throw new Error(`Unexpected governor test import: ${specifier}`)
  }

  const previousQueueTimeout = process.env.CHAT2API_QWEN_AI_QUEUE_TIMEOUT_MS
  process.env.CHAT2API_QWEN_AI_QUEUE_TIMEOUT_MS = String(queueTimeoutMs)
  try {
    new Function('require', 'module', 'exports', output)(testRequire, module, module.exports)
  } finally {
    if (previousQueueTimeout === undefined) {
      delete process.env.CHAT2API_QWEN_AI_QUEUE_TIMEOUT_MS
    } else {
      process.env.CHAT2API_QWEN_AI_QUEUE_TIMEOUT_MS = previousQueueTimeout
    }
  }

  return module.exports.QwenAiRequestGovernor
}

function loadLoadBalancerForRuntimeTest(storeOverrides = {}) {
  const source = fs.readFileSync('src/main/proxy/loadbalancer.ts', 'utf8')
  const output = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
    },
  }).outputText
  const module = { exports: {} }
  const storeManager = { ...storeOverrides }
  const testRequire = specifier => {
    if (specifier === '../store/store') return { storeManager }
    if (specifier === './adapters/providerModelOptions') {
      return { normalizeProviderModelForMatch: value => value }
    }
    if (specifier === './adapters/qwen-ai-token-refresh') {
      return { hasQwenAiSessionCookie: cookies => /(?:^|;\s*)token=[^;]+/.test(cookies || '') }
    }
    if (specifier === './qwenAiRequestGovernor') {
      return { qwenAiRequestGovernor: { isAccountImmediatelyAvailable: () => true } }
    }
    if (specifier === '../store/types' || specifier === './types') return {}
    throw new Error(`Unexpected load-balancer test import: ${specifier}`)
  }

  new Function('require', 'module', 'exports', output)(testRequire, module, module.exports)
  return module.exports.LoadBalancer
}

test('Qwen AI requests are routed through a per-provider governor', () => {
  const forwarderSource = fs.readFileSync('src/main/proxy/forwarder.ts', 'utf8')
  const governorSource = fs.readFileSync('src/main/proxy/qwenAiRequestGovernor.ts', 'utf8')
  const qwenAiForwarderSource = forwarderSource.slice(
    forwarderSource.indexOf('private async forwardQwenAi'),
    forwarderSource.indexOf('/**\n   * Z.ai Dedicated Forward'),
  )

  assert.match(forwarderSource, /qwenAiRequestGovernor/)
  assert.match(forwarderSource, /qwenAiRequestGovernor\.run\(account\.id/)
  assert.match(forwarderSource, /this\.forwardQwenAi\(request, account, provider, actualModel, startTime, context, \{[\s\S]*requestTimeoutMs: options\.qwenAiRequestTimeoutMs/)
  assert.match(forwarderSource, /signal: context\.signal/)
  assert.match(forwarderSource, /deadlineAt: options\.qwenAiRequestDeadlineAt/)
  assert.match(forwarderSource, /deadlineAt: options\.requestDeadlineAt/)
  assert.match(forwarderSource, /CHAT2API_QWEN_AI_RETRY_COUNT/)
  assert.match(forwarderSource, /QwenAiAdapter\.isQwenAiProvider\(provider\)[\s\S]*qwenAiRetryCountFromEnv\(recoverManagedToolStream\)/)
  assert.match(forwarderSource, /previousRecoveryHint === 'managed_tool_stream_validation'/)
  assert.match(forwarderSource, /defaultManagedToolRecoveryOnly/)
  assert.match(forwarderSource, /result\.recoveryHint !== 'managed_tool_stream_validation'/)
  assert.match(forwarderSource, /recoveryBypassUsed = true/)
  assert.match(forwarderSource, /recoveryBypassAccountInterval: options\.qwenAiRecoveryBypassAccountInterval/)
  assert.match(qwenAiForwarderSource, /const retryable = status === 499[\s\S]*status === 504[\s\S]*\? false/)
  assert.match(forwarderSource, /lastHeaders = result\.headers/)
  assert.match(forwarderSource, /headers: lastHeaders/)
  assert.match(forwarderSource, /lastRetryable = result\.retryable/)
  assert.match(forwarderSource, /retryable: lastRetryable/)
  assert.match(qwenAiForwarderSource, /createQwenAiResumableStream\(response\.data, \{[\s\S]*?resume: \(responseId, recoverySignal\) => adapter\.resumeChatCompletion/)
  assert.match(qwenAiForwarderSource, /recoverySignal \|\| context\?\.signal/)
  assert.match(qwenAiForwarderSource, /handler\.handleStream\(resumableResponseStream, \{[\s\S]*?onFailure: \(\) => cleanupChat\(activeChatId \|\| chatId\),[\s\S]*?recoverFromIdle: \(error, onResume\) => resumableResponseStream\.recoverFromIdle\(error, onResume\),[\s\S]*?recoverFromSemanticEmpty: \(error, onResume\) => resumableResponseStream\.recoverFromIdle\(error, onResume\),[\s\S]*?\}\)/)
  assert.match(qwenAiForwarderSource, /handler\.handleNonStream\(resumableResponseStream, \{[\s\S]*?signal: context\?\.signal,[\s\S]*?recoverFromIdle: \(error, onResume\) => resumableResponseStream\.recoverFromIdle\(error, onResume\),[\s\S]*?recoverFromSemanticEmpty: \(error, onResume\) => resumableResponseStream\.recoverFromIdle\(error, onResume\),[\s\S]*?\}\)/)
  assert.match(qwenAiForwarderSource, /const replayMessages = transformed\.plan\.workflowContinuation[\s\S]*?transformed\.messages\.slice\(0, -1\)[\s\S]*?workflowContinuationMessage/)

  assert.match(governorSource, /CHAT2API_QWEN_AI_MAX_CONCURRENT/)
  assert.match(governorSource, /CHAT2API_QWEN_AI_GLOBAL_MIN_INTERVAL_MS/)
  assert.match(governorSource, /CHAT2API_QWEN_AI_ACCOUNT_MIN_INTERVAL_MS/)
  assert.match(governorSource, /CHAT2API_QWEN_AI_AUTO_TUNE_ENABLED/)
  assert.match(governorSource, /CHAT2API_QWEN_AI_AUTO_TUNE_MAX_CONCURRENT/)
  assert.match(governorSource, /CHAT2API_QWEN_AI_AUTO_TUNE_MIN_GLOBAL_INTERVAL_MS/)
  assert.match(governorSource, /CHAT2API_QWEN_AI_RISK_COOLDOWN_MS/)
  assert.match(governorSource, /CHAT2API_QWEN_AI_GLOBAL_RISK_COOLDOWN_MS/)
  assert.match(governorSource, /CHAT2API_QWEN_AI_GLOBAL_RISK_THRESHOLD/)
  assert.match(governorSource, /maxConcurrent/)
  assert.match(governorSource, /accountNextAvailableAt/)
  assert.match(governorSource, /calculateQwenAiRequestReadyAt/)
  assert.match(governorSource, /recoveryBypassAccountInterval/)
  assert.match(governorSource, /attachRelease\(recordedResult\.stream, releaseStream\)/)
  assert.match(governorSource, /accountActive:/)
  assert.match(governorSource, /nextReadyAt === Number\.POSITIVE_INFINITY/)
  assert.match(governorSource, /parseQwenAiRetryAfterMs/)
  assert.match(governorSource, /http_429_retry_after_/)
  assert.match(governorSource, /createQueueTimeoutResult/)
  assert.match(governorSource, /status: 429/)
  assert.match(governorSource, /'Retry-After'/)
  assert.match(governorSource, /retryable: true/)
})

test('explicit Qwen governor environment settings override persisted values', () => {
  const overrides = {
    CHAT2API_QWEN_AI_AUTO_TUNE_ENABLED: 'true',
    CHAT2API_QWEN_AI_AUTO_TUNE_MAX_CONCURRENT: '20',
    CHAT2API_QWEN_AI_AUTO_TUNE_MIN_GLOBAL_INTERVAL_MS: '1000',
    CHAT2API_QWEN_AI_ACCOUNT_MIN_INTERVAL_MS: '30000',
  }
  const previous = Object.fromEntries(
    Object.keys(overrides).map(key => [key, process.env[key]]),
  )

  Object.assign(process.env, overrides)
  try {
    const Governor = loadGovernorForRuntimeTest(1_000, {
      autoTuneEnabled: false,
      autoTuneMaxConcurrent: 4,
      autoTuneMinGlobalIntervalMs: 8_000,
      accountMinIntervalMs: 120_000,
    })
    const status = new Governor().getStatus([], [])

    assert.equal(status.config.autoTuneEnabled, true)
    assert.equal(status.config.autoTuneMaxConcurrent, 20)
    assert.equal(status.config.autoTuneMinGlobalIntervalMs, 1_000)
    assert.equal(status.config.accountMinIntervalMs, 30_000)
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
})

test('Qwen AI governor removes the queued abort listener and does not cool an account after active abort', async () => {
  const Governor = loadGovernorForRuntimeTest()
  const governor = new Governor()
  const controller = new AbortController()
  const started = deferred()
  const upstream = deferred()

  const resultPromise = governor.run('account-1', () => {
    started.resolve()
    return upstream.promise
  }, { signal: controller.signal })

  await started.promise
  assert.equal(getEventListeners(controller.signal, 'abort').length, 1)

  controller.abort()
  const result = await resultPromise
  assert.equal(result.status, 499)
  assert.match(result.error, /while Qwen AI request was active/)
  assert.doesNotMatch(result.error, /was queued/)
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0)

  upstream.reject(Object.assign(new Error('canceled'), { code: 'ERR_CANCELED' }))
  await new Promise(resolve => setImmediate(resolve))

  const status = governor.getStatus(
    [{ id: 'account-1', name: 'Account 1', providerId: 'qwen-ai', status: 'active' }],
    [{ id: 'qwen-ai', name: 'Qwen AI', apiEndpoint: 'https://chat.qwen.ai' }],
  )
  assert.equal(status.accounts[0].governorCooldownInMs, 0)
  assert.equal(status.accounts[0].governorCooldownReason, undefined)
})

test('Qwen AI governor keeps an active slot occupied until an aborted operation settles', async () => {
  const Governor = loadGovernorForRuntimeTest(2_000, {
    maxConcurrent: 1,
    globalMinIntervalMs: 0,
    accountMinIntervalMs: 0,
  })
  const governor = new Governor()
  const controller = new AbortController()
  const started = deferred()
  const upstream = deferred()
  const first = governor.run('account-1', () => {
    started.resolve()
    return upstream.promise
  }, { signal: controller.signal })

  await started.promise
  controller.abort()
  const cancelled = await first
  assert.equal(cancelled.status, 499)

  let secondStarted = false
  const second = governor.run('account-2', async () => {
    secondStarted = true
    return { success: true, status: 200 }
  })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(secondStarted, false)

  upstream.resolve({ success: true, status: 200 })
  const secondResult = await second
  assert.equal(secondResult.status, 200)
  assert.equal(secondStarted, true)
})

test('Qwen AI governor can delay an active abort result until the operation settles', async () => {
  const Governor = loadGovernorForRuntimeTest()
  const governor = new Governor()
  const controller = new AbortController()
  const started = deferred()
  const upstream = deferred()
  let returned = false

  const pending = governor.run('account-1', () => {
    started.resolve()
    return upstream.promise
  }, {
    signal: controller.signal,
    waitForActiveSettlementOnAbort: true,
  })
  pending.then(() => { returned = true })

  await started.promise
  controller.abort()
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(returned, false)

  upstream.resolve({ success: true, status: 200 })
  const result = await pending
  assert.equal(result.status, 499)
  assert.equal(returned, true)
})

test('Qwen AI governor preserves cancellation when a global circuit opens', async () => {
  const Governor = loadGovernorForRuntimeTest(3_000)
  const governor = new Governor()
  const activeResult = deferred()
  const activeStarted = deferred()
  const activePromise = governor.run('account-1', () => {
    activeStarted.resolve()
    return activeResult.promise
  })
  await activeStarted.promise

  const controller = new AbortController()
  const queuedPromise = governor.run('account-2', async () => ({
    success: true,
    status: 200,
    body: {},
  }), { signal: controller.signal })
  await new Promise(resolve => setImmediate(resolve))

  controller.abort()
  governor.openGlobalCooldown(5_000, 'test_global_circuit', 1)
  const result = await queuedPromise

  assert.equal(result.status, 499)
  assert.match(result.error, /while Qwen AI request was queued/)

  activeResult.resolve({ success: true, status: 200, body: {} })
  await activePromise
})

test('Qwen AI governor returns a runtime 429 after the queue deadline', { timeout: 5_000 }, async () => {
  const Governor = loadGovernorForRuntimeTest(1_000)
  const governor = new Governor()
  const activeStarted = deferred()
  const activeResult = deferred()
  const activePromise = governor.run('account-1', () => {
    activeStarted.resolve()
    return activeResult.promise
  })
  await activeStarted.promise

  const queuedController = new AbortController()
  let queuedRequestStarted = false
  const queuedAt = Date.now()
  const result = await governor.run('account-2', async () => {
    queuedRequestStarted = true
    return { success: true, status: 200 }
  }, { signal: queuedController.signal })
  const waitedMs = Date.now() - queuedAt

  assert.equal(queuedRequestStarted, false)
  assert.equal(result.status, 429)
  assert.equal(result.retryable, true)
  assert.equal(result.errorCode, 'qwen_ai_queue_timeout')
  assert.equal(result.accountFault, false)
  assert.equal(result.retryScope, 'next-account')
  assert.equal(result.headers?.['Retry-After'], '1')
  assert.match(result.error, /waited in queue for more than 1s/)
  assert.ok(waitedMs >= 900, `queue deadline fired too early: ${waitedMs}ms`)
  assert.ok(waitedMs < 3_000, `queue deadline fired too late: ${waitedMs}ms`)
  assert.equal(getEventListeners(queuedController.signal, 'abort').length, 0)

  activeResult.resolve({ success: true, status: 200, body: {} })
  await activePromise
})

test('Qwen AI governor returns 504 when an absolute request deadline expires while pending', { timeout: 5_000 }, async (t) => {
  const Governor = loadGovernorForRuntimeTest(1_000)
  const governor = new Governor()
  const activeStarted = deferred()
  const activeResult = deferred()
  const activePromise = governor.run('account-1', () => {
    activeStarted.resolve()
    return activeResult.promise
  })
  t.after(() => activeResult.resolve({ success: true, status: 200, body: {} }))
  await activeStarted.promise

  const queuedController = new AbortController()
  let queuedRequestStarted = false
  const queuedAt = Date.now()
  const result = await governor.run('account-2', async () => {
    queuedRequestStarted = true
    return { success: true, status: 200, body: {} }
  }, {
    signal: queuedController.signal,
    deadlineAt: queuedAt + 100,
  })
  const waitedMs = Date.now() - queuedAt

  assert.equal(queuedRequestStarted, false)
  assert.equal(result.status, 504)
  assert.equal(result.errorCode, 'qwen_ai_request_timeout')
  assert.equal(result.retryable, false)
  assert.equal(result.accountFault, false)
  assert.equal(result.retryScope, undefined)
  assert.equal(result.headers, undefined)
  assert.match(result.error, /cumulative request deadline/)
  assert.ok(waitedMs >= 50, `request deadline fired too early: ${waitedMs}ms`)
  assert.ok(waitedMs < 750, `request deadline fired too late: ${waitedMs}ms`)
  assert.equal(getEventListeners(queuedController.signal, 'abort').length, 0)

  activeResult.resolve({ success: true, status: 200, body: {} })
  await activePromise
})

test('Qwen AI immediate compaction admission never enters the shared queue', async () => {
  const Governor = loadGovernorForRuntimeTest(1_000, {
    maxConcurrent: 1,
    globalMinIntervalMs: 0,
    accountMinIntervalMs: 0,
  })
  const governor = new Governor()
  const activeStarted = deferred()
  const activeResult = deferred()
  const activePromise = governor.run('normal-1', () => {
    activeStarted.resolve()
    return activeResult.promise
  }, { requestClass: 'normal' })
  await activeStarted.promise

  const startedAt = Date.now()
  const result = await governor.run('compaction-1', async () => ({
    success: true,
    status: 200,
  }), {
    requestClass: 'context_compaction',
    allowQueue: false,
  })

  assert.ok(Date.now() - startedAt < 250)
  assert.equal(result.status, 429)
  assert.equal(result.errorCode, 'qwen_ai_compaction_admission_deferred')
  assert.equal(result.retryable, true)
  assert.equal(result.accountFault, false)
  assert.equal(governor.getStatus([], []).queueSize, 0)

  activeResult.resolve({ success: true, status: 200, body: {} })
  await activePromise
})

test('Qwen AI governor keeps a normal request slot available while compaction is active', async () => {
  const Governor = loadGovernorForRuntimeTest(1_000, {
    maxConcurrent: 3,
    globalMinIntervalMs: 0,
    accountMinIntervalMs: 0,
  })
  const governor = new Governor()
  const compactionReleases = [deferred(), deferred()]
  const compactionStarted = []

  const compactionPromises = compactionReleases.map((release, index) => governor.run(
    `compaction-${index + 1}`,
    async () => {
      compactionStarted.push(index + 1)
      await release.promise
      return { success: true, status: 200 }
    },
    { requestClass: 'context_compaction' },
  ))

  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(compactionStarted.sort(), [1, 2])
  assert.equal(governor.getStatus([], []).compactionActiveRequests, 2)

  let normalStarted = false
  const normal = governor.run('normal-1', async () => {
    normalStarted = true
    return { success: true, status: 200 }
  }, { requestClass: 'normal' })

  const normalResult = await normal
  assert.equal(normalStarted, true)
  assert.equal(normalResult.success, true)

  compactionReleases.forEach(release => release.resolve())
  await Promise.all(compactionPromises)
})

test('Qwen AI governor keeps compaction queue timeouts local to the compaction request', { timeout: 5_000 }, async () => {
  const Governor = loadGovernorForRuntimeTest(1_000, {
    maxConcurrent: 1,
    globalMinIntervalMs: 0,
    accountMinIntervalMs: 0,
  })
  const governor = new Governor()
  const activeStarted = deferred()
  const activeResult = deferred()
  const activePromise = governor.run('normal-1', () => {
    activeStarted.resolve()
    return activeResult.promise
  }, { requestClass: 'normal' })
  await activeStarted.promise

  const result = await governor.run('compaction-1', async () => ({
    success: true,
    status: 200,
  }), { requestClass: 'context_compaction' })

  assert.equal(result.status, 429)
  assert.equal(result.errorCode, 'qwen_ai_queue_timeout')
  assert.equal(result.retryScope, undefined)
  assert.equal(result.accountFault, false)

  activeResult.resolve({ success: true, status: 200 })
  await activePromise
})

test('Qwen AI governor admits a request that becomes ready at the queue deadline', { timeout: 5_000 }, async () => {
  const Governor = loadGovernorForRuntimeTest(1_000)
  const governor = new Governor()
  const realDateNow = Date.now
  const fixedNow = realDateNow()
  let requestStarted = false
  let resultPromise

  Date.now = () => fixedNow
  try {
    governor.accountNextAvailableAt.set('account-1', fixedNow + 1_000)
    resultPromise = governor.run('account-1', async () => {
      requestStarted = true
      return { success: true, status: 200, body: {} }
    })
  } finally {
    Date.now = realDateNow
  }

  const result = await resultPromise
  assert.equal(requestStarted, true)
  assert.equal(result.success, true)
  assert.equal(result.status, 200)
})

test('Qwen AI managed-tool recovery is not blocked by the provider failure cooldown', async () => {
  const Governor = loadGovernorForRuntimeTest(1_000, {
    failureCooldownMs: 5_000,
  })
  const governor = new Governor()

  const first = await governor.run('account-1', async () => ({
    success: false,
    status: 502,
    error: 'local tool stream validation failed',
    recoveryHint: 'managed_tool_stream_validation',
  }))
  assert.equal(first.status, 502)

  let recoveryStarted = false
  const recovery = await governor.run('account-1', async () => {
    recoveryStarted = true
    return { success: true, status: 200, body: {} }
  }, { recoveryBypassAccountInterval: true })

  assert.equal(recoveryStarted, true)
  assert.equal(recovery.success, true)
})

test('Qwen AI account failover may bypass aggregate pacing only when explicitly requested', async () => {
  const Governor = loadGovernorForRuntimeTest(3_000, {
    maxConcurrent: 2,
    globalMinIntervalMs: 250,
    accountMinIntervalMs: 0,
  })
  const governor = new Governor()
  const firstStarted = deferred()
  const releaseFirst = deferred()
  const first = governor.run('account-1', async () => {
    firstStarted.resolve()
    await releaseFirst.promise
    return { success: true, status: 200 }
  })
  await firstStarted.promise

  let ordinaryStarted = false
  const ordinary = governor.run('account-2', async () => {
    ordinaryStarted = true
    return { success: true, status: 200 }
  })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(ordinaryStarted, false)

  let recoveryStarted = false
  const recovery = governor.run('account-3', async () => {
    recoveryStarted = true
    return { success: true, status: 200 }
  }, { recoveryBypassGlobalInterval: true })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(recoveryStarted, true)

  releaseFirst.resolve()
  await Promise.all([first, ordinary, recovery])
})

test('Qwen AI governor logs queue and active timings per request attempt', async () => {
  const Governor = loadGovernorForRuntimeTest()
  const governor = new Governor()
  const messages = []
  const originalConsoleInfo = console.info
  console.info = (...args) => messages.push(args)

  try {
    const result = await governor.run('account-1', async () => ({
      success: true,
      status: 200,
      body: {},
    }), {
      requestId: 'request-1',
      attempt: 2,
    })
    assert.equal(result.success, true)
  } finally {
    console.info = originalConsoleInfo
  }

  const lifecycle = messages
    .filter(args => args[0] === '[QwenAI Governor] lifecycle')
    .map(args => JSON.parse(args[1]))
  const admitted = lifecycle.find(entry => entry.event === 'admitted')
  const released = lifecycle.find(entry => entry.event === 'released')

  assert.equal(admitted.requestId, 'request-1')
  assert.equal(admitted.attempt, 2)
  assert.equal(admitted.queueDepthAtEnqueue, 1)
  assert.ok(admitted.queueWaitMs >= 0)
  assert.equal(released.requestId, 'request-1')
  assert.equal(released.attempt, 2)
  assert.ok(released.activeDurationMs >= 0)
})

test('Qwen AI deferred stream risk failures are reported back to the governor', () => {
  const Governor = loadGovernorForRuntimeTest(1_000, {
    riskCooldownMs: 5_000,
    maxRiskCooldownMs: 5_000,
    globalRiskThreshold: 2,
  })
  const governor = new Governor()

  governor.reportDeferredFailure('account-1', {
    success: false,
    status: 403,
    error: 'FAIL_SYS_USER_VALIDATE RGV587 challenge',
    errorCode: 'qwen_ai_risk_control',
    retryable: false,
    accountFault: true,
  })

  const status = governor.getStatus(
    [{ id: 'account-1', name: 'Account 1', providerId: 'qwen-ai', status: 'active' }],
    [{ id: 'qwen-ai', name: 'Qwen AI', apiEndpoint: 'https://chat.qwen.ai' }],
  )
  assert.ok(status.accounts[0].governorCooldownInMs > 4_000)
  assert.equal(status.accounts[0].governorCooldownReason, 'qwen_ai_risk_control')
})

test('context compaction risk cools accounts without opening the ordinary global circuit', () => {
  const accounts = Array.from({ length: 10 }, (_, index) => ({
    id: `account-${index + 1}`,
    name: `Account ${index + 1}`,
    providerId: 'qwen-ai',
    status: 'active',
  }))
  const providers = [{ id: 'qwen-ai', name: 'Qwen AI', apiEndpoint: 'https://chat.qwen.ai' }]
  const Governor = loadGovernorForRuntimeTest(1_000, {
    riskCooldownMs: 5_000,
    maxRiskCooldownMs: 5_000,
    globalRiskCooldownMs: 20_000,
    maxGlobalRiskCooldownMs: 20_000,
    globalRiskThreshold: 2,
    riskWindowMs: 60_000,
  }, { accounts, providers })
  const governor = new Governor()

  for (const account of accounts) {
    governor.reportDeferredFailure(account.id, {
      success: false,
      status: 403,
      error: 'FAIL_SYS_USER_VALIDATE RGV587 challenge',
      errorCode: 'qwen_ai_risk_control',
      retryable: false,
      accountFault: true,
    }, 'context_compaction')
  }

  const status = governor.getStatus(accounts, providers)
  assert.equal(status.globalCooldownInMs, 0)
  assert.equal(status.recentRiskEvents, 0)
  assert.equal(status.recentRiskAccounts, 0)
  assert.ok(status.accounts.every(account => account.governorCooldownInMs > 4_000))
})

test('Qwen AI governor releases a slot when the returned stream already ended', { timeout: 5_000 }, async () => {
  const Governor = loadGovernorForRuntimeTest()
  const governor = new Governor()
  const endedStream = Readable.from(['complete'])
  endedStream.resume()
  await once(endedStream, 'end')

  const firstResult = await governor.run('account-1', async () => ({
    success: true,
    status: 200,
    stream: endedStream,
  }))
  assert.equal(firstResult.success, true)
  assert.equal(endedStream.readableEnded, true)

  let secondStarted = false
  const secondResult = await governor.run('account-2', async () => {
    secondStarted = true
    return { success: true, status: 200, body: {} }
  })

  assert.equal(secondStarted, true)
  assert.equal(secondResult.success, true)
  assert.equal(secondResult.status, 200)
})

test('Qwen AI governor allows only one in-flight request per account until stream end', { timeout: 5_000 }, async () => {
  const Governor = loadGovernorForRuntimeTest(3_000, {
    maxConcurrent: 2,
    globalMinIntervalMs: 0,
    accountMinIntervalMs: 0,
  })
  const { PassThrough } = await import('node:stream')
  const governor = new Governor()
  const firstStarted = deferred()
  const firstStream = new PassThrough()

  const firstPromise = governor.run('account-1', async () => {
    firstStarted.resolve()
    return { success: true, status: 200, stream: firstStream }
  })
  await firstStarted.promise
  await firstPromise

  let secondStarted = false
  const secondPromise = governor.run('account-1', async () => {
    secondStarted = true
    return { success: true, status: 200 }
  })

  await new Promise(resolve => setImmediate(resolve))
  assert.equal(secondStarted, false)

  firstStream.resume()
  firstStream.end()
  const secondResult = await secondPromise
  assert.equal(secondResult.success, true)
  assert.equal(secondStarted, true)
})

test('Qwen AI governor keeps ordinary 429 responses account-neutral', () => {
  const Governor = loadGovernorForRuntimeTest(3_000, {
    maxConcurrent: 1,
    globalMinIntervalMs: 0,
    accountMinIntervalMs: 0,
  })
  const governor = new Governor()
  return governor.run('account-1', async () => ({
    success: false,
    status: 429,
    headers: { 'Retry-After': '300' },
    error: 'upstream rate limited',
    errorCode: 'qwen_ai_rate_limited',
    accountFault: false,
  })).then(() => {
    const status = governor.getStatus(
      [{ id: 'account-1', name: 'Account 1', providerId: 'qwen-ai', status: 'active' }],
      [{ id: 'qwen-ai', name: 'Qwen AI', apiEndpoint: 'https://chat.qwen.ai' }],
    )
    assert.equal(status.accounts[0].governorCooldownInMs, 0)
    assert.equal(status.accounts[0].governorCooldownReason, undefined)
  })
})

test('Qwen AI governor adds Retry-After only to capacity 429 responses', async () => {
  const Governor = loadGovernorForRuntimeTest(3_000, {
    maxConcurrent: 1,
    globalMinIntervalMs: 0,
    accountMinIntervalMs: 0,
    failureCooldownMs: 45_000,
    maxRiskCooldownMs: 120_000,
  })
  const governor = new Governor()
  const result = await governor.run('account-1', async () => ({
    success: false,
    status: 429,
    error: 'upstream capacity limited',
    errorCode: 'qwen_ai_capacity_limit',
    retryable: false,
    accountFault: true,
    retryScope: 'next-account',
  }))

  assert.equal(result.status, 429)
  assert.equal(result.headers?.['Retry-After'], '45')
  assert.equal(result.retryable, false)
  assert.equal(result.accountFault, true)
  assert.equal(result.retryScope, 'next-account')
})

test('Qwen AI capacity 429s do not open the global risk circuit', async () => {
  const Governor = loadGovernorForRuntimeTest(1_000, {
    maxConcurrent: 1,
    globalMinIntervalMs: 0,
    accountMinIntervalMs: 0,
    failureCooldownMs: 25,
    riskCooldownMs: 25,
    maxRiskCooldownMs: 25,
    globalRiskCooldownMs: 1_000,
    maxGlobalRiskCooldownMs: 1_000,
    riskWindowMs: 1_000,
    globalRiskThreshold: 3,
  })
  const governor = new Governor()
  const accounts = ['account-1', 'account-2', 'account-3', 'account-4'].map(id => ({
    id,
    name: id,
    providerId: 'qwen-ai',
    status: 'active',
  }))
  const providers = [{ id: 'qwen-ai', name: 'Qwen AI', apiEndpoint: 'https://chat.qwen.ai' }]

  for (const account of accounts.slice(0, 3)) {
    const result = await governor.run(account.id, async () => ({
      success: false,
      status: 429,
      error: 'Qwen AI capacity is temporarily exhausted',
      errorCode: 'qwen_ai_capacity_limit',
      retryable: false,
      accountFault: true,
      retryScope: 'next-account',
    }))
    assert.equal(result.errorCode, 'qwen_ai_capacity_limit')
  }

  let fourthRequestStarted = false
  const fourthResult = await governor.run('account-4', async () => {
    fourthRequestStarted = true
    return { success: true, status: 200, body: {} }
  })
  const status = governor.getStatus(accounts, providers)

  assert.equal(fourthRequestStarted, true)
  assert.equal(fourthResult.success, true)
  assert.equal(status.globalCooldownInMs, 0)
  assert.equal(status.recentRiskEvents, 0)
  assert.equal(status.recentRiskAccounts, 0)
})

test('a global risk circuit admits one healthy half-open probe and closes on success', async () => {
  const Governor = loadGovernorForRuntimeTest(1_000, {
    maxConcurrent: 1,
    globalMinIntervalMs: 0,
    accountMinIntervalMs: 0,
    failureCooldownMs: 25,
    riskCooldownMs: 25,
    maxRiskCooldownMs: 25,
    globalRiskCooldownMs: 1_000,
    maxGlobalRiskCooldownMs: 1_000,
    riskWindowMs: 1_000,
    globalRiskThreshold: 3,
  })
  const governor = new Governor()
  const accounts = ['account-1', 'account-2', 'account-3', 'account-4'].map(id => ({
    id,
    name: id,
    providerId: 'qwen-ai',
    status: 'active',
  }))
  const providers = [{ id: 'qwen-ai', name: 'Qwen AI', apiEndpoint: 'https://chat.qwen.ai' }]

  for (const account of accounts.slice(0, 3)) {
    const result = await governor.run(account.id, async () => ({
      success: false,
      status: 403,
      error: 'FAIL_SYS_USER_VALIDATE challenge required',
      errorCode: 'qwen_ai_risk_control',
      retryable: false,
      accountFault: true,
      retryScope: 'next-account',
    }))
    assert.equal(result.errorCode, 'qwen_ai_risk_control')
  }

  let fourthRequestStarted = false
  const fourthResult = await governor.run('account-4', async () => {
    fourthRequestStarted = true
    return { success: true, status: 200, body: {} }
  })
  const status = governor.getStatus(accounts, providers)

  assert.equal(fourthRequestStarted, true)
  assert.equal(fourthResult.success, true)
  assert.equal(status.globalCooldownInMs, 0)
  assert.equal(status.globalRecoveryProbeActive, false)
  assert.equal(status.recentRiskEvents, 3)
  assert.equal(status.recentRiskAccounts, 3)
})

test('a failed half-open probe keeps the exhausted-pool circuit open and blocks the next request', async () => {
  const accounts = ['account-1', 'account-2', 'account-3', 'account-4', 'account-5'].map(id => ({
    id,
    name: id,
    providerId: 'qwen-ai',
    status: 'active',
  }))
  const providers = [{ id: 'qwen-ai', name: 'Qwen AI', apiEndpoint: 'https://chat.qwen.ai' }]
  const Governor = loadGovernorForRuntimeTest(1_000, {
    maxConcurrent: 1,
    globalMinIntervalMs: 0,
    accountMinIntervalMs: 0,
    riskCooldownMs: 25,
    maxRiskCooldownMs: 25,
    globalRiskCooldownMs: 5_000,
    maxGlobalRiskCooldownMs: 5_000,
    riskWindowMs: 5_000,
    globalRiskThreshold: 3,
  }, { accounts, providers })
  const governor = new Governor()
  const risk = {
    success: false,
    status: 403,
    error: 'FAIL_SYS_USER_VALIDATE challenge required',
    errorCode: 'qwen_ai_risk_control',
    retryable: false,
    accountFault: true,
    retryScope: 'next-account',
  }

  for (const account of accounts) {
    const result = await governor.run(account.id, async () => ({ ...risk }))
    assert.equal(result.errorCode, 'qwen_ai_risk_control')
  }

  await new Promise(resolve => setTimeout(resolve, 30))
  let probeStarted = false
  const probeResult = await governor.run('account-1', async () => {
    probeStarted = true
    return { ...risk }
  })
  let nextRequestStarted = false
  const nextResult = await governor.run('account-2', async () => {
    nextRequestStarted = true
    return { success: true, status: 200, body: {} }
  })
  const status = governor.getStatus(accounts, providers)

  assert.equal(probeStarted, true)
  assert.equal(probeResult.errorCode, 'qwen_ai_risk_control')
  assert.equal(nextRequestStarted, false)
  assert.equal(nextResult.status, 429)
  assert.equal(nextResult.errorCode, 'qwen_ai_global_risk_circuit')
  assert.equal(status.globalRecoveryProbeActive, false)
  assert.ok(status.globalRecoveryNextInMs > 0)
  assert.ok(status.globalCooldownInMs > 0)
})

test('a large Qwen account pool keeps healthy accounts available after isolated risks', async () => {
  const accounts = Array.from({ length: 99 }, (_, index) => ({
    id: `account-${index + 1}`,
    name: `Account ${index + 1}`,
    providerId: 'qwen-ai',
    status: 'active',
  }))
  const Governor = loadGovernorForRuntimeTest(1_000, {
    maxConcurrent: 1,
    globalMinIntervalMs: 0,
    accountMinIntervalMs: 0,
    riskCooldownMs: 25,
    maxRiskCooldownMs: 25,
    globalRiskCooldownMs: 1_000,
    maxGlobalRiskCooldownMs: 1_000,
    riskWindowMs: 1_000,
    globalRiskThreshold: 3,
  }, {
    accounts,
    providers: [{ id: 'qwen-ai', name: 'Qwen AI', apiEndpoint: 'https://chat.qwen.ai' }],
  })
  const governor = new Governor()

  for (const accountId of ['account-1', 'account-2', 'account-3']) {
    await governor.run(accountId, async () => ({
      success: false,
      status: 403,
      error: 'FAIL_SYS_USER_VALIDATE challenge required',
      errorCode: 'qwen_ai_risk_control',
      retryable: false,
      accountFault: true,
      retryScope: 'next-account',
    }))
  }

  let fourthRequestStarted = false
  const fourthResult = await governor.run('account-4', async () => {
    fourthRequestStarted = true
    return { success: true, status: 200, body: {} }
  })
  const status = governor.getStatus(accounts, [{
    id: 'qwen-ai',
    name: 'Qwen AI',
    apiEndpoint: 'https://chat.qwen.ai',
  }])

  assert.equal(fourthRequestStarted, true)
  assert.equal(fourthResult.success, true)
  assert.equal(status.globalCooldownInMs, 0)
  assert.equal(status.recentRiskAccounts, 3)
  assert.equal(status.effectiveConfig.healthyAccountCount, 96)
})

test('a large Qwen pool stays open for healthy accounts after risk reaches ten percent', async () => {
  const accounts = Array.from({ length: 99 }, (_, index) => ({
    id: `account-${index + 1}`,
    name: `Account ${index + 1}`,
    providerId: 'qwen-ai',
    status: 'active',
  }))
  const providers = [{ id: 'qwen-ai', name: 'Qwen AI', apiEndpoint: 'https://chat.qwen.ai' }]
  const Governor = loadGovernorForRuntimeTest(1_000, {
    maxConcurrent: 1,
    globalMinIntervalMs: 0,
    accountMinIntervalMs: 0,
    riskCooldownMs: 25,
    maxRiskCooldownMs: 25,
    globalRiskCooldownMs: 5_000,
    maxGlobalRiskCooldownMs: 5_000,
    riskWindowMs: 5_000,
    globalRiskThreshold: 3,
  }, { accounts, providers })
  const governor = new Governor()

  for (const account of accounts.slice(0, 10)) {
    await governor.run(account.id, async () => ({
      success: false,
      status: 403,
      error: 'FAIL_SYS_USER_VALIDATE challenge required',
      errorCode: 'qwen_ai_risk_control',
      retryable: false,
      accountFault: true,
      retryScope: 'next-account',
    }))
  }

  const beforeHealthyRequest = governor.getStatus(accounts, providers)
  assert.equal(beforeHealthyRequest.globalCooldownInMs, 0)

  let healthyRequestStarted = false
  const healthyResult = await governor.run('account-11', async () => {
    healthyRequestStarted = true
    return { success: true, status: 200, body: {} }
  })
  const status = governor.getStatus(accounts, providers)

  assert.equal(healthyRequestStarted, true)
  assert.equal(healthyResult.success, true)
  assert.equal(status.globalCooldownInMs, 0)
  assert.equal(status.recentRiskAccounts, 10)
  assert.equal(status.effectiveConfig.healthyAccountCount, 89)
})

test('Qwen AI global risk circuit is account-neutral and never requests account failover', async () => {
  const Governor = loadGovernorForRuntimeTest()
  const governor = new Governor()
  governor.openGlobalCooldown(5_000, 'test_global_circuit', 1)
  let started = false

  const result = await governor.run('account-1', async () => {
    started = true
    return { success: true, status: 200 }
  })

  assert.equal(started, false)
  assert.equal(result.status, 429)
  assert.equal(result.errorCode, 'qwen_ai_global_risk_circuit')
  assert.equal(result.retryable, false)
  assert.equal(result.accountFault, false)
  assert.equal(result.retryScope, undefined)
})

test('Qwen AI governor does not cool an account for an account-neutral protocol failure', async () => {
  const Governor = loadGovernorForRuntimeTest(3_000, {
    maxConcurrent: 1,
    globalMinIntervalMs: 0,
    accountMinIntervalMs: 0,
    failureCooldownMs: 45_000,
  })
  const governor = new Governor()

  await governor.run('account-1', async () => ({
    success: false,
    status: 502,
    error: 'Provider returned an unsupported response protocol',
    errorCode: 'synthetic_protocol_error',
    retryable: false,
    accountFault: false,
  }))

  const status = governor.getStatus(
    [{ id: 'account-1', name: 'Account 1', providerId: 'qwen-ai', status: 'active' }],
    [{ id: 'qwen-ai', name: 'Qwen AI', apiEndpoint: 'https://chat.qwen.ai' }],
  )
  assert.equal(status.accounts[0].governorCooldownInMs, 0)
  assert.equal(status.accounts[0].governorCooldownReason, undefined)
})

test('Qwen AI governor does not cool an account when an account-neutral request rejects', async () => {
  const Governor = loadGovernorForRuntimeTest(3_000, {
    maxConcurrent: 1,
    globalMinIntervalMs: 0,
    accountMinIntervalMs: 0,
    failureCooldownMs: 45_000,
  })
  const governor = new Governor()
  const error = Object.assign(new Error('local protocol rejection'), { accountFault: false })

  await assert.rejects(
    governor.run('account-1', async () => {
      throw error
    }),
    rejected => rejected === error,
  )

  const status = governor.getStatus(
    [{ id: 'account-1', name: 'Account 1', providerId: 'qwen-ai', status: 'active' }],
    [{ id: 'qwen-ai', name: 'Qwen AI', apiEndpoint: 'https://chat.qwen.ai' }],
  )
  assert.equal(status.accounts[0].governorCooldownInMs, 0)
  assert.equal(status.accounts[0].governorCooldownReason, undefined)
})

test('Qwen AI account-neutral failures bypass load-balancer penalties on immediate and deferred paths', () => {
  const proxyTypes = fs.readFileSync('src/main/proxy/types.ts', 'utf8')
  const forwarderSource = fs.readFileSync('src/main/proxy/forwarder.ts', 'utf8')
  const chatRouteSource = fs.readFileSync('src/main/proxy/routes/chat.ts', 'utf8')

  assert.match(proxyTypes, /accountFault\?: boolean/)
  assert.match(forwarderSource, /qwenAiAccountFailureDetails\(/)
  assert.match(forwarderSource, /inferredErrorAccountFault/)
  assert.match(forwarderSource, /accountFault: clientCancelled \|\| sessionStateFailure \|\| continuationRejected/)
  assert.match(forwarderSource, /: inferredErrorAccountFault/)
  assert.match(chatRouteSource, /result\.accountFault !== false/)
  assert.match(chatRouteSource, /isQwenAiAccountFault/)
  assert.match(chatRouteSource, /const failureAccountFault = streamFailureAccountFault\(error, failureStatus\)/)
})

test('Qwen AI risk-control failures cool the account and require distinct accounts before global circuit', () => {
  const chatRouteSource = fs.readFileSync('src/main/proxy/routes/chat.ts', 'utf8')
  const loadBalancerSource = fs.readFileSync('src/main/proxy/loadbalancer.ts', 'utf8')
  const governorSource = fs.readFileSync('src/main/proxy/qwenAiRequestGovernor.ts', 'utf8')

  assert.match(chatRouteSource, /isQwenAiRiskControl/)
  assert.match(chatRouteSource, /FAIL_SYS_USER_VALIDATE\|RGV587/)
  assert.match(chatRouteSource, /loadBalancer\.markQwenAiRiskControl\(account\.id\)/)

  assert.match(loadBalancerSource, /markAccountCooldown/)
  assert.match(loadBalancerSource, /markQwenAiRiskControl/)
  assert.match(loadBalancerSource, /QWEN_AI_RISK_COOLDOWN/)
  assert.match(loadBalancerSource, /cooldownUntil/)
  assert.match(loadBalancerSource, /isAccountInHardCooldown/)
  assert.match(loadBalancerSource, /filter\(account => !this\.isAccountInHardCooldown\(account\.id\)\)/)
  assert.match(loadBalancerSource, /qwenAiRequestGovernor\.isAccountImmediatelyAvailable\(candidate\.account\.id\)/)

  assert.match(governorSource, /qwen_ai_risk_control/)
  assert.match(governorSource, /2 \*\* \(failures - 1\)/)
  assert.match(governorSource, /recordGlobalRiskControl/)
  assert.match(governorSource, /recordGlobalRiskControl\(accountId, config,/)
  assert.match(governorSource, /new Set\(this\.riskEvents\.map\(event => event\.accountId\)\)\.size/)
  assert.match(governorSource, /qwen_ai_global_risk_circuit/)
  assert.match(governorSource, /createGlobalCircuitOpenResult/)
  assert.match(governorSource, /reportDeferredFailure/)
  assert.match(governorSource, /Retry-After/)
  assert.match(chatRouteSource, /ctx\.set\(key, value\)/)
  assert.match(chatRouteSource, /qwenAiRequestGovernor\.reportDeferredFailure\(completionAccount\.id/)
})

test('Qwen AI governor exposes configurable global risk circuit settings', () => {
  const sharedTypes = fs.readFileSync('src/shared/types.ts', 'utf8')
  const storeTypes = fs.readFileSync('src/main/store/types.ts', 'utf8')
  const configSource = fs.readFileSync('src/main/store/config.ts', 'utf8')
  const panelSource = fs.readFileSync('src/renderer/src/components/proxy/QwenAiGovernorPanel.tsx', 'utf8')
  const zh = fs.readFileSync('src/renderer/src/i18n/locales/zh-CN.json', 'utf8')

  for (const source of [sharedTypes, storeTypes, panelSource]) {
    assert.match(source, /globalRiskCooldownMs/)
    assert.match(source, /maxGlobalRiskCooldownMs/)
    assert.match(source, /riskWindowMs/)
    assert.match(source, /globalRiskThreshold/)
  }

  assert.match(sharedTypes, /globalCooldownInMs/)
  assert.match(sharedTypes, /recentRiskEvents/)
  assert.match(sharedTypes, /recentRiskAccounts/)
  assert.match(storeTypes, /globalMinIntervalMs:\s*15000/)
  assert.match(storeTypes, /accountMinIntervalMs:\s*120000/)
  assert.match(storeTypes, /globalRiskCooldownMs:\s*30 \* 60 \* 1000/)
  assert.match(storeTypes, /globalRiskThreshold:\s*3/)
  assert.match(configSource, /maxGlobalRiskCooldownMs must be greater than or equal to globalRiskCooldownMs/)
  assert.match(zh, /全局风控熔断/)
})

test('Qwen AI governor auto-tunes effective rate limits from healthy accounts and risk events', () => {
  const sharedTypes = fs.readFileSync('src/shared/types.ts', 'utf8')
  const storeTypes = fs.readFileSync('src/main/store/types.ts', 'utf8')
  const configSource = fs.readFileSync('src/main/store/config.ts', 'utf8')
  const governorSource = fs.readFileSync('src/main/proxy/qwenAiRequestGovernor.ts', 'utf8')
  const panelSource = fs.readFileSync('src/renderer/src/components/proxy/QwenAiGovernorPanel.tsx', 'utf8')
  const en = fs.readFileSync('src/renderer/src/i18n/locales/en-US.json', 'utf8')

  for (const source of [sharedTypes, storeTypes]) {
    assert.match(source, /autoTuneEnabled/)
    assert.match(source, /autoTuneMaxConcurrent/)
    assert.match(source, /autoTuneMinGlobalIntervalMs/)
  }

  assert.match(sharedTypes, /QwenAiGovernorEffectiveConfig/)
  assert.match(sharedTypes, /effectiveConfig: QwenAiGovernorEffectiveConfig/)
  assert.match(storeTypes, /autoTuneEnabled:\s*true/)
  assert.match(storeTypes, /autoTuneMaxConcurrent:\s*(?:MAX_QWEN_AI_CONCURRENCY|100)/)
  assert.match(storeTypes, /autoTuneMinGlobalIntervalMs:\s*(?:1000|8000)/)
  assert.match(configSource, /qwenAiGovernorConfig\.autoTuneEnabled must be a boolean/)
  assert.match(governorSource, /calculateEffectiveConfig/)
  assert.match(governorSource, /calculateQwenAiAdaptiveLimits/)
  assert.match(governorSource, /accountCount: options\.accountCount/)
  assert.match(governorSource, /healthyAccountCount: options\.healthyAccountCount/)
  assert.match(governorSource, /recentRiskEvents: options\.recentRiskEvents/)
  assert.match(governorSource, /recentRiskAccountCount: options\.recentRiskAccounts/)
  assert.match(governorSource, /effectiveConfig/)
  assert.match(panelSource, /qwen-auto-tune/)
  assert.match(panelSource, /status\?\.effectiveConfig\.maxConcurrent/)
  assert.match(panelSource, /autoTuneMaxConcurrent/)
  assert.match(en, /Auto tuning/)
})

test('Qwen AI cancellation and timeout paths are not retried or logged as success', () => {
  const forwarderSource = fs.readFileSync('src/main/proxy/forwarder.ts', 'utf8')
  const governorSource = fs.readFileSync('src/main/proxy/qwenAiRequestGovernor.ts', 'utf8')
  const qwenAiSource = fs.readFileSync('src/main/proxy/adapters/qwen-ai.ts', 'utf8')
  const proxyTypes = fs.readFileSync('src/main/proxy/types.ts', 'utf8')

  assert.match(proxyTypes, /retryable\?: boolean/)
  assert.match(forwarderSource, /context\.signal\?\.aborted/)
  assert.match(forwarderSource, /isClientCancellationError\(error\)/)
  const errorsSource = fs.readFileSync('src/main/proxy/utils/errors.ts', 'utf8')
  assert.match(errorsSource, /name === 'CanceledError'/)
  assert.match(errorsSource, /code === 'ERR_CANCELED'/)
  assert.match(forwarderSource, /timed out\|timeout\|idle for more than/)
  assert.match(governorSource, /destroyForwardStream/)
  assert.match(governorSource, /candidate\.destroy\(\)/)
  assert.doesNotMatch(governorSource, /candidate\.destroy\(new Error/)
  assert.match(governorSource, /item\.cancelled \|\| item\.signal\?\.aborted/)
  assert.match(governorSource, /Client disconnected while Qwen AI request was active/)
  assert.match(qwenAiSource, /options\.signal\?\.aborted/)
  assert.match(qwenAiSource, /Qwen AI response stream aborted before reading started/)
  assert.match(qwenAiSource, /QWEN_AI_STREAM_FAILURE_EVENT/)
  assert.match(qwenAiSource, /transStream\.qwenAiFailure = error/)
  assert.match(qwenAiSource, /const onUpstreamError = \(err: Error\) => \{\s*if \(finalChunkSent \|\| semanticRecoveryInFlight \|\| transientRecoveryInFlight\) \{\s*return/)
  assert.match(qwenAiSource, /stream\.once\('error', onUpstreamError\)[\s\S]*if \(options\.signal\?\.aborted\)/)
  assert.match(forwarderSource, /retryable = status === 499[\s\S]*status === 403[\s\S]*status === 429[\s\S]*status === 504[\s\S]*\? false/)

  const chatRouteSource = fs.readFileSync('src/main/proxy/routes/chat.ts', 'utf8')
  assert.match(chatRouteSource, /deferStreamOutcome/)
  assert.match(chatRouteSource, /QWEN_AI_STREAM_FAILURE_EVENT/)
  assert.match(chatRouteSource, /streamFailureStatus/)
  assert.match(chatRouteSource, /recordDeferredStreamOutcome\(!qwenAiFailure, qwenAiFailure\)/)
  assert.match(chatRouteSource, /ctx\.res\.once\('close',[\s\S]*!ctx\.res\.writableEnded/)
  assert.match(governorSource, /queueAbortListener/)
  assert.match(governorSource, /removeEventListener\('abort', item\.queueAbortListener\)/)
  assert.match(governorSource, /settledByAbort \|\| item\.signal\?\.aborted \|\| item\.cancelled/)
  assert.match(governorSource, /item\.cancelled = true\s*\n\s*this\.clearQueueItemWaiters\(item\)/)

  const geminiRouteSource = fs.readFileSync('src/main/proxy/routes/gemini.ts', 'utf8')
  assert.match(geminiRouteSource, /ctx\.res\.once\('close',[\s\S]*!ctx\.res\.writableEnded/)
})

test('Qwen AI load balancing prefers a complete web session over an incomplete imported session', () => {
  const provider = {
    id: 'qwen-ai',
    name: 'Qwen AI',
    apiEndpoint: 'https://chat.qwen.ai',
    enabled: true,
  }
  const incomplete = {
    id: 'account-incomplete',
    name: 'Incomplete',
    providerId: provider.id,
    status: 'active',
    credentials: {
      token: 'jwt-value',
      cookies: 'cnaui=auxiliary; x-ap=value',
    },
  }
  const complete = {
    id: 'account-complete',
    name: 'Complete',
    providerId: provider.id,
    status: 'active',
    credentials: {
      token: 'jwt-value',
      cookies: 'cnaui=auxiliary; token=session-value; x-ap=value',
    },
  }
  const LoadBalancer = loadLoadBalancerForRuntimeTest({
    getProviders: () => [provider],
    getAccountsByProviderId: () => [incomplete, complete],
    getEffectiveModels: () => [],
    getConfig: () => ({ modelMappings: {} }),
  })
  const loadBalancer = new LoadBalancer()

  const selected = loadBalancer.selectAccount('Qwen3.8-Max-Preview')

  assert.equal(selected.account.id, complete.id)
})

test('Qwen AI load balancing can still repair an incomplete session when no ready session exists', () => {
  const provider = {
    id: 'qwen-ai',
    name: 'Qwen AI',
    apiEndpoint: 'https://chat.qwen.ai',
    enabled: true,
  }
  const incomplete = {
    id: 'account-incomplete',
    name: 'Incomplete',
    providerId: provider.id,
    status: 'active',
    credentials: {
      token: 'jwt-value',
      cookies: 'cnaui=auxiliary; x-ap=value',
    },
  }
  const LoadBalancer = loadLoadBalancerForRuntimeTest({
    getProviders: () => [provider],
    getAccountsByProviderId: () => [incomplete],
    getEffectiveModels: () => [],
    getConfig: () => ({ modelMappings: {} }),
  })
  const loadBalancer = new LoadBalancer()

  const selected = loadBalancer.selectAccount('Qwen3.8-Max-Preview')

  assert.equal(selected.account.id, incomplete.id)
})

test('Qwen AI load balancing excludes an account persisted as inactive after signin rejection', () => {
  const provider = {
    id: 'qwen-ai',
    name: 'Qwen AI',
    apiEndpoint: 'https://chat.qwen.ai',
    enabled: true,
  }
  const inactive = {
    id: 'account-unregistered',
    name: 'Unregistered',
    providerId: provider.id,
    status: 'inactive',
    credentials: { token: 'stale-jwt', cookies: 'cnaui=auxiliary' },
  }
  const healthy = {
    id: 'account-healthy',
    name: 'Healthy',
    providerId: provider.id,
    status: 'active',
    credentials: { token: 'jwt-value', cookies: 'token=session-value' },
  }
  const LoadBalancer = loadLoadBalancerForRuntimeTest({
    getProviders: () => [provider],
    getAccountsByProviderId: () => [inactive, healthy],
    getEffectiveModels: () => [],
    getConfig: () => ({ modelMappings: {} }),
  })

  const selected = new LoadBalancer().selectAccount('Qwen3.8-Max-Preview')

  assert.equal(selected.account.id, healthy.id)
})

test('Qwen AI complete-session failover never falls through to an incomplete session', () => {
  const provider = {
    id: 'qwen-ai',
    name: 'Qwen AI',
    apiEndpoint: 'https://chat.qwen.ai',
    enabled: true,
  }
  const accounts = [
    {
      id: 'account-complete-1',
      name: 'Complete 1',
      providerId: provider.id,
      status: 'active',
      credentials: { token: 'jwt-value', cookies: 'token=session-1; x-ap=value' },
    },
    {
      id: 'account-complete-2',
      name: 'Complete 2',
      providerId: provider.id,
      status: 'active',
      credentials: { token: 'jwt-value', cookies: 'token=session-2; x-ap=value' },
    },
    {
      id: 'account-incomplete',
      name: 'Incomplete',
      providerId: provider.id,
      status: 'active',
      credentials: { token: 'jwt-value', cookies: 'cnaui=auxiliary; x-ap=value' },
    },
  ]
  const LoadBalancer = loadLoadBalancerForRuntimeTest({
    getProviders: () => [provider],
    getAccountsByProviderId: () => accounts,
    getEffectiveModels: () => [],
    getConfig: () => ({ modelMappings: {} }),
  })
  const loadBalancer = new LoadBalancer()
  const constraints = { qwenAiWebSessionTier: 'complete' }

  const secondReady = loadBalancer.selectAccount(
    'Qwen3.8-Max-Preview',
    'fill-first',
    provider.id,
    undefined,
    new Set(['account-complete-1']),
    constraints,
  )
  const exhausted = loadBalancer.selectAccount(
    'Qwen3.8-Max-Preview',
    'fill-first',
    provider.id,
    undefined,
    new Set(['account-complete-1', 'account-complete-2']),
    constraints,
  )

  assert.equal(secondReady.account.id, 'account-complete-2')
  assert.equal(exhausted, null)
})

test('Qwen AI production logs avoid dumping full prompts by default', () => {
  const qwenAiSource = fs.readFileSync('src/main/proxy/adapters/qwen-ai.ts', 'utf8')

  assert.match(qwenAiSource, /CHAT2API_QWEN_AI_DEBUG_PAYLOADS/)
  assert.match(qwenAiSource, /CHAT2API_QWEN_AI_DEBUG_STREAM/)
  assert.match(qwenAiSource, /summarizePayloadForLog/)
  assert.match(qwenAiSource, /Request payload summary/)
  assert.match(qwenAiSource, /contentChars/)
  assert.match(qwenAiSource, /fileCount/)
  assert.match(qwenAiSource, /if \(QWEN_AI_DEBUG_PAYLOAD_LOGS\)/)
  assert.match(qwenAiSource, /if \(QWEN_AI_DEBUG_STREAM_LOGS\)/)
})

test('Qwen AI governor exposes soft load-balancer recovery separately from hard availability', () => {
  const LoadBalancer = loadLoadBalancerForRuntimeTest()
  const loadBalancer = new LoadBalancer()
  const beforeFailure = Date.now()
  loadBalancer.markAccountFailed('account-1')
  const failures = loadBalancer.getAccountFailureSnapshot()

  assert.equal(failures['account-1'].count, 1)
  assert.equal(failures['account-1'].reason, 'request_failure')
  assert.ok(failures['account-1'].recoveryUntil >= beforeFailure + 60_000)
  assert.equal(failures['account-1'].cooldownUntil, undefined)

  const Governor = loadGovernorForRuntimeTest()
  const governor = new Governor()
  const status = governor.getStatus(
    [{ id: 'account-1', name: 'Account 1', providerId: 'qwen-ai', status: 'active' }],
    [{ id: 'qwen-ai', name: 'Qwen AI', apiEndpoint: 'https://chat.qwen.ai' }],
    failures,
  )
  const account = status.accounts[0]

  assert.equal(account.nextAvailableInMs, 0)
  assert.equal(account.loadBalancerCooldownInMs, 0)
  assert.ok(account.loadBalancerRecoveryInMs > 59_000)
  assert.equal(account.loadBalancerFailures, 1)
  assert.equal(account.loadBalancerReason, 'request_failure')
})

test('Qwen AI governor exposes the latest structured failover for each account', () => {
  const Governor = loadGovernorForRuntimeTest()
  const governor = new Governor()
  const record = {
    requestId: 'request-1',
    status: 502,
    errorCode: 'upstream_error',
    attempt: 2,
    accountFault: false,
    timestamp: 1_700_000_000_000,
  }
  governor.reportAccountFailover('account-1', record)

  const status = governor.getStatus(
    [{ id: 'account-1', name: 'Account 1', providerId: 'qwen-ai', status: 'active' }],
    [{ id: 'qwen-ai', name: 'Qwen AI', apiEndpoint: 'https://chat.qwen.ai' }],
  )

  assert.deepEqual(status.accounts[0].recentFailover, record)

  const panelSource = fs.readFileSync('src/renderer/src/components/proxy/QwenAiGovernorPanel.tsx', 'utf8')
  assert.match(panelSource, /loadBalancerRecoveryInMs/)
  assert.match(panelSource, /loadBalancerFailures > 0/)
  assert.match(panelSource, /recentFailover/)
})
