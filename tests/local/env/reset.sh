#!/bin/bash
# fresh database + env + migration + seed
set -e
cd /work
cat > .env <<'ENV'
DATABASE_URL=postgres://postgres:postgres@dbbkp-check-pg:5432/dbbkp_panel
JWT_SECRET=check-jwt-secret-0123456789
INTERNAL_SECRET=check-internal-secret-0123456789
MASTER_KEY=0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef
REDIS_URL=redis://dbbkp-check-redis:6379
API_PORT=4000
API_INTERNAL_URL=http://localhost:4000
DBBKP_NETWORK=dbbkp-check-net
DBBKP_TLS=false
GITHUB_WEBHOOK_SECRET=check-webhook-secret
PIPELINE_ISOLATION=docker
RECONCILE_INTERVAL_MS=20000
DEPLOY_HEALTH_TIMEOUT_MS=60000
DBBKP_PUBLIC_HTTP_PORT=8088
ENV
export DATABASE_URL=postgres://postgres:postgres@dbbkp-check-pg:5432/dbbkp_panel
node -e '
const postgres = require("/work/packages/db/node_modules/postgres");
(async () => {
  const sql = postgres("postgres://postgres:postgres@dbbkp-check-pg:5432/postgres");
  await sql`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = ${"dbbkp_panel"}`;
  await sql.unsafe("DROP DATABASE IF EXISTS dbbkp_panel");
  await sql.unsafe("CREATE DATABASE dbbkp_panel");
  await sql.end();
  console.log("database recreated");
})().catch((e) => { console.error(e); process.exit(1); });
'
rm -rf packages/db/drizzle && cp -r /src/packages/db/drizzle packages/db/
pnpm db:migrate 2>&1 | tail -1; echo
INITIAL_ADMIN_PASSWORD=Initial-Passw0rd-1 pnpm db:seed 2>&1 | grep -E "INITIALIZED|already|failed"
node -e '
const Redis = require("/work/apps/api/node_modules/ioredis");
const r = new Redis("redis://dbbkp-check-redis:6379"); r.flushall().then(() => { console.log("redis flushed"); r.quit(); });
'