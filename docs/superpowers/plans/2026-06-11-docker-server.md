# Chat2API Docker Server Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a Docker/server runtime for Chat2API that runs the existing OpenAI-compatible proxy and management API without Electron.

**Architecture:** Keep the desktop app intact and add a separate Node server entrypoint. Introduce small runtime and storage boundaries so server-only behavior lives in isolated files, which keeps future upstream pulls easier to merge.

**Tech Stack:** Node.js, TypeScript, Koa, existing Chat2API proxy modules, JSON storage, Vite/Rollup server build, Docker, Docker Compose, Node test runner.

---

## Upstream Sync Policy

This implementation must preserve a small Docker-specific patch surface.

Docker-specific code should live in:

```text
src/server/
src/main/runtime/
src/main/store/storage/
docs/docker.md
Dockerfile
docker-compose.yml
.dockerignore
tests/server/
```

When a file from upstream changes, prefer upstream behavior first. Reapply only these minimal compatibility edits:

- Replace direct Electron calls in shared server paths with `runtime`.
- Keep provider behavior unchanged unless the provider imports Electron directly.
- Keep Docker boot configuration in `src/server/bootstrapConfig.ts`.
- Keep server build config in root-level build files.

After pulling upstream, run:

```bash
npm install
npm run test:server-compat
npm run build:server
docker build -t chat2api:server .
```

---

## File Structure

Create:

```text
src/server/index.ts
src/server/bootstrapConfig.ts
src/main/runtime/types.ts
src/main/runtime/index.ts
src/main/runtime/electronRuntime.ts
src/main/runtime/nodeRuntime.ts
src/main/store/storage/types.ts
src/main/store/storage/electronJsonStore.ts
src/main/store/storage/nodeJsonStore.ts
tests/server/server-imports.test.mjs
tests/server/bootstrap-config.test.mjs
tests/server/node-json-store.test.mjs
Dockerfile
.dockerignore
docker-compose.yml
docs/docker.md
vite.server.config.ts
```

Modify:

```text
package.json
src/main/store/store.ts
src/main/lib/challenge.ts
src/main/oauth/adapters/base.ts
src/main/oauth/adapters/deepseek.ts
src/main/oauth/adapters/glm.ts
src/main/oauth/adapters/kimi.ts
src/main/oauth/adapters/minimax.ts
src/main/oauth/adapters/qwen.ts
src/main/proxy/adapters/perplexity.ts
```

Keep desktop-only files unchanged unless TypeScript imports require type-only adjustments:

```text
src/main/index.ts
src/preload/index.ts
src/main/ipc/handlers.ts
src/main/window/
src/main/tray/
src/main/updater/
src/renderer/
```

---

### Task 1: Server Import Guard

**Files:**
- Create: `tests/server/server-imports.test.mjs`

- [ ] **Step 1: Write failing import guard test**

Create `tests/server/server-imports.test.mjs`:

```js
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'

const repoRoot = process.cwd()

const serverAllowedElectronFiles = new Set([
  path.normalize('src/main/runtime/electronRuntime.ts'),
])

function walk(dir) {
  const entries = fs.readdirSync(dir, { withFileTypes: true })
  const files = []

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      files.push(...walk(fullPath))
    } else if (entry.isFile() && fullPath.endsWith('.ts')) {
      files.push(fullPath)
    }
  }

  return files
}

test('server runtime files do not import electron directly', () => {
  const checkedRoots = [
    path.join(repoRoot, 'src/server'),
    path.join(repoRoot, 'src/main/runtime'),
    path.join(repoRoot, 'src/main/store/storage'),
  ]

  const violations = []

  for (const root of checkedRoots) {
    if (!fs.existsSync(root)) continue

    for (const file of walk(root)) {
      const relative = path.normalize(path.relative(repoRoot, file))
      if (serverAllowedElectronFiles.has(relative)) continue

      const source = fs.readFileSync(file, 'utf8')
      if (source.includes("from 'electron'") || source.includes('from "electron"')) {
        violations.push(relative)
      }
    }
  }

  assert.deepEqual(violations, [])
})
```

- [ ] **Step 2: Run test to verify it fails before files exist**

Run:

```bash
node --test tests/server/server-imports.test.mjs
```

Expected: PASS initially because the new server paths do not exist yet. This test becomes protective after later tasks create files.

- [ ] **Step 3: Commit guard test**

```bash
git add tests/server/server-imports.test.mjs
git commit -m "test: guard server runtime against electron imports"
```

---

### Task 2: Runtime Boundary

**Files:**
- Create: `src/main/runtime/types.ts`
- Create: `src/main/runtime/nodeRuntime.ts`
- Create: `src/main/runtime/electronRuntime.ts`
- Create: `src/main/runtime/index.ts`

- [ ] **Step 1: Create runtime types**

Create `src/main/runtime/types.ts`:

```ts
export interface RuntimeAdapter {
  kind: 'electron' | 'node'
  getDataDir(): string
  isEncryptionAvailable(): boolean
  encryptString(value: string): string
  decryptString(value: string): string
  getResourcePath(fileName: string): string
  openExternal(url: string): Promise<void>
  notify(channel: string, payload: unknown): void
}
```

- [ ] **Step 2: Create Node runtime implementation**

Create `src/main/runtime/nodeRuntime.ts`:

```ts
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'crypto'
import { existsSync } from 'fs'
import { homedir } from 'os'
import { join, resolve } from 'path'
import type { RuntimeAdapter } from './types'

const ENCRYPTION_PREFIX = 'c2a:v1:'

function getKey(): Buffer | null {
  const secret = process.env.CHAT2API_STORAGE_ENCRYPTION_KEY
  if (!secret) return null
  return createHash('sha256').update(secret).digest()
}

function getDefaultDataDir(): string {
  if (process.env.CHAT2API_DATA_DIR) {
    return resolve(process.env.CHAT2API_DATA_DIR)
  }

  if (process.env.NODE_ENV === 'production') {
    return '/data'
  }

  return join(homedir(), '.chat2api')
}

export const nodeRuntime: RuntimeAdapter = {
  kind: 'node',

  getDataDir(): string {
    return getDefaultDataDir()
  },

  isEncryptionAvailable(): boolean {
    return getKey() !== null
  },

  encryptString(value: string): string {
    const key = getKey()
    if (!key) return value

    const iv = randomBytes(12)
    const cipher = createCipheriv('aes-256-gcm', key, iv)
    const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()])
    const tag = cipher.getAuthTag()

    return `${ENCRYPTION_PREFIX}${Buffer.concat([iv, tag, encrypted]).toString('base64')}`
  },

  decryptString(value: string): string {
    const key = getKey()
    if (!key || !value.startsWith(ENCRYPTION_PREFIX)) return value

    const payload = Buffer.from(value.slice(ENCRYPTION_PREFIX.length), 'base64')
    const iv = payload.subarray(0, 12)
    const tag = payload.subarray(12, 28)
    const encrypted = payload.subarray(28)
    const decipher = createDecipheriv('aes-256-gcm', key, iv)
    decipher.setAuthTag(tag)

    return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8')
  },

  getResourcePath(fileName: string): string {
    const candidates = [
      resolve(process.cwd(), fileName),
      resolve(process.cwd(), 'resources', fileName),
      resolve(__dirname, '..', '..', '..', fileName),
    ]

    const found = candidates.find(candidate => existsSync(candidate))
    return found || candidates[0]
  },

  async openExternal(url: string): Promise<void> {
    console.log(`[Runtime] Open this URL manually: ${url}`)
  },

  notify(): void {
  },
}
```

- [ ] **Step 3: Create Electron runtime implementation**

Create `src/main/runtime/electronRuntime.ts`:

```ts
import { app, BrowserWindow, safeStorage, shell } from 'electron'
import { homedir } from 'os'
import { join } from 'path'
import type { RuntimeAdapter } from './types'

export const electronRuntime: RuntimeAdapter = {
  kind: 'electron',

  getDataDir(): string {
    return join(homedir(), '.chat2api')
  },

  isEncryptionAvailable(): boolean {
    try {
      return safeStorage.isEncryptionAvailable()
    } catch {
      return false
    }
  },

  encryptString(value: string): string {
    return Buffer.from(safeStorage.encryptString(value)).toString('base64')
  },

  decryptString(value: string): string {
    return safeStorage.decryptString(Buffer.from(value, 'base64'))
  },

  getResourcePath(fileName: string): string {
    if (app.isPackaged) {
      return join(process.resourcesPath, fileName)
    }

    return join(app.getAppPath(), fileName)
  },

  async openExternal(url: string): Promise<void> {
    await shell.openExternal(url)
  },

  notify(channel: string, payload: unknown): void {
    BrowserWindow.getAllWindows().forEach((win) => {
      win.webContents.send(channel, payload)
    })
  },
}
```

- [ ] **Step 4: Create runtime selector**

Create `src/main/runtime/index.ts`:

```ts
import type { RuntimeAdapter } from './types'
import { nodeRuntime } from './nodeRuntime'

let runtime: RuntimeAdapter = nodeRuntime

export function setRuntime(nextRuntime: RuntimeAdapter): void {
  runtime = nextRuntime
}

export function getRuntime(): RuntimeAdapter {
  return runtime
}

export type { RuntimeAdapter }
```

- [ ] **Step 5: Run import guard**

Run:

```bash
node --test tests/server/server-imports.test.mjs
```

Expected: PASS. Only `src/main/runtime/electronRuntime.ts` may import Electron.

- [ ] **Step 6: Commit runtime boundary**

```bash
git add src/main/runtime tests/server/server-imports.test.mjs
git commit -m "feat: add runtime boundary for server mode"
```

---

### Task 3: Node JSON Store Adapter

**Files:**
- Create: `src/main/store/storage/types.ts`
- Create: `src/main/store/storage/nodeJsonStore.ts`
- Create: `src/main/store/storage/electronJsonStore.ts`
- Create: `tests/server/node-json-store.test.mjs`
- Modify: `src/main/store/store.ts`

- [ ] **Step 1: Write Node JSON store test**

Create `tests/server/node-json-store.test.mjs`:

```js
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

test('node json store persists values under configured directory', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'chat2api-store-'))
  process.env.CHAT2API_DATA_DIR = tempDir

  const { NodeJsonStore } = await import('../../out-server/main/store/storage/nodeJsonStore.js')

  const store = new NodeJsonStore({
    name: 'data',
    cwd: tempDir,
    defaults: {
      providers: [],
      accounts: [],
      config: { proxyPort: 8080 },
    },
  })

  store.set('config', { proxyPort: 18080 })

  const secondStore = new NodeJsonStore({
    name: 'data',
    cwd: tempDir,
    defaults: {},
  })

  assert.equal(secondStore.get('config').proxyPort, 18080)
  assert.ok(fs.existsSync(path.join(tempDir, 'data.json')))
})
```

- [ ] **Step 2: Create storage interface**

Create `src/main/store/storage/types.ts`:

```ts
export interface JsonStoreOptions<T extends Record<string, unknown>> {
  name: string
  cwd: string
  defaults: T
  encryptionKey?: string
}

export interface JsonStore<T extends Record<string, unknown>> {
  get<K extends keyof T>(key: K): T[K]
  get(key: string): unknown
  set<K extends keyof T>(key: K, value: T[K]): void
  set(key: string, value: unknown): void
  delete(key: string): void
  clear(): void
}
```

- [ ] **Step 3: Create Node JSON store**

Create `src/main/store/storage/nodeJsonStore.ts`:

```ts
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs'
import { join } from 'path'
import type { JsonStore, JsonStoreOptions } from './types'

export class NodeJsonStore<T extends Record<string, unknown>> implements JsonStore<T> {
  private readonly filePath: string
  private data: Record<string, unknown>

  constructor(options: JsonStoreOptions<T>) {
    mkdirSync(options.cwd, { recursive: true })
    this.filePath = join(options.cwd, `${options.name}.json`)
    this.data = { ...options.defaults }

    if (existsSync(this.filePath)) {
      try {
        const parsed = JSON.parse(readFileSync(this.filePath, 'utf8'))
        this.data = { ...this.data, ...parsed }
      } catch {
        renameSync(this.filePath, join(options.cwd, `${options.name}.corrupted.${Date.now()}.json`))
        this.persist()
      }
    } else {
      this.persist()
    }
  }

  get(key: string): unknown {
    return this.data[key]
  }

  set(key: string, value: unknown): void {
    this.data = {
      ...this.data,
      [key]: value,
    }
    this.persist()
  }

  delete(key: string): void {
    const next = { ...this.data }
    delete next[key]
    this.data = next
    this.persist()
  }

  clear(): void {
    this.data = {}
    this.persist()
  }

  private persist(): void {
    writeFileSync(this.filePath, `${JSON.stringify(this.data, null, 2)}\n`, 'utf8')
  }
}
```

- [ ] **Step 4: Create Electron JSON store wrapper**

Create `src/main/store/storage/electronJsonStore.ts`:

```ts
import type { JsonStoreOptions } from './types'

export async function createElectronJsonStore<T extends Record<string, unknown>>(
  options: JsonStoreOptions<T>
): Promise<any> {
  const module = await import('electron-store')
  const Store = module.default
  return new Store(options)
}
```

- [ ] **Step 5: Modify store manager to use runtime and storage adapter**

In `src/main/store/store.ts`, replace the Electron import:

```ts
import type { BrowserWindow } from 'electron'
import { getRuntime } from '../runtime'
import { NodeJsonStore } from './storage/nodeJsonStore'
import { createElectronJsonStore } from './storage/electronJsonStore'
```

Replace dynamic `electron-store` initialization with:

```ts
const runtime = getRuntime()

if (runtime.kind === 'electron') {
  this.store = await createElectronJsonStore({
    name: 'data',
    cwd: storagePath,
    defaults: this.getDefaultData() as unknown as Record<string, unknown>,
    encryptionKey: this.getEncryptionKey(),
  })
} else {
  this.store = new NodeJsonStore({
    name: 'data',
    cwd: storagePath,
    defaults: this.getDefaultData() as unknown as Record<string, unknown>,
  })
}
```

Replace `getStoragePath()` body with:

```ts
private getStoragePath(): string {
  return getRuntime().getDataDir()
}
```

Replace `getEncryptionKey()` body with:

```ts
private getEncryptionKey(): string | undefined {
  return getRuntime().isEncryptionAvailable()
    ? 'chat2api-fixed-encryption-key-v1'
    : undefined
}
```

Replace `encryptData()` body with:

```ts
encryptData(data: string): string {
  try {
    const runtime = getRuntime()
    if (runtime.isEncryptionAvailable()) {
      return runtime.encryptString(data)
    }
  } catch (error) {
    console.error('Failed to encrypt data:', error)
  }
  return data
}
```

Replace `decryptData()` body with:

```ts
decryptData(encryptedData: string): string {
  try {
    const runtime = getRuntime()
    if (runtime.isEncryptionAvailable()) {
      return runtime.decryptString(encryptedData)
    }
  } catch (error) {
    console.error('Failed to decrypt data:', error)
  }
  return encryptedData
}
```

- [ ] **Step 6: Build server once storage adapter exists**

Run:

```bash
npm run build:server
```

Expected before Task 7 script exists: command missing. Continue to Task 7 before treating this as a failure.

- [ ] **Step 7: Commit storage adapter**

```bash
git add src/main/store/store.ts src/main/store/storage tests/server/node-json-store.test.mjs
git commit -m "feat: add node json storage for server mode"
```

---

### Task 4: Server Bootstrap Configuration

**Files:**
- Create: `src/server/bootstrapConfig.ts`
- Create: `tests/server/bootstrap-config.test.mjs`

- [ ] **Step 1: Write bootstrap config test**

Create `tests/server/bootstrap-config.test.mjs`:

```js
import assert from 'node:assert/strict'
import test from 'node:test'

test('server env produces config overrides', async () => {
  process.env.CHAT2API_HOST = '0.0.0.0'
  process.env.CHAT2API_PORT = '18080'
  process.env.CHAT2API_ENABLE_MANAGEMENT_API = 'true'
  process.env.CHAT2API_MANAGEMENT_SECRET = 'mgmt_test_secret'
  process.env.CHAT2API_LOAD_BALANCE_STRATEGY = 'fill-first'

  const { createServerConfigOverrides } = await import('../../out-server/server/bootstrapConfig.js')
  const overrides = createServerConfigOverrides()

  assert.equal(overrides.proxyHost, '0.0.0.0')
  assert.equal(overrides.proxyPort, 18080)
  assert.equal(overrides.loadBalanceStrategy, 'fill-first')
  assert.deepEqual(overrides.managementApi, {
    enableManagementApi: true,
    managementApiSecret: 'mgmt_test_secret',
  })
})
```

- [ ] **Step 2: Create bootstrap config module**

Create `src/server/bootstrapConfig.ts`:

```ts
import type { AppConfig, LoadBalanceStrategy } from '../main/store/types'
import { storeManager } from '../main/store/store'

const VALID_STRATEGIES = new Set<LoadBalanceStrategy>([
  'round-robin',
  'fill-first',
  'failover',
])

function parsePort(value: string | undefined): number | undefined {
  if (!value) return undefined
  const parsed = Number.parseInt(value, 10)
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) {
    throw new Error(`Invalid CHAT2API_PORT: ${value}`)
  }
  return parsed
}

function parseBoolean(value: string | undefined): boolean | undefined {
  if (value === undefined) return undefined
  return ['1', 'true', 'yes', 'on'].includes(value.toLowerCase())
}

export function createServerConfigOverrides(): Partial<AppConfig> {
  const overrides: Partial<AppConfig> = {}
  const port = parsePort(process.env.CHAT2API_PORT)
  const host = process.env.CHAT2API_HOST
  const strategy = process.env.CHAT2API_LOAD_BALANCE_STRATEGY as LoadBalanceStrategy | undefined
  const enableManagementApi = parseBoolean(process.env.CHAT2API_ENABLE_MANAGEMENT_API)
  const managementSecret = process.env.CHAT2API_MANAGEMENT_SECRET
  const enableApiKey = parseBoolean(process.env.CHAT2API_ENABLE_API_KEY)
  const logLevel = process.env.CHAT2API_LOG_LEVEL as AppConfig['logLevel'] | undefined

  if (port !== undefined) overrides.proxyPort = port
  if (host) overrides.proxyHost = host

  if (strategy) {
    if (!VALID_STRATEGIES.has(strategy)) {
      throw new Error(`Invalid CHAT2API_LOAD_BALANCE_STRATEGY: ${strategy}`)
    }
    overrides.loadBalanceStrategy = strategy
  }

  if (logLevel) {
    if (!['debug', 'info', 'warn', 'error'].includes(logLevel)) {
      throw new Error(`Invalid CHAT2API_LOG_LEVEL: ${logLevel}`)
    }
    overrides.logLevel = logLevel
  }

  if (enableApiKey !== undefined) {
    overrides.enableApiKey = enableApiKey
  }

  if (enableManagementApi !== undefined || managementSecret) {
    overrides.managementApi = {
      enableManagementApi: enableManagementApi ?? Boolean(managementSecret),
      managementApiSecret: managementSecret || '',
    }
  }

  return overrides
}

export function applyServerConfigOverrides(): AppConfig {
  const overrides = createServerConfigOverrides()
  if (Object.keys(overrides).length === 0) {
    return storeManager.getConfig()
  }
  return storeManager.updateConfig(overrides)
}
```

- [ ] **Step 3: Commit bootstrap config**

```bash
git add src/server/bootstrapConfig.ts tests/server/bootstrap-config.test.mjs
git commit -m "feat: add server env bootstrap config"
```

---

### Task 5: Server Entrypoint

**Files:**
- Create: `src/server/index.ts`

- [ ] **Step 1: Create server entrypoint**

Create `src/server/index.ts`:

```ts
import { setRuntime } from '../main/runtime'
import { nodeRuntime } from '../main/runtime/nodeRuntime'
import { proxyServer } from '../main/proxy/server'
import { storeManager } from '../main/store/store'
import { applyServerConfigOverrides } from './bootstrapConfig'

setRuntime(nodeRuntime)

async function shutdown(signal: string): Promise<void> {
  console.log(`[Server] Received ${signal}, shutting down`)
  try {
    await proxyServer.stop()
  } finally {
    storeManager.flushPendingWrites()
    process.exit(0)
  }
}

async function main(): Promise<void> {
  process.on('SIGINT', () => void shutdown('SIGINT'))
  process.on('SIGTERM', () => void shutdown('SIGTERM'))

  process.on('uncaughtException', (error) => {
    console.error('[Server] Uncaught exception:', error)
  })

  process.on('unhandledRejection', (reason) => {
    console.error('[Server] Unhandled rejection:', reason)
  })

  await storeManager.initialize()
  const config = applyServerConfigOverrides()

  const started = await proxyServer.start(config.proxyPort, config.proxyHost)
  if (!started) {
    throw new Error(`Failed to start server on ${config.proxyHost}:${config.proxyPort}`)
  }

  console.log(`[Server] Chat2API listening on ${config.proxyHost}:${config.proxyPort}`)
}

void main().catch((error) => {
  console.error('[Server] Startup failed:', error)
  process.exit(1)
})
```

- [ ] **Step 2: Commit server entrypoint**

```bash
git add src/server/index.ts
git commit -m "feat: add node server entrypoint"
```

---

### Task 6: Replace Resource and Browser Runtime Calls

**Files:**
- Modify: `src/main/lib/challenge.ts`
- Modify: `src/main/oauth/adapters/base.ts`
- Modify: `src/main/oauth/adapters/deepseek.ts`
- Modify: `src/main/oauth/adapters/glm.ts`
- Modify: `src/main/oauth/adapters/kimi.ts`
- Modify: `src/main/oauth/adapters/minimax.ts`
- Modify: `src/main/oauth/adapters/qwen.ts`

- [ ] **Step 1: Replace DeepSeek WASM path**

In `src/main/lib/challenge.ts`, replace:

```ts
import { app } from 'electron'
```

with:

```ts
import { getRuntime } from '../runtime'
```

Replace WASM path selection with:

```ts
const wasmPath = getRuntime().getResourcePath('sha3_wasm_bg.7b9ca65ddd.wasm')
```

- [ ] **Step 2: Replace base OAuth browser opening**

In `src/main/oauth/adapters/base.ts`, keep `BrowserWindow` as a type-only import if required:

```ts
import type { BrowserWindow } from 'electron'
import { getRuntime } from '../../runtime'
```

Replace `shell.openExternal(url)` calls with:

```ts
await getRuntime().openExternal(url)
```

- [ ] **Step 3: Replace provider manual login browser opening**

For each OAuth adapter listed in this task, replace:

```ts
import { shell } from 'electron'
```

with:

```ts
import { getRuntime } from '../../runtime'
```

Replace:

```ts
await shell.openExternal(loginUrl)
```

with:

```ts
await getRuntime().openExternal(loginUrl)
```

Use the provider's existing login URL variable for each file.

- [ ] **Step 4: Run Electron import scan**

Run:

```bash
Get-ChildItem -Path src/main -Recurse -Filter *.ts | Select-String -Pattern "from 'electron'"
```

Expected remaining server-relevant Electron imports:

```text
src/main/runtime/electronRuntime.ts
src/main/proxy/adapters/perplexity.ts
```

Desktop-only imports may remain in `src/main/index.ts`, `src/main/ipc`, `src/main/window`, `src/main/tray`, `src/main/updater`, `src/main/oauth/inAppLogin.ts`, and `src/main/oauth/manager.ts`.

- [ ] **Step 5: Commit runtime call replacements**

```bash
git add src/main/lib/challenge.ts src/main/oauth/adapters/base.ts src/main/oauth/adapters/deepseek.ts src/main/oauth/adapters/glm.ts src/main/oauth/adapters/kimi.ts src/main/oauth/adapters/minimax.ts src/main/oauth/adapters/qwen.ts
git commit -m "refactor: route shared runtime calls through adapter"
```

---

### Task 7: Server Build Configuration

**Files:**
- Create: `vite.server.config.ts`
- Modify: `package.json`

- [ ] **Step 1: Create server Vite config**

Create `vite.server.config.ts`:

```ts
import { builtinModules } from 'module'
import { resolve } from 'path'
import { defineConfig } from 'vite'

const external = [
  ...builtinModules,
  ...builtinModules.map(moduleName => `node:${moduleName}`),
  'electron',
  'electron-store',
]

export default defineConfig({
  build: {
    outDir: 'out-server',
    emptyOutDir: true,
    target: 'node20',
    ssr: true,
    lib: {
      entry: resolve(__dirname, 'src/server/index.ts'),
      formats: ['cjs'],
      fileName: () => 'server/index.js',
    },
    rollupOptions: {
      external,
      output: {
        format: 'cjs',
        entryFileNames: '[name].js',
        chunkFileNames: 'chunks/[name]-[hash].js',
      },
    },
  },
  resolve: {
    alias: {
      '@shared': resolve(__dirname, 'src/shared'),
    },
  },
})
```

- [ ] **Step 2: Add package scripts**

In `package.json`, add scripts:

```json
"build:server": "vite build --config vite.server.config.ts",
"start:server": "node out-server/server/index.js",
"test:server-compat": "npm run build:server && node --test tests/server/*.test.mjs"
```

- [ ] **Step 3: Build server**

Run:

```bash
npm run build:server
```

Expected: build succeeds and writes `out-server/server/index.js`.

- [ ] **Step 4: Run server compatibility tests**

Run:

```bash
npm run test:server-compat
```

Expected: all `tests/server/*.test.mjs` tests pass.

- [ ] **Step 5: Commit build config**

```bash
git add package.json vite.server.config.ts tests/server
git commit -m "build: add server build and compatibility tests"
```

---

### Task 8: Perplexity Node Compatibility

**Files:**
- Modify: `src/main/proxy/adapters/perplexity.ts`

- [ ] **Step 1: Replace Electron net import**

In `src/main/proxy/adapters/perplexity.ts`, replace:

```ts
import { net } from 'electron'
```

with:

```ts
import axios from 'axios'
```

- [ ] **Step 2: Replace Electron request implementation**

Find the method that calls `net.request`. Replace that request path with an axios streaming request:

```ts
const response = await axios.post(QUERY_ENDPOINT, requestData, {
  headers,
  responseType: 'stream',
  timeout: 120000,
  validateStatus: () => true,
})

if (response.status < 200 || response.status >= 300) {
  throw new Error(`Perplexity request failed: HTTP ${response.status}`)
}

return response.data
```

Preserve existing headers, cookie handling, request body shape, and stream parser code.

- [ ] **Step 3: Build server**

Run:

```bash
npm run build:server
```

Expected: build succeeds without requiring Electron for server entrypoint.

- [ ] **Step 4: Commit Perplexity compatibility**

```bash
git add src/main/proxy/adapters/perplexity.ts
git commit -m "refactor: replace electron net in perplexity adapter"
```

---

### Task 9: Docker Packaging

**Files:**
- Create: `Dockerfile`
- Create: `.dockerignore`
- Create: `docker-compose.yml`
- Create: `docs/docker.md`

- [ ] **Step 1: Create Dockerfile**

Create `Dockerfile`:

```dockerfile
FROM node:22-bookworm-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run build:server

FROM node:22-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
ENV CHAT2API_HOST=0.0.0.0
ENV CHAT2API_PORT=8080
ENV CHAT2API_DATA_DIR=/data
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/out-server ./out-server
COPY --from=build /app/sha3_wasm_bg.7b9ca65ddd.wasm ./sha3_wasm_bg.7b9ca65ddd.wasm
RUN mkdir -p /data
VOLUME ["/data"]
EXPOSE 8080
CMD ["node", "out-server/server/index.js"]
```

- [ ] **Step 2: Create dockerignore**

Create `.dockerignore`:

```text
.git
dist
out
out-server
node_modules
npm-debug.log
docs/screenshots
backup
*.log
```

- [ ] **Step 3: Create Docker Compose file**

Create `docker-compose.yml`:

```yaml
services:
  chat2api:
    build:
      context: .
      dockerfile: Dockerfile
    image: chat2api:server
    container_name: chat2api
    restart: unless-stopped
    ports:
      - "8080:8080"
    environment:
      CHAT2API_HOST: 0.0.0.0
      CHAT2API_PORT: 8080
      CHAT2API_DATA_DIR: /data
      CHAT2API_ENABLE_MANAGEMENT_API: "true"
      CHAT2API_MANAGEMENT_SECRET: ${CHAT2API_MANAGEMENT_SECRET}
      CHAT2API_LOG_LEVEL: info
      CHAT2API_LOAD_BALANCE_STRATEGY: round-robin
    volumes:
      - chat2api-data:/data

volumes:
  chat2api-data:
```

- [ ] **Step 4: Create Docker docs**

Create `docs/docker.md`:

```md
# Chat2API Docker Server

## Build

```bash
docker build -t chat2api:server .
```

## Run

```bash
docker run -d \
  --name chat2api \
  -p 8080:8080 \
  -v chat2api-data:/data \
  -e CHAT2API_HOST=0.0.0.0 \
  -e CHAT2API_PORT=8080 \
  -e CHAT2API_ENABLE_MANAGEMENT_API=true \
  -e CHAT2API_MANAGEMENT_SECRET=mgmt_change_me \
  chat2api:server
```

## Health Check

```bash
curl http://localhost:8080/health
```

## Add A Qwen Account

```bash
curl -X POST http://localhost:8080/v0/management/accounts \
  -H "Authorization: Bearer mgmt_change_me" \
  -H "Content-Type: application/json" \
  -d '{
    "providerId": "qwen",
    "name": "qwen-account-1",
    "credentials": {
      "ticket": "tongyi_sso_ticket_value"
    }
  }'
```

## Add A Second Qwen Account

```bash
curl -X POST http://localhost:8080/v0/management/accounts \
  -H "Authorization: Bearer mgmt_change_me" \
  -H "Content-Type: application/json" \
  -d '{
    "providerId": "qwen",
    "name": "qwen-account-2",
    "credentials": {
      "ticket": "another_tongyi_sso_ticket_value"
    }
  }'
```

## Pin A Model To One Account

Use `preferredAccountId` from the account list:

```bash
curl http://localhost:8080/v0/management/providers/qwen/accounts \
  -H "Authorization: Bearer mgmt_change_me"
```

```bash
curl -X POST http://localhost:8080/v0/management/model-mappings \
  -H "Authorization: Bearer mgmt_change_me" \
  -H "Content-Type: application/json" \
  -d '{
    "requestModel": "qwen-primary",
    "actualModel": "Qwen3.7-Max",
    "preferredProviderId": "qwen",
    "preferredAccountId": "account_id_from_previous_response"
  }'
```

## Upstream Update Flow

```bash
git fetch upstream
git merge upstream/main
npm install
npm run test:server-compat
npm run build:server
docker build -t chat2api:server .
```

If conflicts occur, keep upstream provider logic first, then reapply the runtime boundary and server entrypoint. Docker-specific files are intentionally isolated under `src/server`, `src/main/runtime`, `src/main/store/storage`, and root Docker files.
```

- [ ] **Step 5: Build Docker image**

Run:

```bash
docker build -t chat2api:server .
```

Expected: image builds successfully.

- [ ] **Step 6: Commit Docker packaging**

```bash
git add Dockerfile .dockerignore docker-compose.yml docs/docker.md
git commit -m "build: add docker server packaging"
```

---

### Task 10: Local Server Smoke Test

**Files:**
- No source files

- [ ] **Step 1: Build server**

Run:

```bash
npm run build:server
```

Expected: build succeeds.

- [ ] **Step 2: Start server locally**

Run:

```bash
$env:CHAT2API_HOST='127.0.0.1'
$env:CHAT2API_PORT='18080'
$env:CHAT2API_ENABLE_MANAGEMENT_API='true'
$env:CHAT2API_MANAGEMENT_SECRET='mgmt_test_secret'
npm run start:server
```

Expected: server logs:

```text
[Server] Chat2API listening on 127.0.0.1:18080
```

- [ ] **Step 3: Check health**

In another shell:

```bash
curl http://127.0.0.1:18080/health
```

Expected response includes:

```json
{
  "status": "running"
}
```

- [ ] **Step 4: Check management API authentication**

Run:

```bash
curl http://127.0.0.1:18080/v0/management/accounts
```

Expected: HTTP 401.

Run:

```bash
curl http://127.0.0.1:18080/v0/management/accounts -H "Authorization: Bearer mgmt_test_secret"
```

Expected: HTTP 200 with:

```json
{
  "success": true,
  "data": []
}
```

- [ ] **Step 5: Commit smoke-test documentation update if command details changed**

If the verified command differs from `docs/docker.md`, update `docs/docker.md` and commit:

```bash
git add docs/docker.md
git commit -m "docs: update docker smoke test commands"
```

---

### Task 11: Docker Smoke Test

**Files:**
- No source files

- [ ] **Step 1: Build image**

Run:

```bash
docker build -t chat2api:server .
```

Expected: image builds successfully.

- [ ] **Step 2: Run container**

Run:

```bash
docker rm -f chat2api-test
docker run -d \
  --name chat2api-test \
  -p 18081:8080 \
  -e CHAT2API_ENABLE_MANAGEMENT_API=true \
  -e CHAT2API_MANAGEMENT_SECRET=mgmt_test_secret \
  chat2api:server
```

Expected: container stays running.

- [ ] **Step 3: Check health**

Run:

```bash
curl http://127.0.0.1:18081/health
```

Expected: response includes:

```json
{
  "status": "running"
}
```

- [ ] **Step 4: Check management API**

Run:

```bash
curl http://127.0.0.1:18081/v0/management/providers \
  -H "Authorization: Bearer mgmt_test_secret"
```

Expected: response includes built-in providers.

- [ ] **Step 5: Clean up container**

Run:

```bash
docker rm -f chat2api-test
```

Expected: container removed.

---

### Task 12: Final Verification

**Files:**
- No source files

- [ ] **Step 1: Run existing source artifact check**

Run:

```bash
npm run check:source-artifacts
```

Expected: PASS.

- [ ] **Step 2: Run desktop build**

Run:

```bash
npm run build
```

Expected: existing Electron build still succeeds.

- [ ] **Step 3: Run server compatibility tests**

Run:

```bash
npm run test:server-compat
```

Expected: server build and server tests pass.

- [ ] **Step 4: Run Docker build**

Run:

```bash
docker build -t chat2api:server .
```

Expected: image builds successfully.

- [ ] **Step 5: Commit final fixes**

If verification required fixes, commit them:

```bash
git add .
git commit -m "fix: complete docker server verification"
```

---

## Completion Criteria

- `npm run build` still builds the Electron app.
- `npm run build:server` builds the Node server.
- `npm run test:server-compat` passes.
- Docker image starts and responds to `/health`.
- Management API can create Qwen accounts in Docker.
- The Docker-specific patch surface remains isolated for future upstream pulls.
