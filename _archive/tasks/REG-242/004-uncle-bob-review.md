# Uncle Bob Review: query.ts

**File size:** 1042 lines — **OVER THRESHOLD** (500 limit)

## File-level

The file is too large. However:
- Splitting 1042-line query command handler is a significant refactoring task
- It's a central CLI command with many interdependent functions
- Our change touches only `executeRawQuery()` (24 lines) and adds ~40 lines of utility code
- Splitting would risk regressions and exceed 20% task time

**Decision:** Flag as tech debt. Do NOT split in this task. Proceed with minimal changes.

## Method-level: `executeRawQuery()` (lines 1019-1042)

- **24 lines** — well under 50-line limit
- **3 parameters** — within limit
- **Nesting depth:** 2 levels (if/else inside function) — acceptable
- **Naming:** clear and descriptive
- **Recommendation:** SKIP refactoring. Method is clean.

## New code placement

The new utility functions (`extractPredicates`, `extractRuleHeads`, `BUILTIN_PREDICATES`) should be placed near `executeRawQuery()` since they're only used there.

## Risk: LOW

Only display logic changes. No query execution impact.

## Tech Debt

- **query.ts at 1042 lines** → create Linear issue for future split (v0.2 tech debt)
