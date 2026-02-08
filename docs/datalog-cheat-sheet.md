# Datalog Cheat Sheet

Grafema uses Datalog queries to search the code graph. This cheat sheet explains the basics and provides copy-paste queries for common tasks.

## Quick Syntax Reference

```
violation(X) :- condition1, condition2, ...
```

This reads as: "X is a violation if condition1 AND condition2 AND ... are all true."

| Syntax | Meaning |
|--------|---------|
| `node(X, "TYPE")` | X is a node of type TYPE |
| `edge(X, Y, "TYPE")` | There's an edge of type TYPE from X to Y |
| `attr(X, "name", Value)` | Node X has attribute "name" with value Value |
| `\+` | NOT (negation) |
| `,` | AND |
| `;` | OR |

## Common Queries

### Find Unresolved Calls

**Problem:** Which function calls couldn't be traced to their definitions?

```datalog
violation(X) :- node(X, "CALL"), \+ edge(X, _, "CALLS").
```

*Translation: X is a violation if X is a CALL node and there is NO CALLS edge from X to anything.*

### Find Unresolved Method Calls

```datalog
violation(X) :- node(X, "METHOD_CALL"), \+ edge(X, _, "CALLS").
```

### Find All HTTP Routes

```datalog
violation(X) :- node(X, "http:route").
```

*Note: "violation" is just the output variable name. It doesn't mean something is wrong.*

### Find eval() Usage

**Security:** Detect dangerous dynamic code execution.

```datalog
violation(X) :- node(X, "CALL"), attr(X, "name", "eval").
```

### Find new Function() Usage

```datalog
violation(X) :- node(X, "CALL"), attr(X, "name", "Function").
```

### Find console.log Calls

```datalog
violation(X) :- node(X, "CALL"), attr(X, "object", "console"), attr(X, "method", "log").
```

### Find Database Queries

```datalog
violation(X) :- node(X, "db:query").
```

### Find HTTP Client Requests

```datalog
violation(X) :- node(X, "http:request").
```

### Find External Dependencies

```datalog
violation(X) :- node(X, "MODULE"), attr(X, "external", "true").
```

### Find Functions in a Specific File

```datalog
violation(X) :- node(X, "FUNCTION"), attr(X, "file", "/path/to/file.js").
```

### Find All Functions Called by a Specific Function

```datalog
violation(Y) :-
  node(X, "FUNCTION"),
  attr(X, "name", "myFunction"),
  edge(X, C, "CONTAINS"),
  node(C, "CALL"),
  edge(C, Y, "CALLS").
```

### Find Unused Functions (No Incoming CALLS)

```datalog
violation(X) :- node(X, "FUNCTION"), \+ edge(_, X, "CALLS").
```

*Warning: May include entry points and event handlers.*

### Find Files with Most Unresolved Calls

```datalog
violation(F) :- node(C, "CALL"), attr(C, "file", F), \+ edge(C, _, "CALLS").
```

*Groups results by file path.*

## Combining Conditions

### AND (comma)

Find functions that are both exported AND have no callers:

```datalog
violation(X) :-
  node(X, "FUNCTION"),
  attr(X, "exported", "true"),
  \+ edge(_, X, "CALLS").
```

### OR (semicolon)

Find either eval or Function calls:

```datalog
violation(X) :-
  node(X, "CALL"),
  (attr(X, "name", "eval") ; attr(X, "name", "Function")).
```

## Understanding Results

Query results return node IDs. Use `npx @grafema/cli node <id>` to see full node details:

```bash
# Run query
npx @grafema/cli query 'violation(X) :- node(X, "CALL"), attr(X, "name", "eval").'

# Output: CALL:src/utils.js:42:eval
# Get details
npx @grafema/cli node "CALL:src/utils.js:42:eval"
```

## Tips

1. **Start simple** — Begin with single conditions, then add more
2. **Use negation carefully** — `\+` can be slow on large graphs
3. **Check file paths** — Use relative paths from project root
4. **Quote strings** — All string values must be in double quotes

## Common Node Types

| Type | Description |
|------|-------------|
| `MODULE` | A JavaScript/TypeScript file |
| `FUNCTION` | Function declaration or expression |
| `CLASS` | Class declaration |
| `METHOD` | Method in a class |
| `VARIABLE` | Variable declaration |
| `CALL` | Function call |
| `METHOD_CALL` | Method call (obj.method()) |
| `http:route` | HTTP endpoint (Express, etc.) |
| `http:request` | HTTP client request (fetch, axios) |
| `db:query` | Database query |

## Common Edge Types

| Type | Meaning |
|------|---------|
| `CONTAINS` | Parent contains child (module contains function) |
| `CALLS` | Function call resolves to target |
| `DEPENDS_ON` | Module imports another module |
| `ASSIGNED_FROM` | Variable gets value from expression |
| `INTERACTS_WITH` | HTTP request connects to route |

## See Also

- [Configuration](configuration.md) — Plugin configuration
- [Getting Started](getting-started.md) — Quick start guide
