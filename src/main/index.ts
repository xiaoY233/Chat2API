import { app, BrowserWindow } from 'electron'
import { join } from 'path'
import { createWindow, getMainWindow, loadUrl, loadFile, openDevTools } from './window/manager'
import { createTrayManager, TrayManager } from './tray/TrayManager'
import { registerIpcHandlers } from './ipc/handlers'
import { UpdaterManager } from './updater'
import { storeManager } from './store/store'

// Prevent uncaught exceptions from crashing the app
process.on('uncaughtException', (error) => {
  console.error('Uncaught Exception:', error)
})

process.on('unhandledRejection', (reason) => {
  console.error('Unhandled Rejection:', reason)
})

// Workaround for V8 JIT compiler crash on macOS ARM64 (Electron 33 bug)
// Completely disable JIT compilation to prevent EXC_BAD_ACCESS crashes
// This trades some performance for stability
if (process.platform === 'darwin' && process.arch === 'arm64') {
  app.commandLine.appendSwitch('js-flags', '--jitless --no-opt')
  app.commandLine.appendSwitch('disable-gpu-sandbox')
}

// Automatically add --no-sandbox flag when running as root user
if (process.getuid && process.getuid() === 0) {
  console.log('Detected running as root user, sandbox settings have been automatically handled')
}

declare module 'electron' {
  interface App {
    isQuitting?: boolean
  }
}

const gotTheLock = app.requestSingleInstanceLock()

if (!gotTheLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    const mainWindow = getMainWindow()
    if (mainWindow) {
      if (mainWindow.isMinimized()) {
        mainWindow.restore()
      }
      mainWindow.show()
      mainWindow.focus()
    }
  })

  initializeApp()
}

let trayManager: TrayManager | null = null

async function initializeApp(): Promise<void> {
  app.on('ready', async () => {
    await setupApp()
  })

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
      app.quit()
    }
  })

  app.on('activate', () => {
    const mainWindow = getMainWindow()
    if (!mainWindow) {
      createWindow()
    } else {
      mainWindow.show()
    }
  })

  app.on('before-quit', () => {
    app.isQuitting = true
    trayManager?.destroy()
  })

  app.on('will-quit', () => {
    cleanup()
  })
}

async function setupApp(): Promise<void> {
  const mainWindow = createWindow({
    width: 1200,
    height: 800,
    minWidth: 800,
    minHeight: 600,
    title: 'Chat2API',
    show: false,
  })

  await registerIpcHandlers(mainWindow)

  trayManager = createTrayManager(mainWindow)

  await loadAppContent(mainWindow)

  if (process.env.NODE_ENV === 'development') {
    openDevTools()
  }
}

async function loadAppContent(mainWindow: BrowserWindow): Promise<void> {
  const isDev = process.env.NODE_ENV === 'development'

  if (isDev) {
    try {
      await loadUrl('http://localhost:5173')
    } catch (error) {
      console.error('Failed to load development server:', error)
    }
  } else {
    try {
      await loadFile(join(__dirname, '../renderer/index.html'))
    } catch (error) {
      console.error('Failed to load production files:', error)
    }
  }
}

function cleanup(): void {
  console.log('Application is exiting, performing cleanup...')
  storeManager.flushPendingWrites()
  const updaterManager = UpdaterManager.getInstance()
  updaterManager.destroy()
}

export function restartApp(): void {
  app.relaunch()
  app.quit()
}

export function getAppVersion(): string {
  return app.getVersion()
}

export function isAppQuitting(): boolean {
  return app.isQuitting ?? false
}

export { getMainWindow }
