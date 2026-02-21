# REG-545: CALL nodes not linked to IMPORT nodes via scope resolution

**Source:** Linear REG-545 (Urgent, Bug, v0.2)
**Date:** 2026-02-21

## Problem

When an imported symbol is called, Grafema does not link the CALL node back to the IMPORT node. This makes it impossible to answer "where is this import used?" from the graph.

**Current state (verified against fresh analysis, 2026-02-21):**

* `CALLS` edges: 1162 (CALL → FUNCTION, works for relative imports)
* `HANDLED_BY` edges: **1** (should be hundreds for external imports)
* Direct CALL → IMPORT edges for relative imports: **0**

## Expected Behavior

Given:

```ts
import { resolve } from 'path'
resolve('./foo')
```

The graph should contain an edge linking the CALL node for `resolve(...)` to the IMPORT node for `resolve`.

This enables:
- "Find all usages" starting from an IMPORT node
- Impact analysis from an imported symbol
- Answering "is this import actually used?"

## Root Cause (preliminary)

`ExternalCallResolver` is supposed to create `HANDLED_BY` edges (CALL → IMPORT) for external package imports, but produces nearly zero results (1 edge in the entire grafema codebase).

`FunctionCallResolver` creates `CALLS` (CALL → FUNCTION) for relative imports but does **not** create a CALL → IMPORT edge.

No resolver does scope-chain traversal (shadowing) to match call site names to their import declarations.

## Acceptance Criteria

- [ ] For every CALL node whose callee name resolves to an imported symbol (via scope chain, respecting shadowing), create a `HANDLED_BY` edge: CALL → IMPORT
- [ ] Works for external imports (`import { x } from 'lib'`)
- [ ] Works for relative imports (`import { x } from './utils'`)
- [ ] `ExternalCallResolver` bug investigated and fixed
- [ ] Test coverage: named import called at top level, called inside nested scope, shadowed import not linked
