import type { RequestLogEntry } from '../store/types.ts'
import type { RequestLogConfig } from './types.ts'

export function sanitizeRequestLogEntry(
  entry: Omit<RequestLogEntry, 'id'>,
  config: RequestLogConfig,
): Omit<RequestLogEntry, 'id'> {
  const sanitized: Omit<RequestLogEntry, 'id'> = {
    ...entry,
    userInput: truncateText(entry.userInput, 500),
    errorStack: undefined,
  }

  if (!config.includeBodies) {
    sanitized.requestBody = undefined
    sanitized.responseBody = undefined
  } else {
    sanitized.requestBody = sanitizeRequestLogBody(entry.requestBody, config)
    sanitized.responseBody = sanitizeRequestLogBody(entry.responseBody, config)
  }

  // 无论是否记录完整 body，都保留一份人类可读的响应摘要（模型说的话 / 工具调用）
  sanitized.responsePreview = sanitizePreview(
    entry.responsePreview ?? extractResponsePreview(entry.responseBody),
    config,
  )
  sanitized.errorMessage = truncateText(entry.errorMessage, 1000)

  return sanitized
}

/**
 * 只处理 updates 里显式出现的字段。
 *
 * 之前的实现会对未提供的字段赋 undefined，导致流式请求在结束时
 * （只更新 responseBody）把已经写好的 requestBody / userInput 清空 ——
 * 这正是日志里「请求没有内容」的直接原因。
 */
export function sanitizeRequestLogUpdates(
  updates: Partial<RequestLogEntry>,
  config: RequestLogConfig,
): Partial<RequestLogEntry> {
  const sanitized: Partial<RequestLogEntry> = { ...updates }

  if ('userInput' in updates) {
    sanitized.userInput = truncateText(updates.userInput, 500)
  }

  if ('errorMessage' in updates) {
    sanitized.errorMessage = truncateText(updates.errorMessage, 1000)
  }

  if ('requestBody' in updates) {
    sanitized.requestBody = config.includeBodies
      ? sanitizeRequestLogBody(updates.requestBody, config)
      : undefined
  }

  if ('responseBody' in updates) {
    sanitized.responseBody = config.includeBodies
      ? sanitizeRequestLogBody(updates.responseBody, config)
      : undefined
  }

  if ('responsePreview' in updates) {
    sanitized.responsePreview = sanitizePreview(updates.responsePreview, config)
  } else if ('responseBody' in updates) {
    // 调用方只给了 responseBody 时，自动补一份摘要
    const auto = extractResponsePreview(updates.responseBody)
    if (auto) {
      sanitized.responsePreview = sanitizePreview(auto, config)
    }
  }

  sanitized.errorStack = undefined

  return sanitized
}

export function trimRequestLogsToMaxEntries(
  entries: RequestLogEntry[],
  config: RequestLogConfig,
): RequestLogEntry[] {
  const maxEntries = Math.max(0, config.maxEntries)
  if (maxEntries === 0) {
    return []
  }

  if (entries.length <= maxEntries) {
    return entries
  }

  return entries.slice(entries.length - maxEntries)
}

function sanitizeRequestLogBody(value: string | undefined, config: RequestLogConfig): string | undefined {
  if (!value) return value

  const redacted = config.redactSensitiveData ? redactSensitiveText(value) : value
  return truncateText(redacted, config.maxBodyChars)
}

function truncateText(value: string | undefined, maxChars: number): string | undefined {
  if (!value) return value
  if (maxChars <= 0) return undefined
  if (value.length <= maxChars) return value
  return `${value.slice(0, maxChars)}...[truncated ${value.length - maxChars} chars]`
}

function sanitizePreview(value: string | undefined, config: RequestLogConfig): string | undefined {
  if (!value) return value

  const redacted = config.redactSensitiveData ? redactSensitiveText(value) : value
  return truncateText(redacted, 2000)
}

/**
 * 把响应体（完整 JSON 或 SSE 文本流）压成一段人类可读的摘要：
 * 模型的正文 + 工具调用 + finish_reason + usage。
 * 上游返回空内容时会明确标出 `[empty response]`，便于排查静默失败。
 */
export function extractResponsePreview(body: string | undefined): string | undefined {
  if (!body) return undefined

  const trimmed = body.trim()
  if (!trimmed) return undefined

  const isSse =
    trimmed.includes('data:') ||
    trimmed.includes('event:') ||
    trimmed.includes('\ndata:')

  const summary = isSse ? summarizeSse(trimmed) : summarizeJson(trimmed)
  return summary || undefined
}

interface ToolCallDraft {
  id?: string
  name: string
  args: string
}

function summarizeSse(text: string): string | undefined {
  let content = ''
  let reasoning = ''
  const toolCalls = new Map<number, ToolCallDraft>()
  let finishReason = ''
  let usage: unknown

  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim()
    if (!line.startsWith('data:')) continue

    const payload = line.slice(5).trim()
    if (!payload || payload === '[DONE]') continue

    let obj: any
    try {
      obj = JSON.parse(payload)
    } catch {
      continue
    }

    if (obj?.usage) usage = obj.usage

    const choice = obj?.choices?.[0]
    if (!choice) continue

    const delta = choice.delta ?? choice.message ?? {}
    if (typeof delta.content === 'string' && delta.content) {
      content += delta.content
    }
    if (typeof delta.reasoning_content === 'string' && delta.reasoning_content) {
      reasoning += delta.reasoning_content
    }
    if (Array.isArray(delta.tool_calls)) {
      for (const tc of delta.tool_calls) {
        const idx = typeof tc?.index === 'number' ? tc.index : toolCalls.size
        const draft = toolCalls.get(idx) ?? { name: '', args: '' }
        if (tc?.id) draft.id = tc.id
        if (typeof tc?.function?.name === 'string') draft.name += tc.function.name
        if (typeof tc?.function?.arguments === 'string') draft.args += tc.function.arguments
        toolCalls.set(idx, draft)
      }
    }
    if (choice.finish_reason) finishReason = choice.finish_reason
  }

  return buildSummary({ content, reasoning, toolCalls, finishReason, usage })
}

function summarizeJson(text: string): string | undefined {
  let obj: any
  try {
    obj = JSON.parse(text)
  } catch {
    return undefined
  }

  const choice = obj?.choices?.[0]
  if (!choice) {
    // 错误响应体（{ error: {...} }）之类，原样截断展示
    return text.slice(0, 2000)
  }

  const message = choice.message ?? {}
  const toolCalls = new Map<number, ToolCallDraft>()
  if (Array.isArray(message.tool_calls)) {
    message.tool_calls.forEach((tc: any, idx: number) => {
      toolCalls.set(idx, {
        id: tc?.id,
        name: typeof tc?.function?.name === 'string' ? tc.function.name : '',
        args: typeof tc?.function?.arguments === 'string' ? tc.function.arguments : '',
      })
    })
  }

  return buildSummary({
    content: typeof message.content === 'string' ? message.content : '',
    reasoning:
      typeof message.reasoning_content === 'string' ? message.reasoning_content : '',
    toolCalls,
    finishReason: choice.finish_reason ?? '',
    usage: obj?.usage,
  })
}

function buildSummary(parts: {
  content: string
  reasoning: string
  toolCalls: Map<number, ToolCallDraft>
  finishReason: string
  usage: unknown
}): string {
  const lines: string[] = []

  if (parts.toolCalls.size > 0) {
    for (const draft of Array.from(parts.toolCalls.values())) {
      const args = draft.args ? `(${draft.args})` : '()'
      lines.push(`[tool_call] ${draft.name || '<unnamed>'}${args}`)
    }
  }

  if (parts.reasoning) {
    lines.push(parts.reasoning)
  }

  if (parts.content) {
    lines.push(parts.content)
  }

  if (!lines.length) {
    lines.push('[empty response] 上游未返回任何内容')
  }

  if (parts.finishReason) {
    lines.push(`[finish_reason] ${parts.finishReason}`)
  }

  if (parts.usage) {
    lines.push(`[usage] ${JSON.stringify(parts.usage)}`)
  }

  return lines.join('\n')
}

function redactSensitiveText(value: string): string {
  return value.replace(
    /(\"?(?:authorization|api[_-]?key|access[_-]?token|refresh[_-]?token|cookie|set-cookie|password|token)\"?\s*[:=]\s*)\"?[^\",}\]\s]+\"?/gi,
    '$1"[REDACTED]"',
  )
}
