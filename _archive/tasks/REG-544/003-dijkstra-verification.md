# Dijkstra Verification Report (Revision 2): REG-544 — `parent_function(NodeId, FunctionId)`

**Date:** 2026-02-21
**Verifier:** Edsger Dijkstra (Plan Verifier)
**Plan under review:** `002-don-plan.md` (Revised, post-rejection)
**Prior report:** This document supersedes the original rejection dated 2026-02-21.

> "Testing shows the presence, not the absence of bugs. I PROVE correctness by enumeration."

---

## Re-Verification Scope

My original rejection identified 6 gaps (3 HIGH, 1 MEDIUM, 2 LOW). Don's revised plan addresses all of them. I verify each claimed fix against the actual codebase, then re-run full completeness enumeration to check for new gaps introduced by the revision.

---

## Section 1: Verification of Claimed Gap Resolutions

### Gap 1 (HIGH): `DECLARES` missing from traversal set

**Claim in revision:** `TRAVERSAL_TYPES` now includes `"DECLARES"`, matching `findContainingFunction.ts:71`.

**Verification:**

I re-read `packages/core/src/queries/findContainingFunction.ts` line 71:
```typescript
const edges = await backend.getIncomingEdges(id, ['CONTAINS', 'HAS_SCOPE', 'DECLARES']);
```

The revised plan's algorithm (Section: Algorithm, step 3) states:
```
TRAVERSAL_TYPES = ["CONTAINS", "HAS_SCOPE", "DECLARES"]
```

The Rust pseudocode in the plan:
```rust
const TRAVERSAL_TYPES: &[&str] = &["CONTAINS", "HAS_SCOPE", "DECLARES"];
```

This matches the TypeScript ground truth exactly. VARIABLE nodes connected via `SCOPE -[DECLARES]-> VARIABLE` will now be traversable.

**Status: GAP 1 IS RESOLVED.**

---

### Gap 2 (HIGH): PARAMETER nodes cannot be resolved via incoming BFS

**Claim in revision:** Pre-BFS check on input node type. If PARAMETER, call `get_incoming_edges(NodeId, Some(&["HAS_PARAMETER"]))` and take `edge.src` as the parent FUNCTION.

**Verification of edge direction:**

I verified the actual RFDB storage implementation:

`packages/rfdb-server/src/storage_v2/shard.rs:1450-1472`:
```rust
pub fn get_incoming_edges(
    &self,
    node_id: u128,
    edge_types: Option<&[&str]>,
) -> Vec<EdgeRecordV2> {
    // Finds edges by dst — edges where dst = node_id
    for edge in self.write_buffer.find_edges_by_dst(node_id) {
        ...
    }
}
```

`get_incoming_edges(node_id)` returns edges where `dst = node_id`. The returned `edge.src` is the other endpoint — the source of the edge.

I verified HAS_PARAMETER edge direction from `test/snapshots/04-control-flow.snapshot.json`:
```json
{
  "from": "FUNCTION:calculatePrice",
  "type": "HAS_PARAMETER",
  "to": "PARAMETER:quantity"
}
```

The edge is stored as `FUNCTION(src) -[HAS_PARAMETER]-> PARAMETER(dst)`.

Therefore: `get_incoming_edges(parameter_id, Some(&["HAS_PARAMETER"]))` returns edges where `dst = parameter_id`, giving `edge.src = function_id`.

**The revised plan's algorithm is CORRECT:**

```
1. If node.type == "PARAMETER":
   a. Call get_incoming_edges(NodeId, Some(&["HAS_PARAMETER"]))
   b. edge.src IS the parent FUNCTION — no BFS needed.
```

This is mathematically sound. `get_incoming_edges` finds edges where `dst = PARAMETER`, and HAS_PARAMETER edges have the FUNCTION as `src`. Therefore `edge.src = FUNCTION`.

**Status: GAP 2 IS RESOLVED.**

---

### Gap 3/5 (HIGH): `eval_explain.rs` not listed as required modification

**Claim in revision:** `eval_explain.rs` is explicitly listed as a required modification. The plan states the missing arm causes wrong results (empty) not just missing profiling data.

**Verification:**

I re-read `packages/rfdb-server/src/datalog/eval_explain.rs:274-287`:
```rust
fn eval_atom(&mut self, atom: &Atom) -> Vec<Bindings> {
    let start = Instant::now();

    let result = match atom.predicate() {
        "node" | "type" => self.eval_node(atom),
        "edge" => self.eval_edge(atom),
        "incoming" => self.eval_incoming(atom),
        "path" => self.eval_path(atom),
        "attr" => self.eval_attr(atom),
        "neq" => self.eval_neq(atom),
        "starts_with" => self.eval_starts_with(atom),
        "not_starts_with" => self.eval_not_starts_with(atom),
        _ => self.eval_derived(atom),  // ← parent_function would fall here without fix
    };
```

Without the fix, `parent_function` falls through to `eval_derived()`. The plan correctly identifies this file as a REQUIRED modification and provides a mirror implementation. The `Files to Modify` table now lists `eval_explain.rs` as `Required? YES (correctness)`.

**Status: GAP 3/5 IS RESOLVED.**

---

### Gap 4 (LOW): Class methods use `METHOD` node type in test setup

**Claim in revision:** Test `test_parent_function_method_node` now explicitly documents that the graph must be built with node type `"FUNCTION"` (not `"METHOD"`) per `ClassVisitor.ts:358`.

**Verification:**

I re-read `packages/core/src/plugins/analysis/ast/visitors/ClassVisitor.ts` relevant lines:
```typescript
// Line 293 and 360:
type: 'FUNCTION',
// Line 367:
isClassMethod: true,
```

Class methods are unambiguously stored as `FUNCTION` nodes with `isClassMethod: true`. The revised test comment:

```rust
// IMPORTANT: Setup must use node type "FUNCTION" (not "METHOD") per ClassVisitor.ts:358.
// The graph structure:
//   CLASS(2) -[CONTAINS]-> FUNCTION(11, isClassMethod=true) -[HAS_SCOPE]-> SCOPE(22) -[CONTAINS]-> CALL(32)
// Expected result: FUNCTION(11)
```

This is now correct. The test will build the graph accurately and will not fail due to type mismatch.

**Status: GAP 4 IS RESOLVED.**

---

### Gap 6 (MEDIUM): Non-determinism for malformed graphs not documented

**Claim in revision:** The doc comment on `eval_parent_function` explicitly states: "assumes at most one parent function per node; behavior is non-deterministic if the graph has multiple CONTAINS parent paths."

The revised plan's doc comment (Section 1, `eval.rs` pseudocode):
```
/// Assumes a well-formed Grafema graph where each node has at most one parent
/// via CONTAINS/HAS_SCOPE/DECLARES. If the graph has multiple CONTAINS parent
/// paths (malformed), the predicate returns the first function found (non-deterministic).
```

**Status: GAP 6 IS RESOLVED (documented).**

---

## Section 2: Re-Enumeration of All Node Types

Complete coverage table for the revised algorithm:

| Input Node Type | Graph Connection to Parent | Edge Type Used | In Traversal? | Algorithm Handles It? |
|-----------------|--------------------------|----------------|---------------|----------------------|
| `CALL` | `SCOPE -[CONTAINS]-> CALL` | CONTAINS | YES | YES |
| `METHOD_CALL` | `SCOPE -[CONTAINS]-> METHOD_CALL` | CONTAINS | YES | YES |
| `CONSTRUCTOR_CALL` | `SCOPE -[CONTAINS]-> CONSTRUCTOR_CALL` | CONTAINS | YES | YES |
| `LITERAL` | `SCOPE -[CONTAINS]-> LITERAL` | CONTAINS | YES | YES |
| `VARIABLE` | `SCOPE -[DECLARES]-> VARIABLE` | DECLARES | **YES (added)** | **YES (Gap 1 fixed)** |
| `PARAMETER` | `FUNCTION -[HAS_PARAMETER]-> PARAMETER` | HAS_PARAMETER | Pre-check | **YES (Gap 2 fixed)** |
| `SCOPE` | `FUNCTION -[HAS_SCOPE]-> SCOPE` | HAS_SCOPE | YES | YES |
| `FUNCTION` (nested) | `SCOPE -[CONTAINS]-> FUNCTION` | CONTAINS | YES | YES — returns enclosing FUNCTION |
| `FUNCTION` (top-level) | `MODULE -[CONTAINS]-> FUNCTION` | CONTAINS | YES | YES — returns empty (MODULE stop) |
| `FUNCTION` (class method) | `CLASS -[CONTAINS]-> FUNCTION` | CONTAINS | YES | YES — returns empty (CLASS stop) |
| `CONSTANT` | `SCOPE -[CONTAINS]-> CONSTANT` | CONTAINS | YES | YES |
| `EXPRESSION` | `SCOPE -[CONTAINS]-> EXPRESSION` | CONTAINS | YES | YES |
| Static block `SCOPE` | `CLASS -[CONTAINS]-> SCOPE(static)` | CONTAINS | YES | YES — CLASS stop → empty |

All known node types are correctly handled. No gaps remain.

---

## Section 3: Algorithm Correctness — Re-Enumeration of Structural Cases

### 3.1 Standard Containment Chains

| Structure | Expected Result | Algorithm Produces |
|-----------|----------------|-------------------|
| `FUNCTION → HAS_SCOPE → SCOPE → CONTAINS → CALL` | FUNCTION | CORRECT |
| `FUNCTION → HAS_SCOPE → SCOPE → CONTAINS → SCOPE(if) → CONTAINS → CALL` | FUNCTION | CORRECT |
| `MODULE → CONTAINS → CALL` (top-level) | empty | CORRECT (MODULE stop) |
| `CLASS → CONTAINS → FUNCTION → HAS_SCOPE → SCOPE → CONTAINS → CALL` | inner FUNCTION | CORRECT |
| `FUNCTION(outer) → HAS_SCOPE → SCOPE → CONTAINS → FUNCTION(inner) → HAS_SCOPE → SCOPE → CONTAINS → CALL` | FUNCTION(inner) | CORRECT — inner FUNCTION is first FUNCTION_TYPE hit |

### 3.2 Gap 1 Fix — VARIABLE via DECLARES

| Structure | Expected Result | Algorithm Produces |
|-----------|----------------|-------------------|
| `FUNCTION → HAS_SCOPE → SCOPE → DECLARES → VARIABLE` | FUNCTION | CORRECT (DECLARES now in traversal) |
| `FUNCTION → HAS_SCOPE → SCOPE → CONTAINS → SCOPE(if) → DECLARES → VARIABLE` | FUNCTION | CORRECT (multi-hop DECLARES) |

### 3.3 Gap 2 Fix — PARAMETER via HAS_PARAMETER

| Structure | Expected Result | Algorithm Produces |
|-----------|----------------|-------------------|
| `FUNCTION → HAS_PARAMETER → PARAMETER` | FUNCTION | CORRECT (pre-check: `get_incoming_edges(param, ["HAS_PARAMETER"])` → edge.src = FUNCTION) |
| `FUNCTION → HAS_PARAMETER → PARAMETER` (no HAS_PARAMETER incoming edge) | empty | CORRECT (returns empty for malformed graph) |

### 3.4 Termination

The BFS uses a `visited` HashSet and `MAX_DEPTH = 20`. Both conditions independently guarantee termination:
- Any cycle in the graph cannot cause infinite traversal (visited set)
- Any acyclic path deeper than 20 hops terminates early

Termination is guaranteed regardless of graph structure.

### 3.5 Correctness of `match_fn_term` Helper

| FunctionId Term | Condition | Result |
|-----------------|-----------|--------|
| `Term::Var(v)` | Any | Binds `v` to found parent_id, returns `vec![{v: parent_id}]` |
| `Term::Const(s)` | `s.parse() == parent_id` | Returns `vec![Bindings::new()]` (empty bindings = match) |
| `Term::Const(s)` | `s.parse() != parent_id` | Returns `vec![]` (no match) |
| `Term::Wildcard` | Any | Returns `vec![Bindings::new()]` (match, no binding) |

All three term types handled correctly. Used in both PARAMETER pre-check and BFS result — no code duplication.

---

## Section 4: Files to Modify — Completeness Check

| File | Change | Required? | In Revised Plan? |
|------|--------|-----------|-----------------|
| `packages/rfdb-server/src/datalog/eval.rs` | Add `"parent_function"` arm + `eval_parent_function()` + `match_fn_term()` | YES | YES |
| `packages/rfdb-server/src/datalog/eval_explain.rs` | Mirror: `"parent_function"` arm + same implementation | YES (correctness) | **YES (Gap 3 fixed)** |
| `packages/rfdb-server/src/datalog/utils.rs` | `"parent_function"` case in `positive_can_place_and_provides()` | YES (query planner) | YES |
| `packages/rfdb-server/src/datalog/tests.rs` | `mod parent_function_tests` with 12 tests | YES | YES |
| `test/unit/ParentFunctionPredicate.test.js` | Integration test (new file) | YES | YES |

---

## Section 5: Test Coverage — Re-Assessment

| Test | Node Type Covered | Structural Case | Adequate? |
|------|-----------------|----------------|-----------|
| `test_parent_function_direct_call_in_scope` | CALL | 1 SCOPE hop | YES |
| `test_parent_function_nested_scope` | CALL | 2+ SCOPE hops | YES |
| `test_parent_function_module_level_call` | CALL | MODULE stop | YES |
| `test_parent_function_variable_node` | VARIABLE | DECLARES edge | YES — **Gap 1 test** |
| `test_parent_function_parameter_node` | PARAMETER | HAS_PARAMETER pre-check | YES — **Gap 2 test** |
| `test_parent_function_constructor_call_node` | CONSTRUCTOR_CALL | CONTAINS | YES |
| `test_parent_function_with_constant_fn_id_match` | CALL | Const term match | YES |
| `test_parent_function_with_constant_fn_id_no_match` | CALL | Const term no-match | YES |
| `test_parent_function_wildcard` | CALL | Wildcard term | YES |
| `test_parent_function_in_datalog_rule` | CALL | End-to-end rule | YES |
| `test_parent_function_method_node` | CALL inside class method | CLASS/FUNCTION boundary | YES — **Gap 4 fixed setup** |
| `test_parent_function_unbound_node_id_returns_empty` | N/A | Unbound arg guard | YES |
| `test_parent_function_explain_evaluator` | CALL | eval_explain.rs mirror | YES — **Gap 3 test** |

All 12 required tests are present, including dedicated tests for each gap fix.

---

## Section 6: Search for New Gaps Introduced by Revision

I reviewed the revised plan for errors introduced by the gap fixes.

### 6.1 PARAMETER Pre-Check Scope

The pre-check on `node.type == "PARAMETER"` fires before the BFS. After the pre-check exits (either returning a result or `vec![]`), the BFS is skipped entirely for PARAMETER nodes. This is correct — there is no path for PARAMETER nodes via the BFS traversal set anyway, and the O(1) direct lookup is superior.

However, I note one implicit assumption: a PARAMETER node has exactly one HAS_PARAMETER incoming edge (one parent function). The code:
```rust
for edge in param_edges {
    let parent_id = edge.src;
    if FUNCTION_TYPES.contains(&parent_type) {
        return Self::match_fn_term(fn_term, parent_id);
    }
}
```

Returns on the FIRST valid edge. If a PARAMETER somehow had multiple HAS_PARAMETER incoming edges (malformed graph), the behavior is non-deterministic. This is the same class of issue as Gap 6 (already documented in the doc comment). No new gap — same pre-existing caveat, same documentation.

### 6.2 `DECLARES` in BFS — No Unintended Traversals

Adding `DECLARES` to `TRAVERSAL_TYPES` could theoretically cause unintended behavior if any non-SCOPE node has an outgoing DECLARES edge. In the Grafema graph model, `DECLARES` is only used for `SCOPE -[DECLARES]-> VARIABLE`. The BFS traverses INCOMING edges, so it follows `VARIABLE ← DECLARES ← SCOPE`, giving `edge.src = SCOPE`. This is the correct upward traversal. No other node type uses DECLARES as a source edge in the graph model.

**No new gap introduced.**

### 6.3 `match_fn_term` as Static Method

The helper is defined as `fn match_fn_term(fn_term: &Term, parent_id: u128) -> Vec<Bindings>` — a static method on the evaluator struct. It has no `&self` parameter. This is called as `Self::match_fn_term(...)`. This is a valid Rust pattern and requires no instance state. Correct.

**No new gap introduced.**

### 6.4 MAX_DEPTH Asymmetry (Gap 4, re-examined)

MAX_DEPTH=20 vs TypeScript's 15 is documented in the plan's doc comment:
> "deliberate: TypeScript uses 15, Rust is more permissive to handle pathological real-world nesting without loss of correctness"

This is an acceptable and documented choice. The Rust predicate is strictly more capable, not less. No correctness concern.

### 6.5 Integration Test Coverage

The plan specifies `test/unit/ParentFunctionPredicate.test.js` with VARIABLE node and PARAMETER node queries verified end-to-end. This provides integration coverage of both gap fixes through the full evaluation stack.

---

## Section 7: Completeness Tables (Final)

### Table 1: Node Type Coverage (Revised)

| Input Node Type | Graph Connection | Edge Type | In Algorithm? | Correct? |
|-----------------|-----------------|-----------|---------------|----------|
| CALL | `SCOPE -[CONTAINS]-> CALL` | CONTAINS | BFS | YES |
| METHOD_CALL | `SCOPE -[CONTAINS]-> METHOD_CALL` | CONTAINS | BFS | YES |
| CONSTRUCTOR_CALL | `SCOPE -[CONTAINS]-> CONSTRUCTOR_CALL` | CONTAINS | BFS | YES |
| LITERAL | `SCOPE -[CONTAINS]-> LITERAL` | CONTAINS | BFS | YES |
| VARIABLE | `SCOPE -[DECLARES]-> VARIABLE` | DECLARES | BFS | YES |
| PARAMETER | `FUNCTION -[HAS_PARAMETER]-> PARAMETER` | HAS_PARAMETER | Pre-check | YES |
| SCOPE (body) | `FUNCTION -[HAS_SCOPE]-> SCOPE` | HAS_SCOPE | BFS | YES |
| SCOPE (nested) | `SCOPE -[CONTAINS]-> SCOPE` | CONTAINS | BFS | YES |
| FUNCTION (nested) | `SCOPE -[CONTAINS]-> FUNCTION` | CONTAINS | BFS | YES — enclosing fn |
| FUNCTION (top-level) | `MODULE -[CONTAINS]-> FUNCTION` | CONTAINS | BFS | YES — empty (MODULE stop) |
| FUNCTION (class method) | `CLASS -[CONTAINS]-> FUNCTION` | CONTAINS | BFS | YES — empty (CLASS stop) |

### Table 2: FUNCTION_TYPES vs Actual Graph

| Type String | Created In Graph? | Created By | In FUNCTION_TYPES? | Correct? |
|-------------|-------------------|------------|-------------------|---------|
| `"FUNCTION"` | YES | FunctionNode.ts, ClassVisitor.ts (class methods) | YES | YES |
| `"METHOD"` | YES (rarely) | MethodNode.ts | YES | YES (harmless forward-compat) |

### Table 3: STOP_TYPES vs Actual Graph

| Type String | In Graph? | Should Stop? | In STOP_TYPES? | Correct? |
|-------------|-----------|--------------|----------------|---------|
| `"FUNCTION"` | YES | YES — found, return it | YES | YES |
| `"METHOD"` | YES | YES — found, return it | YES | YES |
| `"MODULE"` | YES | YES — no containing function | YES | YES |
| `"CLASS"` | YES | YES — not inside a function | YES | YES |

### Table 4: Required Files vs Plan

| File | In Plan? | Required? | Status |
|------|----------|-----------|--------|
| `eval.rs` | YES | YES | OK |
| `eval_explain.rs` | YES | YES | OK |
| `utils.rs` | YES | YES | OK |
| `tests.rs` | YES | YES | OK |
| `ParentFunctionPredicate.test.js` | YES | YES | OK |

---

## Summary of Original Gaps and Their Resolution

| Gap | Original Severity | Resolved in Revision? | Evidence |
|-----|------------------|-----------------------|---------|
| Gap 1: DECLARES missing from traversal set | HIGH | YES | `TRAVERSAL_TYPES = ["CONTAINS", "HAS_SCOPE", "DECLARES"]` + `test_parent_function_variable_node` |
| Gap 2: PARAMETER nodes unresolvable via BFS | HIGH | YES | Pre-check on `node.type == "PARAMETER"` + `get_incoming_edges(NodeId, ["HAS_PARAMETER"])` returning `edge.src = FUNCTION` (verified against shard.rs storage) |
| Gap 3/5: eval_explain.rs not listed as required | HIGH | YES | Explicitly listed as `Required? YES (correctness)` with mirror implementation |
| Gap 4: Test uses METHOD type instead of FUNCTION | LOW | YES | Test comment explicitly states FUNCTION type, references ClassVisitor.ts:358 |
| Gap 6: Non-determinism undocumented | MEDIUM | YES | Documented in predicate doc comment |

**No new gaps introduced by the revision.**

---

## Verdict

**APPROVE**

The revised plan by Don Melton correctly addresses all three HIGH-severity gaps and all remaining issues from the original rejection:

1. **Gap 1 (DECLARES)** — `TRAVERSAL_TYPES` now includes `"DECLARES"`, matching `findContainingFunction.ts:71` exactly. VARIABLE nodes are now correctly handled.

2. **Gap 2 (PARAMETER)** — The pre-BFS check on input node type correctly identifies PARAMETER nodes and resolves them via `get_incoming_edges(NodeId, ["HAS_PARAMETER"])`. I have verified against the actual RFDB storage implementation that `get_incoming_edges` returns edges where `dst = node_id` and `edge.src = parent`, confirming the FUNCTION is correctly retrieved in one call.

3. **Gap 3/5 (eval_explain.rs)** — Explicitly listed as a required modification with a complete mirror implementation. The plan correctly identifies that without this fix, queries using `parent_function` through the explain endpoint return wrong empty results, not merely missing profiling data.

4. **Gap 4 (CLASS METHOD as FUNCTION)** — Test setup now correctly uses `"FUNCTION"` node type with reference to `ClassVisitor.ts:358`.

The algorithm is mathematically correct: BFS with visited set guarantees termination, the traversal edge set matches the TypeScript ground truth, the PARAMETER special case uses the correct edge direction, and `eval_explain.rs` mirroring ensures correctness across all evaluation contexts.

The implementation is ready for Uncle Bob's code quality review.
