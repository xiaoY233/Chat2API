# Qwen AI

| 项目 | 说明 |
| --- | --- |
| 供应商 ID | qwen-ai |
| 官网 | https://chat.qwen.ai |
| API Base | https://chat.qwen.ai |
| 认证 | JWT Token |
| 凭据字段 | `token`, `cookies` |

## 默认模型

内置默认模型使用当前 Qwen AI 官方模型清单。`Qwen3.8-Max` 会映射到 `qwen3.8-max`，默认使用 Thinking 模式：`thinking_enabled: true`、`auto_thinking: false`；Preview 模型仅在客户端明确选择对应名称时使用。

| 显示名称 | 实际模型 ID |
| --- | --- |
| Qwen3.8-Max | qwen3.8-max |
| Qwen3.8-Max_Fast | qwen3.8-max |
| Qwen3.8-Max_Auto | qwen3.8-max |
| Qwen3.8-Max_Thinking | qwen3.8-max |
| Qwen3.7-Plus | qwen3.7-plus |
| Qwen3.7-Max | qwen3.7-max |

`Qwen3.8-Max` 模式名称会优先于客户端传入的 `reasoning_effort` / `enable_thinking`：

| 模型名 | thinking_enabled | auto_thinking |
| --- | --- | --- |
| Qwen3.8-Max | true | false |
| Qwen3.8-Max_Fast | false | false |
| Qwen3.8-Max_Auto | true | true |
| Qwen3.8-Max_Thinking | true | false |

也支持原始控制形式 `Qwen3.8-Max_TeT_AtT`。`Te` 后的 `T` / `F` 控制 `thinking_enabled`，`At` 后的 `T` / `F` 控制 `auto_thinking`，例如 `Qwen3.8-Max_TeF_AtT` 会发送 `false / true`。旧的 `-fast` 和 `-thinking` 后缀仍可使用。

## 其他官网模型

以下模型来自 `backup/har/chat.qwen.ai2.har` 中实际调用对话的官网模型。它们不作为内置默认模型，用户可在供应商管理 -> 模型管理中自行添加：显示名称填左列，实际模型 ID 填右列。

| 显示名称 | 实际模型 ID | 备注 |
| --- | --- | --- |
| Qwen3.7-Max-Preview | qwen-latest-series-invite-beta-v24 | Preview |
| Qwen3.7-Plus-Preview | qwen-latest-series-invite-beta-v16 | Preview |
| Qwen3.6-Max-Preview | qwen3.6-max-preview | Preview |
| Qwen3.6-Plus-Preview | qwen3.6-plus-preview | Preview |
| Qwen3.5-Plus | qwen3.5-plus | 低版本 |
| Qwen3.5-Omni-Plus | qwen3.5-omni-plus | 低版本 |
| Qwen3.5-Flash | qwen3.5-flash | 低版本 |
| Qwen3.5-Max-Preview | qwen3.5-max-2026-03-08 | 低版本 Preview |
| Qwen3.5-397B-A17B | qwen3.5-397b-a17b | 低版本 |
| Qwen3.5-122B-A10B | qwen3.5-122b-a10b | 低版本 |
| Qwen3.5-Omni-Flash | qwen3.5-omni-flash | 低版本 |
| Qwen3.5-27B | qwen3.5-27b | 低版本 |
| Qwen3.5-35B-A3B | qwen3.5-35b-a3b | 低版本 |
| Qwen3-Max | qwen3-max-2026-01-23 | 普通 Qwen3 |
| Qwen3-235B-A22B-2507 / Qwen2.5-Plus | qwen-plus-2025-07-28 | HAR 页面标签存在歧义 |
| Qwen3-VL-235B-A22B | qwen3-vl-plus | 多模态 |
| Qwen3-Omni-Flash | qwen3-omni-flash-2025-12-01 | Omni |
| Qwen2.5-Max | qwen-max-latest | 低版本 |

## 适配状态

已适配：国际版网页对话、流式对话、非流式对话、多轮会话、账号级清理对话记录、思考模式后缀、模型别名。

后续验证：官网反爬请求头、模型接口版本、Preview 邀请模型是否仍可用、图片/多模态模型字段。

## 教程

1. 登录 `chat.qwen.ai`。
2. 打开 DevTools -> Application -> Local Storage，复制 `token`；如请求需要 Cookie，同时复制完整 Cookie 字符串。
3. 在供应商管理中添加 Qwen AI 账号，填入 `token`，可选填 `cookies`。
4. 在模型管理中使用默认模型；如需上表其他模型，手动添加显示名称和实际模型 ID。
