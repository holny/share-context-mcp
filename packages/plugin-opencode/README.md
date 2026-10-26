# @share-context-mcp/plugin-opencode

opencode v2 伴生插件（spec §5.4）—— share-context-mcp 的真·实时投递层。它连接本机 MCP server 内置的 IPC broadcaster（`packages/server/src/broadcaster.ts`）的 Unix socket，把摘要卡注入正在运行的 agent 会话。

## 行为

1. **连接 IPC socket**（指数退避重连；server 不在线时静默待命——MCP stdio server 只在 agent 会话期间存活，socket 时有时无是常态）。
2. **urgent 卡**（`cardKind === "urgent"`，即 @你 的消息）→ 立即 `session.synthetic(delivery: "steer")` 注入，绕过一切窗口。
3. **digest 卡** → 暂存 pending 槽；该会话下一次工具调用的结果尾部搭便车追加卡片文本，追加后清空 pending。格式：

   ```
   \n\n---
   📋 协作通道：N 条新消息（M 条 @你）
   - [#seq·kind·topic] from: statement
   用 fetch_updates 展开详情
   ```

4. **防遗忘**：跟踪每会话工具动作（edit/write/patch/bash/shell 记为动作；`share_update` 记为已分享）。在**下一轮开始**（`session.execution.started` 事件）判定上一轮：有写动作且未分享 → 注入一句温和提示（含"忽略"出口）。锚定在下一轮开始而非 idle 边界，是因为 idle 事件异步到达可能与下一轮的 hook 交错（测试中实际复现过误报）；而 `started` 触发时上一轮的所有 hook 必然已完成。

## 配置（环境变量）

| 变量 | 含义 | 默认 |
| --- | --- | --- |
| `SHARE_CONTEXT_IPC_SOCKET` | broadcaster 的 Unix socket 路径（与 server 共用同一变量） | `~/.share-context-mcp/ipc.sock` |
| `SHARE_CONTEXT_PLUGIN` | 设为 `off`/`0`/`false`/`no` 完全禁用插件（不注册 hook、不连 socket） | 启用 |

## 安装（本地路径插件）

bocomcode_v2 的插件加载器（`packages/core/src/plugin/module.ts`）支持本地目录：目录根必须能解析出 `index` 入口（本包根部的 `index.ts` 即为此准备）。在 opencode 配置（如 `~/.config/opencode/opencode.json` 或项目 `.opencode/opencode.json`）中加入：

```json
{
  "plugin": [
    "/absolute/path/to/share-context-mcp/packages/plugin-opencode"
  ]
}
```

加载器会用 Bun 直接加载 TS 源码，无需构建。插件对宿主零依赖（promise-plugin Context 按结构匹配），import 图完全自包含。

## 设计要点

- **多会话并发**：状态按 sessionID 路由；urgent 卡投递给最近活跃的会话（IPC 事件不携带 sessionID，这是已知近似）；工具结果搭便车天然按会话。
- **纵深防御**：broadcaster 端已做字段白名单（Review Focus #2），客户端再次校验事件形状，丢弃一切非规范行。
- **纯函数可测**：卡片合并/渲染（`src/coalesce.ts`）、防遗忘判定（`src/anti-forget.ts`）、退避调度（`src/ipc.ts` 的 `nextBackoffMs`）均为独立纯函数，`test/` 下全覆盖；插件进程内 smoke（`test/plugin-smoke.test.ts`）用最小 fake Context 驱动真实 socket 验证 urgent steer / digest 搭便车 / 防遗忘注入。真实 opencode 会话级验证在 Task 5。
