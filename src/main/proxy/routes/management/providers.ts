/**
 * Management API - Provider Routes
 * Provides CRUD operations for provider management
 */

import Router from '@koa/router'
import type { Context } from 'koa'
import { managementAuthMiddleware } from '../../middleware/managementAuth'
import ProviderManager from '../../../store/providers'
import { BUILTIN_PROVIDERS } from '../../../store/types'
import { CustomProviderManager } from '../../../providers/custom'
import { ProviderChecker } from '../../../providers/checker'
import { getBuiltinProvider } from '../../../providers/builtin'
import { mergeProviderModelCapabilities, parseProviderModelsResponse } from '../../../providers/modelSync'
import { withQwenAiModelModeAliases } from '../../../providers/qwen-ai-model-mode'
import AccountManager from '../../../store/accounts'
import { storeManager } from '../../../store/store'
import axios from 'axios'
import type {
  Provider,
  CreateProviderRequest,
  UpdateProviderRequest,
  ProviderStatusRequest,
  ManagementApiResponse,
} from '../../../../../shared/types'

const router = new Router({ prefix: '/v0/management/providers' })

router.use(managementAuthMiddleware)

function createErrorResponse(code: string, message: string): ManagementApiResponse {
  return {
    success: false,
    error: {
      code,
      message,
    },
  }
}

function createSuccessResponse<T>(data: T): ManagementApiResponse<T> {
  return {
    success: true,
    data,
  }
}

router.get('/', async (ctx: Context) => {
  try {
    const providers = ProviderManager.getAll()

    ctx.set('Content-Type', 'application/json')
    ctx.body = createSuccessResponse(providers)
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Failed to get providers'
    ctx.status = 500
    ctx.body = createErrorResponse('internal_error', errorMessage)
  }
})

router.get('/builtin', async (ctx: Context) => {
  try {
    const builtinProviders = BUILTIN_PROVIDERS.map((provider) => ({
      ...provider,
      credentialFields: provider.credentialFields,
    }))

    ctx.set('Content-Type', 'application/json')
    ctx.body = createSuccessResponse(builtinProviders)
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Failed to get built-in providers'
    ctx.status = 500
    ctx.body = createErrorResponse('internal_error', errorMessage)
  }
})

router.post('/check-all', async (ctx: Context) => {
  try {
    const providers = ProviderManager.getAll()
    const results: Record<string, ProviderCheckResult> = {}

    await Promise.all(providers.map(async (provider) => {
      const result = await ProviderChecker.checkProviderStatus(provider)
      results[provider.id] = result
      ProviderManager.update(provider.id, {
        status: result.status,
        lastStatusCheck: Date.now(),
      })
    }))

    ctx.set('Content-Type', 'application/json')
    ctx.body = createSuccessResponse(results)
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Failed to check provider status'
    ctx.status = 500
    ctx.body = createErrorResponse('internal_error', errorMessage)
  }
})

router.post('/import', async (ctx: Context) => {
  try {
    const body = ctx.request.body as { jsonData?: string }
    if (!body.jsonData) {
      ctx.status = 400
      ctx.body = createErrorResponse('invalid_request', 'Missing required field: jsonData')
      return
    }

    const provider = CustomProviderManager.importProvider(body.jsonData)
    ctx.status = 201
    ctx.set('Content-Type', 'application/json')
    ctx.body = createSuccessResponse(provider)
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Failed to import provider'
    ctx.status = 400
    ctx.body = createErrorResponse('import_failed', errorMessage)
  }
})

router.get('/:id', async (ctx: Context) => {
  try {
    const id = ctx.params.id
    const provider = ProviderManager.getById(id)

    if (!provider) {
      ctx.status = 404
      ctx.body = createErrorResponse('not_found', 'Provider not found')
      return
    }

    ctx.set('Content-Type', 'application/json')
    ctx.body = createSuccessResponse(provider)
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Failed to get provider'
    ctx.status = 500
    ctx.body = createErrorResponse('internal_error', errorMessage)
  }
})

router.post('/:id/check', async (ctx: Context) => {
  try {
    const id = ctx.params.id
    const provider = ProviderManager.getById(id)

    if (!provider) {
      ctx.status = 404
      ctx.body = createErrorResponse('not_found', 'Provider not found')
      return
    }

    const result = await ProviderChecker.checkProviderStatus(provider)
    ProviderManager.update(id, {
      status: result.status,
      lastStatusCheck: Date.now(),
    })

    ctx.set('Content-Type', 'application/json')
    ctx.body = createSuccessResponse(result)
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Failed to check provider status'
    ctx.status = 500
    ctx.body = createErrorResponse('internal_error', errorMessage)
  }
})

router.post('/:id/validate-token', async (ctx: Context) => {
  try {
    const providerId = ctx.params.id
    const body = ctx.request.body as { credentials?: Record<string, string> }
    const credentials = body.credentials || {}

    let provider = ProviderManager.getById(providerId)
    const builtinConfig = getBuiltinProvider(providerId)

    if (!provider && builtinConfig) {
      provider = {
        id: builtinConfig.id,
        name: builtinConfig.name,
        type: 'builtin',
        authType: builtinConfig.authType,
        apiEndpoint: builtinConfig.apiEndpoint,
        chatPath: builtinConfig.chatPath,
        headers: builtinConfig.headers,
        enabled: true,
        description: builtinConfig.description,
        supportedModels: builtinConfig.supportedModels || [],
        modelMappings: builtinConfig.modelMappings || {},
        modelCapabilities: mergeProviderModelCapabilities(
          undefined,
          builtinConfig.modelCapabilities,
        ),
        credentialFields: builtinConfig.credentialFields,
        modelsApiEndpoint: builtinConfig.modelsApiEndpoint,
        modelsApiHeaders: builtinConfig.modelsApiHeaders,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      }
    }

    if (!provider) {
      ctx.status = 404
      ctx.body = createErrorResponse('not_found', 'Provider not found')
      return
    }

    const result = await ProviderChecker.checkAccountToken(provider, {
      id: 'temp',
      providerId,
      name: 'temp',
      credentials,
      status: 'active',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    })

    ctx.set('Content-Type', 'application/json')
    ctx.body = createSuccessResponse(result)
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Failed to validate token'
    ctx.status = 500
    ctx.body = createErrorResponse('internal_error', errorMessage)
  }
})

router.post('/:id/duplicate', async (ctx: Context) => {
  try {
    const provider = CustomProviderManager.duplicate(ctx.params.id)
    ctx.status = 201
    ctx.set('Content-Type', 'application/json')
    ctx.body = createSuccessResponse(provider)
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Failed to duplicate provider'
    ctx.status = errorMessage.includes('not found') ? 404 : 500
    ctx.body = createErrorResponse('duplicate_failed', errorMessage)
  }
})

router.get('/:id/export', async (ctx: Context) => {
  try {
    const json = CustomProviderManager.exportProvider(ctx.params.id)
    ctx.set('Content-Type', 'application/json')
    ctx.body = createSuccessResponse(json)
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Failed to export provider'
    ctx.status = errorMessage.includes('not found') ? 404 : 500
    ctx.body = createErrorResponse('export_failed', errorMessage)
  }
})

router.post('/:id/models/update', async (ctx: Context) => {
  try {
    const providerId = ctx.params.id
    const provider = ProviderManager.getById(providerId)

    if (!provider) {
      ctx.status = 404
      ctx.body = createErrorResponse('not_found', 'Provider not found')
      return
    }

    let modelsApiEndpoint: string | undefined
    let modelsApiHeaders: Record<string, string> | undefined

    if (provider.type === 'builtin') {
      const builtinConfig = getBuiltinProvider(providerId)
      modelsApiEndpoint = builtinConfig?.modelsApiEndpoint
      modelsApiHeaders = builtinConfig?.modelsApiHeaders
    }

    if (!modelsApiEndpoint) {
      ctx.body = createSuccessResponse({
        success: false,
        error: 'This provider does not support dynamic model updates',
      })
      return
    }

    const activeAccount = AccountManager.getByProviderId(providerId, true)
      .find(account => account.status === 'active')

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      ...modelsApiHeaders,
    }

    if (activeAccount?.credentials?.token) {
      headers.Authorization = `Bearer ${activeAccount.credentials.token}`
    }
    if (activeAccount?.credentials?.cookies) {
      headers.Cookie = activeAccount.credentials.cookies
    }

    const response = await axios.get(modelsApiEndpoint, {
      headers,
      timeout: 15000,
      validateStatus: () => true,
    })

    if (response.status !== 200) {
      ctx.body = createSuccessResponse({
        success: false,
        error: `Failed to fetch models: HTTP ${response.status}`,
      })
      return
    }

    const parsedModels = parseProviderModelsResponse(response.data)
    const { supportedModels, modelMappings, modelCapabilities } = providerId === 'qwen-ai'
      ? withQwenAiModelModeAliases(parsedModels)
      : parsedModels
    if (supportedModels.length === 0) {
      ctx.body = createSuccessResponse({
        success: false,
        error: 'No models found in the response',
      })
      return
    }

    const mergedModelCapabilities = mergeProviderModelCapabilities(
      provider.modelCapabilities,
      modelCapabilities,
    )
    ProviderManager.update(providerId, {
      supportedModels,
      modelMappings,
      modelCapabilities: mergedModelCapabilities,
    })

    ctx.set('Content-Type', 'application/json')
    ctx.body = createSuccessResponse({
      success: true,
      modelsCount: supportedModels.length,
    })
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Failed to update models'
    ctx.status = 500
    ctx.body = createErrorResponse('internal_error', errorMessage)
  }
})

router.get('/:id/models/effective', async (ctx: Context) => {
  try {
    ctx.set('Content-Type', 'application/json')
    ctx.body = createSuccessResponse(storeManager.getEffectiveModels(ctx.params.id))
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Failed to get effective models'
    ctx.status = 500
    ctx.body = createErrorResponse('internal_error', errorMessage)
  }
})

router.post('/:id/models/custom', async (ctx: Context) => {
  try {
    const models = storeManager.addCustomModel(ctx.params.id, ctx.request.body as { displayName: string; actualModelId: string })
    ctx.set('Content-Type', 'application/json')
    ctx.body = createSuccessResponse({ success: true, models })
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Failed to add custom model'
    ctx.status = 400
    ctx.body = createSuccessResponse({ success: false, error: errorMessage, models: [] })
  }
})

router.delete('/:id/models/:modelName', async (ctx: Context) => {
  try {
    const models = storeManager.removeModel(ctx.params.id, decodeURIComponent(ctx.params.modelName))
    ctx.set('Content-Type', 'application/json')
    ctx.body = createSuccessResponse({ success: true, models })
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Failed to remove model'
    ctx.status = 400
    ctx.body = createSuccessResponse({ success: false, error: errorMessage, models: [] })
  }
})

router.post('/:id/models/reset', async (ctx: Context) => {
  try {
    const models = storeManager.resetModels(ctx.params.id)
    ctx.set('Content-Type', 'application/json')
    ctx.body = createSuccessResponse({ success: true, models })
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Failed to reset models'
    ctx.status = 400
    ctx.body = createSuccessResponse({ success: false, error: errorMessage, models: [] })
  }
})

router.post('/', async (ctx: Context) => {
  try {
    const request = ctx.request.body as CreateProviderRequest

    if (!request.name || typeof request.name !== 'string') {
      ctx.status = 400
      ctx.body = createErrorResponse('invalid_request', 'Missing required field: name')
      return
    }

    if (!request.authType) {
      ctx.status = 400
      ctx.body = createErrorResponse('invalid_request', 'Missing required field: authType')
      return
    }

    if (!request.apiEndpoint || typeof request.apiEndpoint !== 'string') {
      ctx.status = 400
      ctx.body = createErrorResponse('invalid_request', 'Missing required field: apiEndpoint')
      return
    }

    const provider = ProviderManager.create({
      id: request.id,
      name: request.name,
      type: request.type || 'custom',
      authType: request.authType,
      apiEndpoint: request.apiEndpoint,
      chatPath: request.chatPath,
      headers: request.headers || {},
      description: request.description,
      icon: request.icon,
      supportedModels: request.supportedModels,
      modelMappings: request.modelMappings,
      modelCapabilities: request.modelCapabilities,
      modelsApiEndpoint: request.modelsApiEndpoint,
      modelsApiHeaders: request.modelsApiHeaders,
      credentialFields: request.credentialFields,
    })

    ctx.status = 201
    ctx.set('Content-Type', 'application/json')
    ctx.body = createSuccessResponse(provider)
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Failed to create provider'
    ctx.status = 500
    ctx.body = createErrorResponse('internal_error', errorMessage)
  }
})

router.put('/:id', async (ctx: Context) => {
  try {
    const id = ctx.params.id
    const request = ctx.request.body as UpdateProviderRequest

    const existingProvider = ProviderManager.getById(id)
    if (!existingProvider) {
      ctx.status = 404
      ctx.body = createErrorResponse('not_found', 'Provider not found')
      return
    }

    const updates: Partial<Omit<Provider, 'id' | 'type' | 'createdAt'>> = {}

    if (request.name !== undefined) {
      updates.name = request.name
    }

    if (request.apiEndpoint !== undefined) {
      updates.apiEndpoint = request.apiEndpoint
    }

    if (request.chatPath !== undefined) {
      updates.chatPath = request.chatPath
    }

    if (request.headers !== undefined) {
      updates.headers = request.headers
    }

    if (request.enabled !== undefined) {
      updates.enabled = request.enabled
    }

    if (request.description !== undefined) {
      updates.description = request.description
    }

    if (request.icon !== undefined) {
      updates.icon = request.icon
    }

    if (request.supportedModels !== undefined) {
      updates.supportedModels = request.supportedModels
    }

    if (request.modelMappings !== undefined) {
      updates.modelMappings = request.modelMappings
    }

    if (request.modelCapabilities !== undefined) {
      updates.modelCapabilities = request.modelCapabilities
    }

    const updatedProvider = ProviderManager.update(id, updates)

    if (!updatedProvider) {
      ctx.status = 500
      ctx.body = createErrorResponse('update_failed', 'Failed to update provider')
      return
    }

    ctx.set('Content-Type', 'application/json')
    ctx.body = createSuccessResponse(updatedProvider)
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Failed to update provider'

    if (errorMessage.includes('Built-in providers cannot modify')) {
      ctx.status = 403
      ctx.body = createErrorResponse('forbidden', errorMessage)
      return
    }

    ctx.status = 500
    ctx.body = createErrorResponse('internal_error', errorMessage)
  }
})

router.delete('/:id', async (ctx: Context) => {
  try {
    const id = ctx.params.id

    const deleted = ProviderManager.delete(id)

    if (!deleted) {
      ctx.status = 404
      ctx.body = createErrorResponse('not_found', 'Provider not found')
      return
    }

    ctx.set('Content-Type', 'application/json')
    ctx.body = createSuccessResponse({ id, deleted: true })
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Failed to delete provider'
    ctx.status = 500
    ctx.body = createErrorResponse('internal_error', errorMessage)
  }
})

router.patch('/:id/status', async (ctx: Context) => {
  try {
    const id = ctx.params.id
    const request = ctx.request.body as ProviderStatusRequest

    if (request.enabled === undefined || typeof request.enabled !== 'boolean') {
      ctx.status = 400
      ctx.body = createErrorResponse('invalid_request', 'Missing or invalid required field: enabled (must be boolean)')
      return
    }

    const existingProvider = ProviderManager.getById(id)
    if (!existingProvider) {
      ctx.status = 404
      ctx.body = createErrorResponse('not_found', 'Provider not found')
      return
    }

    const updatedProvider = ProviderManager.update(id, { enabled: request.enabled })

    if (!updatedProvider) {
      ctx.status = 500
      ctx.body = createErrorResponse('update_failed', 'Failed to update provider status')
      return
    }

    ctx.set('Content-Type', 'application/json')
    ctx.body = createSuccessResponse(updatedProvider)
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Failed to update provider status'
    ctx.status = 500
    ctx.body = createErrorResponse('internal_error', errorMessage)
  }
})

export default router
