# LongCat

| 项目 | 说明 |
| --- | --- |
| 供应商 ID | longcat |
| 官网 | https://longcat.chat |
| API Base | https://longcat.chat/api |
| 认证 | Cookie（`passport_token_key`） |
| 凭据字段 | `passport_token_key` |
| 当前状态 | 可用（需要登录网页版后复制 Cookie） |

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

请求会带上 `Cookie: passport_token_key=<value>`、`X-Client-Language` 和 `X-Requested-With` 等网页端请求头。消息会被扁平化为 `role:content;role:content` 形式，与网页端请求体一致。

## 教程

1. 打开 `https://longcat.chat` 并登录。
2. 打开 DevTools -> Application -> Cookies -> `longcat.chat`。
3. 找到 `passport_token_key`，复制其值（也可以复制完整 Cookie 字符串）。
4. 在供应商管理中添加 LongCat 账号，填入 `passport_token_key`。
5. 选择 `LongCat` 或 `LongCat-Search` 模型发起对话即可；`LongCat-Search` 会自动开启联网搜索。
