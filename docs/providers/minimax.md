# MiniMax

| 项目 | 说明 |
| --- | --- |
| 供应商 ID | minimax |
| 官网 | https://agent.minimaxi.com |
| API Base | https://agent.minimaxi.com |
| 认证 | JWT Token |
| 凭据字段 | `token`, `realUserID` |

## 默认模型

| 显示名称 | 实际模型 ID |
| --- | --- |
| MiniMax-M2.7 | MiniMax-M2.7 |

## 适配状态

已适配：流式对话、非流式对话、多轮会话、账号级清理对话记录、`realUserID+JWTtoken` 组合凭据。

后续验证：官网模型名称升级、MCP/多智能体字段、历史会话删除接口分页。

## 教程

1. 登录 `agent.minimaxi.com`。
2. 从浏览器请求或本地存储中复制 JWT token；如有 `realUserID`，可单独填入。
3. 在供应商管理中添加 MiniMax 账号。
4. 默认模型仅保留 `MiniMax-M2.7`；旧的 `MiniMax-M2.5` 不再作为内置默认模型。
