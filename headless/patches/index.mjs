import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

function patchFile(stagingRoot, relativePath, replacements) {
  const filePath = join(stagingRoot, relativePath)
  let contents = readFileSync(filePath, 'utf8').replace(/\r\n/g, '\n')

  for (const { label, before, after } of replacements) {
    const first = contents.indexOf(before)
    if (first === -1) {
      throw new Error(`Headless patch no longer applies (${label}): ${relativePath}`)
    }
    if (contents.indexOf(before, first + before.length) !== -1) {
      throw new Error(`Headless patch is ambiguous (${label}): ${relativePath}`)
    }
    contents = `${contents.slice(0, first)}${after}${contents.slice(first + before.length)}`
  }

  writeFileSync(filePath, contents)
}

export function applyHeadlessPatches(stagingRoot) {
  patchFile(stagingRoot, 'src/main/store/store.ts', [
    {
      label: 'disable unsafe automatic recovery in headless mode',
      before: `      this.initializationError = error instanceof Error ? error : new Error(String(error))
      
      // Try to recover by backing up corrupted data and reinitializing`,
      after: `      this.initializationError = error instanceof Error ? error : new Error(String(error))

      if (process.env.CHAT2API_HEADLESS === '1') {
        throw this.initializationError
      }
      
      // Try to recover by backing up corrupted data and reinitializing`,
    },
    {
      label: 'remove credential encryption logs',
      before: `      console.log('[Store] encryptData input length:', data.length, 'content:', data.substring(0, 20) + '...')
      if (safeStorage.isEncryptionAvailable()) {
        // Create new Buffer to store encryption result
        const encrypted = Buffer.from(safeStorage.encryptString(data))
        const result = encrypted.toString('base64')
        console.log('[Store] encryptData output length:', result.length, 'content:', result.substring(0, 20) + '...')
        // Verify encryption is correct
        const decrypted = safeStorage.decryptString(encrypted)
        console.log('[Store] encryptData verify decryption:', decrypted.substring(0, 20) + '...', 'match:', decrypted === data)
        return result`,
      after: `      if (safeStorage.isEncryptionAvailable()) {
        const encrypted = Buffer.from(safeStorage.encryptString(data))
        return encrypted.toString('base64')`,
    },
    {
      label: 'remove account update credential logs',
      before: `    console.log('[Store] Update account:', {
      id,
      updatesCredentials: updates.credentials,
      oldCredentials: accounts[index].credentials,
      oldCredentialsDecrypted: this.decryptCredentials(accounts[index].credentials),
    })
    
`,
      after: '',
    },
    {
      label: 'remove encrypted credential logs',
      before: `      updatedAccount.credentials = this.encryptCredentials(updates.credentials)
      console.log('[Store] Encrypted credentials:', updatedAccount.credentials)
      console.log('[Store] Old credentials:', accounts[index].credentials)
      console.log('[Store] Credentials match:', JSON.stringify(updatedAccount.credentials) === JSON.stringify(accounts[index].credentials))`,
      after: `      updatedAccount.credentials = this.encryptCredentials(updates.credentials)`,
    },
    {
      label: 'remove credential persistence verification logs',
      before: `    // Verify save was successful
    const savedAccounts = this.store!.get('accounts') as Account[]
    const savedAccount = savedAccounts.find(a => a.id === id)
    console.log('[Store] Verify after save:', {
      id,
      savedCredentials: savedAccount?.credentials,
    })
    
`,
      after: '',
    },
  ])

  patchFile(stagingRoot, 'src/main/proxy/adapters/deepseek.ts', [
    {
      label: 'remove DeepSeek credential logs',
      before: `    console.log('[DeepSeek] Account credentials:', JSON.stringify(account.credentials, null, 2))
    this.token = account.credentials.token || account.credentials.apiKey || account.credentials.refreshToken || ''
    console.log('[DeepSeek] Using token:', this.token.substring(0, 20) + '...')`,
      after: `    this.token = account.credentials.token || account.credentials.apiKey || account.credentials.refreshToken || ''`,
    },
  ])

  patchFile(stagingRoot, 'src/main/proxy/loadbalancer.ts', [
    {
      label: 'remove load balancer token logs',
      before: `      for (const account of accounts) {
        console.log(\`[LoadBalancer] Account \${account.name} (\${account.id}) Token: \${(account.credentials.token || '').substring(0, 20)}...\`)
        candidates.push({`,
      after: `      for (const account of accounts) {
        candidates.push({`,
    },
  ])

  patchFile(stagingRoot, 'src/main/providers/checker.ts', [
    {
      label: 'remove DeepSeek validation token log',
      before: `      console.log('[DeepSeek] Validating Token:', token.substring(0, 20) + '...')
      
`,
      after: '',
    },
    {
      label: 'remove Kimi validation token log',
      before: `      console.log('[Kimi] Validating Token:', token.substring(0, 20) + '...')
      
`,
      after: '',
    },
    {
      label: 'remove GLM validation token log',
      before: `      console.log('[GLM] Validating Token:', refreshToken.substring(0, 20) + '...')
      
`,
      after: '',
    },
    {
      label: 'remove GLM token response log',
      before: `      console.log('[GLM] Response data:', JSON.stringify(response.data, null, 2))
      
`,
      after: '',
    },
    {
      label: 'remove Kimi validation response log',
      before: `      console.log('[Kimi] Response data:', JSON.stringify(response.data, null, 2))
      
`,
      after: '',
    },
    {
      label: 'remove MiniMax validation token log',
      before: `      console.log('[MiniMax] Validating Token:', token.substring(0, 30) + '...')
      
`,
      after: '',
    },
    {
      label: 'remove MiniMax user ID log',
      before: `            console.log('[MiniMax] Extracted userId from token:', realUserID)
`,
      after: '',
    },
  ])

  patchFile(stagingRoot, 'src/main/proxy/adapters/minimax.ts', [
    {
      label: 'remove MiniMax request logs',
      before: `    console.log('[MiniMax] Stream Request - uuid:', realUserID, 'user_id:', realUserID, 'device_id:', deviceInfo.deviceId)
    console.log('[MiniMax] Request body:', dataJson)
    console.log('[MiniMax] Query string:', queryStr)
    console.log('[MiniMax] Headers - timestamp:', timestamp, 'signature:', signature.substring(0, 16) + '...', 'yy:', yy.substring(0, 16) + '...')

`,
      after: '',
    },
    {
      label: 'remove MiniMax response payload logs',
      before: `    stream.on('response', (respHeaders) => {
      console.log('[MiniMax] HTTP/2 response headers:', JSON.stringify(respHeaders))
    })

    stream.on('data', (chunk) => {
      console.log('[MiniMax] HTTP/2 data chunk:', chunk.toString().substring(0, 200))
    })

`,
      after: '',
    },
    {
      label: 'remove MiniMax SSE payload log',
      before: `          console.log('[MiniMax] SSE event:', eventName, 'data:', event.data?.substring(0, 100))

`,
      after: '',
    },
    {
      label: 'close MiniMax HTTP2 session',
      before: `    const stream = session.request(headers)
    stream.setTimeout(120000)
    stream.setEncoding('utf8')

    stream.on('error', (err) => {
      console.error('[MiniMax] HTTP/2 stream error:', err)
    })

    stream.on('close', () => {
      console.log('[MiniMax] HTTP/2 stream closed')
    })`,
      after: `    const stream = session.request(headers)
    stream.setTimeout(120000, () => {
      stream.close()
      if (!session.destroyed) session.destroy()
    })
    stream.setEncoding('utf8')

    stream.on('error', (err) => {
      console.error('[MiniMax] HTTP/2 stream error:', err)
      if (!session.destroyed) session.destroy()
    })

    stream.on('close', () => {
      if (!session.closed && !session.destroyed) session.close()
    })

    session.on('error', (err) => {
      console.error('[MiniMax] HTTP/2 session error:', err)
    })`,
    },
  ])

  patchFile(stagingRoot, 'src/main/proxy/adapters/zai.ts', [
    {
      label: 'remove Z.ai request metadata logs',
      before: `      console.log('[Z.ai] Request body:', JSON.stringify(requestBody, null, 2))
      console.log('[Z.ai] Signature:', signature)
      console.log('[Z.ai] Timestamp:', timestamp)
      console.log('[Z.ai] RequestId:', requestId)
      console.log('[Z.ai] UserId:', userId)
`,
      after: '',
    },
  ])

  patchFile(stagingRoot, 'src/main/store/config.ts', [
    {
      label: 'redact persisted configuration logs',
      before: `    storeManager.addLog('info', 'Update app configuration', {
      data: { updates },
    })`,
      after: `    storeManager.addLog('info', 'Update app configuration', {
      data: { updatedKeys: Object.keys(updates) },
    })`,
    },
  ])

  patchFile(stagingRoot, 'src/main/proxy/server.ts', [
    {
      label: 'fail closed when API key authentication has no keys',
      before: `      if (config.enableApiKey && config.apiKeys && config.apiKeys.length > 0) {
        const authHeader = ctx.get('Authorization') || ''`,
      after: `      if (config.enableApiKey) {
        if (!config.apiKeys || config.apiKeys.length === 0) {
          ctx.status = 503
          ctx.body = {
            error: {
              message: 'API key authentication is enabled but no keys are configured',
              type: 'configuration_error',
              code: 'api_key_misconfigured',
            },
          }
          return
        }

        const authHeader = ctx.get('Authorization') || ''`,
    },
    {
      label: 'remove unauthenticated statistics endpoint',
      before: `    this.router.get('/stats', async (ctx) => {
      const statistics = proxyStatusManager.getStatistics()
      ctx.body = statistics
    })

`,
      after: '',
    },
    {
      label: 'remove stats from public path list',
      before: `      const publicPaths = ['/', '/health', '/stats']`,
      after: `      const publicPaths = ['/', '/health']`,
    },
  ])
}
