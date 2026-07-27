import { decryptCredential, encryptCredential } from '../keyManager.ts'

export const app = {
  isPackaged: false,
  getAppPath(): string {
    return process.env.CHAT2API_RESOURCE_DIR || '/app/resources'
  },
}

export const safeStorage = {
  isEncryptionAvailable(): boolean {
    return true
  },
  encryptString(value: string): Buffer {
    return encryptCredential(value)
  },
  decryptString(value: Buffer): string {
    return decryptCredential(Buffer.from(value))
  },
}

export class BrowserWindow {
  constructor() {
    throw new Error('BrowserWindow is unavailable in Chat2API Headless')
  }
}

export const net = {
  request(): never {
    throw new Error('electron.net is unavailable; Perplexity is not supported by Chat2API Headless')
  },
}
