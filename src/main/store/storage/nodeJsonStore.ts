import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs'
import { join } from 'path'
import type { JsonStore, JsonStoreOptions } from './types'

export class NodeJsonStore<T extends Record<string, unknown>> implements JsonStore<T> {
  private readonly filePath: string
  private data: Record<string, unknown>

  constructor(options: JsonStoreOptions<T>) {
    mkdirSync(options.cwd, { recursive: true })
    this.filePath = join(options.cwd, `${options.name}.json`)
    this.data = { ...options.defaults }

    if (existsSync(this.filePath)) {
      try {
        const parsed = JSON.parse(readFileSync(this.filePath, 'utf8'))
        this.data = { ...this.data, ...parsed }
      } catch {
        renameSync(this.filePath, join(options.cwd, `${options.name}.corrupted.${Date.now()}.json`))
        this.persist()
      }
    } else {
      this.persist()
    }
  }

  get(key: string): unknown {
    return this.data[key]
  }

  set(key: string, value: unknown): void {
    this.data = {
      ...this.data,
      [key]: value,
    }
    this.persist()
  }

  delete(key: string): void {
    const next = { ...this.data }
    delete next[key]
    this.data = next
    this.persist()
  }

  clear(): void {
    this.data = {}
    this.persist()
  }

  private persist(): void {
    writeFileSync(this.filePath, `${JSON.stringify(this.data, null, 2)}\n`, 'utf8')
  }
}
