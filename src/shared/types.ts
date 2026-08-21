export type AccountStatus = 'active' | 'inactive' | 'expired' | 'error'

export type ProviderStatus = 'online' | 'offline' | 'unknown'

export type ProviderType = 'builtin' | 'custom'

// Provider vendor type (for OAuth adapters)
export type ProviderVendor = 'deepseek' | 'glm' | 'kimi' | 'mimo' | 'minimax' | 'qwen' | 'qwen-ai' | 'zai' | 'perplexity' | 'custom'

export type AuthType = 
  | 'oauth' 
  | 'token' 
  | 'cookie' 
  | 'userToken' 
  | 'refresh_token' 
  | 'jwt' 
  | 'realUserID_token' 
  | 'tongyi_sso_ticket'

export interface CredentialField {
  name: string
  label: string
  type: 'text' | 'password' | 'textarea'
  required: boolean
  placeholder?: string
  helpText?: string
}

export type LoadBalanceStrategy = 'round-robin' | 'fill-first' | 'failover'

export type Theme = 'light' | 'dark' | 'system'

export type QwenAiSessionMode = 'legacy' | 'tool-call-binding'

export interface QwenAiGovernorConfig {
  autoTuneEnabled: boolean
  autoTuneMaxConcurrent: number
  autoTuneMinGlobalIntervalMs: number
  maxConcurrent: number
  globalMinIntervalMs: number
  accountMinIntervalMs: number
  riskCooldownMs: number
  maxRiskCooldownMs: number
  failureCooldownMs: number
  globalRiskCooldownMs: number
  maxGlobalRiskCooldownMs: number
  riskWindowMs: number
  globalRiskThreshold: number
}

export interface QwenAiGovernorEffectiveConfig extends QwenAiGovernorConfig {
  configuredMaxConcurrent: number
  configuredGlobalMinIntervalMs: number
  healthyAccountCount: number
  coolingAccountCount: number
  autoTuneReason: string
}

export interface QwenAiAccountFailoverRecord {
  requestId?: string
  status?: number
  errorCode?: string
  attempt: number
  accountFault?: boolean
  timestamp: number
}

export interface QwenAiGovernorAccountStatus {
  accountId: string
  accountName: string
  providerId: string
  providerName: string
  status: AccountStatus
  queuedRequests: number
  activeRequests: number
  nextAvailableAt?: number
  nextAvailableInMs: number
  governorCooldownUntil?: number
  governorCooldownInMs: number
  governorCooldownReason?: string
  governorFailures: number
  loadBalancerCooldownUntil?: number
  loadBalancerCooldownInMs: number
  loadBalancerRecoveryUntil?: number
  loadBalancerRecoveryInMs: number
  loadBalancerReason?: string
  loadBalancerFailures: number
  recentFailover?: QwenAiAccountFailoverRecord
  /** Whether the stored cookies contain the Qwen Web session token used for routing. */
  webSessionReady?: boolean
  webSessionRepairable?: boolean
  webSessionRepairState?: 'ready' | 'pending' | 'repairing' | 'backoff' | 'unrepairable'
  webSessionNextAttemptAt?: number
}

export interface QwenAiGovernorStatus {
  config: QwenAiGovernorConfig
  effectiveConfig: QwenAiGovernorEffectiveConfig
  queueSize: number
  /** Requests currently occupying slots, split by scheduler class. */
  normalActiveRequests: number
  compactionActiveRequests: number
  normalQueuedRequests: number
  compactionQueuedRequests: number
  /** Effective compaction cap after reserving slots for normal traffic. */
  compactionMaxConcurrent: number
  normalReservedSlots: number
  activeRequests: number
  globalNextAvailableAt?: number
  globalNextAvailableInMs: number
  globalCooldownUntil?: number
  globalCooldownInMs: number
  globalCooldownReason?: string
  globalFailures: number
  globalRecoveryProbeActive: boolean
  globalRecoveryProbeAccountId?: string
  globalRecoveryNextAt?: number
  globalRecoveryNextInMs: number
  recentRiskEvents: number
  recentRiskAccounts: number
  sessionRepair?: {
    running: boolean
    inFlightAccountId?: string
    nextRunAt?: number
    globalPauseUntil?: number
  }
  accounts: QwenAiGovernorAccountStatus[]
}

export type {
  LegacyToolPromptConfig,
  ToolCallingConfig,
} from './toolCalling'

export interface Account {
  id: string
  providerId: string
  name: string
  email?: string
  credentials: Record<string, string>
  status: AccountStatus
  lastUsed?: number
  createdAt: number
  updatedAt: number
  errorMessage?: string
  requestCount?: number
  dailyLimit?: number
  todayUsed?: number
}

export interface ProviderModelCapability {
  /** Whether the provider permits skipping its reasoning/thinking phase. */
  thinkingSkippable?: boolean
  /** Maximum input context reported by the provider model catalogue. */
  maxContextLength?: number
  /** Maximum tokens reserved for a provider-generated context summary. */
  maxSummaryGenerationLength?: number
}

export interface Provider {
  id: string
  name: string
  type: ProviderType
  authType: AuthType
  apiEndpoint: string
  chatPath?: string
  headers: Record<string, string>
  enabled: boolean
  createdAt: number
  updatedAt: number
  description?: string
  icon?: string
  supportedModels?: string[]
  modelMappings?: Record<string, string>
  modelCapabilities?: Record<string, ProviderModelCapability>
  modelsApiEndpoint?: string
  modelsApiHeaders?: Record<string, string>
  status?: ProviderStatus
  lastStatusCheck?: number
}

export interface ModelMapping {
  requestModel: string
  actualModel: string
  preferredProviderId?: string
  preferredAccountId?: string
}

export interface ApiKey {
  id: string
  name: string
  key: string
  enabled: boolean
  createdAt: number
  lastUsedAt?: number
  usageCount: number
  description?: string
}

export interface AppConfig {
  proxyPort: number
  proxyHost: string
  loadBalanceStrategy: LoadBalanceStrategy
  modelMappings: Record<string, ModelMapping>
  theme: Theme
  autoStart: boolean
  autoStartProxy: boolean
  minimizeToTray: boolean
  logLevel: 'debug' | 'info' | 'warn' | 'error'
  logRetentionDays: number
  requestLogConfig: RequestLogConfig
  requestTimeout: number
  retryCount: number
  apiKeys: ApiKey[]
  enableApiKey: boolean
  oauthProxyMode: 'system' | 'none'
  sessionConfig: SessionConfig
  toolCallingConfig: ToolCallingConfig
  toolPromptConfig?: LegacyToolPromptConfig
  qwenAiGovernorConfig: QwenAiGovernorConfig
  qwenAiSessionMode: QwenAiSessionMode
  managementApi: ManagementApiConfig
  contextManagement?: unknown
  language: 'zh-CN' | 'en-US'
}

export type LogLevel = 'debug' | 'info' | 'warn' | 'error'

export interface LogEntry {
  id: string
  timestamp: number
  level: LogLevel
  message: string
  accountId?: string
  providerId?: string
  requestId?: string
  data?: Record<string, unknown>
}

export interface ProxyStatus {
  isRunning: boolean
  port: number
  host: string
  uptime: number
  connections: number
}

export interface ProxyStatistics {
  totalRequests: number
  successRequests: number
  failedRequests: number
  avgLatency: number
  requestsPerMinute: number
  activeConnections: number
  modelUsage: Record<string, number>
  providerUsage: Record<string, number>
  accountUsage: Record<string, number>
}

export interface ProviderCheckResult {
  providerId: string
  status: ProviderStatus
  latency?: number
  error?: string
}

export interface OAuthResult {
  success: boolean
  providerId?: string
  providerType?: ProviderVendor
  credentials?: Record<string, string>
  account?: Account
  accountInfo?: {
    userId?: string
    email?: string
    name?: string
  }
  error?: string
}

export interface ValidationResult {
  valid: boolean
  error?: string
  validatedAt: number
  credentials?: Record<string, string>
  accountInfo?: {
    name?: string
    email?: string
    quota?: number
    used?: number
    expiresAt?: number
  }
}

export type PromptType = 'general' | 'tool-use' | 'agent' | 'translation' | 'search'

export interface SystemPrompt {
  id: string
  name: string
  description: string
  prompt: string
  type: PromptType
  isBuiltin: boolean
  emoji?: string
  groups?: string[]
  createdAt: number
  updatedAt: number
}

export interface SessionConfig {
  sessionTimeout: number
  maxMessagesPerSession: number
  deleteAfterTimeout: boolean
  maxSessionsPerAccount: number
}

export interface RequestLogConfig {
  enabled: boolean
  maxEntries: number
  includeBodies: boolean
  maxBodyChars: number
  redactSensitiveData: boolean
}

export interface ManagementApiConfig {
  enableManagementApi: boolean
  managementApiSecret: string
  managementApiPort?: number
}

export interface ManagementApiResponse<T = unknown> {
  success: boolean
  data?: T
  error?: ManagementApiError
}

export interface ManagementApiError {
  code: string
  message: string
  details?: Record<string, unknown>
}

export interface ManagementApiPaginationParams {
  page?: number
  limit?: number
}

export interface ManagementApiPaginatedResponse<T> {
  items: T[]
  total: number
  page: number
  limit: number
  totalPages: number
}

export interface CreateProviderRequest {
  /** Optional caller-supplied identifier used by imports and migrations. */
  id?: string
  name: string
  type?: ProviderType
  authType: AuthType
  apiEndpoint: string
  chatPath?: string
  headers?: Record<string, string>
  enabled?: boolean
  description?: string
  icon?: string
  supportedModels?: string[]
  modelMappings?: Record<string, string>
  modelCapabilities?: Record<string, ProviderModelCapability>
  modelsApiEndpoint?: string
  modelsApiHeaders?: Record<string, string>
  credentialFields?: CredentialField[]
}

export interface UpdateProviderRequest {
  name?: string
  apiEndpoint?: string
  chatPath?: string
  headers?: Record<string, string>
  enabled?: boolean
  description?: string
  icon?: string
  supportedModels?: string[]
  modelMappings?: Record<string, string>
  modelCapabilities?: Record<string, ProviderModelCapability>
  modelsApiEndpoint?: string
  modelsApiHeaders?: Record<string, string>
}

export interface ProviderStatusRequest {
  enabled: boolean
}

export interface CreateAccountRequest {
  providerId: string
  name: string
  email?: string
  credentials: Record<string, string>
  dailyLimit?: number
}

export interface UpdateAccountRequest {
  name?: string
  email?: string
  credentials?: Record<string, string>
  dailyLimit?: number
}

export interface CreateApiKeyRequest {
  name: string
  description?: string
}

export interface UpdateApiKeyRequest {
  name?: string
  description?: string
  enabled?: boolean
}

export interface CreateModelMappingRequest {
  requestModel: string
  actualModel: string
  preferredProviderId?: string
  preferredAccountId?: string
}

export interface UpdateModelMappingRequest {
  actualModel?: string
  preferredProviderId?: string
  preferredAccountId?: string
}

export interface ProxyStatusResponse {
  isRunning: boolean
  port: number
  host: string
  uptime: number
  connections: number
}

export interface HealthCheckResponse {
  status: 'healthy' | 'unhealthy' | 'degraded'
  version: string
  uptime: number
  timestamp: number
  components?: {
    proxy: 'up' | 'down'
    database: 'up' | 'down'
    managementApi: 'up' | 'down'
  }
}

export interface StatisticsResponse {
  totalRequests: number
  successRequests: number
  failedRequests: number
  avgLatency: number
  requestsPerMinute: number
  activeConnections: number
  modelUsage: Record<string, number>
  providerUsage: Record<string, number>
  accountUsage: Record<string, number>
  dailyStats?: Record<string, {
    totalRequests: number
    successRequests: number
    failedRequests: number
  }>
}

export interface ConfigUpdateRequest {
  proxyPort?: number
  proxyHost?: string
  loadBalanceStrategy?: LoadBalanceStrategy
  theme?: Theme
  autoStart?: boolean
  autoStartProxy?: boolean
  minimizeToTray?: boolean
  logLevel?: 'debug' | 'info' | 'warn' | 'error'
  logRetentionDays?: number
  requestLogConfig?: Partial<RequestLogConfig>
  requestTimeout?: number
  retryCount?: number
  enableApiKey?: boolean
  oauthProxyMode?: 'system' | 'none'
  sessionConfig?: SessionConfig
  toolCallingConfig?: Partial<ToolCallingConfig>
  toolPromptConfig?: LegacyToolPromptConfig
  qwenAiGovernorConfig?: Partial<QwenAiGovernorConfig>
  qwenAiSessionMode?: QwenAiSessionMode
  managementApi?: ManagementApiConfig
}

export interface EffectiveModel {
  displayName: string
  actualModelId: string
  isCustom: boolean
}
