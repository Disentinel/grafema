# REG-556: Link CALL node arguments via PASSES_ARGUMENT edges

**Source:** Linear REG-556
**Priority:** Urgent
**Type:** Bug
**Date:** 2026-02-21

## Goal

CALL nodes must have `PASSES_ARGUMENT` edges to each argument node. Currently CALL nodes only have `CONTAINS → SCOPE`, with no trace of what was passed to them.

## Symptoms

* `CALL "createLogger"` (L104): no PASSES_ARGUMENT edges to `options.logLevel ?? 'info'`
* `CALL "this.plugins.unshift"` (L160): no PASSES_ARGUMENT to `new SimpleProjectDiscovery()`
* Affects all calls where arguments are complex expressions (property access, logical expressions, new expressions)

## Acceptance Criteria

- [ ] Every CALL node has `PASSES_ARGUMENT` edges for each argument
- [ ] Works for: identifier args, property access args, new expressions, logical expressions
- [ ] `CONSTRUCTOR_CALL` also gets PASSES_ARGUMENT edges
- [ ] Unit test: `foo(a, b.c, new X())` → 3 PASSES_ARGUMENT edges

## MLA Config

Mini-MLA
