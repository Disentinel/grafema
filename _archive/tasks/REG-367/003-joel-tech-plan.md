# REG-367: Joel Spolsky Tech Plan — Dependency-Based Plugin Ordering

## Overview

Replace priority-based numeric ordering (`priority: 80`) with dependency-based topological sort using Kahn's algorithm. The `dependencies` field already exists on 25 of ~37 plugins. We add it to the remaining 12, implement toposort, update the Orchestrator, and remove `priority` entirely.

## Current State Analysis

### Priority Sort Locations (to be replaced)

1. **`packages/core/src/Orchestrator.ts` line 840-843** — `runPhase()` sorts by priority (descending):
   ```typescript
   // Сортируем по priority (больше = раньше)
   phasePlugins.sort((a, b) =>
     (b.metadata.priority || 0) - (a.metadata.priority || 0)
   );
   ```

2. **`packages/core/src/Orchestrator.ts` line 778-780** — `discover()` sorts discovery plugins:
   ```typescript
   // Сортируем по приоритету
   discoveryPlugins.sort((a, b) =>
     (b.metadata.priority || 0) - (a.metadata.priority || 0)
   );
   ```

### Type Definition

3. **`packages/types/src/plugins.ts` line 43** — `priority` on `PluginMetadata`:
   ```typescript
   priority?: number;
   ```

### Plugin Inventory (by phase)

#### DISCOVERY (4 plugins)

| Plugin | Priority | Dependencies | File |
|--------|----------|-------------|------|
| WorkspaceDiscovery | 110 | `[]` | `discovery/WorkspaceDiscovery.ts:45` |
| MonorepoServiceDiscovery | 100 | `[]` | `discovery/MonorepoServiceDiscovery.ts:50` |
| DiscoveryPlugin (base) | 100 | `[]` | `discovery/DiscoveryPlugin.ts:38` |
| SimpleProjectDiscovery | 50 | `[]` | `discovery/SimpleProjectDiscovery.ts:48` |

All discovery plugins already have `dependencies: []`. Priority ordering among them is: WorkspaceDiscovery > Monorepo/DiscoveryPlugin > SimpleProject. Since none depend on each other, they will run in registration order after toposort (which is correct — order doesn't matter within this phase since they are independent).

#### INDEXING (3 plugins)

| Plugin | Priority | Dependencies | Needs `dependencies` added? |
|--------|----------|-------------|---------------------------|
| JSModuleIndexer | 90 | (none) | YES — `[]` |
| IncrementalModuleIndexer | 90 | (none) | YES — `[]` |
| RustModuleIndexer | 85 | (none) | YES — `[]` |

These indexers are independent (JS vs Rust), so `dependencies: []` is correct.

#### ANALYSIS (12 plugins)

| Plugin | Priority | Dependencies | Needs `dependencies` added? |
|--------|----------|-------------|---------------------------|
| SystemDbAnalyzer | 85 | (none) | YES — `['JSASTAnalyzer']` |
| IncrementalAnalysisPlugin | 85 | `['JSModuleIndexer']` | OK |
| JSASTAnalyzer | 80 | `['JSModuleIndexer']` | OK |
| ExpressAnalyzer | 75 | `['JSASTAnalyzer']` | OK |
| ExpressRouteAnalyzer | 75 | `['JSModuleIndexer', 'JSASTAnalyzer']` | OK |
| ServiceLayerAnalyzer | 75 | `['JSModuleIndexer', 'JSASTAnalyzer']` | OK |
| SQLiteAnalyzer | 75 | `['JSModuleIndexer', 'JSASTAnalyzer']` | OK |
| FetchAnalyzer | 75 | `['JSModuleIndexer', 'JSASTAnalyzer']` | OK |
| SocketIOAnalyzer | 75 | `['JSModuleIndexer', 'JSASTAnalyzer']` | OK |
| DatabaseAnalyzer | 75 | `['JSASTAnalyzer']` | OK |
| ExpressResponseAnalyzer | 74 | `['ExpressRouteAnalyzer', 'JSASTAnalyzer']` | OK |
| ReactAnalyzer | 70 | `['JSASTAnalyzer']` | OK |
| RustAnalyzer | 75 | `['RustModuleIndexer']` | OK |

**Cross-phase deps:** `JSModuleIndexer` and `JSASTAnalyzer` appear in ANALYSIS plugin deps but belong to INDEXING and ANALYSIS respectively. The toposort will correctly handle `JSASTAnalyzer` as intra-phase (ANALYSIS depends on ANALYSIS), and `JSModuleIndexer` as cross-phase (ANALYSIS depends on INDEXING — informational, ignored during ANALYSIS toposort since it's not in the same phase set).

#### ENRICHMENT (14 plugins)

| Plugin | Priority | Dependencies | Needs `dependencies` added? |
|--------|----------|-------------|---------------------------|
| InstanceOfResolver | 100 | (none) | YES — `['JSASTAnalyzer']` |
| ImportExportLinker | 90 | `['JSASTAnalyzer']` | OK (cross-phase) |
| MountPointResolver | 90 | `['JSModuleIndexer', 'JSASTAnalyzer', 'ExpressRouteAnalyzer']` | OK (all cross-phase) |
| PrefixEvaluator | 80 | `['JSModuleIndexer', 'JSASTAnalyzer', 'MountPointResolver']` | OK (MountPointResolver is intra-phase) |
| FunctionCallResolver | 80 | `['ImportExportLinker']` | OK |
| ExternalCallResolver | 70 | `['FunctionCallResolver']` | OK |
| RejectionPropagationEnricher | 70 | `['JSASTAnalyzer']` | OK (cross-phase) |
| AliasTracker | 60 | (none) | YES — `['MethodCallResolver']` |
| ValueDomainAnalyzer | 65 | (none) | YES — `['AliasTracker']` |
| HTTPConnectionEnricher | 50 | `['ExpressRouteAnalyzer', 'FetchAnalyzer', 'ExpressResponseAnalyzer']` | OK (all cross-phase) |
| MethodCallResolver | 50 | (none) | YES — `['ImportExportLinker']` |
| ExpressHandlerLinker | 50 | `['JSASTAnalyzer', 'ExpressRouteAnalyzer']` | OK (all cross-phase) |
| NodejsBuiltinsResolver | 45 | `['JSASTAnalyzer', 'ImportExportLinker']` | OK (ImportExportLinker is intra-phase) |
| ArgumentParameterLinker | 45 | `['JSASTAnalyzer', 'MethodCallResolver']` | OK (MethodCallResolver is intra-phase) |
| RustFFIEnricher | 45 | `['RustAnalyzer', 'MethodCallResolver']` | OK (MethodCallResolver is intra-phase) |
| ClosureCaptureEnricher | 40 | `['JSASTAnalyzer']` | OK (cross-phase) |

#### VALIDATION (7 plugins)

| Plugin | Priority | Dependencies | Needs `dependencies` added? |
|--------|----------|-------------|---------------------------|
| GraphConnectivityValidator | 100 | (none) | YES — `[]` |
| DataFlowValidator | 100 | (none) | YES — `[]` |
| EvalBanValidator | 95 | (none) | YES — `['JSASTAnalyzer']` |
| CallResolverValidator | 90 | `['FunctionCallResolver', 'ExternalCallResolver']` | OK (cross-phase) |
| SQLInjectionValidator | 90 | (none) | YES — `['ValueDomainAnalyzer']` |
| BrokenImportValidator | 85 | `['ImportExportLinker', 'FunctionCallResolver']` | OK (cross-phase) |
| ShadowingDetector | 80 | (none) | YES — `['JSASTAnalyzer']` |
| TypeScriptDeadCodeValidator | 50 | `['JSASTAnalyzer']` | OK (cross-phase) |

### Summary of Plugins Needing `dependencies` Added (12 total)

| Plugin | File | Line | Add |
|--------|------|------|-----|
| JSModuleIndexer | `indexing/JSModuleIndexer.ts` | 148 | `dependencies: []` |
| IncrementalModuleIndexer | `indexing/IncrementalModuleIndexer.ts` | 50 | `dependencies: []` |
| RustModuleIndexer | `indexing/RustModuleIndexer.ts` | 36 | `dependencies: []` |
| SystemDbAnalyzer | `analysis/SystemDbAnalyzer.ts` | 57 | `dependencies: ['JSASTAnalyzer']` |
| InstanceOfResolver | `enrichment/InstanceOfResolver.ts` | 55 | `dependencies: ['JSASTAnalyzer']` |
| MethodCallResolver | `enrichment/MethodCallResolver.ts` | 270 | `dependencies: ['ImportExportLinker']` |
| AliasTracker | `enrichment/AliasTracker.ts` | 79 | `dependencies: ['MethodCallResolver']` |
| ValueDomainAnalyzer | `enrichment/ValueDomainAnalyzer.ts` | 117 | `dependencies: ['AliasTracker']` |
| GraphConnectivityValidator | `validation/GraphConnectivityValidator.ts` | 50 | `dependencies: []` |
| DataFlowValidator | `validation/DataFlowValidator.ts` | 57 | `dependencies: []` |
| EvalBanValidator | `validation/EvalBanValidator.ts` | 66 | `dependencies: ['JSASTAnalyzer']` |
| SQLInjectionValidator | `validation/SQLInjectionValidator.ts` | 109 | `dependencies: ['ValueDomainAnalyzer']` |
| ShadowingDetector | `validation/ShadowingDetector.ts` | 67 | `dependencies: ['JSASTAnalyzer']` |

---

## Implementation Plan

### Step 1: Create `toposort.ts` utility

**File:** `packages/core/src/core/toposort.ts` (new file)

**Interface:**

```typescript
/**
 * Topological sort error - thrown when a dependency cycle is detected.
 */
export class CycleError extends Error {
  readonly cycle: string[];
  constructor(cycle: string[]) {
    super(`Dependency cycle detected: ${cycle.join(' -> ')}`);
    this.name = 'CycleError';
    this.cycle = cycle;
  }
}

/**
 * Input item for topological sort.
 * Each item has a unique ID and a list of dependency IDs.
 */
export interface ToposortItem {
  id: string;
  dependencies: string[];
}

/**
 * Topologically sort items by their dependencies using Kahn's algorithm.
 *
 * Rules:
 * - Dependencies not present in the input set are silently ignored (cross-phase deps).
 * - If the input contains a cycle, throws CycleError with the cycle path.
 * - When multiple items have zero in-degree, they are emitted in their original
 *   input order (registration order tiebreaker).
 * - Empty input returns empty array.
 *
 * @param items - Array of items with id and dependencies
 * @returns Array of IDs in topological order (dependencies first)
 * @throws CycleError if a dependency cycle exists
 *
 * Time complexity:  O(V + E) where V = items.length, E = total dependencies
 * Space complexity: O(V + E)
 */
export function toposort(items: ToposortItem[]): string[];
```

**Algorithm (Kahn's with registration-order tiebreaker):**

```
1. Build adjacency list and in-degree map from items
2. For each item's dependency:
   - If dep is NOT in the item set → skip (cross-phase, informational)
   - If dep IS in the item set → add edge dep→item, increment in-degree
3. Initialize queue with all items having in-degree 0, preserving input order
4. While queue is not empty:
   a. Dequeue first item (FIFO — preserves registration order among peers)
   b. Add to result
   c. For each successor of this item:
      - Decrement in-degree
      - If in-degree reaches 0, add to queue
5. If result.length < items.length → cycle exists
   - Find cycle using DFS from any unvisited node
   - Throw CycleError with cycle path
6. Return result
```

**Big-O Analysis:**
- V = number of plugins in the phase (typically 3-14)
- E = number of intra-phase dependency edges (typically V-1 to 2V)
- Time: O(V + E) — one pass to build graph, one pass to process queue
- Space: O(V + E) — adjacency list + in-degree map + queue
- In practice: V < 15, so this is constant-time. No performance concern.

### Step 2: Unit tests for `toposort.ts`

**File:** `test/unit/toposort.test.js` (new file)

**Test cases:**

1. **Empty input** — returns `[]`
2. **Single item, no deps** — returns `['A']`
3. **Linear chain** — `A -> B -> C` returns `['A', 'B', 'C']`
4. **Diamond dependency** — `A -> B, A -> C, B -> D, C -> D` returns `['A', 'B', 'C', 'D']` or `['A', 'C', 'B', 'D']` depending on registration order
5. **Missing deps (cross-phase)** — Item B depends on X (not in set). X is silently ignored. B has effective in-degree 0.
6. **Cycle detection** — `A -> B -> C -> A` throws `CycleError` with cycle `['A', 'B', 'C', 'A']`
7. **Self-cycle** — `A -> A` throws `CycleError`
8. **Registration order tiebreaker** — Items with no dependencies among each other come out in input order
9. **All independent** — `[C, B, A]` all with `[]` deps → `['C', 'B', 'A']` (preserves input order)
10. **Real-world enrichment scenario** — Simulate the ENRICHMENT phase plugins with their actual dependencies, verify correct ordering

### Step 3: Modify `Orchestrator.ts`

**File:** `packages/core/src/Orchestrator.ts`

#### Change 1: Add import (top of file, ~line 14)

```typescript
import { toposort, CycleError } from './core/toposort.js';
```

#### Change 2: Replace priority sort in `runPhase()` (lines 840-843)

**Before:**
```typescript
// Сортируем по priority (больше = раньше)
phasePlugins.sort((a, b) =>
  (b.metadata.priority || 0) - (a.metadata.priority || 0)
);
```

**After:**
```typescript
// Topological sort by dependencies (Kahn's algorithm)
// Cross-phase dependencies are silently ignored (they are informational).
// Registration order is used as tiebreaker for plugins with no dependency relationship.
const pluginMap = new Map(phasePlugins.map(p => [p.metadata.name, p]));
const sortedIds = toposort(
  phasePlugins.map(p => ({
    id: p.metadata.name,
    dependencies: p.metadata.dependencies ?? [],
  }))
);
const sortedPlugins = sortedIds
  .map(id => pluginMap.get(id))
  .filter((p): p is Plugin => p !== undefined);

// Replace phasePlugins with sorted order
phasePlugins.length = 0;
phasePlugins.push(...sortedPlugins);
```

Note: We reassign to the mutable `phasePlugins` array (which is `let`-declared via `.filter()`). The exact mechanism may use `sortedPlugins` directly in the loop below. The key point: the `for` loop at line 846 iterates `phasePlugins` — we replace its contents with the toposorted order.

Actually, looking at the code more carefully, `phasePlugins` is `const` from `.filter()`. We should replace the sort in-place:

**Precise replacement:**

```typescript
// Topological sort by dependencies (Kahn's algorithm)
const pluginMap = new Map(phasePlugins.map(p => [p.metadata.name, p]));
const sortedIds = toposort(
  phasePlugins.map(p => ({
    id: p.metadata.name,
    dependencies: p.metadata.dependencies ?? [],
  }))
);
const sortedPhasePlugins = sortedIds
  .map(id => pluginMap.get(id)!)
  .filter(Boolean);
phasePlugins.splice(0, phasePlugins.length, ...sortedPhasePlugins);
```

Wait — `phasePlugins` is declared as:
```typescript
const phasePlugins = this.plugins.filter(plugin => ...);
```

`.filter()` returns a new array, so we can mutate it with `.splice()`. OR we can just use a new variable. Simplest approach: replace the `.sort()` call (3 lines) with the toposort block, and instead of mutating the `phasePlugins` array, we use a new `const sortedPlugins` and change the `for` loop to iterate over it.

**Final approach for `runPhase()`:**

Replace lines 840-843:
```typescript
// Сортируем по priority (больше = раньше)
phasePlugins.sort((a, b) =>
  (b.metadata.priority || 0) - (a.metadata.priority || 0)
);
```

With:
```typescript
// Topological sort by dependencies (Kahn's algorithm).
// Cross-phase deps are silently ignored. Registration order breaks ties.
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
```

This mutates the existing `phasePlugins` array in-place. The rest of the method (the `for` loop at line 846) iterates `phasePlugins` and works unchanged.

#### Change 3: Replace priority sort in `discover()` (lines 778-780)

**Before:**
```typescript
// Сортируем по приоритету
discoveryPlugins.sort((a, b) =>
  (b.metadata.priority || 0) - (a.metadata.priority || 0)
);
```

**After:**
```typescript
// Topological sort by dependencies (same algorithm as runPhase)
const pluginMap = new Map(discoveryPlugins.map(p => [p.metadata.name, p]));
const sortedIds = toposort(
  discoveryPlugins.map(p => ({
    id: p.metadata.name,
    dependencies: p.metadata.dependencies ?? [],
  }))
);
discoveryPlugins.length = 0;
for (const id of sortedIds) {
  const plugin = pluginMap.get(id);
  if (plugin) discoveryPlugins.push(plugin);
}
```

#### Change 4: Add logging after toposort (both locations)

After the toposort block in both `runPhase()` and `discover()`, add:

```typescript
this.logger.debug('Plugin execution order', {
  phase: phaseName,
  order: phasePlugins.map(p => p.metadata.name),
});
```

(For `discover()`, use `phase: 'DISCOVERY'` and `discoveryPlugins`.)

### Step 4: Remove `priority` from type definition

**File:** `packages/types/src/plugins.ts` line 43

**Before:**
```typescript
export interface PluginMetadata {
  name: string;
  phase: PluginPhase;
  priority?: number;
  creates?: { ... };
  dependencies?: string[];
}
```

**After:**
```typescript
export interface PluginMetadata {
  name: string;
  phase: PluginPhase;
  creates?: { ... };
  dependencies?: string[];
}
```

Simply remove the `priority?: number;` line.

### Step 5: Remove `priority` from all plugin metadata (37 files)

For each plugin file, remove the `priority: N,` line (with its comment) from the `metadata` getter, and ensure `dependencies` is present.

#### DISCOVERY plugins (4 files)

All already have `dependencies`. Remove `priority` line only.

| File | Line to remove |
|------|---------------|
| `discovery/WorkspaceDiscovery.ts:45` | `priority: 110, // Higher than MonorepoServiceDiscovery (100)` |
| `discovery/MonorepoServiceDiscovery.ts:50` | `priority: 100,` |
| `discovery/DiscoveryPlugin.ts:38` | `priority: 100,` |
| `discovery/SimpleProjectDiscovery.ts:48` | `priority: 50, // Lower priority than specialized discovery plugins` |

#### INDEXING plugins (3 files)

Remove `priority`, add `dependencies: []`.

| File | Line to remove | Add |
|------|---------------|-----|
| `indexing/JSModuleIndexer.ts:144` | `priority: 90,` | After `creates` block: `dependencies: []` |
| `indexing/IncrementalModuleIndexer.ts:46` | `priority: 90,` | `dependencies: []` |
| `indexing/RustModuleIndexer.ts:32` | `priority: 85,  // After JSModuleIndexer (90)` | `dependencies: []` |

#### ANALYSIS plugins (12 files)

Remove `priority` line. Add `dependencies` where missing.

| File | Priority line to remove | Add dependencies? |
|------|------------------------|-------------------|
| `analysis/JSASTAnalyzer.ts:258` | `priority: 80,` | Already has `['JSModuleIndexer']` |
| `analysis/IncrementalAnalysisPlugin.ts:81` | `priority: 85, // Запускается после...` | Already has `['JSModuleIndexer']` |
| `analysis/SystemDbAnalyzer.ts:53` | `priority: 85, // Run after JSASTAnalyzer` | ADD `dependencies: ['JSASTAnalyzer']` |
| `analysis/ExpressAnalyzer.ts:75` | `priority: 75, // После JSASTAnalyzer (80)` | Already has `['JSASTAnalyzer']` |
| `analysis/ExpressRouteAnalyzer.ts:74` | `priority: 75, // После JSASTAnalyzer (80)...` | Already has `['JSModuleIndexer', 'JSASTAnalyzer']` |
| `analysis/ExpressResponseAnalyzer.ts:49` | `priority: 74, // After ExpressRouteAnalyzer (75)` | Already has `['ExpressRouteAnalyzer', 'JSASTAnalyzer']` |
| `analysis/ServiceLayerAnalyzer.ts:93` | `priority: 75, // После JSASTAnalyzer (80)` | Already has `['JSModuleIndexer', 'JSASTAnalyzer']` |
| `analysis/SQLiteAnalyzer.ts:57` | `priority: 75, // После JSASTAnalyzer (80)` | Already has `['JSModuleIndexer', 'JSASTAnalyzer']` |
| `analysis/FetchAnalyzer.ts:75` | `priority: 75, // После JSASTAnalyzer (80)` | Already has `['JSModuleIndexer', 'JSASTAnalyzer']` |
| `analysis/SocketIOAnalyzer.ts:102` | `priority: 75, // После JSASTAnalyzer (80)` | Already has `['JSModuleIndexer', 'JSASTAnalyzer']` |
| `analysis/DatabaseAnalyzer.ts:51` | `priority: 75, // После JSASTAnalyzer (80)` | Already has `['JSASTAnalyzer']` |
| `analysis/ReactAnalyzer.ts:206` | `priority: 70, // After JSASTAnalyzer and ExpressAnalyzer` | Already has `['JSASTAnalyzer']` |
| `analysis/RustAnalyzer.ts:176` | `priority: 75, // Lower than JSASTAnalyzer (80)` | Already has `['RustModuleIndexer']` |

**NOTE on JSASTAnalyzer.ts:** There is a second `priority: 80` at line 386 inside a `task = new Task({...})` — this is a **Task priority** for the internal worker pool, NOT plugin priority. Do NOT remove this one.

#### ENRICHMENT plugins (14 files)

Remove `priority` line. Add `dependencies` where missing.

| File | Priority line to remove | Add dependencies? |
|------|------------------------|-------------------|
| `enrichment/InstanceOfResolver.ts:51` | `priority: 100,  // Высокий приоритет...` | ADD `dependencies: ['JSASTAnalyzer']` |
| `enrichment/ImportExportLinker.ts:42` | `priority: 90, // Run early in enrichment...` | Already has `['JSASTAnalyzer']` |
| `enrichment/MountPointResolver.ts:53` | `priority: 90,  // High priority...` | Already has `['JSModuleIndexer', 'JSASTAnalyzer', 'ExpressRouteAnalyzer']` |
| `enrichment/PrefixEvaluator.ts:85` | `priority: 80,  // After MountPointResolver (90)` | Already has `['JSModuleIndexer', 'JSASTAnalyzer', 'MountPointResolver']` |
| `enrichment/FunctionCallResolver.ts:58` | `priority: 80, // After ImportExportLinker (90)` | Already has `['ImportExportLinker']` |
| `enrichment/ExternalCallResolver.ts:50` | `priority: 70, // After FunctionCallResolver (80)` | Already has `['FunctionCallResolver']` |
| `enrichment/RejectionPropagationEnricher.ts:39` | `priority: 70, // After FunctionCallResolver (80)...` | Already has `['JSASTAnalyzer']` |
| `enrichment/ValueDomainAnalyzer.ts:111` | `priority: 65, // After AliasTracker (60)` | ADD `dependencies: ['AliasTracker']` |
| `enrichment/AliasTracker.ts:74` | `priority: 60, // После MethodCallResolver (50)` | ADD `dependencies: ['MethodCallResolver']` |
| `enrichment/HTTPConnectionEnricher.ts:54` | `priority: 50,  // После основных enrichers` | Already has `['ExpressRouteAnalyzer', 'FetchAnalyzer', 'ExpressResponseAnalyzer']` |
| `enrichment/MethodCallResolver.ts:265` | `priority: 50,` | ADD `dependencies: ['ImportExportLinker']` |
| `enrichment/ExpressHandlerLinker.ts:44` | `priority: 50, // After analysis plugins` | Already has `['JSASTAnalyzer', 'ExpressRouteAnalyzer']` |
| `enrichment/NodejsBuiltinsResolver.ts:57` | `priority: 45, // After ImportExportLinker...` | Already has `['JSASTAnalyzer', 'ImportExportLinker']` |
| `enrichment/ArgumentParameterLinker.ts:66` | `priority: 45, // Runs AFTER MethodCallResolver...` | Already has `['JSASTAnalyzer', 'MethodCallResolver']` |
| `enrichment/RustFFIEnricher.ts:32` | `priority: 45,  // After MethodCallResolver (50)` | Already has `['RustAnalyzer', 'MethodCallResolver']` |
| `enrichment/ClosureCaptureEnricher.ts:54` | `priority: 40, // Lower number = runs later...` | Already has `['JSASTAnalyzer']` |

#### VALIDATION plugins (7 files)

Remove `priority` line. Add `dependencies` where missing.

| File | Priority line to remove | Add dependencies? |
|------|------------------------|-------------------|
| `validation/GraphConnectivityValidator.ts:46` | `priority: 100,` | ADD `dependencies: []` |
| `validation/DataFlowValidator.ts:53` | `priority: 100,` | ADD `dependencies: []` |
| `validation/EvalBanValidator.ts:62` | `priority: 95, // Высокий приоритет...` | ADD `dependencies: ['JSASTAnalyzer']` |
| `validation/CallResolverValidator.ts:50` | `priority: 90,` | Already has `['FunctionCallResolver', 'ExternalCallResolver']` |
| `validation/SQLInjectionValidator.ts:105` | `priority: 90, // After ValueDomainAnalyzer (65)` | ADD `dependencies: ['ValueDomainAnalyzer']` |
| `validation/BrokenImportValidator.ts:80` | `priority: 85, // After enrichment plugins...` | Already has `['ImportExportLinker', 'FunctionCallResolver']` |
| `validation/ShadowingDetector.ts:63` | `priority: 80, // After enrichment...` | ADD `dependencies: ['JSASTAnalyzer']` |
| `validation/TypeScriptDeadCodeValidator.ts:50` | `priority: 50, // Lower priority...` | Already has `['JSASTAnalyzer']` |

### Step 6: Update test fixtures

**File:** `test/unit/OrchestratorStrictSuppressed.test.js`

This test creates mock plugins with `priority` in metadata. Remove `priority` from:
- `createMockEnrichmentPlugin()` — line 29: `priority: 50,`
- `createMockDiscoveryPlugin()` — line 50: `priority: 100,`
- `createMockIndexingPlugin()` — line 78: `priority: 100,`
- Lines 151-152 and 158-159: `plugin1.metadata.priority = 60;` and `plugin2.metadata.priority = 40;`

Also search for any other test files referencing `priority` in plugin metadata:

```bash
grep -rn "priority:" test/ --include="*.js" --include="*.ts" | grep -v node_modules
```

### Step 7: Export `toposort` and `CycleError` from `@grafema/core`

**File:** `packages/core/src/index.ts`

Add export line:
```typescript
export { toposort, CycleError } from './core/toposort.js';
```

### Step 8: Integration test — plugin execution order

**File:** `test/unit/pluginExecutionOrder.test.js` (new file)

Test that the Orchestrator actually runs plugins in dependency order:

```javascript
describe('Plugin execution order (REG-367)', () => {
  it('should run enrichment plugins in dependency order', async () => {
    const executionOrder = [];

    // Create mock plugins with specific dependency chain: A -> B -> C
    const pluginA = createPlugin('PluginA', 'ENRICHMENT', [], executionOrder);
    const pluginB = createPlugin('PluginB', 'ENRICHMENT', ['PluginA'], executionOrder);
    const pluginC = createPlugin('PluginC', 'ENRICHMENT', ['PluginB'], executionOrder);

    // Register in reverse order to prove priority doesn't matter
    const orchestrator = new Orchestrator({
      graph: backend,
      plugins: [discovery, indexing, pluginC, pluginA, pluginB],
      logLevel: 'silent',
    });

    await orchestrator.run(projectPath);

    // Verify A before B before C
    assert.deepStrictEqual(executionOrder, ['PluginA', 'PluginB', 'PluginC']);
  });

  it('should throw CycleError on circular dependencies', async () => {
    const pluginA = createPlugin('A', 'ENRICHMENT', ['B'], []);
    const pluginB = createPlugin('B', 'ENRICHMENT', ['A'], []);

    const orchestrator = new Orchestrator({
      graph: backend,
      plugins: [discovery, indexing, pluginA, pluginB],
      logLevel: 'silent',
    });

    await assert.rejects(
      () => orchestrator.run(projectPath),
      (err) => err instanceof CycleError || err.message.includes('cycle')
    );
  });

  it('should ignore cross-phase dependencies', async () => {
    // Plugin depends on 'JSASTAnalyzer' which is in ANALYSIS phase
    // This should NOT cause an error in ENRICHMENT phase toposort
    const plugin = createPlugin('MyEnricher', 'ENRICHMENT', ['JSASTAnalyzer'], []);

    const orchestrator = new Orchestrator({
      graph: backend,
      plugins: [discovery, indexing, plugin],
      logLevel: 'silent',
    });

    // Should not throw
    await orchestrator.run(projectPath);
  });

  it('should preserve registration order for independent plugins', async () => {
    const order = [];
    const p1 = createPlugin('First', 'ENRICHMENT', [], order);
    const p2 = createPlugin('Second', 'ENRICHMENT', [], order);
    const p3 = createPlugin('Third', 'ENRICHMENT', [], order);

    const orchestrator = new Orchestrator({
      graph: backend,
      plugins: [discovery, indexing, p1, p2, p3],
      logLevel: 'silent',
    });

    await orchestrator.run(projectPath);
    assert.deepStrictEqual(order, ['First', 'Second', 'Third']);
  });
});
```

---

## Expected Enrichment Phase Order After Migration

Based on the dependency graph, the ENRICHMENT phase toposort will produce this order (assuming registration order follows the current plugin array in typical usage):

```
1. InstanceOfResolver       (deps: [JSASTAnalyzer] — cross-phase, effective: [])
2. ImportExportLinker        (deps: [JSASTAnalyzer] — cross-phase, effective: [])
3. MountPointResolver        (deps: [JSModuleIndexer, JSASTAnalyzer, ExpressRouteAnalyzer] — all cross-phase)
4. RejectionPropagationEnricher (deps: [JSASTAnalyzer] — cross-phase)
5. HTTPConnectionEnricher    (deps: [ExpressRouteAnalyzer, FetchAnalyzer, ExpressResponseAnalyzer] — all cross-phase)
6. ExpressHandlerLinker      (deps: [JSASTAnalyzer, ExpressRouteAnalyzer] — all cross-phase)
7. ClosureCaptureEnricher    (deps: [JSASTAnalyzer] — cross-phase)
8. PrefixEvaluator           (deps: [..., MountPointResolver] — MountPointResolver is intra-phase)
9. FunctionCallResolver      (deps: [ImportExportLinker] — intra-phase)
10. ExternalCallResolver     (deps: [FunctionCallResolver] — intra-phase)
11. NodejsBuiltinsResolver   (deps: [JSASTAnalyzer, ImportExportLinker] — ImportExportLinker intra-phase)
12. MethodCallResolver       (deps: [ImportExportLinker] — intra-phase)
13. ArgumentParameterLinker  (deps: [JSASTAnalyzer, MethodCallResolver] — MethodCallResolver intra-phase)
14. RustFFIEnricher          (deps: [RustAnalyzer, MethodCallResolver] — MethodCallResolver intra-phase)
15. AliasTracker             (deps: [MethodCallResolver] — intra-phase)
16. ValueDomainAnalyzer      (deps: [AliasTracker] — intra-phase)
```

This matches the semantics of the old priority ordering while being explicit about WHY each plugin runs in that position.

---

## Execution Order

1. **Step 1** — Create `toposort.ts`
2. **Step 2** — Write toposort unit tests, verify they pass
3. **Step 3** — Modify `Orchestrator.ts` (both sort locations + import + logging)
4. **Step 4** — Remove `priority` from `PluginMetadata` type
5. **Step 5** — Update all 37 plugin files (remove priority, add dependencies where missing)
6. **Step 6** — Update test fixtures
7. **Step 7** — Export from index.ts
8. **Step 8** — Write integration test, verify full test suite passes

Steps 4-6 can be done in parallel since they are independent edits. Step 3 depends on Step 1. Step 8 depends on all previous steps.

---

## Risk Analysis

**Low risk:**
- The dependency information is already encoded in priority numbers and comments. We are making implicit knowledge explicit.
- 25 of 37 plugins already have correct `dependencies` arrays.
- Toposort is a well-understood algorithm with O(V+E) complexity.

**Medium risk:**
- The 12 plugins getting new `dependencies` arrays need careful verification. The dependencies listed above were derived from priority comments and code analysis. Each should be double-checked during implementation.

**No risk:**
- Cross-phase deps are informational-only. The toposort ignores them. This is safe because phases already run sequentially (DISCOVERY -> INDEXING -> ANALYSIS -> ENRICHMENT -> VALIDATION).

## Verification Criteria

1. `npm test` passes with zero failures
2. `npm run build` succeeds (TypeScript compilation)
3. No remaining references to `priority` in any plugin metadata (grep check)
4. All plugins have `dependencies` field (grep check)
5. New toposort unit tests pass (cycle detection, diamond, missing deps, tiebreaker)
6. Integration test proves dependency ordering works end-to-end
