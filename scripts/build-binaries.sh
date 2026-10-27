#!/bin/bash
# Build single-file executables with Bun's --compile (cross-compilation).
# Usage:
#   scripts/build-binaries.sh          → host machine only
#   scripts/build-binaries.sh all      → all 5 release targets
#   scripts/build-binaries.sh <target> → one target
#     targets: bun-darwin-arm64 bun-darwin-x64 bun-linux-x64 bun-linux-arm64 bun-windows-x64
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p dist/bin

# ext per target: Windows needs .exe; everything else none.
ext_for() {
  case "$1" in
    bun-windows-x64) echo ".exe" ;;
    *) echo "" ;;
  esac
}

build_one() {
  local target=$1
  local ext
  ext=$(ext_for "$target")
  echo "building share-context-relay ($target)..."
  bun build --compile --target=$target packages/relay/src/bin.ts --outfile "dist/bin/share-context-relay-$target$ext"
  echo "building share-context-server ($target)..."
  bun build --compile --target=$target packages/server/src/bin.ts --outfile "dist/bin/share-context-server-$target$ext"
}

if [ $# -gt 0 ] && [ "$1" = "all" ]; then
  for t in bun-darwin-arm64 bun-darwin-x64 bun-linux-x64 bun-linux-arm64 bun-windows-x64; do
    build_one "$t"
  done
elif [ $# -gt 0 ]; then
  build_one "$1"
else
  case "$(uname -s)/$(uname -m)" in
    Darwin/arm64)   build_one bun-darwin-arm64 ;;
    Darwin/x86_64)  build_one bun-darwin-x64 ;;
    Linux/x86_64)   build_one bun-linux-x64 ;;
    Linux/aarch64)  build_one bun-linux-arm64 ;;
    MINGW*|MSYS*|Windows*) build_one bun-windows-x64 ;;
    *) echo "unsupported host: $(uname -s)/$(uname -m) — pass 'all' or an explicit target"; exit 1 ;;
  esac
fi
echo "done: dist/bin/"
