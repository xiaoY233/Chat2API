import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import net from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const headlessRoot = join(dirname(fileURLToPath(import.meta.url)), '..')

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = typeof address === 'object' && address ? address.port : 0
      server.close(error => error ? reject(error) : resolve(port))
    })
  })
}

async function waitForHealth(url: string, childOutput: () => string): Promise<void> {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    try {
      const response = await fetch(url)
      if (response.ok) return
    } catch {
      // Server is still starting.
    }
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  throw new Error(`Headless server did not become healthy:\n${childOutput()}`)
}

test('built server starts without Electron and accepts management CLI requests', async () => {
  const root = mkdtempSync(join(tmpdir(), 'chat2api-headless-smoke-'))
  const home = join(root, 'home')
  const port = await freePort()
  const environment = {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    CHAT2API_DATA_DIR: join(home, '.chat2api'),
    CHAT2API_RESOURCE_DIR: join(headlessRoot, 'dist', 'resources'),
    CHAT2API_HOST: '127.0.0.1',
    CHAT2API_PORT: String(port),
    CHAT2API_SHUTDOWN_TIMEOUT: '5000',
  }

  let output = ''
  const child = spawn(process.execPath, [join(headlessRoot, 'dist', 'server.js')], {
    env: environment,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  child.stdout.on('data', chunk => { output += chunk.toString() })
  child.stderr.on('data', chunk => { output += chunk.toString() })

  try {
    await waitForHealth(`http://127.0.0.1:${port}/health`, () => output)

    const managementSecret = readFileSync(join(home, '.chat2api', 'management-secret'), 'utf8').trim()
    const managementHeaders = {
      Authorization: `Bearer ${managementSecret}`,
      'Content-Type': 'application/json',
    }
    const enableWithoutKeys = await fetch(`http://127.0.0.1:${port}/v0/management/config/enableApiKey`, {
      method: 'PUT',
      headers: managementHeaders,
      body: JSON.stringify({ value: true }),
    })
    assert.equal(enableWithoutKeys.ok, true)
    assert.equal((await fetch(`http://127.0.0.1:${port}/v1/models`)).status, 503)
    await fetch(`http://127.0.0.1:${port}/v0/management/config/enableApiKey`, {
      method: 'PUT',
      headers: managementHeaders,
      body: JSON.stringify({ value: false }),
    })

    const cli = spawn(process.execPath, [join(headlessRoot, 'dist', 'chat2api-ctl.js'), 'status'], {
      env: environment,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let cliOutput = ''
    cli.stdout.on('data', chunk => { cliOutput += chunk.toString() })
    cli.stderr.on('data', chunk => { cliOutput += chunk.toString() })
    const cliExitCode = await new Promise<number | null>(resolve => cli.once('exit', resolve))
    assert.equal(cliExitCode, 0, cliOutput)
    assert.match(cliOutput, /"status": "running"/)

    const testToken = 'headless-smoke-secret-token'
    const addAccount = spawn(
      process.execPath,
      [join(headlessRoot, 'dist', 'chat2api-ctl.js'), 'account', 'add', '--stdin', '--no-validate'],
      { env: environment, stdio: ['pipe', 'pipe', 'pipe'] },
    )
    let addAccountOutput = ''
    addAccount.stdout.on('data', chunk => { addAccountOutput += chunk.toString() })
    addAccount.stderr.on('data', chunk => { addAccountOutput += chunk.toString() })
    addAccount.stdin.end(JSON.stringify({
      providerId: 'deepseek',
      name: 'smoke-account',
      credentials: { token: testToken },
    }))
    const addAccountExitCode = await new Promise<number | null>(resolve => addAccount.once('exit', resolve))
    assert.equal(addAccountExitCode, 0, addAccountOutput)
    assert.match(addAccountOutput, /smoke-account/)

    const createKey = spawn(
      process.execPath,
      [join(headlessRoot, 'dist', 'chat2api-ctl.js'), 'api-key', 'create', '--name', 'smoke-key'],
      { env: environment, stdio: ['ignore', 'pipe', 'pipe'] },
    )
    let createKeyOutput = ''
    createKey.stdout.on('data', chunk => { createKeyOutput += chunk.toString() })
    createKey.stderr.on('data', chunk => { createKeyOutput += chunk.toString() })
    const createKeyExitCode = await new Promise<number | null>(resolve => createKey.once('exit', resolve))
    assert.equal(createKeyExitCode, 0, createKeyOutput)
    assert.match(createKeyOutput, /sk-mgmt-/)
    assert.equal((await fetch(`http://127.0.0.1:${port}/v1/models`)).status, 401)

    const persistedStore = readFileSync(join(home, '.chat2api', 'data.json'))
    assert.equal(persistedStore.includes(Buffer.from(testToken)), false)
    assert.doesNotMatch(output, new RegExp(testToken))

    const lifecycleResponse = await fetch(`http://127.0.0.1:${port}/v0/management/proxy/stop`, {
      method: 'POST',
      headers: managementHeaders,
    })
    assert.equal(lifecycleResponse.status, 409)
    assert.equal((await fetch(`http://127.0.0.1:${port}/health`)).ok, true)
  } finally {
    child.kill('SIGTERM')
    await Promise.race([
      new Promise(resolve => child.once('exit', resolve)),
      new Promise(resolve => setTimeout(resolve, 7_000)),
    ])
    if (child.exitCode === null) child.kill('SIGKILL')
    rmSync(root, { recursive: true, force: true })
  }
})

test('invalid master key fails closed without moving persisted data', async () => {
  const root = mkdtempSync(join(tmpdir(), 'chat2api-headless-fail-closed-'))
  const home = join(root, 'home')
  const dataDirectory = join(home, '.chat2api')
  mkdirSync(dataDirectory, { recursive: true })
  const persisted = Buffer.from('existing-encrypted-store')
  writeFileSync(join(dataDirectory, 'data.json'), persisted)
  writeFileSync(join(dataDirectory, 'master.key'), Buffer.alloc(32, 0x5a))

  const port = await freePort()
  const child = spawn(process.execPath, [join(headlessRoot, 'dist', 'server.js')], {
    env: {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      CHAT2API_DATA_DIR: dataDirectory,
      CHAT2API_RESOURCE_DIR: join(headlessRoot, 'dist', 'resources'),
      CHAT2API_HOST: '127.0.0.1',
      CHAT2API_PORT: String(port),
      CHAT2API_SHUTDOWN_TIMEOUT: '2000',
    },
    stdio: 'ignore',
  })

  try {
    const exitCode = await Promise.race([
      new Promise<number | null>(resolve => child.once('exit', resolve)),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('Fail-closed process did not exit')), 5_000)),
    ])
    assert.notEqual(exitCode, 0)
    assert.deepEqual(readFileSync(join(dataDirectory, 'data.json')), persisted)
    assert.equal(readdirSync(dataDirectory).some(name => name.startsWith('data.corrupted.')), false)
  } finally {
    if (child.exitCode === null) child.kill('SIGKILL')
    rmSync(root, { recursive: true, force: true })
  }
})
