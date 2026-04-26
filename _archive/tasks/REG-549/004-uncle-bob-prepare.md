# STEP 2.5 — Pre-Implementation Review (Uncle Bob)
**Task:** REG-549
**Reviewer:** Robert C. Martin (Uncle Bob)
**Date:** 2026-02-22

---

## Files Reviewed

### 1. `ImportExportVisitor.ts`
**Path:** `packages/core/src/plugins/analysis/ast/visitors/ImportExportVisitor.ts`
**Line count:** 389 lines — OVER 300. Hard limit exceeded.

**Immediate question:** Does this require a mandatory split?

Only if the methods we are directly modifying are themselves problematic, or if the file's excess meaningfully increases risk of our change. Let me assess the methods we touch:

**Target: the two specifier `map()` loops (lines 285-297 and 308-317)**

These are inside `ExportNamedDeclaration` handler within `getExportHandlers()`. The full `getExportHandlers()` method spans lines 264-380 = **117 lines**. This is the method body as a whole.

However, the two specifier loops themselves are individually compact and unambiguous:
- Loop 1 (lines 285-297): 13 lines — handles `export { foo } from './module'` specifiers
- Loop 2 (lines 308-317): 10 lines — handles `export { foo }` specifiers (no source)

The two loops are nearly identical in structure. That duplication is a real smell, but it exists today and is stable. REG-549 will add a `column` field to each loop's return object — a 1-line addition to each. The duplication is not made worse.

**Interface definitions (`ExportSpecifierInfo`, lines 66-69):** 4 lines. Trivial. No issue.

**Verdict for this file:** The file exceeds 300 lines, but the methods we are directly modifying (the two map loops) are each under 15 lines and pose no structural risk to our change. The larger `getExportHandlers()` method (117 lines) is a legitimate concern but refactoring it is outside REG-549 scope and carries real risk of disturbing existing export handling behavior. **Do not split as part of this task.** File length is a deferred refactor (create a follow-up issue if needed).

---

### 2. `ModuleRuntimeBuilder.ts`
**Path:** `packages/core/src/plugins/analysis/ast/builders/ModuleRuntimeBuilder.ts`
**Line count:** 455 lines — OVER 300. Hard limit exceeded.

**Target: `bufferExportNodes()` (lines 155-236)**

Length: 82 lines. Exceeds the 50-line candidate threshold.

Structural assessment of `bufferExportNodes()`:
- Outer `for` loop iterating over `exports`
- Three `if/else if/else if` branches: `default`, `named`, `all`
- `named` branch has its own sub-branch: `specifiers` vs `name`
- Each branch creates one export node and one CONTAINS edge — identical pattern repeated 4 times

The repetition within each branch is genuine duplication. However:
1. The pattern is completely regular — same two calls (`bufferNode`, `bufferEdge`) with different args
2. REG-549's change to this method is adding a `column` field from the specifier to the `NodeFactory.createExport()` call inside the `specifiers` branch (lines 177-196). That is a 1-field addition to one `createExport()` call.
3. Splitting the method now introduces risk of regression across the `default`, `all`, and `name`-based `named` branches that REG-549 does not touch.

**Verdict for this file:** `bufferExportNodes()` at 82 lines is a legitimate split candidate in isolation, but the specific change REG-549 makes touches only the `specifiers` sub-branch. Splitting carries non-trivial regression risk for a 1-field addition. **Do not refactor. Proceed to implementation.** Log as technical debt.

---

### 3. `ASTWorker.ts`
**Path:** `packages/core/src/core/ASTWorker.ts`
**Line count:** 567 lines — OVER 300. Hard limit exceeded.

**Target: the specifier `forEach` loop (lines 293-308)**

This is inside `ExportNamedDeclaration` handler within `parseModule()`. The specific loop we modify (lines 293-308) is 16 lines. Completely within limits.

The broader `parseModule()` function spanning lines 179-546 is enormous (~368 lines), but REG-549 modifies only the 16-line specifier forEach block inside it. That block is self-contained: it maps export specifiers to `ExportNode.createWithContext()` calls. Our change adds a `source` field propagation — a 1-line addition.

There is no safe way to split `parseModule()` within a 20% time budget without risk of breaking the worker protocol (message passing, collections, scope tracking). This is a large pre-existing structural debt in ASTWorker.

**Verdict for this file:** Target loop is clean and well under 50 lines. The file-level and function-level excess is real tech debt but is far outside REG-549 scope. **Do not refactor. Proceed to implementation.**

---

### 4. `types.ts`
**Path:** `packages/core/src/plugins/analysis/ast/types.ts`
**Line count:** 1294 lines — massively over 300. This is a types-only aggregation file.

**Target: `ExportSpecifier` interface (lines 567-570)**

```typescript
export interface ExportSpecifier {
  local: string;
  exported: string;
}
```

4 lines. REG-549 adds a `source?: string` field to this interface. The change is trivial.

The file size is not a structural problem in the same sense — types files commonly grow large as a central registry. There is no behavior here to split. The interface we modify is a leaf type with no dependencies to untangle.

**Verdict for this file:** Clean. No issues.

---

## Summary

| File | Lines | Target Method/Area | Method Lines | Action |
|------|-------|--------------------|--------------|--------|
| `ImportExportVisitor.ts` | 389 | Two specifier map loops | 13 / 10 | Clean — proceed |
| `ModuleRuntimeBuilder.ts` | 455 | `bufferExportNodes()` | 82 | Over 50-line threshold, but change scope is minimal — proceed, log debt |
| `ASTWorker.ts` | 567 | Specifier forEach loop | 16 | Clean — proceed |
| `types.ts` | 1294 | `ExportSpecifier` interface | 4 | Clean — proceed |

---

## Verdict

**Skip refactoring — proceed to implementation.**

No method we are directly modifying justifies a refactoring investment within this task's scope. `bufferExportNodes()` is the only borderline case (82 lines), but the REG-549 change to it is a single field addition to one code branch. The risk of introducing regressions in the other branches (`default`, `all`, `named`+`name`) during a split exceeds the benefit.

Three files exceed the 300-line hard limit. All three should be tracked as tech debt for dedicated refactoring tasks — not addressed here.

**Recommended follow-up issues (not blocking REG-549):**
- Refactor `ImportExportVisitor.ts`: split `getExportHandlers()` into per-declaration-type handlers
- Refactor `ModuleRuntimeBuilder.ts`: extract `bufferSingleExportNode()` helper to eliminate 4x duplication
- Refactor `ASTWorker.ts`: split `parseModule()` into focused extraction functions
