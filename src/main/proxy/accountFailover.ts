import type { AccountSelection, ForwardResult } from './types'

export interface AccountFailoverAttempt {
  selection: AccountSelection
  attempt: number
}

export interface AccountFailoverOutcome {
  selection: AccountSelection
  result: ForwardResult
  failoverCount: number
  excludedAccountIds: ReadonlySet<string>
}

export interface AccountFailoverLimitInput {
  configuredMaxFailovers: number
  qwenAiProvider: boolean
  activeAccountCount: number
  qwenAiMaxAccountFailovers?: string
}

interface AccountFailoverOptions {
  initialSelection: AccountSelection
  maxFailovers: number
  signal?: AbortSignal
  forward: (attempt: AccountFailoverAttempt) => Promise<ForwardResult>
  selectNext: (excludedAccountIds: ReadonlySet<string>) => AccountSelection | null
  onFailedAttempt?: (
    attempt: AccountFailoverAttempt,
    result: ForwardResult,
  ) => void | Promise<void>
}

function nonNegativeInteger(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0
}

export function resolveAccountFailoverLimit(input: AccountFailoverLimitInput): number {
  const configuredMaxFailovers = nonNegativeInteger(input.configuredMaxFailovers)
  if (!input.qwenAiProvider) return configuredMaxFailovers

  const poolMaxFailovers = Math.max(0, nonNegativeInteger(input.activeAccountCount) - 1)
  const deploymentLimit = Number(input.qwenAiMaxAccountFailovers)
  if (!Number.isSafeInteger(deploymentLimit) || deploymentLimit <= 0) {
    return poolMaxFailovers
  }

  return Math.min(poolMaxFailovers, deploymentLimit)
}

export function isNextAccountFailoverEligible(
  result: ForwardResult,
  signal?: AbortSignal,
): boolean {
  return !result.success
    && result.retryScope === 'next-account'
    && result.status !== 499
    && signal?.aborted !== true
}

export async function forwardWithAccountFailover(
  options: AccountFailoverOptions,
): Promise<AccountFailoverOutcome> {
  const maxFailovers = Math.max(0, Math.floor(options.maxFailovers))
  let selection = options.initialSelection
  let failoverCount = 0
  let excludedAccountIds: ReadonlySet<string> = new Set()

  while (true) {
    const attempt = { selection, attempt: failoverCount + 1 }
    const result = await options.forward(attempt)

    if (
      !isNextAccountFailoverEligible(result, options.signal)
      || failoverCount >= maxFailovers
    ) {
      return { selection, result, failoverCount, excludedAccountIds }
    }

    const nextExcludedAccountIds = new Set([
      ...excludedAccountIds,
      selection.account.id,
    ])
    const nextSelection = options.selectNext(nextExcludedAccountIds)
    if (!nextSelection) {
      return {
        selection,
        result,
        failoverCount,
        excludedAccountIds: nextExcludedAccountIds,
      }
    }

    await options.onFailedAttempt?.(attempt, result)
    selection = nextSelection
    excludedAccountIds = nextExcludedAccountIds
    failoverCount += 1
  }
}
