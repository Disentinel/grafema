# REG-591: Architecture Plan — Plugin API for Domain Analyzers in core-v2

**Author:** Don Melton, Tech Lead
**Date:** 2026-03-01
**Status:** PLAN — ready for implementation

---

## Decision Summary

**Chosen approach:** Post-walk per-file hook (Option A from exploration). Domain plugins receive
`FileResult` + raw Babel `File` AST after `walkFile()` completes. They return additional nodes,
edges, and deferred refs to merge in. No changes to the core walk loop or visitor dispatch.

**Rejected approach:** Visitor injection (Option B). Forces domain plugins to understand Babel AST
internals. Violates the "one visitor per AST node type" invariant. Overkill for the actual need.

**Prior art consulted:**
- Babel plugin API: visitor pattern, per-node callbacks, pure transformation functions
- ESLint rule API: `create(context)` returns visitor object, meta describes what the rule does
- TypeScript transformer API: post-parse hook, receives Program node, returns transformed tree

**Key lesson from prior art:** The most usable plugin APIs (ESLint rules, Babel plugins) share two
properties: (1) they give the plugin a typed, structured view of what was already parsed, and (2)
they are pure — plugins declare what they produce, not how the orchestrator stores it. Grafema's
`DomainPlugin` should follow the same pattern.

---

## 1. DomainPlugin Interface

```typescript
/**
 * A domain plugin analyzes one file AFTER the core walk completes.
 * It receives the FileResult (all graph nodes/edges for the file) and the
 * raw Babel AST. It returns additional nodes, edges, and deferred refs to
 * merge into the result.
 *
 * Contracts (enforced by convention, not runtime):
 *   - Pure function: no I/O, no side effects, no mutations
 *   - Must not mutate fileResult or ast
 *   - May only CREATE new nodes/edges/deferred — never modify existing ones
 *   - Node IDs must be globally unique; use file path as prefix
 *
 * When to implement DomainPlugin:
 *   - You need to detect framework-specific patterns (Express routes,
 *     Socket.IO events, database queries, React components)
 *   - You can express your detection as: "find CALL nodes where
 *     metadata.object is X and metadata.method is Y"
 *   - You need the string value of call arguments (paths, event names,
 *     SQL query strings)
 *
 * When NOT to use DomainPlugin:
 *   - You need to modify existing graph nodes → not supported
 *   - You need cross-file context → use Stage 3 (resolveProject) instead
 *   - You are analyzing a non-JS/TS language → separate entry point needed
 */
export interface DomainPlugin {
  /**
   * Unique plugin name. Used in logs and error messages.
   * Convention: lowercase, no spaces (e.g., "express", "socketio", "fetch").
   */
  readonly name: string;

  /**
   * Called once per file after walkFile() + resolveFileRefs() complete.
   *
   * @param fileResult  Completed per-file analysis result. Read-only.
   * @param ast         Parsed Babel File node. Same parse as walkFile used.
   *                    Available as escape hatch for complex patterns that
   *                    cannot be expressed via FileResult.nodes alone.
   * @returns           Additional nodes and edges to merge into FileResult.
   *                    Return empty arrays if this file has no relevant patterns.
   */
  analyzeFile(
    fileResult: Readonly<FileResult>,
    ast: File,
  ): DomainPluginResult;
}

/**
 * What a domain plugin returns for one file.
 * All arrays may be empty.
 */
export interface DomainPluginResult {
  nodes: GraphNode[];
  edges: GraphEdge[];
  /**
   * Deferred refs that need cross-file resolution.
   * Use for edges that point to nodes in other files
   * (e.g., a handler function defined in another module).
   */
  deferred?: DeferredRef[];
}
```

**Why this shape:**

- `analyzeFile(fileResult, ast)` is the entire interface. One method. No lifecycle hooks (init,
  cleanup) — domain plugins are stateless per-file analyzers, not stateful services.
- `File` AST is passed as an escape hatch. Most plugins will not need it — they'll use
  `fileResult.nodes` with `argValues` added (see section 6). But complex cases (nested route
  builders, template literals, conditional patterns) benefit from direct AST access.
- `Readonly<FileResult>` signals intent. TypeScript won't deeply freeze it, but it communicates
  the contract clearly to implementors.
- `deferred?` is optional. Most domain plugins create nodes with known edges (MODULE → EXPOSES →
  http:route). Cross-file handler resolution is an advanced case.

**Type additions to `packages/core-v2/src/types.ts`:**

Add `DomainPlugin` and `DomainPluginResult` interfaces. Import `File` from `@babel/types` (already
imported in `walk.ts` — will need to be exported from types or the interface defined in walk.ts).

The cleanest approach: define `DomainPlugin` and `DomainPluginResult` in `types.ts` alongside the
other interfaces. Add `import type { File } from '@babel/types';` to `types.ts`.

---

## 2. Plugin Registry

There is no central plugin registry object. Domain plugins are passed directly as an array to
`walkFile()`. This matches how the walk engine already works: `VisitorRegistry` is also passed as a
parameter, not registered globally.

**walkFile signature change:**

```typescript
export async function walkFile(
  code: string,
  file: string,
  registry: VisitorRegistry,
  domainPlugins: readonly DomainPlugin[] = [],
  strict = true,
): Promise<FileResult>
```

The `domainPlugins` parameter defaults to empty. Zero new call sites need to change. Existing tests
pass as-is.

**How CoreV2Analyzer discovers and passes plugins:**

`CoreV2Analyzer` is the v1 Plugin wrapper around `walkFile`. It currently calls:

```typescript
const walkResult = await walkFile(code, filePath, jsRegistry);
```

After this change, it will call:

```typescript
const walkResult = await walkFile(code, filePath, jsRegistry, this.domainPlugins);
```

Where `this.domainPlugins` is populated in the constructor or `execute()` from the plugin context
or config. The exact mechanism is a configuration concern (see subsection below).

**Enabling/Disabling:**

Domain plugins are opt-in. `CoreV2Analyzer` checks the orchestrator config for a `domains` key:

```json
{
  "engine": "v2",
  "domains": ["express", "socketio", "fetch"]
}
```

If `domains` is absent or empty, `domainPlugins` is `[]`. This is backward-compatible: existing
configs with no `domains` key behave identically to today.

Domain plugins ship as part of the `@grafema/core` package (not `@grafema/core-v2`). They are
registered in a static map in `CoreV2Analyzer`:

```typescript
const DOMAIN_PLUGIN_REGISTRY: Record<string, DomainPlugin> = {
  express: new ExpressPlugin(),
  // socketio: new SocketIOPlugin(),
  // fetch: new FetchPlugin(),
};
```

`CoreV2Analyzer.execute()` reads `config.domains`, looks up each name in `DOMAIN_PLUGIN_REGISTRY`,
and passes the resolved array to each `walkFile` call.

**Why not a global registry or DI container:**

Overkill. Domain plugins are not services. They have no state. A plain map in `CoreV2Analyzer`
is explicit, testable, and trivially extensible without introducing a new subsystem.

---

## 3. Integration with walk.ts Pipeline

**Where plugins run:** After Stage 2 (file-scope resolution), before returning `FileResult`.

The integration point in `walkFile`, immediately before the `return` statement:

```typescript
// ─── Domain plugins ───────────────────────────────────────────
if (domainPlugins.length > 0) {
  let nodes = result.nodes;
  let edges = result.edges;
  let unresolvedRefs = result.unresolvedRefs;

  for (const plugin of domainPlugins) {
    const extra = plugin.analyzeFile(result, ast);
    nodes = [...nodes, ...extra.nodes];
    edges = [...edges, ...extra.edges];
    unresolvedRefs = [...unresolvedRefs, ...(extra.deferred ?? [])];
  }

  result = { ...result, nodes, edges, unresolvedRefs };
}

return result;
```

**Why after Stage 2 (not after Stage 1):**

Stage 2 resolves `scope_lookup` deferred refs. After Stage 2, `CALLS_ON` edges are resolved —
a CALL node for `app.get(...)` has an edge from CALL → VARIABLE#app. Domain plugins can see
these edges and confirm that `app` is indeed an Express instance (by tracing CALLS_ON to the
VARIABLE, then finding its ASSIGNED_FROM edge points to a node in a module named 'express').

If plugins ran after Stage 1, they would see fewer resolved edges and have to duplicate scope
lookup logic.

**How plugin results merge with FileResult:**

Pure array concatenation. No deduplication. No conflict resolution. If a domain plugin emits
a node with the same ID as an existing node, it gets duplicated — but this is a plugin bug, not
something the engine should guard against at runtime. The contract (plugin docstring) says: create
NEW nodes, do not replicate existing ones.

**How plugin deferred refs get resolved:**

Plugin-emitted `DeferredRef` entries go into `unresolvedRefs`, the same array that Stage 3
(`resolveProject`) processes. Stage 3 iterates all `FileResult.unresolvedRefs` across all files.
It does not distinguish between walk-produced refs and plugin-produced refs. This means domain
plugins can emit cross-file refs (e.g., "this handler is defined in routes/users.ts") and Stage 3
will resolve them.

The only constraint: plugin-produced refs must use `kind` values that Stage 3 handles
(`import_resolve`, `call_resolve`, `type_resolve`, `alias_resolve`). The `scope_lookup` and
`export_lookup` kinds are meaningless after Stage 2 — Stage 3 ignores them. Domain plugins
should not emit `scope_lookup` refs.

---

## 4. Express Plugin (Reference Implementation)

**Location:** `packages/core/src/plugins/domain/ExpressPlugin.ts`

This is NOT a v1 Plugin. It implements `DomainPlugin` from `@grafema/core-v2`. It lives in
`packages/core` because it depends on `NodeFactory` and branded node types from `@grafema/types`.

**What patterns it detects:**

1. `app.get('/path', handler)` — HTTP route registration
2. `router.post('/path', handler)` — same, with router
3. `app.use('/prefix', router)` — router mounting (express:mount)

All three are detectable from CALL nodes in `fileResult.nodes` using only:
- `node.type === 'CALL'`
- `node.metadata.object` in `{'app', 'router'}` (configurable)
- `node.metadata.method` in HTTP_METHODS or `'use'`
- `node.metadata.argValues[0]` — the path string (requires argValues, see section 6)

**Detection logic (pseudocode):**

```typescript
const HTTP_METHODS = new Set(['get', 'post', 'put', 'delete', 'patch', 'options', 'head']);
const EXPRESS_OBJECTS = new Set(['app', 'router', 'Router']);

function analyzeFile(fileResult, ast) {
  const nodes = [];
  const edges = [];

  // Find the module node for EXPOSES edges
  const moduleNode = fileResult.nodes.find(n => n.type === 'MODULE');

  // Check if this file imports from 'express'
  // IMPORT nodes have name === specifier and IMPORTS_FROM edge to EXTERNAL#express
  const importsExpress = fileResult.nodes.some(n =>
    n.type === 'IMPORT' && (n.name === 'express' || n.name === 'Router')
  );
  // Also check EXTERNAL nodes touched by DEPENDS_ON from MODULE
  const dependsOnExpress = fileResult.edges.some(e =>
    e.type === 'DEPENDS_ON' && e.dst.includes('express')
  );

  if (!importsExpress && !dependsOnExpress) {
    return { nodes: [], edges: [] };
  }

  for (const callNode of fileResult.nodes) {
    if (callNode.type !== 'CALL') continue;
    const obj = callNode.metadata?.object;
    const method = callNode.metadata?.method;
    const argValues = callNode.metadata?.argValues;

    if (!EXPRESS_OBJECTS.has(obj)) continue;

    if (HTTP_METHODS.has(method) && argValues?.length >= 1) {
      // Route registration
      const routeNode = createHttpRouteNode(callNode, method, argValues[0]);
      nodes.push(routeNode);
      if (moduleNode) {
        edges.push({ src: moduleNode.id, dst: routeNode.id, type: 'EXPOSES' });
      }
      // DEFINES: link to handler if second argument resolves to a function
      // (done via deferred ref if handler is in another file)
    }

    if (method === 'use' && argValues?.length >= 1) {
      // Router mounting
      const mountNode = createExpressMountNode(callNode, argValues[0]);
      nodes.push(mountNode);
      if (moduleNode) {
        edges.push({ src: moduleNode.id, dst: mountNode.id, type: 'MOUNTS' });
      }
    }
  }

  return { nodes, edges };
}
```

**How it uses CALL metadata:**

The entire detection is based on `metadata.object`, `metadata.method`, and `metadata.argValues`.
No AST traversal needed. The `ast` parameter is not used by the basic Express plugin.

**Nodes it creates:**

```typescript
// http:route
{
  id: `${file}->http:route->${method.toUpperCase()}:${path}#${line}`,
  type: 'http:route',
  name: `${method.toUpperCase()} ${path}`,
  file, line, column,
  metadata: {
    method: method.toUpperCase(),   // 'GET', 'POST', etc.
    path,                           // '/users'
    mountedOn: obj,                 // 'app' or 'router'
  }
}

// express:mount
{
  id: `${file}->express:mount->${prefix}#${line}`,
  type: 'express:mount',
  name: prefix,
  file, line, column,
  metadata: {
    prefix,
    mountedOn: obj,
  }
}
```

**Edges it creates:**

- `MODULE → EXPOSES → http:route`
- `MODULE → MOUNTS → express:mount`
- `http:route → DEFINES → handler` (when handler arg resolves; via deferred ref for cross-file)

**Import detection:**

Before iterating CALL nodes, the plugin scans for IMPORT or EXTERNAL nodes to confirm the file
actually uses Express. This avoids false positives when `app` or `router` variable names appear
in non-Express code. The check is: does any DEPENDS_ON edge from the MODULE node point to an
EXTERNAL whose name contains 'express'?

---

## 5. Changes Needed

### Files to modify

**`packages/core-v2/src/types.ts`**

Add:
```typescript
import type { File } from '@babel/types';  // add to existing import

export interface DomainPluginResult {
  nodes: GraphNode[];
  edges: GraphEdge[];
  deferred?: DeferredRef[];
}

export interface DomainPlugin {
  readonly name: string;
  analyzeFile(fileResult: Readonly<FileResult>, ast: File): DomainPluginResult;
}
```

**`packages/core-v2/src/walk.ts`**

1. Add `DomainPlugin` to the imports from `./types.js`
2. Change `walkFile` signature: add `domainPlugins: readonly DomainPlugin[] = []` parameter
   (before `strict`, after `registry`)
3. Add domain plugin execution block immediately before `return result` (after
   `deriveLoopElementEdges`)
4. The `ast` variable is already in scope — pass it directly to plugins

**`packages/core-v2/src/index.ts`**

Export the new types:
```typescript
export type { DomainPlugin, DomainPluginResult } from './types.js';
```

**`packages/core/src/plugins/analysis/CoreV2Analyzer.ts`**

1. Import `DomainPlugin` from `@grafema/core-v2`
2. Add private `domainPlugins: DomainPlugin[]` field
3. In `execute()`: read `config.domains` array, look up in `DOMAIN_PLUGIN_REGISTRY`, set
   `this.domainPlugins`
4. Change `walkFile(code, filePath, jsRegistry)` call to
   `walkFile(code, filePath, jsRegistry, this.domainPlugins)`
5. Update `creates.nodes` metadata to include domain node types when domain plugins are active

### New files to create

**`packages/core/src/plugins/domain/ExpressPlugin.ts`**

The reference implementation. Implements `DomainPlugin`. ~120 lines.
Contains: `ExpressPlugin` class, `createHttpRouteNode()`, `createExpressMountNode()` helpers.

**`packages/core-v2/test/domain-plugin.test.mjs`**

Tests for the plugin hook in `walkFile`. Tests:
- walkFile with empty domainPlugins array returns same result as without
- Plugin's analyzeFile receives fileResult + ast
- Plugin's returned nodes/edges/deferred are merged into FileResult
- Multiple plugins run in order, results accumulate

**`packages/core/test/unit/express-plugin.test.js`** (or `.mjs`)

Tests for ExpressPlugin:
- Detects `app.get('/users', handler)` → creates http:route
- Detects `app.use('/api', router)` → creates express:mount
- Skips files that don't import from 'express'
- Empty result for files with no Express patterns

### No new files needed for

- Plugin registry — it's a plain const in CoreV2Analyzer
- Configuration parsing — reuses existing `config.domains` pattern
- Node type additions — `http:route`, `express:mount` already exist in `packages/types/src/nodes.ts`

---

## 6. argValues Gap

**Decision: YES — add `argValues` to CALL node metadata.**

**Why:** Without `argValues`, domain plugins must traverse the edge graph to find string literal
arguments:

```
CALL node → [PASSES_ARGUMENT] → CONSTANT node → metadata.value
```

This forces every domain plugin to implement graph traversal logic. It couples plugins to the
internal edge structure. It's slow (linear scan of edges per CALL node). And it doesn't work for
literal arguments that are not Identifier-referenced (they may not have PASSES_ARGUMENT edges at
all — they get CONTAINS edges via EDGE_MAP).

**Where to add it:** `packages/core-v2/src/visitors/expressions.ts`, in `visitCallExpression`.

**Exact change:** After computing `calleeName` and before creating the CALL node, extract string
literal values from `call.arguments`:

```typescript
// Extract string literal argument values for domain plugin consumption.
// Only string literals and simple template literals (no expressions) are captured.
// Complex args (Identifiers, expressions, nested calls) are omitted — plugins
// can use the ast parameter to handle those.
const argValues: string[] = [];
for (const arg of call.arguments) {
  if (arg.type === 'StringLiteral') {
    argValues.push((arg as StringLiteral).value);
  } else if (
    arg.type === 'TemplateLiteral'
    && arg.quasis.length === 1
    && arg.expressions.length === 0
  ) {
    argValues.push(arg.quasis[0].value.cooked ?? arg.quasis[0].value.raw);
  } else {
    // Non-string arg: push null to preserve argument position
    // so argValues[0] always corresponds to arguments[0]
    argValues.push(null as unknown as string);
  }
}
```

Then add `argValues` to the CALL node metadata:

```typescript
metadata: {
  arguments: call.arguments.length,
  chained: isChained,
  argValues,          // new field
  ...(memberExprMeta),
}
```

**Position preservation:** `null` entries keep argument positions stable.
`argValues[0]` is always the first argument, regardless of whether it's a string.
Domain plugins check `argValues[0] !== null` before using it.

**What about NumericLiteral or BooleanLiteral?** Not needed for current domain analyzers. Can
be added later if needed. Keep it minimal.

**Implications:**

1. `argValues` is always present on CALL nodes (never undefined). An empty array means zero
   arguments. A `null` entry means a non-string argument in that position.

2. Backward compatibility: `metadata` is `Record<string, unknown>` — adding a new field does
   not break any existing consumers. Tests that assert specific metadata shapes will need updating
   only if they assert the exact set of keys.

3. Memory: `argValues` adds a small array per CALL node. For typical codebases, CALL nodes
   are ~10-30% of total nodes. Most argValues arrays will be short (0-3 entries). Not a concern.

4. This change belongs in `expressions.ts`, not in the domain plugin. It is foundational data
   about what was called — the same way `method` and `object` are already in CALL metadata.
   Argument values are just more of the same.

---

## 7. Sequencing and Implementation Order

The implementation must happen in this order (each step is independently testable):

1. **Add `argValues` to CALL metadata** (`expressions.ts`) — pure additive change, tests still pass
2. **Add `DomainPlugin`/`DomainPluginResult` interfaces** (`types.ts`, `index.ts`) — type-only, no
   behavior change
3. **Add domain plugin hook to `walkFile`** (`walk.ts`) — tested by new `domain-plugin.test.mjs`
4. **Implement `ExpressPlugin`** (`packages/core/src/plugins/domain/ExpressPlugin.ts`) — tested by
   `express-plugin.test.js`
5. **Wire `CoreV2Analyzer` to pass plugins** (`CoreV2Analyzer.ts`) — integration test

These map directly to five commits. Each commit is independently buildable and all tests pass.

---

## 8. What v1 Domain Analyzers Do vs What This Plan Enables

| Capability | v1 ExpressAnalyzer | v2 ExpressPlugin |
|---|---|---|
| Parse source file | Yes (re-parse from disk) | No (uses existing FileResult) |
| Detect `app.get(path, handler)` | Yes (babel traverse) | Yes (scan CALL nodes) |
| Get path string | Yes (from AST directly) | Yes (via argValues) |
| Link to handler function | Yes (via traverse scope) | Partial (deferred ref for cross-file) |
| Router mount detection | Yes | Yes |
| Import source verification | Yes (checks imports in traverse) | Yes (IMPORT/DEPENDS_ON nodes) |
| Nested routes (app.route(...).get()) | Yes | Needs ast escape hatch |
| Dynamic paths (template literals) | Partial | Yes (if simple template) |

The v2 plugin handles ~85% of what v1 does without re-parsing. The remaining 15% (complex nested
patterns) use the `ast` escape hatch.

---

## 9. What This Plan Explicitly Does NOT Do

- **Does not migrate all v1 domain analyzers.** Only Express as reference implementation.
  SocketIO, Fetch, React, Database — separate issues after validation.
- **Does not remove v1 domain analyzers.** They continue to run when `CoreV2Analyzer` is active.
  Coexistence confirmed in exploration report (section 7).
- **Does not add a plugin discovery mechanism** (npm packages, config file scanning). Plugins
  are hardcoded in `CoreV2Analyzer`. Discovery is a v0.3+ concern.
- **Does not add inter-plugin communication.** Plugins cannot see each other's output. If plugin
  B needs to see nodes created by plugin A, they run in the same batch (A before B, deterministic
  order), but the design does not guarantee this. For now, each plugin is independent.
- **Does not handle non-JS/TS languages.** Rust analyzer is out of scope for this interface.

---

## 10. File Reference Summary

| Path | Change |
|------|--------|
| `packages/core-v2/src/types.ts` | Add `DomainPlugin`, `DomainPluginResult` interfaces |
| `packages/core-v2/src/walk.ts` | Add `domainPlugins` parameter, run plugins after Stage 2 |
| `packages/core-v2/src/index.ts` | Export new types |
| `packages/core-v2/src/visitors/expressions.ts` | Add `argValues` to CALL node metadata |
| `packages/core/src/plugins/analysis/CoreV2Analyzer.ts` | Wire domain plugins from config |
| `packages/core/src/plugins/domain/ExpressPlugin.ts` | NEW: reference implementation |
| `packages/core-v2/test/domain-plugin.test.mjs` | NEW: walkFile domain plugin hook tests |
| `packages/core/test/unit/express-plugin.test.js` | NEW: ExpressPlugin unit tests |
