#!/bin/bash
# Dev install: link this working copy into the per-user UXP plugins folder AND
# register it in Premiere's plugin registry. No sudo, no packaging, no build
# step - edits to the panel's HTML/CSS/JS are picked up when the panel is
# reopened.
#
# The registry step is the one that is easy to miss. Premiere does NOT scan
# .../UXP/Plugins/External for plugins to load, despite that being where they
# live. It reads a manifest of its own:
#
#   ~/Library/Application Support/Adobe/UXP/PluginsInfo/v1/premierepro.json
#
# A plugin dropped in the folder but absent from that file is silently ignored
# - no error in the panel list, nothing in the UXP log except its absence.
# Verified on Premiere 26.3.2: the log line to look for is
# "upic::Loading plugins from user PluginsInfo file".
set -euo pipefail

SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEST_DIR="$HOME/Library/Application Support/Adobe/UXP/Plugins/External"
INFO="$HOME/Library/Application Support/Adobe/UXP/PluginsInfo/v1/premierepro.json"

read -r ID VER NAME MINVER <<EOF
$(/usr/bin/python3 -c '
import json, sys
m = json.load(open(sys.argv[1]))
print(m["id"], m["version"], m["name"].replace(" ", " "), m["host"]["minVersion"])
' "$SRC/manifest.json")
EOF
NAME="${NAME//$' '/ }"

DEST="$DEST_DIR/${ID}_${VER}"
MODE="${1:-symlink}"

# --- 1. put the plugin where the registry will point ------------------------

mkdir -p "$DEST_DIR"
rm -rf "$DEST"

if [ "$MODE" = "copy" ]; then
  # Fallback for if the UXP loader refuses to follow a symlink. Re-run after
  # every edit - which is why symlink is the default.
  /usr/bin/rsync -a --delete \
    --exclude '.git' --exclude 'scripts' --exclude 'tests' --exclude 'docs' \
    "$SRC/" "$DEST/"
  echo "Copied:   $DEST"
else
  ln -s "$SRC" "$DEST"
  echo "Linked:   $DEST -> $SRC"
fi

# --- 2. register it, without disturbing the plugins already listed ----------

mkdir -p "$(dirname "$INFO")"
/usr/bin/python3 - "$INFO" "$ID" "$VER" "$NAME" "$MINVER" <<'PY'
import json, os, sys

info_path, plugin_id, version, name, min_version = sys.argv[1:6]

data = {"plugins": []}
if os.path.exists(info_path):
    try:
        with open(info_path) as fh:
            data = json.load(fh)
    except (ValueError, OSError):
        # A corrupt registry would take every other UXP panel down with it, so refuse
        # rather than overwrite it with a file containing only us.
        sys.exit("Registry exists but will not parse: " + info_path)

plugins = [p for p in data.get("plugins", []) if p.get("pluginId") != plugin_id]
plugins.append({
    "hostMinVersion": min_version,
    "name": name,
    "path": "$localPlugins/External/%s_%s" % (plugin_id, version),
    "pluginId": plugin_id,
    "status": "enabled",
    "type": "uxp",
    "versionString": version,
})
data["plugins"] = plugins

tmp = info_path + ".tmp"
with open(tmp, "w") as fh:
    json.dump(data, fh, indent=4, sort_keys=True)
os.replace(tmp, info_path)
print("Registered: %s (%s) alongside %d other plugin(s)."
      % (name, plugin_id, len(plugins) - 1))
PY

echo
echo "Restart Premiere Pro, then: Window > Extensions > $NAME"
