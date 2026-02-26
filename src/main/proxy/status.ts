/**
 * Proxy Service Module - Status Management
 * Records request count, success rate, response time and other statistics
 */

import { ProxyStatistics, ProxyConfig } from './types'

/**
 * Proxy status manager
 */
export class ProxyStatusManager {
  private statistics: ProxyStatistics = {
    totalRequests: 0,
    successRequests: 0,
    failedRequests: 0,
    avgLatency: 0,
    requestsPerMinute: 0,
    activeConnections: 0,
    modelUsage: {},
    providerUsage: {},
    accountUsage: {},
  }

  private config: ProxyConfig = {
    port: 8080,
    host: '0.0.0.0',
    timeout: 120000,
    retryCount: 3,
    retryDelay: 5000,
    maxConnections: 100,
    enableCors: true,
    corsOrigin: '*',
  }

  private startTime: number | null = null
  private isRunning: boolean = false
  private requestTimestamps: number[] = []
  private latencySum: number = 0

  /**
   * Get statistics
   */
  getStatistics(): ProxyStatistics {
    this.cleanupOldTimestamps()
    this.statistics.requestsPerMinute = this.requestTimestamps.length
    this.statistics.avgLatency = this.statistics.totalRequests > 0
      ? this.latencySum / this.statistics.totalRequests
      : 0
    return { ...this.statistics }
  }

  /**
   * Get configuration
   */
  getConfig(): ProxyConfig {
    return { ...this.config }
  }

  /**
   * Update configuration
   */
  updateConfig(config: Partial<ProxyConfig>): void {
    this.config = { ...this.config, ...config }
  }

  /**
   * Get running status
   */
  getRunningStatus(): { isRunning: boolean; startTime: number | null; uptime: number } {
    return {
      isRunning: this.isRunning,
      startTime: this.startTime,
      uptime: this.startTime ? Date.now() - this.startTime : 0,
    }
  }

  /**
   * Start proxy
   */
  start(): void {
    this.isRunning = true
    this.startTime = Date.now()
  }

  /**
   * Stop proxy
   */
  stop(): void {
    this.isRunning = false
    this.startTime = null
    this.statistics.activeConnections = 0
  }

  /**
   * Record request start
   */
  recordRequestStart(model: string, providerId?: string, accountId?: string): void {
    this.statistics.totalRequests++
    this.statistics.activeConnections++
    this.requestTimestamps.push(Date.now())

    this.statistics.modelUsage[model] = (this.statistics.modelUsage[model] || 0) + 1

    if (providerId) {
      this.statistics.providerUsage[providerId] = (this.statistics.providerUsage[providerId] || 0) + 1
    }

    if (accountId) {
      this.statistics.accountUsage[accountId] = (this.statistics.accountUsage[accountId] || 0) + 1
    }

    this.cleanupOldTimestamps()
  }

  /**
   * Record request success
   */
  recordRequestSuccess(latency: number): void {
    this.statistics.successRequests++
    this.statistics.activeConnections = Math.max(0, this.statistics.activeConnections - 1)
    this.latencySum += latency
  }

  /**
   * Record request failure
   */
  recordRequestFailure(latency: number): void {
    this.statistics.failedRequests++
    this.statistics.activeConnections = Math.max(0, this.statistics.activeConnections - 1)
    this.latencySum += latency
  }

  /**
   * Clean up expired timestamps (older than 1 minute)
   */
  private cleanupOldTimestamps(): void {
    const oneMinuteAgo = Date.now() - 60000
    this.requestTimestamps = this.requestTimestamps.filter(ts => ts > oneMinuteAgo)
  }

  /**
   * Reset statistics
   */
  resetStatistics(): void {
    this.statistics = {
      totalRequests: 0,
      successRequests: 0,
      failedRequests: 0,
      avgLatency: 0,
      requestsPerMinute: 0,
      activeConnections: 0,
      modelUsage: {},
      providerUsage: {},
      accountUsage: {},
    }
    this.requestTimestamps = []
    this.latencySum = 0
  }

  /**
   * Get port
   */
  getPort(): number {
    return this.config.port
  }

  /**
   * Set port
   */
  setPort(port: number): void {
    this.config.port = port
  }
}

export const proxyStatusManager = new ProxyStatusManager()
export default proxyStatusManager
