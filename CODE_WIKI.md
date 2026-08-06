# Chat2API 项目代码文档

## 1. 项目概述

Chat2API 是一个多平台 AI 服务统一管理工具，通过利用官方 Web UI 实现零成本访问领先的 AI 模型。它支持 DeepSeek、GLM、Kimi、MiniMax、Qwen、Z.ai 等提供商，并与 openlcaw、Cline、Roo-Code 等工具无缝集成，使任何 OpenAI 兼容客户端都能开箱即用。

### 核心功能
- OpenAI 兼容 API：提供标准的 OpenAI 兼容 API 端点，实现无缝集成
- 多提供商支持：连接 DeepSeek、GLM、Kimi、MiniMax、Perplexity、Qwen、Z.ai 等
- 上下文管理：智能对话上下文管理，支持滑动窗口、令牌限制和摘要策略
- 函数调用支持：通过提示工程实现所有模型的通用工具调用能力，兼容 Cherry Studio、Kilo Code 等客户端
- 模型映射：灵活的模型名称映射，支持通配符和首选提供商/账户选择
- 自定义参数：支持自定义 HTTP 头，启用网络搜索、思考模式和深度研究功能
- 仪表板监控：实时请求流量、令牌使用和成功率
- API 密钥管理：为本地代理生成和管理密钥
- 模型管理：查看和管理所有提供商的可用模型
- 请求日志：详细的请求日志，用于调试和分析
- 代理配置：灵活的代理设置和路由策略
- 系统托盘集成：从菜单栏快速访问状态
- 多语言支持：英语和简体中文支持
- 现代 UI：清洁、响应式界面，支持明暗主题

## 2. 项目架构

Chat2API 采用 Electron 架构，分为主进程和渲染进程两部分。主进程负责核心功能实现，包括代理服务器、账户管理、模型管理等；渲染进程负责用户界面展示。

### 架构图

```
Chat2API/
├── src/
│   ├── main/                    # Electron 主进程
│   │   ├── index.ts            # 应用入口点
│   │   ├── tray.ts             # 系统托盘集成
│   │   ├── proxy/              # 代理服务器管理
│   │   ├── ipc/                # IPC 处理器
│   │   ├── store/              # 数据存储
│   │   ├── oauth/              # OAuth 认证
│   │   ├── providers/          # 提供商管理
│   │   └── utils/              # 工具函数
│   ├── preload/                # 上下文桥接
│   └── renderer/               # React 前端
│       ├── components/         # UI 组件
│       ├── pages/              # 页面组件
│       ├── stores/             # Zustand 状态管理
│       └── hooks/              # 自定义钩子
├── build/                      # 构建资源
└── scripts/                    # 构建脚本
```

## 3. 主要模块职责

### 3.1 主进程 (Main Process)

#### 3.1.1 应用核心 (src/main/index.ts)
- 应用启动和初始化
- 窗口管理
- 系统托盘集成
- 异常处理

#### 3.1.2 代理服务 (src/main/proxy/)
- 提供 OpenAI 兼容的 API 端点
- 管理请求路由和转发
- 实现负载均衡策略
- 模型映射和转换
- 会话管理

#### 3.1.3 数据存储 (src/main/store/)
- 管理应用配置
- 存储提供商和账户信息
- 日志管理

#### 3.1.4 OAuth 认证 (src/main/oauth/)
- 处理不同提供商的认证流程
- 令牌提取和管理

#### 3.1.5 提供商管理 (src/main/providers/)
- 内置提供商支持
- 自定义提供商配置
- 提供商状态检查

### 3.2 渲染进程 (Renderer Process)

#### 3.2.1 界面组件 (src/renderer/src/components/)
- 仪表板组件
- 提供商管理组件
- 代理设置组件
- 模型管理组件
- 日志查看组件

#### 3.2.2 页面 (src/renderer/src/pages/)
- 仪表板页面
- 提供商页面
- 代理设置页面
- 模型页面
- API 密钥页面
- 日志页面
- 设置页面

#### 3.2.3 状态管理 (src/renderer/src/stores/)
- 仪表板状态
- 提供商状态
- 代理状态
- 日志状态
- 设置状态

## 4. 关键类与函数

### 4.1 主进程核心类

#### 4.1.1 ProxyServer (src/main/proxy/server.ts)
- **职责**：实现基于 Koa 的代理服务器
- **主要方法**：
  - `start(port, host)`：启动代理服务器
  - `stop()`：停止代理服务器
  - `restart(port, host)`：重启代理服务器
  - `isRunning()`：检查服务器是否运行
  - `getStatistics()`：获取服务器统计信息

#### 4.1.2 LoadBalancer (src/main/proxy/loadbalancer.ts)
- **职责**：实现负载均衡策略
- **主要方法**：
  - `selectAccount(model, strategy, preferredProviderId, preferredAccountId)`：选择合适的账户
  - `markAccountFailed(accountId)`：标记账户失败
  - `clearAccountFailure(accountId)`：清除账户失败状态
  - `getAvailableAccounts(model, preferredProviderId, excludeFailed)`：获取可用账户列表

#### 4.1.3 ModelMapper (src/main/proxy/modelMapper.ts)
- **职责**：支持请求模型到实际模型的映射
- **主要方法**：
  - `mapModel(requestedModel, provider)`：映射模型名称
  - `getActualModel(requestedModel, providerId)`：获取实际模型名称
  - `getPreferredProvider(requestedModel)`：获取首选提供商
  - `addMapping(requestModel, actualModel, preferredProviderId, preferredAccountId)`：添加模型映射

#### 4.1.4 StoreManager (src/main/store/store.ts)
- **职责**：管理应用数据存储
- **主要方法**：
  - `getConfig()`：获取应用配置
  - `updateConfig(config)`：更新应用配置
  - `getProviders()`：获取提供商列表
  - `getAccountsByProviderId(providerId, activeOnly)`：获取指定提供商的账户
  - `addLog(level, message, data)`：添加日志

### 4.2 渲染进程核心组件

#### 4.2.1 Dashboard (src/renderer/src/pages/Dashboard.tsx)
- **职责**：展示应用仪表板，包括请求统计、提供商状态等

#### 4.2.2 Providers (src/renderer/src/pages/Providers.tsx)
- **职责**：管理 AI 服务提供商和账户

#### 4.2.3 ProxySettings (src/renderer/src/pages/ProxySettings.tsx)
- **职责**：配置代理服务器设置，包括端口、负载均衡策略等

#### 4.2.4 Models (src/renderer/src/pages/Models.tsx)
- **职责**：管理和查看可用的 AI 模型

#### 4.2.5 ApiKeys (src/renderer/src/pages/ApiKeys.tsx)
- **职责**：管理 API 密钥

## 5. 依赖关系

### 5.1 核心依赖

| 依赖 | 版本 | 用途 |
|------|------|------|
| Electron | 33+ | 跨平台桌面应用框架 |
| React | 18+ | UI 框架 |
| TypeScript | 5+ | 类型安全的 JavaScript |
| Koa | 2.15+ | HTTP 服务器 |
| Zustand | 5+ | 状态管理 |
| Tailwind CSS | 3.4+ | CSS 框架 |
| Axios | 1.7+ | HTTP 客户端 |
| electron-store | 10+ | 数据存储 |
| eventsource-parser | 3+ | 处理 Server-Sent Events |
| i18next | 25+ | 国际化 |

### 5.2 开发依赖

| 依赖 | 版本 | 用途 |
|------|------|------|
| electron-vite | 2.3+ | 构建工具 |
| vite | 5.4+ | 前端构建工具 |
| typescript | 5.6+ | 类型检查 |
| tailwindcss | 3.4+ | CSS 框架 |
| electron-builder | 25.1+ | 应用打包 |

## 6. 项目运行方式

### 6.1 开发环境

#### 6.1.1 安装依赖
```bash
npm install
```

#### 6.1.2 启动开发服务器
```bash
# Linux/macOS
npm run dev

# Windows
npm run dev:win
```

### 6.2 生产构建

#### 6.2.1 构建应用
```bash
npm run build              # 构建应用
npm run build:mac          # 构建 macOS 版本
npm run build:win          # 构建 Windows 版本
npm run build:linux        # 构建 Linux 版本
npm run build:all          # 构建所有平台版本
```

### 6.3 运行应用

#### 6.3.1 启动应用
```bash
# 预览构建版本
npm start

# 无沙箱模式启动
npm run start:sandbox
```

## 7. 配置与部署

### 7.1 配置文件

应用数据存储在 `~/.chat2api/` 目录：
- `config.json` - 应用配置
- `providers.json` - 提供商设置
- `accounts.json` - 账户凭证（加密）
- `logs/` - 请求日志

### 7.2 代理配置

- **端口**：默认 8080，可在设置中修改
- **路由策略**：轮询（Round Robin）、填充优先（Fill First）、故障转移（Failover）
- **API 密钥**：可在设置中启用 API 密钥认证

### 7.3 提供商配置

支持的提供商：
- DeepSeek
- GLM
- Kimi
- MiniMax
- Perplexity
- Qwen (CN)
- Qwen AI (Global)
- Z.ai

每个提供商需要配置相应的认证信息，如令牌或凭证。

## 8. 开发指南

### 8.1 代码结构

- **主进程**：`src/main/` 目录，包含核心功能实现
- **渲染进程**：`src/renderer/src/` 目录，包含 UI 组件和页面
- **共享代码**：`src/shared/` 目录，包含主进程和渲染进程共享的代码

### 8.2 扩展提供商

要添加新的提供商支持，需要：
1. 在 `src/main/providers/builtin/` 目录添加提供商实现
2. 在 `src/main/oauth/adapters/` 目录添加 OAuth 适配器
3. 在 `src/main/proxy/adapters/` 目录添加代理适配器
4. 在渲染进程中添加提供商图标和配置界面

### 8.3 调试技巧

- 使用 `npm run dev` 启动开发模式，支持热重载
- 主进程日志可在终端查看
- 渲染进程可使用 Chrome 开发者工具调试（在开发模式下自动打开）

## 9. 常见问题

### 9.1 macOS："App is damaged and can't be opened"

由于 macOS 安全机制，从 App Store 外下载的应用可能会触发此警告。运行以下命令修复：

```bash
sudo xattr -rd com.apple.quarantine "/Applications/Chat2API.app"
```

### 9.2 端口被占用

如果默认端口 8080 被占用，可在设置中修改代理端口。

### 9.3 提供商认证失败

- 检查令牌是否有效
- 确保网络连接正常
- 查看应用日志获取详细错误信息

## 10. 技术栈

| 组件 | 技术 |
|------|------|
| 框架 | Electron 33+ |
| 前端 | React 18 + TypeScript |
| 样式 | Tailwind CSS |
| 状态管理 | Zustand |
| 构建工具 | Vite + electron-vite |
| 打包工具 | electron-builder |
| 服务器 | Koa |

## 11. 许可证

GNU General Public License v3.0。详见 [LICENSE](LICENSE) 文件。

## 12. 贡献指南

1. Fork 项目
2. 创建功能分支 (`git checkout -b feature/amazing-feature`)
3. 提交更改 (`git commit -m 'Add amazing feature'`)
4. 推送到分支 (`git push origin feature/amazing-feature`)
5. 打开 Pull Request

## 13. 更新日志

### v1.2.0
- Implemented automatic application update feature
- Added real-time download progress tracking
- Added one-click install and restart functionality
- Improved error handling and user experience
- Added multi-language support for update UI

### v1.1.4
- 新增 Perplexity 提供商支持
- 改进上下文管理功能
- 优化模型映射逻辑
- 修复已知 bug

### v1.1.3
- 新增函数调用支持
- 改进代理服务器性能
- 优化 UI 界面

### v1.1.2
- 新增 Qwen AI (Global) 支持
- 改进 OAuth 认证流程
- 修复稳定性问题

### v1.1.1
- 新增系统托盘集成
- 改进日志系统
- 修复 minor bug

### v1.1.0
- 初始版本发布
- 支持多个 AI 提供商
- 提供 OpenAI 兼容 API
- 实现基本的代理功能