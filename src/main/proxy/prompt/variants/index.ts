/**
 * Prompt Variants Index
 * Exports all built-in prompt variants
 */

export { DEFAULT_VARIANT } from './default'
export { XML_VARIANT } from './xml'
export { QWEN_VARIANT } from './qwen'
export { DEEPSEEK_VARIANT } from './deepseek'
export { GLM_VARIANT } from './glm'

import { DEFAULT_VARIANT } from './default'
import { XML_VARIANT } from './xml'
import { QWEN_VARIANT } from './qwen'
import { DEEPSEEK_VARIANT } from './deepseek'
import { GLM_VARIANT } from './glm'
import { PromptVariant } from '../types'

/**
 * All built-in variants
 */
export const BUILTIN_VARIANTS: PromptVariant[] = [
  DEFAULT_VARIANT,
  XML_VARIANT,
  QWEN_VARIANT,
  DEEPSEEK_VARIANT,
  GLM_VARIANT,
]
