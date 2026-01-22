# Joel Spolsky's Technical Plan: REG-115 Reachability Queries

## Executive Summary

This plan details the implementation of transitive reachability queries for Grafema's graph engine. The key technical challenge is efficient backward traversal - currently O(E) per step due to full edge scan. We solve this by adding a reverse adjacency list to the Rust engine, then exposing it through the protocol stack.

---

## Phase 1: Rust Engine - Reverse Adjacency List

### Step 1.1: Add Reverse Adjacency Data Structure

**File:** `rust-engine/src/graph/engine.rs`

Add `reverse_adjacency: HashMap<u128, Vec<usize>>` field after `adjacency`.

Changes required:
1. Struct definition: add field
2. `GraphEngine::create()`: initialize `reverse_adjacency: HashMap::new()`
3. `GraphEngine::open()`: build reverse adjacency alongside forward
4. `apply_delta() AddEdge`: update reverse adjacency
5. `GraphEngine::clear()`: clear reverse_adjacency
6. `flush()`: rebuild reverse adjacency

### Step 1.2: Add reverse_neighbors Method

**File:** `rust-engine/src/graph/engine.rs` (after `neighbors()`)

```rust
pub fn reverse_neighbors(&self, id: u128, edge_types: &[&str]) -> Vec<u128>
```

### Step 1.3: Update get_incoming_edges to Use Reverse Adjacency

Replace O(E) scan with O(degree) lookup via reverse_adjacency.

### Step 1.4: Add Reachability Method

```rust
pub fn reachability(
    &self,
    start: &[u128],
    max_depth: usize,
    edge_types: &[&str],
    backward: bool
) -> Vec<u128>
```

---

## Phase 2: Protocol Extension

### Step 2.1: Add Reachability Request

**File:** `rust-engine/src/bin/rfdb_server.rs`

Add to `Request` enum:
```rust
Reachability {
    start_ids: Vec<String>,
    max_depth: u32,
    edge_types: Vec<String>,
    backward: bool,
}
```

### Step 2.2: Add Request Handler

Add match arm in `handle_request()` that calls `engine.reachability()`.

---

## Phase 3: TypeScript Client

### Step 3.1: Add Command Type

**File:** `packages/types/src/rfdb.ts` - add `'reachability'` to `RFDBCommand`

### Step 3.2: Add Request Interface

```typescript
export interface ReachabilityRequest extends RFDBRequest {
  cmd: 'reachability';
  startIds: string[];
  maxDepth: number;
  edgeTypes?: EdgeType[];
  backward: boolean;
}
```

### Step 3.3: Add Client Interface Method

**File:** `packages/types/src/rfdb.ts` - add to `IRFDBClient`:
```typescript
reachability(startIds: string[], maxDepth: number, edgeTypes: EdgeType[], backward: boolean): Promise<string[]>;
```

### Step 3.4: Implement in RFDBClient

**File:** `packages/rfdb/ts/client.ts`

### Step 3.5: Implement in RFDBServerBackend

**File:** `packages/core/src/storage/backends/RFDBServerBackend.ts`

---

## Phase 4: Tests

### Step 4.1: Rust Unit Tests

Test cases:
- `test_reverse_adjacency_basic` - basic reverse neighbor lookup
- `test_reachability_forward` - forward traversal
- `test_reachability_backward` - backward traversal
- `test_reverse_adjacency_persists_after_flush` - persistence

### Step 4.2: Integration Tests (TypeScript)

**File:** `test/unit/reachability.test.ts`

---

## Implementation Order

```
Step 1.1 (reverse_adjacency field)
    ↓
Step 1.2 (reverse_neighbors method)
    ↓
Step 1.3 (update get_incoming_edges) ← Parallel with 1.2
    ↓
Step 1.4 (reachability method)
    ↓
Step 4.1 (Rust tests)
    ↓
Step 2.1 + 2.2 (protocol)
    ↓
Step 3.1-3.5 (TypeScript)
    ↓
Step 4.2 (Integration tests)
```

---

## Definition of Done

| Step | Done When |
|------|-----------|
| 1.1 | `reverse_adjacency` field compiles, initialized everywhere |
| 1.2 | `reverse_neighbors()` returns correct results |
| 1.3 | `get_incoming_edges()` uses reverse adjacency |
| 1.4 | `reachability()` works forward and backward |
| 2.1-2.2 | Server handles `Reachability` request |
| 3.1-3.5 | TypeScript client can call `reachability()` |
| 4.1 | All Rust tests pass |
| 4.2 | Integration tests pass |

---

## Performance

| Operation | Before | After |
|-----------|--------|-------|
| `get_incoming_edges(id)` | O(E) | O(degree) |
| Backward BFS | O(V * E) | O(V + E) |
| Memory | None | O(E) |

---

## Edge Cases

1. **Non-existent start node:** Return empty array
2. **Empty edge_types:** Traverse ALL edge types
3. **maxDepth = 0:** Return only start nodes
4. **Cycle in graph:** Handled by visited set in BFS
