# REG-315: Datalog: add attr_edge() predicate for edge metadata queries

## Problem

Currently Datalog can only query node attributes via `attr(NodeId, AttrName, Value)`. There's no way to query **edge metadata**.

REG-314 Phase 2 stores cardinality information on ITERATES_OVER edges:

```json
{ "iterates": "values", "cardinality": { "scale": "nodes", "confidence": "declared" } }
```

To write guarantee rules that check cardinality, we need to query edge metadata.

## Proposed Solution

Add `attr_edge(Src, Dst, EdgeType, AttrName, Value)` predicate:

```datalog
% Find loops iterating over large collections
large_iteration(Loop, Var, File, Line) :-
    node(Loop, "LOOP"),
    edge(Loop, Var, "ITERATES_OVER"),
    attr_edge(Loop, Var, "ITERATES_OVER", "cardinality.scale", Scale),
    (Scale = "nodes" ; Scale = "unbounded"),
    attr(Loop, "file", File),
    attr(Loop, "line", Line).
```

## Technical Details

File: `packages/rfdb-server/src/datalog/eval.rs`

Similar to `eval_attr()`, implement `eval_attr_edge()`:

1. Look up edge by (src, dst, type)
2. Parse edge metadata JSON
3. Use `get_metadata_value()` helper from REG-313 for nested paths

## Acceptance Criteria

- [ ] `attr_edge(Src, Dst, Type, AttrName, Value)` predicate works
- [ ] Supports nested paths like `"cardinality.scale"` (uses REG-313 helper)
- [ ] Tests for edge metadata queries
- [ ] Works with ITERATES_OVER edges from CardinalityEnricher

## Dependencies

* REG-313 (nested paths in attr) - Done
* REG-314 Phase 2 (CardinalityEnricher) - Done

## Blocks

* REG-314 Phase 3 (Standard Datalog rules library)
