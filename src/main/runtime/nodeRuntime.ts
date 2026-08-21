import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'crypto'
import { existsSync } from 'fs'
import { homedir } from 'os'
import { join, resolve } from 'path'
import type { RuntimeAdapter } from './types.ts'

const ENCRYPTION_PREFIX = 'c2a:v1:'

function getEncryptionKey(): Buffer | null {
  const secret = process.env.CHAT2API_STORAGE_ENCRYPTION_KEY
  if (!secret) {
    return null
  }
  return createHash('sha256').update(secret).digest()
}

export const nodeRuntime: RuntimeAdapter = {
  kind: 'node',

  getDataDir(): string {
    if (process.env.CHAT2API_DATA_DIR) {
      return resolve(process.env.CHAT2API_DATA_DIR)
    }

    if (process.env.NODE_ENV === 'production') {
      return '/data'
    }

    return join(homedir(), '.chat2api')
  },

  isEncryptionAvailable(): boolean {
    return getEncryptionKey() !== null
  },

  encryptString(value: string): string {
    const key = getEncryptionKey()
    if (!key) {
      return value
    }

    const iv = randomBytes(12)
    const cipher = createCipheriv('aes-256-gcm', key, iv)
    const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()])
    const tag = cipher.getAuthTag()

    return `${ENCRYPTION_PREFIX}${Buffer.concat([iv, tag, encrypted]).toString('base64')}`
  },

  decryptString(value: string): string {
    const key = getEncryptionKey()
    if (!key || !value.startsWith(ENCRYPTION_PREFIX)) {
      return value
    }

    const payload = Buffer.from(value.slice(ENCRYPTION_PREFIX.length), 'base64')
    const iv = payload.subarray(0, 12)
    const tag = payload.subarray(12, 28)
    const encrypted = payload.subarray(28)
    const decipher = createDecipheriv('aes-256-gcm', key, iv)
    decipher.setAuthTag(tag)

    return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8')
  },

  getResourcePath(fileName: string): string {
    const candidates = [
      resolve(process.cwd(), fileName),
      resolve(process.cwd(), 'resources', fileName),
      resolve(__dirname, '..', '..', '..', fileName),
    ]

    return candidates.find((candidate) => existsSync(candidate)) || candidates[0]
  },

  async openExternal(url: string): Promise<void> {
    console.log(`[Runtime] Open this URL manually: ${url}`)
  },

  notify(): void {
  },
}
