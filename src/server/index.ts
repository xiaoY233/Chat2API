import { setRuntime } from '../main/runtime'
import { nodeRuntime } from '../main/runtime/nodeRuntime'
import { proxyServer } from '../main/proxy/server'
import { storeManager } from '../main/store/store'
import { applyServerConfigOverrides } from './bootstrapConfig'

setRuntime(nodeRuntime)

async function shutdown(signal: string): Promise<void> {
  console.log(`[Server] Received ${signal}, shutting down`)
  try {
    await proxyServer.stop()
  } finally {
    storeManager.flushPendingWrites()
    process.exit(0)
  }
}

let shutdownPromise: Promise<void> | undefined

function requestShutdown(signal: string): void {
  shutdownPromise ??= shutdown(signal)
  void shutdownPromise
}

async function main(): Promise<void> {
  process.on('SIGINT', () => requestShutdown('SIGINT'))
  process.on('SIGTERM', () => requestShutdown('SIGTERM'))

  process.on('uncaughtException', (error) => {
    console.error('[Server] Uncaught exception:', error)
  })

  process.on('unhandledRejection', (reason) => {
    console.error('[Server] Unhandled rejection:', reason)
  })

  await storeManager.initialize()
  await storeManager.syncDynamicBuiltinProviderModels()
  const config = applyServerConfigOverrides()

  const started = await proxyServer.start(config.proxyPort, config.proxyHost)
  if (!started) {
    throw new Error(`Failed to start server on ${config.proxyHost}:${config.proxyPort}`)
  }

  console.log(`[Server] Chat2API listening on ${config.proxyHost}:${config.proxyPort}`)
}

void main().catch((error) => {
  console.error('[Server] Startup failed:', error)
  process.exit(1)
})
