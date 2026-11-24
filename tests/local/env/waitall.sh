#!/bin/bash
# wait (up to the given seconds, default 160) for all.sh to finish, then show the result
for i in $(seq 1 $(( ${1:-160} / 5 ))); do grep -q '=== finished' /tmp/all.log 2>/dev/null && break; sleep 5; done
echo "pass=$(grep -c PASS /tmp/all.log) fail=$(grep -c FAIL /tmp/all.log) finished=$(grep -c '=== finished' /tmp/all.log)"
grep -E '^===|FAIL|ERRORS|error' /tmp/all.log | tail -${2:-30}
