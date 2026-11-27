# Deploy King panel (Next.js, standalone server). Build from the repository root:
#   docker build -f apps/panel/Dockerfile -t deploy-king-panel .
ARG NODE_IMAGE=node:22-alpine

# ── 1. Build ────────────────────────────────────────────────────────────────────
FROM ${NODE_IMAGE} AS build
RUN corepack enable
WORKDIR /repo
ENV CI=true PNPM_HOME=/pnpm NEXT_TELEMETRY_DISABLED=1
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store pnpm config set store-dir /pnpm/store && pnpm fetch --ignore-scripts
COPY . .
# The panel imports the API's types, so the API's packages are installed too (no scripts: nothing native is needed).
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store pnpm config set store-dir /pnpm/store \
 && pnpm install --frozen-lockfile --offline --ignore-scripts --filter "@dbbkp/panel..." --filter "@dbbkp/api..."
# Rewrites are fixed at build time; this address is replaced at start when API_INTERNAL_URL differs.
ENV NEXT_OUTPUT=standalone API_INTERNAL_URL=http://dbbkp-api:4000
RUN pnpm --filter @dbbkp/panel build \
 && cp -r apps/panel/.next/static apps/panel/.next/standalone/apps/panel/.next/static \
 && cp apps/panel/.next/standalone/apps/panel/.next/routes-manifest.json apps/panel/.next/standalone/apps/panel/.next/routes-manifest.build.json

# ── 2. Runtime ──────────────────────────────────────────────────────────────────
FROM ${NODE_IMAGE}
RUN apk add --no-cache tini
WORKDIR /app
COPY --from=build /repo/apps/panel/.next/standalone /app
COPY apps/panel/docker-entrypoint.sh /usr/local/bin/dk-panel-start
RUN chmod +x /usr/local/bin/dk-panel-start && chown -R node:node /app/apps/panel/.next
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 \
    PORT=3000 HOSTNAME=0.0.0.0 \
    API_INTERNAL_URL=http://dbbkp-api:4000
USER node
EXPOSE 3000
HEALTHCHECK --interval=15s --timeout=5s --start-period=30s --retries=5 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/login').then(r=>process.exit(r.status<500?0:1)).catch(()=>process.exit(1))"
ENTRYPOINT ["/sbin/tini", "--", "dk-panel-start"]
CMD ["node", "apps/panel/server.js"]
