# Steve Jobs Review: REG-412 — `grafema file <path>` command

## Verdict: APPROVE

---

## Vision Alignment

This feature is exactly what Grafema should be. "AI should query the graph, not read code." The SWE-bench experiments showed agents `cat`-ing entire files because there was no middle ground between raw text and single-node context. This command fills that gap precisely.

The comparison to LSP Document Symbols + relationship edges is apt. No other tool gives you file-level structure with cross-file edges in a single command. This is a genuine product differentiator for AI agent workflows.

## Architecture Review

### No full-graph scans -- PASS

The data flow is clean:
1. `queryNodes({file, type: 'MODULE'})` -- server-side filtered, O(1)
2. `getOutgoingEdges(moduleId, ['CONTAINS'])` -- targeted edge query
3. Per-entity: 1-3 targeted edge queries via `findCallsInFunction` or `getOutgoingEdges`

No iteration over all nodes. No backward pattern scanning. Starts from a specific file, follows CONTAINS edges down, fetches targeted edge types. This is the correct "forward registration" pattern.

### Plugin architecture -- PASS

- Reuses `findCallsInFunction` (existing utility, proven in MCP handlers)
- Reuses `queryNodes`, `getOutgoingEdges`, `getNode` from `GraphBackend`
- No new abstract methods on `GraphBackend`
- No new edge types or node types
- Adding support for new languages/frameworks requires zero changes to `FileOverview`

### Reuses existing infrastructure -- PASS

The reuse inventory is thorough. Path resolution copied from `explain` command. Call resolution via `findCallsInFunction`. MCP wiring follows `get_context` pattern exactly. No new subsystems.

### FileOverview as core class -- CORRECT

This is the right decision. CLI and MCP both need the same logic. The `FileExplainer` pattern (core class + thin wrappers) is established and works. Not duplicating `FileExplainer` is also correct -- they serve different purposes (node discovery vs. entity overview with relationships).

## Complexity Analysis

O(N * (S + K)) where N = entities, S = scopes per function, K = calls per function.

- Typical file: 10-50 entities, 5-30 calls each
- Total: 200-500 DB operations
- At <1ms per RFDB round-trip: <500ms per file
- With `includeEdges=false`: <100ms

This is acceptable. The `--no-edges` escape hatch is good for large files where 500ms matters.

### One concern that I verified is NOT a problem:

The plan fetches each child node individually in `getTopLevelEntities` with `getNode(edge.dst)` for every CONTAINS edge. For a file with 200 CONTAINS edges (large file), that's 200 sequential getNode calls. However, each is <1ms via unix socket, so 200ms worst case. Not a showstopper. If it becomes one later, batching can be added without API changes.

## Code Quality

### Types -- clean

Joel's types map precisely to the node record types in `packages/types/src/nodes.ts`:
- `FunctionNodeRecord.async`, `.params`, `.returnType`, `.signature` -- all verified present (lines 112-124)
- `ClassNodeRecord.exported`, `.superClass` -- verified (lines 128-132)
- `VariableNodeRecord.kind` -- verified (lines 176-180)
- `ImportNodeRecord.source`, `.specifiers` -- verified (lines 152-158)
- `ExportNodeRecord.exportedName`, `.isDefault` -- verified (lines 167-173)

No phantom fields. Every field the plan reads actually exists on the node types.

### `findCallsInFunction` compatibility -- verified

The plan shows `this.graph as any` for the cast, but checking the MCP handlers (`handlers.ts:1035`), the existing code passes the `GraphBackend` directly without `as any`. The `findCallsInFunction` internal `GraphBackend` interface is a strict subset of `@grafema/types` `GraphBackend`. The `as any` cast is unnecessary -- implementation should pass `this.graph` directly, matching the existing pattern in handlers.

### METHOD_CALL handling

`findCallsInFunction` already handles both `CALL` and `METHOD_CALL` node types (line 96 of `findCallsInFunction.ts`). The `FileOverview` code delegates call resolution entirely to this utility, so method calls on objects (e.g., `response.json()`) will be captured correctly. Good delegation.

### Class method handling -- robust

The plan handles both `FUNCTION` (with `isClassMethod` flag) and `METHOD` types when traversing CLASS -> CONTAINS edges (Joel's plan line 462). Checking `nodes.ts`, both `FunctionNodeRecord` (with `isClassMethod?: boolean`) and `MethodNodeRecord` (with `type: 'METHOD'`) exist. The plan covers both paths.

## Edge Cases

The edge case table is comprehensive. Key ones I verified:

1. **File not analyzed** -- returns `NOT_ANALYZED` status, empty arrays. Correct.
2. **Symlinks** -- `realpathSync()` before querying. Same as `explain` command. Correct.
3. **Anonymous functions** -- falls back to `<anonymous>`. Correct.
4. **Import with no specifiers** (side-effect imports like `import './styles.css'`) -- returns empty specifiers array. Correct.
5. **CLASS with superClass on node but no EXTENDS edge** -- falls back to `node.superClass` field. Correct.

## MVP Completeness Check

Does this work for >50% of real-world cases?

- Functions with calls: YES (via `findCallsInFunction`)
- Classes with methods: YES (via CONTAINS traversal)
- Classes with inheritance: YES (via EXTENDS edge + `superClass` fallback)
- Variables with assignments: YES (via ASSIGNED_FROM edge)
- Imports: YES (directly from node fields)
- Exports: YES (directly from node fields)
- Arrow functions: YES (stored as FUNCTION nodes with `arrowFunction: true`)
- Async functions: YES (`async` field on FunctionNodeRecord)

Gaps:
- No IMPLEMENTS edge resolution (interfaces) -- acceptable, JS/PHP don't have interfaces in the traditional sense, and this is documented as a curated summary, not exhaustive
- No RETURNS edge display for functions -- the `returnType` field is shown from the node, but RETURNS edges to specific return nodes are not traversed. The acceptance criteria mentions "RETURNS" but Don's plan explicitly excluded it from the edge table. The `returnType` on the node record is sufficient for the overview use case.
- Decorators are not shown -- acceptable for v1

None of these gaps defeat the feature's purpose. The command will work correctly for the vast majority of real-world JavaScript/PHP/Python files.

## Implementation Plan

4 atomic commits, each independently testable. Clean separation: core class -> CLI wrapper -> MCP wrapper -> tests. This is textbook.

Total ~810 lines including tests, ~36 lines modified in existing files. Low blast radius. No architectural changes.

## Minor Notes for Implementation

1. **Remove `as any` cast** when calling `findCallsInFunction`. Pass `this.graph` directly, matching the existing pattern in MCP handlers.
2. **Dynamic import of `realpathSync`** in the MCP handler (Joel's plan line 923) is unnecessary -- `realpathSync` is already imported at the top of `handlers.ts` via `import { existsSync, readFileSync, ... } from 'fs'`. Just add `realpathSync` to the existing import.
3. The test mock backend includes `getIncomingEdges` which `FileOverview` never calls -- harmless, but implementation should note this is for future extensibility, not current need.

## Summary

This plan is right. It fills a real product gap discovered through actual experimentation (SWE-bench). The architecture reuses existing infrastructure cleanly. No full-graph scans. No backward pattern scanning. Complexity is bounded. Types are verified against the actual codebase. Edge cases are handled. The feature works for the vast majority of real-world files.

**APPROVE** -- escalate to Vadim for final confirmation.
