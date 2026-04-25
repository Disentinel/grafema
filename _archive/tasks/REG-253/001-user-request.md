# REG-253: Query by arbitrary node type

## Problem

`grafema query` has a hardcoded list of searchable types. Users cannot query for nodes of arbitrary types that exist in the graph.

### Current State

```bash
grafema query "pattern"  # searches default types only
```

### Desired State

```bash
grafema query --type http:request "pattern"
grafema query --type jsx:component "pattern"
grafema ls --type http:request  # list all nodes of a type
```

## Why This Matters

* Grafema creates many specialized node types (http:request, jsx:component, etc.)
* Users need to find and explore these nodes
* Currently no way to discover what nodes of a given type exist

## Acceptance Criteria

- [ ] `grafema query --type <nodeType> "pattern"` - search within specific node type
- [ ] `grafema ls --type <nodeType>` - list all nodes of a type
- [ ] `grafema types` - list all node types present in the graph with counts
- [ ] Tab completion for `--type` argument (if feasible)

## Technical Notes

The graph already stores node types. This is primarily a CLI enhancement to expose existing data.
