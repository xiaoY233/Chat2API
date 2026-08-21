import assert from 'node:assert/strict'
import { once } from 'node:events'
import { PassThrough, Readable } from 'node:stream'
import test from 'node:test'
import { forwardWithAccountFailover } from '../../src/main/proxy/accountFailover.ts'
import { createDeferredQwenAiFailoverStream } from '../../src/main/proxy/qwenAiDeferredStream.ts'
import { createResponsesStreamTransform } from '../../src/main/proxy/responses/stream.ts'
import type { AccountSelection, ForwardResult } from '../../src/main/proxy/types.ts'
import { SseKeepAliveStream } from '../../src/main/proxy/utils/sseKeepAlive.ts'
import { bufferValidatedSseStream } from '../../src/main/proxy/utils/validatedSseStream.ts'

const QWEN_AI_STREAM_FAILURE_EVENT = 'qwen-ai-stream-failure'

function selection(id: string): AccountSelection {
  return {
    account: { id, providerId: 'qwen-ai', status: 'active' } as AccountSelection['account'],
    provider: {
      id: 'qwen-ai',
      apiEndpoint: 'https://chat.qwen.ai',
    } as AccountSelection['provider'],
    actualModel: 'qwen3.8-max',
  }
}

function completeSse(content: string): string {
  return [
    `data: ${JSON.stringify({ choices: [{ delta: { content }, finish_reason: null }] })}\n\n`,
    `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\n`,
    'data: [DONE]\n\n',
  ].join('')
}

test('deferred managed stream drops a partial 429 branch and exposes only the next account', async () => {
  const first = selection('account-a')
  const second = selection('account-b')
  const attempts: string[] = []
  const failedAccounts: string[] = []
  let outcomeSettled = false

  const outcomePromise = forwardWithAccountFailover({
    initialSelection: first,
    maxFailovers: 1,
    forward: async ({ selection: current }): Promise<ForwardResult> => {
      attempts.push(current.account.id)
      if (current.account.id === first.account.id) {
        const upstream = new PassThrough()
        const capacityError = Object.assign(new Error('Qwen AI capacity limit after partial output'), {
          status: 429,
          code: 'qwen_ai_capacity_limit',
          retryable: false,
          accountFault: true,
          retryScope: 'next-account' as const,
        })
        setTimeout(() => {
          upstream.write(`data: ${JSON.stringify({
            choices: [{ delta: { reasoning_content: 'BAD_REASONING' }, finish_reason: null }],
          })}\n\n`)
          upstream.write(`data: ${JSON.stringify({
            choices: [{ delta: { content: 'BAD_PARTIAL' }, finish_reason: null }],
          })}\n\n`)
          upstream.destroy(capacityError)
        }, 5)

        try {
          const stream = await bufferValidatedSseStream(upstream)
          return { success: true, status: 200, stream, skipTransform: true }
        } catch (error) {
          const failure = error as typeof capacityError
          return {
            success: false,
            status: failure.status,
            error: failure.message,
            errorCode: failure.code,
            retryable: failure.retryable,
            accountFault: failure.accountFault,
            retryScope: failure.retryScope,
          }
        }
      }

      await new Promise(resolve => setTimeout(resolve, 35))
      const stream = await bufferValidatedSseStream(Readable.from([completeSse('GOOD_FINAL')]))
      return { success: true, status: 200, stream, skipTransform: true }
    },
    selectNext: excluded => excluded.has(first.account.id) ? second : null,
    onFailedAttempt: ({ selection: failed }) => {
      failedAccounts.push(failed.account.id)
    },
  })
  void outcomePromise.finally(() => { outcomeSettled = true })

  const deferred = createDeferredQwenAiFailoverStream(outcomePromise, undefined)
  const clientStream = new SseKeepAliveStream({ intervalMs: 10 })
  const chunks: Buffer[] = []
  clientStream.on('data', chunk => chunks.push(Buffer.from(chunk)))
  deferred.pipe(clientStream)

  await once(clientStream, 'data')
  assert.equal(outcomeSettled, false)
  const waitingOutput = Buffer.concat(chunks).toString('utf8')
  assert.match(waitingOutput, /: keep-alive/)
  assert.doesNotMatch(waitingOutput, /BAD_REASONING|BAD_PARTIAL|GOOD_FINAL/)
  await once(clientStream, 'end')
  const output = Buffer.concat(chunks).toString('utf8')

  assert.deepEqual(attempts, ['account-a', 'account-b'])
  assert.deepEqual(failedAccounts, ['account-a'])
  assert.match(output, /: keep-alive/)
  assert.match(output, /GOOD_FINAL/)
  assert.doesNotMatch(output, /BAD_REASONING|BAD_PARTIAL/)
  assert.equal(deferred.qwenAiEffectiveAccountId, 'account-b')
  assert.equal(deferred.qwenAiFailure, undefined)
})

test('deferred managed stream preserves the final failure classification', async () => {
  const finalSelection = selection('account-final')
  const outcome = Promise.resolve({
    selection: finalSelection,
    result: {
      success: false,
      status: 429,
      error: 'all accounts capacity limited',
      errorCode: 'qwen_ai_capacity_limit',
      retryable: false,
      accountFault: true,
      retryScope: 'next-account' as const,
    },
    failoverCount: 3,
    excludedAccountIds: new Set<string>(),
  })
  const deferred = createDeferredQwenAiFailoverStream(outcome)
  const failureEvent = once(deferred, QWEN_AI_STREAM_FAILURE_EVENT)
  const chunks: Buffer[] = []
  deferred.on('data', chunk => chunks.push(Buffer.from(chunk)))
  const streamEnd = once(deferred, 'end')

  const [[failure]] = await Promise.all([failureEvent, streamEnd])
  assert.equal((failure as Error & { status?: number }).status, 429)
  assert.equal((failure as Error & { code?: string }).code, 'qwen_ai_capacity_limit')
  assert.equal(deferred.qwenAiFailure, failure)
  assert.equal(deferred.qwenAiEffectiveAccountId, 'account-final')
  const body = Buffer.concat(chunks).toString('utf8')
  assert.match(body, /event: error/)
  assert.match(body, /all accounts capacity limited/)
  assert.match(body, /data: \[DONE\]/)
})

test('deferred final failover failure reaches Responses as a structured terminal event', async () => {
  const selected = selection('account-responses-failure')
  const deferred = createDeferredQwenAiFailoverStream(Promise.resolve({
    selection: selected,
    result: {
      success: false,
      status: 504,
      error: 'Qwen AI request exceeded its cumulative request deadline.',
      errorCode: 'qwen_ai_request_timeout',
      accountFault: false,
    },
    failoverCount: 1,
    excludedAccountIds: new Set<string>(),
  }))
  const responses = createResponsesStreamTransform({
    request: { model: 'test-model', input: 'hello', stream: true },
    responseId: 'resp_final_failover',
    model: 'test-model',
  }).start()
  const chunks: string[] = []
  responses.on('data', chunk => chunks.push(chunk.toString()))
  const ended = once(responses, 'end')
  deferred.pipe(responses)

  await ended
  const events = chunks.join('').split('\n\n')
    .filter(Boolean)
    .map(block => JSON.parse(block.split('\n').find(line => line.startsWith('data: '))!.slice(6)))
  assert.equal(events.at(-1)?.type, 'response.failed')
  assert.equal(events.filter(event => event.type === 'response.failed').length, 1)
  assert.equal(events.some(event => event.type === 'response.completed'), false)
  assert.equal(events.find(event => event.type === 'response.failed')?.response?.error?.code, 'qwen_ai_request_timeout')
})

test('deferred Qwen stream retains the live Responses session state', async () => {
  const selected = selection('account-session')
  const sessionState = {
    providerId: 'qwen-ai',
    accountId: 'account-session',
    requestedModel: 'Qwen3.8-Max_Auto',
    actualModel: 'qwen3.8-max',
    requestFingerprint: 'fingerprint',
    getChatId: () => 'chat-session',
    getParentId: () => 'response-session',
  }
  const upstream = Readable.from([completeSse('session-complete')])
  const deferred = createDeferredQwenAiFailoverStream(Promise.resolve({
    selection: selected,
    result: {
      success: true,
      status: 200,
      stream: upstream,
      skipTransform: true,
      qwenAiSessionState: sessionState,
    },
    failoverCount: 0,
    excludedAccountIds: new Set<string>(),
  }))

  deferred.resume()
  await once(deferred, 'end')

  assert.equal(deferred.qwenAiSessionState, sessionState)
  assert.equal(deferred.qwenAiSessionState?.getChatId(), 'chat-session')
  assert.equal(deferred.qwenAiSessionState?.getParentId(), 'response-session')
})

test('deferred Qwen failure drains error and DONE frames into a failed Responses event', async () => {
  const selected = selection('account-failure-drain')
  const source = new PassThrough() as any
  const failure = Object.assign(new Error('synthetic upstream failure'), {
    status: 502,
    code: 'qwen_ai_stream_error',
    accountFault: false,
  })
  const deferred = createDeferredQwenAiFailoverStream(Promise.resolve({
    selection: selected,
    result: { success: true, status: 200, stream: source, skipTransform: true },
    failoverCount: 0,
    excludedAccountIds: new Set<string>(),
  }))
  const responses = createResponsesStreamTransform({
    request: { model: 'test-model', input: 'hello', stream: true },
    responseId: 'resp_failure_drain',
    model: 'test-model',
  }).start()
  const chunks: string[] = []
  responses.on('data', chunk => chunks.push(chunk.toString()))
  const responseEnd = once(responses, 'end')
  deferred.pipe(responses)

  // Account failover attaches the source listeners on the next microtask.
  await new Promise<void>(resolve => setImmediate(resolve))
  source.qwenAiFailure = failure
  source.emit(QWEN_AI_STREAM_FAILURE_EVENT, failure)
  source.write(`event: error\ndata: ${JSON.stringify({
    error: { message: failure.message, code: failure.code },
  })}\n\n`)
  source.end('data: [DONE]\n\n')

  await responseEnd
  const output = chunks.join('')
  const events = output.split('\n\n')
    .filter(Boolean)
    .map(block => JSON.parse(block.split('\n').find(line => line.startsWith('data: '))!.slice(6)))
  assert.equal(events.at(-1)?.type, 'response.failed')
  assert.equal(events.some(event => event.type === 'response.completed'), false)
  assert.match(output, /synthetic upstream failure/)
})

test('deferred Qwen failure drains a pre-ended buffered source attached late', async () => {
  const selected = selection('account-pre-ended-failure')
  const source = new PassThrough() as any
  const failure = Object.assign(new Error('pre-ended synthetic failure'), {
    status: 502,
    code: 'qwen_ai_stream_error',
    accountFault: false,
  })
  source.qwenAiFailure = failure
  source.write(`event: error\ndata: ${JSON.stringify({
    error: { message: failure.message, code: failure.code },
  })}\n\n`)
  source.end('data: [DONE]\n\n')

  // The provider can finish while account-failover bookkeeping is still
  // settling. At this point the terminal bytes remain readable, but no
  // deferred-stream listener has been attached yet.
  await once(source, 'finish')
  assert.equal(source.readableEnded, false)
  assert.ok(source.readableLength > 0)

  let resolveOutcome!: (value: any) => void
  const outcome = new Promise(resolve => { resolveOutcome = resolve })
  const deferred = createDeferredQwenAiFailoverStream(outcome)
  const responses = createResponsesStreamTransform({
    request: { model: 'test-model', input: 'hello', stream: true },
    responseId: 'resp_pre_ended_failure',
    model: 'test-model',
  }).start()
  const chunks: string[] = []
  responses.on('data', chunk => chunks.push(chunk.toString()))
  const responseEnd = once(responses, 'end')
  deferred.pipe(responses)

  resolveOutcome({
    selection: selected,
    result: { success: true, status: 200, stream: source, skipTransform: true },
    failoverCount: 0,
    excludedAccountIds: new Set<string>(),
  })

  await responseEnd
  const output = chunks.join('')
  const events = output.split('\n\n')
    .filter(Boolean)
    .map(block => JSON.parse(block.split('\n').find(line => line.startsWith('data: '))!.slice(6)))
  assert.equal(events.at(-1)?.type, 'response.failed')
  assert.equal(events.some(event => event.type === 'response.completed'), false)
  assert.match(output, /pre-ended synthetic failure/)
})
