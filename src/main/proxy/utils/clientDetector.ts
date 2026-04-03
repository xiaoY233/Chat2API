/**
 * Client Detector Module
 * Detects client type and tool source from messages
 */

import { ChatMessage } from '../types'
import {
  ClientType,
  ToolCallFormat,
  ToolSource,
  CLIENT_SIGNATURES,
  GENERAL_TOOL_SIGNATURES,
  detectClientFromContent,
  hasGeneralToolPromptSignature,
  isKnownClient,
} from '../constants/signatures'

/**
 * Client detection result
 */
export interface ClientDetectionResult {
  clientType: ClientType
  isKnownClient: boolean
  toolSource: ToolSource
  toolCallFormat: ToolCallFormat
  injectsPrompt: boolean
  confidence: number
  matchedSignatures: string[]
  tools: any[] | null
  hasMCPDefinitions: boolean
}

/**
 * Tool detection result
 */
export interface ToolDetectionResult {
  source: ToolSource
  tools: any[] | null
  hasMCPDefinitions: boolean
}

/**
 * Extract all text content from messages
 */
function extractAllContent(messages: ChatMessage[]): string {
  const parts: string[] = []

  for (const msg of messages) {
    if (msg.role === 'system' || msg.role === 'user' || msg.role === 'assistant') {
      if (typeof msg.content === 'string') {
        parts.push(msg.content)
      } else if (Array.isArray(msg.content)) {
        for (const part of msg.content) {
          if (typeof part === 'string') {
            parts.push(part)
          } else if (part && typeof part === 'object' && 'text' in part) {
            parts.push((part as { text: string }).text)
          }
        }
      }
    }
  }

  return parts.join('\n')
}

/**
 * Detect MCP tool definitions in messages
 * MCP tools are defined using <tools><tool>...</tool></tools> XML format
 */
function detectMCPToolDefinitions(messages: ChatMessage[]): {
  hasMCPDefinitions: boolean
  tools: any[] | null
} {
  const allContent = extractAllContent(messages)

  const toolsMatch = allContent.match(/<tools>([\s\S]*?)<\/tools>/i)
  if (!toolsMatch) {
    return { hasMCPDefinitions: false, tools: null }
  }

  const toolsContent = toolsMatch[1]
  const toolMatches = toolsContent.matchAll(/<tool>([\s\S]*?)<\/tool>/gi)
  const tools: any[] = []

  for (const match of toolMatches) {
    const toolContent = match[1]

    const nameMatch = toolContent.match(/<name>([^<]*)<\/name>/i)
    const descMatch = toolContent.match(/<description>([^<]*)<\/description>/i)
    const argsMatch = toolContent.match(/<arguments>([\s\S]*?)<\/arguments>/i)

    if (nameMatch) {
      tools.push({
        type: 'function',
        function: {
          name: nameMatch[1].trim(),
          description: descMatch ? descMatch[1].trim() : '',
          parameters: argsMatch ? parseMCPArguments(argsMatch[1]) : {},
        },
      })
    }
  }

  return {
    hasMCPDefinitions: tools.length > 0,
    tools: tools.length > 0 ? tools : null,
  }
}

/**
 * Parse MCP arguments format to JSON schema
 */
function parseMCPArguments(argsContent: string): Record<string, unknown> {
  try {
    const properties: Record<string, unknown> = {}
    const required: string[] = []

    const propsMatch = argsContent.match(/<properties>([\s\S]*?)<\/properties>/i)
    if (propsMatch) {
      const propMatches = propsMatch[1].matchAll(
        /<property>\s*<name>([^<]*)<\/name>\s*<type>([^<]*)<\/type>([\s\S]*?)<\/property>/gi
      )

      for (const match of propMatches) {
        const name = match[1].trim()
        const type = match[2].trim().toLowerCase()
        const descMatch = match[3].match(/<description>([^<]*)<\/description>/i)

        properties[name] = {
          type: type === 'string' || type === 'str' ? 'string' : type,
          description: descMatch ? descMatch[1].trim() : '',
        }
      }
    }

    const requiredMatch = argsContent.match(/<required>([\s\S]*?)<\/required>/i)
    if (requiredMatch) {
      const reqItems = requiredMatch[1].matchAll(/<item>([^<]*)<\/item>/gi)
      for (const match of reqItems) {
        required.push(match[1].trim())
      }
    }

    return {
      type: 'object',
      properties,
      required: required.length > 0 ? required : undefined,
    }
  } catch {
    return { type: 'object', properties: {} }
  }
}

/**
 * Detect tool source from request
 */
function detectToolSource(
  messages: ChatMessage[],
  openaiTools: any[] | undefined
): ToolDetectionResult {
  if (openaiTools && openaiTools.length > 0) {
    return {
      source: 'openai',
      tools: openaiTools,
      hasMCPDefinitions: false,
    }
  }

  const mcpResult = detectMCPToolDefinitions(messages)
  if (mcpResult.hasMCPDefinitions) {
    return {
      source: 'mcp',
      tools: mcpResult.tools,
      hasMCPDefinitions: true,
    }
  }

  return {
    source: 'none',
    tools: null,
    hasMCPDefinitions: false,
  }
}

/**
 * Detect client and tool information from messages
 */
export function detectClient(
  messages: ChatMessage[],
  openaiTools?: any[]
): ClientDetectionResult {
  const allContent = extractAllContent(messages)
  const clientResult = detectClientFromContent(allContent)
  const toolResult = detectToolSource(messages, openaiTools)

  return {
    clientType: clientResult.clientType,
    isKnownClient: isKnownClient(clientResult.clientType),
    toolSource: toolResult.source,
    toolCallFormat: clientResult.toolCallFormat,
    injectsPrompt: clientResult.injectsPrompt,
    confidence: clientResult.confidence,
    matchedSignatures: clientResult.matchedSignatures,
    tools: toolResult.tools,
    hasMCPDefinitions: toolResult.hasMCPDefinitions,
  }
}

/**
 * Check if any tool prompt has been injected
 */
export function hasToolPromptInjected(messages: ChatMessage[]): boolean {
  const allContent = extractAllContent(messages)
  return hasGeneralToolPromptSignature(allContent)
}

/**
 * Check if client has injected prompt
 */
export function hasClientInjectedPrompt(messages: ChatMessage[]): boolean {
  const result = detectClient(messages)
  return result.isKnownClient && result.injectsPrompt
}

/**
 * Get tool call format for client
 */
export function getToolCallFormatForClient(clientType: ClientType): ToolCallFormat {
  const config = CLIENT_SIGNATURES[clientType]
  return config?.toolCallFormat || 'bracket'
}

/**
 * Get prompt section markers for client
 */
export function getPromptSectionMarkers(
  clientType: ClientType
): { start: string; end: string } | null {
  const config = CLIENT_SIGNATURES[clientType]
  return config?.promptSectionMarkers || null
}

/**
 * Remove tool prompt section from content
 */
export function removeToolPromptSection(content: string, clientType: ClientType): string {
  const markers = getPromptSectionMarkers(clientType)
  if (!markers) {
    return content
  }

  const startIndex = content.indexOf(markers.start)
  if (startIndex === -1) {
    return content
  }

  const endIndex = content.indexOf(markers.end)
  if (endIndex !== -1 && endIndex > startIndex) {
    return (content.slice(0, startIndex) + content.slice(endIndex)).trim()
  }

  return content.slice(0, startIndex).trim()
}

/**
 * Clean tool prompts from messages
 */
export function cleanToolPrompts(messages: ChatMessage[]): ChatMessage[] {
  const allContent = extractAllContent(messages)
  const clientResult = detectClientFromContent(allContent)

  if (!clientResult.promptSectionMarkers) {
    return messages
  }

  return messages.map((msg) => {
    if (msg.role === 'system' && typeof msg.content === 'string') {
      const cleanedContent = removeToolPromptSection(msg.content, clientResult.clientType)
      if (cleanedContent !== msg.content) {
        return { ...msg, content: cleanedContent }
      }
    }
    return msg
  })
}

export type { ClientType, ToolCallFormat, ToolSource }
