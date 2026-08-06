export type ToolCallingModeSetting = 'off' | 'auto' | 'force'
export type ToolClientAdapterId = 'standard-openai-tools' | 'cherry-studio-mcp' | string
export type ToolSmokeCategory =
  | 'pass'
  | 'no_tools_received'
  | 'model_did_not_call_tool'
  | 'invalid_tool_name'
  | 'parser_failed'
  | 'wrapper_leaked'
  | 'client_did_not_return_tool_result'
  | 'provider_or_account_error'
  | 'not_run'

export interface ToolCallingConfig {
  enabled: boolean
  mode: ToolCallingModeSetting
  clientAdapterId: ToolClientAdapterId
  diagnosticsEnabled: boolean
  advanced: {
    customPromptTemplate?: string
    promptPreviewEnabled: boolean
  }
}

export interface LegacyToolPromptConfig {
  mode?: 'auto' | 'always' | 'never' | string
  defaultFormat?: 'bracket' | 'xml' | string
  customPromptTemplate?: string
  enableToolCallParsing?: boolean
}

export interface ToolClientAdapterMeta {
  id: 'standard-openai-tools' | 'cherry-studio-mcp'
  label: string
  descriptionKey: string
  smokeTestKind: 'openai-tools' | 'cherry-mcp-weather'
}

export interface ToolProviderSupportMeta {
  providerId: 'deepseek' | 'kimi' | 'glm' | 'qwen' | 'mimo'
  label: string
  managed: true
  protocolId: 'managed_xml'
  status: 'supported'
}

export const DEFAULT_TOOL_CALLING_CONFIG: ToolCallingConfig = {
  enabled: true,
  mode: 'auto',
  clientAdapterId: 'standard-openai-tools',
  diagnosticsEnabled: false,
  advanced: {
    promptPreviewEnabled: false,
    customPromptTemplate: undefined,
  },
}

export const P0_TOOL_CLIENT_ADAPTERS: ToolClientAdapterMeta[] = [
  {
    id: 'standard-openai-tools',
    label: 'Standard OpenAI Tools',
    descriptionKey: 'toolCalling.clients.standardOpenAiToolsDesc',
    smokeTestKind: 'openai-tools',
  },
  {
    id: 'cherry-studio-mcp',
    label: 'Cherry Studio MCP',
    descriptionKey: 'toolCalling.clients.cherryStudioMcpDesc',
    smokeTestKind: 'cherry-mcp-weather',
  },
]

export const P0_TOOL_PROVIDER_SUPPORT: ToolProviderSupportMeta[] = [
  { providerId: 'deepseek', label: 'DEEPSEEK', managed: true, protocolId: 'managed_xml', status: 'supported' },
  { providerId: 'kimi', label: 'KIMI', managed: true, protocolId: 'managed_xml', status: 'supported' },
  { providerId: 'glm', label: 'GLM', managed: true, protocolId: 'managed_xml', status: 'supported' },
  { providerId: 'qwen', label: 'QWEN', managed: true, protocolId: 'managed_xml', status: 'supported' },
  { providerId: 'mimo', label: 'MIMO', managed: true, protocolId: 'managed_xml', status: 'supported' },
]

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isMode(value: unknown): value is ToolCallingModeSetting {
  return value === 'off' || value === 'auto' || value === 'force'
}

function isClientAdapterId(value: unknown): value is ToolClientAdapterId {
  return value === 'standard-openai-tools' || value === 'cherry-studio-mcp'
}

export function normalizeToolCallingConfig(value: unknown): ToolCallingConfig {
  if (!isRecord(value)) return DEFAULT_TOOL_CALLING_CONFIG

  if ('defaultFormat' in value || value.mode === 'always' || value.mode === 'never') {
    const legacy = value as LegacyToolPromptConfig
    const enabled = legacy.mode !== 'never'

    return {
      enabled,
      mode: legacy.mode === 'never' ? 'off' : legacy.mode === 'always' ? 'force' : 'auto',
      clientAdapterId: 'standard-openai-tools',
      diagnosticsEnabled: Boolean(legacy.customPromptTemplate) || legacy.enableToolCallParsing === false,
      advanced: {
        promptPreviewEnabled: false,
        customPromptTemplate: typeof legacy.customPromptTemplate === 'string'
          ? legacy.customPromptTemplate
          : undefined,
      },
    }
  }

  const advanced = isRecord(value.advanced) ? value.advanced : {}
  const enabled = typeof value.enabled === 'boolean'
    ? value.enabled
    : DEFAULT_TOOL_CALLING_CONFIG.enabled
  const mode = isMode(value.mode) ? value.mode : DEFAULT_TOOL_CALLING_CONFIG.mode

  return {
    enabled: mode === 'off' ? false : enabled,
    mode,
    clientAdapterId: isClientAdapterId(value.clientAdapterId)
      ? value.clientAdapterId
      : DEFAULT_TOOL_CALLING_CONFIG.clientAdapterId,
    diagnosticsEnabled: typeof value.diagnosticsEnabled === 'boolean'
      ? value.diagnosticsEnabled
      : DEFAULT_TOOL_CALLING_CONFIG.diagnosticsEnabled,
    advanced: {
      promptPreviewEnabled: typeof advanced.promptPreviewEnabled === 'boolean'
        ? advanced.promptPreviewEnabled
        : DEFAULT_TOOL_CALLING_CONFIG.advanced.promptPreviewEnabled,
      customPromptTemplate: typeof advanced.customPromptTemplate === 'string'
        ? advanced.customPromptTemplate
        : undefined,
    },
  }
}
