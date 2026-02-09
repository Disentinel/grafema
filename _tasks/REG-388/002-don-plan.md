# Don Melton Plan: REG-388 — Batch IPC calls

## Assessment

**Lens: Mini-MLA** — Well-understood, mechanical transformation. No architecture changes. One pattern applied 30+ times.

## Current State

- **GraphBuilder** already uses `_bufferNode()` / `_bufferEdge()` + `_flushNodes()` / `_flushEdges()` — the gold standard
- **RFDBServerBackend.addNode()** delegates to `addNodes([node])` — each singular call = 1 IPC roundtrip
- **~130 call sites** across 30+ files still use singular `addNode()` / `addEdge()` in loops
- All calls return `Promise<void>` — return values are never used, safe to batch

## Approach

**Collect-then-flush pattern.** For each plugin:

1. Collect nodes and edges into arrays during analysis/iteration
2. Call `addNodes()` / `addEdges()` once at the end

### Two Pattern Categories

**Category A — Analysis plugins (local data, no graph reads):**
These plugins parse AST, collect local data, then write to graph. Simple: replace loop-based `addNode/addEdge` with array push, flush at end.

Files: ExpressAnalyzer, SocketIOAnalyzer, FetchAnalyzer, ServiceLayerAnalyzer, ReactAnalyzer, ExpressRouteAnalyzer, DatabaseAnalyzer, SQLiteAnalyzer, SystemDbAnalyzer, RustAnalyzer

**Category B — Plugins that interleave reads and writes:**
These plugins read from graph BETWEEN writes (e.g., `getNode()`, `queryNodes()`, graph traversals). Need to audit: does the read depend on a node/edge we're about to write?

Files: ExpressResponseAnalyzer (reads HANDLED_BY edges), FetchAnalyzer (reads FUNCTION/CALL nodes from graph — but those were written by JSASTAnalyzer, not by FetchAnalyzer itself), enrichment plugins

**Key insight:** In all Category B cases I examined, the reads query nodes/edges from PREVIOUS plugins (JSASTAnalyzer, ExpressRouteAnalyzer), not from the current plugin's own buffered data. So batching is still safe — we're not reading our own writes.

**Exception: ExpressResponseAnalyzer** creates response stub nodes with `addNode()`, then immediately uses the returned ID for an `addEdge()`. But the ID is generated locally (not from graph) — so we can buffer both and flush together.

### Special Cases

1. **Enrichment plugins with single addEdge calls** (MethodCallResolver, InstanceOfResolver, ExpressHandlerLinker, ClosureCaptureEnricher, ArgumentParameterLinker, MountPointResolver): These have 1 call inside a loop. Buffer edges, flush at end.

2. **FetchAnalyzer.ensureNetworkNode()** — lazy singleton creation. Move to `execute()` level (create once upfront). This is a minor structural change but doesn't affect semantics.

3. **ServiceLayerAnalyzer.queryNodes() inside loop** — queries FUNCTION/SERVICE_CLASS nodes while writing SERVICE_INSTANCE nodes. Safe because reads are for different types than writes.

4. **Orchestrator.ts** — has 2-3 calls for ISSUE nodes and SERVICE nodes. Low volume, but batch anyway for consistency.

5. **GuaranteeAPI.ts / GuaranteeManager.ts** — These are not performance-critical (called by user API, not during analysis). But convert for consistency.

## Scope

### Priority 1 — Analysis plugins (highest IPC volume)
| File | addNode | addEdge | Total | In Loops |
|------|---------|---------|-------|----------|
| SocketIOAnalyzer | 4 | 6 | 10 | Yes |
| ServiceLayerAnalyzer | 4 | 5 | 9 | Yes |
| FetchAnalyzer | 3 | 5 | 8 | Yes |
| RustAnalyzer | 6 | 1* | 7 | Yes (*edges batched separately) |
| ReactAnalyzer | 5 | 2 | 7 | Yes |
| ExpressAnalyzer | 3 | 4 | 7 | Yes |
| ExpressRouteAnalyzer | 2 | 4 | 6 | Yes |
| ExpressResponseAnalyzer | 5 | 1 | 6 | Yes |
| DatabaseAnalyzer | 3 | 3 | 6 | Yes |
| SQLiteAnalyzer | 1 | 2 | 3 | Yes |
| SystemDbAnalyzer | 2 | 2 | 4 | Yes |

### Priority 2 — Enrichment plugins
| File | addEdge | In Loops |
|------|---------|----------|
| RustFFIEnricher | 5 (incl addNodes) | Yes |
| ValueDomainAnalyzer | 4 | Yes |
| NodejsBuiltinsResolver | 4 | Yes |
| FunctionCallResolver | 3 | Yes |
| ImportExportLinker | 2 | Yes |
| HTTPConnectionEnricher | 2 | Yes |
| ExternalCallResolver | 2 | Yes |
| AliasTracker | 2 | Yes |
| MethodCallResolver | 1 | Yes |
| InstanceOfResolver | 1 | Yes |
| ExpressHandlerLinker | 1 | Yes |
| ClosureCaptureEnricher | 1 | Yes |
| ArgumentParameterLinker | 1 | Yes |

### Priority 3 — Infrastructure (low volume, convert for consistency)
| File | Calls | In Loops |
|------|-------|----------|
| GuaranteeAPI | 5 | No (user API) |
| GuaranteeManager | 4 | Some |
| JSModuleIndexer | 3 (partially batched) | Yes |
| IncrementalModuleIndexer | 3 | Yes |
| IncrementalAnalysisPlugin | 3 | Yes |
| IncrementalReanalyzer | 1 | No |
| Orchestrator | 3 | Some |
| Discovery plugins (3 files) | 1 each | No |
| RustModuleIndexer | 1 | No |

### Already batched (no changes needed)
- **GraphBuilder** (JSASTAnalyzer) — already uses _bufferNode/_bufferEdge
- **RejectionPropagationEnricher** — already uses addEdges()

## Implementation Strategy

1. Convert all **Priority 1** files first (analysis plugins — biggest impact)
2. Convert **Priority 2** files (enrichment plugins)
3. Convert **Priority 3** files (infrastructure — consistency)
4. Run full test suite after each priority group
5. Do NOT change any logic — only replace the graph write pattern

## Risk Assessment

**Risk: LOW**
- Pattern is purely mechanical
- No behavior change (addNode delegates to addNodes internally)
- GraphBuilder already proves the pattern works at scale (12K nodes/s)
- Existing tests catch regressions
- Worst case: node/edge not added → test will fail immediately

## NOT in scope
- Changing plugin interfaces
- Adding buffer/flush to GraphBackend itself (each plugin buffers locally)
- Optimizing graph READ operations (queryNodes, getNode, etc.)
- Changing plugin execution order or parallelism
