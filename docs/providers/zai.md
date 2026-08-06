# Z.ai

| 项目 | 说明 |
| --- | --- |
| 供应商 ID | zai |
| 官网 | https://chat.z.ai |
| API Base | https://chat.z.ai/api |
| 认证 | JWT Token |
| 凭据字段 | `token`，可选 `captcha_verify_param` |
| 当前状态 | 受前端验证码风控限制，暂不可用 |

## 默认模型

| 显示名称 | 实际模型 ID |
| --- | --- |
| GLM-5.1 | GLM-5.1 |
| GLM-5-Turbo | GLM-5-Turbo |
| GLM-5V-Turbo | GLM-5v-Turbo |
| GLM-5 | glm-5 |
| GLM-4.7 | glm-4.7 |

## 适配状态

暂不可用：Z.ai 当前对 `/api/v2/chat/completions` 增加了前端验证码风控校验。Web 页面可用是因为浏览器会运行阿里云 CaptchaJS、生成设备令牌并完成 VerifyCaptchaV3，再把短时有效的 `captcha_verify_param` 带入对话请求。代理侧仅携带 JWT token、Cookie、浏览器 headers 或 HAR 中复制出的旧 `captcha_verify_param`，仍可能返回 `FRONTEND_CAPTCHA_REQUIRED`。

已完成的适配尝试：流式对话、非流式对话、多轮会话、账号级清理对话记录、GLM 系列模型映射、`X-FE-Version: prod-fe-1.1.37`、`X-Region: domestic`、带浏览器环境 query 参数和 token 认证头的 `/api/v2/chat/completions` 请求。

后续方向：需要独立评估真实浏览器辅助模式，让 Z.ai Web 页面自行生成短时验证码参数；在此之前不建议把 Z.ai 作为稳定可用供应商。

## 教程

1. 登录 `chat.z.ai`。
2. 打开 DevTools -> Application -> Cookies 或请求头，复制以 `eyJ` 开头的 JWT token。
3. 在供应商管理中添加 Z.ai 账号，填入 `token`。
4. 当前对话接口受验证码风控限制，添加账号不代表可正常完成对话。
5. `captcha_verify_param` 仅保留为调试字段；该值通常短时有效，不能作为长期账号凭据使用。
