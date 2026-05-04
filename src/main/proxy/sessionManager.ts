/**
 * Session Manager Module
 * Manages conversation sessions for stateless single-turn dialogue
 */

import { createHash } from 'crypto'
import { storeManager } from '../store/store'
import { SessionRecord, SessionConfig, ChatMessage, DEFAULT_SESSION_CONFIG } from '../store/types'

export interface CreateSessionOptions {
  providerId: string
  accountId: string
  model?: string
  sessionType?: 'chat' | 'agent'
  messages?: ChatMessage[]
}

export interface SessionContext {
  sessionId: string
  providerSessionId: string | undefined
  parentMessageId: string | undefined
  messages: ChatMessage[]
  isNew: boolean
}

export function computeHistoryHash(messages: ChatMessage[]): string | undefined {
  if (!messages || messages.length === 0) return undefined

  // Hash the first user message as a stable conversation identifier.
  // This stays constant across all turns, unlike hashing the full prefix.
  const firstUserMsg = messages.find(m => m.role === 'user')
  if (!firstUserMsg) return undefined

  const content = typeof firstUserMsg.content === 'string'
    ? firstUserMsg.content
    : JSON.stringify(firstUserMsg.content)

  return createHash('md5').update(`${firstUserMsg.role}:${content}`).digest('hex')
}

class SessionManagerClass {
  private cleanupInterval: NodeJS.Timeout | null = null

  initialize(): void {
    this.startCleanupScheduler()
    console.log('[SessionManager] Initialized')
  }

  destroy(): void {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval)
      this.cleanupInterval = null
    }
    console.log('[SessionManager] Destroyed')
  }

  private startCleanupScheduler(): void {
    const CLEANUP_INTERVAL_MS = 60 * 1000

    this.cleanupInterval = setInterval(() => {
      this.cleanExpiredSessions()
    }, CLEANUP_INTERVAL_MS)

    console.log('[SessionManager] Cleanup scheduler started, interval: 1 minute')
  }

  getSessionConfig(): SessionConfig {
    return storeManager.getSessionConfig()
  }

  updateSessionConfig(updates: Partial<SessionConfig>): SessionConfig {
    const newConfig = storeManager.updateSessionConfig(updates)
    console.log('[SessionManager] Session config updated:', newConfig)
    return newConfig
  }

  getOrCreateSession(options: CreateSessionOptions): SessionContext {
    const { providerId, accountId, model, messages } = options

    // Compute hash from shared message prefix to find matching sessions
    const hash = computeHistoryHash(messages || [])

    // 1) Look up by history hash — matches an ongoing conversation
    if (hash) {
      const sessions = storeManager.getSessionsByProviderId(providerId)
      const config = this.getSessionConfig()
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

    // 2) Fall back to active session for this provider+account (backward compat)
    const existingSession = this.getActiveSession(providerId, accountId)
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

    // 3) Create a brand-new session
    const newSession = this.createSession({
      providerId,
      accountId,
      model,
      messages: messages || [],
    })

    if (hash) {
      newSession.historyHash = hash
    }

    return {
      sessionId: newSession.id,
      providerSessionId: undefined,
      parentMessageId: undefined,
      messages: newSession.messages,
      isNew: true,
    }
  }

  updateProviderSession(
    sessionId: string,
    providerSessionId: string | undefined,
    parentMessageId: string | undefined,
    messages?: ChatMessage[],
  ): void {
    const session = storeManager.getSessionById(sessionId)
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

  getActiveSession(providerId: string, accountId: string): SessionRecord | undefined {
    const sessions = storeManager.getSessionsByProviderId(providerId)
    const accountSessions = sessions.filter(s => s.accountId === accountId)
    const config = this.getSessionConfig()
    const timeoutMs = config.sessionTimeout * 60 * 1000
    const now = Date.now()
    
    return accountSessions.find(s => 
      s.status === 'active' && 
      (now - s.lastActiveAt) < timeoutMs
    )
  }

  createSession(options: CreateSessionOptions): SessionRecord {
    const { providerId, accountId, model, sessionType = 'chat', messages } = options
    const now = Date.now()

    const session: SessionRecord = {
      id: this.generateSessionId(),
      providerId,
      accountId,
      sessionType,
      messages: messages || [],
      createdAt: now,
      lastActiveAt: now,
      status: 'active',
      model,
    }
    
    storeManager.addSession(session)
    return session
  }

  getSession(sessionId: string): SessionRecord | undefined {
    return storeManager.getSessionById(sessionId)
  }

  getAllActiveSessions(): SessionRecord[] {
    return storeManager.getActiveSessions()
  }

  getAllSessions(): SessionRecord[] {
    return storeManager.getSessions()
  }

  deleteSession(sessionId: string): boolean {
    const result = storeManager.deleteSession(sessionId)
    if (result) {
      console.log('[SessionManager] Deleted session:', sessionId)
    }
    return result
  }

  cleanExpiredSessions(): number {
    const removedCount = storeManager.cleanExpiredSessions()
    if (removedCount > 0) {
      console.log('[SessionManager] Cleaned expired sessions:', removedCount)
    }
    return removedCount
  }

  clearAllSessions(): void {
    storeManager.clearAllSessions()
    console.log('[SessionManager] Cleared all sessions')
  }

  getSessionsByAccount(accountId: string): SessionRecord[] {
    return storeManager.getSessionsByAccountId(accountId)
  }

  getSessionsByProvider(providerId: string): SessionRecord[] {
    return storeManager.getSessionsByProviderId(providerId)
  }

  shouldDeleteAfterChat(): boolean {
    const config = this.getSessionConfig()
    return config.deleteAfterTimeout
  }

  private generateSessionId(): string {
    return `session-${Date.now()}-${Math.random().toString(36).substring(2, 11)}`
  }
}

export const sessionManager = new SessionManagerClass()
export default sessionManager
