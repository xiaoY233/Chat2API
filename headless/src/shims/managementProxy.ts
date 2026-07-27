import Router from '@koa/router'
import type { Context } from 'koa'
import { managementAuthMiddleware } from '../../../src/main/proxy/middleware/managementAuth.ts'
import { proxyStatusManager } from '../../../src/main/proxy/status.ts'

const router = new Router({ prefix: '/v0/management/proxy' })
router.use(managementAuthMiddleware)

router.get('/status', async (ctx: Context) => {
  ctx.body = { success: true, data: proxyStatusManager.getRunningStatus() }
})

async function rejectLifecycleRequest(ctx: Context): Promise<void> {
  ctx.status = 409
  ctx.body = {
    success: false,
    error: {
      code: 'container_lifecycle_required',
      message: 'Use docker compose restart/stop to control the headless service',
    },
  }
}

router.post('/start', rejectLifecycleRequest)
router.post('/stop', rejectLifecycleRequest)
router.post('/restart', rejectLifecycleRequest)

export default router
