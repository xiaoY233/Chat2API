import assert from 'node:assert/strict'
import { EventEmitter, once } from 'node:events'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import { PassThrough, Transform } from 'node:stream'
import test from 'node:test'
import ts from 'typescript'

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
      throw new Error(`Unexpected session bridge test import: ${specifier}`)
    }
    return runtimeRequire(specifier)
  }
  new Function('require', 'module', 'exports', output)(testRequire, module, module.exports)
  return module.exports
}

const sessionBridge = loadTypeScriptModule('src/main/proxy/qwenAiSessionBridge.ts')
const qwenAiAccountPolicy = loadTypeScriptModule('src/main/proxy/qwenAiAccountPolicy.ts')
const storeModule = loadTypeScriptModule('src/main/proxy/responses/store.ts', {
  '../qwenAiSessionBridge': sessionBridge,
})
const accountFailover = loadTypeScriptModule('src/main/proxy/accountFailover.ts')
const workflowHeuristics = loadTypeScriptModule('src/main/proxy/toolCalling/workflowHeuristics.ts')
const toolCallSessionStoreModule = loadTypeScriptModule(
  'src/main/proxy/qwenAiToolCallSessionStore.ts',
  { './toolCalling/workflowHeuristics': workflowHeuristics },
)

function request(overrides = {}) {
  return {
    model: 'Qwen3.8-Max_Auto',
    messages: [
      { role: 'system', content: 'Follow the repository instructions.' },
      { role: 'user', content: 'Inspect the project.' },
    ],
    tools: [{
      type: 'function',
      function: {
        name: 'read_file',
        description: 'Read a file.',
        parameters: {
          type: 'object',
          properties: { path: { type: 'string' } },
          required: ['path'],
        },
      },
    }],
    tool_choice: 'auto',
    parallel_tool_calls: false,
    reasoning_effort: 'xhigh',
    enable_thinking: true,
    thinking_budget: 8192,
    ...overrides,
  }
}

test('Qwen Responses session fingerprint retains the established contract but ignores normal turn data', () => {
  const baseline = sessionBridge.createQwenAiSessionRequestFingerprint(request())
  const followUp = sessionBridge.createQwenAiSessionRequestFingerprint(request({
    messages: [
      { role: 'system', content: 'Follow the repository instructions.' },
      { role: 'assistant', content: null, tool_calls: [{
        id: 'call_1',
        type: 'function',
        function: { name: 'read_file', arguments: '{"path":"package.json"}' },
      }] },
      { role: 'tool', tool_call_id: 'call_1', content: '{"name":"chat2api"}' },
    ],
  }))

  assert.equal(followUp, baseline, 'tool result deltas must continue the established Qwen chat')
  assert.notEqual(
    sessionBridge.createQwenAiSessionRequestFingerprint(request({
      messages: [{ role: 'system', content: 'Different instructions.' }],
    })),
    baseline,
    'a changed system prompt requires a fresh full replay',
  )
  assert.notEqual(
    sessionBridge.createQwenAiSessionRequestFingerprint(request({
      tools: [{
        type: 'function',
        function: { name: 'write_file', parameters: { type: 'object' } },
      }],
    })),
    baseline,
    'a changed tool catalog requires a fresh full replay',
  )
  assert.notEqual(
    sessionBridge.createQwenAiSessionRequestFingerprint(request({ reasoning_effort: 'high' })),
    baseline,
    'thinking settings are part of the pinned Qwen chat contract',
  )
})

test('Qwen Responses binding is resolved only after real chat and parent ids are available', () => {
  const state = {
    providerId: 'qwen-ai',
    accountId: 'account-pinned',
    requestedModel: 'Qwen3.8-Max_Auto',
    actualModel: 'qwen3.8-max',
    requestFingerprint: 'fingerprint',
    toolProtocol: 'managed-tools-v1',
    getChatId: () => ' chat-real ',
    getParentId: () => ' response-real ',
  }

  assert.deepEqual(sessionBridge.resolveQwenAiSessionBinding(state), {
    providerId: 'qwen-ai',
    accountId: 'account-pinned',
    requestedModel: 'Qwen3.8-Max_Auto',
    actualModel: 'qwen3.8-max',
    chatId: 'chat-real',
    parentId: 'response-real',
    requestFingerprint: 'fingerprint',
    toolProtocol: 'managed-tools-v1',
  })
  assert.equal(sessionBridge.resolveQwenAiSessionBinding({
    ...state,
    getParentId: () => ' ',
  }), undefined)
})

test('Responses conversation storage preserves, clones, and clears a Qwen session binding', () => {
  const { ResponsesConversationStore } = storeModule
  const store = new ResponsesConversationStore({ maxEntries: 4, maxTotalBytes: 4096, maxEntryBytes: 2048 })
  const messages = [{ role: 'user', content: 'first turn' }]
  const binding = {
    providerId: 'qwen-ai',
    accountId: 'account-pinned',
    requestedModel: 'Qwen3.8-Max_Auto',
    actualModel: 'qwen3.8-max',
    chatId: 'chat-real',
    parentId: 'response-real',
    requestFingerprint: 'fingerprint',
  }

  assert.equal(store.set('resp_first', messages, binding), true)
  messages[0].content = 'caller mutation'
  binding.parentId = 'caller mutation'

  const firstRead = store.getConversation('resp_first')
  assert.equal(firstRead.messages[0].content, 'first turn')
  assert.deepEqual(firstRead.qwenAiSessionBinding, {
    providerId: 'qwen-ai',
    accountId: 'account-pinned',
    requestedModel: 'Qwen3.8-Max_Auto',
    actualModel: 'qwen3.8-max',
    chatId: 'chat-real',
    parentId: 'response-real',
    requestFingerprint: 'fingerprint',
  })

  firstRead.messages[0].content = 'read mutation'
  firstRead.qwenAiSessionBinding.parentId = 'read mutation'
  assert.equal(store.getConversation('resp_first').messages[0].content, 'first turn')
  assert.equal(store.getConversation('resp_first').qwenAiSessionBinding.parentId, 'response-real')

  const beforeClear = store.stats().totalBytes
  store.clearQwenAiSessionBinding('resp_first')
  const cleared = store.getConversation('resp_first')
  assert.equal(cleared.messages[0].content, 'first turn')
  assert.equal(cleared.qwenAiSessionBinding, undefined)
  assert.ok(store.stats().totalBytes < beforeClear)
})

function toolCallBinding(parentId = 'parent-1') {
  return {
    providerId: 'qwen-ai',
    accountId: 'account-pinned',
    requestedModel: 'Qwen3.8-Max_Auto',
    actualModel: 'qwen3.8-max',
    chatId: 'chat-1',
    parentId,
    requestFingerprint: 'fingerprint',
  }
}

test('Qwen tool-call store claims complete batches atomically and consumes the whole batch', () => {
  const { QwenAiToolCallSessionStore } = toolCallSessionStoreModule
  const store = new QwenAiToolCallSessionStore({ ttlMs: 1_000, leaseMs: 100, maxEntries: 8 })
  const binding = toolCallBinding()

  assert.equal(store.set(['call_a', 'call_b'], binding), true)
  assert.deepEqual(store.claim(['call_a']), { status: 'missing' })

  const first = store.claim(['call_b', 'call_a'])
  assert.equal(first.status, 'claimed')
  assert.deepEqual(first.binding, binding)
  const concurrent = store.claim(['call_a', 'call_b'])
  assert.equal(concurrent.status, 'busy')
  assert.ok(concurrent.retryAfterMs > 0)

  assert.equal(store.release(first.claim), true)
  const retry = store.claim(['call_a', 'call_b'])
  assert.equal(retry.status, 'claimed')
  assert.equal(store.consume(retry.claim), true)
  assert.equal(store.resolve(['call_a', 'call_b']), undefined)
  assert.deepEqual(store.stats(), { entries: 0 })
})

test('Qwen tool-call store rejects stale claims after a reused ID creates a new generation', () => {
  const { QwenAiToolCallSessionStore } = toolCallSessionStoreModule
  const store = new QwenAiToolCallSessionStore({ ttlMs: 1_000, leaseMs: 100, maxEntries: 8 })
  const oldBinding = toolCallBinding('parent-old')
  const newBinding = toolCallBinding('parent-new')

  assert.equal(store.set(['call_a'], oldBinding), true)
  const oldClaim = store.claim(['call_a'])
  assert.equal(oldClaim.status, 'claimed')
  assert.equal(store.set(['call_a'], newBinding), true)

  assert.equal(store.consume(oldClaim.claim), false)
  assert.equal(store.release(oldClaim.claim), false)
  assert.deepEqual(store.resolve(['call_a']), newBinding)
})

test('Qwen tool-call store reclaims expired leases without letting the old owner delete the batch', () => {
  const { QwenAiToolCallSessionStore } = toolCallSessionStoreModule
  let now = 10_000
  const store = new QwenAiToolCallSessionStore({
    ttlMs: 1_000,
    leaseMs: 50,
    maxEntries: 8,
    now: () => now,
  })

  assert.equal(store.set(['call_a'], toolCallBinding()), true)
  const expired = store.claim(['call_a'])
  assert.equal(expired.status, 'claimed')
  now += 50
  const reclaimed = store.claim(['call_a'])
  assert.equal(reclaimed.status, 'claimed')
  assert.equal(store.consume(expired.claim), false)
  assert.equal(store.release(expired.claim), false)
  assert.equal(store.release(reclaimed.claim), true)
  assert.ok(store.resolve(['call_a']))
})

test('Qwen tool-call store removes an entire old batch when one ID is reused', () => {
  const { QwenAiToolCallSessionStore } = toolCallSessionStoreModule
  const store = new QwenAiToolCallSessionStore({ ttlMs: 1_000, leaseMs: 100, maxEntries: 8 })

  assert.equal(store.set(['call_a', 'call_b'], toolCallBinding('parent-old')), true)
  assert.equal(store.set(['call_b', 'call_c'], toolCallBinding('parent-new')), true)
  assert.equal(store.resolve(['call_a', 'call_b']), undefined)
  assert.equal(store.resolve(['call_a']), undefined)
  assert.deepEqual(store.resolve(['call_b', 'call_c']), toolCallBinding('parent-new'))

  store.delete(['call_b'])
  assert.equal(store.resolve(['call_b', 'call_c']), undefined)
})

function loadResponsesRouteHarness(options = {}) {
  const source = fs.readFileSync('src/main/proxy/routes/responses.ts', 'utf8')
  const output = ts.transpileModule(source, {
    compilerOptions: {
      esModuleInterop: true,
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
    },
  }).outputText
  const provider = {
    id: 'qwen-ai',
    name: 'Qwen AI',
    apiEndpoint: 'https://chat.qwen.ai',
  }
  const account = {
    id: 'account-pinned',
    name: 'Pinned account',
    providerId: provider.id,
    status: 'active',
  }
  const secondaryAccount = {
    id: 'account-replay',
    name: 'Replay account',
    providerId: provider.id,
    status: 'active',
  }
  const selection = { account, provider, actualModel: 'qwen3.8-max' }
  const secondarySelection = {
    account: secondaryAccount,
    provider,
    actualModel: 'qwen3.8-max',
  }
  const accounts = new Map([
    [account.id, account],
    [secondaryAccount.id, secondaryAccount],
  ])
  const conversations = new Map()
  const toolCallSessions = new toolCallSessionStoreModule.QwenAiToolCallSessionStore({
    ttlMs: 60_000,
    maxEntries: 32,
  })
  const calls = {
    forwards: [],
    selections: [],
    stores: [],
    clears: [],
    accountFailures: [],
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
    constructor(streamOptions) {
      super()
      this.streamOptions = streamOptions
      this.failed = false
    }

    _transform(chunk, encoding, callback) {
      callback(null, chunk)
    }

    _flush(callback) {
      if (!this.failed) {
        const response = {
          output: options.streamOutput || [],
          status: options.streamTerminalStatus || 'completed',
        }
        if (response.status === 'completed') this.streamOptions.onComplete(response)
        else this.streamOptions.onIncomplete(response)
      }
      callback()
    }

    fail(error) {
      if (this.failed) return
      this.failed = true
      this.streamOptions.onFailure(error)
    }
  }

  class MockCompatibilityError extends Error {}
  class MockImageResolutionError extends Error {}
  const localModules = {
    '@koa/router': MockRouter,
    '../forwarder': {
      shouldDeferQwenAiManagedStreamCommit: () => false,
      requestForwarder: {
        forwardChatCompletion: async (chatRequest, forwardedAccount, forwardedProvider, actualModel, context) => {
          calls.forwards.push({ chatRequest, account: forwardedAccount, provider: forwardedProvider, actualModel, context })
          if (typeof options.forwardResult === 'function') {
            return options.forwardResult({
              chatRequest,
              account: forwardedAccount,
              provider: forwardedProvider,
              actualModel,
              context,
            })
          }
          return {
            success: true,
            status: 200,
            body: { choices: [] },
            qwenAiToolCallIds: chatRequest.messages.some(message => message.role === 'tool')
              ? []
              : ['call_read'],
            qwenAiSessionState: {
              providerId: forwardedProvider.id,
              accountId: forwardedAccount.id,
              requestedModel: chatRequest.model,
              actualModel,
              requestFingerprint: context.qwenAiSessionBridge?.requestFingerprint || 'missing',
              getChatId: () => context.qwenAiSessionBridge?.continuation?.binding.chatId
                || 'qwen-chat-real',
              getParentId: () => 'qwen-parent-real',
            },
          }
        },
      },
    },
    '../loadbalancer': {
      loadBalancer: {
        selectAccount: (...args) => {
          calls.selections.push(args)
          const excludedAccountIds = args[4]
          if (options.includeSecondaryAccount && excludedAccountIds?.has(account.id)) {
            return secondarySelection
          }
          return selection
        },
        hasCompleteQwenAiWebSession: () => false,
        clearAccountFailure: () => {},
        markAccountFailed: accountId => calls.accountFailures.push(accountId),
      },
    },
    '../accountFailover': {
      forwardWithAccountFailover: accountFailover.forwardWithAccountFailover,
      resolveAccountFailoverLimit: accountFailover.resolveAccountFailoverLimit,
    },
    '../qwenAiDeferredStream': {
      createDeferredQwenAiFailoverStream: () => {
        throw new Error('The non-stream bridge harness must not create a deferred stream')
      },
    },
    '../qwenAiRequestGovernor': {
      qwenAiRequestGovernor: {
        reportAccountFailover: () => {},
        reportDeferredFailure: () => {},
      },
    },
    '../adapters/qwen-ai': {
      QWEN_AI_STREAM_FAILURE_EVENT: 'qwen-ai-stream-failure',
      isQwenAiStaleSessionError: value => Boolean(
        value && (
          value.code === 'qwen_ai_session_stale'
          || value.errorCode === 'qwen_ai_session_stale'
          || value.status === 404
          || value.status === 409
          || ((value.status === 400 || value.status === 422)
            && /^(chat|conversation|parent|response|session)[_-]?id$/i.test(String(value.param || '')))
          || /chat(?:id)?[^\n]*not[ _-]?found|parent[^\n]*not[ _-]?found/i.test(String(value.message || value.error || ''))
        )
      ),
      QwenAiAdapter: {
        isQwenAiProvider: candidate => candidate?.apiEndpoint === 'https://chat.qwen.ai',
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
    '../stream': { streamHandler: { createTransformStream: () => new PassThrough() } },
    '../../store/store': {
      storeManager: {
        getConfig: () => ({
          loadBalanceStrategy: 'round-robin',
          retryCount: options.retryCount ?? 0,
          qwenAiSessionMode: options.sessionMode,
        }),
        getAccountsByProviderId: () => options.includeSecondaryAccount
          ? [account, secondaryAccount]
          : [account],
        getAccountById: accountId => accounts.get(accountId),
        getProviderById: providerId => providerId === provider.id ? provider : undefined,
        incrementAccountUsage: () => {},
        recordRequestInStats: () => {},
        addLog: () => {},
      },
    },
    '../utils/errors': {
      isClientCancellationError: () => false,
      sanitizeForwardedErrorHeaders: headers => headers,
    },
    '../utils/sseKeepAlive': { SseKeepAliveStream: class SseKeepAliveStream extends PassThrough {} },
    '../responses/compat': {
      ResponsesCompatibilityError: MockCompatibilityError,
      responsesRequestToChatCompletion: (incoming, previous = []) => {
        const incomingMessages = Array.isArray(incoming.input)
          ? incoming.input.flatMap(item => {
              if (item.type === 'message') {
                return [{
                  role: item.role === 'assistant' ? 'assistant' : item.role === 'system'
                    || item.role === 'developer' ? 'system' : 'user',
                  content: typeof item.content === 'string'
                    ? item.content
                    : Array.isArray(item.content)
                      ? item.content
                        .map(part => typeof part?.text === 'string' ? part.text : '')
                        .join('')
                      : '',
                }]
              }
              if (item.type === 'function_call' || item.type === 'custom_tool_call') {
                return [{
                  role: 'assistant',
                  content: null,
                  tool_calls: [{
                    id: item.call_id || item.id,
                    type: 'function',
                    function: {
                      name: item.name,
                      arguments: typeof item.arguments === 'string'
                        ? item.arguments
                        : JSON.stringify(item.arguments ?? {}),
                    },
                  }],
                }]
              }
              if (
                item.type !== 'function_call_output'
                && item.type !== 'custom_tool_call_output'
              ) {
                return []
              }
              const hasAttachment = Array.isArray(item.output)
              const toolMessage = {
                role: 'tool',
                tool_call_id: item.call_id,
                content: hasAttachment
                  ? 'Tool output attachment follows.'
                  : typeof item.output === 'string' ? item.output : JSON.stringify(item.output),
              }
              if (!hasAttachment) return [toolMessage]
              return [
                toolMessage,
                {
                  role: 'user',
                  content: [
                    { type: 'text', text: 'Tool output attachment follows.' },
                    ...item.output.map(attachment => ({
                      type: 'image_url',
                      image_url: { url: attachment.image_url },
                    })),
                  ],
                },
              ]
            })
          : [{ role: 'user', content: String(incoming.input || '') }]
        const conversationMessages = [...previous, ...incomingMessages]
        return {
          chatRequest: {
            model: incoming.model,
            messages: conversationMessages,
            stream: incoming.stream === true,
            tools: incoming.tools,
            tool_choice: incoming.tool_choice,
            reasoning_effort: incoming.reasoning?.effort,
          },
          conversationMessages,
        }
      },
      chatCompletionToResponse: async (_completion, incoming, options) => ({
        id: options.id,
        model: options.model,
        status: 'completed',
        output: Array.isArray(incoming.input)
          ? []
          : [{
              type: 'function_call',
              call_id: 'call_read',
              name: 'read_file',
              arguments: '{"path":"package.json"}',
            }],
      }),
      responseOutputToChatMessages: output => output.map(item => ({
        role: 'assistant',
        content: null,
        tool_calls: [{
          id: item.call_id,
          type: 'function',
          function: { name: item.name, arguments: item.arguments },
        }],
      })),
    },
    '../responses/store': {
      responsesConversationStore: {
        getConversation: responseId => conversations.get(responseId),
        set: (responseId, messages, binding) => {
          const stored = { messages: structuredClone(messages), qwenAiSessionBinding: binding && { ...binding } }
          conversations.set(responseId, stored)
          calls.stores.push({ responseId, ...stored })
          return true
        },
        clearQwenAiSessionBinding: responseId => {
          calls.clears.push(responseId)
          const stored = conversations.get(responseId)
          if (stored) delete stored.qwenAiSessionBinding
        },
      },
    },
    '../responses/stream': {
      createResponsesStreamTransform: streamOptions => ({ start: () => new MockResponsesStream(streamOptions) }),
    },
    '../requestIntent': {
      classifyChatRequest: () => ({
        intent: 'normal',
        reason: 'test',
        signals: [],
        messageCount: 0,
        toolCount: 1,
        toolResultCount: 0,
        textChars: 0,
      }),
    },
    '../qwenAiSessionBridge': sessionBridge,
    '../qwenAiToolCallSessionStore': {
      getTrailingQwenAiToolResultBatch: toolCallSessionStoreModule.getTrailingQwenAiToolResultBatch,
      qwenAiToolCallSessionStore: toolCallSessions,
    },
    '../qwenAiAccountPolicy': qwenAiAccountPolicy,
    '../toolCalling/workflowHeuristics': workflowHeuristics,
    '../responses/image': {
      ResponseImageResolutionError: MockImageResolutionError,
      createResponseImageResolver: () => async value => value,
    },
  }
  const testRequire = specifier => {
    if (Object.prototype.hasOwnProperty.call(localModules, specifier)) return localModules[specifier]
    if (specifier.startsWith('.')) throw new Error(`Unexpected Responses bridge route import: ${specifier}`)
    return runtimeRequire(specifier)
  }
  const module = { exports: {} }
  new Function('require', 'module', 'exports', output)(testRequire, module, module.exports)
  const router = module.exports.default
  const handler = router.stack.find(layer => layer.path === '/responses')?.handler
  assert.equal(typeof handler, 'function')
  return {
    handler,
    calls,
    conversations,
    provider,
    account,
    secondaryAccount,
    toolCallSessions,
  }
}

function createRouteContext(body) {
  const req = new EventEmitter()
  const res = new EventEmitter()
  res.writableEnded = false
  const responseHeaders = {}
  return {
    request: { body },
    headers: {},
    req,
    res,
    ip: '127.0.0.1',
    responseHeaders,
    set: (name, value) => { responseHeaders[name] = value },
  }
}

test('Responses route saves a real Qwen binding then pins continuation to the same account with only tool-result delta', async () => {
  const { handler, calls, conversations, provider, account } = loadResponsesRouteHarness()
  const tools = [{
    type: 'function',
    function: { name: 'read_file', parameters: { type: 'object' } },
  }]

  const firstContext = createRouteContext({
    model: 'Qwen3.8-Max_Auto',
    input: 'Read package.json.',
    tools,
    tool_choice: 'auto',
    reasoning: { effort: 'xhigh' },
  })
  await handler(firstContext)

  assert.equal(calls.forwards.length, 1)
  assert.equal(calls.forwards[0].context.qwenAiSessionBridge.continuation, undefined)
  assert.equal(calls.stores.length, 1)
  const firstStored = calls.stores[0]
  assert.deepEqual(firstStored.qwenAiSessionBinding, {
    providerId: provider.id,
    accountId: account.id,
    requestedModel: 'Qwen3.8-Max_Auto',
    actualModel: 'qwen3.8-max',
    chatId: 'qwen-chat-real',
    parentId: 'qwen-parent-real',
    requestFingerprint: calls.forwards[0].context.qwenAiSessionBridge.requestFingerprint,
  })

  const continuationContext = createRouteContext({
    model: 'Qwen3.8-Max_Auto',
    previous_response_id: firstStored.responseId,
    input: [{
      type: 'function_call_output',
      call_id: 'call_read',
      output: '{"name":"chat2api"}',
    }],
    tools,
    tool_choice: 'auto',
    reasoning: { effort: 'xhigh' },
  })
  await handler(continuationContext)

  assert.equal(calls.forwards.length, 2)
  const continuation = calls.forwards[1]
  assert.equal(continuation.account.id, account.id)
  assert.equal(continuation.provider.id, provider.id)
  assert.equal(continuation.actualModel, 'qwen3.8-max')
  assert.equal(continuation.context.qwenAiSessionBridge.continuation.binding.chatId, 'qwen-chat-real')
  assert.equal(continuation.context.qwenAiSessionBridge.continuation.binding.parentId, 'qwen-parent-real')
  assert.deepEqual(continuation.context.qwenAiSessionBridge.continuation.inputMessages, [{
    role: 'tool',
    tool_call_id: 'call_read',
    content: '{"name":"chat2api"}',
  }])
  assert.equal(continuation.chatRequest.messages.length, 3, 'fallback remains able to replay full history')
  assert.deepEqual(calls.selections[1].slice(2), [provider.id, account.id, new Set(), {
    allowQueuedQwenAiPreferredAccount: true,
  }])
  assert.equal(conversations.get(firstStored.responseId).qwenAiSessionBinding.chatId, 'qwen-chat-real')
  assert.deepEqual(calls.clears, [])
})

test('Responses legacy mode keeps full-history replay and omits Qwen session bindings', async () => {
  const { handler, calls, toolCallSessions } = loadResponsesRouteHarness({ sessionMode: 'legacy' })
  const tools = [{
    type: 'function',
    function: { name: 'read_file', parameters: { type: 'object' } },
  }]

  await handler(createRouteContext({
    model: 'Qwen3.8-Max_Auto',
    input: 'Read package.json.',
    tools,
    tool_choice: 'auto',
    reasoning: { effort: 'xhigh' },
  }))
  const firstStored = calls.stores[0]
  await handler(createRouteContext({
    model: 'Qwen3.8-Max_Auto',
    previous_response_id: firstStored.responseId,
    input: [{
      type: 'function_call_output',
      call_id: 'call_read',
      output: '{"name":"chat2api"}',
    }],
    tools,
    tool_choice: 'auto',
    reasoning: { effort: 'xhigh' },
  }))

  assert.equal(calls.forwards.length, 2)
  assert.equal(calls.forwards[0].context.qwenAiSessionBridge, undefined)
  assert.equal(calls.forwards[1].context.qwenAiSessionBridge, undefined)
  assert.deepEqual(
    calls.forwards[1].chatRequest.messages.map(message => message.role),
    ['user', 'assistant', 'tool'],
  )
  assert.equal(firstStored.qwenAiSessionBinding, undefined)
  assert.equal(toolCallSessions.resolve(['call_read']), undefined)
})

function storedBridgeConversation(tools) {
  const messages = [
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
  ]
  const requestFingerprint = sessionBridge.createQwenAiSessionRequestFingerprint({
    model: 'Qwen3.8-Max_Auto',
    messages: [...messages, { role: 'tool', tool_call_id: 'call_read', content: '{"name":"chat2api"}' }],
    tools,
    tool_choice: 'auto',
    reasoning_effort: 'xhigh',
  })
  return {
    messages,
    qwenAiSessionBinding: {
      providerId: 'qwen-ai',
      accountId: 'account-pinned',
      requestedModel: 'Qwen3.8-Max_Auto',
      actualModel: 'qwen3.8-max',
      chatId: 'retained-qwen-chat',
      parentId: 'retained-qwen-parent',
      requestFingerprint,
    },
  }
}

function fullHistoryToolResultRequest(tools, overrides = {}) {
  return {
    model: 'Qwen3.8-Max_Auto',
    input: [
      {
        type: 'message',
        role: 'user',
        content: 'Read package.json.',
      },
      {
        type: 'function_call',
        call_id: 'call_read',
        name: 'read_file',
        arguments: '{"path":"package.json"}',
      },
      {
        type: 'function_call_output',
        call_id: 'call_read',
        output: '{"name":"chat2api"}',
      },
    ],
    tools,
    tool_choice: 'auto',
    reasoning: { effort: 'xhigh' },
    ...overrides,
  }
}

test('Responses full-history tool results use the Qwen tool-call binding and consume it after success', async () => {
  const { handler, calls, toolCallSessions } = loadResponsesRouteHarness()
  const tools = [{ type: 'function', function: { name: 'read_file', parameters: { type: 'object' } } }]
  const stored = storedBridgeConversation(tools)
  assert.equal(toolCallSessions.set(['call_read'], stored.qwenAiSessionBinding), true)

  await handler(createRouteContext(fullHistoryToolResultRequest(tools)))

  assert.equal(calls.forwards.length, 1)
  const forwarded = calls.forwards[0]
  assert.equal(forwarded.context.qwenAiSessionBridge.continuation.binding.chatId, 'retained-qwen-chat')
  assert.equal(forwarded.context.qwenAiSessionBridge.continuation.binding.parentId, 'retained-qwen-parent')
  assert.deepEqual(forwarded.context.qwenAiSessionBridge.continuation.inputMessages, [{
    role: 'tool',
    tool_call_id: 'call_read',
    content: '{"name":"chat2api"}',
  }])
  assert.deepEqual(
    forwarded.chatRequest.messages.map(message => message.role),
    ['user', 'assistant', 'tool'],
    'the complete client transcript remains available for a replay',
  )
  assert.equal(toolCallSessions.resolve(['call_read']), undefined)
})

test('Responses rejects a concurrent full-history continuation before it reaches the forwarder', async () => {
  let completeContinuation
  const { handler, calls, toolCallSessions } = loadResponsesRouteHarness({
    forwardResult: ({ chatRequest, account, provider, actualModel, context }) => new Promise(resolve => {
      completeContinuation = () => resolve({
        success: true,
        status: 200,
        body: { choices: [] },
        qwenAiToolCallIds: [],
        qwenAiSessionState: {
          providerId: provider.id,
          accountId: account.id,
          requestedModel: chatRequest.model,
          actualModel,
          requestFingerprint: context.qwenAiSessionBridge.requestFingerprint,
          getChatId: () => context.qwenAiSessionBridge.continuation.binding.chatId,
          getParentId: () => 'parent-after-continuation',
        },
      })
    }),
  })
  const tools = [{ type: 'function', function: { name: 'read_file', parameters: { type: 'object' } } }]
  const stored = storedBridgeConversation(tools)
  assert.equal(toolCallSessions.set(['call_read'], stored.qwenAiSessionBinding), true)

  const firstContext = createRouteContext(fullHistoryToolResultRequest(tools))
  const firstContinuation = handler(firstContext)
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(calls.forwards.length, 1)

  const duplicate = createRouteContext(fullHistoryToolResultRequest(tools))
  await handler(duplicate)
  assert.equal(duplicate.status, 429)
  assert.equal(duplicate.body.error.code, 'CHAT_IN_PROGRESS')
  assert.ok(Number(duplicate.responseHeaders['Retry-After']) >= 1)
  assert.equal(calls.forwards.length, 1, 'the duplicate must not enter the forwarder')
  assert.deepEqual(calls.accountFailures, [])

  completeContinuation()
  await firstContinuation
  assert.equal(toolCallSessions.resolve(['call_read']), undefined)
})

test('Responses full-history CHAT_IN_PROGRESS preserves its Qwen tool-call binding', async () => {
  let continuationAttempts = 0
  const { handler, calls, toolCallSessions } = loadResponsesRouteHarness({
    forwardResult: ({ chatRequest, account, provider, actualModel, context }) => {
      continuationAttempts += 1
      if (continuationAttempts === 1) {
        return {
          success: false,
          status: 429,
          error: 'Qwen chat is still in progress',
          errorCode: 'CHAT_IN_PROGRESS',
          accountFault: false,
        }
      }
      return {
        success: true,
        status: 200,
        body: { choices: [] },
        qwenAiToolCallIds: [],
        qwenAiSessionState: {
          providerId: provider.id,
          accountId: account.id,
          requestedModel: chatRequest.model,
          actualModel,
          requestFingerprint: context.qwenAiSessionBridge.requestFingerprint,
          getChatId: () => context.qwenAiSessionBridge.continuation.binding.chatId,
          getParentId: () => 'parent-after-retry',
        },
      }
    },
  })
  const tools = [{ type: 'function', function: { name: 'read_file', parameters: { type: 'object' } } }]
  const stored = storedBridgeConversation(tools)
  assert.equal(toolCallSessions.set(['call_read'], stored.qwenAiSessionBinding), true)
  const ctx = createRouteContext(fullHistoryToolResultRequest(tools))

  await handler(ctx)

  assert.equal(ctx.status, 429)
  assert.equal(calls.forwards.length, 1)
  assert.equal(calls.forwards[0].context.qwenAiSessionBridge.continuation.binding.chatId, 'retained-qwen-chat')
  assert.deepEqual(toolCallSessions.resolve(['call_read']), stored.qwenAiSessionBinding)

  await handler(createRouteContext(fullHistoryToolResultRequest(tools)))
  assert.equal(calls.forwards.length, 2)
  assert.equal(calls.forwards[1].context.qwenAiSessionBridge.continuation.binding.chatId, 'retained-qwen-chat')
  assert.equal(toolCallSessions.resolve(['call_read']), undefined)
})

test('Responses account failover clears the old tool-call binding and replays full history on a new Qwen chat', async () => {
  const { handler, calls, account, secondaryAccount, toolCallSessions } = loadResponsesRouteHarness({
    includeSecondaryAccount: true,
    forwardResult: ({ chatRequest, account: forwardedAccount, provider, actualModel, context }) => {
      if (forwardedAccount.id === account.id) {
        return {
          success: false,
          status: 429,
          error: 'Qwen account quota is exhausted',
          errorCode: 'qwen_ai_capacity_limit',
          accountFault: true,
          retryScope: 'next-account',
        }
      }
      return {
        success: true,
        status: 200,
        body: { choices: [] },
        qwenAiToolCallIds: [],
        qwenAiSessionState: {
          providerId: provider.id,
          accountId: forwardedAccount.id,
          requestedModel: chatRequest.model,
          actualModel,
          requestFingerprint: context.qwenAiSessionBridge?.requestFingerprint || 'missing',
          getChatId: () => 'replayed-qwen-chat',
          getParentId: () => 'replayed-qwen-parent',
        },
      }
    },
  })
  const tools = [{ type: 'function', function: { name: 'read_file', parameters: { type: 'object' } } }]
  const stored = storedBridgeConversation(tools)
  assert.equal(toolCallSessions.set(['call_read'], stored.qwenAiSessionBinding), true)

  await handler(createRouteContext(fullHistoryToolResultRequest(tools)))

  assert.equal(calls.forwards.length, 2)
  assert.equal(calls.forwards[0].account.id, account.id)
  assert.equal(calls.forwards[0].context.qwenAiSessionBridge.continuation.binding.chatId, 'retained-qwen-chat')
  assert.equal(calls.forwards[1].account.id, secondaryAccount.id)
  assert.equal(calls.forwards[1].context.qwenAiSessionBridge.continuation, undefined)
  assert.deepEqual(
    calls.forwards[1].chatRequest.messages.map(message => message.role),
    ['user', 'assistant', 'tool'],
  )
  assert.ok(calls.accountFailures.includes(account.id))
  assert.equal(toolCallSessions.resolve(['call_read']), undefined)
})

test('Responses invalid continuation input clears the old Qwen binding and falls back to a full replay', async () => {
  const { handler, calls, conversations } = loadResponsesRouteHarness()
  const tools = [{ type: 'function', function: { name: 'read_file', parameters: { type: 'object' } } }]
  conversations.set('resp_prior', storedBridgeConversation(tools))

  await handler(createRouteContext({
    model: 'Qwen3.8-Max_Auto',
    previous_response_id: 'resp_prior',
    input: 'Continue with a normal user message.',
    tools,
    tool_choice: 'auto',
    reasoning: { effort: 'xhigh' },
  }))

  assert.deepEqual(calls.clears, ['resp_prior'])
  assert.equal(calls.forwards.length, 1)
  assert.equal(calls.forwards[0].context.qwenAiSessionBridge.continuation, undefined)
  assert.equal(conversations.get('resp_prior').qwenAiSessionBinding, undefined)
})

test('Responses CHAT_IN_PROGRESS keeps a compatible Qwen binding for the next retry', async () => {
  const { handler, calls, conversations } = loadResponsesRouteHarness({
    forwardResult: () => ({
      success: false,
      status: 429,
      error: 'Qwen chat is still in progress',
      errorCode: 'CHAT_IN_PROGRESS',
      accountFault: false,
    }),
  })
  const tools = [{ type: 'function', function: { name: 'read_file', parameters: { type: 'object' } } }]
  const stored = storedBridgeConversation(tools)
  conversations.set('resp_prior', stored)
  const ctx = createRouteContext({
    model: 'Qwen3.8-Max_Auto',
    previous_response_id: 'resp_prior',
    input: [{
      type: 'function_call_output',
      call_id: 'call_read',
      output: '{"name":"chat2api"}',
    }],
    tools,
    tool_choice: 'auto',
    reasoning: { effort: 'xhigh' },
  })

  await handler(ctx)

  assert.equal(ctx.status, 429)
  assert.equal(calls.forwards[0].context.qwenAiSessionBridge.continuation.binding.chatId, 'retained-qwen-chat')
  assert.deepEqual(calls.clears, [])
  assert.equal(conversations.get('resp_prior').qwenAiSessionBinding.chatId, 'retained-qwen-chat')
})

test('Responses clears a rejected Qwen continuation binding without penalizing its account', async () => {
  const { handler, calls, conversations } = loadResponsesRouteHarness({
    forwardResult: () => ({
      success: false,
      status: 400,
      error: 'Qwen rejected the continuation payload',
      errorCode: 'qwen_ai_continuation_rejected',
      accountFault: false,
    }),
  })
  const tools = [{ type: 'function', function: { name: 'read_file', parameters: { type: 'object' } } }]
  conversations.set('resp_prior', storedBridgeConversation(tools))
  const ctx = createRouteContext({
    model: 'Qwen3.8-Max_Auto',
    previous_response_id: 'resp_prior',
    input: [{
      type: 'function_call_output',
      call_id: 'call_read',
      output: '{"name":"chat2api"}',
    }],
    tools,
    tool_choice: 'auto',
    reasoning: { effort: 'xhigh' },
  })

  await handler(ctx)

  assert.equal(ctx.status, 400)
  assert.deepEqual(calls.clears, ['resp_prior'])
  assert.deepEqual(calls.accountFailures, [])
  assert.equal(conversations.get('resp_prior').qwenAiSessionBinding, undefined)
})

test('Responses continuation retains synthesized tool-result attachments while validating the tool batch', async () => {
  const { handler, calls, conversations } = loadResponsesRouteHarness()
  const tools = [{ type: 'function', function: { name: 'read_file', parameters: { type: 'object' } } }]
  conversations.set('resp_prior', storedBridgeConversation(tools))
  const imageUrl = 'data:image/png;base64,AA=='

  await handler(createRouteContext({
    model: 'Qwen3.8-Max_Auto',
    previous_response_id: 'resp_prior',
    input: [{
      type: 'function_call_output',
      call_id: 'call_read',
      output: [{ type: 'input_image', image_url: imageUrl }],
    }],
    tools,
    tool_choice: 'auto',
    reasoning: { effort: 'xhigh' },
  }))

  const continuation = calls.forwards[0].context.qwenAiSessionBridge.continuation
  assert.deepEqual(continuation.inputMessages, [
    {
      role: 'tool',
      tool_call_id: 'call_read',
      content: 'Tool output attachment follows.',
    },
    {
      role: 'user',
      content: [
        { type: 'text', text: 'Tool output attachment follows.' },
        { type: 'image_url', image_url: { url: imageUrl } },
      ],
    },
  ])
  assert.deepEqual(calls.clears, [])
})

test('Responses streams persist late Qwen state only after a completed terminal response', async () => {
  for (const [terminalStatus, expectsBinding] of [
    ['completed', true],
    ['incomplete', false],
  ]) {
    const upstream = new PassThrough()
    const { handler, calls } = loadResponsesRouteHarness({
      streamTerminalStatus: terminalStatus,
      streamOutput: [{
        type: 'function_call',
        call_id: 'call_read',
        name: 'read_file',
        arguments: '{"path":"package.json"}',
      }],
      forwardResult: () => ({
        success: true,
        status: 200,
        stream: upstream,
        skipTransform: true,
      }),
    })
    const tools = [{ type: 'function', function: { name: 'read_file', parameters: { type: 'object' } } }]
    const ctx = createRouteContext({
      model: 'Qwen3.8-Max_Auto',
      input: 'Read package.json.',
      stream: true,
      tools,
      tool_choice: 'auto',
      reasoning: { effort: 'xhigh' },
    })

    await handler(ctx)
    const ended = once(ctx.body, 'end')
    upstream.qwenAiSessionState = {
      providerId: 'qwen-ai',
      accountId: 'account-pinned',
      requestedModel: 'Qwen3.8-Max_Auto',
      actualModel: 'qwen3.8-max',
      requestFingerprint: calls.forwards[0].context.qwenAiSessionBridge.requestFingerprint,
      getChatId: () => 'stream-chat-real',
      getParentId: () => 'stream-parent-real',
    }
    upstream.qwenAiToolCallIds = ['call_read']
    upstream.end('data: [DONE]\n\n')
    ctx.body.resume()
    await ended

    assert.equal(calls.stores.length, 1)
    assert.equal(
      calls.stores[0].qwenAiSessionBinding?.chatId,
      expectsBinding ? 'stream-chat-real' : undefined,
      `${terminalStatus} stream binding expectation`,
    )
  }
})

function adapterWithMatcher(name, matches = false) {
  const Adapter = class {}
  Adapter[name] = () => matches
  return Adapter
}

function loadForwarderForBridgeTests(overrides = {}) {
  const source = fs.readFileSync('src/main/proxy/forwarder.ts', 'utf8')
  const output = ts.transpileModule(source, {
    compilerOptions: {
      esModuleInterop: true,
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
    },
  }).outputText
  const StreamHandler = class {}
  const module = { exports: {} }
  const localModules = {
    axios: { create: () => ({}) },
    http2: {},
    '../store/types': {},
    './types': {},
    './status': { proxyStatusManager: {} },
    '../store/store': {
      storeManager: {
        getConfig: () => ({
          retryCount: 0,
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
      findModelCapability: () => undefined,
      isQwenAiStaleSessionError: value => Boolean(
        value && (
          value.code === 'qwen_ai_session_stale'
          || value.errorCode === 'qwen_ai_session_stale'
          || value.status === 404
          || value.status === 409
          || ((value.status === 400 || value.status === 422)
            && /^(chat|conversation|parent|response|session)[_-]?id$/i.test(String(value.param || '')))
          || /chat(?:id)?[^\n]*not[ _-]?found|parent[^\n]*not[ _-]?found/i.test(String(value.message || value.error || ''))
        )
      ),
      isQwenAiTransientTransportError: () => false,
      isQwenAiUpstreamBusyMessage: () => false,
      qwenAiRequestTimeoutMsFromEnv: () => 600_000,
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
      ToolCallingEngine: class {},
      createToolWorkflowContinuationMessage: () => ({
        role: 'user',
        content: 'Continue after the completed tool result.',
      }),
      extractLatestActiveUserRequest: () => 'Read package.json.',
      extractLatestActiveUserAttachments: messages => messages
        .filter(message => message.role === 'user' && Array.isArray(message.content))
        .flatMap(message => message.content.filter(part => part.type === 'image_url')),
    },
    './toolCalling/assistantInputBoundary': {
      sanitizeAssistantInputHistory: messages => ({ messages, removedMessageCount: 0 }),
    },
    './qwenAiRequestGovernor': {
      qwenAiRequestGovernor: { run: (_accountId, operation) => operation() },
    },
    './qwenAiAccountPolicy': qwenAiAccountPolicy,
    './utils/validatedSseStream': {
      BufferedSseError: class BufferedSseError extends Error {},
      bufferValidatedSseStream: async stream => stream,
    },
    './utils/errors': {
      isClientCancellationError: () => false,
      sanitizeForwardedErrorHeaders: headers => headers,
    },
    './sessionManager': { sessionManager: { shouldDeleteAfterChat: () => true } },
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
      classifyChatRequest: () => ({ intent: 'normal', textChars: 0 }),
    },
    './qwenAiCompactionBoundary': {
      estimateQwenAiRequestInputTokens: () => 1,
      boundQwenAiCompactionMessages: messages => ({
        messages,
        chunks: [{ messages, estimatedTokens: 0, sourceTextChars: 0 }],
        originalMessageCount: messages.length,
        keptMessageCount: messages.length,
        originalEstimatedTokens: 0,
        keptEstimatedTokens: 0,
        inputTokenBudget: 12000,
        chunkBudgetTokens: 12000,
        chunkSource: 'test',
        chunkCount: 1,
        splitMessageCount: 0,
        sourceTextChars: 0,
        coveredTextChars: 0,
        boundarySource: 'test',
        trimmed: false,
      }),
      planQwenAiCompactionChunks: messages => ({
        chunks: [{ messages, estimatedTokens: 0, sourceTextChars: 0 }],
        chunkBudgetTokens: 12000,
        chunkSource: 'test',
        sourceMessageCount: messages.length,
        sourceTextChars: 0,
        coveredTextChars: 0,
        splitMessageCount: 0,
        chunkCount: 1,
      }),
    },
  }
  const testRequire = specifier => {
    if (Object.prototype.hasOwnProperty.call(localModules, specifier)) return localModules[specifier]
    if (specifier.startsWith('.')) throw new Error(`Unexpected forwarder bridge import: ${specifier}`)
    return runtimeRequire(specifier)
  }
  new Function('require', 'module', 'exports', output)(testRequire, module, module.exports)
  return module.exports.RequestForwarder
}

function createForwarderBridgeHarness(continuationOutcome, emittedToolCallIds = []) {
  const calls = { starts: [], continuations: [], deletedChats: [] }
  class QwenAiAdapter {
    static isQwenAiProvider() { return true }

    async chatCompletion(input) {
      calls.starts.push(input)
      return {
        response: { status: 200, data: {}, headers: {} },
        chatId: `fresh-chat-${calls.starts.length}`,
        parentId: null,
      }
    }

    async continueChatCompletion(input) {
      calls.continuations.push(input)
      if (continuationOutcome instanceof Error) throw continuationOutcome
      return { status: 200, data: {}, headers: {} }
    }

    async deleteChat(chatId) {
      calls.deletedChats.push(chatId)
      return true
    }
  }

  class QwenAiStreamHandler {
    constructor() {
      this.chatId = ''
    }

    setChatId(chatId) { this.chatId = chatId }
    getChatId() { return this.chatId }
    getResponseId() { return 'qwen-parent-after-turn' }
    getPendingSemanticRecoveryError() { return undefined }
    isComplete() { return true }
    async handleNonStream() {
      if (emittedToolCallIds.length > 0) {
        return {
          choices: [{
            message: {
              role: 'assistant',
              content: null,
              tool_calls: emittedToolCallIds.map((id, index) => ({
                id,
                type: 'function',
                function: {
                  name: 'read_file',
                  arguments: JSON.stringify({ path: `file-${index}.txt` }),
                },
              })),
            },
          }],
        }
      }
      return { choices: [{ message: { role: 'assistant', content: 'done' } }] }
    }
  }

  const RequestForwarder = loadForwarderForBridgeTests({ QwenAiAdapter, QwenAiStreamHandler })
  const forwarder = new RequestForwarder()
  forwarder.transformRequestForPromptToolUse = request => ({
    messages: request.messages,
    plan: {
      shouldParseResponse: true,
      allowedToolNames: new Set(['read_file']),
      protocol: 'managed-tools-v1',
      failedToolResultPending: false,
    },
  })
  forwarder.applyToolCallsToResponse = () => {}
  return { forwarder, calls }
}

function bridgeForwardRequest() {
  const messages = [
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
    { role: 'tool', tool_call_id: 'call_read', content: '{"name":"chat2api"}' },
  ]
  return {
    model: 'Qwen3.8-Max_Auto',
    messages,
    stream: false,
    tools: [{ type: 'function', function: { name: 'read_file', parameters: { type: 'object' } } }],
    tool_choice: 'auto',
    reasoning_effort: 'xhigh',
  }
}

function bridgeForwardContext() {
  const binding = {
    providerId: 'qwen-ai',
    accountId: 'account-pinned',
    requestedModel: 'Qwen3.8-Max_Auto',
    actualModel: 'qwen3.8-max',
    chatId: 'retained-qwen-chat',
    parentId: 'retained-qwen-parent',
    requestFingerprint: 'bridge-fingerprint',
    toolProtocol: 'managed-tools-v1',
  }
  return {
    requestId: 'resp_followup',
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
  }
}

function skeletonBridgeForwardContext() {
  return {
    requestId: 'resp_first',
    signal: new AbortController().signal,
    qwenAiSessionBridge: {
      requestFingerprint: 'bridge-fingerprint',
    },
  }
}

test('Qwen forwarder removes a skeleton bridge chat after a normal response without tool calls', async () => {
  const { forwarder, calls } = createForwarderBridgeHarness()
  const result = await forwarder.forwardQwenAi(
    bridgeForwardRequest(),
    { id: 'account-pinned' },
    { id: 'qwen-ai', apiEndpoint: 'https://chat.qwen.ai' },
    'qwen3.8-max',
    Date.now(),
    skeletonBridgeForwardContext(),
  )

  assert.equal(result.success, true)
  assert.equal(calls.starts.length, 1)
  assert.equal(result.qwenAiToolCallIds, undefined)
  assert.deepEqual(calls.deletedChats, ['fresh-chat-1'])
})

test('Qwen forwarder retains a skeleton bridge chat only when it emitted client-visible tool calls', async () => {
  const { forwarder, calls } = createForwarderBridgeHarness(undefined, ['call_next'])
  const result = await forwarder.forwardQwenAi(
    bridgeForwardRequest(),
    { id: 'account-pinned' },
    { id: 'qwen-ai', apiEndpoint: 'https://chat.qwen.ai' },
    'qwen3.8-max',
    Date.now(),
    skeletonBridgeForwardContext(),
  )

  assert.equal(result.success, true)
  assert.equal(calls.starts.length, 1)
  assert.deepEqual(result.qwenAiToolCallIds, ['call_next'])
  assert.deepEqual(calls.deletedChats, [])
})

test('Qwen forwarder sends only the continuation delta to the pinned chat', async () => {
  const { forwarder, calls } = createForwarderBridgeHarness()
  const result = await forwarder.forwardQwenAi(
    bridgeForwardRequest(),
    { id: 'account-pinned' },
    { id: 'qwen-ai', apiEndpoint: 'https://chat.qwen.ai' },
    'qwen3.8-max',
    Date.now(),
    bridgeForwardContext(),
  )

  assert.equal(result.success, true)
  assert.equal(calls.starts.length, 0)
  assert.equal(calls.continuations.length, 1)
  assert.equal(calls.continuations[0].chatId, 'retained-qwen-chat')
  assert.equal(calls.continuations[0].parentId, 'retained-qwen-parent')
  assert.equal(
    calls.continuations[0].chatInProgressRetryAttempts,
    0,
    'Responses retained-chat continuations must fail fast into same-account replay',
  )
  assert.deepEqual(calls.continuations[0].messages, [
    { role: 'tool', tool_call_id: 'call_read', content: '{"name":"chat2api"}' },
    { role: 'user', content: 'Continue after the completed tool result.' },
  ])
  assert.deepEqual(sessionBridge.resolveQwenAiSessionBinding(result.qwenAiSessionState), {
    providerId: 'qwen-ai',
    accountId: 'account-pinned',
    requestedModel: 'Qwen3.8-Max_Auto',
    actualModel: 'qwen3.8-max',
    chatId: 'retained-qwen-chat',
    parentId: 'qwen-parent-after-turn',
    requestFingerprint: 'bridge-fingerprint',
    toolProtocol: 'managed-tools-v1',
  })
})

test('Qwen forwarder carries active user attachments into a retained continuation', async () => {
  const { forwarder, calls } = createForwarderBridgeHarness()
  const request = bridgeForwardRequest()
  request.messages = request.messages.map(message => message.role === 'user'
    ? {
        ...message,
        content: [{ type: 'text', text: 'Inspect this screenshot.' }, {
          type: 'image_url', image_url: { url: 'https://example.test/screenshot.png' },
        }],
      }
    : message)

  const result = await forwarder.forwardQwenAi(
    request,
    { id: 'account-pinned' },
    { id: 'qwen-ai', apiEndpoint: 'https://chat.qwen.ai' },
    'qwen3.8-max',
    Date.now(),
    bridgeForwardContext(),
  )

  assert.equal(result.success, true)
  assert.deepEqual(calls.continuations[0].messages[1], {
    role: 'user',
    content: [{ type: 'image_url', image_url: { url: 'https://example.test/screenshot.png' } }],
  })
})

test('Qwen stale chat or parent retries a full replay on the same account', async () => {
  const staleScenarios = [
    Object.assign(new Error('Qwen session is stale (404)'), { status: 404 }),
    Object.assign(new Error('Qwen session is stale (409)'), { status: 409 }),
    Object.assign(new Error('InvalidParameter: parent_id is invalid'), {
      status: 400,
      code: 'InvalidParameter',
      param: 'parent_id',
    }),
  ]
  for (const stale of staleScenarios) {
    const { forwarder, calls } = createForwarderBridgeHarness(stale)
    const request = bridgeForwardRequest()
    const result = await forwarder.forwardQwenAi(
      request,
      { id: 'account-pinned' },
      { id: 'qwen-ai', apiEndpoint: 'https://chat.qwen.ai' },
      'qwen3.8-max',
      Date.now(),
      bridgeForwardContext(),
    )

    assert.equal(result.success, true, `status ${stale.status} should be repaired locally`)
    assert.equal(calls.continuations.length, 1)
    assert.equal(calls.starts.length, 1)
    assert.deepEqual(calls.starts[0].messages, request.messages)
    assert.deepEqual(calls.deletedChats, ['retained-qwen-chat', 'fresh-chat-1'])
  }
})

test('Qwen ordinary continuation 400 clears the binding without replaying or faulting the account', async () => {
  const rejected = Object.assign(new Error('Invalid chat tool output content is malformed'), {
    status: 400,
    code: 'InvalidParameter',
    param: 'content',
  })
  const { forwarder, calls } = createForwarderBridgeHarness(rejected)
  const result = await forwarder.forwardQwenAi(
    bridgeForwardRequest(),
    { id: 'account-pinned' },
    { id: 'qwen-ai', apiEndpoint: 'https://chat.qwen.ai' },
    'qwen3.8-max',
    Date.now(),
    bridgeForwardContext(),
  )

  assert.equal(result.success, false)
  assert.equal(result.status, 400)
  assert.equal(result.errorCode, 'qwen_ai_continuation_rejected')
  assert.equal(result.accountFault, false)
  assert.equal(result.retryScope, undefined)
  assert.equal(calls.continuations.length, 1)
  assert.equal(calls.starts.length, 0)
  assert.deepEqual(calls.deletedChats, [])
})

test('Qwen account faults retain next-account failover while CHAT_IN_PROGRESS stays account-neutral', async () => {
  for (const status of [401, 403, 429]) {
    const accountFault = Object.assign(new Error(`Qwen account failure (${status})`), {
      status,
      code: status === 429 ? 'qwen_ai_capacity_limit' : 'qwen_ai_account_failure',
      accountFault: true,
      retryScope: 'next-account',
    })
    const { forwarder } = createForwarderBridgeHarness(accountFault)
    const result = await forwarder.forwardQwenAi(
      bridgeForwardRequest(),
      { id: 'account-pinned' },
      { id: 'qwen-ai', apiEndpoint: 'https://chat.qwen.ai' },
      'qwen3.8-max',
      Date.now(),
      bridgeForwardContext(),
    )
    assert.equal(result.success, false)
    assert.equal(result.status, status)
    assert.equal(result.accountFault, true)
    assert.equal(result.retryScope, 'next-account')
  }

  const busy = Object.assign(new Error('Qwen chat is still in progress'), {
    status: 429,
    code: 'CHAT_IN_PROGRESS',
    retryable: true,
    accountFault: false,
  })
  const { forwarder, calls } = createForwarderBridgeHarness(busy)
  const result = await forwarder.forwardQwenAi(
    bridgeForwardRequest(),
    { id: 'account-pinned' },
    { id: 'qwen-ai', apiEndpoint: 'https://chat.qwen.ai' },
    'qwen3.8-max',
    Date.now(),
    bridgeForwardContext(),
  )
  assert.equal(result.success, true)
  assert.equal(result.status, 200)
  assert.equal(result.accountFault, undefined)
  assert.equal(result.retryScope, undefined)
  assert.equal(calls.starts.length, 1, 'busy continuation must replay the full transcript on the same account')
})

test('Qwen continuation does not switch accounts for an account-neutral 5xx replay hint', async () => {
  const transient = Object.assign(new Error('Qwen upstream returned 503'), {
    status: 503,
    code: 'qwen_ai_upstream_error',
    accountFault: false,
    retryScope: 'next-account',
  })
  const { forwarder, calls } = createForwarderBridgeHarness(transient)
  const result = await forwarder.forwardQwenAi(
    bridgeForwardRequest(),
    { id: 'account-pinned' },
    { id: 'qwen-ai', apiEndpoint: 'https://chat.qwen.ai' },
    'qwen3.8-max',
    Date.now(),
    bridgeForwardContext(),
  )

  assert.equal(result.success, false)
  assert.equal(result.status, 503)
  assert.equal(result.accountFault, false)
  assert.equal(result.retryScope, undefined)
  assert.equal(calls.continuations.length, 1)
  assert.equal(calls.starts.length, 0)
})
