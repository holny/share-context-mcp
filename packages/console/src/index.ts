/**
 * Local management console — lightweight web page on localhost.
 * Shows channels, members, recent messages, and backend health.
 */
import { homedir } from "node:os";
import { join } from "node:path";
import { Store } from "@share-context-mcp/server";
import { RelayBridge } from "@share-context-mcp/server";

export async function startConsole(opts: { port: number }): Promise<void> {
  const dbPath = process.env.SHARE_CONTEXT_DB_PATH
    ?? join(homedir(), ".share-context-mcp", "state.db");
  const store = new Store(dbPath);
  const relayUrl = process.env.SHARE_CONTEXT_RELAY_URL ?? "http://127.0.0.1:8931";
  const backend = new RelayBridge({ baseUrl: relayUrl, store });

  const html = buildConsoleHtml();

  const server = Bun.serve({
    port: opts.port,
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === "/api/channels") {
        const channels = store.listChannels();
        const result = [];
        for (const ch of channels) {
          try {
            const meta = await backend.meta(ch);
            result.push({ channelId: ch, memberName: ch, ...meta });
          } catch { result.push({ channelId: ch, memberName: ch, error: true }); }
        }
        return Response.json(result);
      }
      if (url.pathname === "/api/messages") {
        const ch = url.searchParams.get("channelId") ?? "";
        const r = await backend.poll(ch, 0);
        return Response.json(r.messages);
      }
      return new Response(html, { headers: { "content-type": "text/html; charset=utf-8" } });
    },
  });
  console.error(`console listening on http://localhost:${server.port}`);
}

function buildConsoleHtml(): string {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>share-context console</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: system-ui, -apple-system, sans-serif; background: #0d1117; color: #e6edf3; padding: 2rem; }
  h1 { font-size: 1.4rem; margin-bottom: 0.5rem; }
  .sub { color: #8b949e; margin-bottom: 1.5rem; }
  .card { background: #161b22; border: 1px solid #30363d; border-radius: 8px; padding: 1.2rem; margin-bottom: 1rem; }
  .card h3 { font-size: 0.95rem; margin-bottom: 0.5rem; color: #58a6ff; }
  .badge { display: inline-block; padding: 2px 8px; border-radius: 12px; font-size: 0.75rem; margin-right: 6px; }
  .badge.on { background: #1a7f37; color: #fff; }
  .badge.off { background: #da3633; color: #fff; }
  table { width: 100%; border-collapse: collapse; }
  td, th { padding: 6px 10px; border-bottom: 1px solid #21262d; text-align: left; font-size: 0.85rem; }
  th { color: #8b949e; font-weight: 500; }
  .empty { color: #8b949e; font-style: italic; }
</style>
</head>
<body>
<h1>📡 share-context console</h1>
<p class="sub">Local MCP Server — channel overview</p>
<div id="root"><p class="empty">Loading…</p></div>
<script>
async function refresh() {
  try {
    const [chRes] = await Promise.all([fetch("/api/channels")]);
    const channels = await chRes.json();
    const root = document.getElementById("root");
    if (channels.length === 0) { root.innerHTML = '<p class="empty">No channels joined yet.</p>'; return; }
    let html = "";
    for (const ch of channels) {
      html += '<div class="card"><h3>📡 ' + ch + ' <span class="badge on">online</span></h3>';
      html += '<table><tr><th>Member</th><th>Joined</th></tr>';
      for (const m of (ch.members || [])) html += '<tr><td>' + m.memberName + '</td><td>' + (m.joinedAt || '—') + '</td></tr>';
      html += '</table></div>';
    }
    root.innerHTML = html;
  } catch (e) { document.getElementById("root").innerHTML = '<p style="color:#f85149">Error: ' + e.message + '</p>'; }
}
refresh();
setInterval(refresh, 10000);
</script>
</body>
</html>`;
}
