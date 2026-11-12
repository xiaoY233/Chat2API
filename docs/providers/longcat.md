# LongCat

| 项目 | 说明 |
| --- | --- |
| 供应商 ID | longcat |
| 官网 | https://longcat.ai/chat |
| API Base | https://longcat.ai/api |
| 认证 | 网页会话 Cookie（`passport_token_key` + 可选 `_lxsdk_*`） |
| 凭据字段 | `passport_token_key`（可填 Cookie 值或完整 Cookie 字符串） |
| 当前状态 | 可用（OAuth 登录自动获取，或手动复制 Cookie） |

## 默认模型

| 显示名称 | 实际模型 ID | 说明 |
| --- | --- | --- |
| LongCat | LongCat | 标准对话 |
| LongCat-Search | LongCat-Search | 开启联网搜索 |

## 适配状态

长猫（美团 LongCat）网页版不提供公开 API Key，本适配直接复用网页登录态：

1. `POST /api/v1/session-create` 创建会话，取得 `conversationId`。
2. `POST /api/v1/chat-completion` 以 SSE 流式返回对话内容；若该接口不可用（404/405），自动回退到 `/api/v1/chat-completion-V2` 的 AG-UI 事件格式。
3. 流式与非流式响应都会转换为 OpenAI 兼容格式，并支持 `reasoning_content` 思考内容与工具调用解析。
4. 启用“清理对话记录”时，请求结束后调用 `GET /api/v1/session-delete?conversationId=...` 删除会话。

请求会带上完整的 `Cookie`（`passport_token_key`，以及登录时一并获取的 `_lxsdk_cuid` / `_lxsdk_s` 等）、`X-Client-Language` 和 `X-Requested-With` 等网页端请求头。消息会被扁平化为 `role:content;role:content` 形式，与网页端请求体一致。

## 登录方式

### 方式一：OAuth 登录（推荐）

1. 在供应商管理中选择 LongCat，点击添加账号。
2. 切换到 **OAuth 登录** 标签页，点击打开登录窗口。
3. 在应用内窗口打开 `https://longcat.ai/chat`，按网页提示登录（国内手机号走 `passport.meituan.com`，海外邮箱走 `passport.mykeeta.com`）。
4. 登录完成后，应用会调用 `/api/v1/user-current` 确认会话，并自动保存 `longcat.ai` 域下的完整 Cookie。

### 方式二：手动填写 Cookie

1. 打开 `https://longcat.ai/chat` 并登录。
2. 打开 DevTools -> Application -> Cookies -> `longcat.ai`。
3. 找到 `passport_token_key`，复制其值（也可以复制完整 Cookie 字符串）。
4. 在供应商管理中添加 LongCat 账号，填入 `passport_token_key`。

选择 `LongCat` 或 `LongCat-Search` 模型发起对话即可；`LongCat-Search` 会自动开启联网搜索。
