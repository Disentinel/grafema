## Uncle Bob PREPARE Review: REG-491

**Files to modify:** 4 files, ~15 LOC total change

---

### File 1: `packages/core/src/plugins/analysis/ast/types.ts`

**File size:** 1248 lines — CRITICAL (>700 lines)

However, this is a pure type-definition file. Its length is structural — one interface per exported type — not a sign of mixed responsibilities. It is doing exactly one thing: declaring AST analysis types. Splitting it would create fragmentation without benefit. The file is already at its natural grain size.

**Method to modify:** Adding one field (`parentScopeId?: string`) to `ConstructorCallInfo` interface at lines 332-341.

```ts
// Current (9 lines):
export interface ConstructorCallInfo {
  id: string;
  type: 'CONSTRUCTOR_CALL';
  className: string;
  isBuiltin: boolean;
  file: string;
  line: number;
  column: number;
}
```

Change is a single optional field addition. Zero risk.

**Recommendation:** SKIP refactoring. File is a type registry, not a logic file. Size limit is not applicable here in the spirit it was intended.

**Risk:** LOW

---

### File 2: `packages/core/src/plugins/analysis/ast/handlers/NewExpressionHandler.ts`

**File size:** 159 lines — OK

**Method to modify:** `getHandlers()` — the single `NewExpression` visitor block. The two `push` calls for simple and namespaced constructors (lines 106-115 and 142-153) currently omit `parentScopeId`. The fix adds that field to each push.

The method is ~140 lines (the entire body of `getHandlers()`), which is over the 50-line guideline, but this is a Babel visitor definition — a flat sequence of if/else branches that map one AST node type to one handler. Each branch is short and independent. There is no viable extraction that improves readability here.

**Recommendation:** SKIP refactoring. The handler structure is correct for its domain.

**Risk:** LOW

---

### File 3: `packages/core/src/plugins/analysis/ast/GraphBuilder.ts`

**File size:** 612 lines — over 500, but borderline.

The file has clear structural sections: constructor/buffer plumbing (lines 36-172), the main `build()` orchestrator (lines 177-356), and utility/post-flush methods (lines 358-611). Three distinct concerns, but the boundaries are clean and the utility methods exist only to serve `build()`. A split is defensible but not urgent for this task.

**Method to modify:** Section 4.5 (lines 302-314) — buffering `CONSTRUCTOR_CALL` nodes. Adding one `CONTAINS` edge push after the existing `_bufferNode` call. This is a ~5-line addition in a 12-line section.

```ts
// Current section (12 lines):
for (const constructorCall of constructorCalls) {
  this._bufferNode({
    id: constructorCall.id,
    ...
    column: constructorCall.column
  } as GraphNode);
}
```

The modification adds a `_bufferEdge` call after `_bufferNode`. Clear, local, no ripple.

**Recommendation:** SKIP refactoring for this task. Create tech debt issue for splitting GraphBuilder (>500 lines, 3 concerns).

**Risk:** LOW for the change. Tech debt noted.

---

### File 4: `packages/core/src/plugins/analysis/JSASTAnalyzer.ts`

**File size:** 4110 lines — CRITICAL (>700 lines, far beyond limit).

This is a known pre-existing condition. The file is the monolithic analyzer. Splitting it is out of scope for this task (would exceed 20% time budget immediately) and is tracked separately.

**Method to modify:** `traverse_new` block (lines 1727-1800, ~73 lines). The change is adding a `getFunctionParent()` guard at the top of the `NewExpression` visitor to skip nodes that are inside function bodies (those are handled by `NewExpressionHandler`). This is a ~3-line addition.

The surrounding pattern is consistent — all other module-level traversals (`traverse_assignments` line 1539, `traverse_updates` line 1620, `traverse_callbacks` line 1651, `traverse_ifs` line 1806) already use this exact guard:

```ts
const functionParent = path.getFunctionParent();
if (functionParent) return;
```

The change is mechanical and pattern-consistent.

**Recommendation:** SKIP refactoring (out of scope, pre-existing tech debt). Proceed with the 3-line guard addition.

**Risk:** LOW for the change itself. The 4110-line file is HIGH risk overall but is pre-existing and unrelated to this task's scope.

---

### Summary

| File | Lines | Status | Action |
|------|-------|--------|--------|
| `types.ts` | 1248 | Type-only file, size OK in context | No refactoring |
| `NewExpressionHandler.ts` | 159 | OK | No refactoring |
| `GraphBuilder.ts` | 612 | Borderline, 3 concerns | No refactoring (create tech debt) |
| `JSASTAnalyzer.ts` | 4110 | CRITICAL — pre-existing | No refactoring (pre-existing tech debt) |

**Overall verdict:** All four files are clear for implementation. The change (~15 LOC) is confined, pattern-consistent, and low-risk. No pre-implementation refactoring required.

**Tech debt to create:** GraphBuilder.ts split (>500 lines, 3 responsibilities).
