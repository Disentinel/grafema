# REG-489: Kent Beck -- Test Report

## Test 1: Rust Unit Tests for `handle_commit_batch` with `protected_types`

**Location:** `packages/rfdb-server/src/bin/rfdb_server.rs`, test module `protocol_tests`

Three tests added at the end of the existing test module:

### `test_commit_batch_protected_types_preserves_nodes`

**What it tests:** Core feature -- when `protected_types: ["MODULE"]` is passed to commitBatch, MODULE nodes are preserved while non-protected node types (FUNCTION) are deleted and replaced.

**Setup:**
- Create MODULE + FUNCTION nodes for file "app.js" (simulates INDEXING phase)
- Call commitBatch with changedFiles: ["app.js"], new FUNCTION node, protected_types: ["MODULE"]

**Assertions:**
- Delta reports 1 node removed (FUNCTION only), 1 node added
- MODULE node still exists (NodeExists returns true)
- Old FUNCTION deleted (NodeExists returns false)
- New FUNCTION exists

### `test_commit_batch_empty_protected_types_legacy_behavior`

**What it tests:** Backward compatibility -- empty `protected_types: []` preserves the legacy delete-all behavior. Ensures callers not using the new feature are unaffected.

**Setup:**
- Create MODULE + FUNCTION nodes for file "app.js"
- Call commitBatch with changedFiles: ["app.js"], new FUNCTION node, protected_types: []

**Assertions:**
- Delta reports 2 nodes removed (both MODULE and FUNCTION deleted)
- MODULE does NOT exist (legacy behavior -- all nodes for file are replaced)
- New FUNCTION exists

### `test_commit_batch_protected_node_edges_preserved`

**What it tests:** Edge preservation -- when MODULE is protected, edges connected to MODULE survive the deletion phase. Cross-file edges (SERVICE -> MODULE) are preserved, and new edges from the batch (MODULE -> new FUNCTION) are added.

**Setup:**
- Create SERVICE node (file: service.js), MODULE node (file: app.js), FUNCTION node (file: app.js)
- Add edges: SERVICE -> MODULE (CONTAINS), MODULE -> FUNCTION (CONTAINS)
- Call commitBatch with changedFiles: ["app.js"], new FUNCTION, new MODULE->FUNCTION edge, protected_types: ["MODULE"]

**Assertions:**
- Delta reports 1 node removed (FUNCTION only), 1 node added
- MODULE survives
- SERVICE -> MODULE CONTAINS edge survives (cross-file edge to protected node)
- MODULE -> new FUNCTION CONTAINS edge exists (from the batch)

**Run command:** `cargo test "protected" --bin rfdb-server`

---

## Test 2: TypeScript Integration Test for MODULE Survival

**Location:** `test/unit/REG489ModuleSurvival.test.js`

Three tests using the real RFDB server via `createTestDatabase()`:

### `should preserve MODULE node when protectedTypes includes MODULE`

**What it tests:** End-to-end wire protocol -- creating nodes via `addNodes`, then calling `client.commitBatch()` with `protectedTypes: ['MODULE']` preserves MODULE nodes and their edges.

**Setup:**
- Add MODULE + FUNCTION nodes for "app.js" via `backend.addNodes()`
- Add SERVICE node for "service.js" with CONTAINS edge to MODULE
- Call `client.beginBatch()`, batch a new FUNCTION for "app.js", commit with `protectedTypes: ['MODULE']`

**Assertions:**
- MODULE nodes found via `findByType('MODULE')` after commitBatch
- New FUNCTION exists via `findByType('FUNCTION')`
- SERVICE -> MODULE CONTAINS edge preserved via `getOutgoingEdges()`

### `should delete MODULE when protectedTypes is not provided`

**What it tests:** Regression baseline -- without protectedTypes, MODULE is deleted (this IS the bug REG-489 fixes). Ensures the test can detect when the fix is missing.

**Setup:**
- Add MODULE + FUNCTION for "app.js"
- CommitBatch WITHOUT protectedTypes parameter

**Assertions:**
- MODULE count is 0 (deleted -- legacy behavior)
- New FUNCTION exists

### `should preserve edges FROM protected nodes when their targets are also protected`

**What it tests:** MODULE -> MODULE DEPENDS_ON edge survival. When two MODULE nodes exist and one file is re-analyzed, inter-module edges survive because both endpoints are protected.

**Setup:**
- Create MODULE(a.js), MODULE(b.js), FUNCTION(a.js)
- Add edges: MODULE(a.js) -> MODULE(b.js) DEPENDS_ON, MODULE(a.js) -> FUNCTION CONTAINS
- CommitBatch for "a.js" with protectedTypes: ["MODULE"]

**Assertions:**
- Both MODULE nodes survive (count = 2)
- DEPENDS_ON edge between MODULEs preserved

**Run command:** `node --test test/unit/REG489ModuleSurvival.test.js`

---

## Test Results

All 6 tests pass (3 Rust, 3 TypeScript):

```
Rust:  3 passed, 0 failed (0.05s)
TS:    3 passed, 0 failed (2.7s)
```

The Rust `test_commit_batch_protected_types_preserves_nodes` and `test_commit_batch_empty_protected_types_legacy_behavior` pass because the implementation in `handle_commit_batch` already has the `continue` guard for protected types (lines 1534-1542 of rfdb_server.rs). The edge test passes because the `continue` skips the entire inner block including edge deletion loops.
