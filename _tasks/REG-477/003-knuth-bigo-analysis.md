# Donald Knuth -- Big-O Complexity Analysis: ANALYSIS Phase

## Executive Summary

1. **The outer loop is the root cause**: `Orchestrator.runBatchPhase('ANALYSIS')` runs ALL 16 analysis plugins once PER SERVICE/UNIT. With 745 services, every plugin executes 745 times -- and each invocation queries ALL modules globally (not just the current service's modules).
2. **ExpressResponseAnalyzer.findIdentifierInScope** is the single worst offender: 5 unscoped `queryNodes` calls (VARIABLE, CONSTANT, PARAMETER, then VARIABLE and CONSTANT again for module-level), each returning ALL nodes of that type across the ENTIRE graph, executed per response call per route per service invocation.
3. **DatabaseAnalyzer and SQLiteAnalyzer** fetch ALL FUNCTION nodes globally (unscoped) and then do linear scans per database query to find parent functions.
4. **ServiceLayerAnalyzer** queries ALL SERVICE_CLASS nodes per service instance per module per service invocation.
5. **GraphBuilder.createClassAssignmentEdges** queries ALL CLASS nodes per variable assignment with class source type, per module, per service invocation.

The total socket round-trips for the user's 745-service project are estimated at **33,525+ IPC calls** (conservative), with many of those calls returning the ENTIRE node set (potentially ~1M nodes) and filtering client-side.

## Variables

| Symbol | Meaning | Grafema (self) | User's project |
|--------|---------|----------------|----------------|
| S | Services/units (outer loop) | 5 | 745 |
| P | ANALYSIS-phase plugins | 16 | 16 |
| M | Total MODULE nodes in graph | 330 | 4,101 |
| N | Total nodes in graph | 69,000 | ~1,000,000 (est.) |
| F | Total FUNCTION nodes | ~2,000 | ~50,000 (est.) |
| V | Total VARIABLE nodes | ~3,000 | ~80,000 (est.) |
| C | Total CONSTANT nodes | ~1,000 | ~30,000 (est.) |
| Pa | Total PARAMETER nodes | ~2,000 | ~50,000 (est.) |
| R | Total http:route nodes | ~5 | ~200 (est.) |
| RC | Response calls per route | ~1-2 | ~1-2 |
| Q | Database queries found | ~0 | ~50 (est.) |
| SC | SERVICE_CLASS nodes | ~0 | ~20 (est.) |
| SI | Service instances per module | ~0 | ~5 (est.) |
| CA | Class assignments per module | ~2 | ~5 (est.) |
| CL | Total CLASS nodes | ~20 | ~500 (est.) |

## The Outer Loop: Orchestrator.runBatchPhase

**File:** `/Users/vadimr/grafema-worker-1/packages/core/src/Orchestrator.ts`, lines 349-406

```
for batchStart in range(0, units.length, BATCH_SIZE):     // S batches
  for unit in batch:                                       // S iterations total
    await this.runPhase('ANALYSIS', {                      // calls PhaseRunner.runPhase
      manifest: { service: unit, modules: [] },
      graph: this.graph,
    })
```

**PhaseRunner.runPhase** (line 317-350):
```
for plugin in phasePlugins (sorted):                       // P plugins
  await this.executePlugin(plugin, context, 'ANALYSIS')    // calls plugin.execute()
```

**Result: The entire ANALYSIS phase runs as O(S x P)**
- Grafema: 5 x 16 = 80 plugin executions
- User: 745 x 16 = 11,920 plugin executions

**Critical observation**: The `context.manifest` passed to each plugin contains the SERVICE/UNIT info, but `getModules()` (Plugin.ts:67-74) queries `graph.queryNodes({ type: 'MODULE' })` -- this returns ALL modules in the graph, NOT scoped to the current service. Every plugin processes the same full module set on every service iteration.

## Per-Plugin getModules() Redundancy

**File:** `/Users/vadimr/grafema-worker-1/packages/core/src/plugins/Plugin.ts`, lines 67-74

Every plugin that calls `this.getModules(graph)` issues an unscoped `queryNodes({ type: 'MODULE' })` call that returns ALL modules. This happens inside the S x P outer loop.

| Plugin | Calls getModules? | Socket round-trip |
|--------|-------------------|-------------------|
| JSASTAnalyzer | Yes (getModuleNodes) | 1 per invocation |
| ExpressAnalyzer | Yes | 1 per invocation |
| ExpressRouteAnalyzer | Yes | 1 per invocation |
| ExpressResponseAnalyzer | No (queries http:route) | 1 per invocation |
| DatabaseAnalyzer | Yes | 1 per invocation |
| ServiceLayerAnalyzer | Yes | 1 per invocation |
| FetchAnalyzer | Yes | 1 per invocation |
| SocketAnalyzer | Yes | 1 per invocation |
| SocketIOAnalyzer | Yes | 1 per invocation |
| ReactAnalyzer | Yes | 1 per invocation |
| SQLiteAnalyzer | Yes | 1 per invocation |
| SystemDbAnalyzer | Yes | 1 per invocation |
| NestJSRouteAnalyzer | No (queries DECORATOR) | 1 per invocation |
| RustAnalyzer | No (queries RUST_MODULE) | 1 per invocation |
| InfraAnalyzer | No (file-based) | 0 |
| IncrementalAnalysisPlugin | Varies | 0-1 per invocation |

**getModules cost**: 12 plugins x S invocations x 1 IPC call returning M nodes each.
- Grafema: 12 x 5 = 60 calls, each returning 330 modules = 19,800 node records transferred
- User: 12 x 745 = 8,940 calls, each returning 4,101 modules = **36,660,840 node records transferred**

**Essential complexity**: O(1) -- call once, globally. These are IDENTICAL calls returning IDENTICAL results.

## Nested Loop Analysis by Plugin

### 1. JSASTAnalyzer -- O(S x M x [per-module work])

**File:** `/Users/vadimr/grafema-worker-1/packages/core/src/plugins/analysis/JSASTAnalyzer.ts`

**Loop structure:**
```
for each service (S):                          // Orchestrator outer loop
  allModules = getModuleNodes(graph)           // O(M) IPC call, returns ALL M modules
  for module in allModules:                    // O(M) iteration
    if analyzedModules.has(module.id): skip    // <-- DEDUP CHECK (key optimization!)
    analyzeModule(module, graph, projectPath)  // O(per-module AST work)
```

**Critical saving**: JSASTAnalyzer has a `this.analyzedModules` Set that tracks already-analyzed modules. After the first service invocation analyzes all M modules, subsequent S-1 invocations skip them all.

**Actual complexity**: O(M) for analysis + O(S x M) for the redundant getModuleNodes + shouldAnalyzeModule loop.

**shouldAnalyzeModule** (line 305-338): For each module, if hash matches, calls `queryNodes({ type: 'FUNCTION', file: module.file })` -- this is file-scoped (GOOD), but still O(S x M) invocations when only O(M) is needed.

**Grafema**: 5 invocations x 330 modules = 1,650 iterations (1,320 are skipped)
**User**: 745 invocations x 4,101 modules = 3,055,245 iterations (3,051,144 are skipped)
**Essential**: O(M) = 4,101 iterations
**Waste factor**: 745x in IPC overhead (even though analysis work is deduped)

### 2. ExpressResponseAnalyzer -- O(S x R x RC x (V + C + Pa + V + C))

**File:** `/Users/vadimr/grafema-worker-1/packages/core/src/plugins/analysis/ExpressResponseAnalyzer.ts`

**Loop structure:**
```
for each service (S):                                    // Orchestrator
  routes = queryNodes({ type: 'http:route' })            // IPC: returns ALL R routes
  for route in routes:                                   // O(R)
    for responseCall in findResponseCalls(route):        // O(RC) per route
      resolveOrCreateResponseNode(...)
        findIdentifierInScope(...)
          queryNodes({ type: 'VARIABLE' })               // IPC: returns ALL V variables
            -> linear scan to match by name, file, scope
          queryNodes({ type: 'CONSTANT' })               // IPC: returns ALL C constants
            -> linear scan
          queryNodes({ type: 'PARAMETER' })              // IPC: returns ALL Pa parameters
            -> linear scan
          // If modulePrefix exists (always true):
          queryNodes({ type: 'VARIABLE' })               // IPC: AGAIN, ALL V variables
            -> linear scan for module-level
          queryNodes({ type: 'CONSTANT' })               // IPC: AGAIN, ALL C constants
            -> linear scan for module-level
```

**Per invocation**: 1 route query + R x RC x 5 unscoped queries = 1 + R x RC x 5

**Computed complexity**: O(S x R x RC x (V + C + Pa + V + C)) = O(S x R x RC x (2V + 2C + Pa))

**Grafema**: 5 x 5 x 1.5 x 5 = 187 IPC calls, each scanning ~6,000 nodes = ~1.1M node scans
**User**: 745 x 200 x 1.5 x 5 = **1,117,500 IPC calls**, each scanning ~160,000 nodes = **~179 BILLION node scans**

**Essential complexity**: O(R x RC) = 200 x 1.5 = 300 -- just need to resolve identifiers for 300 response calls.

**Waste factor**: 745 x 5 = **3,725x** (service loop x redundant full scans)

**NOTE**: Even without the service loop, the 5 unscoped queries per call are O(N) each when they should be O(1) point lookups with proper indexing (query by type + file + name).

### 3. DatabaseAnalyzer -- O(S x M x [AST] + S x Q x F)

**File:** `/Users/vadimr/grafema-worker-1/packages/core/src/plugins/analysis/DatabaseAnalyzer.ts`

**Loop structure:**
```
for each service (S):                                    // Orchestrator
  modules = getModules(graph)                            // IPC: ALL M modules
  functions = getFunctions(graph)                        // IPC: queryNodes({type:'FUNCTION'}) -> ALL F functions
  for module in modules:                                 // O(M)
    analyzeModule(module, functions, graph, projectPath)
      // AST traverse (proportional to file size)
      for query in databaseQueries:                      // O(Q_m) queries in this module
        findParentFunction(query, functions)              // O(F) linear scan of ALL functions
```

**getFunctions** (line 123-129): `queryNodes({ type: 'FUNCTION' })` returns ALL functions globally, unscoped.

**findParentFunction** (line 333-346): Filters all F functions by file + line proximity, then sorts. This is O(F) per database query.

**Computed complexity**: O(S x (M + F + M x Q_per_module x F))

**Grafema**: 5 x (330 + 2000 + 330 x 0 x 2000) = ~11,650 (no DB queries in Grafema)
**User**: 745 x (4101 + 50000 + 4101 x ~0.01 x 50000) = 745 x ~2,104,101 = **~1.57 billion operations**
  - The getFunctions call alone: 745 calls returning 50K nodes each = 37.25M node records

**Essential complexity**: O(M + F + Q x F_per_file) -- run once, scope functions to file
**Waste factor**: 745x (service loop) x unscoped function query

### 4. SQLiteAnalyzer -- O(S x M x Q_sq x F)

**File:** `/Users/vadimr/grafema-worker-1/packages/core/src/plugins/analysis/SQLiteAnalyzer.ts`, line 311

**Loop structure:**
```
for each service (S):                                    // Orchestrator
  modules = getModules(graph)                            // IPC: ALL M modules
  for module in modules:                                 // O(M)
    // AST traverse
    for query in sqliteQueries:                          // O(Q_sq)
      queryNodes({ type: 'FUNCTION' })                   // IPC: ALL F functions, UNSCOPED
        -> linear scan matching file + line proximity
```

**Critical**: Unlike DatabaseAnalyzer which fetches functions ONCE, SQLiteAnalyzer calls `queryNodes({ type: 'FUNCTION' })` INSIDE the per-query loop. This is O(Q_sq) full scans per module.

**Computed complexity**: O(S x M x Q_sq x F)

**User**: Even with modest 50 SQLite queries total: 745 x 4101 x (50/4101) x 50000 = 745 x 50 x 50000 = **~1.86 billion operations**

**Essential complexity**: O(M x Q_sq) with file-scoped function lookup
**Waste factor**: 745x (service loop) x F/F_per_file (unscoped query)

### 5. ServiceLayerAnalyzer -- O(S x M x SI x SC)

**File:** `/Users/vadimr/grafema-worker-1/packages/core/src/plugins/analysis/ServiceLayerAnalyzer.ts`, line 374

**Loop structure:**
```
for each service (S):                                    // Orchestrator
  modules = getModules(graph)                            // IPC: ALL M modules
  for module in modules:                                 // O(M)
    // AST traverse finds service instances
    for instance in serviceInstances:                    // O(SI_m) per module
      queryNodes({ type: 'SERVICE_CLASS' })              // IPC: ALL SC service classes
        -> linear scan to match by name
```

**Computed complexity**: O(S x M x SI_avg x SC)
**User**: 745 x 4101 x ~0.005 x 20 = ~305,475 IPC calls x SC nodes each
**Essential**: O(M x SI x 1) -- name lookup should be O(1)
**Waste factor**: 745x (service loop) x SC (linear scan)

### 6. GraphBuilder.createClassAssignmentEdges -- O(S x M x CA x CL)

**File:** `/Users/vadimr/grafema-worker-1/packages/core/src/plugins/analysis/ast/GraphBuilder.ts`, line 520-550

**Loop structure:**
```
for each service (S):                                    // Orchestrator
  JSASTAnalyzer.execute() processes modules:
    for module in modulesToAnalyze:                      // O(M) (deduped after first run)
      graphBuilder.build(module, graph, ...)
        createClassAssignmentEdges(variableAssignments, graph)
          for assignment in variableAssignments:         // O(CA) per module
            if sourceType === 'CLASS':
              queryNodes({ type: 'CLASS' })              // IPC: ALL CL class nodes
                -> linear scan to match by name + file
```

**JSASTAnalyzer deduplication mitigates this**: After first service invocation, modules are skipped. So this is effectively O(M x CA_class x CL), not multiplied by S.

**Computed complexity (actual)**: O(M x CA_class x CL)
**User**: 4101 x ~0.5 x 500 = ~1,025,250 IPC-level node scans
**Essential**: O(M x CA_class x 1) -- class lookup by name+file should be O(1)
**Waste factor**: CL (linear scan instead of indexed lookup) = 500x

### 7. ExpressRouteAnalyzer -- O(S x M x [AST] + S x MW x F_file)

**File:** `/Users/vadimr/grafema-worker-1/packages/core/src/plugins/analysis/ExpressRouteAnalyzer.ts`, line 440

**Loop structure:**
```
for each service (S):                                    // Orchestrator
  modules = getModules(graph)                            // IPC: ALL M modules
  for module in modules:                                 // O(M)
    // AST traverse
    // For each middleware (already scoped correctly):
    for middleware in middlewares:
      queryNodes({ type: 'FUNCTION', file: module.file, name: middleware.name })
        // SCOPED by file AND name -- GOOD!
```

**Assessment**: Well-scoped queries. Main waste is S x M redundancy from outer loop.

### 8. FetchAnalyzer -- O(S x M x [AST]) -- WELL SCOPED

**File:** `/Users/vadimr/grafema-worker-1/packages/core/src/plugins/analysis/FetchAnalyzer.ts`, lines 331-337

```
for each service (S):                                    // Orchestrator
  modules = getModules(graph)                            // IPC: ALL M modules
  for module in modules:                                 // O(M)
    queryNodes({ type: 'FUNCTION', file: module.file! }) // SCOPED
    queryNodes({ type: 'CALL', file: module.file! })     // SCOPED
    // In-memory filtering after that
```

**Assessment**: Queries are properly file-scoped. Only waste is the S x M outer loop redundancy.

### 9. SocketAnalyzer -- O(S x M x [AST]) -- WELL SCOPED

**Same pattern as FetchAnalyzer**: file-scoped queries. Only outer loop waste.

### 10. ReactAnalyzer -- O(S x M x [AST])

**File:** `/Users/vadimr/grafema-worker-1/packages/core/src/plugins/analysis/ReactAnalyzer.ts`

**Assessment**: Iterates all modules but has early exit for non-React files (`isReactFile` check). No inner graph queries. Waste is only the S x M outer loop.

### 11. NestJSRouteAnalyzer -- O(S x D)

**File:** `/Users/vadimr/grafema-worker-1/packages/core/src/plugins/analysis/NestJSRouteAnalyzer.ts`

```
for each service (S):                                    // Orchestrator
  queryNodes({ type: 'DECORATOR' })                      // IPC: all decorators
  // In-memory partitioning, no further queries
```

**Assessment**: Single query per invocation, but repeated S times. Decorators set is typically small.

### 12-16. Other Analyzers (ExpressAnalyzer, SystemDbAnalyzer, SocketIOAnalyzer, RustAnalyzer, InfraAnalyzer)

All follow the same `getModules() -> for module -> AST traverse` pattern. Main waste is S x M outer loop. No additional unscoped graph queries inside inner loops.

## Worst Offenders (ranked by waste factor)

| # | Plugin:Method | Current Big-O | Essential Big-O | Waste Factor (user) | IPC Calls (user) |
|---|--------------|---------------|-----------------|---------------------|------------------|
| 1 | ExpressResponseAnalyzer:findIdentifierInScope | O(S x R x RC x (2V+2C+Pa)) | O(R x RC) | **3,725x** | 1,117,500 |
| 2 | SQLiteAnalyzer:execute (per-query FUNCTION scan) | O(S x M x Q_sq x F) | O(Q_sq) | **745 x F/F_file** | ~37,250 |
| 3 | DatabaseAnalyzer:getFunctions + findParentFunction | O(S x (F + Q x F)) | O(Q) | **745x** | 745 |
| 4 | All 12 plugins:getModules | O(S x P_mod x M) | O(M) once | **8,940x** | 8,940 |
| 5 | ServiceLayerAnalyzer (per-instance SC scan) | O(S x M x SI x SC) | O(SI) | **745 x SC** | ~305,000 |
| 6 | GraphBuilder:createClassAssignmentEdges | O(M x CA x CL) | O(CA) total | **CL = 500x** | ~1,000,000 |
| 7 | JSASTAnalyzer:shouldAnalyzeModule | O(S x M) | O(M) | **745x** | ~3,055,000 |

## Socket Round-trip Analysis

### Per-service invocation (S=1)

| Plugin | IPC Calls | Nodes transferred (est.) |
|--------|-----------|--------------------------|
| getModules (12 plugins) | 12 | 12 x M |
| JSASTAnalyzer shouldAnalyzeModule | M | M x ~1 (early exit) |
| JSASTAnalyzer getModuleNodes | 1 | M |
| DatabaseAnalyzer getFunctions | 1 | F |
| DatabaseAnalyzer findParentFunction | Q | Q x F |
| SQLiteAnalyzer per-query FUNCTION | Q_sq | Q_sq x F |
| ExpressResponseAnalyzer routes | 1 | R |
| ExpressResponseAnalyzer findIdentifierInScope | R x RC x 5 | R x RC x 5 x (V+C+Pa) |
| ServiceLayerAnalyzer per-instance | SI_total | SI_total x SC |
| GraphBuilder CLASS lookups | CA_class_total | CA_class_total x CL |
| Other file-scoped queries | ~M | ~M x F_per_file |

### Total for full run (multiplied by S)

**User's project (S=745):**

| Category | IPC Calls | Approximate nodes transferred |
|----------|-----------|-------------------------------|
| getModules calls | 8,940 | 36,660,840 |
| ExpressResponseAnalyzer | 1,117,500 | ~179,000,000,000 |
| DatabaseAnalyzer | 745 + 745 x Q | 745 x 50,000 + ... |
| SQLiteAnalyzer | 745 x Q_sq | 745 x Q_sq x 50,000 |
| ServiceLayerAnalyzer | ~305,000 | ~6,100,000 |
| GraphBuilder CLASS | ~1,025,000 | ~512,500,000 |
| Other | ~20,000 | ~50,000,000 |

**Conservative total: ~2.5M IPC round-trips. Data transferred: hundreds of billions of node records.**

### Key insight: IPC round-trips vs data volume

Each `queryNodes` call goes through unix-socket IPC to RFDB. Even if RFDB responds fast, the serialization/deserialization of returning ALL 50,000 FUNCTION nodes 745 times is catastrophic. The bottleneck is not RFDB query speed -- it's the data transfer volume.

## The Fundamental Architecture Problem

The root cause is a **mismatch between execution granularity and data scope**:

```
Execution: per-service (S=745)
Data queries: global (all modules, all nodes)
```

Every plugin receives a "service context" but immediately ignores it and queries the global graph. This means:

1. **745 identical executions**: Same plugins, same data, same results
2. **No benefit from per-service execution**: Plugins don't use service boundaries for scoping
3. **Redundant IPC**: Same data requested 745 times over unix-socket

The architecture was designed for per-service analysis (where each service has its own module subset), but the implementation queries globally, making the per-service loop pure overhead.

## Recommendations (by impact)

### 1. Run ANALYSIS globally, not per-service (Fix A) -- **Eliminates 744/745 = 99.87% of work**

Change `runBatchPhase('ANALYSIS', units)` to run ANALYSIS plugins ONCE with all modules, not once per unit. This is the single highest-impact change.

**Expected speedup**: 745x for user's project
**Risk**: Low -- plugins already ignore service context
**Effort**: Modify Orchestrator to call `runPhase('ANALYSIS')` once with global manifest

### 2. Scope ExpressResponseAnalyzer queries (Fix D) -- **Eliminates O(N) per call**

Replace 5 unscoped `queryNodes({ type: 'VARIABLE' })` calls with `queryNodes({ type: 'VARIABLE', file, name })`. This converts O(V) scans to O(1) lookups.

**Expected speedup**: V/1 = 80,000x per query (after Fix A)
**Even without Fix A**: 745 x 80,000x = catastrophic waste eliminated

### 3. Scope DatabaseAnalyzer and SQLiteAnalyzer function queries -- **Eliminates O(F) per query**

- DatabaseAnalyzer: change `queryNodes({ type: 'FUNCTION' })` to `queryNodes({ type: 'FUNCTION', file: module.file })`
- SQLiteAnalyzer: same fix, AND move the query OUTSIDE the per-query loop (fetch once per module)

**Expected speedup**: F/F_per_file = ~100x per module

### 4. Scope ServiceLayerAnalyzer SERVICE_CLASS query

Replace `queryNodes({ type: 'SERVICE_CLASS' })` with `queryNodes({ type: 'SERVICE_CLASS', name: instance.serviceClass })`.

### 5. Scope GraphBuilder CLASS query

Replace `queryNodes({ type: 'CLASS' })` with `queryNodes({ type: 'CLASS', name: className, file })`.

### 6. Plugin applicability filter (Fix C) -- **Skip irrelevant plugins**

Before running a plugin, check if the current module set contains relevant patterns (e.g., skip ExpressResponseAnalyzer if no http:route nodes exist, skip DatabaseAnalyzer if no SQL patterns detected).

**Expected impact**: Moderate -- reduces constant factor but doesn't fix algorithmic complexity

### 7. JSASTAnalyzer: skip shouldAnalyzeModule on re-invocations

The `analyzedModules` set already prevents re-analysis, but the `shouldAnalyzeModule` check still runs for every module on every service invocation. Consider: if module is in `analyzedModules`, skip the hash check entirely (already done at line 358-360, but getModuleNodes IPC call still happens).

## Summary Table: Fix Impact

| Fix | Complexity Before | Complexity After | Speedup (user) |
|-----|-------------------|------------------|-----------------|
| Fix A: Global ANALYSIS | O(S x P x M x ...) | O(P x M x ...) | 745x |
| Fix D: Scope queries | O(... x N_type) | O(... x 1) | 50,000-80,000x per call |
| Both combined | O(S x P x M x N) | O(P x M) | **~37 million x** |

The combination of Fix A + Fix D transforms the analysis from transferring hundreds of billions of node records to transferring a few million -- a reduction of 4-5 orders of magnitude.
