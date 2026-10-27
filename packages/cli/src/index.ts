#!/usr/bin/env bun
import { homedir } from "node:os";
import { join } from "node:path";
import { existsSync } from "node:fs";

const VERSION = "0.1.0";

function arg(name: string): string | undefined {
  const prefix = `--${name}`;
  for (let i = 0; i < process.argv.length; i++) {
    if (process.argv[i] === prefix) {
      const v = process.argv[i + 1];
      return v !== undefined && !v.startsWith("--") ? v : undefined;
    }
    if (process.argv[i].startsWith(`${prefix}=`)) return process.argv[i].slice(prefix.length + 1);
  }
  return undefined;
}

function relayUrl(): string {
  return (arg("relay-url") ?? process.env.SHARE_CONTEXT_RELAY_URL ?? "http://127.0.0.1:8931").replace(/\/+$/, "");
}

function dbPath(): string {
  return process.env.SHARE_CONTEXT_DB_PATH ?? join(homedir(), ".share-context-mcp", "state.db");
}

async function cmdRelay() {
  const { startRelay } = await import("@share-context-mcp/relay");
  const port = Number(arg("port") ?? 8931);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    console.error(`invalid --port: ${arg("port")}`);
    process.exit(1);
  }
  const db = arg("db") ?? join(homedir(), ".share-context-mcp", "relay.db");
  console.error(`share-context relay v${VERSION}`);
  console.error(`  admin console: http://localhost:${port}/admin`);
  console.error(`  press Ctrl+C to stop\n`);
  const relay = await startRelay({ port, dbPath: db });
  console.error(`relay listening on http://0.0.0.0:${relay.port}`);
  process.on("SIGINT", () => process.exit(0));
  process.on("SIGTERM", () => process.exit(0));
  setInterval(() => {}, 60_000);
}

async function cmdServer() {
  const { runStdioServer } = await import("@share-context-mcp/server");
  console.error(`share-context server v${VERSION} — stdio mode`);
  await runStdioServer({});
}

async function cmdCreateChannel() {
  const { Store } = await import("@share-context-mcp/server");
  const { RelayBridge } = await import("@share-context-mcp/server");
  const store = new Store(dbPath());
  const bridge = new RelayBridge({ baseUrl: relayUrl(), store });
  const created = await bridge.createChannel({ memberName: arg("member") ?? "me" });
  console.log(`\n✅ Channel created!\n  channel_id: ${created.channelId}\n  password:   ${created.password}\n`);
}

async function cmdJoin() {
  const { Store } = await import("@share-context-mcp/server");
  const { RelayBridge } = await import("@share-context-mcp/server");
  const store = new Store(dbPath());
  const bridge = new RelayBridge({ baseUrl: relayUrl(), store });
  await bridge.join(arg("channel-id")!, arg("password")!, arg("member")!);
  console.log(`\n✅ Joined channel ${arg("channel-id")} as ${arg("member")}\n`);
}

async function cmdStatus() {
  const { Store, RelayBridge } = await import("@share-context-mcp/server");
  const store = new Store(dbPath());
  const bridge = new RelayBridge({ baseUrl: relayUrl(), store });
  const channels = store.listChannels();
  if (channels.length === 0) { console.log("No channels joined."); return; }
  for (const ch of channels) {
    try {
      const meta = await bridge.meta(ch);
      console.log(`\n📡 ${ch} (${store.getChannelSecret(ch)?.memberName ?? "?"})`);
      console.log(`   members: ${meta.members.map((m) => m.memberName).join(", ")}`);
    } catch (e) { console.log(`\n📡 ${ch} — error`); }
  }
}

async function cmdFetch() {
  const { Store, RelayBridge } = await import("@share-context-mcp/server");
  const store = new Store(dbPath());
  const bridge = new RelayBridge({ baseUrl: relayUrl(), store });
  const channels = store.listChannels();
  for (const ch of channels) {
    try {
      const r = await bridge.poll(ch, 0);
      console.log(`\n📡 ${ch}:`);
      for (const m of r.messages) console.log(`  [${m.seq}] ${m.kind} (${m.topic}) ${m.provenance.member}: ${m.statement.slice(0, 100)}`);
    } catch (e) { console.error(`\n📡 ${ch} — error: ${e instanceof Error ? e.message : String(e)}`); }
  }
}

async function cmdRotatePassword() {
  const { Store, RelayBridge, generateGroupedPassword } = await import("@share-context-mcp/server");
  const store = new Store(dbPath());
  const bridge = new RelayBridge({ baseUrl: relayUrl(), store });
  const channels = store.listChannels();
  if (channels.length === 0) { console.log("No channels."); return; }
  for (const ch of channels) {
    const newPassword = generateGroupedPassword();
    await bridge.rotate(ch, newPassword);
    console.log(`\n🔄 ${ch}: new password = ${newPassword}\n  (share this with teammates — old password no longer works)\n`);
  }
}

async function cmdLeave() {
  const { Store, RelayBridge } = await import("@share-context-mcp/server");
  const store = new Store(dbPath());
  const bridge = new RelayBridge({ baseUrl: relayUrl(), store });
  const channels = store.listChannels();
  if (channels.length === 0) { console.log("No channels."); return; }
  for (const ch of channels) {
    await bridge.leave(ch);
    console.log(`Left ${ch}`);
  }
}

function cmdHelp() {
  console.log(`share-context v${VERSION}\n\nCommands:\n  relay            Start blind relay server\n  server           Start local MCP server (stdio)\n  create-channel   Create a channel (--member <name>)\n  join             Join a channel (--channel-id <id> --password <pw> --member <name>)\n  status           Show channel status\n  fetch            Fetch recent messages\n  rotate-password  Rotate channel password\n  leave            Leave channels\n  help             Show help`);
}

const command = process.argv[2];
const commands: Record<string, () => Promise<void>> = {
  relay: cmdRelay, server: cmdServer, "create-channel": cmdCreateChannel,
  join: cmdJoin, status: cmdStatus, fetch: cmdFetch,
  "rotate-password": cmdRotatePassword,
  leave: cmdLeave,
};

if (!command || command === "help" || command === "--help") { cmdHelp(); process.exit(0); }
const handler = commands[command];
if (!handler) { console.error(`Unknown: ${command}`); process.exit(1); }
handler().catch((err) => { console.error(`Error: ${err instanceof Error ? err.message : String(err)}`); process.exit(1); });
