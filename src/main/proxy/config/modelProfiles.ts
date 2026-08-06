import { ToolCallFormat } from '../constants/signatures'

/**
 * 模型配置文件
 * 定义每个模型的特征，包括是否支持原生函数调用、首选格式等
 */
export interface ModelProfile {
  id: string
  nativeFunctionCalling: boolean
  preferredFormat: ToolCallFormat
  parsingStrategy: 'legacy' | 'balanced'
  streamHandlerType: 'bracket' | 'xml' | 'anthropic' | 'json'
}

/**
 * 模型配置映射
 * 按模型ID定义配置
 */
export const MODEL_PROFILES: Record<string, ModelProfile> = {
  // OpenAI 模型
  'gpt-4': {
    id: 'gpt-4',
    nativeFunctionCalling: true,
    preferredFormat: 'json',
    parsingStrategy: 'balanced',
    streamHandlerType: 'json'
  },
  'gpt-4-turbo': {
    id: 'gpt-4-turbo',
    nativeFunctionCalling: true,
    preferredFormat: 'json',
    parsingStrategy: 'balanced',
    streamHandlerType: 'json'
  },
  'gpt-4o': {
    id: 'gpt-4o',
    nativeFunctionCalling: true,
    preferredFormat: 'json',
    parsingStrategy: 'balanced',
    streamHandlerType: 'json'
  },
  'gpt-4o-mini': {
    id: 'gpt-4o-mini',
    nativeFunctionCalling: true,
    preferredFormat: 'json',
    parsingStrategy: 'balanced',
    streamHandlerType: 'json'
  },
  'gpt-3.5-turbo': {
    id: 'gpt-3.5-turbo',
    nativeFunctionCalling: true,
    preferredFormat: 'json',
    parsingStrategy: 'balanced',
    streamHandlerType: 'json'
  },

  // Anthropic 模型
  'claude-3': {
    id: 'claude-3',
    nativeFunctionCalling: true,
    preferredFormat: 'anthropic',
    parsingStrategy: 'balanced',
    streamHandlerType: 'anthropic'
  },
  'claude-3.5': {
    id: 'claude-3.5',
    nativeFunctionCalling: true,
    preferredFormat: 'anthropic',
    parsingStrategy: 'balanced',
    streamHandlerType: 'anthropic'
  },
  'claude-sonnet': {
    id: 'claude-sonnet',
    nativeFunctionCalling: true,
    preferredFormat: 'anthropic',
    parsingStrategy: 'balanced',
    streamHandlerType: 'anthropic'
  },
  'claude-opus': {
    id: 'claude-opus',
    nativeFunctionCalling: true,
    preferredFormat: 'anthropic',
    parsingStrategy: 'balanced',
    streamHandlerType: 'anthropic'
  },
  'claude-haiku': {
    id: 'claude-haiku',
    nativeFunctionCalling: true,
    preferredFormat: 'anthropic',
    parsingStrategy: 'balanced',
    streamHandlerType: 'anthropic'
  },

  // Google Gemini 模型
  'gemini-1.5': {
    id: 'gemini-1.5',
    nativeFunctionCalling: true,
    preferredFormat: 'json',
    parsingStrategy: 'balanced',
    streamHandlerType: 'json'
  },
  'gemini-2.0': {
    id: 'gemini-2.0',
    nativeFunctionCalling: true,
    preferredFormat: 'json',
    parsingStrategy: 'balanced',
    streamHandlerType: 'json'
  },

  // DeepSeek 模型
  'deepseek': {
    id: 'deepseek',
    nativeFunctionCalling: false,
    preferredFormat: 'bracket',
    parsingStrategy: 'balanced',
    streamHandlerType: 'bracket'
  },
  'deepseek-v3.2': {
    id: 'deepseek-v3.2',
    nativeFunctionCalling: false,
    preferredFormat: 'bracket',
    parsingStrategy: 'balanced',
    streamHandlerType: 'bracket'
  },

  // GLM 模型
  'glm': {
    id: 'glm',
    nativeFunctionCalling: false,
    preferredFormat: 'bracket',
    parsingStrategy: 'legacy',
    streamHandlerType: 'bracket'
  },
  'glm-4': {
    id: 'glm-4',
    nativeFunctionCalling: false,
    preferredFormat: 'bracket',
    parsingStrategy: 'legacy',
    streamHandlerType: 'bracket'
  },
  'glm-4v': {
    id: 'glm-4v',
    nativeFunctionCalling: false,
    preferredFormat: 'bracket',
    parsingStrategy: 'legacy',
    streamHandlerType: 'bracket'
  },

  // Kimi 模型
  'kimi': {
    id: 'kimi',
    nativeFunctionCalling: false,
    preferredFormat: 'bracket',
    parsingStrategy: 'legacy',
    streamHandlerType: 'bracket'
  },

  // Qwen 模型
  'qwen': {
    id: 'qwen',
    nativeFunctionCalling: false,
    preferredFormat: 'bracket',
    parsingStrategy: 'balanced',
    streamHandlerType: 'bracket'
  },
  'qwen-turbo': {
    id: 'qwen-turbo',
    nativeFunctionCalling: false,
    preferredFormat: 'bracket',
    parsingStrategy: 'balanced',
    streamHandlerType: 'bracket'
  },
  'qwen-plus': {
    id: 'qwen-plus',
    nativeFunctionCalling: false,
    preferredFormat: 'bracket',
    parsingStrategy: 'balanced',
    streamHandlerType: 'bracket'
  },
  'qwen-max': {
    id: 'qwen-max',
    nativeFunctionCalling: false,
    preferredFormat: 'bracket',
    parsingStrategy: 'balanced',
    streamHandlerType: 'bracket'
  },

  // MiniMax 模型
  'minimax': {
    id: 'minimax',
    nativeFunctionCalling: false,
    preferredFormat: 'bracket',
    parsingStrategy: 'legacy',
    streamHandlerType: 'bracket'
  },

  // Z.ai 模型
  'zai': {
    id: 'zai',
    nativeFunctionCalling: false,
    preferredFormat: 'bracket',
    parsingStrategy: 'legacy',
    streamHandlerType: 'bracket'
  },

  // Perplexity 模型
  'perplexity': {
    id: 'perplexity',
    nativeFunctionCalling: false,
    preferredFormat: 'bracket',
    parsingStrategy: 'balanced',
    streamHandlerType: 'bracket'
  },

  // 通用默认配置
  'default': {
    id: 'default',
    nativeFunctionCalling: false,
    preferredFormat: 'bracket',
    parsingStrategy: 'balanced',
    streamHandlerType: 'bracket'
  }
}

/**
 * 获取模型配置
 * @param model 模型名称
 * @param provider 提供商名称
 * @returns 模型配置
 */
export function getModelProfile(model: string, provider?: string): ModelProfile {
  // 优先匹配精确模型ID
  if (model && MODEL_PROFILES[model.toLowerCase()]) {
    return MODEL_PROFILES[model.toLowerCase()]
  }

  // 匹配模型前缀
  const lowerModel = model?.toLowerCase() || ''
  for (const key of Object.keys(MODEL_PROFILES)) {
    if (key === 'default') continue
    if (lowerModel.includes(key)) {
      return MODEL_PROFILES[key]
    }
  }

  // 如果有提供商信息，尝试匹配提供商特定的模型
  if (provider) {
    const lowerProvider = provider.toLowerCase()

    // 特定提供商的模型模式
    if (lowerProvider.includes('deepseek')) {
      return MODEL_PROFILES['deepseek']
    } else if (lowerProvider.includes('glm')) {
      return MODEL_PROFILES['glm']
    } else if (lowerProvider.includes('kimi')) {
      return MODEL_PROFILES['kimi']
    } else if (lowerProvider.includes('qwen')) {
      return MODEL_PROFILES['qwen']
    } else if (lowerProvider.includes('minimax')) {
      return MODEL_PROFILES['minimax']
    } else if (lowerProvider.includes('zai')) {
      return MODEL_PROFILES['zai']
    } else if (lowerProvider.includes('perplexity')) {
      return MODEL_PROFILES['perplexity']
    }
  }

  // 默认配置
  return MODEL_PROFILES['default']
}

/**
 * 检查模型是否支持原生函数调用
 * @param model 模型名称
 * @param provider 提供商名称
 * @returns 是否支持原生函数调用
 */
export function isNativeFunctionCallingModel(model: string, provider?: string): boolean {
  const profile = getModelProfile(model, provider)
  return profile.nativeFunctionCalling
}

/**
 * 获取模型的首选工具调用格式
 * @param model 模型名称
 * @param provider 提供商名称
 * @returns 首选格式
 */
export function getPreferredFormat(model: string, provider?: string): ToolCallFormat {
  const profile = getModelProfile(model, provider)
  return profile.preferredFormat
}

/**
 * 获取模型的流式处理类型
 * @param model 模型名称
 * @param provider 提供商名称
 * @returns 流式处理类型
 */
export function getStreamHandlerType(model: string, provider?: string): 'bracket' | 'xml' | 'anthropic' | 'json' {
  const profile = getModelProfile(model, provider)
  return profile.streamHandlerType
}

/**
 * 获取模型的解析策略
 * @param model 模型名称
 * @param provider 提供商名称
 * @returns 解析策略
 */
export function getParsingStrategy(model: string, provider?: string): 'legacy' | 'balanced' {
  const profile = getModelProfile(model, provider)
  return profile.parsingStrategy
}

/**
 * 获取所有可用的模型ID
 */
export function getAvailableModelIds(): string[] {
  return Object.keys(MODEL_PROFILES).filter(key => key !== 'default')
}