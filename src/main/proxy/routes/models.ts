/**
 * Proxy Service Module - Models Route
 * Implements /v1/models route
 */

import Router from '@koa/router'
import type { Context } from 'koa'
import { ModelsResponse, ModelInfo } from '../types'
import { loadBalancer } from '../loadbalancer'
import { storeManager } from '../../store/store'

const router = new Router({ prefix: '/v1' })

/**
 * Get all available models
 */
router.get('/models', async (ctx: Context) => {
  const providers = storeManager.getProviders().filter(p => p.enabled)
  const models: ModelInfo[] = []
  const addedModels = new Set<string>()

  for (const provider of providers) {
    const accounts = storeManager.getAccountsByProviderId(provider.id)
      .filter(account => account.status === 'active')

    if (accounts.length === 0) {
      continue
    }

    if (provider.supportedModels && provider.supportedModels.length > 0) {
      for (const modelId of provider.supportedModels) {
        if (!addedModels.has(modelId)) {
          addedModels.add(modelId)
          models.push({
            id: modelId,
            object: 'model',
            created: Math.floor(provider.createdAt / 1000),
            owned_by: provider.name,
          })
        }
      }
    }
  }

  const response: ModelsResponse = {
    object: 'list',
    data: models,
  }

  ctx.set('Content-Type', 'application/json')
  ctx.body = response
})

/**
 * Get specified model info
 */
router.get('/models/:model', async (ctx: Context) => {
  const modelId = ctx.params.model

  const providers = storeManager.getProviders().filter(p => p.enabled)

  for (const provider of providers) {
    const accounts = storeManager.getAccountsByProviderId(provider.id)
      .filter(account => account.status === 'active')

    if (accounts.length === 0) {
      continue
    }

    if (provider.supportedModels) {
      const normalizedModelId = modelId.toLowerCase()
      const found = provider.supportedModels.some(m => {
        const normalizedSupported = m.toLowerCase()
        if (normalizedSupported.endsWith('*')) {
          return normalizedModelId.startsWith(normalizedSupported.slice(0, -1))
        }
        return normalizedSupported === normalizedModelId
      })

      if (found) {
        ctx.set('Content-Type', 'application/json')
        ctx.body = {
          id: modelId,
          object: 'model',
          created: Math.floor(provider.createdAt / 1000),
          owned_by: provider.name,
        }
        return
      }
    }
  }

  ctx.status = 404
  ctx.body = {
    error: {
      message: `Model '${modelId}' not found`,
      type: 'invalid_request_error',
      param: 'model',
      code: 'model_not_found',
    },
  }
})

export default router
