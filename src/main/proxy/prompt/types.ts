/**
 * Prompt Variant Types
 * Defines types for model-specific prompt variants
 */

import { ToolCallFormat } from '../adapters/prompt'

/**
 * Prompt variant configuration
 */
export interface PromptVariant {
  id: string
  name: string
  description?: string
  modelPatterns: string[]
  providerPatterns?: string[]
  systemPrompt: string
  toolPromptTemplate: string
  toolCallFormat: ToolCallFormat
  examples?: string[]
  priority?: number
}

/**
 * Prompt variant selector options
 */
export interface PromptVariantSelectorOptions {
  model: string
  provider?: string
  preferVariant?: string
}

/**
 * Built-in variant IDs
 */
export const BUILTIN_VARIANT_IDS = {
  DEFAULT: 'default',
  QWEN: 'qwen',
  DEEPSEEK: 'deepseek',
  GLM: 'glm',
  KIMI: 'kimi',
  MINIMAX: 'minimax',
  ANTHROPIC: 'anthropic',
} as const

export type BuiltinVariantId = typeof BUILTIN_VARIANT_IDS[keyof typeof BUILTIN_VARIANT_IDS]
