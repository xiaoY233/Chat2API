/**
 * Management API - Configuration Routes
 * Provides configuration management endpoints
 */

import Router from '@koa/router'
import type { Context } from 'koa'
import { managementAuthMiddleware } from '../../middleware/managementAuth'
import ConfigManager from '../../../store/config'
import type {
  ManagementApiResponse,
  AppConfig,
  ConfigUpdateRequest,
} from '../../../../shared/types'

const router = new Router({ prefix: '/v0/management/config' })

router.use(managementAuthMiddleware)

const SENSITIVE_KEYS = ['managementApiSecret', 'apiKeys', 'credentials']

function maskSensitiveValue(value: unknown, key?: string): unknown {
  if (typeof value === 'string') {
    if (key && SENSITIVE_KEYS.some(k => key.toLowerCase().includes(k.toLowerCase()))) {
      return '***'
    }
    return value
  }

  if (Array.isArray(value)) {
    return value.map((item, index) => {
      if (typeof item === 'object' && item !== null) {
        return maskSensitiveObject(item as Record<string, unknown>)
      }
      return maskSensitiveValue(item)
    })
  }

  if (typeof value === 'object' && value !== null) {
    return maskSensitiveObject(value as Record<string, unknown>)
  }

  return value
}

function maskSensitiveObject(obj: Record<string, unknown>): Record<string, unknown> {
  const masked: Record<string, unknown> = {}

  for (const [key, value] of Object.entries(obj)) {
    if (key === 'key' || key === 'managementApiSecret' || key === 'credentials') {
      masked[key] = '***'
    } else if (key === 'apiKeys' && Array.isArray(value)) {
      masked[key] = value.map(apiKey => ({
        ...apiKey,
        key: '***',
      }))
    } else if (typeof value === 'object' && value !== null) {
      masked[key] = maskSensitiveValue(value, key)
    } else {
      masked[key] = value
    }
  }

  return masked
}

function maskConfig(config: AppConfig): Record<string, unknown> {
  const masked = { ...config } as Record<string, unknown>

  if (masked.managementApi) {
    const managementApi = { ...(masked.managementApi as Record<string, unknown>) }
    managementApi.managementApiSecret = '***'
    masked.managementApi = managementApi
  }

  if (Array.isArray(masked.apiKeys)) {
    masked.apiKeys = masked.apiKeys.map(apiKey => ({
      ...(apiKey as Record<string, unknown>),
      key: '***',
    }))
  }

  return masked
}

router.get('/', async (ctx: Context) => {
  try {
    const config = ConfigManager.get()
    const maskedConfig = maskConfig(config)

    ctx.body = {
      success: true,
      data: maskedConfig,
    } as ManagementApiResponse<Record<string, unknown>>
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error'
    ctx.status = 500
    ctx.body = {
      success: false,
      error: {
        code: 'internal_error',
        message: errorMessage,
      },
    } as ManagementApiResponse
  }
})

router.put('/', async (ctx: Context) => {
  try {
    const updates = ctx.request.body as ConfigUpdateRequest

    if (!updates || typeof updates !== 'object') {
      ctx.status = 400
      ctx.body = {
        success: false,
        error: {
          code: 'invalid_request',
          message: 'Request body must be a valid configuration object',
        },
      } as ManagementApiResponse
      return
    }

    const validation = ConfigManager.validate(updates as Partial<AppConfig>)

    if (!validation.valid) {
      ctx.status = 400
      ctx.body = {
        success: false,
        error: {
          code: 'validation_error',
          message: validation.errors.join('; '),
          details: { errors: validation.errors },
        },
      } as ManagementApiResponse
      return
    }

    const updatedConfig = ConfigManager.update(updates as Partial<AppConfig>)
    const maskedConfig = maskConfig(updatedConfig)

    ctx.body = {
      success: true,
      data: maskedConfig,
    } as ManagementApiResponse<Record<string, unknown>>
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error'
    ctx.status = 500
    ctx.body = {
      success: false,
      error: {
        code: 'internal_error',
        message: errorMessage,
      },
    } as ManagementApiResponse
  }
})

router.get('/:key', async (ctx: Context) => {
  try {
    const key = ctx.params.key as keyof AppConfig

    const config = ConfigManager.get()

    if (!(key in config)) {
      ctx.status = 404
      ctx.body = {
        success: false,
        error: {
          code: 'config_key_not_found',
          message: `Configuration key '${key}' not found`,
        },
      } as ManagementApiResponse
      return
    }

    const value = config[key]
    const maskedValue = maskSensitiveValue(value, key)

    ctx.body = {
      success: true,
      data: maskedValue,
    } as ManagementApiResponse<unknown>
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error'
    ctx.status = 500
    ctx.body = {
      success: false,
      error: {
        code: 'internal_error',
        message: errorMessage,
      },
    } as ManagementApiResponse
  }
})

router.put('/:key', async (ctx: Context) => {
  try {
    const key = ctx.params.key as keyof AppConfig
    const { value } = ctx.request.body as { value: unknown }

    if (value === undefined) {
      ctx.status = 400
      ctx.body = {
        success: false,
        error: {
          code: 'invalid_request',
          message: 'Request body must contain a "value" field',
        },
      } as ManagementApiResponse
      return
    }

    const config = ConfigManager.get()

    if (!(key in config)) {
      ctx.status = 404
      ctx.body = {
        success: false,
        error: {
          code: 'config_key_not_found',
          message: `Configuration key '${key}' not found`,
        },
      } as ManagementApiResponse
      return
    }

    const updates = { [key]: value } as Partial<AppConfig>
    const validation = ConfigManager.validate(updates)

    if (!validation.valid) {
      ctx.status = 400
      ctx.body = {
        success: false,
        error: {
          code: 'validation_error',
          message: validation.errors.join('; '),
          details: { errors: validation.errors },
        },
      } as ManagementApiResponse
      return
    }

    const updatedConfig = ConfigManager.update(updates)
    const maskedValue = maskSensitiveValue(updatedConfig[key], key)

    ctx.body = {
      success: true,
      data: maskedValue,
    } as ManagementApiResponse<unknown>
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error'
    ctx.status = 500
    ctx.body = {
      success: false,
      error: {
        code: 'internal_error',
        message: errorMessage,
      },
    } as ManagementApiResponse
  }
})

export default router
