/**
 * Built-in System Prompts
 */

import type { SystemPrompt } from '../store/types'

/**
 * Built-in System Prompts Array
 */
export const BUILTIN_PROMPTS: SystemPrompt[] = [
  // Tool Use prompt removed - now handled by utils/tools.ts with [function_calls] format
]

/**
 * Get built-in prompt by ID
 */
export function getBuiltinPromptById(id: string): SystemPrompt | undefined {
  return BUILTIN_PROMPTS.find(p => p.id === id)
}
