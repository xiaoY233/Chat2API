export interface TokenExtractionGuide {
  loginUrl: string
  steps: string[]
  tokenKey: string
  tokenLabel: string
  storageType: 'localStorage' | 'cookie' | 'other'
  placeholder?: string
  helpUrl?: string
}

export const TOKEN_EXTRACTION_GUIDES: Record<string, TokenExtractionGuide> = {
  deepseek: {
    loginUrl: 'https://chat.deepseek.com',
    steps: [
      '1. Click the button below to open DeepSeek website',
      '2. Log in to your account',
      '3. Press F12 to open Developer Tools',
      '4. Switch to the Application tab',
      '5. Find Local Storage → chat.deepseek.com on the left',
      '6. Find the userToken field and copy its value',
    ],
    tokenKey: 'userToken',
    tokenLabel: 'Token',
    storageType: 'localStorage',
    placeholder: 'Paste the Token obtained from DeepSeek',
  },
  qwen: {
    loginUrl: 'https://www.qianwen.com',
    steps: [
      '1. Click the button below to open Qwen website',
      '2. Log in to your account',
      '3. Press F12 to open Developer Tools',
      '4. Switch to the Application tab',
      '5. Find Cookies → www.qianwen.com on the left',
      '6. Find tongyi_sso_ticket and copy its value',
    ],
    tokenKey: 'tongyi_sso_ticket',
    tokenLabel: 'Ticket',
    storageType: 'cookie',
    placeholder: 'Paste the Ticket obtained from Qwen',
  },
  glm: {
    loginUrl: 'https://chatglm.cn',
    steps: [
      '1. Click the button below to open GLM website',
      '2. Log in to your account',
      '3. Press F12 to open Developer Tools',
      '4. Switch to the Application tab',
      '5. Find Local Storage → chatglm.cn on the left',
      '6. Find the token or access_token field and copy its value',
    ],
    tokenKey: 'token',
    tokenLabel: 'Token',
    storageType: 'localStorage',
    placeholder: 'Paste the Token obtained from GLM',
  },
  kimi: {
    loginUrl: 'https://www.kimi.com',
    steps: [
      '1. Click the button below to open Kimi website',
      '2. Log in to your account',
      '3. Press F12 to open Developer Tools',
      '4. Switch to the Network tab',
      '5. Refresh the page or send a message',
      '6. Find any API request and check the Authorization header',
      '7. Copy the token value after Bearer',
    ],
    tokenKey: 'authorization',
    tokenLabel: 'Token',
    storageType: 'other',
    placeholder: 'Paste the Token obtained from Kimi',
  },
  minimax: {
    loginUrl: 'https://www.minimaxi.com',
    steps: [
      '1. Click the button below to open MiniMax website',
      '2. Log in to your account',
      '3. Press F12 to open Developer Tools',
      '4. Switch to the Application tab',
      '5. Find Local Storage → www.minimaxi.com on the left',
      '6. Find the token or access_token field and copy its value',
    ],
    tokenKey: 'token',
    tokenLabel: 'Token',
    storageType: 'localStorage',
    placeholder: 'Paste the Token obtained from MiniMax',
  },
}

export function getGuideByProvider(providerType: string): TokenExtractionGuide | undefined {
  return TOKEN_EXTRACTION_GUIDES[providerType]
}
