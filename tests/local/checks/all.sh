#!/bin/bash
# run every local check in turn; results go to /tmp/all.log (PASS / FAIL lines)
cd /tmp/shot
echo "=== fitunit.ts"
(cd /work/apps/api && DATABASE_URL=postgres://postgres:postgres@dbbkp-check-pg:5432/dbbkp_panel npx tsx /t/fitunit.ts 2>&1 | grep -E "PASS|FAIL")
echo "=== cleanunit.ts"
(cd /work/apps/api && DATABASE_URL=postgres://postgres:postgres@dbbkp-check-pg:5432/dbbkp_panel npx tsx /t/cleanunit.ts 2>&1 | grep -E "PASS|FAIL")
echo "=== installcheck.sh"
bash /t/installcheck.sh
echo "=== hostscan_check.py"
if command -v python3 >/dev/null; then python3 /t/hostscan_check.py; python3 /t/hostact_check.py; else echo "NOTE  python3 is not in this container; run tests/local/checks/hostscan_check.py on the host"; fi
echo "=== watchunit.ts"
(cd /work/apps/api && DATABASE_URL=postgres://postgres:postgres@dbbkp-check-pg:5432/dbbkp_panel npx tsx /t/watchunit.ts 2>&1 | grep -E "PASS|FAIL")
echo "=== scheduleunit.ts"
(cd /work/apps/api && npx tsx /t/scheduleunit.ts 2>&1 | grep -E "PASS|FAIL")
echo "=== teamunit.ts"
(cd /work/apps/api && npx tsx /t/teamunit.ts 2>&1 | grep -E "PASS|FAIL")
for t in teamflow.ts accessflow.ts cleanapi.ts watchflow.ts actflow.ts jobsflow.ts assistantflow.ts; do
  echo "=== $t"
  bash /t/freshdb.sh $t
done
for t in capacity.mjs fitui.mjs crashloop.mjs rootdir.mjs wf3.mjs rootui.mjs wf.mjs wf2.mjs "mcp.mjs http://localhost:3000" mcp2.mjs agents.mjs; do
  echo "=== $t"
  timeout 900 node /t/$t 2>&1 | grep -E "PASS|FAIL|NOTE|ERRORS|error|pageerror" | cut -c1-170
done
node /t/wfclean.mjs
node /t/mcpclean.cjs
echo "=== finished"
