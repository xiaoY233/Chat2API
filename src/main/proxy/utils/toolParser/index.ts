import { ToolCall } from '../../types'
import { ToolCallFormat } from '../../constants/signatures'

/**
 * 工具调用解析结果
 */
export interface ToolParseResult {
  content: string
  toolCalls: ToolCall[]
  format: ToolCallFormat
  rawMatches: string[]
}

/**
 * 流式处理状态
 */
export interface StreamState {
  contentBuffer: string
  isBufferingToolCall: boolean
  toolCallIndex: number
  hasEmittedToolCall: boolean
}

/**
 * 流式处理结果
 */
export interface StreamParseResult {
  chunks: any[]
  shouldFlush: boolean
}

/**
 * 统一工具调用解析入口
 * 支持 bracket、xml、anthropic、json 格式
 */
export function parseToolCalls(content: string): ToolParseResult {
  if (!content) {
    return { content: '', toolCalls: [], format: 'unknown', rawMatches: [] }
  }

  // 检测格式
  const format = detectToolCallFormat(content)

  console.log('[ToolParser] Detected format:', format)

  let result: { content: string; toolCalls: ToolCall[]; rawMatches: string[] }

  switch (format) {
    case 'bracket':
      result = parseBracketFormat(content)
      break
    case 'xml':
      result = parseXmlFormat(content)
      break
    case 'anthropic':
      result = parseAnthropicFormat(content)
      break
    case 'json':
      result = parseJsonFormat(content)
      break
    default:
      return { content, toolCalls: [], format: 'unknown', rawMatches: [] }
  }

  return { ...result, format }
}

/**
 * 统一流式处理入口
 * 用于处理流式响应中的工具调用
 */
export function parseToolCallsStream(
  content: string,
  state: StreamState
): StreamParseResult {
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
            delta: {
              content: textBefore
            },
            finish_reason: null
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
                  delta: {
                    content: textBefore
                  },
                  finish_reason: null
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
          delta: {
            content: state.contentBuffer
          },
          finish_reason: null
        })
      }
      state.contentBuffer = ''
      return { chunks: result, shouldFlush: true }
    }

    // 使用统一解析器处理缓冲内容
    const { content: cleanContent, toolCalls } = parseToolCalls(state.contentBuffer)

    if (toolCalls.length > 0) {
      for (const tc of toolCalls) {
        tc.index = state.toolCallIndex++

        const rawText = tc.rawText
        delete tc.rawText

        const toolCallData = {
          delta: {
            tool_calls: [tc]
          },
          finish_reason: null
        }
        result.push(toolCallData)

        if (rawText) {
          state.contentBuffer = state.contentBuffer.replace(rawText, '')
        }
      }
      state.hasEmittedToolCall = true

      if (state.contentBuffer.includes('[/function_calls]')) {
        state.isBufferingToolCall = false
        state.contentBuffer = state.contentBuffer.replace(/\[\/\?function_calls\]/g, '').trim()
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
            delta: {
              content: state.contentBuffer
            },
            finish_reason: null
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
        delta: {
          content: state.contentBuffer
        },
        finish_reason: null
      })
    }
    state.contentBuffer = ''
  }

  return { chunks: result, shouldFlush: true }
}

/**
 * 刷新流式缓冲区
 */
export function flushToolCallBuffer(
  state: StreamState
): any[] {
  const result: any[] = []

  if (!state.contentBuffer) {
    return result
  }

  // 使用统一解析器
  const { content: cleanContent, toolCalls } = parseToolCalls(state.contentBuffer)

  if (toolCalls.length > 0) {
    for (const tc of toolCalls) {
      tc.index = state.toolCallIndex++
      delete tc.rawText
      result.push({
        delta: { tool_calls: [tc] },
        finish_reason: null
      })
    }
    state.hasEmittedToolCall = true

    // 输出剩余内容
    if (cleanContent && cleanContent.trim()) {
      result.push({
        delta: { content: cleanContent },
        finish_reason: null
      })
    }
  } else {
    if (state.contentBuffer && !state.hasEmittedToolCall) {
      result.push({
        delta: { content: state.contentBuffer },
        finish_reason: null
      })
    } else if (state.contentBuffer && state.hasEmittedToolCall) {
      console.warn('[StreamHandler] Discarding remaining buffer because tool calls were emitted:', state.contentBuffer.substring(0, 200) + '...')
    }
  }

  state.contentBuffer = ''
  return result
}

/**
 * 检测工具调用格式
 */
function detectToolCallFormat(content: string): ToolCallFormat {
  if (content.includes('[function_calls]') || /\[call[:=]/.test(content)) {
    return 'bracket'
  }

  if (content.includes('<tool_use>')) {
    return 'xml'
  }

  if (content.includes('<antml:function_calls>') || content.includes('antml:function_calls')) {
    return 'anthropic'
  }

  if (/content"\s*:\s*\[/i.test(content) || /"function"\s*:\s*\{/i.test(content)) {
    return 'json'
  }

  return 'bracket'
}

/**
 * 解析 bracket 格式: [function_calls][call:name]{args}[/call][/function_calls]
 */
function parseBracketFormat(content: string): { content: string; toolCalls: ToolCall[]; rawMatches: string[] } {
  const toolCalls: ToolCall[] = []
  const rawMatches: string[] = []
  let cleanContent = content

  let processedText = content
  const missingBracketRegex = /(^|[^\/\[])(function_calls\])/g
  if (!processedText.includes('[function_calls]') && missingBracketRegex.test(processedText)) {
    processedText = processedText.replace(/(^|[^\/\[])(function_calls\])/g, '$1[$2')
  }

  const blockRegex = /\[function_calls\]([\s\S]*?)(?:\[\/function_calls\]|$)/g
  let blockMatch

  while ((blockMatch = blockRegex.exec(processedText)) !== null) {
    const blockContent = blockMatch[1]

    const callStartRegex = /\[call[:=]?([a-zA-Z0-9_:-]+)\]/g
    let callStartMatch

    while ((callStartMatch = callStartRegex.exec(blockContent)) !== null) {
      const functionName = callStartMatch[1]
      const argsStartIndex = callStartMatch.index + callStartMatch[0].length
      const remainingText = blockContent.substring(argsStartIndex)

      let argumentsStr = extractBalancedJson(remainingText)
      let parsed = null

      if (argumentsStr) {
        let cleanArgsStr = argumentsStr.trim()
        if (cleanArgsStr.startsWith('```') && cleanArgsStr.endsWith('```')) {
          cleanArgsStr = cleanArgsStr.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')
        }
        parsed = tryParseJSON(cleanArgsStr)
      }

      if (!parsed) {
        parsed = tryRegexFallback(remainingText)
      }

      if (parsed) {
        let rawTextEndIndex = argsStartIndex + (argumentsStr?.length || 0)
        const afterJson = blockContent.substring(rawTextEndIndex)
        const closeTagMatch = afterJson.match(/^\s*\[\/call\]/)
        if (closeTagMatch) rawTextEndIndex += closeTagMatch[0].length

        const rawText = blockContent.substring(callStartMatch.index, rawTextEndIndex)
        rawMatches.push(rawText)

        toolCalls.push({
          index: toolCalls.length,
          id: `call_${Date.now()}_${toolCalls.length}`,
          type: 'function',
          function: { name: functionName, arguments: JSON.stringify(parsed) },
        })

        callStartRegex.lastIndex = rawTextEndIndex
      }
    }
  }

  for (const raw of rawMatches) {
    cleanContent = cleanContent.replace(raw, '')
  }

  const emptyBlockRegex = /\[function_calls\]\s*\[\/function_calls\]/g
  cleanContent = cleanContent.replace(emptyBlockRegex, '')

  return { content: cleanContent.trim(), toolCalls, rawMatches }
}

/**
 * 解析 XML 格式: <tool_use><name>tool_name</name><arguments>{...}</arguments></tool_use>
 */
function parseXmlFormat(content: string): { content: string; toolCalls: ToolCall[]; rawMatches: string[] } {
  const toolCalls: ToolCall[] = []
  const rawMatches: string[] = []
  let cleanContent = content

  const toolUseRegex = /<tool_use>\s*<name>([^<]+)<\/name>\s*<arguments>([\s\S]*?)<\/arguments>\s*<\/tool_use>/g

  let match
  let index = 0

  while ((match = toolUseRegex.exec(content)) !== null) {
    const rawText = match[0]
    const name = match[1].trim()
    let argsStr = match[2].trim()

    if (argsStr.startsWith('```')) {
      argsStr = argsStr.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')
    }

    const parsed = tryParseJSON(argsStr)

    if (parsed) {
      rawMatches.push(rawText)
      toolCalls.push({
        index: index++,
        id: `call_${Date.now()}_${index}`,
        type: 'function',
        function: {
          name,
          arguments: JSON.stringify(parsed),
        },
      })
    }
  }

  for (const raw of rawMatches) {
    cleanContent = cleanContent.replace(raw, '')
  }

  return { content: cleanContent.trim(), toolCalls, rawMatches }
}

/**
 * 解析 Anthropic 格式: <antml:function_calls>...</antml:function_calls>
 */
function parseAnthropicFormat(content: string): { content: string; toolCalls: ToolCall[]; rawMatches: string[] } {
  const toolCalls: ToolCall[] = []
  const rawMatches: string[] = []
  let cleanContent = content

  const blockRegex = /<antml:function_calls>\s*([\s\S]*?)\s*<\/antml:function_calls>/g
  let blockMatch

  while ((blockMatch = blockRegex.exec(content)) !== null) {
    const blockContent = blockMatch[1]
    rawMatches.push(blockMatch[0])

    const invokeRegex = /<antml:invoke name="([^"]+)">\s*<antml:parameters>([\s\S]*?)<\/antml:parameters>\s*<\/antml:invoke>/g
    let invokeMatch
    let index = 0

    while ((invokeMatch = invokeRegex.exec(blockContent)) !== null) {
      const name = invokeMatch[1]
      const argsStr = invokeMatch[2].trim()

      const parsed = tryParseJSON(argsStr)

      if (parsed) {
        toolCalls.push({
          index: index++,
          id: `call_${Date.now()}_${index}`,
          type: 'function',
          function: {
            name,
            arguments: JSON.stringify(parsed),
          },
        })
      }
    }
  }

  for (const raw of rawMatches) {
    cleanContent = cleanContent.replace(raw, '')
  }

  return { content: cleanContent.trim(), toolCalls, rawMatches }
}

/**
 * 解析 JSON 格式: Standard OpenAI tool_calls JSON
 */
function parseJsonFormat(content: string): { content: string; toolCalls: ToolCall[]; rawMatches: string[] } {
  const toolCalls: ToolCall[] = []
  const rawMatches: string[] = []

  try {
    const parsed = JSON.parse(content)

    if (parsed.tool_calls && Array.isArray(parsed.tool_calls)) {
      for (let i = 0; i < parsed.tool_calls.length; i++) {
        const tc = parsed.tool_calls[i]
        if (tc.function) {
          toolCalls.push({
            index: i,
            id: tc.id || `call_${Date.now()}_${i}`,
            type: 'function',
            function: {
              name: tc.function.name,
              arguments: typeof tc.function.arguments === 'string'
                ? tc.function.arguments
                : JSON.stringify(tc.function.arguments),
            },
          })
        }
      }
      rawMatches.push(content)
      return { content: '', toolCalls, rawMatches }
    }
  } catch {
    // Not valid JSON, try to extract tool_calls pattern
  }

  const toolCallsRegex = /"tool_calls"\s*:\s*\[([\s\S]*?)\]/g
  let match

  while ((match = toolCallsRegex.exec(content)) !== null) {
    const toolCallsStr = `[${match[1]}]`

    try {
      const calls = JSON.parse(toolCallsStr)

      for (let i = 0; i < calls.length; i++) {
        const tc = calls[i]
        if (tc.function) {
          toolCalls.push({
            index: i,
            id: tc.id || `call_${Date.now()}_${i}`,
            type: 'function',
            function: {
              name: tc.function.name,
              arguments: typeof tc.function.arguments === 'string'
                ? tc.function.arguments
                : JSON.stringify(tc.function.arguments),
            },
          })
        }
      }

      rawMatches.push(match[0])
    } catch {
      // Skip invalid JSON
    }
  }

  let cleanContent = content
  for (const raw of rawMatches) {
    cleanContent = cleanContent.replace(raw, '')
  }

  return { content: cleanContent.trim(), toolCalls, rawMatches }
}

/**
 * 提取平衡的 JSON 对象字符串
 */
export function extractBalancedJson(str: string): string | null {
  const startIdx = str.indexOf('{')
  if (startIdx === -1) return null

  let depth = 0
  let inString = false
  let isEscaped = false

  for (let i = startIdx; i < str.length; i++) {
    const char = str[i]

    if (char === '\\' && !isEscaped) {
      isEscaped = true
      continue
    }

    if (char === '"' && !isEscaped) {
      inString = !inString
    } else if (!inString) {
      if (char === '{') {
        depth++
      } else if (char === '}') {
        depth--
        if (depth === 0) {
          return str.substring(startIdx, i + 1)
        }
      }
    }

    isEscaped = false
  }

  return null
}

/**
 * 尝试多种策略解析 JSON
 */
export function tryParseJSON(str: string): any | null {
  if (!str) return null

  // 直接解析
  try {
    return JSON.parse(str)
  } catch {
    // Continue to cleanup attempts
  }

  // 修复字符串内未转义的换行符和制表符
  try {
    let inString = false
    let isEscaped = false
    let fixedStr = ''

    for (let i = 0; i < str.length; i++) {
      const char = str[i]

      if (char === '\\' && !isEscaped) {
        isEscaped = true
        fixedStr += char
      } else if (char === '"' && !isEscaped) {
        inString = !inString
        fixedStr += char
      } else if (inString && (char === '\n' || char === '\r' || char === '\t')) {
        if (char === '\n') fixedStr += '\\n'
        else if (char === '\r') fixedStr += '\\r'
        else if (char === '\t') fixedStr += '\\t'
      } else {
        isEscaped = false
        fixedStr += char
      }
    }

    return JSON.parse(fixedStr)
  } catch {
    // Continue to next attempt
  }

  // 移除 JSON 标记之间的所有换行符和额外空白
  try {
    let inString = false
    let isEscaped = false
    let compactStr = ''

    for (let i = 0; i < str.length; i++) {
      const char = str[i]

      if (char === '\\' && !isEscaped) {
        isEscaped = true
        compactStr += char
      } else if (char === '"' && !isEscaped) {
        inString = !inString
        compactStr += char
      } else if (!inString && (char === '\n' || char === '\r' || char === '\t')) {
        continue
      } else {
        isEscaped = false
        compactStr += char
      }
    }

    return JSON.parse(compactStr)
  } catch {
    // Continue to next attempt
  }

  // 修复键周围缺少引号的问题
  try {
    const fixedStr = str.replace(/([{,]\s*)([a-zA-Z_][a-zA-Z0-9_]*)\s*:/g, '$1"$2":')
    let inString = false
    let isEscaped = false
    let compactStr = ''

    for (let i = 0; i < fixedStr.length; i++) {
      const char = fixedStr[i]
      if (char === '\\' && !isEscaped) {
        isEscaped = true
        compactStr += char
      } else if (char === '"' && !isEscaped) {
        inString = !inString
        compactStr += char
      } else if (!inString && (char === '\n' || char === '\r')) {
        continue
      } else {
        isEscaped = false
        compactStr += char
      }
    }
    return JSON.parse(compactStr)
  } catch {
    // Continue to next attempt
  }

  // 尝试修复单引号 (Python dict 风格)
  try {
    const doubleQuotedStr = str.replace(/'/g, '"')
    return JSON.parse(doubleQuotedStr)
  } catch {
    // All attempts failed
  }

  return null
}

/**
 * 针对特定已知工具的正则回退
 * 这是完全损坏的 JSON 的最后手段
 */
export function tryRegexFallback(str: string): any | null {
  try {
    // 检查是否像 write_to_file
    if (str.includes('"filePath"') && str.includes('"content"')) {
      const filePathMatch = str.match(/"filePath"\s*:\s*"([^"]+)"/)
      if (filePathMatch) {
        const contentStart = str.indexOf('"content"')
        if (contentStart !== -1) {
          const valueStart = str.indexOf('"', contentStart + 9) + 1

          let valueEnd = -1
          const endMatch = str.match(/"\s*\}\s*(?:\[\/call\])?\s*$/)
          if (endMatch) {
            valueEnd = endMatch.index!
          } else {
            return null
          }

          if (valueStart !== 0 && valueEnd > valueStart) {
            const contentValue = str.substring(valueStart, valueEnd)
            return {
              filePath: filePathMatch[1],
              content: contentValue.replace(/\\n/g, '\n').replace(/\\"/g, '"')
            }
          }
        }
      }
    }

    // 检查是否像 replace_in_file
    if (str.includes('"filePath"') && str.includes('"old_str"') && str.includes('"new_str"')) {
      const filePathMatch = str.match(/"filePath"\s*:\s*"([^"]+)"/)
      if (filePathMatch) {
        const oldStrStart = str.indexOf('"old_str"')
        const newStrStart = str.indexOf('"new_str"')

        if (oldStrStart !== -1 && newStrStart !== -1) {
          const oldStrValueStart = str.indexOf('"', oldStrStart + 9) + 1
          const oldStrValueEnd = str.lastIndexOf('"', newStrStart - 1)

          const newStrValueStart = str.indexOf('"', newStrStart + 9) + 1

          let newStrValueEnd = -1
          const endMatch = str.match(/"\s*\}\s*(?:\[\/call\])?\s*$/)
          if (endMatch) {
            newStrValueEnd = endMatch.index!
          } else {
            return null
          }

          if (oldStrValueStart !== 0 && oldStrValueEnd > oldStrValueStart &&
              newStrValueStart !== 0 && newStrValueEnd > newStrValueStart) {

            const oldStrValue = str.substring(oldStrValueStart, oldStrValueEnd)
            const newStrValue = str.substring(newStrValueStart, newStrValueEnd)

            return {
              filePath: filePathMatch[1],
              old_str: oldStrValue.replace(/\\n/g, '\n').replace(/\\"/g, '"'),
              new_str: newStrValue.replace(/\\n/g, '\n').replace(/\\"/g, '"')
            }
          }
        }
      }
    }
  } catch {
    // Regex fallback failed
  }

  return null
}

/**
 * 创建流式状态
 */
export function createStreamState(): StreamState {
  return {
    contentBuffer: '',
    isBufferingToolCall: false,
    toolCallIndex: 0,
    hasEmittedToolCall: false
  }
}

/**
 * 检查是否应该阻止正常输出
 */
export function shouldBlockOutput(state: StreamState): boolean {
  return state.isBufferingToolCall && !state.hasEmittedToolCall
}