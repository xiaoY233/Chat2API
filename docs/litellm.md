# Anthropic Compatibility with LiteLLM

Chat2API exposes OpenAI-compatible endpoints. LiteLLM provides the Anthropic-compatible `/v1/messages` boundary and converts requests to Chat2API's `/v1/responses` endpoint.

```text
Anthropic client -> LiteLLM :4000 -> Chat2API :8080 -> configured provider
```

The Compose file builds a small derived image from LiteLLM `1.93.0`. The build
applies the Anthropic mid-stream error fix to both Chat Completions and
Responses translations, and emits standard Anthropic `ping` events during
quiet upstream periods. A Responses `type:error`, `response.failed`, transport
exception, or premature EOF therefore terminates with a valid `event: error`,
while a healthy but temporarily quiet stream ends with `message_stop`. Its wildcard
route preserves the incoming model name, so a request for `client-model`
reaches Chat2API as `client-model`.
Configure that name in Chat2API's model mappings when the provider uses a
different model ID.

## Start

Start the Chat2API proxy on `127.0.0.1:8080` first. This can be the desktop application or the headless server:

```powershell
# Interactive streams should use the defaults below. Early provider failures
# retain their HTTP status until the first client-visible SSE frame.
$env:CHAT2API_QWEN_AI_BUFFER_MANAGED_STREAMS = 'true'
$env:CHAT2API_SSE_KEEPALIVE_INTERVAL_MS = '15000'

npm run build:server
npm run start:server
```

Then start LiteLLM:

```powershell
$env:LITELLM_MASTER_KEY = 'sk-change-this-key'
# Optional: outer LiteLLM read/first-byte budget in seconds (default 900).
# Keep this above Chat2API's active response limit and tolerated queue wait.
$env:LITELLM_REQUEST_TIMEOUT = '900'
# Standard Anthropic ping interval during downstream silence; 0 disables it.
$env:LITELLM_ANTHROPIC_SSE_HEARTBEAT_INTERVAL_MS = '15000'
# The bundled deployment pins its model route to num_retries: 0 so a queued
# request or client cancellation is not submitted a second time.

# Set this only when Chat2API API-key authentication is enabled.
$env:CHAT2API_API_KEY = 'your-chat2api-key'

docker compose -f docker-compose.litellm.yml up -d --build
docker compose -f docker-compose.litellm.yml ps
```

`LITELLM_BASE_IMAGE` can select another compatible base image and
`LITELLM_IMAGE` can change the local derived-image tag. The patch build verifies
the expected LiteLLM source anchors and fails instead of applying a partial
patch when the base source no longer matches.

The Anthropic-compatible base URL is `http://127.0.0.1:4000`. The Compose service listens only on loopback by default.

The Compose health check verifies both LiteLLM's own liveness endpoint and the
`/health` endpoint derived from `CHAT2API_BASE_URL`. This prevents a bridge
from being reported healthy while its Chat2API target is stopped or points at
an old port. The default Docker topology is therefore:

```text
LiteLLM container -> host.docker.internal:8080 (Chat2API container)
```

For a native Chat2API process, set `CHAT2API_BASE_URL` to the native listener
and regenerate the native supervisor config with the same `-Chat2ApiPort`
value. The native setup defaults to `18080` specifically to keep it separate
from the Docker listener; do not combine a stale native config with a Docker
Chat2API process.

The bundled route is intentionally generic: it preserves each incoming model
name and forwards it to Chat2API. If a client sends a startup probe or another
alias that differs from the provider model ID, create a normal Chat2API model
mapping through the UI or `/v0/management/model-mappings` (including an optional
preferred provider/account). No client-specific probe or provider is enabled by
the Compose defaults.

If Chat2API is listening on another address, set a URL reachable from the container before starting LiteLLM:

```powershell
$env:CHAT2API_BASE_URL = 'http://host.docker.internal:18080/v1'
```

## Verify

```powershell
$headers = @{
  'x-api-key' = $env:LITELLM_MASTER_KEY
  'anthropic-version' = '2023-06-01'
}

$body = @{
  model = 'your-chat2api-model'
  max_tokens = 128
  messages = @(
    @{ role = 'user'; content = 'Reply with exactly: LiteLLM works' }
  )
} | ConvertTo-Json -Depth 10

Invoke-RestMethod `
  -Method Post `
  -Uri 'http://127.0.0.1:4000/v1/messages' `
  -Headers $headers `
  -ContentType 'application/json' `
  -Body $body
```

Anthropic SDK clients use the same endpoint:

```python
from anthropic import Anthropic

client = Anthropic(
    api_key="sk-change-this-key",
    base_url="http://127.0.0.1:4000",
)

message = client.messages.create(
    model="your-chat2api-model",
    max_tokens=128,
    messages=[{"role": "user", "content": "Hello"}],
)
print(message.content[0].text)
```

For Claude Code, point its Anthropic base URL at LiteLLM and use the LiteLLM master key as its Anthropic token.

For example, the user-level `~/.claude/settings.json` can contain:

```json
{
  "env": {
    "ANTHROPIC_BASE_URL": "http://127.0.0.1:4000",
    "ANTHROPIC_AUTH_TOKEN": "sk-change-this-key",
    "CLAUDE_CODE_DISABLE_NONSTREAMING_FALLBACK": "1",
    "ANTHROPIC_MODEL": "your-chat2api-model",
    "ANTHROPIC_DEFAULT_SONNET_MODEL": "your-chat2api-model",
    "ANTHROPIC_DEFAULT_OPUS_MODEL": "your-chat2api-model",
    "ANTHROPIC_DEFAULT_HAIKU_MODEL": "your-chat2api-model",
    "CLAUDE_ENABLE_STREAM_WATCHDOG": "false"
  },
  "permissions": {
    "defaultMode": "bypassPermissions"
  }
}
```

[Anthropic documents](https://code.claude.com/docs/en/env-vars#variables)
`CLAUDE_CODE_DISABLE_NONSTREAMING_FALLBACK=1` for proxy and gateway deployments
where a mid-stream failure could otherwise replay the same tool workflow as a
non-streaming request. With this setting, the streaming error reaches Claude
Code's retry layer instead.

Claude Code 2.1.220 and later also have a semantic-event stream watchdog that
is independent of `API_FORCE_IDLE_TIMEOUT`. Standard Anthropic `ping` events
keep the byte transport alive but do not prevent that watchdog from expiring
when a validated managed branch has not emitted model content. Set
`CLAUDE_ENABLE_STREAM_WATCHDOG=false` for this bridge so Chat2API's Qwen
meaningful-progress timeout owns provider liveness. Claude Code's byte-level
watchdog remains enabled, and the bundled LiteLLM heartbeat keeps a healthy
transport active. Restart existing Claude Code processes after changing this
environment value.

The `permissions` block is optional. `bypassPermissions` disables local tool
approval checks, so use it only in directories whose contents and commands you
trust.

Claude Code captures its permission mode when a session starts. After changing
`permissions.defaultMode`, exit the existing session and start `claude` again;
continuing or resuming an older session keeps that session's previous mode.

Some interactive clients send a preliminary connectivity request before the
first conversation. If that request uses an alias rather than the configured
provider model, add a mapping for the exact alias in Chat2API. This keeps the
protocol bridge usable for both interactive and non-interactive clients without
embedding a client name, project path, or provider model in the deployment.

The deployment enables LiteLLM 1.93's supported
`general_settings.cancel_on_disconnect` option. Its request processor monitors
the downstream connection and cancels an in-flight upstream call when the
client closes the connection, so abandoned work does not keep provider
capacity occupied. This lifecycle policy is independent of client, model, and
provider selection.

## Compatibility Details

LiteLLM 1.93.0 normally sends Anthropic Messages requests for an OpenAI target to the OpenAI Responses API. Chat2API exposes that endpoint, so the Compose service keeps the native Responses bridge enabled through the configurable environment value:

```text
LITELLM_USE_CHAT_COMPLETIONS_URL_FOR_ANTHROPIC_MESSAGES=false
```

Keep the default for current Chat2API releases. Set the value to `true` only
when the LiteLLM deployment is intentionally pointed at an older compatible
target that exposes Chat Completions but not Responses. The supplied config
reads the value from the environment so it does not encode a client-specific
model or request path. It also strips the non-Anthropic `usage.total_tokens`
extension and drops parameters that cannot be represented by the selected
OpenAI-compatible provider.

The wildcard deployment explicitly declares `supports_native_streaming: true`.
Without that declaration LiteLLM cannot infer streaming support for its
internal `openai/*` model id and buffers a non-streaming Responses request into
synthetic SSE. Chat2API's `/v1/responses` stream is native SSE, so the explicit
capability keeps first-byte and incremental output behavior intact for Claude
Code.

Anthropic `count_tokens` requests use the local LiteLLM tokenizer by default:

```text
LITELLM_ANTHROPIC_COUNT_TOKENS_LOCAL_ONLY=true
```

This avoids probing the separate OpenAI Responses token-counting endpoint,
which Chat2API does not currently expose. The bundled image patch counts
Anthropic `system`, `tools`, and `image`/`source` content in the same local
path. Set the value to `false` only when the configured target provides a
compatible `/responses/input_tokens` endpoint.

The Compose service also sets LiteLLM's generic `REQUEST_TIMEOUT` to `900`
seconds by default (override it with `LITELLM_REQUEST_TIMEOUT`). LiteLLM uses
this as an outer HTTP connect/read budget. The bundled configuration binds
`general_settings.pass_through_request_timeout` to `REQUEST_TIMEOUT`, so
pass-through requests use the configured 900-second budget instead of a
separate LiteLLM fallback. It is not
a total-generation timer, and streaming reads can refresh it. Chat2API
independently bounds streams that stop making meaningful progress. Qwen also
has the cumulative request deadline described below. LiteLLM's setting does
not change Chat2API's queue policy.
The derived image separately emits an Anthropic `event: ping` after
`LITELLM_ANTHROPIC_SSE_HEARTBEAT_INTERVAL_MS` of upstream silence (15 seconds
by default). This is protocol-level transport activity, not assistant content,
and applies to every translated Anthropic stream regardless of client, model,
provider, or prompt. Set it to `0` when another proxy already guarantees a
shorter heartbeat interval.
The bundled config sets both the deployment `num_retries` and
`router_settings.num_retries` to the integer `0`. LiteLLM 1.93 has separate
SDK and Router retry budgets; setting only the deployment value still leaves
the Router default at two retries. Zeroing both prevents a duplicate request
after Chat2API returns a queue `429` or a client cancellation. Configure
retries in a separately managed LiteLLM route only when the upstream operation
is known to be idempotent.

The adapter covers regular messages, streaming SSE, Anthropic tool use, tool results, and token counting. Actual support for thinking, images, tools, and other model features still depends on the provider selected by Chat2API. When a provider such as Qwen returns generated-image URLs, Chat2API includes stable Markdown image links in the assistant text; those links survive the Responses-to-Anthropic conversion and are visible to Claude and Claude Code. Structured `image_generation_call` items are additional Responses metadata and should not be the only representation relied on by Anthropic clients.

For Qwen AI managed-tool requests, atomic SSE validation is the default.
Chat2API immediately opens a protocol keep-alive stream, withholds the managed
branch until terminal validation completes, and performs account failover in
the background. Neither the keep-alive nor a failed account's partial branch
becomes model content. Validation failures can then be retried before any model
bytes are committed. Set
`CHAT2API_QWEN_AI_RETRY_COUNT=0` to disable the opt-in recovery retry. Positive
values are honored within the cumulative request deadline; the default is one.
Set `CHAT2API_QWEN_AI_BUFFER_MANAGED_STREAMS=false` only to opt out of atomic
managed-stream recovery.

Before live forwarding, Chat2API waits for the first client-visible SSE frame
or a terminal provider failure. This preserves a pre-output failure's HTTP
status across the OpenAI-to-Anthropic bridge. Deployments can explicitly set
`CHAT2API_QWEN_AI_STREAM_PREFLIGHT_MAX_HOLD_MS` to a positive millisecond value
to release a still-quiet stream after a deadline, or to `0` for immediate
release. `CHAT2API_SSE_KEEPALIVE_INTERVAL_MS` controls comment frames on
Chat2API's OpenAI and Gemini SSE endpoints and accepts `0` to disable them.

The first validated tool-stream recovery may bypass the ordinary per-account
minimum interval so it cannot collide with the queue timeout. It still obeys
the global start interval, concurrency limit, account and global risk
cooldowns, and client cancellation. This exception is scoped to the same
logical request and is never based on a project path, prompt text, or tool
name. `CHAT2API_QWEN_AI_VALIDATED_STREAM_MAX_BYTES` controls the validation
buffer limit; the default is 16 MiB. Reaching that limit rejects the buffered
response instead of committing an unvalidated prefix.

When the Qwen AI governor cannot start a queued request within
`CHAT2API_QWEN_AI_QUEUE_TIMEOUT_MS`, Chat2API returns `429` with a
`Retry-After` header and marks the failure as retryable. A real client
disconnect remains `499` and is not retried. The Compose default is `120000`
ms (120 seconds); override it through the environment when a deployment is
willing to keep clients waiting longer. Pacing and cooldown settings remain
available through the generic Qwen AI governor panel or management API; no
Claude-specific model or request path is required.

Long-context Qwen responses use separate generic transport and response limits.
`QWEN_AI_REQUEST_TIMEOUT_MS` defaults to `840000` ms in the Docker image and
Compose example, while `QWEN_AI_STREAM_IDLE_TIMEOUT_MS` defaults to `180000`
ms. The value is deployment-configurable and should leave enough headroom below
the downstream client or proxy deadline for a structured terminal response.
The cumulative request deadline starts at route entry and is preserved across
account failover, governor waits, retries, compaction stages, document upload
and parsing, active response streams, and semantic recovery. Expiry returns
`504/qwen_ai_request_timeout` without penalizing the account.
`QWEN_AI_RESPONSE_TIMEOUT_MS=0` disables only an additional post-admission
response cap; it does not disable the cumulative request deadline. Set it to a
positive millisecond value to impose a shorter response-only limit. The queue
timer applies only before a governor slot is acquired, and the response/idle
timers apply after the upstream request has started. A long generation does
not consume the queue timer, but it can keep a slot busy long enough for later
requests to receive `429`. Do not
raise the queue timeout solely because a single generation is slow; raise it
only when the client and deployment are intended to tolerate a longer
admission wait.
Document parsing is separately bounded per account by
`QWEN_AI_FILE_PARSE_TIMEOUT_MS` (default `120000` ms), with polling controlled
by `QWEN_AI_FILE_PARSE_POLL_INTERVAL_MS` (default `2000` ms). A parse-stage
timeout occurs before generation is submitted, so Chat2API can continue the
same client request on another eligible account. It is account-neutral and
does not penalize the previous account. Expiry of the cumulative request
deadline remains terminal and is not converted into account failover.
Qwen transport resets are continued by response id instead of submitting the
prompt a second time. `CHAT2API_QWEN_AI_STREAM_RESUME_ATTEMPTS` defaults to `3`
and `CHAT2API_QWEN_AI_STREAM_RESUME_DELAY_MS` to `1000` ms; set attempts to `0`
to disable this bounded recovery. These are generic deployment controls and do
not depend on a Claude session, project directory, model name, or prompt.
If Qwen declares that response ID permanently closed with `The request is
ended!`, Chat2API stops issuing resume GETs and replays the complete request
once in a fresh chat on the same credential. The replay does not add a workflow
correction prompt, does not penalize the account, and a second ended result is
returned as an explicit `502`.
Response-id resumes and managed-tool continuations share the cumulative
 `CHAT2API_QWEN_AI_RECOVERY_BUDGET_MS` (default `180000` ms). It covers only
 no-progress recovery work and pauses while a replacement stream is active, so
 active generation does not spend this smaller budget. Active streams still
 remain inside the configured cumulative request deadline. Set the recovery
 budget to `0` to disable recovery and return the original upstream failure.
Managed semantic recovery also has an absolute
`CHAT2API_QWEN_AI_WORKFLOW_RECOVERY_TIMEOUT_MS` deadline (default `840000` ms).
It starts with the first workflow continuation and keeps running across active
replacement streams, so repeated incomplete progress cannot bypass the
no-progress budget or reach LiteLLM's outer timeout. It is clamped to the
 current request's remaining `QWEN_AI_REQUEST_TIMEOUT_MS` budget. Expiry of the
 workflow timer is reported as `504/qwen_ai_workflow_recovery_timeout`; expiry
 of the earlier cumulative request deadline is
 `504/qwen_ai_request_timeout`. Neither marks the account faulty.
Before the first Qwen completion POST, Chat2API measures the exact serialized
UTF-8 JSON body. `CHAT2API_QWEN_AI_REQUEST_MAX_BYTES` defaults to `92160` as a
document-offload target rather than a local request ceiling. An oversized body
first moves archived history and complete tool documentation to Qwen documents
while keeping the active task and tool exchange inline. If the hybrid layout is
still above the target, Chat2API moves the complete managed conversation into
the transcript document and keeps only compact tool control inline. It then
submits the reduced request instead of returning a local HTTP 413. `0` disables
automatic offload. The original messages and validation schemas remain
unchanged. The compact inline tool-description limit is configurable through
`CHAT2API_QWEN_AI_HERMES_ROUTING_SUMMARY_MAX_CODE_POINTS`; `0` omits those
summaries while retaining the complete attached reference.
For managed-tool semantic terminals, the proxy submits a generic continuation
user turn in the same Qwen chat, parented to the latest response id, without
replaying the transcript or uploaded documents. Only an undeclared native tool
branch is isolated through a fresh-chat replay. The
`CHAT2API_QWEN_AI_WORKFLOW_CONTINUATION_ATTEMPTS` default is `1`, so a malformed
or incomplete branch gets at most one corrective user turn. `0` disables this
path; positive values are honored within the absolute workflow recovery
deadline. The continuation does not replay the original prompt or uploaded
files.
Qwen can briefly reject that continuation with HTTP 200 and
`code=CHAT_IN_PROGRESS` while it finalizes the parent response. The proxy then
retries the exact same continuation payload in the same chat with exponential
backoff until `CHAT2API_QWEN_AI_CHAT_IN_PROGRESS_RETRY_BUDGET_MS` is spent
(default `300000` ms). The admission budget is capped by
`QWEN_AI_REQUEST_TIMEOUT_MS`; once a generation is accepted, the same
cumulative request deadline remains in force. Leave
`CHAT2API_QWEN_AI_CHAT_IN_PROGRESS_RETRY_ATTEMPTS` unset/blank for deadline mode;
set a positive value only when the deployment needs an explicit attempt cap, or
set it to `0` to disable this recovery. `CHAT2API_QWEN_AI_CHAT_IN_PROGRESS_RETRY_DELAY_MS`
defaults to `1000` ms and controls the initial delay. Each retry uses the
remaining admission budget, and an exhausted busy result briefly cools the account
without treating its credentials as invalid. Other JSON errors are not retried,
and a client disconnect cancels the wait.
Responses tool-result continuations have a separate
`CHAT2API_QWEN_AI_RESPONSES_CONTINUATION_RETRY_ATTEMPTS` setting (default `0`).
With the default, a busy retained chat immediately falls back to a complete
transcript replay on the same account instead of holding the Claude request in
exponential backoff.
The queue limit is applied per governor admission attempt, while every attempt
and account failover in one logical request shares the route-level cumulative
deadline. A client abort during a later attempt is still a genuine `499`, not
a queue timeout or request deadline.
Cross-account replay is limited to `401`, `403`, and capacity-classified `429`.
`CHAT_IN_PROGRESS`, chat/session `404/409`, parent or continuation `400`, and
ordinary `5xx` failures remain account-neutral and do not rotate credentials.
Override these environment values for deployments with different latency
budgets.

LiteLLM 1.93.0 has two non-streaming error-response differences in this database-free setup:

- A missing client key returns `401`, but an unknown key returns `400` with `error.type=no_db_connection` because LiteLLM attempts a virtual-key database lookup.
- Non-streaming upstream failures preserve the HTTP status but use an OpenAI-style `{ "error": ... }` body instead of Anthropic's outer `{ "type": "error", "error": ... }` body.

Both cases deny the request correctly, but clients that require the exact
Anthropic non-streaming error envelope need an additional response-normalization
layer or a future LiteLLM release that changes this behavior. Mid-stream errors
are normalized by the derived image because a malformed event would otherwise
leave the client with a pending turn.

## Offline Integration Test

The integration test uses fake keys, a temporary Chat2API data directory, and a local mock OpenAI server. It does not read configured accounts or call a real model provider.

```powershell
docker pull docker.litellm.ai/berriai/litellm:v1.93.0
npm run test:litellm
```

It verifies the complete `Anthropic client -> LiteLLM -> Chat2API -> mock upstream` chain, including non-streaming text, streaming SSE, tool calls and results, token counting, authentication, and upstream errors. A separate direct mock stream verifies that partial content followed by an upstream transport error ends with a spec-compliant Anthropic `error` event.

## References

- [LiteLLM Anthropic pass-through documentation](https://docs.litellm.ai/docs/pass_through/anthropic_completion)
- [LiteLLM 1.93.0 wildcard configuration](https://github.com/BerriAI/litellm/blob/v1.93.0/litellm/proxy/wildcard_config.yaml)
- [LiteLLM 1.93.0 Anthropic endpoint implementation](https://github.com/BerriAI/litellm/blob/v1.93.0/litellm/proxy/anthropic_endpoints/endpoints.py)
- [LiteLLM 1.93.0 compatibility flag source](https://github.com/BerriAI/litellm/blob/v1.93.0/litellm/__init__.py)
- [LiteLLM PR #33352: surface mid-stream provider errors as Anthropic error events](https://github.com/BerriAI/litellm/pull/33352)

## Stop

```powershell
docker compose -f docker-compose.litellm.yml down
```
