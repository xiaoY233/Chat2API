/**
 * Session Manager Test Suite
 *
 * Tests computeHistoryHash and sessionManager multi-turn conversation flow.
 * Mocks storeManager since Electron is not available in test environment.
 *
 * Run: npx -y tsx tests/session-manager.test.ts
 */

// ─── Mock StoreManager ──────────────────────────────────────────────────────────

interface MockSessionRecord {
  id: string
  providerId: string
  accountId: string
  sessionType: 'chat' | 'agent'
  messages: Array<{ role: string; content: string | any[]; timestamp: number; providerMessageId?: string; toolCallId?: string }>
  createdAt: number
  lastActiveAt: number
  status: 'active' | 'expired' | 'deleted'
  model?: string
  metadata?: { title?: string; tokenCount?: number }
  providerSessionId?: string
  parentMessageId?: string
  historyHash?: string
}

const mockSessions: MockSessionRecord[] = []
let mockConfig = {
  sessionTimeout: 30,
  maxMessagesPerSession: 50,
  deleteAfterTimeout: false,
  maxSessionsPerAccount: 3,
}

const mockStoreManager = {
  getSessionConfig: () => mockConfig,
  updateSessionConfig: (updates: Partial<typeof mockConfig>) => {
    Object.assign(mockConfig, updates)
    return mockConfig
  },
  getSessionsByProviderId: (providerId: string) =>
    mockSessions.filter(s => s.providerId === providerId),
  getSessionById: (id: string) =>
    mockSessions.find(s => s.id === id),
  getActiveSessions: () =>
    mockSessions.filter(s => s.status === 'active'),
  addSession: (session: MockSessionRecord) => {
    mockSessions.push(session)
  },
  deleteSession: (id: string) => {
    const idx = mockSessions.findIndex(s => s.id === id)
    if (idx !== -1) {
      mockSessions.splice(idx, 1)
      return true
    }
    return false
  },
  cleanExpiredSessions: () => {
    const timeoutMs = mockConfig.sessionTimeout * 60 * 1000
    const now = Date.now()
    const before = mockSessions.length
    for (let i = mockSessions.length - 1; i >= 0; i--) {
      const s = mockSessions[i]
      if (s.status === 'active' && (now - s.lastActiveAt) >= timeoutMs) {
        s.status = 'expired'
      }
    }
    return before - mockSessions.filter(s => s.status === 'active').length
  },
  clearAllSessions: () => { mockSessions.length = 0 },
  getSessionsByAccountId: (accountId: string) =>
    mockSessions.filter(s => s.accountId === accountId),
  getSessions: () => mockSessions,
}

// ─── Import computeHistoryHash (pure function, no Electron dependency) ──────────

// We can't directly import from src/main due to Electron deps,
// so we copy the function here for pure testing.

import { createHash } from 'crypto'

interface ChatMessage {
  role: 'user' | 'assistant' | 'system' | 'tool'
  content: string | any[]
  timestamp: number
  providerMessageId?: string
  toolCallId?: string
}

function computeHistoryHash(messages: ChatMessage[]): string | undefined {
  if (!messages || messages.length === 0) return undefined

  // Hash the first user message as a stable conversation identifier.
  const firstUserMsg = messages.find(m => m.role === 'user')
  if (!firstUserMsg) return undefined

  const content = typeof firstUserMsg.content === 'string'
    ? firstUserMsg.content
    : JSON.stringify(firstUserMsg.content)

  return createHash('md5').update(`${firstUserMsg.role}:${content}`).digest('hex')
}

// ─── Tests ─────────────────────────────────────────────────────────────────────

const passed: string[] = []
const failed: string[] = []

function assert(condition: boolean, name: string, detail?: string): void {
  if (condition) {
    passed.push(name)
  } else {
    failed.push(`FAIL: ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

function assertEqual<T>(actual: T, expected: T, name: string): void {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  if (ok) {
    passed.push(name)
  } else {
    failed.push(`FAIL: ${name} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
  }
}

// ─── 1) computeHistoryHash ─────────────────────────────────────────────────────

// Empty array returns undefined
assert(
  computeHistoryHash([]) === undefined,
  'empty array → undefined'
)

// Single user message returns hash of that message
const h1 = computeHistoryHash([
  { role: 'user', content: 'Hello', timestamp: 1 },
])
assert(
  h1 !== undefined && h1.length === 32,
  'single user message → valid MD5 hash'
)

// Multiple messages — still hashes first user message
const h2a = computeHistoryHash([
  { role: 'system', content: 'You are helpful', timestamp: 1 },
  { role: 'user', content: 'Hello', timestamp: 2 },
])
const h2b = computeHistoryHash([
  { role: 'user', content: 'Hello', timestamp: 1 },
  { role: 'assistant', content: 'Hi!', timestamp: 2 },
  { role: 'user', content: 'How are you?', timestamp: 3 },
])
assertEqual(h2a, h2b, 'same first user message → same hash regardless of later messages')

// Different first user message → different hash
const h3 = computeHistoryHash([
  { role: 'user', content: 'Different', timestamp: 1 },
])
assert(
  h3 !== h2a,
  'different first user message → different hash'
)

// No user messages → undefined
const h4 = computeHistoryHash([
  { role: 'system', content: 'System prompt', timestamp: 1 },
  { role: 'assistant', content: 'Response', timestamp: 2 },
])
assert(
  h4 === undefined,
  'no user message → undefined'
)

// Content is array (multimodal)
const h5 = computeHistoryHash([
  { role: 'user', content: [{ type: 'text', text: 'Describe this' }], timestamp: 1 },
])
assert(
  h5 !== undefined && h5.length === 32,
  'multimodal content (array) → valid hash'
)

// Null content
const h6 = computeHistoryHash([
  { role: 'user', content: null as any, timestamp: 1 },
])
assert(
  h6 !== undefined,
  'null content → still produces hash (from stringified)'
)

// ─── 2) Session flow simulation (mock-based) ────────────────────────────────────

// Replicate sessionManager logic with mock store

let nextId = 1
function generateSessionId(): string {
  return `session-test-${nextId++}`
}

function getActiveSession(providerId: string, accountId: string): MockSessionRecord | undefined {
  const sessions = mockStoreManager.getSessionsByProviderId(providerId)
  const accountSessions = sessions.filter(s => s.accountId === accountId)
  const config = mockStoreManager.getSessionConfig()
  const timeoutMs = config.sessionTimeout * 60 * 1000
  const now = Date.now()

  return accountSessions.find(s =>
    s.status === 'active' &&
    (now - s.lastActiveAt) < timeoutMs
  )
}

function getOrCreateSession(options: {
  providerId: string
  accountId: string
  model?: string
  messages?: ChatMessage[]
}): {
  sessionId: string
  providerSessionId: string | undefined
  parentMessageId: string | undefined
  messages: ChatMessage[]
  isNew: boolean
} {
  const { providerId, accountId, model, messages } = options
  const hash = computeHistoryHash(messages || [])

  // 1) Hash lookup
  if (hash) {
    const sessions = mockStoreManager.getSessionsByProviderId(providerId)
    const config = mockStoreManager.getSessionConfig()
    const timeoutMs = config.sessionTimeout * 60 * 1000
    const now = Date.now()

    const matched = sessions.find(s =>
      s.accountId === accountId &&
      s.status === 'active' &&
      s.historyHash === hash &&
      (now - s.lastActiveAt) < timeoutMs
    )

    if (matched) {
      matched.lastActiveAt = now
      matched.messages = messages || matched.messages
      return {
        sessionId: matched.id,
        providerSessionId: matched.providerSessionId,
        parentMessageId: matched.parentMessageId,
        messages: matched.messages,
        isNew: false,
      }
    }
  }

  // 2) Fallback to active session
  const existingSession = getActiveSession(providerId, accountId)
  if (existingSession) {
    existingSession.messages = messages || existingSession.messages
    if (hash) {
      existingSession.historyHash = hash
    }
    return {
      sessionId: existingSession.id,
      providerSessionId: existingSession.providerSessionId,
      parentMessageId: existingSession.parentMessageId,
      messages: existingSession.messages,
      isNew: false,
    }
  }

  // 3) Create new
  const session: MockSessionRecord = {
    id: generateSessionId(),
    providerId,
    accountId,
    sessionType: 'chat',
    messages: messages || [],
    createdAt: Date.now(),
    lastActiveAt: Date.now(),
    status: 'active',
    model,
  }
  if (hash) {
    session.historyHash = hash
  }

  mockStoreManager.addSession(session)
  return {
    sessionId: session.id,
    providerSessionId: undefined,
    parentMessageId: undefined,
    messages: session.messages,
    isNew: true,
  }
}

function updateProviderSession(
  sessionId: string,
  providerSessionId: string | undefined,
  parentMessageId: string | undefined,
  messages?: ChatMessage[],
): void {
  const session = mockStoreManager.getSessionById(sessionId)
  if (!session) return

  session.providerSessionId = providerSessionId || session.providerSessionId
  session.parentMessageId = parentMessageId || session.parentMessageId
  if (messages) {
    session.messages = messages
    const hash = computeHistoryHash(messages)
    if (hash) {
      session.historyHash = hash
    }
  }
  session.lastActiveAt = Date.now()
}

// Reset state before session flow tests
mockSessions.length = 0
nextId = 1
mockConfig.sessionTimeout = 30

// Test: First request creates new session
{
  const ctx1 = getOrCreateSession({
    providerId: 'deepseek',
    accountId: 'account-1',
    model: 'deepseek-chat',
    messages: [{ role: 'user', content: 'Hello', timestamp: 1 }],
  })
  assert(ctx1.isNew, 'first request → new session')
  assert(ctx1.providerSessionId === undefined, 'first request → no providerSessionId')
  assert(mockSessions.length === 1, 'first request → one session in store')
}

// Test: Second request with same first user message → hash match (or fallback)
{
  const ctx2 = getOrCreateSession({
    providerId: 'deepseek',
    accountId: 'account-1',
    model: 'deepseek-chat',
    messages: [
      { role: 'user', content: 'Hello', timestamp: 1 },
      { role: 'assistant', content: 'Hi!', timestamp: 2 },
      { role: 'user', content: 'How are you?', timestamp: 3 },
    ],
  })
  assert(!ctx2.isNew, 'second request → reused session')
  assert(mockSessions.length === 1, 'second request → still one session')
}

// Test: After response, updateProviderSession stores provider IDs
{
  const session = mockSessions[0]
  updateProviderSession(
    session.id,
    'upstream-session-123',
    'upstream-msg-456',
    [
      { role: 'user', content: 'Hello', timestamp: 1 },
      { role: 'assistant', content: 'Hi!', timestamp: 2 },
      { role: 'user', content: 'How are you?', timestamp: 3 },
    ],
  )
  assert(session.providerSessionId === 'upstream-session-123', 'update stores providerSessionId')
  assert(session.parentMessageId === 'upstream-msg-456', 'update stores parentMessageId')
  assert(session.historyHash !== undefined, 'update sets historyHash')
}

// Test: Third request with same first user message → hash match returns stored IDs
{
  const ctx3 = getOrCreateSession({
    providerId: 'deepseek',
    accountId: 'account-1',
    model: 'deepseek-chat',
    messages: [
      { role: 'user', content: 'Hello', timestamp: 1 },
      { role: 'assistant', content: 'Hi!', timestamp: 2 },
      { role: 'user', content: 'How are you?', timestamp: 3 },
      { role: 'assistant', content: 'I am fine!', timestamp: 4 },
      { role: 'user', content: 'Tell me a joke', timestamp: 5 },
    ],
  })
  assert(!ctx3.isNew, 'third request → reused session')
  assert(ctx3.providerSessionId === 'upstream-session-123', 'third request → has stored providerSessionId')
  assert(ctx3.parentMessageId === 'upstream-msg-456', 'third request → has stored parentMessageId')
}

// Test: Different account → different session
{
  const ctx4 = getOrCreateSession({
    providerId: 'deepseek',
    accountId: 'account-2',
    model: 'deepseek-chat',
    messages: [{ role: 'user', content: 'Hello', timestamp: 1 }],
  })
  assert(ctx4.isNew, 'different account → new session')
  assert(ctx4.providerSessionId === undefined, 'different account → no providerSessionId')
  assert(mockSessions.length === 2, 'different account → two sessions total')
}

// Test: Different provider → different session
{
  const ctx5 = getOrCreateSession({
    providerId: 'kimi',
    accountId: 'account-1',
    model: 'kimi-k2',
    messages: [{ role: 'user', content: 'Hello', timestamp: 1 }],
  })
  assert(ctx5.isNew, 'different provider → new session')
  assert(mockSessions.length === 3, 'different provider → three sessions total')
}

// Test: updateProviderSession with falsy IDs preserves existing
{
  const session = mockSessions[0]
  const before = { ...session }
  updateProviderSession(session.id, undefined, undefined)
  assert(session.providerSessionId === before.providerSessionId, 'undefined providerSessionId → preserves existing')
  assert(session.parentMessageId === before.parentMessageId, 'undefined parentMessageId → preserves existing')
}

// Test: updateProviderSession with non-existent session does nothing
{
  updateProviderSession('non-existent-id', 'foo', 'bar')
  assert(true, 'update of non-existent session → no crash') // should not throw
}

// Test: Session timeout — expired session not matched
{
  // Create a session in the past
  const oldSession: MockSessionRecord = {
    id: 'old-session',
    providerId: 'deepseek',
    accountId: 'account-3',
    sessionType: 'chat',
    messages: [{ role: 'user', content: 'Old', timestamp: 1 }],
    createdAt: Date.now() - 3600000,
    lastActiveAt: Date.now() - 3600000,
    status: 'active',
    historyHash: computeHistoryHash([{ role: 'user', content: 'Old', timestamp: 1 }]),
  }
  mockSessions.push(oldSession)

  const ctx = getOrCreateSession({
    providerId: 'deepseek',
    accountId: 'account-3',
    messages: [{ role: 'user', content: 'Old', timestamp: 1 }],
  })
  // The old session should be filtered out due to timeout, so a new one is created
  // But with matching hash on a timed-out session, we fall through to getActiveSession
  // which also filters by timeout, so we create new
  assert(ctx.isNew, 'expired session → new session created')
}

// ─── Report ─────────────────────────────────────────────────────────────────────

console.log('')
console.log(`Passed: ${passed.length}`)
console.log(`Failed: ${failed.length}`)
if (failed.length > 0) {
  console.log('')
  for (const f of failed) {
    console.log(`  ${f}`)
  }
  process.exit(1)
} else {
  console.log('All session manager tests passed!')
}
