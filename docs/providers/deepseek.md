# DeepSeek

| 项目 | 说明 |
| --- | --- |
| 供应商 ID | deepseek |
| 官网 | https://chat.deepseek.com |
| API Base | https://chat.deepseek.com/api |
| 认证 | User Token |
| 凭据字段 | `token` |

## 默认模型

| 显示名称 | 实际模型 ID |
| --- | --- |
| deepseek-v4-flash | deepseek-v4-flash |
| deepseek-v4-pro | deepseek-v4-pro |

## 适配状态

已适配：流式对话、非流式对话、多轮会话、账号级清理对话记录、Web 搜索/思考模式别名、托管工具调用提示注入。

后续验证：官网请求头版本、搜索和思考参数、会话删除接口在官网升级后的兼容性。

## 教程

1. 登录 `chat.deepseek.com`。
2. 打开 DevTools -> Application -> Local Storage，复制用户 token。
3. 在 Chat2API Manager 的供应商管理中添加 DeepSeek 账号，填入 `token`。
4. 在模型管理中保留默认模型；如需搜索/思考别名，使用全局模型映射指向默认模型。
