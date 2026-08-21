import assert from 'node:assert/strict'
import test from 'node:test'

test('server env produces config overrides', async () => {
  process.env.CHAT2API_HOST = '0.0.0.0'
  process.env.CHAT2API_PORT = '18080'
  process.env.CHAT2API_ENABLE_MANAGEMENT_API = 'true'
  process.env.CHAT2API_MANAGEMENT_SECRET = 'mgmt_test_secret'
  process.env.CHAT2API_LOAD_BALANCE_STRATEGY = 'fill-first'
  process.env.CHAT2API_LOG_LEVEL = 'debug'

  const { createServerConfigOverrides } = await import('../../out-server/server/bootstrapConfig.js')
  const overrides = createServerConfigOverrides()

  assert.equal(overrides.proxyHost, '0.0.0.0')
  assert.equal(overrides.proxyPort, 18080)
  assert.equal(overrides.loadBalanceStrategy, 'fill-first')
  assert.equal(overrides.logLevel, 'debug')
  assert.deepEqual(overrides.managementApi, {
    enableManagementApi: true,
    managementApiSecret: 'mgmt_test_secret',
  })
})
