/**
 * Management API - Statistics and Monitoring Routes
 * Provides statistics, health status, and log endpoints
 */

import Router from '@koa/router'
import type { Context } from 'koa'
import { managementAuthMiddleware } from '../../middleware/managementAuth'
import { proxyStatusManager } from '../../status'
import { storeManager } from '../../../store/store'
import { createAdapter } from '../../../oauth/adapters'
import { getRuntime } from '../../../runtime'
import { generateManagementSecret } from '../../middleware/managementAuth'
import type {
  ManagementApiResponse,
  StatisticsResponse,
  HealthCheckResponse,
  ProxyStatusResponse,
  LogEntry,
  LogLevel,
  SystemPrompt,
} from '../../../../shared/types'
import type { RequestLogEntry } from '../../../store/types'
import type { ProviderType } from '../../../oauth/types'

const router = new Router({ prefix: '/v0/management' })

const BROWSER_IMPORT_RESULT_TTL_MS = 10 * 60 * 1000
const BROWSER_IMPORT_RESULT_LIMIT = 128
const BROWSER_IMPORT_RATE_WINDOW_MS = 60 * 1000
const BROWSER_IMPORT_RATE_LIMIT = 32

type BrowserImportProviderId = 'qwen' | 'qwen-ai' | 'kimi'

type BrowserImportResult = {
  importId: string
  providerId: BrowserImportProviderId
  status: 'success' | 'error'
  credentials: Record<string, string>
  error?: string
  createdAt: number
  expiresAt: number
}

const browserImportResults = new Map<string, BrowserImportResult>()
const browserImportSubmissionRates = new Map<string, { startedAt: number; count: number }>()

class BrowserImportRateLimitError extends Error {
  constructor() {
    super('Too many browser import submissions; try again later')
    this.name = 'BrowserImportRateLimitError'
  }
}

function getBrowserImportClientKey(ctx: Context): string {
  // Do not trust client-controlled forwarding headers here.  The Docker
  // server does not enable Koa's proxy mode by default, so `ctx.ip` is the
  // peer address that actually opened the connection.  A reverse proxy can
  // opt into trusted proxy handling at the application boundary instead of
  // allowing every browser to bypass this limiter by rotating X-Forwarded-For.
  return ctx.ip || ctx.req.socket.remoteAddress || 'unknown'
}

function enforceBrowserImportRateLimit(ctx: Context): void {
  const now = Date.now()
  browserImportSubmissionRates.forEach((entry, key) => {
    if (now - entry.startedAt >= BROWSER_IMPORT_RATE_WINDOW_MS) {
      browserImportSubmissionRates.delete(key)
    }
  })

  const key = getBrowserImportClientKey(ctx)
  const current = browserImportSubmissionRates.get(key)
  if (!current || now - current.startedAt >= BROWSER_IMPORT_RATE_WINDOW_MS) {
    browserImportSubmissionRates.set(key, { startedAt: now, count: 1 })
    return
  }

  if (current.count >= BROWSER_IMPORT_RATE_LIMIT) {
    throw new BrowserImportRateLimitError()
  }

  browserImportSubmissionRates.set(key, {
    ...current,
    count: current.count + 1,
  })
}

function cleanupBrowserImportResults(): void {
  const now = Date.now()
  browserImportResults.forEach((result, id) => {
    if (result.expiresAt <= now) {
      browserImportResults.delete(id)
    }
  })

  if (browserImportResults.size > BROWSER_IMPORT_RESULT_LIMIT) {
    const overflow = browserImportResults.size - BROWSER_IMPORT_RESULT_LIMIT
    const oldestIds = Array.from(browserImportResults.entries())
      .sort(([, left], [, right]) => left.createdAt - right.createdAt)
      .slice(0, overflow)
      .map(([id]) => id)

    oldestIds.forEach((id) => browserImportResults.delete(id))
  }
}

function parseBrowserImportBody(body: unknown): Record<string, unknown> {
  if (typeof body === 'string') {
    try {
      return JSON.parse(body) as Record<string, unknown>
    } catch {
      return {}
    }
  }
  return body && typeof body === 'object' ? body as Record<string, unknown> : {}
}

const MAX_BROWSER_IMPORT_PAYLOAD_BYTES = 128 * 1024

function normalizeBrowserImportCredentials(
  providerId: BrowserImportProviderId,
  credentials: Record<string, unknown>,
): Record<string, string> {
  if (providerId === 'kimi') {
    const refreshToken = String(credentials.refreshToken || credentials.refresh_token || '')
    const token = String(credentials.accessToken || credentials.access_token || credentials.token || credentials.kimiAuth || credentials['kimi-auth'] || refreshToken || '')
    const tokenField: Record<string, string> = { token: token }
    const deviceId = String(
      credentials.deviceId
      || credentials.device_id
      || credentials.webId
      || credentials.web_id
      || '',
    )
    const sessionId = String(credentials.sessionId || credentials.session_id || credentials.ssid || '')
    const trafficId = String(
      credentials.trafficId
      || credentials.traffic_id
      || credentials.userId
      || credentials.user_id
      || credentials.mshUserId
      || credentials.msh_user_id
      || '',
    )

    return {
      ...tokenField,
      ...(refreshToken ? { refreshToken } : {}),
      ...(deviceId ? { deviceId } : {}),
      ...(sessionId ? { sessionId } : {}),
      ...(trafficId ? { trafficId } : {}),
    }
  }

  if (providerId === 'qwen-ai') {
    return {
      token: String(credentials.token || ''),
      cookies: String(credentials.cookies || ''),
      baxiaUidToken: String(credentials.baxiaUidToken || credentials.baxia_uid_token || credentials.uidToken || ''),
      baxiaUa: String(credentials.baxiaUa || credentials.baxia_ua || credentials.bxUa || credentials.bx_ua || ''),
      baxiaVersion: String(credentials.baxiaVersion || credentials.baxia_version || credentials.bxV || credentials.bx_v || ''),
      x5secdata: String(credentials.x5secdata || ''),
      x5sectag: String(credentials.x5sectag || ''),
    }
  }

  const ticket = String(credentials.ticket || credentials.tongyi_sso_ticket || '')
  return {
    ticket,
    tongyi_sso_ticket: ticket,
  }
}

function setBrowserImportResult(input: {
  importId: string
  providerId: string
  credentials?: Record<string, unknown>
  error?: string
}): BrowserImportResult {
  cleanupBrowserImportResults()

  if (!input.importId || input.importId.length < 16 || input.importId.length > 128) {
    throw new Error('importId must be between 16 and 128 characters')
  }

  if (input.providerId !== 'qwen' && input.providerId !== 'qwen-ai' && input.providerId !== 'kimi') {
    throw new Error('Unsupported browser import provider')
  }

  if (browserImportResults.has(input.importId)) {
    throw new Error('importId has already been used')
  }

  const credentials = normalizeBrowserImportCredentials(
    input.providerId,
    input.credentials || {},
  )
  const error = String(input.error || '')
  const now = Date.now()
  const result: BrowserImportResult = {
    importId: input.importId,
    providerId: input.providerId,
    status: error ? 'error' : 'success',
    credentials,
    error: error || undefined,
    createdAt: now,
    expiresAt: now + BROWSER_IMPORT_RESULT_TTL_MS,
  }

  browserImportResults.set(input.importId, result)
  return result
}

router.post('/browser-import/complete', async (ctx: Context) => {
  const body = parseBrowserImportBody(ctx.request.body)

  // Body-parser runs before this route, but reject oversized parsed payloads
  // as well so chunked requests cannot smuggle unbounded credential blobs
  // into the in-memory import result store.
  const bodySize = Buffer.byteLength(JSON.stringify(body), 'utf8')
  if (bodySize > MAX_BROWSER_IMPORT_PAYLOAD_BYTES) {
    ctx.status = 413
    ctx.body = {
      success: false,
      error: {
        code: 'browser_import_payload_too_large',
        message: `Browser import payload exceeds ${MAX_BROWSER_IMPORT_PAYLOAD_BYTES} bytes`,
      },
    } as ManagementApiResponse
    return
  }

  try {
    enforceBrowserImportRateLimit(ctx)
    const result = setBrowserImportResult({
      importId: String(body.importId || ''),
      providerId: String(body.providerId || ''),
      credentials: parseBrowserImportBody(body.credentials) as Record<string, unknown>,
      error: String(body.error || ''),
    })

    ctx.body = {
      success: true,
      data: {
        status: result.status,
        providerId: result.providerId,
      },
    } as ManagementApiResponse
  } catch (error) {
    ctx.status = error instanceof BrowserImportRateLimitError ? 429 : 400
    ctx.body = {
      success: false,
      error: {
        code: 'invalid_browser_import',
        message: error instanceof Error ? error.message : 'Invalid browser import payload',
      },
    } as ManagementApiResponse
  }
})

router.use(managementAuthMiddleware)

router.get('/browser-import/:importId', async (ctx: Context) => {
  cleanupBrowserImportResults()
  const importId = String(ctx.params.importId || '')
  const result = browserImportResults.get(importId)

  ctx.body = {
    success: true,
    data: result || null,
  } as ManagementApiResponse<BrowserImportResult | null>
})

router.get('/statistics', async (ctx: Context) => {
  try {
    const proxyStats = proxyStatusManager.getStatistics()
    const persistentStats = storeManager.getStatistics()
    const todayStats = storeManager.getTodayStatistics()

    const response: StatisticsResponse = {
      totalRequests: persistentStats.totalRequests,
      successRequests: persistentStats.successRequests,
      failedRequests: persistentStats.failedRequests,
      avgLatency:
        persistentStats.successRequests > 0
          ? persistentStats.totalLatency / persistentStats.successRequests
          : 0,
      requestsPerMinute: proxyStats.requestsPerMinute,
      activeConnections: proxyStats.activeConnections,
      modelUsage: persistentStats.modelUsage,
      providerUsage: persistentStats.providerUsage,
      accountUsage: persistentStats.accountUsage,
      dailyStats: {
        [todayStats.date]: {
          totalRequests: todayStats.totalRequests,
          successRequests: todayStats.successRequests,
          failedRequests: todayStats.failedRequests,
        },
      },
    }

    ctx.body = {
      success: true,
      data: response,
    } as ManagementApiResponse<StatisticsResponse>
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

router.get('/statistics/persistent', async (ctx: Context) => {
  try {
    ctx.body = {
      success: true,
      data: storeManager.getStatistics(),
    } as ManagementApiResponse
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error'
    ctx.status = 500
    ctx.body = {
      success: false,
      error: { code: 'internal_error', message: errorMessage },
    } as ManagementApiResponse
  }
})

router.get('/statistics/today', async (ctx: Context) => {
  try {
    ctx.body = {
      success: true,
      data: storeManager.getTodayStatistics(),
    } as ManagementApiResponse
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error'
    ctx.status = 500
    ctx.body = {
      success: false,
      error: { code: 'internal_error', message: errorMessage },
    } as ManagementApiResponse
  }
})

router.get('/proxy/statistics', async (ctx: Context) => {
  try {
    const stats = proxyStatusManager.getStatistics()
    ctx.body = {
      success: true,
      data: {
        totalRequests: stats.totalRequests,
        successRequests: stats.successRequests,
        failedRequests: stats.failedRequests,
        avgLatency: stats.avgLatency,
        requestsPerMinute: stats.requestsPerMinute,
        activeConnections: stats.activeConnections,
        modelUsage: stats.modelUsage,
        providerUsage: stats.providerUsage,
        accountUsage: stats.accountUsage,
      },
    } as ManagementApiResponse
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error'
    ctx.status = 500
    ctx.body = {
      success: false,
      error: { code: 'internal_error', message: errorMessage },
    } as ManagementApiResponse
  }
})

router.get('/health', async (ctx: Context) => {
  try {
    const runningStatus = proxyStatusManager.getRunningStatus()
    const config = storeManager.getConfig()
    const proxyConfig = proxyStatusManager.getConfig()

    const proxyStatus: ProxyStatusResponse = {
      isRunning: runningStatus.isRunning,
      port: proxyConfig.port,
      host: proxyConfig.host,
      uptime: runningStatus.uptime,
      connections: proxyStatusManager.getStatistics().activeConnections,
    }

    const healthStatus: HealthCheckResponse = {
      status: runningStatus.isRunning ? 'healthy' : 'unhealthy',
      version: process.env.npm_package_version || '1.0.0',
      uptime: runningStatus.uptime,
      timestamp: Date.now(),
      components: {
        proxy: runningStatus.isRunning ? 'up' : 'down',
        database: 'up',
        managementApi: config.managementApi.enableManagementApi ? 'up' : 'down',
      },
    }

    ctx.body = {
      success: true,
      data: {
        health: healthStatus,
        proxy: proxyStatus,
      },
    } as ManagementApiResponse<{
      health: HealthCheckResponse
      proxy: ProxyStatusResponse
    }>
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

interface LogsQueryParams {
  page?: string
  limit?: string
  level?: LogLevel
  type?: 'system' | 'request'
}

router.get('/logs', async (ctx: Context) => {
  try {
    const query = ctx.query as LogsQueryParams
    const page = Math.max(1, parseInt(query.page || '1', 10))
    const limit = Math.min(200, Math.max(1, parseInt(query.limit || '50', 10)))
    const level = query.level
    const logType = query.type || 'request'

    if (logType === 'system') {
      const allLogs = storeManager.getLogs(level ? { level } : undefined)
      const total = allLogs.length
      const totalPages = Math.ceil(total / limit)
      const startIndex = (page - 1) * limit
      const logs = allLogs.slice(startIndex, startIndex + limit)

      ctx.body = {
        success: true,
        data: {
          logs,
          pagination: {
            page,
            limit,
            total,
            totalPages,
          },
        },
      } as ManagementApiResponse<{
        logs: LogEntry[]
        pagination: {
          page: number
          limit: number
          total: number
          totalPages: number
        }
      }>
    } else {
      const allRequestLogs = storeManager.getRequestLogs()
      let filteredLogs = allRequestLogs

      if (level === 'error') {
        filteredLogs = allRequestLogs.filter((log) => log.status === 'error')
      } else if (level === 'info') {
        filteredLogs = allRequestLogs.filter((log) => log.status === 'success')
      }

      const total = filteredLogs.length
      const totalPages = Math.ceil(total / limit)
      const startIndex = (page - 1) * limit
      const logs = filteredLogs.slice(startIndex, startIndex + limit)

      ctx.body = {
        success: true,
        data: {
          logs,
          pagination: {
            page,
            limit,
            total,
            totalPages,
          },
        },
      } as ManagementApiResponse<{
        logs: RequestLogEntry[]
        pagination: {
          page: number
          limit: number
          total: number
          totalPages: number
        }
      }>
    }
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

router.get('/app-logs', async (ctx: Context) => {
  try {
    const level = ctx.query.level as LogLevel | 'all' | undefined
    const keyword = ctx.query.keyword as string | undefined
    const startTime = ctx.query.startTime ? Number(ctx.query.startTime) : undefined
    const endTime = ctx.query.endTime ? Number(ctx.query.endTime) : undefined
    const limit = ctx.query.limit ? Number(ctx.query.limit) : undefined
    const offset = ctx.query.offset ? Number(ctx.query.offset) : undefined

    ctx.body = {
      success: true,
      data: storeManager.getLogs({ level, keyword, startTime, endTime, limit, offset }),
    } as ManagementApiResponse<LogEntry[]>
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error'
    ctx.status = 500
    ctx.body = {
      success: false,
      error: { code: 'internal_error', message: errorMessage },
    } as ManagementApiResponse
  }
})

router.put('/app-logs', async (ctx: Context) => {
  try {
    storeManager.replaceLogs(Array.isArray(ctx.request.body) ? ctx.request.body as LogEntry[] : [])
    ctx.body = { success: true, data: null } as ManagementApiResponse<null>
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error'
    ctx.status = 500
    ctx.body = {
      success: false,
      error: { code: 'internal_error', message: errorMessage },
    } as ManagementApiResponse
  }
})

router.delete('/app-logs', async (ctx: Context) => {
  try {
    storeManager.clearLogs()
    ctx.body = { success: true, data: null } as ManagementApiResponse<null>
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error'
    ctx.status = 500
    ctx.body = {
      success: false,
      error: { code: 'internal_error', message: errorMessage },
    } as ManagementApiResponse
  }
})

router.get('/app-logs/stats', async (ctx: Context) => {
  ctx.body = { success: true, data: storeManager.getLogStats() } as ManagementApiResponse
})

router.get('/app-logs/trend', async (ctx: Context) => {
  const days = ctx.query.days ? Number(ctx.query.days) : undefined
  ctx.body = { success: true, data: storeManager.getLogTrend(days) } as ManagementApiResponse
})

router.get('/accounts/:accountId/logs/trend', async (ctx: Context) => {
  const days = ctx.query.days ? Number(ctx.query.days) : undefined
  ctx.body = {
    success: true,
    data: storeManager.getAccountLogTrend(ctx.params.accountId, days),
  } as ManagementApiResponse
})

router.get('/app-logs/export', async (ctx: Context) => {
  const format = ctx.query.format === 'txt' ? 'txt' : 'json'
  ctx.body = {
    success: true,
    data: storeManager.exportLogs(format),
  } as ManagementApiResponse<string>
})

router.get('/app-logs/:id', async (ctx: Context) => {
  const log = storeManager.getLogById(ctx.params.id)
  if (!log) {
    ctx.status = 404
    ctx.body = {
      success: false,
      error: { code: 'not_found', message: 'Log not found' },
    } as ManagementApiResponse
    return
  }

  ctx.body = { success: true, data: log } as ManagementApiResponse<LogEntry>
})

router.get('/request-logs', async (ctx: Context) => {
  const limit = ctx.query.limit ? Number(ctx.query.limit) : undefined
  const filter = {
    status: ctx.query.status as 'success' | 'error' | undefined,
    providerId: ctx.query.providerId as string | undefined,
  }
  ctx.body = {
    success: true,
    data: storeManager.getRequestLogs(limit, filter),
  } as ManagementApiResponse<RequestLogEntry[]>
})

router.get('/request-logs/stats', async (ctx: Context) => {
  ctx.body = { success: true, data: storeManager.getRequestLogStats() } as ManagementApiResponse
})

router.get('/request-logs/trend', async (ctx: Context) => {
  const days = ctx.query.days ? Number(ctx.query.days) : undefined
  ctx.body = { success: true, data: storeManager.getRequestLogTrend(days) } as ManagementApiResponse
})

router.delete('/request-logs', async (ctx: Context) => {
  storeManager.clearRequestLogs()
  ctx.body = { success: true, data: null } as ManagementApiResponse<null>
})

router.get('/request-logs/:id', async (ctx: Context) => {
  const log = storeManager.getRequestLogById(ctx.params.id)
  if (!log) {
    ctx.status = 404
    ctx.body = {
      success: false,
      error: { code: 'not_found', message: 'Request log not found' },
    } as ManagementApiResponse
    return
  }
  ctx.body = { success: true, data: log } as ManagementApiResponse<RequestLogEntry>
})

router.get('/prompts', async (ctx: Context) => {
  ctx.body = { success: true, data: storeManager.getSystemPrompts() } as ManagementApiResponse<SystemPrompt[]>
})

router.get('/prompts/builtin', async (ctx: Context) => {
  ctx.body = { success: true, data: storeManager.getBuiltinPrompts() } as ManagementApiResponse<SystemPrompt[]>
})

router.get('/prompts/custom', async (ctx: Context) => {
  ctx.body = { success: true, data: storeManager.getCustomPrompts() } as ManagementApiResponse<SystemPrompt[]>
})

router.get('/prompts/type/:type', async (ctx: Context) => {
  ctx.body = {
    success: true,
    data: storeManager.getSystemPromptsByType(ctx.params.type as SystemPrompt['type']),
  } as ManagementApiResponse<SystemPrompt[]>
})

router.get('/prompts/:id', async (ctx: Context) => {
  const prompt = storeManager.getSystemPromptById(ctx.params.id)
  if (!prompt) {
    ctx.status = 404
    ctx.body = {
      success: false,
      error: { code: 'not_found', message: 'Prompt not found' },
    } as ManagementApiResponse
    return
  }
  ctx.body = { success: true, data: prompt } as ManagementApiResponse<SystemPrompt>
})

router.post('/prompts', async (ctx: Context) => {
  ctx.status = 201
  ctx.body = {
    success: true,
    data: storeManager.addSystemPrompt(ctx.request.body as Omit<SystemPrompt, 'id' | 'createdAt' | 'updatedAt'>),
  } as ManagementApiResponse<SystemPrompt>
})

router.put('/prompts/:id', async (ctx: Context) => {
  ctx.body = {
    success: true,
    data: storeManager.updateSystemPrompt(ctx.params.id, ctx.request.body as Partial<SystemPrompt>),
  } as ManagementApiResponse<SystemPrompt | null>
})

router.delete('/prompts/:id', async (ctx: Context) => {
  ctx.body = {
    success: true,
    data: storeManager.deleteSystemPrompt(ctx.params.id),
  } as ManagementApiResponse<boolean>
})

router.get('/store/:key', async (ctx: Context) => {
  const key = ctx.params.key as 'providers' | 'accounts' | 'config' | 'logs'
  ctx.body = {
    success: true,
    data: storeManager.getStore()?.get(key),
  } as ManagementApiResponse
})

router.put('/store/:key', async (ctx: Context) => {
  const key = ctx.params.key as 'providers' | 'accounts' | 'config' | 'logs'
  const body = ctx.request.body as { value?: unknown }
  storeManager.getStore()?.set(key, body.value as never)
  ctx.body = { success: true, data: null } as ManagementApiResponse<null>
})

router.delete('/store/:key', async (ctx: Context) => {
  const key = ctx.params.key as 'providers' | 'accounts' | 'config' | 'logs'
  storeManager.getStore()?.delete(key)
  ctx.body = { success: true, data: null } as ManagementApiResponse<null>
})

router.delete('/store', async (ctx: Context) => {
  const body = ctx.request.body as { confirm?: boolean } | undefined
  if (!body || body.confirm !== true) {
    ctx.status = 400
    ctx.body = {
      success: false,
      error: { code: 'confirmation_required', message: 'Request body must include { confirm: true }' },
    } as ManagementApiResponse
    return
  }

  storeManager.clearAll()
  ctx.body = { success: true, data: null } as ManagementApiResponse<null>
})

router.get('/oauth/status', async (ctx: Context) => {
  ctx.body = { success: true, data: 'idle' } as ManagementApiResponse<string>
})

router.post('/oauth/start-login', async (ctx: Context) => {
  const body = ctx.request.body as { providerId?: string; providerType?: ProviderType }
  if (!body.providerId || !body.providerType) {
    ctx.status = 400
    ctx.body = {
      success: false,
      error: { code: 'invalid_request', message: 'providerId and providerType are required' },
    } as ManagementApiResponse
    return
  }

  const adapter = createAdapter(body.providerType, {
    providerId: body.providerId,
    providerType: body.providerType,
    authMethods: [],
    callbackPort: 8311,
  })
  ctx.body = { success: true, data: await adapter.startLogin({ providerId: body.providerId, providerType: body.providerType }) } as ManagementApiResponse
})

router.post('/oauth/cancel-login', async (ctx: Context) => {
  ctx.body = { success: true, data: null } as ManagementApiResponse<null>
})

router.post('/oauth/login-with-token', async (ctx: Context) => {
  const body = ctx.request.body as {
    providerId?: string
    providerType?: ProviderType
    token?: string
    realUserID?: string
    mimoUserId?: string
    mimoPhToken?: string
  }

  if (!body.providerId || !body.providerType || !body.token) {
    ctx.status = 400
    ctx.body = {
      success: false,
      error: { code: 'invalid_request', message: 'providerId, providerType and token are required' },
    } as ManagementApiResponse
    return
  }

  const adapter = createAdapter(body.providerType, {
    providerId: body.providerId,
    providerType: body.providerType,
    authMethods: [],
    callbackPort: 8311,
  }) as any

  if (typeof adapter.loginWithToken === 'function') {
    ctx.body = {
      success: true,
      data: await adapter.loginWithToken(body.providerId, body.token, body.realUserID, body.mimoUserId, body.mimoPhToken),
    } as ManagementApiResponse
    return
  }

  const validationCredentials = body.providerType === 'mimo'
    ? { service_token: body.token, user_id: body.mimoUserId || '', ph_token: body.mimoPhToken || '' }
    : { token: body.token }
  const validation = await adapter.validateToken(validationCredentials)

  ctx.body = {
    success: true,
    data: validation.valid
      ? {
          success: true,
          providerId: body.providerId,
          providerType: body.providerType,
          credentials: validationCredentials,
          accountInfo: validation.accountInfo,
        }
      : {
          success: false,
          providerId: body.providerId,
          providerType: body.providerType,
          error: validation.error || 'Token validation failed',
        },
  } as ManagementApiResponse
})

router.post('/oauth/validate-token', async (ctx: Context) => {
  const body = ctx.request.body as { providerId?: string; providerType?: ProviderType; credentials?: Record<string, string> }
  if (!body.providerId || !body.providerType) {
    ctx.status = 400
    ctx.body = {
      success: false,
      error: { code: 'invalid_request', message: 'providerId and providerType are required' },
    } as ManagementApiResponse
    return
  }

  const adapter = createAdapter(body.providerType, {
    providerId: body.providerId,
    providerType: body.providerType,
    authMethods: [],
    callbackPort: 8311,
  })

  ctx.body = {
    success: true,
    data: await adapter.validateToken(body.credentials || {}),
  } as ManagementApiResponse
})

router.post('/oauth/refresh-token', async (ctx: Context) => {
  const body = ctx.request.body as { providerId?: string; providerType?: ProviderType; credentials?: Record<string, string> }
  if (!body.providerId || !body.providerType) {
    ctx.status = 400
    ctx.body = {
      success: false,
      error: { code: 'invalid_request', message: 'providerId and providerType are required' },
    } as ManagementApiResponse
    return
  }

  const adapter = createAdapter(body.providerType, {
    providerId: body.providerId,
    providerType: body.providerType,
    authMethods: [],
    callbackPort: 8311,
  })

  ctx.body = {
    success: true,
    data: await adapter.refreshToken(body.credentials || {}),
  } as ManagementApiResponse
})

router.post('/management-api/generate-secret', async (ctx: Context) => {
  const secret = generateManagementSecret()
  const config = storeManager.getConfig()
  storeManager.updateConfig({
    managementApi: {
      ...config.managementApi,
      managementApiSecret: secret,
    },
  })
  ctx.body = { success: true, data: secret } as ManagementApiResponse<string>
})

router.post('/app/open-external', async (ctx: Context) => {
  const body = ctx.request.body as { url?: string }
  if (body.url) {
    await getRuntime().openExternal(body.url)
  }
  ctx.body = { success: true, data: null } as ManagementApiResponse<null>
})

export default router
