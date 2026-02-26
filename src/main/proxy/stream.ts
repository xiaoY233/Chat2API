/**
 * Proxy Service Module - Stream Response Handler
 * Properly handles SSE format, supports stream and non-stream response conversion
 */

import { PassThrough, Transform } from 'stream'
import { SSEEvent, ChatCompletionResponse, ChatCompletionChoice } from './types'

/**
 * SSE Parser
 */
export class SSEParser {
  private buffer: string = ''

  /**
   * Parse SSE data
   */
  parse(data: string): SSEEvent[] {
    this.buffer += data
    const events: SSEEvent[] = []
    const lines = this.buffer.split('\n')
    this.buffer = lines.pop() || ''

    let currentEvent: Partial<SSEEvent> = {}

    for (const line of lines) {
      if (line === '') {
        if (currentEvent.data !== undefined) {
          events.push({
            event: currentEvent.event,
            data: currentEvent.data,
            id: currentEvent.id,
            retry: currentEvent.retry,
          })
        }
        currentEvent = {}
        continue
      }

      const colonIndex = line.indexOf(':')
      if (colonIndex === -1) {
        continue
      }

      const field = line.slice(0, colonIndex)
      let value = line.slice(colonIndex + 1)

      if (value.startsWith(' ')) {
        value = value.slice(1)
      }

      switch (field) {
        case 'event':
          currentEvent.event = value
          break
        case 'data':
          currentEvent.data = (currentEvent.data || '') + value
          break
        case 'id':
          currentEvent.id = value
          break
        case 'retry':
          currentEvent.retry = parseInt(value, 10)
          break
      }
    }

    return events
  }

  /**
   * Reset parser
   */
  reset(): void {
    this.buffer = ''
  }
}

/**
 * SSE Formatter
 */
export class SSEFormatter {
  /**
   * Format SSE event
   */
  format(event: SSEEvent): string {
    let result = ''

    if (event.id) {
      result += `id: ${event.id}\n`
    }

    if (event.event) {
      result += `event: ${event.event}\n`
    }

    if (event.retry !== undefined) {
      result += `retry: ${event.retry}\n`
    }

    result += `data: ${event.data}\n\n`

    return result
  }

  /**
   * Format JSON data
   */
  formatJSON(data: object, event?: string): string {
    return this.format({
      event,
      data: JSON.stringify(data),
    })
  }

  /**
   * Format done marker
   */
  formatDone(): string {
    return 'data: [DONE]\n\n'
  }
}

/**
 * Stream Response Handler
 */
export class StreamHandler {
  private parser: SSEParser
  private formatter: SSEFormatter

  constructor() {
    this.parser = new SSEParser()
    this.formatter = new SSEFormatter()
  }

  /**
   * Create SSE transform stream
   * Converts upstream response to OpenAI compatible format
   */
  createTransformStream(
    model: string,
    responseId: string,
    onEnd?: () => void
  ): Transform {
    let isFirstChunk = true
    const created = Math.floor(Date.now() / 1000)
    const parser = this.parser
    const formatter = this.formatter
    const transformChunk = this.transformChunk.bind(this)

    return new Transform({
      objectMode: true,
      transform(chunk: Buffer, encoding, callback) {
        try {
          const events = parser.parse(chunk.toString())

          for (const event of events) {
            if (event.data === '[DONE]') {
              this.push(formatter.formatDone())
              continue
            }

            let parsedData: any
            try {
              parsedData = JSON.parse(event.data)
            } catch {
              this.push(formatter.format(event))
              continue
            }

            const transformedData = transformChunk(parsedData, model, responseId, created, isFirstChunk)
            if (transformedData) {
              isFirstChunk = false
              this.push(formatter.formatJSON(transformedData))
            }
          }

          callback()
        } catch (error) {
          callback(error as Error)
        }
      },

      flush(callback) {
        this.push(formatter.formatDone())
        onEnd?.()
        callback()
      },
    })
  }

  /**
   * Transform chunk to OpenAI format
   */
  private transformChunk(
    data: any,
    model: string,
    responseId: string,
    created: number,
    isFirstChunk: boolean
  ): ChatCompletionResponse | null {
    if (!data) return null

    const delta: ChatCompletionChoice['delta'] = {}

    if (isFirstChunk) {
      delta.role = 'assistant'
    }

    if (typeof data === 'string') {
      delta.content = data
    } else if (data.choices?.[0]?.delta?.content) {
      delta.content = data.choices[0].delta.content
    } else if (data.choices?.[0]?.text) {
      delta.content = data.choices[0].text
    } else if (data.content) {
      delta.content = data.content
    } else if (data.message) {
      delta.content = data.message
    } else if (data.text) {
      delta.content = data.text
    }

    if (data.choices?.[0]?.delta?.reasoning_content) {
      delta.reasoning_content = data.choices[0].delta.reasoning_content
    } else if (data.reasoning_content) {
      delta.reasoning_content = data.reasoning_content
    }

    const finishReason = data.choices?.[0]?.finish_reason || data.finish_reason || null

    if (!delta.content && !delta.reasoning_content && !finishReason) {
      return null
    }

    return {
      id: responseId,
      object: 'chat.completion.chunk',
      created,
      model,
      choices: [{
        index: 0,
        delta,
        finish_reason: finishReason,
      }],
    }
  }

  /**
   * Convert stream response to non-stream response
   */
  async streamToResponse(
    stream: NodeJS.ReadableStream,
    model: string,
    responseId: string
  ): Promise<ChatCompletionResponse> {
    return new Promise((resolve, reject) => {
      let content = ''
      let reasoningContent = ''
      let finishReason: ChatCompletionChoice['finish_reason'] = null
      const created = Math.floor(Date.now() / 1000)

      stream.on('data', (chunk: Buffer) => {
        const events = this.parser.parse(chunk.toString())

        for (const event of events) {
          if (event.data === '[DONE]') continue

          try {
            const data = JSON.parse(event.data)

            if (data.choices?.[0]?.delta?.content) {
              content += data.choices[0].delta.content
            } else if (data.choices?.[0]?.text) {
              content += data.choices[0].text
            } else if (data.content) {
              content += data.content
            } else if (data.text) {
              content += data.text
            }

            if (data.choices?.[0]?.delta?.reasoning_content) {
              reasoningContent += data.choices[0].delta.reasoning_content
            } else if (data.reasoning_content) {
              reasoningContent += data.reasoning_content
            }

            if (data.choices?.[0]?.finish_reason) {
              finishReason = data.choices[0].finish_reason
            }
          } catch {
            // Ignore parse errors
          }
        }
      })

      stream.on('end', () => {
        resolve({
          id: responseId,
          object: 'chat.completion',
          created,
          model,
          choices: [{
            index: 0,
            message: {
              role: 'assistant',
              content: content.trim(),
              ...(reasoningContent && { reasoning_content: reasoningContent.trim() }),
            },
            finish_reason: finishReason || 'stop',
          }],
          usage: {
            prompt_tokens: 0,
            completion_tokens: 0,
            total_tokens: 0,
          },
        })
      })

      stream.on('error', reject)
    })
  }

  /**
   * Create PassThrough stream for SSE response
   */
  createPassThrough(): PassThrough {
    return new PassThrough()
  }

  /**
   * Write SSE event to stream
   */
  writeSSEEvent(stream: PassThrough, data: object): void {
    stream.write(this.formatter.formatJSON(data))
  }

  /**
   * Write SSE done marker
   */
  writeSSEDone(stream: PassThrough): void {
    stream.write(this.formatter.formatDone())
    stream.end()
  }

  /**
   * Create error response stream
   */
  createErrorStream(model: string, responseId: string, error: string): PassThrough {
    const stream = new PassThrough()
    const created = Math.floor(Date.now() / 1000)

    stream.write(this.formatter.formatJSON({
      id: responseId,
      object: 'chat.completion.chunk',
      created,
      model,
      choices: [{
        index: 0,
        delta: {
          role: 'assistant',
          content: error,
        },
        finish_reason: 'stop',
      }],
    }))

    stream.write(this.formatter.formatDone())
    stream.end()

    return stream
  }
}

export const streamHandler = new StreamHandler()
export default streamHandler
