# syntax=docker/dockerfile:1.7

FROM node:22-bookworm AS build

WORKDIR /workspace

COPY headless/package.json headless/package-lock.json ./headless/
RUN npm ci --prefix headless --no-audit --no-fund

COPY src ./src
COPY sha3_wasm_bg.7b9ca65ddd.wasm ./sha3_wasm_bg.7b9ca65ddd.wasm
COPY headless/build.mjs headless/tsconfig.json ./headless/
COPY headless/src ./headless/src
COPY headless/patches ./headless/patches

RUN npm run build --prefix headless \
 && test -s headless/dist/server.js \
 && test -s headless/dist/chat2api-ctl.js \
 && test -s headless/dist/resources/sha3_wasm_bg.7b9ca65ddd.wasm

FROM node:22-bookworm-slim AS runtime

ARG APP_VERSION=dev
ARG UID=10001
ARG GID=10001

LABEL org.opencontainers.image.title="Chat2API Headless" \
      org.opencontainers.image.description="Headless compatibility runtime for Chat2API" \
      org.opencontainers.image.version="${APP_VERSION}" \
      org.opencontainers.image.source="https://github.com/xiaoY233/Chat2API"

RUN groupadd --gid "${GID}" chat2api \
 && useradd --uid "${UID}" --gid "${GID}" --home-dir /var/lib/chat2api --create-home chat2api \
 && install -d -o chat2api -g chat2api -m 0700 /var/lib/chat2api/.chat2api /app/resources

COPY --from=build --chown=chat2api:chat2api /workspace/headless/dist/server.js /app/server.js
COPY --from=build --chown=chat2api:chat2api /workspace/headless/dist/server.js.map /app/server.js.map
COPY --from=build --chown=chat2api:chat2api /workspace/headless/dist/chat2api-ctl.js /app/chat2api-ctl.js
COPY --from=build --chown=chat2api:chat2api /workspace/headless/dist/chat2api-ctl.js.map /app/chat2api-ctl.js.map
COPY --from=build --chown=chat2api:chat2api /workspace/headless/dist/resources /app/resources

RUN chmod 0755 /app/chat2api-ctl.js \
 && ln -s /app/chat2api-ctl.js /usr/local/bin/chat2api-ctl

USER chat2api
WORKDIR /var/lib/chat2api

ENV NODE_ENV=production \
    NODE_OPTIONS=--max-old-space-size=768 \
    HOME=/var/lib/chat2api \
    CHAT2API_DATA_DIR=/var/lib/chat2api/.chat2api \
    CHAT2API_HEADLESS=1 \
    CHAT2API_RESOURCE_DIR=/app/resources \
    CHAT2API_HOST=0.0.0.0 \
    CHAT2API_PORT=8080 \
    CHAT2API_SHUTDOWN_TIMEOUT=20000

EXPOSE 8080
VOLUME ["/var/lib/chat2api/.chat2api"]

CMD ["node", "--enable-source-maps", "/app/server.js"]
