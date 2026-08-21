/**
 * Classify a Qwen failure at the account boundary.
 *
 * The upstream sometimes sends an Error-like object without the adapter's
 * derived `accountFault` flag (for example after an Axios/socket wrapper).
 * Keep the fallback deliberately narrow: authentication failures and the
 * provider's explicit capacity class may move to another account; ordinary
 * throttling, transient gateway failures, and conversation state errors may
 * not.
 */
export type QwenAiAccountFailureClassification = {
  accountFault?: unknown
  retryScope?: unknown
  status?: unknown
  statusCode?: unknown
  status_code?: unknown
  httpStatus?: unknown
  http_status?: unknown
  errorCode?: unknown
  code?: unknown
  param?: unknown
  message?: unknown
  error?: unknown
  response?: unknown
  cause?: unknown
  original_exception?: unknown
  originalException?: unknown
  data?: unknown
  detail?: unknown
  details?: unknown
  body?: unknown
}

export type QwenAiAccountFailureDetails = {
  status?: number
  code?: string
  accountFault?: boolean
  retryScope?: 'next-account'
}

const ERROR_CHILD_FIELDS = [
  'cause',
  'original_exception',
  'originalException',
  'originalError',
  'response',
  'data',
  'error',
  'errors',
  'detail',
  'details',
  'body',
] as const

const ERROR_MAX_DEPTH = 8
const ERROR_MAX_NODES = 128

type ErrorNode = {
  record: Record<string, unknown>
  depth: number
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

function errorNodes(value: unknown): ErrorNode[] {
  const nodes: ErrorNode[] = []
  const queue: Array<{ value: unknown; depth: number }> = [{ value, depth: 0 }]
  const visited = new Set<object>()

  while (queue.length > 0 && nodes.length < ERROR_MAX_NODES) {
    const item = queue.shift()!
    if (!isRecord(item.value) || item.depth > ERROR_MAX_DEPTH) continue
    if (visited.has(item.value)) continue
    visited.add(item.value)
    nodes.push({ record: item.value, depth: item.depth })

    for (const field of ERROR_CHILD_FIELDS) {
      const child = item.value[field]
      if (Array.isArray(child)) {
        child.slice(0, 16).forEach(entry => queue.push({
          value: entry,
          depth: item.depth + 1,
        }))
      } else if (child !== undefined && child !== null) {
        queue.push({ value: child, depth: item.depth + 1 })
      }
    }
  }

  return nodes
}

function numericStatus(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value >= 400 && value <= 599 ? value : undefined
  }
  if (typeof value === 'string' && /^\d{3}$/.test(value.trim())) {
    const parsed = Number(value.trim())
    return parsed >= 400 && parsed <= 599 ? parsed : undefined
  }
  return undefined
}

function statusCandidates(value: unknown): Array<{ status: number; depth: number }> {
  return errorNodes(value).flatMap(({ record, depth }) => (
    ['status', 'statusCode', 'status_code', 'httpStatus', 'http_status'].map(field => {
      const status = numericStatus(record[field])
      return status === undefined ? undefined : { status, depth }
    }).filter((candidate): candidate is { status: number; depth: number } => candidate !== undefined)
  ))
}

function stringField(value: unknown, field: string): string | undefined {
  if (!isRecord(value)) return undefined
  const candidate = value[field]
  return typeof candidate === 'string' && candidate.trim() ? candidate.trim() : undefined
}

function effectiveStatus(value: unknown): number | undefined {
  const candidates = statusCandidates(value)
  if (candidates.length === 0) return undefined

  // LiteLLM commonly puts a synthetic 503 on the outer exception and the
  // provider's real status on original_exception/response.data. Prefer the
  // deepest 4xx in that case; otherwise use the deepest observed upstream
  // status. This keeps nested 401/403/429 actionable while preserving a
  // nested 504/502 as account-neutral transport failure.
  const clientStatuses = candidates.filter(candidate => candidate.status >= 400 && candidate.status < 500)
  const pool = clientStatuses.length > 0 ? clientStatuses : candidates
  return pool
    .slice()
    .sort((left, right) => right.depth - left.depth)
    .at(0)?.status
}

function effectiveStringField(value: unknown, fields: readonly string[]): string | undefined {
  const candidates = errorNodes(value).flatMap(({ record, depth }) => fields
    .map(field => {
      const candidate = stringField(record, field)
      return candidate ? { candidate, depth } : undefined
    })
    .filter((entry): entry is { candidate: string; depth: number } => entry !== undefined))
  return candidates
    .slice()
    .sort((left, right) => right.depth - left.depth)
    .at(0)?.candidate
}

function statusOf(value: QwenAiAccountFailureClassification): number | undefined {
  return effectiveStatus(value)
}

function codeOf(value: QwenAiAccountFailureClassification): string {
  return (effectiveStringField(value, ['errorCode', 'error_code', 'code']) || '').toUpperCase()
}

function paramOf(value: QwenAiAccountFailureClassification): string {
  return (effectiveStringField(value, ['param']) || '').toLowerCase().replace(/[^a-z0-9]/g, '')
}

function explicitAccountFault(value: unknown): boolean | undefined {
  const candidates = errorNodes(value).flatMap(({ record, depth }) => {
    const candidate = typeof record.accountFault === 'boolean'
      ? record.accountFault
      : typeof record.account_fault === 'boolean'
        ? record.account_fault
        : undefined
    return candidate === undefined ? [] : [{ value: candidate, depth }]
  })
  // An explicit false is a deliberate account-neutral decision made by the
  // adapter/governor. Preserve it even when a wrapper also contains a nested
  // exception with a stale boolean value; the status/code policy still guards
  // against arbitrary 5xx/429 account rotation.
  if (candidates.some(candidate => candidate.value === false)) return false
  return candidates
    .slice()
    .sort((left, right) => right.depth - left.depth)
    .at(0)?.value
}

function rootStringField(value: unknown, fields: readonly string[]): string | undefined {
  if (!isRecord(value)) return undefined
  for (const field of fields) {
    const candidate = stringField(value, field)
    if (candidate) return candidate
  }
  return undefined
}

/**
 * Normalize account-bound metadata once at the provider boundary. The status
 * and code come from the same bounded error graph used by the policy; wrapper
 * booleans cannot turn an ordinary 5xx/429 into an account fault.
 */
export function qwenAiAccountFailureDetails(
  value: QwenAiAccountFailureClassification | undefined,
): QwenAiAccountFailureDetails {
  if (!value) return {}
  const status = statusOf(value)
  const code = codeOf(value) || undefined
  const explicit = explicitAccountFault(value)
  const classification = {
    ...value,
    status,
    code,
    errorCode: code,
    accountFault: explicit,
  }
  const accountFault = explicit === false
    ? false
    : isQwenAiAccountFault(classification)
      ? true
      : undefined
  return {
    status,
    code,
    accountFault,
    retryScope: qwenAiAccountRetryScope({ ...classification, accountFault }),
  }
}

/**
 * Preserve the two deliberate account-neutral replay scopes emitted by the
 * governor/file transport. A nested wrapper's stale retryScope is ignored.
 */
export function qwenAiSafeExplicitRetryScope(
  value: QwenAiAccountFailureClassification | undefined,
): 'next-account' | undefined {
  if (!isRecord(value) || value.retryScope !== 'next-account') return undefined
  if (value.accountFault !== false) return undefined
  const code = rootStringField(value, ['errorCode', 'error_code', 'code'])?.toLowerCase()
  return code === 'qwen_ai_file_parse_timeout' || code === 'qwen_ai_queue_timeout'
    ? 'next-account'
    : undefined
}

/** Status/code combinations that must remain on the current conversation. */
export function isQwenAiAccountNeutralFailure(value: QwenAiAccountFailureClassification | undefined): boolean {
  if (!value) return false
  const status = statusOf(value)
  const code = codeOf(value)
  if (
    code === 'CHAT_IN_PROGRESS'
    || code === 'QWEN_AI_SESSION_STALE'
    || code === 'QWEN_AI_CONTINUATION_REJECTED'
    || status === 404
    || status === 409
  ) {
    return true
  }
  if (status === 400) {
    const param = paramOf(value)
    if (param === 'chatid' || param === 'conversationid' || param === 'parentid') return true
  }
  return false
}

/**
 * Return true only for an account fault. Explicit false always wins, while
 * an absent flag is inferred from the narrow status/code contract above.
 */
export function isQwenAiAccountFault(value: QwenAiAccountFailureClassification | undefined): boolean {
  if (!value || isQwenAiAccountNeutralFailure(value)) return false
  if (explicitAccountFault(value) === false) return false

  const status = statusOf(value)
  const code = codeOf(value)
  // Account rotation is intentionally restricted to the documented classes.
  // An explicit true from a wrapper cannot turn a 5xx/ordinary 429 into an
  // account fault, which prevents the pool from being drained by congestion.
  return status === 401
    || status === 403
    || (status === 429 && code === 'QWEN_AI_CAPACITY_LIMIT')
}

/** The only inferred retry scope that is safe to use for account rotation. */
export function qwenAiAccountRetryScope(
  value: QwenAiAccountFailureClassification | undefined,
): 'next-account' | undefined {
  if (!value || explicitAccountFault(value) === false || isQwenAiAccountNeutralFailure(value)) {
    return undefined
  }
  const status = statusOf(value)
  const code = codeOf(value)
  return status === 401
    || status === 403
    || (status === 429 && code === 'QWEN_AI_CAPACITY_LIMIT')
    ? 'next-account'
    : undefined
}
