# Z.ai

| 项目 | 说明 |
| --- | --- |
| 供应商 ID | zai |
| 官网 | https://chat.z.ai |
| API Base | https://chat.z.ai/api |
| 认证 | JWT Token |
| 凭据字段 | `token`，可选 `captcha_verify_param` |
| 当前状态 | 自动完成前端验证码，可正常对话（需在桌面端运行） |

## 默认模型

| 显示名称 | 实际模型 ID |
| --- | --- |
| GLM-5.3 | glm-5.3 |
| GLM-5.3-flash | x-preview-l |
| GLM-5.2 | glm-5.2 |

## 适配状态

Z.ai 对 `/api/v2/chat/completions` 增加了阿里云 Captcha V3 校验：请求必须携带短时有效的 `captcha_verify_param`，否则返回 `FRONTEND_CAPTCHA_REQUIRED`。

当前实现会自动完成验证码：

1. 在 Electron 中打开隐藏的 `chat.z.ai` 窗口，触发页面自身的 Captcha SDK。
2. 通过 `window.z_um.getToken()` 批量采集设备令牌，缓存到用户数据目录并按有效期补充。
3. 每次对话前调用 `InitCaptchaV3`，生成阿里云验证报文并调用 `VerifyCaptchaV3`，得到 `captcha_verify_param`。
4. 如果服务端仍返回 `FRONTEND_CAPTCHA_REQUIRED`，自动换新参数重试一次。

`X-FE-Version` 会从 `chat.z.ai` 首页动态读取，读取失败时回退到 `prod-fe-1.1.128`；请求头使用 `X-Region: overseas`。设备令牌一次性使用，隐藏窗口采集失败后会进入冷却，避免频繁打开窗口。

`captcha_verify_param` 账号字段仅保留为手动覆盖/调试用途：自动生成不可用（例如无桌面环境）时，可在 HAR 中复制最新请求体的值临时填入。

## 教程

1. 登录 `chat.z.ai`。
2. 打开 DevTools -> Application -> Cookies 或请求头，复制以 `eyJ` 开头的 JWT token。
3. 在供应商管理中添加 Z.ai 账号，填入 `token`。
4. 保持应用运行在桌面环境，首次对话时隐藏验证码窗口会自动采集设备令牌。
5. 正常情况下无需填写 `captcha_verify_param`；仅在排查问题时作为手动覆盖字段使用。
