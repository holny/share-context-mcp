/**
 * Anti-forget tests (task-4 brief Step 1, Review Focus #5): the pure
 * shouldRemind decision and its tool-classification helpers must not
 * misfire on read-only sessions, already-shared turns, or share tools
 * under any of the names they may carry (namespace / channel_ prefixes).
 */
import { describe, expect, test } from "bun:test";
import { isActionTool, isShareTool, renderReminder, shouldRemind } from "../src/anti-forget";

describe("shouldRemind", () => {
  test("false for read-only sessions (no actions)", () => {
    expect(shouldRemind(0, false)).toBe(false);
  });

  test("false when the turn already shared", () => {
    expect(shouldRemind(3, true)).toBe(false);
  });

  test("true when there are write actions and no share", () => {
    expect(shouldRemind(1, false)).toBe(true);
    expect(shouldRemind(5, false)).toBe(true);
  });

  test("never negative-safe: -1 actions treated as none", () => {
    expect(shouldRemind(-1, false)).toBe(false);
  });
});

describe("isActionTool", () => {
  test("counts edit/write/patch as actions", () => {
    for (const tool of ["edit", "write", "patch"]) expect(isActionTool(tool)).toBe(true);
  });

  test("counts shell-family tools as write-ish actions", () => {
    for (const tool of ["bash", "shell"]) expect(isActionTool(tool)).toBe(true);
  });

  test("does not count read-only tools", () => {
    for (const tool of ["read", "grep", "glob", "fetch_messages", "list", "todo"]) {
      expect(isActionTool(tool)).toBe(false);
    }
  });

  test("namespaced tool names still classify", () => {
    expect(isActionTool("mcp__fs__edit")).toBe(true);
    expect(isActionTool("tools/write")).toBe(true);
  });
});

describe("isShareTool", () => {
  test("matches send_message in all its spellings", () => {
    for (const tool of ["send_message", "channel_send_message", "mcp__share-context__send_message", "channel/send_message"]) {
      expect(isShareTool(tool)).toBe(true);
    }
  });

  test("does not match other channel tools or substrings", () => {
    for (const tool of ["fetch_messages", "channel_fetch_messages", "send_messages", "channel_fetch"]) {
      expect(isShareTool(tool)).toBe(false);
    }
  });
});

describe("renderReminder", () => {
  test("mentions send_message and stays gentle (offers the ignore-out)", () => {
    const text = renderReminder();
    expect(text).toContain("send_message");
    expect(text).toContain("忽略");
  });
});
