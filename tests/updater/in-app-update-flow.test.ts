import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

test('app check update delegates to UpdaterManager instead of GitHub REST version check', () => {
  const handlers = readFileSync('src/main/ipc/handlers.ts', 'utf8')
  const checkHandler = handlers.slice(
    handlers.indexOf('ipcMain.handle(IpcChannels.APP_CHECK_UPDATE'),
    handlers.indexOf('ipcMain.handle(IpcChannels.APP_DOWNLOAD_UPDATE'),
  )

  assert.match(checkHandler, /updaterManager\.checkForUpdates\(\)/)
  assert.match(checkHandler, /updaterManager\.getStatus\(\)/)
  assert.doesNotMatch(checkHandler, /api\.github\.com\/repos/)
  assert.doesNotMatch(checkHandler, /compareVersions/)
  assert.doesNotMatch(checkHandler, /releaseUrl/)
})

test('preload and renderer types expose updater status for checkUpdate', () => {
  const preload = readFileSync('src/preload/index.ts', 'utf8')
  const electronTypes = readFileSync('src/renderer/src/types/electron.d.ts', 'utf8')

  assert.match(preload, /checkUpdate:\s*\(\): Promise<UpdateStatus>/)
  assert.match(electronTypes, /checkUpdate:\s*\(\) => Promise<UpdateStatus>/)
  assert.doesNotMatch(preload, /hasUpdate: boolean; currentVersion: string; latestVersion: string; releaseUrl/)
  assert.doesNotMatch(electronTypes, /hasUpdate: boolean; currentVersion: string; latestVersion: string; releaseUrl/)
})

test('about page state is driven by updater events, not manual release URLs', () => {
  const about = readFileSync('src/renderer/src/pages/About.tsx', 'utf8')

  assert.match(about, /onUpdateChecking/)
  assert.match(about, /onUpdateAvailable/)
  assert.match(about, /onUpdateNotAvailable/)
  assert.match(about, /onUpdateProgress/)
  assert.match(about, /onUpdateDownloaded/)
  assert.match(about, /onUpdateError/)
  assert.match(about, /latestVersion: info\?\.version/)
  assert.doesNotMatch(about, /releaseUrl/)
  assert.doesNotMatch(about, /hasUpdate/)
})

test('about page does not hard-code the app version fallback', () => {
  const about = readFileSync('src/renderer/src/pages/About.tsx', 'utf8')

  assert.match(about, /getVersion\(\)\.then/)
  assert.match(about, /const displayAppVersion = appVersion \|\| '\.\.\.'/)
  assert.doesNotMatch(about, /useState<string>\('1\.3\.0'\)/)
})
