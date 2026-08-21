import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'

test('management API exposes built-in providers for docker admin credential forms', () => {
  const source = fs.readFileSync('src/main/proxy/routes/management/providers.ts', 'utf8')

  assert.match(source, /router\.get\('\/builtin'/)
  assert.match(source, /BUILTIN_PROVIDERS/)
  assert.match(source, /credentialFields/)
})

test('management API preserves built-in provider identity and credential fields when adding one from docker admin', () => {
  const routeSource = fs.readFileSync('src/main/proxy/routes/management/providers.ts', 'utf8')
  const providerManagerSource = fs.readFileSync('src/main/store/providers.ts', 'utf8')
  const storeSource = fs.readFileSync('src/main/store/store.ts', 'utf8')

  assert.match(routeSource, /id:\s*request\.id/)
  assert.match(routeSource, /credentialFields:\s*request\.credentialFields/)
  assert.match(providerManagerSource, /id\?:\s*string/)
  assert.match(providerManagerSource, /credentialFields\?:/)
  assert.match(storeSource, /this\.store!\.set\('providers', \[\.\.\.providers, provider\]\)/)
  assert.doesNotMatch(storeSource, /providers\.push\(provider\)/)
})

test('store startup migrates orphaned docker-created Qwen AI accounts back to the builtin qwen-ai provider', () => {
  const storeSource = fs.readFileSync('src/main/store/store.ts', 'utf8')

  assert.match(storeSource, /migrateQwenAiProviderAliases/)
  assert.match(storeSource, /account\.providerId === provider\.id/)
  assert.match(storeSource, /providerId:\s*'qwen-ai'/)
  assert.match(storeSource, /this\.store\?\.set\('accounts', migratedAccounts\)/)
})
