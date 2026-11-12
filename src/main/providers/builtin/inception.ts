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
  description: 'Inception Mercury web chat (chat.inceptionlabs.ai). Anonymous: no login needed, the app solves the Vercel challenge itself and streams /api/chat, with native web search',
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
      helpText: 'No login is required: the app solves the Vercel checkpoint and creates a session automatically, so this can be left empty. Advanced/manual fallback: copy the _vcrcs cookie from a browser and paste it here (value or full Cookie header).',
    },
  ],
  tokenCheckEndpoint: '/api/session',
  tokenCheckMethod: 'GET',
}

export default inceptionConfig