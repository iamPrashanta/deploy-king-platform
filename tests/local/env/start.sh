#!/bin/bash
# (re)start api + worker in the background; the panel is started separately by panel.sh / pstart.sh
for p in $(ps -eo pid,args | grep -E 'tsx.*src/index.ts' | grep -v grep | awk '{print $1}'); do kill -9 $p 2>/dev/null; done
sleep 1
cd /work/apps/api && nohup pnpm dev > /work/_api.log 2>&1 &
cd /work/apps/worker && nohup pnpm dev > /work/_worker.log 2>&1 &
for i in $(seq 1 40); do curl -s -m 2 http://localhost:4000/health >/dev/null && break; sleep 1; done
sleep 3
echo "--- api"; tail -n 12 /work/_api.log | cut -c1-200
echo "--- worker"; tail -n 8 /work/_worker.log | cut -c1-200
