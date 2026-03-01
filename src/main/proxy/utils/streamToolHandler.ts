/**
 * Stream Tool Handler Module - Handle tool calls in streaming responses
 * Used by all provider-specific StreamHandlers
 */

import { parseToolCallsFromText } from './toolParser'

export interface ToolCallState {
  contentBuffer: string
  isBufferingToolCall: boolean
  toolCallIndex: number
  hasEmittedToolCall: boolean
}

export function createToolCallState(): ToolCallState {
  return {
    contentBuffer: '',
    isBufferingToolCall: false,
    toolCallIndex: 0,
    hasEmittedToolCall: false
  }
}

/**
 * Process streaming content and detect/parse tool calls
 * Returns the chunks that should be sent to the client
 */
export function processStreamContent(
  content: string,
  state: ToolCallState,
  baseChunk: any,
  isFirstChunk: boolean,
  modelType: string = 'default'
): { chunks: any[], shouldFlush: boolean } {
  const result: any[] = []
  const marker = '[function_calls]'

  if (!content) {
    return { chunks: result, shouldFlush: false }
  }

  state.contentBuffer += content

  // If we are not buffering, check if we should start
  if (!state.isBufferingToolCall) {
    const markerIdx = state.contentBuffer.indexOf('[function_calls]')

    if (markerIdx !== -1) {
      // We found the full marker!
      state.isBufferingToolCall = true
      // If we have text before the marker, send it first
      if (markerIdx > 0) {
        const textBefore = state.contentBuffer.substring(0, markerIdx)
        if (!state.hasEmittedToolCall) {
          result.push({
            ...baseChunk,
            choices: [{
              index: 0,
              delta: { content: textBefore },
              finish_reason: null
            }]
          })
        }
        state.contentBuffer = state.contentBuffer.substring(markerIdx)
      }
    } else {
      // Check if the buffer ends with a partial marker
      let foundPartial = false
      for (let i = 0; i < state.contentBuffer.length; i++) {
        if (state.contentBuffer[i] === '[') {
          const potentialMarker = state.contentBuffer.substring(i)
          if (marker.startsWith(potentialMarker)) {
            state.isBufferingToolCall = true
            foundPartial = true
            if (i > 0) {
              const textBefore = state.contentBuffer.substring(0, i)
              if (!state.hasEmittedToolCall) {
                result.push({
                  ...baseChunk,
                  choices: [{
                    index: 0,
                    delta: { content: textBefore },
                    finish_reason: null
                  }]
                })
              }
              state.contentBuffer = potentialMarker
            }
            break
          }
        }
      }

      if (foundPartial) {
        return { chunks: result, shouldFlush: false }
      }
    }
  }

  if (state.isBufferingToolCall) {
    // Check if the buffer is still a valid prefix or contains the full marker
    const hasFullMarker = state.contentBuffer.includes(marker)
    const isPrefix = marker.startsWith(state.contentBuffer)

    if (!hasFullMarker && !isPrefix) {
      // False alarm, it's not a tool call. Flush buffer and stop buffering.
      state.isBufferingToolCall = false
      // Send the buffered content as normal text
      if (state.contentBuffer && !state.hasEmittedToolCall) {
        result.push({
          ...baseChunk,
          choices: [{
            index: 0,
            delta: { content: state.contentBuffer },
            finish_reason: null
          }]
        })
      }
      state.contentBuffer = ''
      return { chunks: result, shouldFlush: true }
    }

    // Try to parse tool calls from buffer
    const { content: cleanContent, toolCalls } = parseToolCallsFromText(state.contentBuffer, modelType)

    if (toolCalls.length > 0) {
      // We found complete tool calls!
      for (const tc of toolCalls) {
        tc.index = state.toolCallIndex++

        // Remove the rawText property before sending to client
        const rawText = tc.rawText
        delete tc.rawText

        const toolCallData = {
          ...baseChunk,
          choices: [{
            index: 0,
            delta: {
              role: isFirstChunk ? 'assistant' : undefined,
              tool_calls: [tc]
            },
            finish_reason: null
          }]
        }
        result.push(toolCallData)

        // Remove ONLY the parsed tool call from the buffer
        if (rawText) {
          state.contentBuffer = state.contentBuffer.replace(rawText, '')
        }
      }
      state.hasEmittedToolCall = true

      // Check if we still have [function_calls] in the buffer
      if (state.contentBuffer.includes('[/function_calls]')) {
        state.isBufferingToolCall = false
        // Remove the block markers
        state.contentBuffer = state.contentBuffer.replace(/\[\/?function_calls\]/g, '').trim()
      } else {
        state.isBufferingToolCall = state.contentBuffer.includes('[function_calls]')
      }

      // If we emitted a tool call, we should NOT send any remaining text content
      if (!state.isBufferingToolCall) {
        state.contentBuffer = ''
      }

      return { chunks: result, shouldFlush: true }
    } else {
      // Still buffering, waiting for complete JSON or closing tag
      // Safety check: if buffer is too long and no tool call found, flush it
      // Increased to 500,000 to support large write_to_file operations
      if (state.contentBuffer.length > 500000) {
        state.isBufferingToolCall = false
        // Send the buffered content as normal text
        if (!state.hasEmittedToolCall) {
          result.push({
            ...baseChunk,
            choices: [{
              index: 0,
              delta: { content: state.contentBuffer },
              finish_reason: null
            }]
          })
        }
        state.contentBuffer = ''
        return { chunks: result, shouldFlush: true }
      }
      return { chunks: result, shouldFlush: false }
    }
  }

  // Normal text output - send the buffer content
  if (state.contentBuffer) {
    // If we have already emitted a tool call in this stream,
    // we should completely block any further normal text output to prevent mixing.
    if (!state.hasEmittedToolCall) {
      result.push({
        ...baseChunk,
        choices: [{
          index: 0,
          delta: { content: state.contentBuffer },
          finish_reason: null
        }]
      })
    }
    state.contentBuffer = ''
  }

  return { chunks: result, shouldFlush: true }
}

/**
 * Flush any remaining content in the buffer at the end of stream
 */
export function flushToolCallBuffer(
  state: ToolCallState,
  baseChunk: any,
  modelType: string = 'default'
): any[] {
  const result: any[] = []

  if (!state.contentBuffer) {
    return result
  }

  // Final check for tool calls in buffer
  const { content: cleanContent, toolCalls } = parseToolCallsFromText(state.contentBuffer, modelType)

  if (toolCalls.length > 0) {
    for (const tc of toolCalls) {
      tc.index = state.toolCallIndex++
      delete tc.rawText // Remove internal property
      result.push({
        ...baseChunk,
        choices: [{
          index: 0,
          delta: { tool_calls: [tc] },
          finish_reason: null
        }]
      })
    }
    state.hasEmittedToolCall = true
    // Don't send remaining text content if we found tool calls
  } else {
    // No tool calls, just flush content
    if (state.contentBuffer && !state.hasEmittedToolCall) {
      result.push({
        ...baseChunk,
        choices: [{
          index: 0,
          delta: { content: state.contentBuffer },
          finish_reason: null
        }]
      })
    } else if (state.contentBuffer && state.hasEmittedToolCall) {
      console.warn('[StreamToolHandler] Discarding remaining buffer because tool calls were emitted:', state.contentBuffer.substring(0, 200) + '...')
    }
  }

  state.contentBuffer = ''
  return result
}

/**
 * Check if we should block normal content output
 * Returns true if we are currently buffering a potential tool call
 */
export function shouldBlockOutput(state: ToolCallState): boolean {
  return state.isBufferingToolCall && !state.hasEmittedToolCall
}

/**
 * Create a base chunk structure for OpenAI-compatible responses
 */
export function createBaseChunk(id: string, model: string, created: number) {
  return {
    id,
    model,
    object: 'chat.completion.chunk',
    created
  }
}
