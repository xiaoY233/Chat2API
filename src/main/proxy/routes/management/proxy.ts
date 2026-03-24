/**
 * Management API - Proxy Control Routes
 * Provides endpoints for proxy service control (start, stop, restart, status)
 */

import Router from '@koa/router'
import type { Context } from 'koa'
import { managementAuthMiddleware } from '../../middleware/managementAuth'
import { proxyServer } from '../../server'
import { proxyStatusManager } from '../../status'
import type {
  ManagementApiResponse,
  ProxyStatusResponse,
} from '../../../../shared/types'

const router = new Router({ prefix: '/v0/management/proxy' })

router.use(managementAuthMiddleware)

interface ProxyStartRequest {
  port?: number
  host?: string
}

interface ProxyRestartRequest {
  port?: number
  host?: string
}

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

function getProxyStatusData(): ProxyStatusResponse {
  const status = proxyStatusManager.getRunningStatus()
  const statistics = proxyStatusManager.getStatistics()
  const port = proxyStatusManager.getPort()
  const host = proxyStatusManager.getHost()

  return {
    isRunning: status.isRunning,
    port,
    host,
    uptime: status.uptime,
    connections: statistics.activeConnections,
  }
}

router.post('/start', async (ctx: Context) => {
  try {
    if (proxyServer.isRunning()) {
      ctx.status = 400
      ctx.body = createErrorResponse('already_running', 'Proxy service is already running')
      return
    }

    const request = (ctx.request.body as ProxyStartRequest) || {}
    const port = request.port
    const host = request.host

    const success = await proxyServer.start(port, host)

    if (!success) {
      ctx.status = 500
      ctx.body = createErrorResponse('start_failed', 'Failed to start proxy service')
      return
    }

    const statusData = getProxyStatusData()

    ctx.set('Content-Type', 'application/json')
    ctx.body = createSuccessResponse({
      isRunning: statusData.isRunning,
      port: statusData.port,
      host: statusData.host,
    })
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Failed to start proxy service'
    ctx.status = 500
    ctx.body = createErrorResponse('internal_error', errorMessage)
  }
})

router.post('/stop', async (ctx: Context) => {
  try {
    if (!proxyServer.isRunning()) {
      ctx.status = 400
      ctx.body = createErrorResponse('not_running', 'Proxy service is not running')
      return
    }

    const success = await proxyServer.stop()

    if (!success) {
      ctx.status = 500
      ctx.body = createErrorResponse('stop_failed', 'Failed to stop proxy service')
      return
    }

    ctx.set('Content-Type', 'application/json')
    ctx.body = createSuccessResponse({
      isRunning: false,
    })
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Failed to stop proxy service'
    ctx.status = 500
    ctx.body = createErrorResponse('internal_error', errorMessage)
  }
})

router.post('/restart', async (ctx: Context) => {
  try {
    const request = (ctx.request.body as ProxyRestartRequest) || {}
    const port = request.port
    const host = request.host

    const success = await proxyServer.restart(port, host)

    if (!success) {
      ctx.status = 500
      ctx.body = createErrorResponse('restart_failed', 'Failed to restart proxy service')
      return
    }

    const statusData = getProxyStatusData()

    ctx.set('Content-Type', 'application/json')
    ctx.body = createSuccessResponse({
      isRunning: statusData.isRunning,
      port: statusData.port,
      host: statusData.host,
    })
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Failed to restart proxy service'
    ctx.status = 500
    ctx.body = createErrorResponse('internal_error', errorMessage)
  }
})

router.get('/status', async (ctx: Context) => {
  try {
    const statusData = getProxyStatusData()

    ctx.set('Content-Type', 'application/json')
    ctx.body = createSuccessResponse(statusData)
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Failed to get proxy status'
    ctx.status = 500
    ctx.body = createErrorResponse('internal_error', errorMessage)
  }
})

export default router
