/**
 * Management API - API Key Routes
 * Provides CRUD operations for API key management
 */

import Router from '@koa/router'
import type { Context } from 'koa'
import { randomUUID } from 'crypto'
import { managementAuthMiddleware } from '../../middleware/managementAuth'
import { storeManager } from '../../../store/store'
import type { 
  ApiKey,
  CreateApiKeyRequest,
  UpdateApiKeyRequest,
  ManagementApiResponse 
} from '../../../../shared/types'

const router = new Router({ prefix: '/v0/management' })

const API_KEY_PREFIX = 'sk-mgmt-'
const KEY_RANDOM_LENGTH = 32

/**
 * Generate a new API key value
 * Format: sk-mgmt-{random-string}
 */
function generateApiKeyValue(): string {
  const randomBytes = new Uint8Array(KEY_RANDOM_LENGTH)
  crypto.getRandomValues(randomBytes)
  const randomString = Array.from(randomBytes)
    .map(b => b.toString(16).padStart(2, '0'))
    .join('')
    .slice(0, KEY_RANDOM_LENGTH)
  return `${API_KEY_PREFIX}${randomString}`
}

/**
 * Mask API key value for display
 * Shows only the last 8 characters
 */
function maskApiKey(key: ApiKey): ApiKey {
  const maskedKey = key.key.length > 8 
    ? `${API_KEY_PREFIX}...${key.key.slice(-8)}`
    : `${API_KEY_PREFIX}...`
  
  return {
    ...key,
    key: maskedKey,
  }
}

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
 * GET /v0/management/api-keys
 * List all API keys (key values masked)
 */
router.get('/api-keys', managementAuthMiddleware, async (ctx: Context) => {
  try {
    const config = storeManager.getConfig()
    const apiKeys = config.apiKeys || []
    const maskedKeys = apiKeys.map(maskApiKey)
    
    ctx.set('Content-Type', 'application/json')
    ctx.body = createSuccessResponse(maskedKeys)
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Failed to get API keys'
    ctx.status = 500
    ctx.body = createErrorResponse('internal_error', errorMessage)
  }
})

/**
 * POST /v0/management/api-keys
 * Create new API key
 * Returns the full key value - only shown once!
 */
router.post('/api-keys', managementAuthMiddleware, async (ctx: Context) => {
  try {
    const request = ctx.request.body as CreateApiKeyRequest
    
    if (!request.name || typeof request.name !== 'string' || request.name.trim() === '') {
      ctx.status = 400
      ctx.body = createErrorResponse('invalid_request', 'Missing required field: name')
      return
    }
    
    const config = storeManager.getConfig()
    const apiKeys = config.apiKeys || []
    
    const newKey: ApiKey = {
      id: randomUUID(),
      name: request.name.trim(),
      key: generateApiKeyValue(),
      enabled: true,
      createdAt: Date.now(),
      usageCount: 0,
      description: request.description?.trim(),
    }
    
    apiKeys.push(newKey)
    
    storeManager.updateConfig({ apiKeys })
    
    storeManager.addLog('info', `Created API key: ${newKey.name}`, {
      data: { keyId: newKey.id },
    })
    
    ctx.status = 201
    ctx.set('Content-Type', 'application/json')
    ctx.body = createSuccessResponse(newKey)
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Failed to create API key'
    ctx.status = 500
    ctx.body = createErrorResponse('internal_error', errorMessage)
  }
})

/**
 * PUT /v0/management/api-keys/:id
 * Update API key metadata (name, description, enabled)
 */
router.put('/api-keys/:id', managementAuthMiddleware, async (ctx: Context) => {
  try {
    const id = ctx.params.id
    const request = ctx.request.body as UpdateApiKeyRequest
    
    const config = storeManager.getConfig()
    const apiKeys = config.apiKeys || []
    const keyIndex = apiKeys.findIndex(k => k.id === id)
    
    if (keyIndex === -1) {
      ctx.status = 404
      ctx.body = createErrorResponse('api_key_not_found', `API key not found: ${id}`)
      return
    }
    
    const existingKey = apiKeys[keyIndex]
    
    if (request.name !== undefined) {
      if (typeof request.name !== 'string' || request.name.trim() === '') {
        ctx.status = 400
        ctx.body = createErrorResponse('invalid_request', 'Invalid field: name must be a non-empty string')
        return
      }
      existingKey.name = request.name.trim()
    }
    
    if (request.description !== undefined) {
      existingKey.description = request.description?.trim()
    }
    
    if (request.enabled !== undefined) {
      if (typeof request.enabled !== 'boolean') {
        ctx.status = 400
        ctx.body = createErrorResponse('invalid_request', 'Invalid field: enabled must be a boolean')
        return
      }
      existingKey.enabled = request.enabled
    }
    
    apiKeys[keyIndex] = existingKey
    
    storeManager.updateConfig({ apiKeys })
    
    storeManager.addLog('info', `Updated API key: ${existingKey.name}`, {
      data: { keyId: id },
    })
    
    const maskedKey = maskApiKey(existingKey)
    ctx.set('Content-Type', 'application/json')
    ctx.body = createSuccessResponse(maskedKey)
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Failed to update API key'
    ctx.status = 500
    ctx.body = createErrorResponse('internal_error', errorMessage)
  }
})

/**
 * DELETE /v0/management/api-keys/:id
 * Delete API key
 */
router.delete('/api-keys/:id', managementAuthMiddleware, async (ctx: Context) => {
  try {
    const id = ctx.params.id
    
    const config = storeManager.getConfig()
    const apiKeys = config.apiKeys || []
    const keyIndex = apiKeys.findIndex(k => k.id === id)
    
    if (keyIndex === -1) {
      ctx.status = 404
      ctx.body = createErrorResponse('api_key_not_found', `API key not found: ${id}`)
      return
    }
    
    const deletedKey = apiKeys[keyIndex]
    apiKeys.splice(keyIndex, 1)
    
    storeManager.updateConfig({ apiKeys })
    
    storeManager.addLog('info', `Deleted API key: ${deletedKey.name}`, {
      data: { keyId: id },
    })
    
    ctx.set('Content-Type', 'application/json')
    ctx.body = createSuccessResponse({ id, deleted: true })
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Failed to delete API key'
    ctx.status = 500
    ctx.body = createErrorResponse('internal_error', errorMessage)
  }
})

/**
 * POST /v0/management/api-keys/:id/regenerate
 * Generate new key value for existing key
 * Returns the new key value - only shown once!
 */
router.post('/api-keys/:id/regenerate', managementAuthMiddleware, async (ctx: Context) => {
  try {
    const id = ctx.params.id
    
    const config = storeManager.getConfig()
    const apiKeys = config.apiKeys || []
    const keyIndex = apiKeys.findIndex(k => k.id === id)
    
    if (keyIndex === -1) {
      ctx.status = 404
      ctx.body = createErrorResponse('api_key_not_found', `API key not found: ${id}`)
      return
    }
    
    const existingKey = apiKeys[keyIndex]
    const newKeyValue = generateApiKeyValue()
    
    existingKey.key = newKeyValue
    existingKey.usageCount = 0
    
    apiKeys[keyIndex] = existingKey
    
    storeManager.updateConfig({ apiKeys })
    
    storeManager.addLog('info', `Regenerated API key: ${existingKey.name}`, {
      data: { keyId: id },
    })
    
    ctx.set('Content-Type', 'application/json')
    ctx.body = createSuccessResponse(existingKey)
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Failed to regenerate API key'
    ctx.status = 500
    ctx.body = createErrorResponse('internal_error', errorMessage)
  }
})

export default router
