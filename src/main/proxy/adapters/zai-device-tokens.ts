/**
 * Z.ai device-token pool
 *
 * Z.ai's captcha uses Aliyun Captcha V3. Verification needs a device token that
 * can only be minted by the Aliyun Captcha SDK running inside a real browser
 * page. Chat2API is an Electron application, so we open a hidden browser window
 * on chat.z.ai, trigger the captcha SDK the same way the web frontend does, and
 * call `window.z_um.getToken()` repeatedly to fill a pool.
 *
 * Tokens are single-use and short lived, so they are persisted to disk and
 * replenished in batches. This mirrors the Playwright collector used by
 * https://github.com/chaoticmindv/zai2api without adding a browser dependency.
 */

import { promises as fs } from 'fs'
import path from 'path'
import type { DeviceTokenSource } from './zai-captcha'

const TOKEN_PREFIX = 'U0dfV0VC'
const TOKEN_TTL_MS = 12 * 60 * 60 * 1000
const TOKEN_TARGET = 30
const TOKEN_LOW_WATER = 6
const TOKEN_MAX_STORED = 120
const ZAI_URL = 'https://chat.z.ai/'
const ZAI_USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36'

interface StoredDeviceToken {
  token: string
  fetchedAt: number
}

interface TokenFile {
  version: 1
  tokens: StoredDeviceToken[]
}

let memoryTokens: StoredDeviceToken[] | null = null
let loadPromise: Promise<void> | null = null
let harvestPromise: Promise<void> | null = null
let filePathPromise: Promise<string | null> | null = null
let nextHarvestAllowedAt = 0
const HARVEST_FAILURE_COOLDOWN_MS = 5 * 60 * 1000

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function isValidDeviceToken(value: unknown): value is string {
  return typeof value === 'string' && value.startsWith(TOKEN_PREFIX) && value.length >= 30
}

async function getTokenFilePath(): Promise<string | null> {
  if (!filePathPromise) {
    filePathPromise = (async () => {
      try {
        const electron = await import('electron')
        const app = (electron as any)?.app
        if (!app || typeof app.getPath !== 'function') {
          return null
        }
        return path.join(app.getPath('userData'), 'zai-captcha-tokens.json')
      } catch {
        return null
      }
    })()
  }
  return filePathPromise
}

async function readStoredTokens(): Promise<StoredDeviceToken[]> {
  const filePath = await getTokenFilePath()
  if (!filePath) {
    return []
  }
  try {
    const raw = await fs.readFile(filePath, 'utf8')
    const parsed = JSON.parse(raw) as TokenFile
    if (!parsed || !Array.isArray(parsed.tokens)) {
      return []
    }
    return parsed.tokens.filter((entry) => isValidDeviceToken(entry?.token))
  } catch {
    return []
  }
}

async function persistTokens(tokens: StoredDeviceToken[]): Promise<void> {
  const filePath = await getTokenFilePath()
  if (!filePath) {
    return
  }
  try {
    const payload: TokenFile = { version: 1, tokens: tokens.slice(-TOKEN_MAX_STORED) }
    await fs.mkdir(path.dirname(filePath), { recursive: true })
    await fs.writeFile(filePath, JSON.stringify(payload), 'utf8')
  } catch (error) {
    console.warn('[Z.ai] Failed to persist device tokens:', error)
  }
}

async function ensureLoaded(): Promise<void> {
  if (memoryTokens) {
    return
  }
  if (!loadPromise) {
    loadPromise = (async () => {
      memoryTokens = await readStoredTokens()
    })().finally(() => {
      loadPromise = null
    })
  }
  await loadPromise
}

function pruneExpired(tokens: StoredDeviceToken[]): StoredDeviceToken[] {
  const now = Date.now()
  return tokens.filter((entry) => now - entry.fetchedAt < TOKEN_TTL_MS)
}

async function waitForExpression(
  win: any,
  expression: string,
  timeoutMs: number,
  intervalMs = 500,
): Promise<boolean> {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    try {
      const value = await win.webContents.executeJavaScript(expression, true)
      if (value) {
        return true
      }
    } catch {
      // Page not ready yet
    }
    await delay(intervalMs)
  }
  return false
}

async function harvestDeviceTokens(count: number): Promise<string[]> {
  let BrowserWindow: any
  try {
    const electron = await import('electron')
    BrowserWindow = (electron as any)?.BrowserWindow
  } catch (error) {
    throw new Error(`Electron is not available: ${error instanceof Error ? error.message : String(error)}`)
  }
  if (!BrowserWindow) {
    throw new Error('Electron BrowserWindow is not available in this runtime')
  }

  const win = new BrowserWindow({
    show: false,
    width: 1280,
    height: 900,
    webPreferences: {
      partition: 'persist:zai-captcha',
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
    },
  })

  try {
    win.webContents.setUserAgent(ZAI_USER_AGENT)
    await win.loadURL(ZAI_URL, { userAgent: ZAI_USER_AGENT })

    const hasInput = await waitForExpression(
      win,
      "Boolean(document.querySelector('#chat-input'))",
      60000,
    )
    if (!hasInput) {
      throw new Error('chat.z.ai chat input did not appear')
    }

    // Trigger the captcha SDK by sending a throwaway message, exactly like the
    // web frontend does before it has a captcha parameter.
    await win.webContents.executeJavaScript(
      `(() => {
        const input = document.querySelector('#chat-input')
        if (!input) return false
        const value = '__'
        if (input.tagName === 'TEXTAREA' || input.tagName === 'INPUT') {
          const proto = input.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
          const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set
          if (setter) setter.call(input, value)
          else input.value = value
          input.dispatchEvent(new Event('input', { bubbles: true }))
          input.dispatchEvent(new Event('change', { bubbles: true }))
        } else {
          input.textContent = value
          input.dispatchEvent(new InputEvent('input', { bubbles: true, data: value, inputType: 'insertText' }))
        }
        input.focus()
        const button = document.querySelector('#send-message-button')
        if (button) {
          button.click()
          return true
        }
        return false
      })()`,
      true,
    )

    const captchaReady = await waitForExpression(
      win,
      "typeof window.z_um !== 'undefined' && typeof window.z_um.getToken === 'function'",
      90000,
    )
    if (!captchaReady) {
      throw new Error('Z.ai captcha SDK did not expose window.z_um.getToken')
    }

    const rawTokens: Array<string | null> = await win.webContents.executeJavaScript(
      `(async () => {
        const tokens = []
        for (let i = 0; i < ${count}; i++) {
          try {
            const token = await Promise.race([
              Promise.resolve(window.z_um.getToken()),
              new Promise((resolve) => setTimeout(() => resolve(null), 10000)),
            ])
            tokens.push(token)
          } catch (error) {
            tokens.push(null)
          }
        }
        return tokens
      })()`,
      true,
    )

    const seen = new Set<string>()
    const valid: string[] = []
    for (const token of rawTokens || []) {
      if (isValidDeviceToken(token) && !seen.has(token)) {
        seen.add(token)
        valid.push(token)
      }
    }
    console.log(`[Z.ai] Harvested ${valid.length}/${count} captcha device tokens`)
    return valid
  } finally {
    try {
      if (!win.isDestroyed()) {
        win.destroy()
      }
    } catch {
      // Ignore teardown errors
    }
  }
}

async function refillTokenPool(force: boolean): Promise<void> {
  if (harvestPromise) {
    return harvestPromise
  }
  if (Date.now() < nextHarvestAllowedAt) {
    return
  }
  harvestPromise = (async () => {
    await ensureLoaded()
    memoryTokens = pruneExpired(memoryTokens || [])
    const missing = TOKEN_TARGET - memoryTokens.length
    if (missing <= 0 && !force) {
      return
    }
    const batch = Math.min(Math.max(missing, 10), 40)
    try {
      const tokens = await harvestDeviceTokens(batch)
      const now = Date.now()
      const existing = new Set((memoryTokens || []).map((entry) => entry.token))
      const additions = tokens
        .filter((token) => !existing.has(token))
        .map((token) => ({ token, fetchedAt: now }))
      memoryTokens = pruneExpired([...(memoryTokens || []), ...additions]).slice(-TOKEN_MAX_STORED)
      await persistTokens(memoryTokens)
    } catch (error) {
      nextHarvestAllowedAt = Date.now() + HARVEST_FAILURE_COOLDOWN_MS
      console.warn('[Z.ai] Captcha device token harvesting failed:', error)
    }
  })().finally(() => {
    harvestPromise = null
  })
  return harvestPromise
}

/**
 * Take one device token from the pool, harvesting more when the pool runs low.
 * Returns null when no browser window can be opened (for example headless CI).
 */
export async function takeZaiDeviceToken(): Promise<string | null> {
  await ensureLoaded()
  memoryTokens = pruneExpired(memoryTokens || [])

  if (memoryTokens.length === 0) {
    await refillTokenPool(true)
    memoryTokens = pruneExpired(memoryTokens || [])
  } else if (memoryTokens.length <= TOKEN_LOW_WATER) {
    void refillTokenPool(false)
  }

  const next = memoryTokens.shift()
  if (next) {
    void persistTokens(memoryTokens)
    return next.token
  }
  return null
}

export const zaiDeviceTokenSource: DeviceTokenSource = {
  takeToken: takeZaiDeviceToken,
}

export async function getZaiDeviceTokenCount(): Promise<number> {
  await ensureLoaded()
  memoryTokens = pruneExpired(memoryTokens || [])
  return memoryTokens.length
}

/** Test helper: clear the in-memory pool. */
export function resetZaiDeviceTokenPoolForTests(): void {
  memoryTokens = []
  loadPromise = null
  harvestPromise = null
  filePathPromise = null
  nextHarvestAllowedAt = 0
}
