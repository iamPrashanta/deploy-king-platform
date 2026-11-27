#!/usr/bin/env bash
# ==============================================================================
# Deploy King platform backup: the platform's own database and its settings
# (/opt/dbbkp, without the source clone). App sources in /var/www/sites are not included.
#   sudo bash /opt/dbbkp/scripts/backup-platform.sh
# Restore with restore-platform.sh <file>.
# ==============================================================================
set -Eeo pipefail

INSTALL_DIR="${INSTALL_DIR:-/opt/dbbkp}"
BACKUP_DIR="${BACKUP_DIR:-/var/backups/dbbkp}"
DATE=$(date +%Y-%m-%d_%H-%M-%S)
BACKUP_FILE="$BACKUP_DIR/platform_backup_$DATE.tar.gz"
env_get() { sed -n "s/^$1=//p" "$INSTALL_DIR/.env" 2>/dev/null | tail -n 1; }
DB_USER=$(env_get POSTGRES_USER); DB_USER=${DB_USER:-dbbkp}
DB_NAME=$(env_get POSTGRES_DB); DB_NAME=${DB_NAME:-dbbkp_panel}

[[ "$EUID" -eq 0 ]] || { echo "Please run as root" >&2; exit 1; }
umask 077
mkdir -p "$BACKUP_DIR"
WORK=$(mktemp -d); trap 'rm -rf "$WORK"' EXIT

echo "Backing up the platform database ($DB_NAME)..."
docker exec dbbkp-postgres pg_dump -U "$DB_USER" --clean --if-exists "$DB_NAME" > "$WORK/platform-db.sql"

echo "Backing up settings..."
tar -czf "$BACKUP_FILE" --exclude="$INSTALL_DIR/src" -C / "${INSTALL_DIR#/}" -C "$WORK" platform-db.sql

echo "Backup stored at: $BACKUP_FILE (it contains every secret: keep it safe)"
