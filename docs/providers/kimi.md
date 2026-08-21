# Kimi

| Item | Value |
| --- | --- |
| Provider ID | `kimi` |
| Website | https://www.kimi.com |
| API base | https://www.kimi.com |
| Authentication | JWT access token or refresh token |

## Default models

| Display name | Public model key |
| --- | --- |
| Kimi-K2.6 | `k2d6` |
| Kimi-K3 | `k3` |

The current Kimi model metadata endpoint exposes K2.6 as `k2d6`. The chat
endpoint selects the internal `SCENARIO_K2D5` scenario for that model; this
internal scenario name must not be presented as the public K2.5 model name.
Older clients that send `Kimi-K2.5` or `k2d5` are normalized to K2.6 for
backward compatibility.

K3 Normal uses `SCENARIO_OK_COMPUTER`, `kimiplus_id=ok-computer`, and the
large context/reasoning options. K3 Swarm is a separate parallel-agent mode
and is not advertised as a normal chat model until its response protocol is
fully supported.

## Authentication

Desktop users can enter a Kimi access token or refresh token. Docker users can
use the browser-assisted import flow from the account dialog while logged in
at `www.kimi.com`. The import flow also preserves request identifiers such as
`webId`, `ssid`, and `trafficId` when they are available.

## Tutorial

1. Log in at `www.kimi.com`.
2. Add a Kimi account in Chat2API and enter an access or refresh token.
3. For Docker, run the generated browser-import script in the logged-in Kimi
   page console, then return to the account dialog.

## Supported features

- Connect JSON streaming and non-streaming chat
- Multi-turn conversations using `conversation_id`/`chat_id` and
  `parent_message_id`/`parent_id`
- Thinking and web-search request options
- Automatic access-token refresh when a refresh token is available
- Account-level conversation cleanup
