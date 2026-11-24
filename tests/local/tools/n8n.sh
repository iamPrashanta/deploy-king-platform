#!/bin/bash
grep -n "n8n" /work/_worker.log | cut -c1-220
echo "--- api log (deletes / errors)"
grep -niE "delete|n8n|error" /work/_api.log | tail -15 | cut -c1-220
echo "--- audit"
cd /work/packages/db && node -e '
const postgres = require("postgres");
const sql = postgres("postgres://postgres:postgres@dbbkp-check-pg:5432/dbbkp_panel");
sql`select action, target_name, created_at from audit_logs order by created_at desc limit 8`.then(r=>{console.log(r.map(x=>x.action+" "+x.target_name+" "+x.created_at.toISOString()).join("\n")); return sql.end();}).catch(e=>{console.log(e.message); return sql.end();});
'
