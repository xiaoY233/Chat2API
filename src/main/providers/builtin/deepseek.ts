import type { BuiltinProviderConfig } from '../../store/types'

export const deepseekConfig: BuiltinProviderConfig = {
  id: 'deepseek',
  name: 'DeepSeek',
  type: 'builtin',
  authType: 'userToken',
  apiEndpoint: 'https://chat.deepseek.com/api',
  chatPath: '/v0/chat/completion',
  headers: {
    'Content-Type': 'application/json',
    'Accept': '*/*',
    'Accept-Encoding': 'gzip, deflate, br, zstd',
    'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
    'Origin': 'https://chat.deepseek.com',
    'Referer': 'https://chat.deepseek.com/',
    'Sec-Ch-Ua': '"Chromium";v="134", "Not:A-Brand";v="24", "Google Chrome";v="134"',
    'Sec-Ch-Ua-Mobile': '?0',
    'Sec-Ch-Ua-Platform': '"macOS"',
    'Sec-Fetch-Dest': 'empty',
    'Sec-Fetch-Mode': 'cors',
    'Sec-Fetch-Site': 'same-origin',
    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36',
    'X-App-Version': '20241129.1',
    'X-Client-Locale': 'zh-CN',
    'X-Client-Platform': 'web',
    'X-Client-Version': '1.6.1',
  },
  enabled: true,
  description: 'DeepSeek AI assistant, supports deep thinking and web search',
  supportedModels: [
    'DeepSeek-V3.2',
  ],
  modelMappings: {
    'DeepSeek-V3.2': 'deepseek-chat',
  },
  credentialFields: [
    {
      name: 'token',
      label: 'User Token',
      type: 'password',
      required: true,
      placeholder: 'Enter DeepSeek user token',
      helpText: 'Authentication token obtained from DeepSeek web version, found in browser DevTools Application -> Local Storage',
    },
  ],
  tokenCheckEndpoint: '/v0/users/current',
  tokenCheckMethod: 'GET',
}

export default deepseekConfig
