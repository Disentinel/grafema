## Uncle Bob PREPARE Review — REG-545

---

## FunctionCallResolver.ts

**File size:** 461 lines — BORDERLINE (39 lines from 500-limit; planned changes will push it over)
**Methods to modify:**
- `execute()` — lines 69–314, ~246 lines
- `metadata` getter — lines 55–67, 13 lines

**File-level:**
- Well-organized, SRP respected. One class, one concern.
- At 461 lines, planned additions (~30–40 lines) will push file to ~491–501 lines — at or over hard limit.

**Method-level: execute()**
- Current: 246 lines. Nearly 5× the 50-line threshold.
- Five distinct index-building phases inside execute(), each a natural extraction candidate:
  1. Build import index (~14 lines)
  2. Build function index (~12 lines)
  3. Build export index (~15 lines)
  4. Build known-files set (inline)
  5. Resolution loop (remains in execute())
- Planned additions: shadow index build (~15 lines) + two HANDLED_BY blocks → execute() will reach ~280 lines.

**Recommendation: REFACTOR execute() BEFORE implementation**

Extract index builders into private methods:
- `buildImportIndex()` — ~14 lines
- `buildFunctionIndex()` — ~12 lines
- `buildExportIndex()` — ~15 lines
- `buildShadowIndex()` — new addition, ~15 lines

execute() drops from 246 to ~180 lines. File stays under 500 limit.
Pattern is consistent with clean coordinator style. Low-risk: each builder is pure, no shared mutable state.

**Risk:** LOW
**Estimated scope:** ~20 lines relocated + 4 private method signatures

---

## builtinPlugins.ts

**File size:** 106 lines — OK
**Change:** 1 import line + 1 registry entry line, following established pattern.

**Recommendation: SKIP** — No structural issues.

**Risk:** LOW

---

## createTestOrchestrator.js

**File size:** 88 lines — OK
**Change:** 2 import lines + 2 `plugins.push()` lines. Perfectly idiomatic.

**Recommendation: SKIP** — No structural issues.

**Risk:** LOW

---

## Summary

| File | Lines | Status | Action |
|------|-------|--------|--------|
| FunctionCallResolver.ts | 461 | BORDERLINE | REFACTOR execute() first |
| builtinPlugins.ts | 106 | OK | SKIP |
| createTestOrchestrator.js | 88 | OK | SKIP |

**Required before implementation:** Extract 4 index-building blocks from `execute()` into private methods. Keeps file under 500 lines and makes `buildShadowIndex()` a natural addition.
