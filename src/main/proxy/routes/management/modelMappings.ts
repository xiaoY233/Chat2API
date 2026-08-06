/**
 * Management API - Model Mapping Routes
 * Provides CRUD operations for model mapping management
 */

import Router from '@koa/router'
import type { Context } from 'koa'
import { managementAuthMiddleware } from '../../middleware/managementAuth'
import ConfigManager from '../../../store/config'
import type {
  ModelMapping,
  CreateModelMappingRequest,
  UpdateModelMappingRequest,
  ManagementApiResponse,
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
 * GET /v0/management/model-mappings
 * List all model mappings
 */
router.get('/model-mappings', managementAuthMiddleware, async (ctx: Context) => {
  try {
    const mappings = ConfigManager.getModelMappings()
    const mappingList = Object.values(mappings)

    ctx.set('Content-Type', 'application/json')
    ctx.body = createSuccessResponse(mappingList)
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Failed to get model mappings'
    ctx.status = 500
    ctx.body = createErrorResponse('internal_error', errorMessage)
  }
})

/**
 * POST /v0/management/model-mappings
 * Create new model mapping
 */
router.post('/model-mappings', managementAuthMiddleware, async (ctx: Context) => {
  try {
    const request = ctx.request.body as CreateModelMappingRequest

    if (!request.requestModel) {
      ctx.status = 400
      ctx.body = createErrorResponse('invalid_request', 'Missing required field: requestModel')
      return
    }

    if (!request.actualModel) {
      ctx.status = 400
      ctx.body = createErrorResponse('invalid_request', 'Missing required field: actualModel')
      return
    }

    const existingMapping = ConfigManager.getModelMapping(request.requestModel)
    if (existingMapping) {
      ctx.status = 409
      ctx.body = createErrorResponse('mapping_exists', `Model mapping already exists: ${request.requestModel}`)
      return
    }

    const mapping: ModelMapping = {
      requestModel: request.requestModel,
      actualModel: request.actualModel,
      preferredProviderId: request.preferredProviderId,
      preferredAccountId: request.preferredAccountId,
    }

    ConfigManager.setModelMapping(mapping)

    ctx.status = 201
    ctx.set('Content-Type', 'application/json')
    ctx.body = createSuccessResponse(mapping)
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Failed to create model mapping'
    ctx.status = 500
    ctx.body = createErrorResponse('internal_error', errorMessage)
  }
})

/**
 * PUT /v0/management/model-mappings/:model
 * Update model mapping
 */
router.put('/model-mappings/:model', managementAuthMiddleware, async (ctx: Context) => {
  try {
    const model = decodeURIComponent(ctx.params.model)
    const request = ctx.request.body as UpdateModelMappingRequest

    const existingMapping = ConfigManager.getModelMapping(model)
    if (!existingMapping) {
      ctx.status = 404
      ctx.body = createErrorResponse('mapping_not_found', `Model mapping not found: ${model}`)
      return
    }

    const updatedMapping: ModelMapping = {
      requestModel: model,
      actualModel: request.actualModel ?? existingMapping.actualModel,
      preferredProviderId: request.preferredProviderId ?? existingMapping.preferredProviderId,
      preferredAccountId: request.preferredAccountId ?? existingMapping.preferredAccountId,
    }

    ConfigManager.setModelMapping(updatedMapping)

    ctx.set('Content-Type', 'application/json')
    ctx.body = createSuccessResponse(updatedMapping)
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Failed to update model mapping'
    ctx.status = 500
    ctx.body = createErrorResponse('internal_error', errorMessage)
  }
})

/**
 * DELETE /v0/management/model-mappings/:model
 * Delete model mapping
 */
router.delete('/model-mappings/:model', managementAuthMiddleware, async (ctx: Context) => {
  try {
    const model = decodeURIComponent(ctx.params.model)

    const deleted = ConfigManager.removeModelMapping(model)

    if (!deleted) {
      ctx.status = 404
      ctx.body = createErrorResponse('mapping_not_found', `Model mapping not found: ${model}`)
      return
    }

    ctx.set('Content-Type', 'application/json')
    ctx.body = createSuccessResponse({ model, deleted: true })
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Failed to delete model mapping'
    ctx.status = 500
    ctx.body = createErrorResponse('internal_error', errorMessage)
  }
})

export default router
