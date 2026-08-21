/**
 * Proxy Service Module - Proxy Server Core
 * Implements proxy server based on Koa
 */

import Koa, { type Context, type Next } from 'koa'
import Router from '@koa/router'
import bodyParser from 'koa-bodyparser'
import { Server as HttpServer, type ServerResponse } from 'http'
import type { Socket } from 'net'
import routes from './routes'
import managementRoutes from './routes/management'
import { proxyStatusManager } from './status'
import { storeManager } from '../store/store'
import { sessionManager } from './sessionManager'
import { qwenAiSessionRepairService } from './qwenAiSessionRepair'
import { mountWebAdminAssets } from '../../server/admin/assets'

const SLOW_REQUEST_THRESHOLD_MS = 1500
const BROWSER_IMPORT_MAX_CONTENT_LENGTH = 128 * 1024
const BROWSER_IMPORT_PATH = '/v0/management/browser-import/complete'
const DEFAULT_SHUTDOWN_DRAIN_TIMEOUT_MS = 540_000
const SHUTDOWN_FORCE_CLOSE_WAIT_MS = 5_000

export function shutdownDrainTimeoutMsFromEnv(): number {
  const raw = process.env.CHAT2API_SHUTDOWN_DRAIN_TIMEOUT_MS
  if (raw === undefined || raw.trim() === '') return DEFAULT_SHUTDOWN_DRAIN_TIMEOUT_MS

  const value = Number(raw)
  return Number.isFinite(value) && value >= 0
    ? Math.floor(value)
    : DEFAULT_SHUTDOWN_DRAIN_TIMEOUT_MS
}

/**
 * Proxy Server Class
 */
export class ProxyServer {
  private app: Koa
  private router: Router
  private server: HttpServer | null = null
  private port: number = 8080
  private host: string = '127.0.0.1'
  private draining = false
  private stopPromise: Promise<boolean> | null = null
  private activeResponses = new Set<ServerResponse>()
  private openSockets = new Set<Socket>()
  private drainWaiters = new Set<() => void>()

  constructor() {
    this.app = new Koa()
    this.router = new Router()

    this.setupMiddleware()
    this.setupRoutes()
    this.setupErrorHandler()
  }

  /**
   * Setup middleware
   */
  private setupMiddleware(): void {
    // Do this before routing so an existing keep-alive connection cannot
    // start another generation after SIGTERM has begun graceful draining.
    this.app.use(async (ctx, next) => {
      if (this.draining) {
        if (ctx.path === '/health') {
          await next()
          return
        }
        ctx.set('Connection', 'close')
        ctx.status = 503
        ctx.body = {
          error: {
            message: 'Server is shutting down and is not accepting new requests.',
            type: 'service_unavailable_error',
            code: 'server_shutting_down',
          },
        }
        return
      }

      this.trackResponse(ctx.res)
      await next()
    })

    this.app.use(async (ctx, next) => {
      ctx.set('Access-Control-Allow-Origin', '*')
      ctx.set('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS')
      ctx.set('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Requested-With, X-API-Key, X-Goog-Api-Key, X-Goog-Upload-Protocol, X-Goog-Upload-Command, X-Goog-Upload-Header-Content-Length, X-Goog-Upload-Header-Content-Type, X-Goog-Upload-File-Name, X-Goog-Upload-Offset')
      ctx.set('Access-Control-Allow-Private-Network', 'true')
      ctx.set('Access-Control-Max-Age', '86400')

      if (ctx.method === 'OPTIONS') {
        ctx.status = 204
        return
      }

      await next()
    })

    // Browser-assisted imports contain only a few token strings. Parse this
    // endpoint before the global 50 MB body parser so a chunked request cannot
    // consume the large upload budget before the route-level size check runs.
    this.app.use(async (ctx, next) => {
      const isBrowserImport = ctx.method === 'POST'
        && ctx.path === BROWSER_IMPORT_PATH
      if (!isBrowserImport) {
        await next()
        return
      }

      const rejectOversizedPayload = () => {
        ctx.status = 413
        ctx.body = {
          success: false,
          error: {
            code: 'browser_import_payload_too_large',
            message: `Browser import payload exceeds ${BROWSER_IMPORT_MAX_CONTENT_LENGTH} bytes`,
          },
        }
      }

      const contentLength = Number(ctx.get('content-length'))
      if (Number.isFinite(contentLength) && contentLength > BROWSER_IMPORT_MAX_CONTENT_LENGTH) {
        rejectOversizedPayload()
        return
      }

      const chunks: Buffer[] = []
      let totalBytes = 0
      try {
        for await (const chunk of ctx.req) {
          const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
          totalBytes += buffer.length
          if (totalBytes > BROWSER_IMPORT_MAX_CONTENT_LENGTH) {
            // Drain without retaining the remainder so Koa can still return a
            // useful 413 response while keeping memory bounded.
            ctx.req.resume()
            rejectOversizedPayload()
            return
          }
          chunks.push(buffer)
        }
      } catch (error) {
        ctx.status = 400
        ctx.body = {
          success: false,
          error: {
            code: 'invalid_browser_import_body',
            message: error instanceof Error ? error.message : 'Unable to read browser import payload',
          },
        }
        return
      }

      const rawBody = Buffer.concat(chunks)
      ;(ctx.request as any).rawBody = rawBody
      const contentType = ctx.get('content-type').split(';', 1)[0].trim().toLowerCase()
      if (contentType === 'application/json') {
        try {
          ;(ctx.request as any).body = rawBody.length > 0
            ? JSON.parse(rawBody.toString('utf8'))
            : {}
        } catch {
          ;(ctx.request as any).body = rawBody.toString('utf8')
        }
      } else if (contentType === 'text/plain' || contentType === '') {
        ;(ctx.request as any).body = rawBody.toString('utf8')
      } else {
        ;(ctx.request as any).body = {}
      }

      await next()
    })

    this.app.use(async (ctx, next) => {
      const shouldReadRawUpload =
        ctx.method === 'POST' &&
        ctx.path.startsWith('/upload/v1beta/files/') &&
        ctx.get('X-Goog-Upload-Command')

      if (!shouldReadRawUpload) {
        await next()
        return
      }

      ;(ctx as Context & { disableBodyParser?: boolean }).disableBodyParser = true
      const chunks: Buffer[] = []
      for await (const chunk of ctx.req) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
      }
      ;(ctx.request as any).rawBody = Buffer.concat(chunks)
      await next()
    })

    this.app.use(bodyParser({
      enableTypes: ['json', 'form', 'text'],
      jsonLimit: '50mb',
      formLimit: '50mb',
      textLimit: '50mb',
    }))

    // API Key validation middleware
    this.app.use(async (ctx, next) => {
      // Skip paths that don't require authentication
      const publicPaths = ['/', '/health', '/stats']
      if (publicPaths.includes(ctx.path) || ctx.path.startsWith('/admin')) {
        await next()
        return
      }

      // Skip management API paths - they have their own authentication
      if (ctx.path.startsWith('/v0/management')) {
        await next()
        return
      }

      const config = storeManager.getConfig()
      
      if (config.enableApiKey && config.apiKeys && config.apiKeys.length > 0) {
        const authHeader = ctx.get('Authorization') || ''
        const providedKey = authHeader.startsWith('Bearer ') 
          ? authHeader.slice(7) 
          : (ctx.query.api_key as string) || ctx.get('X-API-Key') || ctx.get('X-Goog-Api-Key')
        
        if (!providedKey) {
          ctx.status = 401
          ctx.body = {
            error: {
              message: 'API key is required',
              type: 'invalid_request_error',
              code: 'missing_api_key',
            },
          }
          return
        }
        
        const validKey = config.apiKeys.find(
          k => k.key === providedKey && k.enabled
        )
        
        if (!validKey) {
          ctx.status = 401
          ctx.body = {
            error: {
              message: 'Invalid API key',
              type: 'invalid_request_error',
              code: 'invalid_api_key',
            },
          }
          return
        }
        
        // Update usage statistics
        const updatedKeys = config.apiKeys.map(k => 
          k.id === validKey.id 
            ? { 
                ...k, 
                lastUsedAt: Date.now(), 
                usageCount: k.usageCount + 1 
              }
            : k
        )
        storeManager.updateConfig({ apiKeys: updatedKeys })
      }
      
      await next()
    })

    this.app.use(async (ctx, next) => {
      const startTime = Date.now()

      await next()

      const latency = Date.now() - startTime
      const shouldRecordAccessLog =
        !ctx.path.startsWith('/v1/models') &&
        (ctx.status >= 400 || latency >= SLOW_REQUEST_THRESHOLD_MS)

      if (shouldRecordAccessLog) {
        // Slow successful generations are expected for long-context models;
        // reserve warning/error levels for actionable HTTP failures.
        const accessLogLevel = ctx.status === 499
          ? 'info'
          : ctx.status >= 500
            ? 'error'
            : ctx.status >= 400
              ? 'warn'
              : 'info'
        storeManager.addLog(accessLogLevel, `${ctx.method} ${ctx.path} ${ctx.status} ${latency}ms`, {
          data: {
            method: ctx.method,
            path: ctx.path,
            status: ctx.status,
            latency,
            clientIP: ctx.ip,
            slowRequest: latency >= SLOW_REQUEST_THRESHOLD_MS,
          },
        })
      }
    })
  }

  /**
   * Setup routes
   */
  private setupRoutes(): void {
    mountWebAdminAssets(this.app)

    // Register OpenAI API routes
    for (const route of routes) {
      this.router.use(route.routes())
      this.router.use(route.allowedMethods())
    }

    this.router.get('/', async (ctx) => {
      ctx.body = {
        name: 'Chat2API Proxy',
        version: '1.1.2',
        description: 'OpenAI API compatible proxy service',
        endpoints: [
          'POST /v1/chat/completions',
          'POST /v1/responses',
          'GET /v1/models',
          'GET /v1/models/:model',
          'POST /v1/completions',
          'GET /v1beta/models',
          'POST /v1beta/models/:model:generateContent',
          'POST /v1beta/models/:model:streamGenerateContent',
          'POST /v1beta/chat2api/qwen-ai/direct-upload/start',
          'POST /v1beta/chat2api/qwen-ai/direct-upload/complete',
          'POST /upload/v1beta/files',
        ],
      }
    })

    this.router.get('/health', async (ctx) => {
      const status = proxyStatusManager.getRunningStatus()
      const statistics = proxyStatusManager.getStatistics()

      if (this.draining) ctx.status = 503
      ctx.body = {
        status: this.draining ? 'draining' : status.isRunning ? 'running' : 'stopped',
        uptime: status.uptime,
        statistics: {
          totalRequests: statistics.totalRequests,
          successRequests: statistics.successRequests,
          failedRequests: statistics.failedRequests,
          activeConnections: statistics.activeConnections,
        },
      }
    })

    this.router.get('/stats', async (ctx) => {
      const statistics = proxyStatusManager.getStatistics()
      ctx.body = statistics
    })

    // Management API enable check middleware
    // This must be registered before management routes
    const managementEnableCheck = async (ctx: Context, next: Next) => {
      if (!ctx.path.startsWith('/v0/management')) {
        await next()
        return
      }

      try {
        const config = storeManager.getConfig()
        if (!config.managementApi?.enableManagementApi) {
          ctx.status = 404
          ctx.body = {
            success: false,
            error: {
              code: 'management_api_disabled',
              message: 'Management API is not enabled',
            },
          }
          return
        }
        await next()
      } catch {
        ctx.status = 503
        ctx.body = {
          success: false,
          error: {
            code: 'service_unavailable',
            message: 'Service is initializing',
          },
        }
      }
    }

    this.app.use(managementEnableCheck)

    // Register all management routes (they already have /v0/management prefix)
    for (const route of managementRoutes) {
      this.app.use(route.routes())
      this.app.use(route.allowedMethods())
    }

    this.app.use(this.router.routes())
    this.app.use(this.router.allowedMethods())

    this.app.use(async (ctx) => {
      ctx.status = 404
      ctx.body = {
        error: {
          message: `Route not found: ${ctx.method} ${ctx.path}`,
          type: 'not_found_error',
        },
      }
    })
  }

  /**
   * Setup error handler
   */
  private setupErrorHandler(): void {
    this.app.on('error', (err, ctx) => {
      const status = err.status || 500
      const message = err.message || 'Internal Server Error'

      storeManager.addLog('error', `Server error: ${message}`, {
        data: {
          status,
          path: ctx.path,
          method: ctx.method,
          stack: err.stack,
        },
      })
    })
  }

  /**
   * Start server
   */
  async start(port?: number, host?: string): Promise<boolean> {
    if (this.server) {
      return false
    }

    this.draining = false
    this.stopPromise = null
    this.port = port || proxyStatusManager.getPort()
    this.host = host || proxyStatusManager.getHost()
    
    sessionManager.initialize()

    return new Promise((resolve) => {
      try {
        this.server = this.app.listen(this.port, this.host, () => {
          proxyStatusManager.start()
          proxyStatusManager.setPort(this.port)
          proxyStatusManager.setHost(this.host)

          storeManager.addLog('info', `Proxy server started successfully, listening on ${this.host}:${this.port}`)
          qwenAiSessionRepairService.start()

          resolve(true)
        })

        this.server.on('error', (err: NodeJS.ErrnoException) => {
          if (err.code === 'EADDRINUSE') {
            storeManager.addLog('error', `Port ${this.port} is already in use`)
          } else {
            storeManager.addLog('error', `Server error: ${err.message}`)
          }
          qwenAiSessionRepairService.stop()
          this.server = null
          resolve(false)
        })

        this.server.on('connection', (socket: Socket) => {
          this.openSockets.add(socket)
          socket.once('close', () => this.openSockets.delete(socket))
        })

        this.server.on('close', () => {
          qwenAiSessionRepairService.stop()
          this.server = null
        })
      } catch (error) {
        storeManager.addLog('error', `Failed to start server: ${error instanceof Error ? error.message : 'Unknown error'}`)
        resolve(false)
      }
    })
  }

  /**
   * Stop server
   */
  async stop(): Promise<boolean> {
    if (this.stopPromise) return this.stopPromise
    if (!this.server) return false

    this.stopPromise = this.stopGracefully(this.server)
    return this.stopPromise
  }

  private async stopGracefully(server: HttpServer): Promise<boolean> {
    this.draining = true
    qwenAiSessionRepairService.stop()
    storeManager.addLog('info', 'Proxy server is draining active HTTP streams before shutdown', {
      data: {
        activeResponses: this.activeResponses.size,
        drainTimeoutMs: shutdownDrainTimeoutMsFromEnv(),
      },
    })

    const closed = new Promise<boolean>((resolve) => {
      server.close((error) => {
        if (error) {
          storeManager.addLog('error', `Failed to stop server: ${error.message}`)
          resolve(false)
          return
        }
        resolve(true)
      })
    })
    // Node keeps a long-lived SSE response open but can retire idle
    // keep-alive sockets immediately once it has stopped listening.
    server.closeIdleConnections?.()

    const drainTimeoutMs = shutdownDrainTimeoutMsFromEnv()
    const drained = await this.waitForActiveResponses(drainTimeoutMs)
    if (!drained) {
      storeManager.addLog('warn', 'Proxy shutdown drain deadline reached; closing remaining HTTP connections', {
        data: {
          activeResponses: this.activeResponses.size,
          openSockets: this.openSockets.size,
          drainTimeoutMs,
        },
      })
      this.forceCloseOpenConnections(server)
    }

    const stopped = await this.waitForServerClose(closed, SHUTDOWN_FORCE_CLOSE_WAIT_MS)
    if (!stopped) {
      storeManager.addLog('error', 'Proxy server did not close after the shutdown drain deadline')
    }

    // Session state can still be needed by a live stream's completion hook.
    // Dispose it only after the server stopped accepting and draining requests.
    sessionManager.destroy()
    this.activeResponses.clear()
    this.openSockets.clear()
    this.drainWaiters.clear()
    if (this.server === server) this.server = null
    proxyStatusManager.stop()

    if (stopped) storeManager.addLog('info', 'Proxy server stopped')
    return stopped
  }

  private trackResponse(response: ServerResponse): void {
    if (response.writableEnded || response.destroyed) return
    this.activeResponses.add(response)

    let released = false
    const release = () => {
      if (released) return
      released = true
      response.removeListener('finish', release)
      response.removeListener('close', release)
      this.activeResponses.delete(response)
      if (this.activeResponses.size === 0) {
        for (const resolve of this.drainWaiters) resolve()
        this.drainWaiters.clear()
      }
    }
    response.once('finish', release)
    response.once('close', release)
  }

  private waitForActiveResponses(timeoutMs: number): Promise<boolean> {
    if (this.activeResponses.size === 0) return Promise.resolve(true)

    return new Promise((resolve) => {
      let settled = false
      const settle = (drained: boolean) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        this.drainWaiters.delete(onDrained)
        resolve(drained)
      }
      const onDrained = () => settle(true)
      const timer = setTimeout(() => settle(false), timeoutMs)
      this.drainWaiters.add(onDrained)
    })
  }

  private forceCloseOpenConnections(server: HttpServer): void {
    server.closeAllConnections?.()
    for (const socket of this.openSockets) socket.destroy()
  }

  private async waitForServerClose(
    closed: Promise<boolean>,
    timeoutMs: number,
  ): Promise<boolean> {
    return Promise.race([
      closed,
      new Promise<boolean>((resolve) => {
        setTimeout(() => resolve(false), timeoutMs)
      }),
    ])
  }

  /**
   * Restart server
   */
  async restart(port?: number, host?: string): Promise<boolean> {
    await this.stop()
    return this.start(port, host)
  }

  /**
   * Check if server is running
   */
  isRunning(): boolean {
    return this.server !== null && proxyStatusManager.getRunningStatus().isRunning
  }

  isDraining(): boolean {
    return this.draining
  }

  /**
   * Get server port
   */
  getPort(): number {
    return this.port
  }

  /**
   * Get statistics
   */
  getStatistics() {
    return proxyStatusManager.getStatistics()
  }

  /**
   * Get running status
   */
  getStatus() {
    return proxyStatusManager.getRunningStatus()
  }

  /**
   * Reset statistics
   */
  resetStatistics(): void {
    proxyStatusManager.resetStatistics()
  }
}

export const proxyServer = new ProxyServer()
export default proxyServer
