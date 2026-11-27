#!/bin/bash
# Runs a check that needs an EMPTY database on this machine, outside the check containers, against any PostgreSQL
# you can reach as a superuser (it also needs pg_dump, pg_restore and psql for dataflow.ts):
#   PG=postgres://postgres:postgres@127.0.0.1:5432 bash tests/local/checks/datalocal.sh dataflow.ts
# Same steps as freshdb.sh: make a database, apply every migration, run the check, drop the database.
set -u
HERE=$(cd "$(dirname "$0")" && pwd)
REPO=$(cd "$HERE/../../.." && pwd)
PG=${PG:-postgres://postgres:postgres@127.0.0.1:5432}
CHECK=${1:-dataflow.ts}
NAME=dbbkp_local_$(basename "$CHECK" .ts)
admin() { (cd "$REPO/packages/db" && node -e 'const sql=require("postgres")(process.argv[1]+"/postgres",{max:1,onnotice:()=>{}});sql.unsafe(process.argv[2]).then(()=>sql.end()).catch(e=>{console.log("FAIL  "+e.message);process.exit(1)})' "$PG" "$1"); }
admin "DROP DATABASE IF EXISTS $NAME" && admin "CREATE DATABASE $NAME" || exit 1
(cd "$REPO/packages/db" && DATABASE_URL=$PG/$NAME npx drizzle-kit migrate >/tmp/$NAME-migrate.log 2>&1) || { echo "FAIL  migrations did not apply (see /tmp/$NAME-migrate.log)"; exit 1; }
# run it from inside apps/api, so its imports resolve the way they do in the check container
COPY="$REPO/apps/api/.local-check-$CHECK"
cp "$HERE/$CHECK" "$COPY"
(cd "$REPO/apps/api" && DATABASE_URL=$PG/$NAME npx tsx "$COPY" 2>&1 | grep -E "PASS|FAIL|CRASH|holds")
STATUS=${PIPESTATUS[0]}
rm -f "$COPY"
admin "DROP DATABASE IF EXISTS $NAME"
exit $STATUS
