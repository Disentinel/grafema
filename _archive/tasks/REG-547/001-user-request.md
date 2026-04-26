# REG-547: NewExpression classified as CALL instead of CONSTRUCTOR_CALL in GraphBuilder

**Linear:** https://linear.app/grafemadev/issue/REG-547
**Priority:** Urgent
**Labels:** Bug, v0.2
**Date:** 2026-02-21

## Problem

`new X()` expressions are classified as `CALL` nodes with `isNew: true` in metadata instead of `CONSTRUCTOR_CALL` nodes. GraphBuilder already knows it's a constructor call (sets `isNew: true`) but uses the wrong node type.

**Verified in** `packages/core/src/core/buildDependencyGraph.ts`:

```
grafema get <id>
[CALL] Set
  ID: ...->CALL->new:Set#0
  Location: line 69 (consumers = new Set())
  Metadata:
    isNew: true       ← GraphBuilder knows it's new, but type is still CALL
```

We have 1158 `CONSTRUCTOR_CALL` nodes in the graph, so some `new` expressions are classified correctly — the bug is inconsistent: some code paths emit `CONSTRUCTOR_CALL`, others emit `CALL` with `isNew: true`.

## Impact

* `new Set()`, `new Map()` etc. show up as CALL in the VS Code explorer instead of CONSTRUCTOR_CALL
* Queries filtering by `CONSTRUCTOR_CALL` miss these nodes
* Cursor-based node lookup returns CALL "Set" instead of a more semantically correct match
* Inconsistent graph structure makes Datalog rules that distinguish constructors from regular calls unreliable

## Root Cause (preliminary)

Two code paths in GraphBuilder create call-like nodes: one correctly emits `CONSTRUCTOR_CALL`, another emits `CALL` and sets `isNew: true`. The `isNew` flag was likely added as a workaround but the type was never corrected.

## Acceptance Criteria

- [ ] All `new X()` expressions → `CONSTRUCTOR_CALL` node type (no CALL with `isNew: true`)
- [ ] `isNew` metadata field can be removed or kept only for compatibility
- [ ] Existing 1158 `CONSTRUCTOR_CALL` nodes unaffected
- [ ] Test coverage: `new Foo()`, `new Foo<T>()`, `new Foo(args)` all produce CONSTRUCTOR_CALL
- [ ] No regression in existing CONSTRUCTOR_CALL tests
