/**
 * Cache Manager - Unified cache management with LRU strategy
 * Provides memory management and automatic cleanup for all caches
 */

export interface CacheOptions {
  maxSize?: number
  maxAge?: number
}

export interface CacheEntry<T> {
  value: T
  timestamp: number
  expiresAt?: number
}

export class LRUCache<K, V> {
  private cache: Map<K, CacheEntry<V>>
  private maxSize: number
  private maxAge: number

  constructor(options: CacheOptions = {}) {
    this.cache = new Map()
    this.maxSize = options.maxSize || 100
    this.maxAge = options.maxAge || 0
  }

  get(key: K): V | undefined {
    const entry = this.cache.get(key)
    if (!entry) return undefined

    if (this.isExpired(entry)) {
      this.cache.delete(key)
      return undefined
    }

    this.cache.delete(key)
    this.cache.set(key, entry)
    return entry.value
  }

  set(key: K, value: V): void {
    if (this.cache.has(key)) {
      this.cache.delete(key)
    } else if (this.cache.size >= this.maxSize) {
      const firstKey = this.cache.keys().next().value
      if (firstKey !== undefined) {
        this.cache.delete(firstKey)
      }
    }

    const entry: CacheEntry<V> = {
      value,
      timestamp: Date.now(),
      expiresAt: this.maxAge > 0 ? Date.now() + this.maxAge : undefined,
    }
    this.cache.set(key, entry)
  }

  has(key: K): boolean {
    const entry = this.cache.get(key)
    if (!entry) return false

    if (this.isExpired(entry)) {
      this.cache.delete(key)
      return false
    }

    return true
  }

  delete(key: K): boolean {
    return this.cache.delete(key)
  }

  clear(): void {
    this.cache.clear()
  }

  size(): number {
    return this.cache.size
  }

  keys(): K[] {
    return Array.from(this.cache.keys())
  }

  values(): V[] {
    return Array.from(this.cache.values()).map(entry => entry.value)
  }

  purgeStale(): number {
    let purged = 0
    for (const [key, entry] of this.cache.entries()) {
      if (this.isExpired(entry)) {
        this.cache.delete(key)
        purged++
      }
    }
    return purged
  }

  private isExpired(entry: CacheEntry<V>): boolean {
    if (!entry.expiresAt) return false
    return Date.now() > entry.expiresAt
  }
}

export class CacheManager {
  private caches: Map<string, LRUCache<string, any>> = new Map()
  private cleanupInterval?: NodeJS.Timeout

  createCache(name: string, options: CacheOptions = {}): LRUCache<string, any> {
    if (this.caches.has(name)) {
      console.warn(`[CacheManager] Cache "${name}" already exists, returning existing cache`)
      return this.caches.get(name)!
    }

    const cache = new LRUCache<string, any>(options)
    this.caches.set(name, cache)
    console.log(`[CacheManager] Created cache "${name}" with maxSize=${options.maxSize || 100}, maxAge=${options.maxAge || 0}ms`)
    return cache
  }

  getCache(name: string): LRUCache<string, any> | undefined {
    return this.caches.get(name)
  }

  hasCache(name: string): boolean {
    return this.caches.has(name)
  }

  deleteCache(name: string): boolean {
    const cache = this.caches.get(name)
    if (cache) {
      cache.clear()
    }
    return this.caches.delete(name)
  }

  clearCache(name: string): boolean {
    const cache = this.caches.get(name)
    if (cache) {
      cache.clear()
      return true
    }
    return false
  }

  clearAll(): void {
    for (const cache of this.caches.values()) {
      cache.clear()
    }
    console.log('[CacheManager] All caches cleared')
  }

  startCleanup(interval: number = 60000): void {
    if (this.cleanupInterval) {
      console.warn('[CacheManager] Cleanup already running')
      return
    }

    this.cleanupInterval = setInterval(() => {
      let totalPurged = 0
      for (const [name, cache] of this.caches.entries()) {
        const purged = cache.purgeStale()
        if (purged > 0) {
          totalPurged += purged
          console.log(`[CacheManager] Purged ${purged} stale entries from cache "${name}"`)
        }
      }
      if (totalPurged > 0) {
        console.log(`[CacheManager] Total purged: ${totalPurged} entries`)
      }
    }, interval)

    console.log(`[CacheManager] Started cleanup interval: ${interval}ms`)
  }

  stopCleanup(): void {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval)
      this.cleanupInterval = undefined
      console.log('[CacheManager] Stopped cleanup interval')
    }
  }

  getStats(): Record<string, { size: number; maxSize: number }> {
    const stats: Record<string, { size: number; maxSize: number }> = {}
    for (const [name, cache] of this.caches.entries()) {
      stats[name] = {
        size: cache.size(),
        maxSize: (cache as any).maxSize,
      }
    }
    return stats
  }

  getTotalSize(): number {
    let total = 0
    for (const cache of this.caches.values()) {
      total += cache.size()
    }
    return total
  }
}

export const cacheManager = new CacheManager()
