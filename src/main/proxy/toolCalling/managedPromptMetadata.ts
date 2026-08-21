import type { ChatMessage } from '../types.ts'

export const MANAGED_TOOL_PROMPT_MESSAGE_NAME = 'chat2api_managed_tool_prompt'

export interface ManagedToolDocumentPrompt {
  content: string
  referenceContent: string
}

const documentPrompts = new WeakMap<ChatMessage, ManagedToolDocumentPrompt>()

export function createManagedToolPromptMessage(
  content: string,
  documentPrompt?: ManagedToolDocumentPrompt,
): ChatMessage {
  const message: ChatMessage = {
    role: 'system',
    name: MANAGED_TOOL_PROMPT_MESSAGE_NAME,
    content,
  }

  if (documentPrompt) {
    documentPrompts.set(message, Object.freeze({ ...documentPrompt }))
  }
  return message
}

export function isManagedToolPromptMessage(message: ChatMessage): boolean {
  return message.role === 'system'
    && message.name === MANAGED_TOOL_PROMPT_MESSAGE_NAME
}

export function getManagedToolDocumentPrompt(
  message: ChatMessage,
): ManagedToolDocumentPrompt | undefined {
  return documentPrompts.get(message)
}
