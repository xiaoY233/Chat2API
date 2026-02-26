import type { BuiltinProviderConfig } from '../../store/types'

export const glmConfig: BuiltinProviderConfig = {
  id: 'glm',
  name: 'GLM',
  type: 'builtin',
  authType: 'refresh_token',
  apiEndpoint: 'https://chatglm.cn/api',
  chatPath: '/chatglm/backend-api/assistant/stream',
  headers: {
    'Content-Type': 'application/json',
    'Accept': 'text/event-stream',
    'Accept-Encoding': 'gzip, deflate, br, zstd',
    'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8,en-GB;q=0.7,en-US;q=0.6',
    'App-Name': 'chatglm',
    'Cache-Control': 'no-cache',
    'Origin': 'https://chatglm.cn',
    'Pragma': 'no-cache',
    'Priority': 'u=1, i',
    'Sec-Ch-Ua': '"Microsoft Edge";v="143", "Chromium";v="143", "Not A(Brand";v="24"',
    'Sec-Ch-Ua-Mobile': '?0',
    'Sec-Ch-Ua-Platform': '"Windows"',
    'Sec-Fetch-Dest': 'empty',
    'Sec-Fetch-Mode': 'cors',
    'Sec-Fetch-Site': 'same-origin',
    'X-App-Fr': 'browser_extension',
    'X-App-Platform': 'pc',
    'X-App-Version': '0.0.1',
    'X-Device-Brand': '',
    'X-Device-Model': '',
    'X-Lang': 'zh',
  },
  enabled: true,
  description: 'Zhipu Qingyan AI assistant, supports GLM-5 flagship model, deep thinking and video generation',
  supportedModels: [
    'GLM-5',
  ],
  modelMappings: {
    'GLM-5': 'glm-5',
  },
  credentialFields: [
    {
      name: 'refresh_token',
      label: 'Refresh Token',
      type: 'password',
      required: true,
      placeholder: 'Enter GLM refresh token',
      helpText: 'Get refresh_token from Zhipu Qingyan web version, found in browser DevTools Application -> Local Storage -> chatglm_refresh_token',
    },
  ],
  tokenCheckEndpoint: '/chatglm/user-api/user/refresh',
  tokenCheckMethod: 'POST',
}

export default glmConfig
