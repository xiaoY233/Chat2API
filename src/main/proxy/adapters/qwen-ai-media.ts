/**
 * Qwen AI media generation helpers.
 *
 * Image/video generation on chat.qwen.ai is performed through the regular
 * chat completion endpoint: a chat session is created with `chat_type` t2i or
 * t2v, the generation model is passed in `messages[0].extra.meta.model`, and
 * the resulting media URL (or video task id) is read from the SSE response.
 */

export type QwenMediaKind = 'image' | 'video'
export type QwenMediaChatType = 't2i' | 't2v'

/** Chat model used by the Qwen web client for media generation. */
export const QWEN_MEDIA_CHAT_MODEL = 'qwen3.8-max'

/** Generation-only models that must be routed through the media pipeline. */
const QWEN_MEDIA_MODELS: Record<string, QwenMediaKind> = {
  'qwen-image-3.0': 'image',
  'qwen-image-3.0-pro': 'image',
  'wan3.0-video': 'video',
  'wan2.7-t2v': 'video',
  'wan2.7-i2v': 'video',
}

const IMAGE_EXTENSIONS = ['.png', '.jpg', '.jpeg', '.webp', '.gif']
const VIDEO_EXTENSIONS = ['.mp4', '.mov', '.webm']

const PREFERRED_KEYS = [
  'video_url',
  'image_url',
  'url',
  'content',
  'result',
  'output',
  'data',
  'message',
]

export function qwenAiMediaKind(model?: string | null): QwenMediaKind | null {
  if (!model) return null
  return QWEN_MEDIA_MODELS[model.trim().toLowerCase()] ?? null
}

export function mediaChatType(kind: QwenMediaKind): QwenMediaChatType {
  return kind === 'image' ? 't2i' : 't2v'
}

export function buildQwenAiMediaPayload(params: {
  chatId: string
  prompt: string
  kind: QwenMediaKind
  size?: string
  generationModel?: string
  chatModel?: string
  fid?: string
  childId?: string
  timestamp?: number
}): Record<string, unknown> {
  const chatType = mediaChatType(params.kind)
  const chatModel = params.chatModel || QWEN_MEDIA_CHAT_MODEL
  const fid = params.fid || randomUUID()
  const childId = params.childId || randomUUID()
  const nowSec = params.timestamp ?? Math.floor(Date.now() / 1000)
  const size = params.size?.trim() || undefined

  const userMessage: Record<string, unknown> = {
    id: null,
    fid,
    parentId: null,
    childrenIds: [childId],
    role: 'user',
    content: params.prompt,
    user_action: 'chat',
    files: [],
    timestamp: nowSec,
    models: [chatModel],
    model: '',
    chat_type: chatType,
    feature_config: {
      thinking_enabled: false,
      output_schema: 'phase',
      research_mode: 'normal',
      auto_thinking: false,
      thinking_mode: 'Fast',
      auto_search: true,
    },
    extra: {
      meta: {
        subChatType: chatType,
        ...(size ? { size } : {}),
        ...(params.generationModel ? { model: params.generationModel } : {}),
      },
    },
    sub_chat_type: chatType,
    parent_id: null,
  }

  const payload: Record<string, unknown> = {
    // Video generation is submitted synchronously and answers with a task id.
    stream: chatType !== 't2v',
    version: '2.1',
    incremental_output: true,
    chatId: params.chatId,
    parentId: '',
    chat_id: params.chatId,
    chat_mode: 'normal',
    messages: [userMessage],
    model: chatModel,
    parent_id: null,
    timestamp: nowSec + 1,
  }

  if (size) {
    payload.size = size
  }

  return payload
}

export interface ParsedQwenMediaResponse {
  content: string
  url?: string
  taskId?: string
  width?: number
  height?: number
}

/**
 * Parses an SSE (or plain JSON) media response, collecting streamed text,
 * optional usage dimensions, a media URL and a video task id.
 */
export function parseQwenAiMediaResponse(
  raw: string,
  kind: QwenMediaKind
): ParsedQwenMediaResponse {
  let content = ''
  let taskId: string | undefined
  let width: number | undefined
  let height: number | undefined
  const parsedValues: unknown[] = []

  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed) continue

    const dataStr = trimmed.startsWith('data:') ? trimmed.slice(5).trim() : trimmed
    if (!dataStr || dataStr === '[DONE]') continue
    if (!dataStr.startsWith('{') && !dataStr.startsWith('[')) continue

    let parsed: any
    try {
      parsed = JSON.parse(dataStr)
    } catch {
      continue
    }
    parsedValues.push(parsed)

    const choice = parsed?.choices?.[0]
    const deltaContent = choice?.delta?.content ?? choice?.message?.content
    if (typeof deltaContent === 'string') {
      content += deltaContent
    }
    if (typeof parsed?.task_id === 'string' && parsed.task_id) {
      taskId = parsed.task_id
    }
    if (typeof parsed?.usage?.width === 'number') width = parsed.usage.width
    if (typeof parsed?.usage?.height === 'number') height = parsed.usage.height
  }

  if (parsedValues.length === 0) {
    try {
      parsedValues.push(JSON.parse(raw))
    } catch {
      // Not JSON; the URL may still be present in the raw text.
    }
  }

  const url =
    extractQwenMediaUrl(content, kind) ||
    extractQwenMediaUrl(parsedValues, kind) ||
    extractQwenMediaUrl(raw, kind) ||
    undefined

  if (!taskId) {
    for (const value of parsedValues) {
      taskId = extractQwenMediaTaskId(value) || undefined
      if (taskId) break
    }
  }

  return { content, url, taskId, width, height }
}

/** Extracts a media URL from arbitrary response data, preferring file extensions. */
export function extractQwenMediaUrl(
  value: unknown,
  kind: QwenMediaKind | 'any' = 'any'
): string | null {
  const extensions =
    kind === 'video'
      ? VIDEO_EXTENSIONS
      : kind === 'image'
        ? IMAGE_EXTENSIONS
        : [...VIDEO_EXTENSIONS, ...IMAGE_EXTENSIONS]

  const matches: string[] = []
  collectUrls(value, matches, new Set())
  const preferred = matches.find((url) =>
    extensions.some((ext) => stripUrlSuffix(url).toLowerCase().includes(ext))
  )
  return preferred || matches[0] || null
}

function collectUrls(value: unknown, urls: string[], seen: Set<unknown>): void {
  if (value === null || value === undefined) return

  if (typeof value === 'string') {
    const found = value.match(/https?:\/\/[^\s"'<>\\]+/g) || []
    for (const url of found) {
      const clean = stripUrlSuffix(url)
      if (clean) urls.push(clean)
    }
    return
  }

  if (typeof value !== 'object') return
  if (seen.has(value)) return
  seen.add(value)

  if (Array.isArray(value)) {
    for (const item of value) collectUrls(item, urls, seen)
    return
  }

  const record = value as Record<string, unknown>
  for (const key of PREFERRED_KEYS) {
    if (key in record) collectUrls(record[key], urls, seen)
  }
  for (const [key, item] of Object.entries(record)) {
    if (!PREFERRED_KEYS.includes(key)) collectUrls(item, urls, seen)
  }
}

/** Removes markdown/JSON punctuation that commonly trails an extracted URL. */
function stripUrlSuffix(url: string): string {
  return url.replace(/[)\]},.;]+$/, '')
}

/** Extracts a video task id from the various shapes Qwen has used. */
export function extractQwenMediaTaskId(value: unknown): string | null {
  if (!value || typeof value !== 'object') return null
  const data = value as Record<string, unknown>
  const dataRecord = data.data as Record<string, unknown> | undefined
  const messages = Array.isArray(dataRecord?.messages)
    ? (dataRecord.messages as unknown[])
    : Array.isArray(data.messages)
      ? (data.messages as unknown[])
      : []
  const firstMessage = (messages[0] ?? null) as Record<string, unknown> | null
  const wanx = (firstMessage?.extra as Record<string, unknown> | undefined)?.wanx as
    | Record<string, unknown>
    | undefined
  if (typeof wanx?.task_id === 'string' && wanx.task_id) {
    return wanx.task_id
  }

  const usage = data.usage as Record<string, unknown> | undefined
  const candidates = [
    data.task_id,
    data.taskId,
    data.response_id,
    data.id,
    dataRecord?.task_id,
    dataRecord?.message_id,
    usage?.task_id,
  ]
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.length > 0) {
      return candidate
    }
  }
  return null
}

/** Markdown content returned to OpenAI-compatible clients. */
export function buildQwenMediaContent(kind: QwenMediaKind, url: string): string {
  return kind === 'image'
    ? `![Generated image](${url})`
    : `[Generated video](${url})`
}

/** Extracts the prompt (last user text) from OpenAI-style messages. */
export function extractMediaPrompt(messages: Array<{ role?: string; content?: unknown }>): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]
    if (message?.role !== 'user') continue
    const text = extractTextContent(message.content)
    if (text.trim()) return text.trim()
  }
  for (let i = messages.length - 1; i >= 0; i--) {
    const text = extractTextContent(messages[i]?.content)
    if (text.trim()) return text.trim()
  }
  return ''
}

function extractTextContent(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map((item: any) => {
      if (typeof item === 'string') return item
      if (item?.type === 'text') return item.text || ''
      return ''
    })
    .filter(Boolean)
    .join('\n')
}

function randomUUID(): string {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (char) => {
    const random = (Math.random() * 16) | 0
    const value = char === 'x' ? random : (random & 0x3) | 0x8
    return value.toString(16)
  })
}
