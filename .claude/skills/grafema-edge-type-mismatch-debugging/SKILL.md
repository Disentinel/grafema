---
name: grafema-edge-type-mismatch-debugging
description: |
  Debug missing edges or failed lookups in Grafema graph when enrichment plugins don't find expected data.
  Use when: (1) enrichment plugin reports 0 items found despite data existing, (2) graph queries
  return empty results unexpectedly, (3) MountPointResolver or similar plugins fail silently.
  Root cause is often edge type mismatch between what indexer creates vs what enrichment expects.
  Key insight: JSModuleIndexer creates DEPENDS_ON edges, not IMPORTS edges.
author: Claude Code
version: 1.0.0
date: 2026-02-01
---

# Grafema Edge Type Mismatch Debugging

## Problem

Grafema enrichment plugins fail to find expected data in the graph, reporting 0 results despite
nodes and edges existing. The root cause is often a mismatch between the edge types that indexers
create vs. what enrichment plugins query for.

## Context / Trigger Conditions

- Enrichment plugin logs show "count: 0" or empty results
- Debug output shows nodes exist but relationships aren't found
- MountPointResolver reports "Module imports built {"files":0}"
- HTTPConnectionEnricher reports "Connections found {"count":0}" despite routes and requests existing
- Any enrichment phase plugin that relies on cross-module relationships

## Root Cause

Different indexers create different edge types:

| Indexer | Edge Type Created | Used For |
|---------|-------------------|----------|
| **JSModuleIndexer** (default) | `DEPENDS_ON` | Module-to-module dependencies |
| **IncrementalModuleIndexer** | `IMPORTS` | Module imports |

If an enrichment plugin looks for `IMPORTS` edges but JSModuleIndexer is active (default),
it will find nothing.

## Solution

1. **Identify which indexer is active** - check `.grafema/config.yaml`:
   ```yaml
   plugins:
     indexing:
       - JSModuleIndexer  # Creates DEPENDS_ON edges
   ```

2. **Check what edge type the enrichment plugin queries**:
   ```typescript
   // Wrong - looks for IMPORTS but JSModuleIndexer creates DEPENDS_ON
   if (edge.type === 'IMPORTS') { ... }

   // Correct - use what JSModuleIndexer actually creates
   if (edge.type === 'DEPENDS_ON') { ... }
   ```

3. **Debug using RFDB direct query**:
   ```javascript
   // Query edges directly to see what exists
   const edges = await graph.getAllEdges();
   const edgeTypes = [...new Set(edges.map(e => e.type))];
   console.log('Edge types:', edgeTypes);
   ```

## Verification

After fixing the edge type:
```
# Before
[INFO] Module imports built {"files":0}

# After
[DEBUG] MODULE nodes indexed {"count":2}
[DEBUG] Found module dependency {"from":"...","to":"..."}
[INFO] Module imports built {"files":1}
```

## Example

REG-248 fix for MountPointResolver:

```typescript
// Before (broken)
for (const edge of edges) {
  if (edge.type === 'IMPORTS') {  // JSModuleIndexer doesn't create this
    // Never executes
  }
}

// After (fixed)
for (const edge of edges) {
  if (edge.type === 'DEPENDS_ON') {  // Matches JSModuleIndexer output
    // Now finds edges correctly
  }
}
```

## Related Node Type Quirks

RFDB stores nodes with `nodeType` field internally, but the graph backend maps `type` queries
to `nodeType`. When debugging:

```javascript
// This works (backend maps type -> nodeType)
graph.queryNodes({ type: 'MODULE' })

// Direct RFDB query shows nodeType field
const nodes = await client.getAllNodes();
console.log(nodes[0].nodeType);  // 'MODULE'
```

## Notes

- Always check verbose logs (`grafema analyze --verbose`) to see what plugins actually find
- The default config uses JSModuleIndexer, so assume `DEPENDS_ON` edges for module relationships
- IncrementalModuleIndexer creates `IMPORTS` edges but isn't the default
- When adding new enrichment plugins, verify which indexer edge types you're depending on
