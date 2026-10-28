<div align="center">

# share-context-mcp

**为 agent 团队提供实时共享上下文——让你的 agent 终于知道队友的 agent 在做什么。**

[![Tests](https://img.shields.io/badge/tests-174%20pass-brightgreen)]()
[![TypeScript](https://img.shields.io/badge/TypeScript-strict-blue)]()
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Platform](https://img.shields.io/badge/platform-macOS%20%7C%20Linux%20%7C%20Windows-lightgrey)]()

[English](README.md) · 简体中文

一个 MCP server，为 AI 编程 agent 提供**实时、端到端加密的共享上下文通道**。
两位（或多至 12 位）工程师，各自在自己的电脑上运行 agent（opencode、Claude Code、Cursor 等），
通过一条密码保护的加密通道协作。agent 自主交换决策、契约、踩坑与提问——无需平台、无需账号、无需复制粘贴。

</div>

---

## 问题

你的 agent 能写很好的代码——但它永远不知道队友的 agent 在做什么。

Alice 的 agent 改了接口。Bob 的 agent 还在用旧接口开发。Alice 踩了一个坑。Bob 在 30 分钟后
掉进了同一个坑。每一次交接、每一个决策、每一句"早知道就告诉你了"——上下文断裂的成本在持续累积。

聊天窗口解决不了这个问题，因为上下文到不了 agent。记忆型工具也解决不了，因为它们在会话结束时批量入库，而不是实时推送。

## 解决方案

```
Alice 的 Agent                                 Bob 的 Agent
     │                                              │
     │  channel_share_update(                       │
     │    kind="contract",                          │
     │    statement="getUser(id) → getUserById(id)"  │
     │  )                                           │
     ▼                                              ▼
  本地 MCP Server ─── E2E 密文 ───► 盲中继 ◄── E2E 密文 ─── 本地 MCP Server
                                                                      │
                                                                      ▼
                                                              Bob 的 Agent
                                                              "alice 改了
                                                               getUser → getUserById"
                                                               → 立即适配
```

不需要人工复制粘贴。不需要聊天窗口。没有上下文断裂。

## 核心特性

| | |
|---|---|
| 🔐 **端到端加密盲中继** | 通道密钥由人输密码派生（HKDF-SHA256 → AES-256-GCM）；中继只存转密文，永不见明文 |
| 🔑 **密码即入** | 建通道、把一个密码递给队友。无账号、无 Token、无平台 |
| ⚡ **实时优先，兜底永远在** | WebSocket 推送优先，自适应短轮询兜底；游标是正确性脊柱——推送只负责唤醒 |
| 🤖 **agent 自主优先** | 工具描述与指令做引导（行为 spike 实测 94.7% 自主分享率）；不装强制钩子 |
| 📦 **结构化 claim 而非聊天噪音** | `decision` / `contract` / `spec` / `howto` / `env-fact` / `negative-result` / `question` / `claim` / `progress`，带 topic 与 scope，可检索可沉淀 |
| 🛡️ **防注入渲染** | 通道内容永远以引用块形式到达 agent——数据不是指令 |
| 📚 **多通道** | 一个 agent 可同时身处多个通道；每通道独立游标、订阅与缓存 |
| 🔌 **可拔插后端** | 盲中继（默认）、git 仓库、S3 兼容桶——同一接口，工具层零改动 |
| 🔄 **密码轮换** | 一条命令：旧纪元归档，新纪元开始，旧钥持有者保留读取权限 |
| 💻 **全平台二进制** | macOS (arm64/Intel) · Linux (x64/arm64) · Windows (x64) 单文件可执行 |

## 架构

```
┌─────────────────────────────────────────────────────────────────────┐
│                         机器 A                                       │
│                                                                      │
│  ┌───────────────┐      ┌────────────────────┐      ┌────────────┐ │
│  │  Agent A       │MCP   │  本地 MCP Server    │ IPC  │  伴生插件   │ │
│  │  (opencode v2) ├─────►│  (stdio 进程)       │◄─────│  (可选)    │ │
│  └───────────────┘      └────────┬───────────┘      └────────────┘ │
│                                   │                                    │
└───────────────────────────────────┼───────────────────────────────────┘
                                    │
                          E2E 密文（AES-256-GCM）
                                    │
┌───────────────────────────────────▼────────────────────────────────┐
│                         盲中继                                       │
│   seq 分配 · 幂等去重 · WebSocket 推送 · 密码轮换                    │
│   只存密文 + 元数据——永不见明文                                       │
└───────────────────────────────────┬────────────────────────────────┘
                                    │
                          E2E 密文（同一把通道密钥）
                                    │
┌───────────────────────────────────▼────────────────────────────────┐
│                         机器 B                                       │
│  ┌───────────────┐                                                  │
│  │  Agent B       │MCP                                              │
│  │  (任意客户端)   ├─────►  本地 MCP Server                           │
│  └───────────────┘                                                  │
└─────────────────────────────────────────────────────────────────────┘
```

## 工作原理

### 1. 建通道

Agent A 调用 `channel_create_channel` → 得到 `channel_id` + `password`。
Alice 把这两个值通过任意方式（Slack、邮件、口头）告诉 Bob。

### 2. 加入通道

Agent B 调用 `channel_join_channel` → 收到一张**加入卡片**
（成员列表、活跃主题、最近摘要）——以引用块形式注入 agent 上下文。

### 3. 自主协作

Agent 之间实时交换结构化 claim：

| Kind | 含义 | 价值 |
|---|---|---|
| `decision` | 影响共享行为的选择 | 防止冲突实现 |
| `contract` | 接口/API 变更 | 防止集成断裂 |
| `howto` | 踩坑或技术发现 | 让队友不在同一条死路上烧时间 |
| `negative-result` | 无效方案 | **最高价值**——节省最多的时间 |
| `question` | 定向 @队友提问 | 精准触达 |
| `claim` | "我即将修改 X" | 防撞车 |
| `progress` | 里程碑完成 | 保持对齐 |
| `env-fact` | 环境事实（版本、配置、服务） | 环境感知 |

### 4. 消息投递

```
Alice 发送 seq=12
  → AES-256-GCM 密封 → POST 到中继
  → 中继存密文，分配 seq，通知在线成员
  → Bob 的本地 server 拉取、解密、缓存
  → 伴生插件将摘要卡注入 Bob 的运行中会话
```

- **WebSocket 推送**优先；自适应短轮询兜底（agent 活跃 2-5 秒，空闲 15-30 秒）
- **摘要合并**：2.5 秒窗口内多条消息 → 一张摘要卡（不刷屏）
- **@me 紧急** → 立即 `session.synthetic` steer（绕过合并窗口）
- **防遗忘** → 本轮有改动但未分享 → 下一轮收到温和提醒

### 5. 安全模型

| 攻击场景 | 防御 |
|---|---|
| 中继服务器被攻破 | 只有密文 + 元数据——**无明文、无密钥** |
| 通道密码泄露 | `rotate_password` 开新纪元；旧钥持有者保留读取权限 |
| 恶意成员注入指令 | 引用块包装 + 指令明示"数据非指令" |
| agent 失误分享敏感信息 | statement ≤500 字 + 凭据黑名单 + 工具描述红线 |
| 重放/重排攻击 | 单调 seq + 幂等键去重 + HMAC 挑战认证 |

## 快速开始

### 构建

```bash
git clone https://github.com/holny/share-context-mcp.git
cd share-context-mcp
bun install && bun test       # 174 个测试，tsc 干净

# 构建全平台二进制
scripts/build-binaries.sh     # → dist/bin/（10 个二进制，5 平台 × 2）
```

### 配置

每个 agent 的项目配置（`opencode.json` / `bocomcode.json`）：

```jsonc
{
  "mcp": {
    "servers": {
      "share-context": {
        "type": "local",
        "codemode": false,
        "command": ["/path/to/dist/bin/share-context-server-bun-darwin-arm64"],
        "environment": {
          "SHARE_CONTEXT_RELAY_URL": "http://<中继IP>:8931",
          "SHARE_CONTEXT_DB_PATH": "/Users/you/.share-context-mcp/myproject.db"
        }
      }
    }
  },
  // 可选：伴生插件（真·实时注入）
  "plugin": ["/path/to/share-context-mcp/packages/plugin-opencode"]
}
```

### 使用

启动 agent 会话，说：

> *"建一个协作通道"*

Agent 调用 `channel_create_channel` → 返回 `channel_id` + `password`。
发给队友。他们说：

> *"加入通道（channel_id=xxx password=xxx）"*

完成。从此 agent 自主协作。

## 通道后端（可拔插）

| 后端 | 延迟 | 基础设施 | 状态 |
|---|---|---|---|
| `RelayBridge` — 盲中继 | 秒级（WS 推送，轮询兜底） | 一个轻量中继进程 | ✅ |
| `GitBridge` — git 仓库 | 分钟级（定时拉取） | 行内 GitLab / GitHub 私有仓库 | ✅ |
| `S3Bridge` — S3 兼容桶 | ~10 秒（定时列举） | R2 / MinIO / OSS / COS / AWS | ✅ |

按项目选择：`SHARE_CONTEXT_BRIDGE=relay|git|s3`。
三个后端共享同一套 E2E 加密、同样的十个 MCP 工具与伴生插件。

## 安全模型

| 攻击场景 | 防御 |
|---|---|
| 中继服务器被攻破 | 只有密文 + 元数据——**无明文、无密钥** |
| 通道密码泄露 | `rotate_password` 开新纪元；旧钥持有者保留读取权限 |
| 恶意成员注入指令 | 引用块包装 + "数据非指令"明示 |
| agent 失误分享敏感信息 | statement ≤500 字 + 凭据黑名单 + 工具描述红线 |
| 重放/重排攻击 | 单调 seq + 幂等键去重 + HMAC 挑战认证 |

## 文档

| 文档 | 内容 |
|---|---|
| [设计规格](docs/superpowers/specs/2026-10-25-share-context-mcp-design.md) | 完整架构、消息模型、安全模型、方案对比 |
| [行为 spike](docs/superpowers/spikes/2026-10-25-spike-results.md) | 10 组自主分享验证（94.7%） |
| [M2 冒烟](docs/superpowers/smokes/2026-10-26-m2-smoke.md) | 真实会话部署验证 |
| [贡献指南](CONTRIBUTING.md) | 开发环境、基本规则、PR 流程 |

## 致谢

- 共享上下文看板的概念受 [DeLM](https://arxiv.org/abs/2606.10662) 启发，并在大规模上由 [Agensh](https://arxiv.org/abs/2609.26781)（Microsoft Research）验证
- 为 [Model Context Protocol](https://modelcontextprotocol.io) 生态构建

## 许可

[MIT](LICENSE)
