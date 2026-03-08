/**
 * Session Manager Module
 * Manages conversation sessions for multi-turn dialogue support
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

  isMultiTurnEnabled(): boolean {
    const config = this.getSessionConfig()
    return config.mode === 'multi'
  }

  getOrCreateSession(options: CreateSessionOptions): SessionContext {
    const { providerId, accountId, model, sessionType = 'chat' } = options
    const config = this.getSessionConfig()

    if (config.mode === 'single') {
      // For single-turn mode, don't create session record
      // Each request is independent, no need to track sessions
      return {
        sessionId: '',  // Empty session ID indicates no session tracking
        providerSessionId: undefined,
        parentMessageId: undefined,
        messages: [],
        isNew: true,
      }
    }

    const existingSession = storeManager.getActiveSessionByProviderAccount(providerId, accountId)
    
    if (existingSession) {
      // Check if max messages per session reached
      if (existingSession.messages.length >= config.maxMessagesPerSession) {
        console.log('[SessionManager] Max messages per session reached, creating new session:', {
          currentCount: existingSession.messages.length,
          maxMessages: config.maxMessagesPerSession,
        })
        // Mark old session as expired and create new one
        storeManager.updateSession(existingSession.id, { status: 'expired' })
        
        const newSession = this.createSession({
          providerId,
          accountId,
          model,
          sessionType,
        })
        
        console.log('[SessionManager] Created new session after max messages:', newSession.id)
        
        return {
          sessionId: newSession.id,
          providerSessionId: undefined,
          parentMessageId: undefined,
          messages: [],
          isNew: true,
        }
      }
      
      console.log('[SessionManager] Found existing session:', {
        sessionId: existingSession.id,
        providerSessionId: existingSession.providerSessionId,
        parentMessageId: existingSession.parentMessageId,
        messageCount: existingSession.messages.length,
      })
      return {
        sessionId: existingSession.id,
        providerSessionId: existingSession.providerSessionId,
        parentMessageId: existingSession.parentMessageId,
        messages: existingSession.messages,
        isNew: false,
      }
    }

    const sessionsByAccount = storeManager.getSessionsByAccountId(accountId)
    const activeSessionsByAccount = sessionsByAccount.filter(s => s.status === 'active')
    
    if (activeSessionsByAccount.length >= config.maxSessionsPerAccount) {
      const oldestSession = activeSessionsByAccount.sort((a, b) => a.lastActiveAt - b.lastActiveAt)[0]
      storeManager.deleteSession(oldestSession.id)
      console.log('[SessionManager] Removed oldest session to make room:', oldestSession.id)
    }

    const newSession = this.createSession({
      providerId,
      accountId,
      model,
      sessionType,
    })

    console.log('[SessionManager] Created new multi-turn session:', newSession.id)
    
    return {
      sessionId: newSession.id,
      providerSessionId: undefined,
      parentMessageId: undefined,
      messages: [],
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

  updateProviderSessionId(
    sessionId: string, 
    providerSessionId: string, 
    parentMessageId?: string
  ): SessionRecord | null {
    if (!sessionId) return null
    
    const session = storeManager.updateProviderSessionId(sessionId, providerSessionId, parentMessageId)
    if (session) {
      console.log('[SessionManager] Updated provider session ID:', {
        sessionId,
        providerSessionId,
        parentMessageId,
      })
    }
    return session
  }

  updateParentMessageId(sessionId: string, parentMessageId: string): SessionRecord | null {
    if (!sessionId) return null
    
    const session = storeManager.updateParentMessageId(sessionId, parentMessageId)
    if (session) {
      console.log('[SessionManager] Updated parent message ID:', {
        sessionId,
        parentMessageId,
      })
    }
    return session
  }

  addMessage(sessionId: string, message: ChatMessage): SessionRecord | null {
    if (!sessionId) return null
    
    const session = storeManager.addMessageToSession(sessionId, message)
    if (session) {
      console.log('[SessionManager] Added message to session:', {
        sessionId,
        role: message.role,
        contentLength: typeof message.content === 'string' 
          ? message.content.length 
          : JSON.stringify(message.content).length,
      })
    }
    return session
  }

  addMessages(sessionId: string, messages: ChatMessage[]): SessionRecord | null {
    if (!sessionId) return null
    
    let session: SessionRecord | null = null
    for (const message of messages) {
      session = this.addMessage(sessionId, message)
    }
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
    // Only delete after chat in single-turn mode with deleteAfterTimeout enabled
    // In multi-turn mode, sessions are deleted by timeout cleaner
    return config.mode === 'single' && config.deleteAfterTimeout
  }

  private generateSessionId(): string {
    return `session-${Date.now()}-${Math.random().toString(36).substring(2, 11)}`
  }
}

export const sessionManager = new SessionManagerClass()
export default sessionManager
