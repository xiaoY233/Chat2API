# Chat2API Tool Testing Skills Design

## Background

Chat2API's tool-calling behavior must be tested through real OpenAI-compatible client traffic, not only hand-written curl requests. The current local `chat2api-proxy-testing` skill proved useful for live smoke tests, but its Cherry Studio matrix runner mixes several responsibilities:

- reading HAR files;
- operating the management API;
- discovering providers and models;
- replaying a specific client protocol;
- judging provider/model results;
- generating reports.

That shape is too narrow. Future tests will include clients other than Cherry Studio, and provider model names will continue to change through `/v1/models`, model mappings, and provider optimization work.

## Goals

Build a stable, reusable testing skill set for Chat2API tool calling:

1. Support multiple OpenAI-compatible clients, starting with Cherry Studio but not designed around it.
2. Treat HAR ingestion as a generic fixture extraction workflow.
3. Treat the management API as a first-class testing capability.
4. Discover test models through the live `/v1/models` API by default.
5. Keep provider/model attribution available through management API data and request logs.
6. Avoid destructive cleanup. Existing sessions must not be cleared unless explicitly requested.
7. Store the long-lived skills in a versioned project directory instead of ignored `.codex/skills`.

## Non-Goals

- Do not add new provider behavior in this design.
- Do not fix provider-specific tool-calling failures in the skill migration.
- Do not make live provider tests mandatory in normal source regression runs.
- Do not embed secrets, account credentials, or management API keys in files.

## Skill Architecture

### 1. `chat2api-management-api`

Purpose: safe, repeatable management API operations for tests.

Responsibilities:

- check `/health`, `/v0/management/health`, and proxy status;
- read masked config, providers, accounts, sessions, logs, statistics, and model mappings;
- create and delete disposable API keys;
- snapshot and restore `toolCallingConfig`;
- create and remove temporary model mappings when provider targeting is needed;
- fetch request logs after each scenario for evidence;
- enforce safety rules around secrets and session cleanup.

Inputs:

- `CHAT2API_BASE_URL`;
- `CHAT2API_MGMT_SECRET`;
- optional filters such as provider id, model id, and log limit.

Outputs:

- structured snapshots for test scripts;
- human-readable command templates;
- cleanup checklist.

Safety rules:

- never print full secrets or generated API keys;
- never clear sessions by default;
- restore modified config in `finally`;
- delete only temporary keys/mappings created by the current run.

### 2. `chat2api-har-tool-fixture`

Purpose: convert a client HAR into replayable, sanitized tool-calling fixtures.

Responsibilities:

- parse HAR files and find `/v1/chat/completions` requests;
- classify request shapes:
  - stream with OpenAI `tools`;
  - non-stream with OpenAI `tools`;
  - stream prompt-based tool protocol;
  - non-stream prompt-based tool protocol;
  - follow-up request containing tool results;
- extract tool names, tool schemas, messages, headers that matter for client detection, and stream flags;
- remove secrets and volatile headers;
- produce fixture JSON that replay scripts can use across providers.

Inputs:

- `CHAT2API_HAR`;
- optional `CHAT2API_CLIENT_PROFILE`;
- optional expected tool name override.

Outputs:

- `backup/har/<client>-tool-fixtures-<timestamp>.json`;
- a short markdown summary of detected scenarios;
- validation errors when a HAR lacks required scenario coverage.

Important rule:

HAR parsing is not client-specific. Client-specific differences belong in client profiles.

### 3. `chat2api-tool-client-replay`

Purpose: replay client tool-calling fixtures against Chat2API.

Responsibilities:

- load fixtures generated from HAR;
- select a client profile;
- apply profile-specific pass/fail rules;
- send requests with realistic client headers;
- validate stream and non-stream OpenAI-compatible responses;
- validate prompt-protocol responses when the client expects visible tool syntax;
- preserve exact tool names.

Initial client profiles:

| Profile | Purpose |
| --- | --- |
| `cherry-studio` | Cherry Studio MCP and prompt XML traffic |
| `openai-tools` | Generic OpenAI SDK-compatible tool calls |
| `custom-har` | Fallback for unknown clients, using fixture-derived rules |

Profile responsibilities:

- request identification hints, such as `x-title` or `User-Agent`;
- expected tool-name style;
- whether prompt-protocol output should be visible content or converted to OpenAI `tool_calls`;
- stream/non-stream pass criteria;
- follow-up tool-result message expectations.

### 4. `chat2api-provider-model-matrix`

Purpose: run model/provider coverage against the live proxy surface.

Responsibilities:

- call `/v1/models` to discover client-visible model ids;
- use management API providers/accounts/model mappings for attribution;
- optionally filter by provider, owner, model, or regex;
- avoid fixed provider `supportedModels` as the primary source;
- create temporary model mappings only when needed to target a provider unambiguously;
- generate markdown and JSON reports.

Default model source:

1. `GET /v1/models` is the primary model list.
2. Management API provider/account/config data is used for attribution and targeting.
3. Built-in provider `supportedModels` is only fallback metadata when `/v1/models` is unavailable.

Report requirements:

- run id, source HAR or fixture path, base URL, client profile;
- management API and proxy health snapshot;
- model discovery source and filter options;
- per-provider and per-model pass/fail summary;
- per-scenario raw evidence in JSON;
- cleanup confirmation for temp keys, mappings, and config restore;
- request-log ids where available.

## End-to-End Flow

1. Read current health through `chat2api-management-api`.
2. Extract or validate fixtures through `chat2api-har-tool-fixture`.
3. Discover models through `/v1/models`.
4. Build provider/model targets using management API attribution.
5. Create one disposable API key.
6. Snapshot and set tool-calling config for the selected client profile.
7. Replay fixtures across targets.
8. Inspect logs and sessions for attribution.
9. Restore config and delete temporary API key/mappings.
10. Write markdown and JSON reports.

## Migration Plan Shape

The implementation should not keep expanding `.codex/skills/chat2api-proxy-testing` as the only location. Long-lived project testing skills should be versioned under:

```text
skills/
  chat2api-management-api/
  chat2api-har-tool-fixture/
  chat2api-tool-client-replay/
  chat2api-provider-model-matrix/
  chat2api-proxy-testing/
```

`chat2api-proxy-testing` becomes the orchestrating entry point and links to the focused skills.

Existing local `.codex/skills/chat2api-proxy-testing` can remain as a working copy during migration, but it should not be treated as the durable source of truth because `.codex/` is ignored by git.

## Acceptance Criteria

- A future agent can test Cherry Studio without reading a one-off prior report.
- A future agent can add another client profile without changing management API logic.
- Matrix testing defaults to `/v1/models`.
- Management API operations are documented as reusable skill behavior.
- The runner does not leak secrets and confirms cleanup.
- Report output distinguishes:
  - tool parser failure;
  - prompt protocol failure;
  - provider connection failure;
  - model routing or mapping failure;
  - timeout.
- Source regression remains separate from live provider smoke tests.

## Design Decisions

1. Versioned skills should live under `skills/`. This keeps them discoverable and commit-friendly without mixing them into ignored `.codex/` local state.
2. Generated live-test reports should continue to default to ignored `backup/har/`. A selected summary can be copied into `docs/testing/` only when it becomes release or issue evidence.
3. Provider-level fail-fast should be opt-in through a flag. Full matrix coverage remains the default because it is better evidence when diagnosing provider support.
