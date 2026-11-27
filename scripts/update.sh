#!/usr/bin/env bash
# ==============================================================================
# Deploy King updater
# Brings an install made by scripts/install.sh up to date. Data, passwords and ports are kept.
# The API applies database migrations itself when it starts.
#   sudo bash /opt/dbbkp/scripts/update.sh              # newest of the branch or tag installed
#   sudo bash /opt/dbbkp/scripts/update.sh --ref v3.2.0 # another branch or tag (source), or image tag (ghcr)
# Running the installer again does the same, and also re-checks the server.
# ==============================================================================

set -Eeo pipefail

INSTALL_DIR="${INSTALL_DIR:-/opt/dbbkp}"
ENV_FILE="$INSTALL_DIR/.env"
LOG_FILE="/var/log/dbbkp-update.log"
NEW_REF=""
[[ "${1:-}" == "--ref" ]] && NEW_REF="${2:-}"

GREEN='\033[0;32m'; BLUE='\033[0;34m'; RED='\033[0;31m'
YELLOW='\033[1;33m'; NC='\033[0m'

log()  { echo -e "${BLUE}[INFO]${NC} $1"; }
ok()   { echo -e "${GREEN}[OK]${NC}   $1"; }
warn() { echo -e "${YELLOW}[WARN]${NC} $1"; }
err()  { echo -e "${RED}[ERR]${NC}  $1" >&2; exit 1; }
env_get() { sed -n "s/^$1=//p" "$ENV_FILE" | tail -n 1; }
env_set() {
  K="$1" V="$2" awk 'BEGIN { k = ENVIRON["K"]; v = ENVIRON["V"]; done = 0 }
    index($0, k "=") == 1 { if (!done) print k "=" v; done = 1; next } { print }
    END { if (!done) print k "=" v }' "$ENV_FILE" > "$ENV_FILE.tmp" && cat "$ENV_FILE.tmp" > "$ENV_FILE" && rm -f "$ENV_FILE.tmp"
}

[[ "$EUID" -eq 0 ]] || err "Please run as root"
[[ -f "$ENV_FILE" ]] || err "No installation found at $INSTALL_DIR. Run scripts/install.sh first."
cd "$INSTALL_DIR"
echo "=== Deploy King update — $(date '+%Y-%m-%d %H:%M:%S') ===" >> "$LOG_FILE"

IMAGES=$(env_get DK_IMAGES); IMAGES=${IMAGES:-source}
SOURCE_DIR=$(env_get DK_SOURCE)

# 1. New source (the compose files and, when building here, the code)
if [[ "$SOURCE_DIR" == "$INSTALL_DIR/src" && -d "$SOURCE_DIR/.git" ]]; then
  REF="${NEW_REF:-$(env_get DK_GIT_REF)}"
  log "Fetching ${REF:-the default branch}..."
  git -C "$SOURCE_DIR" fetch -q --depth 1 origin "${REF:-HEAD}" >>"$LOG_FILE" 2>&1 || err "Could not fetch ${REF:-the default branch}"
  git -C "$SOURCE_DIR" checkout -q --force FETCH_HEAD
  [[ -n "$NEW_REF" && "$IMAGES" == "source" ]] && env_set DK_GIT_REF "$NEW_REF"
  ok "Source: $(git -C "$SOURCE_DIR" log -1 --format='%h %s' | cut -c1-70)"
elif [[ -n "$SOURCE_DIR" ]]; then
  log "Building from your checkout at $SOURCE_DIR (update it yourself, e.g. git pull)."
fi
if [[ -f "$SOURCE_DIR/deploy/compose.yml" ]]; then
  cp "$SOURCE_DIR/deploy/compose.yml" "$SOURCE_DIR/deploy/compose.tls.yml" "$INSTALL_DIR/"
fi

# 2. New images
if [[ "$IMAGES" == "ghcr" ]]; then
  [[ -n "$NEW_REF" ]] && env_set DK_TAG "${NEW_REF#v}"
  log "Downloading images (tag $(env_get DK_TAG))..."
  docker compose pull >>"$LOG_FILE" 2>&1 || err "Could not download the images. See $LOG_FILE"
  UP_FLAGS="--no-build"
else
  env_set DK_VERSION "$(git -C "$SOURCE_DIR" describe --tags --always 2>/dev/null || echo source)"
  log "Building images (a few minutes)..."
  for svc in dbbkp-api dbbkp-worker dbbkp-panel; do
    docker compose build "$svc" >>"$LOG_FILE" 2>&1 || err "The build failed ($svc); the running version was not touched. See $LOG_FILE"
  done
  UP_FLAGS=""
fi

# 3. Restart what changed, and wait until it is healthy
log "Restarting changed containers..."
# shellcheck disable=SC2086
if ! docker compose up -d --wait --wait-timeout 600 --remove-orphans $UP_FLAGS >>"$LOG_FILE" 2>&1; then
  docker compose ps >&2 || true
  err "Some containers did not become healthy. See: cd $INSTALL_DIR && docker compose logs"
fi
ok "All containers are running and healthy"

# 4. Images no longer used by any container
docker image prune -f >/dev/null 2>&1 || true

if [[ -f "$INSTALL_DIR/scripts/doctor.sh" ]]; then
  bash "$INSTALL_DIR/scripts/doctor.sh" >/dev/null 2>&1 && ok "Health check passed" || warn "The health check found problems: bash $INSTALL_DIR/scripts/doctor.sh"
fi
echo -e "\n${BLUE}Update finished.${NC}"
