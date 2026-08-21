import { existsSync, readFileSync } from 'fs'
import { extname, join, normalize, resolve, sep } from 'path'
import type Koa from 'koa'

const CONTENT_TYPES: Record<string, string> = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
}

function resolveAdminDir(): string {
  return resolve(process.cwd(), 'out-admin')
}

function isInside(baseDir: string, targetPath: string): boolean {
  const normalizedBase = normalize(baseDir + sep)
  const normalizedTarget = normalize(targetPath)
  return normalizedTarget.startsWith(normalizedBase)
}

function sendFile(ctx: Koa.Context, filePath: string): void {
  ctx.type = CONTENT_TYPES[extname(filePath)] || 'application/octet-stream'
  ctx.body = readFileSync(filePath)
}

export function mountWebAdminAssets(app: Koa): void {
  app.use(async (ctx, next) => {
    if (ctx.path === '/admin') {
      ctx.redirect('/admin/')
      return
    }

    if (!ctx.path.startsWith('/admin/')) {
      await next()
      return
    }

    const adminDir = resolveAdminDir()
    const indexPath = join(adminDir, 'admin.html')

    if (!existsSync(indexPath)) {
      ctx.status = 503
      ctx.body = {
        error: {
          message: 'Web admin assets are not built. Run npm run build:admin.',
          type: 'admin_assets_missing',
        },
      }
      return
    }

    const rawPath = decodeURIComponent(ctx.path.slice('/admin/'.length))
    const relativePath = rawPath || 'admin.html'
    const assetPath = join(adminDir, relativePath)

    if (isInside(adminDir, assetPath) && existsSync(assetPath)) {
      sendFile(ctx, assetPath)
      return
    }

    sendFile(ctx, indexPath)
  })
}
