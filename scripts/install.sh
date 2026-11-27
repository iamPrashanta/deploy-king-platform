#!/usr/bin/env bash
# ==============================================================================
# Deploy King server installer
# Coexistence-aware: lists what already runs here and changes nothing until you confirm.
# Safe to run again: it keeps the passwords, ports and data of an existing install, and updates it.
# ==============================================================================
# Usage:
#   sudo bash install.sh                        # build the images from source on this server
#   sudo bash install.sh --domain example.com   # panel at portal.example.com, apps at <name>.example.com
#   sudo bash install.sh --images ghcr          # pull the published images instead of building
#   sudo bash install.sh --dry-run              # show the plan, change nothing
#   sudo bash install.sh --yes                  # accept the plan without being asked
#   sudo bash install.sh --force                # install next to another control panel (side by side)
#   sudo bash install.sh --mode existing-panel  # side by side even on a free server
# More: --email you@example.com (Let's Encrypt), --version v3.1.0 (image tag or git ref),
#       --repo <git url>, --ref <branch or tag>, --dir /opt/dbbkp
# One command on a fresh server:
#   curl -fsSL https://raw.githubusercontent.com/iamPrashanta/deploy-king-platform/v3.x/scripts/install.sh | sudo bash -s -- --yes
# ==============================================================================

set -Eeo pipefail

DBBKP_VERSION="3.0.0"
INSTALL_DIR="/opt/dbbkp"
LOG_FILE="/var/log/dbbkp-install.log"
APP_USER="dbbkp"
REPO_URL="https://github.com/iamPrashanta/deploy-king-platform.git"
GHCR_PREFIX="ghcr.io/iamprashanta/deploy-king"

# ─── Parse flags ──────────────────────────────────────────────────────────────
INSTALL_MODE=""      # clean | existing-panel
USER_DOMAIN=""
ACME_EMAIL_FLAG=""
DRY_RUN=false
FORCE=false        # install next to another control panel
ASSUME_YES=false   # accept the plan without asking
IMAGES=""          # source (build here, the default) | ghcr (pull the published images)
WANT_VERSION=""    # ghcr: image tag; source: git ref, when --ref is not given
GIT_REF=""
REPO_FLAG=""

need_value() { [[ -n "$2" && "$2" != --* ]] || { echo "Missing value for $1" >&2; exit 1; }; }
while [[ $# -gt 0 ]]; do
  case $1 in
    --mode)     need_value "$1" "${2:-}"; INSTALL_MODE="$2"; shift 2 ;;
    --domain)   need_value "$1" "${2:-}"; USER_DOMAIN="$2";  shift 2 ;;
    --email)    need_value "$1" "${2:-}"; ACME_EMAIL_FLAG="$2"; shift 2 ;;
    --images)   need_value "$1" "${2:-}"; IMAGES="$2";       shift 2 ;;
    --version)  need_value "$1" "${2:-}"; WANT_VERSION="$2"; shift 2 ;;
    --ref)      need_value "$1" "${2:-}"; GIT_REF="$2";      shift 2 ;;
    --repo)     need_value "$1" "${2:-}"; REPO_FLAG="$2";    shift 2 ;;
    --dir)      need_value "$1" "${2:-}"; INSTALL_DIR="$2";  shift 2 ;;
    --dry-run)  DRY_RUN=true;      shift   ;;
    --force)    FORCE=true;        shift   ;;
    --yes|-y)   ASSUME_YES=true;   shift   ;;
    -h|--help)  sed -n '2,21p' "$0" 2>/dev/null | sed 's/^# \{0,1\}//'; exit 0 ;;
    *)          echo "Unknown option: $1 (see --help)" >&2; exit 1 ;;
  esac
done
STATE_FILE="$INSTALL_DIR/.install-state.json"

# ─── Logging ──────────────────────────────────────────────────────────────────
GREEN='\033[0;32m'; BLUE='\033[0;34m'; RED='\033[0;31m'
YELLOW='\033[1;33m'; CYAN='\033[0;36m'; BOLD='\033[1m'; NC='\033[0m'

_ts()   { date '+%Y-%m-%d %H:%M:%S'; }
log()   { echo -e "${BLUE}[INFO]${NC} $1" | tee -a "$LOG_FILE"; }
ok()    { echo -e "${GREEN}[OK]${NC}   $1" | tee -a "$LOG_FILE"; }
warn()  { echo -e "${YELLOW}[WARN]${NC} $1" | tee -a "$LOG_FILE"; }
err()   { echo -e "${RED}[ERR]${NC}  $1" | tee -a "$LOG_FILE" >&2; exit 1; }
step()  { echo -e "\n${BOLD}${CYAN}==> $1${NC}" | tee -a "$LOG_FILE"; }
info()  { echo -e "    ${YELLOW}$1${NC}"; }
dry()   { echo -e "    ${CYAN}[DRY-RUN]${NC} $1"; }

# A value from the .env of an existing install (empty when there is none).
env_get() {
  [[ -f "$INSTALL_DIR/.env" ]] && sed -n "s/^$1=//p" "$INSTALL_DIR/.env" | tail -n 1
  return 0
}

# ─── Dry-run guard ─────────────────────────────────────────────────────────────
run() {
  if $DRY_RUN; then dry "$*"; else eval "$*"; fi
}

# ─── Root check ───────────────────────────────────────────────────────────────
if [[ "$EUID" -ne 0 ]]; then
  err "This installer must be run as root (sudo bash install.sh)"
fi

mkdir -p "$(dirname "$LOG_FILE")"
$DRY_RUN || mkdir -p "$INSTALL_DIR"
echo "=== Deploy King install log — $(_ts) ===" >> "$LOG_FILE"

# Flags not given on a second run keep what the first run chose.
[[ -z "$IMAGES" ]] && IMAGES=$(env_get DK_IMAGES)
IMAGES="${IMAGES:-source}"
case "$IMAGES" in
  source|ghcr) ;;
  *) err "--images must be 'source' (build on this server) or 'ghcr' (pull the published images)" ;;
esac
case "$INSTALL_MODE" in
  ""|clean|existing-panel) ;;
  agent-only) err "--mode agent-only is not available yet: the agent has no published image. Nothing has been changed." ;;
  *) err "--mode must be 'clean' or 'existing-panel'" ;;
esac
[[ -z "$USER_DOMAIN" ]] && USER_DOMAIN=$(env_get DK_DOMAIN)
[[ -n "$USER_DOMAIN" && ! "$USER_DOMAIN" =~ ^[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?$ ]] && err "--domain must be a host name such as example.com"

# ─── Banner ───────────────────────────────────────────────────────────────────
echo -e "${BOLD}${BLUE}"
cat << 'EOF'
    ____             __               __ __ _
   / __ \___  ____  / /___  __  __   / //_/(_)___  ____ _
  / / / / _ \/ __ \/ / __ \/ / / /  / ,<  / / __ \/ __ `/
 / /_/ /  __/ /_/ / / /_/ / /_/ /  / /| |/ / / / / /_/ /
/_____/\___/ .___/_/\____/\__, /  /_/ |_/_/_/ /_/\__, /
          /_/            /____/                 /____/
EOF
echo -e "  Server installer v${DBBKP_VERSION}${NC}"
echo ""

# ==============================================================================
# PHASE 1: PRE-FLIGHT CHECKS
# ==============================================================================

step "Phase 1: Pre-flight Checks"

# ── OS detection ──────────────────────────────────────────────────────────────
if [[ ! -f /etc/os-release ]]; then
  err "Cannot detect OS. Only Ubuntu 20.04+ and Debian 11+ are supported."
fi
# Read in a subshell: os-release sets VERSION, ID and more, which must not leak into this script.
OS_ID=$(. /etc/os-release; echo "${ID:-}")
OS_NAME=$(. /etc/os-release; echo "${PRETTY_NAME:-unknown}")
if [[ "$OS_ID" != "ubuntu" && "$OS_ID" != "debian" ]]; then
  err "Unsupported OS: $OS_NAME. Only Ubuntu and Debian are supported."
fi
ok "OS: $OS_NAME"

# ── Architecture ──────────────────────────────────────────────────────────────
ARCH=$(uname -m)
if [[ "$ARCH" != "x86_64" && "$ARCH" != "aarch64" ]]; then
  warn "Architecture '$ARCH' is untested. Continuing anyway."
fi
ok "Arch: $ARCH"

# ── Resource checks ───────────────────────────────────────────────────────
if command -v free &>/dev/null; then RAM_MB=$(free -m | awk '/^Mem:/ {print $2}')
else RAM_MB=$(awk '/^MemTotal:/ {print int($2 / 1024)}' /proc/meminfo); fi   # minimal images have no procps
DISK_AT="$INSTALL_DIR"; while [[ ! -d "$DISK_AT" ]]; do DISK_AT=$(dirname "$DISK_AT"); done   # a dry run creates nothing
DISK_GB=$(df -BG "$DISK_AT" | awk 'NR==2 {gsub("G",""); print $4}')
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
# Without ss (a minimal image), the kernel's own list of listening sockets is read instead.
port_owner() {
  local line name hex
  if command -v ss &>/dev/null; then
    line=$(ss -H -ltnp 2>/dev/null | awk -v p="$1" '{ n = split($4, a, ":"); if (a[n] == p) { print; exit } }') || true
    [[ -z "$line" ]] && return 0
    name=$(sed -n 's/.*users:(("\([^"]*\)".*/\1/p' <<<"$line")
    echo "${name:-another program}"
  else
    hex=$(printf '%04X' "$1")
    # state 0A is LISTEN; the local address is the second column, ADDR:PORT in hex
    cat /proc/net/tcp /proc/net/tcp6 2>/dev/null \
      | awk -v h=":$hex" '$4 == "0A" && substr($2, length($2) - 4) == h { found = 1 } END { exit !found }' \
      && echo "another program"
    return 0
  fi
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
# Running again on an existing install: its own proxy on 80/443 is not "something else".
# Asked of Docker, because ss cannot always name the process that holds a published port.
own_port() {
  [[ "$(env_get "$1")" == "$2" ]] || return 1
  command -v docker &>/dev/null && docker port dbbkp-traefik 2>/dev/null | grep -qE ":$2\$"
}
if [[ -f "$INSTALL_DIR/.env" ]]; then
  [[ -n "$PORT80_OWNER" ]] && own_port TRAEFIK_HTTP_PORT 80 && PORT80_OWNER=""
  [[ -n "$PORT443_OWNER" ]] && own_port TRAEFIK_HTTPS_PORT 443 && PORT443_OWNER=""
fi

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

# Running again: keep the mode the first install chose, unless --mode says otherwise.
[[ -z "$INSTALL_MODE" ]] && INSTALL_MODE=$(env_get DK_INSTALL_MODE)
if [[ -z "$INSTALL_MODE" ]]; then
  if $NEEDS_SIDE_BY_SIDE; then INSTALL_MODE="existing-panel"; else INSTALL_MODE="clean"; fi
elif [[ "$INSTALL_MODE" == "clean" && -n "$PORT80_OWNER$PORT443_OWNER" ]]; then
  err "A clean install needs ports 80 and 443, but they are used by ${PORT80_OWNER:-$PORT443_OWNER}. Nothing has been changed. Run with --mode existing-panel to install side by side."
fi

if [[ "$INSTALL_MODE" == "existing-panel" ]]; then
  warn "Installing SIDE BY SIDE: ports 80 and 443 and every existing site stay exactly as they are."
fi

ok "Install mode: ${BOLD}$INSTALL_MODE${NC}"


# ── Existing installation ─────────────────────────────────────────────────────
EXISTING_INSTALL=false
if [[ -f "$INSTALL_DIR/.env" ]]; then
  EXISTING_INSTALL=true
  warn "Deploy King is already installed at $INSTALL_DIR. Running again keeps its data, passwords and ports, and updates it."
fi

# ==============================================================================
# PHASE 2: PORT DETECTION
# ==============================================================================

step "Phase 2: Port Auto-detection"

find_free_port() {
  local port="$1"
  local max=$((port + 100))
  while [[ $port -lt $max ]]; do
    if [[ -z "$(port_owner "$port")" ]]; then
      echo "$port"
      return
    fi
    port=$((port + 1))
  done
  err "Could not find free port starting from $1 within 100 attempts"
}

# A second run keeps the ports of the first (its own containers hold them now).
PANEL_PORT=$(env_get PANEL_PORT)
API_PORT=$(env_get API_PORT)
TRAEFIK_HTTP=$(env_get TRAEFIK_HTTP_PORT)
TRAEFIK_HTTPS=$(env_get TRAEFIK_HTTPS_PORT)
if [[ "$(env_get DK_INSTALL_MODE)" != "$INSTALL_MODE" ]]; then
  # new install, or the mode changed: choose again
  PANEL_PORT=""; API_PORT=""; TRAEFIK_HTTP=""; TRAEFIK_HTTPS=""
fi

if [[ "$INSTALL_MODE" == "clean" ]]; then
  PANEL_PORT=${PANEL_PORT:-$(find_free_port 3000)}
  API_PORT=${API_PORT:-$(find_free_port 4000)}
  TRAEFIK_HTTP=${TRAEFIK_HTTP:-80}
  TRAEFIK_HTTPS=${TRAEFIK_HTTPS:-443}
else
  # Coexistence: use high ports, never touch 80/443
  PANEL_PORT=${PANEL_PORT:-$(find_free_port 3100)}
  API_PORT=${API_PORT:-$(find_free_port 4100)}
  TRAEFIK_HTTP=${TRAEFIK_HTTP:-$(find_free_port 8088)}
  TRAEFIK_HTTPS=${TRAEFIK_HTTPS:-$(find_free_port 8444)}
fi

ok "Panel:   :$PANEL_PORT"
ok "API:     127.0.0.1:$API_PORT (this server only; browsers reach it through the panel)"
ok "Traefik: :$TRAEFIK_HTTP / :$TRAEFIK_HTTPS"
info "PostgreSQL and Redis run in containers and take no port on this server."

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
if [[ "${IMAGES:-source}" == "ghcr" ]]; then
  echo "    - Download the Deploy King images from ghcr.io (${GHCR_PREFIX:-ghcr.io}-api, -worker, -panel)"
else
  echo "    - Get the Deploy King source and build its images on this server (a few minutes)"
fi
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
if [[ "${IMAGES:-source}" == "source" && "${RAM_MB:-0}" -lt 1900 ]]; then
  echo -e "    ${YELLOW}Note:${NC} Building the images needs about 2 GB of memory. With less, add swap first, or use --images ghcr."
fi
echo ""
if [[ "${EXISTING_INSTALL:-false}" == true ]]; then
  echo -e "    ${YELLOW}Note:${NC} Deploy King is already installed here. Its data, passwords and ports are kept."
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

# Kept from the first install when there is one: the database and the stored secrets depend on them.
# Made from /dev/urandom with coreutils only: this runs before any package is installed.
rand_hex() { head -c "$1" /dev/urandom | od -An -v -tx1 | tr -d ' \n'; }
secret_hex() { local v; v=$(env_get "$1"); [[ -n "$v" ]] && echo "$v" || rand_hex "$2"; }
POSTGRES_PASSWORD=$(secret_hex POSTGRES_PASSWORD 24)
REDIS_PASSWORD=$(secret_hex REDIS_PASSWORD 24)
JWT_SECRET=$(secret_hex JWT_SECRET 48)
INTERNAL_SECRET=$(secret_hex INTERNAL_SECRET 32)
# 32-byte hex master key for AES-256-GCM secrets store
MASTER_KEY=$(secret_hex MASTER_KEY 32)
ADMIN_USER=$(env_get INITIAL_ADMIN_USERNAME); ADMIN_USER=${ADMIN_USER:-admin}
ADMIN_PASS=$(env_get INITIAL_ADMIN_PASSWORD)
[[ -z "$ADMIN_PASS" ]] && ADMIN_PASS=$(LC_ALL=C tr -dc 'A-Za-z0-9' </dev/urandom | head -c 16 || true)

if $EXISTING_INSTALL; then ok "Credentials kept from the existing install"; else ok "Credentials generated (kept only in $INSTALL_DIR/.env, readable by root)"; fi

# ==============================================================================
# PHASE 4: INSTALL DEPENDENCIES
# ==============================================================================

step "Phase 4: Installing System Dependencies"

has_systemd() { [[ -d /run/systemd/system ]]; }
version_ge() { [[ "$(printf '%s\n%s\n' "$2" "$1" | sort -V | head -n1)" == "$2" ]]; }

run "apt-get update -qq >/dev/null"
run "DEBIAN_FRONTEND=noninteractive apt-get install -y -qq curl git jq openssl ca-certificates iproute2 python3-minimal >/dev/null"
ok "Base packages installed"

# ── Docker ────────────────────────────────────────────────────────────────────
if ! command -v docker &>/dev/null; then
  log "Installing Docker Engine with the Compose and Buildx plugins (get.docker.com)..."
  run "curl -fsSL https://get.docker.com | sh >>'$LOG_FILE' 2>&1"
  ok "Docker installed"
else
  ok "Docker already installed: $(docker --version | awk '{print $3}' | tr -d ',')"
fi

if ! $DRY_RUN; then
  if ! docker info &>/dev/null; then
    if has_systemd; then
      systemctl enable --now docker >/dev/null 2>&1 || true
      sleep 2
    fi
    docker info &>/dev/null || err "Docker is installed but not running. Start it (systemctl start docker, or dockerd), then run the installer again."
  fi

  # Compose 2.24 or newer reads deploy/compose.yml (optional env files). Buildx builds the images.
  if ! docker compose version &>/dev/null; then
    apt-get install -y -qq docker-compose-plugin >/dev/null 2>&1 || apt-get install -y -qq docker-compose-v2 >/dev/null 2>&1 || true
  fi
  COMPOSE_VERSION=$(docker compose version --short 2>/dev/null | sed 's/^v//')
  [[ -n "$COMPOSE_VERSION" ]] || err "Docker Compose is missing. Install Docker from https://get.docker.com, then run the installer again."
  version_ge "$COMPOSE_VERSION" "2.24.0" || err "Docker Compose $COMPOSE_VERSION is too old (2.24 or newer is needed). Update Docker (https://get.docker.com), then run the installer again."
  if [[ "$IMAGES" == "source" ]] && ! docker buildx version &>/dev/null; then
    apt-get install -y -qq docker-buildx-plugin >/dev/null 2>&1 || apt-get install -y -qq docker-buildx >/dev/null 2>&1 || true
    docker buildx version &>/dev/null || err "Docker Buildx is missing; it builds the images. Install it (apt-get install docker-buildx-plugin), or use --images ghcr."
  fi
  ok "Docker Compose: $COMPOSE_VERSION"
fi

if id "$APP_USER" &>/dev/null; then
  getent group docker &>/dev/null && run "usermod -aG docker $APP_USER"
fi

# ==============================================================================
# PHASE 5: FIREWALL (SAFE — NO RESET)
# ==============================================================================

step "Phase 5: Firewall — Safe Port Opening"

if command -v ufw &>/dev/null; then
  # NEVER reset, NEVER change default policies on existing systems
  # Only ADD the ports we need. The API listens on 127.0.0.1 only and needs no rule.
  run "ufw allow $PANEL_PORT/tcp >/dev/null 2>&1 || true"

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
  info "Ensure ports $PANEL_PORT, $TRAEFIK_HTTP and $TRAEFIK_HTTPS are accessible"
fi

# ==============================================================================
# PHASE 6: SYSTEM USER & DIRECTORIES
# ==============================================================================

step "Phase 6: System User & Directories"

if ! id "$APP_USER" &>/dev/null; then
  run "useradd -r -m -s /bin/bash $APP_USER"
  getent group docker &>/dev/null && run "usermod -aG docker $APP_USER"
  ok "System user '$APP_USER' created"
else
  ok "System user '$APP_USER' already exists"
fi

run "mkdir -p $INSTALL_DIR/scan $INSTALL_DIR/scripts $INSTALL_DIR/actions/requests $INSTALL_DIR/actions/results"
run "mkdir -p /var/www/sites /var/log/dbbkp"
run "chown $APP_USER:$APP_USER $INSTALL_DIR /var/log/dbbkp"
ok "Directories created"

# ==============================================================================
# PHASE 7: GET THE SOURCE
# ==============================================================================

step "Phase 7: Deploy King Source"

# The compose files and the server watch come from the source; with --images source, the images too.
# Run from a checkout (sudo bash scripts/install.sh), it uses that checkout. Otherwise it keeps a
# clone in $INSTALL_DIR/src and brings it up to date on every run.
SCRIPT_PATH="${BASH_SOURCE[0]:-}"
LOCAL_SRC=""
if [[ -f "$SCRIPT_PATH" && -z "$REPO_FLAG" && -z "$GIT_REF" ]]; then
  candidate="$(cd "$(dirname "$SCRIPT_PATH")/.." && pwd)"
  [[ -f "$candidate/deploy/compose.yml" && -f "$candidate/apps/api/Dockerfile" ]] && LOCAL_SRC="$candidate"
fi
REPO="${REPO_FLAG:-$(env_get DK_GIT_REPO)}"; REPO="${REPO:-$REPO_URL}"
REF="${GIT_REF:-$WANT_VERSION}"; [[ -z "$REF" ]] && REF=$(env_get DK_GIT_REF)

if [[ -n "$LOCAL_SRC" ]]; then
  SOURCE_DIR="$LOCAL_SRC"
  ok "Using this checkout: $SOURCE_DIR"
else
  SOURCE_DIR="$INSTALL_DIR/src"
  if $DRY_RUN; then
    dry "Would clone or update $REPO${REF:+ ($REF)} in $SOURCE_DIR"
  elif [[ -d "$SOURCE_DIR/.git" ]]; then
    log "Updating $SOURCE_DIR from $REPO${REF:+ ($REF)}..."
    git -C "$SOURCE_DIR" remote set-url origin "$REPO"
    git -C "$SOURCE_DIR" fetch -q --depth 1 origin "${REF:-HEAD}" >>"$LOG_FILE" 2>&1 || err "Could not fetch ${REF:-the default branch} from $REPO"
    git -C "$SOURCE_DIR" checkout -q --force FETCH_HEAD
    ok "Source updated: $(git -C "$SOURCE_DIR" log -1 --format='%h %s' | cut -c1-70)"
  else
    log "Cloning $REPO${REF:+ ($REF)}..."
    rm -rf "$SOURCE_DIR"
    git clone -q --depth 1 ${REF:+--branch "$REF"} "$REPO" "$SOURCE_DIR" >>"$LOG_FILE" 2>&1 || err "Could not clone $REPO${REF:+ at $REF}"
    ok "Source cloned: $(git -C "$SOURCE_DIR" log -1 --format='%h %s' | cut -c1-70)"
  fi
fi
if ! $DRY_RUN && [[ ! -f "$SOURCE_DIR/deploy/compose.yml" ]]; then
  err "$SOURCE_DIR has no deploy/compose.yml. This version of Deploy King predates the container install; use a newer --ref or --version."
fi

if [[ "$IMAGES" == "ghcr" ]]; then
  IMAGE_PREFIX="$GHCR_PREFIX"
  IMAGE_TAG="${WANT_VERSION#v}"; IMAGE_TAG="${IMAGE_TAG:-$(env_get DK_TAG)}"
  [[ -z "$IMAGE_TAG" || "$IMAGE_TAG" == local ]] && IMAGE_TAG=latest
  DK_VERSION_VALUE="$IMAGE_TAG"
else
  IMAGE_PREFIX="deploy-king"
  IMAGE_TAG="local"
  DK_VERSION_VALUE=$(git -C "$SOURCE_DIR" describe --tags --always 2>/dev/null || echo "source")
fi

# ==============================================================================
# PHASE 8: CONFIGURATION (.env AND COMPOSE FILES)
# ==============================================================================

step "Phase 8: Writing Configuration"

SERVER_IP=$(curl -s --max-time 5 https://api.ipify.org 2>/dev/null || true)
[[ "$SERVER_IP" =~ ^[0-9a-fA-F.:]+$ ]] || SERVER_IP=$(hostname -I 2>/dev/null | awk '{print $1}')
SERVER_IP=${SERVER_IP:-127.0.0.1}

# Addresses. With a domain: the panel at portal.<domain>, apps at <name>.<domain>
# (side by side: <name>.apps.<domain>, which is what the web server examples pass on).
TLS=false
if [[ -n "$USER_DOMAIN" ]]; then
  PANEL_DOMAIN="portal.$USER_DOMAIN"
  if [[ "$INSTALL_MODE" == "clean" ]]; then
    BASE_DOMAIN="$USER_DOMAIN"; TLS=true
    PANEL_URL="https://$PANEL_DOMAIN"
  else
    BASE_DOMAIN="apps.$USER_DOMAIN"
    PANEL_URL="http://$PANEL_DOMAIN"
  fi
else
  PANEL_DOMAIN="portal.localhost"; BASE_DOMAIN="localhost"
  PANEL_URL="http://$SERVER_IP:$PANEL_PORT"
fi
COMPOSE_FILES="compose.yml"; $TLS && COMPOSE_FILES="compose.yml:compose.tls.yml"
ACME_EMAIL="${ACME_EMAIL_FLAG:-$(env_get ACME_EMAIL)}"

ENV_FILE="$INSTALL_DIR/.env"
# Sets one line of .env and leaves every other line, including your own additions, as it is.
env_set() {
  local tmp="$ENV_FILE.tmp"
  K="$1" V="$2" awk 'BEGIN { k = ENVIRON["K"]; v = ENVIRON["V"]; done = 0 }
    index($0, k "=") == 1 { if (!done) print k "=" v; done = 1; next }
    { print }
    END { if (!done) print k "=" v }' "$ENV_FILE" > "$tmp"
  cat "$tmp" > "$ENV_FILE"; rm -f "$tmp"
}

if $DRY_RUN; then
  dry "Would write $ENV_FILE and copy the compose files ($COMPOSE_FILES) to $INSTALL_DIR"
else
  umask 077
  if [[ ! -f "$ENV_FILE" ]]; then
    cat > "$ENV_FILE" << 'ENVEOF'
# Deploy King settings, read by docker compose in this folder. Written by scripts/install.sh.
# The installer sets the lines it knows on every run and keeps everything else, so add your own below.
# All settings: deploy/.env.example in the source, and the Configuration section of README.md.
ENVEOF
  fi
  env_set DK_INSTALL_MODE "$INSTALL_MODE"
  env_set DK_IMAGES "$IMAGES"
  env_set DK_DOMAIN "$USER_DOMAIN"
  env_set DK_GIT_REPO "$REPO"
  env_set DK_GIT_REF "$REF"
  env_set COMPOSE_FILE "$COMPOSE_FILES"
  env_set DK_SOURCE "$SOURCE_DIR"
  env_set DK_IMAGE_PREFIX "$IMAGE_PREFIX"
  env_set DK_TAG "$IMAGE_TAG"
  env_set DK_VERSION "$DK_VERSION_VALUE"
  env_set POSTGRES_PASSWORD "$POSTGRES_PASSWORD"
  env_set REDIS_PASSWORD "$REDIS_PASSWORD"
  env_set JWT_SECRET "$JWT_SECRET"
  env_set INTERNAL_SECRET "$INTERNAL_SECRET"
  env_set MASTER_KEY "$MASTER_KEY"
  env_set INITIAL_ADMIN_USERNAME "$ADMIN_USER"
  env_set INITIAL_ADMIN_PASSWORD "$ADMIN_PASS"
  env_set DBBKP_BASE_DOMAIN "$BASE_DOMAIN"
  env_set PANEL_DOMAIN "$PANEL_DOMAIN"
  env_set DBBKP_TLS "$TLS"
  env_set ACME_EMAIL "$ACME_EMAIL"
  env_set PUBLIC_API_URL "$PANEL_URL"
  env_set PANEL_PORT "$PANEL_PORT"
  env_set API_PORT "$API_PORT"
  env_set TRAEFIK_HTTP_PORT "$TRAEFIK_HTTP"
  env_set TRAEFIK_HTTPS_PORT "$TRAEFIK_HTTPS"
  env_set DK_SITES_DIR /var/www/sites
  env_set DK_SCAN_DIR "$INSTALL_DIR/scan"
  env_set DK_ACTION_REQUESTS_DIR "$INSTALL_DIR/actions/requests"
  env_set DK_ACTION_RESULTS_DIR "$INSTALL_DIR/actions/results"
  # Optional overrides from the environment, e.g. a base image from a registry mirror.
  for key in DK_NODE_IMAGE DK_POSTGRES_IMAGE DK_REDIS_IMAGE DK_TRAEFIK_IMAGE; do
    [[ -n "${!key:-}" ]] && env_set "$key" "${!key}"
  done
  chmod 600 "$ENV_FILE"
  umask 022
  cp "$SOURCE_DIR/deploy/compose.yml" "$SOURCE_DIR/deploy/compose.tls.yml" "$INSTALL_DIR/"
  [[ -f "$SOURCE_DIR/deploy/compose.desktop.yml" ]] && cp "$SOURCE_DIR/deploy/compose.desktop.yml" "$INSTALL_DIR/"
  # The compose file of installers before 3.0 pulled images that were never published.
  [[ -f "$INSTALL_DIR/docker-compose.yml" ]] && mv "$INSTALL_DIR/docker-compose.yml" "$INSTALL_DIR/docker-compose.yml.old"
  ok "Configuration written to $ENV_FILE (compose files: $COMPOSE_FILES)"
fi

# ==============================================================================
# PHASE 9: SYSTEMD SERVICE
# ==============================================================================

step "Phase 9: Installing Systemd Service"

UP_FLAGS="--remove-orphans"; [[ "$IMAGES" == "ghcr" ]] && UP_FLAGS="--remove-orphans --no-build"
if $DRY_RUN; then
  dry "Would install /etc/systemd/system/dbbkp.service (starts the containers at boot)"
elif has_systemd; then
  cat > /etc/systemd/system/dbbkp.service << SVCEOF
[Unit]
Description=Deploy King
Requires=docker.service
After=docker.service network-online.target
Wants=network-online.target

[Service]
Type=oneshot
RemainAfterExit=yes
WorkingDirectory=$INSTALL_DIR
ExecStart=/usr/bin/env docker compose up -d $UP_FLAGS
ExecStop=/usr/bin/env docker compose down
TimeoutStartSec=900
StandardOutput=journal
StandardError=journal
SyslogIdentifier=dbbkp

[Install]
WantedBy=multi-user.target
SVCEOF
  systemctl daemon-reload
  systemctl enable dbbkp.service >/dev/null 2>&1
  ok "Systemd service installed (dbbkp.service)"
else
  warn "No systemd here: skipping dbbkp.service. The containers still restart with Docker (restart: unless-stopped)."
fi

# ==============================================================================
# PHASE 10: SAVE INSTALL STATE
# ==============================================================================

step "Phase 10: Saving Install State"

if $DRY_RUN; then
  dry "Would write $STATE_FILE"
else
  cat > "$STATE_FILE" << STATEEOF
{
  "version": "${DBBKP_VERSION}",
  "installedAt": "$(_ts)",
  "mode": "${INSTALL_MODE}",
  "images": "${IMAGES}",
  "source": "${SOURCE_DIR}",
  "serverIp": "${SERVER_IP}",
  "domain": "${USER_DOMAIN:-localhost}",
  "panelUrl": "${PANEL_URL}",
  "ports": {
    "panel": ${PANEL_PORT},
    "api": ${API_PORT},
    "traefikHttp": ${TRAEFIK_HTTP},
    "traefikHttps": ${TRAEFIK_HTTPS}
  },
  "services": ["dbbkp-postgres","dbbkp-redis","dbbkp-traefik","dbbkp-api","dbbkp-worker","dbbkp-panel"],
  "controlPanels": [$(printf '"%s",' "${CONTROL_PANELS[@]}" | sed 's/,$//; s/^"",\{0,1\}$//')],
  "webServers": [$(printf '"%s",' "${WEB_SERVERS[@]}" | sed 's/,$//; s/^"",\{0,1\}$//')],
  "port80": "${PORT80_OWNER}",
  "port443": "${PORT443_OWNER}",
  "existingSites": ${EXISTING_SITE_COUNT:-0},
  "detectedPanels": [$(printf '"%s",' "${DETECTED_PANELS[@]}" | sed 's/,$//; s/^"",\{0,1\}$//')]
}
STATEEOF
  chmod 600 "$STATE_FILE"
  ok "Install state saved to $STATE_FILE"
fi

# ==============================================================================
# PHASE 11: SERVER WATCH, SIDE-BY-SIDE EXAMPLES
# ==============================================================================

step "Phase 11: Server Watch"

# ── Server watch ────────────────────────────────────────────────────────
# A read-only scan every five minutes (scripts/host-scan.py). Its first list is what the admin reviews
# on the Security page: everything that was on this server before or at install.
SRC_DIR="$SOURCE_DIR/scripts"
if $DRY_RUN; then
  dry "Would install the server watch (dbbkp-scan.timer)"
elif [[ -f "$SRC_DIR/host-scan.py" && -f "$SRC_DIR/install-scan.sh" ]]; then
  cp "$SRC_DIR"/*.sh "$SRC_DIR/host-scan.py" "$SRC_DIR/host-act.py" "$INSTALL_DIR/scripts/"
  if ! has_systemd; then
    warn "The server watch needs systemd, which this system does not have; it is not installed."
  elif env INSTALL_DIR="$INSTALL_DIR" bash "$INSTALL_DIR/scripts/install-scan.sh" >>"$LOG_FILE" 2>&1; then
    ok "Server watch installed (read-only, every 5 minutes)"
  else
    warn "The server watch could not be installed. Later: sudo bash $INSTALL_DIR/scripts/install-scan.sh"
  fi
else
  warn "host-scan.py was not found in $SRC_DIR, so the server watch is not installed."
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

ADMIN_WORKS=false
if $DRY_RUN; then
  if [[ "$IMAGES" == "ghcr" ]]; then dry "Would run: docker compose pull"; else dry "Would run: docker compose build"; fi
  dry "Would run: cd $INSTALL_DIR && docker compose up -d --wait $UP_FLAGS"
else
  cd "$INSTALL_DIR"
  show_log_tail() { echo "    Last lines of $LOG_FILE:" >&2; tail -n 25 "$LOG_FILE" | sed 's/^/      /' >&2; }
  if [[ "$IMAGES" == "ghcr" ]]; then
    log "Downloading images ($IMAGE_PREFIX-*:$IMAGE_TAG)..."
    docker compose pull >>"$LOG_FILE" 2>&1 || { show_log_tail; err "Could not download the images. Are they published for tag '$IMAGE_TAG'? Without them, run again with --images source."; }
  else
    log "Building the images from $SOURCE_DIR (a few minutes; progress in $LOG_FILE)..."
    BUILD_START=$(date +%s)
    # One at a time: a small server runs out of memory building all three together.
    for svc in dbbkp-api dbbkp-worker dbbkp-panel; do
      docker compose build "$svc" >>"$LOG_FILE" 2>&1 || { show_log_tail; err "The image build failed ($svc). Nothing that was running has been stopped."; }
    done
    ok "Images built in $(( $(date +%s) - BUILD_START ))s"
  fi
  log "Starting the containers and waiting until each one is healthy..."
  # shellcheck disable=SC2086
  if docker compose up -d --wait --wait-timeout 600 $UP_FLAGS >>"$LOG_FILE" 2>&1; then
    ok "All containers are running and healthy"
  else
    show_log_tail
    docker compose ps >&2 || true
    err "Some containers did not become healthy. See: cd $INSTALL_DIR && docker compose logs"
  fi
  has_systemd && systemctl start dbbkp.service >/dev/null 2>&1 || true

  # The password printed below must really work: sign in with it.
  LOGIN=$(curl -s --max-time 15 "http://127.0.0.1:$API_PORT/api/auth/login" -H 'content-type: application/json' \
    -d "{\"username\":\"$ADMIN_USER\",\"password\":\"$ADMIN_PASS\"}" || true)
  [[ "$LOGIN" == *'"token"'* ]] && ADMIN_WORKS=true
fi

# ==============================================================================
# COMPLETION SUMMARY
# ==============================================================================

echo ""
echo -e "${BOLD}${GREEN}╔══════════════════════════════════════════════════════╗${NC}"
if $DRY_RUN; then
echo -e "${BOLD}${GREEN}║    Dry run finished. Nothing was changed.            ║${NC}"
else
echo -e "${BOLD}${GREEN}║    Deploy King is installed and running              ║${NC}"
fi
echo -e "${BOLD}${GREEN}╚══════════════════════════════════════════════════════╝${NC}"
echo ""
echo -e "  ${BOLD}Panel${NC}         : ${CYAN}http://${SERVER_IP}:${PANEL_PORT}${NC}"
if [[ -n "$USER_DOMAIN" ]]; then
  echo -e "                  ${CYAN}${PANEL_URL}${NC} (once ${PANEL_DOMAIN} points at this server)"
  echo -e "  ${BOLD}Apps${NC}          : <name>.${BASE_DOMAIN} (point *.${BASE_DOMAIN} at this server)"
else
  echo -e "  ${BOLD}Apps${NC}          : http://<name>.localhost on this server only. For public addresses, run again with --domain example.com"
fi
echo -e "  ${BOLD}Mode${NC}          : ${YELLOW}${INSTALL_MODE}${NC}, images: ${IMAGES}"
if [[ ${#DETECTED_PANELS[@]} -gt 0 ]]; then
  echo -e "  ${BOLD}Coexisting with${NC}: ${YELLOW}${DETECTED_PANELS[*]}${NC}"
fi
echo ""
if [[ "$INSTALL_MODE" == "existing-panel" ]]; then
  echo -e "  ${BOLD}Next step${NC}     : your web server still answers on ports 80 and 443. To give Deploy King"
  echo -e "                  an address, copy ${CYAN}$SIDE_DIR/nginx.conf${NC} (or apache.conf) as its first lines explain."
  echo ""
fi
echo -e "  ${BOLD}User name${NC}     : ${YELLOW}${ADMIN_USER}${NC}"
if $ADMIN_WORKS; then
  echo -e "  ${BOLD}Admin password${NC}: ${YELLOW}${ADMIN_PASS}${NC}  (checked: it signs in. You are asked to change it.)"
elif $DRY_RUN; then
  echo -e "  ${BOLD}Admin password${NC}: shown here after a real run"
else
  echo -e "  ${BOLD}Admin password${NC}: the one you chose at the first sign-in (this run did not change it)."
  echo -e "                  Forgot it? ${CYAN}docker exec dbbkp-api tsx node_modules/@dbbkp/db/src/reset-admin.ts 'new-password'${NC}"
fi
echo -e "  ${BOLD}Install log${NC}   : ${LOG_FILE}"
echo -e "  ${BOLD}State file${NC}    : ${STATE_FILE}"
echo ""
echo -e "  ${BOLD}Credentials are stored in:${NC} ${CYAN}$INSTALL_DIR/.env${NC}"
echo -e "  ${YELLOW}Keep this file secure — it contains all secrets. Keep a copy of MASTER_KEY.${NC}"
echo ""
echo -e "  ${BOLD}Useful commands:${NC}"
echo -e "    ${CYAN}cd $INSTALL_DIR && docker compose ps${NC}       — containers"
echo -e "    ${CYAN}cd $INSTALL_DIR && docker compose logs -f${NC}  — live logs"
echo -e "    ${CYAN}bash $INSTALL_DIR/scripts/doctor.sh${NC}        — health check"
echo -e "    ${CYAN}sudo bash $INSTALL_DIR/scripts/update.sh${NC}   — update (or run this installer again)"
echo ""
