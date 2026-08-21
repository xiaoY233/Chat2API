import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'

const expectedContract = {
  proxy: ['start', 'stop', 'getStatus', 'onStatusChanged'],
  store: ['get', 'set', 'delete', 'clearAll', 'onInitError', 'retryInit'],
  providers: [
    'getAll',
    'getBuiltin',
    'add',
    'update',
    'delete',
    'checkStatus',
    'checkAllStatus',
    'duplicate',
    'export',
    'import',
    'updateModels',
    'getEffectiveModels',
    'addCustomModel',
    'removeModel',
    'resetModels',
  ],
  accounts: [
    'getAll',
    'getById',
    'getByProvider',
    'add',
    'update',
    'delete',
    'validate',
    'validateToken',
    'getCredits',
    'clearChats',
  ],
  oauth: [
    'startLogin',
    'cancelLogin',
    'loginWithToken',
    'validateToken',
    'refreshToken',
    'getStatus',
    'startInAppLogin',
    'cancelInAppLogin',
    'isInAppLoginOpen',
    'onCallback',
    'onProgress',
  ],
  browserImport: [
    'createSession',
    'getSession',
    'buildImportScript',
    'applyImportPayload',
  ],
  logs: ['get', 'getStats', 'getTrend', 'getAccountTrend', 'clear', 'export', 'getById', 'onNewLog'],
  requestLogs: ['get', 'getById', 'getStats', 'getTrend', 'clear', 'onNewLog'],
  statistics: ['get', 'getToday'],
  app: [
    'getVersion',
    'minimize',
    'maximize',
    'close',
    'showWindow',
    'hideWindow',
    'openExternal',
    'checkUpdate',
    'downloadUpdate',
    'installUpdate',
    'getUpdateStatus',
    'onUpdateChecking',
    'onUpdateAvailable',
    'onUpdateNotAvailable',
    'onUpdateProgress',
    'onUpdateDownloaded',
    'onUpdateError',
  ],
  config: ['get', 'update', 'onConfigChanged'],
  prompts: ['getAll', 'getBuiltin', 'getCustom', 'getById', 'add', 'update', 'delete', 'getByType'],
  session: [
    'getConfig',
    'updateConfig',
    'getAll',
    'getActive',
    'getById',
    'getByAccount',
    'getByProvider',
    'delete',
    'clearAll',
    'cleanExpired',
  ],
  managementApi: ['getConfig', 'updateConfig', 'generateSecret'],
  contextManagement: ['getConfig', 'updateConfig'],
  toolCalling: ['getStatus', 'runSmoke'],
  tray: ['openDashboard', 'setHeight', 'quitApp'],
}

test('web admin adapter exposes the preload electronAPI contract', () => {
  const source = fs.readFileSync('src/renderer/src/web-admin-api.ts', 'utf8')

  assert.match(source, /window\.electronAPI\s*=/)
  assert.match(source, /sessionStorage/)
  assert.match(source, /Authorization/)
  assert.match(source, /\/v0\/management/)

  for (const [namespace, methods] of Object.entries(expectedContract)) {
    assert.match(source, new RegExp(`${namespace}\\s*[:=]\\s*\\{`), `missing namespace ${namespace}`)

    for (const method of methods) {
      assert.match(source, new RegExp(`${method}\\s*[:(]`), `missing ${namespace}.${method}`)
    }
  }

  assert.match(source, /invoke\s*[:(]/)
  assert.match(source, /send\s*[:(]/)
  assert.match(source, /\bon\s*[:(]/)
})

test('web admin keeps browser management secret in sync after settings changes', () => {
  const source = fs.readFileSync('src/renderer/src/web-admin-api.ts', 'utf8')

  assert.match(
    source,
    /generateSecret:\s*async[\s\S]*setManagementSecret\(secret\)[\s\S]*return secret/,
    'managementApi.generateSecret must store the newly generated secret before returning',
  )
  assert.match(
    source,
    /updateConfig:\s*async[\s\S]*managementApiSecret[\s\S]*setManagementSecret\(nextConfig\.managementApiSecret\)/,
    'managementApi.updateConfig must store the updated secret when it changes',
  )
})

test('web admin proxy start is idempotent when docker server is already running', () => {
  const source = fs.readFileSync('src/renderer/src/web-admin-api.ts', 'utf8')

  assert.match(
    source,
    /const status = await proxy\.getStatus\(\)[\s\S]*if \(status\.isRunning\) \{[\s\S]*return true[\s\S]*\}/,
    'proxy.start should return true when the Docker server is already running',
  )
})

test('web admin tool-calling smoke preserves electron preload response shape', () => {
  const source = fs.readFileSync('src/renderer/src/web-admin-api.ts', 'utf8')

  assert.match(
    source,
    /runSmoke:\s*async[\s\S]*const data = await managementFetch[\s\S]*return \{ success: true, data \}/,
    'toolCalling.runSmoke should return { success, data } like the Electron preload API',
  )
})

test('web admin marks docker runtime and disables electron-only proxy stop controls', () => {
  const webMainSource = fs.readFileSync('src/renderer/src/web-main.tsx', 'utf8')
  const headerSource = fs.readFileSync('src/renderer/src/components/layout/Header.tsx', 'utf8')
  const dashboardSource = fs.readFileSync('src/renderer/src/pages/Dashboard.tsx', 'utf8')
  const quickActionsSource = fs.readFileSync('src/renderer/src/components/dashboard/QuickActions.tsx', 'utf8')
  const proxyStatusSource = fs.readFileSync('src/renderer/src/components/proxy/ProxyStatus.tsx', 'utf8')
  const proxyConfigFormSource = fs.readFileSync('src/renderer/src/components/proxy/ProxyConfigForm.tsx', 'utf8')

  assert.match(webMainSource, /__CHAT2API_WEB_ADMIN__\s*=\s*true/)
  assert.match(headerSource, /isDockerWebAdmin/)
  assert.match(dashboardSource, /isDockerWebAdmin/)
  assert.match(quickActionsSource, /proxyManagedExternally/)
  assert.match(proxyStatusSource, /isDockerWebAdmin/)
  assert.match(proxyConfigFormSource, /isDockerWebAdmin/)
})

test('web admin provides browser-assisted Qwen AI import instead of docker in-app oauth', () => {
  const source = fs.readFileSync('src/renderer/src/web-admin-api.ts', 'utf8')
  const addAccountSource = fs.readFileSync('src/renderer/src/components/providers/AddAccountDialog.tsx', 'utf8')
  const addProviderSource = fs.readFileSync('src/renderer/src/components/providers/AddProviderDialog.tsx', 'utf8')
  const electronTypes = fs.readFileSync('src/renderer/src/types/electron.d.ts', 'utf8')

  assert.match(source, /const browserImport\s*=/)
  assert.match(source, /buildImportScript/)
  assert.match(source, /localStorage\.getItem\('token'\)/)
  assert.match(source, /document\.cookie/)
  assert.match(source, /\/browser-import\/complete/)
  assert.match(source, /providerId\s*=\s*'qwen-ai'/)
  assert.match(source, /tongyi_sso_ticket/)

  assert.match(addAccountSource, /browserImport/)
  assert.match(addAccountSource, /isDockerWebAdmin/)
  assert.match(addAccountSource, /browserImportScript/)
  assert.match(addAccountSource, /browserImportPayload/)
  assert.match(addAccountSource, /browserImportScriptRef/)
  assert.match(addAccountSource, /applyBrowserImportPayload/)
  assert.match(addAccountSource, /copyTextToClipboard/)
  assert.match(addAccountSource, /selectVisibleTextArea/)
  assert.match(addAccountSource, /document\.execCommand\('copy'\)/)
  assert.match(addAccountSource, /browserImportCopyManual/)
  assert.match(addAccountSource, /window\.setInterval/)
  assert.match(addAccountSource, /browserImport\.getSession/)
  assert.match(addAccountSource, /browserImport\.applyImportPayload/)

  assert.match(addProviderSource, /browserImport/)
  assert.match(addProviderSource, /isDockerWebAdmin/)
  assert.match(addProviderSource, /browserImportScript/)
  assert.match(addProviderSource, /browserImportPayload/)
  assert.match(addProviderSource, /browserImportScriptRef/)
  assert.match(addProviderSource, /applyBrowserImportPayload/)
  assert.match(addProviderSource, /copyTextToClipboard/)
  assert.match(addProviderSource, /selectVisibleTextArea/)
  assert.match(addProviderSource, /document\.execCommand\('copy'\)/)
  assert.match(addProviderSource, /browserImportCopyManual/)
  assert.match(addProviderSource, /window\.setInterval/)
  assert.match(addProviderSource, /browserImport\.getSession/)
  assert.match(addProviderSource, /browserImport\.applyImportPayload/)
  assert.match(addProviderSource, /oauthRefreshCredentialFields/)
  assert.match(addProviderSource, /renderCredentialFields\(oauthRefreshCredentialFields\)/)
  assert.match(addProviderSource, /\.\.\.prev,\s*\.\.\.mappedCredentials/)

  assert.match(electronTypes, /interface BrowserImportAPI/)
  assert.match(electronTypes, /browserImport: BrowserImportAPI/)
})
