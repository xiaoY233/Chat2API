# Inception (Mercury)

| 项目 | 说明 |
| --- | --- |
| 供应商 ID | inception |
| 官网 | https://chat.inceptionlabs.ai/ |
| API Base | https://chat.inceptionlabs.ai |
| 认证 | 匿名网页会话（Vercel 清关 Cookie `_vcrcs`） |
| 凭据字段 | `_vcrcs`（可选；留空由应用自行完成 Vercel 校验） |
| 当前状态 | 可用（OAuth 登录自动获取，或应用自行求解） |

## 默认模型

| 显示名称 | 实际模型 ID | 说明 |
| --- | --- | --- |
| mercury-3 | mercury-3 | Mercury 3 扩散式对话模型，默认开启联网搜索 |

## 适配状态

Inception 的网页版 `chat.inceptionlabs.ai` 是一个匿名站点：没有账号体系，也不提供公开 API Key，唯一的凭证是 Vercel 边缘校验使用的 `_vcrcs` 清关 Cookie。因此本适配直接复用网页会话，并在需要时自行求解校验：

1. 应用会内置 Vercel 校验的 v2 工作量证明（PoW）求解器，无需浏览器即可获取 `_vcrcs`。
2. `GET /api/session` 拿到会话令牌 `token`（有效期约 10 分钟）。
3. `POST /api/chat` 带上 `x-session-token` 与 AI SDK `useChat` 请求体，以 Vercel AI 数据流 SSE 返回内容（`text-delta` / `reasoning-delta` / `source-url`）。
4. 流式与非流式响应都会转换为 OpenAI 兼容格式，支持 `reasoning_content` 思考内容与工具调用解析。
5. 若上游返回 429/403（清关过期），自动刷新 `_vcrcs` 并重试，最多重试 2 次。

`_vcrcs` 与浏览器 UA 绑定，有效期约 60 分钟；应用会统一使用同一个 Chrome UA，并在过期时自动重新求解。

## 登录方式

### 方式一：OAuth 登录（推荐）

1. 在供应商管理中选择 Inception (Mercury)，点击添加账号。
2. 切换到 **OAuth 登录** 标签页，点击打开登录窗口。
3. 应用内窗口会打开 `https://chat.inceptionlabs.ai/`，由 Chromium 完成 Vercel 校验。
4. 校验通过后，应用会调用 `/api/session` 确认会话，并自动保存 `chat.inceptionlabs.ai` 域下的 Cookie（含 `_vcrcs`）。

### 方式二：应用自动求解（无需登录窗口）

即使不填任何凭据，应用也会自行完成 Vercel 校验并创建会话，可直接添加账号使用。

### 方式三：手动填写 Cookie

1. 用浏览器打开 `https://chat.inceptionlabs.ai/`。
2. 打开 DevTools -> Application -> Cookies -> `chat.inceptionlabs.ai`。
3. 找到 `_vcrcs`，复制其值（也可以复制完整 Cookie 字符串）。
4. 在供应商管理中添加 Inception 账号，填入 `_vcrcs`。

选择 `mercury-3` 模型发起对话即可；如需关闭联网搜索，可传入 `web_search: false`。