/**
 * Management API - Account Routes
 * Provides CRUD operations for account management
 */

import Router from '@koa/router'
import type { Context } from 'koa'
import { managementAuthMiddleware } from '../../middleware/managementAuth'
import AccountManager from '../../../store/accounts'
import ProviderManager from '../../../store/providers'
import { KimiAdapter } from '../../adapters/kimi'
import { QwenAdapter } from '../../adapters/qwen'
import { QwenAiAdapter } from '../../adapters/qwen-ai'
import { MiniMaxAdapter } from '../../adapters/minimax'
import { ZaiAdapter } from '../../adapters/zai'
import { PerplexityAdapter } from '../../adapters/perplexity'
import { DeepSeekAdapter } from '../../adapters/deepseek'
import { GLMAdapter } from '../../adapters/glm'
import { MimoAdapter } from '../../adapters/mimo'
import type { 
  Account, 
  CreateAccountRequest, 
  UpdateAccountRequest,
  ManagementApiResponse,
  ValidationResult 
} from '../../../../../shared/types'

const router = new Router({ prefix: '/v0/management' })

/**
 * Mask sensitive credential fields
 * Replaces all credential values with '***' for security
 */
function maskCredentials(account: Account): Account {
  const maskedCredentials: Record<string, string> = {}
  for (const key of Object.keys(account.credentials)) {
    maskedCredentials[key] = '***'
  }
  
  return {
    ...account,
    credentials: maskedCredentials,
  }
}

function shouldIncludeCredentials(ctx: Context): boolean {
  return ctx.query.includeCredentials === 'true' || ctx.query.includeCredentials === '1'
}

function maybeMask(account: Account, includeCredentials: boolean): Account {
  return includeCredentials ? account : maskCredentials(account)
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
 * GET /v0/management/accounts
 * List all accounts (credentials masked)
 */
router.get('/accounts', managementAuthMiddleware, async (ctx: Context) => {
  try {
    const includeCredentials = shouldIncludeCredentials(ctx)
    const accounts = AccountManager.getAll(includeCredentials)
    const responseAccounts = accounts.map((account) => maybeMask(account, includeCredentials))
    
    ctx.set('Content-Type', 'application/json')
    ctx.body = createSuccessResponse(responseAccounts)
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Failed to get accounts'
    ctx.status = 500
    ctx.body = createErrorResponse('internal_error', errorMessage)
  }
})

/**
 * GET /v0/management/providers/:providerId/accounts
 * List accounts by provider (credentials masked)
 */
router.get('/providers/:providerId/accounts', managementAuthMiddleware, async (ctx: Context) => {
  try {
    const providerId = ctx.params.providerId
    const includeCredentials = shouldIncludeCredentials(ctx)
    const accounts = AccountManager.getByProviderId(providerId, includeCredentials)
    const responseAccounts = accounts.map((account) => maybeMask(account, includeCredentials))
    
    ctx.set('Content-Type', 'application/json')
    ctx.body = createSuccessResponse(responseAccounts)
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Failed to get accounts by provider'
    ctx.status = 500
    ctx.body = createErrorResponse('internal_error', errorMessage)
  }
})

/**
 * GET /v0/management/accounts/:id
 * Get account by ID (credentials masked)
 * Returns 404 if account not found
 */
router.get('/accounts/:id', managementAuthMiddleware, async (ctx: Context) => {
  try {
    const id = ctx.params.id
    const includeCredentials = shouldIncludeCredentials(ctx)
    const account = AccountManager.getById(id, includeCredentials)
    
    if (!account) {
      ctx.status = 404
      ctx.body = createErrorResponse('account_not_found', `Account not found: ${id}`)
      return
    }
    
    ctx.set('Content-Type', 'application/json')
    ctx.body = createSuccessResponse(maybeMask(account, includeCredentials))
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Failed to get account'
    ctx.status = 500
    ctx.body = createErrorResponse('internal_error', errorMessage)
  }
})

/**
 * POST /v0/management/accounts
 * Create new account
 */
router.post('/accounts', managementAuthMiddleware, async (ctx: Context) => {
  try {
    const request = ctx.request.body as CreateAccountRequest
    
    if (!request.providerId) {
      ctx.status = 400
      ctx.body = createErrorResponse('invalid_request', 'Missing required field: providerId')
      return
    }
    
    if (!request.name) {
      ctx.status = 400
      ctx.body = createErrorResponse('invalid_request', 'Missing required field: name')
      return
    }
    
    if (!request.credentials || typeof request.credentials !== 'object') {
      ctx.status = 400
      ctx.body = createErrorResponse('invalid_request', 'Missing or invalid required field: credentials')
      return
    }
    
    const account = AccountManager.create({
      providerId: request.providerId,
      name: request.name,
      email: request.email,
      credentials: request.credentials,
      dailyLimit: request.dailyLimit,
    })
    
    const maskedAccount = maskCredentials(account)
    ctx.status = 201
    ctx.set('Content-Type', 'application/json')
    ctx.body = createSuccessResponse(maskedAccount)
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Failed to create account'
    
    if (errorMessage.includes('not found')) {
      ctx.status = 404
      ctx.body = createErrorResponse('provider_not_found', errorMessage)
    } else {
      ctx.status = 500
      ctx.body = createErrorResponse('internal_error', errorMessage)
    }
  }
})

/**
 * PUT /v0/management/accounts/:id
 * Update account
 */
router.put('/accounts/:id', managementAuthMiddleware, async (ctx: Context) => {
  try {
    const id = ctx.params.id
    const request = ctx.request.body as UpdateAccountRequest
    
    const existingAccount = AccountManager.getById(id, false)
    if (!existingAccount) {
      ctx.status = 404
      ctx.body = createErrorResponse('account_not_found', `Account not found: ${id}`)
      return
    }
    
    const updates: Partial<Omit<Account, 'id' | 'createdAt'>> = {}
    
    if (request.name !== undefined) {
      updates.name = request.name
    }
    
    if (request.email !== undefined) {
      updates.email = request.email
    }
    
    if (request.credentials !== undefined) {
      updates.credentials = request.credentials
    }
    
    if (request.dailyLimit !== undefined) {
      updates.dailyLimit = request.dailyLimit
    }
    
    const updatedAccount = AccountManager.update(id, updates)
    
    if (!updatedAccount) {
      ctx.status = 500
      ctx.body = createErrorResponse('update_failed', 'Failed to update account')
      return
    }
    
    const maskedAccount = maskCredentials(updatedAccount)
    ctx.set('Content-Type', 'application/json')
    ctx.body = createSuccessResponse(maskedAccount)
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Failed to update account'
    ctx.status = 500
    ctx.body = createErrorResponse('internal_error', errorMessage)
  }
})

/**
 * DELETE /v0/management/accounts/:id
 * Delete account
 */
router.delete('/accounts/:id', managementAuthMiddleware, async (ctx: Context) => {
  try {
    const id = ctx.params.id
    
    const deleted = AccountManager.delete(id)
    
    if (!deleted) {
      ctx.status = 404
      ctx.body = createErrorResponse('account_not_found', `Account not found: ${id}`)
      return
    }
    
    ctx.set('Content-Type', 'application/json')
    ctx.body = createSuccessResponse({ id, deleted: true })
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Failed to delete account'
    ctx.status = 500
    ctx.body = createErrorResponse('internal_error', errorMessage)
  }
})

/**
 * POST /v0/management/accounts/:id/validate
 * Validate account credentials
 */
router.post('/accounts/:id/validate', managementAuthMiddleware, async (ctx: Context) => {
  try {
    const id = ctx.params.id
    
    const existingAccount = AccountManager.getById(id, false)
    if (!existingAccount) {
      ctx.status = 404
      ctx.body = createErrorResponse('account_not_found', `Account not found: ${id}`)
      return
    }
    
    const validationResult: ValidationResult = await AccountManager.validate(id)
    
    ctx.set('Content-Type', 'application/json')
    ctx.body = createSuccessResponse(validationResult)
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Failed to validate account'
    ctx.status = 500
    ctx.body = createErrorResponse('internal_error', errorMessage)
  }
})

router.get('/accounts/:id/credits', managementAuthMiddleware, async (ctx: Context) => {
  try {
    const account = AccountManager.getById(ctx.params.id, true)
    if (!account) {
      ctx.status = 404
      ctx.body = createErrorResponse('account_not_found', `Account not found: ${ctx.params.id}`)
      return
    }

    const provider = ProviderManager.getById(account.providerId)
    if (!provider || provider.id !== 'minimax') {
      ctx.body = createSuccessResponse(null)
      return
    }

    const adapter = new MiniMaxAdapter(provider, account)
    ctx.set('Content-Type', 'application/json')
    ctx.body = createSuccessResponse(await adapter.getCredits())
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Failed to get account credits'
    ctx.status = 500
    ctx.body = createErrorResponse('internal_error', errorMessage)
  }
})

router.post('/accounts/:id/clear-chats', managementAuthMiddleware, async (ctx: Context) => {
  try {
    const account = AccountManager.getById(ctx.params.id, true)
    if (!account) {
      ctx.status = 404
      ctx.body = createErrorResponse('account_not_found', `Account not found: ${ctx.params.id}`)
      return
    }

    const provider = ProviderManager.getById(account.providerId)
    if (!provider) {
      ctx.status = 404
      ctx.body = createErrorResponse('provider_not_found', `Provider not found: ${account.providerId}`)
      return
    }

    const clearChatsHandlers: Record<string, () => Promise<boolean>> = {
      kimi: () => new KimiAdapter(provider, account).deleteAllChats(),
      qwen: () => new QwenAdapter(provider, account).deleteAllChats(),
      'qwen-ai': () => new QwenAiAdapter(provider, account).deleteAllChats(),
      minimax: () => new MiniMaxAdapter(provider, account).deleteAllChats(),
      zai: () => new ZaiAdapter(provider, account).deleteAllChats(),
      perplexity: () => new PerplexityAdapter(provider, account).deleteAllChats(),
      deepseek: () => new DeepSeekAdapter(provider, account).deleteAllChats(),
      glm: () => new GLMAdapter(provider, account).deleteAllChats(),
      mimo: () => new MimoAdapter(provider, account).deleteAllChats(),
    }

    const handler = clearChatsHandlers[provider.id]
    if (!handler) {
      ctx.body = createSuccessResponse({
        success: false,
        error: 'This feature is not available for this provider',
      })
      return
    }

    ctx.body = createSuccessResponse({ success: await handler() })
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Failed to clear chats'
    ctx.status = 500
    ctx.body = createSuccessResponse({ success: false, error: errorMessage })
  }
})

export default router
