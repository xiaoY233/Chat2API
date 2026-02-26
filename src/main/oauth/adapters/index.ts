/**
 * OAuth Adapter Index
 * Export all provider authentication adapters
 */

export { BaseOAuthAdapter } from './base'
export { DeepSeekAdapter } from './deepseek'
export { GLMAdapter } from './glm'
export { KimiAdapter } from './kimi'
export { MiniMaxAdapter } from './minimax'
export { QwenAdapter } from './qwen'
export { QwenAiAdapter } from './qwen-ai'
export { ZaiAdapter } from './zai'
import { BaseOAuthAdapter } from './base'
import { DeepSeekAdapter } from './deepseek'
import { GLMAdapter } from './glm'
import { KimiAdapter } from './kimi'
import { MiniMaxAdapter } from './minimax'
import { QwenAdapter } from './qwen'
import { QwenAiAdapter } from './qwen-ai'
import { ZaiAdapter } from './zai'
import { ProviderType, AdapterConfig } from '../types'

/**
 * Adapter factory function
 */
export function createAdapter(
  providerType: ProviderType,
  config: AdapterConfig
): BaseOAuthAdapter {
  switch (providerType) {
    case 'deepseek':
      return new DeepSeekAdapter(config)
    case 'glm':
      return new GLMAdapter(config)
    case 'kimi':
      return new KimiAdapter(config)
    case 'minimax':
      return new MiniMaxAdapter(config)
    case 'qwen':
      return new QwenAdapter(config)
    case 'qwen-ai':
      return new QwenAiAdapter(config)
    case 'zai':
      return new ZaiAdapter(config)
    default:
      throw new Error(`Unsupported provider type: ${providerType}`)
  }
}

/**
 * Get supported authentication methods for provider
 */
export function getSupportedAuthMethods(providerType: ProviderType): string[] {
  switch (providerType) {
    case 'deepseek':
      return ['manual']
    case 'glm':
      return ['manual']
    case 'kimi':
      return ['manual']
    case 'minimax':
      return ['manual']
    case 'qwen':
      return ['manual', 'cookie']
    case 'qwen-ai':
      return ['manual']
    case 'zai':
      return ['manual']
    default:
      return ['manual']
  }
}
