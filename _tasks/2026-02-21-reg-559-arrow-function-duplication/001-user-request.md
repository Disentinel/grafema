# REG-559: Fix anonymous arrow function node duplication

**Date:** 2026-02-21
**Priority:** Urgent
**Labels:** v0.2, Bug

## Goal

Fix duplicate FUNCTION nodes for anonymous arrow functions. `p => p.metadata?.phase === 'DISCOVERY'` appears twice in "Nodes in File" at the same position `L155:43`.

## Symptoms

Panel shows:

```
FUNCTION anonymous[1] L155:43
FUNCTION anonymous[1] L155:43  ← duplicate
```

Explorer for `CALL "this.plugins.some"`:

* `PASSES_ARGUMENT → FUNCTION "anonymous[1]"`
* `DERIVES_FROM → FUNCTION "anonymous[1]"`

Two different edge types pointing to what should be the same node — two separate nodes are created.

## Root Cause

Two code paths both create a FUNCTION node for the same arrow function AST node: one when processing it as a call argument, another when processing it as a derived value.

## Acceptance Criteria

- [ ] Arrow function passed as argument appears exactly once in "Nodes in File"
- [ ] Single FUNCTION node with both `PASSES_ARGUMENT` and `DERIVES_FROM` edges pointing to it
- [ ] Unit test: `arr.map(x => x)` → exactly one FUNCTION node
