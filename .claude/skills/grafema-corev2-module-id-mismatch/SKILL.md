---
name: grafema-corev2-module-id-mismatch
description: |
  Fix dangling edges in Grafema graph caused by CoreV2Analyzer filtering out MODULE nodes
  (mapNodes) but passing edges unchanged (mapEdges). Use when: (1) MODULE nodes have missing
  DEPENDS_ON, IMPORTS, CONTAINS, or DECLARES edges despite code clearly having imports,
  (2) edges reference MODULE#{file} IDs that don't match any node, (3) blast radius shows
  no cross-module impact. Root cause: core-v2 walkFile uses MODULE#{file} but JSModuleIndexer
  creates MODULE nodes with {file}->global->MODULE->module semantic ID format.
author: Claude Code
version: 1.0.0
date: 2026-03-21
---

# CoreV2Analyzer MODULE ID Mismatch

## Problem

CoreV2Analyzer filters out MODULE nodes from core-v2 output (since JSModuleIndexer is the
authority for MODULE nodes) but passes all edges unchanged. Edges referencing `MODULE#{file}`
as src/dst become dangling because the real MODULE nodes have ID `{file}->global->MODULE->module`.

## Context / Trigger Conditions

- MODULE nodes have 0 outgoing DEPENDS_ON edges despite the source file having imports
- Blast radius shows no cross-module impact
- `edge(X, _, "DEPENDS_ON")` Datalog queries return nothing for MODULE nodes
- Edges in RFDB have src/dst starting with `MODULE#` — these are orphaned
- CONTAINS edges from MODULE to top-level FUNCTION/CLASS are missing
- Module-level DECLARES edges are broken

## Solution

The MODULE ID format must be consistent between core-v2's walkFile and JSModuleIndexer.

**Key files:**
- `packages/core-v2/src/walk.ts` — `computeModuleId(file)` generates the canonical format
- `packages/core/src/core/nodes/ModuleNode.ts` — `createWithContext()` uses `computeSemanticId('MODULE', 'module', ctx)`
- `packages/core/src/plugins/analysis/CoreV2Analyzer.ts` — `mapNodes()` filters MODULE, `mapEdges()` passes all

**The asymmetry:**
```typescript
// mapNodes: FILTERS out MODULE nodes (line ~231)
private mapNodes(nodes) {
  return nodes.filter(n => n.type !== 'MODULE').map(...)
}

// mapEdges: PASSES ALL edges unchanged (line ~239)
private mapEdges(edges) {
  return edges.map(e => { /* just flatten metadata */ })
}
```

**Affected edge types from core-v2:**
| Edge | Where Created | How moduleId is used |
|------|--------------|---------------------|
| DEPENDS_ON | modules.ts:59 | src = ctx.moduleId |
| IMPORTS | modules.ts:102 | src = ctx.moduleId |
| CONTAINS (structural) | walk.ts visit() | src = parentNodeId (= moduleId for top-level) |
| CONTAINS (FILE→MODULE) | walk.ts:278 | dst = moduleId |
| DECLARES (module scope) | walk.ts:179 | src = scope.id (= moduleId) |
| IMPORTS (resolution) | resolve.ts:840+ | dst = moduleNode.id (from FileResult) |

## Verification

After fixing, verify:
1. `pnpm build && node --test --test-concurrency=1 'test/unit/*.test.js'`
2. `grafema analyze --clear` then check DEPENDS_ON edges for MODULE nodes
3. Datalog: `result(X) :- node(X, "MODULE"), edge(X, _, "DEPENDS_ON").` should return most modules

## Notes

- core-v2 cannot import from core (no dependency), so `computeModuleId()` lives in core-v2
- The scope system uses moduleId as internal ephemeral ID — format doesn't affect scope behavior
- `ctx.nodeId()` uses `file` directly, not `moduleId` — other node IDs are unaffected
- `protectedTypes: ['MODULE']` in commitBatch is a no-op since mapNodes already filters them
- Golden tests match by type+name, not exact ID — format changes don't break them
