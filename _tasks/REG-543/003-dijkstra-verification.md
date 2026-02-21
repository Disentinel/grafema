# REG-543: Dijkstra Verification of Don's Plan

## Verdict: APPROVE (with noted risks)

The plan is correct in its core logic and safe to implement. Two gaps exist: one is a pre-existing mismatch between the stated fix and the real-world target node name, and one is a documented but under-specified false-positive concern. Neither blocks implementation. Details below.

---

## Verification Method

All findings are grounded in source code. Files examined:

- `/Users/vadimr/grafema-worker-2/packages/cli/src/commands/impact.ts` — target file
- `/Users/vadimr/grafema-worker-2/packages/core/src/plugins/analysis/ast/visitors/ClassVisitor.ts` — how class methods are stored
- `/Users/vadimr/grafema-worker-2/packages/core/src/core/ASTWorker.ts` — secondary path (Babel)
- `/Users/vadimr/grafema-worker-2/packages/core/src/plugins/analysis/JSASTAnalyzer.ts` — metadata field declarations (line 282-283)
- `/Users/vadimr/grafema-worker-2/packages/core/src/storage/backends/RFDBServerBackend.ts` — `findByAttr` implementation
- `/Users/vadimr/grafema-worker-2/packages/rfdb/ts/base-client.ts` — client `findByAttr` (passes query as-is)
- `/Users/vadimr/grafema-worker-2/packages/rfdb-server/src/bin/rfdb_server.rs` — Rust `WireAttrQuery`, `FindByAttr` handler, confirmed camelCase deserialization

---

## 1. `extractMethodName()` — Input Universe Analysis

### All possible inputs for `target.name`

`findTarget` scans FUNCTION and CLASS nodes. For the REG-543 scenario, the relevant path is FUNCTION nodes. Class methods are stored by `ClassVisitor.ts` as:

```typescript
// ClassVisitor.ts line 358-364
const funcData: ClassFunctionInfo = {
  id: functionId,
  type: 'FUNCTION',
  name: methodName,       // bare name only — e.g. "addNode"
  ...
  className: className,
};
```

The `name` field is always the bare method name from `methodNode.key.name`. It is NOT qualified with the class name. So `target.name` for a class method `addNode` on `GraphBackend` is `"addNode"`, not `"GraphBackend.addNode"`.

### Completeness Table

| Input to `extractMethodName` | Source | Result | Correct? |
|---|---|---|---|
| `"addNode"` | Bare method name (class method via JSASTAnalyzer) | `"addNode"` | Yes |
| `"GraphBackend.addNode"` | Would only occur if name stored as qualified name | `"addNode"` | Yes (handles it) |
| `"a.b.c.method"` | Would occur for deeply nested (hypothetical) | `"method"` | Yes |
| `""` | Edge case: anonymous or empty-name function | `""` — falsy, Path 2 skipped | Safe |
| `"."` | Degenerate | `""` — falsy, Path 2 skipped | Safe |
| `"method."` | Trailing dot | `""` — falsy, Path 2 skipped | Safe |

**Conclusion:** `extractMethodName` is correct. The critical observation is that in the actual codebase, `target.name` is the bare method name (`"addNode"`), so `extractMethodName` is largely a no-op for the primary use case — but it correctly handles qualified names if they ever appear.

---

## 2. Merge / Dedup Logic

### Scenario: Same node in BOTH results

Path 1: `getIncomingEdges(targetId, ['CALLS'])` — returns CALL nodes with a resolved CALLS edge.
Path 2: `findByAttr({ nodeType: 'CALL', method: targetName })` — returns ALL CALL nodes with that method name, including those that also have a CALLS edge.

A CALL node that has `method = "addNode"` AND has a CALLS edge to the target WILL appear in both results.

**The plan handles this correctly.** The `seen = new Set<string>()` is initialized before Path 1 and used throughout both paths. Path 1 adds IDs to `seen`. Path 2 checks `!seen.has(id)` before adding. Dedup is correct.

No issue here.

---

## 3. `findByAttr` Query for `method` Attribute — FUNCTION Nodes Without a Dot

### The concern

The plan queries `findByAttr({ nodeType: 'CALL', method: targetName })`. This uses `method` as a metadata filter. The question is: does a direct function call (e.g., `addNode()` with no receiver) have `method` set in its metadata?

### What the code shows

From `JSASTAnalyzer.ts` (lines 3060-3093), a direct `Identifier` call (no dot) creates a CALL node with these fields:
```typescript
callSites.push({
  id: callId,
  type: 'CALL',
  name: calleeName,      // e.g. "addNode"
  // NO `method` field
  // NO `object` field
  file: ..., line: ..., ...
});
```

From lines 3122-3128, a method call (with dot) creates:
```typescript
methodCalls.push({
  type: 'CALL',
  name: fullName,         // e.g. "graph.addNode"
  object: objectName,     // e.g. "graph"
  method: methodName,     // e.g. "addNode"
  ...
});
```

The metadata fields `object` and `method` are declared at line 282-283:
```typescript
{ name: 'object', fieldType: 'string', nodeTypes: ['CALL'] },
{ name: 'method', fieldType: 'string', nodeTypes: ['CALL'] },
```

**Conclusion:** `method` is only set on CALL nodes that have a receiver object (i.e., `x.addNode()`). A direct call `addNode()` does NOT have `method` set. Therefore `findByAttr({ nodeType: 'CALL', method: 'addNode' })` will NOT return direct bare function calls named `addNode`. It will only return calls of the form `something.addNode()`.

This is correct behavior for the bug: we want to find `graph.addNode()` calls (unresolved method calls), not calls to a bare function named `addNode`. The query is precise.

---

## 4. Broadness / False Positives

### What the plan says

The plan acknowledges that `method === "addNode"` matches ALL calls `*.addNode()` regardless of class. `graph.addNode()`, `tree.addNode()`, `cache.addNode()` — all match. This is intentional.

### Is this acceptable?

For the stated use case (untyped/loosely-typed JS/PHP code, interface/abstract type variables), this is the correct trade-off: without type information, we cannot distinguish. The alternative (showing 0 callers) is strictly worse.

**One un-addressed concern:** if the user runs `grafema impact "addNode"` in a codebase that has BOTH:
1. A resolved function `addNode` (with CALLS edges from some callers), AND
2. Many unrelated method calls `anything.addNode()` in other classes

...then Path 2 would add ALL of those unrelated callers to the result, inflating the count significantly. This could be very noisy in large codebases.

The plan acknowledges this ("potential noise") and explicitly accepts it as correct behavior for impact analysis. The user request also accepts it. This is a product decision, not a correctness defect.

**However**, the plan does not specify any output annotation distinguishing "resolved via CALLS edge" from "matched by method name only." Mixing both without annotation could confuse users who expect the resolved callers to be authoritative. The plan notes this as a possible follow-up. This is acceptable for the current scope.

---

## 5. Test Coverage

### Proposed test scenario

The test in Don's plan creates:
```javascript
// src/backend.js
class GraphBackend {
  addNode(node) { /* ... */ }
}
// src/service.js
function useGraph(graph) {
  graph.addNode({ id: '1', type: 'FUNCTION' });
}
```

Then runs `grafema impact "addNode"` and asserts `useGraph` appears.

### Is this test correct?

**Yes, with a caveat.** The flow:

1. `JSASTAnalyzer` analyzes `backend.js` → creates a FUNCTION node with `name: "addNode"` (from `ClassVisitor`, as verified above)
2. `JSASTAnalyzer` analyzes `service.js` → creates a CALL node with `method: "addNode"`, `object: "graph"`, `name: "graph.addNode"`. Because `graph` is an untyped parameter, `MethodCallResolver` cannot resolve it → no CALLS edge.
3. `grafema impact "addNode"` → `findTarget` finds the FUNCTION node → Path 1 returns [] (no CALLS edges) → Path 2 queries `{ nodeType: 'CALL', method: 'addNode' }` → finds the CALL node → `findContainingFunction` finds `useGraph` → `useGraph` appears.

**The test is valid and exercises the exact bug fix.**

### Unhappy paths NOT covered by the test

| Scenario | Risk | Covered? |
|---|---|---|
| `addNode` also has resolved callers (Path 1 has results, Path 2 adds more) | Dedup correctness | No |
| Two different classes both have `addNode` method, calls to both show up | Known false-positive, accepted | No |
| `addNode` is a bare function (no object), called as `addNode()` | Should NOT appear in results | No — worth verifying this stays 0 |
| `backend.findByAttr` throws (server disconnect during query) | Silently skipped | No — but existing pattern, acceptable |
| `target.name` is empty string | Path 2 skipped, no crash | No — low risk |

**Missing test: bare function call exclusion.** The test should verify that a bare `addNode()` call (no receiver) does NOT get included via Path 2. This ensures the `method` attribute filter is working as expected and not picking up direct function calls. Recommend adding one assertion:

```typescript
// In a test with: function caller() { addNode(); } (bare call, no object)
// After fix, this should NOT appear as a caller via Path 2
assert.ok(
  !output.includes('caller'),
  'Bare function call addNode() should NOT be found via method-attribute path'
);
```

This is a test gap, not a code correctness gap — the implementation is correct, but the test does not verify the precise boundary.

---

## 6. Wire Protocol Verification

The plan uses `backend.findByAttr({ nodeType: 'CALL', method: targetName })`.

Verified: `RFDBServerBackend.findByAttr` calls `this.client.findByAttr(query)` which calls `_send('findByAttr', { query })`. The Rust `WireAttrQuery` uses `#[serde(rename_all = "camelCase")]`, so `nodeType` (camelCase) deserializes to `node_type` (snake_case) correctly. The `method` key lands in `extra: HashMap<String, serde_json::Value>` and is used as a metadata filter. This is confirmed by the Rust test at line 3200: `extra.insert("method", ...)` works with `node_type: Some("CALL")`.

No protocol issue.

---

## Summary of Gaps

| Gap | Severity | Blocking? |
|---|---|---|
| Test does not verify bare `addNode()` call is excluded from results | Low | No |
| No test for dedup when same caller is found by both Path 1 and Path 2 | Low | No |
| No output annotation distinguishing resolved vs. name-matched callers | Design choice, accepted | No |

---

## Final Verdict: APPROVE

The plan is logically sound, the implementation is additive and safe, the dedup logic is correct, the wire protocol works, and the index exists. The proposed test exercises the core bug scenario correctly. The gaps above are minor and do not block implementation.

Rob should implement per steps 1-8 in Don's plan. The bare-call exclusion test (gap 1 above) is recommended as an addition to the test file, but is not required to unblock implementation.
