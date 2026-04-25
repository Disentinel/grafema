## Dijkstra Plan Verification: REG-541

**Verdict:** REJECT

**Completeness tables:** 5 tables

**Critical gaps found:** 3 (each would leave violations open)
**Non-critical gaps found:** 3

---

## Completeness Table 1: EdgeFactory parameter surface vs actual call sites

Don's design: `EdgeFactory.create(type, src, dst, options?: { index?, metadata? })`

`EdgeRecord` interface (canonical): `{ src, dst, type, index?, metadata? }` — no other fields.

| Call site | Fields passed | Fits EdgeFactory.create()? |
|---|---|---|
| AliasTracker, FunctionCallResolver, ImportExportLinker, etc. | `{ type, src, dst }` | YES |
| ArgumentParameterLinker | `{ type, src, dst, metadata: { argIndex, callId } }` | YES — callId is inside metadata |
| ValueDomainAnalyzer | `{ type, src, dst, metadata: { ... } }` | YES |
| RejectionPropagationEnricher | `addEdges([{ type, src, dst, metadata }], true)` | **PARTIALLY NO** — `skipValidation=true` is the 2nd argument to addEdges, not to addEdge |
| **SocketConnectionEnricher** | `{ type, src, dst, matchType: 'path', path: clientPath }` | **NO** — `matchType` and `path` are top-level fields not in EdgeRecord |
| **SocketConnectionEnricher** | `{ type, src, dst, matchType: 'port', port: ..., host: ... }` | **NO** — `matchType`, `port`, `host` are top-level fields not in EdgeRecord |
| **HTTPConnectionEnricher** | `{ type, src, dst, matchType: ..., }` | **NO** — same extra field at top level |
| **ServiceConnectionEnricher** | `{ type, src, dst, matchType: ..., }` | **NO** — same extra field at top level |
| IncrementalModuleIndexer | `{ src, dst, type, version: 'main' }` cast as `EdgeToAdd` | **NO** — `version` is a top-level non-EdgeRecord field |
| GraphBuilder fallback `addEdges` | `addEdges(edges, true)` — `skipValidation` as 2nd arg | **NO** — GraphFactory.addEdges() signature does not accommodate `skipValidation` |

**Gap 1 (CRITICAL):** At least 6 call sites pass non-standard top-level fields (`matchType`, `path`, `port`, `host`, `version`) that are NOT in `EdgeRecord` and NOT in Don's `options?: { index?, metadata? }`. These cannot be routed through `EdgeFactory.create()` without either:
- (a) adding those fields to options — which contradicts the "edges are pure data triples" claim, OR
- (b) acknowledging these as typed edge subtypes with their own fields — which requires named builders or a different approach.

Don's plan says "no named builders" and "edges are pure data triples" — but the codebase contradicts this: at least 3 enrichers use extra top-level fields on edges. The plan does not name a resolution for these cases.

**Gap 2 (CRITICAL):** `RejectionPropagationEnricher` and GraphBuilder both call `addEdges(edges, true)` with a `skipValidation=true` second argument. Don's `GraphFactory.addEdges(edges: EdgeRecord[])` has no such parameter. If GraphFactory wraps addEdges without forwarding `skipValidation`, these calls will either break (missing argument) or silently change behavior (validation now runs where it didn't before, potentially causing errors on REJECTS edges with non-graph CLASS nodes).

---

## Completeness Table 2: brandNodeInternal callers and resolution path

Don says "~5-6 files" with direct `brandNodeInternal`. Actual count: **8 files**.

| File | Pattern | Node type(s) | NodeFactory method exists? | Resolution in plan? |
|---|---|---|---|---|
| `GraphBuilder.ts` | Internal use in `_bufferNode` | All buffered types | YES (NodeFactory creates them before buffering) | Acknowledged as exempt |
| `IncrementalReanalyzer.ts` | `brandNodeInternal(moduleNode)` | MODULE (pre-created by NodeFactory) | YES | Not mentioned in plan |
| `IncrementalAnalysisPlugin.ts` | `brandNodeInternal(enrichedNode)` | Any (enriched from existing graph node) | YES (node was already branded) | Not mentioned in plan |
| `MountPointResolver.ts` | `brandNodeInternal(updatedRoute)` | route type (enriched existing node) | YES (node was already branded) | Not mentioned in plan |
| `JSASTAnalyzer.ts` | `brandNodeInternal({ type: 'MODULE', ... })` | MODULE | YES — `NodeFactory.createModule()` | Listed as "1 violation" |
| `SystemDbAnalyzer.ts` | `brandNodeInternal({ type: 'SYSTEM_DB_VIEW_REGISTRATION', ... })` | SYSTEM_DB_VIEW_REGISTRATION, SYSTEM_DB_SUBSCRIPTION | **NO** — not in NodeFactory at all | **NOT MENTIONED** |
| `ServiceConnectionEnricher.ts` | `brandNodeInternal({ ...route, customerFacing: true })` | Route node enrichment (existing node) | YES (node was already branded) | Listed but mischaracterized as "inline literal" |
| `GraphInitializer.ts` | `brandNodeInternal({ type: 'GRAPH_META', ... })` | GRAPH_META | **NO** — not in NodeFactory | Listed, needs `NodeFactory.createGraphMeta()` |

**Gap 3 (CRITICAL):** `SystemDbAnalyzer.ts` creates nodes of type `SYSTEM_DB_VIEW_REGISTRATION` and `SYSTEM_DB_SUBSCRIPTION` — neither type exists in NodeFactory and neither appears in `NodeFactory.validate()`. Don's plan does not mention these types at all. The plan lists `NodeFactory.createGraphMeta()` and `NodeFactory.createGuarantee()` as the needed new methods, but omits `createSystemDbViewRegistration()` and `createSystemDbSubscription()`. These 2 calls in SystemDbAnalyzer would remain as violations post-migration because there is no factory path for them.

Additionally, IncrementalReanalyzer, IncrementalAnalysisPlugin, MountPointResolver, and ServiceConnectionEnricher are all cases of re-branding already-branded nodes (enrichment mutations). This is a distinct pattern that Don's plan collapses into "inline brandNodeInternal" without distinguishing. The escape hatch `GraphFactory.addInternalNode()` may not be appropriate for these — they need a deliberate `GraphFactory.updateNode()` or `GraphFactory.addNodeWithMutation()` semantic that explicitly acknowledges "this is an upsert of an existing typed node with extra fields."

---

## Completeness Table 3: DiscoveryManager omission from file list

Don's "Files to touch" section lists 47 files across indexers, analyzers, enrichers, and core infrastructure. The actual set of 47 files with violations includes `DiscoveryManager.ts`.

| File | Violations | In Don's plan? |
|---|---|---|
| `packages/core/src/DiscoveryManager.ts` | 1 (`addNode`) | **MISSING** |

Don's plan lists 47 files but `DiscoveryManager.ts` does not appear in the "Modified" sections. The migration would leave exactly 1 violation open. DiscoveryManager is not a plugin — it does not receive a PluginContext, it holds `this.graph: GraphBackend` directly. This means the injection strategy (adding `graphFactory` to PluginContext) does not apply to it automatically. It requires its own GraphFactory construction or receiving GraphFactory as a constructor param.

---

## Completeness Table 4: GraphFactory injection strategy vs code patterns

Don's plan says: add `graphFactory: GraphFactory` to `PluginContext` and have plugins use `context.graphFactory`. But the actual pattern in the codebase is:

```ts
// Every plugin does:
const { graph } = context;  // destructured at top of execute()
// Then calls:
await graph.addEdge({ ... });
```

This appears in: DatabaseAnalyzer, SocketIOAnalyzer, FetchAnalyzer, NestJSRouteAnalyzer, SystemDbAnalyzer, IncrementalAnalysisPlugin, ExpressResponseAnalyzer, SocketAnalyzer, ReactAnalyzer, ServiceLayerAnalyzer, ExpressRouteAnalyzer, SQLiteAnalyzer, RustAnalyzer, ExpressAnalyzer, SimpleProjectDiscovery, HTTPConnectionEnricher, SocketConnectionEnricher, ClosureCaptureEnricher, ExternalCallResolver, ServiceConnectionEnricher, and all other plugins.

| Option | Description | Impact on 47-file migration |
|---|---|---|
| Option A: Add `graphFactory` to PluginContext, migrate each plugin to `const { graphFactory } = context` | Two changes per plugin: rename destructuring + rename all call sites | Each of 40+ plugins needs destructuring rename + all addNode/addEdge call renames |
| Option B: Make GraphFactory implement GraphBackend-compatible interface, inject as `graph` | Callers see `context.graph` but actually get a GraphFactory | Zero destructuring changes — only the injection site changes in PhaseRunner |
| Don's stated preference | "make GraphFactory implement a compatible interface so it can replace `graph` in contexts" (preferred path) | No destructuring changes needed |

Don mentions Option B is "preferred" but then describes Option A migration patterns in Step 3 (all examples show `context.graphFactory.addEdge`). This contradiction means the implementer must make an architectural decision that Don left open. If Option B is chosen, `GraphFactory` must implement the full `GraphBackend` interface including `getNode`, `getOutgoingEdges`, `bfs`, `export`, etc. — which would make GraphFactory a proxy, not a thin facade. If Option A is chosen, the per-file change count is doubled.

This is not a blocking error but an **underspecified decision** that will cause confusion in implementation.

---

## Completeness Table 5: Test strategy — does it verify migration completeness?

Don's plan says: "write EdgeFactory + GraphFactory tests BEFORE migration". The tests verify that the factories work correctly.

| What the tests verify | What they do NOT verify |
|---|---|
| `EdgeFactory.create()` returns valid EdgeRecord | That all 38 addEdge violations were migrated |
| `GraphFactory.addNode()` delegates to graph.addNode | That all 24 addNode violations were migrated |
| `GraphFactory.addEdge()` uses EdgeFactory.create | That violations count went 95 → 0 |
| Debug logging fires | That no file was missed |

The guarantee check (Datalog query) will verify 0 violations post-migration — but only if it runs. Don's plan says to update `.grafema/guarantees.yaml` to say "0 violations" at the end, but this is documentation — the actual guarantee enforcement runs `grafema analyze` and checks the graph. The plan does not include a step: **run `grafema analyze` on the repo itself and confirm 0 guarantee violations** before the PR is opened.

Without this step, a missed file (like DiscoveryManager) would slip through. The unit tests for GraphFactory/EdgeFactory cannot catch missed migration sites because they test the factories, not the call sites.

---

## Precondition issues

**Issue 1: GraphBuilder sync batch path and guarantee exclusion**

Don claims the `batchNode`/`batchEdge` path "stays exempt" from the guarantee as an "internal optimization." This is incorrect. The guarantee rule excludes `packages/core/src/storage/` and `packages/core/src/core/factories/`. GraphBuilder lives at `packages/core/src/plugins/analysis/ast/GraphBuilder.ts` — it is NOT excluded. The `batchNode`/`batchEdge` calls themselves are not `addNode`/`addEdge` calls, so the Datalog rule would not flag them. But this is a coincidence of naming, not a principled exclusion. Don should document this explicitly rather than calling it "exempt from the guarantee."

**Issue 2: GuaranteeManager uses GuaranteeGraph interface, not GraphBackend**

Don notes (Risk 5) that `GraphFactory` wraps `GraphBackend`, while `GuaranteeManager` uses its own `GuaranteeGraph` duck-typed interface. Don asserts "GraphFactory's interface is a superset of GuaranteeGraphBackend." This is unverified. `GuaranteeGraph` requires `queryNodes(filter)` which returns `AsyncIterable` — `GraphBackend` abstract class does not have `queryNodes`. If Option B (GraphFactory implements GraphBackend as proxy) is chosen, this breaks GuaranteeManager compatibility.

**Issue 3: NodeFactory.validate() does not cover GUARANTEE or GRAPH_META or SYSTEM_DB_*** types**

Don's plan says `GraphFactory.addNode()` delegates to `NodeFactory.validate()`. But `NodeFactory.validate()` returns `['Unknown node type: GUARANTEE']` for GUARANTEE nodes, `['Unknown node type: GRAPH_META']` for GRAPH_META nodes, and `['Unknown node type: SYSTEM_DB_VIEW_REGISTRATION']` for SystemDbAnalyzer nodes. In `validate: true` mode this would throw. This means either: (a) validation mode must skip unknown types silently — which undermines the value of validation, or (b) the new `NodeFactory.createGuarantee()` / `createGraphMeta()` / `createSystemDbViewRegistration()` methods must also add corresponding validators — which Don's plan does not mention.

---

## Summary of gaps

| # | Gap | Severity | Violations at risk |
|---|---|---|---|
| 1 | EdgeFactory.create() cannot handle top-level non-standard fields (matchType, path, port, host, version) | CRITICAL | 6+ violations in 3 enrichers + IncrementalModuleIndexer |
| 2 | addEdges(edges, skipValidation=true) signature not addressed in GraphFactory.addEdges() | CRITICAL | 2 violations in RejectionPropagationEnricher + GraphBuilder |
| 3 | SystemDbAnalyzer creates SYSTEM_DB_VIEW_REGISTRATION + SYSTEM_DB_SUBSCRIPTION — no NodeFactory method planned | CRITICAL | 2 violations in SystemDbAnalyzer |
| 4 | DiscoveryManager.ts missing from file list entirely | SERIOUS | 1 violation left open |
| 5 | GraphFactory injection: Option A vs Option B unresolved — migration patterns in plan contradict stated preference | DESIGN | Ambiguity forces improvisation across 40+ files |
| 6 | No "run grafema analyze on self and verify 0 violations" step in plan | PROCESS | Missed files (e.g., Gap 4) would not be caught before PR |

**Gaps 1, 2, and 3 are individually critical.** Gap 1 alone affects 6+ call sites across 3 files. The plan as written would result in at least 9 violations remaining open (6 from non-standard edge fields + 2 from skipValidation pattern + minimum 1 from DiscoveryManager) — far above the "0 violations" target.

**Required fixes before proceeding to implementation:**

1. Decide the real EdgeRecord contract: do `matchType`, `path`, `port`, `host`, `version` belong in `metadata` (requiring call-site refactoring) or as typed edge subclasses (requiring named builders the plan rejected)? One answer must be chosen and documented.

2. Add `skipValidation?: boolean` parameter to `GraphFactory.addEdges()` or provide an explicit pattern for the RejectionPropagationEnricher case.

3. Add `NodeFactory.createSystemDbViewRegistration()` and `NodeFactory.createSystemDbSubscription()` (or an explicit escape hatch decision) to the plan.

4. Add `DiscoveryManager.ts` to the file list with a note that it does not receive PluginContext and needs a different injection strategy.

5. Resolve the GraphFactory injection ambiguity: commit to Option A (rename context destructuring everywhere) or Option B (GraphFactory as GraphBackend proxy) — these have different implementation costs and different architectural footprints.
