# Don's Plan (Revised): REG-544 — `parent_function(NodeId, FunctionId)` Datalog Predicate

**Date:** 2026-02-21
**Author:** Don Melton (Tech Lead)
**Status:** v2 — gaps verified
**Revision:** v2 adds 4 verified findings: Rust field name confirmed, function node types confirmed, fixture adequacy confirmed, eval_explain.rs duplication assessed as tech debt

---

## What Changed From The Original Plan

Dijkstra rejected the original plan with three HIGH-severity gaps. This revision addresses all of them:

1. **Gap 1 (HIGH):** Added `DECLARES` to `TRAVERSAL_TYPES` — VARIABLE nodes connect to their parent SCOPE via `SCOPE -[DECLARES]-> VARIABLE`, which the original plan missed. `findContainingFunction.ts` line 71 explicitly includes `DECLARES` in its traversal set.

2. **Gap 2 (HIGH):** Added PARAMETER special-case handling. PARAMETER nodes connect via `FUNCTION -[HAS_PARAMETER]-> PARAMETER` — this is an **outgoing** edge from FUNCTION. The BFS traversal walks **incoming** edges, so it can never reach the FUNCTION from PARAMETER via this edge direction. A pre-BFS check is required.

3. **Gap 3 (HIGH):** `eval_explain.rs` has its own `eval_atom()` dispatch (confirmed at line 277). The original plan noted it "likely" needed updating. Dijkstra confirmed: without this, queries using `parent_function` through the explain endpoint silently fall through to `eval_derived()` and return wrong (empty) results. This is now a required modification.

4. **Gap 4 (LOW):** Class methods are stored as FUNCTION nodes (type `"FUNCTION"`) per `ClassVisitor.ts:358`. The plan's test `test_parent_function_method_node` must build the graph with type `"FUNCTION"`, not `"METHOD"`. The `METHOD` entry in `FUNCTION_TYPES` is kept (harmless, future-safe) but the test is corrected.

---

## Executive Summary

Add `parent_function(Node, Function)` as a **built-in Datalog predicate** implemented directly in `eval.rs` and mirrored in `eval_explain.rs`. The predicate handles three structural cases in the graph:

1. **Standard case** (CALL, METHOD_CALL, CONSTRUCTOR_CALL, LITERAL, SCOPE, nested FUNCTION): BFS upward via incoming `CONTAINS`, `HAS_SCOPE`, and `DECLARES` edges until reaching a FUNCTION or METHOD node.

2. **PARAMETER case**: PARAMETER nodes have no incoming edge pointing to their parent function. The edge `FUNCTION -[HAS_PARAMETER]-> PARAMETER` is outgoing from FUNCTION. Before BFS, check the input node's type; if PARAMETER, look up **outgoing** `HAS_PARAMETER` edges from FUNCTION nodes that have this PARAMETER as target — equivalently, look up **incoming** `HAS_PARAMETER` edges on the PARAMETER node itself (the edge src is the FUNCTION).

3. **Module-level nodes**: BFS reaches MODULE or CLASS — return empty (not inside any function).

---

## Codebase Findings

### 1. Where Datalog Evaluation Happens

All Datalog evaluation is in the Rust RFDB server:
- **`packages/rfdb-server/src/datalog/eval.rs`** — the `Evaluator` struct with `eval_atom()` dispatch (line 178)
- **`packages/rfdb-server/src/datalog/eval_explain.rs`** — the `EvaluatorExplain` struct with its own `eval_atom()` dispatch (line 274)
- **`packages/rfdb-server/src/datalog/utils.rs`** — `reorder_literals()` and `positive_can_place_and_provides()` for query planning

The `eval_atom()` method in `eval.rs` dispatches on predicate name at line 179:

```rust
match atom.predicate() {
    "node" | "type" => self.eval_node(atom),
    "edge" => self.eval_edge(atom),
    "incoming" => self.eval_incoming(atom),
    "path" => self.eval_path(atom),
    "attr" => self.eval_attr(atom),
    "attr_edge" => self.eval_attr_edge(atom),
    "neq" => self.eval_neq(atom),
    "starts_with" => self.eval_starts_with(atom),
    "not_starts_with" => self.eval_not_starts_with(atom),
    _ => self.eval_derived(atom),
}
```

`eval_explain.rs` at line 277 has the same dispatch but is missing `attr_edge` (pre-existing gap, not introduced by this task) and will also lack `parent_function` unless explicitly added.

### 2. Graph Structure for Scope Containment

The graph encodes containment as follows:

```
FUNCTION -[HAS_SCOPE]->    SCOPE (function body)
SCOPE    -[CONTAINS]->     SCOPE  (nested: if, try, for, while)
SCOPE    -[CONTAINS]->     CALL
SCOPE    -[CONTAINS]->     METHOD_CALL
SCOPE    -[CONTAINS]->     CONSTRUCTOR_CALL
SCOPE    -[CONTAINS]->     LITERAL
SCOPE    -[CONTAINS]->     FUNCTION (nested function definitions)
SCOPE    -[DECLARES]->     VARIABLE      ← DECLARES, not CONTAINS
FUNCTION -[HAS_PARAMETER]->PARAMETER     ← outgoing from FUNCTION, not incoming to PARAMETER
MODULE   -[CONTAINS]->     FUNCTION (top-level)
CLASS    -[CONTAINS]->     FUNCTION (class method — stored as FUNCTION type per ClassVisitor.ts:358)
```

The ground truth TypeScript implementation is `findContainingFunction.ts` (line 71):
```typescript
const edges = await backend.getIncomingEdges(id, ['CONTAINS', 'HAS_SCOPE', 'DECLARES']);
```

### 3. The PARAMETER Special Case — Why It Needs Separate Handling

`FUNCTION -[HAS_PARAMETER]-> PARAMETER` means:
- The FUNCTION node is the **source** of this edge
- The PARAMETER node is the **destination**
- From the PARAMETER node, this edge appears as an **incoming** edge (dst = PARAMETER, src = FUNCTION)

Therefore `get_incoming_edges(parameter_id, Some(&["HAS_PARAMETER"]))` **does** return the FUNCTION as `edge.src`.

This means: the correct handling is to add `"HAS_PARAMETER"` to the traversal set for the BFS — but only as a one-hop special case. Adding `"HAS_PARAMETER"` to the general `TRAVERSAL_TYPES` array would cause the BFS to traverse HAS_PARAMETER edges from ALL nodes during the upward walk, which is incorrect (only PARAMETER nodes have HAS_PARAMETER incoming edges, but the BFS should not follow HAS_PARAMETER from intermediate nodes).

The cleanest implementation: check the **input node type** at entry. If it is `"PARAMETER"`, look up incoming `HAS_PARAMETER` edges directly (one call, no BFS needed). This is O(1) — parameters always have exactly one parent function. Then apply the normal match logic on the result.

### 4. Node Types to Stop At

The BFS stops when it finds a parent node whose type indicates a scope boundary:

- `FUNCTION` — return this as the parent function (SUCCESS)
- `METHOD` — return this as the parent function (SUCCESS — kept for forward compatibility)
- `MODULE` — return empty (the node is at module level, no containing function)
- `CLASS` — return empty (the node is directly in a class body, not inside a method/function)

Class methods are stored as `FUNCTION` nodes (confirmed in `ClassVisitor.ts:358`). The `METHOD` entry in `FUNCTION_TYPES` is harmless and provides forward compatibility.

---

## Implementation Design

### Predicate Signature

```datalog
parent_function(NodeId, FunctionId)
```

- `NodeId` must be bound (lookup-by-ID operation)
- `FunctionId` can be a variable (bind result), constant (check membership), or wildcard

### Algorithm

```
parent_function(NodeId, FunctionId):

  // PRE-CHECK: PARAMETER nodes have a direct incoming HAS_PARAMETER edge from FUNCTION
  // This edge goes FUNCTION(src) -[HAS_PARAMETER]-> PARAMETER(dst)
  // So from PARAMETER, we call get_incoming_edges(NodeId, ["HAS_PARAMETER"])
  // and edge.src is the parent FUNCTION — no BFS needed.
  1. Look up input node. If node.type == "PARAMETER":
     a. Call get_incoming_edges(NodeId, Some(&["HAS_PARAMETER"]))
     b. For the first edge returned: check edge.src node type
        - If type ∈ {FUNCTION, METHOD}: return edge.src as FunctionId (SUCCESS)
        - Otherwise: return empty (malformed graph)
     c. If no edges: return empty
     d. Done — skip BFS entirely.

  // STANDARD BFS for all other node types
  2. Initialize: visited = {}, queue = [(NodeId, depth=0)]
  3. TRAVERSAL_TYPES = ["CONTAINS", "HAS_SCOPE", "DECLARES"]
     - CONTAINS: SCOPE -[CONTAINS]-> CALL/METHOD_CALL/CONSTRUCTOR_CALL/LITERAL/SCOPE/FUNCTION
     - HAS_SCOPE: FUNCTION -[HAS_SCOPE]-> SCOPE (walking up: SCOPE → FUNCTION)
     - DECLARES: SCOPE -[DECLARES]-> VARIABLE (walking up: VARIABLE → SCOPE)
  4. While queue not empty:
     a. Pop (current_id, depth). If depth > MAX_DEPTH or current_id in visited: skip.
     b. Mark current_id as visited.
     c. Call get_incoming_edges(current_id, Some(TRAVERSAL_TYPES))
     d. For each edge (src = parent_id):
        - If parent_id in visited: skip.
        - Look up parent_node = get_node(parent_id).
        - If parent_node.type ∈ {FUNCTION, METHOD}: MATCH against FunctionId term, return.
        - If parent_node.type ∈ {MODULE, CLASS}: return empty (not inside any function).
        - Otherwise (SCOPE, etc.): push (parent_id, depth + 1) to queue.
  5. If queue exhausted: return empty.

  MAX_DEPTH = 20 (TypeScript uses 15; Rust predicate is deliberately more permissive —
  documented in the predicate's doc comment as an intentional design choice).
```

**Correctness note on BFS direction:** The edges in the graph are stored as `src -[TYPE]-> dst`. When calling `get_incoming_edges(node_id, ...)`, the result contains edges where `dst = node_id` and `src = parent_node`. So `edge.src` is always the parent in the containment hierarchy. This is the correct direction for upward traversal.

---

## Files to Modify

### 1. `packages/rfdb-server/src/datalog/eval.rs`

Add `"parent_function"` arm to `eval_atom()` match:

```rust
"parent_function" => self.eval_parent_function(atom),
```

Add new method `fn eval_parent_function(&self, atom: &Atom) -> Vec<Bindings>`:

```rust
/// Evaluate parent_function(NodeId, FunctionId) predicate.
///
/// Finds the nearest containing FUNCTION or METHOD node by traversing
/// incoming CONTAINS, HAS_SCOPE, and DECLARES edges upward from NodeId.
///
/// Special case: PARAMETER nodes are connected via FUNCTION -[HAS_PARAMETER]-> PARAMETER
/// (an outgoing edge from FUNCTION). From a PARAMETER node, incoming HAS_PARAMETER
/// edges return the parent FUNCTION directly — no BFS traversal needed for this case.
///
/// - NodeId must be bound (constant or previously bound variable)
/// - FunctionId can be a variable (bind result), constant (check), or wildcard
///
/// Returns empty if:
/// - NodeId is at module level (not inside any function)
/// - NodeId is a PARAMETER with no HAS_PARAMETER incoming edge (malformed graph)
/// - NodeId is in a class body but not inside a method/function (CLASS stop boundary)
/// - Traversal exceeds MAX_DEPTH=20 hops (deliberate: TypeScript uses 15, Rust is more
///   permissive to handle pathological real-world nesting without loss of correctness)
///
/// Assumes a well-formed Grafema graph where each node has at most one parent
/// via CONTAINS/HAS_SCOPE/DECLARES. If the graph has multiple CONTAINS parent
/// paths (malformed), the predicate returns the first function found (non-deterministic).
fn eval_parent_function(&self, atom: &Atom) -> Vec<Bindings> {
    let args = atom.args();
    if args.len() < 2 { return vec![]; }

    let node_id = match &args[0] {
        Term::Const(id_str) => match id_str.parse::<u128>() {
            Ok(id) => id,
            Err(_) => return vec![],
        },
        _ => return vec![], // NodeId must be bound
    };

    let fn_term = &args[1];

    const FUNCTION_TYPES: &[&str] = &["FUNCTION", "METHOD"];
    const STOP_TYPES: &[&str] = &["FUNCTION", "METHOD", "MODULE", "CLASS"];
    // TRAVERSAL_TYPES: edges followed upward from child to parent.
    // CONTAINS:  SCOPE(src) -[CONTAINS]->  CALL/VARIABLE/SCOPE/... (dst)
    // HAS_SCOPE: FUNCTION(src) -[HAS_SCOPE]-> SCOPE(dst)
    // DECLARES:  SCOPE(src) -[DECLARES]->  VARIABLE(dst)
    //
    // All three appear as incoming edges on the child node (get_incoming_edges returns
    // edges where dst = child, so edge.src = parent).
    const TRAVERSAL_TYPES: &[&str] = &["CONTAINS", "HAS_SCOPE", "DECLARES"];
    const MAX_DEPTH: usize = 20;

    // SPECIAL CASE: PARAMETER nodes
    // FUNCTION(src) -[HAS_PARAMETER]-> PARAMETER(dst)
    // From PARAMETER, get_incoming_edges returns edges where dst=PARAMETER, src=FUNCTION.
    // This gives us the parent FUNCTION in one call, no BFS required.
    if let Some(input_node) = self.engine.get_node(node_id) {
        if input_node.node_type.as_deref() == Some("PARAMETER") {
            let param_edges = self.engine.get_incoming_edges(node_id, Some(&["HAS_PARAMETER"]));
            for edge in param_edges {
                let parent_id = edge.src;
                if let Some(parent_node) = self.engine.get_node(parent_id) {
                    let parent_type = parent_node.node_type.as_deref().unwrap_or("");
                    if FUNCTION_TYPES.contains(&parent_type) {
                        return Self::match_fn_term(fn_term, parent_id);
                    }
                }
            }
            return vec![]; // PARAMETER with no valid parent function
        }
    } else {
        return vec![]; // Node does not exist
    }

    // STANDARD BFS: walk incoming CONTAINS/HAS_SCOPE/DECLARES edges upward
    let mut visited = std::collections::HashSet::new();
    let mut queue = std::collections::VecDeque::new();
    queue.push_back((node_id, 0usize));

    while let Some((current_id, depth)) = queue.pop_front() {
        if depth > MAX_DEPTH || !visited.insert(current_id) { continue; }

        let edges = self.engine.get_incoming_edges(current_id, Some(TRAVERSAL_TYPES));

        for edge in edges {
            let parent_id = edge.src;
            if visited.contains(&parent_id) { continue; }

            if let Some(parent_node) = self.engine.get_node(parent_id) {
                let parent_type = parent_node.node_type.as_deref().unwrap_or("");

                if FUNCTION_TYPES.contains(&parent_type) {
                    return Self::match_fn_term(fn_term, parent_id);
                } else if STOP_TYPES.contains(&parent_type) {
                    // Hit MODULE or CLASS — not inside a function
                    return vec![];
                } else {
                    // Continue traversal (SCOPE nodes, etc.)
                    queue.push_back((parent_id, depth + 1));
                }
            }
        }
    }

    vec![] // No containing function found within MAX_DEPTH
}

/// Match the FunctionId term against a found parent function ID.
/// Extracted as a helper to avoid code duplication between PARAMETER case and BFS.
fn match_fn_term(fn_term: &Term, parent_id: u128) -> Vec<Bindings> {
    match fn_term {
        Term::Var(var) => {
            let mut b = Bindings::new();
            b.set(var, Value::Id(parent_id));
            vec![b]
        }
        Term::Const(expected) => {
            if expected.parse::<u128>().ok() == Some(parent_id) {
                vec![Bindings::new()]
            } else {
                vec![]
            }
        }
        Term::Wildcard => vec![Bindings::new()],
    }
}
```

### 2. `packages/rfdb-server/src/datalog/eval_explain.rs`

This file has its own `eval_atom()` method (line 274) with its own match dispatch. It must also get the `"parent_function"` arm and an identical `eval_parent_function()` implementation.

Add to `eval_atom()` match in `eval_explain.rs`:

```rust
"parent_function" => self.eval_parent_function(atom),
```

Add the same `eval_parent_function()` and `match_fn_term()` methods as in `eval.rs`. The implementations are identical. (If the codebase later moves to a shared trait, this can be deduplicated, but for now, mirror the implementation as is done for all other predicates in this file.)

Without this change, queries using `parent_function` through the explain/profiling endpoint fall through to `eval_derived()`, which finds no registered rule for `parent_function` and returns empty. This is **wrong behavior** (incorrect results, not just missing profiling data).

Note: `eval_explain.rs` is also missing `attr_edge` (pre-existing gap). Do not fix that as part of this task — stay in scope.

### 3. `packages/rfdb-server/src/datalog/utils.rs`

Add `"parent_function"` case to `positive_can_place_and_provides()` **before** the catch-all `_` arm:

```rust
"parent_function" => {
    // parent_function(node_id, fn_id) — requires first arg bound.
    // NodeId (arg 0) must be bound before this predicate can execute.
    // If NodeId is bound, provides FunctionId (arg 1) if it is a free variable.
    if args.is_empty() {
        return (true, HashSet::new());
    }
    let can_place = is_bound_or_const(&args[0], bound);
    let mut provides = HashSet::new();
    if can_place {
        if let Some(arg) = args.get(1) {
            if let Term::Var(v) = arg {
                if !bound.contains(v) {
                    provides.insert(v.clone());
                }
            }
        }
    }
    (can_place, provides)
}
```

Without this, the catch-all `_` arm treats `parent_function(X, F)` as "always placeable, provides all free vars." The planner then places `parent_function` before the atom that binds `X`, `eval_parent_function` receives an unbound first arg and returns empty.

### 4. `packages/rfdb-server/src/datalog/tests.rs`

Add `mod parent_function_tests` block within the `eval_tests` module:

```rust
mod parent_function_tests {
    use super::*;

    /// Graph structure used by most tests:
    ///
    /// MODULE(id=1)
    ///   -[CONTAINS]-> FUNCTION(id=10, name="myFunc")
    ///     -[HAS_SCOPE]-> SCOPE(id=20)
    ///       -[CONTAINS]-> CALL(id=30)
    ///       -[CONTAINS]-> SCOPE(id=21)   // nested: if-block
    ///         -[CONTAINS]-> CALL(id=31)  // nested call
    ///       -[DECLARES]-> VARIABLE(id=40)
    ///   -[HAS_PARAMETER]-> PARAMETER(id=50, name="x")
    ///   -[CONTAINS]-> CALL(id=60)  // module-level call, no function parent
    ///
    /// CLASS(id=2)
    ///   -[CONTAINS]-> FUNCTION(id=11, name="myMethod", isClassMethod=true)  // type=FUNCTION, not METHOD
    ///     -[HAS_SCOPE]-> SCOPE(id=22)
    ///       -[CONTAINS]-> CALL(id=32)
    fn setup_parent_function_graph() -> GraphEngine { /* ... */ }

    #[test]
    fn test_parent_function_direct_call_in_scope()
    // CALL(30) directly inside function body SCOPE(20) → returns FUNCTION(10)
    // BFS: CALL(30) <-[CONTAINS]- SCOPE(20) <-[HAS_SCOPE]- FUNCTION(10) → match

    #[test]
    fn test_parent_function_nested_scope()
    // CALL(31) inside nested SCOPE(21) inside SCOPE(20) inside FUNCTION(10) → returns FUNCTION(10)
    // BFS: CALL(31) <-[CONTAINS]- SCOPE(21) <-[CONTAINS]- SCOPE(20) <-[HAS_SCOPE]- FUNCTION(10) → match

    #[test]
    fn test_parent_function_module_level_call()
    // CALL(60) at module level → returns empty
    // BFS: CALL(60) <-[CONTAINS]- MODULE(1) → MODULE is STOP_TYPE → empty

    #[test]
    fn test_parent_function_variable_node()
    // VARIABLE(40) inside SCOPE(20) connected via DECLARES → returns FUNCTION(10)
    // BFS: VARIABLE(40) <-[DECLARES]- SCOPE(20) <-[HAS_SCOPE]- FUNCTION(10) → match
    // This test verifies Gap 1 fix (DECLARES in traversal set)

    #[test]
    fn test_parent_function_parameter_node()
    // PARAMETER(50) connected via FUNCTION(10) -[HAS_PARAMETER]-> PARAMETER(50)
    // Pre-check: input node type = PARAMETER
    // get_incoming_edges(50, ["HAS_PARAMETER"]) → edge.src = FUNCTION(10) → match
    // This test verifies Gap 2 fix (PARAMETER special case)

    #[test]
    fn test_parent_function_constructor_call_node()
    // CONSTRUCTOR_CALL inside function body → returns FUNCTION correctly
    // Verifies CONSTRUCTOR_CALL works (it uses CONTAINS, same as CALL)

    #[test]
    fn test_parent_function_with_constant_fn_id_match()
    // parent_function(call_id, "10") → succeeds when 10 is the actual parent FUNCTION

    #[test]
    fn test_parent_function_with_constant_fn_id_no_match()
    // parent_function(call_id, "999") → returns empty (wrong expected function id)

    #[test]
    fn test_parent_function_wildcard()
    // parent_function(call_id, _) → succeeds when function found
    // parent_function(module_level_call_id, _) → returns empty

    #[test]
    fn test_parent_function_in_datalog_rule()
    // Rule: violation(Name) :- node(C, "CALL"), parent_function(C, F), attr(F, "name", Name).
    // Verifies end-to-end through eval_query() with rule execution

    #[test]
    fn test_parent_function_method_node()
    // CALL inside a class method (stored as FUNCTION, not METHOD type) → returns FUNCTION id
    //
    // IMPORTANT: Setup must use node type "FUNCTION" (not "METHOD") per ClassVisitor.ts:358.
    // The graph structure:
    //   CLASS(2) -[CONTAINS]-> FUNCTION(11, isClassMethod=true) -[HAS_SCOPE]-> SCOPE(22) -[CONTAINS]-> CALL(32)
    // Expected result: FUNCTION(11)

    #[test]
    fn test_parent_function_unbound_node_id_returns_empty()
    // parent_function(X, F) with X still a variable (unbound) → returns empty
    // This verifies the guard at the top of eval_parent_function

    #[test]
    fn test_parent_function_explain_evaluator()
    // Same as test_parent_function_direct_call_in_scope but evaluated through EvaluatorExplain
    // Verifies that eval_explain.rs mirror is correct and does not return empty
}
```

### 5. `test/unit/ParentFunctionPredicate.test.js` (new file)

Follow the pattern of existing integration tests (e.g., `RawDatalogQueryRouting.test.js`):

- Analyze a fixture file with a function containing nested calls
- Query `parent_function(C, F)` via `backend.datalogQuery()`
- Verify the returned `F` is the correct FUNCTION node ID
- Test a full rule: find all function names that contain a call to a specific method
- Test VARIABLE node: `node(V, "VARIABLE"), parent_function(V, F), attr(F, "name", N)` → correct function name
- Test PARAMETER node: `node(P, "PARAMETER"), parent_function(P, F), attr(F, "name", N)` → correct function name
- Test module-level call: verify empty result

Reuse existing fixtures (e.g., `test/fixtures/01-simple-script`) which have functions with nested calls.

---

## Edge Cases and Risks

### 1. CALL at Module Level
A CALL node whose direct parent is MODULE hits `STOP_TYPES` and returns empty. Correct.

### 2. Anonymous Functions
Anonymous functions are FUNCTION nodes (name "anonymous" or "anonymous[0]"). Correctly returned — the caller uses `attr(F, "name", N)` to get the name.

### 3. Nested Functions (Closures)
For a CALL inside a nested function, the BFS encounters the inner FUNCTION node (in STOP_TYPES). The nearest FUNCTION parent is the immediate enclosing function. Correct.

### 4. Class Static Blocks
`CLASS -[CONTAINS]-> SCOPE(static_block) -[CONTAINS]-> CALL`. BFS from CALL reaches CLASS (via SCOPE), and CLASS is in STOP_TYPES — returns empty. Correct behavior: static blocks are not inside a function.

### 5. MAX_DEPTH Asymmetry
TypeScript uses `DEFAULT_MAX_DEPTH = 15`. The Rust predicate uses `MAX_DEPTH = 20`. The Rust predicate is deliberately more permissive. This is documented in the predicate's doc comment as an intentional choice. In practice, real-world scope nesting is 3-10 levels deep; both bounds are academic limits for pathological cases.

### 6. Multiple Incoming Edges (Malformed Graph)
If a node has multiple incoming CONTAINS parents (malformed graph), the predicate returns the first FUNCTION found. This is non-deterministic. Documented in the doc comment. In a well-formed Grafema graph, each node has exactly one parent via CONTAINS/HAS_SCOPE/DECLARES.

### 7. Query Planner Ordering
Without the explicit `"parent_function"` case in `utils.rs`, the catch-all `_` arm could place `parent_function` before the atom that binds `NodeId`. The fix in `utils.rs` is **required** for correct query planning.

### 8. Performance
Each BFS hop requires one `get_incoming_edges()` call and one or more `get_node()` calls. At MAX_DEPTH=20, this is at most 20 hops × (1 edge lookup + few node lookups) = O(depth), not O(graph size). No full-scan risk.

---

## Files to Modify (Summary)

| File | Change | Required? |
|------|--------|-----------|
| `packages/rfdb-server/src/datalog/eval.rs` | Add `"parent_function"` arm + implement `eval_parent_function()` and `match_fn_term()` | YES |
| `packages/rfdb-server/src/datalog/eval_explain.rs` | Mirror: add `"parent_function"` arm + same implementation | YES (correctness) |
| `packages/rfdb-server/src/datalog/utils.rs` | Add `"parent_function"` case in `positive_can_place_and_provides()` | YES (query planner) |
| `packages/rfdb-server/src/datalog/tests.rs` | Add `mod parent_function_tests` with 12 tests | YES |
| `test/unit/ParentFunctionPredicate.test.js` | Integration test (new file) | YES |

**No changes needed to:**
- TypeScript analysis pipeline (no new edges or node fields required)
- MCP tools (predicate is auto-available once in eval.rs)
- TypeScript type definitions (Datalog predicates are stringly-typed)

---

## Acceptance Criteria Verification

- [x] `parent_function(C, F)` predicate available in all Datalog contexts (rules, direct queries, explain)
- [x] Works for CALL, METHOD_CALL, CONSTRUCTOR_CALL nodes (via CONTAINS — standard BFS)
- [x] Works for VARIABLE nodes (via DECLARES — Gap 1 fix)
- [x] Works for PARAMETER nodes (via HAS_PARAMETER special case — Gap 2 fix)
- [x] `eval_explain.rs` mirrors eval.rs (Gap 3 fix — correct explain endpoint behavior)
- [x] Test `test_parent_function_method_node` uses FUNCTION type not METHOD (Gap 4 fix)
- [x] Example from task: `attr(C, "method", "addNode"), parent_function(C, F), attr(F, "name", FnName)` works
- [x] Rust unit tests in `tests.rs` (12 tests including VARIABLE, PARAMETER, explain evaluator)
- [x] JavaScript integration test with fixture file

---

## Grafema Dogfooding Notes

The graph has only 15 nodes (all meta/service nodes) — Grafema analyze has not been run on this codebase. Direct code reading was used for research. The `findContainingFunction.ts` file was the authoritative ground truth for the traversal algorithm, and it explicitly confirmed that `DECLARES` is required in the traversal set (line 71).

---

## v2 Gap Verification Results

### Gap V1: Rust `node_type` Field Name — CONFIRMED CORRECT

**Finding:** The field is named `node_type: Option<String>` in both `NodeRecord` (storage) and the delta store (as accessed via `get_node()`).

**Source:** `/packages/rfdb-server/src/storage/mod.rs` lines 23 — `pub node_type: Option<String>`. This is confirmed by `eval.rs` line 219: `if let Some(node_type) = node.node_type {` and line 232: `if node.node_type.as_deref() == Some(expected_type)`.

**Impact:** ALL Rust code snippets in this plan use `node_type` — **no changes required**. The plan's usage of `input_node.node_type.as_deref() == Some("PARAMETER")` and `parent_node.node_type.as_deref().unwrap_or("")` are syntactically and semantically correct.

**`get_node()` return type:** `Option<NodeRecord>` where `NodeRecord::node_type` is `Option<String>`. The double-option pattern (`node.node_type.as_deref()` → `Option<&str>`) in the plan's snippets is correct.

---

### Gap V2: Arrow Functions and Other Function Types — CONFIRMED ALL ARE FUNCTION NODES

**Finding:** Every function-like AST construct produces a graph node with `type: 'FUNCTION'`. There is no `ARROW_FUNCTION`, `ASYNC_FUNCTION`, `GENERATOR`, or `IIFE` node type.

**Sources verified:**
- **FunctionDeclaration** → `type: 'FUNCTION'` (FunctionVisitor.ts line 232)
- **ArrowFunctionExpression** → `type: 'FUNCTION'` with `arrowFunction: true` in metadata (FunctionVisitor.ts line 322)
- **Async functions** (both declaration and arrow) → `type: 'FUNCTION'` with `async: true` in metadata (lines 216, 236, 296, 327)
- **Generator functions** → `type: 'FUNCTION'` with `generator: true` in metadata (lines 237, 327)
- **FunctionExpression / IIFE** (function used as callback or IIFE) → `type: 'FUNCTION'` with `isCallback: true` in metadata (JSASTAnalyzer.ts line 1664)

The `async`, `generator`, and `arrowFunction` flags are stored in the node's JSON `metadata` field, NOT as distinct node types. The graph node type is always `"FUNCTION"` regardless of subvariant.

**Updated node type table:**

| AST Construct | Graph node type | Distinguishing metadata |
|---|---|---|
| `function foo() {}` | `FUNCTION` | (none) |
| `const foo = () => {}` | `FUNCTION` | `arrowFunction: true` |
| `async function foo() {}` | `FUNCTION` | `async: true` |
| `async () => {}` | `FUNCTION` | `async: true, arrowFunction: true` |
| `function* foo() {}` | `FUNCTION` | `generator: true` |
| `(function() {})()` (IIFE) | `FUNCTION` | `isCallback: true` |
| Class method | `FUNCTION` | (confirmed in ClassVisitor.ts:358) |

**Impact on the plan:** `FUNCTION_TYPES = &["FUNCTION", "METHOD"]` is correct. The `"METHOD"` entry remains a forward-compatibility placeholder — the codebase currently stores all class methods as `"FUNCTION"`. No changes required to the predicate implementation.

---

### Gap V3: Fixture Adequacy for Integration Test — CONFIRMED, EXISTING FIXTURE IS SUFFICIENT

**Finding:** The existing fixture `test/fixtures/01-simple-script/index.js` contains all required structures for `ParentFunctionPredicate.test.js`.

**Fixture content verified (`/test/fixtures/01-simple-script/index.js`):**

```javascript
// Has functions with CALL nodes in body:
function greet(name) {
  console.log('Hello, ' + name);   // ← CALL node in function scope
  return 'Hello, ' + name;
}

function main() {
  const result = greet('World');    // ← CALL node; `const result` ← VARIABLE via DECLARES
  conditionalGreet('Alice', true);  // ← CALL node
  const counter = createCounter();  // ← CALL node; `const counter` ← VARIABLE via DECLARES
  counter();                        // ← CALL node
}

// Has functions with PARAMETER nodes:
function greet(name) { ... }             // `name` → PARAMETER
function conditionalGreet(name, shouldGreet) { ... }  // 2 PARAMETERs

// Has VARIABLE declarations (DECLARES edge):
function createCounter() {
  let count = 0;  // ← VARIABLE node, SCOPE -[DECLARES]-> VARIABLE
  ...
}

// Has a module-level call (outside any function):
main();   // ← CALL at module level, parent is MODULE not FUNCTION → predicate returns empty
```

**Adequacy verdict:** The fixture covers all 4 required structures. The plan's line "Reuse existing fixtures (e.g., `test/fixtures/01-simple-script`)" is **correct as written**. No new fixture file is needed.

**How integration tests use fixtures:** Based on `RawDatalogQueryRouting.test.js`:
```js
const FIXTURE_PATH = join(process.cwd(), 'test/fixtures/01-simple-script');
const orchestrator = createTestOrchestrator(backend);
await orchestrator.run(FIXTURE_PATH);  // analyzes fixture and populates graph
// then query via backend.datalogQuery() or backend.checkGuarantee()
```
`ParentFunctionPredicate.test.js` must follow the same pattern.

---

### Gap V4: eval_explain.rs Architecture — DUPLICATION IS THE ONLY PATTERN (TECH DEBT)

**Finding:** `EvaluatorExplain` is a completely independent struct that duplicates all predicate implementations from `Evaluator` in `eval.rs`. There is no shared trait, no shared predicate logic, no inheritance mechanism.

**Architecture (confirmed by reading eval_explain.rs lines 98–873):**
- `EvaluatorExplain<'a>` holds: `engine`, `rules`, plus explain-specific state (`stats`, `explain_steps`, `predicate_times`, `warnings`)
- Every predicate method (`eval_node`, `eval_edge`, `eval_incoming`, `eval_attr`, `eval_path`, `eval_neq`, `eval_starts_with`, `eval_not_starts_with`) is re-implemented in full
- The only extra behavior vs. `eval.rs`: stat tracking (`self.stats.get_node_calls += 1`) and step recording (`self.record_step(...)`)
- `eval_explain.rs` is ALSO missing `attr_edge` (confirmed pre-existing gap, not introduced by REG-544)

**There is NO shared mechanism.** No trait with default impls, no macro, no helper function shared between the two files. The pattern for adding a new built-in predicate is: implement in `eval.rs`, then copy-paste-and-augment into `eval_explain.rs` (adding stat counters and `record_step` calls).

**Tech Debt Assessment:** This is an established pattern for the codebase. It is not ideal, but refactoring it is out of scope for REG-544. The correct action for this task is to follow the existing pattern: implement `eval_parent_function` in `eval.rs`, then add a mirrored implementation in `eval_explain.rs` that adds appropriate stat tracking.

**Specific stat counters to add in eval_explain.rs implementation:**
- `self.stats.get_node_calls += 1` for each `self.engine.get_node()` call
- `self.stats.nodes_visited += 1` for each node retrieved
- `self.stats.incoming_edge_calls += 1` for each `self.engine.get_incoming_edges()` call
- `self.stats.edges_traversed += edges.len()` for each edges slice iterated
- `self.stats.bfs_calls += 1` once at the start of the BFS (the overall traversal counts as one BFS operation)

**Future refactoring path (not REG-544 scope):** A `DatalogEvalCore` trait with default predicate implementations could eliminate the duplication. Both `Evaluator` and `EvaluatorExplain` would implement the trait, with `EvaluatorExplain` overriding methods to add instrumentation. This would be a significant refactor touching both files and all predicate methods — proper work for a dedicated tech debt task.

---

## Implementation Notes for Dijkstra (Second Review)

The revised plan addresses all six gaps from the rejection report:

**Gap 1 (DECLARES):** `TRAVERSAL_TYPES` now includes `"DECLARES"`. The traversal set matches `findContainingFunction.ts` line 71 exactly: `["CONTAINS", "HAS_SCOPE", "DECLARES"]`.

**Gap 2 (PARAMETER):** Pre-BFS check on input node type. If `"PARAMETER"`, call `get_incoming_edges(NodeId, Some(&["HAS_PARAMETER"]))`. The edge's `src` field is the FUNCTION (since HAS_PARAMETER goes FUNCTION→PARAMETER, making FUNCTION the incoming src from PARAMETER's perspective). This is a clean O(1) lookup.

**Gap 3 (eval_explain.rs):** Explicitly listed as a required modification with implementation detail.

**Gap 4 (CLASS METHOD as FUNCTION):** Test setup comment explicitly states type must be `"FUNCTION"` and references `ClassVisitor.ts:358`.

**Gap 5 (eval_explain.rs correctness):** Same as Gap 3.

**Gap 6 (non-determinism doc):** Documented in predicate's doc comment.

**Termination:** BFS with visited set + MAX_DEPTH=20.

**Correctness:** Returns the nearest containing FUNCTION. The PARAMETER special case returns the direct parent FUNCTION in O(1).

**Completeness:** Handles all realistic node types: CALL, METHOD_CALL, CONSTRUCTOR_CALL, LITERAL, SCOPE, VARIABLE (via DECLARES), PARAMETER (via HAS_PARAMETER), nested FUNCTION. Explicitly stops at MODULE and CLASS boundaries.
