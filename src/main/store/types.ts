/**
 * Credential Storage Module - Type Definitions
 * Defines core data structures for accounts, providers, and configuration
 */

import type { ProviderStatus } from '../../shared/types'

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
}

/**
 * Load Balance Strategy Enum
 */
export type LoadBalanceStrategy = 'round-robin' | 'fill-first' | 'failover'

/**
 * Theme Enum
 */
export type Theme = 'light' | 'dark' | 'system'

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
  /** Delete session after chat (only supported by some providers) */
  deleteSessionAfterChat?: boolean
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
  /** Load balance strategy */
  loadBalanceStrategy: LoadBalanceStrategy
  /** Model mapping configuration */
  modelMappings: Record<string, ModelMapping>
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
}

/**
 * Log Level Enum
 */
export type LogLevel = 'debug' | 'info' | 'warn' | 'error'

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
 * Credential Validation Result Interface
 */
export interface ValidationResult {
  /** Whether valid */
  valid: boolean
  /** Error message */
  error?: string
  /** Validation time */
  validatedAt: number
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
}

/**
 * Default Application Configuration
 */
export const DEFAULT_CONFIG: AppConfig = {
  proxyPort: 8080,
  loadBalanceStrategy: 'round-robin',
  modelMappings: {},
  theme: 'system',
  autoStart: false,
  autoStartProxy: false,
  minimizeToTray: true,
  logLevel: 'info',
  logRetentionDays: 7,
  requestTimeout: 60000,
  retryCount: 3,
  apiKeys: [],
  enableApiKey: false,
  oauthProxyMode: 'system',
}

/**
 * Built-in Provider Configuration
 */
export const BUILTIN_PROVIDERS: BuiltinProviderConfig[] = [
  {
    id: 'deepseek',
    name: 'DeepSeek',
    type: 'builtin',
    authType: 'userToken',
    apiEndpoint: 'https://chat.deepseek.com/api',
    chatPath: '/v0/chat/completion',
    headers: {
      'Content-Type': 'application/json',
      'Accept': '*/*',
      'Origin': 'https://chat.deepseek.com',
      'Referer': 'https://chat.deepseek.com/',
    },
    enabled: true,
    description: 'DeepSeek intelligent dialogue assistant, supports deep thinking and web search',
    supportedModels: ['DeepSeek-V3.2'],
    modelMappings: {
      'DeepSeek-V3.2': 'deepseek-chat',
    },
    credentialFields: [
      {
        name: 'token',
        label: 'User Token',
        type: 'password',
        required: true,
        placeholder: 'Enter DeepSeek user token',
        helpText: 'Authentication token obtained from DeepSeek web version',
      },
    ],
  },
  {
    id: 'glm',
    name: 'GLM (Zhipu Qingyan)',
    type: 'builtin',
    authType: 'refresh_token',
    apiEndpoint: 'https://chatglm.cn/api',
    chatPath: '/chatglm/backend-api/assistant/stream',
    headers: {
      'Content-Type': 'application/json',
      'Accept': 'text/event-stream',
      'Origin': 'https://chatglm.cn',
      'Referer': 'https://chatglm.cn/',
    },
    enabled: true,
    description: 'Zhipu Qingyan AI assistant, supports GLM-5 flagship model, deep thinking and video generation',
    supportedModels: ['GLM-5'],
    modelMappings: {
      'GLM-5': 'glm-5',
    },
    credentialFields: [
      {
        name: 'refresh_token',
        label: 'Refresh Token',
        type: 'password',
        required: true,
        placeholder: 'Enter chatglm_refresh_token',
        helpText: 'Get chatglm_refresh_token from Zhipu Qingyan web version Cookie',
      },
    ],
  },
  {
    id: 'kimi',
    name: 'Kimi (Moonshot)',
    type: 'builtin',
    authType: 'jwt',
    apiEndpoint: 'https://www.kimi.com',
    chatPath: '/apiv2/kimi.gateway.chat.v1.ChatService/Chat',
    headers: {
      'Content-Type': 'application/connect+json',
      'Accept': '*/*',
      'Origin': 'https://www.kimi.com',
      'Referer': 'https://www.kimi.com/',
    },
    enabled: true,
    description: 'Kimi K2.5 AI assistant, supports thinking mode and web search',
    supportedModels: ['kimi-k2.5'],
    credentialFields: [
      {
        name: 'token',
        label: 'Access Token',
        type: 'password',
        required: true,
        placeholder: 'Enter Kimi access token or refresh token',
        helpText: 'Supports JWT Token or refresh_token',
      },
    ],
  },
  {
    id: 'minimax',
    name: 'MiniMax',
    type: 'builtin',
    authType: 'jwt',
    apiEndpoint: 'https://agent.minimaxi.com',
    chatPath: '/matrix/api/v1/chat/send_msg',
    headers: {
      'Content-Type': 'application/json',
      'Accept': 'application/json',
      'Origin': 'https://agent.minimaxi.com',
      'Referer': 'https://agent.minimaxi.com/',
    },
    enabled: true,
    description: 'MiniMax Agent - AI assistant with MCP multi-agent collaboration',
    supportedModels: ['MiniMax-M2.5'],
    credentialFields: [
      {
        name: 'token',
        label: 'JWT Token',
        type: 'password',
        required: true,
        placeholder: 'Enter MiniMax JWT Token or realUserID+JWTtoken',
        helpText: 'Format: "realUserID+JWTtoken" or just JWT token',
      },
      {
        name: 'realUserID',
        label: 'Real User ID (Optional)',
        type: 'text',
        required: false,
        placeholder: 'Enter Real User ID (optional)',
        helpText: 'If provided, use this instead of JWT user ID',
      },
    ],
  },
  {
    id: 'qwen',
    name: 'Qwen',
    type: 'builtin',
    authType: 'tongyi_sso_ticket',
    apiEndpoint: 'https://qianwen.biz.aliyun.com',
    chatPath: '/dialog/conversation',
    headers: {
      'Content-Type': 'application/json',
      'Accept': 'application/json, text/event-stream, text/plain, */*',
      'Origin': 'https://tongyi.aliyun.com',
      'Referer': 'https://tongyi.aliyun.com/',
    },
    enabled: true,
    description: 'Qwen AI assistant by Alibaba Cloud',
    supportedModels: [
      'Qwen3.5-Plus',
      'Qwen3-Max',
      'Qwen3-Flash',
      'Qwen3-Coder',
      'Qwen3-Plus',
      'qwen3-235b-a22b',
      'qwen3-coder-plus',
      'qwen3-30b-a3b',
      'qwen-max-latest',
    ],
    modelMappings: {},
    credentialFields: [
      {
        name: 'ticket',
        label: 'SSO Ticket',
        type: 'password',
        required: true,
        placeholder: 'Enter tongyi_sso_ticket',
        helpText: 'SSO ticket obtained from www.qianwen.com, found in browser DevTools Application -> Cookies as tongyi_sso_ticket',
      },
    ],
  },
  {
    id: 'qwen-ai',
    name: 'Qwen AI (International)',
    type: 'builtin',
    authType: 'jwt',
    apiEndpoint: 'https://chat.qwen.ai',
    chatPath: '/api/v2/chat/completions',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      source: 'web',
    },
    enabled: true,
    description: 'Qwen AI international version (chat.qwen.ai)',
    supportedModels: [
      'Qwen3.5-Plus',
      'Qwen3.5-397B',
      'Qwen3-VL-Plus',
      'Qwen3-Max',
      'Qwen3-Coder-Plus',
      'Qwen-Max-Latest',
      'Qwen-Plus',
      'Qwen-Turbo',
    ],
    modelMappings: {
      'Qwen3.5-Plus': 'qwen3.5-plus',
      'Qwen3.5-397B': 'qwen3.5-397b-a17b',
      'Qwen3-VL-Plus': 'qwen3-vl-plus',
      'Qwen3-Max': 'qwen3-max',
      'Qwen3-Coder-Plus': 'qwen3-coder-plus',
      'Qwen-Max-Latest': 'qwen-max-latest',
      'Qwen-Plus': 'qwen-plus-2025-09-11',
      'Qwen-Turbo': 'qwen-turbo-2025-02-11',
    },
    credentialFields: [
      {
        name: 'token',
        label: 'Auth Token',
        type: 'password',
        required: true,
        placeholder: 'Enter JWT token from chat.qwen.ai',
        helpText: 'JWT token obtained from chat.qwen.ai Local Storage (key: "token")',
      },
      {
        name: 'cookies',
        label: 'Cookies (Optional)',
        type: 'textarea',
        required: false,
        placeholder: 'Optional cookies for enhanced compatibility',
        helpText: 'Full cookie string from browser DevTools (optional but recommended)',
      },
    ],
  },
  {
    id: 'zai',
    name: 'Z.ai',
    type: 'builtin',
    authType: 'token',
    apiEndpoint: 'https://chat.z.ai/api',
    chatPath: '/v2/chat/completions',
    headers: {
      'Content-Type': 'application/json',
      'Accept': '*/*',
      'Origin': 'https://chat.z.ai',
      'Referer': 'https://chat.z.ai/',
    },
    enabled: true,
    description: 'Z.ai - Free AI Chatbot powered by GLM-5 and GLM-4.7',
    supportedModels: ['GLM-5', 'GLM-4.7', 'GLM-4.6V', 'GLM-4.6'],
    modelMappings: {
      'GLM-5': 'glm-5',
      'GLM-4.7': 'glm-4.7',
      'GLM-4.6V': 'glm-4.6v',
      'GLM-4.6': 'glm-4.6',
    },
    credentialFields: [
      {
        name: 'token',
        label: 'Access Token',
        type: 'password',
        required: true,
        placeholder: 'Enter Z.ai JWT Token',
        helpText: 'Get token from Z.ai cookie (token) or localStorage',
      },
    ],
    tokenCheckEndpoint: '/api/v1/users/user/settings',
    tokenCheckMethod: 'GET',
  },
]
