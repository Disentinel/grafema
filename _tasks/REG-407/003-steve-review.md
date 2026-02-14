# Steve Jobs Review: REG-407 Extract shared `buildNodeContext()` to `@grafema/core`

## Vision Alignment

Does this move us toward "AI should query the graph, not read code"? **Yes** -- consolidating graph querying logic into `@grafema/core` makes it the canonical way to get node context. Both CLI and MCP now call the same function. This is the right direction: one source of truth for how we build node neighborhoods.

## What I Like

1. **Clean DI pattern.** The `readFileContent` callback in `BuildNodeContextOptions` decouples file I/O from graph logic. Testable without filesystem. Matches how the codebase does things elsewhere.

2. **Interface-based backend.** `GraphBackend` interface at the top of `NodeContext.ts` accepts anything with `getNode`/`getOutgoingEdges`/`getIncomingEdges` -- no coupling to `RFDBServerBackend`. Both CLI and MCP pass their backends directly. Correct.

3. **MCP gains improvements.** Before this refactoring, MCP lacked structural-last sorting (it was alphabetical only) and had no edge metadata display. Now it gets both for free by using the shared code. Incidental improvement from DRY -- this is how it should work.

4. **Clean separation: data vs formatting.** `buildNodeContext()` returns typed data. CLI formats with its `formatCodePreview` utility (80-char truncation). MCP formats with its own inline logic (120-char truncation). Each consumer owns its formatting. The shared module is data-only, as documented.

5. **Barrel exports are complete.** All types and functions exported from `NodeContext.ts` -> `queries/index.ts` -> `core/index.ts`. No gaps.

6. **Tests pass.** 10/10 context command tests. Build clean.

## Issues Found

### Minor Issue: Source preview behavior change for CLI

**Before:** CLI's `buildNodeContext` used `getCodePreview()` which called `readFileSync` internally.
**After:** The shared `buildNodeContext` uses `defaultReadFileContent` which also calls `readFileSync`.

The calculation is equivalent:
- Old: `startLine = max(1, line - contextBefore)`, `endLine = min(length, line + contextAfter)` with `contextBefore=contextLines`, `contextAfter=contextLines+12`
- New: `startLine = max(1, line - contextLines)`, `endLine = min(length, line + contextLines + 12)`

Same math. No behavioral change. **OK.**

### Observation: Sequential `getNode` calls in `groupEdges`

In `groupEdges()`, each edge resolves its connected node with `await backend.getNode(connectedId)` in a sequential loop. For nodes with many edges, this is N sequential round-trips.

However: this is **pre-existing behavior** -- both the old CLI and MCP code did exactly the same thing. This refactoring faithfully preserves it. Not a regression, not in scope for this task. If it becomes a problem, it's a separate optimization issue (batch `getNodes`).

### Observation: MCP code context still reads files inline

In MCP `formatEdgeSection` (lines 1199-1216), non-structural edge code context still reads files with `readFileSync` inline -- it doesn't use the `SourcePreview` from `buildNodeContext`. This is correct because:
- `buildNodeContext` only provides source for the **central node**
- The code context for **connected nodes** is per-edge, per-consumer formatting concern
- CLI uses `getCodePreview()` for this; MCP reads inline

Not a problem. The per-edge code context is formatting, not shared logic.

### No tests for the new shared module itself

There are 10 tests for the CLI context command (which exercises the flow end-to-end), but no unit tests for `buildNodeContext()` / `groupEdges()` / `getNodeDisplayName()` / `formatEdgeMetadata()` in isolation. Given the DI callback for file reading, these functions are easily testable.

However: the existing tests cover the integrated path, and these helper functions are simple enough that the risk is low. For a DRY refactoring that preserves existing behavior, this is acceptable. If the functions grow more complex, they should get their own unit tests.

## Checklist

| Criteria | Verdict |
|----------|---------|
| Aligns with project vision? | Yes -- canonical graph query in core |
| Cut corners? | No -- clean DI, interface-based, proper exports |
| Architectural gaps? | None -- data/formatting separation is correct |
| Would shipping this embarrass us? | No |
| Tests pass? | Yes, 10/10 |
| Build clean? | Yes |
| MCP regression? | No -- gains structural-last sort and edge metadata |
| CLI regression? | No -- same behavior through shared code |

## Verdict

**APPROVE**

This is a clean, well-executed DRY refactoring. The shared module does exactly one thing: build node context data. Both consumers import it and handle their own formatting. The interface-based design and DI callback for file reading make it testable and loosely coupled. MCP gets incidental improvements (structural-last sort, edge metadata, display names for HTTP/SocketIO nodes) for free.

No hacks. No shortcuts. No "MVP limitations." Ship it.
