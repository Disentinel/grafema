# REG-254: Linus Torvalds - High-Level Review

## Summary

**Status: CHANGES NEEDED**

The implementation is fundamentally sound but has one critical architectural oversight and one missing piece.

---

## Critical Issues

### 1. Missing README Documentation (BLOCKER)

**What's wrong:** Joel's plan explicitly called for `packages/core/src/queries/README.md` documenting the graph architecture. This is NOT optional fluff - it's critical infrastructure documentation.

**Why it matters:**
- Future developers will cargo-cult the wrong pattern without understanding the graph structure
- AI agents (our primary users) need to understand WHY the code works this way
- The HAS_SCOPE -> SCOPE -> CONTAINS pattern is non-obvious and needs explicit documentation
- "AI should query the graph, not read code" - but AI needs to understand the graph structure

**From Joel's Plan (Phase 9):**
```markdown
## Graph Architecture Comment

**File:** `packages/core/src/queries/README.md`

### Graph Structure

### Function Containment

FUNCTION -[HAS_SCOPE]-> SCOPE (function_body)
                        SCOPE -[CONTAINS]-> SCOPE (nested blocks: if, for, etc.)
                        SCOPE -[CONTAINS]-> CALL (function call)
                        SCOPE -[CONTAINS]-> METHOD_CALL (method call)
```

**Required action:** Add the README exactly as specified in Joel's plan before marking this complete.

---

### 2. Graph Structure Inconsistency in findContainingFunction

**What's wrong:** The shared utility `findContainingFunction.ts` only follows `CONTAINS` and `HAS_SCOPE` edges, but the CLI version in `query.ts` also follows `DECLARES` edges.

**Location:** Compare these two implementations:

**Core utility** (`packages/core/src/queries/findContainingFunction.ts:59`):
```typescript
const edges = await backend.getIncomingEdges(id, ['CONTAINS', 'HAS_SCOPE']);
```

**CLI version** (`packages/cli/src/commands/query.ts:478`):
```typescript
const edges = await backend.getIncomingEdges(id, null);
// Only follow structural edges
if (!['CONTAINS', 'HAS_SCOPE', 'DECLARES'].includes(edge.type)) continue;
```

**Why this matters:**
- The CLI has a LOCAL implementation of `findContainingFunction` that hasn't been replaced
- The local version handles `DECLARES` edges (for variables declared in functions)
- This creates divergent behavior between MCP and CLI
- Violates DRY principle - two implementations doing the same thing differently

**The question:** Which is correct?
- If variables need `DECLARES` edge traversal, the core utility is wrong
- If they don't, the CLI implementation is wrong
- Either way, we have inconsistency

**Root cause analysis:**
Rob's report says "Fixed CLI to use shared utilities" but he only fixed `getCallees()`. The `findContainingFunction` in CLI is still a separate implementation at lines 456-511. This is exactly the kind of half-fix that causes bugs later.

**Required action:**
1. Determine correct behavior (with or without DECLARES)
2. Update core utility if needed
3. Remove duplicate implementation from CLI
4. Add test case for variable containment if DECLARES is needed

---

## What They Got Right

### Architecture: Shared Utilities in Core

**Good:** Utilities in `packages/core/src/queries/` is the right place. Both MCP and CLI depend on core, no circular dependencies, clean layering.

**Good:** Minimal GraphBackend interface makes testing easy and avoids coupling to implementation details.

### Algorithm: Transitive Call Handling

**Good:** The cycle detection in `findCallsInFunction` is correct:
- Tracks visited function IDs in `seenTargets`
- Adds starting function to prevent self-cycles
- Respects `transitiveDepth` limit
- Handles mutual recursion (A -> B -> A)

This is the right solution. Not clever, just correct.

### Testing Coverage

**Good:** 35 tests covering:
- Direct calls (CALL and METHOD_CALL)
- Resolution status (resolved vs unresolved)
- Transitive mode with cycle handling
- Edge cases (no scope, missing nodes, deep nesting)

Tests communicate intent clearly, no mock hell.

### MCP Tool Design

**Good:** The `get_function_details` tool properly:
- Uses shared utilities (no duplication)
- Handles disambiguation with file parameter
- Returns both calls and calledBy
- Formats output for human readability + JSON for machines
- Documents graph structure in tool description for AI agents

### CLI Bug Fix

**Good:** Fixed the broken `getCallees()` function that:
- Only found CALL nodes (missed METHOD_CALL)
- Used wrong graph traversal (CONTAINS directly from function)

Now correctly uses `findCallsInFunctionCore` from `@grafema/core`.

---

## Does This Align with Project Vision?

**Yes, mostly.**

The vision is "AI should query the graph, not read code." This implementation enables that:
- `get_function_details` tool gives AI comprehensive function information
- Transitive mode answers "what does this call chain do?" without reading code
- Shared utilities make behavior consistent across MCP and CLI

**But:** The missing README and the findContainingFunction duplication are cracks in the foundation. Not fixing them is the kind of technical debt that compounds.

---

## Did We Do The Right Thing or a Hack?

**Right thing:**
- Shared utilities in core (no new package needed)
- BFS traversal for scope walking
- Cycle detection for transitive mode
- Minimal backend interface

**Hack/Shortcut:**
- No README documentation (skipped from plan)
- CLI still has duplicate `findContainingFunction` implementation
- Inconsistent edge type handling (DECLARES vs not)

---

## What Was Forgotten?

1. **README.md** from Joel's plan Phase 9
2. **Complete CLI migration** - only `getCallees` was fixed, `findContainingFunction` still duplicated
3. **Edge type consistency** - DECLARES handling differs between CLI and core

---

## Verdict

**CHANGES NEEDED**

The core algorithm is solid. The architecture is right. But the execution is incomplete:

1. **Add README.md** - This is non-negotiable. Document the graph structure.
2. **Fix findContainingFunction duplication** - Remove CLI version, use core utility
3. **Resolve DECLARES edge handling** - Document why it's different or make it consistent

This is 85% done. Don't ship it at 85%. Finish the job.

---

## Approval Checklist

- [ ] README.md added to `packages/core/src/queries/`
- [ ] CLI uses core's `findContainingFunction` (no duplicate implementation)
- [ ] DECLARES edge handling documented or made consistent
- [ ] Tests verify CLI and MCP use same utilities

**Next Steps:**
1. Rob: Add README.md from Joel's plan
2. Rob: Fix CLI findContainingFunction duplication
3. Rob: Document/fix DECLARES edge inconsistency
4. Kevlin: Review code quality after fixes
5. Linus: Re-review after changes

---

*Linus Torvalds, High-level Reviewer*
*REG-254: Variable tracing stops at function call boundaries*
*Review Date: 2026-02-01*
