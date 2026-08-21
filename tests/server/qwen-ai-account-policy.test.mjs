import assert from 'node:assert/strict'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import test from 'node:test'
import ts from 'typescript'

const require = createRequire(import.meta.url)

function loadPolicy() {
  const source = fs.readFileSync('src/main/proxy/qwenAiAccountPolicy.ts', 'utf8')
  const output = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
    },
  }).outputText
  const module = { exports: {} }
  new Function('require', 'module', 'exports', output)(require, module, module.exports)
  return module.exports
}

const {
  isQwenAiAccountFault,
  isQwenAiAccountNeutralFailure,
  qwenAiAccountRetryScope,
} = loadPolicy()

test('nested LiteLLM 503 wrapper preserves a real 401 account fault', () => {
  const error = {
    status_code: 503,
    original_exception: {
      response: {
        status: '401',
        data: { error: { code: 'AUTH_EXPIRED', message: 'token expired' } },
      },
    },
  }

  assert.equal(isQwenAiAccountFault(error), true)
  assert.equal(qwenAiAccountRetryScope(error), 'next-account')
})

test('nested 403 and capacity 429 remain account-bound through cause/data wrappers', () => {
  const risk = {
    status: 503,
    cause: { data: { error: { status_code: '403', code: 'RISK_CONTROL' } } },
  }
  const capacity = {
    status: 503,
    originalException: {
      response: { data: { error: { status: 429, error_code: 'qwen_ai_capacity_limit' } } },
    },
  }

  assert.equal(isQwenAiAccountFault(risk), true)
  assert.equal(qwenAiAccountRetryScope(risk), 'next-account')
  assert.equal(isQwenAiAccountFault(capacity), true)
  assert.equal(qwenAiAccountRetryScope(capacity), 'next-account')
})

test('nested transport 5xx stays account-neutral even with stale wrapper flags', () => {
  const cases = [
    {
      status: 503,
      accountFault: true,
      retryScope: 'next-account',
      original_exception: { status_code: '504', code: 'UPSTREAM_TIMEOUT' },
    },
    {
      status: 429,
      accountFault: true,
      original_exception: { response: { status: 502, code: 'BAD_GATEWAY' } },
    },
  ]

  for (const error of cases) {
    assert.equal(isQwenAiAccountFault(error), false)
    assert.equal(qwenAiAccountRetryScope(error), undefined)
  }
})

test('stale conversation errors remain neutral and cannot inherit retry scope', () => {
  const error = {
    status: 503,
    retryScope: 'next-account',
    original_exception: {
      response: {
        status: '404',
        data: { error: { code: 'CHAT_NOT_FOUND', message: 'chat is gone' } },
      },
    },
  }

  assert.equal(isQwenAiAccountNeutralFailure(error), true)
  assert.equal(isQwenAiAccountFault(error), false)
  assert.equal(qwenAiAccountRetryScope(error), undefined)
})

test('explicit account-neutral false wins over nested account-bound residue', () => {
  const error = {
    status: 503,
    accountFault: false,
    original_exception: { response: { status: 401, code: 'AUTH_EXPIRED' } },
  }

  assert.equal(isQwenAiAccountFault(error), false)
  assert.equal(qwenAiAccountRetryScope(error), undefined)
})

test('cyclic error graphs are bounded and remain classifiable', () => {
  const error = { status: 503 }
  error.cause = error
  error.original_exception = { status_code: '403', code: 'RISK_CONTROL' }

  assert.equal(isQwenAiAccountFault(error), true)
  assert.equal(qwenAiAccountRetryScope(error), 'next-account')
})
