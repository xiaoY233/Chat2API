import type { BuiltinProviderConfig } from '../../store/types'

export const zaiConfig: BuiltinProviderConfig = {
  id: 'zai',
  name: 'Z.ai',
  type: 'builtin',
  authType: 'jwt',
  apiEndpoint: 'https://chat.z.ai/api',
  chatPath: '/v2/chat/completions',
  headers: {
    'Content-Type': 'application/json',
    'Accept': '*/*',
    'Accept-Encoding': 'gzip, deflate, br, zstd',
    'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8,en-GB;q=0.7,en-US;q=0.6',
    'Cache-Control': 'no-cache',
    'Origin': 'https://chat.z.ai',
    'Pragma': 'no-cache',
    'Sec-Ch-Ua': '"Chromium";v="144", "Not(A:Brand";v="8", "Google Chrome";v="144"',
    'Sec-Ch-Ua-Mobile': '?0',
    'Sec-Ch-Ua-Platform': '"Windows"',
    'Sec-Fetch-Dest': 'empty',
    'Sec-Fetch-Mode': 'cors',
    'Sec-Fetch-Site': 'same-origin',
    'X-FE-Version': 'prod-fe-1.0.241',
  },
  enabled: true,
  description: 'Z.ai - Free AI Chatbot powered by GLM-5 and GLM-4.7',
  supportedModels: [
    'GLM-5',
    'GLM-4.7',
    'GLM-4.6V',
    'GLM-4.6',
  ],
  modelMappings: {
    'GLM-5': 'glm-5',
    'GLM-4.7': 'glm-4.7',
    'GLM-4.6V': 'glm-4.6v',
    'GLM-4.6': 'glm-4.6v',
  },
  credentialFields: [
    {
      name: 'token',
      label: 'Access Token',
      type: 'password',
      required: true,
      placeholder: 'Enter Z.ai JWT Token',
      helpText: 'Get token from Z.ai cookie (token) or localStorage, starts with "eyJ..."',
    },
  ],
  tokenCheckEndpoint: '/api/v1/users/user/settings',
  tokenCheckMethod: 'GET',
}

export default zaiConfig
