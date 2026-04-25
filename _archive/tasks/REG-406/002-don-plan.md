# Don Melton Plan — REG-406: `grafema context <semanticId>`

## Analysis

The task has two parts:
1. **Add SemanticID to `query` output** — trivial, already displayed (ID line in `formatNodeDisplay`)
2. **New `context` command** — the core of the task

### Existing Infrastructure

**Reuse (don't build):**
- `codePreview.ts` — `getCodePreview()` + `formatCodePreview()` already exist, currently unused
- `formatNode.ts` — `formatNodeDisplay()` already shows `[TYPE] name`, ID, Location
- `query.ts` — `getCallers()` and `getCallees()` already do exactly what we need for graph neighborhood
- `findContainingFunction` from `@grafema/core` — finds the function containing a CALL node
- `parseSemanticId` from `@grafema/core` — parses semantic IDs into components
- `RFDBServerBackend` — `getNode()` to fetch single node by semantic ID

**Key finding:** `BaseNodeRecord` doesn't have `endLine`. For function body preview, we'll use `getCodePreview()` with a reasonable `contextAfter` default. The function body extent can be estimated from the scope's content, but for MVP we use the `contextAfter` parameter (default ~15 lines should show most functions).

**No `endLine`?** This is a known gap — but it's fine for this feature. The `--lines` flag lets users control how much source code to show. Default context (3 before, 15 after) covers ~80% of JS/TS functions. If the user needs more, `--lines 30`.

### Architecture

The `context` command is essentially a **composition** of existing primitives:
1. Lookup node by semantic ID → `backend.getNode(id)`
2. Show source code → `getCodePreview()` + `formatCodePreview()`
3. Show callers → `getCallers()` (extracted from query.ts)
4. Show callees → `getCallees()` (extracted from query.ts)
5. Show caller code context → For each caller, find CALL node location, show code preview

### Call site locations

For "called by" with code context, we need the CALL node's location, not the caller function's location. Current `getCallers()` returns the containing function but loses the CALL node location. We need a variant that also returns the call site location.

## Plan

### Part 1: Add SemanticID to `query` output

Already done — `formatNodeDisplay()` shows `ID: <semanticId>` on line 94 of `formatNode.ts`. No changes needed here. The acceptance criteria says "shows SemanticID" — it already does.

### Part 2: Extract shared utilities

Extract `getCallers()` and `getCallees()` from `query.ts` into a shared utility so both `query` and `context` can use them. Also create an enhanced variant for `context` that includes call site location.

### Part 3: New `context` command

**File:** `packages/cli/src/commands/context.ts`

**Arguments:**
- `<semanticId>` — required positional argument (semantic ID or partial match)

**Options:**
- `--project <path>` — project path (default: `.`)
- `--json` — JSON output
- `--lines <n>` — context lines around each reference (default: 3)
- `--depth <n>` — graph traversal depth (default: 1, max: 3) — FUTURE, v1 does depth=1 only

**Flow:**
1. Connect to backend
2. Look up node by exact semantic ID (`backend.getNode(id)`)
3. If not found, try fuzzy match (search by name + file from semantic ID components)
4. Get code preview of the node's source (file + line)
5. Get callers with call site locations (up to 10)
6. For each caller, get code preview at the call site
7. Get callees (up to 10)
8. Format and display

**Output format (text):**
```
[FUNCTION] invokeCleanup
  Location: hooks/src/index.js:345

  Source (lines 345-360):
    345 | function invokeCleanup(hook) {
    346 |   const cleanup = hook._cleanup;
    ...

  Called by (4):
    1. hooks/src/index.js:37  (in afterPaint)
       35 |   const hooks = ...
     > 37 |   hooks._pendingEffects.forEach(invokeCleanup);
       38 |   ...

  Calls (1):
    - hook._cleanup() (line 349)
```

**Output format (JSON):**
```json
{
  "node": { "id": "...", "type": "FUNCTION", "name": "invokeCleanup", ... },
  "source": { "file": "...", "startLine": 345, "endLine": 360, "lines": [...] },
  "calledBy": [
    { "caller": {...}, "callSite": { "file": "...", "line": 37 }, "source": {...} }
  ],
  "calls": [
    { "name": "cleanup", "line": 349, "resolved": false }
  ]
}
```

### Part 4: Register in CLI

Add to `cli.ts` between `queryCommand` and `typesCommand`.

### Part 5: Add MCP tool

Add `get_context` tool to MCP definitions and handler. Reuse the same core logic.

### Part 6: Tests

Test the `context` command core logic:
- Node lookup by exact semantic ID
- Code preview generation
- Callers with call site info
- JSON output format
- Edge cases: node not found, no callers, no callees

## Scope Control

**In scope:**
- CLI `context` command (text + JSON output)
- MCP `get_context` tool
- Shared callers/callees utilities
- Tests

**Out of scope (future):**
- `--depth` traversal beyond 1 (will add later)
- `endLine` for accurate function body extent
- Callees with code context (only name + line for now)

## Complexity

- O(1) for node lookup by ID
- O(k) for callers/callees where k = number of edges (typically small, <20)
- O(k) for code previews (one file read per caller)
- Total: O(k) — no full graph scans, no O(n) operations

## Files to modify

1. `packages/cli/src/commands/context.ts` — NEW: context command
2. `packages/cli/src/cli.ts` — register command
3. `packages/mcp/src/definitions.ts` — add tool definition
4. `packages/mcp/src/handlers.ts` — add handler
5. `packages/mcp/src/server.ts` — wire handler
6. `packages/mcp/src/types.ts` — add args type
7. `test/unit/context.test.js` — NEW: tests
