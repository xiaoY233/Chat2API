#!/usr/bin/env node

import { createInterface } from 'node:readline'
import { getManagementSecret } from './keyManager.ts'

type JsonObject = Record<string, any>

const PROVIDER_FIELDS: Record<string, Array<{ name: string; label: string; required: boolean; secret: boolean }>> = {
  deepseek: [{ name: 'token', label: 'DeepSeek User Token', required: true, secret: true }],
  glm: [{ name: 'refresh_token', label: 'GLM refresh_token', required: true, secret: true }],
  zai: [
    { name: 'token', label: 'Z.ai JWT Token', required: true, secret: true },
    { name: 'captcha_verify_param', label: 'captcha_verify_param', required: false, secret: true },
  ],
  kimi: [{ name: 'token', label: 'Kimi kimi-auth/JWT Token', required: true, secret: true }],
  minimax: [
    { name: 'token', label: 'MiniMax JWT Token or realUserID+JWTtoken', required: true, secret: true },
    { name: 'realUserID', label: 'MiniMax Real User ID', required: false, secret: false },
  ],
}

const args = process.argv.slice(2)
const command = args[0] || 'help'
const baseUrl = `http://127.0.0.1:${process.env.CHAT2API_PORT || '8080'}`

function option(name: string): string | undefined {
  const index = args.indexOf(`--${name}`)
  return index >= 0 ? args[index + 1] : undefined
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk))
  return Buffer.concat(chunks).toString('utf8')
}

function ask(prompt: string, hidden = false): Promise<string> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error('Interactive input requires a TTY; use --stdin for scripted account creation')
  }

  const readline = createInterface({ input: process.stdin, output: process.stdout, terminal: true })
  if (hidden) {
    const internal = readline as typeof readline & { _writeToOutput?: (value: string) => void }
    internal._writeToOutput = value => {
      if (value.includes(prompt)) process.stdout.write(value)
    }
  }

  return new Promise(resolve => {
    readline.question(prompt, answer => {
      readline.close()
      if (hidden) process.stdout.write('\n')
      resolve(answer.trim())
    })
  })
}

async function request(path: string, options: RequestInit = {}, useManagementAuth = true): Promise<JsonObject> {
  const headers = new Headers(options.headers)
  headers.set('Content-Type', 'application/json')
  if (useManagementAuth) headers.set('Authorization', `Bearer ${getManagementSecret()}`)

  const response = await fetch(`${baseUrl}${path}`, { ...options, headers })
  const text = await response.text()
  let body: any = text
  try {
    body = text ? JSON.parse(text) : null
  } catch {
    // Preserve non-JSON upstream errors for diagnostics.
  }

  if (!response.ok) {
    const detail = typeof body === 'string' ? body : JSON.stringify(body)
    throw new Error(`${options.method || 'GET'} ${path} failed (${response.status}): ${detail}`)
  }
  return body
}

function print(value: unknown): void {
  console.log(JSON.stringify(value, null, 2))
}

function requireValidCredentials(response: JsonObject): void {
  if (response?.data?.valid === false) {
    throw new Error(response.data.error || 'Provider rejected the account credentials')
  }
}

async function status(): Promise<void> {
  const [health, management] = await Promise.all([
    request('/health', {}, false),
    request('/v0/management/health'),
  ])
  print({ health, management })
}

async function list(path: string): Promise<void> {
  print(await request(path))
}

async function buildInteractiveAccount(providerId: string): Promise<JsonObject> {
  const fields = PROVIDER_FIELDS[providerId]
  if (!fields) throw new Error(`Unsupported provider: ${providerId}`)

  const name = option('name') || await ask('Account name: ')
  if (!name) throw new Error('Account name is required')

  return { providerId, name, credentials: await buildInteractiveCredentials(providerId) }
}

async function buildInteractiveCredentials(providerId: string): Promise<Record<string, string>> {
  const fields = PROVIDER_FIELDS[providerId]
  if (!fields) throw new Error(`Unsupported provider: ${providerId}`)

  const credentials: Record<string, string> = {}
  for (const field of fields) {
    const value = await ask(`${field.label}${field.required ? '' : ' (optional)'}: `, field.secret)
    if (field.required && !value) throw new Error(`${field.name} is required`)
    if (value) credentials[field.name] = value
  }

  return credentials
}

async function addAccount(): Promise<void> {
  let payload: JsonObject
  if (args.includes('--stdin')) {
    const input = await readStdin()
    payload = JSON.parse(input)
  } else {
    const providerId = args[2]
    if (!providerId) throw new Error('Usage: chat2api-ctl account add <provider> [--name NAME]')
    payload = await buildInteractiveAccount(providerId)
  }

  if (!PROVIDER_FIELDS[payload.providerId]) {
    throw new Error(`Unsupported provider: ${payload.providerId}`)
  }

  const created = await request('/v0/management/accounts', {
    method: 'POST',
    body: JSON.stringify(payload),
  })
  print(created)

  const accountId = created?.data?.id
  if (accountId && !args.includes('--no-validate')) {
    const validation = await request(`/v0/management/accounts/${encodeURIComponent(accountId)}/validate`, {
      method: 'POST',
    })
    print({ validation: validation.data })
    requireValidCredentials(validation)
  }
}

async function validateAccount(): Promise<void> {
  const id = args[2]
  if (!id) throw new Error('Usage: chat2api-ctl account validate <account-id>')
  const validation = await request(`/v0/management/accounts/${encodeURIComponent(id)}/validate`, { method: 'POST' })
  print(validation)
  requireValidCredentials(validation)
}

async function updateAccount(): Promise<void> {
  const id = args[2]
  if (!id) throw new Error('Usage: chat2api-ctl account update <account-id> [--stdin]')

  const existing = await request(`/v0/management/accounts/${encodeURIComponent(id)}`)
  const providerId = existing?.data?.providerId
  if (!PROVIDER_FIELDS[providerId]) throw new Error(`Unsupported provider: ${providerId}`)

  let credentials: Record<string, string>
  if (args.includes('--stdin')) {
    const value = JSON.parse(await readStdin())
    credentials = value.credentials || value
  } else {
    credentials = await buildInteractiveCredentials(providerId)
  }

  print(await request(`/v0/management/accounts/${encodeURIComponent(id)}`, {
    method: 'PUT',
    body: JSON.stringify({ credentials }),
  }))

  if (!args.includes('--no-validate')) {
    const validation = await request(`/v0/management/accounts/${encodeURIComponent(id)}/validate`, { method: 'POST' })
    print(validation)
    requireValidCredentials(validation)
  }
}

async function deleteAccount(): Promise<void> {
  const id = args[2]
  if (!id) throw new Error('Usage: chat2api-ctl account delete <account-id>')
  print(await request(`/v0/management/accounts/${encodeURIComponent(id)}`, { method: 'DELETE' }))
}

async function createApiKey(): Promise<void> {
  const name = option('name') || 'primary'
  const previousConfig = await request('/v0/management/config/enableApiKey')
  const previousEnabled = previousConfig?.data === true
  const created = await request('/v0/management/api-keys', {
    method: 'POST',
    body: JSON.stringify({ name, description: 'Created by chat2api-ctl' }),
  })
  const apiKey = created?.data?.key
  const apiKeyId = created?.data?.id
  if (!apiKey) throw new Error('Management API did not return the new API key')

  try {
    await request('/v0/management/config/enableApiKey', {
      method: 'PUT',
      body: JSON.stringify({ value: true }),
    })

    const verification = await fetch(`${baseUrl}/v1/models`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    })
    if (!verification.ok) {
      throw new Error(`The new API key failed verification (${verification.status})`)
    }
  } catch (error) {
    if (apiKeyId) {
      await request(`/v0/management/api-keys/${encodeURIComponent(apiKeyId)}`, { method: 'DELETE' })
        .catch(() => undefined)
    }
    await request('/v0/management/config/enableApiKey', {
      method: 'PUT',
      body: JSON.stringify({ value: previousEnabled }),
    }).catch(() => undefined)
    throw error
  }

  console.error('Store this API key now. It will only be shown in full once.')
  print({ id: created.data.id, name: created.data.name, key: apiKey })
}

async function snapshot(): Promise<void> {
  const [health, providers, accounts, config] = await Promise.all([
    request('/health', {}, false),
    request('/v0/management/providers/'),
    request('/v0/management/accounts'),
    request('/v0/management/config/'),
  ])
  print({ health, providers: providers.data, accounts: accounts.data, config: config.data })
}

function help(): void {
  console.log(`Chat2API Headless management CLI

Commands:
  status
  providers
  accounts
  account add <deepseek|glm|zai|kimi|minimax> [--name NAME] [--no-validate]
  account add --stdin [--no-validate]
  account update <account-id> [--stdin] [--no-validate]
  account validate <account-id>
  account delete <account-id>
  api-key create [--name NAME]
  api-key list
  snapshot
`)
}

async function main(): Promise<void> {
  if (command === 'status') return status()
  if (command === 'providers') return list('/v0/management/providers/')
  if (command === 'accounts') return list('/v0/management/accounts')
  if (command === 'account' && args[1] === 'add') return addAccount()
  if (command === 'account' && args[1] === 'update') return updateAccount()
  if (command === 'account' && args[1] === 'validate') return validateAccount()
  if (command === 'account' && args[1] === 'delete') return deleteAccount()
  if (command === 'api-key' && args[1] === 'create') return createApiKey()
  if (command === 'api-key' && args[1] === 'list') return list('/v0/management/api-keys')
  if (command === 'snapshot') return snapshot()
  help()
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
})
