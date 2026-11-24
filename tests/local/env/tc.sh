#!/bin/bash
cd /work/apps/api && npx tsc --noEmit > /work/_tsc_api.log 2>&1; echo "api_exit=$? errors=$(grep -c 'error TS' /work/_tsc_api.log)"
cd /work/apps/worker && npx tsc --noEmit > /work/_tsc_worker.log 2>&1; echo "worker_exit=$? errors=$(grep -c 'error TS' /work/_tsc_worker.log)"
echo ---API; cut -c1-300 /work/_tsc_api.log | head -${1:-40}
echo ---WORKER; cut -c1-300 /work/_tsc_worker.log | head -${1:-40}