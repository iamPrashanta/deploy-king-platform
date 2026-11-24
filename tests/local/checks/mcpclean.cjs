// clear test agent tokens and their activity from the check database
const postgres = require("/work/packages/db/node_modules/postgres");
(async () => {
  const sql = postgres("postgres://postgres:postgres@dbbkp-check-pg:5432/dbbkp_panel");
  const calls = await sql`delete from mcp_calls returning id`;
  const toks = await sql`delete from api_tokens returning id`;
  console.log("removed calls:", calls.length, "tokens:", toks.length);
  await sql.end();
})();
