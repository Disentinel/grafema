# REG-558: Fix LITERAL nodes showing "(anonymous)" instead of their value as name

**Source:** Linear REG-558
**Priority:** Urgent
**Labels:** Bug, v0.2
**Date:** 2026-02-21

## Goal

LITERAL nodes must use the literal value as their `name`, truncated to 64 characters. Currently all LITERAL nodes show `"(anonymous)"`.

## Expected behavior

| Source | Current name | Expected name |
| -- | -- | -- |
| `'Orchestrator'` | `(anonymous)` | `'Orchestrator'` |
| `false` | `(anonymous)` | `false` |
| `10` | `(anonymous)` | `10` |
| `null` | `(anonymous)` | `null` |
| `'very long string...'` | `(anonymous)` | `'very long str…'` (64 chars max) |

## Fix

In the literal node builder: set `name = String(node.value)` (with quotes for strings), truncate at 64 chars with `…`.

## Acceptance Criteria

- [ ] String literal: name = `'value'` (with quotes), max 64 chars
- [ ] Number literal: name = `"42"`
- [ ] Boolean literal: name = `"true"` / `"false"`
- [ ] Null literal: name = `"null"`
- [ ] Long strings truncated to 64 chars + `…`
- [ ] Unit test covering all cases

## Configuration

Single Agent (Rob Pike) — well-understood bug fix, single file, <50 LOC
