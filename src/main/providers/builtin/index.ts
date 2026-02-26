import deepseekConfig from './deepseek'
import glmConfig from './glm'
import kimiConfig from './kimi'
import minimaxConfig from './minimax'
import qwenConfig from './qwen'
import qwenAiConfig from './qwen-ai'
import zaiConfig from './zai'
import type { BuiltinProviderConfig } from '../../store/types'

export const builtinProviders: BuiltinProviderConfig[] = [
  deepseekConfig,
  glmConfig,
  kimiConfig,
  minimaxConfig,
  qwenConfig,
  qwenAiConfig,
  zaiConfig,
]

export const builtinProviderMap: Record<string, BuiltinProviderConfig> = {
  deepseek: deepseekConfig,
  glm: glmConfig,
  kimi: kimiConfig,
  minimax: minimaxConfig,
  qwen: qwenConfig,
  'qwen-ai': qwenAiConfig,
  zai: zaiConfig,
}

export function getBuiltinProvider(id: string): BuiltinProviderConfig | undefined {
  return builtinProviderMap[id]
}

export function getBuiltinProviders(): BuiltinProviderConfig[] {
  return builtinProviders
}

export {
  deepseekConfig,
  glmConfig,
  kimiConfig,
  minimaxConfig,
  qwenConfig,
  qwenAiConfig,
  zaiConfig,
}

export default builtinProviders
