/**
 * Activity roles daily scan (governance v2 §5): per channel, compute
 * sender/receiver counts from messages sent AFTER the member's joined_at,
 * then assign the activity tier per the spec criteria. Atomic per channel.
 * Permission roles are NOT touched by the scan.
 *
 * Criteria (daily scan, N ≥ 10 active members, T = 7 days):
 *   core         sender top 5% AND ≥5 msgs        (expiry T)
 *   backbone     sender top 5–20% AND ≥5 msgs     (expiry T)
 *   active_core  sender top 20–60% AND ≥5 msgs    (expiry T)
 *   deep_focus   receiver top 20% AND ≥5 msgs     (expiry T)
 *   participant  sender ≥5 msgs                   (expiry 2T)
 *   observer     receiver ≥1 OR sender ≥1         (expiry T)
 *   lurker       default (new / inactive)
 *
 * Blind-relay note: the recipient lives inside the E2E-encrypted envelope,
 * so "receiver count" = channel messages created after the member's
 * joined_at (the volume the member received while in the channel). Receiver
 * ties break alphabetically — documented v1 semantics.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { openDb } from "../src/db";
import { scanActivityRoles } from "../src/activity";

const DAY_MS = 86_400_000;

let dir: string;
let db: ReturnType<typeof openDb>;

/** Insert a channel row directly (relay storage shape, blind fields are dummies). */
function seedChannel(channelId: string): void {
  db.prepare(
    "INSERT INTO channels(id, epoch, next_seq, min_seq, creator_member, manager_member, admission_mode, verify_key, created_at, encrypted, key_version) VALUES (?, 1, 1, 1, ?, ?, 'password', ?, ?, 0, 0)",
  ).run(channelId, "mgr", "mgr", randomBytes(32).toString("base64"), new Date().toISOString());
}

function seedMember(channelId: string, name: string, joinedAt: string): void {
  db.prepare(
    "INSERT INTO members(channel_id, name, token_hash, token_expires_at, epoch, joined_at, last_poll_seq, last_viewed_seq, status, can_invite) VALUES (?, ?, 'h', NULL, 1, ?, 0, 0, 'active', 1)",
  ).run(channelId, name, joinedAt);
}

function seedMessage(channelId: string, seq: number, sender: string | null, _to: string | null, createdAt: string): void {
  // `to` accepted for call-site clarity but unused: the blind relay stores no
  // recipient column (it lives inside the E2E envelope)
  void _to;
  db.prepare(
    "INSERT INTO messages(channel_id, seq, sender, nonce, ciphertext, idem_key, created_at, encrypted, key_version) VALUES (?, ?, ?, 'n', 'c', ?, ?, 0, 0)",
  ).run(channelId, seq, sender, `idem-${seq}`, createdAt);
}

/** N active members joined at T0; one member per name. */
function seedChannelWithMembers(memberCount: number): string {  const channelId = randomBytes(8).toString("hex");
  seedChannel(channelId);
  const t0 = "2026-10-01T00:00:00Z";
  for (let i = 0; i < memberCount; i++) seedMember(channelId, `m${i}`, t0);
  return channelId;
}

function roleOf(channelId: string, name: string): { activity_role: string | null; activity_expires_at: number | null } {
  return db
    .prepare("SELECT activity_role, activity_expires_at FROM members WHERE channel_id = ? AND name = ?")
    .get(channelId, name) as { activity_role: string | null; activity_expires_at: number | null };
}

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "relay-activity-"));
  db = openDb(join(dir, "relay.db"));
});

afterAll(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("activity role scan (§5)", () => {
  test("sender tiers: top 5% core, 5–20% backbone, 20–60% active_core (≥5 msgs, N=12)", () => {
    const ch = seedChannelWithMembers(12);
    // sender counts: m0=20 (rank 1 → top 5% → core), m1=m2=10 (ranks 2-3 →
    // top 20% → backbone), m3..m7=5 (ranks 4-8 → top 60% → active_core),
    // m8..m11=0 (lurker)
    let seq = 1;
    for (let i = 0; i < 20; i++) seedMessage(ch, seq++, "m0", null, "2026-10-20T00:00:00Z");
    for (let i = 0; i < 10; i++) { seedMessage(ch, seq++, "m1", null, "2026-10-20T00:00:00Z"); seedMessage(ch, seq++, "m2", null, "2026-10-20T00:00:00Z"); }
    for (let i = 0; i < 5; i++) for (const m of ["m3", "m4", "m5", "m6", "m7"]) seedMessage(ch, seq++, m, null, "2026-10-20T00:00:00Z");

    scanActivityRoles(db, { now: Date.parse("2026-10-29T00:00:00Z") });

    expect(roleOf(ch, "m0").activity_role).toBe("core");
    expect(roleOf(ch, "m1").activity_role).toBe("backbone");
    expect(roleOf(ch, "m2").activity_role).toBe("backbone");
    for (const m of ["m3", "m4", "m5", "m6", "m7"]) expect(roleOf(ch, m).activity_role).toBe("active_core");
    // m8/m9/m11 sent nothing → observer. m10 also sent nothing but sits in
    // the receiver top-3 (lexicographic ties: m0, m1, m10 — m0/m1 are taken
    // by sender tiers) with ≥5 received → deep_focus.
    expect(roleOf(ch, "m10").activity_role).toBe("deep_focus");
    for (const m of ["m8", "m9", "m11"]) expect(roleOf(ch, m).activity_role).toBe("observer");

    // expiry: T days for core/backbone/active_core (7d from scan time)
    const scanT = Date.parse("2026-10-29T00:00:00Z");
    expect(roleOf(ch, "m0").activity_expires_at).toBe(scanT + 7 * DAY_MS);
    expect(roleOf(ch, "m3").activity_expires_at).toBe(scanT + 7 * DAY_MS);
    // observer tier also expires after T; only lurker has no expiry
    expect(roleOf(ch, "m8").activity_expires_at).toBe(scanT + 7 * DAY_MS);
  });

  test("deep_focus: receiver top 20% with ≥5 received; late joiner gets nothing retroactively", () => {
    const ch = seedChannelWithMembers(12);
    // m11 joins AFTER every message → received 0; the other 11 (joined at
    // T0, before the traffic) each received 7 → receiver top 20% (3 of 12)
    // with ≥5 → deep_focus for the alphabetical tie-break winners
    db.prepare("UPDATE members SET joined_at = ? WHERE channel_id = ? AND name = ?").run(
      "2026-10-25T00:00:00Z", ch, "m11",
    );
    for (let i = 1; i <= 6; i++) seedMessage(ch, i, "m3", null, "2026-10-20T00:00:00Z");
    seedMessage(ch, 7, "m3", null, "2026-10-20T00:00:00Z");

    scanActivityRoles(db, { now: Date.parse("2026-10-29T00:00:00Z") });

    expect(roleOf(ch, "m3").activity_role).toBe("core"); // 7 sends, rank 1
    expect(roleOf(ch, "m0").activity_role).toBe("deep_focus");
    expect(roleOf(ch, "m1").activity_role).toBe("deep_focus");
    expect(roleOf(ch, "m10").activity_role).toBe("deep_focus"); // lexicographic tie-break
    expect(roleOf(ch, "m11").activity_role).toBe("lurker"); // joined after the traffic
  });

  test("participant: ≥5 sent messages outside the sender tiers (expiry 2T)", () => {
    const ch = seedChannelWithMembers(20);
    // N=20: top 5% = 1, top 20% = 4, top 60% = 12. m0..m11 send 6 each →
    // ranks 1-12 (all inside top 60%); m13's 5 sends rank 13 → participant.
    // m12/m14..m19 send nothing → observer (receiver ≥1).
    let seq = 1;
    for (let i = 0; i < 6; i++) for (const m of ["m0", "m1", "m10", "m11", "m2", "m3", "m4", "m5", "m6", "m7", "m8", "m9"]) seedMessage(ch, seq++, m, null, "2026-10-20T00:00:00Z");
    for (let i = 0; i < 5; i++) seedMessage(ch, seq++, "m13", null, "2026-10-20T00:00:00Z");

    scanActivityRoles(db, { now: Date.parse("2026-10-29T00:00:00Z") });

    expect(roleOf(ch, "m0").activity_role).toBe("core");
    for (const m of ["m1", "m10", "m11"]) expect(roleOf(ch, m).activity_role).toBe("backbone");
    for (const m of ["m2", "m3", "m4", "m5", "m6", "m7", "m8", "m9"]) expect(roleOf(ch, m).activity_role).toBe("active_core");
    expect(roleOf(ch, "m13").activity_role).toBe("participant");
    expect(roleOf(ch, "m13").activity_expires_at).toBe(Date.parse("2026-10-29T00:00:00Z") + 14 * DAY_MS);
    // zero-senders: the receiver top-4 is fully absorbed by assigned sender
    // tiers, so they land on observer
    for (const m of ["m12", "m14", "m15", "m16", "m17", "m18", "m19"]) expect(roleOf(ch, m).activity_role).toBe("observer");
  });

  test("messages before joined_at do not count (no retroactive attribution)", () => {
    const ch = seedChannelWithMembers(12);
    // newcomer joins LATE; 8 messages exist BEFORE the join
    db.prepare("UPDATE members SET joined_at = ? WHERE channel_id = ? AND name = ?").run(
      "2026-10-25T00:00:00Z", ch, "m11",
    );
    let seq = 1;
    for (let i = 0; i < 8; i++) seedMessage(ch, seq++, "m11", null, "2026-10-20T00:00:00Z");

    scanActivityRoles(db, { now: Date.parse("2026-10-29T00:00:00Z") });

    // all 8 sends predate the join → lurker, not participant/observer
    expect(roleOf(ch, "m11").activity_role).toBe("lurker");
  });

  test("N < 10: no percentile promotions (everyone stays lurker)", () => {
    const ch = seedChannelWithMembers(5);
    let seq = 1;
    for (let i = 0; i < 9; i++) seedMessage(ch, seq++, "m0", null, "2026-10-20T00:00:00Z");
    scanActivityRoles(db, { now: Date.parse("2026-10-29T00:00:00Z") });
    expect(roleOf(ch, "m0").activity_role).toBe("lurker");
  });

  test("permission roles are untouched by the activity scan", () => {
    const ch = seedChannelWithMembers(12);
    db.prepare("UPDATE members SET permission_role = 'vip' WHERE channel_id = ? AND name = ?").run(ch, "m5");
    let seq = 1;
    for (let i = 0; i < 6; i++) seedMessage(ch, seq++, "m5", null, "2026-10-20T00:00:00Z");
    scanActivityRoles(db, { now: Date.parse("2026-10-29T00:00:00Z") });
    const row = db.prepare("SELECT permission_role, activity_role FROM members WHERE channel_id = ? AND name = ?").get(ch, "m5") as { permission_role: string; activity_role: string };
    expect(row.permission_role).toBe("vip");
  });

  test("rescan rewrites stale tiers (inactive core member demotes to lurker)", () => {
    const ch = seedChannelWithMembers(12);
    let seq = 1;
    for (let i = 0; i < 20; i++) seedMessage(ch, seq++, "m0", null, "2026-10-20T00:00:00Z");
    scanActivityRoles(db, { now: Date.parse("2026-10-29T00:00:00Z") });
    expect(roleOf(ch, "m0").activity_role).toBe("core");

    // simulate expiry + a channel where m0 goes quiet: wipe messages (a new
    // member base takes the tiers) and rescan
    db.prepare("DELETE FROM messages WHERE channel_id = ?").run(ch);
    for (let i = 0; i < 10; i++) seedMessage(ch, seq++, "m1", null, "2026-10-28T00:00:00Z");
    scanActivityRoles(db, { now: Date.parse("2026-10-30T00:00:00Z") });
    expect(roleOf(ch, "m0").activity_role).not.toBe("core"); // demoted
    expect(roleOf(ch, "m1").activity_role).toBe("core");
  });

  test("banned/left members are excluded from tiers and left untouched", () => {
    const ch = seedChannelWithMembers(12);
    db.prepare("UPDATE members SET status = 'banned' WHERE channel_id = ? AND name = ?").run(ch, "m9");
    let seq = 1;
    for (let i = 0; i < 20; i++) seedMessage(ch, seq++, "m9", null, "2026-10-20T00:00:00Z");
    db.prepare("UPDATE members SET activity_role = 'core', activity_expires_at = 9999999999999 WHERE channel_id = ? AND name = ?").run(ch, "m9");
    scanActivityRoles(db, { now: Date.parse("2026-10-29T00:00:00Z") });
    // banned member's old tier is frozen (not rewritten, not counted in N)
    expect(roleOf(ch, "m9").activity_role).toBe("core");
    // m9's sends are invisible to the tiering: active members with zero
    // sends land on deep_focus (receiver volume) or observer
    expect(roleOf(ch, "m0").activity_role).toBe("deep_focus");
  });

  test("v3 probation promotion: trial members past probation_until are promoted to regular; unexpired ones stay", () => {
    const channelId = randomBytes(8).toString("hex");
    seedChannel(channelId);
    seedMember(channelId, "expired", "2026-10-01T00:00:00Z");
    seedMember(channelId, "stillIn", "2026-10-01T00:00:00Z");
    seedMember(channelId, "regular1", "2026-10-01T00:00:00Z");
    db.prepare("UPDATE members SET permission_role = 'trial', probation_until = ? WHERE channel_id = ? AND name = 'expired'").run("2026-10-20T00:00:00Z", channelId);
    db.prepare("UPDATE members SET permission_role = 'trial', probation_until = ? WHERE channel_id = ? AND name = 'stillIn'").run("2099-01-01T00:00:00Z", channelId);
    const now = Date.parse("2026-10-30T12:00:00Z");
    scanActivityRoles(db, { now });
    const row = (name: string) =>
      db.prepare("SELECT permission_role, probation_until FROM members WHERE channel_id = ? AND name = ?").get(channelId, name) as { permission_role: string; probation_until: string | null };
    expect(row("expired").permission_role).toBe("regular");
    expect(row("expired").probation_until).toBeNull();
    expect(row("stillIn").permission_role).toBe("trial");
    expect(row("stillIn").probation_until).not.toBeNull();
    expect(row("regular1").permission_role).toBe("regular");
  });
});
