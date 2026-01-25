# REG-212: CLI help: Add Examples section to all commands

## Problem

`grafema query --help` shows argument description but no examples:

```
Arguments:
  pattern   Search pattern: "function X", "class Y", or just "X"
```

User doesn't know:

* Can you search by path? (`query "api.ts"`)
* Do wildcards work? (`query "fetch*"`)
* How to search HTTP routes?

## Expected Behavior

Add Examples section to help output:

```
Examples:
  grafema query "auth"              Search by name
  grafema query "function login"    Search functions only
  grafema query --raw "calls(X,Y)"  Raw Datalog query
```

## Scope

Add examples to all CLI commands:

* `grafema query`
* `grafema trace`
* `grafema impact`
* `grafema analyze`
* etc.

## Acceptance Criteria

- [ ] All commands have Examples section in --help
- [ ] Examples cover common use cases
- [ ] Examples are tested and work
