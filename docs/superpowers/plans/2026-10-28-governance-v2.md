# Governance v2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans.

**Goal:** Consolidate MCP tools 11→7, user/consumer formal model, encrypted toggle, join blob, activity roles.

**Spec:** docs/superpowers/specs/2026-10-28-governance-v2-design.md

**Prerequisite:** Governance foundation already on main (T1–T9 prior plan).

## T1: Tool consolidation (11 → 7)
Rename + merge tools. Update tests, instructions.

## T2: User/Consumer model
users + consumers tables, token bound to user.

## T3: Encrypted toggle
encrypted boolean + key_version, keyring, encryptedCount display.

## T4: Join blob
encodeJoinBlob/parseJoinBlob, join_from_blob tool, CLI --blob.

## T5: Activity role daily scan
Daily cron, activity role assignment.

## T6: Remaining fixes
Leftover OCR items.

## T7: Docs + e2e
README, instructions, governance e2e.

## Execution: Native (inline)
