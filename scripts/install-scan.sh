#!/usr/bin/env bash
# ==============================================================================
# Deploy King: turn on the server watch
# ==============================================================================
# Installs scripts/host-scan.py and a timer that runs it every five minutes. The scan only reads:
# it lists users, admin rights, SSH keys and settings, scheduled jobs, services, startup files and
# listening ports, and writes the list to a file the panel reads. See the Security page.
#
# It also installs the action helper (scripts/host-act.py), which carries out "Remove" and "Undo" from
# the Security page: a fixed list of actions, each checked again on the server, with a copy kept for undo.
#
#   sudo bash install-scan.sh               install, or update both scripts, and run the scan once
#   sudo bash install-scan.sh --no-actions  the scan only; findings are then removed by hand
#   sudo bash install-scan.sh --remove      stop both and remove them (old reports and undo copies are kept)
#   INSTALL_DIR=/opt/dbbkp                where the panel is installed (default)
# ==============================================================================
set -Eeuo pipefail

INSTALL_DIR="${INSTALL_DIR:-/opt/dbbkp}"
SCAN_DIR="$INSTALL_DIR/scan"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SERVICE=/etc/systemd/system/dbbkp-scan.service
TIMER=/etc/systemd/system/dbbkp-scan.timer
ACT_DIR="$INSTALL_DIR/actions"
ACT_UNITS=(/etc/systemd/system/dbbkp-act.service /etc/systemd/system/dbbkp-act.path /etc/systemd/system/dbbkp-act.timer)
ACTIONS=true
[[ "${1:-}" == "--no-actions" ]] && ACTIONS=false

if [[ "$EUID" -ne 0 ]]; then
  echo "Run this as root (sudo bash install-scan.sh). The scan must read every user's SSH keys." >&2
  exit 1
fi

if [[ "${1:-}" == "--remove" ]]; then
  systemctl disable --now dbbkp-scan.timer dbbkp-act.path dbbkp-act.timer 2>/dev/null || true
  rm -f "$SERVICE" "$TIMER" "${ACT_UNITS[@]}"
  systemctl daemon-reload
  echo "The server watch is off. The panel will say that it stopped reporting."
  exit 0
fi

if [[ ! -f "$HERE/host-scan.py" ]]; then
  echo "host-scan.py is not next to this script ($HERE). Copy both files from the scripts folder of the repository." >&2
  exit 1
fi
if ! command -v python3 >/dev/null 2>&1; then
  echo "Installing python3 (the scan needs it; nothing else)..."
  apt-get install -y -qq python3-minimal >/dev/null
fi
if ! command -v systemctl >/dev/null 2>&1; then
  echo "This server has no systemd. Run the scan from cron instead:" >&2
  echo "  */5 * * * * root /usr/bin/python3 $SCAN_DIR/host-scan.py --out $SCAN_DIR/inventory.json" >&2
  exit 1
fi

install -d -m 755 "$SCAN_DIR"
# Only root may change the script: whoever can edit it decides what the panel is told.
install -m 700 -o root -g root "$HERE/host-scan.py" "$SCAN_DIR/host-scan.py"

cat > "$SERVICE" << UNITEOF
[Unit]
Description=Deploy King server watch (read-only scan)
Documentation=file://$SCAN_DIR/host-scan.py

[Service]
Type=oneshot
ExecStart=/usr/bin/env python3 $SCAN_DIR/host-scan.py --out $SCAN_DIR/inventory.json
Nice=10
IOSchedulingClass=idle
TimeoutStartSec=120
# It reads the whole server and writes one file.
ProtectSystem=strict
ProtectHome=read-only
ReadWritePaths=$SCAN_DIR
NoNewPrivileges=yes
PrivateTmp=yes
UNITEOF

cat > "$TIMER" << UNITEOF
[Unit]
Description=Deploy King server watch, every five minutes

[Timer]
OnBootSec=2min
OnUnitActiveSec=5min
AccuracySec=30s

[Install]
WantedBy=timers.target
UNITEOF

if $ACTIONS && [[ -f "$HERE/host-act.py" ]]; then
  install -m 700 -o root -g root "$HERE/host-act.py" "$SCAN_DIR/host-act.py"
  # The panel writes requests here; only the helper's answers come back. Undo copies live elsewhere, root only.
  install -d -m 755 "$ACT_DIR" "$ACT_DIR/results"
  # Only root may write requests: the API container runs as root; ordinary users on the server cannot.
  install -d -m 700 -o root -g root "$ACT_DIR/requests"
  install -d -m 700 /var/lib/dbbkp-actions
  cat > /etc/systemd/system/dbbkp-act.service << UNITEOF
[Unit]
Description=Deploy King action helper (Remove and Undo from the Security page)
Documentation=file://$SCAN_DIR/host-act.py

[Service]
Type=oneshot
ExecStart=/usr/bin/env python3 $SCAN_DIR/host-act.py --dir $ACT_DIR --state /var/lib/dbbkp-actions
TimeoutStartSec=120
UNITEOF
  # Runs as soon as a request arrives.
  cat > /etc/systemd/system/dbbkp-act.path << UNITEOF
[Unit]
Description=Deploy King action helper, on each request

[Path]
PathExistsGlob=$ACT_DIR/requests/*.json
Unit=dbbkp-act.service

[Install]
WantedBy=paths.target
UNITEOF
  # And every five minutes, so the panel knows the helper is there.
  cat > /etc/systemd/system/dbbkp-act.timer << UNITEOF
[Unit]
Description=Deploy King action helper, heartbeat

[Timer]
OnBootSec=1min
OnUnitActiveSec=5min

[Install]
WantedBy=timers.target
UNITEOF
elif ! $ACTIONS; then
  systemctl disable --now dbbkp-act.path dbbkp-act.timer 2>/dev/null || true
  rm -f "${ACT_UNITS[@]}"
fi

systemctl daemon-reload
systemctl enable --now dbbkp-scan.timer >/dev/null
if $ACTIONS && [[ -f /etc/systemd/system/dbbkp-act.service ]]; then
  systemctl enable --now dbbkp-act.path dbbkp-act.timer >/dev/null
  systemctl start dbbkp-act.service || echo "The action helper did not start. See: journalctl -u dbbkp-act.service -n 30" >&2
  echo "The action helper is on: Remove and Undo on the Security page work. (Turn it off with --no-actions.)"
fi
if systemctl start dbbkp-scan.service; then
  COUNT=$(python3 -c "import json;print(len(json.load(open('$SCAN_DIR/inventory.json'))['items']))" 2>/dev/null || echo "?")
  echo "The server watch is on. First list: $COUNT things, written to $SCAN_DIR/inventory.json."
  echo "Open Security in the panel to review it. The API container needs $SCAN_DIR mounted at /host-scan, and for Remove"
  echo "and Undo, $ACT_DIR/requests at /host-actions/requests and $ACT_DIR/results at /host-actions/results (new installs have all three)."
else
  echo "The timer is installed, but the first scan failed. See: journalctl -u dbbkp-scan.service -n 30" >&2
  exit 1
fi
