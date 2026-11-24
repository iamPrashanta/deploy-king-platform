#!/bin/bash
# start the already-built panel on :3000 if it is not running
if curl -s -m 2 -o /dev/null http://localhost:3000/login; then echo "panel already up"; exit 0; fi
cd /work/apps/panel
NEXT_TELEMETRY_DISABLED=1 nohup npx next start -p 3000 -H 0.0.0.0 > /work/_panel.log 2>&1 &
for i in $(seq 1 30); do curl -s -m 2 -o /dev/null http://localhost:3000/login && break; sleep 1; done
echo "panel up: $(curl -s -m 3 -o /dev/null -w '%{http_code}' http://localhost:3000/login)"
