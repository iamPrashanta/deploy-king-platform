#!/bin/bash
# The container stack end to end: deploy/compose.yml (or an install by scripts/install.sh) that is already up.
#   bash tests/local/checks/composecheck.sh
# It checks the API's /health, signs in through the panel with the first admin's password, changes it,
# uploads a small ZIP app, waits for the deploy and opens the app through Traefik. Then it deletes the app.
# Needs curl and python3. Settings (defaults in brackets):
#   PANEL       the panel's address                       [http://127.0.0.1:3000]
#   API         the API's own address, for /health        [http://127.0.0.1:4000]
#   TRAEFIK     the proxy's HTTP address                  [http://127.0.0.1:80]
#   ADMIN_USER  [admin]   ADMIN_PASS  the first admin's password (required)
#   NEW_PASS    the password it is changed to             [Compose-Check-Passw0rd-1]
#   DOMAIN      the base domain apps get                  [localhost]
PANEL=${PANEL:-http://127.0.0.1:3000}; API=${API:-http://127.0.0.1:4000}; TRAEFIK=${TRAEFIK:-http://127.0.0.1:80}
ADMIN_USER=${ADMIN_USER:-admin}; NEW_PASS=${NEW_PASS:-Compose-Check-Passw0rd-1}; DOMAIN=${DOMAIN:-localhost}
[[ -n "$ADMIN_PASS" ]] || { echo "FAIL  set ADMIN_PASS to the first admin's password"; exit 1; }
failed=0
pass() { echo "PASS  $1"; }
fail() { echo "FAIL  $1"; failed=1; }
json() { python3 -c "import sys,json; d=json.load(sys.stdin); print(eval(sys.argv[1]))" "$1" 2>/dev/null; }
trpc_m() { curl -s -X POST "$PANEL/trpc/$1" -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' -d "$2"; }
trpc_q() { curl -s -G "$PANEL/trpc/$1" -H "authorization: Bearer $TOKEN" --data-urlencode "input=$2"; }
login() { curl -s "$PANEL/api/auth/login" -H 'content-type: application/json' -d "{\"username\":\"$ADMIN_USER\",\"password\":\"$1\"}"; }

# 1. health
h=$(curl -s -m 5 "$API/health")
[[ $(json "d['status']" <<<"$h") == ok ]] && pass "the API answers /health" || fail "the API answers /health ($h)"

# 2. the first admin, through the panel's address
r=$(login "$ADMIN_PASS"); TOKEN=$(json "d['token']" <<<"$r")
if [[ -n "$TOKEN" ]]; then
  pass "the first admin signs in with the password from the install"
  if [[ $(json "d['user']['mustChangePassword']" <<<"$r") == True ]]; then
    pass "it is asked to change that password"
    trpc_m auth.changePassword "{\"newPassword\":\"$NEW_PASS\"}" >/dev/null
  fi
elif [[ -n $(json "d['token']" <<<"$(login "$NEW_PASS")") ]]; then
  pass "the admin signs in (the password was already changed by an earlier run)"
else
  fail "the first admin signs in ($r)"; exit 1
fi
TOKEN=$(json "d['token']" <<<"$(login "$NEW_PASS")")
[[ -n "$TOKEN" ]] && pass "the changed password works" || { fail "sign-in with the changed password"; exit 1; }

# 3. a ZIP app
NAME="zipcheck$RANDOM"; MARK="deploy-king-zip-check-$RANDOM$RANDOM"; T=$(mktemp -d)
python3 - "$T/app.zip" "$MARK" <<'PY'
import sys, zipfile
with zipfile.ZipFile(sys.argv[1], "w") as z:
    z.writestr("site/index.html", f"<!doctype html><title>check</title><p>{sys.argv[2]}</p>\n")
PY
up=$(curl -s "$PANEL/api/sites/upload" -H "authorization: Bearer $TOKEN" -F "project=@$T/app.zip" -F "domain=$NAME.$DOMAIN" -F "type=static")
SITE=$(json "d['siteId']" <<<"$up"); DEP=$(json "d['deploymentId']" <<<"$up")
[[ -n "$DEP" ]] && pass "the ZIP upload is accepted" || { fail "the ZIP upload ($up)"; exit 1; }

status=""
for _ in $(seq 1 90); do
  status=$(trpc_q sites.deployment "{\"deploymentId\":\"$DEP\"}" | json "d['result']['data']['status']")
  [[ "$status" == active || "$status" == failed || "$status" == cancelled ]] && break
  sleep 2
done
[[ "$status" == active ]] && pass "the deploy finishes (status: $status)" || {
  fail "the deploy finishes (status: ${status:-unknown})"
  trpc_q sites.deployment "{\"deploymentId\":\"$DEP\"}" | json "d['result']['data']['log'][-1500:]" | sed 's/^/        /'
}

body=""
for _ in $(seq 1 15); do
  body=$(curl -s -m 5 -H "Host: $NAME.$DOMAIN" "$TRAEFIK/")
  grep -q "$MARK" <<<"$body" && break
  sleep 2
done
grep -q "$MARK" <<<"$body" && pass "the app answers through Traefik at $NAME.$DOMAIN" || fail "the app answers through Traefik (got: ${body:0:120})"

# 4. clean up
[[ -n "$SITE" ]] && trpc_m sites.delete "{\"id\":\"$SITE\"}" >/dev/null
rm -rf "$T"
[[ $failed == 0 ]] && echo "compose check holds"
exit $failed
