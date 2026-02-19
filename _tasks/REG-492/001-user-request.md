## User Request: REG-492

**Source:** Linear issue REG-492
**Date:** 2026-02-19

### Task

Link CALL nodes to IMPORT nodes for external library calls.

### Problem

92% of CALL nodes have no CALLS/HANDLED_BY edges. For external library calls, there is zero connectivity between CALL nodes and the IMPORT nodes they reference.

**Current state:**
- EXTERNAL_MODULE nodes (33) exist as placeholders
- IMPORT nodes (1,104 external) exist for each named import
- MODULE → IMPORTS → EXTERNAL_MODULE edges (517) connect modules to dependencies
- 758 CALL nodes match external import names in the same file
- **CALL → IMPORT edges: 0** — no graph connectivity

**Impact:** Enrichment plugins for specific libraries (Express, Socket.IO, etc.) cannot use the graph to find calls to library functions. They fall back to AST pattern matching instead of graph queries.

### Proposed Solution

Extend FunctionCallResolver (or create a new enricher) to create edges:

```
CALL → HANDLED_BY → IMPORT (when call name matches local import binding in same file)
```

### Acceptance Criteria

- [ ] CALL nodes for external imports have HANDLED_BY → IMPORT edges
- [ ] Enrichment plugins can query: "find all calls to functions from library X"
- [ ] No performance regression (enrichment phase within 20% of current)
- [ ] Existing CALL → FUNCTION edges for internal calls not affected
