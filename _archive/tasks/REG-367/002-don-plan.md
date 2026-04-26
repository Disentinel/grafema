# Don Melton Plan: REG-367 -- Replace priority with declarative depends_on

## Architectural Analysis

### The Problem

The current plugin ordering system uses **numeric priority** -- a fragile, implicit ordering mechanism. The comments in the code tell the real story: every priority number is justified in terms of *another plugin*, never in absolute terms:

- `priority: 80, // After ImportExportLinker (90)`
- `priority: 45, // Runs AFTER MethodCallResolver (50)`
- `priority: 70, // After FunctionCallResolver (80)`
- `priority: 74, // After ExpressRouteAnalyzer (75)`

Every single priority is really a disguised dependency. The system already *has* the dependency information -- most plugins declare `dependencies: [...]` -- but the Orchestrator completely ignores it. We have two parallel systems saying the same thing, and the one we actually use is the worse one.

This is exactly the kind of architectural mismatch the Root Cause Policy exists for.

### What Exists Today

**`dependencies` field**: Already declared on 25 out of ~37 plugins. Already ignored. The data is there -- we just need to use it.

**Plugins missing `dependencies`**: Six enrichment plugins (InstanceOfResolver, MethodCallResolver, AliasTracker, ValueDomainAnalyzer, HTTPConnectionEnricher, ExternalCallResolver) and seven validators (DataFlowValidator, GraphConnectivityValidator, EvalBanValidator, ShadowingDetector, SQLInjectionValidator, CallResolverValidator, BrokenImportValidator) plus three indexers (JSModuleIndexer, IncrementalModuleIndexer, RustModuleIndexer) have `dependencies` but the grep didn't match because they are declared or because they're at the top of their dep chains.

Wait -- let me be precise. From the actual code:

**Plugins with `dependencies` declared:**
- WorkspaceDiscovery: `[]`
- MonorepoServiceDiscovery/DiscoveryPlugin(base): `[]`
- SimpleProjectDiscovery: `[]`
- RejectionPropagationEnricher: `['JSASTAnalyzer']`
- ExpressAnalyzer: `['JSASTAnalyzer']`
- RustAnalyzer: `['RustModuleIndexer']`
- NodejsBuiltinsResolver: `['JSASTAnalyzer', 'ImportExportLinker']`
- ArgumentParameterLinker: `['JSASTAnalyzer', 'MethodCallResolver']`
- ExternalCallResolver: `['FunctionCallResolver']`
- SQLiteAnalyzer: `['JSModuleIndexer', 'JSASTAnalyzer']`
- ImportExportLinker: `['JSASTAnalyzer']`
- MountPointResolver: `['JSModuleIndexer', 'JSASTAnalyzer', 'ExpressRouteAnalyzer']`
- ExpressRouteAnalyzer: `['JSModuleIndexer', 'JSASTAnalyzer']`
- FunctionCallResolver: `['ImportExportLinker']`
- ClosureCaptureEnricher: `['JSASTAnalyzer']`
- RustFFIEnricher: `['RustAnalyzer', 'MethodCallResolver']`
- PrefixEvaluator: `['JSModuleIndexer', 'JSASTAnalyzer', 'MountPointResolver']`
- HTTPConnectionEnricher: `['ExpressRouteAnalyzer', 'FetchAnalyzer', 'ExpressResponseAnalyzer']`
- ExpressHandlerLinker: `['JSASTAnalyzer', 'ExpressRouteAnalyzer']`
- ReactAnalyzer: `['JSASTAnalyzer']`
- IncrementalAnalysisPlugin: `['JSModuleIndexer']`
- ExpressResponseAnalyzer: `['ExpressRouteAnalyzer', 'JSASTAnalyzer']`
- SocketIOAnalyzer: `['JSModuleIndexer', 'JSASTAnalyzer']`
- DatabaseAnalyzer: `['JSASTAnalyzer']`
- FetchAnalyzer: `['JSModuleIndexer', 'JSASTAnalyzer']`
- ServiceLayerAnalyzer: `['JSModuleIndexer', 'JSASTAnalyzer']`
- JSASTAnalyzer: `['JSModuleIndexer']`
- CallResolverValidator: `['FunctionCallResolver', 'ExternalCallResolver']`
- BrokenImportValidator: `['ImportExportLinker', 'FunctionCallResolver']`
- TypeScriptDeadCodeValidator: `['JSASTAnalyzer']`

**Plugins WITHOUT `dependencies` declared** (no `dependencies` field in metadata):
- JSModuleIndexer (root -- no deps needed)
- IncrementalModuleIndexer (root -- no deps needed)
- RustModuleIndexer (root -- no deps needed)
- InstanceOfResolver
- MethodCallResolver
- AliasTracker
- ValueDomainAnalyzer
- DataFlowValidator
- GraphConnectivityValidator
- EvalBanValidator
- ShadowingDetector
- SQLInjectionValidator

## Key Design Decisions

### 1. Keep `dependencies`, don't rename to `depends_on`

**Decision: Keep `dependencies`.**

Rationale:
- Already declared on 25+ plugins. Renaming is pure churn.
- `dependencies` is the standard term (npm, Maven, Gradle, Cargo all use it).
- `depends_on` is Docker Compose terminology. We're not Docker Compose.
- The field already exists in `PluginMetadata` type. Zero type changes needed.

### 2. Cross-phase dependencies: acknowledge but don't validate

**Decision: Dependencies are intra-phase only for ordering. Cross-phase deps are informational.**

Rationale:
- Phases run in fixed order: DISCOVERY -> INDEXING -> ANALYSIS -> ENRICHMENT -> VALIDATION
- When an ENRICHMENT plugin declares `dependencies: ['JSASTAnalyzer']`, that's an ANALYSIS plugin. It already ran. The dependency is satisfied by phase ordering, not by toposort.
- Within a phase, toposort orders plugins based on intra-phase dependencies.
- Cross-phase dependencies serve documentation purpose and can be validated at startup ("plugin X depends on Y, but Y is not registered") but don't affect ordering.

**Implementation**: When building the DAG for a phase, include only same-phase plugins. Filter out cross-phase dependency names from the edge set. Optionally warn if a cross-phase dependency is not registered at all.

### 3. Cycle detection: fail hard on startup with clear error

**Decision: Kahn's algorithm, which naturally detects cycles.**

Rationale (from prior art research):
- Kahn's BFS-based approach is O(V+E) -- optimal for this.
- If after processing, not all nodes are in the sorted result, the remaining nodes form a cycle.
- The remaining nodes can be reported to identify the cycle.
- We have ~10-16 plugins per phase max. Performance is irrelevant. Clarity of error message is everything.

**Error format**:
```
Cycle detected in ENRICHMENT plugin dependencies:
  FunctionCallResolver -> ImportExportLinker -> FunctionCallResolver
Cannot determine execution order. Fix the dependency declarations.
```

### 4. Same-level ordering: registration order (stable, deterministic)

**Decision: For plugins at the same topological level (no dependency relationship between them), use registration order.**

Rationale:
- Priority as tiebreaker defeats the purpose. We're removing priority, not hiding it.
- Registration order comes from the config file (`config.yaml` plugins list). The user controls it.
- For truly independent plugins (no data dependency), order doesn't matter. If it did, they should declare a dependency.
- Kahn's algorithm with a regular queue (not priority queue) preserves insertion order naturally.
- This is deterministic: same config = same order. Always.

### 5. Remove `priority` completely

**Decision: Remove `priority` from `PluginMetadata`, from all plugins, and from Orchestrator sort code.**

Rationale:
- Keeping it as "optional tiebreaker" creates a backdoor for the old broken pattern.
- If someone adds `priority` to "fix" ordering, they're working around the dependency system.
- Clean break. No half-measures.

## Prior Art

- **Webpack Tapable**: Uses `stage` (numeric) and `before` (named) for hook ordering. The `before` option is exactly what we're doing -- naming dependencies explicitly. Tapable moved away from pure numeric ordering because it didn't scale.
- **Vite/Rollup**: Uses `enforce: 'pre' | 'post'` for coarse ordering, plus `order` on individual hooks. Less granular than our needs -- they have 3 buckets, we need full DAG.
- **npm/Cargo/Maven**: All use named dependency graphs with topological resolution. Battle-tested at massive scale.
- **Kahn's Algorithm**: Standard BFS-based topological sort. Naturally detects cycles. O(V+E). Used by package managers worldwide.

## Dependency Graph (Current State, What Toposort Should Produce)

### DISCOVERY phase
```
WorkspaceDiscovery -> []
MonorepoServiceDiscovery -> []
SimpleProjectDiscovery -> []
```
All independent. Registration order determines execution.

### INDEXING phase
```
JSModuleIndexer -> []
IncrementalModuleIndexer -> []
RustModuleIndexer -> []
```
All independent. Registration order determines execution.

### ANALYSIS phase (intra-phase deps only)
```
JSASTAnalyzer -> []  (depends on JSModuleIndexer, but that's cross-phase)
IncrementalAnalysisPlugin -> []  (depends on JSModuleIndexer, cross-phase)
SystemDbAnalyzer -> []  (no deps declared, needs adding)
ExpressAnalyzer -> []  (depends on JSASTAnalyzer but they're BOTH ANALYSIS)
```

Wait -- this is important. ExpressAnalyzer declares `dependencies: ['JSASTAnalyzer']` and both are ANALYSIS phase plugins. This IS an intra-phase dependency. Let me re-examine.

**Actually intra-phase ANALYSIS dependencies:**
- JSASTAnalyzer: `['JSModuleIndexer']` -- cross-phase (INDEXING). Effectively no intra-phase deps.
- IncrementalAnalysisPlugin: `['JSModuleIndexer']` -- cross-phase. No intra-phase deps.
- SystemDbAnalyzer: no deps declared. Needs `['JSASTAnalyzer']` based on priority 85 comment.
- ExpressAnalyzer: `['JSASTAnalyzer']` -- INTRA-PHASE. Must run after JSASTAnalyzer.
- ExpressRouteAnalyzer: `['JSModuleIndexer', 'JSASTAnalyzer']` -- JSASTAnalyzer is intra-phase.
- ExpressResponseAnalyzer: `['ExpressRouteAnalyzer', 'JSASTAnalyzer']` -- both intra-phase.
- SocketIOAnalyzer: `['JSModuleIndexer', 'JSASTAnalyzer']` -- JSASTAnalyzer is intra-phase.
- DatabaseAnalyzer: `['JSASTAnalyzer']` -- intra-phase.
- FetchAnalyzer: `['JSModuleIndexer', 'JSASTAnalyzer']` -- JSASTAnalyzer is intra-phase.
- ServiceLayerAnalyzer: `['JSModuleIndexer', 'JSASTAnalyzer']` -- JSASTAnalyzer is intra-phase.
- SQLiteAnalyzer: `['JSModuleIndexer', 'JSASTAnalyzer']` -- JSASTAnalyzer is intra-phase.
- ReactAnalyzer: `['JSASTAnalyzer']` -- intra-phase.
- RustAnalyzer: `['RustModuleIndexer']` -- cross-phase. No intra-phase deps.

**ANALYSIS toposort (intra-phase edges only):**
```
Level 0: JSASTAnalyzer, IncrementalAnalysisPlugin, RustAnalyzer
Level 1: ExpressAnalyzer, ExpressRouteAnalyzer, SocketIOAnalyzer, DatabaseAnalyzer,
         FetchAnalyzer, ServiceLayerAnalyzer, SQLiteAnalyzer, ReactAnalyzer, SystemDbAnalyzer
Level 2: ExpressResponseAnalyzer (depends on ExpressRouteAnalyzer AND JSASTAnalyzer)
```

### ENRICHMENT phase (intra-phase deps only)
```
InstanceOfResolver: []  (needs deps: currently priority 100, runs first -- investigate why)
ImportExportLinker: []  (depends on JSASTAnalyzer -- cross-phase)
MountPointResolver: ['ExpressRouteAnalyzer'] -- cross-phase only. No intra-phase deps.
FunctionCallResolver: ['ImportExportLinker'] -- INTRA-PHASE
PrefixEvaluator: ['MountPointResolver'] -- INTRA-PHASE
ExternalCallResolver: ['FunctionCallResolver'] -- INTRA-PHASE
RejectionPropagationEnricher: [] -- depends on JSASTAnalyzer (cross-phase)
ValueDomainAnalyzer: [] -- needs deps (currently priority 65, "after AliasTracker")
AliasTracker: [] -- needs deps (currently priority 60, "after MethodCallResolver")
MethodCallResolver: [] -- needs deps (currently priority 50)
ExpressHandlerLinker: ['ExpressRouteAnalyzer'] -- cross-phase only
HTTPConnectionEnricher: ['ExpressRouteAnalyzer', 'FetchAnalyzer', 'ExpressResponseAnalyzer'] -- all cross-phase
NodejsBuiltinsResolver: ['ImportExportLinker'] -- INTRA-PHASE (JSASTAnalyzer is cross-phase)
ArgumentParameterLinker: ['MethodCallResolver'] -- INTRA-PHASE (JSASTAnalyzer is cross-phase)
ClosureCaptureEnricher: [] -- depends on JSASTAnalyzer (cross-phase)
RustFFIEnricher: ['MethodCallResolver'] -- INTRA-PHASE (RustAnalyzer is cross-phase)
```

**ENRICHMENT plugins needing `dependencies` added (based on priority comments):**
- InstanceOfResolver: Should declare `[]` (truly first, no enrichment deps)
- MethodCallResolver: Should declare `['ImportExportLinker']` (priority 50, needs import resolution)
- AliasTracker: Should declare `['MethodCallResolver']` (priority 60, "after MethodCallResolver")
- ValueDomainAnalyzer: Should declare `['AliasTracker']` (priority 65, "after AliasTracker")

**ENRICHMENT toposort:**
```
Level 0: InstanceOfResolver, ImportExportLinker, MountPointResolver,
         RejectionPropagationEnricher, ExpressHandlerLinker,
         HTTPConnectionEnricher, ClosureCaptureEnricher
Level 1: FunctionCallResolver, PrefixEvaluator, NodejsBuiltinsResolver, MethodCallResolver
Level 2: ExternalCallResolver, ArgumentParameterLinker, AliasTracker, RustFFIEnricher
Level 3: ValueDomainAnalyzer
```

### VALIDATION phase (intra-phase deps)
All validators depend on enrichment plugins (cross-phase). No validator depends on another validator.

```
Level 0: DataFlowValidator, GraphConnectivityValidator, EvalBanValidator,
         CallResolverValidator, SQLInjectionValidator, BrokenImportValidator,
         ShadowingDetector, TypeScriptDeadCodeValidator
```

All validators are independent of each other. Registration order.

## Risks and Constraints

### Risk 1: Missing dependencies on plugins that currently rely on priority
**Severity: MEDIUM**
**Mitigation**: The migration table below identifies every plugin that needs `dependencies` added. We verify the toposort output matches the current priority-based order.

### Risk 2: Cross-phase dependencies that look intra-phase
**Severity: LOW**
**Mitigation**: The algorithm partitions by phase first, then toposorts within. Cross-phase deps are filtered out of the DAG edges but validated for existence.

### Risk 3: Third-party / custom plugins still using priority
**Severity: LOW**
**Mitigation**: The `priority` field becomes deprecated first (warn if set), then removed. Custom plugins loaded from `.grafema/plugins/` that set priority get a warning. This is a breaking change -- document in CHANGELOG.

### Risk 4: Incorrect dependency declarations causing wrong order
**Severity: MEDIUM**
**Mitigation**:
1. Write tests that verify the toposort output matches expected order for all phases.
2. Validate that all declared dependencies reference registered plugins.
3. Integration tests that run the full pipeline.

### Risk 5: Discovery phase -- WorkspaceDiscovery MUST run before SimpleProjectDiscovery
**Severity: HIGH**
**Mitigation**: WorkspaceDiscovery currently has priority 110, SimpleProjectDiscovery has 50. They don't declare inter-dependencies. But the current code runs ALL discovery plugins and collects ALL services -- it doesn't stop after the first. So the order might not actually matter for correctness. Need to verify: does SimpleProjectDiscovery check if services already exist? If not, running order among independent discovery plugins might not matter. If it does, SimpleProjectDiscovery should declare `dependencies: ['WorkspaceDiscovery']` or we need a different mechanism (e.g., fallback pattern).

After examining the discovery code: SimpleProjectDiscovery runs independently and creates its own SERVICE node. WorkspaceDiscovery and MonorepoServiceDiscovery do the same. The Orchestrator collects ALL services from ALL discovery plugins. So order among discovery plugins is currently irrelevant -- they all contribute to the manifest. No risk here.

## High-Level Plan

### Step 1: Add `dependencies` to all plugins that are missing them (no behavior change)
- Add proper `dependencies` arrays to the ~12 plugins that don't have them
- Based on the priority analysis above
- All tests pass -- no behavior change yet

### Step 2: Implement toposort utility
- New file: `packages/core/src/core/toposort.ts`
- Kahn's algorithm with cycle detection
- Returns sorted list + error on cycle
- Thorough unit tests

### Step 3: Replace priority-based sort in Orchestrator.runPhase()
- Replace lines 840-843 (and 778-780) with toposort call
- Filter deps to intra-phase only
- Validate all declared deps reference registered plugins
- Log the computed execution order

### Step 4: Remove `priority` from PluginMetadata type
- Remove from `packages/types/src/plugins.ts`
- Remove from all plugins
- Update config documentation

### Step 5: Add startup validation
- On Orchestrator construction, validate:
  1. No cycles in any phase's dependency graph
  2. All declared dependencies reference registered plugins (warn for cross-phase, error for missing)
- Clear error messages with the cycle path

### Step 6: Update tests
- Unit tests for toposort (edge cases: empty, single, cycle, diamond, etc.)
- Integration test: verify execution order matches expected for default config
- Regression test: verify the full analysis pipeline still works

## Migration Table: Plugins Needing `dependencies` Added

| Plugin | Phase | Current Priority | Dependencies to Add | Rationale |
|--------|-------|-----------------|---------------------|-----------|
| InstanceOfResolver | ENRICHMENT | 100 | `[]` | Truly first enricher, no enrichment-phase deps |
| MethodCallResolver | ENRICHMENT | 50 | `['ImportExportLinker']` | Needs IMPORTS_FROM edges to resolve methods |
| AliasTracker | ENRICHMENT | 60 | `['MethodCallResolver']` | "After MethodCallResolver" per comment |
| ValueDomainAnalyzer | ENRICHMENT | 65 | `['AliasTracker']` | "After AliasTracker" per comment |
| SystemDbAnalyzer | ANALYSIS | 85 | `['JSASTAnalyzer']` | "Run after JSASTAnalyzer" per comment |
| DataFlowValidator | VALIDATION | 100 | `[]` | No intra-phase deps |
| GraphConnectivityValidator | VALIDATION | 100 | `[]` | No intra-phase deps |
| EvalBanValidator | VALIDATION | 95 | `[]` | No intra-phase deps |
| ShadowingDetector | VALIDATION | 80 | `[]` | No intra-phase deps |
| SQLInjectionValidator | VALIDATION | 90 | `['ValueDomainAnalyzer']` | "After ValueDomainAnalyzer (65)" but VDA is ENRICHMENT -- so actually `[]` intra-phase |

Correction: SQLInjectionValidator's dependency on ValueDomainAnalyzer is cross-phase (ENRICHMENT -> VALIDATION). All validators are effectively `dependencies: []` for intra-phase ordering.

## Files to Modify

1. `packages/types/src/plugins.ts` -- Remove `priority` from `PluginMetadata`
2. `packages/core/src/core/toposort.ts` -- NEW: Kahn's algorithm implementation
3. `packages/core/src/Orchestrator.ts` -- Replace sort with toposort, add validation
4. All plugin files (~37 files) -- Remove `priority`, add missing `dependencies`
5. `packages/cli/src/commands/analyze.ts` -- No changes needed (plugins constructed from config)
6. `packages/core/src/config/ConfigLoader.ts` -- No changes needed (config lists plugin names, not priorities)
7. Test files -- New tests for toposort, updated integration tests

## Estimated Scope

- Toposort implementation + tests: ~150 lines
- Orchestrator changes: ~50 lines changed
- Plugin metadata updates: ~37 files, ~2-5 lines each
- New tests: ~200 lines
- **Total: ~500 lines changed, ~350 lines new**

## Open Question for Joel

The `IncrementalModuleIndexer` has the same priority (90) as `JSModuleIndexer` and both are INDEXING phase with no declared deps. Are they mutually exclusive (config picks one or the other) or do they both run? If both run, does order matter? If yes, one should depend on the other.

Looking at the config: `DEFAULT_CONFIG` only lists `JSModuleIndexer` for indexing. `IncrementalModuleIndexer` is an alternative. So they're mutually exclusive -- no issue.
