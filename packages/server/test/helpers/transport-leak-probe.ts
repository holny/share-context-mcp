/**
 * Timer-leak probe for ChannelTransport.stop() (task-2, run as a SUBPROCESS
 * by transport.test.ts). A leaked timer keeps a plain `bun` process alive,
 * so the parent asserts this process exits 0 on its own.
 *
 * 40 listen/stop cycles in mixed phases — stop while connecting, stop after
 * the WS is up, stop from a timer mid-connect — then a quiet tail. No
 * process.exit(): the event loop must drain by itself.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startRelay } from "@share-context-mcp/relay";
import { RelayMailbox } from "../../src/mailbox/relay";
import { Store } from "../../src/store";

const dir = mkdtempSync(join(tmpdir(), "scm-leak-probe-"));
const relay = await startRelay({ port: 0, dbPath: join(dir, "relay.db"), pingIntervalMs: 50 });
const store = new Store(join(dir, "state.db"));
const mailbox = new RelayMailbox({ baseUrl: `http://127.0.0.1:${relay.port}`, store });
const { channelId } = await mailbox.createChannel({ memberName: "leak" });

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

for (let i = 0; i < 40; i++) {
  const l = mailbox.listen(channelId, () => {}, {
    wsDeathTimeoutMs: 100,
    probeIntervalMs: 50,
    pollActiveMs: 20,
    pollIdleMs: 20,
  });
  if (i % 3 === 0) {
    await l.stop(); // stop immediately — mid-connect
  } else if (i % 3 === 1) {
    const t0 = Date.now();
    while (l.state !== "ws" && Date.now() - t0 < 2000) await sleep(5);
    await l.stop(); // stop after the WS is established
  } else {
    setTimeout(() => void l.stop(), 30); // stop from a timer while connecting/polling
  }
}

await sleep(200); // quiet tail: stopped transports must not schedule anything
relay.stop();
store.close();
rmSync(dir, { recursive: true, force: true });
// no explicit exit — a leaked timer would hang the process here
