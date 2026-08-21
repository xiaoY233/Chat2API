export interface RuntimeAdapter {
  kind: 'electron' | 'node'
  getDataDir(): string
  isEncryptionAvailable(): boolean
  encryptString(value: string): string
  decryptString(value: string): string
  getResourcePath(fileName: string): string
  openExternal(url: string): Promise<void>
  notify(channel: string, payload: unknown): void
}
