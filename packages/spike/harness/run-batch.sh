#!/usr/bin/env bash
# Run spike pairs 02..10 sequentially (1 pair at a time to limit API load).
set -u
DIR=/Users/hly/Documents/01_work/code/share-context-mcp/.superpowers/sdd/2026-10-25-share-context-mcp-m1/spike
for n in 02 03 04 05 06 07 08 09 10; do
  echo "=== $(date +%H:%M:%S) pair-$n ==="
  bash "$DIR/run-pair.sh" "pair-$n"
done
echo "ALL PAIRS DONE $(date +%H:%M:%S)"
