#!/bin/bash
#
# Fetch a STATIC ffmpeg + ffprobe into the plugin's own bin/ folder, for the helper.
#
# Why bundled rather than a system install:
#   - the panel works on any machine the extension is copied to, with no
#     homebrew, no PATH setup, no per-machine install step;
#   - every machine runs the SAME pinned build, so a conform behaves
#     identically everywhere - frame matching included;
#   - nothing depends on binaries inside other vendors' app bundles.
#
# Versions and checksums are PINNED below. To move to a newer build, update the
# version block and the four checksums together - never loosen the verification.
#
# Source: ffmpeg.martin-riedl.de, which publishes SHA-256 alongside each build.
# The checksums here were recorded at pin time and are re-verified on every run;
# a mismatch aborts and deletes the download.
#
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BIN="$ROOT/bin"

FFMPEG_VERSION="9.0.1"

ARM64_BUILD="1787073674_9.0.1"
ARM64_FFMPEG_SHA="8287a1b2229e05eb41859f073e18e6c52c60a778f2f5e6881070fe51b79407fe"
ARM64_FFPROBE_SHA="102a26b8940a053298d9929bfaae71e4b6ef65ba5f19a99a88c433108560741a"

AMD64_BUILD="1787081194_9.0.1"
AMD64_FFMPEG_SHA="5bdead62ff504ab9b447cc72b212c4fb481e3f7de5877d427a51bee8136dda40"
AMD64_FFPROBE_SHA="34511bbcf1988ad2886023bf5ace4f44cf62e6defeb3d194d6f7619e5b061f7f"

BASE="https://ffmpeg.martin-riedl.de/download/macos"

case "$(uname -m)" in
  arm64)  ARCH_DIR="arm64"; BUILD="$ARM64_BUILD"
          FFMPEG_SHA="$ARM64_FFMPEG_SHA"; FFPROBE_SHA="$ARM64_FFPROBE_SHA" ;;
  x86_64) ARCH_DIR="amd64"; BUILD="$AMD64_BUILD"
          FFMPEG_SHA="$AMD64_FFMPEG_SHA"; FFPROBE_SHA="$AMD64_FFPROBE_SHA" ;;
  *)      echo "Unsupported architecture: $(uname -m)" >&2; exit 1 ;;
esac

FORCE=0
[ "${1:-}" = "--force" ] && FORCE=1

# A tiny stamp file records which verified archive a binary came from, so
# re-runs can skip the download without keeping the 28 MB zip around.
have_good_binary() {
  local path="$1" want="$2"
  [ -x "$path" ] || return 1
  [ "$FORCE" = "1" ] && return 1
  [ "$(cat "$path.from" 2>/dev/null)" = "$want" ]
}

fetch_one() {
  local tool="$1" want_sha="$2"
  local url="$BASE/$ARCH_DIR/$BUILD/$tool.zip"
  local tmp; tmp="$(mktemp -d)"

  if have_good_binary "$BIN/$tool" "$want_sha"; then
    echo "  $tool: already present and verified, skipping"
    rm -rf "$tmp"; return 0
  fi

  echo "  $tool: downloading $FFMPEG_VERSION ($ARCH_DIR)"
  curl -fsSL --max-time 300 -o "$tmp/$tool.zip" "$url"

  local got
  got="$(shasum -a 256 "$tmp/$tool.zip" | awk '{print $1}')"
  if [ "$got" != "$want_sha" ]; then
    rm -rf "$tmp"
    echo "  $tool: CHECKSUM MISMATCH - refusing to install" >&2
    echo "    expected $want_sha" >&2
    echo "    got      $got" >&2
    exit 1
  fi
  echo "  $tool: sha256 verified"

  mkdir -p "$BIN"
  unzip -qo "$tmp/$tool.zip" -d "$tmp/x"
  local found
  found="$(find "$tmp/x" -type f -name "$tool" -perm -u+x | head -1)"
  [ -n "$found" ] || { echo "  $tool: not found inside the zip" >&2; rm -rf "$tmp"; exit 1; }

  mv "$found" "$BIN/$tool"
  chmod +x "$BIN/$tool"
  # Record the verified archive hash so re-runs can skip the download.
  printf '%s' "$want_sha" > "$BIN/$tool.from"

  # Downloaded binaries can carry a quarantine flag, which makes Gatekeeper
  # refuse to exec them with an opaque error.
  xattr -d com.apple.quarantine "$BIN/$tool" 2>/dev/null || true

  rm -rf "$tmp"
}

echo "Fetching static ffmpeg $FFMPEG_VERSION for $ARCH_DIR into bin/"
fetch_one ffmpeg  "$FFMPEG_SHA"
fetch_one ffprobe "$FFPROBE_SHA"

echo
echo "Verifying they run:"
"$BIN/ffmpeg"  -hide_banner -version | head -1 | sed 's/^/  /'
"$BIN/ffprobe" -hide_banner -version | head -1 | sed 's/^/  /'
echo "  arch: $(lipo -archs "$BIN/ffmpeg")"
# grep exits 1 when it matches nothing, which here is the SUCCESS case
# (no non-system dylibs = static), so it must not trip `set -e`.
DEPS="$(otool -L "$BIN/ffmpeg" | tail -n +2 | { grep -v '/usr/lib/\|/System/Library/' || true; } | wc -l | tr -d ' ')"
if [ "$DEPS" = "0" ]; then
  echo "  static: yes (no non-system dylib dependencies)"
else
  echo "  WARNING: $DEPS non-system dylib dependencies - this build is NOT portable" >&2
fi
