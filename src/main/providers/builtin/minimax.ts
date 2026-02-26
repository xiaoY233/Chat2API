import type { BuiltinProviderConfig } from '../../store/types'

export const minimaxConfig: BuiltinProviderConfig = {
  id: 'minimax',
  name: 'MiniMax',
  type: 'builtin',
  authType: 'jwt',
  apiEndpoint: 'https://agent.minimaxi.com',
  chatPath: '/matrix/api/v1/chat/send_msg',
  headers: {
    'Content-Type': 'application/json',
    'Accept': 'application/json, text/plain, */*',
    'Accept-Encoding': 'gzip, deflate, br, zstd',
    'Accept-Language': 'zh-CN,zh;q=0.9',
    'Cache-Control': 'no-cache',
    'Origin': 'https://agent.minimaxi.com',
    'Pragma': 'no-cache',
    'Sec-Ch-Ua': '"Not:A-Brand";v="99", "Google Chrome";v="145", "Chromium";v="145"',
    'Sec-Ch-Ua-Mobile': '?0',
    'Sec-Ch-Ua-Platform': '"macOS"',
    'Sec-Fetch-Dest': 'empty',
    'Sec-Fetch-Mode': 'cors',
    'Sec-Fetch-Site': 'same-origin',
    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36',
  },
  enabled: true,
  description: 'MiniMax Agent - AI assistant with MCP multi-agent collaboration',
  supportedModels: [
    'MiniMax-M2.5',
  ],
  modelMappings: {
    'MiniMax-M2.5': 'MiniMax-M2.5',
  },
  credentialFields: [
    {
      name: 'token',
      label: 'JWT Token',
      type: 'password',
      required: true,
      placeholder: 'Enter MiniMax JWT Token or realUserID+JWTtoken',
      helpText: 'Format: "realUserID+JWTtoken" or just JWT token (will extract userID from JWT)',
    },
    {
      name: 'realUserID',
      label: 'Real User ID (Optional)',
      type: 'text',
      required: false,
      placeholder: 'Enter Real User ID (optional)',
      helpText: 'If provided, use this instead of JWT user ID. Can also use format: realUserID+JWTtoken in token field',
    },
  ],
  tokenCheckEndpoint: '/v1/api/user/device/register',
  tokenCheckMethod: 'POST',
}

export default minimaxConfig
