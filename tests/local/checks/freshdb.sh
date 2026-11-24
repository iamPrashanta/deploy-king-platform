#!/bin/bash
# Runs a check that needs an EMPTY database: creates one, applies every migration, runs the check, drops it.
#   bash /t/freshdb.sh teamflow.ts
PG=postgres://postgres:postgres@dbbkp-check-pg:5432
NAME=dbbkp_check_$(basename "$1" .ts)
cd /work/packages/db
admin() { node -e 'const sql=require("postgres")(process.argv[1]+"/postgres",{max:1});sql.unsafe(process.argv[2]).then(()=>sql.end()).catch(e=>{console.log("FAIL  "+e.message);process.exit(1)})' "$PG" "$1"; }
admin "DROP DATABASE IF EXISTS $NAME" && admin "CREATE DATABASE $NAME" || exit 1
DATABASE_URL=$PG/$NAME npx drizzle-kit migrate >/tmp/$NAME-migrate.log 2>&1 || { echo "FAIL  migrations did not apply (see /tmp/$NAME-migrate.log)"; exit 1; }
(cd /work/apps/api && DATABASE_URL=$PG/$NAME npx tsx /t/$1 2>&1 | grep -E "PASS|FAIL|CRASH|holds")
admin "DROP DATABASE IF EXISTS $NAME"
