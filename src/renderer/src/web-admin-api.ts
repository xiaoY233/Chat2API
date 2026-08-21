import type {
  Account,
  AppConfig,
  EffectiveModel,
  LogEntry,
  LogLevel,
  OAuthResult,
  Provider,
  ProviderCheckResult,
  ProviderVendor,
  ProxyStatus,
  QwenAiGovernorConfig,
  QwenAiGovernorStatus,
  SystemPrompt,
} from './types/electron'

const MANAGEMENT_SECRET_KEY = 'chat2api.managementSecret'
const MANAGEMENT_BASE = '/v0/management'

type ManagementResponse<T = unknown> = {
  success: boolean
  data?: T
  error?: {
    code: string
    message: string
    details?: Record<string, unknown>
  }
}

type Listener = (...args: unknown[]) => void

const eventListeners = new Map<string, Set<Listener>>()

const BROWSER_IMPORT_SESSION_TTL_MS = 10 * 60 * 1000

type BrowserImportSession = {
  id: string
  providerId: string
  createdAt: number
  expiresAt: number
  status: 'pending' | 'success' | 'error' | 'expired'
  credentials?: Record<string, string>
  error?: string
}

type BrowserImportPayload = {
  importId: string
  providerId: string
  credentials: Record<string, string>
  error?: string
}

const browserImportSessions = new Map<string, BrowserImportSession>()

export function getStoredManagementSecret(): string {
  return sessionStorage.getItem(MANAGEMENT_SECRET_KEY) || ''
}

export function setManagementSecret(secret: string): void {
  sessionStorage.setItem(MANAGEMENT_SECRET_KEY, secret)
}

export function clearManagementSecret(): void {
  sessionStorage.removeItem(MANAGEMENT_SECRET_KEY)
}

export async function verifyManagementSecret(secret: string): Promise<boolean> {
  if (!secret) return false

  const response = await fetch(`${MANAGEMENT_BASE}/health`, {
    headers: {
      Authorization: `Bearer ${secret}`,
    },
  })

  if (response.status === 401 || response.status === 403 || response.status === 404) {
    return false
  }

  if (!response.ok) {
    throw new Error(`Management API check failed: HTTP ${response.status}`)
  }

  const payload = await response.json() as ManagementResponse
  return payload.success === true
}

function getManagementSecret(): string {
  const secret = getStoredManagementSecret()
  if (!secret) {
    throw new Error('Management secret is not configured.')
  }
  return secret
}

async function managementFetch<T>(
  path: string,
  init: RequestInit = {},
): Promise<T> {
  const headers = new Headers(init.headers)
  headers.set('Authorization', `Bearer ${getManagementSecret()}`)

  if (init.body !== undefined && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json')
  }

  const response = await fetch(`${MANAGEMENT_BASE}${path}`, {
    ...init,
    headers,
  })

  const contentType = response.headers.get('Content-Type') || ''
  const payload = contentType.includes('application/json')
    ? await response.json() as ManagementResponse<T>
    : { success: response.ok, data: await response.text() as T }

  if (!response.ok || !payload.success) {
    const message = payload.error?.message || `Management API request failed: HTTP ${response.status}`
    throw new Error(message)
  }

  return payload.data as T
}

function toQuery(params: Record<string, unknown>): string {
  const searchParams = new URLSearchParams()

  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== '') {
      searchParams.set(key, String(value))
    }
  }

  const query = searchParams.toString()
  return query ? `?${query}` : ''
}

function noOpUnsubscribe(): () => void {
  return () => undefined
}

function emit(channel: string, ...args: unknown[]): void {
  const listeners = eventListeners.get(channel)
  if (!listeners) return
  listeners.forEach((listener) => listener(...args))
}

function on(channel: string, callback: Listener): () => void {
  const listeners = eventListeners.get(channel) || new Set<Listener>()
  listeners.add(callback)
  eventListeners.set(channel, listeners)

  return () => {
    listeners.delete(callback)
    if (listeners.size === 0) {
      eventListeners.delete(channel)
    }
  }
}

function cleanupBrowserImportSessions(): void {
  const now = Date.now()
  for (const [id, session] of browserImportSessions.entries()) {
    if (session.expiresAt <= now) {
      browserImportSessions.set(id, { ...session, status: 'expired', error: 'Import session expired.' })
    }
  }
}

function createBrowserImportId(): string {
  if (typeof globalThis.crypto?.randomUUID === 'function') {
    return globalThis.crypto.randomUUID()
  }

  const cryptoApi = globalThis.crypto
  const bytes = new Uint8Array(16)
  if (typeof cryptoApi?.getRandomValues === 'function') {
    cryptoApi.getRandomValues(bytes)
  } else {
    for (let i = 0; i < bytes.length; i++) {
      bytes[i] = Math.floor(Math.random() * 256)
    }
  }

  bytes[6] = (bytes[6] & 0x0f) | 0x40
  bytes[8] = (bytes[8] & 0x3f) | 0x80

  const hex = Array.from(bytes, byte => byte.toString(16).padStart(2, '0'))
  return [
    hex.slice(0, 4).join(''),
    hex.slice(4, 6).join(''),
    hex.slice(6, 8).join(''),
    hex.slice(8, 10).join(''),
    hex.slice(10, 16).join(''),
  ].join('-')
}

function createBrowserImportSession(providerId: string): BrowserImportSession {
  cleanupBrowserImportSessions()
  const id = createBrowserImportId()
  const createdAt = Date.now()
  const session: BrowserImportSession = {
    id,
    providerId,
    createdAt,
    expiresAt: createdAt + BROWSER_IMPORT_SESSION_TTL_MS,
    status: 'pending',
  }
  browserImportSessions.set(id, session)
  return session
}

function getBrowserImportSession(id: string): BrowserImportSession | null {
  cleanupBrowserImportSessions()
  return browserImportSessions.get(id) || null
}

async function syncBrowserImportSession(id: string): Promise<BrowserImportSession | null> {
  const session = getBrowserImportSession(id)
  if (!session || session.status !== 'pending') {
    return session
  }

  const remote = await managementFetch<{
    importId: string
    providerId: string
    status: 'success' | 'error'
    credentials: Record<string, string>
    error?: string
  } | null>(`/browser-import/${encodeURIComponent(id)}`)

  if (!remote) {
    return session
  }

  return setBrowserImportResult(
    remote.importId,
    remote.providerId,
    remote.credentials,
    remote.error,
  )
}

function setBrowserImportResult(
  id: string,
  providerId: string,
  credentials: Record<string, string>,
  error?: string,
): BrowserImportSession {
  cleanupBrowserImportSessions()
  const current = browserImportSessions.get(id)
  if (!current) {
    throw new Error('Import session was not found or has expired.')
  }
  if (current.providerId !== providerId) {
    throw new Error('Import provider does not match the active session.')
  }

  const next: BrowserImportSession = {
    ...current,
    status: error ? 'error' : 'success',
    credentials,
    error,
  }
  browserImportSessions.set(id, next)
  return next
}

function parseBrowserImportPayload(input: string): BrowserImportPayload {
  const trimmed = input.trim()
  if (!trimmed) {
    throw new Error('Import payload cannot be empty.')
  }

  const jsonText = trimmed.startsWith('{')
    ? trimmed
    : trimmed.slice(trimmed.indexOf('{'), trimmed.lastIndexOf('}') + 1)

  if (!jsonText || !jsonText.startsWith('{') || !jsonText.endsWith('}')) {
    throw new Error('Import payload must be a JSON object copied from the provider console.')
  }

  const payload = JSON.parse(jsonText) as Partial<BrowserImportPayload>
  if (!payload.importId || typeof payload.importId !== 'string') {
    throw new Error('Import payload is missing importId.')
  }
  if (!payload.providerId || typeof payload.providerId !== 'string') {
    throw new Error('Import payload is missing providerId.')
  }
  if (!payload.credentials || typeof payload.credentials !== 'object') {
    throw new Error('Import payload is missing credentials.')
  }

  const credentials = Object.fromEntries(
    Object.entries(payload.credentials).map(([key, value]) => [key, typeof value === 'string' ? value : String(value ?? '')]),
  )

  return {
    importId: payload.importId,
    providerId: payload.providerId,
    credentials,
    error: typeof payload.error === 'string' ? payload.error : '',
  }
}

function applyBrowserImportPayload(input: string): BrowserImportSession {
  const payload = parseBrowserImportPayload(input)
  return setBrowserImportResult(
    payload.importId,
    payload.providerId,
    payload.credentials,
    payload.error,
  )
}

function buildBrowserImportFallbackBlock(): string {
  return `  const payloadText = JSON.stringify(payload);
  const copyPayload = async () => {
    try {
      if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
        await navigator.clipboard.writeText(payloadText);
        return true;
      }
    } catch (clipboardError) {
      console.warn('Chat2API browser import payload clipboard copy failed:', clipboardError);
    }

    try {
      const textarea = document.createElement('textarea');
      textarea.value = payloadText;
      textarea.setAttribute('readonly', 'readonly');
      textarea.style.position = 'fixed';
      textarea.style.left = '-9999px';
      document.body.appendChild(textarea);
      textarea.focus();
      textarea.select();
      const copied = document.execCommand('copy');
      document.body.removeChild(textarea);
      return copied;
    } catch (fallbackError) {
      console.warn('Chat2API browser import payload fallback copy failed:', fallbackError);
      return false;
    }
  };
  let payloadAnnounced = false;
  const announcePayload = async () => {
    if (payloadAnnounced) return;
    payloadAnnounced = true;
    console.log('Chat2API browser import payload:', payloadText);
    const copied = await copyPayload();
    console.warn(copied
      ? 'Payload copied. Paste it into the Chat2API admin page if needed.'
      : 'Copy failed. Copy the JSON printed above manually.');
  };
  const showOfflinePayload = async (error) => {
    console.error('Chat2API browser import failed:', error);
    if (location.protocol === 'https:' && completeUrl.startsWith('http://')) {
      console.warn('Mixed Content: HTTPS provider pages cannot post credentials to an HTTP Chat2API address.');
    }
    await announcePayload();
  };
  void announcePayload();
  void fetch(completeUrl, {
    method: 'POST',
    mode: 'cors',
    headers: { 'Content-Type': 'text/plain' },
    body: payloadText,
  })
    .then((response) => {
      if (!response.ok) {
        throw new Error(\`Chat2API browser import failed with HTTP \${response.status}. Check that the Docker container is running and regenerate the import script.\`);
      }
      console.log('Chat2API browser import sent. Return to the Chat2API admin page.');
    })
    .catch(showOfflinePayload);
  return payloadText;`
}

function buildQwenAiImportScript(session: BrowserImportSession): string {
  const completeUrl = `${window.location.origin}${MANAGEMENT_BASE}/browser-import/complete`
  return `(() => {
  const importId = ${JSON.stringify(session.id)};
  const providerId = 'qwen-ai';
  const completeUrl = ${JSON.stringify(completeUrl)};
  const token = localStorage.getItem('token') || localStorage.getItem('access_token') || '';
  const cookies = document.cookie || '';
  const getBaxiaUidToken = () => {
    try {
      return window.__baxia__?.getFYModule?.getUidToken?.() || '';
    } catch (error) {
      return '';
    }
  };
  const baxiaUidToken = getBaxiaUidToken();
  const x5secdata = cookies.match(/(?:^|;\\s*)x5secdata=([^;]+)/)?.[1] || '';
  const x5sectag = cookies.match(/(?:^|;\\s*)x5sectag=([^;]+)/)?.[1] || '';
  const payload = {
    importId,
    providerId,
    credentials: { token, cookies, baxiaUidToken, x5secdata, x5sectag },
    error: token ? '' : 'No token was found in chat.qwen.ai localStorage. Log in first, then run this script again.',
  };
${buildBrowserImportFallbackBlock()}
})();`
}

function buildQwenImportScript(session: BrowserImportSession): string {
  const completeUrl = `${window.location.origin}${MANAGEMENT_BASE}/browser-import/complete`
  return `(() => {
  const importId = ${JSON.stringify(session.id)};
  const providerId = 'qwen';
  const completeUrl = ${JSON.stringify(completeUrl)};
  const match = (document.cookie || '').match(/(?:^|;\\s*)tongyi_sso_ticket=([^;]+)/);
  const ticket = match ? decodeURIComponent(match[1]) : '';
  const payload = {
    importId,
    providerId,
    credentials: { ticket, tongyi_sso_ticket: ticket },
    error: ticket ? '' : 'No tongyi_sso_ticket cookie was readable. The cookie may be HttpOnly, so use manual credentials for domestic Qwen.',
  };
${buildBrowserImportFallbackBlock()}
})();`
}

function buildKimiImportScript(session: BrowserImportSession): string {
  const completeUrl = `${window.location.origin}${MANAGEMENT_BASE}/browser-import/complete`
  return `(() => {
  const importId = ${JSON.stringify(session.id)};
  const providerId = 'kimi';
  const completeUrl = ${JSON.stringify(completeUrl)};
  const tokenRefreshEndpoint = 'https://www.kimi.com/api/auth/token/refresh';
  const readStorage = (key) => {
    try {
      return localStorage.getItem(key) || '';
    } catch (error) {
      return '';
    }
  };
  const readCookie = (name) => {
    const prefix = name + '=';
    const entry = (document.cookie || '').split(';').map((part) => part.trim()).find((part) => part.startsWith(prefix));
    if (!entry) return '';
    const value = entry.slice(prefix.length);
    try {
      return decodeURIComponent(value);
    } catch (error) {
      return value;
    }
  };
  const readTokenInfo = () => {
    const raw = readStorage('volcano-token-info');
    if (!raw) return {};
    try {
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === 'object' ? parsed : {};
    } catch (error) {
      return {};
    }
  };
  const tokenInfo = readTokenInfo();
  const accessToken = readStorage('access_token') || readStorage('accessToken')
    || '';
  const refreshToken = readStorage('refresh_token') || readStorage('refreshToken')
    || '';
  const kimiAuth = readStorage('kimi-auth') || readStorage('kimi_auth')
    || readStorage('kimiAuth') || readCookie('kimi-auth');
  const token = accessToken || kimiAuth || refreshToken;
  const deviceId = readStorage('device_id') || readStorage('deviceId')
    || tokenInfo.webId || '';
  const sessionId = readStorage('session_id') || readStorage('sessionId')
    || tokenInfo.ssid || '';
  const trafficId = readStorage('traffic_id') || readStorage('trafficId')
    || readStorage('msh_user_id') || tokenInfo.userId || '';
  const payload = {
    importId,
    providerId,
    credentials: {
      token,
      access_token: accessToken,
      refresh_token: refreshToken,
      refreshToken,
      kimiAuth,
      deviceId,
      sessionId,
      trafficId,
    },
    error: token ? '' : 'No Kimi token was found. Check localStorage.access_token/localStorage.refresh_token or the kimi-auth cookie, then run this script again. The web refresh endpoint is ' + tokenRefreshEndpoint,
  };
${buildBrowserImportFallbackBlock()}
})();`
}

function buildBrowserImportScript(session: BrowserImportSession): string {
  if (session.providerId === 'qwen-ai') {
    return buildQwenAiImportScript(session)
  }
  if (session.providerId === 'qwen') {
    return buildQwenImportScript(session)
  }
  if (session.providerId === 'kimi') {
    return buildKimiImportScript(session)
  }
  throw new Error('Browser-assisted import is only available for Qwen and Kimi providers in Docker.')
}

const defaultUpdateStatus = {
  checking: false,
  available: false,
  downloading: false,
  downloaded: false,
  error: null,
  progress: null,
  version: null,
  releaseDate: null,
  releaseNotes: null,
}

function normalizeLogFilter(filter?: {
  level?: LogLevel | 'all'
  keyword?: string
  startTime?: number
  endTime?: number
  limit?: number
  offset?: number
}): string {
  return toQuery({
    level: filter?.level === 'all' ? undefined : filter?.level,
    keyword: filter?.keyword,
    startTime: filter?.startTime,
    endTime: filter?.endTime,
    limit: filter?.limit,
    offset: filter?.offset,
  })
}

async function getConfig(): Promise<AppConfig> {
  return managementFetch<AppConfig>('/config')
}

async function updateConfig(updates: Partial<AppConfig>): Promise<boolean> {
  const config = await managementFetch<AppConfig>('/config', {
    method: 'PUT',
    body: JSON.stringify(updates),
  })
  if (typeof updates.managementApi?.managementApiSecret === 'string' && updates.managementApi.managementApiSecret) {
    setManagementSecret(updates.managementApi.managementApiSecret)
  }
  emit('config:changed', config)
  return true
}

const proxy = {
  start: async (port?: number): Promise<boolean> => {
    const status = await proxy.getStatus()
    if (status.isRunning) {
      emit('proxy:statusChanged', status)
      return true
    }

    await managementFetch('/proxy/start', {
      method: 'POST',
      body: JSON.stringify({ port }),
    })
    emit('proxy:statusChanged', await proxy.getStatus())
    return true
  },

  stop: async (): Promise<boolean> => {
    throw new Error('Stopping the Docker server from the web admin is not supported because it also hosts this admin UI.')
  },

  getStatus: (): Promise<ProxyStatus> => managementFetch<ProxyStatus>('/proxy/status'),

  onStatusChanged: (callback: (status: ProxyStatus) => void) =>
    on('proxy:statusChanged', callback as Listener),
}

const store = {
  get: async <T>(key: string): Promise<T | undefined> => {
    if (key === 'config') return getConfig() as Promise<T>
    if (key === 'providers') return managementFetch<T>('/providers')
    if (key === 'accounts') return managementFetch<T>('/accounts')
    if (key === 'logs') return managementFetch<T>(`/app-logs${toQuery({ limit: 1000 })}`)
    return managementFetch<T>(`/store/${encodeURIComponent(key)}`)
  },

  set: async <T>(key: string, value: T): Promise<void> => {
    if (key === 'config') {
      await updateConfig(value as Partial<AppConfig>)
      return
    }

    if (key === 'logs') {
      await managementFetch('/app-logs', {
        method: 'PUT',
        body: JSON.stringify(value),
      })
      return
    }

    await managementFetch(`/store/${encodeURIComponent(key)}`, {
      method: 'PUT',
      body: JSON.stringify({ value }),
    })
  },

  delete: async (key: string): Promise<void> => {
    await managementFetch(`/store/${encodeURIComponent(key)}`, { method: 'DELETE' })
  },

  clearAll: async (): Promise<void> => {
    await managementFetch('/store', {
      method: 'DELETE',
      body: JSON.stringify({ confirm: true }),
    })
  },

  onInitError: () => noOpUnsubscribe(),

  retryInit: async () => ({ success: true }),
}

const providers = {
  getAll: (): Promise<Provider[]> => managementFetch<Provider[]>('/providers'),
  getBuiltin: (): Promise<Provider[]> => managementFetch<Provider[]>('/providers/builtin'),

  add: (data: Partial<Provider>): Promise<Provider> =>
    managementFetch<Provider>('/providers', {
      method: 'POST',
      body: JSON.stringify(data),
    }),

  update: (id: string, updates: Partial<Provider>): Promise<Provider | null> =>
    managementFetch<Provider>(`/providers/${encodeURIComponent(id)}`, {
      method: 'PUT',
      body: JSON.stringify(updates),
    }),

  delete: async (id: string): Promise<boolean> => {
    await managementFetch(`/providers/${encodeURIComponent(id)}`, { method: 'DELETE' })
    return true
  },

  checkStatus: (providerId: string): Promise<ProviderCheckResult> =>
    managementFetch<ProviderCheckResult>(`/providers/${encodeURIComponent(providerId)}/check`, {
      method: 'POST',
    }),

  checkAllStatus: (): Promise<Record<string, ProviderCheckResult>> =>
    managementFetch<Record<string, ProviderCheckResult>>('/providers/check-all', {
      method: 'POST',
    }),

  duplicate: (id: string): Promise<Provider> =>
    managementFetch<Provider>(`/providers/${encodeURIComponent(id)}/duplicate`, {
      method: 'POST',
    }),

  export: (id: string): Promise<string> =>
    managementFetch<string>(`/providers/${encodeURIComponent(id)}/export`),

  import: (jsonData: string): Promise<Provider> =>
    managementFetch<Provider>('/providers/import', {
      method: 'POST',
      body: JSON.stringify({ jsonData }),
    }),

  updateModels: (providerId: string) =>
    managementFetch<{ success: boolean; modelsCount?: number; error?: string }>(
      `/providers/${encodeURIComponent(providerId)}/models/update`,
      { method: 'POST' },
    ),

  getEffectiveModels: (providerId: string): Promise<EffectiveModel[]> =>
    managementFetch<EffectiveModel[]>(`/providers/${encodeURIComponent(providerId)}/models/effective`),

  addCustomModel: (providerId: string, model: { displayName: string; actualModelId: string }) =>
    managementFetch<{ success: boolean; models: EffectiveModel[]; error?: string }>(
      `/providers/${encodeURIComponent(providerId)}/models/custom`,
      {
        method: 'POST',
        body: JSON.stringify(model),
      },
    ),

  removeModel: (providerId: string, modelName: string) =>
    managementFetch<{ success: boolean; models: EffectiveModel[]; error?: string }>(
      `/providers/${encodeURIComponent(providerId)}/models/${encodeURIComponent(modelName)}`,
      { method: 'DELETE' },
    ),

  resetModels: (providerId: string) =>
    managementFetch<{ success: boolean; models: EffectiveModel[]; error?: string }>(
      `/providers/${encodeURIComponent(providerId)}/models/reset`,
      { method: 'POST' },
    ),
}

const accounts = {
  getAll: (includeCredentials?: boolean): Promise<Account[]> =>
    managementFetch<Account[]>(`/accounts${toQuery({ includeCredentials })}`),

  getById: (id: string, includeCredentials?: boolean): Promise<Account | null> =>
    managementFetch<Account>(`/accounts/${encodeURIComponent(id)}${toQuery({ includeCredentials })}`),

  getByProvider: (providerId: string): Promise<Account[]> =>
    managementFetch<Account[]>(`/providers/${encodeURIComponent(providerId)}/accounts`),

  add: (data: {
    providerId: string
    name: string
    email?: string
    credentials: Record<string, string>
    dailyLimit?: number
  }): Promise<Account> =>
    managementFetch<Account>('/accounts', {
      method: 'POST',
      body: JSON.stringify(data),
    }),

  update: (id: string, updates: Partial<Account>): Promise<Account | null> =>
    managementFetch<Account>(`/accounts/${encodeURIComponent(id)}`, {
      method: 'PUT',
      body: JSON.stringify(updates),
    }),

  delete: async (id: string): Promise<boolean> => {
    await managementFetch(`/accounts/${encodeURIComponent(id)}`, { method: 'DELETE' })
    return true
  },

  validate: async (accountId: string): Promise<boolean> => {
    const result = await managementFetch<{ valid: boolean }>(
      `/accounts/${encodeURIComponent(accountId)}/validate`,
      { method: 'POST' },
    )
    return result.valid
  },

  validateToken: (providerId: string, credentials: Record<string, string>) =>
    managementFetch<{
      valid: boolean
      error?: string
      credentials?: Record<string, string>
      userInfo?: {
        name?: string
        email?: string
        quota?: number
        used?: number
      }
    }>(`/providers/${encodeURIComponent(providerId)}/validate-token`, {
      method: 'POST',
      body: JSON.stringify({ credentials }),
    }),

  getCredits: (accountId: string): Promise<{
    totalCredits: number
    usedCredits: number
    remainingCredits: number
    expiresAt?: number
  } | null> =>
    managementFetch(`/accounts/${encodeURIComponent(accountId)}/credits`),

  clearChats: (accountId: string): Promise<{ success: boolean; error?: string }> =>
    managementFetch(`/accounts/${encodeURIComponent(accountId)}/clear-chats`, {
      method: 'POST',
    }),
}

const oauth = {
  startLogin: (providerId: string, providerType: ProviderVendor): Promise<OAuthResult> =>
    managementFetch<OAuthResult>('/oauth/start-login', {
      method: 'POST',
      body: JSON.stringify({ providerId, providerType }),
    }),

  cancelLogin: async (): Promise<void> => {
    await managementFetch('/oauth/cancel-login', { method: 'POST' })
  },

  loginWithToken: (
    providerId: string,
    providerType: ProviderVendor,
    token: string,
    realUserID?: string,
    mimoUserId?: string,
    mimoPhToken?: string,
  ): Promise<OAuthResult> =>
    managementFetch<OAuthResult>('/oauth/login-with-token', {
      method: 'POST',
      body: JSON.stringify({ providerId, providerType, token, realUserID, mimoUserId, mimoPhToken }),
    }),

  validateToken: (providerId: string, providerType: ProviderVendor, credentials: Record<string, string>) =>
    managementFetch<{
      valid: boolean
      tokenType?: string
      expiresAt?: number
      credentials?: Record<string, string>
      accountInfo?: {
        userId?: string
        email?: string
        name?: string
        quota?: number
        used?: number
      }
      error?: string
    }>('/oauth/validate-token', {
      method: 'POST',
      body: JSON.stringify({ providerId, providerType, credentials }),
    }),

  refreshToken: (providerId: string, providerType: ProviderVendor, credentials: Record<string, string>) =>
    managementFetch('/oauth/refresh-token', {
      method: 'POST',
      body: JSON.stringify({ providerId, providerType, credentials }),
    }),

  getStatus: (): Promise<string> => managementFetch<string>('/oauth/status'),

  startInAppLogin: (providerId: string, providerType: ProviderVendor): Promise<OAuthResult> =>
    Promise.resolve({
      success: false,
      providerId,
      providerType,
      error: 'In-app automatic login is only available in the Electron desktop app. Use manual credentials in Docker.',
    }),

  cancelInAppLogin: async (): Promise<void> => undefined,

  isInAppLoginOpen: async (): Promise<boolean> => false,

  onCallback: () => noOpUnsubscribe(),

  onProgress: (callback: Listener) => on('oauth:progress', callback),
}

const browserImport = {
  createSession: async (providerId: string): Promise<BrowserImportSession> =>
    createBrowserImportSession(providerId),

  getSession: async (id: string): Promise<BrowserImportSession | null> =>
    syncBrowserImportSession(id),

  applyImportPayload: async (input: string): Promise<BrowserImportSession> =>
    applyBrowserImportPayload(input),

  buildImportScript: async (id: string): Promise<string> => {
    const session = getBrowserImportSession(id)
    if (!session) {
      throw new Error('Import session was not found or has expired.')
    }
    return buildBrowserImportScript(session)
  },
}

const logs = {
  get: (filter?: {
    level?: LogLevel | 'all'
    keyword?: string
    startTime?: number
    endTime?: number
    limit?: number
    offset?: number
  }): Promise<LogEntry[]> =>
    managementFetch<LogEntry[]>(`/app-logs${normalizeLogFilter(filter)}`),

  getStats: () => managementFetch('/app-logs/stats'),
  getTrend: (days?: number) => managementFetch(`/app-logs/trend${toQuery({ days })}`),
  getAccountTrend: (accountId: string, days?: number) =>
    managementFetch(`/accounts/${encodeURIComponent(accountId)}/logs/trend${toQuery({ days })}`),

  clear: async (): Promise<void> => {
    await managementFetch('/app-logs', { method: 'DELETE' })
  },

  export: (format?: 'json' | 'txt') =>
    managementFetch<string>(`/app-logs/export${toQuery({ format })}`),

  getById: (id: string) => managementFetch(`/app-logs/${encodeURIComponent(id)}`),

  onNewLog: (callback: Listener) => on('logs:newLog', callback),
}

const requestLogs = {
  get: (filter?: { status?: 'success' | 'error'; providerId?: string; limit?: number }) =>
    managementFetch(`/request-logs${toQuery(filter || {})}`),

  getById: (id: string) => managementFetch(`/request-logs/${encodeURIComponent(id)}`),
  getStats: () => managementFetch('/request-logs/stats'),
  getTrend: (days?: number) => managementFetch(`/request-logs/trend${toQuery({ days })}`),

  clear: async (): Promise<void> => {
    await managementFetch('/request-logs', { method: 'DELETE' })
  },

  onNewLog: (callback: Listener) => on('requestLogs:new', callback),
}

const statistics = {
  get: () => managementFetch('/statistics/persistent'),
  getToday: () => managementFetch('/statistics/today'),
}

const app = {
  getVersion: async (): Promise<string> => '1.4.0',
  minimize: async (): Promise<void> => undefined,
  maximize: async (): Promise<void> => undefined,
  close: async (): Promise<void> => undefined,
  showWindow: async (): Promise<void> => undefined,
  hideWindow: async (): Promise<void> => undefined,
  openExternal: async (url: string): Promise<void> => {
    window.open(url, '_blank', 'noopener,noreferrer')
  },
  checkUpdate: async () => defaultUpdateStatus,
  downloadUpdate: async (): Promise<void> => undefined,
  installUpdate: async (): Promise<void> => undefined,
  getUpdateStatus: async () => defaultUpdateStatus,
  onUpdateChecking: () => noOpUnsubscribe(),
  onUpdateAvailable: () => noOpUnsubscribe(),
  onUpdateNotAvailable: () => noOpUnsubscribe(),
  onUpdateProgress: () => noOpUnsubscribe(),
  onUpdateDownloaded: () => noOpUnsubscribe(),
  onUpdateError: () => noOpUnsubscribe(),
}

const config = {
  get: getConfig,
  update: updateConfig,
  onConfigChanged: (callback: (config: AppConfig) => void) =>
    on('config:changed', callback as Listener),
}

const prompts = {
  getAll: (): Promise<SystemPrompt[]> => managementFetch<SystemPrompt[]>('/prompts'),
  getBuiltin: (): Promise<SystemPrompt[]> => managementFetch<SystemPrompt[]>('/prompts/builtin'),
  getCustom: (): Promise<SystemPrompt[]> => managementFetch<SystemPrompt[]>('/prompts/custom'),
  getById: (id: string) => managementFetch(`/prompts/${encodeURIComponent(id)}`),
  add: (prompt: Omit<SystemPrompt, 'id' | 'createdAt' | 'updatedAt'>) =>
    managementFetch<SystemPrompt>('/prompts', {
      method: 'POST',
      body: JSON.stringify(prompt),
    }),
  update: (id: string, updates: Partial<SystemPrompt>) =>
    managementFetch<SystemPrompt | null>(`/prompts/${encodeURIComponent(id)}`, {
      method: 'PUT',
      body: JSON.stringify(updates),
    }),
  delete: async (id: string): Promise<boolean> => {
    await managementFetch(`/prompts/${encodeURIComponent(id)}`, { method: 'DELETE' })
    return true
  },
  getByType: (type: string) => managementFetch<SystemPrompt[]>(`/prompts/type/${encodeURIComponent(type)}`),
}

const session = {
  getConfig: () => managementFetch('/sessions/config'),
  updateConfig: async (config: unknown): Promise<void> => {
    await managementFetch('/sessions/config', {
      method: 'PUT',
      body: JSON.stringify(config),
    })
  },
  getAll: () => managementFetch('/sessions/all'),
  getActive: () => managementFetch('/sessions'),
  getById: (id: string) => managementFetch(`/sessions/${encodeURIComponent(id)}`),
  getByAccount: (accountId: string) =>
    managementFetch(`/accounts/${encodeURIComponent(accountId)}/sessions`),
  getByProvider: (providerId: string) =>
    managementFetch(`/providers/${encodeURIComponent(providerId)}/sessions`),
  delete: async (id: string): Promise<boolean> => {
    await managementFetch(`/sessions/${encodeURIComponent(id)}`, { method: 'DELETE' })
    return true
  },
  clearAll: async (): Promise<void> => {
    await managementFetch('/sessions', {
      method: 'DELETE',
      body: JSON.stringify({ confirm: true }),
    })
  },
  cleanExpired: () => managementFetch<number>('/sessions/clean-expired', { method: 'POST' }),
}

const managementApi = {
  getConfig: async () => (await getConfig()).managementApi,
  updateConfig: async (updates: Partial<AppConfig['managementApi']>) => {
    const current = await getConfig()
    const nextConfig = {
      ...current.managementApi,
      ...updates,
    }
    await updateConfig({
      managementApi: nextConfig,
    })
    if (typeof nextConfig.managementApiSecret === 'string' && nextConfig.managementApiSecret) {
      setManagementSecret(nextConfig.managementApiSecret)
    }
    return nextConfig
  },
  generateSecret: async () => {
    const secret = await managementFetch<string>('/management-api/generate-secret', { method: 'POST' })
    setManagementSecret(secret)
    return secret
  },
}

const defaultContextManagement = {
  enabled: true,
  strategies: {
    slidingWindow: { enabled: true, maxMessages: 20 },
    tokenLimit: { enabled: false, maxTokens: 4000 },
    summary: { enabled: false, keepRecentMessages: 20 },
  },
  executionOrder: ['slidingWindow', 'tokenLimit', 'summary'],
}

const contextManagement = {
  getConfig: async () => {
    const appConfig = await getConfig()
    return appConfig.contextManagement || defaultContextManagement
  },
  updateConfig: async (updates: unknown) => {
    const appConfig = await getConfig()
    const nextConfig = {
      ...(appConfig.contextManagement as Record<string, unknown> || defaultContextManagement),
      ...(updates as Record<string, unknown>),
    }
    await updateConfig({ contextManagement: nextConfig } as Partial<AppConfig>)
    return nextConfig
  },
}

const toolCalling = {
  getStatus: () => managementFetch('/tool-calling/status'),
  runSmoke: async (input: { clientAdapterId: string }) => {
    const data = await managementFetch('/tool-calling/smoke', {
      method: 'POST',
      body: JSON.stringify(input),
    })

    return { success: true, data }
  },
}

const qwenAiGovernor = {
  getStatus: (): Promise<QwenAiGovernorStatus | null> =>
    managementFetch<QwenAiGovernorStatus>('/qwen-ai-governor/status'),

  updateConfig: (updates: Partial<QwenAiGovernorConfig>): Promise<QwenAiGovernorConfig> =>
    managementFetch<QwenAiGovernorConfig>('/qwen-ai-governor/config', {
      method: 'PUT',
      body: JSON.stringify(updates),
    }),

  clearAccountCooldown: async (accountId: string): Promise<void> => {
    await managementFetch(`/qwen-ai-governor/accounts/${encodeURIComponent(accountId)}/cooldown`, {
      method: 'DELETE',
    })
  },

  clearAllCooldowns: async (): Promise<void> => {
    await managementFetch('/qwen-ai-governor/cooldowns', {
      method: 'DELETE',
    })
  },
}

const tray = {
  openDashboard: (): void => undefined,
  setHeight: (): void => undefined,
  quitApp: (): void => undefined,
}

async function invoke(channel: string, ...args: unknown[]): Promise<unknown> {
  switch (channel) {
    case 'proxy:getStatistics':
      return managementFetch('/proxy/statistics')
    case 'app:openExternal':
      return app.openExternal(String(args[0] || ''))
    case 'oauth:loginWithToken': {
      const input = args[0] as {
        providerId: string
        providerType: ProviderVendor
        token: string
        realUserID?: string
        mimoUserId?: string
        mimoPhToken?: string
      }
      return oauth.loginWithToken(
        input.providerId,
        input.providerType,
        input.token,
        input.realUserID,
        input.mimoUserId,
        input.mimoPhToken,
      )
    }
    case 'managementApi:getConfig':
      return managementApi.getConfig()
    case 'managementApi:updateConfig':
      return managementApi.updateConfig(args[0] as Partial<AppConfig['managementApi']>)
    case 'managementApi:generateSecret':
      return managementApi.generateSecret()
    case 'contextManagement:getConfig':
      return contextManagement.getConfig()
    case 'contextManagement:updateConfig':
      return contextManagement.updateConfig(args[0])
    default:
      throw new Error(`Unsupported web admin IPC channel: ${channel}`)
  }
}

function send(channel: string, ...args: unknown[]): void {
  emit(channel, ...args)
}

window.electronAPI = {
  proxy,
  store,
  providers,
  accounts,
  oauth,
  browserImport,
  logs,
  requestLogs,
  statistics,
  app,
  config,
  prompts,
  session,
  managementApi,
  contextManagement,
  toolCalling,
  qwenAiGovernor,
  tray,
  on,
  send,
  invoke,
}
