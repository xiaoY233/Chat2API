/**
 * Management API Authentication Middleware
 * Provides Bearer token authentication for management API endpoints
 */

import type { Context, Next } from 'koa'
import { randomUUID } from 'crypto'
import { storeManager } from '../../store/store'

/**
 * Management API Error Response Interface
 * Follows the error response format defined in spec
 */
export interface ManagementApiErrorResponse {
  success: false
  error: {
    code: string
    message: string
    details?: Record<string, unknown>
  }
}

/**
 * Generate a cryptographically secure management secret
 * Uses UUID v4 format for secure random key generation
 * @returns Generated secret key in format: mgmt_<uuid>
 */
export function generateManagementSecret(): string {
  const uuid = randomUUID()
  return `mgmt_${uuid}`
}

/**
 * Create unauthorized error response
 * @param message - Error message
 * @param code - Error code
 * @returns Error response object
 */
function createUnauthorizedResponse(
  message: string,
  code: string
): ManagementApiErrorResponse {
  return {
    success: false,
    error: {
      code,
      message,
    },
  }
}

/**
 * Extract authentication token from request
 * Supports both Authorization: Bearer <token> and X-Management-Secret header
 * @param ctx - Koa context
 * @returns Extracted token or null
 */
function extractAuthToken(ctx: Context): string | null {
  const authHeader = ctx.get('Authorization')
  if (authHeader) {
    if (authHeader.startsWith('Bearer ')) {
      return authHeader.slice(7).trim()
    }
  }

  const secretHeader = ctx.get('X-Management-Secret')
  if (secretHeader) {
    return secretHeader.trim()
  }

  return null
}

/**
 * Management API Authentication Middleware
 * Validates Bearer token from Authorization header or X-Management-Secret header
 * Compares against managementApiSecret from config
 * Returns 401 Unauthorized for invalid/missing authentication
 */
export async function managementAuthMiddleware(ctx: Context, next: Next): Promise<void> {
  const config = storeManager.getConfig()
  const managementConfig = config.managementApi

  if (!managementConfig.enableManagementApi) {
    ctx.status = 404
    ctx.body = createUnauthorizedResponse(
      'Management API is not enabled',
      'management_api_disabled'
    )
    return
  }

  if (!managementConfig.managementApiSecret) {
    ctx.status = 500
    ctx.body = createUnauthorizedResponse(
      'Management API secret is not configured',
      'management_api_misconfigured'
    )
    return
  }

  const providedToken = extractAuthToken(ctx)

  if (!providedToken) {
    ctx.status = 401
    ctx.body = createUnauthorizedResponse(
      'Authentication required. Provide Authorization: Bearer <secret> or X-Management-Secret header',
      'missing_authentication'
    )
    return
  }

  if (providedToken !== managementConfig.managementApiSecret) {
    ctx.status = 401
    ctx.body = createUnauthorizedResponse(
      'Invalid management API secret',
      'invalid_secret'
    )
    return
  }

  await next()
}

export default managementAuthMiddleware
