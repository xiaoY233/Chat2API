/**
 * Credential Storage Module - Type Definitions
 * Defines core data structures for accounts, providers, and configuration
 */

import type { ProviderModelCapability, ProviderStatus } from '../../shared/types'
import type { LegacyToolPromptConfig, ToolCallingConfig } from '../../shared/toolCalling.ts'
import { DEFAULT_TOOL_CALLING_CONFIG } from '../../shared/toolCalling.ts'

/**
 * Account Status Enum
 */
export type AccountStatus = 'active' | 'inactive' | 'expired' | 'error'

/**
 * Provider Type Enum
 */
export type ProviderType = 'builtin' | 'custom'

/**
 * Authentication Type Enum
 * - oauth: OAuth authentication
 * - token: Simple Token authentication
 * - cookie: Cookie authentication
 * - userToken: User Token authentication (DeepSeek)
 * - refresh_token: Refresh token authentication (GLM)
 * - jwt: JWT/Refresh token authentication (Kimi)
 * - realUserID_token: realUserID+JWT authentication (MiniMax)
 * - tongyi_sso_ticket: Tongyi SSO ticket authentication (Qwen)
 */
export type AuthType = 
  | 'oauth' 
  | 'token' 
  | 'cookie' 
  | 'userToken' 
  | 'refresh_token' 
  | 'jwt' 
  | 'realUserID_token' 
  | 'tongyi_sso_ticket'

/**
 * Credential Field Configuration Interface
 * Defines credential fields required by provider
 */
export interface CredentialField {
  /** Field name */
  name: string
  /** Field label (display name) */
  label: string
  /** Field type */
  type: 'text' | 'password' | 'textarea'
  /** Whether required */
  required: boolean
  /** Placeholder text */
  placeholder?: string
  /** Help text */
  helpText?: string
}

/**
 * Built-in Provider Configuration Interface
 * Extends Provider interface, adds credential field configuration
 */
export interface BuiltinProviderConfig extends Omit<Provider, 'createdAt' | 'updatedAt'> {
  /** Credential field configuration */
  credentialFields: CredentialField[]
  /** Token check endpoint */
  tokenCheckEndpoint?: string
  /** Token check method */
  tokenCheckMethod?: 'GET' | 'POST'
  /** Models list API endpoint for dynamic model fetching */
  modelsApiEndpoint?: string
  /** Additional headers for models API request */
  modelsApiHeaders?: Record<string, string>
}

/**
 * Load Balance Strategy Enum
 */
export type LoadBalanceStrategy = 'round-robin' | 'fill-first' | 'failover'

/**
 * Theme Enum
 */
export type Theme = 'light' | 'dark' | 'system'

/** Qwen AI tool-result conversation handling strategy. */
export type QwenAiSessionMode = 'legacy' | 'tool-call-binding'

export const DEFAULT_QWEN_AI_SESSION_MODE: QwenAiSessionMode = 'tool-call-binding'

export function normalizeQwenAiSessionMode(value: unknown): QwenAiSessionMode {
  return value === 'legacy' || value === 'tool-call-binding'
    ? value
    : DEFAULT_QWEN_AI_SESSION_MODE
}

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
  /**
   * Number of distinct accounts that must hit Qwen AI risk control inside
   * riskWindowMs before opening the provider-wide circuit.
   */
  globalRiskThreshold: number
}

/**
 * Hard safety ceiling for Qwen AI concurrency settings.
 *
 * The adaptive governor may scale below this value based on the number of
 * healthy accounts. Keeping a finite ceiling prevents a malformed config or
 * an accidental environment value from creating an unbounded request fanout.
 */
export const MAX_QWEN_AI_CONCURRENCY = 100
const MAX_QWEN_AI_GOVERNOR_DURATION_MS = 24 * 60 * 60 * 1000

function normalizeQwenAiInteger(
  value: unknown,
  fallback: number,
  min: number,
  max: number,
): number {
  const fallbackValue = Number.isInteger(fallback)
    ? Math.min(max, Math.max(min, fallback))
    : min
  return Number.isInteger(value)
    ? Math.min(max, Math.max(min, value as number))
    : fallbackValue
}

export function normalizeQwenAiConcurrency(value: unknown, fallback: number): number {
  return normalizeQwenAiInteger(value, fallback, 1, MAX_QWEN_AI_CONCURRENCY)
}

/**
 * Account Interface
 * Represents account configuration under a provider
 */
export interface Account {
  /** Account unique identifier */
  id: string
  /** Provider ID */
  providerId: string
  /** Account name */
  name: string
  /** Account email (optional) */
  email?: string
  /** Credential data (encrypted storage) */
  credentials: Record<string, string>
  /** Account status */
  status: AccountStatus
  /** Last used time (timestamp) */
  lastUsed?: number
  /** Created time (timestamp) */
  createdAt: number
  /** Updated time (timestamp) */
  updatedAt: number
  /** Error message (when status is error) */
  errorMessage?: string
  /** Request count */
  requestCount?: number
  /** Daily request limit */
  dailyLimit?: number
  /** Today used count */
  todayUsed?: number
}

/**
 * Provider Interface
 * Represents an API provider configuration
 */
export interface Provider {
  /** Provider unique identifier */
  id: string
  /** Provider name */
  name: string
  /** Provider type */
  type: ProviderType
  /** Authentication type */
  authType: AuthType
  /** API endpoint address */
  apiEndpoint: string
  /** Chat API path */
  chatPath?: string
  /** Default request headers */
  headers: Record<string, string>
  /** Whether enabled */
  enabled: boolean
  /** Created time (timestamp) */
  createdAt: number
  /** Updated time (timestamp) */
  updatedAt: number
  /** Provider description */
  description?: string
  /** Icon URL */
  icon?: string
  /** Supported model list */
  supportedModels?: string[]
  /** Model name mapping */
  modelMappings?: Record<string, string>
  /** Model capability metadata reported by the provider */
  modelCapabilities?: Record<string, ProviderModelCapability>
  /** Models list API endpoint for dynamic model fetching */
  modelsApiEndpoint?: string
  /** Additional headers for models API request */
  modelsApiHeaders?: Record<string, string>
  /** Provider status */
  status?: ProviderStatus
  /** Last status check time */
  lastStatusCheck?: number
}

/**
 * Model Mapping Configuration
 * Maps request model to actual used model
 */
export interface ModelMapping {
  /** Request model name */
  requestModel: string
  /** Actual used model name */
  actualModel: string
  /** Preferred provider ID */
  preferredProviderId?: string
  /** Preferred account ID */
  preferredAccountId?: string
}

/**
 * Application Configuration Interface
 */
export interface AppConfig {
  /** Proxy service port */
  proxyPort: number
  /** Proxy service bind address */
  proxyHost: string
  /** Load balance strategy */
  loadBalanceStrategy: LoadBalanceStrategy
  /** Model mapping configuration */
  modelMappings: Record<string, ModelMapping>
  /** Default model mappings have been seeded into editable config */
  defaultModelMappingsSeeded?: boolean
  /** UI theme */
  theme: Theme
  /** Auto start on boot */
  autoStart: boolean
  /** Auto start proxy on launch */
  autoStartProxy: boolean
  /** Minimize to tray */
  minimizeToTray: boolean
  /** Log level */
  logLevel: 'debug' | 'info' | 'warn' | 'error'
  /** Log retention days */
  logRetentionDays: number
  /** Request log persistence configuration */
  requestLogConfig: RequestLogConfig
  /** Request timeout (milliseconds) */
  requestTimeout: number
  /** Retry count */
  retryCount: number
  /** API Key list */
  apiKeys: ApiKey[]
  /** Whether to enable API Key authentication */
  enableApiKey: boolean
  /** OAuth proxy mode: 'system' uses system proxy, 'none' disables proxy */
  oauthProxyMode: 'system' | 'none'
  /** Session management configuration */
  sessionConfig: SessionConfig
  /** Tool calling configuration */
  toolCallingConfig: ToolCallingConfig
  /** Legacy migration input from pre-v2 tool prompt settings */
  toolPromptConfig?: LegacyToolPromptConfig
  /** Qwen AI request governor configuration */
  qwenAiGovernorConfig: QwenAiGovernorConfig
  /** Qwen AI tool-result conversation handling strategy */
  qwenAiSessionMode: QwenAiSessionMode
  /** Management API configuration */
  managementApi: ManagementApiConfig
  /** Context management configuration */
  contextManagement: ContextManagementConfig
}

/**
 * Log Level Enum
 */
export type LogLevel = 'debug' | 'info' | 'warn' | 'error'

/**
 * Session Status Enum
 */
export type SessionStatus = 'active' | 'expired' | 'deleted'

/**
 * Sliding Window Configuration Interface
 * Controls message count-based context trimming
 */
export interface SlidingWindowConfig {
  /** Whether sliding window strategy is enabled */
  enabled: boolean
  /** Maximum number of messages to keep */
  maxMessages: number
}

/**
 * Token Limit Configuration Interface
 * Controls token count-based context trimming
 */
export interface TokenLimitConfig {
  /** Whether token limit strategy is enabled */
  enabled: boolean
  /** Maximum number of tokens to keep */
  maxTokens: number
}

/**
 * Summary Configuration Interface
 * Controls context summarization strategy
 */
export interface SummaryConfig {
  /** Whether summary strategy is enabled */
  enabled: boolean
  /** Number of recent messages to keep after summarization */
  keepRecentMessages: number
  /** Custom summary prompt template (optional) */
  summaryPrompt?: string
}

/**
 * Context Management Configuration Interface
 * Controls how conversation context is managed and trimmed
 */
export interface ContextManagementConfig {
  /** Whether context management is enabled */
  enabled: boolean
  /** Strategy configurations */
  strategies: {
    slidingWindow: SlidingWindowConfig
    tokenLimit: TokenLimitConfig
    summary: SummaryConfig
  }
  /** Execution order of strategies */
  executionOrder: ('slidingWindow' | 'tokenLimit' | 'summary')[]
}

/**
 * Chat Message Interface
 * Represents a single message in a conversation
 */
export interface ChatMessage {
  /** Message role */
  role: 'user' | 'assistant' | 'system' | 'tool'
  /** Message content */
  content: string | any[]
  /** Timestamp */
  timestamp: number
  /** Provider-specific message ID */
  providerMessageId?: string
  /** Tool call ID (for tool messages) */
  toolCallId?: string
}

/**
 * Session Record Interface
 * Represents a conversation session
 */
export interface SessionRecord {
  /** Session unique identifier */
  id: string
  /** Provider ID */
  providerId: string
  /** Account ID */
  accountId: string
  /** Session type */
  sessionType: 'chat' | 'agent'
  /** Message history */
  messages: ChatMessage[]
  /** Creation time (timestamp) */
  createdAt: number
  /** Last active time (timestamp) */
  lastActiveAt: number
  /** Session status */
  status: SessionStatus
  /** Model used */
  model?: string
  /** Session metadata */
  metadata?: {
    title?: string
    tokenCount?: number
  }
}

/**
 * Session Configuration Interface
 * Global session management settings
 */
export interface SessionConfig {
  /** Session timeout (minutes), default 30 */
  sessionTimeout: number
  /** Max messages per session, default 50 */
  maxMessagesPerSession: number
  /** Delete session after timeout */
  deleteAfterTimeout: boolean
  /** Max active sessions per account, default 3 */
  maxSessionsPerAccount: number
}

export type { LegacyToolPromptConfig, ToolCallingConfig }

/**
 * Management API Configuration Interface
 * Controls the management API server settings
 */
export interface ManagementApiConfig {
  /** Whether to enable the management API */
  enableManagementApi: boolean
  /** Secret key for management API authentication */
  managementApiSecret: string
  /** Management API port (optional, defaults to proxyPort) */
  managementApiPort?: number
}

/**
 * API Key Interface
 */
export interface ApiKey {
  /** API Key ID */
  id: string
  /** API Key name */
  name: string
  /** API Key value */
  key: string
  /** Whether enabled */
  enabled: boolean
  /** Created time */
  createdAt: number
  /** Last used time */
  lastUsedAt?: number
  /** Usage count */
  usageCount: number
  /** Description */
  description?: string
}

/**
 * Log Entry Interface
 */
export interface LogEntry {
  /** Log ID */
  id: string
  /** Timestamp */
  timestamp: number
  /** Log level */
  level: LogLevel
  /** Log message */
  message: string
  /** Related account ID */
  accountId?: string
  /** Related provider ID */
  providerId?: string
  /** Request ID */
  requestId?: string
  /** Extra data */
  data?: Record<string, unknown>
}

/**
 * Request Log Entry Interface
 * Detailed log for API request tracking
 */
export interface RequestLogEntry {
  /** Log ID */
  id: string
  /** Timestamp */
  timestamp: number
  /** Request status */
  status: 'success' | 'error'
  /** HTTP status code */
  statusCode: number

  /** HTTP method */
  method: string
  /** Request URL path */
  url: string
  /** Requested model name */
  model: string
  /** Actual model used (after mapping) */
  actualModel?: string

  /** Provider ID */
  providerId?: string
  /** Provider name */
  providerName?: string
  /** Account ID */
  accountId?: string
  /** Account name */
  accountName?: string

  /** Request body JSON string */
  requestBody?: string
  /** User input extracted from messages (truncated to 200 chars) */
  userInput?: string

  /** Web search enabled */
  webSearch?: boolean
  /** Reasoning effort level */
  reasoningEffort?: 'low' | 'medium' | 'high'

  /** Response status code */
  responseStatus: number
  /** Response preview (truncated) */
  responsePreview?: string
  /** Response body JSON string */
  responseBody?: string

  /** Request latency in milliseconds */
  latency: number
  /** Whether streaming request */
  isStream: boolean

  /** Error message */
  errorMessage?: string
  /** Stable machine-readable error code */
  errorCode?: string
  /** Error stack trace */
  errorStack?: string
}

export interface RequestLogConfig {
  /** Whether detailed request logs are persisted */
  enabled: boolean
  /** Maximum persisted request log entries */
  maxEntries: number
  /** Whether request and response bodies are stored */
  includeBodies: boolean
  /** Maximum characters persisted for each body field */
  maxBodyChars: number
  /** Whether obvious sensitive values are redacted */
  redactSensitiveData: boolean
}

/**
 * Daily Statistics Interface
 * Statistics for a single day
 */
export interface DailyStatistics {
  /** Date string (YYYY-MM-DD) */
  date: string
  /** Total requests */
  totalRequests: number
  /** Successful requests */
  successRequests: number
  /** Failed requests */
  failedRequests: number
  /** Total latency (for average calculation) */
  totalLatency: number
  /** Model usage count */
  modelUsage: Record<string, number>
  /** Provider usage count */
  providerUsage: Record<string, number>
}

/**
 * Persistent Statistics Interface
 * Statistics that persist across app restarts
 */
export interface PersistentStatistics {
  /** Total requests (all time) */
  totalRequests: number
  /** Successful requests (all time) */
  successRequests: number
  /** Failed requests (all time) */
  failedRequests: number
  /** Total latency for average calculation */
  totalLatency: number
  /** Last updated timestamp */
  lastUpdated: number
  /** Model usage count */
  modelUsage: Record<string, number>
  /** Provider usage count */
  providerUsage: Record<string, number>
  /** Account usage count */
  accountUsage: Record<string, number>
  /** Daily statistics (keyed by date string) */
  dailyStats: Record<string, DailyStatistics>
}

/**
 * System Prompt Type Enum
 */
export type PromptType = 'general' | 'tool-use' | 'agent' | 'translation' | 'search'

/**
 * System Prompt Interface
 */
export interface SystemPrompt {
  /** Unique identifier */
  id: string
  /** Prompt name */
  name: string
  /** Prompt description */
  description: string
  /** Prompt content */
  prompt: string
  /** Prompt type */
  type: PromptType
  /** Whether built-in (built-in prompts cannot be edited/deleted) */
  isBuiltin: boolean
  /** Emoji icon */
  emoji?: string
  /** Group tags */
  groups?: string[]
  /** Creation time */
  createdAt: number
  /** Update time */
  updatedAt: number
}

/**
 * Credential Validation Result Interface
 */
export interface ValidationResult {
  /** Whether valid */
  valid: boolean
  /** Error message */
  error?: string
  /** Validation time */
  validatedAt: number
  /** Canonical credentials returned after validation or token rotation */
  credentials?: Record<string, string>
  /** Account info (returned when validation succeeds) */
  accountInfo?: {
    name?: string
    email?: string
    quota?: number
    used?: number
    expiresAt?: number
  }
}

/**
 * Custom Model Configuration
 * User-defined model with display name and actual API model ID
 */
export interface CustomModel {
  /** Model display name (used in AI client) */
  displayName: string
  /** Actual model ID (used in API call) */
  actualModelId: string
}

/**
 * User Model Overrides for a Provider
 * Stores user customizations to built-in provider models
 */
export interface ProviderModelOverrides {
  /** User added custom models */
  addedModels: CustomModel[]
  /** Excluded default model display names */
  excludedModels: string[]
}

/**
 * User Model Overrides
 * Maps provider IDs to their model customizations
 */
export type UserModelOverrides = Record<string, ProviderModelOverrides>

export const DEEPSEEK_PRIMARY_MODELS = ['deepseek-v4-flash', 'deepseek-v4-pro']

export const DEEPSEEK_LEGACY_MODEL_MAPPING_NAMES = [
  'deepseek-chat',
  'deepseek-reasoner',
  'DeepSeek-V3.2',
  'DeepSeek-Search',
  'DeepSeek-R1',
  'DeepSeek-R1-Search',
]

/**
 * Effective Model Information
 * Combined model info after merging defaults with user overrides
 */
export interface EffectiveModel {
  /** Model display name (used in AI client) */
  displayName: string
  /** Actual model ID (used in API call) */
  actualModelId: string
  /** Whether this is a user-added custom model */
  isCustom: boolean
}

/**
 * Storage Data Structure Interface
 */
export interface StoreSchema {
  /** Provider list */
  providers: Provider[]
  /** Account list */
  accounts: Account[]
  /** Application configuration */
  config: AppConfig
  /** Log entries */
  logs: LogEntry[]
  /** Request log entries */
  requestLogs: RequestLogEntry[]
  /** System prompts */
  systemPrompts: SystemPrompt[]
  /** Session records */
  sessions: SessionRecord[]
  /** Persistent statistics */
  statistics: PersistentStatistics
  /** User model overrides for built-in providers */
  userModelOverrides: UserModelOverrides
}

/**
 * Default Session Configuration
 */
export const DEFAULT_SESSION_CONFIG: SessionConfig = {
  sessionTimeout: 30,
  maxMessagesPerSession: 50,
  deleteAfterTimeout: false,
  maxSessionsPerAccount: 3,
}

/**
 * Default Persistent Statistics
 */
export const DEFAULT_STATISTICS: PersistentStatistics = {
  totalRequests: 0,
  successRequests: 0,
  failedRequests: 0,
  totalLatency: 0,
  lastUpdated: Date.now(),
  modelUsage: {},
  providerUsage: {},
  accountUsage: {},
  dailyStats: {},
}

/**
 * Default User Model Overrides
 */
export const DEFAULT_USER_MODEL_OVERRIDES: UserModelOverrides = {}

export const DEFAULT_TOOL_CALLING_CONFIG_VALUE = DEFAULT_TOOL_CALLING_CONFIG

export const DEFAULT_QWEN_AI_GOVERNOR_CONFIG: QwenAiGovernorConfig = {
  autoTuneEnabled: true,
  autoTuneMaxConcurrent: MAX_QWEN_AI_CONCURRENCY,
  // A one-second floor lets the adaptive policy use the account pool. Older
  // persisted configs retain their own value during normalization.
  autoTuneMinGlobalIntervalMs: 1000,
  maxConcurrent: 1,
  globalMinIntervalMs: 15000,
  accountMinIntervalMs: 120000,
  riskCooldownMs: 10 * 60 * 1000,
  maxRiskCooldownMs: 30 * 60 * 1000,
  failureCooldownMs: 2 * 60 * 1000,
  globalRiskCooldownMs: 30 * 60 * 1000,
  maxGlobalRiskCooldownMs: 2 * 60 * 60 * 1000,
  riskWindowMs: 5 * 60 * 1000,
  globalRiskThreshold: 3,
}

/**
 * Merge a partial persisted value with defaults and clamp the two concurrency
 * controls to the shared safety ceiling. Existing values within the range are
 * retained verbatim so upgrading does not silently change user preferences.
 */
export function normalizeQwenAiGovernorConfig(
  config?: Partial<QwenAiGovernorConfig>,
): QwenAiGovernorConfig {
  const merged = {
    ...DEFAULT_QWEN_AI_GOVERNOR_CONFIG,
    ...(config || {}),
  }

  const riskCooldownMs = normalizeQwenAiInteger(
    merged.riskCooldownMs,
    DEFAULT_QWEN_AI_GOVERNOR_CONFIG.riskCooldownMs,
    0,
    MAX_QWEN_AI_GOVERNOR_DURATION_MS,
  )
  const globalRiskCooldownMs = normalizeQwenAiInteger(
    merged.globalRiskCooldownMs,
    DEFAULT_QWEN_AI_GOVERNOR_CONFIG.globalRiskCooldownMs,
    0,
    MAX_QWEN_AI_GOVERNOR_DURATION_MS,
  )

  return {
    ...merged,
    autoTuneEnabled: typeof merged.autoTuneEnabled === 'boolean'
      ? merged.autoTuneEnabled
      : DEFAULT_QWEN_AI_GOVERNOR_CONFIG.autoTuneEnabled,
    autoTuneMaxConcurrent: normalizeQwenAiConcurrency(
      merged.autoTuneMaxConcurrent,
      DEFAULT_QWEN_AI_GOVERNOR_CONFIG.autoTuneMaxConcurrent,
    ),
    autoTuneMinGlobalIntervalMs: normalizeQwenAiInteger(
      merged.autoTuneMinGlobalIntervalMs,
      DEFAULT_QWEN_AI_GOVERNOR_CONFIG.autoTuneMinGlobalIntervalMs,
      0,
      MAX_QWEN_AI_GOVERNOR_DURATION_MS,
    ),
    maxConcurrent: normalizeQwenAiConcurrency(
      merged.maxConcurrent,
      DEFAULT_QWEN_AI_GOVERNOR_CONFIG.maxConcurrent,
    ),
    globalMinIntervalMs: normalizeQwenAiInteger(
      merged.globalMinIntervalMs,
      DEFAULT_QWEN_AI_GOVERNOR_CONFIG.globalMinIntervalMs,
      0,
      MAX_QWEN_AI_GOVERNOR_DURATION_MS,
    ),
    accountMinIntervalMs: normalizeQwenAiInteger(
      merged.accountMinIntervalMs,
      DEFAULT_QWEN_AI_GOVERNOR_CONFIG.accountMinIntervalMs,
      0,
      MAX_QWEN_AI_GOVERNOR_DURATION_MS,
    ),
    riskCooldownMs,
    maxRiskCooldownMs: Math.max(
      riskCooldownMs,
      normalizeQwenAiInteger(
        merged.maxRiskCooldownMs,
        DEFAULT_QWEN_AI_GOVERNOR_CONFIG.maxRiskCooldownMs,
        0,
        MAX_QWEN_AI_GOVERNOR_DURATION_MS,
      ),
    ),
    failureCooldownMs: normalizeQwenAiInteger(
      merged.failureCooldownMs,
      DEFAULT_QWEN_AI_GOVERNOR_CONFIG.failureCooldownMs,
      0,
      MAX_QWEN_AI_GOVERNOR_DURATION_MS,
    ),
    globalRiskCooldownMs,
    maxGlobalRiskCooldownMs: Math.max(
      globalRiskCooldownMs,
      normalizeQwenAiInteger(
        merged.maxGlobalRiskCooldownMs,
        DEFAULT_QWEN_AI_GOVERNOR_CONFIG.maxGlobalRiskCooldownMs,
        0,
        MAX_QWEN_AI_GOVERNOR_DURATION_MS,
      ),
    ),
    riskWindowMs: normalizeQwenAiInteger(
      merged.riskWindowMs,
      DEFAULT_QWEN_AI_GOVERNOR_CONFIG.riskWindowMs,
      1000,
      MAX_QWEN_AI_GOVERNOR_DURATION_MS,
    ),
    globalRiskThreshold: normalizeQwenAiInteger(
      merged.globalRiskThreshold,
      DEFAULT_QWEN_AI_GOVERNOR_CONFIG.globalRiskThreshold,
      1,
      100,
    ),
  }
}

/**
 * Default Management API Configuration
 */
export const DEFAULT_MANAGEMENT_API_CONFIG: ManagementApiConfig = {
  enableManagementApi: false,
  managementApiSecret: '',
}

/**
 * Default Context Management Configuration
 */
export const DEFAULT_CONTEXT_MANAGEMENT_CONFIG: ContextManagementConfig = {
  enabled: false,
  strategies: {
    slidingWindow: { enabled: true, maxMessages: 20 },
    tokenLimit: { enabled: false, maxTokens: 4000 },
    summary: { enabled: false, keepRecentMessages: 20 },
  },
  executionOrder: ['slidingWindow', 'tokenLimit', 'summary'],
}

export const DEFAULT_REQUEST_LOG_CONFIG: RequestLogConfig = {
  enabled: true,
  maxEntries: 200,
  includeBodies: false,
  maxBodyChars: 8000,
  redactSensitiveData: true,
}

export const DEFAULT_DEEPSEEK_MODEL_MAPPINGS: Record<string, ModelMapping> = {
  'deepseek-v4-flash-think': {
    requestModel: 'deepseek-v4-flash-think',
    actualModel: 'deepseek-v4-flash',
    preferredProviderId: 'deepseek',
  },
  'deepseek-v4-flash-search': {
    requestModel: 'deepseek-v4-flash-search',
    actualModel: 'deepseek-v4-flash',
    preferredProviderId: 'deepseek',
  },
  'deepseek-v4-flash-think-search': {
    requestModel: 'deepseek-v4-flash-think-search',
    actualModel: 'deepseek-v4-flash',
    preferredProviderId: 'deepseek',
  },
  'deepseek-v4-pro-think': {
    requestModel: 'deepseek-v4-pro-think',
    actualModel: 'deepseek-v4-pro',
    preferredProviderId: 'deepseek',
  },
  'deepseek-v4-pro-search': {
    requestModel: 'deepseek-v4-pro-search',
    actualModel: 'deepseek-v4-pro',
    preferredProviderId: 'deepseek',
  },
  'deepseek-v4-pro-think-search': {
    requestModel: 'deepseek-v4-pro-think-search',
    actualModel: 'deepseek-v4-pro',
    preferredProviderId: 'deepseek',
  },
}

export function createDefaultModelMappings(): Record<string, ModelMapping> {
  return Object.fromEntries(
    Object.entries(DEFAULT_DEEPSEEK_MODEL_MAPPINGS).map(([key, mapping]) => [key, { ...mapping }]),
  )
}

export function isDefaultModelMapping(requestModel: string): boolean {
  return requestModel in DEFAULT_DEEPSEEK_MODEL_MAPPINGS
}

export function normalizeModelMappingsWithDefaults(
  mappings?: Record<string, ModelMapping>
): Record<string, ModelMapping> {
  const legacyModelNames = new Set(DEEPSEEK_LEGACY_MODEL_MAPPING_NAMES)
  const customMappings = Object.fromEntries(
    Object.entries(mappings || {}).filter(([requestModel]) =>
      !isDefaultModelMapping(requestModel) && !legacyModelNames.has(requestModel)
    ),
  )

  return {
    ...createDefaultModelMappings(),
    ...customMappings,
  }
}

export function sanitizeDeepSeekModelOverrides(
  overrides?: ProviderModelOverrides
): ProviderModelOverrides {
  const migratedModelNames = new Set([
    ...DEEPSEEK_PRIMARY_MODELS,
    ...DEEPSEEK_LEGACY_MODEL_MAPPING_NAMES,
    ...Object.keys(DEFAULT_DEEPSEEK_MODEL_MAPPINGS),
  ])

  return {
    addedModels: (overrides?.addedModels || []).filter(model =>
      !migratedModelNames.has(model.displayName)
    ),
    excludedModels: (overrides?.excludedModels || []).filter(model =>
      DEEPSEEK_PRIMARY_MODELS.includes(model)
    ),
  }
}

/**
 * Default Application Configuration
 */
export const DEFAULT_CONFIG: AppConfig = {
  proxyPort: 8080,
  proxyHost: '127.0.0.1',
  loadBalanceStrategy: 'round-robin',
  modelMappings: createDefaultModelMappings(),
  defaultModelMappingsSeeded: true,
  theme: 'system',
  autoStart: false,
  autoStartProxy: false,
  minimizeToTray: true,
  logLevel: 'info',
  logRetentionDays: 7,
  requestLogConfig: DEFAULT_REQUEST_LOG_CONFIG,
  requestTimeout: 60000,
  retryCount: 3,
  apiKeys: [],
  enableApiKey: false,
  oauthProxyMode: 'system',
  sessionConfig: DEFAULT_SESSION_CONFIG,
  toolCallingConfig: DEFAULT_TOOL_CALLING_CONFIG,
  toolPromptConfig: undefined,
  qwenAiGovernorConfig: DEFAULT_QWEN_AI_GOVERNOR_CONFIG,
  qwenAiSessionMode: DEFAULT_QWEN_AI_SESSION_MODE,
  managementApi: DEFAULT_MANAGEMENT_API_CONFIG,
  contextManagement: DEFAULT_CONTEXT_MANAGEMENT_CONFIG,
}

/**
 * Built-in Provider Configuration
 * Re-exported from providers/builtin/index.ts to avoid duplication
 */
export { builtinProviders as BUILTIN_PROVIDERS } from '../providers/builtin/index.ts'
