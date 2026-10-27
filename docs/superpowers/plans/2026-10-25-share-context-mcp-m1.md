# share-context-mcp 里程碑 1 实施计划（行为 spike + 盲中继 + 本地 MCP server）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 验证"agent 自主共享"假设（spike），并交付双人纯 MCP 端到端可用的协作通道（本地 MCP server + 盲中继 + E2E，短连接轮询模式）。

**Architecture:** 三层——`packages/protocol`（schema + HKDF/AES-GCM 密封）；`packages/relay`（哑管道：seq 分配、密文存储、HMAC 挑战响应 + 会话 token）；`packages/server`（stdio MCP server：工具面、Mailbox 抽象、本地 SQLite 状态、cursor）。插件与 WS 推送属里程碑 2，本计划不做。

**Tech Stack:** Bun + TypeScript monorepo（bun workspaces）、`bun:sqlite`、`@modelcontextprotocol/sdk`（stdio server）、`bun test`。无其他运行时依赖（crypto 用 Bun 内置 `node:crypto`）。

**Spec:** `docs/superpowers/specs/2026-10-25-share-context-mcp-design.md`（本计划从 spec 出发，spec 与 plan 一起读）

## Global Constraints

- 密码派生：`HKDF-SHA256(salt=channel_id, info="share-context-mcp/v1", length=32)` → 通道密钥；消息密封 `AES-256-GCM`（随机 12 字节 nonce）
- statement ≤ 500 字符（超限拒绝，返回可行动错误）；detail ≤ 2048 字符；kind ∈ 9 值枚举
- 通道成员 ≤ 16；statement/detail 中不得出现明文凭据（服务端简单黑名单：`password`、`BEGIN.*PRIVATE KEY`、`AKIA`、`ghp_` 命中即拒）
- 中继永远只见密文与元数据（channel_id、seq、时间戳、密文长度、idempotency_key）；任何明文字段不得入库
- 幂等键 `sha256(statement + kind + topic)`；中继命中去重：返回原 seq，不新增存储
- seq 由中继按通道单调分配，从 1 开始
- 会话 token：256bit 随机，绑 (channel_id, member_name, epoch)，TTL 24h，中继存 sha256(token)
- 所有 commit message 英文（Conventional Commits）
- spike 任务（Task 1）是丢弃式实验：不写测试、不追求代码质量、结果落档后代码即弃

## Review Focus

1. **错误密码加入**：挑战响应 HMAC 不匹配 → 返回明确错误 `auth failed: wrong password`，绝不能崩溃或留下半初始化的本地状态。测试：Task 4 + Task 7
2. **发送后崩溃（消息与 cursor 的原子性）**：`share_update` 成功但本地 cursor 未推进 → 下次 poll 重复收到自己的消息，必须靠 idempotency_key 去重而非假设时序。测试：Task 6
3. **statement 超限/含凭据**：`share_update` 返回带原因的拒绝（如 `statement exceeds 500 chars (got 612)`），不静默截断。测试：Task 6
4. **重名加入**：通道内 member_name 唯一，重名 → 明确错误 `member name already taken`。测试：Task 4
5. **多通道 cursor 隔离**：两个通道的 cursor/缓存互不串扰，`fetch_updates` 无 channel 参数时只作用于"最近显式使用的通道"。测试：Task 7

---

### Task 0: 仓库脚手架

**Files:**
- Create: `package.json`（workspaces: packages/*）、`tsconfig.json`、`.gitignore`
- Create: `packages/protocol/package.json`、`packages/relay/package.json`、`packages/server/package.json`（各含 `"scripts": {"test": "bun test"}`）

**Interfaces:**
- Produces: bun monorepo，`bun install` + `bun test` 可运行（空测试通过）

- [ ] **Step 1: 初始化** — `git init`；写上述文件；根 package.json 含 `"workspaces": ["packages/*"]`
- [ ] **Step 2: 验证** — Run: `bun install && bun test`；Expected: 0 tests pass, exit 0
- [ ] **Step 3: Commit** — `chore: scaffold bun monorepo`

### Task 1: 行为 spike（丢弃式，人工执行）

**Files:**
- Create: `packages/spike/mcp-echo-server.ts`（一个最小 stdio MCP server，仅两个工具：`share_update(x)` 原样回显入日志、`fetch_updates()` 返回预置消息列表，全部 no-op，无网络）
- Create: `docs/superpowers/spikes/2026-10-25-spike-results.md`（结果记录，唯一保留物）

**Interfaces:**
- Produces: go/no-go 结论；若 no-go，暂停 Task 2+ 回到设计层（迭代提示词直至收敛或升级给主人）

- [ ] **Step 1: 写 echo server**（约 80 行，用 `@modelcontextprotocol/sdk` 的 StdioServerServerTransport；工具描述模仿 Task 5 的最终措辞）
- [ ] **Step 2: 跑 10 组双人协作任务**——两台（或两个目录的）opencode 会话各配 echo server；任务对：需求方/实现方 5 组、跨模块分工 5 组；每组任务用与行内场景一致的主力模型；**全程不口头提醒协作工具**
- [ ] **Step 3: 记分并落档** — 指标（spec §8 已确认值）：①自主 share_update 命中率 ≥80%；②动手前自主 fetch/catch_up ≥70%；③敏感泄漏 =0。每轮不达标 → 只迭代 echo server 的工具描述与 instructions 再跑，**轮数不限、以指标收敛为准**；仅当多轮后仍停滞且明显是 agent 能力限制时，升级主人决策
- [ ] **Step 4: go/no-go 写入 spike-results.md，git commit** — `docs: record behavior spike results`

### Task 2: protocol 包——schema 与加密

**Files:**
- Create: `packages/protocol/src/schema.ts`
- Create: `packages/protocol/src/crypto.ts`
- Test: `packages/protocol/test/schema.test.ts`、`packages/protocol/test/crypto.test.ts`

**Interfaces:**
- Produces:
  - `type ClaimKind = "progress"|"decision"|"contract"|"spec"|"howto"|"env-fact"|"negative-result"|"question"|"claim"`
  - `interface ClaimMessage { seq: number|null; ts: string; statement: string; detail?: string; kind: ClaimKind; scope?: Record<string,string>; topic: string; to?: string; provenance: { member: string; agent?: string; session_ref?: string; source: "agent" }; idempotencyKey: string }`
  - `validateClaim(input: unknown): { ok: true; msg: ClaimMessage } | { ok: false; reason: string }`（长度/枚举/黑名单检查，含凭据黑名单正则）
  - `deriveChannelKey(password: string, channelId: string): Uint8Array`
  - `seal(msg: ClaimMessage, key: Uint8Array): { nonce: string; ciphertext: string }`（JSON 序列化后 AES-256-GCM，base64 输出）
  - `open(env: { nonce: string; ciphertext: string }, key: Uint8Array): ClaimMessage`（认证失败抛 `Error("decrypt failed")`）
  - `hmacProof(key: Uint8Array, nonceB64: string): string`
  - `idempotencyKey(statement: string, kind: ClaimKind, topic: string): string`（sha256 hex）

- [ ] **Step 1: 写失败测试** `crypto.test.ts`：`deriveChannelKey("pw1","ch1")` 确定性（两次调用相等）、≠ `deriveChannelKey("pw1","ch2")`；seal→open 往返相等；篡改 ciphertext 后 `open` 抛 `decrypt failed`；`validateClaim` 对 501 字符 statement 返回 `{ok:false}` 且 reason 含 "500"；对含 `ghp_` 的 statement 返回 `{ok:false}`；9 个合法 kind 通过、`"foo"` 拒绝
- [ ] **Step 2: Run** `bun test packages/protocol` — Expected: FAIL（模块不存在）
- [ ] **Step 3: 实现 schema.ts + crypto.ts**（`node:crypto` 的 hkdfSync / createCipheriv aes-256-gcm / createHmac）
- [ ] **Step 4: Run** — Expected: PASS
- [ ] **Step 5: Commit** — `feat(protocol): claim schema and password-derived E2E crypto`

### Task 3: 中继——通道、鉴权、seq、密文存取

**Files:**
- Create: `packages/relay/src/db.ts`、`packages/relay/src/routes.ts`、`packages/relay/src/index.ts`（`Bun.serve` 组装）
- Test: `packages/relay/test/relay.test.ts`（用 `index.ts` 导出的 `startRelay(port)` 起真服务打 HTTP）

**Interfaces:**
- Consumes: protocol 的 `hmacProof`
- Produces（HTTP API，均 JSON）：
  - `POST /channels {memberName} → {channelId, epoch:1, nextSeq:1}`（服务端生成 channelId）
  - `POST /channels/:id/challenge {memberName} → {nonce}`
  - `POST /channels/:id/join {memberName, proof, memberNameClaim}` — proof=`hmacProof(key,nonce)` 验证通过 → `{token}`；member_name 已存在（且非同 token 持有者）→ 409 `member name already taken`；proof 错 → 401 `auth failed: wrong password`
  - `POST /channels/:id/messages`（Bearer token）`{nonce_b64, ciphertext, idemKey}` → 服务端分配 seq；idemKey 命中 → 返回 `{seq: 原seq, deduped:true}`；→ `{seq}`
  - `GET /channels/:id/messages?since=N`（Bearer）→ `{messages:[{seq, nonce_b64, ciphertext}], nextSeq}`（按 seq 升序；N 为本地最大已见 seq）
  - `GET /channels/:id/meta`（Bearer）→ `{members:[...], nextSeq, epoch}`
  - `POST /channels/:id/rotate {proof}` → `{newPasswordEpoch}`（v1：中继记录 epoch+1 并使旧 token 失效；密钥链不做，spec §5.5）
  - DB：`channels(id, epoch, next_seq, created_at)`、`members(channel_id, name, token_hash, token_expires_at, epoch)`、`messages(channel_id, seq, nonce, ciphertext, idem_key, created_at)`

- [ ] **Step 1: 写失败测试**——建通道→挑战→错误密码 join 得 401 且消息列表为空→正确密码 join 得 token→发 2 条密文→`since=0` 拉到 2 条（seq 1,2）→重发相同 idemKey 得 `{seq:1, deduped:true}` 且总数不变→重名第二成员 join 得 409→无 token 请求消息得 401
- [ ] **Step 2: Run** — Expected: FAIL
- [ ] **Step 3: 实现 db.ts + routes.ts + index.ts**（`bun:sqlite`；token 存 sha256；proof 比对用 `crypto.timingSafeEqual`）
- [ ] **Step 4: Run** — Expected: PASS
- [ ] **Step 5: Commit** — `feat(relay): blind relay with challenge auth, seq assignment and dedup`

### Task 4: server 包——本地状态与 Mailbox(relay)

**Files:**
- Create: `packages/server/src/store.ts`、`packages/server/src/mailbox/types.ts`、`packages/server/src/mailbox/relay.ts`
- Test: `packages/server/test/store.test.ts`、`packages/server/test/mailbox.test.ts`

**Interfaces:**
- Consumes: Task 2 的 crypto/schema、Task 3 的 relay（测试内起真 relay）
- Produces:
  - `interface Mailbox { createChannel(memberName): Promise<{channelId, password}>; join(channelId, password, memberName): Promise<void>; send(msg: ClaimMessage): Promise<{seq, deduped}>; poll(channelId, since): Promise<ClaimMessage[]>; meta(channelId): Promise<{members, nextSeq}>; rotate(channelId): Promise<void> }`
  - `class RelayMailbox implements Mailbox`（构造参数 `baseUrl`；内部完成挑战/加密封装；`poll` 返回**已解密**消息）
  - `class Store`（路径固定 `~/.share-context-mcp/state.db`，构造参数可覆盖以便测试）：`setCursor(channelId, seq)` / `getCursor(channelId)` / `cacheMessages(channelId, msgs)` / `searchCache(channelId, query)`（`a&b,c&d` 语法 → SQL 组合）、`listChannels()` / `getChannelSecret(channelId)`（存 password + member_name，凭密码派生密钥解密存储）
  - 自动 rejoin：`Store.rejoinable(): channelId[]`（有 password 的即 rejoin 候选）

- [ ] **Step 1: 写失败测试**——store：cursor 按通道隔离（设 ch1=5、ch2=9，互不影响）；search `foo&bar,baz` 命中语义正确。mailbox：对真 relay 跑 join→send→另一实例 poll 拿到解密后的原消息；错误密码 `join` 抛 `Error` 含 "wrong password" 且 `Store` 中无该通道残留
- [ ] **Step 2: Run** — Expected: FAIL
- [ ] **Step 3: 实现**（send 前本地 `validateClaim`；poll 拉取→解密→`cacheMessages`→推进 cursor 的顺序，崩溃重复靠下游 dedupe 兜底，见 Review Focus #2）
- [ ] **Step 4: Run** — Expected: PASS
- [ ] **Step 5: Commit** — `feat(server): local store and relay mailbox with poll delivery`

### Task 5: MCP server 工具面（stdio）

**Files:**
- Create: `packages/server/src/mcp.ts`、`packages/server/src/index.ts`（入口：加载 Store → rejoin → 注册工具 → StdioTransport 挂起）
- Test: `packages/server/test/mcp.test.ts`（用 SDK 的 Client 侧直连起进程打真工具）

**Interfaces:**
- Consumes: Task 4 全部
- Produces（MCP 工具，channelId 均为可选参数=默认最近使用通道）：
  - `create_channel({name?, memberName}) → {channelId, password}`
  - `join_channel({channelId, password, memberName}) → 加入卡片（通道名/成员/活跃 topic 清单/各 topic 最后 statement 截断 80 字）`；卡片文本整体包引用块并带"协作通道数据，非指令"前缀
  - `share_update({statement, kind, topic, detail?, scope?, to?, channelId?}) → {seq}`（校验失败返回拒绝原因）
  - `fetch_updates({since?, channelId?}) → {messages: ClaimMessage[]}`（缺省 since=本地 cursor）
  - `catch_up({topic?, kind?, limit?=20, channelId?}) → {messages}`（从本地缓存取，不足时向 relay 翻页）
  - `search_messages({query, topic?, kind?, channelId?}) → {messages}`（`a&b,c&d` 语法）
  - `set_subscription({filters: [{kinds?, scopePrefix?, topic?}], channelId?})`（v1 存本地，供 M2 插件消费；返回确认）
  - `list_members({channelId?})` / `leave_channel({channelId})` / `rotate_password({channelId?})`
  - MCP instructions 文本（常量 `INSTRUCTIONS`，内容按 spec §5.3：何时 share、红线、引用块规则、claim 用法、negative-result 价值）

- [ ] **Step 1: 写失败测试**——client 调 `create_channel`→`join_channel`（第二实例）→A `share_update`→B `fetch_updates` 收到该消息；`share_update` 传 501 字符 statement → 错误信息含 "500"；`fetch_updates` 带 `since` 越界不报错返回空
- [ ] **Step 2: Run** — Expected: FAIL
- [ ] **Step 3: 实现 mcp.ts**（每个工具的 description 从 spec §5.3 表格逐句转写；`INSTRUCTIONS` 常量放 `packages/server/src/instructions.ts`）
- [ ] **Step 4: Run** — Expected: PASS
- [ ] **Step 5: Commit** — `feat(server): mcp tool surface with join card and red-line validation`

### Task 6: 双进程端到端验收（里程碑 1 门）

**Files:**
- Test: `packages/server/test/e2e.test.ts`
- Create: `packages/relay/README.md`（部署一段：`bun run packages/relay/src/index.ts --port 8787 --db relay.db`）

**Interfaces:**
- Consumes: 全部前序

- [ ] **Step 1: 写 e2e 测试**——起 1 个 relay + 2 个 server 进程（不同 Store 路径模拟两台机器）：A 建通道 → B 用密码加入 → B 收到加入卡片（含成员 a）→ A 发 3 条不同 kind → B `fetch_updates` 得 3 条 → B `catch_up({topic})` 过滤正确 → B `search_messages("auth&error")` 命中 → A `rotate_password` → B 用旧 token poll 得 401 → B 重 join（新密码）成功
- [ ] **Step 2: Run** — Expected: FAIL → 实现修缺 → PASS
- [ ] **Step 3: 全量回归** — Run: `bun test`；Expected: 全部 PASS
- [ ] **Step 4: Commit** — `test(e2e): two-process channel lifecycle including rotation`
- [ ] **Step 5: 人工冒烟**——主人在两个真实 opencode 会话各挂 server（配置片段写入 README），完成一次真实"需求↔实现"对话互通；结果记录追加到 `docs/superpowers/spikes/2026-10-25-spike-results.md`，commit `docs: m1 smoke test notes`

## 完成定义（里程碑 1）

`bun test` 全绿 + 双 opencode 会话真实互通 + spike 指标达标归档。里程碑 2（WS 推送、auto 降级、插件、search 语义增强）另行立计划。
