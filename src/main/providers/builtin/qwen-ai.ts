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
  supportedModels: [
    'Qwen3.5-Plus',
    'Qwen3.5-397B-A17B',
    'Qwen3-Max',
    'Qwen3-235B-A22B-2507',
    'Qwen3-Coder',
    'Qwen3-VL-235B-A22B',
    'Qwen3-Omni-Flash',
    'Qwen2.5-Max',
  ],
  modelMappings: {
    'Qwen3.5-Plus': 'qwen3.5-plus',
    'Qwen3.5-397B-A17B': 'qwen3.5-397b-a17b',
    'Qwen3-Max': 'qwen3-max',
    'Qwen3-235B-A22B-2507': 'qwen3-235b-a22b-2507',
    'Qwen3-Coder': 'qwen3-coder-plus',
    'Qwen3-VL-235B-A22B': 'qwen3-vl-235b-a22b',
    'Qwen3-Omni-Flash': 'qwen3-omni-flash',
    'Qwen2.5-Max': 'qwen2.5-max',
    qwen: 'qwen3-max',
    qwen3: 'qwen3-max',
    'qwen3.5': 'qwen3.5-plus',
    'qwen3-coder': 'qwen3-coder-plus',
    'qwen3-vl': 'qwen3-vl-235b-a22b',
    'qwen3-omni': 'qwen3-omni-flash',
    'qwen2.5': 'qwen2.5-max',
  },
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
