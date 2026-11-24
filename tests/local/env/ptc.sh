#!/bin/bash
# typecheck the panel
cd /work/apps/panel && npx tsc --noEmit > /work/_tsc_panel.log 2>&1
echo "panel_exit=$? errors=$(grep -c 'error TS' /work/_tsc_panel.log)"
cut -c1-260 /work/_tsc_panel.log | head -${1:-60}
