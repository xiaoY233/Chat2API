/**
 * Management API - Session Routes
 * Provides session management operations
 */

import Router from '@koa/router'
import type { Context } from 'koa'
import { managementAuthMiddleware } from '../../middleware/managementAuth'
import sessionManager from '../../sessionManager'
import type { 
  SessionRecord,
  ManagementApiResponse 
} from '../../../../shared/types'

const router = new Router({ prefix: '/v0/management' })

/**
 * Create error response
 */
function createErrorResponse(code: string, message: string): ManagementApiResponse {
  return {
    success: false,
    error: {
      code,
      message,
    },
  }
}

/**
 * Create success response
 */
function createSuccessResponse<T>(data: T): ManagementApiResponse<T> {
  return {
    success: true,
    data,
  }
}

/**
 * Transform session for API response
 * Omits sensitive or internal fields if needed
 */
function transformSession(session: SessionRecord): SessionRecord {
  return {
    ...session,
  }
}

/**
 * GET /v0/management/sessions
 * List all active sessions
 */
router.get('/sessions', managementAuthMiddleware, async (ctx: Context) => {
  try {
    const sessions = sessionManager.getAllActiveSessions()
    const transformedSessions = sessions.map(transformSession)
    
    ctx.set('Content-Type', 'application/json')
    ctx.body = createSuccessResponse(transformedSessions)
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Failed to get sessions'
    ctx.status = 500
    ctx.body = createErrorResponse('internal_error', errorMessage)
  }
})

/**
 * GET /v0/management/sessions/:id
 * Get session by ID with message history
 */
router.get('/sessions/:id', managementAuthMiddleware, async (ctx: Context) => {
  try {
    const id = ctx.params.id
    const session = sessionManager.getSession(id)
    
    if (!session) {
      ctx.status = 404
      ctx.body = createErrorResponse('session_not_found', `Session not found: ${id}`)
      return
    }
    
    const transformedSession = transformSession(session)
    ctx.set('Content-Type', 'application/json')
    ctx.body = createSuccessResponse(transformedSession)
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Failed to get session'
    ctx.status = 500
    ctx.body = createErrorResponse('internal_error', errorMessage)
  }
})

/**
 * DELETE /v0/management/sessions/:id
 * Delete specific session
 */
router.delete('/sessions/:id', managementAuthMiddleware, async (ctx: Context) => {
  try {
    const id = ctx.params.id
    const session = sessionManager.getSession(id)
    
    if (!session) {
      ctx.status = 404
      ctx.body = createErrorResponse('session_not_found', `Session not found: ${id}`)
      return
    }
    
    const deleted = sessionManager.deleteSession(id)
    
    if (!deleted) {
      ctx.status = 500
      ctx.body = createErrorResponse('delete_failed', `Failed to delete session: ${id}`)
      return
    }
    
    ctx.set('Content-Type', 'application/json')
    ctx.body = createSuccessResponse({ id, deleted: true })
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Failed to delete session'
    ctx.status = 500
    ctx.body = createErrorResponse('internal_error', errorMessage)
  }
})

/**
 * DELETE /v0/management/sessions
 * Clear all sessions (requires confirmation)
 * Body: { confirm: true }
 */
router.delete('/sessions', managementAuthMiddleware, async (ctx: Context) => {
  try {
    const body = ctx.request.body as { confirm?: boolean } | undefined
    
    if (!body || body.confirm !== true) {
      ctx.status = 400
      ctx.body = createErrorResponse('confirmation_required', 'Request body must include { confirm: true } to clear all sessions')
      return
    }
    
    sessionManager.clearAllSessions()
    
    ctx.set('Content-Type', 'application/json')
    ctx.body = createSuccessResponse({ cleared: true })
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Failed to clear sessions'
    ctx.status = 500
    ctx.body = createErrorResponse('internal_error', errorMessage)
  }
})

export default router
