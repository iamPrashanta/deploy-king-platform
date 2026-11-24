#!/usr/bin/env bash
# ==============================================================================
# DBBKP Platform Installer v2.0
# Production-safe. Coexistence-aware. Rollback-capable.
# ==============================================================================
# Usage:
#   sudo bash install.sh                   # Auto-detect mode
#   sudo bash install.sh --mode agent-only # Agent only (no panel)
#   sudo bash install.sh --domain example.com
#   sudo bash install.sh --dry-run        # Show plan without making changes
#   sudo bash install.sh --yes            # Accept the plan without being asked
#   sudo bash install.sh --force          # Install next to another control panel (side by side)
# ==============================================================================

set -Eeo pipefail

DBBKP_VERSION="2.0.0"
INSTALL_DIR="/opt/dbbkp"
STATE_FILE="$INSTALL_DIR/.install-state.json"
LOG_FILE="/var/log/dbbkp-install.log"
APP_USER="dbbkp"
DB_NAME="dbbkp_panel"

# ─── Parse flags ──────────────────────────────────────────────────────────────
INSTALL_MODE=""      # clean | existing-panel | docker-only | agent-only
USER_DOMAIN=""
DRY_RUN=false
FORCE=false        # install next to another control panel
ASSUME_YES=false   # accept the plan without asking

while [[ $# -gt 0 ]]; do
  case $1 in
    --mode)     INSTALL_MODE="$2"; shift 2 ;;
    --domain)   USER_DOMAIN="$2";  shift 2 ;;
    --dry-run)  DRY_RUN=true;      shift   ;;
    --force)    FORCE=true;        shift   ;;
    --yes|-y)   ASSUME_YES=true;   shift   ;;
    *)          shift ;;
  esac
done

# ─── Logging ──────────────────────────────────────────────────────────────────
GREEN='\033[0;32m'; BLUE='\033[0;34m'; RED='\033[0;31m'
YELLOW='\033[1;33m'; CYAN='\033[0;36m'; BOLD='\033[1m'; NC='\033[0m'

_ts()   { date '+%Y-%m-%d %H:%M:%S'; }
log()   { echo -e "${BLUE}[INFO]${NC} $1" | tee -a "$LOG_FILE"; }
ok()    { echo -e "${GREEN}[OK]${NC}   $1" | tee -a "$LOG_FILE"; }
warn()  { echo -e "${YELLOW}[WARN]${NC} $1" | tee -a "$LOG_FILE"; }
err()   { echo -e "${RED}[ERR]${NC}  $1" >&2 | tee -a "$LOG_FILE"; exit 1; }
step()  { echo -e "\n${BOLD}${CYAN}==> $1${NC}" | tee -a "$LOG_FILE"; }
info()  { echo -e "    ${YELLOW}$1${NC}"; }
dry()   { echo -e "    ${CYAN}[DRY-RUN]${NC} $1"; }

# ─── Dry-run guard ─────────────────────────────────────────────────────────────
run() {
  if $DRY_RUN; then dry "$*"; else eval "$@"; fi
}

# ─── Root check ───────────────────────────────────────────────────────────────
if [[ "$EUID" -ne 0 ]]; then
  err "This installer must be run as root (sudo bash install.sh)"
fi

mkdir -p "$(dirname "$LOG_FILE")" "$INSTALL_DIR"
echo "=== DBBKP Install Log — $(_ts) ===" >> "$LOG_FILE"

# ─── Banner ───────────────────────────────────────────────────────────────────
echo -e "${BOLD}${BLUE}"
cat << 'EOF'
    ____  ____  ____  __ __ ____
   / __ \/ __ )/ __ )/ //_// __ \
  / / / / __  / __  / ,<  / /_/ /
 / /_/ / /_/ / /_/ / /| |/ ____/
/_____/_____/_____/_/ |_/_/

EOF
echo -e "  Platform Installer v${DBBKP_VERSION}${NC}"
echo ""

# ==============================================================================
# PHASE 1: PRE-FLIGHT CHECKS
# ==============================================================================

step "Phase 1: Pre-flight Checks"

# ── OS detection ──────────────────────────────────────────────────────────────
if [[ ! -f /etc/os-release ]]; then
  err "Cannot detect OS. Only Ubuntu 20.04+ and Debian 11+ are supported."
fi
. /etc/os-release
if [[ "$ID" != "ubuntu" && "$ID" != "debian" ]]; then
  err "Unsupported OS: $PRETTY_NAME. Only Ubuntu and Debian are supported."
fi
ok "OS: $PRETTY_NAME"

# ── Architecture ──────────────────────────────────────────────────────────────
ARCH=$(uname -m)
if [[ "$ARCH" != "x86_64" && "$ARCH" != "aarch64" ]]; then
  warn "Architecture '$ARCH' is untested. Continuing anyway."
fi
ok "Arch: $ARCH"

# ── Resource checks ───────────────────────────────────────────────────────
RAM_MB=$(free -m | awk '/^Mem:/ {print $2}')
DISK_GB=$(df -BG "$INSTALL_DIR" | awk 'NR==2 {gsub("G",""); print $4}')
CPU_CORES=$(nproc)

if [[ "$RAM_MB" -lt 900 ]]; then
  err "Insufficient RAM: ${RAM_MB}MB available, 1GB minimum required."
fi
if [[ "$DISK_GB" -lt 5 ]]; then
  err "Insufficient disk: ${DISK_GB}GB available at $INSTALL_DIR, 5GB minimum required."
fi

# Enough to install, but tight once apps are added. Shown in the plan and asked about before anything changes.
LOW_RESOURCES=()
[[ "$RAM_MB" -lt 1900 ]] && LOW_RESOURCES+=("Memory is ${RAM_MB} MB. 2 GB or more is recommended; with less, only one or two small apps will fit.")
[[ "$DISK_GB" -lt 10 ]] && LOW_RESOURCES+=("Free disk is ${DISK_GB} GB. 10 GB or more is recommended; builds and images fill a small disk quickly.")

ok "Resources: ${RAM_MB}MB RAM, ${DISK_GB}GB disk, ${CPU_CORES} CPU cores"

# ── What already runs on this server (read only: nothing here changes anything) ─
# Which program listens on a TCP port. Prints nothing when the port is free.
port_owner() {
  local line name
  line=$(ss -H -ltnp 2>/dev/null | awk -v p="$1" '{ n = split($4, a, ":"); if (a[n] == p) { print; exit } }') || true
  [[ -z "$line" ]] && return 0
  name=$(sed -n 's/.*users:(("\([^"]*\)".*/\1/p' <<<"$line")
  echo "${name:-another program}"
}

# Another control panel owns the web server's configuration and rewrites it; two panels on one server undo each other's work.
CONTROL_PANELS=()
[[ -f /usr/local/cpanel/cpanel ]]              && CONTROL_PANELS+=("cPanel/WHM")
[[ -d /usr/local/psa ]]                        && CONTROL_PANELS+=("Plesk")
[[ -d /usr/local/CyberCP ]]                    && CONTROL_PANELS+=("CyberPanel")
[[ -d /www/server/panel ]]                     && CONTROL_PANELS+=("aaPanel")
[[ -d /usr/local/directadmin ]]                && CONTROL_PANELS+=("DirectAdmin")
[[ -d /usr/local/hestia ]]                     && CONTROL_PANELS+=("HestiaCP")
[[ -d /usr/local/vesta ]]                      && CONTROL_PANELS+=("VestaCP")
[[ -d /home/clp ]]                             && CONTROL_PANELS+=("CloudPanel")
[[ -f /etc/webmin/virtual-server/config ]]     && CONTROL_PANELS+=("Virtualmin")
[[ -d /data/coolify ]]                         && CONTROL_PANELS+=("Coolify")
[[ -d /etc/dokploy ]]                          && CONTROL_PANELS+=("Dokploy")
[[ -d /captain ]]                              && CONTROL_PANELS+=("CapRover")

WEB_SERVERS=()
command -v nginx &>/dev/null                                   && WEB_SERVERS+=("Nginx")
{ command -v apache2 &>/dev/null || command -v httpd &>/dev/null; } && WEB_SERVERS+=("Apache")
command -v caddy &>/dev/null                                   && WEB_SERVERS+=("Caddy")
[[ -d /etc/openlitespeed || -d /usr/local/lsws ]]              && WEB_SERVERS+=("OpenLiteSpeed")

PORT80_OWNER=$(port_owner 80)
PORT443_OWNER=$(port_owner 443)

# Addresses the existing web server answers for. Names only; no file is copied and no secret is read.
existing_sites() {
  {
    grep -rhoE '^\s*server_name\s+[^;]+' /etc/nginx/sites-enabled /etc/nginx/conf.d 2>/dev/null | sed -E 's/^\s*server_name\s+//' | tr -s ' \t' '\n'
    grep -rhoiE '^\s*Server(Name|Alias)\s+.+' /etc/apache2/sites-enabled /etc/httpd/conf.d 2>/dev/null | sed -E 's/^\s*\S+\s+//' | tr -s ' \t' '\n'
  } | grep -vE '^(_|localhost|)$' | sort -u
}
EXISTING_SITES=$(existing_sites || true)
EXISTING_SITE_COUNT=$(grep -c . <<<"$EXISTING_SITES" || true)

OTHER_SERVICES=()
for pair in "3306:MySQL/MariaDB" "5432:PostgreSQL" "6379:Redis" "27017:MongoDB"; do
  owner=$(port_owner "${pair%%:*}")
  [[ -n "$owner" ]] && OTHER_SERVICES+=("${pair#*:} on port ${pair%%:*}")
done
EXISTING_CONTAINERS=0
command -v docker &>/dev/null && EXISTING_CONTAINERS=$(docker ps -q 2>/dev/null | grep -c . || true)

# Kept under its old name for the state file, doctor.sh and update.sh.
DETECTED_PANELS=("${CONTROL_PANELS[@]}" "${WEB_SERVERS[@]}")

echo ""
echo -e "  ${BOLD}Found on this server${NC}"
[[ ${#CONTROL_PANELS[@]} -gt 0 ]] && echo -e "    Control panel : ${YELLOW}${CONTROL_PANELS[*]}${NC}"
[[ ${#WEB_SERVERS[@]} -gt 0 ]]    && echo -e "    Web server    : ${WEB_SERVERS[*]}"
[[ -n "$PORT80_OWNER" ]]          && echo -e "    Port 80       : used by ${YELLOW}${PORT80_OWNER}${NC}"
[[ -n "$PORT443_OWNER" ]]         && echo -e "    Port 443      : used by ${YELLOW}${PORT443_OWNER}${NC}"
if [[ "$EXISTING_SITE_COUNT" -gt 0 ]]; then
  echo -e "    Websites      : ${EXISTING_SITE_COUNT} address(es), for example $(head -n 3 <<<"$EXISTING_SITES" | paste -sd, - | sed 's/,/, /g')"
fi
[[ ${#OTHER_SERVICES[@]} -gt 0 ]] && echo -e "    Databases     : $(printf '%s; ' "${OTHER_SERVICES[@]}" | sed 's/; $//')"
[[ "$EXISTING_CONTAINERS" -gt 0 ]] && echo -e "    Containers    : ${EXISTING_CONTAINERS} running"
if [[ ${#DETECTED_PANELS[@]} -eq 0 && -z "$PORT80_OWNER$PORT443_OWNER" && ${#OTHER_SERVICES[@]} -eq 0 && "$EXISTING_CONTAINERS" -eq 0 && "$EXISTING_SITE_COUNT" -eq 0 ]]; then
  echo -e "    Nothing that needs care. This looks like a fresh server."
fi
echo ""

# ── Another control panel: stop unless forced ─────────────────────────────────
if [[ ${#CONTROL_PANELS[@]} -gt 0 && "$INSTALL_MODE" != "agent-only" ]]; then
  if ! $FORCE; then
    echo -e "${RED}[STOP]${NC} ${CONTROL_PANELS[*]} is installed on this server." >&2
    echo "       A control panel rewrites the web server's configuration whenever it likes, so the two would" >&2
    echo "       undo each other's work. Nothing has been changed." >&2
    echo "       Best: install Deploy King on its own server." >&2
    echo "       To install here anyway, side by side on other ports: add --force" >&2
    exit 1
  fi
  warn "${CONTROL_PANELS[*]} is installed. Continuing because --force was given; ports 80 and 443 stay with it."
fi

# ── Install mode ───────────────────────────────────────────────────────────
# Side by side whenever something else has, or could take, ports 80 and 443. A web server that is
# installed but stopped still counts: taking its ports would stop it from ever starting again.
NEEDS_SIDE_BY_SIDE=false
[[ -n "$PORT80_OWNER$PORT443_OWNER" || ${#DETECTED_PANELS[@]} -gt 0 ]] && NEEDS_SIDE_BY_SIDE=true

if [[ -z "$INSTALL_MODE" ]]; then
  if $NEEDS_SIDE_BY_SIDE; then INSTALL_MODE="existing-panel"; else INSTALL_MODE="clean"; fi
elif [[ "$INSTALL_MODE" == "clean" && -n "$PORT80_OWNER$PORT443_OWNER" ]]; then
  err "--mode clean needs ports 80 and 443, but they are used by ${PORT80_OWNER:-$PORT443_OWNER}. Nothing has been changed. Run without --mode to install side by side."
fi

if [[ "$INSTALL_MODE" == "existing-panel" ]]; then
  warn "Installing SIDE BY SIDE: ports 80 and 443 and every existing site stay exactly as they are."
fi

ok "Install mode: ${BOLD}$INSTALL_MODE${NC}"

# ── Existing dbbkp installation check ─────────────────────────────────────────
if [[ -f "$STATE_FILE" ]]; then
  warn "Existing dbbkp installation detected at $INSTALL_DIR"
  warn "To upgrade, run: bash scripts/update.sh"
  warn "To reinstall, remove $STATE_FILE first."
  EXISTING_INSTALL=true
fi

# ==============================================================================
# PHASE 2: PORT DETECTION
# ==============================================================================

step "Phase 2: Port Auto-detection"

find_free_port() {
  local port="$1"
  local max=$((port + 100))
  while [[ $port -lt $max ]]; do
    if ! ss -tulpn 2>/dev/null | grep -q ":${port} "; then
      echo "$port"
      return
    fi
    port=$((port + 1))
  done
  err "Could not find free port starting from $1 within 100 attempts"
}

# Choose base ports based on mode
if [[ "$INSTALL_MODE" == "clean" ]]; then
  PANEL_PORT=$(find_free_port 3000)
  API_PORT=$(find_free_port 4000)
  TRAEFIK_HTTP=80
  TRAEFIK_HTTPS=443
else
  # Coexistence: use high ports, never touch 80/443
  PANEL_PORT=$(find_free_port 3100)
  API_PORT=$(find_free_port 4100)
  TRAEFIK_HTTP=$(find_free_port 8088)
  TRAEFIK_HTTPS=$(find_free_port 8444)
fi

REDIS_PORT=$(find_free_port 6379)
PG_PORT=$(find_free_port 5432)

ok "Panel:   :$PANEL_PORT"
ok "API:     :$API_PORT"
ok "Traefik: :$TRAEFIK_HTTP / :$TRAEFIK_HTTPS"
ok "Redis:   :$REDIS_PORT"
ok "Postgres::$PG_PORT"

# ── The plan, and one question before anything is changed ────────────────────
# Asks on the terminal even when the script itself arrives through a pipe (curl ... | bash).
confirm() {
  local reply=""
  if $ASSUME_YES || $DRY_RUN; then return 0; fi
  if [[ -t 0 ]]; then
    read -r -p "$1 [y/N]: " reply
  elif (: </dev/tty) 2>/dev/null; then
    read -r -p "$1 [y/N]: " reply </dev/tty
  else
    err "Cannot ask for confirmation without a terminal. Nothing has been changed. Re-run with --yes to accept the plan above."
  fi
  [[ "$reply" == "y" || "$reply" == "Y" ]]
}

echo ""
echo -e "  ${BOLD}What the installer will do${NC}"
echo "    - Install Docker if it is missing, and add the system user '$APP_USER'"
echo "    - Create $INSTALL_DIR, /var/www/sites and /var/log/dbbkp"
echo "    - Start its own containers: database, queue, proxy, API, worker, panel"
if [[ "$INSTALL_MODE" == "clean" ]]; then
  echo "    - Take ports 80 and 443 for the proxy, and open them in the firewall"
else
  echo "    - Use ports $TRAEFIK_HTTP and $TRAEFIK_HTTPS for its proxy. Ports 80 and 443 are NOT touched"
  echo "    - Change no existing website, web server file, cron job or database"
fi
echo "    - Add firewall rules for its own ports only. No rule is removed"
echo "    - Add a read-only scan of this server every 5 minutes, so the panel can show what changes (Security page),"
echo "      and a helper that removes what you choose there, with a copy kept for undo"
for line in "${LOW_RESOURCES[@]}"; do
  echo -e "    ${YELLOW}Note:${NC} $line"
done
echo ""
if [[ "${EXISTING_INSTALL:-false}" == true ]]; then
  echo -e "    ${YELLOW}Note:${NC} Deploy King is already installed here. Continuing may overwrite its configuration."
  echo ""
fi
if ! confirm "Continue with this plan?"; then
  echo "Stopped. Nothing has been changed."
  exit 0
fi

if $DRY_RUN; then
  echo ""
  warn "DRY-RUN mode — no changes will be made. Showing planned steps only."
  echo ""
fi

# ==============================================================================
# PHASE 3: GENERATE CREDENTIALS
# ==============================================================================

step "Phase 3: Generating Credentials"

# Unique DB username to avoid collision with existing postgres users
DB_USER="dbbkp_$(openssl rand -hex 3)"
DB_PASS=$(openssl rand -base64 24 | tr -d '+/=' | head -c 28)
REDIS_PASS=$(openssl rand -base64 24 | tr -d '+/=' | head -c 28)
JWT_SECRET=$(openssl rand -base64 48 | tr -d '+/=')
INTERNAL_SECRET=$(openssl rand -base64 32 | tr -d '+/=')
# 32-byte hex master key for AES-256-GCM secrets store
MASTER_KEY=$(openssl rand -hex 32)
ADMIN_PASS=$(openssl rand -base64 12 | tr -d '+/=' | head -c 14)

ok "Credentials generated (never stored in plaintext)"

# ==============================================================================
# PHASE 4: INSTALL DEPENDENCIES
# ==============================================================================

step "Phase 4: Installing System Dependencies"

run "apt-get update -qq >/dev/null"
run "apt-get install -y -qq curl wget git sudo jq openssl ca-certificates gnupg lsb-release python3-minimal >/dev/null"
ok "Base packages installed"

# ── Docker ────────────────────────────────────────────────────────────────────
if ! command -v docker &>/dev/null; then
  log "Installing Docker via apt (docker.io + compose plugin)..."
  run "apt-get install -y -qq docker.io docker-compose-plugin >/dev/null"
  run "systemctl enable --now docker >/dev/null"
  ok "Docker installed"
else
  DOCKER_VER=$(docker --version | awk '{print $3}' | tr -d ',')
  ok "Docker already installed: $DOCKER_VER"
fi

# Add dbbkp user to docker group
if id "$APP_USER" &>/dev/null; then
  run "usermod -aG docker $APP_USER"
fi

# ── Docker Compose plugin check ───────────────────────────────────────────────
if ! docker compose version &>/dev/null; then
  run "apt-get install -y -qq docker-compose-plugin >/dev/null"
fi
ok "Docker Compose: $(docker compose version --short 2>/dev/null || echo 'installed')"

# ==============================================================================
# PHASE 5: FIREWALL (SAFE — NO RESET)
# ==============================================================================

step "Phase 5: Firewall — Safe Port Opening"

if command -v ufw &>/dev/null; then
  # NEVER reset, NEVER change default policies on existing systems
  # Only ADD the ports we need
  run "ufw allow $PANEL_PORT/tcp >/dev/null 2>&1 || true"
  run "ufw allow $API_PORT/tcp   >/dev/null 2>&1 || true"

  if [[ "$INSTALL_MODE" == "clean" ]]; then
    run "ufw allow 80/tcp  >/dev/null 2>&1 || true"
    run "ufw allow 443/tcp >/dev/null 2>&1 || true"
  else
    run "ufw allow $TRAEFIK_HTTP/tcp  >/dev/null 2>&1 || true"
    run "ufw allow $TRAEFIK_HTTPS/tcp >/dev/null 2>&1 || true"
    info "Skipping 80/443 — coexistence mode (existing web server detected)"
  fi

  ok "Firewall ports opened (no rules were removed or reset)"
else
  warn "UFW not found — skipping firewall configuration"
  info "Ensure ports $PANEL_PORT and $API_PORT are accessible"
fi

# ==============================================================================
# PHASE 6: SYSTEM USER & DIRECTORIES
# ==============================================================================

step "Phase 6: System User & Directories"

if ! id "$APP_USER" &>/dev/null; then
  run "useradd -r -m -s /bin/bash $APP_USER"
  run "usermod -aG docker $APP_USER"
  ok "System user '$APP_USER' created"
else
  ok "System user '$APP_USER' already exists"
fi

run "mkdir -p $INSTALL_DIR/data/{postgres,redis,letsencrypt}"
run "mkdir -p $INSTALL_DIR/traefik/rules $INSTALL_DIR/scan $INSTALL_DIR/scripts $INSTALL_DIR/actions/requests $INSTALL_DIR/actions/results"
run "mkdir -p /var/www/sites /var/log/dbbkp"
run "chown -R $APP_USER:$APP_USER $INSTALL_DIR /var/www/sites /var/log/dbbkp"
ok "Directories created"

# ==============================================================================
# PHASE 7: WRITE ENV FILE
# ==============================================================================

step "Phase 7: Writing Environment Configuration"

run "cat > $INSTALL_DIR/.env << 'ENVEOF'
# ── Core ────────────────────────────────────
NODE_ENV=production
DOMAIN=${USER_DOMAIN:-localhost}

# ── Ports ───────────────────────────────────
PORT=$PANEL_PORT
API_PORT=$API_PORT

# ── Database ────────────────────────────────
DATABASE_URL=postgresql://${DB_USER}:${DB_PASS}@dbbkp-postgres:${PG_PORT}/${DB_NAME}
DB_USER=${DB_USER}
DB_PASSWORD=${DB_PASS}
DB_NAME=${DB_NAME}

# ── Redis ───────────────────────────────────
REDIS_URL=redis://:${REDIS_PASS}@dbbkp-redis:${REDIS_PORT}
REDIS_PASSWORD=${REDIS_PASS}

# ── Security ────────────────────────────────
JWT_SECRET=${JWT_SECRET}
JWT_EXPIRES=7d
INTERNAL_SECRET=${INTERNAL_SECRET}
MASTER_KEY=${MASTER_KEY}

# ── Panel ───────────────────────────────────
NEXT_PUBLIC_API_URL=http://\${DOMAIN}:\${API_PORT}
NEXT_PUBLIC_WS_URL=ws://\${DOMAIN}:\${API_PORT}

# ── Integrations (fill in as needed) ────────
CLOUDFLARE_API_TOKEN=
CLOUDFLARE_ZONE_ID=
SERVER_IP=
ACME_EMAIL=admin@\${DOMAIN:-localhost}

# ── Pipeline Runner ──────────────────────────
PIPELINE_ISOLATION=docker
PIPELINE_DOCKER_IMAGE=node:20-bookworm
PIPELINE_DOCKER_MEMORY=1g
PIPELINE_DOCKER_CPUS=1
PIPELINE_CONCURRENCY=2
ENVEOF"

run "chmod 600 $INSTALL_DIR/.env"
ok "Environment file written to $INSTALL_DIR/.env"

# ==============================================================================
# PHASE 8: DOCKER COMPOSE (PRODUCTION)
# ==============================================================================

step "Phase 8: Writing Docker Compose Stack"

# Traefik section differs by mode
if [[ "$INSTALL_MODE" == "clean" ]]; then
  TRAEFIK_CMD_HTTPS="- \"--entrypoints.websecure.address=:443\""
  TRAEFIK_CMD_ACME="- \"--certificatesresolvers.letsencrypt.acme.tlschallenge=true\""
  TRAEFIK_CMD_EMAIL="- \"--certificatesresolvers.letsencrypt.acme.email=\${ACME_EMAIL}\""
  TRAEFIK_CMD_STORE="- \"--certificatesresolvers.letsencrypt.acme.storage=/letsencrypt/acme.json\""
  TRAEFIK_PORTS="    ports:\n      - \"${TRAEFIK_HTTP}:80\"\n      - \"${TRAEFIK_HTTPS}:443\""
else
  TRAEFIK_CMD_HTTPS="- \"--entrypoints.websecure.address=:8443\""
  TRAEFIK_CMD_ACME=""
  TRAEFIK_CMD_EMAIL=""
  TRAEFIK_CMD_STORE=""
  TRAEFIK_PORTS="    ports:\n      - \"${TRAEFIK_HTTP}:80\"\n      - \"${TRAEFIK_HTTPS}:8443\""
fi

cat > "$INSTALL_DIR/docker-compose.yml" << DCEOF
services:
  dbbkp-postgres:
    image: postgres:15-alpine
    container_name: dbbkp-postgres
    restart: unless-stopped
    environment:
      POSTGRES_USER: \${DB_USER}
      POSTGRES_PASSWORD: \${DB_PASSWORD}
      POSTGRES_DB: \${DB_NAME}
    volumes:
      - ./data/postgres:/var/lib/postgresql/data
    networks:
      - dbbkp
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U \${DB_USER}"]
      interval: 10s
      timeout: 5s
      retries: 5

  dbbkp-redis:
    image: redis:7-alpine
    container_name: dbbkp-redis
    restart: unless-stopped
    command: redis-server --requirepass \${REDIS_PASSWORD} --save 60 1
    volumes:
      - ./data/redis:/data
    networks:
      - dbbkp
    healthcheck:
      test: ["CMD", "redis-cli", "-a", "\${REDIS_PASSWORD}", "ping"]
      interval: 10s
      timeout: 5s
      retries: 5

  dbbkp-traefik:
    image: traefik:v3.0
    container_name: dbbkp-traefik
    restart: unless-stopped
    command:
      - "--api.dashboard=false"
      - "--providers.docker=true"
      - "--providers.docker.exposedbydefault=false"
      - "--providers.docker.network=dbbkp"
      - "--entrypoints.web.address=:80"
      ${TRAEFIK_CMD_HTTPS}
      ${TRAEFIK_CMD_ACME}
      ${TRAEFIK_CMD_EMAIL}
      ${TRAEFIK_CMD_STORE}
    ports:
$(echo -e "$TRAEFIK_PORTS" | sed 's/^    //')
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock:ro
      - ./data/letsencrypt:/letsencrypt
      - ./traefik/rules:/etc/traefik/rules
    networks:
      - dbbkp

  dbbkp-api:
    image: ghcr.io/dbbkp/api:latest
    container_name: dbbkp-api
    restart: unless-stopped
    env_file: .env
    environment:
      - DATABASE_URL=postgresql://\${DB_USER}:\${DB_PASSWORD}@dbbkp-postgres:5432/\${DB_NAME}
      - REDIS_URL=redis://:\${REDIS_PASSWORD}@dbbkp-redis:6379
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock
      - /var/www/sites:/var/www/sites
      - /var/log/dbbkp:/var/log/dbbkp
      - ./scan:/host-scan:ro
      - ./actions/requests:/host-actions/requests
      - ./actions/results:/host-actions/results:ro
    depends_on:
      dbbkp-postgres:
        condition: service_healthy
      dbbkp-redis:
        condition: service_healthy
    networks:
      - dbbkp
    labels:
      - "traefik.enable=true"
      - "traefik.http.routers.api.rule=PathPrefix(\`/api\`) || PathPrefix(\`/trpc\`) || PathPrefix(\`/ws\`) || PathPrefix(\`/webhooks\`) || PathPrefix(\`/internal\`)"
      - "traefik.http.services.api.loadbalancer.server.port=4000"

  dbbkp-worker:
    image: ghcr.io/dbbkp/worker:latest
    container_name: dbbkp-worker
    restart: unless-stopped
    env_file: .env
    environment:
      - DATABASE_URL=postgresql://\${DB_USER}:\${DB_PASSWORD}@dbbkp-postgres:5432/\${DB_NAME}
      - REDIS_URL=redis://:\${REDIS_PASSWORD}@dbbkp-redis:6379
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock
      - /var/www/sites:/var/www/sites
    depends_on:
      dbbkp-postgres:
        condition: service_healthy
      dbbkp-redis:
        condition: service_healthy
    networks:
      - dbbkp

  dbbkp-agent:
    image: ghcr.io/dbbkp/agent:latest
    container_name: dbbkp-agent
    restart: unless-stopped
    pid: host
    environment:
      - INTERNAL_SECRET=\${INTERNAL_SECRET}
      - API_ENDPOINT=http://dbbkp-api:4000
    volumes:
      - /var/www/sites:/var/www/sites:ro
      - /proc:/proc:ro
      - /var/spool/cron:/var/spool/cron:ro
      - /etc/cron.d:/etc/cron.d:ro
    depends_on:
      - dbbkp-api
    networks:
      - dbbkp

  dbbkp-panel:
    image: ghcr.io/dbbkp/panel:latest
    container_name: dbbkp-panel
    restart: unless-stopped
    env_file: .env
    depends_on:
      - dbbkp-api
    networks:
      - dbbkp
    labels:
      - "traefik.enable=true"
      - "traefik.http.routers.panel.rule=PathPrefix(\`/\`)"
      - "traefik.http.services.panel.loadbalancer.server.port=3000"

networks:
  dbbkp:
    driver: bridge
DCEOF

run "chmod 640 $INSTALL_DIR/docker-compose.yml"
ok "Docker Compose stack written"

# ==============================================================================
# PHASE 9: SYSTEMD SERVICE
# ==============================================================================

step "Phase 9: Installing Systemd Service"

cat > /etc/systemd/system/dbbkp.service << SVCEOF
[Unit]
Description=dbbkp Platform
Requires=docker.service
After=docker.service network-online.target
Wants=network-online.target

[Service]
Type=oneshot
RemainAfterExit=yes
WorkingDirectory=$INSTALL_DIR
EnvironmentFile=$INSTALL_DIR/.env
ExecStartPre=-/usr/bin/docker compose down --remove-orphans
ExecStart=/usr/bin/docker compose up -d --wait
ExecStop=/usr/bin/docker compose down
ExecReload=/usr/bin/docker compose pull && /usr/bin/docker compose up -d --wait
StandardOutput=journal
StandardError=journal
SyslogIdentifier=dbbkp
Restart=on-failure
RestartSec=10

[Install]
WantedBy=multi-user.target
SVCEOF

run "systemctl daemon-reload"
run "systemctl enable dbbkp.service >/dev/null"
ok "Systemd service installed"

# ==============================================================================
# PHASE 10: ACME CONFIG & TRAEFIK RULES DIR
# ==============================================================================

step "Phase 10: Traefik Configuration"

ACME_FILE="$INSTALL_DIR/data/letsencrypt/acme.json"
if [[ ! -f "$ACME_FILE" ]]; then
  run "touch $ACME_FILE"
  run "chmod 600 $ACME_FILE"
fi
ok "Traefik configuration ready"

# ==============================================================================
# PHASE 11: SAVE INSTALL STATE
# ==============================================================================

step "Phase 11: Saving Install State"

SERVER_IP=$(curl -s --max-time 5 https://api.ipify.org 2>/dev/null || hostname -I | awk '{print $1}')

cat > "$STATE_FILE" << STATEEOF
{
  "version": "${DBBKP_VERSION}",
  "installedAt": "$(_ts)",
  "mode": "${INSTALL_MODE}",
  "serverIp": "${SERVER_IP}",
  "domain": "${USER_DOMAIN:-localhost}",
  "ports": {
    "panel": ${PANEL_PORT},
    "api": ${API_PORT},
    "traefikHttp": ${TRAEFIK_HTTP},
    "traefikHttps": ${TRAEFIK_HTTPS},
    "redis": ${REDIS_PORT},
    "postgres": ${PG_PORT}
  },
  "services": ["dbbkp-postgres","dbbkp-redis","dbbkp-traefik","dbbkp-api","dbbkp-worker","dbbkp-agent","dbbkp-panel"],
  "controlPanels": [$(printf '"%s",' "${CONTROL_PANELS[@]}" | sed 's/,$//; s/^"",\{0,1\}$//')],
  "webServers": [$(printf '"%s",' "${WEB_SERVERS[@]}" | sed 's/,$//; s/^"",\{0,1\}$//')],
  "port80": "${PORT80_OWNER}",
  "port443": "${PORT443_OWNER}",
  "existingSites": ${EXISTING_SITE_COUNT:-0},
  "detectedPanels": [$(printf '"%s",' "${DETECTED_PANELS[@]}" | sed 's/,$//; s/^"",\{0,1\}$//')]
}
STATEEOF

run "chmod 600 $STATE_FILE"
ok "Install state saved to $STATE_FILE"

# ── Server watch ────────────────────────────────────────────────────────
# A read-only scan every five minutes (scripts/host-scan.py). Its first list is what the admin reviews
# on the Security page: everything that was on this server before or at install.
SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [[ -f "$SRC_DIR/host-scan.py" && -f "$SRC_DIR/install-scan.sh" ]]; then
  run "cp $SRC_DIR/*.sh $SRC_DIR/host-scan.py $SRC_DIR/host-act.py $INSTALL_DIR/scripts/"
  if $DRY_RUN; then
    dry "Would install the server watch (dbbkp-scan.timer)"
  elif INSTALL_DIR="$INSTALL_DIR" bash "$INSTALL_DIR/scripts/install-scan.sh" >>"$LOG_FILE" 2>&1; then
    ok "Server watch installed (read-only, every 5 minutes)"
  else
    warn "The server watch could not be installed. Later: sudo bash $INSTALL_DIR/scripts/install-scan.sh"
  fi
else
  warn "host-scan.py was not found next to the installer, so the server watch is not installed."
  info "Copy the scripts folder to $INSTALL_DIR/scripts and run: sudo bash $INSTALL_DIR/scripts/install-scan.sh"
fi

# ── Side by side: how the existing web server passes addresses on ──────────────
# Written as files to copy from. The installer never edits the existing web server's configuration.
SIDE_DIR="$INSTALL_DIR/side-by-side"
if [[ "$INSTALL_MODE" == "existing-panel" ]] && ! $DRY_RUN; then
  mkdir -p "$SIDE_DIR"
  SIDE_NAMES="${USER_DOMAIN:+portal.$USER_DOMAIN *.apps.$USER_DOMAIN}"
  SIDE_NAMES="${SIDE_NAMES:-portal.example.com *.apps.example.com}"
  cat > "$SIDE_DIR/nginx.conf" << NGXEOF
# Deploy King, side by side with the sites Nginx already serves.
# Nginx keeps ports 80 and 443 and passes only the addresses below on to Deploy King.
#
#   1. Put the addresses you want Deploy King to answer for in server_name.
#   2. Copy this file to /etc/nginx/conf.d/deploy-king.conf
#   3. Check and reload:  nginx -t && systemctl reload nginx
#   4. For HTTPS, get a certificate the way you do for your other sites (for example: certbot --nginx).
#
# To undo: delete /etc/nginx/conf.d/deploy-king.conf and reload Nginx.

map \$http_upgrade \$deployking_connection {
  default upgrade;
  ''      close;
}

server {
  listen 80;
  listen [::]:80;
  server_name ${SIDE_NAMES};

  client_max_body_size 512m;

  location / {
    proxy_pass http://127.0.0.1:${TRAEFIK_HTTP};
    proxy_http_version 1.1;
    proxy_set_header Host \$host;
    proxy_set_header X-Real-IP \$remote_addr;
    proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto \$scheme;
    proxy_set_header Upgrade \$http_upgrade;
    proxy_set_header Connection \$deployking_connection;
    proxy_read_timeout 3600s;
    proxy_buffering off;
  }
}
NGXEOF
  cat > "$SIDE_DIR/apache.conf" << APEOF
# Deploy King, side by side with the sites Apache already serves.
# Apache keeps ports 80 and 443 and passes only the addresses below on to Deploy King.
#
#   1. Put the addresses you want Deploy King to answer for in ServerName / ServerAlias.
#   2. Enable the modules:  a2enmod proxy proxy_http proxy_wstunnel rewrite headers
#   3. Copy this file to /etc/apache2/sites-available/deploy-king.conf and run: a2ensite deploy-king
#   4. Check and reload:  apachectl configtest && systemctl reload apache2
#
# To undo: a2dissite deploy-king, then reload Apache.

<VirtualHost *:80>
  ServerName $(awk '{print $1}' <<<"$SIDE_NAMES")
  ServerAlias $(awk '{print $2}' <<<"$SIDE_NAMES")

  ProxyPreserveHost On
  RequestHeader set X-Forwarded-Proto expr=%{REQUEST_SCHEME}
  RewriteEngine On
  RewriteCond %{HTTP:Upgrade} =websocket [NC]
  RewriteRule /(.*) ws://127.0.0.1:${TRAEFIK_HTTP}/\$1 [P,L]
  ProxyPass / http://127.0.0.1:${TRAEFIK_HTTP}/ timeout=3600
  ProxyPassReverse / http://127.0.0.1:${TRAEFIK_HTTP}/
</VirtualHost>
APEOF
  chmod 644 "$SIDE_DIR/nginx.conf" "$SIDE_DIR/apache.conf"
  ok "Side-by-side examples written to $SIDE_DIR (nothing was installed into your web server)"
fi

# ==============================================================================
# PHASE 12: START PLATFORM
# ==============================================================================

step "Phase 12: Starting Platform"

if $DRY_RUN; then
  dry "Would run: systemctl start dbbkp.service"
  dry "Would run: cd $INSTALL_DIR && docker compose up -d"
else
  log "Pulling images and starting services (this may take 1-2 minutes)..."
  cd "$INSTALL_DIR"
  if docker compose up -d --wait 2>>"$LOG_FILE"; then
    ok "All containers started"
  else
    warn "Some containers may not be running yet — images may need to be published first"
    warn "Run: systemctl start dbbkp once images are available"
  fi
fi

# ==============================================================================
# COMPLETION SUMMARY
# ==============================================================================

echo ""
echo -e "${BOLD}${GREEN}╔══════════════════════════════════════════════════════╗${NC}"
echo -e "${BOLD}${GREEN}║    dbbkp Platform Installed Successfully!            ║${NC}"
echo -e "${BOLD}${GREEN}╚══════════════════════════════════════════════════════╝${NC}"
echo ""
echo -e "  ${BOLD}Panel URL${NC}     : ${CYAN}http://${SERVER_IP}:${PANEL_PORT}${NC}"
echo -e "  ${BOLD}API URL${NC}       : ${CYAN}http://${SERVER_IP}:${API_PORT}${NC}"
echo -e "  ${BOLD}Mode${NC}          : ${YELLOW}${INSTALL_MODE}${NC}"
if [[ ${#DETECTED_PANELS[@]} -gt 0 ]]; then
  echo -e "  ${BOLD}Coexisting with${NC}: ${YELLOW}${DETECTED_PANELS[*]}${NC}"
fi
echo ""
if [[ "$INSTALL_MODE" == "existing-panel" ]]; then
  echo -e "  ${BOLD}Next step${NC}     : your web server still answers on ports 80 and 443. To give Deploy King"
  echo -e "                  an address, copy ${CYAN}$SIDE_DIR/nginx.conf${NC} (or apache.conf) as its first lines explain."
  echo ""
fi
echo -e "  ${BOLD}Admin password${NC}: ${YELLOW}${ADMIN_PASS}${NC}"
echo -e "  ${BOLD}Install log${NC}   : ${LOG_FILE}"
echo -e "  ${BOLD}State file${NC}    : ${STATE_FILE}"
echo ""
echo -e "  ${BOLD}Credentials are stored in:${NC} ${CYAN}$INSTALL_DIR/.env${NC}"
echo -e "  ${YELLOW}Keep this file secure — it contains all secrets.${NC}"
echo ""
echo -e "  ${BOLD}Useful commands:${NC}"
echo -e "    ${CYAN}systemctl status dbbkp${NC}           — service status"
echo -e "    ${CYAN}cd $INSTALL_DIR && docker compose logs -f${NC} — live logs"
echo -e "    ${CYAN}bash /opt/dbbkp/scripts/doctor.sh${NC} — run health check"
echo -e "    ${CYAN}bash /opt/dbbkp/scripts/update.sh${NC}  — update platform"
echo ""
