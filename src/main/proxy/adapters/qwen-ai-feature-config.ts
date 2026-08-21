export interface QwenAiFeatureConfigOptions {
  thinkingEnabled: boolean
  autoThinking: boolean
  thinkingBudget?: number
}

/** Match qwen.ai's Fast/Thinking feature payload without inventing fields. */
export function createQwenAiFeatureConfig(
  options: QwenAiFeatureConfigOptions,
): Record<string, unknown> {
  const featureConfig: Record<string, unknown> = {
    thinking_enabled: options.thinkingEnabled,
    output_schema: 'phase',
    research_mode: 'normal',
    auto_thinking: options.autoThinking,
    auto_search: false,
  }

  if (options.thinkingEnabled) {
    featureConfig.thinking_format = 'summary'
    if (options.thinkingBudget) {
      featureConfig.thinking_budget = options.thinkingBudget
    }
  }

  return featureConfig
}
