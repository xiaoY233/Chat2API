/**
 * Session Manager Module
 * Manages conversation sessions for stateless single-turn dialogue
 */

import { storeManager } from '../store/store'
import { SessionRecord, SessionConfig, ChatMessage, DEFAULT_SESSION_CONFIG } from '../store/types'

export interface CreateSessionOptions {
  providerId: string
  accountId: string
  model?: string
  sessionType?: 'chat' | 'agent'
}

export interface SessionContext {
  sessionId: string
  providerSessionId: string | undefined
  parentMessageId: string | undefined
  messages: ChatMessage[]
  isNew: boolean
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
    const { providerId, accountId, model } = options
    const sessionConfig = this.getSessionConfig()
    
    if (sessionConfig.mode === 'single') {
      return {
        sessionId: '',
        providerSessionId: undefined,
        parentMessageId: undefined,
        messages: [],
        isNew: true,
      }
    }
    
    const existingSession = this.getActiveSession(providerId, accountId)
    
    if (existingSession) {
      return {
        sessionId: existingSession.id,
        providerSessionId: existingSession.providerSessionId,
        parentMessageId: existingSession.parentMessageId,
        messages: existingSession.messages,
        isNew: false,
      }
    }
    
    const newSession = this.createSession({
      providerId,
      accountId,
      model,
    })
    
    return {
      sessionId: newSession.id,
      providerSessionId: newSession.providerSessionId,
      parentMessageId: newSession.parentMessageId,
      messages: newSession.messages,
      isNew: true,
    }
  }

  createSession(options: CreateSessionOptions): SessionRecord {
    const { providerId, accountId, model, sessionType = 'chat' } = options
    const now = Date.now()
    
    const session: SessionRecord = {
      id: this.generateSessionId(),
      providerId,
      accountId,
      providerSessionId: '',
      sessionType,
      messages: [],
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

  getActiveSession(providerId: string, accountId: string): SessionRecord | undefined {
    return storeManager.getActiveSessionByProviderAccount(providerId, accountId)
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

  deleteSessionByProviderSessionId(providerSessionId: string): boolean {
    const sessions = storeManager.getSessions()
    const session = sessions.find(s => s.providerSessionId === providerSessionId)
    if (session) {
      return this.deleteSession(session.id)
    }
    return false
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
    return config.mode === 'single' && config.deleteAfterTimeout
  }

  private generateSessionId(): string {
    return `session-${Date.now()}-${Math.random().toString(36).substring(2, 11)}`
  }
}

export const sessionManager = new SessionManagerClass()
export default sessionManager
