#!/usr/bin/env bash
# ==============================================================================
# Installs dk, the Deploy King assistant for the terminal.
# ==============================================================================
# Usage (from a checkout of this repository):
#   bash scripts/install-dk.sh                 # build apps/cli and install dk for you (~/.local/bin)
#   sudo bash scripts/install-dk.sh --system   # install for everyone (/usr/local/bin)
#   bash scripts/install-dk.sh --dir ~/bin     # install into a folder of your choice
#   bash scripts/install-dk.sh --from dk.mjs   # install a bundle that was already built
#   bash scripts/install-dk.sh --uninstall     # remove it again (add --system or --dir as when installing)
#
# dk is one file (dist/dk.mjs) that needs Node.js 18 or newer and nothing else. Your settings live in
# ~/.config/deploy-king/config.json (readable only by you); uninstalling leaves them.
# ==============================================================================
set -Eeuo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEST="${HOME}/.local/bin"
FROM=""
UNINSTALL=false

while [ $# -gt 0 ]; do
  case "$1" in
    --system) DEST="/usr/local/bin" ;;
    --dir) DEST="${2:?--dir needs a folder}"; shift ;;
    --from) FROM="${2:?--from needs a file}"; shift ;;
    --uninstall) UNINSTALL=true ;;
    -h|--help) sed -n '2,14p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "Unknown option: $1 (see --help)" >&2; exit 2 ;;
  esac
  shift
done

say() { printf '\033[32m●\033[0m %s\n' "$*"; }
fail() { printf '\033[31m●\033[0m %s\n' "$*" >&2; exit 1; }

TARGET="${DEST%/}/dk"

if $UNINSTALL; then
  if [ -e "$TARGET" ]; then rm -f "$TARGET"; say "Removed $TARGET"; else say "dk is not installed in $DEST"; fi
  say "Your settings in ~/.config/deploy-king were kept. Remove that folder to forget them."
  exit 0
fi

command -v node >/dev/null 2>&1 || fail "Node.js 18 or newer is needed: https://nodejs.org"
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
[ "$NODE_MAJOR" -ge 18 ] || fail "Node.js 18 or newer is needed (this is $(node -v))."

if [ -z "$FROM" ]; then
  FROM="$ROOT/apps/cli/dist/dk.mjs"
  command -v pnpm >/dev/null 2>&1 || fail "pnpm is needed to build dk from source (npm i -g pnpm@9), or pass --from <dk.mjs>."
  [ -d "$ROOT/node_modules" ] || { say "Installing packages"; (cd "$ROOT" && pnpm install --frozen-lockfile); }
  say "Building dk"
  LOG="$(cd "$ROOT" && pnpm --filter @dbbkp/cli build 2>&1)" || { echo "$LOG" >&2; fail "The build failed."; }
fi
[ -f "$FROM" ] || fail "No bundle at $FROM"

mkdir -p "$DEST"
install -m 0755 "$FROM" "$TARGET"
say "Installed $TARGET ($("$TARGET" --version))"

case ":$PATH:" in
  *":$DEST:"*) ;;
  *) echo "  $DEST is not on your PATH. Add it, for example: echo 'export PATH=\"$DEST:\$PATH\"' >> ~/.bashrc" ;;
esac
echo "  Next: dk login        (the token comes from the panel: AI agents → New token)"
echo "        export ANTHROPIC_API_KEY=…   or   dk config set anthropic-key"
