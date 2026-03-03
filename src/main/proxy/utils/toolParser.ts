/**
 * Tool Parser Module - Parse tool calls from text content
 * 
 * Supported formats:
 * 1. Bracket format: [function_calls][call:name]{args}[/call][/function_calls]
 * 2. XML format (MiniMax): <tool_use><name>...</name><arguments>...</arguments></tool_use>
 * 
 * All formats are normalized to the standard OpenAI tool_calls format
 */

export interface ParsedToolCall {
  index: number
  id: string
  type: 'function'
  function: {
    name: string
    arguments: string
  }
  rawText?: string
}

/**
 * Normalize XML format to bracket format for consistent parsing
 * This handles MiniMax's XML output format
 */
export function normalizeToolCallFormat(text: string, modelType: string): string {
  if (modelType !== 'minimax') return text
  
  // Convert <tool_use> XML format to [function_calls] bracket format
  let normalized = text
  
  // Pattern 1: Standard XML format
  // <tool_use><name>func</name><arguments>{"arg": "value"}</arguments></tool_use>
  const xmlPattern1 = /<tool_use>\s*<name>\s*([^<]+)\s*<\/name>\s*<arguments>\s*([\s\S]*?)\s*<\/arguments>\s*<\/tool_use>/gi
  normalized = normalized.replace(xmlPattern1, (match, name, args) => {
    return `[function_calls]\n[call:${name.trim()}]${args.trim()}[/call]\n[/function_calls]`
  })
  
  // Pattern 2: Parameter format
  // <tool_use><name>func</name><parameter name="arguments">{"arg": "value"}</parameter></tool_use>
  const xmlPattern2 = /<tool_use>\s*<name>\s*([^<]+)\s*<\/name>\s*<parameter\s+name="arguments">\s*([\s\S]*?)\s*<\/parameter>\s*<\/tool_use>/gi
  normalized = normalized.replace(xmlPattern2, (match, name, args) => {
    return `[function_calls]\n[call:${name.trim()}]${args.trim()}[/call]\n[/function_calls]`
  })
  
  // Pattern 3: Simple value format (no JSON)
  // <tool_use><name>func</name>simple_value</tool_use>
  const xmlPattern3 = /<tool_use>\s*<name>\s*([^<]+)\s*<\/name>([\s\S]*?)<\/tool_use>/gi
  normalized = normalized.replace(xmlPattern3, (match, name, value) => {
    const trimmedValue = value.trim()
    // If it's not already JSON, wrap it
    if (trimmedValue && !trimmedValue.startsWith('{') && !trimmedValue.startsWith('[')) {
      return `[function_calls]\n[call:${name.trim()}]{"value":"${trimmedValue}"}[/call]\n[/function_calls]`
    }
    return match
  })
  
  return normalized
}

/**
 * Parse tool calls from text content
 */
export function parseToolCallsFromText(text: string, modelType: string = 'default'): { 
  content: string
  toolCalls: ParsedToolCall[] 
} {
  console.log('[ToolParser] parseToolCallsFromText called, modelType:', modelType, 'text length:', text?.length || 0)
  if (!text) {
    return { content: '', toolCalls: [] }
  }

  const toolCalls: ParsedToolCall[] = []
  let cleanContent = text

  // Normalize XML format to bracket format for MiniMax and DeepSeek (both use XML format)
  const normalizedText = normalizeToolCallFormat(text, modelType === 'default' ? 'deepseek' : modelType)
  console.log('[ToolParser] normalizedText:', normalizedText.substring(0, 200))
  
  // Support both [function_calls] and function_calls] (missing opening bracket)
  const hasFunctionCalls = normalizedText.includes('[function_calls]') || 
                           normalizedText.includes('function_calls]') ||
                           /\[call[:=]/.test(normalizedText)
  
  console.log('[ToolParser] hasFunctionCalls:', hasFunctionCalls)
  
  if (!hasFunctionCalls) {
    return { content: text, toolCalls: [] }
  }

  // Prepend missing opening bracket if needed
  let processedText = normalizedText
  if (!processedText.includes('[function_calls]') && processedText.includes('function_calls]')) {
    processedText = '[' + processedText
    console.log('[ToolParser] Prepended opening bracket, processedText:', processedText.substring(0, 100))
  }

  // Extract the content inside [function_calls]...[/function_calls]
  // Also support unclosed [function_calls] blocks for streaming or malformed output
  const blockRegex = /\[function_calls\]([\s\S]*?)(?:\[\/function_calls\]|$)/g
  let blockMatch

  while ((blockMatch = blockRegex.exec(processedText)) !== null) {
    const blockContent = blockMatch[1]
    console.log('[ToolParser] blockContent:', blockContent?.substring(0, 200))

    // Parse individual [call:name]...[/call] inside the block
    if (modelType === 'kimi' || modelType === 'glm' || modelType === 'minimax' || modelType === 'zai') {
      // Legacy Regex-based Logic (Proven to work for these models)
      // Support [call:name], [call:=name], [call := name] formats
      const callRegex = modelType === 'minimax' 
        ? /\[(?:call\s*[:=]\s*([a-zA-Z0-9_:-]+)|invoke\s+name\s*=\s*"([a-zA-Z0-9_:-]+)")\]([\s\S]*?)\[\/call\]/g
        : /\[call\s*[:=]?\s*([a-zA-Z0-9_:-]+)\]([\s\S]*?)\[\/call\]/g

      let match
      while ((match = callRegex.exec(blockContent)) !== null) {
        const functionName = match[1] || match[2]
        let argumentsStr = ''
        if (modelType === 'minimax') {
          argumentsStr = (match[3] || '').trim()
        } else {
          argumentsStr = (match[2] || '').trim()
        }

        // Clean up markdown
        if (argumentsStr.startsWith('```') && argumentsStr.endsWith('```')) {
          argumentsStr = argumentsStr.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')
        }

        const parsed = tryParseJSON(argumentsStr)
        if (parsed) {
          toolCalls.push({
            index: toolCalls.length,
            id: `call_${Date.now()}_${toolCalls.length}`,
            type: 'function',
            function: { name: functionName, arguments: JSON.stringify(parsed) },
            rawText: match[0]
          })
        }
      }
    } else {
      // Modern Balanced-Braces Logic (Specifically for Qwen to handle nested tags)
      // Support both [call:name] and [call:=name] formats
      const callStartRegex = /\[call[:=]?([a-zA-Z0-9_:-]+)\]/g
      let callStartMatch

      while ((callStartMatch = callStartRegex.exec(blockContent)) !== null) {
        const functionName = callStartMatch[1]
        const argsStartIndex = callStartMatch.index + callStartMatch[0].length
        const remainingText = blockContent.substring(argsStartIndex)

        let argumentsStr = extractBalancedJson(remainingText)
        let jsonEndIndex = -1
        let parsed = null

        if (argumentsStr) {
          const startIdx = remainingText.indexOf('{')
          jsonEndIndex = startIdx + argumentsStr.length
          let cleanArgsStr = argumentsStr.trim()
          if (cleanArgsStr.startsWith('```') && cleanArgsStr.endsWith('```')) {
            cleanArgsStr = cleanArgsStr.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')
          }
          parsed = tryParseJSON(cleanArgsStr)
        }

        if (!parsed) {
          parsed = tryRegexFallback(remainingText)
          if (parsed) {
            const endCallIdx = remainingText.indexOf('[/call]')
            jsonEndIndex = endCallIdx !== -1 ? endCallIdx : remainingText.length
          }
        }

        if (parsed) {
          let rawTextEndIndex = argsStartIndex + jsonEndIndex
          const afterJson = blockContent.substring(rawTextEndIndex)
          const closeTagMatch = afterJson.match(/^\s*\[\/call\]/)
          if (closeTagMatch) rawTextEndIndex += closeTagMatch[0].length

          toolCalls.push({
            index: toolCalls.length,
            id: `call_${Date.now()}_${toolCalls.length}`,
            type: 'function',
            function: { name: functionName, arguments: JSON.stringify(parsed) },
            rawText: blockContent.substring(callStartMatch.index, rawTextEndIndex)
          })
          callStartRegex.lastIndex = rawTextEndIndex
        }
      }
    }

    // Remove the parsed calls from content
    for (const tc of toolCalls) {
      if (tc.rawText) {
        cleanContent = cleanContent.replace(tc.rawText, '')
      }
    }

    // If the block is now empty (except for [function_calls] tags and whitespace), remove the tags too
    // Only remove if we found the closing tag
    if (blockContent.includes('[/function_calls]')) {
      const emptyBlockRegex = /\[function_calls\]\s*\[\/function_calls\]/g
      cleanContent = cleanContent.replace(emptyBlockRegex, '')
    }
  }

  return {
    content: cleanContent.trim(),
    toolCalls
  }
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

  // Try direct parse first
  try {
    return JSON.parse(str)
  } catch (e) {
    // Continue to cleanup attempts
  }

  // Attempt 1: Fix unescaped newlines and tabs inside string values
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
        // Replace unescaped control characters inside string with escaped versions
        if (char === '\n') fixedStr += '\\n'
        else if (char === '\r') fixedStr += '\\r'
        else if (char === '\t') fixedStr += '\\t'
      } else {
        isEscaped = false
        fixedStr += char
      }
    }

    return JSON.parse(fixedStr)
  } catch (e) {
    // Continue to next attempt
  }

  // Attempt 2: Remove all newlines and extra whitespace between JSON tokens
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
        // Skip whitespace outside strings
        continue
      } else {
        isEscaped = false
        compactStr += char
      }
    }

    return JSON.parse(compactStr)
  } catch (e) {
    // Continue to next attempt
  }

  // Attempt 3: Try to fix common issues like missing quotes around keys
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
  } catch (e) {
    // Continue to next attempt
  }

  // Attempt 4: Try to fix single quotes (Python dict style)
  try {
    const doubleQuotedStr = str.replace(/'/g, '"')
    return JSON.parse(doubleQuotedStr)
  } catch (e) {
    // All attempts failed
  }

  return null
}

/**
 * Regex fallback for specific known tools (write_to_file, replace_in_file)
 * This is a last resort for completely broken JSON
 */
function tryRegexFallback(str: string): any | null {
  try {
    // Check if it looks like write_to_file
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

    // Check if it looks like replace_in_file
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
  } catch (e) {
    // Regex fallback failed
  }

  return null
}
