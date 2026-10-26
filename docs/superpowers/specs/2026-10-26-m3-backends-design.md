# M3 设计 — GitBridge 与 S3Bridge 后端（一次性全实现）

- 日期：2026-10-26
- 状态：已批准（主人指令：一次性全实现、不中断、交付完全测试的成品）
- 前置：M1/M2 已合入 main（ChannelBridge 接口、RelayBridge、双游标、broadcaster、插件）

## 1. 意图

M2 交付了唯一后端 RelayBridge（实时，但需要架中继服务）。M3 把 ChannelBridge 接口的另外两个实现做出来：

- **GitBridge** — 通道 = 一个 git 仓库（行内 GitLab / GitHub 私有仓库）。零新基础设施，分钟级延迟。
- **S3Bridge** — 通道 = 一个 S3 兼容桶前缀。一个实现覆盖 AWS S3 / Cloudflare R2 / 阿里 OSS / 腾讯 COS / 自建 MinIO。准实时。

选择权交给每个项目：agent 项目配置里通过环境变量 `SHARE_CONTEXT_BRIDGE=relay|git|s3`（默认 relay）+ 各后端自己的环境变量选择后端。MCP 工具层、broadcaster、插件、双游标、E2E 加密全部不动。

## 2. 目标 / 非目标

### 目标
- 两个新 Bridge 通过与 RelayBridge 相同的语义测试（send/poll/listen/meta/rotate/leave + 双成员互投 + rotate）
- GitBridge 在 file:// 裸仓库上端到端测试（本地 git 即可复现）
- S3Bridge 对一个进程内假 S3（Bun.serve 实现所需端点）端到端测试
- 桥选择工厂：`createChannelBridge(kind, deps)`，env 驱动
- 上层零改动：MCP 工具、broadcaster、Store 双游标、插件完全复用

### 非目标
- 实时推送（两个新后端 listen = 定时轮询铃；内网 GitLab webhook 触发留给 v2）
- 官方 MCP Registry 的实际发布（npm 化打包准备好，`npm publish` 由维护者执行）
- 跨后端互通（一个通道只存在于一种后端上）

### 反目标
- 为后端差异化放松 E2E：三个后端都必须先 seal 后落盘、poll 出来先 open
- 引入 AWS SDK 依赖（S3 用 fetch + node:crypto 手写 SigV4，保持零依赖传统）

## 3. 核心设计

### 3.1 seq 分配（两后端共同难题：无中心分配者）

引入**后端内的原子序号文件** `state/head.json`：`{"nextSeq": N, "epoch": E}`。

- **GitBridge send**：pull → 读 head.nextSeq → 写 `messages/<seq>-<idemKey8>.enc` → 更新 head → commit → `pull --rebase --autostash` → push；push 被拒或 rebase 后 head 变化 → 重读 head 重试（≤5 次）。与中继 `stmtAllocSeq RETURNING` 同构：重读-重试消化并发。
- **S3Bridge send**：`GET state/head.json`（记 ETag）→ `PUT state/head.json` 带 `If-Match: <ETag>` 原子自增（S3/R2/MinIO 均支持条件写）；412 → 重读重试（≤5）。消息对象键 `<prefix>/<channelId>/<epoch>/<seq 12位补零>-<idemKey8>.enc`。
- **幂等去重**：文件名含 idemKey 前 8 字符；poll 侧再按完整 idemKey 去重（Batch 内与对缓存）。
- **有序性**：seq 单调；乱序到达（git rebase 重排）由 poll 侧按 seq 排序后输出。

### 3.2 GitBridge

- 持久工作副本：`~/.share-context-mcp/git-bridge/<channelId>/`（bare remote 可为 file:// 便于测试）
- 布局：`channels/<channelId>/{state/head.json, messages/*.enc, members.json}`
- `createChannel({name, memberName, gitUrl})` — gitUrl 进 opts（Mailbox 接口扩展可选字段，非破坏）；本地 init → 结构提交 → push -u
- `join({channelId, password, memberName, gitUrl})` — clone/pull 验证可读 → 追加 members.json → push（push 权限即成员资格；E2E 密码仅用于派生密钥）
- `poll(since)` — fetch → 读 origin HEAD 与本地已见对比 → 解析新增 .enc → open → 按 seq 排序 → 过滤 seq ≤ since（重放防护）
- `listen` — 定时 fetch（默认 15s，可配）；onNotify 唤醒上层 poll
- `rotate` — 换 epoch 目录 + head.json.epoch+1；push
- git 凭证：使用用户现有 git 推拉配置（行内 GitLab SSH/HTTPS 均可），不在本桥内做认证

### 3.3 S3Bridge（SigV4 手写，零依赖）

- 配置（env）：`SHARE_CONTEXT_S3_ENDPOINT`、`SHARE_CONTEXT_S3_BUCKET`、`SHARE_CONTEXT_S3_REGION`、`SHARE_CONTEXT_S3_AK`、`SHARE_CONTEXT_S3_SK`（或 join/create 时显式传入）
- SigV4：node:crypto HMAC-SHA256 链（~80 行）：canonical request → signing key → Authorization header
- 操作映射：
  - createChannel：PUT `<prefix>/<channelId>/state/head.json`（If-None-Match: * 防抢占）+ PUT members.json
  - send：GET head（记 ETag）→ 条件 PUT head（If-Match，412 重读重试 ≤5）→ PUT 消息对象
  - poll：GET `?list-type=2&prefix=<dir>/&start-after=<since 起始键>` → 解析 XML（小型正则解析 Key/ETag）→ 按 seq 升序 GET 解密
  - listen：ListObjects 定时轮询（默认 10s，可配）
- 强一致：AWS/R2/MinIO 均为强一致写后读，无脏读窗口；不支持 If-Match 条件写的边缘 S3 实现 → 文档标注降级（退化为 last-write-wins + 幂等键去重）

### 3.4 桥选择工厂

`packages/server/src/bridge/factory.ts`：

```ts
createChannelBridge(kind: "relay" | "git" | "s3", opts): ChannelBridge
```

- kind 来源：env `SHARE_CONTEXT_BRIDGE`（默认 relay）
- index.ts 的 runStdioServer 据此构建 backend 注入 McpServerDeps（替代硬编码 RelayBridge）
- Mailbox 接口微调：createChannel/join 增加可选 `gitUrl?` / `s3?` 透传字段（非破坏）

### 3.5 测试策略

- GitBridge：`git init --bare` 临时裸仓库做 remote，双成员全流程（create/join/send×3/poll/rotate/re-join），push 竞争重试路径注入测试
- S3Bridge：Bun.serve 进程内假 S3（GET/PUT 对象 + ETag 条件写 + List XML + 412 模拟），双成员全流程 + 条件写竞争重试
- 工厂：env 切换三种 kind，类型正确
- 回归：现有 158 测试不动一行语义

## 4. 风险

- git push 竞争重试上限（5 次）耗尽 → send 抛错，agent 可重试（消息未丢，还在本地队列语义外——文档明示 v1 send 失败需重发）
- S3 条件写不被支持 → 检测 501/400 NotImplemented 后降级 last-write-wins + 幂等过滤，并在 meta 中标记 `degradedSeq: true`
- 两个新后端无实时推送 → 文档明示延迟档位：relay 秒级 / S3 ~10s / git ~15s

## 5. 交付

- 158 + 新增（预计 ~30）测试全绿；tsc 干净
- 二进制重建（新桥打包进 server 二进制，零配置切换）
- README 特性矩阵更新（三后端对照表）
- npm 化打包字段（bin/mcpName/files）就绪，发布命令留给维护者
