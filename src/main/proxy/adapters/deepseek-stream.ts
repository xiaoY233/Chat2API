/**
 * DeepSeek Stream Response Handler
 * Converts DeepSeek SSE stream to OpenAI compatible format
 */

import { PassThrough } from 'stream'

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

  constructor(model: string, sessionId: string, onEnd?: () => void) {
    this.model = model
    this.sessionId = sessionId
    this.created = Math.floor(Date.now() / 1000)
    this.onEnd = onEnd
  }

  private parseSSE(data: string): StreamChunk | null {
    try {
      return JSON.parse(data)
    } catch {
      return null
    }
  }

  private createChunk(delta: { role?: string; content?: string; reasoning_content?: string }, finishReason?: string): string {
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
    const transStream = new PassThrough()
    const isThinkingModel = this.model.includes('think') || this.model.includes('r1')
    const isSilentModel = this.model.includes('silent')
    const isFoldModel = (this.model.includes('fold') || this.model.includes('search')) && !isThinkingModel
    const isSearchSilentModel = this.model.includes('search-silent')

    let buffer = ''

    stream.on('data', (chunk: Buffer) => {
      buffer += chunk.toString()
      const lines = buffer.split('\n')
      buffer = lines.pop() || ''

      for (const line of lines) {
        if (!line.trim() || !line.startsWith('data:')) continue

        const data = line.slice(5).trim()
        if (data === '[DONE]') {
          this.handleDone(transStream, isFoldModel, isSearchSilentModel)
          return
        }

        const parsed = this.parseSSE(data)
        if (!parsed) continue

        this.processChunk(parsed, transStream, isThinkingModel, isSilentModel, isFoldModel, isSearchSilentModel)
      }
    })

    stream.on('end', () => {
      this.handleDone(transStream, isFoldModel, isSearchSilentModel)
    })

    stream.on('error', (err) => {
      transStream.emit('error', err)
    })

    return transStream
  }

  private processChunk(
    chunk: StreamChunk,
    transStream: PassThrough,
    isThinkingModel: boolean,
    isSilentModel: boolean,
    isFoldModel: boolean,
    isSearchSilentModel: boolean
  ): void {
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

    const delta: { role?: string; content?: string; reasoning_content?: string } = {}
    if (this.isFirstChunk) {
      delta.role = 'assistant'
      this.isFirstChunk = false
    }

    const cleanedValue = content.replace(/FINISHED/g, '')
    const processedContent = isSearchSilentModel
      ? cleanedValue.replace(/\[citation:(\d+)\]/g, '')
      : cleanedValue.replace(/\[citation:(\d+)\]/g, '[$1]')

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

    transStream.write(this.createChunk({}, 'stop'))
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
        resolve({
          id: `${this.sessionId}@${messageId}`,
          model: this.model,
          object: 'chat.completion',
          choices: [{
            index: 0,
            message: {
              role: 'assistant',
              content: accumulatedContent.trim(),
              reasoning_content: accumulatedThinkingContent.trim(),
            },
            finish_reason: 'stop',
          }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: accumulatedTokenUsage },
          created: this.created,
        })
      })

      stream.on('error', reject)
    })
  }
}
