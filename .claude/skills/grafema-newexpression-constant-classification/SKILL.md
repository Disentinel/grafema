---
name: grafema-newexpression-constant-classification
description: |
  Debug missing VARIABLE nodes for `const x = new X()` variables in Grafema graph.
  Use when: (1) variables initialized with `new X()` don't appear when querying
  nodeType:'VARIABLE', (2) resolveVariableInScope returns null for `const db = new Database()`,
  (3) enrichers like ValueDomainAnalyzer or AliasTracker silently skip class instance
  variables, (4) VS Code click on `const x = new Foo()` falls through to CALL node.
  Root cause: `shouldBeConstant` condition in both VariableVisitor.ts and
  JSASTAnalyzer.ts incorrectly included `isNewExpression`, creating CONSTANT nodes.
  Solution: remove `|| isNewExpression` from shouldBeConstant in BOTH dual collection paths.
author: Claude Code
version: 1.0.0
date: 2026-02-21
---

# Grafema NewExpression CONSTANT/VARIABLE Classification

## Problem

`const x = new Foo()` creates a **CONSTANT** node instead of a **VARIABLE** node.
All enrichers (`ValueDomainAnalyzer`, `AliasTracker`) and VS Code trace engine query
`nodeType: 'VARIABLE'` — they silently miss everything initialized with `new`.

## Context / Trigger Conditions

- `resolveVariableInScope` returns null for a variable you can see exists
- VS Code: clicking on `const db = new Database()` falls through to the CONSTRUCTOR_CALL node
- Blast radius / data flow analysis doesn't include class instance variables
- `queryNodes({ nodeType: 'VARIABLE' })` returns fewer nodes than expected
- Any `const x = new X()` or `const x = new X<T>()` that should be a VARIABLE

## Root Cause

`VariableVisitor.ts` (line ~253) and `JSASTAnalyzer.ts:handleVariableDeclaration` (line ~2084)
both contain:

```ts
const shouldBeConstant = isConst && (isLoopVariable || isLiteral || isNewExpression);
//                                                                   ^^^^^^^^^^^^^^^
//                                                         This is wrong — remove it
```

CONSTANT is semantically correct only for:
- **Literals**: `const PORT = 3000`, `const BATCH = []` — fixed values
- **Loop variables**: `for (const key in obj)` — scoping construct

`new X()` produces a class instance (mutable object). Even though the binding is `const`
(can't be reassigned), the value is a runtime-created object — it must be VARIABLE so
enrichers can track it.

## Solution

Remove `|| isNewExpression` from `shouldBeConstant` in **both** dual collection paths:

### Path 1 — Module-level (`VariableVisitor.ts`)

```ts
// BEFORE:
const shouldBeConstant = isConst && (isLoopVariable || isLiteral || isNewExpression);

// AFTER:
const shouldBeConstant = isConst && (isLoopVariable || isLiteral);
```

**Also move** the `classInstantiations.push()` block from inside the
`if (shouldBeConstant)` guard to AFTER the if/else block, so INSTANCE_OF edges
are still created for all NewExpression (const and let):

```ts
if (shouldBeConstant) {
  // CONSTANT node for literals / loop vars
} else {
  // VARIABLE node — now includes const x = new X()
}

// After if/else — fires for any NewExpression regardless of node type:
if (isNewExpression) {
  const newExpr = declarator.init as NewExpression;
  if (newExpr.callee.type === 'Identifier') {
    classInstantiations.push({ variableId: varId, ... });
  }
}
```

### Path 2 — In-function (`JSASTAnalyzer.ts:handleVariableDeclaration`)

Same change — identical `shouldBeConstant` line and same `classInstantiations.push()`
relocation. Uses Babel type guards (`t.isNewExpression`, `t.isIdentifier`) but same logic.

## Side Effects of the Fix

1. **`let x = new Foo()`** — Was already VARIABLE, but was NOT getting INSTANCE_OF edges
   (classInstantiations.push was inside the shouldBeConstant guard which never fired for let).
   After the fix, `let x = new Foo()` ALSO gets INSTANCE_OF edges — new correct behavior.

2. **TypeScript generics** — `new Map<string, Set<string>>()` — Babel puts type params
   in `typeParameters`, callee is still `Identifier('Map')`. No special handling needed.

3. **Member expression callees** — `new ns.Foo()`, `new this.factory()` — callee is
   MemberExpression, NOT Identifier. `classInstantiations.push()` will NOT fire for these
   (intentional). The VARIABLE node is still created correctly. INSTANCE_OF edges for
   namespaced constructors are a pre-existing gap.

## Snapshot Impact Warning

When making this fix, **do NOT manually predict which snapshot nodes change**.
The actual count of affected nodes is always higher than expected — Don predicted 2 in
REG-546 but the real count was ~10. Instead:

1. Implement the fix
2. `pnpm build`
3. Run `UPDATE_SNAPSHOTS=true node --test 'test/unit/snapshot*.test.js'` (or equivalent)
4. All CONSTANT→VARIABLE flips are generated automatically

Nodes that will flip:
- All `const x = new SomeClass()` at module level (VariableVisitor path)
- All `const x = new SomeClass()` inside function bodies (JSASTAnalyzer path)
- `const x = new this.factory()` also flips (isNewExpression true, even though callee is ThisExpression)

Nodes that stay CONSTANT:
- `const PORT = 3000` (literal)
- `const BATCH = []` (literal — isLiteral fires before isNewExpression)
- `for (const key in obj)` (loop variable)

## Verification

```bash
# After fix:
pnpm build
node --test test/unit/DataFlowTracking.test.js

# The test 'should track new Class() assignment' must now assert:
# helper.type === 'VARIABLE'  (not CONSTANT)
```

Check that:
- `const x = new Foo()` node has `type: 'VARIABLE'`
- ASSIGNED_FROM edge: `x` → CONSTRUCTOR_CALL for Foo still exists
- INSTANCE_OF edge: still created (via classInstantiations.push outside guard)

## Notes

- This was fixed in REG-546. REG-534 had a similar fix (expanded expression type coverage
  in trackVariableAssignment) but missed the NewExpression case.
- The dual collection path trap is documented in MEMORY.md. Both VariableVisitor.ts
  (module-level) and JSASTAnalyzer.ts:handleVariableDeclaration (in-function) must ALWAYS
  be updated together when changing variable classification logic.
- Enrichers only query `nodeType: 'VARIABLE'`. CONSTANT nodes are permanently invisible
  to data flow analysis. Any future classification of dynamic values as CONSTANT is a bug.
