# REG-213: grafema query --raw Datalog queries not working or undocumented

## Problem

```bash
grafema query --raw "type(N, T)"
# → No results.
```

Either:

1. Bug: --raw flag doesn't work
2. Documentation gap: syntax is different than expected

No documentation on how to write raw Datalog queries.

## Expected Behavior

Either:

1. Fix --raw flag to execute Datalog queries
2. Document correct syntax and available predicates
3. Both

## Acceptance Criteria

- [ ] `grafema query --raw` works with Datalog syntax
- [ ] Documentation for available predicates (node, edge, attr, etc.)
- [ ] Examples in --help output
- [ ] Error messages if syntax is wrong
