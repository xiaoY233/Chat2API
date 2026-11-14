/**
 * Inception (Mercury) web protocol helpers.
 *
 * The public playground at https://chat.inceptionlabs.ai is an anonymous
 * Vercel-hosted app guarded by the Vercel Security Checkpoint. Talking to it
 * requires three steps:
 *
 *   1. Clear the checkpoint: a v2 proof-of-work that yields the `_vcrcs`
 *      cookie (see solveVercelChallenge / acquireInceptionClearance).
 *   2. GET /api/session  -> { ok: true, token }
 *   3. POST /api/chat with `x-session-token` and the AI SDK "useChat" body,
 *      which streams Vercel AI data-stream events (text-delta, reasoning-delta,
 *      source-url, ...).
 *
 * No official API key is involved, and the playground has no account system:
 * the `_vcrcs` clearance cookie is the whole credential. The proof-of-work is
 * ported from the verified reference implementation
 * (github.com/bacteriaw/inceptionlabs2api) so the app can self-heal clearance
 * without a browser.
 */

import axios from 'axios'
import crypto from 'crypto'

export const INCEPTION_API_BASE = 'https://chat.inceptionlabs.ai'
export const INCEPTION_LOGIN_URL = 'https://chat.inceptionlabs.ai/'
export const INCEPTION_DEFAULT_MODEL = 'mercury-3'
export const INCEPTION_MODELS = ['mercury-3']

/**
 * A single Chrome UA used for both clearance acquisition and every upstream
 * request. The `_vcrcs` cookie is UA-bound, so the two must never diverge.
 */
export const INCEPTION_USER_AGENT =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36'

const CHALLENGE_PATH = '/.well-known/vercel/security/request-challenge'
const CLEARANCE_COOKIE_PREFIX = '_vcrc'
const CLEARANCE_TTL_MS = 45 * 60 * 1000

// ---------------------------------------------------------------------------
// Vercel Security Checkpoint v2 proof-of-work
// ---------------------------------------------------------------------------

const PREFIX_LEN = 4
const MULTIPLIERS = [498787, 533737, 619763, 708403, 828071]

/**
 * Solve a Vercel checkpoint v2 token. Token layout:
 *
 *   <version>.<seed>.<ttl>.<b64(payload)>.<signature>
 *   payload = <id>;<prefix>;<target>;<rounds>;<binary>
 *
 * Each round finds a suffix h so that sha256(prefix + h) starts with the
 * current 4-hex-char target; the next target is a 4-char slice of that digest
 * at a seed-dependent offset. The nonce is a counter: the server only cares
 * that the digests match.
 */
export function solveVercelChallenge(token: string): string {
  const parts = token.split('.')
  if (parts.length < 4) {
    throw new Error(`malformed challenge token: ${parts.length} dot-parts`)
  }
  const seed = BigInt(parseInt(parts[1], 10))
  if (!Number.isFinite(Number(parts[1]))) {
    throw new Error('malformed challenge seed')
  }
  const raw = Buffer.from(parts[3], 'base64').toString('utf8')
  const fields = raw.split(';')
  if (fields.length < 4) {
    throw new Error(`malformed challenge payload: ${fields.length} fields`)
  }
  const prefix = fields[1]
  const target = fields[2]
  const rounds = parseInt(fields[3], 10)
  if (!Number.isFinite(rounds) || rounds < 1) {
    throw new Error(`malformed challenge rounds: ${fields[3]}`)
  }

  const mul = BigInt(MULTIPLIERS[((Number(seed) % 5) + 5) % 5])
  const key = Number((((seed * mul) % 36n) + 36n) % 36n)
  if (target.length < key + PREFIX_LEN) {
    throw new Error('challenge target too short for key offset')
  }
  let current = target.slice(key, key + PREFIX_LEN)

  const out: string[] = []
  let nonce = 0n
  for (let round = 0; round < rounds; round++) {
    for (;;) {
      const h = nonce.toString(16).padStart(16, '0')
      nonce += 1n
      const digest = crypto.createHash('sha256').update(prefix + h).digest('hex')
      if (digest.slice(0, PREFIX_LEN) !== current) continue
      out.push(h)
      const off = Number((((seed * BigInt(MULTIPLIERS[round % 5])) % 60n) + 60n) % 60n)
      current = digest.slice(off, off + PREFIX_LEN)
      break
    }
  }
  return out.join(';')
}

// ---------------------------------------------------------------------------
// Clearance acquisition
// ---------------------------------------------------------------------------

function extractClearanceCookie(setCookie: string | string[] | undefined): string {
  if (!setCookie) return ''
  const list = Array.isArray(setCookie) ? setCookie : [setCookie]
  for (const entry of list) {
    const pair = entry.split(';')[0]
    if (pair.startsWith(CLEARANCE_COOKIE_PREFIX)) {
      return pair
    }
  }
  return ''
}

/**
 * Acquire a fresh `_vcrcs` clearance cookie by solving the checkpoint.
 * Returns '' when the egress is already welcome and sets no cookie.
 */
export async function acquireInceptionClearance(): Promise<string> {
  const probe = await axios.get(`${INCEPTION_API_BASE}/api/session`, {
    headers: {
      'User-Agent': INCEPTION_USER_AGENT,
      Accept: '*/*',
      'Accept-Language': 'en-US,en;q=0.9',
    },
    timeout: 20000,
    maxRedirects: 0,
    validateStatus: () => true,
  })

  if (probe.status === 200) {
    const existing = extractClearanceCookie(probe.headers['set-cookie'])
    if (existing) return existing
    return ''
  }

  const token = probe.headers['x-vercel-challenge-token'] as string | undefined
  if (!token) {
    throw new Error(
      `Inception: expected a Vercel challenge, got HTTP ${probe.status} without x-vercel-challenge-token`,
    )
  }
  if (probe.status !== 429 && probe.status !== 403) {
    throw new Error(`Inception: expected a Vercel challenge, got HTTP ${probe.status}`)
  }

  const solution = solveVercelChallenge(token)

  const submit = await axios.post(`${INCEPTION_API_BASE}${CHALLENGE_PATH}`, null, {
    headers: {
      'User-Agent': INCEPTION_USER_AGENT,
      Accept: '*/*',
      'Accept-Language': 'en-US,en;q=0.9',
      Origin: INCEPTION_API_BASE,
      Referer: `${INCEPTION_API_BASE}/.well-known/vercel/security/static/challenge.v2.min.js`,
      'Sec-Fetch-Site': 'same-origin',
      'Sec-Fetch-Mode': 'cors',
      'Sec-Fetch-Dest': 'empty',
      'x-vercel-challenge-token': token,
      'x-vercel-challenge-solution': solution,
      'x-vercel-challenge-version': '2',
    },
    timeout: 20000,
    maxRedirects: 0,
    validateStatus: () => true,
  })

  if (submit.status === 403) {
    throw new Error('Inception: the checkpoint rejected the proof of work (version drift?)')
  }
  if (submit.status !== 204 && submit.status !== 200) {
    throw new Error(`Inception: checkpoint solution rejected with HTTP ${submit.status}`)
  }
  const cookie = extractClearanceCookie(submit.headers['set-cookie'])
  if (!cookie) {
    throw new Error('Inception: checkpoint response carried no _vcrc* cookie')
  }
  return cookie
}

let cachedClearance: { cookie: string; at: number } | null = null

/**
 * Return a usable clearance cookie. A caller-supplied cookie (e.g. captured by
 * the in-app login window) always wins, so the app can reuse a live browser
 * session. Otherwise a natively solved cookie is cached for its safe lifetime.
 */
export async function getInceptionClearance(preferred?: string): Promise<string> {
  if (preferred) return preferred
  if (cachedClearance && Date.now() - cachedClearance.at < CLEARANCE_TTL_MS) {
    return cachedClearance.cookie
  }
  const cookie = await acquireInceptionClearance()
  cachedClearance = cookie ? { cookie, at: Date.now() } : null
  return cookie
}

export function invalidateInceptionClearance(): void {
  cachedClearance = null
}

/** Build a Cookie header from stored credentials (full jar or bare _vcrcs). */
export function buildInceptionCookieHeader(credentials: Record<string, string> | undefined): string {
  if (!credentials) return ''
  const jar = credentials.cookie || credentials.cookieJar || ''
  if (jar.trim()) {
    // A stored jar may already contain the clearance cookie. If the user also
    // supplied a fresh `_vcrcs` field, let it override the jar value rather
    // than leaving a stale one in place.
    const vcrcs = credentials[`_vcrcs`] || credentials.vcrcs || ''
    if (vcrcs) {
      const explicit = vcrcs.includes('=') ? vcrcs : `_vcrcs=${vcrcs}`
      const name = explicit.split('=')[0] || '_vcrcs'
      const rest = jar
        .split(';')
        .map((pair) => pair.trim())
        .filter((pair) => pair && !pair.startsWith(`${name}=`))
      return [explicit, ...rest].join('; ')
    }
    return jar
  }
  const single = credentials[`_vcrcs`] || credentials.vcrcs || ''
  if (single) {
    return single.includes('=') ? single : `_vcrcs=${single}`
  }
  return ''
}

// ---------------------------------------------------------------------------
// Session / chat
// ---------------------------------------------------------------------------

export async function fetchInceptionSessionToken(cookie: string): Promise<string> {
  const response = await axios.get(`${INCEPTION_API_BASE}/api/session`, {
    headers: {
      'User-Agent': INCEPTION_USER_AGENT,
      Accept: '*/*',
      'Accept-Language': 'en-US,en;q=0.9',
      ...(cookie ? { Cookie: cookie } : {}),
    },
    timeout: 20000,
    validateStatus: () => true,
  })
  if (response.status !== 200 || !response.data?.ok || !response.data?.token) {
    throw new Error(
      `Inception: failed to create a session (HTTP ${response.status}${response.data?.ok === false ? ', ok=false' : ''})`,
    )
  }
  return String(response.data.token)
}

export function randomId(prefix: string): string {
  const hex = Array.from({ length: 6 }, () => Math.floor(Math.random() * 256).toString(16).padStart(2, '0')).join('')
  return `${prefix}-${hex}`
}

export interface InceptionMessage {
  role: string
  content: string | Array<{ type?: string; text?: string }> | null
  tool_calls?: Array<{ id?: string; function?: { name?: string; arguments?: string } }>
  tool_call_id?: string
  name?: string
}

export interface InceptionChatOptions {
  reasoningEffort?: string
  webSearch?: boolean
  timezone?: string
  language?: string
}

export interface InceptionUpstreamMessage {
  id: string
  role: 'user' | 'assistant'
  parts: Array<{ type: 'text'; text: string; state?: string }>
}

function messageText(message: InceptionMessage): string {
  if (typeof message.content === 'string') return message.content
  if (Array.isArray(message.content)) {
    return message.content
      .filter((part) => part && (part.type === 'text' || typeof part.text === 'string'))
      .map((part) => part.text || '')
      .join('\n')
  }
  return ''
}

/**
 * Convert OpenAI-style messages into the AI SDK parts format the web client
 * sends. The upstream only understands `user` and `assistant` roles, so system
 * prompts are folded into the first user turn, tool output becomes a user
 * turn, consecutive same-role turns are coalesced, and the conversation is
 * guaranteed to end on a user message.
 */
export function buildInceptionMessages(messages: InceptionMessage[]): InceptionUpstreamMessage[] {
  const systemParts: string[] = []
  const cleaned: Array<{ role: 'user' | 'assistant'; content: string }> = []

  for (const message of messages || []) {
    const role = message.role || 'user'
    if (role === 'system' || role === 'developer') {
      const text = messageText(message)
      if (text) systemParts.push(text)
      continue
    }
    if (role === 'tool' || role === 'function') {
      const id = message.tool_call_id || message.name || 'tool'
      cleaned.push({ role: 'user', content: `[Tool Execution Result for \`${id}\`]:\n${messageText(message)}` })
      continue
    }
    let content = messageText(message)
    if (role === 'assistant' && Array.isArray(message.tool_calls) && message.tool_calls.length > 0) {
      const blocks = message.tool_calls
        .map((call) => {
          const name = call.function?.name || 'unknown'
          const args = call.function?.arguments || '{}'
          return `\`\`\`json\n{"name": "${name}", "arguments": ${args}}\n\`\`\``
        })
        .join('\n')
      content = content ? `${content}\n${blocks}` : blocks
    }
    cleaned.push({ role: role === 'assistant' ? 'assistant' : 'user', content })
  }

  if (systemParts.length > 0) {
    const prefix = `[System Instructions]\n${systemParts.join('\n\n')}\n\n`
    const firstUser = cleaned.findIndex((message) => message.role === 'user')
    if (firstUser >= 0) {
      cleaned[firstUser] = { ...cleaned[firstUser], content: prefix + cleaned[firstUser].content }
    } else {
      cleaned.unshift({ role: 'user', content: systemParts.join('\n\n') })
    }
  }

  const coalesced: Array<{ role: 'user' | 'assistant'; content: string }> = []
  for (const message of cleaned) {
    const last = coalesced[coalesced.length - 1]
    if (last && last.role === message.role) {
      last.content = `${last.content}\n\n${message.content}`
    } else {
      coalesced.push({ ...message })
    }
  }

  if (coalesced.length === 0) {
    coalesced.push({ role: 'user', content: 'Hello' })
  } else if (coalesced[coalesced.length - 1].role !== 'user') {
    coalesced.push({ role: 'user', content: 'Please continue.' })
  }

  return coalesced.map((message) => ({
    id: randomId('m'),
    role: message.role,
    parts: [
      message.role === 'assistant'
        ? { type: 'text' as const, text: message.content, state: 'done' }
        : { type: 'text' as const, text: message.content },
    ],
  }))
}

export function buildInceptionRequestBody(
  messages: InceptionMessage[],
  options: InceptionChatOptions = {},
): Record<string, unknown> {
  const upstreamMessages = buildInceptionMessages(messages)
  const lastId = upstreamMessages[upstreamMessages.length - 1]?.id || randomId('m')
  let effort = options.reasoningEffort
  if (!effort || effort === 'none' || effort === 'auto') {
    effort = 'medium'
  }
  return {
    id: randomId('c'),
    messageId: lastId,
    trigger: 'submit-message',
    messages: upstreamMessages,
    reasoningEffort: effort,
    webSearchEnabled: options.webSearch !== false,
    voiceMode: false,
    timezone: options.timezone || 'UTC',
    language: options.language || 'en-US',
  }
}

// ---------------------------------------------------------------------------
// Stream events
// ---------------------------------------------------------------------------

export interface InceptionDelta {
  content?: string
  reasoning?: string
  sources?: Array<{ url: string; title?: string }>
  error?: string
  finished?: boolean
}

function usableSource(url: unknown): string {
  if (typeof url !== 'string' || !/^https?:\/\//i.test(url)) return ''
  if (url === '__searching__') return ''
  return url
}

/** Translate one Vercel AI data-stream event into a normalised delta. */
export function parseInceptionEvent(payload: any): InceptionDelta {
  if (!payload || typeof payload !== 'object') return {}
  const type = typeof payload.type === 'string' ? payload.type : ''
  switch (type) {
    case 'text-start':
      return typeof payload.text === 'string' && payload.text ? { content: payload.text } : {}
    case 'text-delta':
      return typeof payload.delta === 'string' && payload.delta ? { content: payload.delta } : {}
    case 'reasoning-delta':
      return typeof payload.delta === 'string' && payload.delta ? { reasoning: payload.delta } : {}
    case 'source-url': {
      const url = usableSource(payload.url)
      return url ? { sources: [{ url, title: typeof payload.title === 'string' ? payload.title : undefined }] } : {}
    }
    case 'error':
      return {
        error:
          (typeof payload.error === 'string' ? payload.error : payload.error?.message) ||
          payload.message ||
          'Inception stream error',
      }
    case 'finish':
    case 'finish-step':
      return typeof payload.finishReason === 'string' ? { finished: true } : {}
    default:
      return {}
  }
}