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

export type KimiScenario = 'SCENARIO_OK_COMPUTER' | 'SCENARIO_K2D5' | 'SCENARIO_K2D6' | 'SCENARIO_CHAT'

export interface KimiChatModelOptions {
  scenario: KimiScenario
  modelId?: string
  kimiPlusId?: string
}

// Scenario/model values mirror the web client's GetAvailableModels config:
// K3 / K3.1 Pro use k3-agent and K2.8 Preview uses k28-agent-preview, both under
// the OK Computer agent scenario with the ok-computer kimiplus id. K2.6 keeps
// SCENARIO_K2D6; anything else falls back to the default chat scenario.
export function resolveKimiChatModel(model: string): KimiChatModelOptions {
  const modelLower = model.toLowerCase()
  if (modelLower.includes('k3')) {
    return {
      scenario: 'SCENARIO_OK_COMPUTER',
      modelId: 'k3-agent',
      kimiPlusId: 'ok-computer',
    }
  }
  if (modelLower.includes('k2.8') || modelLower.includes('k28')) {
    return {
      scenario: 'SCENARIO_OK_COMPUTER',
      modelId: 'k28-agent-preview',
      kimiPlusId: 'ok-computer',
    }
  }
  if (modelLower.includes('k2.6') || modelLower.includes('k2d6')) {
    return { scenario: 'SCENARIO_K2D6' }
  }
  return { scenario: 'SCENARIO_CHAT', modelId: 'k2d6-chat' }
}

export function resolveKimiScenario(model: string): KimiScenario {
  return resolveKimiChatModel(model).scenario
}

export function createKimiChatPayload(options: {
  model: string
  content: string
  enableWebSearch: boolean
  enableThinking: boolean
}) {
  const chatModel = resolveKimiChatModel(options.model)
  const scenario = chatModel.scenario

  return {
    scenario,
    chat_id: '',
    ...(chatModel.kimiPlusId ? { kimiplusId: chatModel.kimiPlusId } : {}),
    tools: options.enableWebSearch ? [{ type: 'TOOL_TYPE_SEARCH', search: {} }] : [],
    message: {
      parent_id: '',
      role: 'user',
      blocks: [{
        message_id: '',
        text: { content: options.content }
      }],
      scenario,
    },
    options: {
      thinking: options.enableThinking,
      ...(chatModel.modelId ? { model: chatModel.modelId } : {}),
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
