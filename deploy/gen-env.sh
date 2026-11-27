#!/usr/bin/env bash
# Writes deploy/.env with new random secrets and an admin password, for deploy/compose.yml.
#   bash deploy/gen-env.sh            # does nothing if deploy/.env exists
#   bash deploy/gen-env.sh --force    # replaces it (a database that already exists keeps its old password)
set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OUT="$DIR/.env"
if [[ -f "$OUT" && "${1:-}" != "--force" ]]; then
  echo "$OUT exists; nothing changed. Use --force to replace it."
  exit 0
fi
hex() { openssl rand -hex "$1"; }
ADMIN_PASS="$(openssl rand -base64 18 | tr -dc 'A-Za-z0-9' | head -c 16)"
umask 077
sed -e "s|^POSTGRES_PASSWORD=.*|POSTGRES_PASSWORD=$(hex 24)|" \
    -e "s|^REDIS_PASSWORD=.*|REDIS_PASSWORD=$(hex 24)|" \
    -e "s|^JWT_SECRET=.*|JWT_SECRET=$(hex 48)|" \
    -e "s|^INTERNAL_SECRET=.*|INTERNAL_SECRET=$(hex 32)|" \
    -e "s|^MASTER_KEY=.*|MASTER_KEY=$(hex 32)|" \
    -e "s|^INITIAL_ADMIN_PASSWORD=.*|INITIAL_ADMIN_PASSWORD=$ADMIN_PASS|" \
    "$DIR/.env.example" > "$OUT"
echo "Wrote $OUT"
echo "First sign-in: admin / $ADMIN_PASS (you are asked to change it)"
