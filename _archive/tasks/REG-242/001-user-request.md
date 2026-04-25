# REG-242: Add error feedback for unknown Datalog predicates in --raw queries

## Problem

When a user runs a raw Datalog query with an unknown predicate, it silently returns empty results:

```bash
grafema query --raw 'unknown_predicate(X, Y)'
# → No results.
```

No indication that `unknown_predicate` doesn't exist.

## Context

Deferred from REG-213. The current behavior is technically correct (Datalog allows user-defined predicates via rules), but UX could be improved.

## Proposed Solution

When a query returns empty results AND uses predicates that:

1. Are not built-in (node, type, edge, attr, path, incoming, neq, starts_with, not_starts_with)
2. Have no user-defined rules

Show a warning:

```
No results.
Note: predicate 'unknown_predicate' is not a built-in. Did you mean: node, type, edge?
```

## Considerations

- Must not break valid derived predicates (user-defined rules)
- Warning only, not error
- Only show when results are empty

## Acceptance Criteria

- [ ] Warning shown for unknown predicates when results empty
- [ ] No warning for valid built-in predicates
- [ ] No warning for user-defined rules that return results
