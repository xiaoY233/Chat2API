# GLM

| 项目 | 说明 |
| --- | --- |
| 供应商 ID | glm |
| 官网 | https://chatglm.cn |
| API Base | https://chatglm.cn/api |
| 认证 | Refresh Token |
| 凭据字段 | `refresh_token` |

## 默认模型

| 显示名称 | 实际模型 ID |
| --- | --- |
| GLM-5.1 | glm-5.1 |

## 适配状态

已适配：流式对话、非流式对话、多轮会话、账号级清理对话记录、刷新 token 校验、思考内容输出。

后续验证：官网模型切换参数、视频/多模态能力、清理对话记录接口字段变化。

## 教程

1. 登录 `chatglm.cn`。
2. 打开 DevTools -> Application -> Local Storage，复制 `chatglm_refresh_token`。
3. 在供应商管理中添加 GLM 账号，填入 `refresh_token`。
4. 使用默认模型 `GLM-5.1` 验证流式和非流式请求。
