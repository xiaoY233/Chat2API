# Docker Browser-Assisted Account Import Plan

Goal: add a Docker-friendly account import flow that avoids DevTools token copying for web-admin users.

Scope:
- Keep Electron automatic in-app login unchanged.
- Do not add Playwright, Chromium, VNC, or a heavier Docker runtime.
- Add a browser-assisted flow for providers whose credentials are readable by page JavaScript after login, starting with Qwen AI international (`chat.qwen.ai`).
- Show clear limitations for domestic Qwen when the `tongyi_sso_ticket` cookie is not readable by JavaScript.

Architecture:
- Web admin creates a short-lived import session in the browser adapter.
- The add-account dialog generates a JavaScript snippet that the user runs on the already logged-in provider page.
- The snippet reads provider-side storage/cookies and posts the credentials back to `/v0/management/browser-import/complete`.
- The add-account dialog polls `/v0/management/browser-import/:id` and fills the existing credential form when credentials arrive.
- Credentials are still validated and saved by the existing account APIs.

Files:
- `src/renderer/src/web-admin-api.ts`: expose `browserImport` methods and maintain browser-side session IDs.
- `src/renderer/src/types/electron.d.ts`: type the new web-admin-only API.
- `src/renderer/src/components/providers/AddAccountDialog.tsx`: replace misleading Docker OAuth pane with browser-assisted import.
- `src/main/proxy/routes/management/statistics.ts`: add provider-scoped import completion endpoint.
- `tests/server/web-admin-electron-api-contract.test.mjs`: assert the API contract and generated script markers.
- `tests/server/browser-import-routes.test.mjs`: assert route shape and provider validation.
- `docs/docker.md`: document the new Qwen AI browser import flow.

Behavior:
- For `qwen-ai`, generated script collects `localStorage.token` and `document.cookie`, then posts `{ providerId: "qwen-ai", credentials: { token, cookies } }`.
- For `qwen`, generated script attempts to read `tongyi_sso_ticket` from `document.cookie`; if it cannot, it reports a clear error that the cookie is likely HttpOnly and manual cookie extraction is still required.
- The Docker UI labels this as browser-assisted import, not OAuth automatic login.
- Electron UI keeps the current OAuth tab and automatic login behavior.

Verification:
- Run the targeted server tests.
- Run `npm run build:server`.
- Rebuild Docker image.
- Restart `chat2api` container.
- Smoke-test `/admin/` and `/v0/management/health`.
