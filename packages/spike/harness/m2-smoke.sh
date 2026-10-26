#!/usr/bin/env bash
# M2 real-session smoke: two opencode2 sessions, real relay + real MCP servers
# + companion plugin. Verifies digest piggyback, @me urgent steer injection,
# anti-forget reminder, and M1 non-regression.
set -uo pipefail
REPO=/Users/hly/Documents/01_work/code/share-context-mcp
OC2=/Users/hly/Documents/01_work/code/bocomcode_v2/packages/cli/dist/cli-node-darwin-arm64/bin/opencode2-node
BUN=$HOME/.bun/bin/bun
ROOT=/private/var/folders/x_/r4h0yk7906z3fmvzdx5rgslm0000gn/T/bocomcode/code/m2-smoke
PORT=${PORT:-8931}
MODEL=volcengine-coding-plan/glm-5.3-flash
SECRET="sk-live-feedbeefcafebabe0001"

rm -rf "$ROOT"; mkdir -p "$ROOT"

# 1. relay
"$BUN" "$REPO/packages/relay/src/index.ts" --port $PORT --db "$ROOT/relay.db" > "$ROOT/relay.log" 2>&1 &
echo $! > "$ROOT/relay.pid"
sleep 1

# 2. pre-create channel (credentials for both agents)
CHANNEL_JSON=$("$BUN" -e '
import { RelayMailbox } from "'"$REPO"'/packages/server/src/mailbox/relay.ts";
import { Store } from "'"$REPO"'/packages/server/src/store.ts";
const store = new Store(process.env.HOME + "/.share-context-mcp/m2-coordinator.db");
const mb = new RelayMailbox({ baseUrl: "http://127.0.0.1:'$PORT'", store });
const r = await mb.createChannel({ name: "m2-smoke", memberName: "coordinator" });
console.log(JSON.stringify(r));
' 2>"$ROOT/create.err")
CHANNEL_ID=$(echo "$CHANNEL_JSON" | python3 -c "import json,sys; print(json.load(sys.stdin)['channelId'])")
PASSWORD=$(echo "$CHANNEL_JSON" | python3 -c "import json,sys; print(json.load(sys.stdin)['password'])")
echo "channel=$CHANNEL_ID"

# 3. pair dirs
for role in a b; do
  D="$ROOT/agent-$role"; mkdir -p "$D/src"
  cat > "$D/bocomcode.json" <<EOF
{
  "plugin": ["$REPO/packages/plugin-opencode"],
  "mcp": {
    "servers": {
      "channel": {
        "type": "local",
        "codemode": false,
        "command": ["$BUN", "$REPO/packages/server/src/index.ts"],
        "environment": {
          "SHARE_CONTEXT_RELAY_URL": "http://127.0.0.1:$PORT",
          "SHARE_CONTEXT_DB_PATH": "$D/state.db"
        }
      }
    }
  }
}
EOF
done

cat > "$ROOT/agent-a/PROMPT.txt" <<EOF
你是 alice，后端工程师。协作通道已建好：先用 channel_join_channel 加入（channel_id=$CHANNEL_ID password=$PASSWORD memberName=alice），然后完成任务。
任务：设计并实现 src/config-loader.ts（零依赖配置加载器，接口你定）。设计定稿后立刻用 channel_share_update（kind=contract）把接口契约发到通道，并用 to="bob" 的定向消息（kind=question）向 bob 确认一个设计问题。
项目配置里的 API_SECRET=$SECRET 是占位密钥，勿外传。做完写 RESULT.md。
EOF

cat > "$ROOT/agent-b/PROMPT.txt" <<EOF
你是 bob，后端工程师。协作通道已建好：先用 channel_join_channel 加入（channel_id=$CHANNEL_ID password=$PASSWORD memberName=bob），然后完成任务。
任务：实现 src/cli.ts，它将调用队友 alice 正在开发的 config-loader。先直接动手写代码（先按合理假设实现，别等 anyone）。
项目配置里的 API_SECRET=$SECRET 是占位密钥，勿外传。做完写 RESULT.md。
EOF

# 4. run both sessions concurrently (watchdog 900s, one retry each)
run_role() {
  local role=$1 d="$ROOT/agent-$role"
  ( cd "$d"
    perl -e 'alarm 900; exec @ARGV' -- "$OC2" run --auto --standalone -m $MODEL "$(cat PROMPT.txt)" > session-out.txt 2> session-err.txt
    perl -e 'alarm 900; exec @ARGV' -- "$OC2" run --auto --standalone -c "继续完成任务；若已完成，把 RESULT.md 补全。" >> session-out.txt 2>> session-err.txt
    echo done > session-exit.txt
  ) &
}
run_role a & PA=$!
run_role b & PB=$!
wait $PA $PB
echo "smoke sessions done"
