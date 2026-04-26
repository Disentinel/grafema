# REG-591: Exploration Report — Plugin API for Domain Analyzers

**Author:** Don Melton, Tech Lead
**Date:** 2026-03-01

---

## 1. Executive Summary

v1 has ~4,640 lines of domain-specific analyzers (ExpressAnalyzer, FetchAnalyzer, SocketIOAnalyzer, ReactAnalyzer, DatabaseAnalyzer, NestJSRouteAnalyzer, ServiceLayerAnalyzer, RustAnalyzer) baked into the ANALYSIS phase as discrete Plugin classes. They work by re-parsing source files with `@babel/traverse` after JSASTAnalyzer has already parsed them.

v2's walk engine is a clean, pure-functional three-stage pipeline (AST → GraphNode[]/GraphEdge[] per file, then cross-file resolution). It has no domain-specific logic at all. The plugin API must enable domain analyzers to run **within** or **after** the per-file walk — without re-parsing the file again.

The key architectural insight is: **v2 domain analyzers do not need a separate parse pass.** They can receive the same `CALL` and `PROPERTY_ACCESS` nodes the walk already produces, plus the raw AST if they need it, and emit additional domain nodes/edges.

---

## 2. core-v2 Architecture

### 2.1 File locations and sizes

```
packages/core-v2/src/
  walk.ts          607 lines  — Stage 1+2: AST → nodes/edges/deferreds
  resolve.ts      1022 lines  — Stage 2.5+3: file-level + cross-file resolution
  registry.ts      409 lines  — VisitorRegistry: maps AST types → visitor functions
  types.ts         192 lines  — All type definitions
  scope.ts         126 lines  — Scope tree: create, declare, lookup
  edge-map.ts      198 lines  — EDGE_MAP: parent.child → edge type overrides
  index.ts          25 lines  — Public exports

  visitors/
    declarations.ts  283 lines
    expressions.ts  1387 lines  (largest: handles CallExpression, assignments, etc.)
    statements.ts    584 lines
    classes.ts       209 lines
    modules.ts       352 lines
    literals.ts      147 lines
    typescript.ts   1344 lines
    misc.ts          361 lines
```

### 2.2 The three-stage pipeline

**Stage 1 (Walk):** `walkFile(code, file, registry)` in `walk.ts`

Single recursive pass over Babel AST. For every AST node, dispatches to `registry[node.type]`. Visitors are pure functions: `(node, parent, ctx) → VisitResult`.

`VisitResult` contains:
```typescript
interface VisitResult {
  nodes: GraphNode[];    // New graph nodes from this AST node
  edges: GraphEdge[];    // Immediate edges (parent → child, etc.)
  deferred: DeferredRef[]; // References that need resolution
}
```

The walk engine auto-manages:
- EDGE_MAP overrides (specific child relationships get semantic edge types)
- Scope push/pop (via `InternalWalkContext`)
- SCOPE node creation and HAS_SCOPE edges
- Function/class stack tracking for RETURNS, AWAITS, DECORATED_BY edges
- DECLARES edges (scope owner → declared node)

At the end of Stage 1, the walk emits a `FileResult`:
```typescript
interface FileResult {
  file: string;
  moduleId: string;
  nodes: GraphNode[];
  edges: GraphEdge[];
  unresolvedRefs: DeferredRef[];
  scopeTree: ScopeNode;
}
```

**Stage 2 (File-scope resolution):** `resolveFileRefs(result)` in `resolve.ts`

Resolves `scope_lookup` and `export_lookup` deferred refs against the file's own scope tree. Returns a new `FileResult` with resolved edges added and remaining unresolved refs.

**Stage 2.5 (Name-based file resolution):** Also in `resolveFileRefs()`.

After scope resolution, tries remaining unresolved refs against all declared nodes in the same file by name matching (catches forward refs).

**Stage 3 (Cross-file resolution):** `resolveProject(fileResults, builtins, packageMap)` in `resolve.ts`.

Takes all `FileResult[]`, builds `ProjectIndex`, resolves `import_resolve`, `call_resolve`, `type_resolve`, `alias_resolve` deferred refs across files.

### 2.3 WalkContext — what visitors receive

```typescript
interface WalkContext {
  file: string;       // Relative file path (used in node IDs)
  moduleId: string;   // e.g. "MODULE#src/app.ts"
  currentScope: ScopeNode;

  pushScope(kind: ScopeKind, id: string): ScopeNode;
  popScope(): void;
  declare(name: string, kind: DeclKind, nodeId: string): string | null;
  nodeId(type: string, name: string, line: number): string;
}
```

Internal fields (not in public interface but in `InternalWalkContext`):
- `_scopeStack: ScopeNode[]`
- `_functionStack: string[]` — enclosing FUNCTION/METHOD node IDs
- `_classStack: string[]` — enclosing CLASS node IDs
- `_declareEdges: GraphEdge[]`

### 2.4 How CALL nodes are produced

In `visitors/expressions.ts`, `visitCallExpression` creates a CALL node for every `CallExpression` AST node:

```typescript
{
  id: `${file}->CALL->${calleeName}#${line}`,
  type: 'CALL',
  name: calleeName,   // e.g. "app.get", "router.use", "socket.emit"
  file, line, column,
  metadata: {
    arguments: call.arguments.length,
    chained: boolean,
    method?: string,    // e.g. "get", "use", "emit"
    object?: string,    // e.g. "app", "router", "socket"
  }
}
```

This means Express patterns like `app.get('/users', handler)` appear in the graph as:
- `CALL` node with `name: "app.get"`, `metadata.method: "get"`, `metadata.object: "app"`
- `CALL` node also gets deferred `CALLS_ON` to the `app` variable via `scope_lookup`
- Arguments that are Identifiers get deferred `PASSES_ARGUMENT` via `scope_lookup`

### 2.5 VisitorRegistry

```typescript
type VisitorRegistry = Record<string, VisitorFn>;
type VisitorFn = (node: Node, parent: Node | null, ctx: WalkContext) => VisitResult;
```

The registry in `registry.ts` (`jsRegistry`) contains one entry per Babel AST node type (~100 entries). The walk throws a FATAL error if a node type has no visitor (Invariant 1).

**IMPORTANT:** The registry is a plain object. There is no existing plugin hook in it.

---

## 3. v1 Domain Analyzers — Patterns and Inputs/Outputs

### 3.1 Two families of analyzers

**Family A: Re-parse analyzers** — re-read the source file, run `@babel/traverse`, look for specific patterns, create domain nodes.

| Analyzer | Lines | Creates nodes | Creates edges |
|----------|-------|---------------|---------------|
| ExpressAnalyzer | 442 | `http:route`, `express:mount` | `EXPOSES`, `MOUNTS`, `DEFINES` |
| ExpressRouteAnalyzer | 479 | `http:route`, `express:middleware` | `ROUTES_TO`, `HANDLED_BY` |
| ExpressResponseAnalyzer | 610 | `http:route` variants | `RESPONDS_WITH` |
| FetchAnalyzer | 704 | `http:request`, `EXTERNAL` | `MAKES_REQUEST`, `CALLS_API` |
| SocketIOAnalyzer | 544 | `socketio:emit`, `socketio:on`, `socketio:room` | `EMITS_EVENT`, `LISTENS_TO`, `JOINS_ROOM` |
| ReactAnalyzer | 330 | `react:component`, `react:state`, hooks, `dom:event`, issue nodes | `RENDERS`, `PASSES_PROP`, `HANDLES_EVENT`, `UPDATES_STATE` |
| DatabaseAnalyzer | 354 | `db:query`, `db:connection` | `MAKES_QUERY`, `READS_FROM`, `WRITES_TO` |
| ServiceLayerAnalyzer | 468 | `SERVICE_CLASS`, `SERVICE_INSTANCE`, DI registration | `PROVIDES`, `CONSUMES` |

**Family B: Graph-query analyzers** — query the graph for nodes already created by JSASTAnalyzer, derive higher-level nodes from those.

| Analyzer | Lines | Inputs | Creates |
|----------|-------|--------|---------|
| NestJSRouteAnalyzer | 254 | Queries `DECORATOR` nodes from graph | `http:route` |
| RustAnalyzer | 455 | Parses `.rs` files (separate language) | Rust-specific nodes |

### 3.2 ExpressAnalyzer pattern in detail (reference implementation)

**Input:** MODULE nodes from graph (via `getModules(graph)`), then re-reads each file.

**Pattern detection:** Uses `@babel/traverse` to find:
```
app.get('/path', handler)    → http:route node
router.use('/prefix', router) → express:mount node
```

**What it looks for specifically:**
- `CallExpression` where `callee` is `MemberExpression`
- `callee.property.name` in `['get','post','put','delete','patch','options','head']`
- `callee.object.name` in `['app', 'router']`
- First argument is a string or template literal (the path)

**Node produced:**
```typescript
{
  type: 'http:route',
  method: 'GET',
  path: '/users',
  file: 'src/routes.ts',
  line: 15, column: 0,
  mountedOn: 'app'
}
```

**Edges produced:**
- `MODULE → EXPOSES → http:route`
- `http:route → DEFINES → handler_function` (when handler is a named function)
- `net:request → MOUNTS → http:route`

**Key problem with v1 approach:** It re-parses the file from disk, ignores any information JSASTAnalyzer already collected, and duplicates the entire Babel parse+traverse pipeline. Each domain analyzer is an independent island.

### 3.3 NestJSRouteAnalyzer — the graph-query approach

This analyzer is the closest analog to what v2 should enable for some patterns. Instead of re-parsing, it:
1. Queries the graph for `DECORATOR` nodes with `name: "Controller"` or HTTP method names
2. Correlates them by file proximity to find the controller class
3. Creates `http:route` nodes from the combination

This works because JSASTAnalyzer creates `DECORATOR` nodes with the decorator name and arguments. The problem is v2's walk produces CALL nodes with `name: "Get"` (from `@Get()`) as a CALL, not a DECORATOR node, because the decorator AST node visitor in v2 handles `Decorator.expression` as DECORATED_BY edge but doesn't create a named DECORATOR graph node.

### 3.4 What all re-parse analyzers actually need from the AST

Looking across all re-parse analyzers, they all follow this pattern:

```
find all CallExpression nodes where:
  callee.object.name ∈ {known objects: 'app', 'router', 'io', 'socket', 'fetch', 'axios', ...}
  AND callee.property.name ∈ {known methods: 'get', 'post', 'emit', 'on', 'query', ...}
  AND arguments[0] is a string literal (the path/event name/query)
```

**This is exactly the information in CALL nodes that walkFile already produces**, specifically in `metadata.object` and `metadata.method`. The only thing missing is: the argument values (the path/event name strings), and the link to which MODULE these calls belong to.

---

## 4. Key Types and Interfaces

### 4.1 core-v2 types (`packages/core-v2/src/types.ts`, 192 lines)

```typescript
GraphNode { id, type, name, file, line, column, exported?, metadata? }
GraphEdge { src, dst, type, metadata? }
VisitResult { nodes: GraphNode[], edges: GraphEdge[], deferred: DeferredRef[] }
FileResult { file, moduleId, nodes, edges, unresolvedRefs, scopeTree }
WalkContext { file, moduleId, currentScope, pushScope, popScope, declare, nodeId }
VisitorFn = (node: Node, parent: Node | null, ctx: WalkContext) => VisitResult
VisitorRegistry = Record<string, VisitorFn>
DeferredRef { kind, name, fromNodeId, edgeType, scopeId?, source?, file, line, column, receiver? }
```

### 4.2 v1 plugin types (`packages/types/src/plugins.ts`, 406 lines)

```typescript
IPlugin { config, metadata, initialize?, execute, cleanup? }
PluginMetadata { name, phase, creates?, dependencies?, covers?, managesBatch? }
PluginContext { graph, manifest?, config?, logger?, factory?, resources? }
PluginResult { success, created: {nodes, edges}, errors, warnings, metadata? }
PluginPhase = 'DISCOVERY' | 'INDEXING' | 'ANALYSIS' | 'ENRICHMENT' | 'VALIDATION'
```

### 4.3 Node types relevant to domain analyzers (`packages/types/src/nodes.ts`)

Namespaced types:
```
http:route, http:request
express:router, express:middleware, express:mount
socketio:emit, socketio:on, socketio:namespace
db:query, db:connection
redis:read, redis:write, redis:delete, redis:publish, redis:subscribe
fs:read, fs:write
net:request, net:stdio
event:listener, event:emit
react:* (not in NAMESPACED_TYPE, defined in ReactAnalyzer's metadata)
```

---

## 5. The Integration Point for a Plugin API

### 5.1 Where plugins can hook into the walk

There are two viable integration points:

**Option A: Post-walk per-file hook**

After `walkFile()` completes and returns `FileResult`, domain plugins receive:
- The `FileResult` (all nodes + edges for the file)
- Optionally: the parsed Babel `File` AST (already computed by `walkFile`)
- Optionally: the raw source code

The plugin returns additional `GraphNode[]` and `GraphEdge[]` that get merged into the result.

This is the cleanest approach. It matches the "pure data, no side effects" philosophy of the walk. No changes to the core walk loop. Plugins are post-processors.

**Option B: Visitor injection**

Plugins register visitor middleware that can intercept specific AST node types (e.g., `CallExpression`) and add extra nodes/edges to the `VisitResult`. This requires modifying the walk engine's dispatch to support multiple visitors per node type.

This is more powerful but changes the core invariant ("one visitor per AST node type"). It also forces domain plugins to understand Babel AST internals.

### 5.2 What a domain plugin needs from FileResult

Looking at the CALL nodes that `walkFile` already produces, a domain plugin can detect patterns like `app.get('/users', handler)` by scanning `FileResult.nodes` for:
- `node.type === 'CALL'`
- `node.metadata.object === 'app'`
- `node.metadata.method === 'get'`

The one thing missing is: **the string literal arguments** (the path `/users`). These are currently CONSTANT or LITERAL nodes connected via PASSES_ARGUMENT edges. A plugin would need to walk the edges to find them.

Alternatively, the walk could be extended to include argument value snapshots in CALL node metadata for string-literal args. This would be a small addition to `visitCallExpression` and would dramatically simplify domain plugins.

### 5.3 Proposed interface shape (sketch)

```typescript
/**
 * A domain plugin that runs after the per-file walk, receiving FileResult
 * and optionally the raw Babel AST. Returns additional nodes/edges to add.
 *
 * Contracts:
 * - Pure function: no side effects, no file I/O
 * - Must not mutate fileResult
 * - May only create new nodes/edges, not modify existing ones
 */
export interface DomainPlugin {
  /** Unique name (e.g. "express", "fetch", "socketio") */
  name: string;

  /**
   * Called once per file after walkFile() + resolveFileRefs().
   * @param fileResult - completed per-file analysis result
   * @param ast - parsed Babel AST (same parse as walkFile used)
   * @returns additional nodes and edges to merge into the result
   */
  analyzeFile(fileResult: FileResult, ast: File): {
    nodes: GraphNode[];
    edges: GraphEdge[];
    deferred?: DeferredRef[];
  };
}
```

### 5.4 How walkFile would change

The signature would become:

```typescript
export async function walkFile(
  code: string,
  file: string,
  registry: VisitorRegistry,
  domainPlugins?: DomainPlugin[],
  strict = true,
): Promise<FileResult>
```

After the existing Stage 1+2 pipeline, before returning:

```typescript
if (domainPlugins && domainPlugins.length > 0) {
  for (const plugin of domainPlugins) {
    const extra = plugin.analyzeFile(result, ast);
    result = {
      ...result,
      nodes: [...result.nodes, ...extra.nodes],
      edges: [...result.edges, ...extra.edges],
      unresolvedRefs: [...result.unresolvedRefs, ...(extra.deferred ?? [])],
    };
  }
}
```

The `ast` variable is already computed by `parseFile()` inside `walkFile()`. It just needs to be passed to domain plugins rather than discarded.

---

## 6. How ExpressAnalyzer Would Work in v2

Instead of re-parsing the file, the v2 Express plugin would:

1. Scan `fileResult.nodes` for CALL nodes where `metadata.object ∈ {'app','router'}` and `metadata.method ∈ HTTP_METHODS`
2. Find the first PASSES_ARGUMENT edge from that CALL node, follow it to a CONSTANT/LITERAL node to get the path string
3. Create an `http:route` node
4. Emit an edge from the enclosing FUNCTION/MODULE to the `http:route` node via EXPOSES

The tricky part is step 2: finding argument values. The graph topology is:
```
CALL → [PASSES_ARGUMENT] → CONSTANT (the path string)
```

To avoid graph traversal at analysis time, we could add `argValues?: string[]` to CALL node metadata in `visitCallExpression` when arguments are string/template literals. This is a minor, backward-compatible change to walk.ts.

---

## 7. v1 Domain Analyzers — Coexistence During Transition

v1 domain analyzers are v1 `Plugin` subclasses that run in the ANALYSIS phase and read from `context.graph`. They depend on `JSASTAnalyzer` (v1) creating MODULE nodes, then query the graph and create domain nodes.

When `CoreV2Analyzer` runs instead of `JSASTAnalyzer`, it creates MODULE nodes in the same format (it filters them out from its own output but the MODULE pre-exists from the INDEXING phase). The v1 domain analyzers should still function correctly if CoreV2Analyzer is used because:
1. MODULE nodes still exist (from JSModuleIndexer)
2. v1 analyzers re-parse the files themselves — they don't depend on v1-specific CALL node structure

So **coexistence is already happening** — see `CoreV2Analyzer.ts` which is a v1 Plugin that wraps core-v2's `walkFile/resolveProject`. v1 domain analyzers can continue to run alongside it.

---

## 8. Analysis of Risk Areas

### 8.1 Argument value extraction

The biggest challenge: domain analyzers need string argument values. Currently:
- `app.get('/users', handler)` → CALL node with metadata but no `argValues`
- The path `/users` is a CONSTANT node connected via PASSES_ARGUMENT

Either:
1. Add `argValues` to CALL metadata in walk.ts (clean, requires small change to expressions.ts)
2. Domain plugins traverse the edge graph in FileResult (works now, more complex)
3. Domain plugins use the Babel AST directly (fallback, need the ast to be passed through)

Option 1 is best. Option 3 is needed as a fallback for complex cases.

### 8.2 Import tracking

Domain analyzers need to know if `app` was imported from `express`, `io` from `socket.io`, etc. Currently this is handled in v1 by collecting imports during the re-parse traverse.

In v2, `walkFile` already creates IMPORT nodes and DEPENDS_ON edges. The domain plugin can scan `fileResult.nodes` for IMPORT nodes where `name` is `'express'` or `'socket.io'`. This is available without any changes.

### 8.3 The Rust analyzer

RustAnalyzer (455 lines) parses `.rs` files using a custom Rust parser shim. This is a completely separate language and needs separate treatment. It does not fit the JS/TS visitor model. It should be kept as a standalone v1-style Plugin or become a separate first-class extension point for non-JS languages.

---

## 9. Existing Patterns Worth Reusing

### 9.1 The NestJSRouteAnalyzer model

NestJSRouteAnalyzer (254 lines) is the cleanest existing domain analyzer because it is **graph-first**: it only queries existing graph nodes (DECORATOR nodes) and derives higher-level nodes from them. This is the model all v2 domain analyzers should aspire to.

In v2, after `walkFile` runs, domain plugins could work exactly like NestJSRouteAnalyzer but against `FileResult.nodes` instead of the live graph.

### 9.2 The CoreV2Analyzer wrapper model

`CoreV2Analyzer` (204 lines, `packages/core/src/plugins/analysis/CoreV2Analyzer.ts`) is the bridge between v1's Plugin system and v2's `walkFile`. It shows how v2 results are adapted into v1's graph write format (mapping GraphNode/GraphEdge to the typed node format via `mapNodes`/`mapEdges`).

Domain plugins implemented for v2 would need similar mapping when their extra nodes/edges are written to the graph.

---

## 10. Recommendations for Architecture

Based on this exploration:

1. **Post-walk plugin hook in `walkFile`** — cleanest integration point. Domain plugins receive `FileResult` + `ast: File` and return additional nodes/edges.

2. **Add `argValues` to CALL node metadata** — small change to `visitCallExpression` in expressions.ts: when an argument is a StringLiteral or simple TemplateLiteral, record its value in `metadata.argValues: string[]`. This makes domain plugins trivially simple.

3. **Domain plugins are NOT v1 Plugins** — they are a new interface (`DomainPlugin`) that operates inside `walkFile`, not in the orchestrator plugin pipeline. They get registered via a new `domainPlugins` parameter to `walkFile`.

4. **CoreV2Analyzer passes domain plugins through** — when CoreV2Analyzer invokes `walkFile`, it receives the list of registered domain plugins from context and passes them through.

5. **Express as reference** — port ExpressAnalyzer first as a pure `DomainPlugin` that scans CALL nodes. This validates the design without implementing all analyzers.

6. **Keep v1 domain analyzers running** — they work against v1's graph format and depend only on MODULE nodes, which CoreV2Analyzer preserves. No migration needed until v2 is stable.

---

## 11. File Reference Summary

| Path | Lines | Purpose |
|------|-------|---------|
| `packages/core-v2/src/walk.ts` | 607 | Walk engine, integration point for domain plugins |
| `packages/core-v2/src/types.ts` | 192 | Core types: GraphNode, GraphEdge, VisitorFn, FileResult |
| `packages/core-v2/src/registry.ts` | 409 | jsRegistry — maps all Babel AST types to visitors |
| `packages/core-v2/src/resolve.ts` | 1022 | File + cross-file resolution |
| `packages/core-v2/src/edge-map.ts` | 198 | EDGE_MAP: declarative edge type overrides |
| `packages/core-v2/src/visitors/expressions.ts` | 1387 | CallExpression visitor — produces CALL nodes |
| `packages/core-v2/src/visitors/modules.ts` | 352 | ImportDeclaration visitor — produces IMPORT/EXTERNAL nodes |
| `packages/core/src/plugins/Plugin.ts` | 129 | v1 Plugin base class |
| `packages/core/src/plugins/analysis/CoreV2Analyzer.ts` | 204 | v1 wrapper around core-v2 pipeline |
| `packages/core/src/plugins/analysis/ExpressAnalyzer.ts` | 442 | Reference v1 Express analyzer |
| `packages/core/src/plugins/analysis/FetchAnalyzer.ts` | 704 | v1 Fetch/HTTP analyzer |
| `packages/core/src/plugins/analysis/NestJSRouteAnalyzer.ts` | 254 | Best-in-class graph-query analyzer |
| `packages/types/src/plugins.ts` | 406 | v1 Plugin system types |
| `packages/types/src/nodes.ts` | 439 | All node type definitions including namespaced |
| `packages/types/src/edges.ts` | 139 | All edge type definitions |
