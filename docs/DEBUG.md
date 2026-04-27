# Chat2API 调试指南

## 开启 DEBUG 模式

DEBUG 模式用于诊断运行时问题（如磁盘 I/O 过高、内存泄漏等）。开启后会激活以下功能：

- **磁盘读写监控**：每 10 秒输出各文件的写入次数、大小、速率
- **Alt+F12 开发者工具**：仅 DEBUG 模式下可用，打开 Chromium DevTools

### 方式一：命令行参数（推荐）

```bash
# Windows
Chat2API.exe --debug

# 或便携版
Chat2API-1.2.0-x64-portable.exe --debug
```

在终端/命令提示符中启动，监控日志会直接输出到控制台。

### 方式二：修改配置文件

编辑 `~/.chat2api/data.json`（Windows 路径为 `C:\Users\<用户名>\.chat2api\data.json`）：

```json
{
  "config": {
    "debugMode": true
  }
}
```

重启应用后生效。

---

## 查看监控输出

### 磁盘读写监控

开启 DEBUG 后，主进程控制台每 10 秒输出类似：

```
[DiskMonitor] 10s 统计 | 写入 23 次 | 总 5120.0KB | 平均 228217B/次 | 速率 0.49MB/s
[DiskMonitor] Top files: data.json: 18次 4608.0KB | app.log: 5次 512.0KB
```

字段说明：
- `写入 N 次`：10 秒内 writeFile 调用次数
- `总 XKB`：10 秒内写入的总字节数
- `平均 XB/次`：单次写入的平均大小
- `速率 XMB/s`：平均写入速率
- `Top files`：写入最频繁的 5 个文件及其次数/大小

### 应用日志

应用日志（业务日志）保存在：

| 平台 | 路径 |
|---|---|
| Windows | `%APPDATA%\Chat2API\logs\app.log` |
| macOS | `~/Library/Application Support/Chat2API/logs/app.log` |
| Linux | `~/.config/Chat2API/logs/app.log` |

格式为 JSON Lines，每行一条日志：

```json
{"id":"...","timestamp":1234567890,"level":"info","message":"Request succeeded","data":{"latency":234}}
```

### 数据文件

`electron-store` 持久化数据保存在：

| 平台 | 路径 |
|---|---|
| Windows | `C:\Users\<用户名>\.chat2api\data.json` |
| macOS | `~/.chat2api/data.json` |
| Linux | `~/.chat2api/data.json` |

包含 providers、accounts、config、logs、requestLogs、statistics 等全部数据。

---

## 开发者工具（DevTools）

### Alt+F12

仅在 **DEBUG 模式** 下可用。按 `Alt+F12` 会打开当前窗口的 Chromium DevTools，用于：
- 检查前端 DOM 和网络请求
- 查看 Console 中的渲染进程日志
- 调试 IPC 通信

> 生产环境（非 DEBUG）下按 Alt+F12 无任何反应。

### 开发模式自动打开

`NODE_ENV=development` 时（即 `npm run dev`），应用启动会自动打开 DevTools，不受 DEBUG 模式限制。

---

## 常见问题排查

### 磁盘占用率过高

1. 以 `--debug` 启动应用
2. 观察 `[DiskMonitor]` 输出，找到写入最频繁的文件
3. 常见根因：
   - `data.json` 频繁重写 → 通常是 `store.set()` 过于频繁（如统计更新未缓冲）
   - `app.log` 频繁重写 → 日志量过大，可调整 `logLevel` 或 `logRetentionDays`

### 日志不显示

- 检查 `config.logLevel` 是否为 `info` 或更低级别
- `debug` 级别日志仅在 `logLevel: 'debug'` 时记录
