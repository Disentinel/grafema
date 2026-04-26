# RFD-2: Enricher Contract v2 -- Joel Spolsky Technical Plan

## Summary

This document expands Don's analysis (002-don-analysis.md) into a step-by-step implementation spec. Each step identifies exact files, interfaces, functions, imports, and expected behavior.

**Total estimated work:**
- ~260 LOC implementation + ~250 LOC tests = ~510 LOC
- 9 implementation steps, 24 test cases
- Zero breaking changes (V1 adapter ensures backward compatibility)

---

## Step 1: Add `EnricherMetadataV2` to `@grafema/types`

**File:** `packages/types/src/plugins.ts`

**What:** Add new interface extending `PluginMetadata` with `consumes`/`produces` fields.

**Where:** After the existing `PluginMetadata` interface (line ~51).

**Exact interface:**

```typescript
/**
 * Extended metadata for Enricher Contract v2 (RFD-2).
 *
 * Adds explicit consumes/produces declarations for edge and node types.
 * This enables automatic dependency inference from data flow
 * instead of manual `dependencies` arrays.
 *
 * When to use: All ENRICHMENT-phase plugins should declare this.
 * The `consumes` field documents which edge types the enricher reads.
 * The `produces` field documents which edge types the enricher creates/modifies.
 * Together they enable `buildDependencyGraph()` to infer execution order.
 *
 * @example
 * ```typescript
 * get metadata(): EnricherMetadataV2 {
 *   return {
 *     name: 'FunctionCallResolver',
 *     phase: 'ENRICHMENT',
 *     consumes: { edges: ['IMPORTS_FROM'] },
 *     produces: { edges: ['CALLS'], nodes: ['EXTERNAL_MODULE'] },
 *     dependencies: ['ImportExportLinker'],
 *   };
 * }
 * ```
 */
export interface EnricherMetadataV2 extends PluginMetadata {
  /**
   * Edge types this enricher reads from the graph.
   * Used for automatic dependency inference: if enricher A produces edge type E,
   * and enricher B consumes edge type E, then B depends on A.
   *
   * Empty array means the enricher doesn't read any edges created by other enrichers
   * (it may still read nodes created by analysis-phase plugins).
   */
  consumes: {
    edges: EdgeType[];
    /** Node types read (documentation/validation only, not used for dependency inference) */
    nodes?: NodeType[];
  };

  /**
   * Edge/node types this enricher creates or modifies.
   * Used for automatic dependency inference.
   */
  produces: {
    edges: EdgeType[];
    /** Node types created (documentation/validation only, not used for dependency inference) */
    nodes?: NodeType[];
  };
}
```

**Imports needed:** None new -- `EdgeType` and `NodeType` are already in scope via the same package.

**Export:** Already exported via `export * from './plugins.js'` in `packages/types/src/index.ts`.

**Design decision -- nested `consumes.edges`/`produces.edges` vs flat `consumes: EdgeType[]`:**

Don's analysis used flat arrays (`consumes: EdgeType[]`). I'm recommending nested objects (`consumes: { edges: EdgeType[], nodes?: NodeType[] }`) because:

1. It mirrors the existing `creates: { nodes?: NodeType[], edges?: EdgeType[] }` pattern already in `PluginMetadata`
2. It keeps a clear slot for future node-type consumption tracking
3. It avoids the confusion of having `consumes` (edges only) alongside `consumesNodes` (separate optional field)

This is a small deviation from Don's spec. If the team prefers flat arrays for simplicity, the code is trivially adjustable.

---

## Step 2: Create `EnricherV2` interface in core

**File:** `packages/core/src/plugins/enrichment/EnricherV2.ts` (new file)

**What:** Defines the `EnricherV2` interface extending `IPlugin` with V2 metadata, `relevantFiles()`, and `processFile()`.

**Exact code structure:**

```typescript
/**
 * EnricherV2 -- Enricher Contract v2 interface (RFD-2).
 *
 * Extends the base IPlugin with:
 * - EnricherMetadataV2 (consumes/produces for automatic dependency inference)
 * - relevantFiles() (future: per-file incremental enrichment)
 * - processFile() (future: per-file processing hook)
 *
 * All existing enrichers continue to work via V1EnricherAdapter.
 * New enrichers should implement this interface directly.
 *
 * @example
 * ```typescript
 * class MyEnricher extends Plugin implements EnricherV2 {
 *   get metadata(): EnricherMetadataV2 { ... }
 *   async execute(context: PluginContext): Promise<PluginResult> { ... }
 * }
 * ```
 */

import type { IPlugin, PluginContext, PluginResult, EnricherMetadataV2 } from '@grafema/types';

export interface EnricherV2 extends IPlugin {
  metadata: EnricherMetadataV2;

  /**
   * Return files relevant to this enricher given the set of changed files.
   * Default behavior (if not implemented): all files are relevant (global pass).
   *
   * Enrichers that operate globally should either:
   * - Not implement this method (default = global)
   * - Return an empty array (explicit global signal)
   *
   * This is a FUTURE hook for incremental enrichment. No enricher implements
   * this in the initial RFD-2 delivery.
   */
  relevantFiles?(changedFiles: string[]): string[];

  /**
   * Process a single file. Optional -- if not implemented, execute() is used.
   * This is a FUTURE hook for per-file incremental enrichment.
   *
   * No enricher implements this in the initial RFD-2 delivery.
   */
  processFile?(file: string, context: PluginContext): Promise<PluginResult>;
}

/**
 * Type guard: check if a plugin implements EnricherV2.
 *
 * Tests for the presence of `consumes` and `produces` in metadata,
 * which distinguishes V2 enrichers from V1 plugins.
 */
export function isEnricherV2(plugin: IPlugin): plugin is EnricherV2 {
  const meta = plugin.metadata as Record<string, unknown>;
  return meta != null && 'consumes' in meta && 'produces' in meta;
}
```

**Export from core index:** Add to `packages/core/src/index.ts`:

```typescript
export { isEnricherV2 } from './plugins/enrichment/EnricherV2.js';
export type { EnricherV2 } from './plugins/enrichment/EnricherV2.js';
```

---

## Step 3: Implement `V1EnricherAdapter`

**File:** `packages/core/src/plugins/enrichment/V1EnricherAdapter.ts` (new file)

**What:** Wraps a V1 `Plugin` instance to satisfy the `EnricherV2` interface. Extracts what it can from existing `PluginMetadata.creates`, leaves `consumes` empty.

**Exact code structure:**

```typescript
/**
 * V1EnricherAdapter -- wraps a legacy Plugin as an EnricherV2.
 *
 * Existing enrichers that extend Plugin (V1 contract) are wrapped in this
 * adapter so the Orchestrator can treat all enrichers uniformly as EnricherV2.
 *
 * Behavior:
 * - `consumes.edges` = [] (unknown -- V1 enrichers didn't declare this)
 * - `produces.edges` = metadata.creates.edges ?? []
 * - `produces.nodes` = metadata.creates.nodes ?? []
 * - `relevantFiles()` = not implemented (global pass)
 * - `execute()` delegates to the wrapped plugin
 *
 * Because `consumes` is empty, `buildDependencyGraph()` cannot infer
 * dependencies automatically. It falls back to `metadata.dependencies`
 * for V1-adapted enrichers.
 */

import type { IPlugin, PluginContext, PluginResult, PluginMetadata, EnricherMetadataV2 } from '@grafema/types';
import type { EnricherV2 } from './EnricherV2.js';

export class V1EnricherAdapter implements EnricherV2 {
  config: Record<string, unknown>;

  constructor(private readonly legacy: IPlugin) {
    this.config = legacy.config;
  }

  get metadata(): EnricherMetadataV2 {
    const base = this.legacy.metadata;
    return {
      ...base,
      consumes: {
        edges: [],
      },
      produces: {
        edges: base.creates?.edges ?? [],
        nodes: base.creates?.nodes ?? [],
      },
    };
  }

  async initialize(context: PluginContext): Promise<void> {
    return this.legacy.initialize?.(context);
  }

  async execute(context: PluginContext): Promise<PluginResult> {
    return this.legacy.execute(context);
  }

  async cleanup(): Promise<void> {
    return this.legacy.cleanup?.();
  }
}
```

**Export from core index:** Add to `packages/core/src/index.ts`:

```typescript
export { V1EnricherAdapter } from './plugins/enrichment/V1EnricherAdapter.js';
```

---

## Step 4: Implement `buildDependencyGraph()`

**File:** `packages/core/src/core/buildDependencyGraph.ts` (new file)

**What:** Converts enricher `consumes`/`produces` declarations into `ToposortItem[]` for the existing `toposort()` function.

**Algorithm:**

1. Build producer index: `Map<EdgeType, string[]>` mapping each edge type to the enricher name(s) that produce it.
2. For each enricher, compute dependencies:
   - **Layer 1 (automatic):** For each edge type in `consumes.edges`, find all producers. Add as dependency (excluding self).
   - **Layer 2 (explicit fallback):** Merge in `metadata.dependencies` (handles cross-phase deps and V1 enrichers with empty consumes).
3. Return `ToposortItem[]` with `{ id, dependencies }`.

**Exact code:**

```typescript
/**
 * Build dependency graph from EnricherV2 consumes/produces declarations (RFD-2).
 *
 * Two-layer dependency resolution:
 *
 * Layer 1 (automatic): If enricher A produces edge type E,
 *   and enricher B consumes edge type E, then B depends on A.
 *   Self-references (consumes intersect produces on same enricher)
 *   are excluded to avoid self-cycles.
 *
 * Layer 2 (explicit fallback): metadata.dependencies are merged in.
 *   This handles:
 *   - Cross-phase deps (e.g., 'JSASTAnalyzer' from ANALYSIS phase)
 *   - V1 enrichers via adapter (consumes = [], so Layer 1 yields nothing)
 *   - Ordering hints that can't be inferred from edge types
 *
 * The result feeds directly into toposort() from core/toposort.ts.
 * Cross-phase dependencies are silently ignored by toposort (existing behavior).
 *
 * Complexity: O(E + P) where E = number of enrichers, P = total produces entries.
 * Building the producer index is O(E * avgProduces) = O(P).
 * Computing dependencies per enricher is O(C * lookup) where C = consumes entries.
 * Total: O(P + E * C) which is O(E + P) since C <= P.
 *
 * @param enrichers - Array of EnricherV2 instances (or V1-adapted)
 * @returns ToposortItem[] ready for toposort()
 */

import type { EnricherMetadataV2, EdgeType } from '@grafema/types';
import type { EnricherV2 } from '../plugins/enrichment/EnricherV2.js';
import type { ToposortItem } from './toposort.js';

export function buildDependencyGraph(enrichers: EnricherV2[]): ToposortItem[] {
  // Step 1: Build producer index -- Map<EdgeType, enricherNames[]>
  const producers = new Map<EdgeType, string[]>();

  for (const enricher of enrichers) {
    const meta = enricher.metadata;
    for (const edgeType of meta.produces.edges) {
      let list = producers.get(edgeType);
      if (!list) {
        list = [];
        producers.set(edgeType, list);
      }
      list.push(meta.name);
    }
  }

  // Step 2: Build ToposortItem[] with merged dependencies
  return enrichers.map(enricher => {
    const meta = enricher.metadata;
    const deps = new Set<string>();

    // Layer 1: Automatic inference from consumes/produces
    for (const edgeType of meta.consumes.edges) {
      const edgeProducers = producers.get(edgeType);
      if (!edgeProducers) continue;

      for (const producerName of edgeProducers) {
        // Exclude self-reference (enricher consumes what it also produces)
        if (producerName !== meta.name) {
          deps.add(producerName);
        }
      }
    }

    // Layer 2: Merge explicit dependencies (V1 fallback + cross-phase + hints)
    if (meta.dependencies) {
      for (const dep of meta.dependencies) {
        deps.add(dep);
      }
    }

    return {
      id: meta.name,
      dependencies: [...deps],
    };
  });
}
```

**Export from core index:** Add to `packages/core/src/index.ts`:

```typescript
export { buildDependencyGraph } from './core/buildDependencyGraph.js';
```

**Complexity verification:**
- Building producer index: iterates all enrichers, for each iterates produces.edges. Total: O(sum of produces entries) = O(P).
- Computing dependencies: iterates all enrichers, for each iterates consumes.edges, for each looks up producers (O(1) Map lookup) and iterates producer list. Worst case: O(E * C * maxProducers). In practice, maxProducers is tiny (1-3 enrichers per edge type), and C is small (0-5). So effectively O(E).
- Merging explicit dependencies: O(E * D) where D = avg explicit deps. D is small (0-3).
- **Total: O(E + P)** as required.

---

## Step 5: Orchestrator Integration

**File:** `packages/core/src/Orchestrator.ts`

**What:** Modify `runPhase()` to use `buildDependencyGraph()` for the ENRICHMENT phase instead of building toposort input directly from `metadata.dependencies`.

**Exact change location:** `runPhase()` method, lines 941-959. Currently:

```typescript
async runPhase(phaseName: string, context: ...): Promise<void> {
    // Filter plugins for this phase
    const phasePlugins = this.plugins.filter(plugin =>
      plugin.metadata.phase === phaseName
    );

    // Topological sort by dependencies (REG-367)
    const pluginMap = new Map(phasePlugins.map(p => [p.metadata.name, p]));
    const sortedIds = toposort(
      phasePlugins.map(p => ({
        id: p.metadata.name,
        dependencies: p.metadata.dependencies ?? [],
      }))
    );
    phasePlugins.length = 0;
    for (const id of sortedIds) {
      const plugin = pluginMap.get(id);
      if (plugin) phasePlugins.push(plugin);
    }
    // ... execute sequentially
```

**New code:** Replace the toposort block (lines 948-959) with:

```typescript
    // Topological sort by dependencies (REG-367, RFD-2)
    const pluginMap = new Map(phasePlugins.map(p => [p.metadata.name, p]));

    let sortedIds: string[];
    if (phaseName === 'ENRICHMENT') {
      // RFD-2: Use consumes/produces-based dependency graph for ENRICHMENT
      const { buildDependencyGraph } = await import('./core/buildDependencyGraph.js');
      const { isEnricherV2 } = await import('./plugins/enrichment/EnricherV2.js');
      const { V1EnricherAdapter } = await import('./plugins/enrichment/V1EnricherAdapter.js');

      const enrichersV2 = phasePlugins.map(p =>
        isEnricherV2(p) ? p : new V1EnricherAdapter(p)
      );
      const depGraph = buildDependencyGraph(enrichersV2);
      sortedIds = toposort(depGraph);
    } else {
      // Other phases: use explicit dependencies (existing behavior)
      sortedIds = toposort(
        phasePlugins.map(p => ({
          id: p.metadata.name,
          dependencies: p.metadata.dependencies ?? [],
        }))
      );
    }

    phasePlugins.length = 0;
    for (const id of sortedIds) {
      const plugin = pluginMap.get(id);
      if (plugin) phasePlugins.push(plugin);
    }
```

**Import needed:** Add at the top of Orchestrator.ts (dynamic imports used instead to avoid circular deps, but the types need to be importable):

No new static imports needed -- we use dynamic `import()` to keep the dependency graph lazy.

**Design note:** Using dynamic imports prevents loading V2 infrastructure for non-ENRICHMENT phases. This is a zero-cost abstraction for DISCOVERY, INDEXING, ANALYSIS, and VALIDATION phases.

**Behavioral guarantee:** When ALL enrichers are V1 (wrapped in V1EnricherAdapter with `consumes.edges = []`), the dependency graph degrades to exactly the current behavior because:
- Layer 1 infers nothing (all consumes are empty)
- Layer 2 copies `metadata.dependencies` verbatim
- Same input to `toposort()` = same output

This means the change is safe to deploy even before enrichers are updated with V2 metadata.

---

## Step 6: Update Metadata on All 14 Registered Enrichers

**What:** Add `consumes` and `produces` fields to each enricher's metadata getter. Change the return type from `PluginMetadata` to `EnricherMetadataV2`. The existing `creates` field REMAINS for backward compatibility (it's still used by `registerPluginNodes()`).

**Import needed in each file:** Add `EnricherMetadataV2` to the import from `@grafema/types`:

```typescript
import type { EnricherMetadataV2 } from '@grafema/types';
```

And change the metadata getter return type from `PluginMetadata` to `EnricherMetadataV2`.

### 6.1 ImportExportLinker

**File:** `packages/core/src/plugins/enrichment/ImportExportLinker.ts`

```typescript
get metadata(): EnricherMetadataV2 {
  return {
    name: 'ImportExportLinker',
    phase: 'ENRICHMENT',
    creates: { nodes: [], edges: ['IMPORTS', 'IMPORTS_FROM'] },
    consumes: { edges: [], nodes: ['IMPORT', 'EXPORT', 'MODULE'] },
    produces: { edges: ['IMPORTS', 'IMPORTS_FROM'] },
    dependencies: ['JSASTAnalyzer'],
  };
}
```

### 6.2 FunctionCallResolver

**File:** `packages/core/src/plugins/enrichment/FunctionCallResolver.ts`

```typescript
get metadata(): EnricherMetadataV2 {
  return {
    name: 'FunctionCallResolver',
    phase: 'ENRICHMENT',
    creates: { nodes: ['EXTERNAL_MODULE'], edges: ['CALLS'] },
    consumes: { edges: ['IMPORTS_FROM'], nodes: ['CALL', 'IMPORT', 'EXPORT', 'FUNCTION'] },
    produces: { edges: ['CALLS'], nodes: ['EXTERNAL_MODULE'] },
    dependencies: ['ImportExportLinker'],
  };
}
```

### 6.3 MethodCallResolver

**File:** `packages/core/src/plugins/enrichment/MethodCallResolver.ts`

```typescript
get metadata(): EnricherMetadataV2 {
  return {
    name: 'MethodCallResolver',
    phase: 'ENRICHMENT',
    creates: { nodes: [], edges: ['CALLS'] },
    consumes: { edges: ['CONTAINS', 'INSTANCE_OF', 'DERIVES_FROM'], nodes: ['CALL', 'CLASS', 'METHOD', 'FUNCTION'] },
    produces: { edges: ['CALLS'] },
    dependencies: ['ImportExportLinker'],
  };
}
```

### 6.4 ArgumentParameterLinker

**File:** `packages/core/src/plugins/enrichment/ArgumentParameterLinker.ts`

```typescript
get metadata(): EnricherMetadataV2 {
  return {
    name: 'ArgumentParameterLinker',
    phase: 'ENRICHMENT',
    creates: { nodes: [], edges: ['RECEIVES_ARGUMENT'] },
    consumes: { edges: ['PASSES_ARGUMENT', 'CALLS', 'HAS_PARAMETER', 'RECEIVES_ARGUMENT'], nodes: ['CALL', 'PARAMETER'] },
    produces: { edges: ['RECEIVES_ARGUMENT'] },
    dependencies: ['JSASTAnalyzer', 'MethodCallResolver'],
  };
}
```

### 6.5 CallbackCallResolver

**File:** `packages/core/src/plugins/enrichment/CallbackCallResolver.ts`

```typescript
get metadata(): EnricherMetadataV2 {
  return {
    name: 'CallbackCallResolver',
    phase: 'ENRICHMENT',
    creates: { edges: ['CALLS'] },
    consumes: { edges: ['PASSES_ARGUMENT', 'IMPORTS_FROM'], nodes: ['CALL', 'METHOD_CALL', 'IMPORT', 'EXPORT', 'FUNCTION'] },
    produces: { edges: ['CALLS'] },
    dependencies: ['ImportExportLinker', 'FunctionCallResolver'],
  };
}
```

### 6.6 AliasTracker

**File:** `packages/core/src/plugins/enrichment/AliasTracker.ts`

```typescript
get metadata(): EnricherMetadataV2 {
  return {
    name: 'AliasTracker',
    phase: 'ENRICHMENT',
    creates: { nodes: [], edges: ['CALLS', 'ALIAS_OF'] },
    consumes: { edges: ['ASSIGNED_FROM', 'CALLS', 'CONTAINS', 'INSTANCE_OF'], nodes: ['CALL', 'VARIABLE', 'CONSTANT', 'CLASS', 'METHOD', 'FUNCTION', 'EXPRESSION'] },
    produces: { edges: ['CALLS', 'ALIAS_OF'] },
    dependencies: ['MethodCallResolver'],
  };
}
```

### 6.7 ValueDomainAnalyzer

**File:** `packages/core/src/plugins/enrichment/ValueDomainAnalyzer.ts`

```typescript
get metadata(): EnricherMetadataV2 {
  return {
    name: 'ValueDomainAnalyzer',
    phase: 'ENRICHMENT',
    creates: { nodes: [], edges: ['CALLS', 'FLOWS_INTO'] },
    consumes: { edges: ['ASSIGNED_FROM', 'FLOWS_INTO', 'CONTAINS'], nodes: ['CALL', 'VARIABLE', 'CONSTANT', 'FUNCTION', 'CLASS', 'SCOPE', 'PARAMETER'] },
    produces: { edges: ['CALLS', 'FLOWS_INTO'] },
    dependencies: ['AliasTracker'],
  };
}
```

### 6.8 InstanceOfResolver

**File:** `packages/core/src/plugins/enrichment/InstanceOfResolver.ts`

```typescript
get metadata(): EnricherMetadataV2 {
  return {
    name: 'InstanceOfResolver',
    phase: 'ENRICHMENT',
    creates: { nodes: [], edges: ['INSTANCE_OF'] },
    consumes: { edges: ['INSTANCE_OF'], nodes: ['CLASS', 'IMPORT'] },
    produces: { edges: ['INSTANCE_OF'] },
    dependencies: ['JSASTAnalyzer'],
  };
}
```

**Note:** InstanceOfResolver both consumes and produces `INSTANCE_OF`. This is NOT a cycle -- it reads existing stub edges and re-creates them resolved. The self-reference exclusion in `buildDependencyGraph()` handles this correctly.

### 6.9 MountPointResolver

**File:** `packages/core/src/plugins/enrichment/MountPointResolver.ts`

```typescript
get metadata(): EnricherMetadataV2 {
  return {
    name: 'MountPointResolver',
    phase: 'ENRICHMENT',
    creates: { nodes: [], edges: [] },
    consumes: { edges: [], nodes: ['express:middleware', 'express:mount', 'http:route', 'IMPORT'] },
    produces: { edges: [] },
    dependencies: ['JSModuleIndexer', 'JSASTAnalyzer', 'ExpressRouteAnalyzer'],
  };
}
```

**Note:** MountPointResolver primarily consumes node types from analysis-phase plugins, not edge types from other enrichers. Its `consumes.edges` is empty. Ordering is ensured by explicit `dependencies`.

### 6.10 ExpressHandlerLinker

**File:** `packages/core/src/plugins/enrichment/ExpressHandlerLinker.ts`

```typescript
get metadata(): EnricherMetadataV2 {
  return {
    name: 'ExpressHandlerLinker',
    phase: 'ENRICHMENT',
    creates: { nodes: [], edges: ['HANDLED_BY'] },
    consumes: { edges: [], nodes: ['http:route', 'FUNCTION'] },
    produces: { edges: ['HANDLED_BY'] },
    dependencies: ['JSASTAnalyzer', 'ExpressRouteAnalyzer'],
  };
}
```

### 6.11 PrefixEvaluator

**File:** `packages/core/src/plugins/enrichment/PrefixEvaluator.ts`

```typescript
get metadata(): EnricherMetadataV2 {
  return {
    name: 'PrefixEvaluator',
    phase: 'ENRICHMENT',
    creates: { nodes: [], edges: [] },
    consumes: { edges: ['DEFINES'], nodes: ['MOUNT_POINT', 'MODULE'] },
    produces: { edges: [] },
    dependencies: ['JSModuleIndexer', 'JSASTAnalyzer', 'MountPointResolver'],
  };
}
```

### 6.12 HTTPConnectionEnricher

**File:** `packages/core/src/plugins/enrichment/HTTPConnectionEnricher.ts`

```typescript
get metadata(): EnricherMetadataV2 {
  return {
    name: 'HTTPConnectionEnricher',
    phase: 'ENRICHMENT',
    creates: { nodes: [], edges: ['INTERACTS_WITH', 'HTTP_RECEIVES'] },
    consumes: { edges: ['RESPONDS_WITH'], nodes: ['http:route', 'http:request'] },
    produces: { edges: ['INTERACTS_WITH', 'HTTP_RECEIVES'] },
    dependencies: ['ExpressRouteAnalyzer', 'FetchAnalyzer', 'ExpressResponseAnalyzer'],
  };
}
```

### 6.13 RustFFIEnricher

**File:** `packages/core/src/plugins/enrichment/RustFFIEnricher.ts`

```typescript
get metadata(): EnricherMetadataV2 {
  return {
    name: 'RustFFIEnricher',
    phase: 'ENRICHMENT',
    creates: { nodes: [], edges: ['FFI_CALLS'] },
    consumes: { edges: [], nodes: ['CALL', 'RUST_FUNCTION', 'RUST_METHOD'] },
    produces: { edges: ['FFI_CALLS'] },
    dependencies: ['RustAnalyzer', 'MethodCallResolver'],
  };
}
```

### 6.14 RejectionPropagationEnricher

**File:** `packages/core/src/plugins/enrichment/RejectionPropagationEnricher.ts`

```typescript
get metadata(): EnricherMetadataV2 {
  return {
    name: 'RejectionPropagationEnricher',
    phase: 'ENRICHMENT',
    creates: { nodes: [], edges: ['REJECTS'] },
    consumes: { edges: ['CALLS', 'REJECTS', 'CONTAINS', 'HAS_SCOPE'], nodes: ['FUNCTION', 'CALL'] },
    produces: { edges: ['REJECTS'] },
    dependencies: ['JSASTAnalyzer'],
  };
}
```

**Note:** RejectionPropagationEnricher consumes `CALLS` edges, which are produced by FunctionCallResolver, MethodCallResolver, AliasTracker, etc. Currently it only declares `dependencies: ['JSASTAnalyzer']` which is insufficient -- it should arguably depend on the call resolvers. With V2, `buildDependencyGraph()` will automatically infer dependency on ALL enrichers that produce `CALLS`, giving it correct ordering for free. This is a concrete example of the V2 contract improving correctness.

---

## Step 7: Update Unregistered Enrichers (3)

**What:** Also update the 3 unregistered enrichers for completeness. They exist as source and may be registered in the future.

### 7.1 ExternalCallResolver

**File:** `packages/core/src/plugins/enrichment/ExternalCallResolver.ts`

```typescript
get metadata(): EnricherMetadataV2 {
  return {
    name: 'ExternalCallResolver',
    phase: 'ENRICHMENT',
    creates: { nodes: ['EXTERNAL_MODULE'], edges: ['CALLS'] },
    consumes: { edges: ['CALLS'], nodes: ['CALL', 'IMPORT'] },
    produces: { edges: ['CALLS'], nodes: ['EXTERNAL_MODULE'] },
    dependencies: ['FunctionCallResolver'],
  };
}
```

### 7.2 NodejsBuiltinsResolver

**File:** `packages/core/src/plugins/enrichment/NodejsBuiltinsResolver.ts`

```typescript
get metadata(): EnricherMetadataV2 {
  return {
    name: 'NodejsBuiltinsResolver',
    phase: 'ENRICHMENT',
    creates: { nodes: ['EXTERNAL_FUNCTION', 'EXTERNAL_MODULE'], edges: ['CALLS', 'IMPORTS_FROM'] },
    consumes: { edges: ['IMPORTS_FROM'], nodes: ['IMPORT', 'CALL'] },
    produces: { edges: ['CALLS', 'IMPORTS_FROM'], nodes: ['EXTERNAL_FUNCTION', 'EXTERNAL_MODULE'] },
    dependencies: ['JSASTAnalyzer', 'ImportExportLinker'],
  };
}
```

### 7.3 ClosureCaptureEnricher

**File:** `packages/core/src/plugins/enrichment/ClosureCaptureEnricher.ts`

```typescript
get metadata(): EnricherMetadataV2 {
  return {
    name: 'ClosureCaptureEnricher',
    phase: 'ENRICHMENT',
    creates: { nodes: [], edges: ['CAPTURES'] },
    consumes: { edges: ['CONTAINS', 'HAS_SCOPE'], nodes: ['FUNCTION', 'SCOPE', 'VARIABLE'] },
    produces: { edges: ['CAPTURES'] },
    dependencies: ['JSASTAnalyzer'],
  };
}
```

---

## Step 8: Dependency Graph Verification

After Steps 6-7, `buildDependencyGraph()` should produce the following inferred + explicit dependency graph for the 14 registered enrichers. This must match or be a superset of the current execution order.

### Expected inferred dependencies (Layer 1: from consumes/produces)

| Enricher | Consumes Edge Types | Auto-inferred Dependencies (producers of those types) |
|----------|-------------------|------------------------------------------------------|
| ImportExportLinker | (none) | (none) |
| FunctionCallResolver | IMPORTS_FROM | ImportExportLinker |
| MethodCallResolver | CONTAINS, INSTANCE_OF, DERIVES_FROM | InstanceOfResolver (INSTANCE_OF) |
| ArgumentParameterLinker | PASSES_ARGUMENT, CALLS, HAS_PARAMETER, RECEIVES_ARGUMENT | FunctionCallResolver (CALLS), MethodCallResolver (CALLS), AliasTracker (CALLS), ValueDomainAnalyzer (CALLS), CallbackCallResolver (CALLS) |
| CallbackCallResolver | PASSES_ARGUMENT, IMPORTS_FROM | ImportExportLinker (IMPORTS_FROM) |
| AliasTracker | ASSIGNED_FROM, CALLS, CONTAINS, INSTANCE_OF | FunctionCallResolver (CALLS), MethodCallResolver (CALLS), CallbackCallResolver (CALLS), InstanceOfResolver (INSTANCE_OF) |
| ValueDomainAnalyzer | ASSIGNED_FROM, FLOWS_INTO, CONTAINS | (no enricher-phase producer of ASSIGNED_FROM/CONTAINS; self for FLOWS_INTO excluded) |
| InstanceOfResolver | INSTANCE_OF | (self excluded) |
| MountPointResolver | (none) | (none) |
| ExpressHandlerLinker | (none) | (none) |
| PrefixEvaluator | DEFINES | (no enricher produces DEFINES) |
| HTTPConnectionEnricher | RESPONDS_WITH | (no enricher produces RESPONDS_WITH) |
| RustFFIEnricher | (none) | (none) |
| RejectionPropagationEnricher | CALLS, REJECTS, CONTAINS, HAS_SCOPE | FunctionCallResolver (CALLS), MethodCallResolver (CALLS), AliasTracker (CALLS), ValueDomainAnalyzer (CALLS), CallbackCallResolver (CALLS), (self for REJECTS excluded) |

### Layer 2 explicit dependencies (merged on top of Layer 1)

All existing `dependencies` arrays are preserved. Cross-phase deps (JSASTAnalyzer, ExpressRouteAnalyzer, etc.) are silently ignored by toposort.

### Key correctness improvements from V2

1. **RejectionPropagationEnricher** currently only depends on `JSASTAnalyzer` (cross-phase). With V2, it auto-depends on all CALLS producers, ensuring it runs AFTER call resolution. This fixes a latent ordering bug.

2. **AliasTracker** currently depends on `MethodCallResolver`. With V2, it also auto-depends on FunctionCallResolver and CallbackCallResolver (all produce CALLS). More correct ordering.

3. **ArgumentParameterLinker** currently depends on `MethodCallResolver`. With V2, it also auto-depends on FunctionCallResolver, AliasTracker, etc. More correct.

---

## Step 9: Test Plan

**Test file:** `test/unit/core/enricherV2.test.ts` (new file)

All tests use `node:test` and `node:assert` (matching existing patterns in `test/unit/core/toposort.test.ts`).

### 9.1 EnricherMetadataV2 Type Tests (3 tests)

| # | Test | Description |
|---|------|-------------|
| 1 | `should accept valid EnricherMetadataV2 with all fields` | Construct a metadata object with consumes, produces, creates, dependencies. Verify all fields accessible. |
| 2 | `should accept EnricherMetadataV2 with empty consumes/produces` | Construct metadata with `consumes: { edges: [] }`, `produces: { edges: [] }`. Verify type-safe access. |
| 3 | `should accept optional nodes in consumes/produces` | Construct metadata with `consumes: { edges: ['CALLS'], nodes: ['FUNCTION'] }`. Verify nodes field is accessible. |

### 9.2 isEnricherV2 Type Guard Tests (3 tests)

| # | Test | Description |
|---|------|-------------|
| 4 | `should return true for plugin with consumes and produces` | Create mock plugin with V2 metadata. Assert `isEnricherV2()` returns true. |
| 5 | `should return false for V1 plugin without consumes/produces` | Create mock V1 plugin. Assert `isEnricherV2()` returns false. |
| 6 | `should return false for plugin with only consumes (no produces)` | Partial metadata -- guard must require both fields. |

### 9.3 V1EnricherAdapter Tests (4 tests)

| # | Test | Description |
|---|------|-------------|
| 7 | `should wrap V1 plugin metadata with empty consumes` | Create V1 plugin with `creates: { edges: ['CALLS'] }`. Adapt. Assert `metadata.consumes.edges` is `[]`. |
| 8 | `should extract produces from V1 creates.edges` | Same plugin. Assert `metadata.produces.edges` is `['CALLS']`. |
| 9 | `should delegate execute() to wrapped plugin` | Create V1 plugin with spy on execute. Adapt. Call execute. Assert delegated. |
| 10 | `should preserve V1 dependencies in metadata` | Create V1 plugin with `dependencies: ['ImportExportLinker']`. Adapt. Assert preserved. |

### 9.4 buildDependencyGraph Tests (9 tests)

| # | Test | Description |
|---|------|-------------|
| 11 | `should return empty array for empty input` | `buildDependencyGraph([])` returns `[]`. |
| 12 | `should create dependency from consumes to produces` | A produces CALLS, B consumes CALLS. Assert B depends on A. |
| 13 | `should exclude self-references (consumes intersect produces)` | A consumes and produces INSTANCE_OF. Assert A has no self-dependency. |
| 14 | `should merge explicit dependencies with inferred` | A produces CALLS, B consumes CALLS AND has `dependencies: ['External']`. Assert B depends on both A and External. |
| 15 | `should handle V1 adapter (empty consumes, explicit deps only)` | V1-adapted enricher with `consumes: { edges: [] }`, `dependencies: ['Foo']`. Assert dep on Foo only. |
| 16 | `should handle multiple producers for same edge type` | A and B both produce CALLS. C consumes CALLS. Assert C depends on both A and B. |
| 17 | `should handle enricher with no consumes and no explicit deps` | Enricher with `consumes: { edges: [] }`, no dependencies. Assert empty dependencies in result. |
| 18 | `should produce valid input for toposort()` | Build graph from 3 enrichers, feed to `toposort()`. Assert no throw and correct order. |
| 19 | `should match current enrichment order for real enricher set` | Create mock enrichers mimicking all 14 registered. Build graph, toposort. Verify key ordering constraints (same as existing toposort.test.ts real-world scenario). |

### 9.5 Orchestrator Integration Tests (3 tests)

| # | Test | Description |
|---|------|-------------|
| 20 | `should use buildDependencyGraph for ENRICHMENT phase` | Create Orchestrator with mock enrichers (V2). Run ENRICHMENT phase. Verify execution order matches consumes/produces deps. |
| 21 | `should wrap V1 enrichers in V1EnricherAdapter automatically` | Create Orchestrator with V1 plugin (no consumes/produces). Run ENRICHMENT phase. Verify no error and correct execution. |
| 22 | `should not use buildDependencyGraph for non-ENRICHMENT phases` | Create Orchestrator with ANALYSIS plugins. Run ANALYSIS phase. Verify standard toposort used (no adapter wrapping). |

### 9.6 Enricher Metadata Correctness Tests (2 tests)

| # | Test | Description |
|---|------|-------------|
| 23 | `should have consumes and produces on all enrichment plugins` | Import all 14 registered enrichers. Assert each has `consumes.edges` and `produces.edges` arrays. Assert `produces.edges` matches `creates.edges`. |
| 24 | `should produce correct dependency graph from real enrichers` | Instantiate all 14 enrichers. Run `buildDependencyGraph()`. Run `toposort()`. Verify: ImportExportLinker before FunctionCallResolver, MethodCallResolver before AliasTracker, AliasTracker before ValueDomainAnalyzer, etc. |

**Total: 24 test cases.**

---

## Implementation Order

Recommended execution sequence for Kent (tests) and Rob (implementation):

| Order | Step | File(s) | Dependencies |
|-------|------|---------|-------------|
| 1 | **Types** (Step 1) | `packages/types/src/plugins.ts` | None |
| 2 | **EnricherV2 interface** (Step 2) | `packages/core/src/plugins/enrichment/EnricherV2.ts` | Step 1 |
| 3 | **V1EnricherAdapter** (Step 3) | `packages/core/src/plugins/enrichment/V1EnricherAdapter.ts` | Steps 1-2 |
| 4 | **buildDependencyGraph** (Step 4) | `packages/core/src/core/buildDependencyGraph.ts` | Steps 1-2 |
| 5 | **Tests for Steps 2-4** (Step 9, sections 9.1-9.4) | `test/unit/core/enricherV2.test.ts` | Steps 1-4 |
| 6 | **Metadata updates** (Steps 6-7) | 17 enricher files | Step 1 |
| 7 | **Orchestrator integration** (Step 5) | `packages/core/src/Orchestrator.ts` | Steps 1-4 |
| 8 | **Integration tests** (Step 9, sections 9.5-9.6) | `test/unit/core/enricherV2.test.ts` | Steps 5-7 |
| 9 | **Regression verification** | Run full test suite | All |

Steps 1-4 can be done in a single commit (new files, no existing behavior change).
Step 5 (Orchestrator) is the only change to existing code.
Steps 6-7 (metadata) are mechanical changes, can be a separate commit.

---

## Big-O Complexity Analysis

| Operation | Complexity | Notes |
|-----------|-----------|-------|
| `buildDependencyGraph()` | O(E + P) | E = enrichers (14), P = total produces entries (~20). Constant in practice. |
| `toposort()` | O(V + D) | V = enrichers (14), D = total dependency edges (~25). Already exists. |
| Orchestrator `runPhase('ENRICHMENT')` | O(E + P + V + D) = O(E) | Dominated by enricher count. No change to asymptotic complexity. |
| Metadata access per enricher | O(1) | Property getter, no computation. |
| V1EnricherAdapter wrapping | O(E) | One wrapper per enricher. |
| `isEnricherV2()` type guard | O(1) | Two `in` checks on metadata object. |

**No new O(n) passes over graph nodes.** All new code operates only on enricher metadata (14-17 items).

---

## Files Changed Summary

| File | Change Type | LOC Added |
|------|------------|-----------|
| `packages/types/src/plugins.ts` | Modified | ~25 |
| `packages/core/src/plugins/enrichment/EnricherV2.ts` | New | ~45 |
| `packages/core/src/plugins/enrichment/V1EnricherAdapter.ts` | New | ~45 |
| `packages/core/src/core/buildDependencyGraph.ts` | New | ~55 |
| `packages/core/src/index.ts` | Modified (exports) | ~5 |
| `packages/core/src/Orchestrator.ts` | Modified (runPhase) | ~15 |
| 17 enricher files | Modified (metadata) | ~5 each = ~85 |
| `test/unit/core/enricherV2.test.ts` | New | ~250 |
| **Total** | | **~525** |

---

## Risks and Mitigations

| Risk | Likelihood | Mitigation |
|------|-----------|------------|
| V1EnricherAdapter changes execution order | Low | Behavioral guarantee: V1 adapter produces identical toposort input. Integration test verifies. |
| RejectionPropagationEnricher gets new auto-deps, changes ordering | Medium | This is actually CORRECT behavior. Current ordering is wrong (missing deps on call resolvers). Test verifies new order is valid. |
| Dynamic import in Orchestrator causes issues | Low | Only for ENRICHMENT phase. Other phases unchanged. Test covers. |
| `FFI_CALLS`, `ALIAS_OF` not in EDGE_TYPE constant | None (existing) | `EdgeType` allows `| string`. Noted in Don's analysis. Not a blocker. |
| Enricher metadata consumes/produces audit is wrong | Medium | Test 23 validates all metadata. Test 24 validates resulting dependency graph. |

---

## NOT in Scope (Explicit Exclusions)

1. **Per-file incremental enrichment** -- `relevantFiles()` and `processFile()` are interface stubs only. No enricher implements them.
2. **Replacing `dependencies` with consumes/produces** -- Both coexist. `dependencies` remains for cross-phase and node-type ordering.
3. **Registering the 3 unregistered enrichers** -- Separate task.
4. **Fixing PrefixEvaluator's filesystem access** -- Known anomaly, not part of RFD-2.
5. **Adding `FFI_CALLS`/`ALIAS_OF`/`HAS_PARAMETER` to EDGE_TYPE constant** -- Nice-to-have, separate task.
