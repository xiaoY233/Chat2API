import type { BuiltinProviderConfig } from '../../store/types'

export const qwenConfig: BuiltinProviderConfig = {
  id: 'qwen',
  name: 'Qwen',
  type: 'builtin',
  authType: 'tongyi_sso_ticket',
  apiEndpoint: 'https://chat2.qianwen.com',
  chatPath: '/api/v2/chat',
  headers: {
    'Content-Type': 'application/json',
    'Accept': 'application/json, text/event-stream, text/plain, */*',
    'Origin': 'https://www.qianwen.com',
    'Referer': 'https://www.qianwen.com/',
  },
  enabled: true,
  description: 'Qwen AI assistant by Alibaba Cloud (www.qianwen.com)',
  supportedModels: [
    'Qwen3',
    'Qwen3-Max',
    'Qwen3-Max-Thinking',
    'Qwen3-Plus',
    'Qwen3.5-Plus',
    'Qwen3-Flash',
    'Qwen3-Coder',
  ],
  modelMappings: {
    'Qwen3': 'tongyi-qwen3-max-model-agent',
    'Qwen3-Max': 'tongyi-qwen3-max-model-agent',
    'Qwen3-Max-Thinking': 'tongyi-qwen3-max-thinking-agent',
    'Qwen3-Plus': 'tongyi-qwen-plus-agent',
    'Qwen3.5-Plus': 'Qwen3.5-Plus',
    'Qwen3-Flash': 'qwen3-flash',
    'Qwen3-Coder': 'qwen3-coder-plus',
  },
  credentialFields: [
    {
      name: 'ticket',
      label: 'SSO Ticket',
      type: 'password',
      required: true,
      placeholder: 'Enter tongyi_sso_ticket',
      helpText: 'SSO ticket obtained from www.qianwen.com, found in browser DevTools Application -> Cookies as tongyi_sso_ticket',
    },
  ],
}

export default qwenConfig
