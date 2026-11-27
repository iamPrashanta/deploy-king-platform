#!/bin/bash
# The installer's check of a used server, on made-up servers. Needs only bash; no root, no containers.
#   bash tests/local/checks/installcheck.sh        (from the repository root, on Linux or WSL)
# It runs the read-only part of scripts/install.sh (what is found, the mode, the plan, the side-by-side files)
# with fake `ss`, `free`, `df` and `nginx` commands in front of the real ones.
S="$(cd "$(dirname "$0")/../../.." && pwd)/scripts/install.sh"
[[ -f "$S" ]] || S=/work/scripts/install.sh   # inside the local test container the checks sit in /t
T=$(mktemp -d); mkdir -p $T/bin $T/web $T/nginx $T/psa $T/opt $T/opt2 $T/again $T/again2
# an earlier install: its .env says which mode and ports it chose
printf 'DK_INSTALL_MODE=clean\nTRAEFIK_HTTP_PORT=80\nTRAEFIK_HTTPS_PORT=443\n' > $T/again/.env
printf 'DK_INSTALL_MODE=existing-panel\nTRAEFIK_HTTP_PORT=8088\nTRAEFIK_HTTPS_PORT=8444\n' > $T/again2/.env
cat > $T/bin/ss <<'X'
#!/bin/bash
echo 'LISTEN 0 128 0.0.0.0:22 0.0.0.0:* users:(("sshd",pid=700,fd=3))'
[[ -n "$OWNPROXY" ]] && printf '%s\n' 'LISTEN 0 4096 0.0.0.0:80 0.0.0.0:* users:(("docker-proxy",pid=1500,fd=7))' 'LISTEN 0 4096 0.0.0.0:443 0.0.0.0:* users:(("docker-proxy",pid=1510,fd=7))'
[[ -n "$BUSY" ]] && printf '%s\n' 'LISTEN 0 511 0.0.0.0:80 0.0.0.0:* users:(("nginx",pid=911,fd=6),("nginx",pid=910,fd=6))' 'LISTEN 0 511 [::]:443 [::]:* users:(("nginx",pid=911,fd=7))' 'LISTEN 0 80 127.0.0.1:3306 0.0.0.0:* users:(("mysqld",pid=1200,fd=22))'
exit 0
X
printf '#!/bin/bash\necho "Mem: ${RAM:-3900} 1000"\n' > $T/bin/free
printf '#!/bin/bash\necho header\necho "/dev/sda1 80G 30G ${DISKFREE:-50}G 38%% /"\n' > $T/bin/df
printf '#!/bin/bash\nexit 0\n' > $T/web/nginx
printf '#!/bin/bash\nexit 0\n' > $T/bin/docker
chmod +x $T/bin/* $T/web/*
printf 'server {\n  server_name shop.example.com www.shop.example.com;\n}\nserver {\n  server_name _;\n}\n' > $T/nginx/shop
{ echo 'set -Eeo pipefail'
  sed -n '/^# ─── Logging/,/^# ─── Root check/p' "$S" | sed '$d'
  echo 'LOG_FILE=/dev/null; INSTALL_DIR=${IDIR:-'"$T/opt2"'}; APP_USER=dbbkp; USER_DOMAIN="${DOM:-}"'
  echo 'INSTALL_MODE="${MODE:-}"; DRY_RUN=${DRY:-false}; FORCE=${FORCE_:-false}; ASSUME_YES=${YES:-false}'
  sed -n '/Resource checks/,/^ok "Install mode:/p' "$S" | sed 's#/etc/nginx/sites-enabled#${NGX:-/nonexistent}#; s#/usr/local/psa#${PSA:-/nonexistent}#'
  echo 'TRAEFIK_HTTP=8088; TRAEFIK_HTTPS=8444'
  sed -n '/^# ── The plan, and one question/,/^# PHASE 3/p' "$S" | sed '$d' | sed '$d'
  sed -n '/^# ── Side by side: how the existing/,/^# PHASE 12/p' "$S" | sed '$d' | sed '$d'
  echo 'echo "REACHED mode=$INSTALL_MODE"'
} > $T/run.sh
failed=0
# check <label> <expected exit> <text that must appear> <text that must not appear, or -> [VAR=value ...]
check() {
  local label=$1 want=$2 has=$3 hasnt=$4; shift 4
  local out code
  out=$(env PATH="$T/bin:$PATH" "$@" bash $T/run.sh </dev/null 2>&1); code=$?
  out=$(sed 's/\x1b\[[0-9;]*m//g' <<<"$out")
  if [[ $code == "$want" ]] && grep -qF -- "$has" <<<"$out" && { [[ $hasnt == - ]] || ! grep -qF -- "$hasnt" <<<"$out"; }; then echo "PASS  $label"
  else echo "FAIL  $label  | exit $code"; echo "$out" | tail -6 | sed 's/^/        /'; failed=1; fi
}
check "a fresh server installs clean and takes 80 and 443"        0 "REACHED mode=clean"            "SIDE BY SIDE"      YES=true
check "a web server on port 80 means side by side"                0 "Port 80       : used by nginx" "Take ports 80"     YES=true BUSY=1
check "side by side says 80 and 443 are not touched"              0 "Ports 80 and 443 are NOT touched" -                YES=true BUSY=1
check "a database already running is named, and left alone"       0 "MySQL/MariaDB on port 3306"    -                   YES=true BUSY=1
check "a web server that is installed but stopped still counts"   0 "REACHED mode=existing-panel"   -                   YES=true PATH="$T/web:$T/bin:$PATH" NGX=$T/nginx IDIR=$T/opt DOM=king.dev
check "existing sites are listed by name"                         0 "shop.example.com"              "example _"         YES=true PATH="$T/web:$T/bin:$PATH" NGX=$T/nginx IDIR=$T/opt2
check "another control panel stops the install"                   1 "Nothing has been changed"      "REACHED"           YES=true PSA=$T/psa
check "--force installs next to it, side by side"                 0 "REACHED mode=existing-panel"   -                   YES=true PSA=$T/psa FORCE_=true
check "--mode clean is refused while port 80 is taken"            1 "used by nginx"                 "REACHED"           YES=true BUSY=1 MODE=clean
check "a small server gets a note in the plan"                    0 "Memory is 1500 MB"             -                   YES=true RAM=1500
check "too little memory stops before anything else"              1 "Insufficient RAM"              "Found on this"     YES=true RAM=600
check "no terminal and no --yes: it stops, it does not guess"     1 "Re-run with --yes"             "REACHED"
check "a dry run shows the plan without asking"                   0 "REACHED mode=existing-panel"   -                   DRY=true BUSY=1
check "it builds the images from source by default"               0 "build its images on this server" "ghcr.io"         YES=true
check "--images ghcr downloads the published images instead"      0 "Download the Deploy King images" "build its images" YES=true IMAGES=ghcr GHCR_PREFIX=ghcr.io/x/deploy-king
check "a second run: its own proxy on 80 and 443 is not a stranger" 0 "REACHED mode=clean"         "SIDE BY SIDE"      YES=true OWNPROXY=1 IDIR=$T/again
check "a second run keeps the side-by-side mode it chose"         0 "REACHED mode=existing-panel"   -                   YES=true IDIR=$T/again2
check "without an earlier install, Docker on port 80 is a stranger" 0 "REACHED mode=existing-panel" -                   YES=true OWNPROXY=1
conf=$T/opt/side-by-side/nginx.conf
if grep -q "server_name portal.king.dev \*.apps.king.dev;" $conf 2>/dev/null && grep -q "proxy_pass http://127.0.0.1:8088;" $conf && grep -q 'proxy_set_header Host \$host;' $conf && [[ -f $T/opt/side-by-side/apache.conf ]]; then
  echo "PASS  side-by-side examples carry the chosen domain and the proxy's port"
else echo "FAIL  side-by-side examples"; failed=1; fi
[[ $failed == 0 ]] && echo "install check holds"
exit $failed
