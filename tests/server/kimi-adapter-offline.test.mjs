import assert from 'node:assert/strict'
import { Readable } from 'node:stream'
import { after, before, test } from 'node:test'
import axios from 'axios'
import { createServer } from 'vite'

let vite
let KimiAdapter
let KimiStreamHandler
let detectTokenType
let storeManager
let KimiOAuthAdapter
let ProviderChecker

before(async () => {
  vite = await createServer({
    server: { middlewareMode: true },
    appType: 'custom',
    logLevel: 'silent',
  })
  const module = await vite.ssrLoadModule('/src/main/proxy/adapters/kimi.ts')
  KimiAdapter = module.KimiAdapter
  KimiStreamHandler = module.KimiStreamHandler
  detectTokenType = module.detectTokenType
  const storeModule = await vite.ssrLoadModule('/src/main/store/store.ts')
  storeManager = storeModule.storeManager
  const oauthModule = await vite.ssrLoadModule('/src/main/oauth/adapters/kimi.ts')
  KimiOAuthAdapter = oauthModule.KimiAdapter
  const checkerModule = await vite.ssrLoadModule('/src/main/providers/checker.ts')
  ProviderChecker = checkerModule.ProviderChecker
})

after(async () => {
  await vite?.close()
})

function createAccessToken(userId = 'kimi-test-user') {
  const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url')
  const payload = Buffer.from(JSON.stringify({
    app_id: 'kimi',
    typ: 'access',
    sub: userId,
  })).toString('base64url')
  return `${header}.${payload}.test-signature`
}

function createAdapterWithCredentials(credentials, accountId = 'kimi-test-account') {
  return new KimiAdapter(
    {
      id: 'kimi',
      name: 'Kimi',
      type: 'builtin',
      authType: 'jwt',
      apiEndpoint: 'https://www.kimi.com',
      chatPath: '/apiv2/kimi.gateway.chat.v1.ChatService/Chat',
      headers: {},
      enabled: true,
      supportedModels: ['Kimi-K2.6', 'Kimi-K3'],
      modelMappings: { 'Kimi-K2.6': 'k2d6', 'Kimi-K3': 'k3' },
      createdAt: 1,
      updatedAt: 1,
    },
    {
      id: accountId,
      providerId: 'kimi',
      name: 'Kimi Test',
      credentials,
      status: 'active',
      createdAt: 1,
      updatedAt: 1,
      requestCount: 0,
      todayUsed: 0,
      lastStatusCheck: 1,
      lastUsed: 1,
    },
  )
}

function createAdapter(token = createAccessToken()) {
  return createAdapterWithCredentials({ token })
}

function decodeConnectFrame(frame) {
  assert.ok(Buffer.isBuffer(frame))
  assert.equal(frame.readUInt8(0), 0)
  assert.equal(frame.readUInt32BE(1), frame.length - 5)
  return JSON.parse(frame.subarray(5).toString('utf8'))
}

function encodeConnectFrame(value, flag = 0) {
  const payload = Buffer.from(JSON.stringify(value), 'utf8')
  const frame = Buffer.alloc(5 + payload.length)
  frame.writeUInt8(flag, 0)
  frame.writeUInt32BE(payload.length, 1)
  payload.copy(frame, 5)
  return frame
}

function fragmentedConnectStream(events) {
  const complete = Buffer.concat(events.map((event) => (
    Buffer.isBuffer(event) ? event : encodeConnectFrame(event)
  )))
  const first = Math.min(3, complete.length)
  const second = Math.min(19, complete.length)
  return Readable.from([
    complete.subarray(0, first),
    complete.subarray(first, second),
    complete.subarray(second),
  ])
}

async function collectText(stream) {
  let result = ''
  for await (const chunk of stream) result += chunk.toString()
  return result
}

function parseSse(text) {
  return text
    .split('\n\n')
    .map((entry) => entry.trim())
    .filter((entry) => entry.startsWith('data: ') && entry !== 'data: [DONE]')
    .map((entry) => JSON.parse(entry.slice('data: '.length)))
}

test('Kimi access-token detection distinguishes access JWTs from refresh credentials', () => {
  assert.equal(detectTokenType(createAccessToken()), 'jwt')
  assert.equal(detectTokenType('opaque-kimi-auth-cookie-value'), 'refresh')
  assert.equal(detectTokenType('eyJ.invalid.jwt'), 'refresh')
})

test('Kimi OAuth validation refreshes a revoked but unexpired access token', async (t) => {
  const staleAccessToken = createAccessToken('oauth-revoked-user')
  const refreshedAccessToken = createAccessToken('oauth-refreshed-user')
  let postCount = 0
  let getCount = 0
  const originalGet = axios.get
  const originalPost = axios.post
  axios.post = async () => {
    postCount += 1
    return postCount === 1
      ? { status: 401, data: {}, headers: {} }
      : {
          status: 200,
          data: { subscription: { userId: 'oauth-refreshed-user', userName: 'OAuth User' } },
          headers: {},
        }
  }
  axios.get = async () => {
    getCount += 1
    return {
      status: 200,
      data: {
        access_token: refreshedAccessToken,
        refresh_token: 'oauth-rotated-refresh',
      },
      headers: {},
    }
  }
  t.after(() => {
    axios.get = originalGet
    axios.post = originalPost
  })

  const adapter = new KimiOAuthAdapter({
    providerId: 'kimi',
    providerType: 'kimi',
    authMethods: ['manual'],
    callbackPort: 8311,
  })
  const result = await adapter.validateToken({
    accessToken: staleAccessToken,
    refreshToken: 'oauth-initial-refresh',
  })

  assert.equal(result.valid, true)
  assert.equal(postCount, 2)
  assert.equal(getCount, 1)
  assert.equal(result.credentials.token, refreshedAccessToken)
  assert.equal(result.credentials.refreshToken, 'oauth-rotated-refresh')
})

test('Kimi provider checker retries revoked access with the stored refresh token', async (t) => {
  const staleAccessToken = createAccessToken('checker-revoked-user')
  const refreshedAccessToken = createAccessToken('checker-refreshed-user')
  let postCount = 0
  let getCount = 0
  const originalGet = axios.get
  const originalPost = axios.post
  axios.post = async () => {
    postCount += 1
    return postCount === 1
      ? { status: 401, data: {}, headers: {} }
      : {
          status: 200,
          data: { subscription: { userName: 'Checker User' } },
          headers: {},
        }
  }
  axios.get = async () => {
    getCount += 1
    return {
      status: 200,
      data: {
        access_token: refreshedAccessToken,
        refresh_token: 'checker-rotated-refresh',
      },
      headers: {},
    }
  }
  t.after(() => {
    axios.get = originalGet
    axios.post = originalPost
  })

  const result = await ProviderChecker.checkAccountToken(
    {
      id: 'kimi',
      name: 'Kimi',
      type: 'builtin',
      authType: 'jwt',
      apiEndpoint: 'https://www.kimi.com',
      headers: {},
      enabled: true,
      createdAt: 1,
      updatedAt: 1,
    },
    {
      id: 'checker-account',
      providerId: 'kimi',
      name: 'Checker Account',
      credentials: {
        accessToken: staleAccessToken,
        refreshToken: 'checker-initial-refresh',
      },
      status: 'active',
      createdAt: 1,
      updatedAt: 1,
    },
  )

  assert.equal(result.valid, true)
  assert.equal(postCount, 2)
  assert.equal(getCount, 1)
  assert.equal(result.credentials.token, refreshedAccessToken)
  assert.equal(result.credentials.accessToken, refreshedAccessToken)
  assert.equal(result.credentials.refreshToken, 'checker-rotated-refresh')
})

test('Kimi normalizes a Bearer-wrapped access credential before sending it upstream', async (t) => {
  const accessToken = createAccessToken('bearer-normalization-user')
  let authorization = ''
  const originalGet = axios.get
  const originalPost = axios.post
  axios.get = async () => {
    throw new Error('Bearer-wrapped access credentials must not trigger token refresh')
  }
  axios.post = async (_url, _body, config) => {
    authorization = config.headers.Authorization
    return { status: 200, data: Readable.from([]), headers: {} }
  }
  t.after(() => {
    axios.get = originalGet
    axios.post = originalPost
  })

  await createAdapter(`  Bearer ${accessToken}  `).chatCompletion({
    model: 'k2d5',
    messages: [{ role: 'user', content: 'normalize authorization' }],
  })

  assert.equal(authorization, `Bearer ${accessToken}`)
})

test('Kimi refresh-only credentials obtain and cache an access token with a Bearer GET', async (t) => {
  const initialRefreshToken = 'kimi-refresh-only-initial'
  const rotatedRefreshToken = 'kimi-refresh-only-rotated'
  const refreshedAccessToken = createAccessToken('refresh-only-user')
  const getCalls = []
  const postCalls = []
  const updateCalls = []
  const originalGet = axios.get
  const originalPost = axios.post
  const originalUpdateAccount = storeManager.updateAccount

  axios.get = async (...args) => {
    getCalls.push(args)
    return {
      status: 200,
      data: {
        access_token: refreshedAccessToken,
        refresh_token: rotatedRefreshToken,
        expires_in: 3600,
        user_id: 'refresh-only-user',
      },
      headers: {},
    }
  }
  axios.post = async (...args) => {
    postCalls.push(args)
    return { status: 200, data: Readable.from([]), headers: {} }
  }
  storeManager.updateAccount = (...args) => {
    updateCalls.push(args)
    return null
  }
  t.after(() => {
    axios.get = originalGet
    axios.post = originalPost
    storeManager.updateAccount = originalUpdateAccount
  })

  const adapter = createAdapterWithCredentials(
    { refreshToken: initialRefreshToken },
    'kimi-refresh-only-account',
  )
  const request = {
    model: 'k2d5',
    messages: [{ role: 'user', content: 'refresh first' }],
  }
  await adapter.chatCompletion(request)
  await adapter.chatCompletion(request)

  assert.equal(getCalls.length, 1, 'a usable refreshed access token should be cached')
  assert.equal(getCalls[0][0], 'https://www.kimi.com/api/auth/token/refresh')
  assert.equal(getCalls[0][1].headers.Authorization, `Bearer ${initialRefreshToken}`)
  assert.equal(postCalls.length, 2)
  assert.equal(postCalls[0][2].headers.Authorization, `Bearer ${refreshedAccessToken}`)
  assert.equal(postCalls[1][2].headers.Authorization, `Bearer ${refreshedAccessToken}`)
  assert.equal(updateCalls.length, 1)
  assert.equal(updateCalls[0][0], 'kimi-refresh-only-account')
  assert.deepEqual(updateCalls[0][1].credentials, {
    token: refreshedAccessToken,
    refreshToken: rotatedRefreshToken,
  })
})

test('Kimi shared refresh requests persist rotated credentials for every waiting account', async (t) => {
  const initialRefreshToken = 'kimi-shared-refresh-token'
  const rotatedRefreshToken = 'kimi-shared-rotated-refresh-token'
  const refreshedAccessToken = createAccessToken('shared-refresh-user')
  const getCalls = []
  const updateCalls = []
  let releaseRefresh
  const refreshGate = new Promise((resolve) => { releaseRefresh = resolve })
  const originalGet = axios.get
  const originalPost = axios.post
  const originalUpdateAccount = storeManager.updateAccount

  axios.get = async (...args) => {
    getCalls.push(args)
    await refreshGate
    return {
      status: 200,
      data: {
        access_token: refreshedAccessToken,
        refresh_token: rotatedRefreshToken,
      },
      headers: {},
    }
  }
  axios.post = async () => ({ status: 200, data: Readable.from([]), headers: {} })
  storeManager.updateAccount = (...args) => {
    updateCalls.push(args)
    return null
  }
  t.after(() => {
    axios.get = originalGet
    axios.post = originalPost
    storeManager.updateAccount = originalUpdateAccount
  })

  const request = {
    model: 'k2d5',
    messages: [{ role: 'user', content: 'shared refresh' }],
  }
  const first = createAdapterWithCredentials(
    { refreshToken: initialRefreshToken },
    'kimi-shared-refresh-account-a',
  )
  const second = createAdapterWithCredentials(
    { refreshToken: initialRefreshToken },
    'kimi-shared-refresh-account-b',
  )
  const firstRequest = first.chatCompletion(request)
  const secondRequest = second.chatCompletion(request)
  await new Promise((resolve) => setImmediate(resolve))
  releaseRefresh()
  await Promise.all([firstRequest, secondRequest])

  assert.equal(getCalls.length, 1)
  assert.deepEqual(
    updateCalls
      .map(([accountId, updates]) => ({ accountId, credentials: updates.credentials }))
      .sort((left, right) => left.accountId.localeCompare(right.accountId)),
    [
      {
        accountId: 'kimi-shared-refresh-account-a',
        credentials: { token: refreshedAccessToken, refreshToken: rotatedRefreshToken },
      },
      {
        accountId: 'kimi-shared-refresh-account-b',
        credentials: { token: refreshedAccessToken, refreshToken: rotatedRefreshToken },
      },
    ],
  )
})

test('Kimi stale adapter snapshots reuse credentials rotated by an earlier request', async (t) => {
  const accountId = 'kimi-stale-snapshot-account'
  const initialAccessToken = createAccessToken('stale-snapshot-user')
  const refreshedAccessToken = createAccessToken('fresh-snapshot-user')
  const initialRefreshToken = 'stale-snapshot-refresh'
  const rotatedRefreshToken = 'fresh-snapshot-refresh'
  let storedAccount = {
    id: accountId,
    providerId: 'kimi',
    name: 'Kimi stale snapshot',
    credentials: { token: initialAccessToken, refreshToken: initialRefreshToken },
    status: 'active',
    createdAt: 1,
    updatedAt: 1,
  }
  let refreshCount = 0
  const authorizations = []
  const originalGet = axios.get
  const originalPost = axios.post
  const originalGetAccount = storeManager.getAccountById
  const originalUpdateAccount = storeManager.updateAccount

  axios.get = async () => {
    refreshCount += 1
    return {
      status: 200,
      data: {
        access_token: refreshedAccessToken,
        refresh_token: rotatedRefreshToken,
      },
      headers: {},
    }
  }
  axios.post = async (_url, _body, config) => {
    authorizations.push(config.headers.Authorization)
    return {
      status: config.headers.Authorization === `Bearer ${initialAccessToken}` ? 401 : 200,
      data: Readable.from([]),
      headers: {},
    }
  }
  storeManager.getAccountById = (id) => id === accountId ? structuredClone(storedAccount) : undefined
  storeManager.updateAccount = (id, updates) => {
    if (id !== accountId) return null
    storedAccount = {
      ...storedAccount,
      ...updates,
      updatedAt: storedAccount.updatedAt + 1,
    }
    return structuredClone(storedAccount)
  }
  t.after(() => {
    axios.get = originalGet
    axios.post = originalPost
    storeManager.getAccountById = originalGetAccount
    storeManager.updateAccount = originalUpdateAccount
  })

  const first = createAdapterWithCredentials(storedAccount.credentials, accountId)
  const delayed = createAdapterWithCredentials(storedAccount.credentials, accountId)
  const request = {
    model: 'k2d5',
    messages: [{ role: 'user', content: 'reuse rotated credentials' }],
  }

  await first.chatCompletion(request)
  await delayed.chatCompletion(request)

  assert.equal(refreshCount, 1)
  assert.deepEqual(authorizations, [
    `Bearer ${initialAccessToken}`,
    `Bearer ${refreshedAccessToken}`,
    `Bearer ${refreshedAccessToken}`,
  ])
  assert.deepEqual(storedAccount.credentials, {
    token: refreshedAccessToken,
    refreshToken: rotatedRefreshToken,
  })
})

test('Kimi ignores a delayed 401 for an access token that another request already replaced', async (t) => {
  const accountId = 'kimi-delayed-401-account'
  const initialAccessToken = createAccessToken('delayed-401-initial-user')
  const refreshedAccessToken = createAccessToken('delayed-401-refreshed-user')
  const unexpectedAccessToken = createAccessToken('delayed-401-unexpected-user')
  const initialRefreshToken = 'delayed-401-initial-refresh'
  const rotatedRefreshToken = 'delayed-401-rotated-refresh'
  let storedAccount = {
    id: accountId,
    providerId: 'kimi',
    name: 'Kimi delayed 401',
    credentials: { token: initialAccessToken, refreshToken: initialRefreshToken },
    status: 'active',
    createdAt: 1,
    updatedAt: 1,
  }
  let refreshCount = 0
  let initialRequestCount = 0
  let releaseInitialRequests
  let releaseRefreshedRequest
  const initialRequestsReady = new Promise((resolve) => { releaseInitialRequests = resolve })
  const refreshedRequestSeen = new Promise((resolve) => { releaseRefreshedRequest = resolve })
  const authorizations = []
  const originalGet = axios.get
  const originalPost = axios.post
  const originalGetAccount = storeManager.getAccountById
  const originalUpdateAccount = storeManager.updateAccount

  axios.get = async () => {
    refreshCount += 1
    return {
      status: 200,
      data: {
        access_token: refreshCount === 1 ? refreshedAccessToken : unexpectedAccessToken,
        refresh_token: rotatedRefreshToken,
      },
      headers: {},
    }
  }
  axios.post = async (_url, _body, config) => {
    const authorization = config.headers.Authorization
    authorizations.push(authorization)
    if (authorization === `Bearer ${initialAccessToken}`) {
      initialRequestCount += 1
      const requestOrder = initialRequestCount
      if (initialRequestCount === 2) releaseInitialRequests()
      await initialRequestsReady
      if (requestOrder === 1) return { status: 401, data: Readable.from([]), headers: {} }
      await refreshedRequestSeen
      return { status: 401, data: Readable.from([]), headers: {} }
    }
    if (authorization === `Bearer ${refreshedAccessToken}`) {
      releaseRefreshedRequest()
      return { status: 200, data: Readable.from([]), headers: {} }
    }
    return { status: 200, data: Readable.from([]), headers: {} }
  }
  storeManager.getAccountById = (id) => id === accountId ? structuredClone(storedAccount) : undefined
  storeManager.updateAccount = (id, updates) => {
    if (id !== accountId) return null
    storedAccount = {
      ...storedAccount,
      ...updates,
      updatedAt: storedAccount.updatedAt + 1,
    }
    return structuredClone(storedAccount)
  }
  t.after(() => {
    axios.get = originalGet
    axios.post = originalPost
    storeManager.getAccountById = originalGetAccount
    storeManager.updateAccount = originalUpdateAccount
  })

  const request = {
    model: 'k2d5',
    messages: [{ role: 'user', content: 'keep the fresh concurrent token' }],
  }
  const first = createAdapterWithCredentials(storedAccount.credentials, accountId)
  const delayed = createAdapterWithCredentials(storedAccount.credentials, accountId)

  await Promise.all([
    first.chatCompletion(request),
    delayed.chatCompletion(request),
  ])

  assert.equal(refreshCount, 1)
  assert.equal(authorizations.filter((value) => value === `Bearer ${initialAccessToken}`).length, 2)
  assert.equal(authorizations.filter((value) => value === `Bearer ${refreshedAccessToken}`).length, 2)
  assert.equal(authorizations.includes(`Bearer ${unexpectedAccessToken}`), false)
  assert.deepEqual(storedAccount.credentials, {
    token: refreshedAccessToken,
    refreshToken: rotatedRefreshToken,
  })
})

test('Kimi ignores a delayed Connect unauthenticated trailer for a replaced access token', async (t) => {
  const accountId = 'kimi-delayed-connect-auth-account'
  const initialAccessToken = createAccessToken('delayed-connect-initial-user')
  const refreshedAccessToken = createAccessToken('delayed-connect-refreshed-user')
  const refreshToken = 'delayed-connect-refresh'
  let storedAccount = {
    id: accountId,
    providerId: 'kimi',
    name: 'Kimi delayed Connect auth',
    credentials: { token: initialAccessToken, refreshToken },
    status: 'active',
    createdAt: 1,
    updatedAt: 1,
  }
  let refreshCount = 0
  let authErrorCount = 0
  const authorizations = []
  const originalGet = axios.get
  const originalPost = axios.post
  const originalGetAccount = storeManager.getAccountById
  const originalUpdateAccount = storeManager.updateAccount

  axios.get = async () => {
    refreshCount += 1
    return {
      status: 200,
      data: { access_token: refreshedAccessToken, refresh_token: refreshToken },
      headers: {},
    }
  }
  axios.post = async (_url, _body, config) => {
    authorizations.push(config.headers.Authorization)
    return { status: 200, data: Readable.from([]), headers: {} }
  }
  storeManager.getAccountById = (id) => id === accountId ? structuredClone(storedAccount) : undefined
  storeManager.updateAccount = (id, updates) => {
    if (id !== accountId) return null
    storedAccount = {
      ...storedAccount,
      ...updates,
      updatedAt: storedAccount.updatedAt + 1,
    }
    return structuredClone(storedAccount)
  }
  t.after(() => {
    axios.get = originalGet
    axios.post = originalPost
    storeManager.getAccountById = originalGetAccount
    storeManager.updateAccount = originalUpdateAccount
  })

  const stale = createAdapterWithCredentials(storedAccount.credentials, accountId)
  const refreshing = createAdapterWithCredentials(storedAccount.credentials, accountId)
  const request = {
    model: 'k2d5',
    messages: [{ role: 'user', content: 'keep token after a stale trailer' }],
  }

  await stale.chatCompletion(request)
  assert.equal(refreshing.invalidateAccessToken(initialAccessToken), true)
  await refreshing.chatCompletion(request)

  const handler = new KimiStreamHandler(
    'Kimi-K2.6',
    '',
    false,
    undefined,
    () => {
      authErrorCount += 1
      stale.invalidateAccessToken(initialAccessToken)
    },
  )
  const source = fragmentedConnectStream([
    encodeConnectFrame({ error: { code: 'unauthenticated', message: 'old token' } }, 0x02),
  ])
  await assert.rejects(
    handler.handleNonStream(source),
    (error) => error.status === 401,
  )

  await stale.chatCompletion(request)

  assert.equal(authErrorCount, 1)
  assert.equal(refreshCount, 1)
  assert.deepEqual(authorizations, [
    `Bearer ${initialAccessToken}`,
    `Bearer ${refreshedAccessToken}`,
    `Bearer ${refreshedAccessToken}`,
  ])
})

test('Kimi retries one access-token 401 after refreshing and keeps the rotated token state', async (t) => {
  const initialAccessToken = createAccessToken('expired-access-user')
  const refreshedAccessToken = createAccessToken('retried-access-user')
  const secondRefreshedAccessToken = createAccessToken('second-retried-access-user')
  const initialRefreshToken = 'kimi-401-refresh-initial'
  const rotatedRefreshToken = 'kimi-401-refresh-rotated'
  const getCalls = []
  const postCalls = []
  const updateCalls = []
  const originalGet = axios.get
  const originalPost = axios.post
  const originalUpdateAccount = storeManager.updateAccount

  axios.get = async (...args) => {
    getCalls.push(args)
    const firstRefresh = getCalls.length === 1
    return {
      status: 200,
      data: {
        access_token: firstRefresh ? refreshedAccessToken : secondRefreshedAccessToken,
        refresh_token: firstRefresh ? rotatedRefreshToken : 'kimi-401-refresh-rotated-again',
        expires_in: 3600,
        user_id: 'retried-access-user',
      },
      headers: {},
    }
  }
  axios.post = async (...args) => {
    postCalls.push(args)
    return {
      status: postCalls.length === 1 || postCalls.length === 3 ? 401 : 200,
      data: Readable.from([]),
      headers: {},
    }
  }
  storeManager.updateAccount = (...args) => {
    updateCalls.push(args)
    return null
  }
  t.after(() => {
    axios.get = originalGet
    axios.post = originalPost
    storeManager.updateAccount = originalUpdateAccount
  })

  const adapter = createAdapterWithCredentials(
    { token: initialAccessToken, refreshToken: initialRefreshToken },
    'kimi-401-retry-account',
  )
  const request = {
    model: 'k2d5',
    messages: [{ role: 'user', content: 'retry after 401' }],
  }
  await adapter.chatCompletion(request)
  await adapter.chatCompletion(request)

  assert.equal(getCalls.length, 2)
  assert.deepEqual(
    getCalls.map((call) => call[1].headers.Authorization),
    [`Bearer ${initialRefreshToken}`, `Bearer ${rotatedRefreshToken}`],
  )
  assert.deepEqual(
    postCalls.map((call) => call[2].headers.Authorization),
    [
      `Bearer ${initialAccessToken}`,
      `Bearer ${refreshedAccessToken}`,
      `Bearer ${refreshedAccessToken}`,
      `Bearer ${secondRefreshedAccessToken}`,
    ],
  )
  assert.deepEqual(
    updateCalls.map(([accountId, updates]) => ({ accountId, credentials: updates.credentials })),
    [
      {
        accountId: 'kimi-401-retry-account',
        credentials: {
          token: refreshedAccessToken,
          refreshToken: rotatedRefreshToken,
        },
      },
      {
        accountId: 'kimi-401-retry-account',
        credentials: {
          token: secondRefreshedAccessToken,
          refreshToken: 'kimi-401-refresh-rotated-again',
        },
      },
    ],
  )
})

test('Kimi bypasses the recent-refresh cache after a refreshed access token is rejected', async (t) => {
  const initialAccessToken = createAccessToken('same-refresh-initial-user')
  const firstRefreshedAccessToken = createAccessToken('same-refresh-first-user')
  const secondRefreshedAccessToken = createAccessToken('same-refresh-second-user')
  const refreshToken = 'kimi-same-refresh-token'
  const getCalls = []
  const postCalls = []
  const originalGet = axios.get
  const originalPost = axios.post
  const originalUpdateAccount = storeManager.updateAccount

  axios.get = async (...args) => {
    getCalls.push(args)
    return {
      status: 200,
      data: {
        access_token: getCalls.length === 1
          ? firstRefreshedAccessToken
          : secondRefreshedAccessToken,
        refresh_token: refreshToken,
        expires_in: 3600,
      },
      headers: {},
    }
  }
  axios.post = async (...args) => {
    postCalls.push(args)
    return {
      status: postCalls.length === 1 || postCalls.length === 3 ? 401 : 200,
      data: Readable.from([]),
      headers: {},
    }
  }
  storeManager.updateAccount = () => null
  t.after(() => {
    axios.get = originalGet
    axios.post = originalPost
    storeManager.updateAccount = originalUpdateAccount
  })

  const adapter = createAdapterWithCredentials(
    { token: initialAccessToken, refreshToken },
    'kimi-same-refresh-401-account',
  )
  const request = {
    model: 'k2d5',
    messages: [{ role: 'user', content: 'force a second network refresh' }],
  }

  await adapter.chatCompletion(request)
  await adapter.chatCompletion(request)

  assert.equal(getCalls.length, 2)
  assert.deepEqual(
    getCalls.map((call) => call[1].headers.Authorization),
    [`Bearer ${refreshToken}`, `Bearer ${refreshToken}`],
  )
  assert.deepEqual(
    postCalls.map((call) => call[2].headers.Authorization),
    [
      `Bearer ${initialAccessToken}`,
      `Bearer ${firstRefreshedAccessToken}`,
      `Bearer ${firstRefreshedAccessToken}`,
      `Bearer ${secondRefreshedAccessToken}`,
    ],
  )
})

test('Kimi stops after one refresh retry when the upstream keeps returning 401', async (t) => {
  const initialAccessToken = createAccessToken('persistent-401-user')
  const refreshedAccessToken = createAccessToken('persistent-401-refreshed-user')
  let getCount = 0
  let postCount = 0
  const originalGet = axios.get
  const originalPost = axios.post
  const originalUpdateAccount = storeManager.updateAccount

  axios.get = async () => {
    getCount += 1
    return {
      status: 200,
      data: {
        access_token: refreshedAccessToken,
        refresh_token: 'persistent-401-rotated-refresh',
        expires_in: 3600,
      },
      headers: {},
    }
  }
  axios.post = async () => {
    postCount += 1
    return { status: 401, data: Readable.from([]), headers: {} }
  }
  storeManager.updateAccount = () => null
  t.after(() => {
    axios.get = originalGet
    axios.post = originalPost
    storeManager.updateAccount = originalUpdateAccount
  })

  const adapter = createAdapterWithCredentials(
    { token: initialAccessToken, refreshToken: 'persistent-401-initial-refresh' },
    'kimi-persistent-401-account',
  )
  await assert.rejects(
    adapter.chatCompletion({
      model: 'k2d5',
      messages: [{ role: 'user', content: 'do not loop' }],
    }),
    /401|invalid|expired/i,
  )

  assert.equal(getCount, 1)
  assert.equal(postCount, 2)
})

test('Kimi retries revoked credentials once for delete, list, and batch cleanup requests', async (t) => {
  const initialAccessToken = createAccessToken('cleanup-initial-user')
  const refreshedAccessTokens = [
    createAccessToken('cleanup-delete-user'),
    createAccessToken('cleanup-list-user'),
    createAccessToken('cleanup-batch-user'),
  ]
  const refreshToken = 'cleanup-shared-refresh-token'
  const endpointCounts = new Map()
  const endpointAuthorizations = new Map()
  let refreshCount = 0
  const originalGet = axios.get
  const originalPost = axios.post
  const originalUpdateAccount = storeManager.updateAccount

  axios.get = async () => {
    const accessToken = refreshedAccessTokens[refreshCount]
    refreshCount += 1
    return {
      status: 200,
      data: { access_token: accessToken, refresh_token: refreshToken },
      headers: {},
    }
  }
  axios.post = async (url, _body, config) => {
    const endpoint = url.split('/').at(-1)
    const count = (endpointCounts.get(endpoint) || 0) + 1
    endpointCounts.set(endpoint, count)
    endpointAuthorizations.set(endpoint, [
      ...(endpointAuthorizations.get(endpoint) || []),
      config.headers.Authorization,
    ])
    if (count === 1) return { status: 401, data: {}, headers: {} }
    if (endpoint === 'ListChats') {
      return {
        status: 200,
        data: { chats: [{ id: 'cleanup-chat-id' }], nextPageToken: '' },
        headers: {},
      }
    }
    return { status: 200, data: {}, headers: {} }
  }
  storeManager.updateAccount = () => null
  t.after(() => {
    axios.get = originalGet
    axios.post = originalPost
    storeManager.updateAccount = originalUpdateAccount
  })

  const adapter = createAdapterWithCredentials(
    { token: initialAccessToken, refreshToken },
    'kimi-cleanup-401-account',
  )

  assert.equal(await adapter.deleteConversation('single-cleanup-chat'), true)
  assert.equal(await adapter.deleteAllChats(), true)

  assert.equal(refreshCount, 3)
  assert.deepEqual(endpointAuthorizations.get('DeleteChat'), [
    `Bearer ${initialAccessToken}`,
    `Bearer ${refreshedAccessTokens[0]}`,
  ])
  assert.deepEqual(endpointAuthorizations.get('ListChats'), [
    `Bearer ${refreshedAccessTokens[0]}`,
    `Bearer ${refreshedAccessTokens[1]}`,
  ])
  assert.deepEqual(endpointAuthorizations.get('BatchDeleteChats'), [
    `Bearer ${refreshedAccessTokens[1]}`,
    `Bearer ${refreshedAccessTokens[2]}`,
  ])
})

test('Kimi delete reports failure when a retried HTTP 200 body still rejects authentication', async (t) => {
  const initialAccessToken = createAccessToken('delete-body-error-initial-user')
  const refreshedAccessToken = createAccessToken('delete-body-error-refreshed-user')
  let getCount = 0
  let postCount = 0
  const originalGet = axios.get
  const originalPost = axios.post
  const originalUpdateAccount = storeManager.updateAccount

  axios.get = async () => {
    getCount += 1
    return {
      status: 200,
      data: {
        access_token: refreshedAccessToken,
        refresh_token: 'delete-body-error-refresh',
      },
      headers: {},
    }
  }
  axios.post = async () => {
    postCount += 1
    return {
      status: 200,
      data: { error_type: 'auth.token.invalid', message: 'revoked' },
      headers: {},
    }
  }
  storeManager.updateAccount = () => null
  t.after(() => {
    axios.get = originalGet
    axios.post = originalPost
    storeManager.updateAccount = originalUpdateAccount
  })

  const adapter = createAdapterWithCredentials(
    { token: initialAccessToken, refreshToken: 'delete-body-error-refresh' },
    'kimi-delete-body-error-account',
  )

  assert.equal(await adapter.deleteConversation('delete-body-error-chat'), false)
  assert.equal(getCount, 1)
  assert.equal(postCount, 2)
})

test('Kimi chat request uses a Connect frame and preserves feature selection', async (t) => {
  const calls = []
  const originalPost = axios.post
  axios.post = async (...args) => {
    calls.push(args)
    return { status: 200, data: Readable.from([]), headers: {} }
  }
  t.after(() => {
    axios.post = originalPost
  })

  const messages = [{ role: 'user', content: 'hello from Docker' }]
  const originalMessages = structuredClone(messages)
  await createAdapter(createAccessToken('request-test-user')).chatCompletion({
    model: 'k2d5',
    // Keep the legacy public alias covered while the provider defaults to K2.6.
    originalModel: 'Kimi-K2.5-think-search',
    messages,
    stream: true,
  })

  assert.equal(calls.length, 1)
  const [url, body, config] = calls[0]
  assert.equal(url, 'https://www.kimi.com/apiv2/kimi.gateway.chat.v1.ChatService/Chat')
  assert.equal(config.responseType, 'stream')
  assert.equal(config.headers['Content-Type'], 'application/connect+json')
  assert.match(config.headers.Authorization, /^Bearer eyJ/)

  const payload = decodeConnectFrame(body)
  assert.equal(payload.scenario, 'SCENARIO_K2D5')
  assert.equal(payload.options.thinking, true)
  assert.equal(payload.options.reasoning_effort, 'REASONING_EFFORT_LOW')
  assert.deepEqual(payload.tools, [{ type: 'TOOL_TYPE_SEARCH', search: { force: true } }])
  assert.match(payload.message.blocks[0].text.content, /hello from Docker/)
  assert.deepEqual(messages, originalMessages, 'building an upstream request must not mutate client messages')
})

test('Kimi K3 Normal request uses the captured OK Computer scenario and proto field names', async (t) => {
  let capturedBody
  const originalPost = axios.post
  axios.post = async (_url, body) => {
    capturedBody = body
    return { status: 200, data: Readable.from([]), headers: {} }
  }
  t.after(() => {
    axios.post = originalPost
  })

  await createAdapter(createAccessToken('k3-payload-user')).chatCompletion({
    model: 'k3',
    originalModel: 'Kimi-K3',
    messages: [{ role: 'user', content: 'use K3 Normal' }],
  })

  const payload = decodeConnectFrame(capturedBody)
  assert.equal(payload.scenario, 'SCENARIO_OK_COMPUTER')
  assert.equal(payload.message.scenario, 'SCENARIO_OK_COMPUTER')
  assert.equal(payload.kimiplus_id, 'ok-computer')
  assert.equal(payload.project_id, '')
  assert.equal(payload.options.thinking, true)
  assert.equal(payload.options.reasoning_effort, 'REASONING_EFFORT_HIGH')
  assert.equal(payload.options.context_length, 'CONTEXT_LENGTH_L')
  assert.equal(payload.options.enable_plugin, true)
  assert.ok(Object.hasOwn(payload, 'chat_id'))
  assert.equal(Object.hasOwn(payload, 'kimi_plus_id'), false)
  assert.equal(Object.hasOwn(payload, 'agent_mode'), false)
})

test('Kimi chat request carries existing chat and parent message identifiers', async (t) => {
  let capturedBody
  const originalPost = axios.post
  axios.post = async (_url, body) => {
    capturedBody = body
    return { status: 200, data: Readable.from([]), headers: {} }
  }
  t.after(() => {
    axios.post = originalPost
  })

  await createAdapter(createAccessToken('session-test-user')).chatCompletion({
    model: 'k2d5',
    messages: [{ role: 'user', content: 'continue' }],
    conversationId: 'chat-existing-123',
    parentId: 'message-parent-456',
  })

  const payload = decodeConnectFrame(capturedBody)
  assert.equal(payload.chat_id, 'chat-existing-123')
  assert.equal(payload.message.parent_id, 'message-parent-456')
})

test('Kimi chat request accepts direct chat, parent, and project aliases', async (t) => {
  let capturedBody
  const originalPost = axios.post
  axios.post = async (_url, body) => {
    capturedBody = body
    return { status: 200, data: Readable.from([]), headers: {} }
  }
  t.after(() => {
    axios.post = originalPost
  })

  await createAdapter(createAccessToken('alias-session-user')).chatCompletion({
    model: 'k2d5',
    messages: [{ role: 'user', content: 'continue with aliases' }],
    conversationId: undefined,
    parentId: 'parent-alias-123',
    projectId: 'project-alias-456',
  })

  const payload = decodeConnectFrame(capturedBody)
  assert.equal(payload.chat_id, '')
  assert.equal(payload.project_id, 'project-alias-456')
  assert.equal(payload.message.parent_id, 'parent-alias-123')
})

test('Kimi extracts OpenAI text content parts and forwards the abort signal', async (t) => {
  let capturedBody
  let capturedSignal
  const controller = new AbortController()
  const originalPost = axios.post
  axios.post = async (_url, body, config) => {
    capturedBody = body
    capturedSignal = config.signal
    return { status: 200, data: Readable.from([]), headers: {} }
  }
  t.after(() => {
    axios.post = originalPost
  })

  await createAdapterWithCredentials(
    { token: createAccessToken('content-parts-user') },
    'kimi-content-parts-account',
  ).chatCompletion({
    model: 'k2d5',
    messages: [{
      role: 'user',
      content: [
        { type: 'text', text: 'first text part' },
        { type: 'text', text: 'second text part' },
      ],
    }],
    signal: controller.signal,
  })

  const content = decodeConnectFrame(capturedBody).message.blocks[0].text.content
  assert.match(content, /first text part/)
  assert.match(content, /second text part/)
  assert.equal(capturedSignal, controller.signal)
})

test('Kimi rejects unsupported media parts instead of sending an empty prompt', async (t) => {
  let postCount = 0
  const originalPost = axios.post
  axios.post = async () => {
    postCount += 1
    return { status: 200, data: Readable.from([]), headers: {} }
  }
  t.after(() => {
    axios.post = originalPost
  })

  await assert.rejects(
    createAdapterWithCredentials(
      { token: createAccessToken('unsupported-media-user') },
      'kimi-unsupported-media-account',
    ).chatCompletion({
      model: 'k2d5',
      messages: [{
        role: 'user',
        content: [{ type: 'image_url', image_url: { url: 'https://example.test/image.png' } }],
      }],
    }),
    /does not support message content parts: image_url/,
  )
  assert.equal(postCount, 0)
})

test('Kimi multi-turn continuation preserves every parallel tool result', async (t) => {
  let capturedBody
  const originalPost = axios.post
  axios.post = async (_url, body) => {
    capturedBody = body
    return { status: 200, data: Readable.from([]), headers: {} }
  }
  t.after(() => {
    axios.post = originalPost
  })

  await createAdapterWithCredentials(
    { token: createAccessToken('parallel-tools-user') },
    'kimi-parallel-tools-account',
  ).chatCompletion({
    model: 'k2d5',
    conversationId: 'chat-parallel-tools',
    parentId: 'assistant-tool-message',
    messages: [
      { role: 'user', content: 'run both tools' },
      {
        role: 'assistant',
        content: null,
        tool_calls: [
          { id: 'call-a', type: 'function', function: { name: 'first_tool', arguments: '{}' } },
          { id: 'call-b', type: 'function', function: { name: 'second_tool', arguments: '{}' } },
        ],
      },
      { role: 'tool', tool_call_id: 'call-a', content: 'first tool result' },
      { role: 'tool', tool_call_id: 'call-b', content: [{ type: 'text', text: 'second tool result' }] },
    ],
  })

  const content = decodeConnectFrame(capturedBody).message.blocks[0].text.content
  assert.match(content, /call-a/)
  assert.match(content, /first tool result/)
  assert.match(content, /call-b/)
  assert.match(content, /second tool result/)
})

test('Kimi stream converts fragmented Connect frames into OpenAI reasoning and answer chunks', async () => {
  const handler = new KimiStreamHandler('Kimi-K2.6', '')
  const source = fragmentedConnectStream([
    { chat: { id: 'chat-real-123' } },
    { message: { id: 'message-real-456', role: 'assistant' } },
    { op: 'append', mask: 'block.think.content', block: { think: { content: 'reasoning' } } },
    { op: 'append', mask: 'block.text.content', block: { text: { content: 'answer' } } },
    // The production Connect JSON representation is an empty message object.
    { done: {} },
  ])

  const output = await handler.handleStream(source)
  const raw = await collectText(output)
  const chunks = parseSse(raw)

  assert.equal(handler.getConversationId(), 'chat-real-123')
  assert.equal(handler.getLastMessageId(), 'message-real-456')
  assert.ok(chunks.every((chunk) => chunk.id === chunks[0].id && chunk.id))
  assert.ok(chunks.some((chunk) => chunk.choices[0].delta.role === 'assistant'))
  assert.ok(chunks.some((chunk) => chunk.choices[0].delta.reasoning_content === 'reasoning'))
  assert.ok(chunks.some((chunk) => chunk.choices[0].delta.content === 'answer'))
  assert.equal(chunks.at(-1).choices[0].finish_reason, 'stop')
  assert.equal(chunks.at(-1).conversation_id, 'chat-real-123')
  assert.equal(chunks.at(-1).chat_id, 'chat-real-123')
  assert.equal(chunks.at(-1).parent_message_id, 'message-real-456')
  assert.equal(chunks.at(-1).parent_id, 'message-real-456')
  assert.equal(raw.match(/data: \[DONE\]/g)?.length, 1)
})

test('Kimi non-stream conversion retains reasoning, answer, and upstream session ids', async () => {
  const handler = new KimiStreamHandler('Kimi-K2.6', '')
  const source = fragmentedConnectStream([
    { chat: { id: 'chat-non-stream' } },
    { message: { id: 'message-non-stream', role: 'assistant' } },
    { op: 'append', mask: 'block.think.content', block: { think: { content: 'think once' } } },
    { op: 'append', mask: 'block.text.content', block: { text: { content: 'final answer' } } },
    // Keep this path aligned with the official proto JSON encoding.
    { done: {} },
  ])

  const response = await handler.handleNonStream(source)
  assert.equal(response.id, 'chat-non-stream')
  assert.equal(response.choices[0].message.reasoning_content, 'think once')
  assert.equal(response.choices[0].message.content, 'final answer')
  assert.equal(response.choices[0].finish_reason, 'stop')
  assert.equal(response.conversation_id, 'chat-non-stream')
  assert.equal(response.chat_id, 'chat-non-stream')
  assert.equal(response.parent_message_id, 'message-non-stream')
  assert.equal(response.parent_id, 'message-non-stream')
  assert.equal(handler.getLastMessageId(), 'message-non-stream')
})

test('Kimi Connect set snapshots emit only new deltas and accept done on the end frame', async () => {
  const handler = new KimiStreamHandler('Kimi-K2.6', '')
  const source = fragmentedConnectStream([
    { op: 'set', mask: 'block.text.content', block: { text: { content: 'hello' } } },
    { op: 'set', mask: 'block.text.content', block: { text: { content: 'hello world' } } },
    { done: false },
    { op: 'append', mask: 'block.text.content', block: { text: { content: '!' } } },
    encodeConnectFrame({ done: {} }, 0x02),
  ])

  const raw = await collectText(await handler.handleStream(source))
  const content = parseSse(raw)
    .map((chunk) => chunk.choices?.[0]?.delta?.content || '')
    .join('')
  assert.equal(content, 'hello world!')
  assert.equal(raw.match(/data: \[DONE\]/g)?.length, 1)
})

test('Kimi stream cancellation destroys the upstream and reports status 499', async () => {
  const handler = new KimiStreamHandler('Kimi-K2.6', '')
  const source = new Readable({ read() {} })
  const controller = new AbortController()
  const output = await handler.handleStream(source, { signal: controller.signal })
  const errorPromise = new Promise((resolve) => output.once('error', resolve))

  controller.abort()
  const error = await errorPromise

  assert.equal(error.status, 499)
  assert.equal(error.retryable, false)
  assert.equal(source.destroyed, true)
})

test('Kimi non-stream conversion rejects explicit upstream errors', async () => {
  const handler = new KimiStreamHandler('Kimi-K2.6', '')
  const source = fragmentedConnectStream([
    { error: { message: 'synthetic upstream failure' } },
  ])

  await assert.rejects(
    handler.handleNonStream(source),
    /Kimi API Error: synthetic upstream failure/,
  )
})

test('Kimi non-stream conversion rejects an error trailer received after done', async () => {
  const handler = new KimiStreamHandler('Kimi-K2.6', '')
  const source = fragmentedConnectStream([
    {},
    { done: true },
    encodeConnectFrame({
      error: {
        code: 'permission_denied',
        message: 'synthetic trailer denial',
      },
    }, 0x02),
  ])

  await assert.rejects(
    handler.handleNonStream(source),
    /Kimi API Error \(permission_denied\): synthetic trailer denial/,
  )
})

test('Kimi Connect error details expose the localized login message and status', async () => {
  const handler = new KimiStreamHandler('Kimi-K2.6', '')
  const source = fragmentedConnectStream([
    { done: true },
    encodeConnectFrame({
      error: {
        code: 'permission_denied',
        details: [{
          type: 'common.error.v1.ErrorDetail',
          debug: {
            reason: 'REASON_ANONYMOUS_REQUIRE_LOGIN',
            localizedMessage: { locale: 'en-US', message: 'Please log in to continue.' },
          },
        }],
      },
    }, 0x02),
  ])

  await assert.rejects(
    handler.handleNonStream(source),
    (error) => {
      assert.equal(error.status, 403)
      assert.equal(error.reason, 'REASON_ANONYMOUS_REQUIRE_LOGIN')
      assert.match(error.message, /Please log in to continue\./)
      assert.doesNotMatch(error.message, /localizedMessage|ErrorDetail/)
      return true
    },
  )
})

test('Kimi stream uses one non-empty response id before and after chat id discovery', async () => {
  const handler = new KimiStreamHandler('Kimi-K2.6', '')
  const source = fragmentedConnectStream([
    { op: 'append', mask: 'block.text.content', block: { text: { content: 'early answer' } } },
    { chat: { id: 'chat-discovered-late' } },
    { done: true },
  ])

  const chunks = parseSse(await collectText(await handler.handleStream(source)))
  const ids = new Set(chunks.map((chunk) => chunk.id))
  assert.equal(ids.size, 1)
  assert.match(chunks[0].id, /^chatcmpl-/)
  assert.equal(chunks[0].id, handler.getResponseId())
  assert.equal(handler.getConversationId(), 'chat-discovered-late')
})

test('Kimi non-stream falls back to a stable id when no upstream chat id is returned', async () => {
  const handler = new KimiStreamHandler('Kimi-K2.6', '')
  const source = fragmentedConnectStream([
    { op: 'append', mask: 'block.text.content', block: { text: { content: 'answer without chat id' } } },
    { done: true },
  ])

  const response = await handler.handleNonStream(source)
  assert.match(response.id, /^chatcmpl-/)
  assert.equal(response.id, handler.getResponseId())
})

test('Kimi stream conversion rejects an error trailer after done without emitting fake success', async () => {
  const handler = new KimiStreamHandler('Kimi-K2.6', '')
  const source = fragmentedConnectStream([
    {},
    { done: true },
    encodeConnectFrame({
      error: {
        code: 'permission_denied',
        message: 'synthetic streamed trailer denial',
      },
    }, 0x02),
  ])

  const output = await handler.handleStream(source)
  let emitted = ''
  let streamError
  try {
    for await (const chunk of output) emitted += chunk.toString()
  } catch (error) {
    streamError = error
  }

  assert.ok(streamError instanceof Error)
  assert.match(streamError.message, /Kimi API Error \(permission_denied\): synthetic streamed trailer denial/)
  assert.doesNotMatch(emitted, /data: \[DONE\]/)
})
