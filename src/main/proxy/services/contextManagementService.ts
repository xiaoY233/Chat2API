/**
 * Context Management Service
 * Manages conversation context with multiple strategies:
 * 1. Sliding Window - Keep recent N messages
 * 2. Token Limit - Truncate by token count
 * 3. Summary Compression - Summarize early conversation
 */

import type { ChatMessage } from '../types'

/**
 * Sliding Window Strategy Configuration
 */
export interface SlidingWindowConfig {
  enabled: boolean
  maxMessages: number
}

/**
 * Token Limit Strategy Configuration
 */
export interface TokenLimitConfig {
  enabled: boolean
  maxTokens: number
}

/**
 * Summary Compression Strategy Configuration
 */
export interface SummaryConfig {
  enabled: boolean
  keepRecentMessages: number
  summaryPrompt?: string
}

/**
 * Context Management Configuration
 */
export interface ContextManagementConfig {
  enabled: boolean
  strategies: {
    slidingWindow: SlidingWindowConfig
    tokenLimit: TokenLimitConfig
    summary: SummaryConfig
  }
  executionOrder: ('slidingWindow' | 'tokenLimit' | 'summary')[]
}

/**
 * Strategy Execution Result
 */
export interface StrategyResult {
  messages: ChatMessage[]
  originalCount: number
  processedCount: number
  strategyName: string
  trimmed: boolean
}

/**
 * Context Processing Result
 */
export interface ContextProcessResult {
  messages: ChatMessage[]
  originalCount: number
  finalCount: number
  strategyResults: StrategyResult[]
  summaryGenerated?: boolean
}

/**
 * Default Configuration
 */
export const DEFAULT_SLIDING_WINDOW_CONFIG: SlidingWindowConfig = {
  enabled: true,
  maxMessages: 20,
}

export const DEFAULT_TOKEN_LIMIT_CONFIG: TokenLimitConfig = {
  enabled: false,
  maxTokens: 4000,
}

export const DEFAULT_SUMMARY_CONFIG: SummaryConfig = {
  enabled: false,
  keepRecentMessages: 20,
  summaryPrompt: 'Please summarize the following conversation concisely, keeping key information and context:',
}

export const DEFAULT_CONTEXT_MANAGEMENT_CONFIG: ContextManagementConfig = {
  enabled: false,
  strategies: {
    slidingWindow: DEFAULT_SLIDING_WINDOW_CONFIG,
    tokenLimit: DEFAULT_TOKEN_LIMIT_CONFIG,
    summary: DEFAULT_SUMMARY_CONFIG,
  },
  executionOrder: ['slidingWindow', 'tokenLimit', 'summary'],
}

/**
 * Estimate token count for a message
 * Simple estimation: 1 token ≈ 3 characters (rough approximation)
 */
function estimateTokens(content: string | ChatMessage['content']): number {
  if (content === null || content === undefined) {
    return 0
  }

  if (typeof content === 'string') {
    return Math.ceil(content.length / 3)
  }

  if (Array.isArray(content)) {
    return content.reduce((total, part) => {
      if (part.type === 'text' && part.text) {
        return total + Math.ceil(part.text.length / 3)
      }
      return total
    }, 0)
  }

  return 0
}

/**
 * Get message content as string
 */
function getMessageContent(message: ChatMessage): string {
  if (typeof message.content === 'string') {
    return message.content
  }
  if (Array.isArray(message.content)) {
    return message.content
      .filter(part => part.type === 'text' && part.text)
      .map(part => part.text)
      .join('\n')
  }
  return ''
}

/**
 * Sliding Window Strategy
 * Keeps the most recent N messages, always preserving system messages
 */
export class SlidingWindowStrategy {
  private config: SlidingWindowConfig

  constructor(config: SlidingWindowConfig = DEFAULT_SLIDING_WINDOW_CONFIG) {
    this.config = { ...DEFAULT_SLIDING_WINDOW_CONFIG, ...config }
  }

  execute(messages: ChatMessage[]): StrategyResult {
    const originalCount = messages.length

    if (!this.config.enabled || originalCount <= this.config.maxMessages) {
      return {
        messages,
        originalCount,
        processedCount: originalCount,
        strategyName: 'slidingWindow',
        trimmed: false,
      }
    }

    const systemMessages = messages.filter(msg => msg.role === 'system')
    const nonSystemMessages = messages.filter(msg => msg.role !== 'system')

    const maxNonSystemMessages = this.config.maxMessages - systemMessages.length
    const keptNonSystemMessages = nonSystemMessages.slice(-maxNonSystemMessages)

    const result = [...systemMessages, ...keptNonSystemMessages]

    console.log(
      `[SlidingWindowStrategy] Trimmed from ${originalCount} to ${result.length} messages ` +
        `(system: ${systemMessages.length}, non-system: ${keptNonSystemMessages.length})`
    )

    return {
      messages: result,
      originalCount,
      processedCount: result.length,
      strategyName: 'slidingWindow',
      trimmed: result.length < originalCount,
    }
  }
}

/**
 * Token Limit Strategy
 * Truncates history by token count, always preserving system messages
 */
export class TokenLimitStrategy {
  private config: TokenLimitConfig

  constructor(config: TokenLimitConfig = DEFAULT_TOKEN_LIMIT_CONFIG) {
    this.config = { ...DEFAULT_TOKEN_LIMIT_CONFIG, ...config }
  }

  execute(messages: ChatMessage[]): StrategyResult {
    const originalCount = messages.length

    if (!this.config.enabled) {
      return {
        messages,
        originalCount,
        processedCount: originalCount,
        strategyName: 'tokenLimit',
        trimmed: false,
      }
    }

    const systemMessages = messages.filter(msg => msg.role === 'system')
    const nonSystemMessages = messages.filter(msg => msg.role !== 'system')

    const systemTokens = systemMessages.reduce(
      (total, msg) => total + estimateTokens(msg.content),
      0
    )

    const availableTokens = this.config.maxTokens - systemTokens

    if (availableTokens <= 0) {
      console.warn(
        `[TokenLimitStrategy] System messages already exceed token limit ` +
          `(${systemTokens} > ${this.config.maxTokens})`
      )
      return {
        messages: systemMessages,
        originalCount,
        processedCount: systemMessages.length,
        strategyName: 'tokenLimit',
        trimmed: true,
      }
    }

    const keptNonSystemMessages: ChatMessage[] = []
    let currentTokens = 0

    for (let i = nonSystemMessages.length - 1; i >= 0; i--) {
      const msg = nonSystemMessages[i]
      const msgTokens = estimateTokens(msg.content)

      if (currentTokens + msgTokens <= availableTokens) {
        keptNonSystemMessages.unshift(msg)
        currentTokens += msgTokens
      } else {
        break
      }
    }

    const result = [...systemMessages, ...keptNonSystemMessages]
    const totalTokens = systemTokens + currentTokens

    console.log(
      `[TokenLimitStrategy] Trimmed from ${originalCount} to ${result.length} messages ` +
        `(tokens: ${totalTokens}/${this.config.maxTokens})`
    )

    return {
      messages: result,
      originalCount,
      processedCount: result.length,
      strategyName: 'tokenLimit',
      trimmed: result.length < originalCount,
    }
  }
}

/**
 * Summary Generation Function Type
 */
export type SummaryGenerator = (
  messages: ChatMessage[],
  prompt?: string
) => Promise<string>

/**
 * Summary Compression Strategy
 * Generates summary for early conversation, keeps recent messages + summary
 */
export class SummaryStrategy {
  private config: SummaryConfig
  private summaryGenerator?: SummaryGenerator

  constructor(
    config: SummaryConfig = DEFAULT_SUMMARY_CONFIG,
    summaryGenerator?: SummaryGenerator
  ) {
    this.config = { ...DEFAULT_SUMMARY_CONFIG, ...config }
    this.summaryGenerator = summaryGenerator
  }

  async execute(messages: ChatMessage[]): Promise<StrategyResult> {
    const originalCount = messages.length

    if (!this.config.enabled) {
      return {
        messages,
        originalCount,
        processedCount: originalCount,
        strategyName: 'summary',
        trimmed: false,
      }
    }

    if (originalCount <= this.config.keepRecentMessages) {
      return {
        messages,
        originalCount,
        processedCount: originalCount,
        strategyName: 'summary',
        trimmed: false,
      }
    }

    if (!this.summaryGenerator) {
      console.warn('[SummaryStrategy] No summary generator provided, falling back to sliding window')
      const fallbackMessages = messages.slice(-this.config.keepRecentMessages)
      return {
        messages: fallbackMessages,
        originalCount,
        processedCount: fallbackMessages.length,
        strategyName: 'summary',
        trimmed: true,
      }
    }

    const systemMessages = messages.filter(msg => msg.role === 'system')
    const nonSystemMessages = messages.filter(msg => msg.role !== 'system')

    const recentMessages = nonSystemMessages.slice(-this.config.keepRecentMessages)
    const oldMessages = nonSystemMessages.slice(0, -this.config.keepRecentMessages)

    if (oldMessages.length === 0) {
      return {
        messages,
        originalCount,
        processedCount: originalCount,
        strategyName: 'summary',
        trimmed: false,
      }
    }

    try {
      console.log(
        `[SummaryStrategy] Generating summary for ${oldMessages.length} old messages`
      )

      const summary = await this.summaryGenerator(
        oldMessages,
        this.config.summaryPrompt
      )

      const summaryMessage: ChatMessage = {
        role: 'system',
        content: `[Conversation Summary]\n${summary}`,
      }

      const result = [...systemMessages, summaryMessage, ...recentMessages]

      console.log(
        `[SummaryStrategy] Compressed from ${originalCount} to ${result.length} messages ` +
          `(summary generated for ${oldMessages.length} messages)`
      )

      return {
        messages: result,
        originalCount,
        processedCount: result.length,
        strategyName: 'summary',
        trimmed: true,
      }
    } catch (error) {
      console.error('[SummaryStrategy] Failed to generate summary:', error)
      const fallbackMessages = [...systemMessages, ...recentMessages]
      return {
        messages: fallbackMessages,
        originalCount,
        processedCount: fallbackMessages.length,
        strategyName: 'summary',
        trimmed: true,
      }
    }
  }
}

/**
 * Context Management Service
 * Orchestrates multiple context management strategies
 */
export class ContextManagementService {
  private config: ContextManagementConfig
  private slidingWindowStrategy: SlidingWindowStrategy
  private tokenLimitStrategy: TokenLimitStrategy
  private summaryStrategy: SummaryStrategy

  constructor(
    config: ContextManagementConfig = DEFAULT_CONTEXT_MANAGEMENT_CONFIG,
    summaryGenerator?: SummaryGenerator
  ) {
    this.config = { ...DEFAULT_CONTEXT_MANAGEMENT_CONFIG, ...config }
    this.slidingWindowStrategy = new SlidingWindowStrategy(
      this.config.strategies.slidingWindow
    )
    this.tokenLimitStrategy = new TokenLimitStrategy(
      this.config.strategies.tokenLimit
    )
    this.summaryStrategy = new SummaryStrategy(
      this.config.strategies.summary,
      summaryGenerator
    )
  }

  /**
   * Update configuration
   */
  updateConfig(config: Partial<ContextManagementConfig>): void {
    this.config = {
      ...this.config,
      ...config,
      strategies: {
        ...this.config.strategies,
        ...(config.strategies || {}),
      },
    }

    this.slidingWindowStrategy = new SlidingWindowStrategy(
      this.config.strategies.slidingWindow
    )
    this.tokenLimitStrategy = new TokenLimitStrategy(
      this.config.strategies.tokenLimit
    )
    this.summaryStrategy = new SummaryStrategy(
      this.config.strategies.summary,
      this.summaryStrategy['summaryGenerator']
    )
  }

  /**
   * Process messages through all enabled strategies
   */
  async process(messages: ChatMessage[]): Promise<ContextProcessResult> {
    const originalCount = messages.length
    const strategyResults: StrategyResult[] = []

    if (!this.config.enabled) {
      return {
        messages,
        originalCount,
        finalCount: originalCount,
        strategyResults: [],
        summaryGenerated: false,
      }
    }

    console.log(
      `[ContextManagementService] Processing ${originalCount} messages ` +
        `with order: ${this.config.executionOrder.join(', ')}`
    )

    let currentMessages = [...messages]
    let summaryGenerated = false

    for (const strategyName of this.config.executionOrder) {
      let result: StrategyResult

      switch (strategyName) {
        case 'slidingWindow':
          result = this.slidingWindowStrategy.execute(currentMessages)
          break

        case 'tokenLimit':
          result = this.tokenLimitStrategy.execute(currentMessages)
          break

        case 'summary':
          result = await this.summaryStrategy.execute(currentMessages)
          if (result.trimmed) {
            summaryGenerated = true
          }
          break

        default:
          console.warn(`[ContextManagementService] Unknown strategy: ${strategyName}`)
          continue
      }

      strategyResults.push(result)
      currentMessages = result.messages

      if (result.trimmed) {
        console.log(
          `[ContextManagementService] Strategy ${strategyName} trimmed ` +
            `${result.originalCount} -> ${result.processedCount} messages`
        )
      }
    }

    console.log(
      `[ContextManagementService] Final result: ${originalCount} -> ${currentMessages.length} messages`
    )

    return {
      messages: currentMessages,
      originalCount,
      finalCount: currentMessages.length,
      strategyResults,
      summaryGenerated,
    }
  }

  /**
   * Get current configuration
   */
  getConfig(): ContextManagementConfig {
    return { ...this.config }
  }

  /**
   * Estimate total tokens for messages
   */
  static estimateTotalTokens(messages: ChatMessage[]): number {
    return messages.reduce((total, msg) => total + estimateTokens(msg.content), 0)
  }
}

/**
 * Create default context management service instance
 */
export function createContextManagementService(
  config?: Partial<ContextManagementConfig>,
  summaryGenerator?: SummaryGenerator
): ContextManagementService {
  const finalConfig: ContextManagementConfig = {
    ...DEFAULT_CONTEXT_MANAGEMENT_CONFIG,
    ...config,
    strategies: {
      ...DEFAULT_CONTEXT_MANAGEMENT_CONFIG.strategies,
      ...(config?.strategies || {}),
    },
  }

  return new ContextManagementService(finalConfig, summaryGenerator)
}
