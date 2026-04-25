# REG-491: CONSTRUCTOR_CALL nodes disconnected when not assigned to variable

## Problem

638 out of 973 CONSTRUCTOR_CALL nodes (65%) are disconnected from the graph — no edges connect to them.

## Root Cause

CONSTRUCTOR_CALL nodes are created for every `new X()` expression (GraphBuilder step 4.5), but the **only edge** that connects to them is `ASSIGNED_FROM` — created only when the result is assigned to a variable:

```js
// Connected: VARIABLE --ASSIGNED_FROM--> CONSTRUCTOR_CALL
const x = new Error('msg');

// Disconnected: node created, zero edges
throw new Error('msg');        // standalone
someFunc(new Error('msg'));    // argument
return new Error('msg');       // return value
new Map().set('a', 'b');       // chained
```

A separate CALL_SITE node is created for the same `new X()` and gets proper `CALLS` edges, but the CONSTRUCTOR_CALL node floats without anchoring.

## Impact

* 0.9% of total graph nodes are disconnected (638 CONSTRUCTOR_CALL + 3 expected root nodes)
* Data flow tracing through unassigned constructor calls is incomplete
* `throw new Error()` and `return new SomeClass()` patterns invisible to data flow queries

## Proposed Fix

Add `CONTAINS` edge from parent FUNCTION/SCOPE → CONSTRUCTOR_CALL for all constructor calls, not just assigned ones. This mirrors how CALL_SITE nodes are anchored via `parentScopeId`.

## Files

* `packages/core/src/plugins/analysis/ast/GraphBuilder.ts` (step 4.5)
* `packages/core/src/plugins/analysis/ast/handlers/NewExpressionHandler.ts`
* `packages/core/src/plugins/analysis/ast/builders/AssignmentBuilder.ts`

## Context

Discovered during REG-489 investigation. After fixing MODULE node survival (42.9% → 0.9% disconnected), CONSTRUCTOR_CALL became the dominant source of disconnected nodes.
