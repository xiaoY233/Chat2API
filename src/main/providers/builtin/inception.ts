import type { BuiltinProviderConfig } from '../../store/types'
import { INCEPTION_API_BASE, INCEPTION_USER_AGENT } from '../inception'

export const inceptionConfig: BuiltinProviderConfig = {
  id: 'inception',
  name: 'Inception (Mercury)',
  type: 'builtin',
  authType: 'cookie',
  apiEndpoint: INCEPTION_API_BASE,
  chatPath: '/api/chat',
  headers: {
    'Accept': 'text/event-stream, application/json',
    'Accept-Language': 'en-US,en;q=0.9',
    'Content-Type': 'application/json',
    'Origin': INCEPTION_API_BASE,
    'Referer': `${INCEPTION_API_BASE}/`,
    'User-Agent': INCEPTION_USER_AGENT,
  },
  enabled: true,
  description: 'Inception Mercury web chat (chat.inceptionlabs.ai) using the anonymous Vercel clearance cookie, with native web search',
  supportedModels: ['mercury-3'],
  modelMappings: {
    'mercury-3': 'mercury-3',
  },
  credentialFields: [
    {
      name: '_vcrcs',
      label: 'Vercel clearance cookie (_vcrcs)',
      type: 'password',
      required: false,
      placeholder: 'Optional: paste the _vcrcs cookie value or a full Cookie header',
      helpText: 'Use the OAuth Login tab to open chat.inceptionlabs.ai; the app captures the clearance cookie automatically. Manual fallback: after opening the site in a browser, copy the _vcrcs cookie. Leaving this empty also works: the app solves the Vercel checkpoint itself.',
    },
  ],
  tokenCheckEndpoint: '/api/session',
  tokenCheckMethod: 'GET',
}

export default inceptionConfig