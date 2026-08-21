import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, renameSync, statSync, writeFileSync } from 'fs'
import { createHash } from 'crypto'
import axios, { type AxiosInstance, type AxiosResponse } from 'axios'
import OSS from 'ali-oss'
import mime from 'mime-types'
import path from 'path'
import type { ChatMessage, ChatMessageContent } from '../types.ts'
import { getProviderToolProfile } from '../toolCalling/providerProfiles.ts'
import {
  getManagedToolDocumentPrompt,
  isManagedToolPromptMessage,
} from '../toolCalling/managedPromptMetadata.ts'
import { getRuntime } from '../../runtime/index.ts'

const QWEN_AI_BASE = 'https://chat.qwen.ai'
const MAX_FILE_SIZE = 2000 * 1024 * 1024
const OSS_SINGLE_PUT_MAX_BYTES = positiveIntegerFromEnv('QWEN_AI_OSS_SINGLE_PUT_MAX_BYTES', 2 * 1024 * 1024)
const OSS_UPLOAD_TIMEOUT_MS = positiveIntegerFromEnv('QWEN_AI_OSS_UPLOAD_TIMEOUT_MS', 5 * 60 * 1000)
const OSS_UPLOAD_RETRY_MAX = positiveIntegerFromEnv('QWEN_AI_OSS_UPLOAD_RETRY_MAX', 3)
const OSS_STS_REFRESH_INTERVAL_MS = positiveIntegerFromEnv('QWEN_AI_OSS_STS_REFRESH_INTERVAL_MS', 4 * 60 * 1000)
const QWEN_AI_FILE_CACHE_ENABLED = process.env.QWEN_AI_FILE_CACHE_ENABLED !== 'false'
const QWEN_AI_FILE_CACHE_TTL_MS = positiveIntegerFromEnv('QWEN_AI_FILE_CACHE_TTL_MS', 47 * 60 * 60 * 1000)
const QWEN_AI_FILE_CACHE_MAX_ENTRIES = positiveIntegerFromEnv('QWEN_AI_FILE_CACHE_MAX_ENTRIES', 512)
const QWEN_AI_DIRECT_UPLOAD_SESSION_TTL_MS = positiveIntegerFromEnv('QWEN_AI_DIRECT_UPLOAD_SESSION_TTL_MS', 60 * 60 * 1000)
const QWEN_AI_DIRECT_FILE_MAX_ENTRIES = positiveIntegerFromEnv('QWEN_AI_DIRECT_FILE_MAX_ENTRIES', 512)
const DOCUMENT_EVIDENCE_MAX_TEXT_BYTES = positiveIntegerFromEnv('QWEN_AI_DOCUMENT_EVIDENCE_MAX_TEXT_BYTES', 32 * 1024 * 1024)
const DOCUMENT_EVIDENCE_MAX_TOTAL_CHARS = positiveIntegerFromEnv('QWEN_AI_DOCUMENT_EVIDENCE_MAX_TOTAL_CHARS', 24000)
const DOCUMENT_EVIDENCE_MAX_PER_FILE_CHARS = positiveIntegerFromEnv('QWEN_AI_DOCUMENT_EVIDENCE_MAX_PER_FILE_CHARS', 12000)
const DOCUMENT_EVIDENCE_MAX_CANDIDATES = positiveIntegerFromEnv('QWEN_AI_DOCUMENT_EVIDENCE_MAX_CANDIDATES', 256)
const DOCUMENT_EVIDENCE_SNIPPET_CHARS = 1600

export const QWEN_AI_DOCUMENT_EVIDENCE_MARKER = '[Attached document evidence]'

const TEXT_DOCUMENT_MIME_TYPES = new Set([
  'application/csv',
  'application/json',
  'application/ld+json',
  'application/markdown',
  'application/toml',
  'application/x-ndjson',
  'application/x-toml',
  'application/x-www-form-urlencoded',
  'application/x-yaml',
  'application/xml',
  'application/yaml',
])

const TEXT_DOCUMENT_EXTENSIONS = new Set([
  '.conf',
  '.csv',
  '.env',
  '.ini',
  '.json',
  '.jsonl',
  '.log',
  '.markdown',
  '.md',
  '.properties',
  '.text',
  '.toml',
  '.tsv',
  '.txt',
  '.xml',
  '.yaml',
  '.yml',
])

const COMMON_QUERY_TERMS = new Set([
  'about',
  'above',
  'after',
  'again',
  'also',
  'and',
  'any',
  'are',
  'argument',
  'arguments',
  'attached',
  'below',
  'call',
  'content',
  'document',
  'documents',
  'exactly',
  'file',
  'files',
  'for',
  'from',
  'function',
  'get',
  'has',
  'have',
  'into',
  'invoke',
  'json',
  'must',
  'need',
  'only',
  'output',
  'please',
  'request',
  'response',
  'schema',
  'should',
  'that',
  'the',
  'them',
  'this',
  'tool',
  'tools',
  'use',
  'using',
  'value',
  'with',
  'you',
  'your',
])

const KEY_VALUE_LINE_PATTERN = /^\s*["']?[A-Za-z][A-Za-z0-9_.-]{1,80}["']?\s*[:=]\s*\S.{0,1200}$/i
const PATH_VALUE_PATTERN = /(?:^|[\s"'=:[({,])(?:[A-Za-z]:[\\/]|\/|\.{1,2}\/|~\/)[^\s"'<>`),;\]}]{2,500}/i
const PATH_VALUE_CONTEXT_PATTERN = /(?:^|[\s"'=:[({,])(?:[A-Za-z]:[\\/]|\/|\.{1,2}\/|~\/)[^\s"'<>`),;\]}]{2,500}/gi
const KEY_VALUE_CONTEXT_PATTERN = /["']?[A-Za-z][A-Za-z0-9_.-]{1,80}["']?\s*[:=]\s*(?:"[^"\n]{1,500}"|'[^'\n]{1,500}'|[^\s,}\]\n]{1,500})/g

type HeaderFactory = () => Record<string, string>
type QwenPostWithRetry = (
  url: string,
  payload: unknown,
  createOptions: () => Record<string, any>,
) => Promise<AxiosResponse>

type QwenFileClass = 'vision' | 'document' | 'audio' | 'video'
type QwenCoarseFileType = 'image' | 'file' | 'audio' | 'video'
export const QWEN_AI_DIRECT_FILE_SCHEME = 'qwen-ai-direct://'

interface NormalizedInputFile {
  data?: Buffer
  localPath?: string
  localMtimeMs?: number
  /** Stable identity for in-memory or downloaded content. */
  contentHash?: string
  sizeBytes: number
  filename: string
  mimeType: string
  sourceUrl?: string
  coarseType: QwenCoarseFileType
  fileClass: QwenFileClass
}

interface QwenStsInfo {
  accessKeyId: string
  accessKeySecret: string
  securityToken?: string
  bucket: string
  region: string
  endpoint: string
  fileId: string
  filePath: string
  fileUrl: string
}

export interface PreparedQwenAiMessage {
  content: string
  files: any[]
  transport: QwenAiMessageTransport
  managedDocumentMode?: QwenAiManagedDocumentMode
  transcriptUtf8Bytes: number
  inlineUtf8Bytes: number
}

export type QwenAiMessageTransport = 'inline' | 'document'
export type QwenAiManagedDocumentMode = 'hybrid' | 'complete'

export interface QwenAiFileOperationOptions {
  signal?: AbortSignal
  deadlineAt?: number
}

export interface PrepareQwenAiMultimodalMessageOptions extends QwenAiFileOperationOptions {
  transport?: QwenAiMessageTransport
  managedToolCalling?: boolean
  workflowContinuation?: boolean
  /** Force the managed document layout. Undefined starts hybrid and escalates when needed. */
  managedDocumentMode?: QwenAiManagedDocumentMode
  /** Target for automatic document offload. Zero disables automatic offload. */
  requestMaxBytes?: number
}

export interface QwenAiFileUploadPartOptions extends QwenAiFileOperationOptions {
  includeEvidence?: boolean
}

interface QwenAiDocumentEvidence {
  filename: string
  mimeType: string
  textBytes: number
  truncated: boolean
  snippets: string[]
}

interface UploadedQwenAiPart {
  file: any
  evidence?: QwenAiDocumentEvidence
}

interface QwenAiFileCacheScope {
  providerId?: string
  accountId?: string
}

interface QwenAiFileCacheRecord {
  key: string
  providerId: string
  accountId: string
  localPath?: string
  localMtimeMs?: number
  contentHash?: string
  sizeBytes: number
  filename: string
  mimeType: string
  coarseType: QwenCoarseFileType
  fileClass: QwenFileClass
  file: any
  createdAt: number
  lastUsedAt: number
}

export interface QwenAiDirectUploadInput {
  filename?: string
  mimeType?: string
  mime_type?: string
  sizeBytes?: number
  size_bytes?: number
  clientFileKey?: string
  client_file_key?: string
}

interface QwenAiDirectFileRecord {
  id: string
  name: string
  uri: string
  providerId: string
  accountId: string
  clientFileKey?: string
  filename: string
  mimeType: string
  sizeBytes: number
  coarseType: QwenCoarseFileType
  fileClass: QwenFileClass
  file: any
  createdAt: number
  lastUsedAt: number
}

interface QwenAiDirectUploadPendingSession {
  sessionId: string
  providerId: string
  accountId: string
  clientFileKey?: string
  file: NormalizedInputFile
  sts: QwenStsInfo
  createdAt: number
  expiresAt: number
}

export interface QwenAiDirectUploadStartResult {
  reused: boolean
  file: any
  qwen: {
    providerId: string
    accountId: string
    fileId: string
  }
  upload?: {
    sessionId: string
    accessKeyId: string
    accessKeySecret: string
    securityToken?: string
    bucket: string
    region: string
    endpoint: string
    fileId: string
    filePath: string
    fileUrl: string
    authVersion: 'v4'
    partSize: number
    parallel: number
    expiresAt: string
  }
}

interface DocumentCandidateSnippet {
  priority: number
  position: number
  label: string
  text: string
}

interface CandidateInput {
  priority: number
  position: number
  label: string
  start: number
  end: number
}

function qwenOssMultipartParams(fileSize: number): { parallel: number; partSize: number } {
  if (fileSize < 5 * 1024 * 1024) {
    return { parallel: 2, partSize: 2 * 1024 * 1024 }
  }

  if (fileSize < 10 * 1024 * 1024) {
    return { parallel: 4, partSize: 2 * 1024 * 1024 }
  }

  if (fileSize < 50 * 1024 * 1024) {
    return { parallel: 6, partSize: 6 * 1024 * 1024 }
  }

  if (fileSize < 100 * 1024 * 1024) {
    return { parallel: 8, partSize: 8 * 1024 * 1024 }
  }

  return { parallel: 10, partSize: 10 * 1024 * 1024 }
}

function qwenOssDirectMultipartParams(fileSize: number): { parallel: number; partSize: number } {
  const base = qwenOssMultipartParams(fileSize)
  if (fileSize < 100 * 1024 * 1024) {
    return base
  }

  return {
    parallel: boundedPositiveIntegerFromEnv('QWEN_AI_DIRECT_UPLOAD_PARALLEL', 12, 1, 16),
    partSize: boundedPositiveIntegerFromEnv('QWEN_AI_DIRECT_UPLOAD_PART_SIZE_MIB', 16, 5, 32) * 1024 * 1024,
  }
}

function positiveIntegerFromEnv(name: string, fallback: number): number {
  const raw = process.env[name]
  if (!raw) {
    return fallback
  }

  const parsed = Number(raw)
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback
}

function qwenAiFileParsePollIntervalMsFromEnv(): number {
  return positiveIntegerFromEnv('QWEN_AI_FILE_PARSE_POLL_INTERVAL_MS', 2000)
}

function qwenAiFileParseTimeoutMsFromEnv(): number {
  return positiveIntegerFromEnv('QWEN_AI_FILE_PARSE_TIMEOUT_MS', 120000)
}

function boundedPositiveIntegerFromEnv(name: string, fallback: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, positiveIntegerFromEnv(name, fallback)))
}

function uuid(): string {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0
    const v = c === 'x' ? r : (r & 0x3) | 0x8
    return v.toString(16)
  })
}

type QwenAiFileOperationError = Error & {
  status?: number
  code?: string
  retryable?: boolean
  accountFault?: boolean
  retryScope?: 'next-account'
}

const MAX_TIMER_DELAY_MS = 2_147_483_647

function operationDeadlineAt(options: QwenAiFileOperationOptions): number | undefined {
  return Number.isFinite(options.deadlineAt) ? options.deadlineAt : undefined
}

function createQwenAiFileDeadlineError(): QwenAiFileOperationError {
  const error = new Error('Qwen AI request deadline exceeded during file processing.') as QwenAiFileOperationError
  error.status = 504
  error.code = 'qwen_ai_request_timeout'
  error.retryable = false
  error.accountFault = false
  return error
}

function createQwenAiFileAbortError(): QwenAiFileOperationError {
  const error = new Error('Qwen AI file processing was cancelled by the client.') as QwenAiFileOperationError
  error.name = 'AbortError'
  error.status = 499
  error.code = 'ERR_CANCELED'
  error.retryable = false
  error.accountFault = false
  return error
}

function createQwenAiFileParseTimeoutError(
  timeoutMs: number,
  lastStatus: string,
): QwenAiFileOperationError {
  const statusDetail = lastStatus ? ` (last status: ${lastStatus})` : ''
  const error = new Error(
    `Qwen AI file parse timed out after ${timeoutMs}ms${statusDetail}`,
  ) as QwenAiFileOperationError
  error.status = 504
  error.code = 'qwen_ai_file_parse_timeout'
  error.retryable = false
  error.accountFault = false
  error.retryScope = 'next-account'
  return error
}

function throwIfQwenAiFileOperationStopped(options: QwenAiFileOperationOptions): void {
  if (options.signal?.aborted) {
    throw createQwenAiFileAbortError()
  }

  const deadlineAt = operationDeadlineAt(options)
  if (deadlineAt !== undefined && Date.now() >= deadlineAt) {
    throw createQwenAiFileDeadlineError()
  }
}

function normalizeQwenAiFileOperationError(
  error: unknown,
  options: QwenAiFileOperationOptions,
): unknown {
  if ((error as QwenAiFileOperationError | undefined)?.code === 'qwen_ai_request_timeout') {
    return error
  }
  if ((error as QwenAiFileOperationError | undefined)?.code === 'ERR_CANCELED') {
    return error
  }
  if (options.signal?.aborted) {
    return createQwenAiFileAbortError()
  }
  const deadlineAt = operationDeadlineAt(options)
  if (deadlineAt !== undefined && Date.now() >= deadlineAt) {
    return createQwenAiFileDeadlineError()
  }
  return error
}

function qwenAiFileOperationTimeout(
  configuredTimeoutMs: number,
  options: QwenAiFileOperationOptions,
): number {
  throwIfQwenAiFileOperationStopped(options)
  const safeConfiguredTimeoutMs = Number.isFinite(configuredTimeoutMs) && configuredTimeoutMs > 0
    ? Math.max(1, Math.floor(configuredTimeoutMs))
    : 1
  const deadlineAt = operationDeadlineAt(options)
  if (deadlineAt === undefined) {
    return safeConfiguredTimeoutMs
  }
  return Math.max(1, Math.min(safeConfiguredTimeoutMs, deadlineAt - Date.now()))
}

function waitForQwenAiFileOperation<T>(
  operation: Promise<T>,
  options: QwenAiFileOperationOptions,
  cancelOperation?: () => void,
): Promise<T> {
  try {
    throwIfQwenAiFileOperationStopped(options)
  } catch (error) {
    cancelOperation?.()
    return Promise.reject(error)
  }

  const deadlineAt = operationDeadlineAt(options)
  if (!options.signal && deadlineAt === undefined) {
    return operation
  }

  return new Promise<T>((resolve, reject) => {
    let settled = false
    let deadlineTimer: NodeJS.Timeout | undefined

    const cleanup = () => {
      if (deadlineTimer) {
        clearTimeout(deadlineTimer)
        deadlineTimer = undefined
      }
      options.signal?.removeEventListener('abort', onAbort)
    }
    const finish = (callback: () => void) => {
      if (settled) return
      settled = true
      cleanup()
      callback()
    }
    const cancel = () => {
      try {
        cancelOperation?.()
      } catch {
        // The structured cancellation error remains authoritative.
      }
    }
    const onAbort = () => {
      cancel()
      finish(() => reject(createQwenAiFileAbortError()))
    }
    const scheduleDeadline = () => {
      if (deadlineAt === undefined || settled) return
      const remainingMs = deadlineAt - Date.now()
      if (remainingMs <= 0) {
        cancel()
        finish(() => reject(createQwenAiFileDeadlineError()))
        return
      }
      deadlineTimer = setTimeout(scheduleDeadline, Math.min(MAX_TIMER_DELAY_MS, remainingMs))
    }

    options.signal?.addEventListener('abort', onAbort, { once: true })
    scheduleDeadline()
    operation.then(
      value => {
        try {
          throwIfQwenAiFileOperationStopped(options)
          finish(() => resolve(value))
        } catch (error) {
          finish(() => reject(error))
        }
      },
      error => finish(() => reject(normalizeQwenAiFileOperationError(error, options))),
    )
  })
}

function delay(ms: number, options: QwenAiFileOperationOptions = {}): Promise<void> {
  let timer: NodeJS.Timeout | undefined
  const operation = new Promise<void>(resolve => {
    timer = setTimeout(resolve, Math.max(0, Math.min(MAX_TIMER_DELAY_MS, ms)))
  })
  return waitForQwenAiFileOperation(operation, options, () => {
    if (timer) clearTimeout(timer)
  })
}

function elapsedSeconds(startTime: number): string {
  return ((Date.now() - startTime) / 1000).toFixed(1)
}

function normalizeOssTargetPart(value: string): string {
  return value.trim().replace(/\/+$/, '').toLowerCase()
}

function hasSameOssTarget(left: QwenStsInfo, right: QwenStsInfo): boolean {
  return normalizeOssTargetPart(left.bucket) === normalizeOssTargetPart(right.bucket)
    && normalizeOssTargetPart(left.region) === normalizeOssTargetPart(right.region)
    && normalizeOssTargetPart(left.endpoint) === normalizeOssTargetPart(right.endpoint)
}

function safeCacheScope(scope?: QwenAiFileCacheScope): Required<QwenAiFileCacheScope> {
  return {
    providerId: scope?.providerId || 'unknown-provider',
    accountId: scope?.accountId || 'unknown-account',
  }
}

function qwenFileCachePath(): string {
  return path.join(getRuntime().getDataDir(), 'qwen-ai-file-cache.json')
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value))
}

function cloneCachedQwenFileItem(fileItem: any, file: NormalizedInputFile): any {
  const cloned = cloneJson(fileItem)
  const now = Date.now()

  cloned.itemId = uuid()
  cloned.name = file.filename
  cloned.size = file.sizeBytes
  cloned.filetype = file.coarseType
  cloned.file_type = file.mimeType
  cloned.showType = file.coarseType
  cloned.file_class = file.fileClass
  cloned.type = file.coarseType
  cloned.meta = {
    ...(cloned.meta || {}),
    name: file.filename,
    size: file.sizeBytes,
    content_type: file.mimeType,
  }

  cloned.file = {
    ...(cloned.file || {}),
    filename: file.filename,
    name: file.filename,
    size: file.sizeBytes,
    type: file.mimeType,
    update_at: now,
    meta: {
      ...(cloned.file?.meta || {}),
      name: file.filename,
      size: file.sizeBytes,
      content_type: file.mimeType,
    },
  }

  return cloned
}

class QwenAiFileCache {
  private records: Record<string, QwenAiFileCacheRecord> = {}
  private directFiles: Record<string, QwenAiDirectFileRecord> = {}
  private loaded = false

  createKey(scope: Required<QwenAiFileCacheScope>, file: NormalizedInputFile): string | null {
    if (!QWEN_AI_FILE_CACHE_ENABLED) {
      return null
    }

    if (file.contentHash) {
      return JSON.stringify([
        'qwen-ai-file-cache-content-v1',
        scope.providerId,
        scope.accountId,
        file.contentHash,
        file.sizeBytes,
        normalizeMimeType(file.mimeType),
        file.coarseType,
        file.fileClass,
      ])
    }

    if (!file.localPath || file.localMtimeMs === undefined) return null

    return JSON.stringify([
      'qwen-ai-file-cache-v1',
      scope.providerId,
      scope.accountId,
      path.resolve(file.localPath),
      file.localMtimeMs,
      file.sizeBytes,
      normalizeMimeType(file.mimeType),
      file.coarseType,
      file.fileClass,
    ])
  }

  get(key: string, scope: Required<QwenAiFileCacheScope>, file: NormalizedInputFile): any | null {
    this.load()

    const record = this.records[key]
    if (!record) {
      return null
    }

    const expired = Date.now() - record.createdAt > QWEN_AI_FILE_CACHE_TTL_MS
    const sourceChanged = file.contentHash
      ? record.contentHash !== file.contentHash
      : !file.localPath
        || file.localMtimeMs === undefined
        || record.localPath !== path.resolve(file.localPath)
        || record.localMtimeMs !== file.localMtimeMs
    const changed =
      record.providerId !== scope.providerId ||
      record.accountId !== scope.accountId ||
      sourceChanged ||
      record.sizeBytes !== file.sizeBytes ||
      normalizeMimeType(record.mimeType) !== normalizeMimeType(file.mimeType) ||
      record.coarseType !== file.coarseType ||
      record.fileClass !== file.fileClass

    if (expired || changed) {
      delete this.records[key]
      this.persist()
      return null
    }

    record.lastUsedAt = Date.now()
    this.persist()
    return cloneCachedQwenFileItem(record.file, file)
  }

  set(key: string, scope: Required<QwenAiFileCacheScope>, file: NormalizedInputFile, fileItem: any): void {
    if (!file.contentHash && (!file.localPath || file.localMtimeMs === undefined)) {
      return
    }

    this.load()

    const now = Date.now()
    this.records[key] = {
      key,
      providerId: scope.providerId,
      accountId: scope.accountId,
      localPath: file.localPath ? path.resolve(file.localPath) : undefined,
      localMtimeMs: file.localMtimeMs,
      contentHash: file.contentHash,
      sizeBytes: file.sizeBytes,
      filename: file.filename,
      mimeType: file.mimeType,
      coarseType: file.coarseType,
      fileClass: file.fileClass,
      file: cloneJson(fileItem),
      createdAt: now,
      lastUsedAt: now,
    }

    this.prune()
    this.persist()
  }

  createClientFileKey(scope: Required<QwenAiFileCacheScope>, clientFileKey: string): string {
    return JSON.stringify([
      'qwen-ai-direct-file-cache-v1',
      scope.providerId,
      scope.accountId,
      clientFileKey,
    ])
  }

  getDirectByClientFileKey(clientFileKey: string): QwenAiDirectFileRecord | null {
    if (!clientFileKey) {
      return null
    }

    this.load()
    const now = Date.now()
    const match = Object.values(this.directFiles)
      .filter(record => record.clientFileKey === clientFileKey && now - record.createdAt <= QWEN_AI_FILE_CACHE_TTL_MS)
      .sort((a, b) => (b.lastUsedAt || b.createdAt || 0) - (a.lastUsedAt || a.createdAt || 0))[0]

    if (!match) {
      return null
    }

    match.lastUsedAt = now
    this.persist()
    return cloneJson(match)
  }

  getDirectByUri(uri: string): QwenAiDirectFileRecord | null {
    this.load()
    const id = extractDirectFileId(uri)
    const record = this.directFiles[id]
    if (!record) {
      return null
    }

    if (Date.now() - record.createdAt > QWEN_AI_FILE_CACHE_TTL_MS) {
      delete this.directFiles[id]
      this.persist()
      return null
    }

    record.lastUsedAt = Date.now()
    this.persist()
    return cloneJson(record)
  }

  setDirect(
    scope: Required<QwenAiFileCacheScope>,
    clientFileKey: string | undefined,
    file: NormalizedInputFile,
    fileItem: any,
  ): QwenAiDirectFileRecord {
    this.load()
    const now = Date.now()
    const id = uuid()
    const record: QwenAiDirectFileRecord = {
      id,
      name: `files/${id}`,
      uri: `${QWEN_AI_DIRECT_FILE_SCHEME}${id}`,
      providerId: scope.providerId,
      accountId: scope.accountId,
      clientFileKey,
      filename: file.filename,
      mimeType: file.mimeType,
      sizeBytes: file.sizeBytes,
      coarseType: file.coarseType,
      fileClass: file.fileClass,
      file: cloneJson(fileItem),
      createdAt: now,
      lastUsedAt: now,
    }

    if (clientFileKey) {
      for (const [existingId, existingRecord] of Object.entries(this.directFiles)) {
        if (existingRecord.clientFileKey === clientFileKey && existingRecord.accountId === scope.accountId) {
          delete this.directFiles[existingId]
        }
      }
    }

    this.directFiles[id] = record
    this.prune()
    this.persist()
    return cloneJson(record)
  }

  private load(): void {
    if (this.loaded) {
      return
    }

    this.loaded = true
    const filePath = qwenFileCachePath()
    if (!existsSync(filePath)) {
      return
    }

    try {
      const parsed = JSON.parse(readFileSync(filePath, 'utf8'))
      const records = parsed?.records
      if (records && typeof records === 'object' && !Array.isArray(records)) {
        this.records = records
      }
      const directFiles = parsed?.directFiles
      if (directFiles && typeof directFiles === 'object' && !Array.isArray(directFiles)) {
        this.directFiles = directFiles
      }
      this.prune()
    } catch {
      try {
        renameSync(filePath, `${filePath}.corrupted.${Date.now()}`)
      } catch {
      }
      this.records = {}
      this.directFiles = {}
    }
  }

  private prune(): void {
    const now = Date.now()
    for (const [key, record] of Object.entries(this.records)) {
      if (!record?.createdAt || now - record.createdAt > QWEN_AI_FILE_CACHE_TTL_MS) {
        delete this.records[key]
      }
    }
    for (const [key, record] of Object.entries(this.directFiles)) {
      if (!record?.createdAt || now - record.createdAt > QWEN_AI_FILE_CACHE_TTL_MS) {
        delete this.directFiles[key]
      }
    }

    const entries = Object.entries(this.records)
    if (entries.length <= QWEN_AI_FILE_CACHE_MAX_ENTRIES) {
      const directEntries = Object.entries(this.directFiles)
      if (directEntries.length <= QWEN_AI_DIRECT_FILE_MAX_ENTRIES) {
        return
      }

      directEntries
        .sort(([, a], [, b]) => (a.lastUsedAt || a.createdAt || 0) - (b.lastUsedAt || b.createdAt || 0))
        .slice(0, directEntries.length - QWEN_AI_DIRECT_FILE_MAX_ENTRIES)
        .forEach(([key]) => {
          delete this.directFiles[key]
        })
      return
    }

    entries
      .sort(([, a], [, b]) => (a.lastUsedAt || a.createdAt || 0) - (b.lastUsedAt || b.createdAt || 0))
      .slice(0, entries.length - QWEN_AI_FILE_CACHE_MAX_ENTRIES)
      .forEach(([key]) => {
        delete this.records[key]
      })

    const directEntries = Object.entries(this.directFiles)
    if (directEntries.length > QWEN_AI_DIRECT_FILE_MAX_ENTRIES) {
      directEntries
        .sort(([, a], [, b]) => (a.lastUsedAt || a.createdAt || 0) - (b.lastUsedAt || b.createdAt || 0))
        .slice(0, directEntries.length - QWEN_AI_DIRECT_FILE_MAX_ENTRIES)
        .forEach(([key]) => {
          delete this.directFiles[key]
        })
    }
  }

  private persist(): void {
    const filePath = qwenFileCachePath()
    const dir = path.dirname(filePath)
    mkdirSync(dir, { recursive: true })
    const tmpPath = `${filePath}.tmp`
    writeFileSync(tmpPath, `${JSON.stringify({ records: this.records, directFiles: this.directFiles }, null, 2)}\n`, 'utf8')
    renameSync(tmpPath, filePath)
  }
}

class QwenAiFileUploadCoordinator {
  private readonly pending = new Map<string, Promise<any>>()

  async run(
    key: string,
    operation: () => Promise<any>,
    options: QwenAiFileOperationOptions = {},
  ): Promise<any> {
    let sharedOperation = this.pending.get(key)
    if (sharedOperation) {
      console.log('[QwenAI][File] cache wait for in-flight upload')
      // A late waiter owns only its wait. Cancelling it must not cancel the
      // physical upload already owned by the first caller.
      return waitForQwenAiFileOperation(sharedOperation, options)
    }

    sharedOperation = Promise.resolve().then(operation).finally(() => {
      if (this.pending.get(key) === sharedOperation) {
        this.pending.delete(key)
      }
    })
    this.pending.set(key, sharedOperation)
    return waitForQwenAiFileOperation(sharedOperation, options)
  }
}

const qwenAiFileCache = new QwenAiFileCache()
const qwenAiFileUploadCoordinator = new QwenAiFileUploadCoordinator()
const qwenAiDirectUploadSessions = new Map<string, QwenAiDirectUploadPendingSession>()

function qwenAiDirectPublicFile(record: QwenAiDirectFileRecord): any {
  return {
    name: record.name,
    uri: record.uri,
    mimeType: record.mimeType,
    mime_type: record.mimeType,
    displayName: record.filename,
    display_name: record.filename,
    sizeBytes: record.sizeBytes,
    size_bytes: record.sizeBytes,
    state: 'ACTIVE',
    createTime: new Date(record.createdAt).toISOString(),
    expirationTime: new Date(record.createdAt + QWEN_AI_FILE_CACHE_TTL_MS).toISOString(),
    qwen: {
      providerId: record.providerId,
      accountId: record.accountId,
      fileId: record.file?.id || record.file?.file?.id || '',
    },
  }
}

function pruneQwenAiDirectUploadSessions(): void {
  const now = Date.now()
  for (const [sessionId, session] of qwenAiDirectUploadSessions.entries()) {
    if (session.expiresAt <= now) {
      qwenAiDirectUploadSessions.delete(sessionId)
    }
  }
}

function normalizeDirectUploadInput(input: QwenAiDirectUploadInput): NormalizedInputFile {
  const sizeBytes = Number(input.sizeBytes ?? input.size_bytes ?? 0)
  if (!Number.isFinite(sizeBytes) || sizeBytes <= 0) {
    throw new Error('Qwen AI direct upload requires positive sizeBytes')
  }

  const rawFilename = String(input.filename || `upload-${uuid()}`)
  const rawMimeType = String(input.mimeType || input.mime_type || mime.lookup(rawFilename) || 'application/octet-stream')
  const mimeType = normalizeMimeType(rawMimeType)
  const filename = ensureExtension(sanitizeFilename(rawFilename), mimeType)
  const classification = classifyFile(mimeType, mimeType.startsWith('video/') ? 'video_url' : mimeType.startsWith('image/') ? 'image_url' : 'file')

  return {
    sizeBytes,
    filename,
    mimeType,
    ...classification,
  }
}

function qwenDirectResultFromRecord(record: QwenAiDirectFileRecord): QwenAiDirectUploadStartResult {
  return {
    reused: true,
    file: qwenAiDirectPublicFile(record),
    qwen: {
      providerId: record.providerId,
      accountId: record.accountId,
      fileId: record.file?.id || record.file?.file?.id || '',
    },
  }
}

export function getQwenAiDirectUploadFile(uri: string): QwenAiDirectFileRecord | null {
  if (!isQwenAiDirectFileUrl(uri)) {
    return null
  }
  return qwenAiFileCache.getDirectByUri(uri)
}

export function getQwenAiDirectUploadSessionScope(sessionId: string): Required<QwenAiFileCacheScope> | null {
  pruneQwenAiDirectUploadSessions()
  const session = qwenAiDirectUploadSessions.get(sessionId)
  if (!session) {
    return null
  }
  return {
    providerId: session.providerId,
    accountId: session.accountId,
  }
}

function isDataUrl(url: string): boolean {
  return /^data:[^;,]+;base64,/i.test(url)
}

function isHttpUrl(url: string): boolean {
  return /^https?:\/\//i.test(url)
}

function isChat2ApiFileUrl(url: string): boolean {
  return /^chat2api-file:\/\//i.test(url)
}

function isQwenAiDirectFileUrl(url: string): boolean {
  return url.startsWith(QWEN_AI_DIRECT_FILE_SCHEME)
}

function extractDirectFileId(uri: string): string {
  return uri.replace(QWEN_AI_DIRECT_FILE_SCHEME, '').replace(/^\/+/, '')
}

function sanitizeFilename(filename: string): string {
  const cleaned = filename
    .replace(/[\\/:*?"<>|]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()

  return cleaned || `upload-${uuid()}`
}

function filenameFromUrl(url: string): string {
  try {
    const parsed = new URL(url)
    const base = path.posix.basename(decodeURIComponent(parsed.pathname))
    return sanitizeFilename(base || `upload-${uuid()}`)
  } catch {
    return `upload-${uuid()}`
  }
}

function filenameFromContentDisposition(header?: string): string | undefined {
  if (!header) {
    return undefined
  }

  const utf8Match = header.match(/filename\*=UTF-8''([^;]+)/i)
  if (utf8Match?.[1]) {
    return sanitizeFilename(decodeURIComponent(utf8Match[1]))
  }

  const asciiMatch = header.match(/filename="?([^";]+)"?/i)
  if (asciiMatch?.[1]) {
    return sanitizeFilename(asciiMatch[1])
  }

  return undefined
}

function ensureExtension(filename: string, mimeType: string): string {
  if (path.extname(filename)) {
    return filename
  }

  const ext = mime.extension(mimeType)
  return ext ? `${filename}.${ext}` : filename
}

function normalizeAudioMimeType(format?: string, explicitMimeType?: string): string {
  if (explicitMimeType) {
    return explicitMimeType
  }

  const normalizedFormat = format?.toLowerCase().replace(/^\./, '')
  if (!normalizedFormat) {
    return 'audio/wav'
  }

  if (normalizedFormat === 'mp3') {
    return 'audio/mpeg'
  }

  if (normalizedFormat === 'm4a') {
    return 'audio/x-m4a'
  }

  return mime.lookup(normalizedFormat) || `audio/${normalizedFormat}`
}

function parseDataUrlPayload(value: string): { mimeType?: string; base64: string } {
  const match = value.match(/^data:([^;,]+);base64,(.*)$/is)
  if (!match) {
    return { base64: value }
  }

  return {
    mimeType: match[1],
    base64: match[2],
  }
}

function classifyFile(mimeType: string, explicitType: ChatMessageContent['type']): Pick<NormalizedInputFile, 'coarseType' | 'fileClass'> {
  if (explicitType === 'image_url' || mimeType.startsWith('image/')) {
    return { coarseType: 'image', fileClass: 'vision' }
  }

  if (mimeType.startsWith('audio/')) {
    return { coarseType: 'audio', fileClass: 'audio' }
  }

  if (mimeType.startsWith('video/')) {
    return { coarseType: 'video', fileClass: 'video' }
  }

  return { coarseType: 'file', fileClass: 'document' }
}

function extractDataUrl(
  url: string,
  filename?: string,
  explicitMimeType?: string,
  explicitType?: ChatMessageContent['type'],
): NormalizedInputFile {
  const match = url.match(/^data:([^;,]+);base64,(.*)$/is)
  if (!match) {
    throw new Error('Unsupported data URL. Expected data:<mime>;base64,<content>.')
  }

  const mimeType = explicitMimeType || match[1] || 'application/octet-stream'
  const data = Buffer.from(match[2], 'base64')
  const rawFilename = filename || `upload-${uuid()}`
  const safeFilename = ensureExtension(sanitizeFilename(rawFilename), mimeType)
  const classification = classifyFile(mimeType, explicitType || (mimeType.startsWith('image/') ? 'image_url' : 'file'))

  return {
    data,
    contentHash: createHash('sha256').update(data).digest('hex'),
    sizeBytes: data.length,
    filename: safeFilename,
    mimeType,
    ...classification,
  }
}

function extractInputAudio(part: ChatMessageContent): NormalizedInputFile {
  const encodedData = part.input_audio?.data
  if (!encodedData) {
    throw new Error('Missing data for input_audio content part')
  }

  const parsedData = parseDataUrlPayload(encodedData)
  const mimeType = normalizeAudioMimeType(part.input_audio?.format, part.mime_type || parsedData.mimeType)
  const filename = ensureExtension(
    sanitizeFilename(part.filename || `input-audio-${uuid()}`),
    mimeType,
  )

  const data = Buffer.from(parsedData.base64, 'base64')
  return {
    data,
    contentHash: createHash('sha256').update(data).digest('hex'),
    sizeBytes: data.length,
    filename,
    mimeType,
    coarseType: 'audio',
    fileClass: 'audio',
  }
}

function extractLocalFile(part: ChatMessageContent): NormalizedInputFile {
  const localPath = part.local_path
  if (!localPath) {
    throw new Error('Missing local_path for Chat2API file content part')
  }

  const stat = statSync(localPath)
  if (!stat.isFile()) {
    throw new Error(`Chat2API local file is not a file: ${localPath}`)
  }

  const explicitMimeType = part.mime_type
  const filename = ensureExtension(
    sanitizeFilename(part.filename || path.basename(localPath)),
    explicitMimeType || mime.lookup(localPath) || 'application/octet-stream',
  )
  const mimeType = explicitMimeType || mime.lookup(filename) || 'application/octet-stream'
  const classification = classifyFile(String(mimeType), part.type)

  return {
    localPath,
    localMtimeMs: stat.mtimeMs,
    sizeBytes: stat.size,
    filename,
    mimeType: String(mimeType),
    ...classification,
  }
}

function textFromContent(content: ChatMessage['content']): string {
  if (typeof content === 'string') {
    return content
  }

  if (Array.isArray(content)) {
    validateSupportedParts(content)
    return content
      .filter(part => part.type === 'text' && typeof part.text === 'string')
      .map(part => part.text)
      .join('')
  }

  return ''
}

function collectFileParts(content: ChatMessage['content']): ChatMessageContent[] {
  if (!Array.isArray(content)) {
    return []
  }

  validateSupportedParts(content)
  return content.filter(part => ['image_url', 'file', 'input_audio', 'video_url'].includes(part.type))
}

type QwenNestedToolResult = {
  toolCallId?: string
  content: string
  isError: boolean
}

function textFromUnknownContent(value: unknown): string {
  if (typeof value === 'string') return value
  if (!Array.isArray(value)) return ''

  return value
    .filter(part => qwenContentPartType(part) === 'text' && isObjectRecord(part) && typeof part.text === 'string')
    .map(part => (part as { text: string }).text)
    .join('')
}

function extractNestedQwenToolResults(content: ChatMessage['content']): QwenNestedToolResult[] {
  if (!Array.isArray(content)) return []

  return content
    .filter(part => qwenContentPartType(part) === 'tool_result' && isObjectRecord(part))
    .map(part => {
      const record = part as unknown as Record<string, unknown>
      const rawId = record.tool_call_id ?? record.tool_use_id
      return {
        toolCallId: typeof rawId === 'string' && rawId ? rawId : undefined,
        content: textFromUnknownContent(record.content) || (typeof record.content === 'string' ? record.content : ''),
        isError: record.is_error === true || record.isError === true,
      }
    })
}

function qwenFilePartIdentity(part: ChatMessageContent): string | undefined {
  const source = part.local_path
    || (part.type === 'input_audio'
      ? part.input_audio?.data
      : part.type === 'image_url'
        ? part.image_url?.url
        : part.type === 'file'
          ? part.file_url?.url
          : part.type === 'video_url'
            ? part.video_url?.url
            : undefined)
  if (typeof source !== 'string' || !source) return undefined

  // Avoid retaining very large data URLs as Set keys while keeping exact
  // identity for ordinary remote/local/direct sources.
  const sourceKey = source.length > 1024
    ? `sha256:${createHash('sha256').update(source).digest('hex')}`
    : source
  return JSON.stringify([
    part.type,
    sourceKey,
    part.type === 'input_audio' ? part.input_audio?.format || '' : '',
    part.local_path || '',
  ])
}

function deduplicateQwenFileParts(parts: ChatMessageContent[]): ChatMessageContent[] {
  const seen = new Set<string>()
  const retained: ChatMessageContent[] = []

  // Identical sources need only one upload, but do not impose a proxy-owned
  // attachment count limit on the caller's request.
  for (let index = parts.length - 1; index >= 0; index -= 1) {
    const part = parts[index]
    const identity = qwenFilePartIdentity(part)
    if (identity && seen.has(identity)) continue
    if (identity) seen.add(identity)
    retained.push(part)
  }

  return retained.reverse()
}

function formatRoleText(role: string, content: string): string {
  return content ? `${role}: ${content}` : `${role}:`
}

function nextLocalToolCallId(rawId: string, usedIds: Set<string>, fallbackIndex: number): string {
  const baseId = rawId || `call_history_${fallbackIndex}`
  if (!usedIds.has(baseId)) {
    usedIds.add(baseId)
    return baseId
  }

  let occurrence = 2
  while (usedIds.has(`${baseId}__${occurrence}`)) {
    occurrence += 1
  }
  const localId = `${baseId}__${occurrence}`
  usedIds.add(localId)
  return localId
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

function qwenContentPartType(value: unknown): string | undefined {
  if (!isObjectRecord(value) || typeof value.type !== 'string') {
    return undefined
  }
  return value.type
}

/** Anthropic bridges can represent a tool result in either supported form. */
function isQwenToolResultMessage(message: ChatMessage): boolean {
  if (message.role === 'tool' || Boolean(message.tool_call_id)) return true
  if (!Array.isArray(message.content)) return false

  return message.content.some(part => (
    qwenContentPartType(part) === 'tool_result'
  ))
}

function renderQwenAiTranscript(messages: ChatMessage[]): { content: string; fileParts: ChatMessageContent[] } {
  const transcriptMessages = messages
  const toolProfile = getProviderToolProfile('qwen-ai')
  const transcriptParts: string[] = []
  const fileParts: ChatMessageContent[] = []
  const usedLocalToolCallIds = new Set<string>()
  const pendingLocalIds = new Map<string, string[]>()
  // Qwen receives this transcript as one user prompt, so keep the system preamble near the active turn.
  const leadingSystemCount = transcriptMessages.findIndex(message => message.role !== 'system')
  const systemPreambleCount = leadingSystemCount === -1 ? transcriptMessages.length : leadingSystemCount
  let latestUserIndex = -1
  for (let index = transcriptMessages.length - 1; index >= systemPreambleCount; index -= 1) {
    if (transcriptMessages[index].role === 'user' && !isQwenToolResultMessage(transcriptMessages[index])) {
      latestUserIndex = index
      break
    }
  }
  const systemPreambleInsertionIndex = isQwenToolResultMessage(transcriptMessages.at(-1) || ({} as ChatMessage))
    ? transcriptMessages.length
    : latestUserIndex
  const relocateSystemPreamble = systemPreambleCount > 0
    && systemPreambleInsertionIndex >= systemPreambleCount
  const systemPreamble = relocateSystemPreamble
    ? transcriptMessages
        .slice(0, systemPreambleCount)
        .map(message => textFromContent(message.content))
        .filter(text => text.length > 0)
        .map(text => formatRoleText('System', text))
    : []
  let fallbackCallIndex = 0

  const appendToolResult = (rawToolCallId: string | undefined, resultText: string, isError: boolean) => {
    if (!rawToolCallId) {
      if (resultText) transcriptParts.push(formatRoleText('Tool', resultText))
      return
    }

    const pending = pendingLocalIds.get(rawToolCallId) ?? []
    const localId = pending[0] ?? rawToolCallId
    pendingLocalIds.set(rawToolCallId, pending.slice(1))
    transcriptParts.push(toolProfile.formatToolResult({
      toolCallId: localId,
      content: resultText,
      isError,
    }))
  }

  for (let messageIndex = 0; messageIndex < transcriptMessages.length; messageIndex += 1) {
    const msg = transcriptMessages[messageIndex]
    if (relocateSystemPreamble && messageIndex < systemPreambleCount) {
      continue
    }

    if (relocateSystemPreamble && messageIndex === systemPreambleInsertionIndex) {
      transcriptParts.push(...systemPreamble)
    }

    const text = textFromContent(msg.content)

    if (msg.role === 'system') {
      if (text) {
        transcriptParts.push(formatRoleText('System', text))
      }
      continue
    }

    if (msg.role === 'user') {
      const messageFileParts = collectFileParts(msg.content)
      fileParts.push(...messageFileParts)
      if (text || messageFileParts.length > 0) {
        transcriptParts.push(formatRoleText('User', text))
      }
      for (const nestedResult of extractNestedQwenToolResults(msg.content)) {
        appendToolResult(nestedResult.toolCallId, nestedResult.content, nestedResult.isError)
      }
      continue
    }

    if (msg.role === 'assistant') {
      const assistantParts: string[] = []
      if (text) {
        assistantParts.push(formatRoleText('Assistant', text))
      }
      if (msg.tool_calls?.length) {
        const transcriptCalls = msg.tool_calls.map((toolCall) => {
          fallbackCallIndex += 1
          const rawId = toolCall.id || `call_history_${fallbackCallIndex}`
          const localId = nextLocalToolCallId(rawId, usedLocalToolCallIds, fallbackCallIndex)
          const pending = pendingLocalIds.get(rawId) ?? []
          const transcriptCall = {
            localId,
            name: toolCall.function.name,
            arguments: toolCall.function.arguments,
          }

          pendingLocalIds.set(rawId, [...pending, localId])
          return {
            id: localId,
            name: transcriptCall.name,
            arguments: transcriptCall.arguments,
          }
        })
        assistantParts.push(toolProfile.formatAssistantToolCalls(transcriptCalls))
      }
      if (assistantParts.length > 0) {
        transcriptParts.push(assistantParts.join('\n'))
      }
      continue
    }

    if (msg.role === 'tool') {
      appendToolResult(msg.tool_call_id, text, msg.is_error === true)
    }
  }

  if (relocateSystemPreamble && systemPreambleInsertionIndex === transcriptMessages.length) {
    transcriptParts.push(...systemPreamble)
  }

  return {
    content: transcriptParts.join('\n\n'),
    fileParts: deduplicateQwenFileParts(fileParts),
  }
}

function buildQwenAiTranscript(messages: ChatMessage[]): { content: string; fileParts: ChatMessageContent[] } {
  return renderQwenAiTranscript(messages)
}

function partitionQwenAiManagedMessages(
  messages: ChatMessage[],
  workflowContinuation: boolean,
  documentMode: QwenAiManagedDocumentMode,
): {
  archiveMessages: ChatMessage[]
  activeMessages: ChatMessage[]
  toolReferenceContents: string[]
} {
  let leadingSystemCount = 0
  while (messages[leadingSystemCount]?.role === 'system') {
    leadingSystemCount += 1
  }

  const leadingSystemMessages = messages.slice(0, leadingSystemCount)
  const managedPromptMessages = leadingSystemMessages.filter(isManagedToolPromptMessage)
  const toolReferenceContents: string[] = []
  const inlineManagedPromptMessages = managedPromptMessages.map((message) => {
    const documentPrompt = getManagedToolDocumentPrompt(message)
    if (!documentPrompt) return message

    toolReferenceContents.push(documentPrompt.referenceContent)
    return { ...message, content: documentPrompt.content }
  })
  const ordinarySystemMessages = leadingSystemMessages.filter(message => (
    !isManagedToolPromptMessage(message)
  ))

  if (documentMode === 'complete') {
    return {
      archiveMessages: [
        ...ordinarySystemMessages,
        ...messages.slice(leadingSystemCount),
      ],
      activeMessages: inlineManagedPromptMessages,
      toolReferenceContents,
    }
  }

  let activeStartIndex = messages.length
  for (let index = messages.length - 1; index >= leadingSystemCount; index -= 1) {
    const message = messages[index]
    if (message.role === 'user' && !isQwenToolResultMessage(message)) {
      activeStartIndex = index
      break
    }
  }

  if (workflowContinuation) {
    let includedToolExchange = false
    for (let index = activeStartIndex - 1; index >= leadingSystemCount; index -= 1) {
      const message = messages[index]
      const isAssistantToolCall = message.role === 'assistant'
        && Boolean(message.tool_calls?.length)
      if (isQwenToolResultMessage(message) || isAssistantToolCall) {
        activeStartIndex = index
        includedToolExchange = true
        continue
      }
      if (
        includedToolExchange
        && message.role === 'user'
        && !isQwenToolResultMessage(message)
      ) {
        activeStartIndex = index
      }
      break
    }
  }

  const archiveMessages = [
    ...ordinarySystemMessages,
    ...messages.slice(leadingSystemCount, activeStartIndex),
  ]
  const activeMessages = [
    ...inlineManagedPromptMessages,
    ...messages.slice(activeStartIndex),
  ]
  return { archiveMessages, activeMessages, toolReferenceContents }
}

function renderQwenAiManagedDocumentContext(
  messages: ChatMessage[],
  documentMode: QwenAiManagedDocumentMode,
): string {
  const activeContext = renderQwenAiTranscript(messages).content
  if (!activeContext) return ''

  const label = documentMode === 'complete'
    ? 'Managed tool control'
    : 'Active managed tool context'
  return [
    documentMode === 'complete'
      ? 'Follow this inline managed-tool control and use the attached transcript for the complete conversation and current task.'
      : 'Follow this inline control context and use the attached transcript for the archived conversation context.',
    `[${label}]`,
    activeContext,
    `[/${label}]`,
  ].join('\n')
}

function qwenAiJsonStringUtf8Bytes(content: string): number {
  return Buffer.byteLength(JSON.stringify(content), 'utf8')
}

function validateSupportedParts(content: ChatMessageContent[]): void {
  for (const part of content) {
    const partType = qwenContentPartType(part)
    if (!['text', 'image_url', 'file', 'input_audio', 'video_url', 'tool_result'].includes(partType || '')) {
      throw new Error(`Unsupported Qwen AI message content part type: ${partType || 'unknown'}`)
    }
  }
}

function extractPartUrl(part: ChatMessageContent): string {
  if (part.type === 'image_url' && part.image_url?.url) {
    return part.image_url.url
  }

  if (part.type === 'file' && part.file_url?.url) {
    return part.file_url.url
  }

  if (part.type === 'video_url' && part.video_url?.url) {
    return part.video_url.url
  }

  throw new Error(`Missing URL for ${part.type} content part`)
}

function normalizeStsResponse(data: any): QwenStsInfo {
  const source = data?.data || data || {}

  const filePath = source.file_path || source.filePath || source.path || ''
  const fileId = source.file_id || source.fileId || source.id || ''
  const fileUrl = source.file_url || source.fileUrl || source.url || source.cdn_url || ''

  const sts: QwenStsInfo = {
    accessKeyId: source.access_key_id || source.accessKeyId || source.AccessKeyId || '',
    accessKeySecret: source.access_key_secret || source.accessKeySecret || source.AccessKeySecret || '',
    securityToken: source.security_token || source.securityToken || source.SecurityToken,
    bucket: source.bucketname || source.bucket || source.bucketName || '',
    region: source.region || '',
    endpoint: source.endpoint || '',
    fileId,
    filePath,
    fileUrl,
  }

  if (!sts.accessKeyId || !sts.accessKeySecret || !sts.bucket || !sts.endpoint || !sts.filePath || !sts.fileId) {
    throw new Error('Qwen AI upload STS response is missing required fields')
  }

  return sts
}

function createQwenFileItem(file: NormalizedInputFile, sts: QwenStsInfo): any {
  const now = Date.now()
  const fileUrl = sts.fileUrl || file.sourceUrl || ''
  const type = file.coarseType

  return {
    id: sts.fileId,
    itemId: uuid(),
    type,
    url: fileUrl,
    name: file.filename,
    collection_name: '',
    progress: 100,
    status: 'uploaded',
    greenNet: 'success',
    size: file.sizeBytes,
    error: '',
    filetype: file.coarseType,
    file_type: file.mimeType,
    showType: type,
    file_class: file.fileClass,
    uploadStatus: 'success',
    meta: {
      name: file.filename,
      size: file.sizeBytes,
      content_type: file.mimeType,
    },
    file: {
      created_at: now,
      data: {},
      filename: file.filename,
      hash: null,
      id: sts.fileId,
      user_id: '',
      meta: {
        name: file.filename,
        size: file.sizeBytes,
        content_type: file.mimeType,
      },
      update_at: now,
      name: file.filename,
      size: file.sizeBytes,
      type: file.mimeType,
      url: fileUrl,
    },
  }
}

function normalizeMimeType(mimeType: string): string {
  return mimeType.split(';')[0]?.trim().toLowerCase() || 'application/octet-stream'
}

function isTextDocument(file: NormalizedInputFile): boolean {
  if (file.fileClass !== 'document') {
    return false
  }

  const mimeType = normalizeMimeType(file.mimeType)
  if (mimeType.startsWith('text/') || TEXT_DOCUMENT_MIME_TYPES.has(mimeType)) {
    return true
  }

  return TEXT_DOCUMENT_EXTENSIONS.has(path.extname(file.filename).toLowerCase())
}

function readLocalEvidenceBytes(localPath: string, fileSize: number, byteLimit: number): Buffer {
  const fd = openSync(localPath, 'r')
  try {
    if (fileSize <= byteLimit) {
      const data = Buffer.alloc(fileSize)
      readSync(fd, data, 0, fileSize, 0)
      return data
    }

    const firstSize = Math.floor(byteLimit / 2)
    const lastSize = Math.ceil(byteLimit / 2)
    const first = Buffer.alloc(firstSize)
    const last = Buffer.alloc(lastSize)
    readSync(fd, first, 0, firstSize, 0)
    readSync(fd, last, 0, lastSize, Math.max(0, fileSize - lastSize))
    return Buffer.concat([
      first,
      Buffer.from('\n\n[... middle of document omitted from local evidence extraction ...]\n\n'),
      last,
    ])
  } finally {
    closeSync(fd)
  }
}

function readEvidenceData(file: NormalizedInputFile): { data: Buffer; truncated: boolean } {
  const byteLimit = Math.min(DOCUMENT_EVIDENCE_MAX_TEXT_BYTES, file.sizeBytes)
  const truncated = file.sizeBytes > byteLimit

  if (file.data) {
    const data = truncated
      ? Buffer.concat([
          file.data.subarray(0, Math.floor(byteLimit / 2)),
          Buffer.from('\n\n[... middle of document omitted from local evidence extraction ...]\n\n'),
          file.data.subarray(file.data.length - Math.ceil(byteLimit / 2)),
        ])
      : file.data
    return { data, truncated }
  }

  if (file.localPath) {
    return {
      data: readLocalEvidenceBytes(file.localPath, file.sizeBytes, byteLimit),
      truncated,
    }
  }

  return { data: Buffer.alloc(0), truncated }
}

function decodeEvidenceText(file: NormalizedInputFile): { text: string; truncated: boolean } | undefined {
  if (!isTextDocument(file)) {
    return undefined
  }

  const decoded = readEvidenceData(file)
  const text = decoded.data
    .toString('utf8')
    .replace(/\u0000/g, '')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')

  const suspiciousChars = (text.match(/\uFFFD/g) || []).length
  if (text.length > 0 && suspiciousChars / text.length > 0.02) {
    return undefined
  }

  return { text, truncated: decoded.truncated }
}

function uniqueTerms(values: string[]): string[] {
  const terms = new Set<string>()

  for (const value of values) {
    const normalized = value.toLowerCase()
    if (normalized.length < 3 || COMMON_QUERY_TERMS.has(normalized)) {
      continue
    }
    terms.add(normalized)
    if (terms.size >= 96) {
      break
    }
  }

  return [...terms]
}

function extractQueryTerms(queryText: string): string[] {
  const rawTokens = queryText.match(/[A-Za-z][A-Za-z0-9_.-]{2,80}|[\p{Script=Han}]{2,}/gu) || []
  const expanded = rawTokens.flatMap((token) => {
    const camelSplit = token.replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    return [
      token,
      ...camelSplit.split(/[^A-Za-z0-9\u4e00-\u9fff]+/u),
    ]
  })

  return uniqueTerms(expanded)
}

function trimSnippet(text: string, maxChars = DOCUMENT_EVIDENCE_SNIPPET_CHARS): string {
  const compact = text
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{4,}/g, '\n\n\n')
    .trim()

  if (compact.length <= maxChars) {
    return compact
  }

  return `${compact.slice(0, Math.max(0, maxChars - 15)).trimEnd()}\n[... truncated ...]`
}

function createWindowSnippet(text: string, start: number, end: number): string {
  const before = Math.max(0, start - Math.floor(DOCUMENT_EVIDENCE_SNIPPET_CHARS / 3))
  const after = Math.min(text.length, end + Math.floor(DOCUMENT_EVIDENCE_SNIPPET_CHARS / 2))
  const windowStart = text.lastIndexOf('\n', before)
  const windowEnd = text.indexOf('\n', after)
  const boundedStart = windowStart >= 0 ? windowStart + 1 : before
  const boundedEnd = windowEnd >= 0 ? windowEnd : after

  return trimSnippet(text.slice(boundedStart, boundedEnd))
}

function countTermMatches(lineLower: string, terms: string[]): number {
  return terms.reduce((count, term) => count + (lineLower.includes(term) ? 1 : 0), 0)
}

function isBetterCandidate(candidate: CandidateInput, existing: DocumentCandidateSnippet): boolean {
  return candidate.priority > existing.priority
    || (candidate.priority === existing.priority && candidate.position < existing.position)
}

function findWorstCandidateIndex(candidates: DocumentCandidateSnippet[]): number {
  let worstIndex = 0

  for (let index = 1; index < candidates.length; index += 1) {
    const candidate = candidates[index]
    const worst = candidates[worstIndex]
    if (
      candidate.priority < worst.priority
      || (candidate.priority === worst.priority && candidate.position > worst.position)
    ) {
      worstIndex = index
    }
  }

  return worstIndex
}

function pushBoundedCandidate(
  candidates: DocumentCandidateSnippet[],
  text: string,
  input: CandidateInput,
): void {
  if (candidates.length >= DOCUMENT_EVIDENCE_MAX_CANDIDATES) {
    const worstIndex = findWorstCandidateIndex(candidates)
    if (!isBetterCandidate(input, candidates[worstIndex])) {
      return
    }

    candidates[worstIndex] = {
      priority: input.priority,
      position: input.position,
      label: input.label,
      text: createWindowSnippet(text, input.start, input.end),
    }
    return
  }

  candidates.push({
    priority: input.priority,
    position: input.position,
    label: input.label,
    text: createWindowSnippet(text, input.start, input.end),
  })
}

function collectStructuredCandidates(text: string, terms: string[]): DocumentCandidateSnippet[] {
  const candidates: DocumentCandidateSnippet[] = []
  let lineStart = 0

  for (const match of text.matchAll(/[^\n]*(?:\n|$)/g)) {
    const rawLine = match[0]
    if (!rawLine) {
      break
    }

    const line = rawLine.replace(/\n$/, '')
    const lineEnd = lineStart + line.length
    const lineLower = line.toLowerCase()
    const termMatches = countTermMatches(lineLower, terms)
    const hasKeyValue = KEY_VALUE_LINE_PATTERN.test(line)
    const hasPathValue = PATH_VALUE_PATTERN.test(line)

    if (hasKeyValue || hasPathValue || termMatches > 0) {
      const priority = (hasPathValue ? 120 : 0)
        + (hasKeyValue ? 90 : 0)
        + Math.min(termMatches, 6) * 18
      pushBoundedCandidate(candidates, text, {
        priority,
        position: lineStart,
        label: hasKeyValue || hasPathValue ? 'structured excerpt' : 'matching excerpt',
        start: lineStart,
        end: lineEnd,
      })
    }

    lineStart = lineEnd + 1
    if (lineStart >= text.length) {
      break
    }
  }

  return candidates
}

function collectPathContextCandidates(text: string): DocumentCandidateSnippet[] {
  const candidates: DocumentCandidateSnippet[] = []

  for (const match of text.matchAll(PATH_VALUE_CONTEXT_PATTERN)) {
    const start = match.index ?? 0
    pushBoundedCandidate(candidates, text, {
      priority: 110,
      position: start,
      label: 'path-like excerpt',
      start,
      end: start + match[0].length,
    })
  }

  return candidates
}

function collectKeyValueContextCandidates(text: string, terms: string[]): DocumentCandidateSnippet[] {
  const candidates: DocumentCandidateSnippet[] = []

  for (const match of text.matchAll(KEY_VALUE_CONTEXT_PATTERN)) {
    const raw = match[0]
    const start = match.index ?? 0
    const priority = 95 + Math.min(countTermMatches(raw.toLowerCase(), terms), 6) * 18
    pushBoundedCandidate(candidates, text, {
      priority,
      position: start,
      label: 'key-value excerpt',
      start,
      end: start + raw.length,
    })
  }

  return candidates
}

function dedupeCandidates(candidates: DocumentCandidateSnippet[]): DocumentCandidateSnippet[] {
  const seen = new Set<string>()
  const unique: DocumentCandidateSnippet[] = []

  for (const candidate of candidates) {
    const key = candidate.text.replace(/\s+/g, ' ').slice(0, 500)
    if (!key || seen.has(key)) {
      continue
    }
    seen.add(key)
    unique.push(candidate)
  }

  return unique
}

function selectEvidenceSnippets(text: string, queryText: string): string[] {
  const terms = extractQueryTerms(queryText)
  const baseCandidates: DocumentCandidateSnippet[] = [
    {
      priority: 40,
      position: 0,
      label: 'document beginning',
      text: trimSnippet(text.slice(0, DOCUMENT_EVIDENCE_SNIPPET_CHARS)),
    },
    {
      priority: 35,
      position: Math.max(0, text.length - DOCUMENT_EVIDENCE_SNIPPET_CHARS),
      label: 'document ending',
      text: trimSnippet(text.slice(Math.max(0, text.length - DOCUMENT_EVIDENCE_SNIPPET_CHARS))),
    },
  ]
  const ranked = dedupeCandidates([
    ...baseCandidates,
    ...collectStructuredCandidates(text, terms),
    ...collectKeyValueContextCandidates(text, terms),
    ...collectPathContextCandidates(text),
  ]).sort((a, b) => (b.priority - a.priority) || (a.position - b.position))

  let usedChars = 0
  const selected: string[] = []

  for (const candidate of ranked) {
    if (!candidate.text) {
      continue
    }
    const rendered = `- ${candidate.label}:\n${candidate.text}`
    if (usedChars + rendered.length > DOCUMENT_EVIDENCE_MAX_PER_FILE_CHARS) {
      continue
    }
    selected.push(rendered)
    usedChars += rendered.length
    if (selected.length >= 12) {
      break
    }
  }

  return selected
}

function createDocumentEvidence(file: NormalizedInputFile, queryText: string): QwenAiDocumentEvidence | undefined {
  const decoded = decodeEvidenceText(file)
  if (!decoded) {
    return undefined
  }

  const snippets = selectEvidenceSnippets(decoded.text, queryText)
  if (snippets.length === 0) {
    return undefined
  }

  return {
    filename: file.filename,
    mimeType: normalizeMimeType(file.mimeType),
    textBytes: file.sizeBytes,
    truncated: decoded.truncated,
    snippets,
  }
}

function renderDocumentEvidence(evidences: QwenAiDocumentEvidence[]): string {
  let usedChars = 0
  const renderedDocuments: string[] = []

  for (const evidence of evidences) {
    const snippets = evidence.snippets.join('\n\n')
    const rendered = [
      `Document: ${evidence.filename}`,
      `MIME: ${evidence.mimeType}; bytes: ${evidence.textBytes}; local evidence truncated: ${evidence.truncated ? 'yes' : 'no'}`,
      snippets,
    ].join('\n')

    if (usedChars + rendered.length > DOCUMENT_EVIDENCE_MAX_TOTAL_CHARS) {
      break
    }

    renderedDocuments.push(rendered)
    usedChars += rendered.length
  }

  if (renderedDocuments.length === 0) {
    return ''
  }

  return [
    QWEN_AI_DOCUMENT_EVIDENCE_MARKER,
    'The following excerpts are copied from attached text documents to keep relevant values near this request. Treat them as evidence from the attachments, not as generated tool arguments. Use only values that are present in the excerpts or the attached documents.',
    renderedDocuments.join('\n\n---\n\n'),
    '[/Attached document evidence]',
  ].join('\n')
}

export class QwenAiFileUploader {
  private readonly axiosInstance: AxiosInstance
  private readonly getHeaders: HeaderFactory
  private readonly postWithRefreshRetry?: QwenPostWithRetry
  private readonly cacheScope: Required<QwenAiFileCacheScope>

  constructor(
    axiosInstance: AxiosInstance,
    getHeaders: HeaderFactory,
    postWithRefreshRetry?: QwenPostWithRetry,
    cacheScope?: QwenAiFileCacheScope,
  ) {
    this.axiosInstance = axiosInstance
    this.getHeaders = getHeaders
    this.postWithRefreshRetry = postWithRefreshRetry
    this.cacheScope = safeCacheScope(cacheScope)
  }

  async uploadPart(
    part: ChatMessageContent,
    evidenceQueryText = '',
    options: QwenAiFileUploadPartOptions = {},
  ): Promise<UploadedQwenAiPart> {
    throwIfQwenAiFileOperationStopped(options)
    const startedAt = Date.now()
    console.log(`[QwenAI][File] resolve start type=${part.type}`)
    const directUrl = part.type === 'input_audio' ? '' : extractPartUrl(part)
    if (directUrl && isQwenAiDirectFileUrl(directUrl)) {
      const directRecord = qwenAiFileCache.getDirectByUri(directUrl)
      if (!directRecord) {
        throw new Error(`Qwen AI direct-upload file not found or expired: ${directUrl}`)
      }
      if (
        directRecord.providerId !== this.cacheScope.providerId ||
        directRecord.accountId !== this.cacheScope.accountId
      ) {
        throw new Error(
          `Qwen AI direct-upload file belongs to account ${directRecord.accountId}, but request used ${this.cacheScope.accountId}`,
        )
      }
      console.log(`[QwenAI][File] direct cache hit filename="${directRecord.filename}" bytes=${directRecord.sizeBytes} account=${this.cacheScope.accountId} totalSeconds=${elapsedSeconds(startedAt)}`)
      throwIfQwenAiFileOperationStopped(options)
      return { file: cloneJson(directRecord.file) }
    }

    const file = await this.resolveFile(part, options)
    throwIfQwenAiFileOperationStopped(options)
    console.log(`[QwenAI][File] resolve done seconds=${elapsedSeconds(startedAt)} filename="${file.filename}" bytes=${file.sizeBytes} mime=${file.mimeType} local=${file.localPath ? 'yes' : 'no'}`)

    if (file.sizeBytes > MAX_FILE_SIZE) {
      throw new Error(`Qwen AI file upload exceeds ${MAX_FILE_SIZE} bytes: ${file.filename}`)
    }

    const evidence = options.includeEvidence === false
      ? undefined
      : createDocumentEvidence(file, evidenceQueryText)
    throwIfQwenAiFileOperationStopped(options)
    const cacheKey = qwenAiFileCache.createKey(this.cacheScope, file)
    if (cacheKey) {
      const cached = qwenAiFileCache.get(cacheKey, this.cacheScope, file)
      if (cached) {
        console.log(`[QwenAI][File] cache hit filename="${file.filename}" bytes=${file.sizeBytes} account=${this.cacheScope.accountId} totalSeconds=${elapsedSeconds(startedAt)}`)
        throwIfQwenAiFileOperationStopped(options)
        return { file: cached, evidence }
      }
      console.log(`[QwenAI][File] cache miss filename="${file.filename}" bytes=${file.sizeBytes} account=${this.cacheScope.accountId}`)
      const uploadedFile = await qwenAiFileUploadCoordinator.run(
        cacheKey,
        () => this.uploadResolvedFile(file, startedAt, options),
        options,
      )
      throwIfQwenAiFileOperationStopped(options)
      qwenAiFileCache.set(cacheKey, this.cacheScope, file, uploadedFile)
      throwIfQwenAiFileOperationStopped(options)
      return {
        file: cloneCachedQwenFileItem(uploadedFile, file),
        evidence,
      }
    }

    const uploadedFile = await this.uploadResolvedFile(file, startedAt, options)
    throwIfQwenAiFileOperationStopped(options)
    return {
      file: uploadedFile,
      evidence,
    }
  }

  async startDirectUpload(
    input: QwenAiDirectUploadInput,
    options: QwenAiFileOperationOptions = {},
  ): Promise<QwenAiDirectUploadStartResult> {
    throwIfQwenAiFileOperationStopped(options)
    pruneQwenAiDirectUploadSessions()
    const startedAt = Date.now()
    const file = normalizeDirectUploadInput(input)
    const clientFileKey = String(input.clientFileKey || input.client_file_key || '').trim() || undefined

    if (file.sizeBytes > MAX_FILE_SIZE) {
      throw new Error(`Qwen AI file upload exceeds ${MAX_FILE_SIZE} bytes: ${file.filename}`)
    }

    if (clientFileKey) {
      const reused = qwenAiFileCache.getDirectByClientFileKey(clientFileKey)
      if (reused) {
        console.log(`[QwenAI][File] direct cache hit filename="${reused.filename}" bytes=${reused.sizeBytes} account=${reused.accountId} totalSeconds=${elapsedSeconds(startedAt)}`)
        return qwenDirectResultFromRecord(reused)
      }
      console.log(`[QwenAI][File] direct cache miss filename="${file.filename}" bytes=${file.sizeBytes} account=${this.cacheScope.accountId}`)
    }

    const stsStartedAt = Date.now()
    console.log(`[QwenAI][File] direct sts start filename="${file.filename}" bytes=${file.sizeBytes} type=${file.coarseType}`)
    const sts = await this.requestSts(file, options)
    throwIfQwenAiFileOperationStopped(options)
    console.log(`[QwenAI][File] direct sts done seconds=${elapsedSeconds(stsStartedAt)} fileId=${sts.fileId}`)

    const sessionId = uuid()
    const expiresAt = Date.now() + QWEN_AI_DIRECT_UPLOAD_SESSION_TTL_MS
    qwenAiDirectUploadSessions.set(sessionId, {
      sessionId,
      providerId: this.cacheScope.providerId,
      accountId: this.cacheScope.accountId,
      clientFileKey,
      file,
      sts,
      createdAt: Date.now(),
      expiresAt,
    })
    try {
      throwIfQwenAiFileOperationStopped(options)
    } catch (error) {
      qwenAiDirectUploadSessions.delete(sessionId)
      throw error
    }

    const multipartParams = qwenOssDirectMultipartParams(file.sizeBytes)
    return {
      reused: false,
      file: {
        name: `files/${sessionId}`,
        uri: `${QWEN_AI_DIRECT_FILE_SCHEME}${sessionId}`,
        mimeType: file.mimeType,
        mime_type: file.mimeType,
        displayName: file.filename,
        display_name: file.filename,
        sizeBytes: file.sizeBytes,
        size_bytes: file.sizeBytes,
        state: 'PROCESSING',
        createTime: new Date().toISOString(),
        expirationTime: new Date(expiresAt).toISOString(),
      },
      qwen: {
        providerId: this.cacheScope.providerId,
        accountId: this.cacheScope.accountId,
        fileId: sts.fileId,
      },
      upload: {
        sessionId,
        accessKeyId: sts.accessKeyId,
        accessKeySecret: sts.accessKeySecret,
        securityToken: sts.securityToken,
        bucket: sts.bucket,
        region: sts.region,
        endpoint: sts.endpoint,
        fileId: sts.fileId,
        filePath: sts.filePath,
        fileUrl: sts.fileUrl,
        authVersion: 'v4',
        partSize: multipartParams.partSize,
        parallel: multipartParams.parallel,
        expiresAt: new Date(expiresAt).toISOString(),
      },
    }
  }

  async completeDirectUpload(
    sessionId: string,
    options: QwenAiFileOperationOptions = {},
  ): Promise<any> {
    throwIfQwenAiFileOperationStopped(options)
    pruneQwenAiDirectUploadSessions()
    const session = qwenAiDirectUploadSessions.get(sessionId)
    if (!session) {
      throw new Error(`Qwen AI direct upload session not found or expired: ${sessionId}`)
    }

    const startedAt = Date.now()
    if (session.file.fileClass === 'document') {
      const parseStartedAt = Date.now()
      console.log(`[QwenAI][File] direct parse start fileId=${session.sts.fileId}`)
      await this.parseDocument(session.sts.fileId, options)
      console.log(`[QwenAI][File] direct parse done seconds=${elapsedSeconds(parseStartedAt)} fileId=${session.sts.fileId}`)
    }

    throwIfQwenAiFileOperationStopped(options)
    const fileItem = createQwenFileItem(session.file, session.sts)
    const record = qwenAiFileCache.setDirect(
      { providerId: session.providerId, accountId: session.accountId },
      session.clientFileKey,
      session.file,
      fileItem,
    )
    qwenAiDirectUploadSessions.delete(sessionId)
    throwIfQwenAiFileOperationStopped(options)
    console.log(`[QwenAI][File] direct upload complete totalSeconds=${elapsedSeconds(startedAt)} filename="${session.file.filename}" bytes=${session.file.sizeBytes} fileId=${session.sts.fileId}`)
    return qwenAiDirectPublicFile(record)
  }

  private async uploadResolvedFile(
    file: NormalizedInputFile,
    startedAt: number,
    options: QwenAiFileOperationOptions = {},
  ): Promise<any> {
    throwIfQwenAiFileOperationStopped(options)
    const stsStartedAt = Date.now()
    console.log(`[QwenAI][File] sts start filename="${file.filename}" bytes=${file.sizeBytes} type=${file.coarseType}`)
    const sts = await this.requestSts(file, options)
    throwIfQwenAiFileOperationStopped(options)
    console.log(`[QwenAI][File] sts done seconds=${elapsedSeconds(stsStartedAt)} fileId=${sts.fileId}`)

    const ossStartedAt = Date.now()
    console.log(`[QwenAI][File] oss upload start filename="${file.filename}" bytes=${file.sizeBytes} fileId=${sts.fileId}`)
    await this.uploadToOss(file, sts, options)
    throwIfQwenAiFileOperationStopped(options)
    console.log(`[QwenAI][File] oss upload done seconds=${elapsedSeconds(ossStartedAt)} filename="${file.filename}" bytes=${file.sizeBytes} fileId=${sts.fileId}`)

    if (file.fileClass === 'document') {
      const parseStartedAt = Date.now()
      console.log(`[QwenAI][File] parse start fileId=${sts.fileId}`)
      await this.parseDocument(sts.fileId, options)
      console.log(`[QwenAI][File] parse done seconds=${elapsedSeconds(parseStartedAt)} fileId=${sts.fileId}`)
    }

    throwIfQwenAiFileOperationStopped(options)
    const fileItem = createQwenFileItem(file, sts)
    console.log(`[QwenAI][File] upload complete totalSeconds=${elapsedSeconds(startedAt)} filename="${file.filename}" bytes=${file.sizeBytes} fileId=${sts.fileId}`)
    return fileItem
  }

  private async resolveFile(
    part: ChatMessageContent,
    options: QwenAiFileOperationOptions = {},
  ): Promise<NormalizedInputFile> {
    throwIfQwenAiFileOperationStopped(options)
    if (part.type === 'input_audio') {
      const file = extractInputAudio(part)
      throwIfQwenAiFileOperationStopped(options)
      return file
    }

    const url = extractPartUrl(part)
    const explicitFilename = part.filename
    const explicitMimeType = part.mime_type

    if (isChat2ApiFileUrl(url)) {
      const file = extractLocalFile(part)
      throwIfQwenAiFileOperationStopped(options)
      return file
    }

    if (isDataUrl(url)) {
      const file = extractDataUrl(url, explicitFilename, explicitMimeType, part.type)
      throwIfQwenAiFileOperationStopped(options)
      return file
    }

    if (!isHttpUrl(url)) {
      throw new Error(`Unsupported Qwen AI file URL scheme for ${part.type}`)
    }

    const response = await waitForQwenAiFileOperation(
      this.axiosInstance.get(url, {
        responseType: 'arraybuffer',
        maxContentLength: MAX_FILE_SIZE,
        maxBodyLength: MAX_FILE_SIZE,
        timeout: qwenAiFileOperationTimeout(60000, options),
        signal: options.signal,
        validateStatus: () => true,
      }),
      options,
    )
    throwIfQwenAiFileOperationStopped(options)

    if (response.status >= 400) {
      throw new Error(`Failed to download Qwen AI input file: HTTP ${response.status}`)
    }

    const headerFilename = filenameFromContentDisposition(response.headers?.['content-disposition'])
    const filename = sanitizeFilename(explicitFilename || headerFilename || filenameFromUrl(url))
    const mimeType = explicitMimeType || response.headers?.['content-type'] || mime.lookup(filename) || 'application/octet-stream'
    const safeFilename = ensureExtension(filename, mimeType)
    const classification = classifyFile(String(mimeType), part.type)

    const data = Buffer.from(response.data)
    return {
      data,
      contentHash: createHash('sha256').update(data).digest('hex'),
      sizeBytes: data.length,
      filename: safeFilename,
      mimeType: String(mimeType),
      sourceUrl: url,
      ...classification,
    }
  }

  private async requestSts(
    file: NormalizedInputFile,
    options: QwenAiFileOperationOptions = {},
  ): Promise<QwenStsInfo> {
    throwIfQwenAiFileOperationStopped(options)
    const response = await this.postJson(
      `${QWEN_AI_BASE}/api/v2/files/getstsToken`,
      {
        filename: file.filename,
        filesize: String(file.sizeBytes),
        filetype: file.coarseType,
      },
      () => ({
        headers: this.getHeaders(),
        timeout: 30000,
        validateStatus: () => true,
      }),
      options,
    )

    throwIfQwenAiFileOperationStopped(options)
    if (response.status >= 400) {
      throw new Error(`Qwen AI upload STS request failed: HTTP ${response.status}`)
    }

    return normalizeStsResponse(response.data)
  }

  private async uploadToOss(
    file: NormalizedInputFile,
    sts: QwenStsInfo,
    options: QwenAiFileOperationOptions = {},
  ): Promise<void> {
    throwIfQwenAiFileOperationStopped(options)
    const refreshOptions = sts.securityToken
      ? {
          refreshSTSToken: async () => {
            const refreshStartedAt = Date.now()
            console.log(`[QwenAI][File] sts refresh start filename="${file.filename}"`)
            const refreshed = await this.requestSts(file, options)
            if (!refreshed.securityToken) {
              throw new Error('Qwen AI refreshed upload STS response is missing its security token')
            }
            if (!hasSameOssTarget(sts, refreshed)) {
              throw new Error('Qwen AI refreshed upload STS target changed during the active upload')
            }
            console.log(`[QwenAI][File] sts refresh done seconds=${elapsedSeconds(refreshStartedAt)} filename="${file.filename}"`)
            return {
              accessKeyId: refreshed.accessKeyId,
              accessKeySecret: refreshed.accessKeySecret,
              stsToken: refreshed.securityToken,
            }
          },
          refreshSTSTokenInterval: OSS_STS_REFRESH_INTERVAL_MS,
        }
      : {}
    const uploadTimeoutMs = qwenAiFileOperationTimeout(OSS_UPLOAD_TIMEOUT_MS, options)
    const client = new OSS({
      accessKeyId: sts.accessKeyId,
      accessKeySecret: sts.accessKeySecret,
      stsToken: sts.securityToken,
      bucket: sts.bucket,
      region: sts.region,
      endpoint: sts.endpoint,
      authorizationV4: true,
      timeout: uploadTimeoutMs,
      retryMax: OSS_UPLOAD_RETRY_MAX,
      ...refreshOptions,
    } as any)

    const uploadOptions = {
      headers: {
        'Content-Type': file.mimeType,
      },
      timeout: uploadTimeoutMs,
      mime: file.mimeType,
    } as any

    const uploadSource = file.localPath || file.data
    if (!uploadSource) {
      throw new Error(`Qwen AI input file has no upload source: ${file.filename}`)
    }

    const upload = Promise.resolve().then(async () => {
      if (file.sizeBytes < OSS_SINGLE_PUT_MAX_BYTES) {
        await client.put(sts.filePath, uploadSource, uploadOptions)
        return
      }

      const multipartParams = qwenOssMultipartParams(file.sizeBytes)
      await client.multipartUpload(sts.filePath, uploadSource, {
        ...uploadOptions,
        ...multipartParams,
      })
    })
    await waitForQwenAiFileOperation(upload, options, () => {
      if (typeof (client as any).cancel === 'function') {
        ;(client as any).cancel()
      }
    })
    throwIfQwenAiFileOperationStopped(options)
  }

  private async parseDocument(
    fileId: string,
    options: QwenAiFileOperationOptions = {},
  ): Promise<void> {
    throwIfQwenAiFileOperationStopped(options)
    const parseResponse = await this.postJson(
      `${QWEN_AI_BASE}/api/v2/files/parse`,
      { file_id: fileId },
      () => ({
        headers: this.getHeaders(),
        timeout: 30000,
        validateStatus: () => true,
      }),
      options,
    )

    throwIfQwenAiFileOperationStopped(options)
    if (parseResponse.status >= 400) {
      throw new Error(`Qwen AI file parse request failed: HTTP ${parseResponse.status}`)
    }

    await this.waitForParse(fileId, options)
  }

  private async waitForParse(
    fileId: string,
    options: QwenAiFileOperationOptions = {},
  ): Promise<void> {
    throwIfQwenAiFileOperationStopped(options)
    const parsePollIntervalMs = qwenAiFileParsePollIntervalMsFromEnv()
    const parseTimeoutMs = qwenAiFileParseTimeoutMsFromEnv()
    const parseDeadlineAt = Date.now() + parseTimeoutMs
    const requestDeadlineAt = operationDeadlineAt(options)
    const pollingDeadlineAt = requestDeadlineAt === undefined
      ? parseDeadlineAt
      : Math.min(parseDeadlineAt, requestDeadlineAt)
    let lastStatus = ''

    while (Date.now() < pollingDeadlineAt) {
      const waitMs = Math.min(parsePollIntervalMs, pollingDeadlineAt - Date.now())
      await delay(waitMs, options)
      throwIfQwenAiFileOperationStopped(options)
      if (Date.now() >= pollingDeadlineAt) break

      const response: AxiosResponse = await this.postJson(
        `${QWEN_AI_BASE}/api/v2/files/parse/status`,
        { file_id_list: [fileId] },
        () => ({
          headers: this.getHeaders(),
          timeout: Math.max(1, Math.min(30000, pollingDeadlineAt - Date.now())),
          validateStatus: () => true,
        }),
        options,
      )

      throwIfQwenAiFileOperationStopped(options)
      if (Date.now() >= pollingDeadlineAt) break
      if (response.status >= 400) {
        throw new Error(`Qwen AI file parse status request failed: HTTP ${response.status}`)
      }

      const status = response.data?.data?.[fileId]?.status
        || response.data?.data?.[0]?.status
        || response.data?.[fileId]?.status
        || response.data?.status

      const normalizedStatus = status ? String(status).toLowerCase() : ''
      lastStatus = normalizedStatus

      if (!normalizedStatus || ['success', 'finished', 'done', 'parsed', 'completed'].includes(normalizedStatus)) {
        return
      }

      if (['failed', 'error', 'fail'].includes(normalizedStatus)) {
        throw new Error(`Qwen AI file parse failed for uploaded document: ${normalizedStatus}`)
      }
    }

    throwIfQwenAiFileOperationStopped(options)
    throw createQwenAiFileParseTimeoutError(parseTimeoutMs, lastStatus)
  }

  private async postJson(
    url: string,
    payload: unknown,
    createOptions: () => Record<string, any>,
    options: QwenAiFileOperationOptions = {},
  ): Promise<AxiosResponse> {
    throwIfQwenAiFileOperationStopped(options)
    const createOperationOptions = () => {
      throwIfQwenAiFileOperationStopped(options)
      const requestOptions = createOptions()
      const configuredTimeout = Number(requestOptions.timeout)
      return {
        ...requestOptions,
        ...(Number.isFinite(configuredTimeout) && configuredTimeout > 0
          ? { timeout: qwenAiFileOperationTimeout(configuredTimeout, options) }
          : {}),
        ...(options.signal ? { signal: options.signal } : {}),
      }
    }

    const operation = this.postWithRefreshRetry
      ? this.postWithRefreshRetry(url, payload, createOperationOptions)
      : this.axiosInstance.post(url, payload, createOperationOptions())
    const response = await waitForQwenAiFileOperation(operation, options)
    throwIfQwenAiFileOperationStopped(options)
    return response
  }
}

function createQwenAiTextDocument(prefix: string, content: string): ChatMessageContent {
  const data = Buffer.from(content, 'utf8')
  const contentHash = createHash('sha256').update(data).digest('hex')
  return {
    type: 'file',
    filename: `${prefix}-${contentHash.slice(0, 16)}.txt`,
    mime_type: 'text/plain',
    file_url: {
      url: `data:text/plain;base64,${data.toString('base64')}`,
    },
  }
}

function createQwenAiTranscriptDocument(content: string): ChatMessageContent {
  return createQwenAiTextDocument('chat2api-conversation', content)
}

function createQwenAiToolReferenceDocument(content: string): ChatMessageContent {
  return createQwenAiTextDocument('chat2api-tool-reference', content)
}

function qwenAiTranscriptDocumentInstruction(filename: string): string {
  return [
    `The complete conversation transcript is attached as ${filename}.`,
    'Read the attachment in full and treat it as the authoritative conversation context.',
    'Preserve every role, system instruction, tool declaration, tool call, tool result, and original attachment, then continue the final pending user task.',
  ].join(' ')
}

function qwenAiEarlierTranscriptDocumentInstruction(filename: string): string {
  return [
    `Conversation context is attached as ${filename}.`,
    'Read it first, then follow the active managed-tool protocol and current turn context provided inline below.',
  ].join(' ')
}

function qwenAiCompleteManagedTranscriptDocumentInstruction(filename: string): string {
  return [
    `The complete managed conversation transcript is attached as ${filename}.`,
    'Read it in full and treat its final event as the current workflow state, including the pending user task and every completed tool result.',
    'Use the inline managed-tool control for any next tool call, and do not repeat work already completed in the transcript.',
  ].join(' ')
}

function qwenAiToolReferenceDocumentInstruction(filename: string): string {
  return [
    `Complete tool definitions are attached as ${filename}.`,
    'The inline tool catalog is optimized for routing and argument construction; consult the attachment whenever additional tool semantics or schema annotations are needed.',
  ].join(' ')
}

export async function prepareQwenAiMultimodalMessage(
  messages: ChatMessage[],
  uploader: QwenAiFileUploader,
  options: PrepareQwenAiMultimodalMessageOptions = {},
): Promise<PreparedQwenAiMessage> {
  throwIfQwenAiFileOperationStopped(options)
  const { content: userContent, fileParts } = buildQwenAiTranscript(messages)
  const uniqueFileParts = deduplicateQwenFileParts(fileParts)
  const transcriptUtf8Bytes = qwenAiJsonStringUtf8Bytes(userContent)
  const requestedTransport = options.transport ?? 'inline'
  const requestMaxBytes = Math.max(0, Math.floor(options.requestMaxBytes ?? 0))
  const shouldUseDocument = requestedTransport === 'document'
    || (requestMaxBytes > 0 && transcriptUtf8Bytes > requestMaxBytes)
  let generatedDocuments: ChatMessageContent[] = []
  let inlineContent = userContent
  let managedDocumentMode: QwenAiManagedDocumentMode | undefined

  if (shouldUseDocument && options.managedToolCalling) {
    const buildManagedDocument = (documentMode: QwenAiManagedDocumentMode): {
      documents: ChatMessageContent[]
      content: string
    } => {
      const { archiveMessages, activeMessages, toolReferenceContents } = partitionQwenAiManagedMessages(
        messages,
        options.workflowContinuation === true,
        documentMode,
      )
      const activeContext = renderQwenAiManagedDocumentContext(activeMessages, documentMode)
      const archiveContent = renderQwenAiTranscript(archiveMessages).content
      const documents: ChatMessageContent[] = []
      const inlineInstructions: string[] = []
      if (archiveContent) {
        const transcriptDocument = createQwenAiTranscriptDocument(archiveContent)
        documents.push(transcriptDocument)
        inlineInstructions.push(
          documentMode === 'complete'
            ? qwenAiCompleteManagedTranscriptDocumentInstruction(
                transcriptDocument.filename || 'the attached transcript',
              )
            : qwenAiEarlierTranscriptDocumentInstruction(
                transcriptDocument.filename || 'the attached transcript',
              ),
        )
      }
      if (toolReferenceContents.length > 0) {
        const toolReferenceDocument = createQwenAiToolReferenceDocument(
          toolReferenceContents.join('\n\n'),
        )
        documents.push(toolReferenceDocument)
        inlineInstructions.push(
          qwenAiToolReferenceDocumentInstruction(
            toolReferenceDocument.filename || 'the attached tool reference',
          ),
        )
      }
      return {
        documents,
        content: [...inlineInstructions, activeContext].filter(Boolean).join('\n\n'),
      }
    }

    managedDocumentMode = options.managedDocumentMode ?? 'hybrid'
    let managedDocument = buildManagedDocument(managedDocumentMode)
    if (
      options.managedDocumentMode === undefined
      && requestMaxBytes > 0
      && qwenAiJsonStringUtf8Bytes(managedDocument.content) > requestMaxBytes
    ) {
      managedDocumentMode = 'complete'
      managedDocument = buildManagedDocument(managedDocumentMode)
    }
    generatedDocuments = managedDocument.documents
    inlineContent = managedDocument.content
  } else if (shouldUseDocument) {
    const transcriptDocument = createQwenAiTranscriptDocument(userContent)
    generatedDocuments.push(transcriptDocument)
    inlineContent = qwenAiTranscriptDocumentInstruction(
      transcriptDocument.filename || 'the attached transcript',
    )
  }

  const transport: QwenAiMessageTransport = generatedDocuments.length > 0 ? 'document' : 'inline'
  const uploadedParts = [...uniqueFileParts, ...generatedDocuments]

  const files: any[] = []
  const evidences: QwenAiDocumentEvidence[] = []
  for (const part of uploadedParts) {
    throwIfQwenAiFileOperationStopped(options)
    const uploaded = await uploader.uploadPart(part, inlineContent, {
      // This transport exists specifically to avoid re-sending the large
      // transcript inline. Qwen still receives every source attachment.
      includeEvidence: transport !== 'document',
      signal: options.signal,
      deadlineAt: options.deadlineAt,
    })
    throwIfQwenAiFileOperationStopped(options)
    files.push(uploaded.file)
    if (uploaded.evidence) {
      evidences.push(uploaded.evidence)
    }
  }

  const documentEvidence = renderDocumentEvidence(evidences)
  throwIfQwenAiFileOperationStopped(options)
  const content = documentEvidence
    ? `${inlineContent}\n\n${documentEvidence}`
    : inlineContent
  throwIfQwenAiFileOperationStopped(options)

  return {
    content,
    files,
    transport,
    managedDocumentMode,
    transcriptUtf8Bytes,
    inlineUtf8Bytes: qwenAiJsonStringUtf8Bytes(content),
  }
}
