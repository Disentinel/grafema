# Plan: REG-601 — break/continue label: TARGETS edge to LABEL node

## Problem Analysis

`break outerLoop;` and `continue myLabel;` create `EXPRESSION('break'/'continue')` nodes with empty edges. The label Identifier is excluded by `visitIdentifier` (returns `EMPTY_RESULT` for `BreakStatement`/`ContinueStatement` contexts). No edge-map entries exist for `BreakStatement.label` or `ContinueStatement.label`.

The graph shows disconnected break/continue nodes with no way to know which loop they target.

## Approach

**Minimal, deferred-ref-based approach** — follow existing patterns.

When `visitBreakStatement`/`visitContinueStatement` finds a label on the AST node, emit a `scope_lookup` deferred ref. Since LABEL nodes aren't registered in the scope system, file-level resolution (`resolveFileRefs`) picks it up by name matching — but only if `LABEL` is in `DECLARABLE_TYPES`.

### Changes

1. **`packages/types/src/edges.ts`** — Add `TARGETS: 'TARGETS'` to `EDGE_TYPE`
2. **`packages/core-v2/src/visitors/statements.ts`** — Modify `visitBreakStatement` and `visitContinueStatement` to emit a `scope_lookup` deferred ref when `node.label` is present
3. **`packages/core-v2/src/resolve.ts`** — Add `'LABEL'` to `DECLARABLE_TYPES` so file-level resolution can find LABEL nodes by name
4. **Test file** — New unit test covering labeled break, labeled continue, unlabeled break/continue

### Edge Cases

| Case | Expected behavior | Handled? |
|------|------------------|----------|
| `break outerLoop` | EXPRESSION --TARGETS--> LABEL:outerLoop | YES — deferred ref |
| `continue myLabel` | EXPRESSION --TARGETS--> LABEL:myLabel | YES — deferred ref |
| `break` (unlabeled) | No TARGETS edge | YES — no label, no deferred ref emitted |
| `continue` (unlabeled) | No TARGETS edge | YES — no label, no deferred ref emitted |
| `break label` inside labeled block (non-loop) | EXPRESSION --TARGETS--> LABEL:block | YES — same mechanism |
| Multiple labels with same name in different functions | resolveFileRefs picks closest by line proximity | YES — existing proximity logic |
| Label in nested scope | Works — LABEL nodes are file-level, name match works | YES |

### Graph Invariants (Acceptance Criteria)

1. `break outerLoop` → `EXPRESSION('break')` --TARGETS--> `LABEL('outerLoop')`
2. `continue myLabel` → `EXPRESSION('continue')` --TARGETS--> `LABEL('myLabel')`
3. Unlabeled `break`/`continue` → no TARGETS edge

### Test Strategy

Unit test: parse JS with labeled break/continue, run `walkFile`, verify TARGETS edges exist. Also verify unlabeled break/continue produce no TARGETS edge.
