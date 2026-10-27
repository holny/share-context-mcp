# share-context-mcp 里程碑 2 实施计划（WS 推送 + 传输降级 + opencode 伴生插件）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 M1 的"轮询准实时"升级为"WS 优先真·实时 + 自动降级"，并交付 opencode v2 伴生插件（摘要卡合并、工具结果搭便车、@me 紧急注入、防遗忘提醒）。

**Architecture:** 中继加 WS 推送端点；本地 MCP server 持有连接（WS/轮询两态，cursor 仍是正确性来源）并经 Unix socket 向插件广播"已解密已过滤"的摘要事件；插件只消费（不持连接不碰密钥），用 `session.synthetic`（@me 紧急）与 `tool.execute.after` 搭便车（其余）注入，外加防遗忘提醒。

**Tech Stack:** Bun + TypeScript；Bun.serve WebSocket；`node:net`/Bun Unix socket；opencode v2 插件 API（`define()`、`ctx.session.synthetic`、hooks，源码参考 `/Users/hly/Documents/01_work/code/bocomcode_v2/packages/plugin/`）。

**Spec:** `docs/superpowers/specs/2026-10-25-share-context-mcp-design.md`（§5.4 插件、§5.7 投递、§5.8 性能；§4 方案对比）

## Global Constraints

- 插件**不持连接、不碰密钥**：WS/解密/cursor/过滤全部在本地 MCP server；插件仅消费 IPC 事件流（spec §5.4 已定）
- cursor 仍是正确性来源：WS 只是推醒优化；WS 断开/被掐 → 自动降级 poll（自适应间隔：活跃 2–5s、空闲 15–30s），并周期性试探回升；transport 配置 `auto | ws | poll`，默认 auto
- 摘要卡合并窗口 2–3s；`@me` 定向消息绕过合并窗口单独立即推
- 注入双通道：`tool.execute.after` 把摘要卡追加到下一次工具调用结果尾部（主路）；`session.synthetic`（delivery "steer"）仅用于 @me 紧急（辅路）
- 防遗忘提醒：一轮内有实质动作（edit/write/shell）但整轮未调 `share_update` → 注入一句温和提示（只提醒不强制）
- IPC：Unix socket（`~/.share-context-mcp/ipc-<port>.sock` 或固定路径+端口协商），行分隔 JSON；事件仅含已解密已过滤的摘要（无密文、无密码）
- 中继 WS 端点鉴权复用会话 token（Bearer in WS handshake query/header）；盲性保持：WS 只推 `{seq, epoch}` 通知，客户端自己来拉密文
- 所有 commit message 英文（Conventional Commits）
- 包名：`packages/plugin-opencode` → `@share-context-mcp/plugin-opencode`

## Review Focus

1. **WS 降级不丢消息**：WS 掐断期间到达的消息，降级 poll 后凭 cursor 补齐——测试：WS 中断场景下无消息丢失（Task 2）
2. **插件绝不接触密钥/密文**：IPC 事件流与插件代码里不得出现 password/channelKey/密文——测试：Task 3 断言事件负载字段白名单
3. **@me 旁路**：定向消息不经合并窗口、synthetic 立即注入；非 @me 消息永不走 synthetic——测试：Task 3/4
4. **合并窗口不吞消息**：窗口内多条合并为一张卡后，每条消息都已 cache+cursor 推进（不依赖注入成功）——测试：Task 3
5. **防遗忘不误报**：只读会话（纯问答、无 edit/shell 写动作）不提醒；已 share 的轮次不提醒——测试：Task 4

---

### Task 0: 分支准备

**Files:** 无新文件（分支操作）

- [ ] **Step 1:** `git checkout -b feat/m2`（自 main b75c274 之后）；确认 `bun test` 86/86
- [ ] **Step 2:** ledger 记录 BASE

### Task 1: 中继 WS 推送端点

**Files:**
- Modify: `packages/relay/src/routes.ts`（或新增 `ws.ts`）、`packages/relay/src/index.ts`
- Test: `packages/relay/test/ws.test.ts`

**Interfaces:**
- Consumes: 现有 token 鉴权、消息存储
- Produces: `WS /channels/:id/ws?token=<token>`（升级为 WebSocket；token 无效/epoch 不符 → 升级拒绝）；连接后推 `{type:"hello", seq:<current nextSeq-1>}`；新消息落库后向该通道所有 WS 连接推 `{type:"message", seq, epoch}`（不含密文/明文）；心跳：服务端每 25s `{type:"ping"}`，客户端 10s 无任何帧可判死；连接断开由客户端处理（中继无状态重连逻辑）

- [ ] **Step 1: 写失败测试**——join 后开 WS：收到 hello（seq 正确）；另一成员 send 2 条 → WS 各收到 message 通知（seq 递增）；坏 token → 升级失败；rotate 后旧 epoch WS 收到 {type:"epoch-invalidated"} 或被服务端关闭
- [ ] **Step 2: Run** `bun test packages/relay` — Expected: FAIL
- [ ] **Step 3: 实现**（Bun.serve 的 websocket 处理；publish 走内存 channel map；盲性：通知体只有 seq/epoch）
- [ ] **Step 4: Run** — Expected: PASS；全仓 `bun test` 仍绿
- [ ] **Step 5: Commit** — `feat(relay): websocket push endpoint with seq-only notifications`

### Task 2: Mailbox listen + 传输自动降级

**Files:**
- Modify: `packages/server/src/mailbox/types.ts`、`packages/server/src/mailbox/relay.ts`、新增 `packages/server/src/transport.ts`
- Test: `packages/server/test/transport.test.ts`

**Interfaces:**
- Consumes: Task 1 WS、现有 poll
- Produces:
  - `TransportMode = "auto" | "ws" | "poll"`（Store kvs 或构造参数，默认 auto）
  - `mailbox.listen(channelId, onNotify: (seq: number) => void): {stop(): Promise<void>}`——auto：先 WS（`ws://.../channels/:id/ws?token=`），onNotify 直调 onNotify(seq)（客户端自己 poll 拉）；WS 建立失败或 10s 无帧/异常断开 → 降级 poll 计时器（活跃 2–5s / 空闲 15–30s，"活跃"= 最近 60s 内有 send/fetch 调用），每 60s 试探 WS 回升；poll 模式：纯计时器
  - 事件回调把新 seq 交给上层（Task 3 的广播器负责拉取/过滤/缓存）
  - 关键不变量：任何模式下消息都不丢——测试 WS 中断场景：建立 WS → 服务端"断开"（测试里直接关连接）→ 断开期间 relay 收 2 条 → 降级 poll 补齐（cursor 前进）→ 恢复 WS 后继续实时

- [ ] **Step 1: 写失败测试**（含 Review Focus #1 丢失场景）
- [ ] **Step 2: Run** — Expected: FAIL
- [ ] **Step 3: 实现 transport.ts**（状态机 ws→poll→ws；所有状态迁移有日志到 stderr debug）
- [ ] **Step 4: Run** — Expected: PASS（不稳定则重跑 3 次确认）
- [ ] **Step 5: Commit** — `feat(server): mailbox listen with ws-first auto downgrade`

### Task 3: 本地 IPC 广播器（过滤 + 合并 + @me 旁路）

**Files:**
- Create: `packages/server/src/broadcaster.ts`
- Modify: `packages/server/src/index.ts`（server 启动时对每个活跃通道 listen → broadcaster）
- Test: `packages/server/test/broadcaster.test.ts`

**Interfaces:**
- Consumes: Task 2 listen、Store 订阅过滤器（set_subscription 已存 kvs，格式 `[{kinds?, scopePrefix?, topic?}]`）
- Produces:
  - `Broadcaster.start(store, mailbox, {socketPath})`：对每个 rejoin 通道 listen；onNotify(seq) → poll 增量（正常拉取+缓存+cursor，复用 mailbox.poll）→ 过滤 → 合并 → 写 socket 行 JSON
  - 事件格式（字段白名单，锁死）：`{type:"digest", channelId, kind:"digest"|"urgent", lines:[{seq, kind, topic, from, to?, statement(截断80字)}], skipped}`——**不含** statement 全文以外内容/密码/密文/cursor；urgent = 存在 `to == 本机 memberName` 的消息
  - 合并窗口 2.5s（可配）：窗口内多条同通道消息合一卡；urgent 消息单独立即发 `{type:"digest", kind:"urgent", ...}`
  - 过滤：无订阅设置 = 全收；有订阅 = kind∈filters.kinds 或 topic 命中或 scopePrefix 命中才入卡；@me 恒入
  - socket 服务端：接受多个客户端连接（多个 opencode 会话），断开清理
- [ ] **Step 1: 写失败测试**——直接构造 Broadcaster + 假 mailbox/真 relay：3 条普通消息同窗 → 1 张卡 3 行；@me 消息 → 立即 urgent 卡；订阅 kind 过滤生效；事件负载无 password/ciphertext 字段（Review Focus #2）；窗口期间 cursor 已推进（#4）；两个客户端都收到
- [ ] **Step 2: Run** — FAIL → **Step 3: 实现** → **Step 4: PASS**
- [ ] **Step 5: Commit** — `feat(server): local ipc broadcaster with subscription filters and digest coalescing`

### Task 4: opencode 伴生插件

**Files:**
- Create: `packages/plugin-opencode/src/index.ts`（插件入口 `define()`）、`src/ipc.ts`（socket 客户端）、`src/coalesce.ts`（纯函数：窗口合并/摘要卡渲染，独立可测）、`src/anti-forget.ts`（纯函数：判定是否提醒）
- Create: `packages/plugin-opencode/package.json`、`README.md`（安装方式：本地路径插件）
- Test: `packages/plugin-opencode/test/*.test.ts`（纯函数单测为主）+ `packages/plugin-opencode/test/plugin-smoke.test.ts`（用 bocomcode_v2 的 plugin API 进程内加载 smoke——能加载则测，不能则 smoke 移到 Task 5 真实会话）

**Interfaces:**
- Consumes: Task 3 的 IPC 事件流（客户端 connect socketPath）
- Produces（插件行为，全部经 bocomcode_v2 插件 API——先读 `/Users/hly/Documents/01_work/code/bocomcode_v2/packages/plugin/src/effect/plugin.ts`、`effect/session.ts`、`effect/tool.ts`、`core/src/session/session.ts:283-323` 的真实签名再写）:
  - IPC 事件 → `coalesce.ts` 合并（2.5s，urgent 旁路）→ 渲染摘要卡文本（同 M1 fetch 摘要样式，含"用 fetch_updates 展开"提示）
  - urgent 卡 → `ctx.session.synthetic(sessionID, text, {delivery:"steer"})` 立即注入（**@me 旁路**，Review Focus #3）
  - 普通卡 → 暂存 pending 卡片；`tool.execute.after` hook 把 pending 卡追加到工具结果尾部（搭便车），追加后清空 pending
  - 防遗忘：hook 在 turn 结束路径（tool.execute.after 累计本轮动作；用 session 事件或 turn 边界）判定：本轮有 edit/write/shell 写动作 且 未调用 `channel_share_update`（M1 工具名前缀 channel_）→ 注入一句温和提示（Review Focus #5；纯函数 `shouldRemind(actions, sharedThisTurn)` 单测覆盖误报场景：只读会话 false、已分享 false、有写动作无分享 true）
  - 多会话并发：插件按 sessionID 路由 synthetic；工具结果搭便车天然按会话
- [ ] **Step 1: 写失败测试**（coalesce/anti-forget 纯函数全覆盖 Review Focus #3/#5；插件加载 smoke）
- [ ] **Step 2: Run** — FAIL → **Step 3: 实现**（IPC 客户端带指数退避重连）→ **Step 4: PASS**
- [ ] **Step 5: Commit** — `feat(plugin-opencode): companion plugin with digest piggyback, urgent steer and anti-forget reminder`

### Task 5: 真实会话冒烟（M2 门禁，自动化执行）

**Files:**
- Create: `docs/superpowers/smokes/2026-10-26-m2-smoke.md`（记录 + 结论）

**Interfaces:**
- Consumes: 全部前序 + 真实 opencode2 会话（复用 spike harness 模式：两目录、bocomcode.json 挂真实 server 进程 + 插件本地路径）

- [ ] **Step 1: 写冒烟脚本** `packages/spike/harness/m2-smoke.sh`：起真 relay → 两个 opencode2 会话（agent-a/agent-b，各挂 `channel` MCP + 插件本地路径）→ A 会话任务里做决策并实现 → 验证四件事：① B 会话收到 urgent/搭便车摘要卡（session 输出含"协作通道"摘要卡标记）；② B 收到 @me 紧急注入（A 的任务里要求发一条 to:B 的 question）；③ 防遗忘提醒出现（B 先干写码动作不分享，观察提示）；④ 全程 M1 功能不回归（fetch/share 正常）
- [ ] **Step 2: 执行并记录**——输出与判定逐条写入 smokes 文档；不过关 → 修插件重跑（最多 3 轮，按"agent 自主性优先"原则只调措辞）
- [ ] **Step 3: Commit** — `docs: m2 real-session smoke results`

### Task 6: 收尾——文档与回归

**Files:**
- Modify: `README.md`（新建仓库主 README：定位、三端架构图、快速开始、M1/M2 功能矩阵）、`packages/relay/README.md`（WS 端点补充）、spec §5.7 状态标注

- [ ] **Step 1:** 写主 README（中文，含定位一句话、架构 ASCII 图、10+插件安装、spike 结果引用）
- [ ] **Step 2:** 全量回归 `bun test` + `bunx tsc --noEmit` 零错误
- [ ] **Step 3: Commit** — `docs: repo readme and m2 docs`
