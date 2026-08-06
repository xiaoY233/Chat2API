import {
  Tray,
  Menu,
  nativeImage,
  app,
  BrowserWindow,
  ipcMain,
  MenuItemConstructorOptions,
} from 'electron'
import path from 'path'
import { TrayWindow } from './TrayWindow'
import { ConfigManager } from '../store/config'

const isWindows = process.platform === 'win32'
const isLinux = process.platform === 'linux'

function getIconPath(): string {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, 'build/icon.png')
  }
  return path.join(__dirname, '../../build/icon.png')
}

function loadAppIcon(): nativeImage {
  const iconPath = getIconPath()
  
  try {
    let icon = nativeImage.createFromPath(iconPath)
    if (!icon.isEmpty()) {
      if (process.platform === 'darwin') {
        icon = icon.resize({ width: 18, height: 18 })
      }
      return icon
    }
  } catch (error) {
    console.error('Failed to load app icon:', error)
  }
  
  return createFallbackIcon()
}

function createFallbackIcon(): nativeImage {
  const size = 22
  const canvas = Buffer.alloc(size * size * 4)
  
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const index = (y * size + x) * 4
      const centerX = size / 2
      const centerY = size / 2
      const distance = Math.sqrt((x - centerX) ** 2 + (y - centerY) ** 2)
      
      if (distance < size / 2 - 1) {
        canvas[index] = 59
        canvas[index + 1] = 130
        canvas[index + 2] = 246
        canvas[index + 3] = 255
      } else {
        canvas[index + 3] = 0
      }
    }
  }
  
  return nativeImage.createFromBuffer(canvas, { width: size, height: size })
}

export class TrayManager {
  private static instance: TrayManager
  private tray: Tray | null = null
  private trayWindow: TrayWindow | null = null
  private mainWindow: BrowserWindow | null = null
  private isRunning: boolean = false

  private constructor() {}

  public static getInstance(): TrayManager {
    if (!TrayManager.instance) {
      TrayManager.instance = new TrayManager()
    }
    return TrayManager.instance
  }

  public create(mainWindow: BrowserWindow): void {
    if (this.tray) return

    this.mainWindow = mainWindow
    if (!isLinux) {
      this.trayWindow = new TrayWindow()
    }

    const icon = loadAppIcon()

    this.tray = new Tray(icon)
    this.tray.setToolTip('Chat2API - AI Proxy Manager')

    this.setupEventHandlers()
    this.updateContextMenu()
    this.setupIpcHandlers()
  }

  private setupEventHandlers(): void {
    if (!this.tray) return

    if (isLinux) {
      this.tray.setContextMenu(this.buildMenu())
      this.tray.on('click', () => {
        this.openDashboard()
      })
    } else if (isWindows) {
      this.tray.on('click', () => {
        this.openDashboard()
      })
      this.tray.on('right-click', () => {
        this.tray?.popUpContextMenu(this.buildMenu())
      })
    } else {
      this.tray.on('click', () => {
        this.toggleWindow()
      })
      this.tray.on('right-click', () => {
        this.tray?.popUpContextMenu(this.buildMenu())
      })
    }
  }

  private setupIpcHandlers(): void {
    ipcMain.on('tray:open-dashboard', () => {
      this.openDashboard()
    })

    ipcMain.on('tray:resize', (_event, height: number) => {
      this.trayWindow?.setHeight(height)
      if (this.trayWindow?.isVisible()) {
        const bounds = this.tray?.getBounds()
        if (bounds) {
          this.trayWindow.show(bounds)
        }
      }
    })

    ipcMain.on('tray:set-height', (_event, height: number) => {
      this.trayWindow?.setHeight(height)
    })

    ipcMain.on('tray:quit-app', () => {
      this.destroy()
      ;(app as any).isQuitting = true
      app.quit()
    })
  }

  private toggleWindow(): void {
    const bounds = this.tray?.getBounds()
    if (bounds && this.trayWindow) {
      this.trayWindow.toggle(bounds)
    }
  }

  private openDashboard(): void {
    if (this.mainWindow && !this.mainWindow.isDestroyed()) {
      if (this.mainWindow.isMinimized()) {
        this.mainWindow.restore()
      }
      this.mainWindow.show()
      this.mainWindow.focus()
    }
    this.trayWindow?.hide()
  }

  private buildMenu(): Menu {
    const config = ConfigManager.get()
    const isZh = config.language === 'zh-CN'
    const template: MenuItemConstructorOptions[] = [
      {
        label: isZh
          ? `状态: ${this.isRunning ? '运行中' : '已停止'}`
          : `Status: ${this.isRunning ? 'Running' : 'Stopped'}`,
        enabled: false,
      },
      {
        label: isZh
          ? this.isRunning
            ? '停止代理'
            : '启动代理'
          : this.isRunning
            ? 'Stop Proxy'
            : 'Start Proxy',
        click: () => {
          this.mainWindow?.webContents.send(this.isRunning ? 'proxy:stop' : 'proxy:start')
        },
      },
      { type: 'separator' },
      {
        label: isZh ? '打开主界面' : 'Open Dashboard',
        click: () => this.openDashboard(),
      },
      {
        label: isZh ? '退出 Chat2API' : 'Quit Chat2API',
        click: () => {
          this.destroy()
          ;(app as any).isQuitting = true
          app.quit()
        },
      },
    ]

    return Menu.buildFromTemplate(template)
  }

  private updateContextMenu(): void {
    if (!this.tray) return
    if (isLinux) {
      this.tray.setContextMenu(this.buildMenu())
    }
  }

  public updateProxyStatus(running: boolean): void {
    this.isRunning = running
    this.updateContextMenu()
  }

  public destroy(): void {
    this.trayWindow?.destroy()
    this.tray?.destroy()
    this.tray = null
    this.trayWindow = null
  }
}

export function createTrayManager(mainWindow: BrowserWindow): TrayManager {
  const manager = TrayManager.getInstance()
  manager.create(mainWindow)
  return manager
}
