# Grafema Datalog Query Patterns

All queries use `query_graph` tool. Every query must define a `violation/1` predicate —
matching nodes are returned as results.

## Syntax Quick Reference

```
violation(X) :- <body>.         # Rule: X is a result if body is true
node(X, "TYPE")                 # Match node by type
edge(X, Y, "TYPE")             # Match edge: X -> Y of given type
attr(X, "name", "value")       # Match node attribute
\+ <condition>                  # Negation: condition is NOT true
```

## Basic Patterns

### Find nodes by type

```datalog
violation(X) :- node(X, "FUNCTION").
```

### Find nodes by type and name

```datalog
violation(X) :- node(X, "FUNCTION"), attr(X, "name", "processPayment").
```

### Find nodes by type and file

```datalog
violation(X) :- node(X, "FUNCTION"), attr(X, "file", "src/api.ts").
```

### Find nodes matching multiple criteria

```datalog
violation(X) :- node(X, "CALL"), attr(X, "name", "eval"), attr(X, "file", "src/handler.ts").
```

## Edge Traversal

### One-hop: Find all calls from a function

```datalog
violation(Call) :-
  node(F, "FUNCTION"), attr(F, "name", "main"),
  edge(F, S, "HAS_SCOPE"), edge(S, Call, "CONTAINS"),
  node(Call, "CALL").
```

### One-hop: Find all callers of a function

```datalog
violation(Caller) :-
  node(Target, "FUNCTION"), attr(Target, "name", "validate"),
  edge(Call, Target, "CALLS"),
  edge(Scope, Call, "CONTAINS"),
  edge(Caller, Scope, "HAS_SCOPE"),
  node(Caller, "FUNCTION").
```

### Find module dependencies

```datalog
violation(Dep) :-
  node(M, "MODULE"), attr(M, "name", "api"),
  edge(M, Dep, "DEPENDS_ON"), node(Dep, "MODULE").
```

### Find what a variable is assigned from

```datalog
violation(Source) :-
  node(V, "VARIABLE"), attr(V, "name", "config"),
  edge(V, Source, "ASSIGNED_FROM").
```

## Negation Patterns

### Functions with no callers (potential dead code)

```datalog
violation(X) :-
  node(X, "FUNCTION"),
  \+ edge(_, X, "CALLS").
```

### Modules with no dependents (unused modules)

```datalog
violation(X) :-
  node(X, "MODULE"),
  \+ edge(_, X, "DEPENDS_ON").
```

### Unresolved calls (external/dynamic targets)

```datalog
violation(X) :-
  node(X, "CALL"),
  attr(X, "resolved", "false").
```

## Invariant Patterns

### No eval() usage

```datalog
violation(X) :- node(X, "CALL"), attr(X, "name", "eval").
```

### No direct database queries outside service layer

```datalog
violation(X) :-
  node(X, "db:query"),
  attr(X, "file", File),
  \+ attr(X, "file", "src/services/").
```

Note: File matching is exact. For pattern matching, use the `find_nodes` tool instead.

### All HTTP endpoints must have handlers

```datalog
violation(X) :-
  node(X, "http:request"),
  \+ edge(_, X, "CALLS").
```

## Join Patterns

### Find functions that call both X and Y

```datalog
violation(F) :-
  node(F, "FUNCTION"),
  edge(F, S, "HAS_SCOPE"),
  edge(S, C1, "CONTAINS"), node(C1, "CALL"), attr(C1, "name", "readFile"),
  edge(S, C2, "CONTAINS"), node(C2, "CALL"), attr(C2, "name", "writeFile").
```

### Find classes that extend a specific base class

```datalog
violation(Child) :-
  node(Base, "CLASS"), attr(Base, "name", "BaseService"),
  edge(Child, Base, "EXTENDS"),
  node(Child, "CLASS").
```

## Performance Tips

1. **Put most selective filters first.** `attr(X, "name", "specific")` before `node(X, "FUNCTION")`.

2. **Avoid unconstrained joins.** Every variable should be bounded by at least one specific condition.

3. **Use high-level tools when possible.** `find_calls` is faster than writing a Datalog query for the same pattern — it uses optimized indexes.

4. **Use `explain: true` to debug.** If a query returns nothing, add `explain: true` to see step-by-step execution.

5. **Use `limit` and `offset` for large result sets.** Default limit applies, but you can paginate through results.

## Common Mistakes

### Wrong: Unbound variable

```datalog
# BAD: Y is never constrained
violation(X) :- node(X, "FUNCTION"), edge(X, Y, "CALLS").
```

```datalog
# GOOD: Constrain Y
violation(X) :- node(X, "FUNCTION"), edge(X, Y, "CALLS"), node(Y, "FUNCTION").
```

### Wrong: Using wrong edge direction

```datalog
# BAD: CALLS edge goes Caller -> Callee, not reverse
violation(X) :- node(X, "FUNCTION"), edge(X, Target, "CALLS").
```

The CALLS edge typically goes from CALL/CALL_SITE node to target FUNCTION,
not directly from FUNCTION to FUNCTION. Check [node-edge-types.md](node-edge-types.md)
for correct edge directions.

### Wrong: Missing scope traversal

Functions don't directly CONTAIN calls — they have scopes that contain calls:

```datalog
# BAD: No direct CONTAINS edge from FUNCTION to CALL
violation(C) :- node(F, "FUNCTION"), edge(F, C, "CONTAINS"), node(C, "CALL").
```

```datalog
# GOOD: Go through HAS_SCOPE
violation(C) :-
  node(F, "FUNCTION"), edge(F, S, "HAS_SCOPE"),
  edge(S, C, "CONTAINS"), node(C, "CALL").
```
