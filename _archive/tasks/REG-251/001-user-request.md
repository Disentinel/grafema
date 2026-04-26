# REG-251: Datalog edge() predicate returns no results

## Problem

The Datalog `edge()` predicate returns no results even when edges exist in the graph.

## Observed Behavior

Query:

```datalog
edge(X, Y, "INTERACTS_WITH")
```

**Result:** No results returned

**Graph state:** 24,937 total edges in the graph

The edge() predicate appears completely non-functional.

## Expected Behavior

`edge(Source, Target, Type)` should return all edges matching the specified type, or all edges if type is a variable.

## Impact

Without working edge queries, users cannot:

1. Explore relationships in the graph
2. Debug missing connections
3. Traverse the dependency graph via Datalog

Combined with broken `attr()`, this renders the Datalog query interface essentially unusable for debugging.

## Acceptance Criteria

- [ ] `edge(X, Y, Type)` returns matching edges
- [ ] Edge type filtering works correctly
- [ ] Variable binding works for all three positions
- [ ] Test coverage for edge() predicate
