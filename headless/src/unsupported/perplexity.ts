export class PerplexityAdapter {
  static isPerplexityProvider(): boolean { return false }
  constructor() { throw new Error('Perplexity is not supported by Chat2API Headless') }
}

export const perplexityAdapter = { PerplexityAdapter }
