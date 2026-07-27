import {
  createCipheriv,
  createDecipheriv,
  hkdfSync,
  randomBytes,
  randomUUID,
} from 'node:crypto'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const MASTER_KEY_BYTES = 32
const NONCE_BYTES = 12
const AUTH_TAG_BYTES = 16
const CREDENTIAL_MAGIC = Buffer.from('C2AH01', 'ascii')
const HKDF_SALT = Buffer.from('chat2api-headless-v1', 'utf8')

let cachedMasterKey: Buffer | undefined

export function getDataDirectory(): string {
  return process.env.CHAT2API_DATA_DIR || join(homedir(), '.chat2api')
}

export function ensureDataDirectory(): string {
  const directory = getDataDirectory()
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  try {
    chmodSync(directory, 0o700)
  } catch (error) {
    if (process.platform !== 'win32') {
      throw new Error(`Cannot secure data directory ${directory}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  return directory
}

function loadMasterKey(): Buffer {
  if (cachedMasterKey) return cachedMasterKey

  const directory = ensureDataDirectory()
  const keyPath = process.env.CHAT2API_MASTER_KEY_FILE || join(directory, 'master.key')

  if (!existsSync(keyPath)) {
    if (process.env.CHAT2API_MASTER_KEY_FILE) {
      throw new Error(`Master key file does not exist: ${keyPath}`)
    }
    if (existsSync(join(directory, 'data.json'))) {
      throw new Error(`Master key is missing while persisted data exists: ${keyPath}`)
    }
    const temporaryPath = `${keyPath}.${process.pid}.tmp`
    writeFileSync(temporaryPath, randomBytes(MASTER_KEY_BYTES), { flag: 'wx', mode: 0o600 })
    renameSync(temporaryPath, keyPath)
  }

  const key = readFileSync(keyPath)
  if (key.length !== MASTER_KEY_BYTES) {
    throw new Error(`Master key must contain exactly ${MASTER_KEY_BYTES} bytes: ${keyPath}`)
  }

  try {
    chmodSync(keyPath, 0o600)
  } catch (error) {
    if (process.platform !== 'win32') {
      throw new Error(`Cannot secure master key ${keyPath}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  cachedMasterKey = Buffer.from(key)
  return cachedMasterKey
}

function deriveKey(purpose: 'credentials' | 'store'): Buffer {
  return Buffer.from(hkdfSync('sha256', loadMasterKey(), HKDF_SALT, purpose, 32))
}

export function getStoreEncryptionKey(): Buffer {
  return deriveKey('store')
}

export function encryptCredential(value: string): Buffer {
  const nonce = randomBytes(NONCE_BYTES)
  const cipher = createCipheriv('aes-256-gcm', deriveKey('credentials'), nonce)
  const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()])
  const authTag = cipher.getAuthTag()
  return Buffer.concat([CREDENTIAL_MAGIC, nonce, authTag, ciphertext])
}

export function decryptCredential(value: Buffer): string {
  const minimumLength = CREDENTIAL_MAGIC.length + NONCE_BYTES + AUTH_TAG_BYTES
  if (value.length < minimumLength || !value.subarray(0, CREDENTIAL_MAGIC.length).equals(CREDENTIAL_MAGIC)) {
    throw new Error('Unsupported or corrupted credential ciphertext')
  }

  const nonceStart = CREDENTIAL_MAGIC.length
  const tagStart = nonceStart + NONCE_BYTES
  const ciphertextStart = tagStart + AUTH_TAG_BYTES
  const decipher = createDecipheriv(
    'aes-256-gcm',
    deriveKey('credentials'),
    value.subarray(nonceStart, tagStart),
  )
  decipher.setAuthTag(value.subarray(tagStart, ciphertextStart))
  return Buffer.concat([
    decipher.update(value.subarray(ciphertextStart)),
    decipher.final(),
  ]).toString('utf8')
}

export function getManagementSecret(): string {
  const directory = ensureDataDirectory()
  const configuredPath = process.env.CHAT2API_MANAGEMENT_SECRET_FILE
  const secretPath = configuredPath || join(directory, 'management-secret')

  if (configuredPath && !existsSync(secretPath)) {
    throw new Error(`Management secret file does not exist: ${secretPath}`)
  }

  if (!existsSync(secretPath)) {
    const temporaryPath = `${secretPath}.${process.pid}.tmp`
    writeFileSync(temporaryPath, `mgmt_${randomUUID()}\n`, { flag: 'wx', mode: 0o600 })
    renameSync(temporaryPath, secretPath)
  }

  const secret = readFileSync(secretPath, 'utf8').trim()
  if (!secret.startsWith('mgmt_') || secret.length < 20) {
    throw new Error(`Invalid management secret in ${secretPath}`)
  }

  try {
    chmodSync(secretPath, 0o600)
  } catch (error) {
    if (process.platform !== 'win32') {
      throw new Error(`Cannot secure management secret ${secretPath}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  return secret
}

export function resetKeyCacheForTests(): void {
  cachedMasterKey = undefined
}
