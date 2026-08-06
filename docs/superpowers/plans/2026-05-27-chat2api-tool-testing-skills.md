# Chat2API Tool Testing Skills Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build versioned, reusable Chat2API testing skills for management API operations, HAR fixture extraction, client replay, and provider/model matrix testing.

**Architecture:** Move durable testing skills into versioned `skills/` directories. Split the current Cherry Studio one-off runner into focused scripts: management API helpers, generic HAR fixture extraction, client-profile replay, and `/v1/models`-driven matrix orchestration. Keep live provider tests opt-in and keep generated reports under ignored `backup/har/`.

**Tech Stack:** Markdown Skill files, Node.js ESM scripts, built-in `fetch`, Node test runner, Chat2API management API, OpenAI-compatible `/v1/models` and `/v1/chat/completions`.

---

## File Structure

Create these versioned skill directories:

```text
skills/
  chat2api-management-api/
    SKILL.md
    scripts/management-api.mjs
  chat2api-har-tool-fixture/
    SKILL.md
    scripts/extract-har-fixtures.mjs
  chat2api-tool-client-replay/
    SKILL.md
    scripts/replay-client-fixture.mjs
    profiles/cherry-studio.json
    profiles/openai-tools.json
    profiles/custom-har.json
  chat2api-provider-model-matrix/
    SKILL.md
    scripts/run-model-matrix.mjs
  chat2api-proxy-testing/
    SKILL.md
```

Add focused tests:

```text
tests/skills/
  chat2api-management-api.test.mjs
  chat2api-har-tool-fixture.test.mjs
  chat2api-tool-client-replay.test.mjs
  chat2api-provider-model-matrix.test.mjs
  chat2api-proxy-testing-skill.test.mjs
```

Keep existing ignored `.codex/skills/chat2api-proxy-testing` as local working state only. Do not rely on it in tests.

---

### Task 1: Versioned Skill Shells

**Files:**
- Create: `skills/chat2api-management-api/SKILL.md`
- Create: `skills/chat2api-har-tool-fixture/SKILL.md`
- Create: `skills/chat2api-tool-client-replay/SKILL.md`
- Create: `skills/chat2api-provider-model-matrix/SKILL.md`
- Create: `skills/chat2api-proxy-testing/SKILL.md`
- Test: `tests/skills/chat2api-proxy-testing-skill.test.mjs`

- [ ] **Step 1: Write failing skill shell test**

Create `tests/skills/chat2api-proxy-testing-skill.test.mjs`:

```js
import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'

const skillPaths = [
  'skills/chat2api-management-api/SKILL.md',
  'skills/chat2api-har-tool-fixture/SKILL.md',
  'skills/chat2api-tool-client-replay/SKILL.md',
  'skills/chat2api-provider-model-matrix/SKILL.md',
  'skills/chat2api-proxy-testing/SKILL.md',
]

test('versioned Chat2API testing skills exist and have trigger-only descriptions', () => {
  for (const file of skillPaths) {
    const text = fs.readFileSync(file, 'utf8')
    assert.match(text, /^---\nname: [a-z0-9-]+\ndescription: Use when /m, file)
    assert.doesNotMatch(text, /T[B]D|FI[X]ME|deferred work/, file)
  }
})

test('proxy testing skill delegates focused responsibilities', () => {
  const text = fs.readFileSync('skills/chat2api-proxy-testing/SKILL.md', 'utf8')
  assert.match(text, /chat2api-management-api/)
  assert.match(text, /chat2api-har-tool-fixture/)
  assert.match(text, /chat2api-tool-client-replay/)
  assert.match(text, /chat2api-provider-model-matrix/)
})
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
node --test tests/skills/chat2api-proxy-testing-skill.test.mjs
```

Expected: fails with `ENOENT` for missing `skills/.../SKILL.md`.

- [ ] **Step 3: Create minimal skill shell files**

Create `skills/chat2api-management-api/SKILL.md`:

```markdown
---
name: chat2api-management-api
description: Use when operating Chat2API Manager's management API for testing, including health checks, config snapshots, temporary API keys, model mappings, sessions, logs, and cleanup verification.
---

# Chat2API Management API

Use this skill before live proxy testing that needs `/v0/management/*`.

## Rules

- Never print full management secrets, API keys, or account credentials.
- Create disposable API keys for tests and delete only keys created by the current run.
- Snapshot config before mutation and restore it in cleanup.
- Do not clear sessions unless the user explicitly asks for cleanup.

## Script

Use `scripts/management-api.mjs` for repeatable operations.
```

Create `skills/chat2api-har-tool-fixture/SKILL.md`:

```markdown
---
name: chat2api-har-tool-fixture
description: Use when converting OpenAI-compatible client HAR files into sanitized replayable Chat2API tool-calling fixtures.
---

# Chat2API HAR Tool Fixture

Use this skill when a recorded client HAR should become reusable test input.

## Rules

- Treat HAR parsing as generic.
- Put client-specific expectations in replay profiles, not in HAR extraction.
- Remove secrets and volatile headers from generated fixtures.

## Script

Use `scripts/extract-har-fixtures.mjs`.
```

Create `skills/chat2api-tool-client-replay/SKILL.md`:

```markdown
---
name: chat2api-tool-client-replay
description: Use when replaying sanitized client tool-calling fixtures against Chat2API with client-specific pass/fail rules.
---

# Chat2API Tool Client Replay

Use this skill to replay fixture scenarios for clients such as Cherry Studio, generic OpenAI tools, or unknown HAR-derived clients.

## Rules

- Preserve exact tool names.
- Validate stream and non-stream behavior separately.
- Use profiles for client-specific prompt-protocol expectations.

## Script

Use `scripts/replay-client-fixture.mjs`.
```

Create `skills/chat2api-provider-model-matrix/SKILL.md`:

```markdown
---
name: chat2api-provider-model-matrix
description: Use when running Chat2API provider and model matrix tests using live /v1/models discovery and management API attribution.
---

# Chat2API Provider Model Matrix

Use this skill when model coverage must follow the live `/v1/models` surface.

## Rules

- Use `GET /v1/models` as the primary model source.
- Use management API data for attribution and cleanup.
- Keep provider fail-fast opt-in.

## Script

Use `scripts/run-model-matrix.mjs`.
```

Create `skills/chat2api-proxy-testing/SKILL.md`:

```markdown
---
name: chat2api-proxy-testing
description: Use when validating Chat2API Manager proxy behavior across dialogue, tool calling, context, provider routing, request logs, and live client replay workflows.
---

# Chat2API Proxy Testing

Use this as the orchestration entry point.

## Focused Skills

- Use `chat2api-management-api` for management API setup, observation, and cleanup.
- Use `chat2api-har-tool-fixture` to extract reusable fixtures from HAR files.
- Use `chat2api-tool-client-replay` to replay one client fixture against one or more models.
- Use `chat2api-provider-model-matrix` to discover `/v1/models` and run matrix coverage.

## Default Order

1. Run source regressions when code changed.
2. Snapshot health and config through management API.
3. Extract or select a fixture.
4. Discover models through `/v1/models`.
5. Replay scenarios.
6. Inspect logs and sessions.
7. Restore config and delete temporary test assets.
```

- [ ] **Step 4: Run test to verify it passes**

Run:

```bash
node --test tests/skills/chat2api-proxy-testing-skill.test.mjs
```

Expected: pass.

- [ ] **Step 5: Commit**

```bash
git add skills tests/skills/chat2api-proxy-testing-skill.test.mjs
git commit -m "docs: add versioned Chat2API testing skill shells"
```

---

### Task 2: Management API Helper

**Files:**
- Create: `skills/chat2api-management-api/scripts/management-api.mjs`
- Modify: `skills/chat2api-management-api/SKILL.md`
- Test: `tests/skills/chat2api-management-api.test.mjs`

- [ ] **Step 1: Write failing tests for command parsing and secret masking**

Create `tests/skills/chat2api-management-api.test.mjs`:

```js
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import test from 'node:test'

const script = 'skills/chat2api-management-api/scripts/management-api.mjs'

test('management helper has documented commands', () => {
  const text = fs.readFileSync(script, 'utf8')
  assert.match(text, /command === 'snapshot'/)
  assert.match(text, /command === 'create-api-key'/)
  assert.match(text, /command === 'delete-api-key'/)
  assert.match(text, /command === 'restore-tool-config'/)
  assert.match(text, /maskSecret/)
})

test('management helper prints safe dry-run output without leaking secret', () => {
  const result = spawnSync('node', [script, 'snapshot', '--dry-run'], {
    env: {
      ...process.env,
      CHAT2API_BASE_URL: 'http://127.0.0.1:8080',
      CHAT2API_MGMT_SECRET: 'mgmt_super_secret_value',
    },
    encoding: 'utf8',
  })

  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /snapshot/)
  assert.doesNotMatch(result.stdout, /mgmt_super_secret_value/)
})
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
node --test tests/skills/chat2api-management-api.test.mjs
```

Expected: fails because `management-api.mjs` does not exist.

- [ ] **Step 3: Implement management helper**

Create `skills/chat2api-management-api/scripts/management-api.mjs`:

```js
#!/usr/bin/env node

const baseUrl = (process.env.CHAT2API_BASE_URL || 'http://127.0.0.1:8080').replace(/\/$/, '')
const managementSecret = process.env.CHAT2API_MGMT_SECRET || ''
const command = process.argv[2] || 'help'
const args = parseArgs(process.argv.slice(3))

function parseArgs(values) {
  const parsed = {}
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index]
    if (!value.startsWith('--')) continue
    const key = value.slice(2)
    const next = values[index + 1]
    if (!next || next.startsWith('--')) {
      parsed[key] = true
    } else {
      parsed[key] = next
      index += 1
    }
  }
  return parsed
}

function maskSecret(value) {
  if (!value) return ''
  if (value.length <= 8) return '***'
  return `${value.slice(0, 4)}...${value.slice(-4)}`
}

function dryRun(label, extra = {}) {
  console.log(JSON.stringify({
    command: label,
    baseUrl,
    managementSecret: maskSecret(managementSecret),
    ...extra,
  }, null, 2))
}

async function request(path, options = {}) {
  if (!managementSecret) throw new Error('CHAT2API_MGMT_SECRET is required')
  const response = await fetch(`${baseUrl}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${managementSecret}`,
      'Content-Type': 'application/json',
      ...options.headers,
    },
  })
  const text = await response.text()
  let body
  try {
    body = text ? JSON.parse(text) : null
  } catch {
    body = text
  }
  return { ok: response.ok, status: response.status, body }
}

async function snapshot() {
  if (args['dry-run']) return dryRun('snapshot')
  const [health, proxy, config, providers, accounts, sessions, logs] = await Promise.all([
    fetch(`${baseUrl}/health`).then(async response => ({ status: response.status, body: await response.text() })),
    request('/v0/management/proxy/status'),
    request('/v0/management/config'),
    request('/v0/management/providers/'),
    request('/v0/management/accounts'),
    request('/v0/management/sessions'),
    request('/v0/management/logs?type=request&limit=20'),
  ])
  console.log(JSON.stringify({ health, proxy, config, providers, accounts, sessions, logs }, null, 2))
}

async function createApiKey() {
  if (args['dry-run']) return dryRun('create-api-key', { name: args.name || 'codex-live-test' })
  const result = await request('/v0/management/api-keys', {
    method: 'POST',
    body: JSON.stringify({
      name: args.name || `codex-live-test-${Date.now()}`,
      description: 'temporary key created by Chat2API testing skill',
    }),
  })
  if (!result.ok) throw new Error(`create-api-key failed: ${result.status}`)
  console.log(JSON.stringify({
    id: result.body.data.id,
    key: result.body.data.key,
  }, null, 2))
}

async function deleteApiKey() {
  if (!args.id) throw new Error('--id is required')
  if (args['dry-run']) return dryRun('delete-api-key', { id: args.id })
  const result = await request(`/v0/management/api-keys/${encodeURIComponent(args.id)}`, { method: 'DELETE' })
  console.log(JSON.stringify(result, null, 2))
}

async function restoreToolConfig() {
  if (!args.file) throw new Error('--file is required')
  if (args['dry-run']) return dryRun('restore-tool-config', { file: args.file })
  const value = JSON.parse(await fs.promises.readFile(args.file, 'utf8'))
  const result = await request('/v0/management/config/toolCallingConfig', {
    method: 'PUT',
    body: JSON.stringify({ value }),
  })
  console.log(JSON.stringify(result, null, 2))
}

async function main() {
  if (command === 'snapshot') return snapshot()
  if (command === 'create-api-key') return createApiKey()
  if (command === 'delete-api-key') return deleteApiKey()
  if (command === 'restore-tool-config') return restoreToolConfig()
  console.log('Commands: snapshot, create-api-key, delete-api-key, restore-tool-config')
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exit(1)
})
```

- [ ] **Step 4: Update management skill usage section**

Append to `skills/chat2api-management-api/SKILL.md`:

````markdown
## Commands

```bash
CHAT2API_MGMT_SECRET=mgmt_xxx node skills/chat2api-management-api/scripts/management-api.mjs snapshot
CHAT2API_MGMT_SECRET=mgmt_xxx node skills/chat2api-management-api/scripts/management-api.mjs create-api-key --name codex-live-test
CHAT2API_MGMT_SECRET=mgmt_xxx node skills/chat2api-management-api/scripts/management-api.mjs delete-api-key --id key-id
```

Use `--dry-run` to verify command shape without network calls.
````

- [ ] **Step 5: Run test to verify it passes**

Run:

```bash
node --test tests/skills/chat2api-management-api.test.mjs
```

Expected: pass.

- [ ] **Step 6: Commit**

```bash
git add skills/chat2api-management-api tests/skills/chat2api-management-api.test.mjs
git commit -m "feat: add Chat2API management API testing skill"
```

---

### Task 3: HAR Fixture Extractor

**Files:**
- Create: `skills/chat2api-har-tool-fixture/scripts/extract-har-fixtures.mjs`
- Modify: `skills/chat2api-har-tool-fixture/SKILL.md`
- Test: `tests/skills/chat2api-har-tool-fixture.test.mjs`

- [ ] **Step 1: Write failing HAR extraction test**

Create `tests/skills/chat2api-har-tool-fixture.test.mjs`:

```js
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

const script = 'skills/chat2api-har-tool-fixture/scripts/extract-har-fixtures.mjs'

function writeHar(file) {
  const har = {
    log: {
      entries: [{
        request: {
          method: 'POST',
          url: 'http://127.0.0.1:8080/v1/chat/completions',
          headers: [
            { name: 'Authorization', value: 'Bearer secret' },
            { name: 'x-title', value: 'Cherry Studio' },
            { name: 'User-Agent', value: 'CherryStudio/1.9.6' },
          ],
          postData: {
            text: JSON.stringify({
              model: 'deepseek-v4-flash',
              stream: true,
              messages: [{ role: 'user', content: 'Use weather' }],
              tools: [{
                type: 'function',
                function: {
                  name: 'mcp__weatherTest__getWeather',
                  description: 'weather',
                  parameters: { type: 'object' },
                },
              }],
              tool_choice: 'auto',
            }),
          },
        },
      }],
    },
  }
  fs.writeFileSync(file, JSON.stringify(har))
}

test('extracts sanitized tool fixture from HAR', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chat2api-har-'))
  const har = path.join(dir, 'client.har')
  const out = path.join(dir, 'fixture.json')
  writeHar(har)

  const result = spawnSync('node', [script, '--har', har, '--out', out, '--client', 'cherry-studio'], {
    encoding: 'utf8',
  })

  assert.equal(result.status, 0, result.stderr)
  const fixture = JSON.parse(fs.readFileSync(out, 'utf8'))
  assert.equal(fixture.clientProfile, 'cherry-studio')
  assert.equal(fixture.toolNames[0], 'mcp__weatherTest__getWeather')
  assert.equal(fixture.scenarios[0].kind, 'tools_stream')
  assert.deepEqual(fixture.scenarios[0].headers, {
    'User-Agent': 'CherryStudio/1.9.6',
    'x-title': 'Cherry Studio',
  })
  assert.doesNotMatch(JSON.stringify(fixture), /secret/)
})
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
node --test tests/skills/chat2api-har-tool-fixture.test.mjs
```

Expected: fails because extractor script does not exist.

- [ ] **Step 3: Implement extractor**

Create `skills/chat2api-har-tool-fixture/scripts/extract-har-fixtures.mjs` with:

```js
#!/usr/bin/env node

import fs from 'node:fs'

const args = parseArgs(process.argv.slice(2))
const harPath = args.har || process.env.CHAT2API_HAR
const outPath = args.out || `backup/har/${args.client || 'custom-har'}-tool-fixtures-${Date.now()}.json`
const clientProfile = args.client || process.env.CHAT2API_CLIENT_PROFILE || 'custom-har'

if (!harPath) throw new Error('--har or CHAT2API_HAR is required')

function parseArgs(values) {
  const parsed = {}
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index]
    if (!value.startsWith('--')) continue
    const key = value.slice(2)
    const next = values[index + 1]
    if (!next || next.startsWith('--')) {
      parsed[key] = true
    } else {
      parsed[key] = next
      index += 1
    }
  }
  return parsed
}

function safeHeaders(headers = []) {
  const allowed = new Set(['user-agent', 'x-title', 'accept-language'])
  const result = {}
  for (const header of headers) {
    const lower = header.name.toLowerCase()
    if (allowed.has(lower)) result[header.name] = header.value
  }
  return result
}

function classify(body) {
  if (body.stream === true && Array.isArray(body.tools)) return 'tools_stream'
  if (body.stream !== true && Array.isArray(body.tools)) return 'tools_nonstream'
  if (body.stream === true && body.messages?.some(message => message.role === 'system')) return 'prompt_stream'
  if (body.stream !== true && body.messages?.some(message => message.role === 'system')) return 'prompt_nonstream'
  if (body.messages?.some(message => message.role === 'tool')) return 'tool_result_followup'
  return 'chat'
}

const har = JSON.parse(fs.readFileSync(harPath, 'utf8'))
const scenarios = []
const toolNames = new Set()

for (const entry of har.log?.entries || []) {
  const request = entry.request
  if (request.method !== 'POST') continue
  if (!request.url.includes('/v1/chat/completions')) continue
  const body = JSON.parse(request.postData?.text || '{}')
  for (const tool of body.tools || []) {
    if (tool.function?.name) toolNames.add(tool.function.name)
  }
  scenarios.push({
    kind: classify(body),
    headers: safeHeaders(request.headers),
    body,
  })
}

if (scenarios.length === 0) {
  throw new Error('No /v1/chat/completions requests found in HAR')
}

fs.mkdirSync(outPath.split('/').slice(0, -1).join('/') || '.', { recursive: true })
fs.writeFileSync(outPath, JSON.stringify({
  schemaVersion: 1,
  sourceHar: harPath,
  clientProfile,
  toolNames: [...toolNames],
  scenarios,
}, null, 2))

console.log(outPath)
```

- [ ] **Step 4: Update HAR fixture skill usage section**

Append to `skills/chat2api-har-tool-fixture/SKILL.md`:

````markdown
## Commands

```bash
node skills/chat2api-har-tool-fixture/scripts/extract-har-fixtures.mjs \
  --har backup/har/Cherry-Studio.har \
  --client cherry-studio \
  --out backup/har/cherry-studio-fixture.json
```

The output fixture is safe to replay and must not contain `Authorization` values.
````

- [ ] **Step 5: Run test to verify it passes**

Run:

```bash
node --test tests/skills/chat2api-har-tool-fixture.test.mjs
```

Expected: pass.

- [ ] **Step 6: Commit**

```bash
git add skills/chat2api-har-tool-fixture tests/skills/chat2api-har-tool-fixture.test.mjs
git commit -m "feat: add HAR tool fixture extraction skill"
```

---

### Task 4: Client Replay Profiles And Runner

**Files:**
- Create: `skills/chat2api-tool-client-replay/profiles/cherry-studio.json`
- Create: `skills/chat2api-tool-client-replay/profiles/openai-tools.json`
- Create: `skills/chat2api-tool-client-replay/profiles/custom-har.json`
- Create: `skills/chat2api-tool-client-replay/scripts/replay-client-fixture.mjs`
- Modify: `skills/chat2api-tool-client-replay/SKILL.md`
- Test: `tests/skills/chat2api-tool-client-replay.test.mjs`

- [ ] **Step 1: Write failing replay profile tests**

Create `tests/skills/chat2api-tool-client-replay.test.mjs`:

```js
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import test from 'node:test'

const script = 'skills/chat2api-tool-client-replay/scripts/replay-client-fixture.mjs'

test('client profiles define prompt and tools expectations', () => {
  const cherry = JSON.parse(fs.readFileSync('skills/chat2api-tool-client-replay/profiles/cherry-studio.json', 'utf8'))
  assert.equal(cherry.id, 'cherry-studio')
  assert.equal(cherry.promptProtocol.visibleToolUseRequired, true)
  assert.equal(cherry.toolsProtocol.finishReason, 'tool_calls')

  const openai = JSON.parse(fs.readFileSync('skills/chat2api-tool-client-replay/profiles/openai-tools.json', 'utf8'))
  assert.equal(openai.id, 'openai-tools')
  assert.equal(openai.promptProtocol.visibleToolUseRequired, false)
})

test('replay dry-run reports selected fixture and model', () => {
  const result = spawnSync('node', [script, '--fixture', 'sample.json', '--profile', 'cherry-studio', '--model', 'deepseek-v4-flash', '--dry-run'], {
    env: {
      ...process.env,
      CHAT2API_API_KEY: 'sk-secret-value',
    },
    encoding: 'utf8',
  })

  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /cherry-studio/)
  assert.match(result.stdout, /deepseek-v4-flash/)
  assert.doesNotMatch(result.stdout, /sk-secret-value/)
})
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
node --test tests/skills/chat2api-tool-client-replay.test.mjs
```

Expected: fails because profiles and runner do not exist.

- [ ] **Step 3: Create profiles**

Create `skills/chat2api-tool-client-replay/profiles/cherry-studio.json`:

```json
{
  "id": "cherry-studio",
  "headers": {
    "x-title": "Cherry Studio",
    "User-Agent": "Mozilla/5.0 CherryStudio/1.9.6"
  },
  "toolsProtocol": {
    "requiresExactToolName": true,
    "finishReason": "tool_calls",
    "rawWrapperPattern": "<\\\\|CHAT2API\\\\|tool_calls>|<tool_calls>|\\\\[function_calls\\\\]"
  },
  "promptProtocol": {
    "visibleToolUseRequired": true,
    "toolUseTag": "<tool_use>"
  }
}
```

Create `skills/chat2api-tool-client-replay/profiles/openai-tools.json`:

```json
{
  "id": "openai-tools",
  "headers": {
    "User-Agent": "OpenAI-Compatible-Test/1.0"
  },
  "toolsProtocol": {
    "requiresExactToolName": true,
    "finishReason": "tool_calls",
    "rawWrapperPattern": "<\\\\|CHAT2API\\\\|tool_calls>|<tool_calls>|\\\\[function_calls\\\\]"
  },
  "promptProtocol": {
    "visibleToolUseRequired": false,
    "toolUseTag": "<tool_use>"
  }
}
```

Create `skills/chat2api-tool-client-replay/profiles/custom-har.json`:

```json
{
  "id": "custom-har",
  "headers": {},
  "toolsProtocol": {
    "requiresExactToolName": true,
    "finishReason": "tool_calls",
    "rawWrapperPattern": "<\\\\|CHAT2API\\\\|tool_calls>|<tool_calls>|\\\\[function_calls\\\\]"
  },
  "promptProtocol": {
    "visibleToolUseRequired": true,
    "toolUseTag": "<tool_use>"
  }
}
```

- [ ] **Step 4: Implement replay runner**

Create `skills/chat2api-tool-client-replay/scripts/replay-client-fixture.mjs` with:

```js
#!/usr/bin/env node

import fs from 'node:fs'

const args = parseArgs(process.argv.slice(2))
const baseUrl = (process.env.CHAT2API_BASE_URL || 'http://127.0.0.1:8080').replace(/\/$/, '')
const apiKey = process.env.CHAT2API_API_KEY || ''

function parseArgs(values) {
  const parsed = {}
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index]
    if (!value.startsWith('--')) continue
    const key = value.slice(2)
    const next = values[index + 1]
    if (!next || next.startsWith('--')) parsed[key] = true
    else {
      parsed[key] = next
      index += 1
    }
  }
  return parsed
}

function mask(value) {
  if (!value) return ''
  return value.length <= 8 ? '***' : `${value.slice(0, 3)}...${value.slice(-4)}`
}

function readProfile(id) {
  return JSON.parse(fs.readFileSync(`skills/chat2api-tool-client-replay/profiles/${id}.json`, 'utf8'))
}

async function main() {
  const profileId = args.profile || 'custom-har'
  const model = args.model || process.env.CHAT2API_MODEL
  if (!args.fixture) throw new Error('--fixture is required')
  if (!model) throw new Error('--model or CHAT2API_MODEL is required')
  const profile = readProfile(profileId)

  if (args['dry-run']) {
    console.log(JSON.stringify({
      fixture: args.fixture,
      profile: profile.id,
      model,
      baseUrl,
      apiKey: mask(apiKey),
    }, null, 2))
    return
  }

  if (!apiKey) throw new Error('CHAT2API_API_KEY is required')
  const fixture = JSON.parse(fs.readFileSync(args.fixture, 'utf8'))
  const results = []

  for (const scenario of fixture.scenarios) {
    const body = { ...scenario.body, model }
    const response = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        ...profile.headers,
        ...scenario.headers,
      },
      body: JSON.stringify(body),
    })
    results.push({
      kind: scenario.kind,
      status: response.status,
      ok: response.ok,
      textPreview: (await response.text()).slice(0, 500),
    })
  }

  console.log(JSON.stringify({ profile: profile.id, model, results }, null, 2))
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exit(1)
})
```

- [ ] **Step 5: Update replay skill usage section**

Append to `skills/chat2api-tool-client-replay/SKILL.md`:

````markdown
## Commands

```bash
CHAT2API_API_KEY=sk_xxx \
node skills/chat2api-tool-client-replay/scripts/replay-client-fixture.mjs \
  --fixture backup/har/cherry-studio-fixture.json \
  --profile cherry-studio \
  --model deepseek-v4-flash
```

Use `--dry-run` to validate profile, model, and fixture selection without live requests.
````

- [ ] **Step 6: Run test to verify it passes**

Run:

```bash
node --test tests/skills/chat2api-tool-client-replay.test.mjs
```

Expected: pass.

- [ ] **Step 7: Commit**

```bash
git add skills/chat2api-tool-client-replay tests/skills/chat2api-tool-client-replay.test.mjs
git commit -m "feat: add client fixture replay skill"
```

---

### Task 5: `/v1/models` Matrix Runner

**Files:**
- Create: `skills/chat2api-provider-model-matrix/scripts/run-model-matrix.mjs`
- Modify: `skills/chat2api-provider-model-matrix/SKILL.md`
- Test: `tests/skills/chat2api-provider-model-matrix.test.mjs`

- [ ] **Step 1: Write failing matrix tests**

Create `tests/skills/chat2api-provider-model-matrix.test.mjs`:

```js
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import test from 'node:test'

const script = 'skills/chat2api-provider-model-matrix/scripts/run-model-matrix.mjs'

test('matrix runner defaults to /v1/models discovery', () => {
  const text = fs.readFileSync(script, 'utf8')
  assert.match(text, /\/v1\/models/)
  assert.match(text, /modelSource: 'v1\/models'/)
  assert.match(text, /fail-fast-provider/)
})

test('matrix runner dry-run does not require secrets and reports filters', () => {
  const result = spawnSync('node', [script, '--fixture', 'fixture.json', '--profile', 'cherry-studio', '--provider', 'deepseek', '--dry-run'], {
    encoding: 'utf8',
  })

  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /v1\/models/)
  assert.match(result.stdout, /deepseek/)
  assert.match(result.stdout, /cherry-studio/)
})
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
node --test tests/skills/chat2api-provider-model-matrix.test.mjs
```

Expected: fails because matrix runner does not exist.

- [ ] **Step 3: Implement matrix runner skeleton**

Create `skills/chat2api-provider-model-matrix/scripts/run-model-matrix.mjs`:

```js
#!/usr/bin/env node

import fs from 'node:fs'

const args = parseArgs(process.argv.slice(2))
const baseUrl = (process.env.CHAT2API_BASE_URL || 'http://127.0.0.1:8080').replace(/\/$/, '')
const managementSecret = process.env.CHAT2API_MGMT_SECRET || ''
const apiKey = process.env.CHAT2API_API_KEY || ''
const runId = new Date().toISOString().replace(/[:.]/g, '-')

function parseArgs(values) {
  const parsed = {}
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index]
    if (!value.startsWith('--')) continue
    const key = value.slice(2)
    const next = values[index + 1]
    if (!next || next.startsWith('--')) parsed[key] = true
    else {
      parsed[key] = next
      index += 1
    }
  }
  return parsed
}

async function getModels() {
  const response = await fetch(`${baseUrl}/v1/models`, {
    headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
  })
  const body = await response.json()
  return body.data || []
}

function dryRun() {
  console.log(JSON.stringify({
    modelSource: 'v1/models',
    modelsEndpoint: `${baseUrl}/v1/models`,
    fixture: args.fixture,
    profile: args.profile || 'custom-har',
    provider: args.provider,
    model: args.model,
    failFastProvider: args['fail-fast-provider'] || false,
  }, null, 2))
}

async function main() {
  if (!args.fixture) throw new Error('--fixture is required')
  if (args['dry-run']) return dryRun()
  if (!managementSecret) throw new Error('CHAT2API_MGMT_SECRET is required')
  if (!apiKey) throw new Error('CHAT2API_API_KEY is required')

  const models = await getModels()
  const selected = models.filter(model => {
    if (args.model && model.id !== args.model) return false
    if (args.provider && model.owned_by !== args.provider) return false
    return true
  })

  fs.mkdirSync('backup/har', { recursive: true })
  const report = {
    runId,
    modelSource: 'v1/models',
    baseUrl,
    fixture: args.fixture,
    profile: args.profile || 'custom-har',
    selectedModels: selected,
  }
  const reportPath = `backup/har/chat2api-model-matrix-${runId}.json`
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2))
  console.log(reportPath)
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exit(1)
})
```

- [ ] **Step 4: Update matrix skill usage section**

Append to `skills/chat2api-provider-model-matrix/SKILL.md`:

````markdown
## Commands

```bash
CHAT2API_BASE_URL=http://127.0.0.1:8080 \
CHAT2API_MGMT_SECRET=mgmt_xxx \
CHAT2API_API_KEY=sk_xxx \
node skills/chat2api-provider-model-matrix/scripts/run-model-matrix.mjs \
  --fixture backup/har/cherry-studio-fixture.json \
  --profile cherry-studio
```

The default model source is `GET /v1/models`. Use `--provider`, `--model`, and `--fail-fast-provider N` to narrow live runs.
````

- [ ] **Step 5: Run test to verify it passes**

Run:

```bash
node --test tests/skills/chat2api-provider-model-matrix.test.mjs
```

Expected: pass.

- [ ] **Step 6: Commit**

```bash
git add skills/chat2api-provider-model-matrix tests/skills/chat2api-provider-model-matrix.test.mjs
git commit -m "feat: add v1 models matrix testing skill"
```

---

### Task 6: Migration From Ignored `.codex` Skill

**Files:**
- Modify: `skills/chat2api-proxy-testing/SKILL.md`
- Modify: `.codex/skills/chat2api-proxy-testing/SKILL.md`
- Test: `tests/skills/chat2api-proxy-testing-skill.test.mjs`

- [ ] **Step 1: Extend test to enforce versioned source of truth**

Append to `tests/skills/chat2api-proxy-testing-skill.test.mjs`:

```js
test('versioned proxy testing skill warns against ignored local source of truth', () => {
  const text = fs.readFileSync('skills/chat2api-proxy-testing/SKILL.md', 'utf8')
  assert.match(text, /versioned source of truth/)
  assert.match(text, /ignored \.codex/)
})
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
node --test tests/skills/chat2api-proxy-testing-skill.test.mjs
```

Expected: fails because warning text is not present.

- [ ] **Step 3: Update versioned proxy testing skill**

Append to `skills/chat2api-proxy-testing/SKILL.md`:

```markdown
## Source Of Truth

The versioned source of truth is this `skills/chat2api-proxy-testing` directory plus the focused sibling skills. Ignored `.codex` copies are local working copies only and must not be the only place where testing behavior is documented.
```

- [ ] **Step 4: Update ignored local skill as a pointer**

Append to `.codex/skills/chat2api-proxy-testing/SKILL.md`:

```markdown
## Versioned Skill Migration

The durable testing skill set now lives under `skills/`. Treat this ignored `.codex` copy as local convenience only.
```

- [ ] **Step 5: Run test to verify it passes**

Run:

```bash
node --test tests/skills/chat2api-proxy-testing-skill.test.mjs
```

Expected: pass.

- [ ] **Step 6: Commit**

```bash
git add skills/chat2api-proxy-testing tests/skills/chat2api-proxy-testing-skill.test.mjs
git commit -m "docs: mark versioned proxy testing skill as source of truth"
```

---

### Task 7: End-To-End Verification

**Files:**
- No production file changes.

- [ ] **Step 1: Run skill tests**

Run:

```bash
node --test tests/skills/*.test.mjs
```

Expected: all tests pass.

- [ ] **Step 2: Run existing tool-calling source tests**

Run:

```bash
node --test tests/tool-calling/*.test.ts
```

Expected: all tests pass. Existing `MODULE_TYPELESS_PACKAGE_JSON` warnings may appear and are not introduced by this plan.

- [ ] **Step 3: Run dry-run script checks**

Run:

```bash
CHAT2API_MGMT_SECRET=mgmt_example \
node skills/chat2api-management-api/scripts/management-api.mjs snapshot --dry-run

node skills/chat2api-har-tool-fixture/scripts/extract-har-fixtures.mjs \
  --har backup/har/Cherry-Studio.har \
  --client cherry-studio \
  --out /private/tmp/chat2api-cherry-fixture.json

CHAT2API_API_KEY=sk_example \
node skills/chat2api-tool-client-replay/scripts/replay-client-fixture.mjs \
  --fixture /private/tmp/chat2api-cherry-fixture.json \
  --profile cherry-studio \
  --model deepseek-v4-flash \
  --dry-run

node skills/chat2api-provider-model-matrix/scripts/run-model-matrix.mjs \
  --fixture /private/tmp/chat2api-cherry-fixture.json \
  --profile cherry-studio \
  --provider deepseek \
  --dry-run
```

Expected:

- management dry-run masks the management secret;
- HAR extraction writes `/private/tmp/chat2api-cherry-fixture.json`;
- replay dry-run masks API key;
- matrix dry-run reports `modelSource: "v1/models"`.

- [ ] **Step 4: Check git status**

Run:

```bash
git status --short
```

Expected: clean except intentionally ignored generated files under `/private/tmp` or `backup/har`.

- [ ] **Step 5: Commit any final documentation fixes**

If dry-run output requires wording updates, commit them:

```bash
git add skills tests/skills
git commit -m "docs: finalize Chat2API testing skills"
```

If no fixes were needed, do not create an empty commit.

---

## Self-Review

Spec coverage:

- Multiple clients: Task 4 creates profiles and replay runner.
- Generic HAR ingestion: Task 3 creates `chat2api-har-tool-fixture`.
- Management API as first-class Skill: Task 2 creates `chat2api-management-api`.
- `/v1/models` default: Task 5 tests and implements matrix discovery marker.
- Attribution and cleanup: Tasks 2 and 5 document and scaffold management-based workflow.
- No destructive cleanup: Tasks 1, 2, and 7 enforce no default session clearing.
- Versioned skills: Tasks 1 and 6 move durable docs under `skills/`.

Placeholder scan:

- No incomplete-marker or deferred-work steps remain.
- Each code-producing task includes concrete file content.
- Each task includes exact commands and expected outcomes.

Type and name consistency:

- Skill names match directory names.
- Script paths match tests and usage docs.
- Environment variable names are consistent across tasks.
