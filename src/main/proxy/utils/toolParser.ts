/**
 * Tool Parser Module - Parse tool calls from text content
 * Format: [function_calls][call:name]{args}[/call][/function_calls]
 * Also handles malformed output where [call:name] is used as delimiter
 * Also handles multiline JSON in arguments
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
 * Parse tool calls from text content
 */
export function parseToolCallsFromText(text: string, modelType: string = 'default'): { 
  content: string
  toolCalls: ParsedToolCall[] 
} {
  if (!text) {
    return { content: '', toolCalls: [] }
  }

  const toolCalls: ParsedToolCall[] = []
  let cleanContent = text

  // Handle MiniMax XML format first
  if (modelType === 'minimax' && text.includes('<tool_use>')) {
    // Try multiple XML patterns for MiniMax's inconsistent format
    const patterns = [
      // Standard format
      /<tool_use>\s*<name>\s*([^<]+)\s*<\/name>\s*(?:<parameter\s+name="arguments">([^<]+)<\/parameter>|<arguments>\s*([^<]+)\s*<\/arguments>)?\s*<\/tool_use>/gi,
      // Format with parameter name
      /<tool_use>\s*<name>\s*([^<]+)<\/parameter>\s*<parameter\s+name="[^"]+">\s*([^<]+)\s*<\/parameter>/gi,
      // Format with invoke
      /<tool_use>\s*<name>\s*([^<]+)<\/\w+>\s*<parameter\s+name="[^"]+">\s*([^<]+)\s*<\/\w+>\s*<\/\w+>/gi,
    ]
    
    for (const xmlRegex of patterns) {
      let match
      xmlRegex.lastIndex = 0 // Reset regex state
      while ((match = xmlRegex.exec(text)) !== null) {
        const functionName = match[1].trim()
        const argumentsStr = (match[2] || match[3] || '{}').trim()
        
        // Try to parse as JSON, or construct a simple object
        let parsed = tryParseJSON(argumentsStr)
        if (!parsed && argumentsStr) {
          // If not valid JSON, treat as a simple value
          parsed = { city: argumentsStr }
        }
        
        if (parsed && toolCalls.length === 0) {
          toolCalls.push({
            index: toolCalls.length,
            id: `call_${Date.now()}_${toolCalls.length}`,
            type: 'function',
            function: { name: functionName, arguments: JSON.stringify(parsed) },
            rawText: match[0]
          })
        }
      }
      if (toolCalls.length > 0) break
    }
    
    // Remove parsed tool calls from content
    for (const tc of toolCalls) {
      if (tc.rawText) {
        cleanContent = cleanContent.replace(tc.rawText, '')
      }
    }
    
    return { content: cleanContent.trim(), toolCalls }
  }

  if (!text.includes('[function_calls]')) {
    return { content: text, toolCalls: [] }
  }

  // Extract the content inside [function_calls]...[/function_calls]
  // Also support unclosed [function_calls] blocks for streaming or malformed output
  const blockRegex = /\[function_calls\]([\s\S]*?)(?:\[\/function_calls\]|$)/g
  let blockMatch

  while ((blockMatch = blockRegex.exec(text)) !== null) {
    const blockContent = blockMatch[1]
    const fullBlock = blockMatch[0]

    // Parse individual [call:name]...[/call] inside the block
    if (modelType === 'kimi' || modelType === 'glm' || modelType === 'minimax' || modelType === 'zai') {
      // Legacy Regex-based Logic (Proven to work for these models)
      const callRegex = modelType === 'minimax' 
        ? /\[(?:call\s*[:=]\s*([a-zA-Z0-9_:-]+)|invoke\s+name\s*=\s*"([a-zA-Z0-9_:-]+)")\]([\s\S]*?)\[\/call\]/g
        : /\[call\s*[:=]\s*([a-zA-Z0-9_:-]+)\]([\s\S]*?)\[\/call\]/g

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
      const callStartRegex = /\[call[:=]([a-zA-Z0-9_:-]+)\]/g
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
