import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import fs from 'node:fs'
import test from 'node:test'
import ts from 'typescript'

const runtimeRequire = createRequire(import.meta.url)

function loadTokenRefreshModule({ post, updateAccount } = {}) {
  const source = fs.readFileSync('src/main/proxy/adapters/qwen-ai-token-refresh.ts', 'utf8')
  const output = ts.transpileModule(source, {
    compilerOptions: {
      esModuleInterop: true,
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
    },
  }).outputText
  const module = { exports: {} }
  const axios = {
    post: post || (async () => {
      throw new Error('Unexpected Qwen AI signin request')
    }),
  }
  const localModules = {
    axios,
    crypto: runtimeRequire('node:crypto'),
    '../../store/store': {
      storeManager: {
        updateAccount: updateAccount || (() => null),
      },
    },
  }
  const testRequire = specifier => {
    if (Object.prototype.hasOwnProperty.call(localModules, specifier)) {
      return localModules[specifier]
    }
    throw new Error(`Unexpected token refresher test import: ${specifier}`)
  }

  new Function('require', 'module', 'exports', output)(testRequire, module, module.exports)
  return module.exports
}

function jwtExpiringAt(timestampMs) {
  const encode = value => Buffer.from(JSON.stringify(value)).toString('base64url')
  return `${encode({ alg: 'none' })}.${encode({ exp: Math.floor(timestampMs / 1000) })}.signature`
}

function qwenAccount(credentials) {
  return {
    id: 'qwen-account',
    providerId: 'qwen-ai',
    name: 'Qwen account',
    status: 'active',
    credentials,
  }
}

test('Qwen AI credentials include optional email and password for automatic token refresh', () => {
  const providerSource = fs.readFileSync('src/main/providers/builtin/qwen-ai.ts', 'utf8')
  const storeTypesSource = fs.readFileSync('src/main/store/types.ts', 'utf8')
  const addAccountSource = fs.readFileSync('src/renderer/src/components/providers/AddAccountDialog.tsx', 'utf8')
  const providersPageSource = fs.readFileSync('src/renderer/src/pages/Providers.tsx', 'utf8')

  assert.match(providerSource, /name:\s*'email'/)
  assert.match(providerSource, /name:\s*'password'/)
  assert.match(providerSource, /required:\s*false/)
  assert.match(storeTypesSource, /export \{ builtinProviders as BUILTIN_PROVIDERS \} from '\.\.\/providers\/builtin\/index\.ts'/)

  assert.match(addAccountSource, /const accountEmail = provider\?\.id === 'qwen-ai'/)
  assert.match(addAccountSource, /email:\s*accountEmail/)
  assert.match(providersPageSource, /email:\s*provider\.id === 'qwen-ai' \? credentials\.email\?\.trim\(\) \|\| undefined : undefined/)
})

test('Qwen AI OAuth import form keeps optional refresh login fields', () => {
  const addAccountSource = fs.readFileSync('src/renderer/src/components/providers/AddAccountDialog.tsx', 'utf8')

  assert.match(addAccountSource, /oauthRefreshCredentialFields/)
  assert.match(addAccountSource, /fields=\{oauthRefreshCredentialFields\}/)
  assert.match(addAccountSource, /setCredentials\(prev => \(\{\s*\.\.\.prev,\s*\.\.\.mappedCredentials,\s*\}\)\)/s)
})

test('Qwen AI adapter refreshes expiring web tokens by signing in with saved email and password', () => {
  const refresherSource = fs.readFileSync('src/main/proxy/adapters/qwen-ai-token-refresh.ts', 'utf8')
  const adapterSource = fs.readFileSync('src/main/proxy/adapters/qwen-ai.ts', 'utf8')

  assert.match(refresherSource, /class QwenAiTokenRefresher/)
  assert.match(refresherSource, /\/api\/v2\/auths\/signin/)
  assert.match(refresherSource, /createHash\('sha256'\)/)
  assert.match(refresherSource, /isTokenExpiringSoon/)
  assert.match(refresherSource, /storeManager\.updateAccount\(account\.id,\s*\{/)
  assert.match(refresherSource, /mergeCookieHeaders/)
  assert.match(refresherSource, /response\.headers\['set-cookie'\]/)
  assert.match(refresherSource, /const credentials = \{\s*\.\.\.account\.credentials,\s*token,\s*\.\.\.\(cookies \? \{ cookies \} : \{\}\),\s*\}/s)
  assert.match(refresherSource, /!this\.isTokenExpiringSoon\(account\.credentials\.token \|\| ''\)/)
  assert.match(refresherSource, /source:\s*'web'/)
  assert.match(refresherSource, /Version:\s*'0\.2\.67'/)
  assert.match(refresherSource, /Timezone:\s*currentTimezoneHeader\(\)/)

  assert.match(adapterSource, /QwenAiTokenRefresher/)
  assert.match(adapterSource, /await this\.tokenRefresher\.refreshIfNeeded\(this\.account, signal\)/)
  assert.match(adapterSource, /await this\.tokenRefresher\.refreshAfterUnauthorized\(this\.account, options\.signal\)/)
  assert.match(adapterSource, /createOptions: \(\) => Record<string, any>/)
  assert.match(adapterSource, /resolveQwenAiAuthHeaders\(token, cookies\)/)
  assert.match(refresherSource, /async refreshIfNeeded\(account: Account, signal\?: AbortSignal\)/)
  assert.match(refresherSource, /async repairWebSession\(account: Account, signal\?: AbortSignal\)/)
  assert.match(refresherSource, /async refreshAfterUnauthorized\(account: Account, signal\?: AbortSignal\)/)
  assert.match(refresherSource, /timeout:\s*15000,\s*signal,/)
  assert.match(adapterSource, /const chatType = imageGeneration\?\.chatType \?\? 't2t'/)
  assert.match(adapterSource, /createChat\(modelId, 'OpenAI_API_Chat', scope\.signal, chatType\)/)
})

test('Qwen AI token refresher persists signin Set-Cookie values for web sessions', () => {
  const refresherSource = fs.readFileSync('src/main/proxy/adapters/qwen-ai-token-refresh.ts', 'utf8')

  assert.match(refresherSource, /export function mergeCookieHeaders/)
  assert.match(refresherSource, /parseCookiePair/)
  assert.match(refresherSource, /cookies\.set\(parsed\[0\], parsed\[1\]\)/)
  assert.match(refresherSource, /Array\.from\(cookies\.entries\(\)\)/)
  assert.match(refresherSource, /account\.credentials\.cookies \|\| account\.credentials\.cookie \|\| ''/)
  assert.match(refresherSource, /\.\.\.\(cookies \? \{ cookies \} : \{\}\)/)
})

test('Qwen AI repairs an incomplete web session even when its JWT is fresh', async () => {
  let signInCalls = 0
  const { QwenAiTokenRefresher } = loadTokenRefreshModule({
    post: async () => {
      signInCalls += 1
      return {
        status: 200,
        data: { data: { token: 'refreshed-jwt' } },
        headers: { 'set-cookie': ['token=session-cookie; Path=/; HttpOnly'] },
      }
    },
  })
  const account = qwenAccount({
    token: jwtExpiringAt(Date.now() + 24 * 60 * 60 * 1000),
    cookies: 'cnaui=auxiliary-cookie; x-ap=auxiliary-value',
    email: 'fixture@example.test',
    password: 'fixture-password',
  })

  const result = await new QwenAiTokenRefresher().refreshIfNeeded(account)

  assert.equal(signInCalls, 1)
  assert.equal(result.credentials.token, 'refreshed-jwt')
  assert.equal(result.credentials.cookies, 'cnaui=auxiliary-cookie; x-ap=auxiliary-value; token=session-cookie')
})

test('Qwen AI keeps a fresh desktop JWT that has no web cookies', async () => {
  let signInCalls = 0
  const { QwenAiTokenRefresher } = loadTokenRefreshModule({
    post: async () => {
      signInCalls += 1
      throw new Error('signin should not run for a fresh desktop JWT')
    },
  })
  const account = qwenAccount({
    token: jwtExpiringAt(Date.now() + 24 * 60 * 60 * 1000),
    cookies: '',
    email: 'fixture@example.test',
    password: 'fixture-password',
  })

  const result = await new QwenAiTokenRefresher().refreshIfNeeded(account)

  assert.equal(result, account)
  assert.equal(signInCalls, 0)
})

test('Qwen AI explicitly repairs a web session that has no cookies yet', async () => {
  let signInCalls = 0
  const { QwenAiTokenRefresher } = loadTokenRefreshModule({
    post: async () => {
      signInCalls += 1
      return {
        status: 200,
        data: { data: { token: 'refreshed-jwt' } },
        headers: { 'set-cookie': ['token=session-cookie; Path=/; HttpOnly'] },
      }
    },
  })
  const account = qwenAccount({
    token: jwtExpiringAt(Date.now() + 24 * 60 * 60 * 1000),
    cookies: '',
    email: 'fixture@example.test',
    password: 'fixture-password',
  })

  const result = await new QwenAiTokenRefresher().repairWebSession(account)

  assert.equal(signInCalls, 1)
  assert.equal(result.credentials.cookies, 'token=session-cookie')
})

test('Qwen AI authentication mode is selected from the actual session credential', () => {
  const { hasQwenAiSessionCookie, resolveQwenAiAuthHeaders } = loadTokenRefreshModule()

  assert.deepEqual(
    resolveQwenAiAuthHeaders('jwt-value', 'cnaui=auxiliary; x-ap=value'),
    {
      Authorization: 'Bearer jwt-value',
      Cookie: 'cnaui=auxiliary; x-ap=value',
    },
  )
  assert.deepEqual(
    resolveQwenAiAuthHeaders('jwt-value', 'cnaui=auxiliary; token=session-value; x-ap=value'),
    { Cookie: 'cnaui=auxiliary; token=session-value; x-ap=value' },
  )
  assert.deepEqual(
    resolveQwenAiAuthHeaders('jwt-value', ''),
    { Authorization: 'Bearer jwt-value', source: 'desktop' },
  )
  assert.equal(hasQwenAiSessionCookie('not_token=value; token_hint=value'), false)
})

test('Qwen AI refresh uses v2 signin and accepts a nested token response', async () => {
  const calls = []
  let persisted
  const { QwenAiTokenRefresher } = loadTokenRefreshModule({
    post: async (url, payload, options) => {
      calls.push({ url, payload, options })
      return {
        status: 200,
        data: { data: { token: 'nested-refreshed-token' } },
        headers: { 'set-cookie': ['token=session-cookie; Path=/; HttpOnly'] },
      }
    },
    updateAccount: (_id, updates) => {
      persisted = updates
      return null
    },
  })
  const account = qwenAccount({
    token: jwtExpiringAt(Date.now() + 60 * 60 * 1000),
    cookies: 'cnaui=auxiliary',
    email: 'fixture@example.test',
    password: 'fixture-password',
  })

  const result = await new QwenAiTokenRefresher().refreshIfNeeded(account)

  assert.equal(calls.length, 1)
  assert.equal(calls[0].url, 'https://chat.qwen.ai/api/v2/auths/signin')
  assert.match(calls[0].payload.password, /^[a-f0-9]{64}$/)
  assert.notEqual(calls[0].payload.password, account.credentials.password)
  assert.equal(result.credentials.token, 'nested-refreshed-token')
  assert.equal(result.credentials.cookies, 'cnaui=auxiliary; token=session-cookie')
  assert.equal(persisted.credentials.token, 'nested-refreshed-token')
})

test('Qwen AI refresh falls back to legacy signin only when v2 is unsupported', async () => {
  const calls = []
  const { QwenAiTokenRefresher } = loadTokenRefreshModule({
    post: async (url) => {
      calls.push(url)
      if (url.endsWith('/api/v2/auths/signin')) {
        return { status: 404, data: { detail: 'not found' }, headers: {} }
      }
      return { status: 200, data: { token: 'legacy-token' }, headers: {} }
    },
  })
  const account = qwenAccount({
    token: jwtExpiringAt(Date.now() + 60 * 60 * 1000),
    email: 'fixture@example.test',
    password: 'fixture-password',
  })

  const result = await new QwenAiTokenRefresher().refreshIfNeeded(account)

  assert.deepEqual(calls, [
    'https://chat.qwen.ai/api/v2/auths/signin',
    'https://chat.qwen.ai/api/v1/auths/signin',
  ])
  assert.equal(result.credentials.token, 'legacy-token')
})

test('Qwen AI refresh maps credential rejection to account failover metadata without a second login', async () => {
  const calls = []
  let persisted
  const { QwenAiTokenRefresher } = loadTokenRefreshModule({
    post: async (url) => {
      calls.push(url)
      return {
        status: 400,
        data: { data: { details: 'password rejected; token=secret-value' } },
        headers: {},
      }
    },
    updateAccount: (_id, updates) => {
      persisted = updates
      return null
    },
  })
  const account = qwenAccount({
    token: jwtExpiringAt(Date.now() + 60 * 60 * 1000),
    email: 'fixture@example.test',
    password: 'fixture-password',
  })

  await assert.rejects(
    new QwenAiTokenRefresher().refreshIfNeeded(account),
    error => {
      assert.equal(error.status, 401)
      assert.equal(error.code, 'qwen_ai_token_refresh_failed')
      assert.equal(error.retryable, false)
      assert.equal(error.accountFault, true)
      assert.equal(error.retryScope, 'next-account')
      assert.match(error.message, /password rejected/)
      assert.doesNotMatch(error.message, /secret-value/)
      return true
    },
  )
  assert.deepEqual(calls, ['https://chat.qwen.ai/api/v2/auths/signin'])
  assert.equal(persisted, undefined, 'ordinary credential rejection remains request-scoped')
})

test('Qwen AI refresh treats a successful HTTP response without a token as an account failure', async () => {
  let persisted
  const { QwenAiTokenRefresher } = loadTokenRefreshModule({
    updateAccount: (_id, updates) => {
      persisted = updates
      return null
    },
    post: async () => ({
      status: 200,
      data: { data: { details: 'account is not registered' } },
      headers: {},
    }),
  })
  const account = qwenAccount({
    token: jwtExpiringAt(Date.now() + 24 * 60 * 60 * 1000),
    cookies: 'cnaui=auxiliary-cookie',
    email: 'fixture@example.test',
    password: 'fixture-password',
  })

  await assert.rejects(
    new QwenAiTokenRefresher().refreshIfNeeded(account),
    error => error.status === 401
      && error.code === 'qwen_ai_token_refresh_failed'
      && error.retryable === false
      && error.accountFault === true
      && error.retryScope === 'next-account'
      && /not registered/.test(error.message),
  )
  assert.equal(persisted.status, 'inactive')
  assert.match(persisted.errorMessage, /not registered/)
})

test('Qwen AI refresh persists an explicit Chinese unregistered-account response', async () => {
  let persisted
  const { QwenAiTokenRefresher } = loadTokenRefreshModule({
    updateAccount: (_id, updates) => {
      persisted = updates
      return null
    },
    post: async () => ({
      status: 401,
      data: { data: { details: '\u60a8\u63d0\u4f9b\u7684\u5e10\u6237\u672a\u6ce8\u518c\u3002\u8bf7\u5148\u6ce8\u518c\uff01' } },
      headers: {},
    }),
  })
  const account = qwenAccount({
    token: jwtExpiringAt(Date.now() + 24 * 60 * 60 * 1000),
    cookies: 'cnaui=auxiliary-cookie',
    email: 'fixture@example.test',
    password: 'fixture-password',
  })

  await assert.rejects(
    new QwenAiTokenRefresher().refreshIfNeeded(account),
    error => error.status === 401
      && error.accountFault === true
      && error.retryScope === 'next-account',
  )
  assert.equal(persisted.status, 'inactive')
})

test('Qwen AI refresh treats a WAF challenge as account-neutral and stops account sweeping', async () => {
  let persisted
  const { QwenAiTokenRefresher } = loadTokenRefreshModule({
    updateAccount: (_id, updates) => {
      persisted = updates
      return null
    },
    post: async () => ({
      status: 403,
      data: '<meta name="aliyun_waf_aa"> FAIL_SYS_USER_VALIDATE challenge',
      headers: {},
    }),
  })
  const account = qwenAccount({
    token: jwtExpiringAt(Date.now() + 24 * 60 * 60 * 1000),
    cookies: 'cnaui=auxiliary-cookie',
    email: 'fixture@example.test',
    password: 'fixture-password',
  })

  await assert.rejects(
    new QwenAiTokenRefresher().refreshIfNeeded(account),
    error => error.status === 403
      && error.code === 'qwen_ai_token_refresh_failed'
      && error.retryable === false
      && error.accountFault === false
      && error.retryScope === undefined,
  )
  assert.equal(persisted, undefined)
})

test('Qwen AI refresh distinguishes upstream failure and cancellation', async () => {
  const credentials = {
    token: jwtExpiringAt(Date.now() + 60 * 60 * 1000),
    email: 'fixture@example.test',
    password: 'fixture-password',
  }
  let upstreamPersisted
  const upstream = loadTokenRefreshModule({
    updateAccount: (_id, updates) => {
      upstreamPersisted = updates
      return null
    },
    post: async () => ({ status: 503, data: { message: 'temporarily unavailable' }, headers: {} }),
  })
  await assert.rejects(
    new upstream.QwenAiTokenRefresher().refreshIfNeeded(qwenAccount(credentials)),
    error => error.status === 502
      && error.retryable === true
      && error.accountFault === false
      && error.retryScope === undefined,
  )
  assert.equal(upstreamPersisted, undefined)

  const controller = new AbortController()
  controller.abort()
  const cancelled = loadTokenRefreshModule({
    post: async () => {
      throw Object.assign(new Error('canceled'), { code: 'ERR_CANCELED' })
    },
  })
  await assert.rejects(
    new cancelled.QwenAiTokenRefresher().refreshIfNeeded(qwenAccount(credentials), controller.signal),
    error => error.status === 499
      && error.retryable === false
      && error.accountFault === false
      && error.retryScope === undefined,
  )
})
