#!/usr/bin/env bash
# ==============================================================================
# Deploy King platform restore, from a file made by backup-platform.sh.
#   sudo bash /opt/dbbkp/scripts/restore-platform.sh /var/backups/dbbkp/platform_backup_<date>.tar.gz
# Replaces the platform database and settings. Running apps are not touched.
# ==============================================================================
set -Eeo pipefail

INSTALL_DIR="${INSTALL_DIR:-/opt/dbbkp}"
RED='\033[0;31m'; NC='\033[0m'
err() { echo -e "${RED}[ERR]${NC} $1" >&2; exit 1; }
env_get() { sed -n "s/^$1=//p" "$INSTALL_DIR/.env" 2>/dev/null | tail -n 1; }

[[ "$EUID" -eq 0 ]] || err "Please run as root"
BACKUP_FILE="${1:-}"
[[ -n "$BACKUP_FILE" ]] || { echo "Usage: $0 <path_to_backup.tar.gz>"; exit 1; }
[[ -f "$BACKUP_FILE" ]] || err "Backup file $BACKUP_FILE not found"

cd "$INSTALL_DIR" 2>/dev/null || mkdir -p "$INSTALL_DIR"
echo "Stopping the API, worker and panel..."
docker compose stop dbbkp-api dbbkp-worker dbbkp-panel >/dev/null 2>&1 || true

echo "Restoring settings..."
WORK=$(mktemp -d); trap 'rm -rf "$WORK"' EXIT
tar -xzf "$BACKUP_FILE" -C / --exclude=platform-db.sql
tar -xzf "$BACKUP_FILE" -C "$WORK" platform-db.sql 2>/dev/null || true
cd "$INSTALL_DIR"

if [[ -f "$WORK/platform-db.sql" ]]; then
  echo "Restoring the database..."
  docker compose up -d --wait dbbkp-postgres >/dev/null
  DB_USER=$(env_get POSTGRES_USER); DB_USER=${DB_USER:-dbbkp}
  DB_NAME=$(env_get POSTGRES_DB); DB_NAME=${DB_NAME:-dbbkp_panel}
  docker exec -i dbbkp-postgres psql -q -v ON_ERROR_STOP=1 -U "$DB_USER" "$DB_NAME" < "$WORK/platform-db.sql" >/dev/null
fi

echo "Starting services..."
docker compose up -d --wait >/dev/null
echo "Platform restored."
