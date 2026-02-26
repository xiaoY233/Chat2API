import { Tray, Menu, nativeImage, BrowserWindow, app, MenuItem } from 'electron'
import { join } from 'path'
import { getProxyStatus } from './ipc/handlers'

let tray: Tray | null = null
let isProxyRunning = false

function loadAppIcon(): nativeImage {
  const iconPath = join(__dirname, '../../build/icon.png')
  
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

function createRunningIcon(): nativeImage {
  const iconPath = join(__dirname, '../../build/icon.png')
  
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
  
  return createFallbackRunningIcon()
}

function createFallbackRunningIcon(): nativeImage {
  const size = 22
  const canvas = Buffer.alloc(size * size * 4)
  
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const index = (y * size + x) * 4
      const centerX = size / 2
      const centerY = size / 2
      const distance = Math.sqrt((x - centerX) ** 2 + (y - centerY) ** 2)
      
      if (distance < size / 2 - 1) {
        canvas[index] = 34
        canvas[index + 1] = 197
        canvas[index + 2] = 94
        canvas[index + 3] = 255
      } else {
        canvas[index + 3] = 0
      }
    }
  }
  
  return nativeImage.createFromBuffer(canvas, { width: size, height: size })
}

export function createTray(mainWindow: BrowserWindow | null): Tray {
  if (tray) {
    return tray
  }

  const icon = loadAppIcon()

  tray = new Tray(icon)

  const contextMenu = buildContextMenu(mainWindow)
  tray.setToolTip('Chat2API')
  tray.setContextMenu(contextMenu)

  tray.on('double-click', () => {
    mainWindow?.show()
    mainWindow?.focus()
  })

  tray.on('click', () => {
    mainWindow?.show()
    mainWindow?.focus()
  })

  return tray
}

function buildContextMenu(mainWindow: BrowserWindow | null): Menu {
  const proxyStatus = getProxyStatus()
  isProxyRunning = proxyStatus.isRunning

  const proxyStatusLabel = isProxyRunning ? 'Stop Proxy Service' : 'Start Proxy Service'

  return Menu.buildFromTemplate([
    {
      label: 'Show Main Window',
      click: () => {
        mainWindow?.show()
        mainWindow?.focus()
      },
    },
    {
      type: 'separator',
    },
    {
      label: proxyStatusLabel,
      click: () => {
        toggleProxy(mainWindow)
      },
    },
    {
      label: isProxyRunning ? `Proxy Running (Port: ${proxyStatus.port})` : 'Proxy Not Running',
      enabled: false,
    },
    {
      type: 'separator',
    },
    {
      label: 'Restart Application',
      click: () => {
        app.relaunch()
        app.quit()
      },
    },
    {
      label: 'Exit',
      click: () => {
        (app as any).isQuitting = true
        app.quit()
      },
    },
  ])
}

async function toggleProxy(mainWindow: BrowserWindow | null): Promise<void> {
  try {
    if (isProxyRunning) {
      mainWindow?.webContents.send('proxy:stop')
    } else {
      mainWindow?.webContents.send('proxy:start')
    }
  } catch (error) {
    console.error('Failed to toggle proxy status:', error)
  }
}

export function updateTrayIcon(isRunning: boolean): void {
  if (!tray) return

  isProxyRunning = isRunning

  const icon = isRunning ? createRunningIcon() : loadAppIcon()

  tray.setImage(icon)

  const statusText = isRunning ? 'Proxy Running' : 'Proxy Stopped'
  tray.setToolTip(`Chat2API - ${statusText}`)
}

export function updateTrayMenu(mainWindow: BrowserWindow | null): void {
  if (!tray) return

  const contextMenu = buildContextMenu(mainWindow)
  tray.setContextMenu(contextMenu)
}

export function destroyTray(): void {
  if (tray) {
    tray.destroy()
    tray = null
  }
}

export function getTray(): Tray | null {
  return tray
}

export function setTrayTooltip(tooltip: string): void {
  tray?.setToolTip(tooltip)
}

export function showTrayBalloon(title: string, content: string): void {
  tray?.displayBalloon({
    title,
    content,
    iconType: 'info',
  })
}
