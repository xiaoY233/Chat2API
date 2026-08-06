---
name: chat2api-tool-client-replay
description: Use when replaying sanitized client tool-calling fixtures against Chat2API with client-specific pass/fail rules.
---

# Chat2API Tool Client Replay

Use this skill to replay fixture scenarios for clients such as Cherry Studio, generic OpenAI tools, or unknown HAR-derived clients.

## Rules

- Preserve exact tool names.
- Validate stream and non-stream behavior separately.
- Use profiles for client-specific prompt-protocol expectations.

## Commands

```bash
CHAT2API_API_KEY=sk_xxx \
node skills/chat2api-tool-client-replay/scripts/replay-client-fixture.mjs \
  --fixture backup/har/cherry-studio-fixture.json \
  --profile cherry-studio \
  --model deepseek-v4-flash
```

Use `--dry-run` to check profile, model, and fixture selection without live requests. If the fixture file exists, dry-run parses the fixture schema and reports `fixtureExists` plus `scenarioCount`; if it is missing, dry-run still exits successfully with `fixtureExists: false`.

## Profiles

- `cherry-studio`: Cherry Studio headers and visible prompt-tool-use expectations.
- `openai-tools`: generic OpenAI-compatible tool-calling expectations.
- `custom-har`: empty client headers for replaying sanitized HAR-derived fixtures.
