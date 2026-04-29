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
  /** Account weights for weighted random selection (accountId → weight, 0-100) */
  accountWeights: Record<string, number>
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
  toolPromptConfig: ToolPromptConfig
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

export interface ToolPromptConfig {
  mode: 'auto' | 'always' | 'never'
  defaultFormat: 'bracket' | 'xml'
  customPromptTemplate?: string
  enableToolCallParsing: boolean
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
  name: string
  type: ProviderType
  authType: AuthType
  apiEndpoint: string
  chatPath?: string
  headers?: Record<string, string>
  enabled?: boolean
  description?: string
  icon?: string
  supportedModels?: string[]
  modelMappings?: Record<string, string>
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
  toolPromptConfig?: ToolPromptConfig
  managementApi?: ManagementApiConfig
}

export interface EffectiveModel {
  displayName: string
  actualModelId: string
  isCustom: boolean
}
