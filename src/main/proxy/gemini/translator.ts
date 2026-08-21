import type { ChatCompletionRequest, ChatCompletionResponse, ChatMessageContent } from '../types'
import { geminiFileStore } from './fileStore'
import { QWEN_AI_DIRECT_FILE_SCHEME, getQwenAiDirectUploadFile } from '../adapters/qwen-ai-files'
import { SseKeepAliveStream } from '../utils/sseKeepAlive'

interface GeminiPart {
  text?: string
  inlineData?: {
    mimeType?: string
    data: string
  }
  inline_data?: {
    mime_type?: string
    data: string
  }
  fileData?: {
    mimeType?: string
    fileUri: string
  }
  file_data?: {
    mime_type?: string
    file_uri: string
  }
}

interface GeminiContent {
  role?: 'user' | 'model'
  parts?: GeminiPart[]
}

function normalizeRole(role?: string): 'system' | 'user' | 'assistant' {
  if (role === 'model') {
    return 'assistant'
  }
  return role === 'system' ? 'system' : 'user'
}

const CHAT2API_FILE_SCHEME = 'chat2api-file://'

function collectQwenDirectUploadHints(contents: GeminiContent[]): { providerId?: string; accountId?: string } {
  for (const content of contents) {
    for (const part of content.parts || []) {
      const fileData = part.fileData || (part.file_data ? {
        mimeType: part.file_data.mime_type,
        fileUri: part.file_data.file_uri,
      } : undefined)
      const fileUri = fileData?.fileUri || ''
      if (!fileUri.startsWith(QWEN_AI_DIRECT_FILE_SCHEME)) {
        continue
      }
      const directFile = getQwenAiDirectUploadFile(fileUri)
      if (directFile) {
        return {
          providerId: directFile.providerId,
          accountId: directFile.accountId,
        }
      }
    }
  }
  return {}
}

function filePartFromMime(url: string, mimeType: string, filename?: string, localPath?: string): ChatMessageContent {
  if (mimeType.startsWith('image/')) {
    return { type: 'image_url', image_url: { url }, mime_type: mimeType, filename, local_path: localPath }
  }
  if (mimeType.startsWith('audio/')) {
    if (url.startsWith('data:')) {
      return {
        type: 'input_audio',
        input_audio: {
          data: url,
          format: mimeType.split('/')[1],
        },
        mime_type: mimeType,
        filename,
        local_path: localPath,
      }
    }
    return { type: 'file', file_url: { url }, mime_type: mimeType, filename, local_path: localPath }
  }
  if (mimeType.startsWith('video/')) {
    return { type: 'video_url', video_url: { url }, mime_type: mimeType, filename, local_path: localPath }
  }
  return { type: 'file', file_url: { url }, mime_type: mimeType, filename, local_path: localPath }
}

function convertPart(part: GeminiPart): ChatMessageContent | null {
  if (typeof part.text === 'string') {
    return { type: 'text', text: part.text }
  }

  const inlineData = part.inlineData || (part.inline_data ? {
    mimeType: part.inline_data.mime_type,
    data: part.inline_data.data,
  } : undefined)
  if (inlineData?.data) {
    const mimeType = inlineData.mimeType || 'application/octet-stream'
    return filePartFromMime(`data:${mimeType};base64,${inlineData.data}`, mimeType)
  }

  const fileData = part.fileData || (part.file_data ? {
    mimeType: part.file_data.mime_type,
    fileUri: part.file_data.file_uri,
  } : undefined)
  if (fileData?.fileUri) {
    if (fileData.fileUri.startsWith(QWEN_AI_DIRECT_FILE_SCHEME)) {
      const directFile = getQwenAiDirectUploadFile(fileData.fileUri)
      if (!directFile) {
        throw new Error(`Qwen AI direct-upload file not found or expired: ${fileData.fileUri}`)
      }
      const mimeType = fileData.mimeType || directFile.mimeType
      return filePartFromMime(fileData.fileUri, mimeType, directFile.filename)
    }

    const storedFile = geminiFileStore.getFile(fileData.fileUri)
    if (storedFile) {
      const mimeType = fileData.mimeType || storedFile.mimeType
      const url = `${CHAT2API_FILE_SCHEME}${encodeURIComponent(storedFile.name)}`
      return filePartFromMime(url, mimeType, storedFile.displayName, storedFile.path)
    }

    const mimeType = fileData.mimeType || 'application/octet-stream'
    return filePartFromMime(fileData.fileUri, mimeType)
  }

  return null
}

function getTextFromChoice(response: ChatCompletionResponse): string {
  return response.choices
    .map(choice => choice.message?.content || choice.delta?.content || choice.message?.reasoning_content || choice.delta?.reasoning_content || '')
    .join('')
}

function mapFinishReason(reason?: string | null): string {
  if (reason === 'length') return 'MAX_TOKENS'
  if (reason === 'content_filter') return 'SAFETY'
  if (reason === 'tool_calls') return 'STOP'
  return 'STOP'
}

export function geminiToChatCompletionRequest(model: string, body: any): ChatCompletionRequest {
  const geminiContents = (body.contents || []) as GeminiContent[]
  const directUploadHints = collectQwenDirectUploadHints(geminiContents)
  const messages = geminiContents.map((content: GeminiContent) => {
    const parts = (content.parts || [])
      .map(convertPart)
      .filter(Boolean) as ChatMessageContent[]

    return {
      role: normalizeRole(content.role),
      content: parts.length === 1 && parts[0].type === 'text' ? parts[0].text || '' : parts,
    }
  })

  if (body.systemInstruction?.parts?.length) {
    messages.unshift({
      role: 'system',
      content: body.systemInstruction.parts.map((part: GeminiPart) => part.text || '').join(''),
    })
  }

  const generationConfig = body.generationConfig || {}
  return {
    model,
    preferredProviderId: directUploadHints.providerId,
    preferredAccountId: directUploadHints.accountId,
    messages,
    stream: false,
    temperature: generationConfig.temperature,
    top_p: generationConfig.topP,
    max_tokens: generationConfig.maxOutputTokens,
    stop: generationConfig.stopSequences,
  }
}

export function chatCompletionToGeminiResponse(response: ChatCompletionResponse, model: string): any {
  const firstChoice = response.choices[0]
  return {
    candidates: [
      {
        content: {
          role: 'model',
          parts: [{ text: getTextFromChoice(response) }],
        },
        finishReason: mapFinishReason(firstChoice?.finish_reason),
        index: firstChoice?.index || 0,
      },
    ],
    modelVersion: model,
    usageMetadata: response.usage ? {
      promptTokenCount: response.usage.prompt_tokens,
      candidatesTokenCount: response.usage.completion_tokens,
      totalTokenCount: response.usage.total_tokens,
    } : undefined,
  }
}

export function chatCompletionStreamToGeminiSse(stream: NodeJS.ReadableStream, model: string): NodeJS.ReadableStream {
  const output = new SseKeepAliveStream()
  let buffer = ''

  stream.on('data', (chunk: Buffer) => {
    buffer += chunk.toString()
    const events = buffer.split('\n\n')
    buffer = events.pop() || ''

    for (const event of events) {
      const line = event.split('\n').find(item => item.startsWith('data: '))
      if (!line) continue
      const data = line.slice(6)
      if (data === '[DONE]') {
        continue
      }
      try {
        const parsed = JSON.parse(data)
        const text = parsed.choices?.map((choice: any) => choice.delta?.content || choice.message?.content || '').join('') || ''
        if (!text) continue
        output.write(`data: ${JSON.stringify({
          candidates: [{ content: { role: 'model', parts: [{ text }] }, finishReason: 'STOP', index: 0 }],
          modelVersion: model,
        })}\n\n`)
      } catch {
      }
    }
  })

  stream.on('end', () => output.end())
  stream.on('error', (error) => output.destroy(error))
  return output
}
