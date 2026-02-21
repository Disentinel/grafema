---
name: grafema-scope-visitor-ordering
description: |
  Correct ordering for Grafema BranchHandler/LoopHandler enter/exit visitors when
  adding new scope types (e.g., switch/case, with-statement, labeled blocks).
  Use when: (1) adding a new ScopeType to Grafema's AST analysis, (2) implementing
  a new enter/exit visitor that creates SCOPE nodes, (3) semantic IDs for SCOPE nodes
  seem wrong (contain their own scope in their path), (4) nodes inside a new scope
  type have incorrect parent context. Root cause: enterCountedScope must come LAST
  in enter (after generateSemanticId and push), matching LoopHandler pattern exactly.
author: Claude Code
version: 1.0.0
date: 2026-02-21
---

# Grafema Scope Visitor Ordering

## Problem

When adding a new scope type to Grafema's `BranchHandler` (or any handler that creates
SCOPE nodes via `enter`/`exit` visitors), it's easy to call `enterCountedScope` in the
wrong order. The result: the SCOPE node's own semantic ID contains its own scope in the
path (e.g., `getCategory->case#0:switch-case[0]` instead of `getCategory:switch-case[0]`).

This happened in REG-536 when implementing `SwitchCase` enter/exit visitors — even the
plan reviewer (Dijkstra) recommended the wrong order ("enter scope BEFORE generating ID").

## Context / Trigger Conditions

- Implementing a new `enter`/`exit` Babel visitor in `BranchHandler.ts` or `LoopHandler.ts`
- The visitor creates a SCOPE node (pushed to `ctx.scopes`) and manages `ctx.scopeIdStack`
- Semantic IDs for the new SCOPE nodes contain the scope type in their parent path
  (e.g., `funcName->case#0:switch-case[0]` instead of `funcName:switch-case[0]`)
- Nodes *inside* the scope have correct IDs, but the SCOPE node itself looks wrong
- After running `UPDATE_SNAPSHOTS=true`, snapshot semantic IDs look unexpected

## Solution

**The correct ordering in `enter`:**

```typescript
enter: (path) => {
  // STEP 1: Generate SCOPE's semantic ID in PARENT context (before entering)
  const semanticId = analyzer.generateSemanticId(scopeType, ctx.scopeTracker);

  // STEP 2: Create and buffer the SCOPE node
  const scopeId = `SCOPE#${scopeType}#${ctx.module.file}#${getLine(node)}:${ctx.scopeCounterRef.value++}`;
  ctx.scopes.push({ id: scopeId, semanticId, scopeType, file, line, parentScopeId: parentId });

  // STEP 3: Push onto stack (so children reference this scope for CONTAINS edges)
  ctx.scopeIdStack.push(scopeId);

  // STEP 4: Enter child scope (so children's semantic IDs use child context) — LAST
  if (ctx.scopeTracker) {
    ctx.scopeTracker.enterCountedScope(scopeLabel);
  }
},
exit: (path) => {
  // STEP 1: Pop stack
  ctx.scopeIdStack.pop();

  // STEP 2: Exit scope tracker
  if (ctx.scopeTracker) {
    ctx.scopeTracker.exitScope();
  }
}
```

**The wrong ordering (common mistake):**

```typescript
// ❌ WRONG: enterCountedScope BEFORE generateSemanticId
if (ctx.scopeTracker) {
  ctx.scopeTracker.enterCountedScope(scopeLabel);  // Now in child context!
}
const semanticId = analyzer.generateSemanticId(scopeType, ctx.scopeTracker);  // Wrong context!
ctx.scopeIdStack.push(scopeId);
```

**Why it matters:**
- `generateSemanticId` reads `scopeTracker.getScopePath()` — the CURRENT context
- If `enterCountedScope` was called first, the SCOPE's ID is generated from inside
  its own scope, embedding its own type in the parent path
- Children need `enterCountedScope` called first — but the SCOPE node itself should
  reflect WHERE IT WAS DECLARED (parent context), not what it contains

**Verify by checking LoopHandler.ts:**
```bash
grep -n "enterCountedScope\|generateSemanticId\|scopeIdStack.push" \
  packages/core/src/plugins/analysis/ast/handlers/LoopHandler.ts
```
Expected output order: `generateSemanticId` (line N) → `push` (line N+14) → `enterCountedScope` (line N+19)

## The switchCaseScopeMap Pattern

When a visitor fires for child nodes (`SwitchCase`) but the parent data (`CASE` node ids)
was created in the parent handler (`SwitchStatement`), use a Map in `FunctionBodyContext`:

```typescript
// In FunctionBodyContext.ts interface:
switchCaseScopeMap: Map<t.SwitchCase, string>;  // AST node → caseId

// In createFunctionBodyContext factory:
switchCaseScopeMap: new Map(),

// In handleSwitchStatement — populate for non-empty cases only:
if (caseNode.consequent.length > 0) {
  ctx.switchCaseScopeMap.set(caseNodePath.node, caseInfo.id);
}

// In SwitchCase.enter — look up and create SCOPE with parentScopeId = caseId:
const caseId = ctx.switchCaseScopeMap.get(casePath.node);
if (!caseId) return;  // empty fall-through case — skip SCOPE creation
// ... create SCOPE with parentScopeId: caseId
// CoreBuilder.bufferScopeEdges creates CASE → CONTAINS → SCOPE automatically
```

**Skip SCOPE for empty fall-through cases** (`consequent.length === 0`) — no body = no nodes = no connectivity issue.

**Clean up the map in exit:**
```typescript
ctx.switchCaseScopeMap.delete(casePath.node);
```

## Snapshot Update

After adding a new scope type, semantic IDs for nodes inside the new scope change.
Update snapshots with the RFDB server running:

```bash
UPDATE_SNAPSHOTS=true node --test test/unit/GraphSnapshot.test.js
```

The RFDB binary is at: `packages/rfdb-server/target/release/rfdb-server`

Then verify without update flag:
```bash
node --test test/unit/GraphSnapshot.test.js
```

## Verification

Correct SCOPE semantic IDs follow this pattern (same as loop body SCOPEs):
- At function body level: `functionName:switch-case[0]` (no `->case#0` in path)
- Nested in outer scope: `functionName->for#0:switch-case[0]` (outer scope in path)

The SCOPE's semantic ID should reflect the PARENT context, not contain its own scope type
in the intermediate path.

Also run connectivity tests to confirm zero disconnected nodes:
```bash
node --import tsx --test test/unit/plugins/analysis/ast/switch-case-connectivity.test.ts
```

## Notes

- This pattern applies to ALL scope-creating visitors: LoopHandler, TryCatchHandler,
  BranchHandler (if/else, switch/case). They all follow the same enter ordering.
- The `ifElseScopeMap` and `tryScopeMap` in `FunctionBodyContext` follow the same
  `switchCaseScopeMap` pattern — study those for reference implementations.
- `ctx.parentScopeId` is the INITIAL function body scope (static). Always use
  `ctx.getCurrentScopeId()` when creating nodes to get the DYNAMIC current top of stack.
  This matters when a scope is nested inside loops/try/if.
