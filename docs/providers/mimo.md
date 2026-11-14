# Mimo

| 项目 | 说明 |
| --- | --- |
| 供应商 ID | mimo |
| 官网 | https://aistudio.xiaomimimo.com |
| API Base | https://aistudio.xiaomimimo.com |
| 认证 | Cookie（对话）/ API Key（TTS） |
| 凭据字段 | `service_token`, `user_id`, `ph_token`，可选 `api_key` |

## 默认模型

| 显示名称 | 实际模型 ID |
| --- | --- |
| MiMo-V2.6-Pro | mimo-v2.6-pro |
| MiMo-V2.6-Flash | mimo-v2.6-flash |
| MiMo-V2.5-TTS | mimo-v2.5-tts |
| MiMo-V2.5-TTS-VoiceDesign | mimo-v2.5-tts-voicedesign |
| MiMo-V2.5-TTS-VoiceClone | mimo-v2.5-tts-voiceclone |

TTS 模型 ID 来自小米 MiMo 官方文档的 MiMo-V2.5-TTS 系列说明。

## 适配状态

已适配：流式对话、非流式对话、多轮会话、会话保存、标题生成、账号级清理对话记录、托管工具调用。

说明：对话模型使用网页 Cookie 调用 `aistudio.xiaomimimo.com/open-apis/bot/chat`。MiMo-V2.5-TTS 系列不在网页对话接口中提供，需在账号中额外填写 `api_key`，代理会改用官方 OpenAI 兼容接口 `https://api.xiaomimimo.com/v1/chat/completions` 并透传音频响应。

TTS 请求约定：
- 待合成文本放在 `assistant` 消息中；只发送 `user` 消息时，最后一条 `user` 消息作为待合成文本，之前的消息作为风格指令。
- 可选 `audio` 字段透传给上游，例如 `{"format": "wav", "voice": "Chloe"}`；默认 `wav` + `mimo_default`。
- `mimo-v2.5-tts-voicedesign` 的 `user` 消息为音色描述，需同时提供待合成的 `assistant` 文本（或 `audio.optimize_text_preview: true`）。
- `mimo-v2.5-tts-voiceclone` 需在 `audio.voice` 中传入 `data:audio/mpeg;base64,...` 或 `data:audio/wav;base64,...` 音频样本。

后续验证：官网 Cookie 字段、会话保存接口、模型 ID 升级。

## 教程

1. 登录 `aistudio.xiaomimimo.com`。
2. 打开 DevTools -> Application -> Cookies，复制 `serviceToken`、`userId`、`xiaomichatbot_ph`。
3. 在供应商管理中添加 Mimo 账号并填写三项 Cookie 凭据。
4. 使用 `MiMo-V2.6-Pro` 作为首选验证模型。
5. 如需 TTS，在 `platform.xiaomimimo.com` 创建 API Key 并填入账号的可选 `api_key` 字段。
