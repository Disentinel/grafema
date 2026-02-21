# REG-548: Fix EXPRESSION nodes using absolute file offset as column number

**Source:** Linear REG-548
**Date:** 2026-02-21
**Priority:** Urgent
**Labels:** Bug, v0.2

## Goal

Fix incorrect column numbers on EXPRESSION nodes. Currently `node.start` (absolute byte offset from start of file) is stored as `column` instead of `node.loc.start.column` (column within the line).

## Symptoms

* `EXPRESSION meta.dependencies L86:3000` — column 3000 is the byte offset
* `EXPRESSION <LogicalExpression> L156:6585` — same issue
* `EXPRESSION <BinaryExpression> L156:6608` — same issue
* Correct values should be ~8–50 range for typical code

## Root Cause

Somewhere in the expression visitor/builder, `node.start` is used instead of `getColumn(node)` (which uses `node.loc.start.column`).

## Acceptance Criteria

- [ ] All EXPRESSION nodes have `column = loc.start.column` (0-indexed, within the line)
- [ ] Column values are in expected range (0–300 for typical source files)
- [ ] Unit test: EXPRESSION node at known position has correct column
