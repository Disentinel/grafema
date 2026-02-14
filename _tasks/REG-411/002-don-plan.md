# Don Melton — Analysis: REG-411

## Problem

When `grafema context <class-id>` is called on a CLASS node:

1. **Source code**: Shows `contextLines + 12` lines after the class declaration line (~15 lines). For a typical class, this only shows the constructor.
2. **Outgoing edges**: CONTAINS edges to methods ARE shown, but in compact form (just name + location, NO code context) because `CONTAINS` is in `STRUCTURAL_EDGE_TYPES`.
3. **Method edges**: The individual method's edges (CALLS, RETURNS, etc.) are NOT shown at all — only the class node's own edges.

The agent sees: class header → constructor source → compact list of method names. But NOT the method bodies or what they call/return.

## Root Cause

The context command treats all nodes uniformly. For a CLASS node, this uniform treatment hides the most valuable information — the methods and their relationships.

## Solution

**Expand CLASS context to include all methods.**

When the target node is a CLASS:
1. Show the class header (type, ID, location) — keep as-is
2. Show the class's OWN edges (non-CONTAINS) — keep as-is
3. **NEW**: For each CONTAINS→METHOD edge, show the method's full context:
   - Method header (type, name, signature)
   - Method source code
   - Method's own edges (CALLS, RETURNS, ASSIGNED_FROM, etc.)
4. Sort methods by source line (source order)

## Implementation

### File: `packages/cli/src/commands/context.ts`

1. **`buildNodeContext()`** — Add a `memberContexts` field to `NodeContext` for CLASS nodes. After building the class's own context, find all CONTAINS→METHOD edges, call `buildNodeContext()` for each method, sort by line number.

2. **`printContext()`** — When `memberContexts` is present, print each member's context after the class-level output. Use a visual separator between methods.

3. **Interface `NodeContext`** — Add optional `memberContexts: NodeContext[]` field.

### Scope

- One file to modify: `packages/cli/src/commands/context.ts`
- No changes to graph structure, analyzers, or enrichers
- This is purely a presentation-layer change

### Complexity

O(m) where m = number of methods in the class. Each method's context requires its own edge queries, but methods per class is typically small (5-20).

### Tests

New test file: `packages/cli/test/context-class.test.ts`
- Test that context on a CLASS shows all methods
- Test that each method's edges are shown
- Test source ordering of methods
- Test that non-CLASS nodes work unchanged

## Non-goals

- Changing STRUCTURAL_EDGE_TYPES classification
- Modifying graph structure or analyzers
- Recursive expansion for nested classes
