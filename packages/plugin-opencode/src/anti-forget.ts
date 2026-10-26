/**
 * Anti-forget reminder logic (spec §5.4, Review Focus #5): pure decision +
 * tool classification. The plugin tracks per-session tool activity; at the
 * turn boundary it asks shouldRemind whether a gentle nudge is due.
 *
 * Misfire guards: read-only sessions (no write-ish actions) never remind;
 * turns that already called share_update never remind; share_update is
 * recognized under every name it may carry in opencode (MCP namespace
 * prefixes like "mcp__server__", the "channel_" prefix, path segments).
 */

/** Tools that modify the workspace or run commands. */
const ACTION_TOOLS = new Set(["edit", "write", "patch", "bash", "shell"]);

/** Strip namespace prefixes ("mcp__server__x", "channel/x", "channel_x"). */
export function bareToolName(tool: string): string {
  const last = tool.split(/[/:]/).pop() ?? tool;
  return last.startsWith("channel_") ? last.slice("channel_".length) : last.replace(/.*__/, "");
}

/** True for tools whose execution means "the workspace changed (probably)". */
export function isActionTool(tool: string): boolean {
  return ACTION_TOOLS.has(bareToolName(tool));
}

/** True only for the sharing tool itself — never for other channel tools. */
export function isShareTool(tool: string): boolean {
  return bareToolName(tool) === "share_update";
}

/** The whole decision: remind iff the turn wrote something and shared nothing. */
export function shouldRemind(actions: number, sharedThisTurn: boolean): boolean {
  return actions >= 1 && !sharedThisTurn;
}

/** The gentle one-liner — offers the ignore-out so noisy turns are not nagged. */
export function renderReminder(): string {
  return "💡 小提醒：这一轮你修改了工作区，但还没有调用 share_update。如果其中有 teammates 需要知道的决策、契约变更或踩坑，请花一句话同步到协作通道；若只是琐碎改动，忽略本提示即可。";
}
