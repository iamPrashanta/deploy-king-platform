#!/bin/sh
# Starts the panel. Next.js writes the API address into its rewrites at build time;
# when API_INTERNAL_URL is not the address the image was built with, put the real one in.
set -e
BUILT_WITH="http://dbbkp-api:4000"
NEXT_DIR=/app/apps/panel/.next
API="${API_INTERNAL_URL%/}"
if [ -n "$API" ] && [ -f "$NEXT_DIR/routes-manifest.build.json" ]; then
  # | is not allowed in a URL, so it is safe as the sed separator
  sed "s|$BUILT_WITH|$API|g" "$NEXT_DIR/routes-manifest.build.json" > "$NEXT_DIR/routes-manifest.json"
fi
exec "$@"
