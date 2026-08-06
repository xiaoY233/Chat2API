/**
 * Unified Tool Parser Module
 * Parses tool calls from multiple formats (bracket, XML, Anthropic, JSON)
 */

import { ToolCall } from '../types'

/**
 * Supported tool call formats
 */
export type ToolCallFormat = 'bracket' | 'xml' | 'anthropic' | 'json' | 'unknown'

/**
 * Parsed tool call result
 */
export interface UnifiedParseResult {
  content: string
  toolCalls: ToolCall[]
  format: ToolCallFormat
  rawMatches: string[]
}

/**
 * Detect the tool call format in content
 */
export function detectToolCallFormat(content: string): ToolCallFormat {
  if (content.includes('[function_calls]') || /\[call[:=]/.test(content)) {
    return 'bracket'
  }
  
  if (content.includes('<tool_use>')) {
    return 'xml'
  }
  
  if (content.includes('<antml:function_calls>') || content.includes('antml:function_calls')) {
    return 'anthropic'
  }
  
  if (/"tool_calls"\s*:/i.test(content) || /"function"\s*:\s*\{/i.test(content)) {
    return 'json'
  }
  
  return 'unknown'
}

/**
 * Parse tool calls from content using all supported formats
 */
export function parseToolCallsUnified(content: string): UnifiedParseResult {
  const format = detectToolCallFormat(content)
  
  console.log('[UnifiedToolParser] Detected format:', format)
  
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
 * Parse bracket format: [function_calls][call:name]{args}[/call][/function_calls]
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
 * Parse XML format: <tool_use><name>tool_name</name><arguments>{...}</arguments></tool_use>
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
 * Parse Anthropic format: <antml:function_calls>...</antml:function_calls>
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
 * Parse JSON format: Standard OpenAI tool_calls JSON
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
 * Extract a balanced JSON object string starting from the first '{'
 */
function extractBalancedJson(str: string): string | null {
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
 * Try to parse JSON with multiple fallback strategies
 */
function tryParseJSON(str: string): any | null {
  if (!str) return null

  try {
    return JSON.parse(str)
  } catch {
    // Continue to cleanup attempts
  }

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

  try {
    const doubleQuotedStr = str.replace(/'/g, '"')
    return JSON.parse(doubleQuotedStr)
  } catch {
    // All attempts failed
  }

  return null
}

/**
 * Regex fallback for specific known tools (write_to_file, replace_in_file)
 */
function tryRegexFallback(str: string): any | null {
  try {
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
