# Deploy King worker: deploys, scheduled jobs, workers sync. Build from the repository root:
#   docker build -f apps/worker/Dockerfile -t deploy-king-worker .
ARG NODE_IMAGE=node:22-alpine
ARG DOCKER_CLI_IMAGE=docker:29-cli

FROM ${DOCKER_CLI_IMAGE} AS dockercli

# ── 1. Install and copy out only what the worker needs ──────────────────────────
FROM ${NODE_IMAGE} AS build
RUN apk add --no-cache python3 make g++ linux-headers git
RUN corepack enable
WORKDIR /repo
ENV CI=true PNPM_HOME=/pnpm
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store pnpm config set store-dir /pnpm/store && pnpm fetch --ignore-scripts
COPY . .
# The root postinstall (sync-scripts.js) downloads newer copies of two scripts and leaves them empty
# when it cannot; the image keeps the scripts of this checkout.
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store pnpm config set store-dir /pnpm/store \
 && cp -r scripts /tmp/dk-scripts \
 && pnpm --filter @dbbkp/worker --prod deploy /out \
 && cp -r /tmp/dk-scripts /out/scripts \
 && rm -f /out/Dockerfile

# ── 2. Runtime ──────────────────────────────────────────────────────────────────
FROM ${NODE_IMAGE}
# git: deploys clone repositories. bash: the job scripts. tini: reaps child processes.
# pg_dump, pg_restore, psql: database backups (the client must be at least as new as the server: 16).
# rclone: backups sent off this server.
RUN apk add --no-cache git bash coreutils tar tini ca-certificates openssh-client postgresql16-client rclone \
 && npm install -g tsx@4.23.15 \
 && npm cache clean --force
# Builds and app containers go through the Docker socket; pipelines also call the docker CLI.
COPY --from=dockercli /usr/local/bin/docker /usr/local/bin/docker
WORKDIR /app
COPY --from=build /out /app
ENV NODE_ENV=production \
    SITES_ROOT=/var/www/sites \
    SCRIPTS_DIR=/app/scripts \
    HEARTBEAT_FILE=/tmp/dk-worker-alive \
    DK_BACKUP_DIR=/var/backups/dbbkp
# Healthy while the worker reaches Redis and the database (src/heartbeat.ts writes the file every 20 s).
HEALTHCHECK --interval=20s --timeout=5s --start-period=60s --retries=3 \
  CMD [ -f /tmp/dk-worker-alive ] && [ $(( $(date +%s) - $(stat -c %Y /tmp/dk-worker-alive) )) -lt 90 ]
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["tsx", "src/index.ts"]
