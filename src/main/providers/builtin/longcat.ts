import type { BuiltinProviderConfig } from '../../store/types'

export const longcatConfig: BuiltinProviderConfig = {
  id: 'longcat',
  name: 'LongCat',
  type: 'builtin',
  authType: 'cookie',
  apiEndpoint: 'https://longcat.ai',
  chatPath: '/api/v1/chat-completion',
  headers: {
    'Accept': 'text/event-stream,application/json',
    'Accept-Language': 'en-US,en;q=0.9',
    'Cache-Control': 'no-cache',
    'Content-Type': 'application/json',
    'Origin': 'https://longcat.ai',
    'Pragma': 'no-cache',
    'Referer': 'https://longcat.ai/',
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
    'X-Client-Language': 'en',
    'X-Requested-With': 'XMLHttpRequest',
  },
  enabled: true,
  description: 'LongCat web chat (Meituan) using the passport_token_key cookie, with web search mode',
  supportedModels: [
    'LongCat',
    'LongCat-Search',
  ],
  modelMappings: {
    'LongCat': 'LongCat',
    'LongCat-Search': 'LongCat-Search',
  },
  credentialFields: [
    {
      name: 'passport_token_key',
      label: 'passport_token_key Cookie',
      type: 'password',
      required: true,
      placeholder: 'Enter the passport_token_key cookie value or full Cookie header',
      helpText: 'Use the OAuth Login tab to sign in to longcat.ai automatically. Manual fallback: DevTools -> Application -> Cookies -> longcat.ai -> passport_token_key.',
    },
  ],
  tokenCheckEndpoint: '/api/v1/user-current',
  tokenCheckMethod: 'GET',
}

export default longcatConfig
