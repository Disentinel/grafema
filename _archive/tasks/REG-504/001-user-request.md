# User Request: REG-504

**Task:** Datalog query reordering: bound variables first
**Source:** Linear REG-504
**Priority:** High
**Labels:** v0.2, Improvement

## Problem

Evaluator processes literals strictly left-to-right. If user writes:

```datalog
violation(X) :- attr(X, "name", "eval"), node(X, "CALL").
```

`attr(X, ...)` gets unbound X → returns empty result → query "doesn't work".

Correct order is `node(X, "CALL")` first (binds X), then `attr(X, ...)`. But the user shouldn't have to think about this.

## Acceptance Criteria

1. Evaluator automatically reorders literals so predicates with unbound variables come after those that bind them
2. Negation (`\+`) always comes after all positive literals that bind the same variables
3. Order doesn't change if literals are already correctly ordered (zero overhead)
4. If reordering is impossible (circular dependency), a clear error is produced
5. Tests: query with "wrong" predicate order gives same result as "correct" order

## Implementation Notes

* Simplest approach: topological sort by variable dependencies
* Each literal: {provides: Set<Var>, requires: Set<Var>}
* `node(X, "TYPE")` provides X; `attr(X, "name", V)` requires X, provides V
* Constraints (`neq`, `starts_with`) — always last
* Implement in `eval.rs` / `eval_explain.rs` at `eval_query()` / `eval_rule_body()` level
