# Chat2API Docker Server Design

## Background

Chat2API is currently packaged as an Electron desktop application. The proxy itself is already a Koa service under `src/main/proxy`, and the project already has a management API under `src/main/proxy/routes/management`. That makes a server deployment realistic without rewriting provider forwarding logic.

The blocking issue is not the proxy architecture. The blocking issue is that several shared modules import Electron APIs directly:

- `src/main/index.ts` starts the Electron app.
- `src/preload/index.ts` exposes IPC to the renderer.
- `src/main/ipc/handlers.ts` bridges the desktop UI to store, proxy, OAuth, logs, and settings.
- `src/main/store/store.ts` imports `app`, `safeStorage`, and `BrowserWindow` from Electron.
- `src/main/lib/challenge.ts` uses `app.isPackaged` and `app.getAppPath()` to locate the DeepSeek WASM file.
- `src/main/proxy/adapters/perplexity.ts` imports `net` from Electron.
- `src/main/oauth/*` contains browser-window and `shell.openExternal` flows.
- `src/main/window`, `src/main/tray`, and `src/main/updater` are desktop-only.

The Docker version should reuse the proxy and provider code while keeping all server-specific changes isolated. This is important because upstream source updates should remain easy to pull and rebase.

## Goals

1. Add a Docker/server runtime that runs without Electron.
2. Preserve the existing Electron desktop application.
3. Reuse the existing Koa proxy, management API, provider configs, adapters, account model, load balancer, sessions, request logs, and statistics.
4. Support Qwen multi-account management through the existing management API.
5. Make future upstream updates easy by isolating Docker-specific code and minimizing edits to upstream-owned provider logic.
6. Provide clear Docker usage documentation and a repeatable verification command set.

## Non-Goals

- Do not rewrite the React renderer into a web management UI in the first server version.
- Do not replace JSON storage with a database in the first server version.
- Do not remove Electron, IPC, tray, updater, or desktop login flows.
- Do not require browser automation inside the Docker image.
- Do not guarantee Perplexity parity until its Electron `net` usage is replaced and verified under Node.

## Recommended Approach

Build a server-only runtime beside the desktop runtime.

The server entrypoint lives under `src/server`. Electron-specific runtime functions are hidden behind small adapters under `src/main/runtime`. Server code imports the proxy server and store manager through the same business-layer APIs used today, but the runtime adapter supplies Node-compatible behavior for storage paths, encryption availability, browser opening, and resource lookup.

This approach is preferable to placing Electron in Docker because the image stays smaller, the runtime is easier to operate on a server, and upstream desktop code remains intact. It is also preferable to immediately converting the React renderer to a web UI because the management API already covers the operations needed for headless server use.

## Architecture

### Runtime Boundary

Add a runtime boundary:

```text
src/main/runtime/
  index.ts
  types.ts
  nodeRuntime.ts
  electronRuntime.ts
```

Responsibilities:

- Return the data directory.
- Report whether secure string encryption is available.
- Encrypt and decrypt strings.
- Resolve bundled resources such as `sha3_wasm_bg.7b9ca65ddd.wasm`.
- Open external URLs when a desktop runtime exists, or log/return the URL under server runtime.
- Provide a desktop window notification hook that is a no-op under server runtime.

The boundary keeps most future upstream changes away from Docker-specific code. If upstream changes provider behavior, the Docker version can usually pull those changes without touching `src/server` or `src/main/runtime`.

### Server Entrypoint

Add `src/server/index.ts`.

Responsibilities:

- Initialize the store.
- Apply server environment overrides.
- Ensure the management API can be enabled from environment variables.
- Start the proxy server on `CHAT2API_HOST` and `CHAT2API_PORT`.
- Flush logs and stop the proxy on `SIGINT` and `SIGTERM`.

The server entrypoint should not import Electron, renderer, preload, IPC, tray, updater, or window modules.

### Storage

Keep the existing data shape and default `StoreSchema`. In Docker, default storage path should be `/data`, configurable with `CHAT2API_DATA_DIR`.

The existing store uses `electron-store`. For the server version, use a Node-compatible store adapter. The first version can continue using the same JSON file structure through a small storage abstraction, rather than introducing SQLite or another database.

Recommended files:

```text
src/main/store/storage/
  types.ts
  electronJsonStore.ts
  nodeJsonStore.ts
```

The `StoreManager` should depend on this local interface instead of constructing `electron-store` directly. The Electron implementation can keep using `electron-store`; the Node implementation can persist `data.json` under `CHAT2API_DATA_DIR`.

### Environment Configuration

Server runtime should support:

```text
CHAT2API_HOST=0.0.0.0
CHAT2API_PORT=8080
CHAT2API_DATA_DIR=/data
CHAT2API_MANAGEMENT_SECRET=mgmt_change_me
CHAT2API_ENABLE_MANAGEMENT_API=true
CHAT2API_ENABLE_API_KEY=false
CHAT2API_API_KEYS=
CHAT2API_LOG_LEVEL=info
CHAT2API_LOAD_BALANCE_STRATEGY=round-robin
CHAT2API_STORAGE_ENCRYPTION_KEY=
```

If `CHAT2API_ENABLE_MANAGEMENT_API=true` and `CHAT2API_MANAGEMENT_SECRET` is set, the server should update config on boot so `/v0/management/*` is usable immediately.

### Provider Compatibility

Most adapters already use `axios` and should work in Node once store and runtime imports are fixed.

Known provider-specific work:

- DeepSeek: resolve WASM path without `electron.app`.
- Perplexity: replace `electron.net` with Node-compatible request code.
- OAuth manual adapters: replace `shell.openExternal` with runtime `openExternal`. Under Docker, return a login URL and require manual credentials.
- In-app OAuth: remain desktop-only. Server version should expose manual credential management through management API.

### Management API

The existing management API is the primary server administration surface. It already supports:

- provider listing and updates;
- account CRUD and validation;
- API key CRUD;
- model mappings with `preferredAccountId`;
- sessions;
- statistics;
- proxy status.

Docker documentation should show how to add multiple Qwen accounts:

```bash
curl -X POST http://localhost:8080/v0/management/accounts \
  -H "Authorization: Bearer $CHAT2API_MANAGEMENT_SECRET" \
  -H "Content-Type: application/json" \
  -d '{
    "providerId": "qwen",
    "name": "qwen-account-1",
    "credentials": {
      "ticket": "tongyi_sso_ticket_value"
    }
  }'
```

### Docker Packaging

Add:

```text
Dockerfile
.dockerignore
docker-compose.yml
docs/docker.md
```

The image should run the Node server entrypoint, expose port `8080`, and mount `/data`.

### Upstream Sync Strategy

The Docker layer must be easy to reapply after pulling upstream source updates.

Rules:

1. Keep server-only code in `src/server`.
2. Keep runtime shims in `src/main/runtime`.
3. Keep storage abstraction files under `src/main/store/storage`.
4. Avoid changing provider adapter behavior unless an adapter imports Electron directly.
5. Avoid changing Electron UI, IPC, tray, updater, and renderer files unless a shared type or build script requires it.
6. Keep Docker files at repository root and docs under `docs/docker.md`.
7. Add tests that fail if the server entrypoint or server bundle imports Electron.
8. Use environment bootstrapping instead of editing default provider definitions for server-only defaults.
9. When upstream changes providers, pull the upstream change first, then rerun the server compatibility tests before touching Docker code.

Future update flow:

```bash
git fetch upstream
git merge upstream/main
npm install
npm run test:server-compat
npm run build:server
docker build -t chat2api:server .
docker run --rm -p 8080:8080 -e CHAT2API_ENABLE_MANAGEMENT_API=true -e CHAT2API_MANAGEMENT_SECRET=mgmt_test chat2api:server
```

If conflicts occur, resolve them in this order:

1. Keep upstream provider logic.
2. Reapply runtime boundary imports only where Electron imports block Node.
3. Reapply server entrypoint and Docker scripts.
4. Run provider smoke tests through `/v1/models` and `/v1/chat/completions`.

## Testing Strategy

Add tests for:

- server entrypoint does not import Electron;
- server runtime resolves `/data` from environment;
- environment bootstrap enables management API and sets host/port;
- Node storage reads and writes provider, account, config, sessions, logs, and statistics data;
- Qwen account CRUD works through management API;
- model mapping can target a specific account;
- `/v1/models` returns models when accounts exist;
- `/health` reports running status;
- Docker image starts and responds to `/health`.

Live provider tests should remain opt-in because they require real credentials.

## Acceptance Criteria

1. `npm run build:server` produces a runnable Node server artifact without Electron.
2. `npm run start:server` starts the proxy service locally.
3. Docker image starts with `/data` mounted.
4. `/health` responds without authentication.
5. `/v0/management/accounts` works with `Authorization: Bearer <secret>`.
6. Multiple Qwen accounts can be added and selected by the load balancer.
7. Existing Electron build commands still work.
8. Server compatibility tests protect the Docker layer from accidental Electron imports.
