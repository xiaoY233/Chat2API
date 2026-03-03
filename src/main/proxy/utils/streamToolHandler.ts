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
  // Support both [function_calls] and <tool_use> formats
  const marker = '[function_calls]'
  const xmlMarker = '<tool_use>'

  if (!content) {
    return { chunks: result, shouldFlush: false }
  }

  state.contentBuffer += content

  // If we are not buffering, check if we should start
  if (!state.isBufferingToolCall) {
    // Check for both [function_calls] and <tool_use> formats anywhere in the buffer
    // Also support missing opening bracket: function_calls]
    const hasBracketMarker = state.contentBuffer.includes('[function_calls]')
    const hasMissingBracket = state.contentBuffer.includes('function_calls]')
    const hasXmlMarker = state.contentBuffer.includes('<tool_use>')
    const hasCallPattern = /\[call[:=]?/.test(state.contentBuffer)
    
    if (hasBracketMarker || hasMissingBracket || hasXmlMarker || hasCallPattern) {
      // Found marker in buffer - start buffering
      state.isBufferingToolCall = true
      // Find the marker position
      let markerIdx = -1
      if (hasBracketMarker) {
        markerIdx = state.contentBuffer.indexOf('[function_calls]')
      } else if (hasMissingBracket) {
        markerIdx = state.contentBuffer.indexOf('function_calls]')
      } else if (hasXmlMarker) {
        markerIdx = state.contentBuffer.indexOf('<tool_use>')
      } else if (hasCallPattern) {
        const match = state.contentBuffer.match(/\[call[:=]?/)
        if (match) markerIdx = match.index || 0
      }
      
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
      // No marker found - check if it starts with potential marker chars
      const firstChar = state.contentBuffer.charAt(0)
      if (firstChar === '<' || firstChar === '[' || firstChar === 'f') {
        // Starts with potential marker - start buffering
        state.isBufferingToolCall = true
      } else {
        // Not a tool call marker - send as normal content
        const content = state.contentBuffer
        state.contentBuffer = ''
        if (!state.hasEmittedToolCall && content) {
          result.push({
            ...baseChunk,
            choices: [{
              index: 0,
              delta: { content: content },
              finish_reason: null
            }]
          })
        }
      }
    }
  } else if (state.isBufferingToolCall) {
    // Check if the buffer contains the full marker (both formats)
    // Also support missing opening bracket: function_calls]
    const hasBracketMarker = state.contentBuffer.includes(marker)
    const hasMissingBracket = state.contentBuffer.includes('function_calls]')
    const hasXmlMarker = state.contentBuffer.includes(xmlMarker)
    const hasCallPattern = /\[call[:=]?/.test(state.contentBuffer)
      const hasFullMarker = hasBracketMarker || hasXmlMarker || hasMissingBracket || hasCallPattern
    
    // Check if buffer starts with potential marker prefix
    const isPrefix = state.contentBuffer.startsWith(marker) || 
                     state.contentBuffer.startsWith(xmlMarker) ||
                     state.contentBuffer.startsWith('function_calls]') ||
                     /\[call[:=]?/.test(state.contentBuffer.substring(0, 50))
    
    // Check if buffer could be a prefix of function_calls]
    const couldBeFunctionCallsPrefix = 'function_calls]'.startsWith(state.contentBuffer) ||
                                        state.contentBuffer.startsWith('function')

    if (!hasFullMarker && !isPrefix && !couldBeFunctionCallsPrefix) {
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
    console.log('[StreamToolHandler] Parsing buffer:', state.contentBuffer.substring(0, 200))
    const { content: cleanContent, toolCalls } = parseToolCallsFromText(state.contentBuffer, modelType)
    console.log('[StreamToolHandler] Parsed toolCalls:', toolCalls.length, toolCalls.map(t => t.function.name))

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

      // Check if we still have tool call markers in the buffer (both formats)
      if (state.contentBuffer.includes('[/function_calls]') || state.contentBuffer.includes('</tool_use>')) {
        state.isBufferingToolCall = false
        // Remove the block markers
        state.contentBuffer = state.contentBuffer
          .replace(/\[\/?function_calls\]/g, '')
          .replace(/<\/?tool_use>/g, '')
          .trim()
      } else {
        state.isBufferingToolCall = state.contentBuffer.includes('[function_calls]') || state.contentBuffer.includes('<tool_use>')
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

  console.log('[StreamToolHandler] flushToolCallBuffer called, buffer length:', state.contentBuffer?.length || 0)
  
  if (!state.contentBuffer) {
    return result
  }

  // Final check for tool calls in buffer
  console.log('[StreamToolHandler] flushToolCallBuffer parsing:', state.contentBuffer.substring(0, 300))
  const { content: cleanContent, toolCalls } = parseToolCallsFromText(state.contentBuffer, modelType)
  console.log('[StreamToolHandler] flushToolCallBuffer parsed toolCalls:', toolCalls.length)

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
