import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'
import ts from 'typescript'

function loadRepairModule({ accounts, providers, repairWebSession }) {
  const source = fs.readFileSync('src/main/proxy/qwenAiSessionRepair.ts', 'utf8')
  const output = ts.transpileModule(source, {
    compilerOptions: {
      esModuleInterop: true,
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
    },
  }).outputText
  const module = { exports: {} }
  const logs = []
  const localModules = {
    '../store/store': {
      storeManager: {
        getProviders: () => providers,
        getAccounts: () => accounts,
        addLog: (...args) => logs.push(args),
      },
    },
    './adapters/qwen-ai-token-refresh': {
      hasQwenAiSessionCookie: cookies => /(?:^|;\s*)token=[^;]+/.test(String(cookies || '')),
      qwenAiTokenRefresher: { repairWebSession },
    },
  }
  const testRequire = specifier => {
    if (Object.prototype.hasOwnProperty.call(localModules, specifier)) {
      return localModules[specifier]
    }
    throw new Error(`Unexpected Qwen session repair test import: ${specifier}`)
  }

  new Function('require', 'module', 'exports', output)(testRequire, module, module.exports)
  return { ...module.exports, logs }
}

function account(id, credentials, status = 'active') {
  return {
    id,
    providerId: 'qwen-ai',
    name: id,
    status,
    credentials,
  }
}

const provider = {
  id: 'qwen-ai',
  name: 'Qwen AI',
  apiEndpoint: 'https://chat.qwen.ai',
}

test('Qwen AI session repair selects one repairable incomplete account and makes it ready', async () => {
  const ready = account('ready', {
    token: 'jwt-ready',
    cookies: 'token=session-ready; x-ap=value',
  })
  const incomplete = account('incomplete', {
    token: 'jwt-incomplete',
    cookies: 'cnaui=value; x-ap=value',
    email: 'fixture@example.test',
    password: 'fixture-password',
  })
  const missingLogin = account('missing-login', {
    token: 'jwt-only',
    cookies: 'cnaui=value',
  })
  const calls = []
  const loaded = loadRepairModule({
    accounts: [ready, incomplete, missingLogin],
    providers: [provider],
    repairWebSession: async selected => {
      calls.push(selected.id)
      return {
        ...selected,
        credentials: {
          ...selected.credentials,
          cookies: `${selected.credentials.cookies}; token=repaired-session`,
        },
      }
    },
  })
  const service = new loaded.QwenAiSessionRepairService()

  const result = await service.repairNext()

  assert.deepEqual(calls, ['incomplete'])
  assert.deepEqual(result, { status: 'repaired', accountId: 'incomplete' })
  const repairedAccount = {
    ...incomplete,
    credentials: {
      ...incomplete.credentials,
      cookies: `${incomplete.credentials.cookies}; token=repaired-session`,
    },
  }
  assert.equal(service.getAccountStatus(repairedAccount).state, 'ready')
  assert.equal(service.getAccountStatus(missingLogin).state, 'unrepairable')
  assert.equal(loaded.logs[0][0], 'info')
})

test('Qwen AI session repair pauses the account sweep after upstream risk control', async () => {
  const incomplete = account('risk-controlled', {
    token: 'jwt-incomplete',
    cookies: 'cnaui=value',
    email: 'fixture@example.test',
    password: 'fixture-password',
  })
  let calls = 0
  const loaded = loadRepairModule({
    accounts: [incomplete],
    providers: [provider],
    repairWebSession: async () => {
      calls += 1
      throw Object.assign(new Error('Qwen AI token refresh failed (risk-control)'), {
        status: 403,
        code: 'qwen_ai_token_refresh_failed',
        accountFault: false,
      })
    },
  })
  const service = new loaded.QwenAiSessionRepairService()

  const failed = await service.repairNext()
  const paused = await service.repairNext()

  assert.equal(failed.status, 'failed')
  assert.equal(failed.accountId, 'risk-controlled')
  assert.ok(failed.globalPauseUntil > Date.now())
  assert.deepEqual(paused, {
    status: 'paused',
    nextAttemptAt: failed.globalPauseUntil,
  })
  assert.equal(calls, 1)
  assert.equal(service.getAccountStatus(incomplete).state, 'backoff')
})

test('Qwen AI session repair skips an account persisted as unregistered', async () => {
  const unregistered = account('unregistered', {
    token: 'jwt-unregistered',
    cookies: 'cnaui=value',
    email: 'fixture@example.test',
    password: 'fixture-password',
  })
  let calls = 0
  const loaded = loadRepairModule({
    accounts: [unregistered],
    providers: [provider],
    repairWebSession: async () => {
      calls += 1
      const error = Object.assign(new Error('Qwen AI account is not registered'), {
        status: 401,
        code: 'qwen_ai_token_refresh_failed',
        accountFault: true,
        retryScope: 'next-account',
        accountStatus: 'inactive',
      })
      // The real refresher persists this state before it throws. Keep the
      // service fixture focused on how it treats that persisted account.
      unregistered.status = error.accountStatus
      unregistered.errorMessage = error.message
      throw error
    },
  })

  const service = new loaded.QwenAiSessionRepairService()
  const failed = await service.repairNext()
  const idle = await service.repairNext()

  assert.equal(failed.status, 'failed')
  assert.equal(idle.status, 'idle')
  assert.equal(unregistered.status, 'inactive')
  assert.equal(service.getAccountStatus(unregistered).state, 'unrepairable')
  assert.equal(calls, 1)
})

test('Qwen AI repair is wired into server lifecycle, validation, and governor status', () => {
  const serverSource = fs.readFileSync('src/main/proxy/server.ts', 'utf8')
  const accountsSource = fs.readFileSync('src/main/store/accounts.ts', 'utf8')
  const governorRouteSource = fs.readFileSync(
    'src/main/proxy/routes/management/qwenAiGovernor.ts',
    'utf8',
  )

  assert.match(serverSource, /qwenAiSessionRepairService\.start\(\)/)
  assert.match(serverSource, /qwenAiSessionRepairService\.stop\(\)/)
  assert.match(accountsSource, /qwenAiTokenRefresher\.repairWebSession\(account\)/)
  assert.match(accountsSource, /validateCredentials\(provider, validationAccount\.credentials\)/)
  assert.match(governorRouteSource, /storeManager\.getAccounts\(true\)/)
  assert.match(governorRouteSource, /webSessionRepairState: repairStatus\.state/)
})
