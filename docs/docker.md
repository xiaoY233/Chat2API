# Chat2API Docker Server

The Docker image runs the existing Koa proxy and management API without Electron. Data is stored under `/data`, so mount it as a volume.

## Build

```bash
docker build -t chat2api:server .
```

If Docker Hub access is restricted or you already have a preferred Node base image locally:

```bash
docker build --build-arg NODE_IMAGE=node:22.21.1 -t chat2api:server .
```

## Run

```bash
docker run -d \
  --name chat2api \
  -p 8080:8080 \
  -v chat2api-data:/data \
  -e CHAT2API_HOST=0.0.0.0 \
  -e CHAT2API_PORT=8080 \
  -e CHAT2API_ENABLE_MANAGEMENT_API=true \
  -e CHAT2API_MANAGEMENT_SECRET=mgmt_change_me \
  chat2api:server
```

## Docker Compose

```bash
$env:CHAT2API_MANAGEMENT_SECRET='mgmt_change_me'
docker compose up -d --build
```

## Health Check

```bash
curl http://localhost:8080/health
```

## Web Admin

Open the browser admin page:

```text
http://localhost:8080/admin/
```

If `localhost` does not resolve correctly on Windows, use:

```text
http://127.0.0.1:8080/admin/
```

Enter `CHAT2API_MANAGEMENT_SECRET` on the login screen. The Docker build serves the existing React management UI from the Electron app, backed by `/v0/management/*` endpoints. The main pages are available in the browser:

- Dashboard
- Providers and accounts
- Proxy settings
- Models and model mapping
- Session settings
- API keys
- Logs
- Settings
- About

Provider account management supports the same manual credential forms used by the Electron UI. For Qwen, add accounts with the `SSO Ticket` field, which maps to the stored credential key `ticket`.

The Docker web admin and proxy run in the same Koa process. Start, stop, restart, and port publishing are therefore managed by Docker or Docker Compose, not by the in-app Stop Proxy button. If you change the listening port or bind address in the UI, restart the container and update your `-p`/Compose port mapping accordingly.

Electron-only automatic in-app login cannot run in Docker because it depends on an Electron `BrowserWindow`. The Docker web admin provides a browser-assisted import flow for Qwen and Kimi providers so you do not have to manually search DevTools storage fields.

## Browser-Assisted Qwen AI Import

For `Qwen AI (International)` (`chat.qwen.ai`):

1. Open `http://localhost:8080/admin/#/providers`.
2. Open the `Qwen AI (International)` account dialog.
3. Switch to the OAuth tab. In Docker this tab becomes `Docker Browser-Assisted Import`.
4. Click `Open Provider Website` and log in at `https://chat.qwen.ai`.
5. Click `Generate Import Script`, then `Copy Import Script`.
6. On the logged-in `chat.qwen.ai` page, open the browser console, paste the script, and run it.
7. Return to Chat2API. The token is filled automatically; click `Validate Credentials`, then `Add Account`.

The script reads `localStorage.token` and readable cookies from the already logged-in `chat.qwen.ai` page, then posts them to the local Docker admin import endpoint using a short-lived random import ID. It does not receive or need the management secret.

For domestic `Qwen` (`www.qianwen.com`), the same flow attempts to read `tongyi_sso_ticket` from `document.cookie`. If the site marks that cookie as `HttpOnly`, browser JavaScript cannot read it and the UI will show a clear failure. In that case, use the manual `SSO Ticket` field.

## Browser-Assisted Kimi Import

For Kimi (`www.kimi.com`):

1. Open `http://localhost:8080/admin/#/providers`.
2. Open the Kimi account dialog and switch to the OAuth tab.
3. Click `Open Provider Website` and log in at `https://www.kimi.com`.
4. Click `Generate Import Script`, copy it, then run it in the logged-in Kimi page's browser console.
5. Return to Chat2API. The access token is filled automatically; validate it and add the account.

The script reads `localStorage.access_token` and `localStorage.refresh_token`. The `volcano-token-info` object is used only for request identifiers (`webId`, `ssid`, and `userId`), which become the stored `deviceId`, `sessionId`, and `trafficId`; it is not treated as a token container. The script also checks the `kimi-auth` cookie/local-storage value when available. Kimi may mark that cookie as `HttpOnly`, so the local-storage tokens are preferred. If the browser blocks the cross-origin POST, the script prints and copies a one-time payload that can be pasted into the Docker admin page.

## Add Qwen Accounts

Add the first Qwen account:

```bash
curl -X POST http://localhost:8080/v0/management/accounts \
  -H "Authorization: Bearer mgmt_change_me" \
  -H "Content-Type: application/json" \
  -d '{
    "providerId": "qwen",
    "name": "qwen-account-1",
    "credentials": {
      "ticket": "tongyi_sso_ticket_value"
    }
  }'
```

Add another Qwen account:

```bash
curl -X POST http://localhost:8080/v0/management/accounts \
  -H "Authorization: Bearer mgmt_change_me" \
  -H "Content-Type: application/json" \
  -d '{
    "providerId": "qwen",
    "name": "qwen-account-2",
    "credentials": {
      "ticket": "another_tongyi_sso_ticket_value"
    }
  }'
```

The proxy load balancer will select among active Qwen accounts according to `CHAT2API_LOAD_BALANCE_STRATEGY` or the persisted config.

Built-in provider records are created lazily when the first account is added for that provider. A fresh container can therefore return an empty provider list until you add an account or otherwise create a provider record.

## Pin A Model To One Account

List accounts:

```bash
curl http://localhost:8080/v0/management/providers/qwen/accounts \
  -H "Authorization: Bearer mgmt_change_me"
```

Create a model mapping with `preferredAccountId`:

```bash
curl -X POST http://localhost:8080/v0/management/model-mappings \
  -H "Authorization: Bearer mgmt_change_me" \
  -H "Content-Type: application/json" \
  -d '{
    "requestModel": "qwen-primary",
    "actualModel": "Qwen3.7-Max",
    "preferredProviderId": "qwen",
    "preferredAccountId": "account_id_from_previous_response"
  }'
```

## Environment Variables

```text
CHAT2API_HOST=0.0.0.0
CHAT2API_PORT=8080
CHAT2API_DATA_DIR=/data
CHAT2API_ENABLE_MANAGEMENT_API=true
CHAT2API_MANAGEMENT_SECRET=mgmt_change_me
CHAT2API_ENABLE_API_KEY=false
CHAT2API_LOG_LEVEL=info
CHAT2API_LOAD_BALANCE_STRATEGY=round-robin
CHAT2API_STORAGE_ENCRYPTION_KEY=
CHAT2API_QWEN_AI_QUEUE_TIMEOUT_MS=120000
# Repair JWT-only Qwen AI accounts by obtaining the Web session cookie.
CHAT2API_QWEN_AI_SESSION_REPAIR_ENABLED=true
CHAT2API_QWEN_AI_SESSION_REPAIR_INTERVAL_MS=25000
CHAT2API_QWEN_AI_SESSION_REPAIR_RESCAN_MS=60000
CHAT2API_QWEN_AI_SESSION_REPAIR_RISK_COOLDOWN_MS=180000
CHAT2API_QWEN_AI_SESSION_REPAIR_FAILURE_RETRY_MS=300000
CHAT2API_QWEN_AI_SESSION_REPAIR_CREDENTIAL_RETRY_MS=21600000
# Optional guarded throughput profile for a larger Qwen AI account pool.
# These environment values override persisted governor settings.
CHAT2API_QWEN_AI_AUTO_TUNE_ENABLED=true
CHAT2API_QWEN_AI_AUTO_TUNE_MAX_CONCURRENT=20
CHAT2API_QWEN_AI_AUTO_TUNE_MIN_GLOBAL_INTERVAL_MS=1000
CHAT2API_QWEN_AI_ACCOUNT_MIN_INTERVAL_MS=30000
QWEN_AI_REQUEST_TIMEOUT_MS=840000
QWEN_AI_RESPONSE_TIMEOUT_MS=0
QWEN_AI_STREAM_IDLE_TIMEOUT_MS=180000
QWEN_AI_FILE_PARSE_POLL_INTERVAL_MS=2000
QWEN_AI_FILE_PARSE_TIMEOUT_MS=120000
QWEN_AI_OSS_STS_REFRESH_INTERVAL_MS=240000
CHAT2API_QWEN_AI_BUFFER_MANAGED_STREAMS=true
CHAT2API_QWEN_AI_REQUEST_MAX_BYTES=92160
CHAT2API_QWEN_AI_HERMES_ROUTING_SUMMARY_MAX_CODE_POINTS=240
CHAT2API_QWEN_AI_RETRY_COUNT=1
CHAT2API_QWEN_AI_BUSY_RETRY_COUNT=1
CHAT2API_QWEN_AI_WORKFLOW_CONTINUATION_ATTEMPTS=1
CHAT2API_QWEN_AI_RECOVERY_BUDGET_MS=180000
CHAT2API_QWEN_AI_WORKFLOW_RECOVERY_TIMEOUT_MS=840000
# Leave blank/unset for deadline mode; set a non-negative integer for an
# explicit retry cap (0 disables busy-chat recovery).
CHAT2API_QWEN_AI_CHAT_IN_PROGRESS_RETRY_ATTEMPTS=
CHAT2API_QWEN_AI_CHAT_IN_PROGRESS_RETRY_DELAY_MS=1000
CHAT2API_QWEN_AI_CHAT_IN_PROGRESS_RETRY_BUDGET_MS=300000
CHAT2API_QWEN_AI_RESPONSES_CONTINUATION_RETRY_ATTEMPTS=0
CHAT2API_VALIDATED_SSE_MAX_HOLD_MS=60000
CHAT2API_SSE_KEEPALIVE_INTERVAL_MS=15000
# During an image update, stop accepting new requests and drain active HTTP/SSE
# streams for this long before the process exits. Keep this at or below the
# Compose stop_grace_period (default 10m).
CHAT2API_SHUTDOWN_DRAIN_TIMEOUT_MS=540000
```

Set `CHAT2API_STORAGE_ENCRYPTION_KEY` if you want server-side credential encryption. If it is omitted, credentials are stored in the mounted data directory without the extra runtime encryption layer.

For Qwen AI, `active` means the stored JWT passed account validation. It does
not by itself mean that the account has the `token=...` cookie required by the
Qwen Web chat endpoints. The background session repair service signs in with a
stored email and password, persists the returned JWT and `Set-Cookie` values,
and then marks the account's Web session as ready in the Qwen governor panel.
Repairs run one account at a time. HTTP 403 or 429 pauses the entire repair
sweep for `CHAT2API_QWEN_AI_SESSION_REPAIR_RISK_COOLDOWN_MS`; other failures and
credential failures use their separate retry intervals. Set
`CHAT2API_QWEN_AI_SESSION_REPAIR_ENABLED=false` to disable this service.

The Qwen AI queue timeout applies only while waiting for a governor slot. The
cumulative request deadline starts at route entry and is preserved across
account failover, queue waits, retries, compaction stages, file upload and
parsing, active response streams, and semantic recovery. Expiry returns
`504/qwen_ai_request_timeout` without penalizing the account. Response and idle
limits apply after admission. The idle timeout is refreshed
only by parsed SSE events that represent generation progress; empty events and
transport heartbeats keep the connection alive without resetting it. The
additional post-admission response limit is disabled when
`QWEN_AI_RESPONSE_TIMEOUT_MS=0`; the cumulative request deadline remains in
force. Set a positive value to impose a shorter response-only cap. A stream
with no meaningful progress still fails after 180 seconds by default.
Document parsing has its own per-account stage limit. When parsing remains
unfinished for `QWEN_AI_FILE_PARSE_TIMEOUT_MS`, Chat2API reports
`504/qwen_ai_file_parse_timeout` internally and continues the same request on
another eligible account without marking the previous account faulty. The
polling cadence is controlled by `QWEN_AI_FILE_PARSE_POLL_INTERVAL_MS`. If the
cumulative request deadline expires first, `qwen_ai_request_timeout` remains
terminal and does not trigger account failover.
When using the bundled LiteLLM Compose service, its generic outer
`REQUEST_TIMEOUT` defaults to `900` seconds (via `LITELLM_REQUEST_TIMEOUT`).
The bundled LiteLLM configuration maps
`general_settings.pass_through_request_timeout` to `REQUEST_TIMEOUT`; this
keeps pass-through Anthropic Messages and Responses requests from falling back
to LiteLLM's built-in 600-second timeout. Streaming activity refreshes
LiteLLM's outer connect/read budget. This value is independent from Chat2API's
Qwen cumulative request, queue, and meaningful-idle limits and remains
configurable.
Chat2API emits legal SSE comment frames after
`CHAT2API_SSE_KEEPALIVE_INTERVAL_MS` of downstream silence. These comments do
not become model output and do not reset the Qwen meaningful-progress timer;
set the value to `0` only when another layer owns transport keep-alives.
If Qwen closes a response socket before its terminal event, Chat2API can ask
Qwen to continue the same response using its `chat_id` and `response_id`.
`CHAT2API_QWEN_AI_STREAM_RESUME_ATTEMPTS` (default `3`) bounds those
continuations and `CHAT2API_QWEN_AI_STREAM_RESUME_DELAY_MS` (default `1000`)
controls the pause between attempts. Set the attempts value to `0` to disable
this transport recovery. It never resubmits the original prompt and is not
selected by a session id, project path, or task content.
Transport resumes and managed workflow continuations also share the bounded
 `CHAT2API_QWEN_AI_RECOVERY_BUDGET_MS` (default `180000` ms). The budget is
 spent only while a replacement stream is being admitted, including retry
 delays and a stalled JSON admission response; it pauses once a replacement
 stream is attached. Active generation does not spend this smaller no-progress
 budget, but it remains inside the configured cumulative request deadline. This
 prevents several recovery layers from accumulating independent waits while
 preserving generations that are making progress within the route budget.
Set it to `0` to disable recovery and surface the original upstream failure.
Once a managed semantic recovery starts,
`CHAT2API_QWEN_AI_WORKFLOW_RECOVERY_TIMEOUT_MS` (default `840000` ms) adds an
absolute wall-clock limit across every replacement branch. Unlike the
no-progress budget, this timer keeps running while a continuation emits output,
so repeated incomplete branches cannot outlive the outer LiteLLM timeout. On
each request it is also clamped to the remaining `QWEN_AI_REQUEST_TIMEOUT_MS`
 budget. Configure the request budget below any downstream client or proxy
 deadline so the transport layers have time to carry the terminal response.
 If the workflow-specific timer expires first, Chat2API returns
 `504/qwen_ai_workflow_recovery_timeout`. If the cumulative request deadline
 expires first, it returns `504/qwen_ai_request_timeout`. Neither penalizes the
 account.
Before the first Qwen completion POST, Chat2API measures the serialized UTF-8
JSON body. `CHAT2API_QWEN_AI_REQUEST_MAX_BYTES` defaults to `92160` bytes as a
document-offload target, not a local client request limit (`0` disables
automatic offload). An oversized request first moves archived history and
complete managed tool documentation to Qwen documents while retaining the
active task and tool exchange inline. If that hybrid layout is still above the
target, the complete managed conversation moves to the transcript document and
only compact tool control remains inline. The original client messages,
completed tool results, and validation schemas are preserved. A body that still
exceeds the target after this reduction is submitted to Qwen instead of being
rejected locally with HTTP 413.
`CHAT2API_QWEN_AI_HERMES_ROUTING_SUMMARY_MAX_CODE_POINTS` controls each compact
inline tool description while the complete description remains in the tool
reference attachment; `0` omits inline descriptions.
When a managed-tool response reaches a semantic terminal without a tool call,
Chat2API can start one corrective user turn in the same Qwen chat instead of
replaying that completed response branch or the original transcript. A fresh
chat replay is reserved for an undeclared provider-native tool call. The
`CHAT2API_QWEN_AI_WORKFLOW_CONTINUATION_ATTEMPTS` default is `1`; `0` disables
semantic recovery and positive values are bounded by the absolute workflow
recovery deadline.
The new turn is parented to Qwen's latest `response_id` and does not resend the
original messages or files.
If Qwen is still finalizing the parent response, its continuation endpoint
returns HTTP 200 JSON with `code=CHAT_IN_PROGRESS` instead of an SSE stream.
Chat2API waits with exponential backoff and retries the exact same continuation
payload until `CHAT2API_QWEN_AI_CHAT_IN_PROGRESS_RETRY_BUDGET_MS` is spent
(default `300000` ms). This admission budget is capped by
`QWEN_AI_REQUEST_TIMEOUT_MS`; once a generation is accepted, the same
cumulative request deadline remains in force. Leave
Bound Claude tool-result continuations use the dedicated
`CHAT2API_QWEN_AI_RESPONSES_CONTINUATION_RETRY_ATTEMPTS=0` setting and fail fast
into same-account full-history replay instead of waiting through a long
busy-chat window. The generic
`CHAT2API_QWEN_AI_CHAT_IN_PROGRESS_RETRY_ATTEMPTS` remains blank by default,
which preserves deadline mode for ordinary semantic workflow continuations.
Set it to a positive value when explicit polling is desired.
`CHAT2API_QWEN_AI_CHAT_IN_PROGRESS_RETRY_DELAY_MS`
(default `1000` ms) sets the initial delay. Each retry uses only the remaining
admission budget, and an exhausted busy result briefly cools the account without
invalidating its credentials. The response is recognized by the provider code
only, so an ordinary JSON error remains a non-stream `502`, and cancellation
stops the wait without another request.
Retained Responses tool-result continuations use
`CHAT2API_QWEN_AI_RESPONSES_CONTINUATION_RETRY_ATTEMPTS` (default `0`) and
therefore hand `CHAT_IN_PROGRESS` to the same-account full-transcript replay
path immediately. Increase it only when the upstream chat settles quickly.
Qwen's early-error preflight keeps the HTTP status mutable until the first
client-visible SSE frame or a terminal failure. This lets a provider rejection
that arrives before output retain its HTTP status across protocol bridges.
`CHAT2API_QWEN_AI_STREAM_PREFLIGHT_MAX_HOLD_MS` is an optional deployment
override: a positive integer releases a still-quiet stream after that many
milliseconds, and `0` releases it immediately.
Managed SSE validation defaults to
`CHAT2API_QWEN_AI_BUFFER_MANAGED_STREAMS=true`. The managed branch is withheld
until terminal validation completes, allowing malformed and provider-only tool
calls to recover before bytes reach the client. Set it to `false` only when
lower first-byte latency is more important than transparent branch recovery.
`CHAT2API_QWEN_AI_VALIDATED_STREAM_MAX_BYTES` bounds that validation buffer.

The persisted `qwenAiSessionMode` setting controls managed tool-result turns.
`tool-call-binding` is the default: a completed first turn binds its Qwen
account, chat ID, and parent ID to the complete client-visible tool-call ID
batch, and a trailing tool-result batch continues only that chat. `legacy`
starts a fresh Qwen chat from the complete client history on every turn. Both
modes remain selectable in the Qwen governor panel.

Cross-account replay is restricted to authentication failures (`401/403`) and
capacity-classified `429` responses. `CHAT_IN_PROGRESS`, stale chat/session
`404/409`, continuation or parent `400`, and ordinary `5xx` responses do not
penalize or rotate the account. If a response resume returns `The request is
ended!`, Chat2API abandons that response ID and replays the complete request
once in a fresh chat on the same credential; a second ended result is returned
as an explicit `502`.

## Upstream Update Flow

The Docker-specific patch surface is intentionally small:

```text
src/server/
src/main/runtime/
src/main/store/storage/
src/renderer/admin.html
src/renderer/src/web-main.tsx
src/renderer/src/web-admin-api.ts
tests/server/
Dockerfile
docker-compose.yml
.dockerignore
docs/docker.md
vite.admin.config.ts
vite.server.config.ts
```

When pulling upstream:

```bash
git fetch upstream
git merge upstream/main
npm install
npm run test:server-compat
npm run build:server
docker build -t chat2api:server .
```

Resolve conflicts by keeping upstream provider, OAuth, adapter, and React UI logic first. Then reapply the Docker runtime boundary, server entrypoint, management API coverage, and web `window.electronAPI` adapter where direct Electron IPC or `BrowserWindow` usage blocks the Node server build.

After every upstream merge, verify the real container, not just the local build:

```bash
docker rm -f chat2api
docker run -d --name chat2api -p 8080:8080 \
  -v chat2api-data:/data \
  -e CHAT2API_ENABLE_MANAGEMENT_API=true \
  -e CHAT2API_MANAGEMENT_SECRET=mgmt_change_me \
  chat2api:server

curl http://127.0.0.1:8080/admin/
curl -H "Authorization: Bearer mgmt_change_me" \
  http://127.0.0.1:8080/v0/management/providers/builtin
```
