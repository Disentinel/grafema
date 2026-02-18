# Don Plan: REG-491 — CONTAINS Edges for CONSTRUCTOR_CALL Nodes

## Problem

CONSTRUCTOR_CALL nodes are created for every `new ClassName()` expression but receive no CONTAINS edge from their parent scope. CALL_SITE and METHOD_CALL nodes both get `SCOPE -> CONTAINS -> node` edges via `parentScopeId`. CONSTRUCTOR_CALL nodes are missing this field entirely, leaving unassigned constructor calls (`throw new Error()`, side-effect-only `new SideEffect()`) floating in the graph with zero connections.

## Root Cause

`ConstructorCallInfo` interface has no `parentScopeId` field, so `NewExpressionHandler` never captures the scope, and `GraphBuilder` step 4.5 never creates the CONTAINS edge. The fix is a 3-point mechanical addition following the established CALL_SITE pattern.

## Scope

~10 LOC implementation, ~50 LOC tests. No architectural decisions. No new abstractions. Follows the existing CALL_SITE CONTAINS pattern exactly.

---

## Change 1 — `types.ts`: Add `parentScopeId` to `ConstructorCallInfo`

**File:** `packages/core/src/plugins/analysis/ast/types.ts`

**Location:** `ConstructorCallInfo` interface (lines 333-341)

**Current:**
```typescript
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

**After:**
```typescript
export interface ConstructorCallInfo {
  id: string;
  type: 'CONSTRUCTOR_CALL';
  className: string;
  isBuiltin: boolean;
  file: string;
  line: number;
  column: number;
  parentScopeId?: string;
}
```

**Why optional:** Consistent with `CallSiteInfo.parentScopeId?: string`. Guards the edge creation safely.

---

## Change 2 — `NewExpressionHandler.ts`: Capture `parentScopeId`

**File:** `packages/core/src/plugins/analysis/ast/handlers/NewExpressionHandler.ts`

**Location:** The `ctx.constructorCalls.push({...})` block (lines 43-51)

**Current:**
```typescript
ctx.constructorCalls.push({
  id: constructorCallId,
  type: 'CONSTRUCTOR_CALL',
  className,
  isBuiltin,
  file: ctx.module.file,
  line,
  column
});
```

**After:**
```typescript
ctx.constructorCalls.push({
  id: constructorCallId,
  type: 'CONSTRUCTOR_CALL',
  className,
  isBuiltin,
  file: ctx.module.file,
  line,
  column,
  parentScopeId: ctx.getCurrentScopeId()
});
```

**Note:** `ctx.getCurrentScopeId()` is already used at lines 112 and 151 in the same handler for CALL_SITE nodes. No new API surface.

---

## Change 3 — `GraphBuilder.ts`: Create CONTAINS edge at step 4.5

**File:** `packages/core/src/plugins/analysis/ast/GraphBuilder.ts`

**Location:** Step 4.5 loop (lines 302-314)

**Current:**
```typescript
// 4.5 Buffer CONSTRUCTOR_CALL nodes
for (const constructorCall of constructorCalls) {
  this._bufferNode({
    id: constructorCall.id,
    type: constructorCall.type,
    name: `new ${constructorCall.className}()`,
    className: constructorCall.className,
    isBuiltin: constructorCall.isBuiltin,
    file: constructorCall.file,
    line: constructorCall.line,
    column: constructorCall.column
  } as GraphNode);
}
```

**After:**
```typescript
// 4.5 Buffer CONSTRUCTOR_CALL nodes
for (const constructorCall of constructorCalls) {
  this._bufferNode({
    id: constructorCall.id,
    type: constructorCall.type,
    name: `new ${constructorCall.className}()`,
    className: constructorCall.className,
    isBuiltin: constructorCall.isBuiltin,
    file: constructorCall.file,
    line: constructorCall.line,
    column: constructorCall.column
  } as GraphNode);

  if (constructorCall.parentScopeId) {
    this._bufferEdge({
      type: 'CONTAINS',
      src: constructorCall.parentScopeId,
      dst: constructorCall.id
    });
  }
}
```

**Pattern source:** `CoreBuilder.ts:134-157` (`bufferCallSiteEdges`) — identical guard and edge structure.

---

## Tests

**File:** `test/unit/ConstructorCallTracking.test.js`

Add a new `describe` block for CONTAINS edges. Test cases:

| Case | Fixture | Assert |
|------|---------|--------|
| Assigned at module level | `const x = new Foo()` (top of file) | MODULE CONTAINS CONSTRUCTOR_CALL |
| Assigned inside function | `function f() { const x = new Foo() }` | FUNCTION CONTAINS CONSTRUCTOR_CALL |
| Thrown (unassigned, no ASSIGNED_FROM) | `throw new Error('msg')` | enclosing scope CONTAINS CONSTRUCTOR_CALL |
| Constructor as argument (unassigned) | `fn(new Foo())` | enclosing scope CONTAINS CONSTRUCTOR_CALL |
| Return constructor (unassigned) | `return new Foo()` inside function | FUNCTION CONTAINS CONSTRUCTOR_CALL |

Each test verifies:
1. The CONTAINS edge exists (`type: 'CONTAINS'`, `src: scopeId`, `dst: constructorCallId`)
2. For cases that also have ASSIGNED_FROM: both edges coexist (regression check)

Fixture strategy: reuse the existing `ConstructorCallTracking.test.js` fixture file or add minimal inline fixtures — match the existing test file's pattern.

---

## No Other Files Touched

- `CoreBuilder.ts` — not needed; CONSTRUCTOR_CALL buffering is in `GraphBuilder.build()` directly, not delegated to `CoreBuilder`
- `AssignmentBuilder.ts` — not needed; ASSIGNED_FROM edges are unrelated and unchanged
- Any other builder or handler — untouched

---

## Execution Order

1. Kent: write failing tests for CONTAINS edges (all 5 cases above)
2. Rob: apply 3 changes (types.ts, NewExpressionHandler.ts, GraphBuilder.ts)
3. Build (`pnpm build`) and run tests (`node --test test/unit/ConstructorCallTracking.test.js`)
4. 4-Review

---

## Acceptance Criteria

- Every `new ClassName()` expression in analyzed JS/TS produces a `SCOPE -> CONTAINS -> CONSTRUCTOR_CALL` edge
- Unassigned constructor calls (`throw new Error()`, `fn(new Foo())`) are anchored to their parent scope via CONTAINS
- Assigned constructor calls retain their existing ASSIGNED_FROM edge in addition to the new CONTAINS edge
- All 5 new test cases pass
- Existing ConstructorCallTracking tests continue to pass (no regressions)
