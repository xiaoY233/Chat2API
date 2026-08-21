import type { JsonStoreOptions } from './types'

export async function createElectronJsonStore<T extends Record<string, unknown>>(
  options: JsonStoreOptions<T>
): Promise<any> {
  const module = await import('electron-store')
  const Store = module.default
  return new Store(options)
}
