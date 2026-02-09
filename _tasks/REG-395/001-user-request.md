# REG-395: Add `grafema grep` fallback for text search in graph context

## Problem

When searching for something like `"maxBodyLength"`, which is a property access (e.g., `config.maxBodyLength`) rather than a named function or variable, `grafema query` returns no results. For SWE-bench agents, the most common first action is keyword search across the codebase. When `query` returns nothing, agents have no graph-based alternative and must fall back to regular grep.

## Proposal

Add a `grafema grep <pattern>` command that:

1. Searches analyzed files for text pattern (like grep)
2. Returns results enriched with graph context (which function contains the match, what calls that function)
3. Falls back gracefully when graph data is unavailable

### Example output

```
$ grafema grep "maxBodyLength"

lib/adapters/http.js:279  (in function httpAdapter, called by dispatchRequest)
  if (config.maxBodyLength > -1) {

lib/adapters/http.js:281  (in function httpAdapter)
    options.maxBodyLength = config.maxBodyLength;

lib/defaults/index.js:106  (in module defaults)
  maxBodyLength: -1,
```

## Value

- Bridges the gap between "query the graph" and "search the code"
- Agent always gets useful results, even for property names
- Graph enrichment adds value over plain grep

## Acceptance Criteria

- [ ] `grafema grep <pattern>` searches all analyzed files
- [ ] Results include graph context (containing function, callers)
- [ ] Works even when pattern doesn't match any graph node
- [ ] Performance: <1s for typical projects

## Complexity

LOW — combine ripgrep/text search with graph node lookup by file:line
