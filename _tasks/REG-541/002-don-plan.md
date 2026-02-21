# Don Melton Plan: REG-541

## Codebase Findings

### NodeFactory pattern (summary)

NodeFactory is a static facade class at `packages/core/src/core/NodeFactory.ts`. It proxies to 8 domain-specific factories (`CoreFactory`, `HttpFactory`, `RustFactory`, `ReactFactory`, `SocketFactory`, `DatabaseFactory`, `ServiceFactory`, `ExternalFactory`) via static method bindings. Each domain factory's methods call `brandNodeInternal()` and the underlying node class's `create()` static method. NodeFactory does NOT call `graph.addNode()` — it only creates node objects. The contract is:

```
NodeFactory.createX(...) → brandNodeInternal(XNode.create(...)) → BrandedNode
caller → graph.addNode(brandedNode)
```

Key insight: **NodeFactory creates objects; callers still call `graph.addNode()`**. REG-541 changes this so the factory takes the `graph` and calls `addNode/addEdge` itself.

### brandNodeInternal pattern

`brandNodeInternal` at `packages/core/src/core/brandNodeInternal.ts` is a type-level brand — it's a nominal type cast (not a runtime operation). Its docstring explicitly lists the 3 legitimate callers: NodeFactory, GraphBuilder._flushNodes(), and RFDBServerBackend._parseNode(). The restriction is intentional: un-branded nodes cannot be passed to `addNode()` in a type-safe manner.

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
- **Files: 47**

Note: the `.grafema/guarantees.yaml` baseline says 95. The exact count at implementation time is the authoritative number.

### Call site anatomy

**addNode callers** fall into 3 categories:
1. **Already using NodeFactory** — node created by `NodeFactory.createX()`, then passed to `graph.addNode(node)` — trivial to wrap (FetchAnalyzer, JSModuleIndexer, discovery plugins, GraphInitializer, IncrementalReanalyzer, PhaseRunner)
2. **Inline node literals** — `graph.addNode(brandNodeInternal({ id: ..., type: ..., ... }))` — need a `GraphFactory.addRawNode()` escape hatch or a new NodeFactory method (JSASTAnalyzer, IncrementalAnalysisPlugin, InfraAnalyzer, ServiceConnectionEnricher, MountPointResolver, GraphInitializer)
3. **GuaranteeManager/GuaranteeAPI** — creates GUARANTEE-typed nodes that have no NodeFactory method yet — will need a new `NodeFactory.createGuarantee()` or a `GraphFactory.addGuaranteeNode()` method

**addEdge callers** are almost uniformly:
```ts
await graph.addEdge({ type: 'SOME_TYPE', src: nodeA.id, dst: nodeB.id });
```
No domain specialization — all edges are `{ type, src, dst }`. The only variation is optional `index` and `metadata` fields (rare). This is the `EdgeRecord` interface.

**addNodes/addEdges callers** are batch operations in analyzers (DatabaseAnalyzer, SocketIOAnalyzer, FetchAnalyzer, ExpressRouteAnalyzer, etc.) that collect arrays of nodes/edges and flush them. The pattern is always:
```ts
const nodes: NodeRecord[] = [];
nodes.push(...);
await graph.addNodes(nodes);
```

### Edge creation patterns observed

Edges are pure data — `{ type: EdgeType, src: string, dst: string }`. There are ~50+ distinct edge types in `EDGE_TYPE` const from `@grafema/types`. Unlike nodes, edges have no complex construction logic, no ID generation, no semantic IDs, no validation beyond type/src/dst. Callers always know the type at the call site.

### GraphBackend interface

`GraphBackend` (abstract class in `packages/core/src/core/GraphBackend.ts`) defines:
- `addNode(node: NodeRecord): Promise<void>`
- `addNodes(nodes: NodeRecord[]): Promise<void>`
- `addEdge(edge: EdgeRecord): Promise<void>`
- `addEdges(edges: EdgeRecord[]): Promise<void>`
- Also: `batchNode`, `batchEdge` (sync batch mode, used only in GraphBuilder)

GraphBuilder uses `batchNode`/`batchEdge` directly (a sync-batch optimization path in RFDB client). This path stays in GraphBuilder — it's an internal implementation detail, not a public API violation.

---

## Design Decisions

### EdgeFactory design decision: Option B — thin generic wrapper, NOT named builders

**Rationale:**

Option A (named builders like `EdgeFactory.importsFrom(src, dst)`) would require 50+ named methods for all edge types. This is mechanical repetition with zero value: edges have no construction logic, no validation beyond "fields present", and callers always know the type at the point of call. Named methods would mean every new edge type requires a new method — a maintenance burden without benefit.

Option B (generic wrapper `EdgeFactory.create(type, src, dst, metadata?)`) is correct because:
1. Edges are pure data triples. The factory's value is **the single interception point** (debug logging, validation), not named semantics.
2. All 38 `addEdge` call sites use the same pattern — the type is a literal string constant.
3. Extensible: debug logging and validation are trivially added in one place.

**EdgeFactory design:**
```ts
export class EdgeFactory {
  static create(type: EdgeType, src: string, dst: string, options?: { index?: number; metadata?: Record<string, unknown> }): EdgeRecord
}
```

This is the sole method. No named builders. The debug logging intercept goes here.

### GraphFactory design decision: thin facade that owns the graph reference, delegates to NodeFactory + EdgeFactory

**Rationale:**

GraphFactory is the answer to "who calls `graph.addNode()`". It holds a `GraphBackend` reference and exposes methods that combine node creation with graph insertion. This:
1. Creates the single interception point for debug logging (call stack capture)
2. Enables runtime validation at creation time
3. Allows callers to stop caring about the two-step create+add pattern

**GraphFactory design:**
```ts
export class GraphFactory {
  constructor(graph: GraphBackend, options?: { debug?: boolean; validate?: boolean })

  // Node methods — creates and inserts
  async addNode<T extends BaseNodeRecord>(node: BrandedNode<T>): Promise<void>
  async addNodes<T extends BaseNodeRecord>(nodes: BrandedNode<T>[]): Promise<void>

  // Edge methods — creates and inserts
  async addEdge(type: EdgeType, src: string, dst: string, options?: EdgeOptions): Promise<void>
  async addEdges(edges: EdgeRecord[]): Promise<void>

  // Debug mode
  setDebug(enabled: boolean): void
}
```

**Critical design point:** GraphFactory does NOT replace the `graph: GraphBackend` parameter in plugin contexts. The `PluginContext` currently carries `graph: GraphBackend`. For migration, the cleanest approach is:
- Add `graphFactory: GraphFactory` to `PluginContext` (or wrap `graph` with GraphFactory)
- Migrate call sites to use `context.graphFactory.addEdge(...)` instead of `graph.addEdge(...)`

However, this is a large API surface change. A simpler alternative: make GraphFactory implement a compatible interface so it can replace `graph` in contexts without changing signatures. This is the preferred path.

**Batch methods:** `addNodes` and `addEdges` on GraphFactory wrap the batch methods on GraphBackend. They add debug logging per-item (debug mode only — in normal mode, delegate directly for performance).

### Migration strategy

With 47 files, the safest approach is **plugin-type by plugin-type**, not file-by-file:

1. **Indexers first** (3 files: JSModuleIndexer, IncrementalModuleIndexer, RustModuleIndexer) — small, well-isolated, good first targets
2. **Discovery plugins** (3 files: SimpleProjectDiscovery, MonorepoServiceDiscovery, WorkspaceDiscovery) — all have same pattern (addNode for service node)
3. **Analyzers** (12 files: FetchAnalyzer, SocketIOAnalyzer, ExpressAnalyzer, ExpressRouteAnalyzer, ExpressResponseAnalyzer, DatabaseAnalyzer, ReactAnalyzer, RustAnalyzer, SQLiteAnalyzer, ServiceLayerAnalyzer, SocketAnalyzer, SystemDbAnalyzer, NestJSRouteAnalyzer) — batch add pattern
4. **Enrichers** (13 files) — mostly addEdge only
5. **Core infrastructure** last (GraphInitializer, PhaseRunner, GuaranteeManager, GuaranteeAPI, IncrementalAnalysisPlugin, IncrementalReanalyzer, GraphBuilder partial) — most complex, touch more architecture

GraphBuilder is a special case: it has its own buffering subsystem (batchNode/batchEdge). The violations in GraphBuilder are the `addNodes`/`addEdges` fallback flush paths. These should be migrated to use `graphFactory.addNodes/addEdges` for the fallback path while keeping the `batchNode`/`batchEdge` sync path as-is (it's an optimization, not a violation of the principle).

---

## Implementation Plan

### Step 1: EdgeFactory

Create `packages/core/src/core/EdgeFactory.ts`:
- Single static method `EdgeFactory.create(type, src, dst, options?): EdgeRecord`
- In debug mode (static flag or instance-based on GraphFactory), logs to stderr with call stack
- Validates: type is non-empty string, src/dst are non-empty strings, throws in strict mode
- Export from `packages/core/src/core/index.ts` (or wherever NodeFactory is exported)

No domain splits needed — edge construction is trivial. This is one file, one class, ~50 LOC.

### Step 2: GraphFactory

Create `packages/core/src/core/GraphFactory.ts`:
- Instance class (not static) — holds `GraphBackend` reference
- Constructor: `new GraphFactory(graph, { debug?: boolean, validate?: boolean })`
- `addNode(node)` / `addNodes(nodes[])` — validate (if enabled), log (if debug), delegate to `this.graph.addNode/addNodes`
- `addEdge(type, src, dst)` / `addEdges(edges[])` — use `EdgeFactory.create()` internally, then delegate
- Static `GraphFactory.setGlobalDebug(enabled: boolean)` for CLI/MCP debug mode activation
- Debug logging format: `[GraphFactory] addEdge CALLS src=fn:foo:10 dst=fn:bar:20\n  at <call stack>`

**Validation in GraphFactory.addNode:**
- Delegates to `NodeFactory.validate(node)` (already exists in NodeFactory)
- If errors found: throws in strict mode, logs warning in normal mode

**PluginContext integration:** Add `graphFactory: GraphFactory` to the `PluginContext` type in `@grafema/types`. PhaseRunner constructs it with the same graph instance. This is an additive change — `graph` stays in context for backward compat during migration.

### Step 3: Migration (47 files)

Migration pattern for each call site:

**Pattern A — addNode of NodeFactory result:**
```ts
// Before
const node = NodeFactory.createX(...);
await graph.addNode(node);
// After
const node = NodeFactory.createX(...);
await context.graphFactory.addNode(node);
// OR if graphFactory holds graph:
await graphFactory.addNode(NodeFactory.createX(...));
```

**Pattern B — addEdge inline:**
```ts
// Before
await graph.addEdge({ type: 'CALLS', src: callSite.id, dst: fn.id });
// After
await graphFactory.addEdge('CALLS', callSite.id, fn.id);
```

**Pattern C — batch addNodes/addEdges:**
```ts
// Before
await graph.addNodes(nodes);
await graph.addEdges(edges);
// After
await graphFactory.addNodes(nodes);
await graphFactory.addEdges(edges);
```

**Pattern D — inline brandNodeInternal (tricky cases):**
Files like JSASTAnalyzer, InfraAnalyzer create nodes inline with `brandNodeInternal({ ... })`. These need either:
- A new `NodeFactory.createX()` method for that node type, OR
- A `GraphFactory.addRawNode(node: BaseNodeRecord)` that handles branding internally

Recommendation: add the missing NodeFactory methods (e.g., `NodeFactory.createGraphMeta()`, `NodeFactory.createGuarantee()`) rather than an escape hatch. This is the right fix — the inline literals are the symptom of missing factory methods.

### Step 4: Tests

New test files:
1. `test/unit/EdgeFactory.test.js`
   - `EdgeFactory.create()` returns valid EdgeRecord
   - Type, src, dst present — passes validation
   - Empty type throws in strict mode
   - Empty src/dst throws in strict mode

2. `test/unit/GraphFactory.test.js`
   - `graphFactory.addNode()` calls `graph.addNode()` with correct node
   - `graphFactory.addEdge()` calls `graph.addEdge()` with EdgeRecord from EdgeFactory
   - Debug mode: addNode logs to stderr
   - Debug mode: addEdge logs to stderr with call stack
   - Validation mode: invalid node throws
   - `addNodes` / `addEdges` batch delegation

3. Update `test/unit/NodeFactoryPart1.test.js` / `NodeFactoryPart2.test.js` pattern to add tests for new NodeFactory methods needed by migration (createGraphMeta, createGuarantee if added).

---

## Files to touch

### New files (create):
- `packages/core/src/core/EdgeFactory.ts`
- `packages/core/src/core/GraphFactory.ts`
- `test/unit/EdgeFactory.test.js`
- `test/unit/GraphFactory.test.js`

### Modified — types:
- `packages/types/src/plugins.ts` — add `graphFactory?: GraphFactory` to `PluginContext`

### Modified — core infrastructure:
- `packages/core/src/core/NodeFactory.ts` — potentially add missing node factory methods (createGraphMeta, createGuarantee)
- `packages/core/src/core/GuaranteeManager.ts` (2 violations)
- `packages/core/src/core/IncrementalReanalyzer.ts` (1 violation)
- `packages/core/src/GraphInitializer.ts` (3 violations)
- `packages/core/src/PhaseRunner.ts` (2 violations) — also constructs GraphFactory here
- `packages/core/src/api/GuaranteeAPI.ts` (3 violations)

### Modified — plugins/analysis:
- `packages/core/src/plugins/analysis/ast/GraphBuilder.ts` (6 violations — special case, partial migration)
- `packages/core/src/plugins/analysis/DatabaseAnalyzer.ts` (2 violations)
- `packages/core/src/plugins/analysis/ExpressAnalyzer.ts` (2 violations)
- `packages/core/src/plugins/analysis/ExpressResponseAnalyzer.ts` (2 violations)
- `packages/core/src/plugins/analysis/ExpressRouteAnalyzer.ts` (2 violations)
- `packages/core/src/plugins/analysis/FetchAnalyzer.ts` (3 violations)
- `packages/core/src/plugins/analysis/IncrementalAnalysisPlugin.ts` (3 violations)
- `packages/core/src/plugins/analysis/JSASTAnalyzer.ts` (1 violation — inline brandNodeInternal)
- `packages/core/src/plugins/analysis/NestJSRouteAnalyzer.ts` (2 violations)
- `packages/core/src/plugins/analysis/ReactAnalyzer.ts` (2 violations)
- `packages/core/src/plugins/analysis/RustAnalyzer.ts` (2 violations)
- `packages/core/src/plugins/analysis/SQLiteAnalyzer.ts` (2 violations)
- `packages/core/src/plugins/analysis/ServiceLayerAnalyzer.ts` (2 violations)
- `packages/core/src/plugins/analysis/SocketAnalyzer.ts` (2 violations)
- `packages/core/src/plugins/analysis/SocketIOAnalyzer.ts` (4 violations)
- `packages/core/src/plugins/analysis/SystemDbAnalyzer.ts` (2 violations)

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
- `packages/core/src/plugins/enrichment/HTTPConnectionEnricher.ts` (2 violations)
- `packages/core/src/plugins/enrichment/ImportExportLinker.ts` (2 violations)
- `packages/core/src/plugins/enrichment/InstanceOfResolver.ts` (1 violation)
- `packages/core/src/plugins/enrichment/MethodCallResolver.ts` (1 violation)
- `packages/core/src/plugins/enrichment/MountPointResolver.ts` (1 violation — inline brandNodeInternal)
- `packages/core/src/plugins/enrichment/NodejsBuiltinsResolver.ts` (2 violations)
- `packages/core/src/plugins/enrichment/RejectionPropagationEnricher.ts` (1 violation)
- `packages/core/src/plugins/enrichment/RustFFIEnricher.ts` (3 violations — comments, verify actual call count)
- `packages/core/src/plugins/enrichment/ServiceConnectionEnricher.ts` (3 violations)
- `packages/core/src/plugins/enrichment/SocketConnectionEnricher.ts` (2 violations)
- `packages/core/src/plugins/enrichment/ValueDomainAnalyzer.ts` (2 violations)

### Modified — plugins/indexing:
- `packages/core/src/plugins/indexing/IncrementalModuleIndexer.ts` (3 violations)
- `packages/core/src/plugins/indexing/JSModuleIndexer.ts` (3 violations)
- `packages/core/src/plugins/indexing/RustModuleIndexer.ts` (1 violation)

### Modified — plugins root:
- `packages/core/src/plugins/InfraAnalyzer.ts` (1 violation — inline node literal)

### Updated — guarantees baseline:
- `.grafema/guarantees.yaml` — update comment from "95 violations" to "0 violations" after migration

---

## Risks

### Risk 1: PluginContext API surface (HIGH)
Adding `graphFactory` to `PluginContext` in `@grafema/types` is an additive change but touches the public plugin API. External plugins (if any exist) won't break (field is optional during migration), but this must be versioned correctly. Mitigation: make the field optional in types during migration, required after all internal plugins are migrated.

### Risk 2: GraphBuilder sync batch path (MEDIUM)
GraphBuilder has two paths: sync batch (batchNode/batchEdge, available on RFDBServerBackend) and fallback (addNodes/addEdges). The fallback path is the violation. Wrapping it through GraphFactory for the fallback path is safe, but the sync batch path cannot go through GraphFactory without a major refactor (it bypasses async). Mitigation: migrate only the fallback path; document that sync batch is a legitimate internal optimization exempt from the guarantee (similar to how storage/ is exempt).

### Risk 3: Inline brandNodeInternal callers (MEDIUM)
5-6 call sites create nodes inline with `brandNodeInternal({ ... })` for node types that have no NodeFactory method (GRAPH_META, GUARANTEE, updated routes). These need new NodeFactory methods or a controlled escape hatch. Creating bogus factory methods for one-off cases (like GRAPH_META) is worse than an escape hatch. Recommendation: add 2-3 targeted new NodeFactory methods for recurring types (createGraphMeta, createGuarantee), and for truly one-off cases, accept a `GraphFactory.addInternalNode(raw: BaseNodeRecord)` that brands internally. This escape hatch is better than proliferating factory methods for every ad-hoc node.

### Risk 4: Test coverage gap (LOW)
The migration is mechanical but large (47 files). Risk of introducing a regression in one file. Mitigation: existing integration tests (unit tests already cover most plugins). Run full test suite after each group of files (not after each file).

### Risk 5: GuaranteeAPI uses its own graph interface (LOW)
`GuaranteeAPI` has its own `GuaranteeGraphBackend` interface (duck-typed subset of GraphBackend). GraphFactory wraps `GraphBackend`, not `GuaranteeGraphBackend`. Need to verify GraphFactory is compatible or GuaranteeAPI gets its own factory wrapping. Mitigation: GraphFactory's interface is a superset of GuaranteeGraphBackend — it should work without modification.

### Risk 6: Validate method in GraphFactory vs NodeFactory (LOW)
`NodeFactory.validate()` exists but returns `string[]` (error messages), not void/throws. GraphFactory needs to decide: log warnings or throw. This must be a consistent policy decision. Recommendation: in `validate: true` mode, throw an `Error` with the validation messages concatenated; in normal mode, skip validation entirely (don't even call validate). Only enable in CI or explicit debug sessions.
