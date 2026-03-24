/**
 * Management API - Statistics and Monitoring Routes
 * Provides statistics, health status, and log endpoints
 */

import Router from '@koa/router'
import type { Context } from 'koa'
import { managementAuthMiddleware } from '../../middleware/managementAuth'
import { proxyStatusManager } from '../../status'
import { storeManager } from '../../../store/store'
import type {
  ManagementApiResponse,
  StatisticsResponse,
  HealthCheckResponse,
  ProxyStatusResponse,
  LogEntry,
  LogLevel,
} from '../../../../shared/types'
import type { RequestLogEntry } from '../../../store/types'

const router = new Router({ prefix: '/v0/management' })

router.use(managementAuthMiddleware)

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
      const allLogs = storeManager.getLogs(undefined, level)
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

export default router
