# 🚀 服务器一键部署与更新

> 适用于 Ubuntu / Debian 无桌面服务器。安装脚本会在 SSH 中交互输入部署端口和项目原生的 Management Secret（留空可自动生成），自动部署完整 Py 版 `/admin/` WebUI；API Key 单独生成并保存为仅 root 可读文件。更新前会备份账户、配置、凭据和运行数据。

**部署我的 Fork 版**

```bash
bash <(curl -fsSL https://raw.githubusercontent.com/qingan123/Chat2API/main/scripts/install-fork.sh)
```

**部署 Py 上游对照版**

```bash
bash <(curl -fsSL https://raw.githubusercontent.com/qingan123/Chat2API/main/scripts/install-official.sh)
```

**更新已部署实例（自动发现 Fork版与 Py 上游版多实例）**

```bash
bash <(curl -fsSL https://raw.githubusercontent.com/qingan123/Chat2API/main/scripts/update.sh)
```

默认目录：Fork版 `/opt/chat2api-<端口>`，Py 上游版 `/opt/chat2api-py-upstream-<端口>`。后台地址为 `http://公网IP:<端口>/admin/`，OpenAI Base URL 为 `http://公网IP:<端口>/v1`。部署成功不等于云安全组、防火墙、NAT 或反向代理已经放行端口。

后续对比 `pyf-feifei/Chat2API` 与官方 `xiaoY233/Chat2API`、同步上游、解决冲突、测试和回滚，请阅读 [`docs/MAINTENANCE_CN.md`](docs/MAINTENANCE_CN.md)。

---

# Chat2API

<p align="center">
  <img src="build/icons.png" alt="Chat2API Logo" width="128" height="128">
</p>

<p align="center">
  <a href="https://github.com/pyf-feifei/Chat2API/releases"><img src="https://img.shields.io/badge/version-1.4.0-2563eb?style=flat-square" alt="版本 1.4.0"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-GPL--3.0-2563eb?style=flat-square" alt="GPL-3.0 许可证"></a>
  <a href="https://www.electronjs.org/"><img src="https://img.shields.io/badge/Electron-33%2B-47848F?style=flat-square&logo=electron&logoColor=white" alt="Electron 33+"></a>
  <a href="https://react.dev/"><img src="https://img.shields.io/badge/React-18-61DAFB?style=flat-square&logo=react&logoColor=black" alt="React 18"></a>
  <a href="https://www.typescriptlang.org/"><img src="https://img.shields.io/badge/TypeScript-5-3178C6?style=flat-square&logo=typescript&logoColor=white" alt="TypeScript 5"></a>
  <img src="https://img.shields.io/badge/platform-macOS%20%7C%20Windows%20%7C%20Linux-lightgrey?style=flat-square" alt="macOS、Windows 和 Linux">
</p>

<p align="center">
  <strong><a href="README.md">English</a> | <a href="https://chat2api-doc.vercel.app/">官网</a> | <a href="https://chat2api-doc.vercel.app/docs">文档</a></strong>
</p>

Chat2API 是一个跨平台桌面应用和无 Electron 服务端。它将基于 Web 的 AI 服务商账户统一接入本地 OpenAI 兼容网关，配置一次后即可连接 OpenAI SDK、编程代理、桌面客户端和内部工具。

![Chat2API 仪表盘](docs/screenshots/preview.png)

## 主要功能

- **OpenAI 兼容网关**：提供 `/v1/chat/completions`、`/v1/responses`、旧版 `/v1/completions`、模型列表、SSE 流式输出、API Key 认证和多模态消息处理；同时在 `/v1beta` 下提供 Gemini 兼容的生成和文件接口。
- **服务商与账户管理**：支持一个服务商配置多个账户，验证凭证、映射客户端模型名、固定首选服务商或账户，并按轮询、填充优先或故障转移策略路由。
- **工具调用与推理兼容**：在上游支持的范围内统一函数/自定义工具调用、工具结果续接、推理内容、联网搜索、深度研究和服务商专属思考模式。
- **长请求控制**：提供上下文压缩、请求和流式超时、队列准入、连接保活、有限重试，以及 Qwen 会话和响应恢复。
- **桌面与服务端部署**：在 macOS、Windows、Linux 上使用 Electron 界面，也可以在 Docker 中运行 Koa 代理和浏览器管理端。
- **运维界面**：仪表盘统计、请求日志、模型同步、API Key、代理设置、主题、系统托盘，以及中英文界面。
- **客户端桥接**：支持 [Codex CLI Responses 接口](docs/codex.md)，并可通过 [LiteLLM 部署 Anthropic 兼容接口](docs/litellm.md)。

## 支持的服务商

当前内置服务商及模型如下：

| 服务商 | 认证方式 | 内置模型 |
| --- | --- | --- |
| DeepSeek | User Token | `deepseek-v4-flash`、`deepseek-v4-pro` |
| GLM | Refresh Token | `GLM-5.1` |
| Kimi | JWT / Web Token | `Kimi-K2.6`、`Kimi-K3` |
| MiniMax | JWT | `MiniMax-M2.7` |
| Mimo | 浏览器 Cookie | `MiMo-V2.5-Pro`、`MiMo-V2.5`、`MiMo-V2-Flash` |
| Perplexity | Session Cookie | `Auto` |
| Qwen（国内版） | SSO Ticket | `Qwen3.6`、`Qwen3.7-Max`、`Qwen3.5-Flash`、`Qwen3-Max`、`Qwen3-Max-Thinking-Preview`、`Qwen3-Coder` |
| Qwen AI（国际版） | JWT，可选 Cookie 和登录凭证 | `Qwen3.8-Max`、`Qwen3.8-Max_Fast`、`Qwen3.8-Max_Auto`、`Qwen3.8-Max_Thinking`、`Qwen3.7-Plus`、`Qwen3.7-Max` |
| Z.ai | JWT | `GLM-5.1`、`GLM-5-Turbo`、`GLM-5V-Turbo`、`GLM-5`、`GLM-4.7` |

服务商可用性和模型名称由上游 Web 应用决定，可能随时变化。凭证获取、适配差异和模型映射请查看[服务商说明](docs/providers/README.md)。

## 安装

### 下载桌面版本

有可用发行版时，请从 [GitHub Releases](https://github.com/xiaoY233/Chat2API/releases) 下载。源码镜像位于 [pyf-feifei/Chat2API](https://github.com/pyf-feifei/Chat2API)：

| 平台 | 安装包 |
| --- | --- |
| macOS Apple Silicon | `Chat2API-<version>-mac-arm64.dmg` |
| macOS Intel | `Chat2API-<version>-mac-x64.dmg` |
| Windows | `Chat2API-<version>-x64-setup.exe` 或便携版 |
| Linux | `Chat2API-<version>-x64.AppImage`、`.deb` 或 `.tar.gz` |

### 从源码运行

环境要求：Node.js 18+、npm 和 Git。Docker 镜像使用 Node.js 22。

```bash
git clone https://github.com/pyf-feifei/Chat2API.git
cd Chat2API
npm install
npm run dev:win       # Windows
npm run dev           # macOS/Linux
```

构建生产版本：

```bash
npm run build
npm run build:mac
npm run build:win
npm run build:linux
npm run build:all
```

### Docker 服务端

Docker 镜像运行 Koa 代理和浏览器管理端，数据保存在 `/data`，默认监听 `8080`：

```bash
docker build -t chat2api:server .
docker run -d --name chat2api \
  -p 8080:8080 \
  -v chat2api-data:/data \
  -e CHAT2API_HOST=0.0.0.0 \
  -e CHAT2API_PORT=8080 \
  -e CHAT2API_ENABLE_MANAGEMENT_API=true \
  -e CHAT2API_MANAGEMENT_SECRET=change-me \
  chat2api:server
```

打开 `http://localhost:8080/admin/`，使用管理密钥登录。完整的 [Docker 部署指南](docs/docker.md) 介绍了 Compose、浏览器辅助导入账户、存储加密、Qwen 会话修复和运行参数调优。

## 快速开始

1. 启动 Chat2API，或启动 Docker 服务端。
2. 打开**服务商**页面，添加内置服务商并填写其 Web 凭证。凭证保存在本地，请勿提交到代码仓库。
3. 打开**代理设置**，选择端口和路由策略，然后启动代理。
4. 将 OpenAI 兼容客户端的地址设为 `http://127.0.0.1:8080/v1`。

Python OpenAI SDK 示例：

```python
from openai import OpenAI

client = OpenAI(
    api_key="your-chat2api-key",
    base_url="http://127.0.0.1:8080/v1",
)

response = client.chat.completions.create(
    model="deepseek-v4-flash",
    messages=[{"role": "user", "content": "你好，Chat2API！"}],
)

print(response.choices[0].message.content)
```

Codex CLI 请使用 Responses 接口并参考 [docs/codex.md](docs/codex.md)；Claude 或其他 Anthropic 客户端请参考 [LiteLLM 指南](docs/litellm.md)。

## 截图

| 仪表盘 | 服务商 |
| --- | --- |
| ![仪表盘](docs/screenshots/dashboard.png) | ![服务商](docs/screenshots/providers.png) |

| 代理设置 | API Key |
| --- | --- |
| ![代理设置](docs/screenshots/proxy.png) | ![API Key](docs/screenshots/api-keys.png) |

| 模型管理 | 会话管理 |
| --- | --- |
| ![模型管理](docs/screenshots/models.png) | ![会话管理](docs/screenshots/Session.png) |

## 配置与数据

桌面版数据保存在 `~/.chat2api/`，Docker 版数据保存在挂载的 `/data` 卷中。

| 路径 | 内容 |
| --- | --- |
| `config.json` | 代理、界面和应用设置 |
| `providers.json` | 服务商定义和模型映射 |
| `accounts.json` | 账户凭证和状态 |
| `logs/` | 请求日志 |

服务端支持主机/端口、管理 API、API Key、存储加密、负载均衡、请求超时和服务商专属参数。可从 [docs/docker.md](docs/docker.md) 中的示例开始配置。

## 参与贡献

欢迎提交 Issue、服务商适配、测试和文档改进。进行较大的适配器改动前，请先阅读现有服务商说明并创建 Issue 讨论。

```bash
npm install
npm run build
npm run test:server-compat
```

## 许可证

Chat2API 使用 [GNU General Public License v3.0](LICENSE) 发布。

## 致谢

[Electron](https://www.electronjs.org/)、[React](https://react.dev/)、[TypeScript](https://www.typescriptlang.org/)、[Tailwind CSS](https://tailwindcss.com/)、[Zustand](https://zustand-demo.pmnd.rs/) 和 [Koa](https://koajs.com/)。
