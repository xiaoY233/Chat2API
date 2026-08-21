import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'fs'
import { join } from 'path'
import type { Context } from 'koa'
import { getRuntime } from '../../runtime'

export const GEMINI_FILE_TTL_MS = 48 * 60 * 60 * 1000

export interface GeminiStoredFile {
  id: string
  name: string
  uri: string
  displayName: string
  mimeType: string
  sizeBytes: number
  createTime: string
  expirationTime: string
  path: string
  state: 'PROCESSING' | 'ACTIVE' | 'FAILED'
}

interface PendingUpload {
  id: string
  displayName: string
  mimeType: string
  sizeBytes: number
  offset: number
  createdAt: number
  path: string
}

function randomId(): string {
  return 'xxxxxxxxxxxx4xxxyxxxxxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = Math.floor(Math.random() * 16)
    const v = c === 'x' ? r : (r & 0x3) | 0x8
    return v.toString(16)
  })
}

function safeFileName(value: string): string {
  return value.replace(/[\\/:*?"<>|]/g, '_').replace(/\s+/g, ' ').trim() || 'upload'
}

function nowIso(): string {
  return new Date().toISOString()
}

function expiresIso(createdAt = Date.now()): string {
  return new Date(createdAt + GEMINI_FILE_TTL_MS).toISOString()
}

function geminiFileName(file: { id: string }): string {
  return `files/${file.id}`
}

function getBodyBuffer(ctx: Context): Buffer {
  const body = (ctx.request as any).rawBody || ctx.request.body
  if (Buffer.isBuffer(body)) {
    return body
  }

  if (typeof body === 'string') {
    return Buffer.from(body)
  }

  if (body === undefined || body === null) {
    return Buffer.alloc(0)
  }

  return Buffer.from(JSON.stringify(body))
}

export class GeminiFileStore {
  private readonly uploadDir: string
  private readonly pendingUploads = new Map<string, PendingUpload>()

  constructor() {
    this.uploadDir = join(getRuntime().getDataDir(), 'gemini-files')
  }

  ensureReady(): void {
    mkdirSync(this.uploadDir, { recursive: true })
  }

  createUploadSession(ctx: Context): GeminiStoredFile {
    this.ensureReady()

    const now = Date.now()
    const uploadProtocol = ctx.get('X-Goog-Upload-Protocol')
    const uploadCommand = ctx.get('X-Goog-Upload-Command')
    const mimeType = ctx.get('X-Goog-Upload-Header-Content-Type') || 'application/octet-stream'
    const sizeBytes = Number.parseInt(ctx.get('X-Goog-Upload-Header-Content-Length') || '0', 10) || 0
    const body = (ctx.request.body || {}) as any
    const bodyFile = body.file || {}
    const displayName = safeFileName(
      ctx.get('X-Goog-Upload-File-Name') || bodyFile.displayName || bodyFile.display_name || `upload-${randomId()}`,
    )
    const id = randomId()
    const filePath = join(this.uploadDir, `${id}-${displayName}`)

    if (uploadProtocol || uploadCommand) {
      // Official @google/genai resumable upload starts with these headers.
      if (uploadProtocol !== 'resumable' || !uploadCommand.includes('start')) {
        throw new Error('Unsupported Gemini upload command')
      }
    }

    const pending: PendingUpload = {
      id,
      displayName,
      mimeType,
      sizeBytes,
      offset: 0,
      createdAt: now,
      path: filePath,
    }
    this.pendingUploads.set(id, pending)

    ctx.set('X-Goog-Upload-URL', `${ctx.origin}/upload/v1beta/files/${id}`)
    ctx.set('X-Goog-Upload-Status', 'active')

    return this.toFile(pending, 'PROCESSING')
  }

  storeUploadChunk(uploadId: string, ctx: Context): GeminiStoredFile {
    this.ensureReady()

    const pending = this.pendingUploads.get(uploadId)
    if (!pending) {
      throw new Error(`Gemini upload session not found: ${uploadId}`)
    }

    const command = ctx.get('X-Goog-Upload-Command') || 'upload, finalize'
    const offset = Number.parseInt(ctx.get('X-Goog-Upload-Offset') || '0', 10) || 0
    if (offset !== pending.offset) {
      throw new Error(`Invalid Gemini upload offset: expected ${pending.offset}, got ${offset}`)
    }

    const chunk = getBodyBuffer(ctx)
    writeFileSync(pending.path, chunk, { flag: offset === 0 ? 'w' : 'a' })
    pending.offset += chunk.length

    const finalized = command.includes('finalize')
    if (finalized) {
      const sizeBytes = statSync(pending.path).size
      const stored = this.toFile({ ...pending, sizeBytes }, 'ACTIVE')
      this.pendingUploads.delete(uploadId)
      ctx.set('X-Goog-Upload-Status', 'final')
      return stored
    }

    ctx.set('X-Goog-Upload-Status', 'active')
    return this.toFile(pending, 'PROCESSING')
  }

  createSimpleFile(ctx: Context): GeminiStoredFile {
    this.ensureReady()

    const body = (ctx.request.body || {}) as any
    const bodyFile = body.file || {}
    const id = randomId()
    const file = { id }
    const displayName = safeFileName(bodyFile.displayName || bodyFile.display_name || `upload-${id}`)
    const mimeType = bodyFile.mimeType || bodyFile.mime_type || ctx.get('Content-Type') || 'application/octet-stream'
    const filePath = join(this.uploadDir, `${id}-${displayName}`)
    const data = bodyFile.data ? Buffer.from(String(bodyFile.data), 'base64') : getBodyBuffer(ctx)
    writeFileSync(filePath, data)

    return {
      id,
      name: geminiFileName(file),
      uri: geminiFileName(file),
      displayName,
      mimeType,
      sizeBytes: statSync(filePath).size,
      createTime: nowIso(),
      expirationTime: expiresIso(),
      path: filePath,
      state: 'ACTIVE',
    }
  }

  getFile(nameOrUri: string): GeminiStoredFile | null {
    this.ensureReady()

    const id = this.extractId(nameOrUri)
    const filePath = this.findPathById(id)
    if (!filePath) {
      return null
    }

    const stat = statSync(filePath)
    const createdAt = stat.birthtimeMs || stat.ctimeMs
    if (Date.now() - createdAt > GEMINI_FILE_TTL_MS) {
      rmSync(filePath, { force: true })
      return null
    }

    const displayName = safeFileName(filePath.split(/[\\/]/).pop()?.replace(`${id}-`, '') || id)
    return {
      id,
      name: geminiFileName({ id }),
      uri: geminiFileName({ id }),
      displayName,
      mimeType: this.guessMimeType(displayName),
      sizeBytes: stat.size,
      createTime: new Date(createdAt).toISOString(),
      expirationTime: expiresIso(createdAt),
      path: filePath,
      state: 'ACTIVE',
    }
  }

  readFile(nameOrUri: string): { file: GeminiStoredFile; data: Buffer } | null {
    const file = this.getFile(nameOrUri)
    if (!file || !existsSync(file.path)) {
      return null
    }

    return { file, data: readFileSync(file.path) }
  }

  deleteFile(nameOrUri: string): boolean {
    const id = this.extractId(nameOrUri)
    const filePath = this.findPathById(id)
    if (!filePath) {
      return false
    }
    rmSync(filePath, { force: true })
    return true
  }

  private toFile(upload: PendingUpload, state: GeminiStoredFile['state']): GeminiStoredFile {
    return {
      id: upload.id,
      name: geminiFileName(upload),
      uri: geminiFileName(upload),
      displayName: upload.displayName,
      mimeType: upload.mimeType,
      sizeBytes: upload.sizeBytes,
      createTime: new Date(upload.createdAt).toISOString(),
      expirationTime: expiresIso(upload.createdAt),
      path: upload.path,
      state,
    }
  }

  private extractId(nameOrUri: string): string {
    return nameOrUri.replace(/^https?:\/\/[^/]+\//, '').replace(/^\/?v1beta\//, '').replace(/^files\//, '')
  }

  private findPathById(id: string): string | null {
    if (!existsSync(this.uploadDir)) {
      return null
    }
    const { readdirSync } = require('fs') as typeof import('fs')
    const match = readdirSync(this.uploadDir).find((fileName) => fileName.startsWith(`${id}-`))
    return match ? join(this.uploadDir, match) : null
  }

  private guessMimeType(fileName: string): string {
    const lower = fileName.toLowerCase()
    if (lower.endsWith('.mp4')) return 'video/mp4'
    if (lower.endsWith('.mov')) return 'video/quicktime'
    if (lower.endsWith('.webm')) return 'video/webm'
    if (lower.endsWith('.mp3')) return 'audio/mpeg'
    if (lower.endsWith('.wav')) return 'audio/wav'
    if (lower.endsWith('.png')) return 'image/png'
    if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) return 'image/jpeg'
    if (lower.endsWith('.pdf')) return 'application/pdf'
    return 'application/octet-stream'
  }
}

export const geminiFileStore = new GeminiFileStore()
