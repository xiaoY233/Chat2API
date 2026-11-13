import type { ChatMessage } from '../types.ts'
import type { NormalizedToolDefinition } from './types.ts'
import { detectClientFromContent } from '../constants/signatures.ts'

const CODING_CLIENTS = new Set([
  'cline',
  'rooCode',
  'claudeCode',
  'kilocode',
  'codexCli',
  'vscodeAgent',
])

const CODING_TOOL_NAME_PATTERN =
  /(?:^|[:._-])(read|write|edit|create|delete|list|glob|grep|bash|shell|exec|command|terminal|patch|apply|view|open|move|copy|replace|insert)(?:[:._-]|$)/i

const CODING_TOOL_NAMES = new Set([
  'read_file',
  'write_file',
  'edit_file',
  'create_file',
  'delete_file',
  'list_dir',
  'list_files',
  'search_files',
  'find_files',
  'view_file',
  'open_file',
  'apply_patch',
  'str_replace',
  'str_replace_editor',
  'replace_in_file',
  'write_to_file',
  'execute_command',
  'run_command',
  'run_terminal_cmd',
  'bash',
  'shell',
  'terminal',
  'todo_write',
  'update_todo_list',
  'browser_action',
  'use_mcp_tool',
  'attempt_completion',
  'ask_followup_question',
])

const CODING_PARAMETER_NAMES = new Set([
  'filePath',
  'file_path',
  'path',
  'command',
  'cmd',
  'content',
  'oldString',
  'old_string',
  'newString',
  'new_string',
  'patch',
  'pattern',
  'glob',
  'query',
  'cwd',
  'workdir',
])

const CODING_TEXT_PATTERNS = [
  /\bopencode\b/i,
  /\baider\b/i,
  /\bcontinue\.dev\b/i,
  /\bcursor\b/i,
  /\bwindsurf\b/i,
  /\bswe-agent\b/i,
  /\bcoding agent\b/i,
  /\bsoftware engineering\b/i,
  /\bcodebase\b/i,
  /\brepository\b/i,
  /\bapply_patch\b/i,
  /\bstr_replace_editor\b/i,
  /\bdefault_api:/i,
  /\bYou are (?:Cline|Roo|Kilo|Claude Code|Codex)\b/i,
]

export function isCodingToolRequest(
  messages: ChatMessage[],
  tools: NormalizedToolDefinition[],
): boolean {
  if (tools.length === 0) return false

  const text = extractText(messages)
  if (text) {
    const detection = detectClientFromContent(text)
    if (CODING_CLIENTS.has(detection.clientType)) return true
    if (CODING_TEXT_PATTERNS.some((pattern) => pattern.test(text))) return true
  }

  for (const tool of tools) {
    if (CODING_TOOL_NAMES.has(tool.name)) return true
    if (tool.name.includes('default_api:')) return true
    if (CODING_TOOL_NAME_PATTERN.test(tool.name)) return true

    const properties = tool.parameters?.properties
    if (properties && typeof properties === 'object') {
      const names = Object.keys(properties as Record<string, unknown>)
      if (names.some((name) => CODING_PARAMETER_NAMES.has(name))) return true
    }
  }

  return false
}

function extractText(messages: ChatMessage[]): string {
  const parts: string[] = []
  for (const message of messages) {
    if (message.role !== 'system' && message.role !== 'user') continue
    parts.push(textFromContent(message.content))
  }
  return parts.join('\n')
}

function textFromContent(content: ChatMessage['content']): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .filter((part) => typeof part === 'object' && part !== null && 'text' in part)
      .map((part) => String((part as { text?: unknown }).text ?? ''))
      .join('\n')
  }
  return ''
}

export function stripManagedToolPrompt(messages: ChatMessage[]): ChatMessage[] {
  return messages.map((message) => {
    if (message.role !== 'system' || typeof message.content !== 'string') return message
    const content = message.content
      .replace(/<!--\s*chat2api:managed-tools\s*-->[\s\S]*$/i, '')
      .replace(/\n{3,}/g, '\n\n')
      .trim()
    return { ...message, content }
  })
}

/**
 * Remove tool-format instruction sections injected by coding clients and by
 * earlier Chat2API requests. The coding prompt is appended afterwards, so the
 * model sees one unambiguous tool protocol instead of several competing ones.
 */
export function cleanConflictingToolPrompts(messages: ChatMessage[]): ChatMessage[] {
  return messages.map((message) => {
    if (message.role !== 'system' || typeof message.content !== 'string') return message

    let content = message.content

    content = content.replace(/<!--\s*chat2api:managed-tools\s*-->[\s\S]*$/i, '')
    content = content.replace(
      /\n?## (?:Available Tools|Tool Call Protocol|Tool Calling \(Coding Mode\))[^\n]*\n[\s\S]*?(?=\n## (?!Available Tools|Tool Call Protocol|Tool Calling \(Coding Mode\))|$)/gi,
      '',
    )
    content = content.replace(/#+\s*TOOL USE[\s\S]*?(?=#+\s*USER'S CURRENT REQUEST|$)/gi, '')
    content = content.replace(/#+\s*Tool Use Guidelines[\s\S]*?(?=\n#+\s|\z)/gi, '')
    content = content.replace(/## Tools\s*\n[\s\S]*?(?=\n## |\z)/gi, '')
    content = content.replace(/Tool definitions:[\s\S]*?(?=\n## |\z)/gi, '')
    content = content.replace(
      /In this environment you have access to a set of tools[\s\S]*?(?=# User Instructions|\z)/gi,
      '',
    )

    content = content.replace(/\n{3,}/g, '\n\n').trim()
    return { ...message, content }
  })
}
