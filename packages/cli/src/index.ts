#!/usr/bin/env bun
import { homedir, hostname } from "node:os";
import { join } from "node:path";
import { existsSync } from "node:fs";
import { randomBytes } from "node:crypto";

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

/** Bare boolean flag: `--name` present (no value consumed). */
function flag(name: string): boolean {
  return process.argv.includes(`--${name}`) || process.argv.some((a) => a.startsWith(`--${name}=`));
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
  const { encodeBlobEnvelope } = await import("@share-context-mcp/protocol");
  const store = new Store(dbPath());
  const bridge = new RelayBridge({ baseUrl: relayUrl(), store });
  const mode = arg("mode");
  const created = await bridge.createChannel({
    memberName: arg("member") ?? "me",
    admissionMode: mode,
    visibility: arg("visibility"),
    encrypted: arg("encrypted") !== undefined,
    probationEnabled: arg("probation") !== undefined,
    contactInfo: arg("contact"),
  });
  console.log(`\n✅ Channel created!\n  channel_id: ${created.channelId}\n  password:   ${created.password}`);
  // Copy-paste onboarding (spec §14): the join blob carries everything a
  // teammate's agent needs — no juggling channel_id + password by hand.
  const blob = encodeBlobEnvelope({
    type: "join_password",
    payload: {
      relayUrl: relayUrl(),
      channelId: created.channelId,
      password: created.password,
      admissionMode: mode ?? "password",
    },
  });
  console.log(`\n  join blob (paste to an agent, or: share-context join --blob "<blob>"):\n  ${blob}\n`);
}

async function cmdJoin() {
  const { Store, RelayBridge } = await import("@share-context-mcp/server");
  const store = new Store(dbPath());
  const blobStr = arg("blob");
  if (blobStr) {
    // Copy-paste onboarding (spec §14): one scmc2- string carries relay,
    // channel, credential/invite code and (when encrypted) the message key.
    const { parseBlobEnvelope } = await import("@share-context-mcp/protocol");
    const env = parseBlobEnvelope(blobStr);
    const p = env.payload as {
      relayUrl?: string; channelId: string; password?: string; inviteCode?: string;
      channelName?: string; messageKey?: string; keyVersion?: number;
    };
    const bridge = new RelayBridge({ baseUrl: p.relayUrl ?? relayUrl(), store });
    const member = arg("member") ?? (hostname().replace(/[^A-Za-z0-9_-]/g, "-").slice(0, 32) || "me");
    if (p.inviteCode) {
      await bridge.joinWithInvite(p.channelId, p.inviteCode, member);
    } else {
      await bridge.join(p.channelId, p.password!, member);
    }
    // key top-up (spec §4.5): an already-joined member can resume after rotation
    if (p.messageKey) {
      store.setMessageKey(p.channelId, p.keyVersion ?? 1, new Uint8Array(Buffer.from(p.messageKey, "base64")));
      console.log(`  message key v${p.keyVersion ?? 1} installed from blob.`);
    }
    if (p.channelName) store.setKv(`channelName:${p.channelId}`, p.channelName);
    console.log(`\n✅ Joined ${p.channelName ?? p.channelId} as ${member} (via share blob)\n`);
    return;
  }
  const bridge = new RelayBridge({ baseUrl: relayUrl(), store });
  const inviteCode = arg("invite-code");
  if (inviteCode) {
    await bridge.joinWithInvite(arg("channel-id")!, inviteCode, arg("member")!);
    console.log(`\n✅ Joined channel ${arg("channel-id")} as ${arg("member")} (via invite code)\n`);
    return;
  }
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
      console.log(`   creator: ${meta.creatorMember ?? "?"}  manager: ${meta.managerMember ?? "?"}  mode: ${meta.admissionMode ?? "password"}${meta.contactInfo ? `\n   contact: ${meta.contactInfo}` : ""}`);
      console.log(`   members: ${meta.members.map((m) => `${m.memberName}${m.lastActiveAt ? "" : " (idle)"}`).join(", ")}`);
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
  const transferTo = arg("transfer-to");
  for (const ch of channels) {
    await bridge.leave(ch, transferTo ? { transferTo } : undefined);
    console.log(`Left ${ch}${transferTo ? ` (roles transferred to ${transferTo} per succession rules)` : ""}`);
  }
}

function cmdHelp() {
  console.log(`share-context v${VERSION}

Commands:
  relay                        Start blind relay server
  server                       Start local MCP server (stdio)
  create-channel               Create a channel (--member <name> [--visibility public|private] [--mode no_limit|invite|password] [--encrypted] [--probation] [--contact "..."])
  join                         Join a channel (--channel-id <id> --password <pw> | --invite-code <code> | --blob "<blob>") [--member <name>]
  status                       Show channel status (roles, admission mode, contact)
  fetch                        Fetch recent messages
  leave                        Leave channels (--channel-id <id> [--transfer-to <name>])

  channel list                 Channels this member holds
  channel info --id <id>       Members, roles, admission mode, contact
  channel bans --id <id>       Banned members (name, consumer ids, ip, by)
  channel unban --id <id> --name N   Restore entry rights (manager/creator)
  channel revoke-invite --id <id> --name N   Strip a member's invite right
  channel grant-invite --id <id> --name N    Restore a member's invite right
  channel transfer --id <id> --to N   Creator hands the manager role to N
  channel dissolve --id <id> [--yes]   Delete the channel (manager/creator)
  channel set-admission <id> --mode no_limit|invite|password [--visibility public|private]
                               [--probation 1|0] [--invite-skips 1|0]
                               [--invite-policy everyone|managers-only] [--contact "..."]
  rotate --id <id> --mode access|full [--password <pw>]
                               access (default): new admission credential only;
                               full: + message key (all members need the new credential)
  rotate-key --id <id>         OWNER ONLY — mint message key vN+1 locally, bump the
                               relay version, broadcast a contact notice (no key travels)
  invite --id <id> [--ttl hours]   Mint an invite code (invite tier, per invite rights)
  token refresh --id <id>      Rotate this member's channel token
  vote start --channel <id> --type kick --target <name> [--reason R] [--revoke-invitees]
  vote list --id <id>          Open + settled votes with tallies
  audit --id <id>              Governance audit log
  directory [query]            Search opt-in channels on the relay
  help                         Show help`);
}

// ---- governance command helpers ----

async function govBridge() {
  const { Store, RelayBridge } = await import("@share-context-mcp/server");
  const store = new Store(dbPath());
  const bridge = new RelayBridge({ baseUrl: relayUrl(), store });
  return { store, bridge };
}

function requireId(): string {
  const id = arg("id") ?? arg("channel");
  if (!id) { console.error("Error: --id (or --channel) required"); process.exit(1); }
  return id;
}

async function relayGetJson(id: string, path: string): Promise<Record<string, unknown>> {
  const { bridge } = await govBridge();
  const res = await fetch(`${relayUrl()}/channels/${id}${path}`, { headers: bridge.authHeaders(id) });
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (res.status >= 400) { console.error(`Error: ${body.error ?? res.status}`); process.exit(1); }
  return body;
}

async function relayPostJson(id: string, path: string, body: Record<string, unknown>): Promise<Record<string, unknown>> {  const { bridge } = await govBridge();
  const res = await fetch(`${relayUrl()}/channels/${id}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...bridge.authHeaders(id) },
    body: JSON.stringify(body),
  });
  const body2 = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (res.status >= 400) { console.error(`Error: ${body2.error ?? res.status}`); process.exit(1); }
  return body2;
}

async function cmdChannelList() {
  const { store } = await govBridge();
  const channels = store.listChannels();
  if (channels.length === 0) { console.log("No channels."); return; }
  for (const ch of channels) {
    const secret = store.getChannelSecret(ch);
    console.log(`${ch}  member=${secret?.memberName ?? "?"}  epoch=${secret?.epoch ?? "?"}`);
  }
}

async function cmdChannelInfo() {
  const id = requireId();
  const info = await relayGetJson(id, "/meta");
  console.log(JSON.stringify(info, null, 2));
}

async function cmdChannelBans() {
  const id = requireId();
  const bans = await relayGetJson(id, "/bans");
  console.log(JSON.stringify(bans, null, 2));
}

async function cmdChannelUnban() {
  const id = requireId();
  const name = arg("name");
  if (!name) { console.error("Error: --name required"); process.exit(1); }
  const out = await relayPostJson(id, "/unban", { name });
  if (out.ok) console.log(`✅ ${name} unbanned${out.reminder ? ` — ${out.reminder}` : ""}`);
  else console.log(`⚠️  ${name} had no active ban — nothing changed.`);
}

async function cmdChannelRevokeInvite() {
  const id = requireId();
  const name = arg("name");
  if (!name) { console.error("Error: --name required"); process.exit(1); }
  const out = await relayPostJson(id, "/invite-rights", { name, canInvite: 0 });
  console.log(`✅ ${out.name} invite right revoked — member notified`);
}

async function cmdChannelGrantInvite() {
  const id = requireId();
  const name = arg("name");
  if (!name) { console.error("Error: --name required"); process.exit(1); }
  const out = await relayPostJson(id, "/invite-rights", { name, canInvite: 1 });
  console.log(`✅ ${out.name} invite right restored`);
}

async function cmdChannelTransfer() {
  const id = requireId();
  const to = arg("to");
  if (!to) { console.error("Error: --to required"); process.exit(1); }
  const out = await relayPostJson(id, "/transfer", { to });
  console.log(`✅ manager role transferred to ${out.manager}`);
}

async function cmdChannelDissolve() {
  const id = requireId();
  if (!flag("yes")) { console.error("This permanently deletes the channel for everyone. Re-run with --yes to confirm."); process.exit(1); }
  const { store, bridge } = await govBridge();
  const res = await fetch(`${relayUrl()}/channels/${id}/dissolve`, {
    method: "POST",
    headers: { "content-type": "application/json", ...bridge.authHeaders(id) },
    body: JSON.stringify({}),
  });
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (res.status >= 400) { console.error(`Error: ${body.error ?? res.status}`); process.exit(1); }
  store.removeChannel(id);
  console.log(`✅ channel ${id} dissolved (all relay data deleted; old credentials/invite codes are dead)`);
}

async function cmdChannelSetAdmission() {
  const id = requireId();
  const mode = arg("mode");
  if (!mode || !["no_limit", "invite", "password"].includes(mode)) {
    console.error("Error: --mode no_limit|invite|password required"); process.exit(1);
  }
  const visibility = arg("visibility");
  if (visibility && !["public", "private"].includes(visibility)) {
    console.error("Error: --visibility public|private"); process.exit(1);
  }
  if (visibility === "private" && mode === "no_limit") {
    console.error("Error: private channels cannot use no_limit admission"); process.exit(1);
  }
  if (mode === "no_limit" && visibility !== "private") {
    const anyEncrypted = false; // relay warns if the channel is encrypted
    void anyEncrypted;
  }
  const body: Record<string, unknown> = { mode };
  if (visibility) body.visibility = visibility;
  const probation = arg("probation");
  if (probation !== undefined) body.probationEnabled = probation === "1" || probation === "true";
  const inviteSkips = arg("invite-skips");
  if (inviteSkips !== undefined) body.inviteSkipsProbation = inviteSkips === "1" || inviteSkips === "true";
  const policy = arg("invite-policy");
  if (policy) body.invitePolicy = policy;
  const contact = arg("contact");
  if (contact) body.contactInfo = contact;
  const out = await relayPostJson(id, "/set-admission", body);
  console.log(`✅ admission mode = ${out.mode}${visibility ? `, visibility = ${visibility}` : ""} (future admissions only — existing members unaffected)`);
  if (typeof out.warning === "string") console.log(`⚠️  ${out.warning}`);
}

/** Owner-only message-key rotation (spec §3): local mint → relay version bump → broadcast. */
async function cmdRotateKey() {
  const id = requireId();
  const { bridge } = await govBridge();
  const nextVersion = await bridge.rotateKey(id);
  console.log(`✅ message key rotated to v${nextVersion} (minted locally — the relay only knows the version number).`);
  console.log(`\nAll other members' sends are now REJECTED with a key-mismatch notice pointing at your contact string.`);
  console.log(`Distribute the new key via an MCP generate_share_blob (join_key blob), or paste it to each member out of band.`);
}

async function cmdRotate() {
  const id = requireId();
  const mode = arg("mode") ?? "access";
  if (!["access", "full"].includes(mode)) { console.error("Error: --mode access|full"); process.exit(1); }
  const { store, bridge } = await govBridge();
  const secret = store.getChannelSecret(id);
  if (!secret) { console.error(`Error: not joined: ${id}`); process.exit(1); }
  const memberCount = (await (await fetch(`${relayUrl()}/channels/${id}/meta`, { headers: bridge.authHeaders(id) })).json() as { members: unknown[] }).members.length;
  const { mintAdmissionCredential } = await import("@share-context-mcp/protocol");
  const channelKey = bridge.channelKey(id);
  const { credential, verifyKeyB64 } = mintAdmissionCredential(channelKey);
  if (mode === "access") {
    // credential swap only: new verify hash, same wrapped key, tokens kept
    const res = await fetch(`${relayUrl()}/channels/${id}/set-credential`, {
      method: "POST",
      headers: { "content-type": "application/json", ...bridge.authHeaders(id) },
      body: JSON.stringify({ verifyKeyB64, credential }),
    });
    const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (res.status >= 400) { console.error(`Error: ${body.error ?? res.status}`); process.exit(1); }
    store.upsertChannel({ channelId: id, password: credential, memberName: secret.memberName, epoch: secret.epoch });
    console.log(`✅ admission credential rotated (access mode).\nNew credential (share with NEW members only — existing members are unaffected):\n${credential}`);
    if (memberCount > 1) console.log(`\nNote: ${memberCount - 1} other member(s) keep their tokens — no action needed for them.`);
  } else {
    // full: new password → new channel key + epoch bump (current rotate endpoint)
    const newPassword = arg("password") ?? randomBytes(20).toString("base64url");
    await bridge.rotate(id, newPassword);
    console.log(`✅ FULL rotation: new password = ${newPassword}\n⚠️  ALL members (including you) MUST re-join with this password — every old session is dead.`);
  }
}

async function cmdInvite() {
  const id = requireId();
  const ttlHours = Number(arg("ttl") ?? 168);
  if (Number.isNaN(ttlHours) || ttlHours <= 0) { console.error("Error: --ttl must be a positive number of hours"); process.exit(1); }
  const { store, bridge } = await govBridge();
  const secret = store.getChannelSecret(id);
  if (!secret) { console.error(`Error: not joined: ${id}`); process.exit(1); }
  const { mintInviteCode } = await import("@share-context-mcp/protocol");
  const channelKey = bridge.channelKey(id);
  const codeId = randomBytes(8).toString("hex");
  const { code } = mintInviteCode(channelKey, codeId, ttlHours * 3_600_000);
  const reg = await relayPostJson(id, "/invite-codes", { codeId, expiresAt: Date.now() + ttlHours * 3_600_000 });
  void reg;
  console.log(`✅ invite code (expires in ${ttlHours}h, single-use):\n${code}`);
  const { encodeBlobEnvelope } = await import("@share-context-mcp/protocol");
  const blob = encodeBlobEnvelope({
    type: "join_invite",
    payload: { relayUrl: relayUrl(), channelId: id, inviteCode: code, admissionMode: "invite" },
    expiresAt: Date.now() + ttlHours * 3_600_000,
    maxUses: 1,
  });
  console.log(`\n  join blob (paste to an agent, or: share-context join --blob "<blob>"):\n${blob}`);
}

async function cmdTokenRefresh() {
  const id = requireId();
  const { bridge } = await govBridge();
  await bridge.refreshToken(id);
  console.log("✅ token refreshed (new token stored locally; the old one is dead)");
}

async function cmdVoteStart() {
  const channelId = arg("channel") ?? requireId();
  const type = arg("type") ?? "kick";
  const target = arg("target");
  if (!target) { console.error("Error: --target required"); process.exit(1); }
  const body: Record<string, unknown> = { type, target };
  const reason = arg("reason");
  if (reason) body.reason = reason;
  if (flag("revoke-invitees")) body.revokeInvitees = true;
  const out = await relayPostJson(channelId, "/votes", body);
  console.log(`✅ vote ${out.voteId} opened (target: ${target}) — closes in 48h or at early resolution`);
}

async function cmdVoteList() {
  const id = requireId();
  const votes = await relayGetJson(id, "/votes");
  console.log(JSON.stringify(votes, null, 2));
}

async function cmdAudit() {
  const id = requireId();
  const log = await relayGetJson(id, "/audit");
  console.log(JSON.stringify(log, null, 2));
}

async function cmdDirectory() {
  const q = process.argv[3] ?? "";
  const res = await fetch(`${relayUrl()}/directory?q=${encodeURIComponent(q)}`);
  console.log(JSON.stringify(await res.json(), null, 2));
}

const command = process.argv[2];
const commands: Record<string, () => Promise<void>> = {
  relay: cmdRelay, server: cmdServer, "create-channel": cmdCreateChannel,
  join: cmdJoin, status: cmdStatus, fetch: cmdFetch,
  "rotate-password": cmdRotatePassword,
  leave: cmdLeave,
  channel: async () => {
    const sub = process.argv[3];
    const map: Record<string, () => Promise<void>> = {
      list: cmdChannelList,
      info: cmdChannelInfo,
      bans: cmdChannelBans,
      unban: cmdChannelUnban,
      "revoke-invite": cmdChannelRevokeInvite,
      "grant-invite": cmdChannelGrantInvite,
      transfer: cmdChannelTransfer,
      dissolve: cmdChannelDissolve,
      "set-admission": cmdChannelSetAdmission,
    };
    const h = map[sub];
    if (!h) { console.error(`Unknown: channel ${sub}`); process.exit(1); }
    await h();
  },
  rotate: cmdRotate,
  "rotate-key": cmdRotateKey,
  invite: cmdInvite,
  token: async () => {
    if (process.argv[3] !== "refresh") { console.error("Unknown: token — use `token refresh <id>`"); process.exit(1); }
    await cmdTokenRefresh();
  },
  vote: async () => {
    const sub = process.argv[3];
    const map: Record<string, () => Promise<void>> = {
      start: cmdVoteStart,
      list: cmdVoteList,
    };
    const h = map[sub];
    if (!h) { console.error(`Unknown: vote ${sub}`); process.exit(1); }
    await h();
  },
  audit: cmdAudit,
  directory: cmdDirectory,
};

if (!command || command === "help" || command === "--help") { cmdHelp(); process.exit(0); }
const handler = commands[command];
if (!handler) { console.error(`Unknown: ${command}`); process.exit(1); }
handler().catch((err) => { console.error(`Error: ${err instanceof Error ? err.message : String(err)}`); process.exit(1); });
