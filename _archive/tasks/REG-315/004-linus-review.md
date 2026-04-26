# Linus Review: REG-315

## Verdict: APPROVED

---

## Did we do the right thing?

**Yes.** This is exactly what was needed:

1. **Aligns with vision**: Query the graph, not read code. Edge metadata is part of the graph - now agents can query it without hacks.

2. **Follows existing patterns**: `eval_attr_edge` is structurally identical to `eval_attr`. Same binding logic, same value matching (Var/Const/Wildcard), same early returns on missing data. No surprises.

3. **Reuses shared infrastructure**: Uses `crate::datalog::utils::get_metadata_value` - the same helper that `eval_attr` uses. No duplication, consistent behavior for nested paths.

## Is it at the right level of abstraction?

**Yes.** The predicate signature makes sense:

```
attr_edge(Src, Dst, EdgeType, AttrName, Value)
```

All arguments except Value must be bound. This is the correct constraint - we don't want to enumerate all edges looking for metadata. The implementation matches this constraint exactly.

## Any hacks or shortcuts?

**No.** Clean implementation:

- Lines 524-607: ~80 lines of straightforward Rust
- Each step is a simple match/filter
- Early returns on invalid inputs
- No `TODO`, no `unwrap()` on results that could fail, no magic

The edge lookup (line 567-571) filters by edge type first, then finds by dst. This is O(e) where e = outgoing edges of src with specific type. For typical graphs, this is 0-3 edges. Not a performance concern.

## Tests actually test what they claim?

**Yes.** 7 tests covering:

1. `test_eval_attr_edge_basic` - happy path, variable binding
2. `test_eval_attr_edge_nested_path` - nested JSON paths (e.g., "cardinality.scale")
3. `test_eval_attr_edge_constant_match` - matching against constant (both match and no-match)
4. `test_eval_attr_edge_no_metadata` - edge exists but no metadata
5. `test_eval_attr_edge_missing_attr` - metadata exists but attr missing
6. `test_eval_attr_edge_edge_not_found` - edge doesn't exist
7. `test_eval_attr_edge_in_rule` - **integration test**: used in a real Datalog rule with multiple predicates

The rule integration test (lines 1841-1943) is particularly good - it demonstrates real usage:

```prolog
large_iteration(Loop, Var, File) :-
    node(Loop, "LOOP"),
    edge(Loop, Var, "ITERATES_OVER"),
    attr_edge(Loop, Var, "ITERATES_OVER", "scale", "nodes"),
    attr(Loop, "file", File).
```

This verifies that `attr_edge` plays well with variable binding from preceding predicates.

## Complexity check

- Does the solution iterate over ALL edges? **NO** - only outgoing edges from specific src with specific type
- Big-O: **O(e)** where e = outgoing edges of src with matching type (typically 0-3)

## Minor observations (not blocking)

1. The predicate requires all 5 arguments. A 4-argument variant `attr_edge(Src, Dst, EdgeType, AttrName)` that just checks existence could be useful. But that's a separate feature if needed.

2. The docstring (lines 514-523) is good but could mention that nested paths are supported (e.g., "foo.bar"). It says "Supports nested path syntax" but an example would help. Not blocking.

---

## Summary

This is a clean, well-tested addition that follows existing patterns. The implementation is correct, efficient, and aligns with project vision. The tests are comprehensive and include meaningful integration coverage.

**Merge it.**
