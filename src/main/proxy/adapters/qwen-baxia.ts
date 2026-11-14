/**
 * Qwen AI baxia (Aliyun anti-bot) session
 *
 * chat.qwen.ai sits behind an Aliyun WAF that returns an HTML challenge page
 * (HTTP 200, `aliyun_waf_aa` / `aliyun_waf_bb`) for requests that do not carry a
 * valid Aliyun "baxia" signature. The signature is produced by the baxia SDK
 * that runs inside the real web page and exposed as `window.__baxia__`.
 *
 * Chat2API is an Electron application, so we open a hidden browser window on
 * chat.qwen.ai, read the freshly minted `bx-ua` / `bx-umidtoken` values from
 * `window.__baxia__.getFYModule`, harvest the qwen.ai cookies, and replay them
 * on every API request. This mirrors the working approach from
 * https://github.com/smanx/qwen2api (scripts/baxia-token.js) without adding a
 * browser dependency.
 */

import { promises as fs } from 'fs'
import path from 'path'

export interface QwenBaxiaSession {
  bxUa: string
  bxUmidToken: string
  bxV: string
  cookies: string
  fetchedAt: number
}

const BAXIA_VERSION = '2.5.36'
const QWEN_URL = 'https://chat.qwen.ai/'
const QWEN_COOKIE_DOMAIN = 'qwen.ai'
const QWEN_USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36'

const SESSION_TTL_MS = 10 * 60 * 1000
const HARVEST_FAILURE_COOLDOWN_MS = 3 * 60 * 1000
const READY_TIMEOUT_MS = 45000

let memorySession: QwenBaxiaSession | null = null
let harvestPromise: Promise<QwenBaxiaSession | null> | null = null
let filePathPromise: Promise<string | null> | null = null
let nextHarvestAllowedAt = 0

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function isValidUmidToken(value: unknown): value is string {
  return typeof value === 'string' && /^T2gA/i.test(value) && value.length > 20
}

function isValidBaxiaSession(session: unknown): session is QwenBaxiaSession {
  if (!session || typeof session !== 'object') return false
  const candidate = session as QwenBaxiaSession
  return isValidUmidToken(candidate.bxUmidToken) && typeof candidate.bxUa === 'string' && candidate.bxUa.length > 10
}

/**
 * Detect the Aliyun WAF challenge. It is served as `text/html` (with HTTP 200
 * or 405) and contains the `aliyun_waf_*` markers, so a content-type check is
 * enough and works for both buffered and streaming responses.
 */
export function isQwenWafResponse(contentType: string | undefined, bodyPreview?: string): boolean {
  const ct = (contentType || '').toLowerCase()
  if (ct.includes('text/html')) {
    return true
  }
  if (bodyPreview) {
    const lower = bodyPreview.toLowerCase()
    if (lower.includes('aliyun_waf') || lower.includes('<html') || lower.includes('<!doctypehtml')) {
      return true
    }
  }
  return false
}

async function getSessionFilePath(): Promise<string | null> {
  if (!filePathPromise) {
    filePathPromise = (async () => {
      try {
        const electron = await import('electron')
        const app = (electron as any)?.app
        if (!app || typeof app.getPath !== 'function') {
          return null
        }
        return path.join(app.getPath('userData'), 'qwen-baxia-session.json')
      } catch {
        return null
      }
    })()
  }
  return filePathPromise
}

async function readStoredSession(): Promise<QwenBaxiaSession | null> {
  const filePath = await getSessionFilePath()
  if (!filePath) return null
  try {
    const raw = await fs.readFile(filePath, 'utf8')
    const parsed = JSON.parse(raw) as QwenBaxiaSession
    if (!isValidBaxiaSession(parsed)) return null
    return parsed
  } catch {
    return null
  }
}

async function persistSession(session: QwenBaxiaSession): Promise<void> {
  const filePath = await getSessionFilePath()
  if (!filePath) return
  try {
    await fs.mkdir(path.dirname(filePath), { recursive: true })
    await fs.writeFile(filePath, JSON.stringify(session), 'utf8')
  } catch (error) {
    console.warn('[QwenAI] Failed to persist baxia session:', error)
  }
}

function isFresh(session: QwenBaxiaSession | null): session is QwenBaxiaSession {
  return !!session && Date.now() - session.fetchedAt < SESSION_TTL_MS
}

async function waitForExpression(
  win: any,
  expression: string,
  timeoutMs: number,
  intervalMs = 500,
): Promise<any> {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    try {
      const value = await win.webContents.executeJavaScript(expression, true)
      if (value) return value
    } catch {
      // Page not ready yet
    }
    await delay(intervalMs)
  }
  return null
}

async function harvestSession(): Promise<QwenBaxiaSession | null> {
  let BrowserWindow: any
  try {
    const electron = await import('electron')
    BrowserWindow = (electron as any)?.BrowserWindow
    const session = (electron as any)?.session
    if (!BrowserWindow || !session) {
      return null
    }
  } catch {
    return null
  }

  const partition = 'persist:qwen-baxia'
  const ses = (await import('electron')).session.fromPartition(partition)
  const win = new BrowserWindow({
    show: false,
    width: 1280,
    height: 800,
    webPreferences: {
      partition,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
    },
  })

  try {
    win.webContents.setUserAgent(QWEN_USER_AGENT)
    await win.loadURL(QWEN_URL, { userAgent: QWEN_USER_AGENT })

    const info = await waitForExpression(
      win,
      `(function () {
        var fm = (window.__baxia__ || {}).getFYModule
        if (!fm || !fm.fyObj) return null
        var uid = ''
        var fy = ''
        try { uid = String(fm.getUidToken()) } catch (e) {}
        try { fy = String(fm.getFYToken()) } catch (e) {}
        if (!uid || uid.length < 20) return null
        return { uid: uid, fy: fy }
      })()`,
      READY_TIMEOUT_MS,
    )

    if (!info || !isValidUmidToken(info.uid)) {
      throw new Error('chat.qwen.ai baxia SDK did not expose a valid token')
    }

    let cookies = ''
    try {
      const jar = await ses.cookies.get({ domain: QWEN_COOKIE_DOMAIN })
      cookies = jar
        .filter((cookie: any) => cookie?.name && cookie?.value)
        .map((cookie: any) => `${cookie.name}=${cookie.value}`)
        .join('; ')
    } catch (error) {
      console.warn('[QwenAI] Failed to read baxia cookies:', error)
    }

    const session: QwenBaxiaSession = {
      bxUa: info.fy || `231!${info.uid}`,
      bxUmidToken: info.uid,
      bxV: BAXIA_VERSION,
      cookies,
      fetchedAt: Date.now(),
    }

    console.log('[QwenAI] Harvested baxia session:', {
      uid: session.bxUmidToken.substring(0, 12) + '...',
      cookies: cookies ? cookies.split('; ').length : 0,
    })
    return session
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

async function refillSession(force: boolean): Promise<QwenBaxiaSession | null> {
  if (harvestPromise) {
    return harvestPromise
  }
  if (Date.now() < nextHarvestAllowedAt) {
    return memorySession
  }
  harvestPromise = (async () => {
    try {
      const session = await harvestSession()
      if (session) {
        memorySession = session
        nextHarvestAllowedAt = 0
        await persistSession(session)
      }
    } catch (error) {
      nextHarvestAllowedAt = Date.now() + HARVEST_FAILURE_COOLDOWN_MS
      console.warn('[QwenAI] Baxia session harvesting failed:', error)
    }
    return memorySession
  })().finally(() => {
    harvestPromise = null
  })
  return harvestPromise
}

/**
 * Return a fresh baxia session, harvesting one when the cache is missing or
 * stale. Pass `forceRefresh` after an upstream WAF challenge. Returns null when
 * no browser window can be opened (for example headless CI), in which case the
 * caller should still attempt the request without baxia headers.
 */
export async function getQwenBaxiaSession(forceRefresh = false): Promise<QwenBaxiaSession | null> {
  if (!memorySession) {
    memorySession = await readStoredSession()
  }

  if (!forceRefresh && isFresh(memorySession)) {
    return memorySession
  }

  return refillSession(forceRefresh)
}

/** Test helper: clear the in-memory session cache. */
export function resetQwenBaxiaSessionForTests(): void {
  memorySession = null
  harvestPromise = null
  filePathPromise = null
  nextHarvestAllowedAt = 0
}

/** Test helper: seed the in-memory session cache. */
export function setQwenBaxiaSessionForTests(session: QwenBaxiaSession | null): void {
  memorySession = session
}