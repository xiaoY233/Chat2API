import type { BuiltinProviderConfig } from '../../store/types'

export const mimoConfig: BuiltinProviderConfig = {
  id: 'mimo',
  name: 'Mimo',
  type: 'builtin',
  authType: 'cookie',
  apiEndpoint: 'https://aistudio.xiaomimimo.com',
  chatPath: '/open-apis/bot/chat',
  headers: {
    'Content-Type': 'application/json',
    'Accept': '*/*',
    'Accept-Encoding': 'gzip, deflate, br, zstd',
    'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
    'Cache-Control': 'no-cache',
    'Origin': 'https://aistudio.xiaomimimo.com',
    'Referer': 'https://aistudio.xiaomimimo.com/',
    'Pragma': 'no-cache',
    'Sec-Ch-Ua': '"Chromium";v="144", "Not(A:Brand";v="8", "Google Chrome";v="144"',
    'Sec-Ch-Ua-Mobile': '?0',
    'Sec-Ch-Ua-Platform': '"Windows"',
    'Sec-Fetch-Dest': 'empty',
    'Sec-Fetch-Mode': 'cors',
    'Sec-Fetch-Site': 'same-origin',
    'X-Timezone': 'Asia/Shanghai',
  },
  enabled: true,
  description: 'XiaomiMIMO - Xiaomi General Intelligence Foundation Model',
  supportedModels: [
    'mimo-v2-pro',
    'mimo-v2-flash-studio',
    'mimo-v2-omni',
  ],
  modelMappings: {
    'mimo-v2-pro': 'mimo-v2-pro',
    'mimo-v2-flash-studio': 'mimo-v2-flash-studio',
    'mimo-v2-omni': 'mimo-v2-omni',
  },
  credentialFields: [
    {
      name: 'service_token',
      label: 'Service Token',
      type: 'password',
      required: true,
      placeholder: 'Enter serviceToken from Cookie',
      helpText: 'Found in browser DevTools -> Application -> Cookies -> serviceToken',
    },
    {
      name: 'user_id',
      label: 'User ID',
      type: 'text',
      required: true,
      placeholder: 'Enter userId from Cookie',
      helpText: 'Found in browser DevTools -> Application -> Cookies -> userId',
    },
    {
      name: 'ph_token',
      label: 'PH Token',
      type: 'password',
      required: true,
      placeholder: 'Enter xiaomichatbot_ph from Cookie',
      helpText: 'Found in browser DevTools -> Application -> Cookies -> xiaomichatbot_ph',
    },
  ],
}

export default mimoConfig
