#!/usr/bin/env bash
# Run one spike pair: agent-a and agent-b concurrently, 15-min watchdog each,
# up to 3 attempts per role (resume with -c after a network failure).
set -uo pipefail
OC2=/Users/hly/Documents/01_work/code/bocomcode_v2/packages/cli/dist/cli-node-darwin-arm64/bin/opencode2-node
PAIR=$1
PAIRDIR=/private/var/folders/x_/r4h0yk7906z3fmvzdx5rgslm0000gn/T/bocomcode/code/spike/pairs/$PAIR

run_role() {
  local role=$1
  local d="$PAIRDIR/agent-$role"
  (
    cd "$d"
    local attempt msg_flags=()
    for attempt in 1 2 3; do
      [ $attempt -ge 2 ] && sleep 15
      if [ $attempt -ge 2 ] && [ -f .session-created ]; then
        perl -e 'alarm 900; exec @ARGV' -- "$OC2" run --auto --standalone -c \
          "继续你未完成的任务。如果已完成，检查 RESULT.md 是否完整。" \
          >> session-out.txt 2>> session-err.txt
      else
        perl -e 'alarm 900; exec @ARGV' -- "$OC2" run --auto --standalone \
          -m volcengine-coding-plan/glm-5.3-flash \
          "$(cat PROMPT.txt)" > session-out.txt 2> session-err.txt
        touch .session-created
      fi
      rc=$?
      if [ $attempt -ge 2 ]; then echo "retry$rc=$?" >> session-exit.txt 2>/dev/null || true; fi
      # success heuristic: RESULT.md exists (task deliverable) or no error in stderr tail
      if [ -f RESULT.md ]; then echo "exit=0(attempt$attempt)" > session-exit.txt; return 0 2>/dev/null || exit 0; fi
      if ! tail -2 session-err.txt | grep -q "fetch failed"; then
        echo "exit=$rc(attempt$attempt)" > session-exit.txt
        [ $rc -eq 0 ] && return 0 2>/dev/null || exit 0
      fi
    done
    echo "exit=exhausted" > session-exit.txt
  )
}

run_role a & PA=$!
run_role b & PB=$!
wait $PA $PB
echo "pair $PAIR done: $(cat "$PAIRDIR"/agent-*/session-exit.txt 2>/dev/null | tr '\n' ' ')"
