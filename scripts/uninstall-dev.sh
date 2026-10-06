#!/bin/bash
# Removes both halves of the dev install: the folder link and the registry
# entry. Leaves every other plugin in the registry alone.
set -euo pipefail

SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
INFO="$HOME/Library/Application Support/Adobe/UXP/PluginsInfo/v1/premierepro.json"

read -r ID VER <<EOF
$(/usr/bin/python3 -c '
import json, sys
m = json.load(open(sys.argv[1]))
print(m["id"], m["version"])
' "$SRC/manifest.json")
EOF

DEST="$HOME/Library/Application Support/Adobe/UXP/Plugins/External/${ID}_${VER}"
rm -rf "$DEST"
echo "Removed: $DEST"

if [ -f "$INFO" ]; then
  /usr/bin/python3 - "$INFO" "$ID" <<'PY'
import json, os, sys
info_path, plugin_id = sys.argv[1:3]
try:
    with open(info_path) as fh:
        data = json.load(fh)
except (ValueError, OSError):
    sys.exit("Registry will not parse, left untouched: " + info_path)

before = len(data.get("plugins", []))
data["plugins"] = [p for p in data.get("plugins", []) if p.get("pluginId") != plugin_id]
tmp = info_path + ".tmp"
with open(tmp, "w") as fh:
    json.dump(data, fh, indent=4, sort_keys=True)
os.replace(tmp, info_path)
print("Deregistered (%d plugin(s) left registered)." % len(data["plugins"]))
PY
fi

echo "Restart Premiere Pro for it to disappear from the panel list."
