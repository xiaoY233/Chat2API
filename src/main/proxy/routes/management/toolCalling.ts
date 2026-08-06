import Router from '@koa/router'
import type { Context } from 'koa'
import ConfigManager from '../../../store/config'
import { managementAuthMiddleware } from '../../middleware/managementAuth'
import {
  buildSmokeFixture,
  getLatestToolCallingSmokeResult,
  setLatestToolCallingSmokeResult,
} from '../../toolCalling/diagnostics'
import type { ManagementApiResponse } from '../../../../shared/types'
import type { ToolClientAdapterId } from '../../../../shared/toolCalling'

const router = new Router({ prefix: '/v0/management/tool-calling' })

router.use(managementAuthMiddleware)

router.get('/status', async (ctx: Context) => {
  const config = ConfigManager.get()

  ctx.body = {
    success: true,
    data: {
      config: config.toolCallingConfig,
      latestSmokeResult: getLatestToolCallingSmokeResult(),
    },
  } as ManagementApiResponse
})

router.post('/smoke', async (ctx: Context) => {
  const body = ctx.request.body as { clientAdapterId?: ToolClientAdapterId }
  const config = ConfigManager.get()
  const clientAdapterId = body.clientAdapterId ?? config.toolCallingConfig.clientAdapterId
  const fixture = buildSmokeFixture(clientAdapterId)

  const result = setLatestToolCallingSmokeResult({
    success: true,
    category: 'pass',
    message: 'Smoke fixture generated. Send it through /v1/chat/completions with a mapped model to run a live provider smoke.',
    clientAdapterId,
    timestamp: Date.now(),
  })

  ctx.body = {
    success: true,
    data: {
      result,
      fixture,
    },
  } as ManagementApiResponse
})

export default router
