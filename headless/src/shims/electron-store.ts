import Conf, { type Options } from 'conf'
import { getStoreEncryptionKey } from '../keyManager.ts'

type ElectronStoreOptions<T extends Record<string, unknown>> = Omit<Options<T>, 'configName' | 'projectName'> & {
  name?: string
  encryptionKey?: string | Buffer
}

export default class ElectronStore<T extends Record<string, unknown> = Record<string, unknown>> extends Conf<T> {
  constructor(options: ElectronStoreOptions<T> = {}) {
    const { name = 'config', encryptionKey: _ignoredEncryptionKey, ...rest } = options
    super({
      ...rest,
      configName: name,
      projectName: 'chat2api-headless',
      encryptionKey: getStoreEncryptionKey(),
    })
  }
}
