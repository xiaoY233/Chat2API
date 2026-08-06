import { BrowserWindow, screen, Rectangle } from 'electron'
import path from 'path'

const isWindows = process.platform === 'win32'
const isMac = process.platform === 'darwin'
const isLinux = process.platform === 'linux'

export class TrayWindow {
  private window: BrowserWindow | null = null
  private isShowing: boolean = false

  constructor() {
    this.createWindow()
  }

  private createWindow(): void {
    this.window = new BrowserWindow({
      width: 340,
      height: 460,
      show: false,
      frame: false,
      fullscreenable: false,
      resizable: false,
      transparent: true,
      alwaysOnTop: true,
      skipTaskbar: true,
      hasShadow: true,
      ...(isMac
        ? {
            vibrancy: 'under-window',
            visualEffectState: 'active',
          }
        : {
            backgroundColor: '#00000000',
          }),
      webPreferences: {
        preload: path.join(__dirname, '../preload/index.js'),
        sandbox: false,
        nodeIntegration: false,
        contextIsolation: true,
      },
    })

    if (process.env.NODE_ENV === 'development' && process.env.ELECTRON_RENDERER_URL) {
      this.window.loadURL(`${process.env.ELECTRON_RENDERER_URL}#tray`)
    } else {
      this.window.loadFile(path.join(__dirname, '../renderer/index.html'), {
        hash: 'tray',
      })
    }

    this.window.on('blur', () => {
      if (this.isShowing) return
      if (!this.window?.webContents.isDevToolsOpened()) {
        this.hide()
      }
    })
  }

  public show(trayBounds: Rectangle): void {
    if (!this.window) return

    this.isShowing = true

    const windowBounds = this.window.getBounds()
    const primaryDisplay = screen.getPrimaryDisplay()
    const workArea = primaryDisplay.workAreaSize
    const displayBounds = primaryDisplay.bounds

    let x = Math.round(trayBounds.x + trayBounds.width / 2 - windowBounds.width / 2)

    let y: number
    if (isWindows || isLinux) {
      const taskbarAtBottom = trayBounds.y > displayBounds.height / 2
      if (taskbarAtBottom) {
        y = Math.round(trayBounds.y - windowBounds.height - 4)
      } else {
        y = Math.round(trayBounds.y + trayBounds.height + 4)
      }
    } else {
      y = Math.round(trayBounds.y + trayBounds.height + 4)
    }

    if (x + windowBounds.width > workArea.width) {
      x = workArea.width - windowBounds.width - 10
    }
    if (x < 10) {
      x = 10
    }
    if (y < 10) {
      y = 10
    }
    if (y + windowBounds.height > workArea.height) {
      y = workArea.height - windowBounds.height - 10
    }

    this.window.setPosition(x, y, false)

    this.window.setOpacity(0)
    this.window.show()
    this.window.focus()

    let opacity = 0
    const fadeInterval = setInterval(() => {
      opacity += 0.15
      if (opacity >= 1) {
        this.window?.setOpacity(1)
        clearInterval(fadeInterval)
        setTimeout(() => {
          this.isShowing = false
        }, 100)
      } else {
        this.window?.setOpacity(opacity)
      }
    }, 16)
  }

  public hide(): void {
    this.window?.hide()
  }

  public toggle(trayBounds: Rectangle): void {
    if (this.window?.isVisible()) {
      this.hide()
    } else {
      this.show(trayBounds)
    }
  }

  public isVisible(): boolean {
    return this.window?.isVisible() ?? false
  }

  public setHeight(height: number): void {
    if (!this.window) return
    const [width] = this.window.getSize()
    const newHeight = Math.min(Math.max(height, 100), 800)
    this.window.setSize(width, newHeight, false)
  }

  public destroy(): void {
    this.window?.close()
    this.window = null
  }
}
