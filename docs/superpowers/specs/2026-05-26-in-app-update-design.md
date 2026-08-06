# 应用内更新设计方案

## 背景

当前项目表面上有“检查更新”入口，但主流程仍然停留在手工检查版本：

- About 页面点击“检查更新”后，`APP_CHECK_UPDATE` handler 直接请求 GitHub Releases API。
- 主进程已有 `UpdaterManager`，并已经接入 `electron-updater` 的检查、下载、进度、下载完成、安装事件。
- preload 和 About 页面也已经有下载更新、重启安装、下载进度等基础 UI 能力。

因此本次不是从零实现更新系统，而是把现有“版本检查”主流程切换为真正的应用内更新流程。

## 目标

采用方案 A：手动检查、手动下载、手动重启安装。

用户路径：

1. 用户在 About 页面点击“检查更新”。
2. 应用内调用 `electron-updater` 检查版本。
3. 如有新版本，页面显示版本号和“下载更新”。
4. 用户点击“下载更新”，应用内展示下载进度。
5. 下载完成后，页面显示“重启安装”。
6. 用户点击“重启安装”，应用退出并安装更新。

## 非目标

本轮不做以下能力：

- 启动时自动检查更新。
- 静默下载更新。
- 后台自动重启安装。
- 自定义更新源配置。
- 增量更新或差分包优化。
- 重做整套设置页面视觉结构。

## 当前问题

### 主进程检查路径不一致

`APP_CHECK_UPDATE` 当前直接调用 GitHub Releases REST API，自己比较版本号。这会绕过 `electron-updater` 的发布元数据、平台适配、下载缓存和错误事件。

结果是：

- 前端拿到的是 `hasUpdate/latestVersion/releaseUrl`。
- 下载按钮调用的是 `UpdaterManager.downloadUpdate()`。
- 但 `UpdaterManager` 自己并没有通过 `checkForUpdates()` 得到“有更新”的状态。

这会造成检查、下载、安装三段状态来源不一致。

### 前端状态模型混杂

About 页面同时维护：

- `appUpdateStatus.result.hasUpdate`
- `isDownloading`
- `isDownloaded`
- `downloadError`
- `downloadProgress`

其中检查结果来自手工 GitHub API，下载状态来自 updater 事件。应用内更新应统一为 updater 状态驱动。

## 设计方案

### 主进程

`APP_CHECK_UPDATE` 不再请求 GitHub Releases API，改为调用：

```ts
await updaterManager.checkForUpdates()
return updaterManager.getStatus()
```

`UpdaterManager` 继续作为唯一更新状态源，负责：

- 设置 `autoUpdater.autoDownload = false`。
- 手动触发 `checkForUpdates()`。
- 转发 `checking-for-update`、`update-available`、`update-not-available`、`download-progress`、`update-downloaded`、`error` 事件。
- 维护 `UpdateStatus`。

### preload

`checkUpdate()` 返回值从手工版本检查结果改为 `UpdateStatus`。

更新事件继续保留：

- `onUpdateChecking`
- `onUpdateAvailable`
- `onUpdateNotAvailable`
- `onUpdateProgress`
- `onUpdateDownloaded`
- `onUpdateError`

### 前端 About 页面

About 页面改为 updater 状态机：

- `idle`：显示“检查更新”。
- `checking`：显示检查中。
- `available`：显示“发现新版本 vX.Y.Z”和“下载更新”。
- `notAvailable`：显示“已是最新版本”。
- `downloading`：显示下载进度、速度、已下载/总大小。
- `downloaded`：显示“更新已下载”和“重启安装”。
- `error`：显示错误和“重试”。

前端不再依赖 `releaseUrl` 作为正常更新路径。GitHub Release 页面只作为错误排查或后续“手动下载”入口，不进入本轮主流程。

### 发布配置

现有 `package.json` 已配置：

```json
"publish": {
  "provider": "github",
  "owner": "xiaoY233",
  "repo": "Chat2API"
}
```

现有 GitHub Actions 使用 `electron-builder --publish=always` 发布各平台包。本轮实现需要验证 release 产物是否包含 `electron-updater` 所需元数据，例如：

- macOS: `latest-mac.yml`
- Windows: `latest.yml`
- Linux AppImage: 对应 updater metadata

如果元数据缺失，应用内检查会失败或找不到更新。本轮代码应保留清晰错误提示，但 release 产物修复可以按验证结果决定是否纳入同一提交。

## 数据流

```text
About.tsx
  -> window.electronAPI.app.checkUpdate()
  -> ipcMain APP_CHECK_UPDATE
  -> UpdaterManager.checkForUpdates()
  -> electron-updater checks GitHub publish metadata
  -> UpdaterManager receives events
  -> ipc event to renderer
  -> About.tsx updates UI
```

下载流程：

```text
About.tsx download button
  -> window.electronAPI.app.downloadUpdate()
  -> ipcMain APP_DOWNLOAD_UPDATE
  -> UpdaterManager.downloadUpdate()
  -> electron-updater downloads artifact
  -> progress/downloaded events
  -> About.tsx shows progress or restart button
```

安装流程：

```text
About.tsx restart button
  -> window.electronAPI.app.installUpdate()
  -> ipcMain APP_INSTALL_UPDATE
  -> UpdaterManager.quitAndInstall()
```

## 错误处理

更新错误分为三类：

- 检查失败：网络错误、GitHub metadata 缺失、未打包环境不支持 updater。
- 下载失败：网络中断、权限问题、文件不存在、签名校验失败。
- 安装失败：没有已下载更新、权限不足、平台限制。

处理原则：

- 主进程记录详细错误日志。
- renderer 显示可理解的错误文案。
- UI 提供“重试”入口。
- 不在失败时自动跳转浏览器，避免回到“检查更新”的旧体验。

## 验收标准

- 点击“检查更新”后，主进程调用 `UpdaterManager.checkForUpdates()`，不再直接请求 GitHub Releases REST API。
- 无更新时，About 页面显示“已是最新版本”。
- 有更新时，About 页面显示新版本号和“下载更新”。
- 点击“下载更新”后，页面显示下载百分比、速度、已下载大小和总大小。
- 下载完成后，页面显示“重启安装”。
- 点击“重启安装”后，调用 `autoUpdater.quitAndInstall(false, true)`。
- 检查和下载错误会显示错误状态，并允许重试。
- `npm run build` 通过。

## 测试计划

- 单元/静态验证：检查 TypeScript 类型和 build。
- 主流程验证：通过 mock 或可控方式触发 updater 状态，确认 About 页面状态切换。
- 打包验证：检查 release workflow 产物中是否包含 updater metadata。
- 回归验证：确认普通 About 页面渲染、版本号显示、外部链接不受影响。
