#!/usr/bin/env bash
#
# Build the release git-atlas server binary and place it where Tauri expects the
# sidecar binary: ui/src-tauri/binaries/git-atlas-<target-triple>[.exe]
#
# Tauri's `externalBin` requires the binary to be suffixed with the Rust target
# triple so the correct one is bundled per-platform. This script derives the
# host triple automatically (override with $TARGET_TRIPLE for cross builds).
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

TRIPLE="${TARGET_TRIPLE:-$(rustc -vV | sed -n 's/^host: //p')}"
if [ -z "$TRIPLE" ]; then
  echo "error: could not determine target triple" >&2
  exit 1
fi

EXT=""
case "$TRIPLE" in
  *windows*) EXT=".exe" ;;
esac

echo "==> Building web UI (ui/dist) so it can be embedded in the server"
( cd ui && npm run build )

echo "==> Building release git-atlas server for $TRIPLE"
cargo build --release --bin git-atlas

SRC="target/release/git-atlas${EXT}"
DEST_DIR="ui/src-tauri/binaries"
DEST="${DEST_DIR}/git-atlas-${TRIPLE}${EXT}"

mkdir -p "$DEST_DIR"
cp "$SRC" "$DEST"
chmod +x "$DEST"

echo "==> Sidecar placed at $DEST"
