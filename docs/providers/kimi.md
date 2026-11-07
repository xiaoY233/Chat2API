# Kimi

| 项目 | 说明 |
| --- | --- |
| 供应商 ID | kimi |
| 官网 | https://www.kimi.com |
| API Base | https://www.kimi.com |
| 认证 | JWT Token |
| 凭据字段 | `token` |

## 默认模型

| 显示名称 | 实际模型 ID |
| --- | --- |
| Kimi-K2.6 | kimi-k2.6 |

## 适配状态

已适配：Connect JSON 对话接口、流式对话、非流式对话、多轮会话、账号级批量清理对话记录、联网搜索和思考参数。

K2.6 使用 `SCENARIO_K2D6`，其余模型回落到 `SCENARIO_CHAT`（`k2d6-chat`）。

后续验证：官网 `ChatService` 协议字段、批量删除接口的返回格式。

## 教程

1. 登录 `www.kimi.com`。
2. 打开 DevTools -> Application -> Cookies，复制 `kimi-auth` 值，或复制可用 JWT/refresh token。
3. 在供应商管理中添加 Kimi 账号，填入 `token`。
4. 默认模型为 `Kimi-K2.6`；旧的 `Kimi-K2.5` 不再作为内置默认模型。
