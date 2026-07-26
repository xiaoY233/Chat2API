import { loadHeadlessConfig } from './config.ts'
import { ensureDataDirectory, getManagementSecret } from './keyManager.ts'
import { installSafeConsole } from './logger.ts'

type Runtime = {
  proxyServer: {
    start(port?: number, host?: string): Promise<boolean>
    stop(): Promise<boolean>
    isRunning(): boolean
  }
  sessionManager: { destroy(): void }
  storeManager: {
    initialize(): Promise<void>
    getConfig(): Record<string, any>
    updateConfig(updates: Record<string, unknown>): void
    flushPendingWrites(): void
  }
}

let runtime: Runtime | undefined
let shuttingDown: Promise<void> | undefined

async function loadRuntime(): Promise<Runtime> {
  const [{ proxyServer }, { sessionManager }, { storeManager }] = await Promise.all([
    import('../../src/main/proxy/server.ts'),
    import('../../src/main/proxy/sessionManager.ts'),
    import('../../src/main/store/store.ts'),
  ])
  return { proxyServer, sessionManager, storeManager }
}

async function shutdown(reason: string, exitCode: number): Promise<void> {
  if (shuttingDown) return shuttingDown

  shuttingDown = (async () => {
    const timeoutMs = loadHeadlessConfig().shutdownTimeoutMs
    const timeout = setTimeout(() => {
      console.error(`[Headless] Shutdown timed out after ${timeoutMs}ms`)
      process.exit(1)
    }, timeoutMs)
    timeout.unref()

    console.log(`[Headless] Shutting down: ${reason}`)
    let finalExitCode = exitCode
    try {
      if (runtime?.proxyServer.isRunning()) {
        await runtime.proxyServer.stop()
      }
    } catch (error) {
      finalExitCode = 1
      console.error('[Headless] Failed to stop proxy server:', error)
    }

    try {
      runtime?.sessionManager.destroy()
    } catch (error) {
      finalExitCode = 1
      console.error('[Headless] Failed to destroy session manager:', error)
    }

    try {
      runtime?.storeManager.flushPendingWrites()
    } catch (error) {
      finalExitCode = 1
      console.error('[Headless] Failed to flush storage:', error)
    }

    clearTimeout(timeout)
    process.exit(finalExitCode)
  })()

  return shuttingDown
}

async function main(): Promise<void> {
  installSafeConsole()
  process.env.CHAT2API_HEADLESS = '1'
  const config = loadHeadlessConfig()
  ensureDataDirectory()
  const managementSecret = getManagementSecret()

  runtime = await loadRuntime()
  await runtime.storeManager.initialize()

  const currentConfig = runtime.storeManager.getConfig()
  runtime.storeManager.updateConfig({
    proxyHost: config.host,
    proxyPort: config.port,
    autoStartProxy: true,
    managementApi: {
      ...(currentConfig.managementApi || {}),
      enableManagementApi: true,
      managementApiSecret: managementSecret,
    },
  })

  const started = await runtime.proxyServer.start(config.port, config.host)
  if (!started) {
    runtime.sessionManager.destroy()
    runtime.storeManager.flushPendingWrites()
    throw new Error(`Proxy server failed to start on ${config.host}:${config.port}`)
  }

  console.log(`[Headless] Chat2API listening on ${config.host}:${config.port}`)
  console.log('[Headless] Management API enabled; use chat2api-ctl inside the container')
}

process.once('SIGINT', () => { void shutdown('SIGINT', 0) })
process.once('SIGTERM', () => { void shutdown('SIGTERM', 0) })
process.once('uncaughtException', error => {
  console.error('[Headless] Uncaught exception:', error)
  void shutdown('uncaughtException', 1)
})
process.once('unhandledRejection', reason => {
  console.error('[Headless] Unhandled rejection:', reason)
  void shutdown('unhandledRejection', 1)
})

main().catch(error => {
  console.error('[Headless] Startup failed:', error instanceof Error ? error.message : String(error))
  void shutdown('startup failure', 1)
})
