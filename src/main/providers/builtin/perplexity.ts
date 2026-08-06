import type { BuiltinProviderConfig } from '../../store/types'

export const perplexityConfig: BuiltinProviderConfig = {
  id: 'perplexity',
  name: 'Perplexity',
  type: 'builtin',
  authType: 'cookie',
  apiEndpoint: 'https://www.perplexity.ai',
  chatPath: '/rest/sse/perplexity_ask',
  headers: {
    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36',
    'Accept': 'text/event-stream',
    'Content-Type': 'application/json',
    'Origin': 'https://www.perplexity.ai',
    'Referer': 'https://www.perplexity.ai/',
  },
  enabled: true,
  description: 'Perplexity AI search assistant with Free Auto mode and web search enhancement',
  supportedModels: [
    'Auto',
  ],
  modelMappings: {
    'Auto': 'auto',
  },
  credentialFields: [
    {
      name: 'sessionToken',
      label: 'Session Token',
      type: 'password',
      required: true,
      placeholder: 'Enter Perplexity session token',
      helpText: 'Session token obtained from Perplexity web version (__Secure-next-auth.session-token cookie)',
    },
  ],
}

export default perplexityConfig
