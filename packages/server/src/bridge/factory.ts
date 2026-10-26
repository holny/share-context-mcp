/**
 * Bridge factory (M3 §3.4): pick the ChannelBackend implementation from the
 * SHARE_CONTEXT_BRIDGE env (default "relay") plus per-backend env config.
 *
 *   relay (default) — SHARE_CONTEXT_RELAY_URL
 *   git             — SHARE_CONTEXT_GIT_REMOTE_ROOT (root that contains one
 *                     repo per channel: <root>/<channelId>)
 *   s3              — SHARE_CONTEXT_S3_ENDPOINT / _BUCKET / _REGION / _AK / _SK
 *                     (+ optional SHARE_CONTEXT_S3_PREFIX)
 */
import { homedir } from "node:os";
import { join } from "node:path";
import { GitBridge } from "./git";
import { RelayBridge } from "./relay";
import { S3Bridge } from "./s3";
import type { ChannelBridge } from "./types";

export type BridgeKind = "relay" | "git" | "s3";

export function resolveBridgeKind(): BridgeKind {
  const raw = (process.env.SHARE_CONTEXT_BRIDGE ?? "relay").toLowerCase();
  if (raw === "relay" || raw === "git" || raw === "s3") return raw;
  throw new Error(`SHARE_CONTEXT_BRIDGE must be relay|git|s3 (got: ${raw})`);
}

export interface BridgeFactoryDeps {
  kind?: BridgeKind;
  /** Fallback S3 connection when env vars are absent (tests / explicit config). */
  s3?: { endpoint: string; bucket: string; region: string; accessKeyId: string; secretAccessKey: string; prefix?: string };
}

export function createChannelBridge(deps: BridgeFactoryDeps & { store: Store } = { store: undefined as unknown as Store }): ChannelBridge {
  const kind = deps.kind ?? resolveBridgeKind();
  const env = process.env;
  if (kind === "git") {
    const remoteRoot = env.SHARE_CONTEXT_GIT_REMOTE_ROOT;
    if (!remoteRoot) throw new Error("SHARE_CONTEXT_BRIDGE=git requires SHARE_CONTEXT_GIT_REMOTE_ROOT");
    return new GitBridge({ remoteRoot });
  }
  if (kind === "s3") {
    const endpoint = env.SHARE_CONTEXT_S3_ENDPOINT;
    const bucket = env.SHARE_CONTEXT_S3_BUCKET;
    const region = env.SHARE_CONTEXT_S3_REGION ?? "us-east-1";
    const accessKeyId = env.SHARE_CONTEXT_S3_AK;
    const secretAccessKey = env.SHARE_CONTEXT_S3_SK;
    if (!endpoint || !bucket || !accessKeyId || !secretAccessKey) {
      throw new Error("SHARE_CONTEXT_BRIDGE=s3 requires SHARE_CONTEXT_S3_ENDPOINT/_BUCKET/_REGION/_AK/_SK");
    }
    return new S3Bridge({ endpoint, bucket, region, accessKeyId, secretAccessKey, prefix: env.SHARE_CONTEXT_S3_PREFIX });
  }
  const relayUrl = env.SHARE_CONTEXT_RELAY_URL ?? "http://127.0.0.1:8931";
  return new RelayBridge({ baseUrl: relayUrl, store: deps.store });
}

/** Absolute default db path, per project (derived from cwd basename + hash). */
export function defaultDbPath(cwd: string): string {
  const slug = (cwd.split("/").pop() || "project").toLowerCase().replace(/[^a-z0-9_-]/g, "-").slice(0, 32) || "project";
  const hash = createHash("sha256").update(cwd).digest("hex").slice(0, 8);
  return join(homedir(), ".share-context-mcp", "projects", `${slug}-${hash}.db`);
}

import { createHash } from "node:crypto";
import { Store } from "../store";
