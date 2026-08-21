/**
 * Client-facing mode aliases for Qwen3.8-Max. These suffixes are never sent
 * upstream: chat.qwen.ai receives the stable qwen3.8-max model id plus the
 * corresponding feature_config flags.
 */
export interface QwenAiModelMode {
  baseModel: string
  thinkingEnabled?: boolean
  autoThinking?: boolean
  /** True when the client supplied an explicit suffix rather than the default. */
  isExplicit: boolean
}

export interface QwenAiModelCatalogue<TCapability = unknown> {
  supportedModels: string[]
  modelMappings: Record<string, string>
  modelCapabilities?: Record<string, TCapability>
}

export interface QwenAiModelCatalogueWithCapabilities<TCapability>
  extends QwenAiModelCatalogue<TCapability> {
  modelCapabilities: Record<string, TCapability>
}

export const QWEN_AI_38_MAX_MODE_ALIASES = [
  'Qwen3.8-Max_Fast',
  'Qwen3.8-Max_Auto',
  'Qwen3.8-Max_Thinking',
] as const

const QWEN_38_MAX = 'qwen3.8-max'

function isQwen38Max(value: string): boolean {
  return value.toLowerCase() === QWEN_38_MAX
}

function mode(baseModel: string, thinkingEnabled: boolean, autoThinking: boolean, isExplicit: boolean): QwenAiModelMode {
  return { baseModel, thinkingEnabled, autoThinking, isExplicit }
}

/**
 * Resolve Qwen3.8-Max aliases without changing unrelated model names.
 *
 * `_TeT_AtF` is the raw form: `Te` controls `thinking_enabled` and `At`
 * controls `auto_thinking`. The three named suffixes are convenient aliases.
 */
export function resolveQwenAiModelMode(modelName: string): QwenAiModelMode {
  const model = modelName.trim()

  if (isQwen38Max(model)) {
    // Qwen3.8-Max defaults to the dedicated Thinking mode, not Auto mode.
    return mode(model, true, false, false)
  }

  const shortcut = /^(qwen3\.8-max)_(fast|auto|thinking)$/i.exec(model)
  if (shortcut) {
    const baseModel = shortcut[1]
    switch (shortcut[2].toLowerCase()) {
      case 'fast':
        return mode(baseModel, false, false, true)
      case 'auto':
        return mode(baseModel, true, true, true)
      default:
        return mode(baseModel, true, false, true)
    }
  }

  const rawFlags = /^(qwen3\.8-max)_te([tf])_at([tf])$/i.exec(model)
  if (rawFlags) {
    return mode(
      rawFlags[1],
      rawFlags[2].toLowerCase() === 't',
      rawFlags[3].toLowerCase() === 't',
      true,
    )
  }

  // Continue accepting the previous hyphen aliases for existing clients.
  const legacyShortcut = /^(qwen3\.8-max)-(fast|auto|thinking)$/i.exec(model)
  if (legacyShortcut) {
    const baseModel = legacyShortcut[1]
    switch (legacyShortcut[2].toLowerCase()) {
      case 'fast':
        return mode(baseModel, false, false, true)
      case 'auto':
        return mode(baseModel, true, true, true)
      default:
        return mode(baseModel, true, false, true)
    }
  }

  return { baseModel: model, isExplicit: false }
}

export function normalizeQwenAiModelModeName(modelName: string): string {
  return resolveQwenAiModelMode(modelName).baseModel
}

/**
 * Add the stable, documented shortcuts after a live catalogue refresh.
 * A catalogue that does not contain Qwen3.8-Max is left unchanged.
 */
export function withQwenAiModelModeAliases<TCapability>(
  catalogue: QwenAiModelCatalogueWithCapabilities<TCapability>,
): QwenAiModelCatalogueWithCapabilities<TCapability>
export function withQwenAiModelModeAliases<TCapability>(
  catalogue: QwenAiModelCatalogue<TCapability>,
): QwenAiModelCatalogue<TCapability>
export function withQwenAiModelModeAliases<TCapability>(
  catalogue: QwenAiModelCatalogue<TCapability>,
): QwenAiModelCatalogue<TCapability> {
  const supportedModels = [...catalogue.supportedModels]
  const modelMappings = { ...catalogue.modelMappings }

  const baseMapping = Object.entries(modelMappings).find(([displayName, modelId]) => (
    isQwen38Max(displayName) || isQwen38Max(modelId)
  ))
  if (!baseMapping) {
    return {
      supportedModels,
      modelMappings,
      ...(catalogue.modelCapabilities ? { modelCapabilities: { ...catalogue.modelCapabilities } } : {}),
    }
  }

  const [, baseModelId] = baseMapping
  for (const alias of QWEN_AI_38_MAX_MODE_ALIASES) {
    if (!supportedModels.some(model => model.toLowerCase() === alias.toLowerCase())) {
      supportedModels.push(alias)
    }
    modelMappings[alias] = baseModelId
  }

  return {
    supportedModels,
    modelMappings,
    ...(catalogue.modelCapabilities ? { modelCapabilities: { ...catalogue.modelCapabilities } } : {}),
  }
}

// Keep this export readable for callers that describe the operation as adding
// aliases rather than returning an immutable catalogue copy.
export const addQwenAiModelModeAliases = withQwenAiModelModeAliases
