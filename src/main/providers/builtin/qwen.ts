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
    'Qwen3.6',
    'Qwen3.7-Max',
    'Qwen3.5-Flash',
    'Qwen3-Max',
    'Qwen3-Max-Thinking-Preview',
    'Qwen3-Coder',
  ],
  modelMappings: {
    'Qwen3.6': 'Qwen',
    'Qwen3.7-Max': 'Qwen3.7-Max',
    'Qwen3.5-Flash': 'Qwen3.5-Flash',
    'Qwen3-Max': 'Qwen3-Max',
    'Qwen3-Max-Thinking-Preview': 'Qwen3-Max-Thinking-Preview',
    'Qwen3-Coder': 'Qwen3-Coder',
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
