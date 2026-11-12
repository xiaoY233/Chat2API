# Inception (Mercury)

| 项目 | 说明 |
| --- | --- |
| 供应商 ID | inception |
| 官网 | https://chat.inceptionlabs.ai/ |
| API Base | https://chat.inceptionlabs.ai |
| 认证 | 无需登录（匿名网页会话，应用自动完成 Vercel 校验） |
| 凭据字段 | `_vcrcs`（可选；留空即可，应用自行完成 Vercel 校验） |
| 当前状态 | 可用（无需账号，添加后直接使用） |

## 默认模型

| 显示名称 | 实际模型 ID | 说明 |
| --- | --- | --- |
| mercury-3 | mercury-3 | Mercury 3 扩散式对话模型，默认开启联网搜索 |

## 适配状态

Inception 的网页版 `chat.inceptionlabs.ai` 是一个匿名站点：没有账号体系，也不提供公开 API Key，直接和 Mercury 3 对话不需要注册或登录。唯一的凭证是 Vercel 边缘校验使用的 `_vcrcs` 清关 Cookie，应用会自行求解，无需用户操作：

1. 应用内置 Vercel 校验的 v2 工作量证明（PoW）求解器，无需浏览器即可获取 `_vcrcs`。
2. `GET /api/session` 拿到会话令牌 `token`（有效期约 10 分钟）。
3. `POST /api/chat` 带上 `x-session-token` 与 AI SDK `useChat` 请求体，以 Vercel AI 数据流 SSE 返回内容（`text-delta` / `reasoning-delta` / `source-url`）。
4. 流式与非流式响应都会转换为 OpenAI 兼容格式，支持 `reasoning_content` 思考内容与工具调用解析。
5. 若上游返回 429/403（清关过期），自动刷新 `_vcrcs` 并重试，最多重试 2 次。

`_vcrcs` 与浏览器 UA 绑定，有效期约 60 分钟；应用会统一使用同一个 Chrome UA，并在过期时自动重新求解，因此长期运行也无需干预。

## 使用方式

无需登录：

1. 在供应商管理中选中 Inception (Mercury)，点击添加账号。
2. `_vcrcs` 字段可以留空（应用会自行完成 Vercel 校验）；只有在你已有一枚可用的 `_vcrcs` Cookie 时，才需要手动填入。
3. 保存后即可在模型管理中选择 `mercury-3` 发起对话；如需关闭联网搜索，可传入 `web_search: false`。

手动填写 `_vcrcs`（可选）：用浏览器打开 `https://chat.inceptionlabs.ai/`，在开发者工具 -> Application -> Cookies -> `chat.inceptionlabs.ai` 中找到 `_vcrcs`，复制其值或完整 Cookie 字符串填入即可。