# Deploy King API. Build from the repository root:
#   docker build -f apps/api/Dockerfile -t deploy-king-api .
ARG NODE_IMAGE=node:22-alpine
ARG DOCKER_CLI_IMAGE=docker:29-cli

FROM ${DOCKER_CLI_IMAGE} AS dockercli

# ── 1. Install and copy out only what the API needs ─────────────────────────────
FROM ${NODE_IMAGE} AS build
# node-pty (the terminal) is compiled from source.
RUN apk add --no-cache python3 make g++ linux-headers git
RUN corepack enable
WORKDIR /repo
ENV CI=true PNPM_HOME=/pnpm
# The package store depends only on the lockfile, so this layer is reused until it changes.
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store pnpm config set store-dir /pnpm/store && pnpm fetch --ignore-scripts
COPY . .
# pnpm deploy copies the API and the workspace packages it uses (sources included) with
# production dependencies only.
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store pnpm config set store-dir /pnpm/store \
 && pnpm --filter @dbbkp/api --prod deploy /out \
 && cp -r scripts /out/scripts \
 && rm -f /out/Dockerfile \
 # node-pty ships Windows and macOS binaries (about 60 MB); the Linux one was just built.
 && rm -rf /out/node_modules/.pnpm/node-pty@*/node_modules/node-pty/prebuilds \
           /out/node_modules/.pnpm/node-pty@*/node_modules/node-pty/deps \
           /out/node_modules/.pnpm/node-pty@*/node_modules/node-pty/third_party

# ── 2. Runtime ──────────────────────────────────────────────────────────────────
FROM ${NODE_IMAGE}
# git: the Git page and commit details. bash, coreutils: helper scripts and disk usage. tini: reaps child processes.
RUN apk add --no-cache git bash coreutils tini ca-certificates openssh-client \
 && npm install -g tsx@4.23.15 \
 && npm cache clean --force
# The terminal runs `docker exec` through the Docker socket.
COPY --from=dockercli /usr/local/bin/docker /usr/local/bin/docker
WORKDIR /app
COPY --from=build /out /app
ENV NODE_ENV=production \
    API_PORT=4000 \
    SITES_ROOT=/var/www/sites \
    SCRIPTS_DIR=/app/scripts \
    DB_MIGRATIONS_DIR=/app/node_modules/@dbbkp/db/drizzle
EXPOSE 4000
HEALTHCHECK --interval=15s --timeout=5s --start-period=60s --retries=5 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.API_PORT||4000)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["tsx", "src/index.ts"]
