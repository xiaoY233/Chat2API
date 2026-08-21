# Qwen AI Multimodal Input Plan

## Goal

Add Docker/server-compatible multimodal input support for the `qwen-ai` provider while keeping the OpenAI-compatible `/v1/chat/completions` surface stable.

The current Docker/server implementation supports image, document/file, audio, and video inputs for ordinary Qwen AI chat completions. Image generation and video generation are intentionally deferred because the Qwen web client routes them through feature/tool-specific chat modes that need separate request captures.

## Current State

`src/main/proxy/adapters/qwen-ai.ts` currently sends only text:

- OpenAI message content is flattened into `userContent`.
- Qwen chat creation uses `chat_type: 't2t'`.
- The outbound Qwen message always uses `files: []`.
- The adapter type accepts `content: string`, so array content parts are not modeled at the Qwen AI adapter boundary.

Qwen web has a file pipeline. The current `qwen-chat-fe` bundle references:

- `/api/v2/files/getstsToken`
- `/api/v2/files/getfilelink`
- `/api/v2/files/parse`
- `/api/v2/files/parse/status`
- `/api/v2/chat/completions`

That means file/image support requires an upload/reference phase before `/api/v2/chat/completions`.

## Scope

### Supported in current Docker chat mode

- OpenAI `messages[].content[]` parts:
  - `{ "type": "text", "text": "..." }`
  - `{ "type": "image_url", "image_url": { "url": "..." } }`
  - `{ "type": "file", "file_url": { "url": "..." }, "filename": "..." }`
  - `{ "type": "input_audio", "input_audio": { "data": "...", "format": "wav" } }`
  - `{ "type": "video_url", "video_url": { "url": "..." }, "filename": "..." }`
- `image_url.url` and `file_url.url` can be:
  - `data:<mime>;base64,...`
  - `http://...` or `https://...`
- `input_audio.data` is an OpenAI-compatible base64 payload. A `data:<mime>;base64,...` payload is also accepted.
- `video_url.url` can be `data:<mime>;base64,...`, `http://...`, or `https://...`.
- Multiple images/files in the latest user request.
- Text-only behavior remains unchanged.

### Deferred

- Voice/RTC chat.
- Qwen image generation and video generation menu actions.
- Long-running parse polling beyond a bounded initial parse request.

## API Compatibility

Clients can send requests like:

```json
{
  "model": "Qwen3.7-Plus",
  "messages": [
    {
      "role": "user",
      "content": [
        { "type": "text", "text": "这张图里有什么？" },
        { "type": "image_url", "image_url": { "url": "data:image/png;base64,..." } }
      ]
    }
  ],
  "stream": false
}
```

For generic files:

```json
{
  "role": "user",
  "content": [
    { "type": "text", "text": "总结这个文件" },
    {
      "type": "file",
      "filename": "report.pdf",
      "file_url": { "url": "https://example.com/report.pdf" }
    }
  ]
}
```

## Design

### 1. Extend proxy content types

Update `src/main/proxy/types.ts` so `ChatMessageContent` supports `file`, `input_audio`, and `video_url` parts. Keep this compatible with the existing loose usage in GLM by adding optional `file_url`, `input_audio`, `video_url`, `filename`, and `mime_type` fields.

### 2. Add Qwen AI multimodal helper

Create `src/main/proxy/adapters/qwen-ai-files.ts` with focused responsibilities:

- Extract text, image, file, audio, and video parts from OpenAI messages.
- Download or decode part URLs into buffers.
- Infer filename and MIME type.
- Request Qwen STS metadata with `/api/v2/files/getstsToken`.
- Upload to the returned OSS location when the STS response is available.
- Convert the upload result into Qwen `messages[].files[]` entries.
- Fall back to a URL-backed file entry only when the input is already an HTTP(S) URL and Qwen returns enough metadata from `/api/v2/files/getfilelink`.

The helper must not log tokens, cookies, raw file contents, or base64 payloads.

### 3. Integrate with `QwenAiAdapter`

Change the adapter boundary to accept the shared `ChatMessage[]` shape instead of the current string-only `QwenAiMessage`.

In `chatCompletion()`:

- Call the helper before building the Qwen payload.
- Preserve existing text-only logic.
- Put extracted text in `content`.
- Put Qwen file refs in `files`.
- Select `chat_type`/`sub_chat_type` based on uploaded file types:
  - only text: `t2t`
  - any image: keep `chat_type: 't2t'` but set file show/type metadata as Qwen expects for vision inputs
  - any document/audio/video: keep `t2t` unless captured evidence shows a required media-specific chat type

### 4. Error handling

- Reject unsupported content part types with a clear error.
- Reject unsupported URL schemes.
- Enforce a conservative max file size before upload.
- If Qwen returns 401 during upload or chat, reuse the existing token refresh retry path.
- If Qwen returns a captcha/risk page, surface the upstream HTTP status and short message without credentials.

### 5. Testing

Add tests that do not require live Qwen network:

- Text extraction keeps existing text-only payload unchanged.
- Image data URL becomes a Qwen file entry and is not included as raw base64 text.
- Generic file URL becomes a Qwen file entry.
- OpenAI `input_audio` becomes a Qwen audio file entry.
- OpenAI `video_url` becomes a Qwen video file entry.
- Unsupported content part types fail clearly.
- `QwenAiAdapter` payload builder uses `files` from the helper instead of `[]`.

Run existing server compatibility tests after implementation:

```bash
npm run test:server-compat
```

Then rebuild and restart Docker:

```bash
docker build --pull=false --build-arg NODE_IMAGE=docker.m.daocloud.io/library/node:22.21.1 -t chat2api:server .
docker stop chat2api
docker rm chat2api
docker run -d --name chat2api --restart unless-stopped -p 8080:8080 \
  -e CHAT2API_HOST=0.0.0.0 \
  -e CHAT2API_PORT=8080 \
  -e CHAT2API_DATA_DIR=/data \
  -e CHAT2API_ENABLE_MANAGEMENT_API=true \
  -e CHAT2API_MANAGEMENT_SECRET=mgmt_change_me \
  -e CHAT2API_LOG_LEVEL=info \
  -e CHAT2API_LOAD_BALANCE_STRATEGY=round-robin \
  -v chat2api-data:/data \
  chat2api:server
```

## Upstream Update Notes

When upstream source updates are pulled, compare these files first:

- `src/main/proxy/types.ts`
- `src/main/proxy/adapters/qwen-ai.ts`
- `src/main/proxy/adapters/qwen-ai-files.ts`
- `src/main/proxy/forwarder.ts`
- `docs/providers/qwen-ai.md`

If Qwen changes its web upload endpoints, recapture the web requests for:

- STS token request.
- OSS upload request.
- File link/parse request.
- Final `/api/v2/chat/completions` message with `files`.
