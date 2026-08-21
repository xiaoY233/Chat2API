export interface JsonStoreOptions<T extends Record<string, unknown>> {
  name: string
  cwd: string
  defaults: T
  encryptionKey?: string
}

export interface JsonStore<T extends Record<string, unknown>> {
  get<K extends keyof T>(key: K): T[K]
  get(key: string): unknown
  set<K extends keyof T>(key: K, value: T[K]): void
  set(key: string, value: unknown): void
  delete(key: string): void
  clear(): void
}
