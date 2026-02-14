# Don Melton Plan: REG-412 — `grafema file <path>` command

## 1. Architecture Analysis

### What Exists

The codebase already has two adjacent commands that share significant DNA with what we need:

1. **`explain` command** (`packages/cli/src/commands/explain.ts`) — Shows all nodes in a file, grouped by type, with semantic IDs. Uses `FileExplainer` core class. **Problem:** it lists nodes flat, no relationships, no hierarchy, no edges. It was designed for "what's in the graph?" discovery, not "what does this file do?" understanding.

2. **`context` command** (`packages/cli/src/commands/context.ts`) — Shows a single node's full neighborhood with edges and code context. **Problem:** too narrow, one node at a time.

The `file` command fills the gap: file-level scope (like `explain`) but with relationship data (like `context`).

### Key Infrastructure Available

| Component | Location | What it provides |
|---|---|---|
| `RFDBServerBackend.queryNodes({file})` | `packages/core/src/storage/backends/RFDBServerBackend.ts:534` | Query all nodes in a file (server-side filter) |
| `backend.getOutgoingEdges(id, types)` | Same file, line 602 | Get specific edge types from a node |
| `backend.getIncomingEdges(id, types)` | Same file, line 611 | Get specific edge types to a node |
| `FileExplainer` | `packages/core/src/core/FileExplainer.ts` | Existing file->nodes query + grouping by type |
| `formatLocation()` | `packages/cli/src/utils/formatNode.ts` | Relative path formatting |
| `getCodePreview()` | `packages/cli/src/utils/codePreview.ts` | Source line extraction |
| `Spinner` | `packages/cli/src/utils/spinner.ts` | CLI loading indicator |
| `exitWithError()` | `packages/cli/src/utils/errorFormatter.ts` | Consistent error formatting |

### Graph Structure for Files

The graph stores files as follows:
```
MODULE node (file=absolute_path, type=MODULE)
  -[CONTAINS]-> FUNCTION nodes (top-level functions)
  -[CONTAINS]-> CLASS nodes
    -[CONTAINS]-> FUNCTION nodes (methods)
  -[CONTAINS]-> VARIABLE nodes
  -[CONTAINS]-> IMPORT nodes
  -[CONTAINS]-> EXPORT nodes
  -[CONTAINS]-> CALL nodes
  -[CONTAINS]-> SCOPE nodes (block structure)
```

Each entity node has edges:
- `CALLS` — what functions this one calls
- `RETURNS` — what it returns (or return type info)
- `IMPORTS`/`IMPORTS_FROM` — import relationships
- `EXPORTS`/`EXPORTS_TO` — export relationships
- `ASSIGNED_FROM` — data flow
- `EXTENDS` — class inheritance
- `THROWS` — error throwing

## 2. Design

### Core Class: `FileOverview` (in `packages/core/`)

New class `FileOverview` in `packages/core/src/core/FileOverview.ts`.

**Why a core class, not just CLI code?** Because the same logic is needed for both CLI (`grafema file`) and MCP (`get_file_overview` tool). The pattern matches `FileExplainer` -- core logic in `packages/core/`, thin CLI/MCP wrappers.

#### Data Flow

```
file path (relative or absolute)
  |
  v
1. Resolve to absolute path (same as explain command)
  |
  v
2. Find MODULE node via queryNodes({file: absolutePath, type: 'MODULE'})
  |
  v
3. Get CONTAINS edges from MODULE -> collect top-level entities
  |
  v
4. For each entity, get "interesting" edges:
   - FUNCTION/METHOD: CALLS outgoing, RETURNS outgoing
   - CLASS: EXTENDS outgoing, CONTAINS for methods
   - VARIABLE: ASSIGNED_FROM outgoing (to show value source)
  |
  v
5. For classes: recursively get methods via CONTAINS, then each method's edges
  |
  v
6. Collect IMPORT nodes (src of IMPORTS edges pointing out of MODULE)
   Collect EXPORT nodes (CONTAINS edges where dst.type === 'EXPORT')
  |
  v
7. Build FileOverviewResult
```

#### Key Types

```typescript
interface FileOverviewResult {
  file: string;
  status: 'ANALYZED' | 'NOT_ANALYZED';
  imports: ImportInfo[];
  exports: ExportInfo[];
  classes: ClassOverview[];
  functions: FunctionOverview[];
  variables: VariableOverview[];
}

interface ImportInfo {
  source: string;       // module path
  specifiers: string[]; // imported names
  id: string;           // semantic ID
}

interface ExportInfo {
  name: string;
  isDefault: boolean;
  id: string;
}

interface FunctionOverview {
  name: string;
  id: string;
  line?: number;
  async: boolean;
  params?: string[];
  calls: string[];      // names of called functions
  returns?: string;      // return type if known
  signature?: string;
}

interface ClassOverview {
  name: string;
  id: string;
  line?: number;
  extends?: string;
  exported: boolean;
  methods: FunctionOverview[];
}

interface VariableOverview {
  name: string;
  id: string;
  line?: number;
  kind: string;       // const/let/var
  assignedFrom?: string; // source description
}
```

### Edge Selection Strategy

**Critical design decision:** which edges to fetch per entity.

We do NOT want to dump all edges (that's what `context` does). We want a curated summary. For each node type, we fetch only "interesting" edges:

| Node Type | Outgoing Edges to Fetch | Incoming Edges to Fetch |
|---|---|---|
| FUNCTION | CALLS, RETURNS, THROWS | (none for overview) |
| CLASS | EXTENDS, IMPLEMENTS | (none) |
| METHOD (via CLASS->CONTAINS) | CALLS, RETURNS, THROWS | (none) |
| VARIABLE | ASSIGNED_FROM | (none) |
| IMPORT | IMPORTS, IMPORTS_FROM | (none) |
| EXPORT | EXPORTS | (none) |

This is O(m) where m = number of top-level entities in the file (typically 5-50). NOT O(n) over all graph nodes. Each entity fetches 1-3 targeted edge queries. Total: maybe 20-150 edge queries per file. Perfectly fine.

### Filtering Out Internal Noise

Top-level means: direct children of MODULE via CONTAINS edges, filtered to "interesting" types:
- FUNCTION, CLASS, VARIABLE, CONSTANT, IMPORT, EXPORT
- Skip: SCOPE, CALL, EXPRESSION, PARAMETER, LITERAL, BRANCH, CASE, LOOP, TRY_BLOCK, etc.

For class methods: children of CLASS via CONTAINS, type=FUNCTION (methods are stored as FUNCTION nodes with `isClassMethod=true` or under CLASS->CONTAINS).

For the CALLS edges on functions: resolve the destination node to get the target function name. If unresolved (no CALLS edge target), show the callee name from the CALL node itself.

## 3. Files to Create / Modify

### New Files

| File | Purpose |
|---|---|
| `packages/core/src/core/FileOverview.ts` | Core class: file -> structured overview with relationships |
| `packages/cli/src/commands/file.ts` | CLI command: `grafema file <path>` |
| `test/unit/FileOverview.test.js` | Unit tests for the core class |

### Modified Files

| File | Change |
|---|---|
| `packages/cli/src/cli.ts` | Add `fileCommand` import and `program.addCommand(fileCommand)` |
| `packages/core/src/index.ts` (or barrel) | Export `FileOverview` class |
| `packages/mcp/src/definitions.ts` | Add `get_file_overview` tool definition |
| `packages/mcp/src/handlers.ts` | Add `handleGetFileOverview` handler |
| `packages/mcp/src/types.ts` | Add `GetFileOverviewArgs` interface |
| `packages/mcp/src/server.ts` | Add case in switch for `get_file_overview` |

### NOT Modified

- `FileExplainer` -- it serves a different purpose (node discovery). We do not extend it; we create a sibling. `FileOverview` queries edges; `FileExplainer` does not.
- `GraphBackend` abstract class -- we use existing `queryNodes`, `getOutgoingEdges`, `getNode`. No new abstract methods needed.

## 4. CLI Command Design

```
grafema file <path> [options]

Options:
  -p, --project <path>   Project path (default: .)
  -j, --json             Output as JSON
  --no-edges             Skip edge resolution (faster, just list entities)
```

### Path Resolution

Same logic as `explain` command:
1. Handle relative paths (`./src/file.ts`)
2. Handle absolute paths
3. `realpathSync()` to handle symlinks (critical on macOS: `/tmp` -> `/private/tmp`)
4. Verify file exists on disk

### Output Format (text)

```
Module: src/core/Axios.js
Imports: utils, buildURL, InterceptorManager, dispatchRequest, mergeConfig
Exports: Axios (default)

Classes:
  Axios (line 15)
    constructor(config)       -> mergeConfig
    request(configOrUrl)      -> buildURL, dispatchRequest
    getUri(config)            -> buildURL

Functions:
  forEachMethodNoData(fn)     (line 120)
  forEachMethodWithData(fn)   (line 130)

Variables:
  const methodsNoData         (line 140)
  const methodsWithData       (line 150)
```

Design choices:
- **Compact.** This is NOT `context`. The whole point is to fit on one screen.
- **Relationships inline.** `-> calledFn1, calledFn2` after each function/method.
- **Line numbers** for navigation.
- **No code preview.** User can use `context` for that.
- **Sorted by line number** within each group, for natural reading order.

### Output Format (JSON)

Full `FileOverviewResult` struct. MCP tool returns the same JSON.

## 5. MCP Tool Design

```
Tool: get_file_overview
Description: Get a structured overview of all entities in a file with their relationships.
             Shows imports, exports, classes, functions, and variables with key edges
             (CALLS, RETURNS, EXTENDS). Use this for file-level understanding before
             diving into specific nodes with get_context.

Input:
  file: string (required) - File path (relative to project root)
  include_edges: boolean (default: true) - Include relationship edges

Output: Text summary + JSON detail (same pattern as get_context)
```

## 6. Complexity Analysis

**Per-file cost:**
- 1 `queryNodes({file, type: MODULE})` to find the MODULE node
- 1 `getOutgoingEdges(moduleId, ['CONTAINS'])` to get top-level entities
- For each of ~N top-level entities: 1-2 `getOutgoingEdges` calls (CALLS, RETURNS, etc.)
- For each class: 1 additional `getOutgoingEdges(classId, ['CONTAINS'])` for methods
- For each method: 1-2 `getOutgoingEdges` calls

**Total:** O(N) where N = entities in file. Typical file: 10-50 entities. Each edge query is a single round-trip to RFDB server. ~50-200 round-trips per file. At <1ms per round-trip, total <200ms.

**No full-graph scans.** We never iterate all nodes. We start from a specific file, follow CONTAINS edges down, then fetch targeted edge types. This is exactly the "forward registration" pattern Grafema uses.

## 7. Risks and Unknowns

### Low Risk
- **Path resolution edge cases.** Already solved in `explain` command; copy the same approach.
- **Missing MODULE node.** If file not analyzed, return `NOT_ANALYZED` status (same as `FileExplainer`).

### Medium Risk
- **Method resolution under CLASS.** The graph stores class methods as FUNCTION nodes connected via CONTAINS from CLASS. Need to verify this is consistent. If some methods are stored differently (e.g., METHOD type instead of FUNCTION), the query needs to handle both. **Mitigation:** Check both FUNCTION and METHOD types in CONTAINS children.
- **CALLS edge target resolution.** A FUNCTION's scope CONTAINS CALL nodes, and those CALL nodes have CALLS edges to target FUNCTIONs. But the FUNCTION itself does NOT directly have CALLS edges. We need to walk: FUNCTION -> HAS_SCOPE -> SCOPE -> CONTAINS -> CALL -> CALLS -> target. This is the same traversal `findCallsInFunction` already does. **Mitigation:** Reuse `findCallsInFunction` from core.

### Design Decision
- **Depth of CALLS display.** The `file` command should show DIRECT calls only, not transitive. Transitive analysis is what `impact` and `get_function_details --transitive` are for. For the `file` command, we list called function names, period.

## 8. Prior Art

The most directly comparable feature in other tools:
- **LSP Document Symbols** (`textDocument/documentSymbol`): Shows hierarchical outline of a file (classes, methods, functions). Rust-analyzer, TypeScript server, etc. all implement this. But it shows NO cross-file relationships.
- **CodeQL database schema**: Has file-level entity querying, but no single "show me the file" command.
- **ctags/etags**: Flat symbol index per file, no relationships.

What we're building is LSP Document Symbols + relationship edges -- specifically designed for AI agent consumption. No other tool does this in a single command. This is a genuine product differentiator.

## 9. Implementation Order

1. **Core class** (`FileOverview.ts`) + unit tests -- the heart of the feature
2. **CLI command** (`file.ts`) -- thin wrapper, follows existing patterns exactly
3. **MCP tool** (definitions + handler + server wiring) -- thin wrapper
4. **Integration test** with a real analyzed file

Each step is independently testable and commitable.

## 10. Reuse Inventory

| Need | Reuse |
|---|---|
| Query nodes by file | `backend.queryNodes({file})` |
| Find calls in a function | `findCallsInFunction()` from core |
| Resolve file paths | Same pattern as `explain` command |
| Format output | `formatLocation()` from CLI utils |
| MCP tool wiring | Same pattern as `get_context` tool |
| Error handling | `exitWithError()` from CLI utils |
| Spinner | `Spinner` from CLI utils |

**Nothing new to build outside the core `FileOverview` class and the two thin wrappers.**
