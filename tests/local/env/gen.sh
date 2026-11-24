#!/bin/bash
# generate the next drizzle migration from the synced schema, then apply it to the check database
set -e
bash /t/sync.sh >/dev/null
cd /work/packages/db
export DATABASE_URL=postgres://postgres:postgres@dbbkp-check-pg:5432/dbbkp_panel
npx drizzle-kit generate 2>&1 | tail -4
ls drizzle
pnpm db:migrate 2>&1 | tail -2
node -e '
const postgres = require("/work/packages/db/node_modules/postgres");
(async () => {
  const sql = postgres(process.env.DATABASE_URL);
  const t = await sql`select table_name from information_schema.tables where table_name in ('"'"'api_tokens'"'"','"'"'mcp_calls'"'"')`;
  console.log("tables:", t.map((r) => r.table_name).join(", "));
  await sql.end();
})();
'
