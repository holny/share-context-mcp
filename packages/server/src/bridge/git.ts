/**
 * GitBridge — ChannelBackend implementation over a git repository (M3 §3.2).
 *
 * Channel = one git repo (intranet GitLab / GitHub private repo). Messages are
 * per-seq encrypted files; a head.json counter allocates seqs with a
 * pull-rebase-push retry (the git analogue of the relay's conditional write).
 * Auth = repo push access (SSH/HTTPS credentials come from the user's git
 * setup); the channel password is used only for E2E key derivation.
 *
 * Layout inside the remote:
 *   channels/<channelId>/
 *     state/head.json     {"nextSeq": N, "epoch": E}
 *     members.json        [{memberName, joinedAt}]
 *     messages/<epoch>/<seq>-<idemKey8>.enc   {nonce, ciphertext} base64 JSON
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { deriveChannelKey, open as sealOpen, seal, validateClaim, type ClaimMessage } from "@share-context-mcp/protocol";
import type { TransportTuning } from "../transport";
import type { BridgeListener, ClaimInput, ChannelBridge, ChannelMember, ChannelMeta, PollResult } from "./types";

const RETRY_LIMIT = 5;

export interface GitBridgeOptions {
  /** Root that contains one git repo per channel: `<remoteRoot>/<channelId>(.git)`. */
  remoteRoot: string;
  /** Poll (fetch) interval for listen(), ms. Default 15_000. */
  pollIntervalMs?: number;
  /** Where persistent working copies live. Default ~/.share-context-mcp/git-bridge/ */
  workRoot?: string;
}

interface ChannelSecret {
  channelId: string;
  password: string;
  memberName: string;
  epoch: number;
  gitUrl: string;
  /** Retained per spec §5.5: holders of an old password keep reading its epoch. */
  priorPasswords: Array<{ epoch: number; password: string }>;
}

export class GitBridge implements ChannelBridge {
  private readonly secrets = new Map<string, ChannelSecret>();
  private readonly timers = new Map<string, ReturnType<typeof setInterval>>();

  constructor(private readonly opts: GitBridgeOptions) {}

  private workCopy(channelId: string): string {
    return join(this.opts.workRoot ?? join(homedir(), ".share-context-mcp", "git-bridge"), channelId);
  }

  private git(cwd: string, args: string[]): string {
    const res = spawnSync("git", args, { cwd, encoding: "utf8" });
    if (res.status !== 0) throw new Error(`git ${args[0]} failed: ${(res.stderr || res.stdout || "").trim().slice(0, 300)}`);
    return res.stdout;
  }

  private secret(channelId: string): ChannelSecret {
    const s = this.secrets.get(channelId);
    if (!s) throw new Error("unknown channel — create or join first");
    return s;
  }

  private keyFor(s: ChannelSecret, epoch = s.epoch): Uint8Array {
    const pw = epoch === s.epoch ? s.password : (s.priorPasswords.find((p) => p.epoch === epoch)?.password ?? s.password);
    return deriveChannelKey(pw, `${s.channelId}/epoch/${epoch}`);
  }

  /** Write files, commit, push — with pull-rebase-retry on a racing push. */
  private writeAndPush(s: ChannelSecret, files: Array<{ path: string; content: string }>, message: string): void {
    const cwd = this.workCopy(s.channelId);
    for (const f of files) {
      mkdirSync(join(cwd, f.path, ".."), { recursive: true });
      writeFileSync(join(cwd, f.path), f.content);
    }
    this.git(cwd, ["add", "-A"]);
    this.git(cwd, ["commit", "-m", message]);
    for (let attempt = 1; attempt <= RETRY_LIMIT; attempt++) {
      const push = spawnSync("git", ["push", "origin", "main"], { cwd, encoding: "utf8" });
      if (push.status === 0) return;
      // someone pushed first — integrate (head.json may have moved) and retry
      this.git(cwd, ["pull", "--rebase", "--autostash", "origin", "main"]);
    }
    throw new Error(`git push rejected after ${RETRY_LIMIT} attempts — re-send this update`);
  }

  /** Fetch + hard-reset to origin/main; return the latest head.json on the remote. */
  private syncHead(s: ChannelSecret): { nextSeq: number; epoch: number } {
    const cwd = this.workCopy(s.channelId);
    this.git(cwd, ["fetch", "origin"]);
    this.git(cwd, ["reset", "--hard", "origin/main"]);
    const headPath = join(cwd, `channels/${s.channelId}/state/head.json`);
    if (!existsSync(headPath)) return { nextSeq: 1, epoch: 1 };
    return JSON.parse(readFileSync(headPath, "utf8")) as { nextSeq: number; epoch: number };
  }

  async createChannel(opts: { name?: string; memberName: string; gitUrl?: string }): Promise<{ channelId: string; password: string }> {
    if (!opts.gitUrl) throw new Error("GitBridge.createChannel requires gitUrl (the remote repo URL for this channel)");
    void opts.name;
    const channelId = (opts.gitUrl.split("/").pop() || "channel").replace(/\.git$/, "").toLowerCase().replace(/[^a-z0-9_-]/g, "-").slice(0, 40);
    const password = deriveGroupedPassword();
    const cwd = this.workCopy(channelId);
    rmSync(cwd, { recursive: true, force: true });
    mkdirSync(cwd, { recursive: true });
    this.git(cwd, ["init", "-b", "main"]);
    this.git(cwd, ["remote", "add", "origin", opts.gitUrl]);
    const secret: ChannelSecret = { channelId, password, memberName: opts.memberName, epoch: 1, gitUrl: opts.gitUrl, priorPasswords: [] };
    this.secrets.set(channelId, secret);
    const key = this.keyFor(secret);
    this.writeAndPush(
      secret,
      [
        { path: `channels/${channelId}/state/head.json`, content: JSON.stringify({ nextSeq: 1, epoch: 1 }) },
        { path: `channels/${channelId}/members.json`, content: JSON.stringify([{ memberName: opts.memberName, joinedAt: new Date().toISOString() }]) },
        {
          path: `channels/${channelId}/state/origin.enc`,
          content: JSON.stringify(
            seal(
              { seq: null, ts: new Date().toISOString(), statement: `channel created by ${opts.memberName}`, kind: "progress", topic: "meta", provenance: { member: opts.memberName, source: "agent" }, idempotencyKey: "create-" + channelId },
              key,
            ),
          ),
        },
      ],
      `create channel ${channelId}`,
    );
    return { channelId, password };
  }

  async join(channelId: string, password: string, memberName: string, opts?: { gitUrl?: string }): Promise<void> {
    const url = opts?.gitUrl ?? this.secrets.get(channelId)?.gitUrl;
    if (!url) throw new Error("GitBridge.join requires gitUrl for a channel not yet known locally");
    const cwd = this.workCopy(channelId);
    rmSync(cwd, { recursive: true, force: true });
    mkdirSync(cwd, { recursive: true });
    this.git(cwd, ["init", "-b", "main"]);
    this.git(cwd, ["remote", "add", "origin", url]);
    const pull = spawnSync("git", ["pull", "origin", "main"], { cwd, encoding: "utf8" });
    if (pull.status !== 0) throw new Error("join failed: cannot read the channel repo (check gitUrl and git credentials)");
    const secret: ChannelSecret = { channelId, password, memberName, epoch: 1, gitUrl: url, priorPasswords: [] };
    this.secrets.set(channelId, secret);
    const headPath = join(cwd, `channels/${channelId}/state/head.json`);
    if (existsSync(headPath)) secret.epoch = (JSON.parse(readFileSync(headPath, "utf8")) as { epoch: number }).epoch;
    const membersPath = join(cwd, `channels/${channelId}/members.json`);
    const members = existsSync(membersPath) ? (JSON.parse(readFileSync(membersPath, "utf8")) as ChannelMember[]) : [];
    if (!members.some((m) => m.memberName === memberName)) {
      members.push({ memberName, joinedAt: new Date().toISOString() });
      writeFileSync(membersPath, JSON.stringify(members));
      this.git(cwd, ["add", "-A"]);
      this.git(cwd, ["commit", "-m", `join: ${memberName}`]);
      const push = spawnSync("git", ["push", "origin", "main"], { cwd, encoding: "utf8" });
      if (push.status !== 0) throw new Error("join failed: push rejected (no push access to the channel repo)");
    }
  }

  async send(msg: ClaimInput, channelId?: string): Promise<{ seq: number; deduped: boolean }> {
    const s = this.secret(channelId ?? "");
    const checked = validateClaim({ ...msg, provenance: { ...(msg.provenance ?? {}), member: s.memberName, source: "agent" as const } });
    if (!checked.ok) throw new Error(checked.reason);
    const claim = checked.msg;
    for (let attempt = 1; attempt <= RETRY_LIMIT; attempt++) {
      const head = this.syncHead(s);
      const epochDir = `channels/${s.channelId}/messages/epoch-${head.epoch}`;
      const seq = head.nextSeq;
      const key = this.keyFor(s, head.epoch);
      const env = seal(claim, key);
      this.writeAndPush(
        s,
        [
          { path: `${epochDir}/${seq}-${claim.idempotencyKey.slice(0, 8)}.enc`, content: JSON.stringify(env) },
          { path: `channels/${s.channelId}/state/head.json`, content: JSON.stringify({ nextSeq: seq + 1, epoch: head.epoch }) },
        ],
        `send seq ${seq} (${claim.kind})`,
      );
      return { seq, deduped: false };
    }
    throw new Error(`send failed after ${RETRY_LIMIT} attempts — try again`);
  }

  async poll(channelId: string, since: number, _opts?: { markActivity?: boolean }): Promise<PollResult> {
    const s = this.secret(channelId);
    this.syncHead(s);
    const base = join(this.workCopy(channelId), `channels/${channelId}/messages`);
    if (!existsSync(base)) return { messages: [], skipped: 0 };
    const out: ClaimMessage[] = [];
    let skipped = 0;
    // Read every epoch directory this member can decrypt (spec §5.5: old-key
    // holders keep reading their epochs; a fresh joiner only has the current
    // password, so older dirs simply fail to open and count as skipped).
    for (const dir of readdirSync(base).filter((d) => d.startsWith("epoch-")).sort((a, b) => Number(a.slice(6)) - Number(b.slice(6)))) {
      const epoch = Number(dir.slice(6));
      const key = this.keyFor(s, epoch);
      const full = join(base, dir);
      for (const f of readdirSync(full).filter((f) => f.endsWith(".enc")).sort((a, b) => Number(a.split("-")[0]) - Number(b.split("-")[0]))) {
        const seq = Number(f.split("-")[0]);
        if (seq <= since) continue;
        try {
          const msg = sealOpen(JSON.parse(readFileSync(join(full, f), "utf8")), key);
          msg.seq = seq; // the filename carries the seq — the sealed payload has none
          out.push(msg);
        } catch {
          skipped++;
        }
      }
    }
    out.sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0));
    return { messages: out, skipped };
  }

  async meta(channelId: string): Promise<ChannelMeta> {
    const s = this.secret(channelId);
    this.syncHead(s);
    const membersPath = join(this.workCopy(channelId), `channels/${channelId}/members.json`);
    const members = existsSync(membersPath) ? (JSON.parse(readFileSync(membersPath, "utf8")) as ChannelMember[]) : [];
    const high = this.syncHead(s).nextSeq - 1;
    return { members, nextSeq: high + 1 };
  }

  listen(channelId: string, onNotify: (seq: number) => void, tuning?: TransportTuning): BridgeListener {
    const interval = this.opts.pollIntervalMs ?? 15_000;
    const timer = setInterval(() => onNotify(0), interval);
    this.timers.set(channelId, timer);
    return {
      stop: async () => {
        const t = this.timers.get(channelId);
        if (t) clearInterval(t);
        this.timers.delete(channelId);
      },
      markActivity() {},
      get state() { return "poll" as const; },
      closeForTest() {},
    };
  }

  async rotate(channelId: string, newPassword: string): Promise<void> {
    const s = this.secret(channelId);
    s.priorPasswords.push({ epoch: s.epoch, password: s.password });
    s.password = newPassword;
    s.epoch += 1;
    this.writeAndPush(s, [
      { path: `channels/${channelId}/state/head.json`, content: JSON.stringify({ nextSeq: this.syncHead(s).nextSeq, epoch: s.epoch }) },
    ], `rotate to epoch ${s.epoch}`);
  }

  async leave(channelId: string): Promise<void> {
    this.secrets.delete(channelId);
    const t = this.timers.get(channelId);
    if (t) clearInterval(t);
    this.timers.delete(channelId);
    rmSync(this.workCopy(channelId), { recursive: true, force: true });
  }
}

function deriveGroupedPassword(): string {
  const alphabet = "abcdefghjkmnpqrstuvwxyz23456789";
  const bytes = new Uint8Array(20);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => alphabet[b % alphabet.length]).join("").replace(/(.{4})(?=.)/g, "$1-");
}
