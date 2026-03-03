/**
 * DeepSeek Stream Response Handler
 * Converts DeepSeek SSE stream to OpenAI compatible format
 */

import { PassThrough } from 'stream'
import { parseToolCallsFromText } from '../utils/toolParser'
import { 
  createToolCallState, 
  processStreamContent, 
  flushToolCallBuffer,
  createBaseChunk,
  ToolCallState 
} from '../utils/streamToolHandler'

const MODEL_NAME = 'deepseek-chat'

interface StreamChunk {
  p?: string
  v?: any
  response_message_id?: string
  o?: string
}

export class DeepSeekStreamHandler {
  private model: string
  private sessionId: string
  private isFirstChunk: boolean = true
  private messageId: string = ''
  private currentPath: string = ''
  private searchResults: any[] = []
  private thinkingStarted: boolean = false
  private accumulatedTokenUsage: number = 2
  private created: number
  private onEnd?: () => void
  private toolCallState: ToolCallState
  private hasError: boolean = false
  private errorMessage: string = ''
  private receivedContent: boolean = false

  constructor(model: string, sessionId: string, onEnd?: () => void) {
    this.model = model
    this.sessionId = sessionId
    this.created = Math.floor(Date.now() / 1000)
    this.onEnd = onEnd
    this.toolCallState = createToolCallState()
  }

  getMessageId(): string {
    return this.messageId
  }

  hasSessionError(): boolean {
    return this.hasError
  }
  
  hasReceivedContent(): boolean {
    return this.receivedContent
  }

  getErrorMessage(): string {
    return this.errorMessage
  }

  private emitErrorChunk(transStream: PassThrough): void {
    transStream.write(`data: ${JSON.stringify({
      id: `${this.sessionId}@error`,
      model: this.model,
      object: 'chat.completion.chunk',
      choices: [{
        index: 0,
        delta: { content: `\n[Error: ${this.errorMessage}]` },
        finish_reason: 'stop',
      }],
      created: this.created,
    })}\n\n`)
  }

  private parseSSE(data: string): StreamChunk | null {
    try {
      return JSON.parse(data)
    } catch {
      return null
    }
  }

  private createChunk(delta: { role?: string; content?: string; reasoning_content?: string; tool_calls?: any[] }, finishReason?: string): string {
    return `data: ${JSON.stringify({
      id: `${this.sessionId}@${this.messageId}`,
      model: this.model,
      object: 'chat.completion.chunk',
      choices: [{
        index: 0,
        delta,
        finish_reason: finishReason || null,
      }],
      created: this.created,
    })}\n\n`
  }

  async handleStream(stream: NodeJS.ReadableStream): Promise<NodeJS.ReadableStream> {
    return new Promise((resolve, reject) => {
      const transStream = new PassThrough()
      const isThinkingModel = this.model.includes('think') || this.model.includes('r1')
      const isSilentModel = this.model.includes('silent')
      const isFoldModel = (this.model.includes('fold') || this.model.includes('search')) && !isThinkingModel
      const isSearchSilentModel = this.model.includes('search-silent')

      let buffer = ''
      let hasEmittedError = false
      let hasResolved = false

      stream.on('data', (chunk: Buffer) => {
        if (hasEmittedError) return
        
        buffer += chunk.toString()
        const lines = buffer.split('\n')
        buffer = lines.pop() || ''

        for (const line of lines) {
          if (!line.trim() || !line.startsWith('data:')) continue

          const data = line.slice(5).trim()
          if (data === '[DONE]') {
            this.handleDone(transStream, isFoldModel, isSearchSilentModel)
            if (!hasResolved) {
              hasResolved = true
              resolve(transStream)
            }
            return
          }

          const parsed = this.parseSSE(data)
          if (!parsed) continue

          this.processChunk(parsed, transStream, isThinkingModel, isSilentModel, isFoldModel, isSearchSilentModel)
          
          // If error detected, reject immediately to trigger retry
          if (this.hasError && !hasEmittedError) {
            hasEmittedError = true
            console.log('[DeepSeek] Error detected, rejecting to trigger retry:', this.errorMessage)
            reject(new Error(this.errorMessage || 'Session error'))
            return
          }
        }
      })

      stream.on('end', () => {
        if (hasEmittedError) return
        
        // Check if we received any content - if not, reject to trigger retry
        if (!this.hasReceivedContent() && !this.messageId) {
          console.log('[DeepSeek] No content received, rejecting to trigger retry')
          hasEmittedError = true
          reject(new Error('No content received - session may be invalid'))
          return
        }
        
        this.handleDone(transStream, isFoldModel, isSearchSilentModel)
        if (!hasResolved) {
          hasResolved = true
          resolve(transStream)
        }
      })

      stream.on('error', (err) => {
        hasEmittedError = true
        reject(err)
      })
    })
  }

  private processChunk(
    chunk: StreamChunk,
    transStream: PassThrough,
    isThinkingModel: boolean,
    isSilentModel: boolean,
    isFoldModel: boolean,
    isSearchSilentModel: boolean
  ): void {
    // Check for error response (e.g., session not found)
    // DeepSeek error format: { v: { error: {...} } } or { error: {...} } or { v: "error message" }
    if (chunk.v && typeof chunk.v === 'object' && chunk.v.error) {
      this.hasError = true
      this.errorMessage = chunk.v.error.message || chunk.v.error.msg || JSON.stringify(chunk.v.error)
      console.error('[DeepSeek] Stream error (v.error):', this.errorMessage)
      this.emitErrorChunk(transStream)
      return
    }
    
    // Check for direct error field
    if ((chunk as any).error) {
      this.hasError = true
      const error = (chunk as any).error
      this.errorMessage = error.message || error.msg || JSON.stringify(error)
      console.error('[DeepSeek] Stream error (error):', this.errorMessage)
      this.emitErrorChunk(transStream)
      return
    }
    
    // Check for string error in v field
    if (chunk.v && typeof chunk.v === 'string' && (chunk.v.includes('error') || chunk.v.includes('Error') || chunk.v.includes('not found') || chunk.v.includes('不存在') || chunk.v.includes('未找到'))) {
      this.hasError = true
      this.errorMessage = chunk.v
      console.error('[DeepSeek] Stream error (v string):', this.errorMessage)
      this.emitErrorChunk(transStream)
      return
    }
    
    // Check for error in p (path) field - sometimes errors come as { p: "error", v: "message" }
    if (chunk.p === 'error' || chunk.p === 'Error') {
      this.hasError = true
      this.errorMessage = typeof chunk.v === 'string' ? chunk.v : JSON.stringify(chunk.v)
      console.error('[DeepSeek] Stream error (p=error):', this.errorMessage)
      this.emitErrorChunk(transStream)
      return
    }

    if (chunk.response_message_id && !this.messageId) {
      this.messageId = chunk.response_message_id
    }

    if (chunk.v && typeof chunk.v === 'object' && chunk.v.response) {
      this.currentPath = chunk.v.response.thinking_enabled ? 'thinking' : 'content'
    } else if (chunk.p === 'response/fragments') {
      this.currentPath = 'content'
    }

    if (chunk.p === 'response/search_status') return

    if (chunk.p === 'response' && Array.isArray(chunk.v)) {
      chunk.v.forEach((e: any) => {
        if (e.p === 'accumulated_token_usage' && typeof e.v === 'number') {
          this.accumulatedTokenUsage = e.v
        }
      })
    }

    if (chunk.p === 'response/search_results' && Array.isArray(chunk.v)) {
      if (chunk.o !== 'BATCH') {
        this.searchResults = chunk.v
      } else {
        chunk.v.forEach((op: any) => {
          const match = op.p?.match(/^(\d+)\/cite_index$/)
          if (match) {
            const index = parseInt(match[1], 10)
            if (this.searchResults[index]) {
              this.searchResults[index].cite_index = op.v
            }
          }
        })
      }
      return
    }

    let content = ''
    if (typeof chunk.v === 'string') {
      content = chunk.v
    } else if (Array.isArray(chunk.v)) {
      content = chunk.v
        .map((e: any) => {
          if (Array.isArray(e.v)) {
            return e.v.map((v: any) => v.content).join('')
          }
          return ''
        })
        .join('')
    }

    if (!content) return

    const cleanedValue = content.replace(/FINISHED/g, '')
    const processedContent = isSearchSilentModel
      ? cleanedValue.replace(/\[citation:(\d+)\]/g, '')
      : cleanedValue.replace(/\[citation:(\d+)\]/g, '[$1]')

    // Process tool call interception for content
    if (this.currentPath === 'content' || !this.currentPath) {
      const baseChunk = createBaseChunk(`${this.sessionId}@${this.messageId}`, this.model, this.created)
      const { chunks: outputChunks, shouldFlush } = processStreamContent(
        processedContent, 
        this.toolCallState, 
        baseChunk, 
        this.isFirstChunk,
        'deepseek'
      )

      for (const outChunk of outputChunks) {
        transStream.write(`data: ${JSON.stringify(outChunk)}\n\n`)
        this.isFirstChunk = false
        // Mark that we received some content
        this.receivedContent = true
      }

      // If we are buffering a potential tool call, don't send any content
      // Return to wait for more content
      if (this.toolCallState.isBufferingToolCall) {
        return
      }
      
      // If we already emitted tool calls, don't send any more content
      if (this.toolCallState.hasEmittedToolCall) {
        return
      }
      
      // If processStreamContent already sent content, don't send again
      if (outputChunks.length > 0) {
        return
      }
    }

    const delta: { role?: string; content?: string; reasoning_content?: string } = {}
    if (this.isFirstChunk) {
      delta.role = 'assistant'
      this.isFirstChunk = false
    }

    // Mark that we received some content
    if (processedContent) {
      this.receivedContent = true
    }

    if (this.currentPath === 'thinking') {
      if (isSilentModel) return
      if (isFoldModel) {
        if (!this.thinkingStarted) {
          this.thinkingStarted = true
          delta.content = `<details><summary>Thinking Process</summary><pre>${processedContent}`
        } else {
          delta.content = processedContent
        }
      } else {
        delta.reasoning_content = processedContent
      }
    } else if (this.currentPath === 'content') {
      if (isFoldModel && this.thinkingStarted) {
        delta.content = `</pre></details>${processedContent}`
        this.thinkingStarted = false
      } else {
        delta.content = processedContent
      }
    } else {
      delta.content = processedContent
    }

    transStream.write(this.createChunk(delta))
  }

  private handleDone(transStream: PassThrough, isFoldModel: boolean, isSearchSilentModel: boolean): void {
    // Flush tool call buffer before finishing
    const baseChunk = createBaseChunk(`${this.sessionId}@${this.messageId}`, this.model, this.created)
    const flushChunks = flushToolCallBuffer(this.toolCallState, baseChunk, 'deepseek')
    for (const outChunk of flushChunks) {
      transStream.write(`data: ${JSON.stringify(outChunk)}\n\n`)
    }

    if (isFoldModel && this.thinkingStarted) {
      transStream.write(this.createChunk({ content: '</pre></details>' }))
    }

    if (this.searchResults.length > 0 && !isSearchSilentModel) {
      const citations = this.searchResults
        .filter(r => r.cite_index)
        .sort((a, b) => a.cite_index - b.cite_index)
        .map(r => `[${r.cite_index}]: [${r.title}](${r.url})`)
        .join('\n')
      
      if (citations) {
        transStream.write(this.createChunk({ content: `\n\n${citations}` }))
      }
    }

    // Determine finish_reason based on whether we had tool calls
    const finishReason = this.toolCallState.hasEmittedToolCall ? 'tool_calls' : 'stop'

    transStream.write(this.createChunk({}, finishReason))
    transStream.write('data: [DONE]\n\n')
    transStream.end()
    
    // Call end callback
    this.onEnd?.()
  }

  async handleNonStream(stream: NodeJS.ReadableStream): Promise<any> {
    let accumulatedContent = ''
    let accumulatedThinkingContent = ''
    let messageId = ''
    let currentPath = ''
    let accumulatedTokenUsage = 2

    return new Promise((resolve, reject) => {
      let buffer = ''

      stream.on('data', (chunk: Buffer) => {
        buffer += chunk.toString()
        const lines = buffer.split('\n')
        buffer = lines.pop() || ''

        for (const line of lines) {
          if (!line.trim() || !line.startsWith('data:')) continue

          const data = line.slice(5).trim()
          if (data === '[DONE]') return

          try {
            const parsed = JSON.parse(data)
            
            if (parsed.response_message_id && !messageId) {
              messageId = parsed.response_message_id
            }

            if (parsed.v && typeof parsed.v === 'object' && parsed.v.response) {
              currentPath = parsed.v.response.thinking_enabled ? 'thinking' : 'content'
            } else if (parsed.p === 'response/fragments') {
              currentPath = 'content'
            }

            if (typeof parsed.v === 'object' && Array.isArray(parsed.v)) {
              parsed.v.forEach((e: any) => {
                if (e.accumulated_token_usage && typeof e.v === 'number') {
                  accumulatedTokenUsage = e.v
                }
                if (Array.isArray(e.v)) {
                  const cleanedValue = e.v.map((v: any) => v.content).join('').replace(/FINISHED/g, '')
                  if (currentPath === 'thinking') {
                    accumulatedThinkingContent += cleanedValue
                  } else if (currentPath === 'content') {
                    accumulatedContent += cleanedValue
                  }
                }
              })
            }

            if (typeof parsed.v === 'string') {
              const cleanedValue = parsed.v.replace(/FINISHED/g, '')
              if (currentPath === 'thinking') {
                accumulatedThinkingContent += cleanedValue
              } else if (currentPath === 'content') {
                accumulatedContent += cleanedValue
              }
            }
          } catch {
            // Ignore parse errors
          }
        }
      })

      stream.on('end', () => {
        // Parse tool calls from accumulated content
        const { content: cleanContent, toolCalls } = parseToolCallsFromText(accumulatedContent)

        const message: any = {
          role: 'assistant',
          content: toolCalls.length > 0 ? null : cleanContent.trim(),
          reasoning_content: accumulatedThinkingContent.trim(),
        }

        if (toolCalls.length > 0) {
          message.tool_calls = toolCalls
        }

        resolve({
          id: `${this.sessionId}@${messageId}`,
          model: this.model,
          object: 'chat.completion',
          choices: [{
            index: 0,
            message,
            finish_reason: toolCalls.length > 0 ? 'tool_calls' : 'stop',
          }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: accumulatedTokenUsage },
          created: this.created,
        })
      })

      stream.on('error', reject)
    })
  }
}
