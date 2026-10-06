#!/bin/bash
# Runs the pure-logic tests under JavaScriptCore. There is no Node on this
# machine, and the UXP runtime is not scriptable from outside, so jsc is the
# test harness. Run from anywhere; paths are resolved against the repo root.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
JSC="/System/Library/Frameworks/JavaScriptCore.framework/Versions/A/Helpers/jsc"
[ -x "$JSC" ] || { echo "jsc not found at $JSC"; exit 1; }
cd "$ROOT"
fail=0
for t in tests/*-test.js; do
  echo "== $t"
  "$JSC" "$t" || fail=1
done
exit $fail
