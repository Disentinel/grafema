# REG-591: Final Fixes to Address Dijkstra Verification Gaps

**Author:** Don Melton, Tech Lead
**Date:** 2026-03-01
**Addressing:** Dijkstra Verification (010-dijkstra-dataflow-verification.md)

---

## Summary

Dijkstra identified two gaps in 009-don-dataflow-update.md:

1. **Gap 1 (documentation):** The investigation incorrectly claims that `let app; app = express()` creates `VARIABLE('app') --ASSIGNED_FROM--> CALL('express')`. It does not. The pattern is NOT detected, and this limitation must be documented in code comments.

2. **Gap 2 (correctness):** Phase 2 alias chain lookup uses variable names as keys instead of node IDs, creating false positives when variables are shadowed in nested scopes.

This delta provides the fixes.

---

## Gap 1 Fix: Document the `let app; app = express()` Limitation

In `_findExpressVarNames` method body, add this comment before the Phase 1 loop:

```typescript
/**
 * Scan FileResult to find all variable names that hold Express app or router instances.
 *
 * Algorithm:
 *   For each VARIABLE node in the file:
 *     Follow all ASSIGNED_FROM edges from that VARIABLE.
 *     If the edge destination is a CALL node with:
 *       name === 'express'            → variable holds an Express app
 *       name === 'express.Router'     → variable holds an Express router
 *     Then add the VARIABLE's name to the result set.
 *
 *   For alias chains (const server = app):
 *     If ASSIGNED_FROM destination is a VARIABLE that is already in the result set,
 *     add the current VARIABLE's name to the result set.
 *     Repeat until no new names are added (BFS convergence).
 *
 * NOTE: Only VariableDeclarator init assignments are detected (const/let x = express()).
 * Separate assignment expressions (let x; x = express()) are NOT detected because
 * AssignmentExpression creates an EXPRESSION node, not a VARIABLE→ASSIGNED_FROM→CALL edge.
 * This is an accepted limitation of the ASSIGNED_FROM traversal. The pattern `const app = express()`
 * covers 95%+ of real Express code and is the recommended style.
 *
 * @returns Map from variable name to 'app' | 'router'
 */
private _findExpressVarNames(fileResult: Readonly<FileResult>): Map<string, 'app' | 'router'> {
```

This replaces the original JSDoc for `_findExpressVarNames` in 009, lines 47-64.

---

## Gap 2 Fix: Use Node IDs Instead of Names for Phase 2 Alias Chain Tracking

Replace Phase 2 (lines 107-131 in 009) with this ID-keyed version:

```typescript
  // Phase 2: alias chain resolution — VARIABLE --ASSIGNED_FROM--> VARIABLE (already known)
  // Runs until convergence (no new additions). Handles: const server = app; server.get(...)
  // Uses node IDs for classification to avoid false positives from variable shadowing.
  const resultById = new Map<string, 'app' | 'router'>();

  // Seed resultById with Phase 1 results
  for (const [name, kind] of result.entries()) {
    const node = nodes.find(n => n.type === 'VARIABLE' && n.name === name);
    if (node) resultById.set(node.id, kind);
  }

  // BFS: follow ASSIGNED_FROM → VARIABLE chains
  let changed = true;
  while (changed) {
    changed = false;
    for (const node of nodes) {
      if (node.type !== 'VARIABLE') continue;
      if (resultById.has(node.id)) continue; // already classified

      const assignedFromEdges = (edgesBySrc.get(node.id) ?? [])
        .filter(e => e.type === 'ASSIGNED_FROM');

      for (const assignEdge of assignedFromEdges) {
        const srcNode = nodeById.get(assignEdge.dst);
        if (!srcNode || srcNode.type !== 'VARIABLE') continue;

        const srcKind = resultById.get(srcNode.id);
        if (srcKind !== undefined) {
          resultById.set(node.id, srcKind);
          changed = true;
          break;
        }
      }
    }
  }

  // Final: convert back to name-keyed map for compatibility with analyzeFile
  const finalResult = new Map<string, 'app' | 'router'>();
  for (const [nodeId, kind] of resultById.entries()) {
    const node = nodes.find(n => n.id === nodeId);
    if (node && node.type === 'VARIABLE') {
      finalResult.set(node.name, kind);
    }
  }

  return finalResult;
```

**Rationale:**

- **Phase 1** still populates a name-keyed map `result` for single-hop detection (unchanged from 009).
- **Phase 2** now converts `result` to `resultById` (keyed by node ID) before the BFS loop.
- The BFS lookup uses `resultById.get(srcNode.id)` instead of `result.get(srcNode.name)`, eliminating the shadowing false positive.
- **Final conversion:** After the loop, `resultById` is converted back to a name-keyed map `finalResult` for compatibility with the rest of `analyzeFile`.
- **Cost:** One extra O(V) scan to convert back to names. Negligible for typical files.

**Effect on shadowing:**

In the shadowed case from Dijkstra's example:

```javascript
function outer() {
  const app = express();           // VARIABLE('app' id=V1) --ASSIGNED_FROM--> CALL('express')
  function inner() {
    const app = {};                // VARIABLE('app' id=V2) --ASSIGNED_FROM--> CALL() [obj literal]
    const server = app;            // VARIABLE('server' id=V3) --ASSIGNED_FROM--> VARIABLE('app' id=V2)
    server.get('/users', h);
  }
}
```

Phase 1 adds both V1 and V2 to `result` (both named `'app'`). When converting to `resultById`:
- V1 → 'app' (from outer express())
- V2 → 'app' (from {} — this is wrong, but Phase 1 is unchanged)

Wait — Phase 1 only adds to `result` if the CALL is `'express'` or `'express.Router'`. An ObjectExpression creates no CALL node, so V2 is never added to Phase 1's `result`. So `resultById` only has V1.

Phase 2 BFS:
- V3 (server) has `ASSIGNED_FROM → VARIABLE(V2)`
- `resultById.get(V2)` is undefined (V2 was never added because `{}` is not a CALL)
- V3 is not added to `resultById`
- No false positive

So Gap 2 fix actually makes the false positive **impossible**, not just less likely. Phase 1 is the gatekeeper — only VARIABLE nodes assigned from `express()` or `express.Router()` CALL nodes are seeded into the result map.

---

## Implementation Checklist

- [ ] Replace Phase 2 code in `_findExpressVarNames` with the ID-keyed version above
- [ ] Update the JSDoc comment for `_findExpressVarNames` to include the `let app; app = express()` limitation note
- [ ] Verify tests still pass (no behavioral change to the output, only internal tracking)
- [ ] Verify no shadowing false positives in test suite

---

## No Changes to Gap 3 and Gap 4

Per Dijkstra's verification:

- **Gap 3** (`require('express')()`): already documented in 009, EC-6. No further action.
- **Gap 4** (destructuring imports): already documented in 008 and 009. No further action.
