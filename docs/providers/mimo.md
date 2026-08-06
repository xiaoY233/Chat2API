# Mimo

| 项目 | 说明 |
| --- | --- |
| 供应商 ID | mimo |
| 官网 | https://aistudio.xiaomimimo.com |
| API Base | https://aistudio.xiaomimimo.com |
| 认证 | Cookie |
| 凭据字段 | `service_token`, `user_id`, `ph_token` |

## 默认模型

| 显示名称 | 实际模型 ID |
| --- | --- |
| MiMo-V2.5-Pro | mimo-v2.5-pro |
| MiMo-V2.5 | mimo-v2.5 |
| MiMo-V2-Flash | mimo-v2-flash |

## 适配状态

已适配：流式对话、非流式对话、多轮会话、会话保存、标题生成、账号级清理对话记录、托管工具调用。

后续验证：官网 Cookie 字段、会话保存接口、模型 ID 升级。

## 教程

1. 登录 `aistudio.xiaomimimo.com`。
2. 打开 DevTools -> Application -> Cookies，复制 `serviceToken`、`userId`、`xiaomichatbot_ph`。
3. 在供应商管理中添加 Mimo 账号并填写三项凭据。
4. 使用 `MiMo-V2.5-Pro` 作为首选验证模型。
