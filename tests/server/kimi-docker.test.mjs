import assert from 'node:assert/strict'
import { once } from 'node:events'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import test from 'node:test'

const repoRoot = process.cwd()

function readSource(relativePath) {
  return fs.readFileSync(path.join(repoRoot, relativePath), 'utf8')
}

async function reservePort() {
  const server = net.createServer()
  server.unref()
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  assert.ok(address && typeof address === 'object')
  const port = address.port
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
  return port
}

async function waitForServer(url, child, output) {
  const deadline = Date.now() + 15_000
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`Docker server exited before becoming ready (${child.exitCode}):\n${output()}`)
    }

    try {
      const response = await fetch(url)
      if (response.ok) return
    } catch {
      // The listener may not be bound yet.
    }

    await new Promise((resolve) => setTimeout(resolve, 100))
  }

  throw new Error(`Docker server did not become ready in time:\n${output()}`)
}

test('Docker browser-assisted import is wired for Kimi credentials', () => {
  const routeSource = readSource('src/main/proxy/routes/management/statistics.ts')
  const webAdminSource = readSource('src/renderer/src/web-admin-api.ts')
  const addAccountSource = readSource('src/renderer/src/components/providers/AddAccountDialog.tsx')
  const addProviderSource = readSource('src/renderer/src/components/providers/AddProviderDialog.tsx')
  const chatRouteSource = readSource('src/main/proxy/routes/chat.ts')
  const dockerDocs = readSource('docs/docker.md')

  assert.match(routeSource, /type BrowserImportProviderId[^\n]*'kimi'/)
  assert.match(routeSource, /input\.providerId[^\n]*'kimi'/)
  assert.match(routeSource, /providerId === 'kimi'[\s\S]{0,500}token:/)

  assert.match(webAdminSource, /function buildKimiImportScript/)
  assert.match(webAdminSource, /providerId = 'kimi'/)
  assert.match(webAdminSource, /kimi-auth|api\/auth\/token\/refresh/)
  assert.match(webAdminSource, /credentials:\s*\{\s*token/)
  assert.match(webAdminSource, /session\.providerId === 'kimi'/)
  for (const marker of [
    "readStorage('access_token')",
    "readStorage('refresh_token')",
    "readStorage('volcano-token-info')",
  ]) {
    assert.match(webAdminSource, new RegExp(marker.replace(/[()'.-]/g, '\\$&')))
  }
  assert.match(webAdminSource, /webId/)
  assert.match(webAdminSource, /ssid/)
  assert.match(webAdminSource, /trafficId/)
  assert.match(webAdminSource, /try\s*\{\s*return decodeURIComponent\([^)]+\)/)
  assert.match(webAdminSource, /catch \(error\)\s*\{\s*return value/)

  assert.match(addAccountSource, /supportsBrowserImport[^\n]*'kimi'/)
  assert.match(addAccountSource, /kimi:\s*'https:\/\/www\.kimi\.com'/)
  assert.match(addAccountSource, /providerId === 'kimi'[\s\S]{0,600}refreshToken/)
  assert.match(addAccountSource, /providerId === 'kimi'[\s\S]{0,800}deviceId/)
  assert.match(addAccountSource, /providerId === 'kimi'[\s\S]{0,800}sessionId/)
  assert.match(addAccountSource, /providerId === 'kimi'[\s\S]{0,800}trafficId/)
  assert.match(addProviderSource, /supportsBrowserImport[^\n]*'kimi'/)
  assert.match(addProviderSource, /kimi:\s*'https:\/\/www\.kimi\.com'/)
  assert.match(addProviderSource, /providerId === 'kimi'[\s\S]{0,600}refreshToken/)
  assert.match(addProviderSource, /providerId === 'kimi'[\s\S]{0,800}deviceId/)
  assert.match(addProviderSource, /providerId === 'kimi'[\s\S]{0,800}sessionId/)
  assert.match(addProviderSource, /providerId === 'kimi'[\s\S]{0,800}trafficId/)
  assert.match(chatRouteSource, /result\.status !== 429 && result\.status !== 499/)
  assert.match(dockerDocs, /Browser-Assisted Kimi Import/i)
})

test('built Node server exposes Kimi and persists a fake account without upstream access', { timeout: 30_000 }, async (t) => {
  const serverEntry = path.join(repoRoot, 'out-server/server/index.js')
  if (!fs.existsSync(serverEntry)) {
    t.skip('run npm run build:server before this test')
    return
  }

  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'chat2api-kimi-docker-'))
  const port = await reservePort()
  const secret = 'mgmt_kimi_docker_test'
  let output = ''
  const child = spawn(process.execPath, [serverEntry], {
    cwd: repoRoot,
    env: {
      ...process.env,
      NODE_ENV: 'test',
      CHAT2API_HOST: '127.0.0.1',
      CHAT2API_PORT: String(port),
      CHAT2API_DATA_DIR: dataDir,
      CHAT2API_ENABLE_MANAGEMENT_API: 'true',
      CHAT2API_MANAGEMENT_SECRET: secret,
      CHAT2API_LOG_LEVEL: 'error',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })

  const appendOutput = (chunk) => {
    output = `${output}${chunk.toString()}`.slice(-12_000)
  }
  child.stdout.on('data', appendOutput)
  child.stderr.on('data', appendOutput)

  t.after(async () => {
    if (child.exitCode === null) {
      child.kill('SIGTERM')
      let shutdownTimer
      await Promise.race([
        once(child, 'exit'),
        new Promise((resolve) => {
          shutdownTimer = setTimeout(resolve, 5_000)
        }),
      ])
      clearTimeout(shutdownTimer)
      if (child.exitCode === null) child.kill('SIGKILL')
    }
    fs.rmSync(dataDir, { recursive: true, force: true })
  })

  const baseUrl = `http://127.0.0.1:${port}`
  const authHeaders = {
    Authorization: `Bearer ${secret}`,
    'Content-Type': 'application/json',
  }
  await waitForServer(`${baseUrl}/health`, child, () => output)

  const healthResponse = await fetch(`${baseUrl}/health`)
  assert.equal(healthResponse.status, 200)
  assert.equal((await healthResponse.json()).status, 'running')

  const builtinResponse = await fetch(`${baseUrl}/v0/management/providers/builtin`, {
    headers: authHeaders,
  })
  assert.equal(builtinResponse.status, 200)
  const builtinBody = await builtinResponse.json()
  const kimi = builtinBody.data.find((provider) => provider.id === 'kimi')
  assert.ok(kimi, 'Kimi must be present in the Docker built-in provider list')
  assert.equal(kimi.apiEndpoint, 'https://www.kimi.com')
  assert.deepEqual(kimi.supportedModels, ['Kimi-K2.6', 'Kimi-K3'])
  assert.equal(kimi.modelMappings['Kimi-K2.6'], 'k2d6')
  assert.equal(kimi.modelMappings['Kimi-K3'], 'k3')
  assert.ok(kimi.credentialFields.some((field) => field.name === 'token' && field.required))

  const fakeToken = 'offline-kimi-token-for-docker-runtime-test'
  const importId = 'kimi-docker-import-00000001'
  const importResponse = await fetch(`${baseUrl}/v0/management/browser-import/complete`, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain' },
    body: JSON.stringify({
      importId,
      providerId: 'kimi',
      credentials: { token: fakeToken, ignored: 'must-not-be-persisted' },
    }),
  })
  assert.equal(importResponse.status, 200)

  const importedResultResponse = await fetch(`${baseUrl}/v0/management/browser-import/${importId}`, {
    headers: authHeaders,
  })
  assert.equal(importedResultResponse.status, 200)
  const importedResultBody = await importedResultResponse.json()
  assert.equal(importedResultBody.data.providerId, 'kimi')
  assert.deepEqual(importedResultBody.data.credentials, { token: fakeToken })

  const tokenInfoImportId = 'kimi-docker-import-00000002'
  const tokenInfoImportResponse = await fetch(`${baseUrl}/v0/management/browser-import/complete`, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain' },
    body: JSON.stringify({
      importId: tokenInfoImportId,
      providerId: 'kimi',
      credentials: {
        token: 'legacy-kimi-refresh-token',
        access_token: 'kimi-access-token',
        refresh_token: 'kimi-refresh-token',
        web_id: 'kimi-web-id',
        ssid: 'kimi-ssid',
        traffic_id: 'kimi-traffic-id',
      },
    }),
  })
  assert.equal(tokenInfoImportResponse.status, 200)

  const tokenInfoResultResponse = await fetch(`${baseUrl}/v0/management/browser-import/${tokenInfoImportId}`, {
    headers: authHeaders,
  })
  assert.equal(tokenInfoResultResponse.status, 200)
  assert.deepEqual((await tokenInfoResultResponse.json()).data.credentials, {
    token: 'kimi-access-token',
    refreshToken: 'kimi-refresh-token',
    deviceId: 'kimi-web-id',
    sessionId: 'kimi-ssid',
    trafficId: 'kimi-traffic-id',
  })

  const cookieImportId = 'kimi-docker-import-00000003'
  const cookieImportResponse = await fetch(`${baseUrl}/v0/management/browser-import/complete`, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain' },
    body: JSON.stringify({
      importId: cookieImportId,
      providerId: 'kimi',
      credentials: { 'kimi-auth': 'kimi-cookie-token' },
    }),
  })
  assert.equal(cookieImportResponse.status, 200)

  const cookieResultResponse = await fetch(`${baseUrl}/v0/management/browser-import/${cookieImportId}`, {
    headers: authHeaders,
  })
  assert.equal(cookieResultResponse.status, 200)
  assert.deepEqual((await cookieResultResponse.json()).data.credentials, {
    token: 'kimi-cookie-token',
  })

  const createResponse = await fetch(`${baseUrl}/v0/management/accounts`, {
    method: 'POST',
    headers: authHeaders,
    body: JSON.stringify({
      providerId: 'kimi',
      name: 'offline-kimi-account',
      credentials: { token: fakeToken },
    }),
  })
  assert.equal(createResponse.status, 201)
  const createdBody = await createResponse.json()
  assert.equal(createdBody.data.providerId, 'kimi')
  assert.equal(createdBody.data.credentials.token, '***')

  const listResponse = await fetch(`${baseUrl}/v0/management/providers/kimi/accounts?includeCredentials=true`, {
    headers: authHeaders,
  })
  assert.equal(listResponse.status, 200)
  const listBody = await listResponse.json()
  assert.equal(listBody.data.length, 1)
  assert.equal(listBody.data[0].credentials.token, fakeToken)

  const modelsResponse = await fetch(`${baseUrl}/v1/models`)
  assert.equal(modelsResponse.status, 200)
  const modelsBody = await modelsResponse.json()
  const modelIds = modelsBody.data.map((model) => model.id)
  assert.deepEqual(modelIds.filter((model) => model.startsWith('Kimi-')), ['Kimi-K2.6', 'Kimi-K3'])
  assert.equal(modelIds.includes('Kimi-K2.5'), false)

  const deleteResponse = await fetch(`${baseUrl}/v0/management/accounts/${createdBody.data.id}`, {
    method: 'DELETE',
    headers: authHeaders,
  })
  assert.equal(deleteResponse.status, 200)
  assert.equal((await deleteResponse.json()).data.deleted, true)

  const oversizedImportResponse = await fetch(`${baseUrl}/v0/management/browser-import/complete`, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain' },
    body: 'x'.repeat(128 * 1024 + 1),
  })
  assert.equal(oversizedImportResponse.status, 413)

  // The three successful imports above consume three slots. Rotating a
  // client-controlled X-Forwarded-For header must not bypass the per-peer
  // limiter, so 29 more succeed and the 33rd submission is rejected.
  for (let index = 0; index < 29; index += 1) {
    const response = await fetch(`${baseUrl}/v0/management/browser-import/complete`, {
      method: 'POST',
      headers: {
        'Content-Type': 'text/plain',
        'X-Forwarded-For': `198.51.100.${index + 1}`,
      },
      body: JSON.stringify({
        importId: `kimi-rate-limit-${String(index).padStart(16, '0')}`,
        providerId: 'kimi',
        credentials: { token: `rate-token-${index}` },
      }),
    })
    assert.equal(response.status, 200)
  }

  const rateLimitedResponse = await fetch(`${baseUrl}/v0/management/browser-import/complete`, {
    method: 'POST',
    headers: {
      'Content-Type': 'text/plain',
      'X-Forwarded-For': '203.0.113.250',
    },
    body: JSON.stringify({
      importId: 'kimi-rate-limit-final-00000000',
      providerId: 'kimi',
      credentials: { token: 'must-be-rate-limited' },
    }),
  })
  assert.equal(rateLimitedResponse.status, 429)
})
