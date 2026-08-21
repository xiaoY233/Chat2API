import { normalizeQwenAiModelModeName } from '../../providers/qwen-ai-model-mode.ts'

export interface DeepSeekChatOptionInput {
  model: string
  web_search?: boolean
  reasoning_effort?: string
}

export interface DeepSeekChatOptions {
  modelType: 'default' | 'expert'
  searchEnabled: boolean
  thinkingEnabled: boolean
}

export function resolveDeepSeekChatOptions(
  request: DeepSeekChatOptionInput,
  _prompt: string = ''
): DeepSeekChatOptions {
  const modelLower = request.model.toLowerCase()
  const isProModel = modelLower.includes('deepseek-v4-pro') || modelLower.includes('expert')
  const isSearchAlias = modelLower.includes('search')
  const isThinkingAlias = modelLower.includes('think')
    || modelLower.includes('r1')
    || modelLower.includes('reasoner')

  return {
    modelType: isProModel ? 'expert' : 'default',
    searchEnabled: Boolean(request.web_search) || isSearchAlias,
    thinkingEnabled: Boolean(request.reasoning_effort)
      || isThinkingAlias,
  }
}

export type KimiScenario = 'SCENARIO_K2D5' | 'SCENARIO_OK_COMPUTER'
export type KimiReasoningEffort = 'low' | 'medium' | 'high'

export interface KimiModelOptions {
  scenario: KimiScenario
  kimiplusId?: string
  defaultReasoningEffort: 'REASONING_EFFORT_NONE' | 'REASONING_EFFORT_HIGH'
  contextLength?: 'CONTEXT_LENGTH_L'
}

export function normalizeProviderModelForMatch(model: string): string {
  const baseModel = normalizeQwenAiModelModeName(model).replace(
    /(?:\[1m\]|-(?:web-search|thinking|think|search|fast|r1))+$/i,
    '',
  )
  const normalized = baseModel.toLowerCase()

  if (
    normalized === 'kimi-k2.6'
    || normalized === 'kimi-k2.5'
    || normalized === 'kimi-k2d5'
    || normalized === 'kimi-k2d6'
    || normalized === 'k2d5'
    || normalized === 'k2d6'
  ) {
    return 'Kimi-K2.6'
  }
  return baseModel
}

export function resolveKimiModelOptions(model: string): KimiModelOptions {
  if (model.toLowerCase().includes('k3')) {
    return {
      scenario: 'SCENARIO_OK_COMPUTER',
      kimiplusId: 'ok-computer',
      defaultReasoningEffort: 'REASONING_EFFORT_HIGH',
      contextLength: 'CONTEXT_LENGTH_L',
    }
  }

  // K2.6 is exposed as k2d6 in the current model metadata, while the chat
  // endpoint still selects the SCENARIO_K2D5 backend scenario.
  return {
    scenario: 'SCENARIO_K2D5',
    defaultReasoningEffort: 'REASONING_EFFORT_NONE',
  }
}

export function resolveKimiScenario(model: string): KimiScenario {
  return resolveKimiModelOptions(model).scenario
}

function resolveKimiReasoningEffort(
  modelOptions: KimiModelOptions,
  enableThinking: boolean,
  reasoningEffort?: KimiReasoningEffort,
): 'REASONING_EFFORT_NONE' | 'REASONING_EFFORT_LOW' | 'REASONING_EFFORT_HIGH' | 'REASONING_EFFORT_MAX' {
  if (modelOptions.scenario === 'SCENARIO_OK_COMPUTER') {
    if (reasoningEffort === 'high') return 'REASONING_EFFORT_MAX'
    if (reasoningEffort === 'medium') return 'REASONING_EFFORT_HIGH'
    if (reasoningEffort === 'low') return 'REASONING_EFFORT_LOW'
    return enableThinking ? 'REASONING_EFFORT_HIGH' : modelOptions.defaultReasoningEffort
  }

  return enableThinking || reasoningEffort
    ? 'REASONING_EFFORT_LOW'
    : modelOptions.defaultReasoningEffort
}

export function createKimiChatPayload(options: {
  model: string
  content: string
  enableWebSearch: boolean
  enableThinking: boolean
  reasoningEffort?: KimiReasoningEffort
  chatId?: string
  parentId?: string
  projectId?: string
}) {
  const modelOptions = resolveKimiModelOptions(options.model)
  const scenario = modelOptions.scenario

  return {
    scenario,
    chat_id: options.chatId || '',
    project_id: options.projectId || '',
    ...(modelOptions.kimiplusId ? { kimiplus_id: modelOptions.kimiplusId } : {}),
    tools: options.enableWebSearch
      ? [{ type: 'TOOL_TYPE_SEARCH', search: { force: true } }]
      : [],
    message: {
      parent_id: options.parentId || '',
      role: 'user',
      blocks: [{
        message_id: '',
        text: { content: options.content }
      }],
      scenario,
    },
    options: {
      thinking: true,
      reasoning_effort: resolveKimiReasoningEffort(
        modelOptions,
        options.enableThinking,
        options.reasoningEffort,
      ),
      ...(modelOptions.contextLength ? { context_length: modelOptions.contextLength } : {}),
      enable_plugin: true,
    }
  }
}

export function encodeKimiGrpcFrame(payload: unknown): Buffer {
  const jsonBuffer = Buffer.from(JSON.stringify(payload), 'utf8')
  const frameBuffer = Buffer.alloc(5 + jsonBuffer.length)
  frameBuffer.writeUInt8(0, 0)
  frameBuffer.writeUInt32BE(jsonBuffer.length, 1)
  jsonBuffer.copy(frameBuffer, 5)
  return frameBuffer
}
