# RFD-2: Enricher Contract v2 -- Don Melton Analysis

## 1. Current Architecture

### 1.1 Plugin Base Class

All enrichers extend `Plugin` (defined in `packages/core/src/plugins/Plugin.ts`), which implements `IPlugin` from `@grafema/types`.

```typescript
abstract class Plugin implements IPlugin {
  abstract get metadata(): PluginMetadata;
  abstract execute(context: PluginContext): Promise<PluginResult>;
  async initialize(_context: PluginContext): Promise<void> {}
  async cleanup(): Promise<void> {}
}
```

**Key types** (from `packages/types/src/plugins.ts`):

```typescript
interface PluginMetadata {
  name: string;
  phase: PluginPhase;  // 'DISCOVERY' | 'INDEXING' | 'ANALYSIS' | 'ENRICHMENT' | 'VALIDATION'
  creates?: { nodes?: NodeType[]; edges?: EdgeType[] };
  dependencies?: string[];  // Plugin names this depends on
  fields?: FieldDeclaration[];
}
```

The `creates` field documents what node/edge types a plugin produces, but there is NO `consumes` concept today. The `dependencies` field references plugin *names* (not edge types) and is used only for ordering.

### 1.2 Execution Model (Orchestrator)

The Orchestrator (`packages/core/src/Orchestrator.ts`) runs plugins through phases in order:

1. **DISCOVERY** -- find services/entrypoints
2. **INDEXING** -- per-unit, batched in parallel
3. **ANALYSIS** -- per-unit, batched in parallel
4. **ENRICHMENT** -- **global**, single pass, sequential
5. **VALIDATION** -- global, sequential

**ENRICHMENT phase execution** (`runPhase('ENRICHMENT', ...)`):

1. Filter plugins to `phase === 'ENRICHMENT'`
2. Topologically sort by `dependencies` using Kahn's algorithm (existing `toposort.ts`)
3. Execute sequentially in sorted order
4. Each plugin receives full graph context (`PluginContext`)
5. Each plugin operates on the **entire graph** -- there is no per-file scoping

This means every enricher today is a **global pass** -- it queries all nodes of certain types, builds indexes, and processes them. There is no `relevantFiles()` or `processFile()` concept.

### 1.3 Dependency Resolution (toposort.ts)

Already exists at `packages/core/src/core/toposort.ts`:

- **Kahn's algorithm** (BFS-based)
- Input: `ToposortItem[]` with `{ id, dependencies }`
- Cross-phase deps silently ignored
- Registration-order tiebreaker for items with equal priority
- Throws `CycleError` with cycle path
- Time: O(V + E), Space: O(V + E)

### 1.4 Plugin Registration

Plugins are registered in a static registry (e.g., `packages/cli/src/commands/analyze.ts`, `packages/mcp/src/config.ts`). Each entry is a factory function:

```typescript
const AVAILABLE_PLUGINS = {
  ImportExportLinker: () => new ImportExportLinker() as Plugin,
  FunctionCallResolver: () => new FunctionCallResolver() as Plugin,
  // ...
};
```

The CLI instantiates only configured plugins, then the Orchestrator sorts and executes them.

---

## 2. Enricher Audit Table

I found **17 enricher source files** in `packages/core/src/plugins/enrichment/`. Of those, **14 are registered** in the CLI (matching the issue's count). Three are source-only: `NodejsBuiltinsResolver`, `ExternalCallResolver`, `ClosureCaptureEnricher`.

### 2.1 Registered Enrichers (14)

| # | Enricher | Reads (Consumes) Nodes | Reads (Consumes) Edges | Produces Edges | Produces Nodes | Dependencies | Per-File? |
|---|----------|----------------------|----------------------|---------------|---------------|-------------|-----------|
| 1 | **ImportExportLinker** | IMPORT, EXPORT, MODULE | -- | IMPORTS, IMPORTS_FROM | -- | JSASTAnalyzer | No (global index) |
| 2 | **FunctionCallResolver** | CALL, IMPORT, EXPORT, FUNCTION | IMPORTS_FROM | CALLS | EXTERNAL_MODULE | ImportExportLinker | No (global index) |
| 3 | **MethodCallResolver** | CALL, CLASS, METHOD, FUNCTION | CONTAINS, INSTANCE_OF, DERIVES_FROM | CALLS | -- | ImportExportLinker | No (global index) |
| 4 | **ArgumentParameterLinker** | CALL, PARAMETER | PASSES_ARGUMENT, CALLS, HAS_PARAMETER, RECEIVES_ARGUMENT | RECEIVES_ARGUMENT | -- | JSASTAnalyzer, MethodCallResolver | No (global) |
| 5 | **CallbackCallResolver** | CALL, METHOD_CALL, IMPORT, EXPORT, FUNCTION | PASSES_ARGUMENT, IMPORTS_FROM | CALLS | -- | ImportExportLinker, FunctionCallResolver | No (global) |
| 6 | **AliasTracker** | CALL, VARIABLE, CONSTANT, CLASS, METHOD, FUNCTION, EXPRESSION | ASSIGNED_FROM, CALLS, CONTAINS, INSTANCE_OF | CALLS, ALIAS_OF | -- | MethodCallResolver | No (global) |
| 7 | **ValueDomainAnalyzer** | CALL, VARIABLE, CONSTANT, FUNCTION, CLASS, SCOPE, PARAMETER | ASSIGNED_FROM, FLOWS_INTO, CONTAINS | CALLS, FLOWS_INTO (updates) | -- | AliasTracker | No (global) |
| 8 | **InstanceOfResolver** | CLASS, IMPORT | INSTANCE_OF | INSTANCE_OF (re-creates) | -- (removes stubs) | JSASTAnalyzer | No (global) |
| 9 | **MountPointResolver** | express:middleware, express:mount, http:route, IMPORT | -- | -- (updates node attrs) | -- | JSModuleIndexer, JSASTAnalyzer, ExpressRouteAnalyzer | No (global) |
| 10 | **ExpressHandlerLinker** | http:route, FUNCTION | -- | HANDLED_BY | -- | JSASTAnalyzer, ExpressRouteAnalyzer | Quasi (per-file groups) |
| 11 | **PrefixEvaluator** | MOUNT_POINT, MODULE | DEFINES | -- (updates node attrs) | -- | JSModuleIndexer, JSASTAnalyzer, MountPointResolver | No (global, reads FS) |
| 12 | **HTTPConnectionEnricher** | http:route, http:request | RESPONDS_WITH | INTERACTS_WITH, HTTP_RECEIVES | -- | ExpressRouteAnalyzer, FetchAnalyzer, ExpressResponseAnalyzer | No (global) |
| 13 | **RustFFIEnricher** | CALL, RUST_FUNCTION, RUST_METHOD | -- | FFI_CALLS | -- | RustAnalyzer, MethodCallResolver | No (global) |
| 14 | **RejectionPropagationEnricher** | FUNCTION, CALL | CALLS, REJECTS, CONTAINS, HAS_SCOPE | REJECTS | -- | JSASTAnalyzer | No (fixpoint iteration) |

### 2.2 Unregistered Enrichers (3)

| # | Enricher | Status | Notes |
|---|----------|--------|-------|
| 15 | **ExternalCallResolver** | Source exists, not in CLI registry | Depends on FunctionCallResolver. Creates CALLS, EXTERNAL_MODULE. |
| 16 | **NodejsBuiltinsResolver** | Source exists, not in CLI registry | Depends on JSASTAnalyzer, ImportExportLinker. Creates EXTERNAL_FUNCTION, EXTERNAL_MODULE, CALLS, IMPORTS_FROM. |
| 17 | **ClosureCaptureEnricher** | Source exists, not in CLI registry | Depends on JSASTAnalyzer. Creates CAPTURES edges. |

### 2.3 Dependency Graph (current)

Based on `dependencies` fields, the enrichment-phase dependency graph is:

```
JSASTAnalyzer (analysis phase)
    |
    +---> ImportExportLinker
    |         |
    |         +---> FunctionCallResolver
    |         |         |
    |         |         +---> CallbackCallResolver
    |         |
    |         +---> MethodCallResolver
    |                   |
    |                   +---> ArgumentParameterLinker
    |                   +---> AliasTracker
    |                   |         |
    |                   |         +---> ValueDomainAnalyzer
    |                   +---> RustFFIEnricher
    |
    +---> InstanceOfResolver
    +---> RejectionPropagationEnricher
    +---> ClosureCaptureEnricher (unregistered)

ExpressRouteAnalyzer (analysis phase)
    |
    +---> ExpressHandlerLinker
    +---> MountPointResolver
    |         |
    |         +---> PrefixEvaluator
    +---> HTTPConnectionEnricher (also depends on FetchAnalyzer, ExpressResponseAnalyzer)
```

---

## 3. High-Level Plan

### 3.1 New Interface: `EnricherV2`

```typescript
interface EnricherMetadataV2 extends PluginMetadata {
  /** Edge types this enricher reads from the graph */
  consumes: EdgeType[];
  /** Edge types this enricher creates/modifies */
  produces: EdgeType[];
  /** Node types this enricher reads (for documentation/validation) */
  consumesNodes?: NodeType[];
  /** Node types this enricher creates (for documentation/validation) */
  producesNodes?: NodeType[];
}

interface EnricherV2 extends IPlugin {
  metadata: EnricherMetadataV2;

  /**
   * Return files relevant to this enricher given the set of changed files.
   * Default: return all changed files (backward-compatible).
   * Enrichers that operate globally should return an empty array
   * (signaling "run once, not per-file").
   */
  relevantFiles?(changedFiles: string[]): string[];

  /**
   * Process a single file. Optional -- if not implemented, execute() is used.
   * This is for future per-file incremental enrichment.
   */
  processFile?(file: string, context: PluginContext): Promise<PluginResult>;

  /**
   * Execute enricher (existing contract, unchanged).
   */
  execute(context: PluginContext): Promise<PluginResult>;
}
```

**Key design decisions:**

1. `consumes`/`produces` are **edge types**, not plugin names. This is more granular and enables automatic dependency inference.
2. `relevantFiles()` is optional. For v1, all existing enrichers will use the default (return all files = global pass). This prepares for incremental enrichment in the future.
3. `processFile()` is optional. No enricher implements it in v1. This is a hook for future per-file processing.
4. `dependencies` remains for **explicit ordering hints** that can't be inferred from edge types (e.g., MountPointResolver depends on ExpressRouteAnalyzer for node creation, not edge types).

### 3.2 V1EnricherAdapter

```typescript
class V1EnricherAdapter implements EnricherV2 {
  constructor(private legacy: Plugin) {}

  get metadata(): EnricherMetadataV2 {
    const base = this.legacy.metadata;
    return {
      ...base,
      consumes: [],    // Unknown -- V1 enrichers didn't declare this
      produces: base.creates?.edges || [],
    };
  }

  relevantFiles(): string[] {
    return []; // Global pass -- no per-file scoping
  }

  async execute(context: PluginContext): Promise<PluginResult> {
    return this.legacy.execute(context);
  }
}
```

The adapter wraps any V1 `Plugin` in the V2 interface. The `consumes` will be empty (unknown), which means the dependency graph builder must fall back to `dependencies` for V1-adapted enrichers.

### 3.3 Dependency Graph from consumes/produces

The dependency graph builder should work in two layers:

**Layer 1: Edge-type inference** (for EnricherV2 with declared consumes/produces)
- If enricher A produces edge type E, and enricher B consumes edge type E, then B depends on A.
- This builds the graph automatically without manual `dependencies` arrays.

**Layer 2: Explicit dependencies fallback** (for V1 enrichers via adapter)
- If an enricher has `consumes: []` (unknown), its `dependencies` field is used as-is.
- This ensures backward compatibility.

**Algorithm:**

```
function buildDependencyGraph(enrichers: EnricherV2[]): ToposortItem[] {
  // Map: edgeType -> enricher names that produce it
  const producers = new Map<EdgeType, string[]>();
  for (const e of enrichers) {
    for (const edgeType of e.metadata.produces) {
      producers.get(edgeType)?.push(e.metadata.name) || producers.set(edgeType, [e.metadata.name]);
    }
  }

  // Build dependencies
  return enrichers.map(e => {
    const deps = new Set<string>();

    // Layer 1: infer from consumes/produces
    for (const edgeType of e.metadata.consumes) {
      const prods = producers.get(edgeType) || [];
      prods.forEach(p => { if (p !== e.metadata.name) deps.add(p); });
    }

    // Layer 2: merge explicit dependencies (for V1 or overrides)
    for (const dep of e.metadata.dependencies || []) {
      deps.add(dep);
    }

    return { id: e.metadata.name, dependencies: [...deps] };
  });
}
```

Then feed the result to the existing `toposort()` function. Cycle detection comes for free.

### 3.4 Metadata Updates for Existing Enrichers

Each existing enricher needs `consumes` and `produces` added to its metadata. Here is the exact mapping based on the audit:

| Enricher | consumes (edges read) | produces (edges created) |
|----------|----------------------|--------------------------|
| ImportExportLinker | -- | IMPORTS, IMPORTS_FROM |
| FunctionCallResolver | IMPORTS_FROM | CALLS |
| MethodCallResolver | CONTAINS, INSTANCE_OF, DERIVES_FROM | CALLS |
| ArgumentParameterLinker | PASSES_ARGUMENT, CALLS, HAS_PARAMETER, RECEIVES_ARGUMENT | RECEIVES_ARGUMENT |
| CallbackCallResolver | PASSES_ARGUMENT, IMPORTS_FROM | CALLS |
| AliasTracker | ASSIGNED_FROM, CALLS, CONTAINS, INSTANCE_OF | CALLS, ALIAS_OF |
| ValueDomainAnalyzer | ASSIGNED_FROM, FLOWS_INTO, CONTAINS | CALLS, FLOWS_INTO |
| InstanceOfResolver | INSTANCE_OF | INSTANCE_OF |
| MountPointResolver | -- | -- |
| ExpressHandlerLinker | -- | HANDLED_BY |
| PrefixEvaluator | DEFINES | -- |
| HTTPConnectionEnricher | RESPONDS_WITH | INTERACTS_WITH, HTTP_RECEIVES |
| RustFFIEnricher | -- | FFI_CALLS |
| RejectionPropagationEnricher | CALLS, REJECTS, CONTAINS, HAS_SCOPE | REJECTS |

**Note:** Some enrichers (MountPointResolver, ExpressHandlerLinker, PrefixEvaluator, RustFFIEnricher) primarily consume **node types** rather than edge types. Their `consumes` for edges is empty or minimal. They still need explicit `dependencies` for ordering relative to analysis-phase plugins that create their node types.

### 3.5 File Structure

```
packages/core/src/plugins/enrichment/
  EnricherV2.ts          -- Interface + EnricherMetadataV2 type
  V1EnricherAdapter.ts   -- Adapter class
  buildDependencyGraph.ts -- consumes/produces -> ToposortItem[]

packages/types/src/plugins.ts
  -- Add EnricherMetadataV2, consumes/produces to PluginMetadata (optional fields)
```

### 3.6 Orchestrator Changes

Minimal. The Orchestrator already:
1. Filters by phase
2. Topologically sorts via `toposort()`
3. Executes sequentially

The only change: the input to `toposort()` for ENRICHMENT phase should come from `buildDependencyGraph()` instead of directly from `dependencies`. This is a one-line change in `runPhase()`.

---

## 4. Risks and Considerations

### 4.1 Edge Types Not in EDGE_TYPE Constant

Several enricher-produced edge types (`FFI_CALLS`, `ALIAS_OF`, `HAS_PARAMETER`) exist only as string literals. The `EdgeType` type allows `| string`, so this works at runtime, but the consumes/produces declarations should use string literals where needed. Not a blocker, but worth noting for future schema tightening.

### 4.2 Enrichers That Read Nodes, Not Edges

Some enrichers (ExpressHandlerLinker, MountPointResolver, RustFFIEnricher) don't really consume edge types -- they consume **node types** created by analysis plugins. The `consumes` field for edge types won't capture this dependency.

**Mitigation:** Keep the existing `dependencies` field as a fallback. The automatic inference from consumes/produces is additive, not a replacement. Enrichers that depend on analysis-phase node types continue using explicit `dependencies`.

### 4.3 Enrichers That Both Read and Write the Same Edge Type

- `InstanceOfResolver` consumes and produces `INSTANCE_OF` (it rewires edges).
- `ValueDomainAnalyzer` consumes and produces `FLOWS_INTO` (it updates edge metadata).

This is not a cycle -- it means the enricher modifies existing edges. The dependency graph builder should handle `consumes ∩ produces != {}` by NOT creating self-dependencies.

### 4.4 Cross-Phase Dependencies

Many enrichers declare `dependencies: ['JSASTAnalyzer']` or `dependencies: ['ExpressRouteAnalyzer']`, which are ANALYSIS-phase plugins. The existing `toposort()` already handles this by silently ignoring unknown IDs (cross-phase deps). The new `buildDependencyGraph()` must do the same.

### 4.5 Unregistered Enrichers (3)

ExternalCallResolver, NodejsBuiltinsResolver, ClosureCaptureEnricher exist as source but aren't registered. The audit should include them in metadata updates, but they don't affect the v2 contract delivery. They can be registered separately.

### 4.6 `relevantFiles()` and Global Enrichers

Almost ALL current enrichers are global -- they query the entire graph, build indexes, and process everything. Making `relevantFiles()` meaningful requires enrichers to be rewritten to scope their work per-file. This is a future concern. For now, `relevantFiles()` returns empty array (= global) for all enrichers.

### 4.7 Backward Compatibility

The `V1EnricherAdapter` ensures zero breaking changes. Existing tests pass without modification. The Orchestrator can accept both V1 (Plugin) and V2 (EnricherV2) enrichers by wrapping V1 enrichers in the adapter at registration time.

### 4.8 PrefixEvaluator Reads from Filesystem

PrefixEvaluator directly reads source files with `readFileSync()` and parses AST with Babel. This is an anomaly -- other enrichers only read from the graph. It also accesses the graph's internal `nodes` Map directly (legacy pattern). This should be noted but NOT fixed as part of RFD-2.

---

## 5. Complexity Assessment

### Is ~400 LOC / ~20 tests realistic?

**LOC estimate:**

| Component | Estimated LOC |
|-----------|-------------|
| `EnricherV2.ts` (interface, types) | ~40 |
| `V1EnricherAdapter.ts` | ~50 |
| `buildDependencyGraph.ts` | ~60 |
| Metadata updates (14 enrichers x ~5 lines each) | ~70 |
| Orchestrator integration (~1 function change) | ~20 |
| Types updates (`packages/types/src/plugins.ts`) | ~20 |
| **Subtotal implementation** | **~260** |

**Test estimate:**

| Test Category | Tests | LOC |
|--------------|-------|-----|
| EnricherMetadataV2 validation (consumes/produces correctness) | 14 | ~100 |
| V1EnricherAdapter (wraps V1, produces correct metadata) | 3 | ~40 |
| buildDependencyGraph (simple graph, cycle detection, mixed V1/V2) | 5 | ~80 |
| Orchestrator integration (enrichers run in correct order) | 2 | ~30 |
| **Subtotal tests** | **~24** | **~250** |

**Total: ~510 LOC.** Slightly over the 400 LOC estimate, but realistic if the metadata updates are counted as mechanical changes (they are). The core new code is ~170 LOC.

**Verdict: YES, this is realistic.** The actual new logic is small. Most work is mechanical (auditing enrichers and adding metadata). The dependency graph builder reuses the existing `toposort()`. The adapter is trivial.

### What Makes This Task Low-Risk

1. The existing `toposort()` already does exactly what we need -- Kahn's with cycle detection.
2. The `Plugin` base class already supports `metadata.creates` and `metadata.dependencies`.
3. Adding `consumes`/`produces` is purely additive -- no existing behavior changes.
4. The V1 adapter is a thin delegation wrapper.
5. All existing enricher tests continue to pass unchanged.

### What Could Increase Scope

1. **If we try to make `relevantFiles()` actually work per-file** -- this would require rewriting each enricher. **Recommendation: DO NOT do this in RFD-2.** Leave it as a no-op default.
2. **If we try to replace `dependencies` with consumes/produces entirely** -- some enrichers depend on node types, not edge types. **Recommendation: Keep `dependencies` as fallback.**
3. **If we try to register the 3 unregistered enrichers** -- separate task, not part of RFD-2.

---

## 6. Recommended Implementation Order

1. **Define `EnricherMetadataV2` interface** in types package (extends PluginMetadata with consumes/produces)
2. **Define `EnricherV2` interface** in core (extends IPlugin with relevantFiles, processFile)
3. **Implement `V1EnricherAdapter`** (wraps Plugin -> EnricherV2)
4. **Implement `buildDependencyGraph()`** (consumes/produces -> ToposortItem[], merge with explicit deps)
5. **Write tests** for adapter, dependency graph, cycle detection
6. **Update metadata** on all 14 registered enrichers (add consumes/produces)
7. **Write metadata validation tests** (each enricher declares correct edge types)
8. **Integrate with Orchestrator** (use buildDependencyGraph in runPhase for ENRICHMENT)
9. **Verify all existing enrichment tests pass**

Steps 1-5 are independent of existing enrichers. Steps 6-7 are mechanical. Step 8 is a minimal Orchestrator change. Step 9 is regression validation.
