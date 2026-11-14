import type { BuiltinProviderConfig } from '../../store/types'

export const qwenAiConfig: BuiltinProviderConfig = {
  id: 'qwen-ai',
  name: 'Qwen AI (International)',
  type: 'builtin',
  authType: 'jwt',
  apiEndpoint: 'https://chat.qwen.ai',
  chatPath: '/api/v2/chat/completions',
  headers: {
    'Content-Type': 'application/json',
    Accept: 'application/json',
    source: 'web',
  },
  enabled: true,
  description: 'Qwen AI international version (chat.qwen.ai)',
  modelsApiEndpoint: 'https://chat.qwen.ai/api/models',
  modelsApiHeaders: {
    Accept: 'application/json, text/plain, */*',
    Referer: 'https://chat.qwen.ai/',
    source: 'web',
    Version: '0.2.35',
  },
  supportedModels: [
    'Qwen4-Max-Preview',
    'Qwen3.8-Max',
    'Qwen3.8-Omni-Flash',
    'Qwen3.7-Max',
    'Qwen3.7-Plus',
    'Qwen3.5-Omni-Plus',
    'Qwen-Image-3.0',
    'Wan3.0-Video',
  ],
  modelMappings: {
    'Qwen4-Max-Preview': 'qwen4.0-max-preview',
    'Qwen3.8-Max': 'qwen3.8-max',
    'Qwen3.8-Omni-Flash': 'qwen3.8-omni-flash',
    'Qwen3.7-Max': 'qwen3.7-max',
    'Qwen3.7-Plus': 'qwen3.7-plus',
    'Qwen3.5-Omni-Plus': 'qwen3.5-omni-plus',
    'Qwen-Image-3.0': 'qwen-image-3.0',
    'Wan3.0-Video': 'wan3.0-video',
  },
  // Kept in supportedModels/modelMappings so the route and catalog entry stay
  // wired. The proxy answers 503 model_unavailable while the model returns
  // empty answers, then restores it after a fresh bare no-system call passes.
  temporarilyUnavailableModels: ['Qwen4-Max-Preview'],
  credentialFields: [
    {
      name: 'token',
      label: 'Auth Token',
      type: 'password',
      required: true,
      placeholder: 'Enter JWT token from chat.qwen.ai',
      helpText: 'JWT token obtained from chat.qwen.ai Local Storage (key: "token")',
    },
    {
      name: 'cookies',
      label: 'Cookies (Optional)',
      type: 'textarea',
      required: false,
      placeholder: 'Optional cookies for enhanced compatibility',
      helpText: 'Full cookie string from browser DevTools (optional but recommended)',
    },
  ],
}

export default qwenAiConfig
