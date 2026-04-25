# Joel Spolsky: Tech Plan Revision - ServiceDetector Coordination

## Context

Linus raised a blocking concern in his review: How does WorkspaceDiscovery coordinate with ServiceDetector to prevent duplicate SERVICE nodes?

After investigating the actual codebase, I have important findings.

## Investigation Findings

### ServiceDetector Is Dead Code

I examined the ServiceDetector implementation and its usage across the codebase:

**File:** `/Users/vadimr/grafema/packages/core/src/plugins/indexing/ServiceDetector.ts`

Key observations:

1. **Not a Plugin:** ServiceDetector has an `analyze()` method (lines 66-111), not an `execute()` method. It doesn't extend `Plugin` or `DiscoveryPlugin`.

2. **Not Registered:** The Orchestrator only auto-registers `SimpleProjectDiscovery` when no DISCOVERY plugins exist (line 170-172 in Orchestrator.ts):
   ```typescript
   const hasDiscovery = this.plugins.some(p => p.metadata?.phase === 'DISCOVERY');
   if (!hasDiscovery) {
     this.plugins.unshift(new SimpleProjectDiscovery());
   }
   ```

3. **Export Only:** ServiceDetector is exported from `packages/core/src/index.ts` (line 156) but is never imported or used anywhere in the codebase:
   ```bash
   # Grep results for ServiceDetector usage:
   packages/core/src/index.ts:156:export { ServiceDetector }...
   packages/core/src/plugins/indexing/ServiceDetector.ts:... (definition only)
   # No imports anywhere
   ```

4. **Phase Inconsistency:** Even if it were used, ServiceDetector declares `phase: 'INDEXING'` but has discovery-like behavior. This confirms Don's observation that it's architecturally misplaced.

### Actual Discovery Plugin Flow

The actual service detection flow is:

```
DISCOVERY Phase (sorted by priority):
1. MonorepoServiceDiscovery (priority: 100) - looks for pkg/ directory
2. SimpleProjectDiscovery (priority: 50) - creates service from root package.json

INDEXING Phase:
- JSModuleIndexer (and other indexing plugins)
- ServiceDetector is NOT in the plugin list
```

**ServiceDetector is dead code** - it's a legacy implementation that was superseded by the plugin architecture but never removed.

## Resolution

### Linus's Concern: Non-Issue

The coordination problem Linus raised doesn't exist in practice:
- ServiceDetector **is not running** because it's not a plugin
- WorkspaceDiscovery will be the only workspace-aware service detector
- No duplicate SERVICE nodes can occur

### Tech Plan Corrections

**Remove from Priority Hierarchy:**

The original tech plan showed:
```
DISCOVERY Phase:
1. WorkspaceDiscovery      (priority: 110) - workspace configurations
2. MonorepoServiceDiscovery (priority: 100) - pkg/ pattern
3. ServiceDetector         (priority: 90)  - apps/packages/services patterns (INDEXING)
4. SimpleProjectDiscovery  (priority: 50)  - root package.json fallback
```

**Corrected hierarchy:**
```
DISCOVERY Phase:
1. WorkspaceDiscovery       (priority: 110) - workspace configurations [NEW]
2. MonorepoServiceDiscovery (priority: 100) - pkg/ pattern
3. SimpleProjectDiscovery   (priority: 50)  - root package.json fallback

(ServiceDetector is NOT in the plugin flow - it's dead code)
```

### Recommended Action: Remove Dead Code

As part of this task (or as a separate tech debt item), we should:

1. **Delete ServiceDetector entirely** (`packages/core/src/plugins/indexing/ServiceDetector.ts`)
2. **Remove export** from `packages/core/src/index.ts` (line 156)
3. **Create Linear issue** for tracking: "REG-XXX: Remove dead ServiceDetector code"

This is safe because:
- ServiceDetector is never instantiated
- No code imports it
- Its functionality is superseded by discovery plugins

### Implementation Impact

The tech plan requires no changes to the WorkspaceDiscovery implementation. The coordination mechanism (Step 8 in original plan) can be removed entirely:

**Remove from tech plan:**
- "Step 8: Make ServiceDetector aware - if WorkspaceDiscovery found services, skip ServiceDetector's naive patterns"

**No skip logic needed** because ServiceDetector doesn't run.

## Updated Implementation Order

**Phase 1: Foundation (unchanged)**
1. detector.ts + tests (1 hour)
2. parsers/*.ts + tests (2 hours)
3. globResolver.ts + tests (2 hours)

**Phase 2: Plugin (unchanged)**
4. WorkspaceDiscovery.ts + tests (2 hours)
5. index.ts exports (15 min)

**Phase 3: Integration (simplified)**
6. Test fixtures (1 hour)
7. Orchestrator default plugin update (30 min)
8. Integration tests (1 hour)
9. **[Optional] Delete ServiceDetector dead code (15 min)**

**Total Estimate:** ~9.5 hours (reduced from ~10 hours)

## Summary

Linus's concern was valid given the tech plan's description, but investigation reveals:

1. **ServiceDetector is dead code** - exported but never used
2. **No coordination needed** - only discovery plugins run, ServiceDetector doesn't
3. **Tech plan simplified** - remove Step 8 (ServiceDetector awareness)
4. **Recommend cleanup** - delete ServiceDetector as tech debt

The WorkspaceDiscovery implementation can proceed as designed. The only DISCOVERY plugins that will create SERVICE nodes are:
- WorkspaceDiscovery (priority 110) - for workspace projects
- MonorepoServiceDiscovery (priority 100) - for pkg/ pattern
- SimpleProjectDiscovery (priority 50) - fallback

All run in DISCOVERY phase, sorted by priority. Higher-priority plugins return services first; Orchestrator aggregates all results. No duplicates because each plugin targets different project structures.

---

**Blocking concern resolved:** ServiceDetector is not running. Proceed with implementation.
