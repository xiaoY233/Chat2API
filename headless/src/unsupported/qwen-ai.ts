export class QwenAiAdapter {
  static isQwenAiProvider(): boolean { return false }
  constructor() { throw new Error('qwen-ai is not supported by Chat2API Headless') }
}

export class QwenAiStreamHandler {
  constructor() { throw new Error('qwen-ai is not supported by Chat2API Headless') }
}

export const qwenAiAdapter = { QwenAiAdapter, QwenAiStreamHandler }
