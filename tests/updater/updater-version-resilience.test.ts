import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

test('updater construction cannot crash the main process on an invalid version', () => {
  const source = readFileSync('src/main/updater/UpdaterManager.ts', 'utf8')

  // electron-updater throws from the `autoUpdater` getter when app.getVersion()
  // is not strict semver, so every access has to be guarded.
  assert.match(source, /private unavailableReason: string \| null = null/)
  assert.match(source, /try \{\s*this\.configureAutoUpdater\(\)/)
  assert.match(source, /catch \(error\) \{[\s\S]*?this\.unavailableReason = message/)
})

test('updater entry points bail out when autoUpdater could not be built', () => {
  const source = readFileSync('src/main/updater/UpdaterManager.ts', 'utf8')

  for (const method of ['checkForUpdates', 'downloadUpdate', 'quitAndInstall']) {
    const start = source.indexOf(`public async ${method}`) >= 0
      ? source.indexOf(`public async ${method}`)
      : source.indexOf(`public ${method}`)
    assert.ok(start > 0, `${method} should exist`)

    const body = source.slice(start, start + 400)
    assert.match(body, /if \(this\.unavailableReason\)/, `${method} must guard on unavailableReason`)
  }
})

test('package version is strict semver for electron-updater', () => {
  const pkg = JSON.parse(readFileSync('package.json', 'utf8')) as { version: string }
  // electron-updater validates with strict semver: "1.5.2pre-1" is rejected,
  // only "1.5.2-pre.1" style prereleases are accepted.
  assert.match(pkg.version, /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$/)
})
