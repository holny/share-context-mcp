/**
 * Manual handshake probe for the echo server (not part of the product).
 * Spawns the server over stdio via the SDK client, lists tools, calls both.
 * Run: SPIKE_LOG_DIR=/tmp/spike-probe bun run packages/spike/probe.ts
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const transport = new StdioClientTransport({
  command: "bun",
  args: ["run", new URL("./mcp-echo-server.ts", import.meta.url).pathname],
  env: { ...process.env, SPIKE_LOG_DIR: process.env.SPIKE_LOG_DIR ?? "/tmp/spike-probe" },
});
const client = new Client({ name: "spike-probe", version: "0.0.0" });
await client.connect(transport);
console.log("== instructions ==\n" + client.getInstructions());
console.log("== tools ==\n" + JSON.stringify((await client.listTools()).tools.map((t) => t.name)));
console.log(
  "== share_update ==\n" +
    JSON.stringify(
      await client.callTool({
        name: "share_update",
        arguments: { statement: "probe: handshake test", kind: "progress", topic: "probe" },
      }),
    ),
);
console.log("== fetch_updates #1 ==\n" + (await client.callTool({ name: "fetch_updates", arguments: {} })).content[0].text);
console.log("== fetch_updates since=2 ==\n" + (await client.callTool({ name: "fetch_updates", arguments: { since: 2 } })).content[0].text);
await client.close();
