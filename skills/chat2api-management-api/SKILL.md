---
name: chat2api-management-api
description: Use when operating Chat2API Manager's management API for testing, including health checks, config snapshots, temporary API keys, model mappings, sessions, logs, and cleanup verification.
---

# Chat2API Management API

Use this skill before live proxy testing that needs `/v0/management/*`.

## Rules

- Never print full management secrets, API keys, or account credentials.
- Create disposable API keys for tests and delete only keys created by the current run.
- Snapshot config before mutation and restore it in cleanup.
- Do not clear sessions unless the user explicitly asks for cleanup.

## Script

Use `scripts/management-api.mjs` for repeatable management API setup, observation, and cleanup commands.

## Commands

```bash
CHAT2API_MGMT_SECRET=mgmt_xxx node skills/chat2api-management-api/scripts/management-api.mjs snapshot
CHAT2API_MGMT_SECRET=mgmt_xxx node skills/chat2api-management-api/scripts/management-api.mjs create-api-key --name codex-live-test
CHAT2API_MGMT_SECRET=mgmt_xxx node skills/chat2api-management-api/scripts/management-api.mjs delete-api-key --id key-id
CHAT2API_MGMT_SECRET=mgmt_xxx node skills/chat2api-management-api/scripts/management-api.mjs restore-tool-config --file /private/tmp/toolCallingConfig.json
```

Use `--dry-run` to verify command shape without network calls.

`create-api-key` prints a one-time API key to stdout. Do not write this output to durable logs, transcripts, or shared artifacts.

`snapshot` omits request logs by default. Use `snapshot --include-logs` only when logs are intentionally needed; included snapshot data is locally redacted before printing.
