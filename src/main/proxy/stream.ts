/**
 * Proxy Service Module - Stream Response Handler
 * Properly handles SSE format, supports stream and non-stream response conversion
 */

import { PassThrough, Transform } from 'stream'
import { SSEEvent, ChatCompletionResponse, ChatCompletionChoice, ToolCall } from './types'
import { parseToolCallsFromText } from './utils/toolParser'

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

    // Tool call buffering state
    let contentBuffer = ''
    let isBufferingToolCall = false
    let toolCallIndex = 0

    return new Transform({
      objectMode: true,
      transform(chunk: Buffer, encoding, callback) {
        try {
          const events = parser.parse(chunk.toString())

          for (const event of events) {
            if (event.data === '[DONE]') {
              // Flush any remaining buffer before done
              if (contentBuffer) {
                const finalData = transformChunk({ content: contentBuffer }, model, responseId, created, isFirstChunk)
                if (finalData) {
                  isFirstChunk = false
                  this.push(formatter.formatJSON(finalData))
                }
                contentBuffer = ''
              }
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
            if (!transformedData) continue

            // Handle tool call buffering
            const deltaContent = transformedData.choices[0].delta?.content || ''

            if (deltaContent) {
              contentBuffer += deltaContent

              const marker = '[function_calls]'

              // If we are not buffering, check if we should start
              if (!isBufferingToolCall) {
                const markerIdx = contentBuffer.indexOf(marker)

                if (markerIdx !== -1) {
                  isBufferingToolCall = true
                  // If we have text before the marker, send it first
                  if (markerIdx > 0) {
                    const textBefore = contentBuffer.substring(0, markerIdx)
                    const textData = {
                      ...transformedData,
                      choices: [{
                        index: 0,
                        delta: { content: textBefore },
                        finish_reason: null
                      }]
                    }
                    this.push(formatter.formatJSON(textData))
                  }
                  contentBuffer = contentBuffer.substring(markerIdx)
                } else {
                  // Check for partial marker
                  for (let i = 0; i < contentBuffer.length; i++) {
                    if (contentBuffer[i] === '[') {
                      const potentialMarker = contentBuffer.substring(i)
                      if (marker.startsWith(potentialMarker)) {
                        isBufferingToolCall = true
                        if (i > 0) {
                          const textBefore = contentBuffer.substring(0, i)
                          const textData = {
                            ...transformedData,
                            choices: [{
                              index: 0,
                              delta: { content: textBefore },
                              finish_reason: null
                            }]
                          }
                          this.push(formatter.formatJSON(textData))
                        }
                        contentBuffer = potentialMarker
                        break
                      }
                    }
                  }
                }
              }

              if (isBufferingToolCall) {
                // Try to parse tool calls from buffer
                const { content: cleanContent, toolCalls } = parseToolCallsFromText(contentBuffer)

                if (toolCalls.length > 0) {
                  // We found complete tool calls!
                  for (const tc of toolCalls) {
                    tc.index = toolCallIndex++
                    const toolCallData = {
                      ...transformedData,
                      choices: [{
                        index: 0,
                        delta: {
                          role: isFirstChunk ? 'assistant' : undefined,
                          tool_calls: [tc]
                        },
                        finish_reason: null
                      }]
                    }
                    isFirstChunk = false
                    this.push(formatter.formatJSON(toolCallData))
                  }

                  // Reset buffer with remaining content
                  contentBuffer = cleanContent
                  isBufferingToolCall = contentBuffer.includes('[function_calls]')

                  if (contentBuffer && !isBufferingToolCall) {
                    const textData = {
                      ...transformedData,
                      choices: [{
                        index: 0,
                        delta: { content: contentBuffer },
                        finish_reason: null
                      }]
                    }
                    this.push(formatter.formatJSON(textData))
                    contentBuffer = ''
                  }
                  continue
                } else {
                  // Still buffering, waiting for complete JSON or closing tag
                  // Safety check: if buffer is too long and no tool call found, flush it
                  if (contentBuffer.length > 10000) {
                    isBufferingToolCall = false
                    // Fall through to normal text output
                  } else {
                    continue
                  }
                }
              }

              // Normal text output
              transformedData.choices[0].delta!.content = contentBuffer
              contentBuffer = ''
            }

            // Handle tool_calls in streaming response
            if (parsedData.choices?.[0]?.delta?.tool_calls) {
              transformedData.choices[0].delta!.tool_calls = parsedData.choices[0].delta.tool_calls
            }

            // Only push if we are NOT currently buffering a potential tool call
            if (!isBufferingToolCall) {
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
        if (contentBuffer) {
          // Final check for tool calls in buffer
          const { content: cleanContent, toolCalls } = parseToolCallsFromText(contentBuffer)

          if (toolCalls.length > 0) {
            for (const tc of toolCalls) {
              tc.index = toolCallIndex++
              const toolCallData = {
                id: responseId,
                object: 'chat.completion.chunk',
                created,
                model,
                choices: [{
                  index: 0,
                  delta: {
                    tool_calls: [tc]
                  },
                  finish_reason: null
                }]
              }
              this.push(formatter.formatJSON(toolCallData))
            }
          } else {
            // No tool calls, just flush content
            const finalData = transformChunk({ content: contentBuffer }, model, responseId, created, isFirstChunk)
            if (finalData) {
              this.push(formatter.formatJSON(finalData))
            }
          }
        }
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
    } else if (data.choices?.[0]?.delta?.content !== undefined) {
      delta.content = data.choices[0].delta.content
    } else if (data.choices?.[0]?.text) {
      delta.content = data.choices[0].text
    } else if (data.content !== undefined) {
      delta.content = data.content
    } else if (data.message) {
      delta.content = data.message
    }

    if (data.choices?.[0]?.delta?.reasoning_content) {
      delta.reasoning_content = data.choices[0].delta.reasoning_content
    } else if (data.reasoning_content) {
      delta.reasoning_content = data.reasoning_content
    }

    // Handle tool_calls in streaming response
    if (data.choices?.[0]?.delta?.tool_calls) {
      delta.tool_calls = data.choices[0].delta.tool_calls
    }

    const finishReason = data.choices?.[0]?.finish_reason || data.finish_reason || null

    // Allow null content when there are tool_calls or finish_reason
    if (delta.content === undefined && !delta.reasoning_content && !delta.tool_calls && !finishReason) {
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
      const toolCalls: ToolCall[] = []
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

            // Aggregate tool_calls from streaming chunks
            if (data.choices?.[0]?.delta?.tool_calls) {
              const deltaToolCalls = data.choices[0].delta.tool_calls
              for (const tc of deltaToolCalls) {
                const existing = toolCalls.find(t => t.index === tc.index)
                if (existing) {
                  if (tc.id) existing.id = tc.id
                  if (tc.type) existing.type = tc.type
                  if (tc.function?.name) existing.function.name = tc.function.name
                  if (tc.function?.arguments) existing.function.arguments += tc.function.arguments
                } else {
                  toolCalls.push({
                    index: tc.index,
                    id: tc.id || '',
                    type: tc.type || 'function',
                    function: {
                      name: tc.function?.name || '',
                      arguments: tc.function?.arguments || ''
                    }
                  })
                }
              }
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
        // Parse tool calls from accumulated content
        const { content: cleanContent, toolCalls: parsedToolCalls } = parseToolCallsFromText(content)

        // Merge parsed tool calls with any native tool calls
        const finalToolCalls = [...toolCalls]
        if (parsedToolCalls.length > 0) {
          parsedToolCalls.forEach(ptc => {
            ptc.index += finalToolCalls.length
            finalToolCalls.push(ptc)
          })
        }

        const message: any = {
          role: 'assistant',
          // If we have tool calls, force content to null to avoid client confusion
          content: finalToolCalls.length > 0 ? null : (cleanContent || null),
        }
        if (reasoningContent) {
          message.reasoning_content = reasoningContent.trim()
        }

        if (finalToolCalls.length > 0) {
          // Remove index field and sort by original index
          message.tool_calls = finalToolCalls
            .sort((a, b) => (a.index || 0) - (b.index || 0))
            .map(({ index, ...rest }) => rest)

          // If we have tool calls, finish reason should be tool_calls
          if (!finishReason || finishReason === 'stop') {
            finishReason = 'tool_calls'
          }
        }

        resolve({
          id: responseId,
          object: 'chat.completion',
          created,
          model,
          choices: [{
            index: 0,
            message,
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
