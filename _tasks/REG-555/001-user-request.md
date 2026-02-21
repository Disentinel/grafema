# Task: REG-555 — Link PROPERTY_ACCESS nodes to their source variable/parameter

**Source:** Linear REG-555 (Priority: Urgent, Labels: Bug, v0.2)
**URL:** https://linear.app/grafemadev/issue/REG-555

## Goal

When `options.graph` is accessed, create a `READS_FROM` (or `DERIVES_FROM`) edge from the `PROPERTY_ACCESS "graph"` node to `PARAMETER "options"`. Currently PROPERTY_ACCESS nodes are "floating" — only connected via `CONTAINS` to their scope.

## Symptoms

`PROPERTY_ACCESS "entrypoint"` (from `options.entrypoint`) has only `CONTAINS → FUNCTION "constructor"`. No link to `PARAMETER "options"`.

## Impact

Value Trace cannot follow `options.X` → `this.X` assignment chains. The source of class field values is untraceable.

## Acceptance Criteria

- [ ] `options.graph` PROPERTY_ACCESS has `READS_FROM → PARAMETER "options"` edge
- [ ] Works for: parameter access, variable access, `this` access
- [ ] Unit test: `const x = obj.prop` → PROPERTY_ACCESS linked to `obj` variable node
