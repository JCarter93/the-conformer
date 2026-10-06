#!/bin/bash
# Install the Conformer's background helper as a launchd agent, so it runs from
# login and the panel never needs a terminal.
#
# The helper is what lets the panel use ffmpeg and numpy at all: UXP has no
# subprocess API, so the panel writes a request into its own data folder and
# the helper - an ordinary process with no such restriction - does the work and
# writes the answer back.
#
#   scripts/install-helper.sh            install and start
#   scripts/install-helper.sh uninstall  stop and remove
#   scripts/install-helper.sh status     is it running?
set -euo pipefail

SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LABEL="theconformer.helper"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
LOGDIR="$HOME/Library/Logs/TheConformer"
ACTION="${1:-install}"

case "$ACTION" in
  uninstall)
    launchctl bootout "gui/$UID/$LABEL" 2>/dev/null || launchctl unload "$PLIST" 2>/dev/null || true
    rm -f "$PLIST"
    echo "Removed $LABEL."
    exit 0
    ;;
  status)
    if launchctl print "gui/$UID/$LABEL" >/dev/null 2>&1; then
      echo "Running. Log: $LOGDIR/helper.log"
      tail -n 5 "$LOGDIR/helper.log" 2>/dev/null || true
    else
      echo "Not running. Install with: scripts/install-helper.sh"
    fi
    exit 0
    ;;
esac

# python3 must have numpy - the frame matching is numpy, and a helper that
# starts and then fails on every verify request is worse than one that refuses
# to install.
PY="$(command -v python3)"
if ! "$PY" -c "import numpy" >/dev/null 2>&1; then
  echo "python3 at $PY has no numpy, which the frame matching needs:"
  echo "  $PY -m pip install --user numpy"
  exit 1
fi

# ffmpeg is GPLv3 and is not shipped with the panel. The helper looks in
# bin/ then PATH; without it the panel can only report that it is missing.
if [ ! -x "$SRC/bin/ffmpeg" ] && ! command -v ffmpeg >/dev/null 2>&1; then
  echo "No ffmpeg found in $SRC/bin or on PATH. The helper will install and run, but"
  echo "cannot plan or check anything until there is one:"
  echo "  scripts/fetch-ffmpeg.sh          (pinned static build, checksum verified)"
  echo "  or download one: https://ffmpeg.org/download.html"
fi

mkdir -p "$LOGDIR" "$(dirname "$PLIST")"

cat > "$PLIST" <<PLISTEOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>$PY</string>
    <string>$SRC/helper/conform_helper.py</string>
    <string>--verbose</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>$LOGDIR/helper.log</string>
  <key>StandardErrorPath</key><string>$LOGDIR/helper.log</string>
  <!-- Interactive, NOT Background. "Background" is not a hint about tidiness:
       it puts the helper and every ffmpeg it starts into Darwin's throttled
       CPU and I/O class, which is for work nobody is waiting on. An editor IS
       waiting on this. Measured on the same 11-cut verify, same machine, same
       files: 583s under Background, 39s run as an ordinary process. -->
  <key>ProcessType</key><string>Interactive</string>
</dict>
</plist>
PLISTEOF

launchctl bootout "gui/$UID/$LABEL" 2>/dev/null || true
launchctl bootstrap "gui/$UID" "$PLIST"
launchctl enable "gui/$UID/$LABEL" 2>/dev/null || true

sleep 1
if launchctl print "gui/$UID/$LABEL" >/dev/null 2>&1; then
  echo "Installed and running: $LABEL"
  echo "Log: $LOGDIR/helper.log"
else
  echo "Installed, but it does not appear to be running. Check $LOGDIR/helper.log"
  exit 1
fi
