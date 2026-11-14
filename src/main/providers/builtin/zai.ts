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
    'Accept-Language': 'zh-CN',
    'Cache-Control': 'no-cache',
    'Origin': 'https://chat.z.ai',
    'Pragma': 'no-cache',
    'Sec-Ch-Ua': '"Not/A)Brand";v="99", "Chromium";v="148"',
    'Sec-Ch-Ua-Mobile': '?0',
    'Sec-Ch-Ua-Platform': '"macOS"',
    'Sec-Fetch-Dest': 'empty',
    'Sec-Fetch-Mode': 'cors',
    'Sec-Fetch-Site': 'same-origin',
    'X-FE-Version': 'prod-fe-1.1.128',
    'X-Region': 'overseas',
  },
  enabled: true,
  description: 'Z.ai - Free AI Chatbot powered by GLM-5.3, GLM-5.3-flash, and GLM-5.2',
  supportedModels: [
    'GLM-5.3',
    'GLM-5.3-flash',
    'GLM-5.2',
  ],
  modelMappings: {
    'GLM-5.3': 'glm-5.3',
    'GLM-5.3-flash': 'x-preview-l',
    'GLM-5.2': 'glm-5.2',
  },
  credentialFields: [
    {
      name: 'token',
      label: 'Access Token',
      type: 'password',
      required: true,
      placeholder: 'Enter Z.ai JWT Token',
      helpText: 'Get token from Z.ai web version, found in browser DevTools Application -> Cookie, starts with "eyJ..."',
    },
    {
      name: 'captcha_verify_param',
      label: 'Captcha Verify Param (Optional)',
      type: 'password',
      required: false,
      placeholder: 'Optional manual captcha_verify_param override',
      helpText: 'Optional. Z.ai captcha is generated automatically through a hidden captcha window. Paste a value from a HAR only when automatic generation is unavailable.',
    },
  ],
  tokenCheckEndpoint: '/api/v1/users/user/settings',
  tokenCheckMethod: 'GET',
}

export default zaiConfig
