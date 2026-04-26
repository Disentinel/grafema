# Don Melton Plan: Extract shared `buildNodeContext()` to `@grafema/core`

## Analysis of Parallel Implementations

### CLI (`packages/cli/src/commands/context.ts`)

**Data layer (lines 157-228):**
- `buildNodeContext()` — assembles `NodeContext` from backend: source preview + grouped outgoing/incoming edges
- `groupEdges()` — groups edges by type, resolves connected node for each edge, sorts structural after primary
- `STRUCTURAL_EDGE_TYPES` — 20-element `Set` defining compact-display edges
- Types: `EdgeWithNode`, `EdgeGroup`, `NodeContext`

**Presentation layer (lines 233-381):**
- `printContext()` — renders `NodeContext` to stdout with grep-friendly prefixes
- `printEdgeGroup()` — renders one edge group with code preview via `getCodePreview`/`formatCodePreview`
- `formatEdgeMetadata()` — inline edge metadata (arg index, mutation method, etc.)
- `getDisplayName()` — human-readable name for HTTP/Socket/default nodes

**Source preview:** Uses CLI's own `getCodePreview()` utility (reads file, slices lines).

---

### MCP (`packages/mcp/src/handlers.ts`, lines 1127-1309)

**Data layer (lines 1141-1209):**
- Inline in `handleGetContext()` — same logic as CLI but reimplemented:
  - Reads file with `readFileSync`, slices lines (duplicates `getCodePreview`)
  - Gets outgoing/incoming edges, filters by type
  - `resolveEdges()` — local function that groups by type + resolves nodes
  - `CONTEXT_STRUCTURAL_EDGES` — identical 20-element `Set`

**Presentation layer (lines 1211-1309):**
- Inline formatting to text lines + JSON result appended
- Renders code context inline for non-structural edges (duplicates `formatCodePreview` with 120-char truncation)

---

### Differences Between the Two

| Aspect | CLI | MCP |
|--------|-----|-----|
| Structural edges set | `STRUCTURAL_EDGE_TYPES` | `CONTEXT_STRUCTURAL_EDGES` |
| Values in set | **Identical** | **Identical** |
| Edge grouping sort | structural-last, then alphabetical | alphabetical only (no structural-last) |
| Source preview | `getCodePreview()` utility (80-char truncation) | inline `readFileSync` (120-char truncation) |
| Code context for edges | via `getCodePreview` + `formatCodePreview` | inline `readFileSync` with 120-char truncation |
| Edge metadata display | `formatEdgeMetadata()` (arg index, mutation, property, iterates) | Not present |
| Display name logic | `getDisplayName()` (HTTP, SocketIO, default) | `node.name \|\| node.id` only |
| Output format | Grep-friendly text OR JSON | Text + JSON appended |
| Result type | `NodeContext` (typed interface) | Ad-hoc `jsonResult` object |
| Backend type | `RFDBServerBackend` (concrete) | `GraphBackend` via `ensureAnalyzed()` |

---

## Plan

### 1. New file: `packages/core/src/queries/NodeContext.ts`

This follows the pattern of `packages/core/src/queries/index.ts` which already exports `findCallsInFunction`, `findContainingFunction`, etc. Node context building is a graph query operation.

**Shared constants:**
```typescript
export const STRUCTURAL_EDGE_TYPES = new Set([
  'CONTAINS', 'HAS_SCOPE', 'DECLARES', 'DEFINES',
  'HAS_CONDITION', 'HAS_CASE', 'HAS_DEFAULT',
  'HAS_CONSEQUENT', 'HAS_ALTERNATE', 'HAS_BODY',
  'HAS_INIT', 'HAS_UPDATE', 'HAS_CATCH', 'HAS_FINALLY',
  'HAS_PARAMETER', 'HAS_PROPERTY', 'HAS_ELEMENT',
  'USES', 'GOVERNS', 'VIOLATES', 'AFFECTS', 'UNKNOWN',
]);
```

**Shared types:**
```typescript
export interface EdgeWithNode {
  edge: EdgeRecord;
  node: BaseNodeRecord | null;
}

export interface EdgeGroup {
  edgeType: string;
  edges: EdgeWithNode[];
}

export interface SourcePreview {
  file: string;
  startLine: number;
  endLine: number;
  lines: string[];
}

export interface NodeContext {
  node: BaseNodeRecord;
  source: SourcePreview | null;
  outgoing: EdgeGroup[];
  incoming: EdgeGroup[];
}
```

**Shared function:**
```typescript
export interface BuildNodeContextOptions {
  contextLines?: number;         // default: 3
  edgeTypeFilter?: Set<string> | null;
  readFileContent?: (filePath: string) => string | null;  // DI for file reading
}

export async function buildNodeContext(
  backend: GraphBackend,
  node: BaseNodeRecord,
  options?: BuildNodeContextOptions,
): Promise<NodeContext>
```

**Internal helper:**
```typescript
async function groupEdges(
  backend: GraphBackend,
  edges: EdgeRecord[],
  nodeField: 'src' | 'dst',
  edgeTypeFilter: Set<string> | null,
): Promise<EdgeGroup[]>
```

**Key design decisions:**
- `readFileContent` callback for DI: CLI can use `readFileSync`, MCP can use `readFileSync`, tests can mock. This avoids importing `fs` in core query logic.
- Default `readFileContent` reads from filesystem (so callers don't have to pass it for normal usage).
- Sort order: structural-last then alphabetical (CLI's current behavior is more useful than MCP's alphabetical-only).
- Source preview context: `contextBefore = contextLines`, `contextAfter = contextLines + 12` (CLI's current formula).

**Display name helper (also shared):**
```typescript
export function getNodeDisplayName(node: BaseNodeRecord): string
```

This covers HTTP routes/requests, SocketIO events, and the default name/id fallback. Useful for both CLI and MCP.

**Edge metadata formatter (also shared):**
```typescript
export function formatEdgeMetadata(edge: EdgeRecord): string
```

MCP doesn't use this today but should -- it's useful context for AI agents.

### 2. Export from `packages/core/src/queries/index.ts`

Add re-exports:
```typescript
export {
  buildNodeContext,
  groupEdges,  // not exported - internal
  getNodeDisplayName,
  formatEdgeMetadata,
  STRUCTURAL_EDGE_TYPES,
} from './NodeContext.js';
export type {
  EdgeWithNode,
  EdgeGroup,
  SourcePreview,
  NodeContext,
  BuildNodeContextOptions,
} from './NodeContext.js';
```

Then `packages/core/src/index.ts` already re-exports everything from `queries/index.ts`, so no changes needed there.

### 3. What stays in CLI (`packages/cli/src/commands/context.ts`)

- Commander setup (argument parsing, options)
- Spinner UX
- `printContext()` — grep-friendly text rendering to stdout
- `printEdgeGroup()` — text rendering with code preview formatting via CLI's `formatCodePreview`
- JSON output mode (`--json`)

The CLI action becomes:
```typescript
const ctx = await buildNodeContext(backend, node, {
  contextLines,
  edgeTypeFilter,
});
```

Remove: `buildNodeContext()`, `groupEdges()`, `STRUCTURAL_EDGE_TYPES`, `EdgeWithNode`, `EdgeGroup`, `NodeContext` (all move to core).

Keep: `printContext`, `printEdgeGroup`, `formatEdgeMetadata` (CLI-specific formatting), `getDisplayName` (replace with `getNodeDisplayName` from core).

### 4. What stays in MCP (`packages/mcp/src/handlers.ts`)

- `handleGetContext()` — validates args, calls shared `buildNodeContext()`, formats output
- Text line formatting (the `formatEdgeGroup` local function and line assembly)
- JSON result construction
- `CONTEXT_STRUCTURAL_EDGES` removed entirely

The MCP handler becomes:
```typescript
const ctx = await buildNodeContext(db, node, {
  contextLines: ctxLines,
  edgeTypeFilter,
});
// Then format ctx into text + JSON as before
```

The MCP handler should also start using `getNodeDisplayName()` and `formatEdgeMetadata()` from core for richer output.

### 5. File placement summary

| File | Action |
|------|--------|
| `packages/core/src/queries/NodeContext.ts` | **NEW** — shared logic |
| `packages/core/src/queries/index.ts` | **EDIT** — add re-exports |
| `packages/cli/src/commands/context.ts` | **EDIT** — import from core, remove duplicated code |
| `packages/mcp/src/handlers.ts` | **EDIT** — import from core, remove duplicated code |

### 6. Tests

- `test/unit/node-context.test.ts` (or similar) — unit tests for `buildNodeContext`, `groupEdges`, `getNodeDisplayName`, `formatEdgeMetadata`
- Mock `GraphBackend` with known nodes/edges
- Verify: edge grouping, structural-last sort, edge type filtering, source preview extraction, display names for HTTP/SocketIO/default

### 7. Migration risk: LOW

- No public API changes (CLI and MCP produce same output)
- Both implementations already work; we're consolidating, not changing behavior
- The only behavioral difference: MCP gets structural-last sort (improvement) and edge metadata display (improvement)

### 8. Implementation order

1. Create `NodeContext.ts` with types, constants, `buildNodeContext`, `getNodeDisplayName`, `formatEdgeMetadata`
2. Write tests for the shared functions
3. Wire into CLI (remove duplicated code, import from core)
4. Wire into MCP (remove duplicated code, import from core)
5. Run full test suite to verify no regressions
