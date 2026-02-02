# REG-250: Datalog attr() predicate doesn't return attribute values

## Problem

The Datalog `attr()` predicate doesn't properly return attribute values, making it impossible to filter or inspect node attributes via raw queries.

## Observed Behavior

Query:

```datalog
node(X, "http:request"), attr(X, "url", U)
```

**Result:** Returns only `X` (node ID), not `U` (attribute value)

The variable `U` is not bound or returned in query results.

## Expected Behavior

The query should return both `X` and `U`, allowing users to:

1. See attribute values in results
2. Filter by attribute values (e.g., `attr(X, "url", "/api/users")`)
3. Join on attribute values across nodes

## Impact

This makes raw Datalog queries nearly useless for debugging. Users can't inspect the graph data they need to diagnose issues like missing connections.

## Acceptance Criteria

- [ ] `attr(Node, Key, Value)` binds and returns `Value`
- [ ] Attribute filtering works (matching specific values)
- [ ] Test coverage for attr() predicate with value binding
