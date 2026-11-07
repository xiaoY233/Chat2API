# Qwen

| 项目 | 说明 |
| --- | --- |
| 供应商 ID | qwen |
| 官网 | https://www.qianwen.com |
| API Base | https://chat2.qianwen.com |
| 认证 | Tongyi SSO Ticket |
| 凭据字段 | `ticket` |

## 默认模型

| 显示名称 | 实际模型 ID |
| --- | --- |
| Qwen3.8 | Qwen |
| Qwen3.8-Max | Qwen3.8-Max |
| Qwen3.8-Flash | Qwen3.8-Flash |
| Qwen3.8-Omni-Flash | Qwen3.8-Omni-Flash |

## 适配状态

已适配：国内版网页对话、流式对话、非流式对话、多轮会话、账号级批量清理对话记录、文件记录清理。

说明：国内版网页的图像/视频生成走独立的 `ai_tool_scene` + `biz_data` 协议，当前尚未适配；需要图像/视频生成请使用 Qwen AI (国际版) 供应商。

后续验证：官网模型名称、批量删除会话接口、附件/文件记录清理字段。

## 教程

1. 登录 `www.qianwen.com`。
2. 打开 DevTools -> Application -> Cookies，复制 `tongyi_sso_ticket`。
3. 在供应商管理中添加 Qwen 账号，填入 `ticket`。
4. 注意本供应商 ID 是 `qwen`，不是 `qwen-ai`。
