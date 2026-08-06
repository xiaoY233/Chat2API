/**
 * Async Store - Asynchronous write queue for data persistence
 * Improves performance by batching and deduplicating writes
 */

export interface WriteTask {
  key: string
  value: any
  timestamp: number
}

export class AsyncStore {
  private writeQueue: Map<string, WriteTask> = new Map()
  private isProcessing: boolean = false
  private flushInterval: NodeJS.Timeout | null = null
  private readonly flushDelay: number
  private readonly batchSize: number
  private onFlush: (tasks: WriteTask[]) => Promise<void>

  constructor(
    onFlush: (tasks: WriteTask[]) => Promise<void>,
    options: {
      flushDelay?: number
      batchSize?: number
    } = {}
  ) {
    this.onFlush = onFlush
    this.flushDelay = options.flushDelay || 100
    this.batchSize = options.batchSize || 10
  }

  set(key: string, value: any): void {
    this.writeQueue.set(key, {
      key,
      value,
      timestamp: Date.now(),
    })

    this.scheduleFlush()
  }

  get(key: string): any | undefined {
    const task = this.writeQueue.get(key)
    if (task) {
      return task.value
    }
    return undefined
  }

  delete(key: string): boolean {
    return this.writeQueue.delete(key)
  }

  clear(): void {
    this.writeQueue.clear()
  }

  size(): number {
    return this.writeQueue.size
  }

  private scheduleFlush(): void {
    if (this.flushInterval) {
      return
    }

    this.flushInterval = setTimeout(() => {
      this.flush()
    }, this.flushDelay)
  }

  async flush(): Promise<void> {
    if (this.isProcessing || this.writeQueue.size === 0) {
      return
    }

    if (this.flushInterval) {
      clearTimeout(this.flushInterval)
      this.flushInterval = null
    }

    this.isProcessing = true

    try {
      const tasks = Array.from(this.writeQueue.values())
      this.writeQueue.clear()

      await this.onFlush(tasks)
    } catch (error) {
      console.error('[AsyncStore] Flush error:', error)
    } finally {
      this.isProcessing = false

      if (this.writeQueue.size > 0) {
        this.scheduleFlush()
      }
    }
  }

  async flushSync(): Promise<void> {
    if (this.flushInterval) {
      clearTimeout(this.flushInterval)
      this.flushInterval = null
    }

    await this.flush()
  }

  destroy(): void {
    if (this.flushInterval) {
      clearTimeout(this.flushInterval)
      this.flushInterval = null
    }
    this.writeQueue.clear()
  }
}

export class AsyncStoreManager {
  private stores: Map<string, AsyncStore> = new Map()

  createStore(
    name: string,
    onFlush: (tasks: WriteTask[]) => Promise<void>,
    options?: {
      flushDelay?: number
      batchSize?: number
    }
  ): AsyncStore {
    if (this.stores.has(name)) {
      console.warn(`[AsyncStoreManager] Store "${name}" already exists`)
      return this.stores.get(name)!
    }

    const store = new AsyncStore(onFlush, options)
    this.stores.set(name, store)
    return store
  }

  getStore(name: string): AsyncStore | undefined {
    return this.stores.get(name)
  }

  async flushAll(): Promise<void> {
    const promises = Array.from(this.stores.values()).map(store => store.flush())
    await Promise.all(promises)
  }

  destroyAll(): void {
    this.stores.forEach(store => store.destroy())
    this.stores.clear()
  }
}

export const asyncStoreManager = new AsyncStoreManager()
