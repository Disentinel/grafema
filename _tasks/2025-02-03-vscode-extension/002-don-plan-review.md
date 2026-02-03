# Don's Plan Review: VS Code Extension MVP

**Status: APPROVED - GREEN LIGHT FOR IMPLEMENTATION**

## Vision Alignment

The VS Code extension directly embodies Grafema's core thesis: **"AI should query the graph, not read code."** Instead of analyzing file text, the extension queries the graph to understand node relationships. The recursive tree navigation (expand edges → see target node's edges) is fundamentally a graph query UI, not a code text UI. This is exactly what we want.

## Infrastructure Reuse

Plan correctly reuses existing Grafema infrastructure with zero unnecessary abstraction:

- **RFDBClient:** Uses `@grafema/rfdb-client` directly (socket-based) — perfect for VS Code (no MCP overhead needed here)
- **Types:** Reuses `WireNode`, `WireEdge` from `@grafema/types` — already defines our graph protocol
- **Server Management:** Pattern copied from `RFDBServerBackend.ts` (binary finding, process spawning, socket waiting) — proven code, minimal changes needed
- **Metadata Parsing:** Borrows `JSON.parse(metadata)` pattern from existing code — consistent with codebase

## Architecture Assessment

✅ **Package Location:** Monorepo package keeps dependencies local, avoids npm hassle
✅ **Direct RFDB Connection:** No MCP layer for this UI — socket client is faster, simpler, correct
✅ **Cursor Tracking:** 150ms debounce prevents query flood — reasonable
✅ **Recursive Tree Provider:** Matches VS Code conventions (File Explorer pattern), leverages TreeDataProvider API
✅ **Error States:** Graceful degradation (no .rfdb → show message, server not running → auto-start)

## No Red Flags

- No new abstractions created where existing code could be reused
- Not trying to replace static analysis with the graph (correct scope)
- Not adding metadata collection that should be an enricher
- File node location (`findNodeAtCursor`) is reasonable for MVP (can be optimized with caching later)

## Blocker Status

**No blockers.** Plan is ready for implementation.

The extension doesn't depend on any unfinished features. RFDB client exists, types exist, server spawning pattern is proven. This can move directly to implementation.

---

## Minor Notes (Not blockers)

1. **NodeLocator approach** — Current plan uses `getAllNodes({file})` + linear search for line match. This works for MVP but will be slow on large files (100+ nodes). Future optimization: `findByAttr({file, line})` could query by metadata directly. For now, acceptable.

2. **Auto-start binary finding** — Reuse the exact logic from `RFDBServerBackend._findServerBinary()`. Don't reimplement. If we change that pattern later, extension auto-start will break — that's OK (document the dependency).

3. **No Datalog in MVP** — Good decision. Extension doesn't need complex queries. If future versions (e.g., "find all callers of this function") are requested, that's when to add Datalog queries. For now, simple edge traversal is correct.

---

**Recommendation:** Proceed to implementation. Kent writes tests, Rob implements. This is well-scoped, reuses infrastructure correctly, and aligns with vision.
