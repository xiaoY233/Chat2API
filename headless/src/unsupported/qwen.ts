export class QwenAdapter {
  static isQwenProvider(): boolean { return false }
  constructor() { throw new Error('Qwen is not supported by Chat2API Headless') }
}

export class QwenStreamHandler {
  constructor() { throw new Error('Qwen is not supported by Chat2API Headless') }
}

export const qwenAdapter = { QwenAdapter, QwenStreamHandler }
