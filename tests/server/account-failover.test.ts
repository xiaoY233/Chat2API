import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'
import {
  forwardWithAccountFailover,
  isNextAccountFailoverEligible,
  resolveAccountFailoverLimit,
} from '../../src/main/proxy/accountFailover.ts'
import type { AccountSelection, ForwardResult } from '../../src/main/proxy/types.ts'

function selection(accountId: string): AccountSelection {
  return {
    account: { id: accountId } as AccountSelection['account'],
    provider: { id: 'qwen-ai' } as AccountSelection['provider'],
    actualModel: 'qwen3.8-max-preview',
  }
}

const nextAccountFailure: ForwardResult = {
  success: false,
  status: 503,
  error: 'account credentials need replacement',
  errorCode: 'qwen_ai_token_refresh_failed',
  retryable: false,
  accountFault: true,
  retryScope: 'next-account',
}

test('Qwen failover limit covers the current active account pool by default', () => {
  const baseInput = {
    configuredMaxFailovers: 3,
    qwenAiProvider: true,
    activeAccountCount: 99,
  }

  assert.equal(resolveAccountFailoverLimit(baseInput), 98)
  assert.equal(resolveAccountFailoverLimit({
    ...baseInput,
    qwenAiMaxAccountFailovers: '0',
  }), 98)
  assert.equal(resolveAccountFailoverLimit({
    ...baseInput,
    qwenAiMaxAccountFailovers: '20',
  }), 20)
})

test('non-Qwen failover limit preserves the configured retry count', () => {
  assert.equal(resolveAccountFailoverLimit({
    configuredMaxFailovers: 3,
    qwenAiProvider: false,
    activeAccountCount: 99,
    qwenAiMaxAccountFailovers: '80',
  }), 3)
})

test('preflight account failures switch accounts inside the same request', async () => {
  const first = selection('account-1')
  const second = selection('account-2')
  const attempted: string[] = []
  const failed: string[] = []
  const exclusions: string[][] = []

  const outcome = await forwardWithAccountFailover({
    initialSelection: first,
    maxFailovers: 3,
    forward: async ({ selection: current }) => {
      attempted.push(current.account.id)
      return current.account.id === first.account.id
        ? nextAccountFailure
        : { success: true, status: 200, body: { choices: [] } }
    },
    selectNext: excluded => {
      exclusions.push([...excluded])
      return excluded.has(first.account.id) ? second : null
    },
    onFailedAttempt: ({ selection: current }) => {
      failed.push(current.account.id)
    },
  })

  assert.deepEqual(attempted, ['account-1', 'account-2'])
  assert.deepEqual(failed, ['account-1'])
  assert.deepEqual(exclusions, [['account-1']])
  assert.equal(outcome.selection.account.id, 'account-2')
  assert.equal(outcome.result.success, true)
  assert.equal(outcome.failoverCount, 1)
})

test('Qwen capacity limits switch accounts inside the same client request', async () => {
  const first = selection('account-1')
  const second = selection('account-2')
  const attempted: string[] = []
  const capacityLimited: ForwardResult = {
    success: false,
    status: 429,
    error: 'Qwen AI upstream capacity is temporarily unavailable',
    errorCode: 'qwen_ai_capacity_limit',
    retryable: false,
    accountFault: true,
    retryScope: 'next-account',
  }

  const outcome = await forwardWithAccountFailover({
    initialSelection: first,
    maxFailovers: 1,
    forward: async ({ selection: current }) => {
      attempted.push(current.account.id)
      return current.account.id === first.account.id
        ? capacityLimited
        : { success: true, status: 200, body: { choices: [] } }
    },
    selectNext: excluded => excluded.has(first.account.id) ? second : null,
  })

  assert.deepEqual(attempted, ['account-1', 'account-2'])
  assert.equal(outcome.result.success, true)
  assert.equal(outcome.selection.account.id, 'account-2')
  assert.equal(outcome.failoverCount, 1)
})

test('Qwen failover reaches a later healthy account after multiple 403 and 429 responses', async () => {
  const accounts = Array.from({ length: 6 }, (_, index) => selection(`account-${index + 1}`))
  const maxFailovers = resolveAccountFailoverLimit({
    configuredMaxFailovers: 3,
    qwenAiProvider: true,
    activeAccountCount: accounts.length,
  })
  const attempted: string[] = []

  const outcome = await forwardWithAccountFailover({
    initialSelection: accounts[0],
    maxFailovers,
    forward: async ({ selection: current }) => {
      attempted.push(current.account.id)
      if (current.account.id === accounts.at(-1)?.account.id) {
        return { success: true, status: 200, body: { choices: [] } }
      }

      const accountNumber = Number(current.account.id.split('-').at(-1))
      return {
        success: false,
        status: accountNumber % 2 === 0 ? 429 : 403,
        error: accountNumber % 2 === 0
          ? 'Qwen AI upstream capacity is temporarily unavailable'
          : 'Qwen AI risk-control challenge',
        errorCode: accountNumber % 2 === 0
          ? 'qwen_ai_capacity_limit'
          : 'qwen_ai_risk_control',
        retryable: false,
        accountFault: true,
        retryScope: 'next-account',
      }
    },
    selectNext: excluded => accounts.find(item => !excluded.has(item.account.id)) ?? null,
  })

  assert.equal(maxFailovers, 5)
  assert.deepEqual(attempted, accounts.map(item => item.account.id))
  assert.equal(outcome.result.success, true)
  assert.equal(outcome.selection.account.id, 'account-6')
  assert.equal(outcome.failoverCount, 5)
})

test('only explicit preflight replay scopes are replayed', async () => {
  const controller = new AbortController()
  const ineligible: ForwardResult[] = [
    { ...nextAccountFailure, retryScope: undefined },
    { ...nextAccountFailure, status: 499 },
  ]

  for (const result of ineligible) {
    let selections = 0
    const outcome = await forwardWithAccountFailover({
      initialSelection: selection('account-1'),
      maxFailovers: 3,
      forward: async () => result,
      selectNext: () => {
        selections += 1
        return selection('account-2')
      },
    })
    assert.equal(outcome.failoverCount, 0)
    assert.equal(selections, 0)
  }

  controller.abort()
  assert.equal(isNextAccountFailoverEligible(nextAccountFailure, controller.signal), false)
})

test('account-neutral preflight failures replay independently of account fault', async () => {
  const first = selection('account-1')
  const second = selection('account-2')
  const replayableUpstreamFailure: ForwardResult = {
    success: false,
    status: 502,
    error: 'upstream service rejected the request',
    retryable: false,
    accountFault: false,
    retryScope: 'next-account',
  }
  const attempted: string[] = []
  const reportedFailures: string[] = []

  const outcome = await forwardWithAccountFailover({
    initialSelection: first,
    maxFailovers: 1,
    forward: async ({ selection: current }) => {
      attempted.push(current.account.id)
      return current.account.id === first.account.id
        ? replayableUpstreamFailure
        : { success: true, status: 200, body: { choices: [] } }
    },
    selectNext: excluded => excluded.has(first.account.id) ? second : null,
    onFailedAttempt: ({ selection: current }) => {
      reportedFailures.push(current.account.id)
    },
  })

  assert.equal(isNextAccountFailoverEligible(replayableUpstreamFailure), true)
  assert.equal(isNextAccountFailoverEligible({
    ...replayableUpstreamFailure,
    accountFault: undefined,
  }), true)
  assert.deepEqual(attempted, ['account-1', 'account-2'])
  assert.deepEqual(reportedFailures, ['account-1'])
  assert.equal(outcome.result.success, true)
  assert.equal(outcome.failoverCount, 1)
})

test('account-neutral file parse timeout continues on the next account', async () => {
  const first = selection('account-1')
  const second = selection('account-2')
  const parseTimeout: ForwardResult = {
    success: false,
    status: 504,
    error: 'Qwen AI file parse timed out',
    errorCode: 'qwen_ai_file_parse_timeout',
    retryable: false,
    accountFault: false,
    retryScope: 'next-account',
  }
  const attempted: string[] = []

  const outcome = await forwardWithAccountFailover({
    initialSelection: first,
    maxFailovers: 1,
    forward: async ({ selection: current }) => {
      attempted.push(current.account.id)
      return current.account.id === first.account.id
        ? parseTimeout
        : { success: true, status: 200, body: { choices: [] } }
    },
    selectNext: excluded => excluded.has(first.account.id) ? second : null,
  })

  assert.deepEqual(attempted, ['account-1', 'account-2'])
  assert.equal(outcome.result.success, true)
  assert.equal(outcome.failoverCount, 1)
})

test('exhausted malformed-tool recovery replays the complete request on the next account', async () => {
  const accounts = [selection('account-1'), selection('account-2')]
  const attempted: string[] = []
  const malformedToolFailure: ForwardResult = {
    success: false,
    status: 502,
    error: 'Provider returned declared native tool call with incomplete JSON arguments: Bash',
    errorCode: 'malformed_tool_call',
    retryable: false,
    accountFault: false,
    retryScope: 'next-account',
  }

  const outcome = await forwardWithAccountFailover({
    initialSelection: accounts[0],
    maxFailovers: 1,
    forward: async ({ selection: current }) => {
      attempted.push(current.account.id)
      return current.account.id === accounts[0].account.id
        ? malformedToolFailure
        : { success: true, status: 200, body: { choices: [] } }
    },
    selectNext: excluded => accounts.find(item => !excluded.has(item.account.id)) ?? null,
  })

  assert.deepEqual(attempted, ['account-1', 'account-2'])
  assert.equal(outcome.result.success, true)
  assert.equal(outcome.selection.account.id, 'account-2')
  assert.equal(outcome.failoverCount, 1)
})

test('account failover is bounded and never reselects an excluded account', async () => {
  const accounts = [selection('account-1'), selection('account-2'), selection('account-3')]
  const attempted: string[] = []

  const outcome = await forwardWithAccountFailover({
    initialSelection: accounts[0],
    maxFailovers: 1,
    forward: async ({ selection: current }) => {
      attempted.push(current.account.id)
      return nextAccountFailure
    },
    selectNext: excluded => accounts.find(item => !excluded.has(item.account.id)) ?? null,
  })

  assert.deepEqual(attempted, ['account-1', 'account-2'])
  assert.equal(outcome.failoverCount, 1)
  assert.equal(outcome.result.success, false)

  const loadBalancerSource = fs.readFileSync('src/main/proxy/loadbalancer.ts', 'utf8')
  assert.match(loadBalancerSource, /excludedAccountIds: ReadonlySet<string>/)
  assert.match(loadBalancerSource, /!excludedAccountIds\.has\(account\.id\)/)
})

test('both OpenAI-compatible generation routes use the shared account failover policy', () => {
  for (const routePath of [
    'src/main/proxy/routes/chat.ts',
    'src/main/proxy/routes/responses.ts',
  ]) {
    const source = fs.readFileSync(routePath, 'utf8')
    assert.match(source, /forwardWithAccountFailover\(\{/)
    assert.match(source, /excludedAccountIds\s*=>\s*loadBalancer\.selectAccount\(/)
    assert.match(source, /reportAccountFailover\(selection\.account\.id/)
    assert.match(source, /accountFault !== false|isQwenAiAccountFault/)
    assert.match(source, /data:\s*\{\s*attempt,\s*status:\s*result\.status,\s*accountFault:\s*result\.accountFault/)
  }

  const chatSource = fs.readFileSync('src/main/proxy/routes/chat.ts', 'utf8')
  const responsesSource = fs.readFileSync('src/main/proxy/routes/responses.ts', 'utf8')
  assert.match(chatSource, /maxFailovers,/)
  assert.match(chatSource, /resolveAccountFailoverLimit\(\{/)
  assert.match(responsesSource, /maxFailovers,/)
  assert.match(responsesSource, /resolveAccountFailoverLimit\(\{/)
})
