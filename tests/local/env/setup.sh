#!/bin/bash
# Bring a new (or recreated) test container to a working state: code, packages, a fresh database with the two
# test users, fixtures, then API, worker and panel. Safe to run again; it starts from an empty database each time.
set -e
bash /src/tests/local/env/pull.sh
echo "== code and packages"; bash /t/sync.sh install
echo "== database"; bash /t/reset.sh
echo "== api and worker"; bash /t/start.sh > /dev/null 2>&1
curl -s -m 5 -o /dev/null -w 'api %{http_code}\n' http://localhost:4000/health
echo "== test users"; node /t/firstlogin.mjs; bash /t/bob.sh
echo "== fixtures"; bash /t/fixtures.sh > /dev/null 2>&1; ls /tmp/z/*.zip | wc -l
echo "== panel"; bash /t/panel.sh
echo "== ready: panel http://localhost:3900 (admin / Check-Passw0rd-12345), apps on http://<name>.localhost:8088"
