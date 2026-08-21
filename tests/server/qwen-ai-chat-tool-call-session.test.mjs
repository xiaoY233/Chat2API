import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import { PassThrough } from 'node:stream'
import test from 'node:test'
import ts from 'typescript'
import {
  isQwenAiAccountFault,
  qwenAiAccountRetryScope,
} from '../../src/main/proxy/qwenAiAccountPolicy.ts'

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
    if (Object.prototype.hasOwnProperty.call(localModules, specifier)) {
      return localModules[specifier]
    }
    if (specifier.startsWith('.')) {
      throw new Error(`Unexpected Chat tool-call test import: ${specifier}`)
    }
    return runtimeRequire(specifier)
  }
  new Function('require', 'module', 'exports', output)(testRequire, module, module.exports)
  return module.exports
}

const sessionBridge = loadTypeScriptModule('src/main/proxy/qwenAiSessionBridge.ts')
const workflowHeuristics = loadTypeScriptModule('src/main/proxy/toolCalling/workflowHeuristics.ts')
const toolCallSessionStoreModule = loadTypeScriptModule(
  'src/main/proxy/qwenAiToolCallSessionStore.ts',
  { './toolCalling/workflowHeuristics': workflowHeuristics },
)
const accountFailover = loadTypeScriptModule('src/main/proxy/accountFailover.ts')

const tools = [{
  type: 'function',
  function: {
    name: 'read_file',
    parameters: {
      type: 'object',
      properties: { path: { type: 'string' } },
      required: ['path'],
    },
  },
}]

function firstTurnRequest() {
  return {
    model: 'Qwen3.8-Max_Auto',
    messages: [
      { role: 'system', content: 'Follow the repository instructions.' },
      { role: 'user', content: 'Read package.json.' },
    ],
    tools,
    tool_choice: 'auto',
    reasoning_effort: 'xhigh',
    stream: false,
  }
}

function toolResultTurnRequest() {
  return {
    ...firstTurnRequest(),
    messages: [
      { role: 'system', content: 'Follow the repository instructions.' },
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
      {
        role: 'tool',
        tool_call_id: 'call_read',
        content: '{"name":"chat2api"}',
      },
    ],
  }
}

function loadChatRouteHarness(options = {}) {
  const source = fs.readFileSync('src/main/proxy/routes/chat.ts', 'utf8')
  const output = ts.transpileModule(source, {
    compilerOptions: {
      esModuleInterop: true,
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
    },
  }).outputText
  let routeHandler
  const provider = {
    id: 'qwen-ai',
    name: 'Qwen AI',
    apiEndpoint: 'https://chat.qwen.ai',
  }
  const accountA = {
    id: 'account-a',
    providerId: provider.id,
    name: 'Account A',
    status: 'active',
  }
  const accountB = {
    id: 'account-b',
    providerId: provider.id,
    name: 'Account B',
    status: 'active',
  }
  const selectionA = { account: accountA, provider, actualModel: 'qwen3.8-max' }
  const selectionB = { account: accountB, provider, actualModel: 'qwen3.8-max' }
  const accounts = new Map([
    [accountA.id, accountA],
    [accountB.id, accountB],
  ])
  const toolCallSessions = new toolCallSessionStoreModule.QwenAiToolCallSessionStore({
    ttlMs: 60_000,
    maxEntries: 32,
  })
  const calls = {
    forwards: [],
    accountFailures: [],
    requestLogs: [],
  }

  class MockRouter {
    post(_path, handler) {
      routeHandler = handler
      return this
    }
  }

  const makeSuccess = ({ request, account, provider: forwardedProvider, actualModel, context }) => ({
    success: true,
    status: 200,
    body: { choices: [] },
    qwenAiToolCallIds: request.messages.some(message => message.role === 'tool')
      ? []
      : ['call_read'],
    qwenAiSessionState: {
      providerId: forwardedProvider.id,
      accountId: account.id,
      requestedModel: request.model,
      actualModel,
      requestFingerprint: context.qwenAiSessionBridge?.requestFingerprint || 'missing',
      getChatId: () => account.id === accountA.id ? 'qwen-chat-a' : 'qwen-chat-b',
      getParentId: () => account.id === accountA.id ? 'qwen-parent-a' : 'qwen-parent-b',
    },
  })

  const storeManager = {
    getConfig: () => ({
      retryCount: 0,
      loadBalanceStrategy: 'round-robin',
      qwenAiSessionMode: options.sessionMode,
    }),
    getAccountsByProviderId: () => [accountA, accountB],
    getAccountById: accountId => accounts.get(accountId),
    getProviderById: providerId => providerId === provider.id ? provider : undefined,
    addLog: () => {},
    addRequestLog: entry => {
      const stored = { id: `request-log-${calls.requestLogs.length + 1}`, ...entry }
      calls.requestLogs.push(stored)
      return stored
    },
    updateRequestLog: () => true,
    incrementAccountUsage: () => {},
    recordRequestInStats: () => {},
  }

  const localModules = {
    'node:stream': { PassThrough },
    '@koa/router': MockRouter,
    '../types': {},
    '../loadbalancer': {
      loadBalancer: {
        selectAccount: (...args) => {
          const excludedAccountIds = args[4]
          return excludedAccountIds?.has(accountA.id) ? selectionB : selectionA
        },
        hasCompleteQwenAiWebSession: () => false,
        clearAccountFailure: () => {},
        markAccountFailed: accountId => calls.accountFailures.push(accountId),
        markQwenAiRiskControl: accountId => calls.accountFailures.push(accountId),
      },
    },
    '../forwarder': {
      shouldDeferQwenAiManagedStreamCommit: () => false,
      requestForwarder: {
        forwardChatCompletion: async (request, account, forwardedProvider, actualModel, context) => {
          const forwarded = { request, account, provider: forwardedProvider, actualModel, context }
          calls.forwards.push(forwarded)
          return options.forwardResult
            ? options.forwardResult(forwarded, makeSuccess)
            : makeSuccess(forwarded)
        },
      },
    },
    '../accountFailover': {
      forwardWithAccountFailover: accountFailover.forwardWithAccountFailover,
      resolveAccountFailoverLimit: accountFailover.resolveAccountFailoverLimit,
    },
    '../qwenAiDeferredStream': {
      createDeferredQwenAiFailoverStream: () => new PassThrough(),
    },
    '../qwenAiRequestGovernor': {
      qwenAiRequestGovernor: {
        reportAccountFailover: () => {},
        reportDeferredFailure: () => {},
      },
    },
    '../adapters/kimi': { KimiAdapter: { isKimiProvider: () => false } },
    '../adapters/qwen-ai': {
      QwenAiAdapter: { isQwenAiProvider: candidate => candidate?.apiEndpoint === provider.apiEndpoint },
      QWEN_AI_STREAM_FAILURE_EVENT: 'qwen-ai-stream-failure',
    },
    '../stream': { streamHandler: { createTransformStream: () => new PassThrough() } },
    '../status': {
      proxyStatusManager: {
        recordRequestStart: () => {},
        recordRequestSuccess: () => {},
        recordRequestFailure: () => {},
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
    '../utils/sseKeepAlive': { SseKeepAliveStream: PassThrough },
    '../requestIntent': {
      classifyChatRequest: () => ({
        intent: 'normal',
        reason: 'test',
        signals: [],
        messageCount: 1,
        toolCount: 1,
        toolResultCount: 0,
        textChars: 1,
        lastUserTextChars: 1,
        lastUserTextPrefix: 'R',
      }),
    },
    '../toolCalling/assistantOutputBoundary': {
      createAssistantOutputBoundaryStream: () => new PassThrough(),
    },
    '../qwenAiSessionBridge': sessionBridge,
    '../qwenAiToolCallSessionStore': {
      getTrailingQwenAiToolResultBatch: toolCallSessionStoreModule.getTrailingQwenAiToolResultBatch,
      qwenAiToolCallSessionStore: toolCallSessions,
    },
    '../qwenAiAccountPolicy': { isQwenAiAccountFault, qwenAiAccountRetryScope },
  }
  const module = { exports: {} }
  const testRequire = specifier => {
    if (Object.prototype.hasOwnProperty.call(localModules, specifier)) return localModules[specifier]
    throw new Error(`Unexpected Chat tool-call test import: ${specifier}`)
  }
  new Function('require', 'module', 'exports', output)(testRequire, module, module.exports)
  assert.equal(typeof routeHandler, 'function')
  return { handler: routeHandler, calls, accountA, accountB, toolCallSessions }
}

async function invokeChatRoute(handler, body) {
  const req = new EventEmitter()
  const res = new EventEmitter()
  res.writableEnded = false
  const responseHeaders = {}
  const ctx = {
    headers: {},
    ip: '127.0.0.1',
    req,
    res,
    request: { body },
    responseHeaders,
    set: (name, value) => { responseHeaders[name] = value },
  }
  await handler(ctx)
  return ctx
}

test('Chat route registers a Qwen tool call and pins a full-history tool result to its chat', async () => {
  const { handler, calls, accountA, toolCallSessions } = loadChatRouteHarness()

  await invokeChatRoute(handler, firstTurnRequest())

  const stored = toolCallSessions.resolve(['call_read'])
  assert.deepEqual(stored, {
    providerId: 'qwen-ai',
    accountId: accountA.id,
    requestedModel: 'Qwen3.8-Max_Auto',
    actualModel: 'qwen3.8-max',
    chatId: 'qwen-chat-a',
    parentId: 'qwen-parent-a',
    requestFingerprint: calls.forwards[0].context.qwenAiSessionBridge.requestFingerprint,
  })

  await invokeChatRoute(handler, toolResultTurnRequest())

  assert.equal(calls.forwards.length, 2)
  const continuation = calls.forwards[1]
  assert.equal(continuation.account.id, accountA.id)
  assert.equal(continuation.context.qwenAiSessionBridge.continuation.binding.chatId, 'qwen-chat-a')
  assert.equal(continuation.context.qwenAiSessionBridge.continuation.binding.parentId, 'qwen-parent-a')
  assert.deepEqual(continuation.context.qwenAiSessionBridge.continuation.inputMessages, [{
    role: 'tool',
    tool_call_id: 'call_read',
    content: '{"name":"chat2api"}',
  }])
  assert.deepEqual(
    continuation.request.messages.map(message => message.role),
    ['system', 'user', 'assistant', 'tool'],
    'the complete transcript remains available for a fallback replay',
  )
  assert.equal(toolCallSessions.resolve(['call_read']), undefined)
})

test('Chat route legacy mode replays full history without creating a tool-call binding', async () => {
  const { handler, calls, toolCallSessions } = loadChatRouteHarness({ sessionMode: 'legacy' })

  await invokeChatRoute(handler, firstTurnRequest())
  await invokeChatRoute(handler, toolResultTurnRequest())

  assert.equal(calls.forwards.length, 2)
  assert.equal(calls.forwards[0].context.qwenAiSessionBridge, undefined)
  assert.equal(calls.forwards[1].context.qwenAiSessionBridge, undefined)
  assert.deepEqual(
    calls.forwards[1].request.messages.map(message => message.role),
    ['system', 'user', 'assistant', 'tool'],
  )
  assert.equal(toolCallSessions.resolve(['call_read']), undefined)
})

test('Chat route replays full history on account B after account A fails and clears the old tool call', async () => {
  const { handler, calls, accountA, accountB, toolCallSessions } = loadChatRouteHarness({
    forwardResult: (forwarded, makeSuccess) => {
      const hasToolResult = forwarded.request.messages.some(message => message.role === 'tool')
      if (!hasToolResult) return makeSuccess(forwarded)
      if (forwarded.account.id === accountA.id) {
        return {
          success: false,
          status: 429,
          error: 'Qwen account quota is exhausted',
          errorCode: 'qwen_ai_capacity_limit',
          accountFault: true,
          retryScope: 'next-account',
        }
      }
      return makeSuccess(forwarded)
    },
  })

  await invokeChatRoute(handler, firstTurnRequest())
  assert.ok(toolCallSessions.resolve(['call_read']))

  await invokeChatRoute(handler, toolResultTurnRequest())

  assert.equal(calls.forwards.length, 3)
  assert.equal(calls.forwards[1].account.id, accountA.id)
  assert.equal(calls.forwards[1].context.qwenAiSessionBridge.continuation.binding.chatId, 'qwen-chat-a')
  assert.equal(calls.forwards[2].account.id, accountB.id)
  assert.equal(calls.forwards[2].context.qwenAiSessionBridge.continuation, undefined)
  assert.deepEqual(
    calls.forwards[2].request.messages.map(message => message.role),
    ['system', 'user', 'assistant', 'tool'],
  )
  assert.ok(calls.accountFailures.includes(accountA.id))
  assert.equal(toolCallSessions.resolve(['call_read']), undefined)
})

test('Chat route keeps a Qwen tool-call binding during CHAT_IN_PROGRESS without failing over', async () => {
  let continuationAttempts = 0
  const { handler, calls, accountA, toolCallSessions } = loadChatRouteHarness({
    forwardResult: (forwarded, makeSuccess) => {
      const hasToolResult = forwarded.request.messages.some(message => message.role === 'tool')
      if (!hasToolResult) return makeSuccess(forwarded)
      continuationAttempts += 1
      if (continuationAttempts > 1) return makeSuccess(forwarded)
      return {
        success: false,
        status: 429,
        error: 'Qwen chat is still in progress',
        errorCode: 'CHAT_IN_PROGRESS',
        retryable: true,
        accountFault: false,
      }
    },
  })

  await invokeChatRoute(handler, firstTurnRequest())
  const beforeRetry = toolCallSessions.resolve(['call_read'])
  assert.ok(beforeRetry)

  const ctx = await invokeChatRoute(handler, toolResultTurnRequest())

  assert.equal(ctx.status, 429)
  assert.equal(ctx.body.error.code, 'CHAT_IN_PROGRESS')
  assert.equal(calls.forwards.length, 2)
  assert.equal(calls.forwards[1].account.id, accountA.id)
  assert.equal(calls.forwards[1].context.qwenAiSessionBridge.continuation.binding.chatId, 'qwen-chat-a')
  assert.deepEqual(calls.accountFailures, [])
  assert.deepEqual(toolCallSessions.resolve(['call_read']), beforeRetry)

  await invokeChatRoute(handler, toolResultTurnRequest())
  assert.equal(calls.forwards.length, 3)
  assert.equal(calls.forwards[2].context.qwenAiSessionBridge.continuation.binding.chatId, 'qwen-chat-a')
  assert.equal(toolCallSessions.resolve(['call_read']), undefined)
})

test('Chat route rejects a concurrent duplicate continuation before it reaches the forwarder', async () => {
  let completeContinuation
  const { handler, calls, toolCallSessions } = loadChatRouteHarness({
    forwardResult: (forwarded, makeSuccess) => {
      const hasToolResult = forwarded.request.messages.some(message => message.role === 'tool')
      if (!hasToolResult) return makeSuccess(forwarded)
      return new Promise(resolve => {
        completeContinuation = () => resolve(makeSuccess(forwarded))
      })
    },
  })

  await invokeChatRoute(handler, firstTurnRequest())
  const firstContinuation = invokeChatRoute(handler, toolResultTurnRequest())
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(calls.forwards.length, 2)

  const duplicate = await invokeChatRoute(handler, toolResultTurnRequest())
  assert.equal(duplicate.status, 429)
  assert.equal(duplicate.body.error.code, 'CHAT_IN_PROGRESS')
  assert.ok(Number(duplicate.responseHeaders['Retry-After']) >= 1)
  assert.equal(calls.forwards.length, 2, 'the duplicate must not enter the forwarder')
  assert.deepEqual(calls.accountFailures, [])

  completeContinuation()
  await firstContinuation
  assert.equal(toolCallSessions.resolve(['call_read']), undefined)
})
