/**
 * Activity role daily scan (governance v2 §5).
 *
 * Per channel, compute per-member sender/receiver counts from messages sent
 * AFTER the member's joined_at (new members never get retroactive credit),
 * then assign the activity tier per the spec criteria. Each channel runs in
 * one transaction — a crash mid-scan leaves the previous consistent tiering.
 *
 * Criteria (daily scan, N ≥ 10 ACTIVE members, T = 7 days default):
 *   core         sender rank within top 5% AND ≥5 msgs     (expiry T)
 *   backbone     sender rank within top 20% AND ≥5 msgs    (expiry T)
 *   active_core  sender rank within top 60% AND ≥5 msgs    (expiry T)
 *   deep_focus   receiver rank within top 20% AND ≥5 msgs  (expiry T)
 *   participant  ≥5 sent msgs outside the sender tiers     (expiry 2T)
 *   observer     receiver ≥1 OR sender ≥1                  (expiry T)
 *   lurker       default (new / inactive)                  (no expiry)
 *
 * One activity role per member — the highest matching tier wins
 * (core > backbone > active_core > deep_focus > participant > observer).
 * The scan NEVER touches permission roles: activity expiry demotes the
 * activity tier only (§5: "Permission roles are NOT affected").
 */
import type { Database } from "bun:sqlite";

const DEFAULT_T_DAYS = 7;

export interface ActivityScanOptions {
  /** Scan time (epoch ms). Defaults to now — injectable for tests. */
  now?: number;
  /** Tier lifetime T in days (spec default 7; participant gets 2T). */
  tDays?: number;
}

interface MemberCounts {
  name: string;
  sent: number;
  received: number;
}

/**
 * Scan every channel and rewrite activity tiers. Returns the number of
 * channels whose tiers changed. Safe to run concurrently with traffic:
 * single transaction per channel, plain SQL only.
 */
export function scanActivityRoles(db: Database, opts: ActivityScanOptions = {}): number {
  const now = opts.now ?? Date.now();
  const tDays = opts.tDays ?? (Number(process.env.SHARE_CONTEXT_ACTIVITY_T_DAYS) || DEFAULT_T_DAYS);
  const tMs = tDays * 86_400_000;
  const channels = db.prepare("SELECT id FROM channels").all() as Array<{ id: string }>;
  let changedChannels = 0;

  const stmtCounts = db.prepare(`
    SELECT m.name,
           (SELECT COUNT(*) FROM messages msg
             WHERE msg.channel_id = m.channel_id AND msg.sender = m.name
               AND msg.created_at > m.joined_at) AS sent,
           (SELECT COUNT(*) FROM messages msg
             WHERE msg.channel_id = m.channel_id
               AND msg.created_at > m.joined_at) AS received
    FROM members m
    WHERE m.channel_id = ? AND m.status = 'active'
  `);
  const stmtRewrite = db.prepare(
    "UPDATE members SET activity_role = ?, activity_expires_at = ? WHERE channel_id = ? AND name = ?",
  );
  const stmtCurrent = db.prepare(
    "SELECT activity_role, activity_expires_at FROM members WHERE channel_id = ? AND name = ?",
  );

  for (const { id: channelId } of channels) {
    const tx = db.transaction((): boolean => {
      const members = stmtCounts.all(channelId) as MemberCounts[];
      const n = members.length;
      // tier assignment under the same N for everyone in this scan
      const assign = new Map<string, { role: string; expiresAt: number | null }>();
      const setRole = (name: string, role: string, expiresAt: number | null): void => {
        assign.set(name, { role, expiresAt });
      };

      if (n >= 10) {
        const bySent = [...members].sort((a, b) => b.sent - a.sent || a.name.localeCompare(b.name));
        const top5 = Math.max(1, Math.ceil(n * 0.05));
        const top20 = Math.ceil(n * 0.20);
        const top60 = Math.ceil(n * 0.60);
        // sender tiers — highest first so a lower tier never overwrites
        bySent.forEach((m, idx) => {
          if (m.sent < 5) return;
          const rank = idx + 1;
          if (rank <= top5) setRole(m.name, "core", now + tMs);
          else if (rank <= top20) setRole(m.name, "backbone", now + tMs);
          else if (rank <= top60) setRole(m.name, "active_core", now + tMs);
          else setRole(m.name, "participant", now + 2 * tMs);
        });
        // deep_focus — receiver top 20% with ≥5 received; sender tiers win
        const byReceived = [...members].sort((a, b) => b.received - a.received || a.name.localeCompare(b.name));
        const recvTop = Math.max(1, Math.ceil(n * 0.20));
        byReceived.slice(0, recvTop).forEach((m) => {
          if (m.received >= 5 && !assign.has(m.name)) setRole(m.name, "deep_focus", now + tMs);
        });
        // observer — any participation; never overwrites a higher tier
        for (const m of members) {
          if (!assign.has(m.name) && (m.sent >= 1 || m.received >= 1)) setRole(m.name, "observer", now + tMs);
        }
      }

      // lurker default for everyone else (and for small channels entirely)
      for (const m of members) {
        if (!assign.has(m.name)) setRole(m.name, "lurker", null);
      }

      // apply — only when something actually changed (keeps quiet channels cheap)
      let changed = false;
      for (const [name, { role, expiresAt }] of assign) {
        const cur = stmtCurrent.get(channelId, name) as { activity_role: string | null; activity_expires_at: number | null } | undefined;
        if (cur?.activity_role !== role || cur?.activity_expires_at !== expiresAt) {
          stmtRewrite.run(role, expiresAt, channelId, name);
          changed = true;
        }
      }
      return changed;
    });
    if (tx()) changedChannels++;
  }
  return changedChannels;
}
