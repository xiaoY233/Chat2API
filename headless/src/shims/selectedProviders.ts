import * as deepseekModule from '../../../src/main/providers/builtin/deepseek.ts'
import * as glmModule from '../../../src/main/providers/builtin/glm.ts'
import * as kimiModule from '../../../src/main/providers/builtin/kimi.ts'
import * as minimaxModule from '../../../src/main/providers/builtin/minimax.ts'
import * as zaiModule from '../../../src/main/providers/builtin/zai.ts'
import type { BuiltinProviderConfig } from '../../../src/main/store/types.ts'

type ConfigModule = Record<string, any>

function readConfig(module: ConfigModule, exportName: string): BuiltinProviderConfig {
  const value = module[exportName] || module.default?.[exportName] || module.default
  if (!value?.id) throw new Error(`Invalid built-in provider module: ${exportName}`)
  return value as BuiltinProviderConfig
}

const deepseekConfig = readConfig(deepseekModule, 'deepseekConfig')
const glmConfig = readConfig(glmModule, 'glmConfig')
const kimiConfig = readConfig(kimiModule, 'kimiConfig')
const minimaxConfig = readConfig(minimaxModule, 'minimaxConfig')
const zaiConfig = readConfig(zaiModule, 'zaiConfig')

export const builtinProviders: BuiltinProviderConfig[] = [
  deepseekConfig,
  glmConfig,
  kimiConfig,
  minimaxConfig,
  zaiConfig,
]

export const builtinProviderMap: Record<string, BuiltinProviderConfig> = {
  deepseek: deepseekConfig,
  glm: glmConfig,
  kimi: kimiConfig,
  minimax: minimaxConfig,
  zai: zaiConfig,
}

export function getBuiltinProvider(id: string): BuiltinProviderConfig | undefined {
  return builtinProviderMap[id]
}

export function getBuiltinProviders(): BuiltinProviderConfig[] {
  return [...builtinProviders]
}

export { deepseekConfig, glmConfig, kimiConfig, minimaxConfig, zaiConfig }
export default builtinProviders
