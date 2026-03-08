/**
 * Stream Tool Handler Module - Handle tool calls in streaming responses
 * Used by all provider-specific StreamHandlers
 * 
 * Strategy: Buffer content when [function_calls] marker is detected,
 * parse tool calls and emit them as tool_calls delta instead of text content
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
  
  if (!state.isBufferingToolCall) {
    const markerIdx = state.contentBuffer.indexOf('[function_calls]')
    
    if (markerIdx !== -1) {
      state.isBufferingToolCall = true
      if (markerIdx > 0) {
        const textBefore = state.contentBuffer.substring(0, markerIdx)
        if (!state.hasEmittedToolCall) {
          result.push({
            ...baseChunk,
            choices: [{
              index: 0,
              delta: { 
                ...(isFirstChunk ? { role: 'assistant' } : {}),
                content: textBefore 
              },
              finish_reason: null
            }]
          })
        }
        state.contentBuffer = state.contentBuffer.substring(markerIdx)
      }
    } else {
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
                    delta: { 
                      ...(isFirstChunk ? { role: 'assistant' } : {}),
                      content: textBefore 
                    },
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
    const hasFullMarker = state.contentBuffer.includes(marker)
    const isPrefix = marker.startsWith(state.contentBuffer)
    
    if (!hasFullMarker && !isPrefix) {
      state.isBufferingToolCall = false
      if (state.contentBuffer && !state.hasEmittedToolCall) {
        result.push({
          ...baseChunk,
          choices: [{
            index: 0,
            delta: { 
              ...(isFirstChunk ? { role: 'assistant' } : {}),
              content: state.contentBuffer 
            },
            finish_reason: null
          }]
        })
      }
      state.contentBuffer = ''
      return { chunks: result, shouldFlush: true }
    }
    
    const { content: cleanContent, toolCalls } = parseToolCallsFromText(state.contentBuffer, modelType)
    
    if (toolCalls.length > 0) {
      for (const tc of toolCalls) {
        tc.index = state.toolCallIndex++
        
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
        
        if (rawText) {
          state.contentBuffer = state.contentBuffer.replace(rawText, '')
        }
      }
      state.hasEmittedToolCall = true
      
      if (state.contentBuffer.includes('[/function_calls]')) {
        state.isBufferingToolCall = false
        state.contentBuffer = state.contentBuffer.replace(/\[\/?function_calls\]/g, '').trim()
      } else {
        state.isBufferingToolCall = state.contentBuffer.includes('[function_calls]')
      }
      
      if (!state.isBufferingToolCall) {
        state.contentBuffer = ''
      }
      
      return { chunks: result, shouldFlush: true }
    } else {
      if (state.contentBuffer.length > 500000) {
        state.isBufferingToolCall = false
        if (!state.hasEmittedToolCall) {
          result.push({
            ...baseChunk,
            choices: [{
              index: 0,
              delta: { 
                ...(isFirstChunk ? { role: 'assistant' } : {}),
                content: state.contentBuffer 
              },
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
  
  if (state.contentBuffer) {
    if (!state.hasEmittedToolCall) {
      result.push({
        ...baseChunk,
        choices: [{
          index: 0,
          delta: { 
            ...(isFirstChunk ? { role: 'assistant' } : {}),
            content: state.contentBuffer 
          },
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
  
  const { content: cleanContent, toolCalls } = parseToolCallsFromText(state.contentBuffer, modelType)
  
  if (toolCalls.length > 0) {
    for (const tc of toolCalls) {
      tc.index = state.toolCallIndex++
      delete tc.rawText
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
    // Output any remaining clean content after tool calls
    if (cleanContent && cleanContent.trim()) {
      result.push({
        ...baseChunk,
        choices: [{
          index: 0,
          delta: { content: cleanContent },
          finish_reason: null
        }]
      })
    }
  } else {
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
