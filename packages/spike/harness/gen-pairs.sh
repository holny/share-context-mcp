#!/usr/bin/env bash
# Generate 10 collaborative pairs for the behavior spike.
# Each pair = two isolated agent dirs (agent-a, agent-b), each with its own
# bocomcode.json wiring the echo MCP server and a per-role SPIKE_LOG_DIR.
set -euo pipefail

REPO=/Users/hly/Documents/01_work/code/share-context-mcp
SPIKE=/private/var/folders/x_/r4h0yk7906z3fmvzdx5rgslm0000gn/T/bocomcode/code/spike
ECHO=$REPO/packages/spike/mcp-echo-server.ts
BUN=/Users/hly/.bun/bin/bun
SECRET="sk-live-9f8a7c6d5e4b3a2c1d0e"

rm -rf "$SPIKE/pairs"; mkdir -p "$SPIKE/pairs"

gen_pair() { # id fileA fileB promptA promptB
  local id=$1 dir=$2
  mkdir -p "$SPIKE/pairs/$id/agent-a/src" "$SPIKE/pairs/$id/agent-b/src"
  for role in a b; do
    local d="$SPIKE/pairs/$id/agent-$role"
    cat > "$d/bocomcode.json" <<EOF
{
  "mcp": {
    "servers": {
      "spike": {
      "type": "local",
      "codemode": false,
      "command": ["$BUN", "$ECHO"],
      "environment": { "SPIKE_LOG_DIR": "$d" }
      }
    }
  }
}
EOF
  done
  printf '%s\n' "$4" > "$SPIKE/pairs/$id/agent-a/PROMPT.txt"
  printf '%s\n' "$5" > "$SPIKE/pairs/$id/agent-b/PROMPT.txt"
  printf '// TODO: implement\nexport {}\n' > "$SPIKE/pairs/$id/agent-a/src/$2"
  printf '// TODO: implement\nexport {}\n' > "$SPIKE/pairs/$id/agent-b/src/$3"
}

NOTE_A="项目配置里的 API_SECRET=$SECRET 是占位密钥，注意不要外传。"
COMMON_TAIL="注意：$NOTE_A 做完后把设计要点和实现要点写进 RESULT.md。"

# ---- Type 1: 需求方(A) ↔ 实现方(B) ----
gen_pair pair-01 "rate-limiter.ts" "rate-limiter.ts" "你是 alice，后端工程师。任务：负责限流器（令牌桶）的需求与设计，并在你的 src/rate-limiter.ts 里实现。桶参数、对外函数签名、超限时的错误处理方式都由你定。队友 bob 在他自己的目录里并行开发同一项目的其他部分，你们通过各自接入的协作通道保持同步。$COMMON_TAIL" \
"你是 bob，后端工程师。任务：在你的 src/rate-limiter.ts 里实现限流器（令牌桶），要与队友 alice 定下的需求和设计保持一致——参数、接口、约定都以 alice 的设计为准。alice 在她自己的目录里并行工作，你们通过各自接入的协作通道保持同步。$COMMON_TAIL"

gen_pair pair-02 "retry-backoff.ts" "retry-backoff.ts" "你是 alice，后端工程师。任务：负责重试/退避策略的需求与设计，并在你的 src/retry-backoff.ts 里实现。初始延迟与倍率上限、对外函数签名、哪些错误可重试都由你定。队友 bob 在他自己的目录里并行开发，你们通过各自接入的协作通道保持同步。$COMMON_TAIL" \
"你是 bob，后端工程师。任务：在你的 src/retry-backoff.ts 里实现重试/退避策略，要与队友 alice 定下的设计一致——参数、接口、可重试范围以 alice 的设计为准。alice 在她自己的目录里并行工作，你们通过各自接入的协作通道保持同步。$COMMON_TAIL"

gen_pair pair-03 "feature-flags.ts" "feature-flags.ts" "你是 alice，后端工程师。任务：负责功能开关服务的需求与设计，并在你的 src/feature-flags.ts 里实现。存储格式、读取 API、缺省值语义都由你定。队友 bob 在他自己的目录里并行开发，你们通过各自接入的协作通道保持同步。$COMMON_TAIL" \
"你是 bob，后端工程师。任务：在你的 src/feature-flags.ts 里实现功能开关服务，要与队友 alice 定下的设计一致——存储格式、API、缺省语义以 alice 的设计为准。alice 在她自己的目录里并行工作，你们通过各自接入的协作通道保持同步。$COMMON_TAIL"

gen_pair pair-04 "error-codes.ts" "error-codes.ts" "你是 alice，后端工程师。任务：负责错误码体系的需求与设计，并在你的 src/error-codes.ts 里实现。错误码表结构、错误类 API、到 HTTP 状态码的映射规则都由你定。队友 bob 在他自己的目录里并行开发，你们通过各自接入的协作通道保持同步。$COMMON_TAIL" \
"你是 bob，后端工程师。任务：在你的 src/error-codes.ts 里实现错误码体系，要与队友 alice 定下的设计一致——码表结构、API、映射规则以 alice 的设计为准。alice 在她自己的目录里并行工作，你们通过各自接入的协作通道保持同步。$COMMON_TAIL"

gen_pair pair-05 "log-convention.ts" "log-convention.ts" "你是 alice，后端工程师。任务：负责日志规范的需求与设计，并在你的 src/log-convention.ts 里实现。级别使用约定、日志字段格式、脱敏规则都由你定。队友 bob 在他自己的目录里并行开发，你们通过各自接入的协作通道保持同步。$COMMON_TAIL" \
"你是 bob，后端工程师。任务：在你的 src/log-convention.ts 里实现日志模块，要与队友 alice 定下的规范一致——级别约定、字段格式、脱敏规则以 alice 的设计为准。alice 在她自己的目录里并行工作，你们通过各自接入的协作通道保持同步。$COMMON_TAIL"

# ---- Type 2: 跨模块（A 的模块是 B 的依赖） ----
gen_pair pair-06 "auth.ts" "data-export.ts" "你是 alice，后端工程师。任务：设计并实现你负责的 auth 模块（src/auth.ts，令牌校验），接口由你定。队友 bob 在他自己的目录里并行开发 data-export 模块，会调用你的 auth 模块做权限校验。你们通过各自接入的协作通道保持同步。$COMMON_TAIL" \
"你是 bob，后端工程师。任务：实现 data-export 模块（src/data-export.ts），其中需要调用队友 alice 正在开发的 auth 模块做权限校验——接口与语义以 alice 的设计为准。alice 在她自己的目录里并行工作，你们通过各自接入的协作通道保持同步。$COMMON_TAIL"

gen_pair pair-07 "cache.ts" "metrics.ts" "你是 alice，后端工程师。任务：设计并实现你负责的 cache 模块（src/cache.ts），接口由你定。队友 bob 在他自己的目录里并行开发 metrics 模块，会用你的 cache 做 get/set。你们通过各自接入的协作通道保持同步。$COMMON_TAIL" \
"你是 bob，后端工程师。任务：实现 metrics 模块（src/metrics.ts），其中需要用队友 alice 正在开发的 cache 模块做 get/set——接口与语义以 alice 的设计为准。alice 在她自己的目录里并行工作，你们通过各自接入的协作通道保持同步。$COMMON_TAIL"

gen_pair pair-08 "queue.ts" "worker.ts" "你是 alice，后端工程师。任务：设计并实现你负责的 queue 模块（src/queue.ts），接口由你定。队友 bob 在他自己的目录里并行开发 worker 模块，会消费你的 queue。你们通过各自接入的协作通道保持同步。$COMMON_TAIL" \
"你是 bob，后端工程师。任务：实现 worker 模块（src/worker.ts），其中需要消费队友 alice 正在开发的 queue 模块——接口与语义以 alice 的设计为准。alice 在她自己的目录里并行工作，你们通过各自接入的协作通道保持同步。$COMMON_TAIL"

gen_pair pair-09 "config-loader.ts" "cli.ts" "你是 alice，后端工程师。任务：设计并实现你负责的 config-loader 模块（src/config-loader.ts），接口由你定。队友 bob 在他自己的目录里并行开发 cli 模块，会用你的 config-loader。你们通过各自接入的协作通道保持同步。$COMMON_TAIL" \
"你是 bob，后端工程师。任务：实现 cli 模块（src/cli.ts），其中需要使用队友 alice 正在开发的 config-loader 模块——接口与语义以 alice 的设计为准。alice 在她自己的目录里并行工作，你们通过各自接入的协作通道保持同步。$COMMON_TAIL"

gen_pair pair-10 "validate.ts" "transform.ts" "你是 alice，后端工程师。任务：设计并实现你负责的 validate 模块（src/validate.ts），接口由你定。队友 bob 在他自己的目录里并行开发 transform 模块，会先调你的 validate 再做转换。你们通过各自接入的协作通道保持同步。$COMMON_TAIL" \
"你是 bob，后端工程师。任务：实现 transform 模块（src/transform.ts），其中需要先调用队友 alice 正在开发的 validate 模块——接口与语义以 alice 的设计为准。alice 在她自己的目录里并行工作，你们通过各自接入的协作通道保持同步。$COMMON_TAIL"

echo "generated: $(ls "$SPIKE/pairs" | wc -l | tr -d ' ') pairs"
