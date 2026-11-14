import test from 'node:test'
import assert from 'node:assert/strict'

import chatRouter from '../../src/main/proxy/routes/chat.ts'
import { loadBalancer } from '../../src/main/proxy/loadbalancer.ts'
import { modelMapper } from '../../src/main/proxy/modelMapper.ts'
import { modelAvailability } from '../../src/main/proxy/modelAvailability.ts'
import { requestForwarder } from '../../src/main/proxy/forwarder.ts'
import { storeManager } from '../../src/main/store/store.ts'

type Handler = (ctx: any, next: () => Promise<void>) => Promise<void>

function chatCompletionHandler(): Handler {
  const layer = (chatRouter as any).stack.find(
    (candidate: any) =>
      candidate.methods.includes('POST') &&
      candidate.path === '/v1/chat/completions',
  )
  assert.ok(layer, 'POST /v1/chat/completions handler is registered')
  return layer.stack[layer.stack.length - 1]
}

async function runRoute(result: Record<string, unknown>) {
  const originalSelect = loadBalancer.selectAccount
  const originalPreferredProvider = modelMapper.getPreferredProvider
  const originalPreferredAccount = modelMapper.getPreferredAccount
  const originalFindGate = modelAvailability.findGate
  const originalForward = requestForwarder.forwardChatCompletion
  const originalGetConfig = storeManager.getConfig
  const originalAddLog = storeManager.addLog
  const originalAddRequestLog = storeManager.addRequestLog
  const originalRecordStats = storeManager.recordRequestInStats

  try {
    const account = {
      id: 'acc-route',
      providerId: 'qwen-ai',
      name: 'route',
      credentials: { token: 'x' },
      status: 'active',
    }
    const provider = { id: 'qwen-ai', name: 'Qwen AI (International)' }

    ;(loadBalancer as any).selectAccount = () => ({
      account,
      provider,
      actualModel: 'qwen3.8-max',
    })
    ;(modelMapper as any).getPreferredProvider = () => undefined
    ;(modelMapper as any).getPreferredAccount = () => undefined
    ;(modelAvailability as any).findGate = () => undefined
    ;(storeManager as any).getConfig = () => ({ loadBalanceStrategy: 'round-robin' })
    ;(storeManager as any).addLog = () => undefined
    ;(storeManager as any).addRequestLog = () => undefined
    ;(storeManager as any).recordRequestInStats = () => undefined
    ;(requestForwarder as any).forwardChatCompletion = async () => result

    const headers: Record<string, string> = {}
    const ctx: any = {
      request: {
        body: {
          model: 'Qwen3.8-Max',
          stream: false,
          messages: [{ role: 'user', content: 'hi' }],
        },
      },
      headers: {},
      ip: '127.0.0.1',
      status: 200,
      body: undefined,
      set(field: string, value: string) {
        headers[field.toLowerCase()] = value
      },
    }

    await chatCompletionHandler()(ctx, async () => {})
    return { ctx, headers }
  } finally {
    ;(loadBalancer as any).selectAccount = originalSelect
    ;(modelMapper as any).getPreferredProvider = originalPreferredProvider
    ;(modelMapper as any).getPreferredAccount = originalPreferredAccount
    ;(modelAvailability as any).findGate = originalFindGate
    ;(requestForwarder as any).forwardChatCompletion = originalForward
    ;(storeManager as any).getConfig = originalGetConfig
    ;(storeManager as any).addLog = originalAddLog
    ;(storeManager as any).addRequestLog = originalAddRequestLog
    ;(storeManager as any).recordRequestInStats = originalRecordStats
  }
}

test('a Qwen captcha cooldown answers 503 + Retry-After instead of hanging', async () => {
  const { ctx, headers } = await runRoute({
    success: false,
    status: 503,
    code: 'waf_captcha',
    retryAfter: 90,
    error:
      'Qwen AI is cooling down after an Aliyun WAF captcha (bxpunish); ' +
      'the account is temporarily rate-limited. Retry in 90s.',
    latency: 3,
  })

  assert.equal(ctx.status, 503)
  assert.equal(headers['retry-after'], '90')
  assert.equal(ctx.body.error.type, 'service_unavailable_error')
  assert.equal(ctx.body.error.code, 'waf_captcha')
  assert.match(ctx.body.error.message, /cooling down/i)
})

test('a revoked Qwen session answers 401 with an actionable error', async () => {
  const { ctx } = await runRoute({
    success: false,
    status: 401,
    code: 'account_session_expired',
    error: 'Qwen AI session expired or was revoked. Sign in again in the account settings to renew it.',
    latency: 2,
  })

  assert.equal(ctx.status, 401)
  assert.equal(ctx.body.error.type, 'authentication_error')
  assert.equal(ctx.body.error.code, 'account_session_expired')
  assert.match(ctx.body.error.message, /sign in again/i)
})
