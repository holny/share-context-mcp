/** Bridge factory tests (M3 Task 3): env-driven selection + per-backend env validation. */
import { afterEach, describe, expect, test } from "bun:test";
import { GitBridge } from "../src/bridge/git";
import { RelayBridge } from "../src/bridge/relay";
import { S3Bridge } from "../src/bridge/s3";
import { createChannelBridge, resolveBridgeKind } from "../src/bridge/factory";
import { Store } from "../src/store";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const storeForTest = () => new Store(join(mkdtempSync(join(tmpdir(), "scm-factory-")), "state.db"));

const ENV_KEYS = ["SHARE_CONTEXT_BRIDGE", "SHARE_CONTEXT_GIT_REMOTE_ROOT", "SHARE_CONTEXT_S3_ENDPOINT", "SHARE_CONTEXT_S3_BUCKET", "SHARE_CONTEXT_S3_AK", "SHARE_CONTEXT_S3_SK"] as const;

afterEach(() => {
  for (const k of ENV_KEYS) delete process.env[k];
});

describe("bridge factory", () => {
  test("default kind = relay", () => {
    expect(resolveBridgeKind()).toBe("relay");
    expect(createChannelBridge({ store: storeForTest() }) instanceof RelayBridge).toBe(true);
  });

  test("git kind requires SHARE_CONTEXT_GIT_REMOTE_ROOT", () => {
    process.env.SHARE_CONTEXT_BRIDGE = "git";
    expect(() => createChannelBridge({ store: storeForTest() })).toThrow("SHARE_CONTEXT_GIT_REMOTE_ROOT");
    process.env.SHARE_CONTEXT_GIT_REMOTE_ROOT = "/tmp/git-root";
    expect(createChannelBridge({ store: storeForTest() }) instanceof GitBridge).toBe(true);
  });

  test("s3 kind requires endpoint/bucket/ak/sk", () => {
    process.env.SHARE_CONTEXT_BRIDGE = "s3";
    expect(() => createChannelBridge({ store: storeForTest() })).toThrow("SHARE_CONTEXT_S3_ENDPOINT");
    process.env.SHARE_CONTEXT_S3_ENDPOINT = "http://127.0.0.1:1";
    process.env.SHARE_CONTEXT_S3_BUCKET = "b";
    process.env.SHARE_CONTEXT_S3_AK = "ak";
    process.env.SHARE_CONTEXT_S3_SK = "sk";
    expect(createChannelBridge({ store: storeForTest() }) instanceof S3Bridge).toBe(true);
  });

  test("invalid kind throws (never silently falls back to relay)", () => {
    process.env.SHARE_CONTEXT_BRIDGE = "carrier-pigeon";
    expect(() => resolveBridgeKind()).toThrow("relay|git|s3");
  });
});
