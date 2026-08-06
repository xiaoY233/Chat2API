# In-App Update Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Convert the About page update flow from manual GitHub release checking to an in-app `electron-updater` check, download, and restart-install workflow.

**Architecture:** Keep `UpdaterManager` as the single main-process update state source. `APP_CHECK_UPDATE` triggers `UpdaterManager.checkForUpdates()`, renderer state is driven by update IPC events, and the existing download/install IPC handlers remain the only way to download or install updates.

**Tech Stack:** Electron main process IPC, `electron-updater`, React 18, TypeScript, Node built-in test runner.

---

## File Structure

- Modify `src/main/ipc/handlers.ts`: replace the manual GitHub Releases API code inside `APP_CHECK_UPDATE` with `UpdaterManager.checkForUpdates()` and `getStatus()`.
- Modify `src/preload/index.ts`: change `app.checkUpdate()` return type from manual release result to updater `UpdateStatus`.
- Modify `src/renderer/src/types/electron.d.ts`: align `AppAPI.checkUpdate()` with `UpdateStatus` and make update event types match renderer usage.
- Modify `src/renderer/src/pages/About.tsx`: replace the mixed `hasUpdate/releaseUrl` and updater event state with one updater-driven state model.
- Create `tests/updater/in-app-update-flow.test.ts`: source-level regression tests that lock the intended updater wiring.

## Task 1: Add Regression Coverage For Update Wiring

**Files:**
- Create: `tests/updater/in-app-update-flow.test.ts`

- [ ] **Step 1: Write the failing source regression test**

Create `tests/updater/in-app-update-flow.test.ts` with this content:

```ts
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
```

- [ ] **Step 2: Run the focused test and verify it fails**

Run:

```bash
node --test tests/updater/in-app-update-flow.test.ts
```

Expected result before implementation: FAIL. At minimum, the first test should fail because `APP_CHECK_UPDATE` still uses `api.github.com/repos` and `compareVersions`.

- [ ] **Step 3: Commit the failing test**

```bash
git add tests/updater/in-app-update-flow.test.ts
git commit -m "test: cover in-app update wiring"
```

## Task 2: Switch Main IPC Check To UpdaterManager

**Files:**
- Modify: `src/main/ipc/handlers.ts`

- [ ] **Step 1: Replace the `APP_CHECK_UPDATE` handler implementation**

In `src/main/ipc/handlers.ts`, replace the whole `ipcMain.handle(IpcChannels.APP_CHECK_UPDATE, async () => { ... })` block with:

```ts
  ipcMain.handle(IpcChannels.APP_CHECK_UPDATE, async () => {
    try {
      await updaterManager.checkForUpdates()
      return updaterManager.getStatus()
    } catch (error) {
      console.error('[App] Check update error:', error)
      return {
        ...updaterManager.getStatus(),
        checking: false,
        error: error instanceof Error ? error.message : String(error),
      }
    }
  })
```

Do not remove the top-level `axios` import because the same file still uses it for provider model API checks.

- [ ] **Step 2: Run the focused test**

Run:

```bash
node --test tests/updater/in-app-update-flow.test.ts
```

Expected result at this point: the first test should pass, and the preload/types/About tests may still fail.

- [ ] **Step 3: Commit the IPC change**

```bash
git add src/main/ipc/handlers.ts
git commit -m "fix: use updater manager for update checks"
```

## Task 3: Align Preload And Renderer Types

**Files:**
- Modify: `src/preload/index.ts`
- Modify: `src/renderer/src/types/electron.d.ts`

- [ ] **Step 1: Add preload update status types**

In `src/preload/index.ts`, add these interfaces near the app API definitions if equivalent local types are not already present in that file:

```ts
interface UpdateProgressInfo {
  percent: number
  bytesPerSecond: number
  transferred: number
  total: number
}

interface UpdateStatus {
  checking: boolean
  available: boolean
  downloading: boolean
  downloaded: boolean
  error: string | null
  progress: UpdateProgressInfo | null
  version: string | null
  releaseDate: string | null
  releaseNotes: string | null
}
```

- [ ] **Step 2: Change preload `checkUpdate` return type**

In `src/preload/index.ts`, change:

```ts
  checkUpdate: (): Promise<{ hasUpdate: boolean; currentVersion: string; latestVersion: string; releaseUrl?: string; error?: string }> =>
    ipcRenderer.invoke(IpcChannels.APP_CHECK_UPDATE),
```

to:

```ts
  checkUpdate: (): Promise<UpdateStatus> =>
    ipcRenderer.invoke(IpcChannels.APP_CHECK_UPDATE),
```

- [ ] **Step 3: Change renderer type declaration**

In `src/renderer/src/types/electron.d.ts`, change:

```ts
  checkUpdate: () => Promise<{ hasUpdate: boolean; currentVersion: string; latestVersion: string; releaseUrl?: string; error?: string }>
```

to:

```ts
  checkUpdate: () => Promise<UpdateStatus>
```

If `onUpdateError` is typed as `(error: string)`, change it to:

```ts
  onUpdateError: (callback: (error: { message?: string } | string) => void) => () => void
```

- [ ] **Step 4: Run the focused test**

Run:

```bash
node --test tests/updater/in-app-update-flow.test.ts
```

Expected result at this point: preload/types assertions should pass, About page assertions may still fail.

- [ ] **Step 5: Commit type alignment**

```bash
git add src/preload/index.ts src/renderer/src/types/electron.d.ts
git commit -m "fix: expose updater status to renderer"
```

## Task 4: Refactor About Page To Updater-Driven State

**Files:**
- Modify: `src/renderer/src/pages/About.tsx`

- [ ] **Step 1: Replace manual update result types**

In `src/renderer/src/pages/About.tsx`, replace the existing `UpdateInfo` interface with:

```ts
type UpdatePhase = 'idle' | 'checking' | 'available' | 'not-available' | 'downloading' | 'downloaded' | 'error'

interface UpdateInfo {
  phase: UpdatePhase
  latestVersion: string | null
  error: string | null
}
```

Keep the existing `DownloadProgress` interface.

- [ ] **Step 2: Replace update state declarations**

Replace:

```ts
  const [appUpdateStatus, setAppUpdateStatus] = useState<{
    checking: boolean
    result?: UpdateInfo
  }>({ checking: false })

  const [downloadProgress, setDownloadProgress] = useState<DownloadProgress | null>(null)
  const [isDownloading, setIsDownloading] = useState(false)
  const [isDownloaded, setIsDownloaded] = useState(false)
  const [downloadError, setDownloadError] = useState<string | null>(null)
```

with:

```ts
  const [updateInfo, setUpdateInfo] = useState<UpdateInfo>({
    phase: 'idle',
    latestVersion: null,
    error: null,
  })
  const [downloadProgress, setDownloadProgress] = useState<DownloadProgress | null>(null)
```

- [ ] **Step 3: Subscribe to all updater events**

Replace the existing updater event `useEffect` with:

```ts
  useEffect(() => {
    if (!window.electronAPI?.app) return

    const unsubscribeChecking = window.electronAPI.app.onUpdateChecking(() => {
      setUpdateInfo({ phase: 'checking', latestVersion: null, error: null })
      setDownloadProgress(null)
    })

    const unsubscribeAvailable = window.electronAPI.app.onUpdateAvailable((info: any) => {
      setUpdateInfo({
        phase: 'available',
        latestVersion: info?.version || null,
        error: null,
      })
      setDownloadProgress(null)
    })

    const unsubscribeNotAvailable = window.electronAPI.app.onUpdateNotAvailable(() => {
      setUpdateInfo({ phase: 'not-available', latestVersion: null, error: null })
      setDownloadProgress(null)
    })

    const unsubscribeProgress = window.electronAPI.app.onUpdateProgress((progress: DownloadProgress) => {
      setUpdateInfo((current) => ({
        phase: 'downloading',
        latestVersion: current.latestVersion,
        error: null,
      }))
      setDownloadProgress(progress)
    })

    const unsubscribeDownloaded = window.electronAPI.app.onUpdateDownloaded((info: any) => {
      setUpdateInfo((current) => ({
        phase: 'downloaded',
        latestVersion: info?.version || current.latestVersion,
        error: null,
      }))
      setDownloadProgress(null)
    })

    const unsubscribeError = window.electronAPI.app.onUpdateError((error: any) => {
      setUpdateInfo((current) => ({
        phase: 'error',
        latestVersion: current.latestVersion,
        error: typeof error === 'string' ? error : error?.message || 'Update failed',
      }))
      setDownloadProgress(null)
    })

    return () => {
      unsubscribeChecking()
      unsubscribeAvailable()
      unsubscribeNotAvailable()
      unsubscribeProgress()
      unsubscribeDownloaded()
      unsubscribeError()
    }
  }, [])
```

- [ ] **Step 4: Refactor check/download/install handlers**

Replace the three update handlers with:

```ts
  const handleCheckAppUpdate = async () => {
    setUpdateInfo({ phase: 'checking', latestVersion: null, error: null })
    setDownloadProgress(null)
    try {
      const status = await window.electronAPI.app.checkUpdate()
      setUpdateInfo((current) => ({
        phase: status.error
          ? 'error'
          : status.available
            ? 'available'
            : status.checking
              ? 'checking'
              : current.phase === 'checking'
                ? current.phase
                : 'not-available',
        latestVersion: status.version || current.latestVersion,
        error: status.error,
      }))
    } catch (error) {
      setUpdateInfo({
        phase: 'error',
        latestVersion: null,
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }

  const handleDownloadUpdate = async () => {
    try {
      setUpdateInfo((current) => ({
        phase: 'downloading',
        latestVersion: current.latestVersion,
        error: null,
      }))
      setDownloadProgress(null)
      await window.electronAPI.app.downloadUpdate()
    } catch (error) {
      setUpdateInfo((current) => ({
        phase: 'error',
        latestVersion: current.latestVersion,
        error: error instanceof Error ? error.message : 'Download failed',
      }))
    }
  }

  const handleInstallUpdate = async () => {
    try {
      await window.electronAPI.app.installUpdate()
    } catch (error) {
      setUpdateInfo((current) => ({
        phase: 'error',
        latestVersion: current.latestVersion,
        error: error instanceof Error ? error.message : 'Install failed',
      }))
    }
  }
```

- [ ] **Step 5: Replace update UI conditions**

In the update button area, replace conditions based on `appUpdateStatus`, `isDownloading`, `isDownloaded`, and `downloadError` with conditions based on `updateInfo.phase`:

```tsx
              {updateInfo.phase === 'checking' ? (
                <div className="flex items-center gap-2 px-3 py-1.5 rounded-full bg-[var(--accent-primary)]/10">
                  <Loader2 className="w-3.5 h-3.5 text-[var(--accent-primary)] animate-spin" />
                  <span className="text-xs font-medium text-[var(--accent-primary)]">
                    {t('settings.checkingUpdate')}
                  </span>
                </div>
              ) : updateInfo.phase === 'downloading' && downloadProgress ? (
                <div className="flex flex-col gap-2 min-w-[200px]">
                  <div className="flex items-center justify-between text-xs text-[var(--text-muted)]">
                    <span>{t('settings.downloadingUpdate')}</span>
                    <span className="font-mono">{downloadProgress.percent.toFixed(1)}%</span>
                  </div>
                  <div className="w-full h-2 bg-[var(--bg-tertiary)] rounded-full overflow-hidden">
                    <div
                      className="h-full bg-[var(--accent-primary)] transition-all duration-300"
                      style={{ width: `${downloadProgress.percent}%` }}
                    />
                  </div>
                  <div className="flex items-center justify-between text-xs text-[var(--text-dim)]">
                    <span>{formatSpeed(downloadProgress.bytesPerSecond)}</span>
                    <span>
                      {formatBytes(downloadProgress.transferred)} / {formatBytes(downloadProgress.total)}
                    </span>
                  </div>
                </div>
              ) : updateInfo.phase === 'downloaded' ? (
                <div className="flex items-center gap-3">
                  <div className="flex items-center gap-2 px-3 py-1.5 rounded-full bg-[var(--success)]/10 shadow-[0_0_8px_var(--success)]">
                    <CheckCircle2 className="w-3.5 h-3.5 text-[var(--success)]" />
                    <span className="text-xs font-medium text-[var(--success)]">
                      {t('settings.updateDownloaded')}
                    </span>
                  </div>
                  <button
                    onClick={handleInstallUpdate}
                    className="px-4 py-2 bg-[var(--accent-primary)] hover:bg-[var(--accent-primary)]/90 text-white text-sm font-medium rounded-full transition-colors flex items-center gap-2 shadow-lg shadow-[var(--accent-primary)]/20"
                  >
                    <RefreshCw className="w-4 h-4" />
                    {t('settings.restartAndInstall')}
                  </button>
                </div>
              ) : updateInfo.phase === 'error' ? (
                <div className="flex items-center gap-3">
                  <div className="flex items-center gap-2 px-3 py-1.5 rounded-full bg-[var(--accent-error)]/10">
                    <AlertCircle className="w-3.5 h-3.5 text-[var(--accent-error)]" />
                    <span className="text-xs font-medium text-[var(--accent-error)]">
                      {t('settings.updateCheckFailed')}
                    </span>
                  </div>
                  <button
                    onClick={handleCheckAppUpdate}
                    className="px-4 py-2 bg-[var(--glass-bg)] hover:bg-[var(--glass-bg-hover)] border border-[var(--glass-border)] hover:border-[var(--glass-border-hover)] rounded-full text-sm text-[var(--text-primary)] font-medium transition-all duration-200 flex items-center gap-2"
                  >
                    <RefreshCw className="h-4 w-4 text-[var(--text-muted)]" />
                    {t('settings.retry')}
                  </button>
                </div>
              ) : updateInfo.phase === 'available' ? (
                <div className="flex items-center gap-3">
                  <div className="flex items-center gap-2 px-3 py-1.5 rounded-full bg-[var(--success)]/10 shadow-[0_0_8px_var(--success)]">
                    <span className="relative flex h-2 w-2">
                      <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-[var(--success)] opacity-75"></span>
                      <span className="relative inline-flex rounded-full h-2 w-2 bg-[var(--success)]"></span>
                    </span>
                    <span className="text-xs font-medium text-[var(--success)]">
                      {t('settings.updateAvailable')} v{updateInfo.latestVersion || ''}
                    </span>
                  </div>
                  <button
                    onClick={handleDownloadUpdate}
                    className="px-4 py-2 bg-[var(--accent-primary)] hover:bg-[var(--accent-primary)]/90 text-white text-sm font-medium rounded-full transition-colors flex items-center gap-2 shadow-lg shadow-[var(--accent-primary)]/20"
                  >
                    <Download className="w-4 h-4" />
                    {t('settings.downloadUpdate')}
                  </button>
                </div>
              ) : (
                <button
                  onClick={handleCheckAppUpdate}
                  className="px-4 py-2 bg-[var(--glass-bg)] hover:bg-[var(--glass-bg-hover)] border border-[var(--glass-border)] hover:border-[var(--glass-border-hover)] rounded-full text-sm text-[var(--text-primary)] font-medium transition-all duration-200 flex items-center gap-2"
                >
                  <Globe className="h-4 w-4 text-[var(--text-muted)]" />
                  {t('settings.checkUpdates')}
                </button>
              )}
```

- [ ] **Step 6: Replace result detail block**

Replace the block that checks `appUpdateStatus.result` with:

```tsx
          {(updateInfo.phase === 'error' || updateInfo.phase === 'not-available') && (
            <div className="mt-4 pt-4 border-t border-[var(--glass-border)]">
              {updateInfo.phase === 'error' ? (
                <div className="flex items-center gap-2 text-[var(--accent-error)]">
                  <AlertCircle className="w-4 h-4" />
                  <span className="text-sm font-medium">
                    {updateInfo.error || t('settings.updateCheckFailed')}
                  </span>
                </div>
              ) : (
                <div className="flex items-center gap-2 text-[var(--accent-success)]">
                  <CheckCircle2 className="w-4 h-4" />
                  <span className="text-sm font-medium">{t('settings.upToDate')}</span>
                </div>
              )}
            </div>
          )}
```

- [ ] **Step 7: Run the focused test**

Run:

```bash
node --test tests/updater/in-app-update-flow.test.ts
```

Expected result: PASS.

- [ ] **Step 8: Commit the About page refactor**

```bash
git add src/renderer/src/pages/About.tsx
git commit -m "fix: drive update UI from updater events"
```

## Task 5: Build Verification And Release Metadata Check

**Files:**
- No required source changes unless verification exposes a package configuration issue.

- [ ] **Step 1: Run focused update tests**

Run:

```bash
node --test tests/updater/in-app-update-flow.test.ts
```

Expected: all tests pass.

- [ ] **Step 2: Run related source regression tests**

Run:

```bash
node --test tests/tool-calling/tool-settings-ui.test.ts tests/providers/provider-flow.test.ts
```

Expected: all tests pass. This guards the source-level test conventions and catches accidental renderer source regressions.

- [ ] **Step 3: Run production build**

Run:

```bash
npm run build
```

Expected: `electron-vite build` succeeds.

- [ ] **Step 4: Inspect publish metadata configuration**

Run:

```bash
node -e "const p=require('./package.json'); console.log(JSON.stringify(p.build.publish,null,2)); console.log(JSON.stringify({mac:p.build.mac.target, win:p.build.win.target, linux:p.build.linux.target},null,2));"
```

Expected output includes:

```json
{
  "provider": "github",
  "owner": "xiaoY233",
  "repo": "Chat2API"
}
```

Expected targets include mac `dmg`, Windows `nsis`, and Linux `AppImage`. If a real release artifact later lacks updater metadata, fix the GitHub Actions/electron-builder publish target in a separate focused change.

- [ ] **Step 5: Final commit for verification adjustments if needed**

If no extra changes are needed, skip this commit. If a package config adjustment is required, commit it with:

```bash
git add package.json .github/workflows/release.yml
git commit -m "fix: align update publish metadata"
```

## Self-Review

- Spec coverage: main check path, updater event data flow, download/install flow, error display, and build verification are covered by Tasks 1-5.
- Scope: startup auto-check, silent download, custom update source, and UI redesign remain outside the plan as requested.
- Type consistency: `checkUpdate()` returns `UpdateStatus` in main/preload/renderer types; About page uses `UpdatePhase` locally for UI rendering.
- Placeholder scan: this plan contains no TBD-style placeholders.
