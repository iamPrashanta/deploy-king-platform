#!/bin/bash
# sync the repo (read-only mount at /src) into the working copy and normalise line endings
set -e
rsync -a --exclude node_modules --exclude .git --exclude .next --exclude .env --exclude 'packages/db/drizzle' /src/ /work/
cd /work
find apps packages scripts -name node_modules -prune -o -type f \( -name '*.ts' -o -name '*.tsx' -o -name '*.js' -o -name '*.json' -o -name '*.sh' -o -name '*.css' \) -print0 | xargs -0 sed -i 's/\r$//'
sed -i 's/\r$//' package.json tsconfig.json pnpm-workspace.yaml turbo.json
if [ "$1" = "install" ]; then pnpm install > /work/_install.log 2>&1 || { tail -20 /work/_install.log; exit 1; }; fi
echo synced