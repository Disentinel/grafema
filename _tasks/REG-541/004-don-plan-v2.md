# Don Melton Plan v2: REG-541

Revision of `002-don-plan.md` after Dijkstra's REJECT (see `003-dijkstra-verification.md`).
All 4 gaps (3 critical + 1 serious) from Dijkstra are resolved. The implementer (Rob Pike) can work directly from this document without reading earlier versions.

---

## Codebase Findings

### NodeFactory pattern (summary)

NodeFactory is a static facade class at `packages/core/src/core/NodeFactory.ts`. It proxies to 8 domain-specific factories (`CoreFactory`, `HttpFactory`, `RustFactory`, `ReactFactory`, `SocketFactory`, `DatabaseFactory`, `ServiceFactory`, `ExternalFactory`) via static method bindings. Each domain factory's methods call `brandNodeInternal()` and the underlying node class's `create()` static method. NodeFactory does NOT call `graph.addNode()` — it only creates node objects. The contract is:

```
NodeFactory.createX(...) → brandNodeInternal(XNode.create(...)) → BrandedNode
caller → graph.addNode(brandedNode)
```

Key insight: **NodeFactory creates objects; callers still call `graph.addNode()`**. REG-541 changes this so the factory takes the `graph` and calls `addNode/addEdge` itself.

### brandNodeInternal pattern

`brandNodeInternal` at `packages/core/src/core/brandNodeInternal.ts` is a type-level brand — a nominal type cast (not a runtime operation). Its docstring explicitly lists the 3 legitimate callers: NodeFactory, GraphBuilder._flushNodes(), and RFDBServerBackend._parseNode(). The restriction is intentional: un-branded nodes cannot be passed to `addNode()` in a type-safe manner.

### Domain factory pattern (CoreFactory, HttpFactory, DatabaseFactory)

All domain factories:
- Are pure static classes (no instantiation)
- Take typed parameter structs (not raw `{ type, src, dst }`)
- Call `brandNodeInternal` internally
- Have typed option interfaces local to the file
- Return typed branded nodes

### Current violations (verified count)

Exact counts (re-verified via grep, excluding storage/, factories/, NodeFactory, EdgeFactory, GraphFactory):
- addNode: **24**
- addEdge: **38**
- addNodes: **15**
- addEdges: **16**
- **Total: 93** (the guarantees.yaml says 95 — close, minor discrepancy due to comment lines)
- **Files: 47** (including DiscoveryManager.ts — omitted in v1, corrected here)

Note: the `.grafema/guarantees.yaml` baseline says 95. The exact count at implementation time is the authoritative number.

### Call site anatomy

**addNode callers** fall into 3 categories:
1. **Already using NodeFactory** — node created by `NodeFactory.createX()`, then passed to `graph.addNode(node)` — trivial to wrap (FetchAnalyzer, JSModuleIndexer, discovery plugins, GraphInitializer, IncrementalReanalyzer, PhaseRunner)
2. **Re-branding mutations** — `graph.addNode(brandNodeInternal({ ...existingNode, newField: value }))` — these are upserts of already-typed nodes with enrichment fields. Callers: IncrementalReanalyzer, IncrementalAnalysisPlugin, MountPointResolver, ServiceConnectionEnricher. These need `GraphFactory.updateNode()` (see Design Decisions).
3. **Inline node literals for types missing from NodeFactory** — `graph.addNode(brandNodeInternal({ id: ..., type: 'SYSTEM_DB_VIEW_REGISTRATION', ... }))`. Callers: JSASTAnalyzer (MODULE, already has factory method), SystemDbAnalyzer (SYSTEM_DB_VIEW_REGISTRATION, SYSTEM_DB_SUBSCRIPTION — missing), GraphInitializer (GRAPH_META — missing), GuaranteeManager/GuaranteeAPI (GUARANTEE — missing). Resolution: add `NodeFactory.createSystemDbViewRegistration()`, `NodeFactory.createSystemDbSubscription()`, `NodeFactory.createGraphMeta()`, `NodeFactory.createGuarantee()`.

**addEdge callers** fall into 2 categories:
1. **Standard triples** — `{ type, src, dst }` or `{ type, src, dst, metadata: {...} }` or `{ type, src, dst, index: N }`. These fit `EdgeFactory.create(type, src, dst, options?)`.
2. **Top-level non-standard fields** — confirmed in 3 files:
   - `SocketConnectionEnricher` — passes `matchType: 'path', path: clientPath` and `matchType: 'port', port: N, host: H` as top-level fields on the edge object.
   - `HTTPConnectionEnricher` — passes `matchType: 'parametric'|'exact'` as top-level field.
   - `ServiceConnectionEnricher` — passes `matchType: 'parametric'|'exact'` as top-level field.
   - `IncrementalModuleIndexer` — passes `version: 'main'` as top-level field (via its local `EdgeToAdd` interface with index signature `[key: string]: unknown`).

   Resolution: these fields must move into `metadata`. See Design Decisions — Gap 1 resolution.

**addEdges with skipValidation** — confirmed in 2 files:
- `RejectionPropagationEnricher` — calls `addEdges([{ type: 'REJECTS', ... }], true)` because the `dst` may be a built-in Error class not in the graph.
- `GraphBuilder._flushFallbackBuffers` — calls `addEdges(this._edgeBuffer, true)` as a cast: `(graph as GraphBackend & { addEdges(e: GraphEdge[], skip?: boolean): Promise<void> })`.

   Resolution: `GraphFactory.addEdges()` accepts optional `skipValidation?: boolean` and forwards it to the backend. See Design Decisions — Gap 2 resolution.

**addNodes/addEdges callers** are batch operations in analyzers (DatabaseAnalyzer, SocketIOAnalyzer, FetchAnalyzer, ExpressRouteAnalyzer, SystemDbAnalyzer, etc.) that collect arrays of nodes/edges and flush them. The pattern is always:
```ts
const nodes: AnyBrandedNode[] = [];
nodes.push(...);
await graph.addNodes(nodes);
```

### Edge creation patterns — complete field inventory

`InputEdge` type in `packages/types/src/plugins.ts` is: `{ src, dst, type: string, [key: string]: unknown }` — it accepts arbitrary extra fields. `EdgeRecord` in `packages/types/src/edges.ts` is: `{ src, dst, type, index?, metadata? }`.

The non-standard top-level fields (`matchType`, `path`, `port`, `host`, `version`) are currently passing TypeScript because the backend's `addEdge(edge: InputEdge)` parameter allows index signatures. However, these fields are silently dropped or passed through to the RFDB wire format in an uncontrolled way. They are semantic metadata about the match and should live in `metadata`.

**Gap 1 resolution**: The correct fix is to move these fields into `metadata` at the call site during migration. This is a call-site change, not an EdgeFactory change. EdgeFactory.create() uses the standard `options?: { index?, metadata? }` parameter. Callers in the 3 enrichers and IncrementalModuleIndexer will be refactored to pass these fields inside `metadata`:

```ts
// Before (SocketConnectionEnricher)
await graph.addEdge({ type: 'INTERACTS_WITH', src: client.id, dst: server.id, matchType: 'path', path: clientPath });

// After
await graphFactory.addEdge('INTERACTS_WITH', client.id, server.id, { metadata: { matchType: 'path', path: clientPath } });
```

This is the correct long-term contract: edges are `{ type, src, dst, index?, metadata? }`. Non-standard fields that were sitting at top-level are moved into `metadata` where they belong semantically.

### GraphBackend interface

`GraphBackend` (abstract class in `packages/core/src/core/GraphBackend.ts`) defines:
- `addNode(node: NodeRecord): Promise<void>`
- `addNodes(nodes: NodeRecord[]): Promise<void>`
- `addEdge(edge: EdgeRecord): Promise<void>`
- `addEdges(edges: EdgeRecord[]): Promise<void>`
- Also: `batchNode`, `batchEdge` (sync batch mode, used only in GraphBuilder)

GraphBuilder uses `batchNode`/`batchEdge` directly (a sync-batch optimization path in RFDB client). This path stays in GraphBuilder — it's an internal implementation detail, not a public API violation. Note: `batchNode`/`batchEdge` are NOT `addNode`/`addEdge` by name, so the Datalog guarantee rule does not flag them. This is correct by design, not coincidental — the sync batch path is a named distinction in the protocol.

### DiscoveryManager (Gap 4 — corrected)

`DiscoveryManager` lives at `packages/core/src/DiscoveryManager.ts`. It has **1 `addNode` violation** at line 180: `await this.graph.addNode(serviceNode)` in `discoverFromConfig()`.

DiscoveryManager is **not a plugin** — it does not receive `PluginContext`. It holds `this.graph: GraphBackend` as a constructor parameter, injected by `Orchestrator.ts` at line 132. The injection strategy for DiscoveryManager is different: its constructor receives `graph: GraphBackend` and must be updated to receive `graphFactory: GraphFactory` instead (or additionally). PhaseRunner/Orchestrator constructs GraphFactory and passes it to DiscoveryManager constructor.

---

## Design Decisions

### EdgeFactory design: thin generic wrapper with metadata-first contract

`EdgeFactory.create(type, src, dst, options?)` — single method, no named builders.

**Rationale:** Edges are pure data triples. Named builders for 50+ edge types is mechanical repetition with zero construction logic value. The factory's value is the single interception point for debug logging and validation.

**The "no named builders" decision stands.** The 3 enrichers that were passing non-standard top-level fields are being fixed at the call site (moving fields into `metadata`), not by adding named builders to EdgeFactory.

**EdgeFactory design:**
```ts
export class EdgeFactory {
  static create(
    type: EdgeType,
    src: string,
    dst: string,
    options?: { index?: number; metadata?: Record<string, unknown> }
  ): EdgeRecord
}
```

This is the sole method. Debug logging and validation go here.

### GraphFactory design: thin facade owning graph reference, delegating to NodeFactory + EdgeFactory

GraphFactory is the answer to "who calls `graph.addNode()`". It holds a `GraphBackend` reference and exposes methods that combine node creation with graph insertion.

**GraphFactory design (complete interface):**
```ts
export class GraphFactory {
  constructor(graph: GraphBackend, options?: { debug?: boolean; validate?: boolean })

  // Node methods — creates and inserts
  async addNode<T extends BaseNodeRecord>(node: BrandedNode<T>): Promise<void>
  async addNodes<T extends BaseNodeRecord>(nodes: BrandedNode<T>[]): Promise<void>

  // Mutation upsert — re-brands and updates existing node (for enrichment mutations)
  async updateNode(node: BaseNodeRecord): Promise<void>

  // Edge methods — creates and inserts
  async addEdge(type: EdgeType, src: string, dst: string, options?: { index?: number; metadata?: Record<string, unknown> }): Promise<void>
  async addEdges(edges: EdgeRecord[], skipValidation?: boolean): Promise<void>

  // Debug mode
  setDebug(enabled: boolean): void
}
```

**Gap 2 resolution — `skipValidation` parameter:** `GraphFactory.addEdges(edges, skipValidation?)` accepts an optional second boolean. When `skipValidation=true`, it delegates directly to `this.graph.addEdges(edges, true)` without running any GraphFactory-level validation. This preserves the existing behavior in `RejectionPropagationEnricher` (edges to non-graph CLASS nodes) and `GraphBuilder._flushFallbackBuffers` (already-validated buffer). The `skipValidation` flag propagates to the backend's `addEdges` call.

**Gap 3 resolution — `updateNode` method:** The 4 call sites that re-brand already-typed nodes (IncrementalReanalyzer, IncrementalAnalysisPlugin, MountPointResolver, ServiceConnectionEnricher) represent a semantically distinct operation: enrichment mutation of an existing node. These are NOT the same as creating a new node. `GraphFactory.updateNode(node: BaseNodeRecord)` handles this: it calls `brandNodeInternal` internally (GraphFactory is a legitimate caller alongside NodeFactory), then delegates to `graph.addNode`. This is an upsert by ID — the backend replaces the existing node.

**PluginContext integration — Option B (GraphFactory as drop-in for `graph`):**

The injection strategy is **Option B**: GraphFactory implements a compatible interface so it can replace `graph` in plugin contexts without changing the destructuring pattern in 40+ plugins.

The key insight from Dijkstra's Table 4: every plugin does `const { graph } = context` then `await graph.addEdge(...)`. If GraphFactory implements `GraphBackend`'s write surface (`addNode`, `addNodes`, `addEdge`, `addEdges`) plus the read surface (`getNode`, `queryNodes`, `getOutgoingEdges`, `getIncomingEdges`, `nodeCount`, `edgeCount`, etc.), it can be injected as `context.graph` with zero change to plugin destructuring.

**Option B implementation:** GraphFactory wraps `GraphBackend`. For write operations (`addNode`, `addEdge`, etc.), it adds logging/validation/interception. For read operations (`getNode`, `getOutgoingEdges`, `queryNodes`, etc.), it delegates directly without modification. GraphFactory does NOT implement the full abstract `GraphBackend` class — it implements the `GraphBackend` interface structurally. This makes it a proxy for write operations and a transparent pass-through for reads.

**GuaranteeManager compatibility:** Dijkstra raised that `GuaranteeManager` uses its own `GuaranteeGraph` interface which requires `queryNodes(filter)`. The `GraphBackend` interface in `packages/types/src/plugins.ts` line 292 DOES include `queryNodes(filter: NodeFilter): AsyncIterable<NodeRecord> | AsyncGenerator<NodeRecord>`. GraphFactory will proxy `queryNodes` to `this.graph.queryNodes()`. This resolves the compatibility concern.

**Migration pattern for Option B:** PhaseRunner constructs `new GraphFactory(this.graph, { debug, validate })` and injects it as `context.graph`. Plugins continue using `const { graph } = context` without any change. Only the injection site in PhaseRunner changes.

**DiscoveryManager injection:** DiscoveryManager receives `graph: GraphBackend` as a constructor parameter injected by Orchestrator. During migration, Orchestrator passes a `GraphFactory` instance (which implements the `GraphBackend` interface) as the `graph` argument. DiscoveryManager's constructor signature does NOT change — it accepts `graph: GraphBackend`, and GraphFactory satisfies that interface. This is the cleanest path: zero changes to DiscoveryManager's constructor, the violation at line 180 (`this.graph.addNode(serviceNode)`) is resolved because `this.graph` is now a GraphFactory instance that intercepts the call.

### New NodeFactory methods required (Gap 3 resolution)

**Gap 3:** `SystemDbAnalyzer` creates `SYSTEM_DB_VIEW_REGISTRATION` and `SYSTEM_DB_SUBSCRIPTION` nodes using `brandNodeInternal` inline. Neither type has a NodeFactory method. The plan omitted these in v1. v2 adds:

Required new domain factory + NodeFactory methods:
- `NodeFactory.createSystemDbViewRegistration(id, params)` — creates SYSTEM_DB_VIEW_REGISTRATION node
- `NodeFactory.createSystemDbSubscription(id, params)` — creates SYSTEM_DB_SUBSCRIPTION node
- `NodeFactory.createGraphMeta(id, params)` — creates GRAPH_META node (for GraphInitializer)
- `NodeFactory.createGuarantee(definition)` — creates GUARANTEE node (for GuaranteeManager/GuaranteeAPI)

These should live in a new domain factory file `packages/core/src/core/factories/SystemFactory.ts` (for SystemDb types) and be added to the existing `CoreFactory.ts` for GRAPH_META and GUARANTEE (since these are core infrastructure types).

**Validation coverage:** When these new factory methods are added, `NodeFactory.validate()` must be updated to recognize these types. Currently `validate()` returns `['Unknown node type: GUARANTEE']` for GUARANTEE nodes — this must be fixed as part of adding the factory methods. After migration, `validate: true` mode will not throw on these types.

### Migration strategy

With 48 files (47 + DiscoveryManager), the safest approach is **category by category**, not file-by-file:

1. **Step 1: New factories** — Create EdgeFactory.ts, GraphFactory.ts. Add new NodeFactory methods. Write tests. No call site changes yet.
2. **Step 2: PhaseRunner + Orchestrator** — Inject GraphFactory as `context.graph`. Wire DiscoveryManager.
3. **Step 3: Indexers** (3 files: JSModuleIndexer, IncrementalModuleIndexer, RustModuleIndexer) — IncrementalModuleIndexer needs `metadata.version` migration (Gap 1).
4. **Step 4: Discovery plugins** (3 files: SimpleProjectDiscovery, MonorepoServiceDiscovery, WorkspaceDiscovery).
5. **Step 5: Analyzers** (16 files including SystemDbAnalyzer which needs new NodeFactory methods).
6. **Step 6: Enrichers** (17 files — SocketConnectionEnricher, HTTPConnectionEnricher, ServiceConnectionEnricher need metadata migration; RejectionPropagationEnricher needs skipValidation path).
7. **Step 7: Core infrastructure** (GraphInitializer, GuaranteeManager, GuaranteeAPI, IncrementalAnalysisPlugin, IncrementalReanalyzer, GraphBuilder fallback path) — most complex.

GraphBuilder is a special case: its `batchNode`/`batchEdge` sync path stays as-is (it is not `addNode`/`addEdge` by name and is not flagged by the guarantee). Its `_flushFallbackBuffers` fallback path uses `addEdges(buffer, true)` — this migrates to `graphFactory.addEdges(buffer, true)` using the new `skipValidation` parameter.

---

## Implementation Plan

### Step 1: EdgeFactory

Create `packages/core/src/core/EdgeFactory.ts`:
- Single static method `EdgeFactory.create(type, src, dst, options?): EdgeRecord`
- In debug mode, logs to stderr with call stack
- Validates: type non-empty, src/dst non-empty — throws in strict mode
- Export from `packages/core/src/core/index.ts`

No domain splits. One file, ~50 LOC.

### Step 2: New NodeFactory methods

Add to `packages/core/src/core/factories/SystemFactory.ts` (new file):
- `createSystemDbViewRegistration(nodeId: string, params: { viewName, serverName, callType, file, line, column }): BrandedNode<SystemDbViewRegistrationNode>`
- `createSystemDbSubscription(nodeId: string, params: { servers: string[], file, line, column }): BrandedNode<SystemDbSubscriptionNode>`

Add to `packages/core/src/core/factories/CoreFactory.ts`:
- `createGraphMeta(params: { id, ...metadata }): BrandedNode<GraphMetaNode>`
- `createGuarantee(params: GuaranteeDefinition): BrandedNode<GuaranteeNode>`

Add to `NodeFactory.ts`:
- `static createSystemDbViewRegistration = SystemFactory.createSystemDbViewRegistration.bind(SystemFactory)`
- `static createSystemDbSubscription = SystemFactory.createSystemDbSubscription.bind(SystemFactory)`
- `static createGraphMeta = CoreFactory.createGraphMeta.bind(CoreFactory)`
- `static createGuarantee = CoreFactory.createGuarantee.bind(CoreFactory)`

Update `NodeFactory.validate()` to recognize `SYSTEM_DB_VIEW_REGISTRATION`, `SYSTEM_DB_SUBSCRIPTION`, `GRAPH_META`, `GUARANTEE` as valid types.

### Step 3: GraphFactory

Create `packages/core/src/core/GraphFactory.ts`:
- Instance class (not static) — holds `GraphBackend` reference
- Constructor: `new GraphFactory(graph: GraphBackend, options?: { debug?: boolean; validate?: boolean })`
- Implements all `GraphBackend` interface methods structurally
- Write operations (`addNode`, `addNodes`, `addEdge`, `addEdges`, `updateNode`): add debug logging and optional validation, then delegate
- Read operations (`getNode`, `queryNodes`, `getOutgoingEdges`, `getIncomingEdges`, `nodeCount`, `edgeCount`, etc.): delegate directly without interception
- Optional operations (`flush`, `close`, `clear`, `deleteNode`, `deleteEdge`, `batchNode`, `batchEdge`, etc.): delegate if defined on wrapped backend
- `addEdge(type, src, dst, options?)` uses `EdgeFactory.create()` internally, wraps into `EdgeRecord`, delegates to `this.graph.addEdge()`
- `addEdges(edges: EdgeRecord[], skipValidation?: boolean)`: delegates to `this.graph.addEdges(edges, skipValidation)` — passes skipValidation through
- `updateNode(node: BaseNodeRecord)`: calls `brandNodeInternal(node as any)` internally, delegates to `this.graph.addNode()` — this is the controlled escape hatch for enrichment mutations
- Debug logging format: `[GraphFactory] addEdge type=CALLS src=fn:foo:10 dst=fn:bar:20\n  at <call stack>`

**Validation in GraphFactory.addNode:**
- In `validate: true` mode: calls `NodeFactory.validate(node)` — if errors returned, throws
- In normal mode: skip validation entirely (performance path)
- After NodeFactory methods for GUARANTEE/GRAPH_META/SYSTEM_DB are added, validate() covers these types

**PhaseRunner integration:** PhaseRunner constructs `new GraphFactory(this.graph, { debug: options.debug, validate: options.validate })` and injects it as `context.graph`. Orchestrator passes the same GraphFactory instance (or a new one wrapping `this.graph`) to `new DiscoveryManager(plugins, graphFactory, config, logger, onProgress, configServices)`.

### Step 4: Migration (48 files)

Migration pattern for each call site:

**Pattern A — addNode of NodeFactory result (most common):**
```ts
// Before
const node = NodeFactory.createX(...);
await graph.addNode(node);
// After — no change needed! graph is now GraphFactory, call is intercepted transparently.
```
With Option B injection, the call site code is unchanged. `graph.addNode()` is now intercepted by GraphFactory.

**Pattern B — addEdge inline:**
```ts
// Before
await graph.addEdge({ type: 'CALLS', src: callSite.id, dst: fn.id });
// After — no change needed. graph.addEdge() is now intercepted by GraphFactory.
// GraphFactory.addEdge receives the InputEdge object and wraps it via EdgeFactory internally.
```

Wait — Option B means GraphFactory implements `addEdge(edge: InputEdge)` (matching the interface), NOT `addEdge(type, src, dst, options?)`. The named-parameter style from v1 only applies if we add new code. For backward-compat, GraphFactory implements both: the interface-compatible overload `addEdge(edge: InputEdge)` which internally calls `EdgeFactory.create()`.

**Revised GraphFactory.addEdge signature:**
```ts
// Implements GraphBackend interface — drop-in replacement
addEdge(edge: InputEdge): Promise<void>
```
The `EdgeFactory.create()` call happens inside GraphFactory.addEdge — it extracts `type`, `src`, `dst`, `index`, `metadata` from the InputEdge and routes the rest into `metadata`. This is the correct place for the interception: GraphFactory normalizes the edge, then delegates the normalized `EdgeRecord` to the backend.

For the non-standard top-level fields in SocketConnectionEnricher etc.: the migration step moves these into `metadata` at the call site (correct semantics), but even without that refactor, GraphFactory.addEdge will handle arbitrary InputEdge fields by folding unknown top-level fields into `metadata`. This provides forward compatibility during migration.

**Pattern C — batch addNodes/addEdges:**
```ts
// Before
await graph.addNodes(nodes);
await graph.addEdges(edges);
// After — no change needed. graph is now GraphFactory, intercepted transparently.
```

**Pattern D — inline brandNodeInternal for missing types:**
```ts
// Before (SystemDbAnalyzer)
allNodes.push(brandNodeInternal({ id: nodeId, type: 'SYSTEM_DB_VIEW_REGISTRATION', ... }));
// After
allNodes.push(NodeFactory.createSystemDbViewRegistration(nodeId, { viewName, serverName, ... }));
```

**Pattern E — enrichment mutations (updateNode):**
```ts
// Before (ServiceConnectionEnricher)
await graph.addNode(brandNodeInternal({ ...route, customerFacing: true }));
// After
await graph.updateNode({ ...route, customerFacing: true });
```

**Pattern F — skipValidation:**
```ts
// Before (RejectionPropagationEnricher)
await graphWithAddEdges.addEdges([{ type: 'REJECTS', ... }], true);
// After
await graph.addEdges([{ type: 'REJECTS', ... }], true);
// (No cast needed — GraphFactory.addEdges accepts skipValidation natively)
```

**Non-standard fields migration (Gap 1):**
The 4 files with non-standard top-level edge fields should be migrated to use `metadata`:

```ts
// SocketConnectionEnricher — before
await graph.addEdge({ type: 'INTERACTS_WITH', src: client.id, dst: server.id, matchType: 'path', path: clientPath });
// After
await graph.addEdge({ type: 'INTERACTS_WITH', src: client.id, dst: server.id, metadata: { matchType: 'path', path: clientPath } });

// IncrementalModuleIndexer — before
await graph.addEdge({ src, dst, type: 'CONTAINS', version: 'main' } as EdgeToAdd);
// After
await graph.addEdge({ src, dst, type: 'CONTAINS', metadata: { version: 'main' } });
// Remove the local EdgeToAdd interface — no longer needed
```

### Step 5: Tests

New test files:
1. `test/unit/EdgeFactory.test.js`
   - `EdgeFactory.create()` returns valid EdgeRecord with type, src, dst
   - `options.metadata` is preserved in returned record
   - `options.index` is preserved in returned record
   - Empty type throws in strict mode
   - Empty src/dst throws in strict mode

2. `test/unit/GraphFactory.test.js`
   - `graphFactory.addNode()` calls `graph.addNode()` with correct branded node
   - `graphFactory.addEdge()` calls `graph.addEdge()` with correct EdgeRecord
   - `graphFactory.addEdges(edges, true)` calls `graph.addEdges(edges, true)` — skipValidation forwarded
   - `graphFactory.updateNode()` calls `graph.addNode()` with branded version of raw node
   - Debug mode: addNode logs to stderr
   - Debug mode: addEdge logs to stderr with call stack
   - Validation mode: invalid node throws
   - `addNodes` / `addEdges` batch delegation
   - Read methods (`getNode`, `queryNodes`, etc.) delegate to wrapped backend transparently

3. `test/unit/NodeFactory.SystemDb.test.js` (new file or appended to existing test pattern):
   - `NodeFactory.createSystemDbViewRegistration()` returns branded node with correct type
   - `NodeFactory.createSystemDbSubscription()` returns branded node with correct type
   - `NodeFactory.createGraphMeta()` returns branded node with correct type
   - `NodeFactory.createGuarantee()` returns branded node with correct type
   - `NodeFactory.validate()` does NOT return errors for these 4 new types

### Step 6: Self-verification

After migration, run `grafema analyze` on the Grafema repo itself and confirm 0 guarantee violations for the "direct graph mutation" guarantee. This step must be in the PR checklist. Without it, a missed file (like DiscoveryManager was missed in v1) would not be caught by factory/unit tests alone.

---

## Files to touch

### New files (create):
- `packages/core/src/core/EdgeFactory.ts`
- `packages/core/src/core/GraphFactory.ts`
- `packages/core/src/core/factories/SystemFactory.ts` (new domain factory for SystemDb types)
- `test/unit/EdgeFactory.test.js`
- `test/unit/GraphFactory.test.js`
- `test/unit/NodeFactory.SystemDb.test.js`

### Modified — types:
- No changes to `@grafema/types` needed for Option B. GraphFactory implements the existing `GraphBackend` interface structurally. The `PluginContext.graph` field type stays `GraphBackend` — GraphFactory is assignable to it.

### Modified — core infrastructure:
- `packages/core/src/core/NodeFactory.ts` — add bindings for 4 new methods (createSystemDbViewRegistration, createSystemDbSubscription, createGraphMeta, createGuarantee); update validate() for new types
- `packages/core/src/core/factories/CoreFactory.ts` — add createGraphMeta, createGuarantee methods
- `packages/core/src/core/GuaranteeManager.ts` (2 violations) — use NodeFactory.createGuarantee(); graph.addNode() already intercepted by GraphFactory
- `packages/core/src/core/IncrementalReanalyzer.ts` (1 violation) — use graph.updateNode() for re-branding mutation
- `packages/core/src/GraphInitializer.ts` (3 violations) — use NodeFactory.createGraphMeta() for GRAPH_META node
- `packages/core/src/PhaseRunner.ts` (2 violations + GraphFactory construction) — construct GraphFactory, inject as context.graph
- `packages/core/src/Orchestrator.ts` — pass GraphFactory to DiscoveryManager constructor
- `packages/core/src/api/GuaranteeAPI.ts` (3 violations) — use NodeFactory.createGuarantee()

### Modified — DiscoveryManager (Gap 4 — was missing from v1):
- `packages/core/src/DiscoveryManager.ts` (1 violation at line 180) — no constructor change needed; receives GraphFactory as `graph: GraphBackend` from Orchestrator; `this.graph.addNode(serviceNode)` is intercepted by GraphFactory transparently

### Modified — plugins/analysis:
- `packages/core/src/plugins/analysis/ast/GraphBuilder.ts` (6 violations — special case) — `_flushFallbackBuffers` migrates `addEdges(buffer, true)` to use GraphFactory.addEdges; batchNode/batchEdge sync path unchanged
- `packages/core/src/plugins/analysis/DatabaseAnalyzer.ts` (2 violations)
- `packages/core/src/plugins/analysis/ExpressAnalyzer.ts` (2 violations)
- `packages/core/src/plugins/analysis/ExpressResponseAnalyzer.ts` (2 violations)
- `packages/core/src/plugins/analysis/ExpressRouteAnalyzer.ts` (2 violations)
- `packages/core/src/plugins/analysis/FetchAnalyzer.ts` (3 violations)
- `packages/core/src/plugins/analysis/IncrementalAnalysisPlugin.ts` (3 violations) — use graph.updateNode() for re-branding
- `packages/core/src/plugins/analysis/JSASTAnalyzer.ts` (1 violation) — use NodeFactory.createModule()
- `packages/core/src/plugins/analysis/NestJSRouteAnalyzer.ts` (2 violations)
- `packages/core/src/plugins/analysis/ReactAnalyzer.ts` (2 violations)
- `packages/core/src/plugins/analysis/RustAnalyzer.ts` (2 violations)
- `packages/core/src/plugins/analysis/SQLiteAnalyzer.ts` (2 violations)
- `packages/core/src/plugins/analysis/ServiceLayerAnalyzer.ts` (2 violations)
- `packages/core/src/plugins/analysis/SocketAnalyzer.ts` (2 violations)
- `packages/core/src/plugins/analysis/SocketIOAnalyzer.ts` (4 violations)
- `packages/core/src/plugins/analysis/SystemDbAnalyzer.ts` (2 violations) — use NodeFactory.createSystemDbViewRegistration() and NodeFactory.createSystemDbSubscription()

### Modified — plugins/discovery:
- `packages/core/src/plugins/discovery/MonorepoServiceDiscovery.ts` (1 violation)
- `packages/core/src/plugins/discovery/SimpleProjectDiscovery.ts` (1 violation)
- `packages/core/src/plugins/discovery/WorkspaceDiscovery.ts` (1 violation)

### Modified — plugins/enrichment:
- `packages/core/src/plugins/enrichment/AliasTracker.ts` (2 violations)
- `packages/core/src/plugins/enrichment/ArgumentParameterLinker.ts` (2 violations)
- `packages/core/src/plugins/enrichment/CallbackCallResolver.ts` (3 violations)
- `packages/core/src/plugins/enrichment/ClosureCaptureEnricher.ts` (1 violation)
- `packages/core/src/plugins/enrichment/ExpressHandlerLinker.ts` (1 violation)
- `packages/core/src/plugins/enrichment/ExternalCallResolver.ts` (2 violations)
- `packages/core/src/plugins/enrichment/FunctionCallResolver.ts` (2 violations)
- `packages/core/src/plugins/enrichment/HTTPConnectionEnricher.ts` (2 violations) — move matchType into metadata
- `packages/core/src/plugins/enrichment/ImportExportLinker.ts` (2 violations)
- `packages/core/src/plugins/enrichment/InstanceOfResolver.ts` (1 violation)
- `packages/core/src/plugins/enrichment/MethodCallResolver.ts` (1 violation)
- `packages/core/src/plugins/enrichment/MountPointResolver.ts` (1 violation) — use graph.updateNode() for route mutation
- `packages/core/src/plugins/enrichment/NodejsBuiltinsResolver.ts` (2 violations)
- `packages/core/src/plugins/enrichment/RejectionPropagationEnricher.ts` (1 violation) — remove cast, use graph.addEdges(edges, true) directly
- `packages/core/src/plugins/enrichment/RustFFIEnricher.ts` (3 violations — verify actual count at implementation time)
- `packages/core/src/plugins/enrichment/ServiceConnectionEnricher.ts` (3 violations) — move matchType into metadata; use graph.updateNode() for route enrichment mutation
- `packages/core/src/plugins/enrichment/SocketConnectionEnricher.ts` (2 violations) — move matchType/path/port/host into metadata
- `packages/core/src/plugins/enrichment/ValueDomainAnalyzer.ts` (2 violations)

### Modified — plugins/indexing:
- `packages/core/src/plugins/indexing/IncrementalModuleIndexer.ts` (3 violations) — move version field into metadata; remove local EdgeToAdd interface
- `packages/core/src/plugins/indexing/JSModuleIndexer.ts` (3 violations)
- `packages/core/src/plugins/indexing/RustModuleIndexer.ts` (1 violation)

### Modified — plugins root:
- `packages/core/src/plugins/InfraAnalyzer.ts` (1 violation)

### Updated — guarantees baseline:
- `.grafema/guarantees.yaml` — update violation count from 95 to 0 after migration and self-verification

---

## Risks

### Risk 1: GraphFactory as GraphBackend proxy — interface completeness (HIGH)
GraphFactory must implement every method in the `GraphBackend` interface. The interface is large (20+ methods, many optional). Missing any required method will cause TypeScript errors when injecting as `context.graph`. Mitigation: implement all required methods first; optional methods (`flush?`, `close?`, `deleteNode?`, etc.) delegate with a guard: `this.graph.flush?.()`.

### Risk 2: GraphBuilder sync batch path (MEDIUM)
GraphBuilder has two paths: sync batch (batchNode/batchEdge) and fallback (addNodes/addEdges). The fallback path is the violation. The sync batch path is named distinctly (`batchNode`/`batchEdge`) and is not flagged by the guarantee rule — this is correct by design. After migration, `_flushFallbackBuffers` uses `graph.addEdges(buffer, true)` (now handled by GraphFactory), and the sync batch path is unchanged. Document this in GraphBuilder as "batchNode/batchEdge is an RFDB-specific optimization path, not subject to the factory guarantee."

### Risk 3: metadata field folding for non-standard top-level fields (MEDIUM)
GraphFactory.addEdge receives an `InputEdge` (which allows arbitrary extra fields). The plan specifies that unknown top-level fields should be folded into `metadata` automatically. However, folding at GraphFactory time and folding at call-site are different: if the same field name exists in both `metadata` and at top-level, there's a collision. Mitigation: the call-site migration to explicit `metadata` must happen for all 4 affected files. The GraphFactory folding is a safety net, not a substitute for the call-site fix.

### Risk 4: NodeFactory.validate() must cover new types (MEDIUM)
Currently `validate()` returns errors for GUARANTEE, GRAPH_META, SYSTEM_DB_VIEW_REGISTRATION, SYSTEM_DB_SUBSCRIPTION. After adding factory methods, validate() must be updated to allow these types. In `validate: true` mode on GraphFactory, passing a node of one of these types before the validate() update would throw. Mitigation: update validate() in the same commit as the factory methods; run NodeFactory.SystemDb tests before enabling validate mode.

### Risk 5: GuaranteeManager's GuaranteeGraph interface (LOW)
GuaranteeManager uses a duck-typed `GuaranteeGraph` interface requiring `queryNodes(filter)`. `GraphBackend` in `packages/types/src/plugins.ts` line 292 includes `queryNodes`. GraphFactory proxies `queryNodes`. This is confirmed compatible — no action needed beyond ensuring the proxy is complete.

### Risk 6: updateNode semantics vs backend behavior (LOW)
`GraphFactory.updateNode()` calls `graph.addNode()` with a re-branded node. Whether the backend treats this as upsert (replace) or error (duplicate) depends on the RFDB backend implementation. Verify that `RFDBServerBackend.addNode()` does an upsert by ID, not an insert-only. If it's insert-only, `updateNode` needs to call a different backend method. Mitigation: check RFDBServerBackend before implementing; if needed, add `updateNode?()` to the GraphBackend interface with a default implementation that calls `addNode`.

### Risk 7: Test coverage gap (LOW)
The migration is mechanical but large (48 files). Risk of regression in one file. Mitigation: run full test suite after each category of files (indexers, analyzers, enrichers, core). Run self-verification step (`grafema analyze` on self) before PR.
