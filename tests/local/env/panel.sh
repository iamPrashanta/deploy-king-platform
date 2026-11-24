#!/bin/bash
# production build of the panel, then serve it on :3000 (forwarded to Windows :3900)
cd /work/apps/panel
for p in $(ps -eo pid,args | grep -E 'next (dev|start|build)|next-server|next-router-worker' | grep -v grep | awk '{print $1}'); do kill -9 $p 2>/dev/null; done
rm -rf .next
if NEXT_TELEMETRY_DISABLED=1 npx next build > /work/_panel_build.log 2>&1; then
  echo "build ok"
  NEXT_TELEMETRY_DISABLED=1 nohup npx next start -p 3000 -H 0.0.0.0 > /work/_panel.log 2>&1 &
  for i in $(seq 1 30); do curl -s -m 2 -o /dev/null http://localhost:3000/login && break; sleep 1; done
  echo "panel up: $(curl -s -m 3 -o /dev/null -w '%{http_code}' http://localhost:3000/login)"
else
  echo "build FAILED"
  grep -v '^\s*$' /work/_panel_build.log | tail -40 | cut -c1-300
fi
