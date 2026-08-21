import { app, BrowserWindow, safeStorage, shell } from 'electron'
import { homedir } from 'os'
import { join } from 'path'
import type { RuntimeAdapter } from './types'

export const electronRuntime: RuntimeAdapter = {
  kind: 'electron',

  getDataDir(): string {
    return join(homedir(), '.chat2api')
  },

  isEncryptionAvailable(): boolean {
    try {
      return safeStorage.isEncryptionAvailable()
    } catch {
      return false
    }
  },

  encryptString(value: string): string {
    return Buffer.from(safeStorage.encryptString(value)).toString('base64')
  },

  decryptString(value: string): string {
    return safeStorage.decryptString(Buffer.from(value, 'base64'))
  },

  getResourcePath(fileName: string): string {
    if (app.isPackaged) {
      return join(process.resourcesPath, fileName)
    }

    return join(app.getAppPath(), fileName)
  },

  async openExternal(url: string): Promise<void> {
    await shell.openExternal(url)
  },

  notify(channel: string, payload: unknown): void {
    BrowserWindow.getAllWindows().forEach((win) => {
      win.webContents.send(channel, payload)
    })
  },
}
