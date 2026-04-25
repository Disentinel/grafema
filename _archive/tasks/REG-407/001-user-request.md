# REG-407: Refactor: Extract shared buildNodeContext() to @grafema/core

## Goal

Extract the shared node context building logic from CLI `context.ts` and MCP `handleGetContext` into a shared function in `@grafema/core`.

## Context

REG-406 implemented `grafema context` in both CLI and MCP. Both have parallel implementations of:

* `STRUCTURAL_EDGE_TYPES` / `CONTEXT_STRUCTURAL_EDGES` (same set, different names)
* Edge grouping and resolution
* Source code preview extraction
* Text formatting with `->` / `<-` prefixes

## Acceptance Criteria

- [ ] Single `buildNodeContext()` in `@grafema/core`
- [ ] CLI and MCP both call the shared function
- [ ] Only output formatting differs between CLI and MCP
- [ ] No behavioral changes
