#!/bin/bash
# Build single-file executables with Bun's --compile.
# Usage: scripts/build-binaries.sh [target]
#   (no arg) = host machine;  or a Bun compile target:
#   bun-linux-x64 / bun-linux-arm64 / bun-darwin-x64 / bun-windows-x64
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p dist/bin
build_one() {
  local target=$1
  echo "building share-context-relay ($target)..."
  bun build --compile --target=$target packages/relay/src/bin.ts --outfile "dist/bin/share-context-relay-$target"
  echo "building share-context-server ($target)..."
  bun build --compile --target=$target packages/server/src/bin.ts --outfile "dist/bin/share-context-server-$target"
}
if [ $# -gt 0 ]; then
  build_one "$1"
else
  case "$(uname -s)/$(uname -m)" in
    Darwin/arm64)   build_one bun-darwin-arm64 ;;
    Darwin/x86_64)  build_one bun-darwin-x64 ;;
    Linux/x86_64)   build_one bun-linux-x64 ;;
    Linux/aarch64)  build_one bun-linux-arm64 ;;
    MINGW*|MSYS*|Windows*) build_one bun-windows-x64 ;;
    *) echo "unsupported host: $(uname -s)/$(uname -m) — pass an explicit target"; exit 1 ;;
  esac
fi
echo "done: dist/bin/"
