# Don Melton's Analysis: REG-115 Reachability Queries

**Motto: "I don't care if it works, is it RIGHT?"**

## Current State Analysis

### What Exists

1. **BFS/DFS in Rust engine** (`rust-engine/src/graph/traversal.rs`):
   - Generic BFS/DFS functions that take a `get_neighbors` closure
   - Currently only used for forward traversal (outgoing edges)

2. **GraphEngine methods** (`rust-engine/src/graph/engine.rs`):
   - `neighbors(id, edge_types)` - returns outgoing neighbors only
   - `bfs(start, max_depth, edge_types)` - forward BFS via neighbors
   - `get_outgoing_edges(node_id, edge_types)` - efficient via adjacency list
   - `get_incoming_edges(node_id, edge_types)` - **scans all edges** (no reverse index)

3. **TypeScript layer** (`packages/core/src/storage/backends/RFDBServerBackend.ts`):
   - Wraps Rust engine via Unix socket
   - `bfs()` and `dfs()` exposed but only forward
   - `getIncomingEdges()` exposed but delegates to slow Rust implementation

4. **Existing usage patterns**:
   - `packages/cli/src/commands/impact.ts` - manual backward BFS using `getIncomingEdges()` in a loop
   - `packages/mcp/src/handlers.ts` - `handleTraceDataFlow()` uses recursive traversal

### Key Gap

**The problem:** Backward traversal (finding sources that flow into a sink) is implemented ad-hoc in TypeScript, not in the Rust engine. This means:
- Performance: Every backward step requires scanning ALL edges (O(E) per step)
- Inconsistency: Different tools implement their own traversal logic
- Missing API: No unified `reachability()` that handles direction

---

## Design Decisions

### Decision 1: Where to implement?

**Recommendation: Rust engine with reverse adjacency list**

Rationale:
- Performance is critical for large graphs
- Forward traversal already uses adjacency list (fast)
- Backward traversal currently scans all edges (slow)
- Adding reverse adjacency list makes backward O(1) per step
- Single implementation in Rust, exposed via protocol

### Decision 2: API Design

**Recommendation: Add `reachability` command to RFDB protocol**

```typescript
interface ReachabilityQuery {
  startIds: string[];           // Starting nodes (sink for backward, source for forward)
  edgeTypes: EdgeType[];        // Which edges to traverse
  direction: 'forward' | 'backward';
  maxDepth: number;
  stopAtTypes?: NodeType[];     // Optional: stop when reaching certain node types
}

interface ReachabilityResult {
  reachable: string[];          // All reachable node IDs
}
```

### Decision 3: Build reverse adjacency at load time

**Recommendation: Build at load time (same as forward adjacency)**

Rationale:
- Forward adjacency is already built at load time
- Symmetric treatment simplifies code
- One-time cost at startup, zero cost at query time

### Decision 4: Return paths or just reachable nodes?

**Recommendation: Return just node IDs by default**

Rationale:
- Most use cases just need "is X reachable from Y?"
- Paths can explode combinatorially
- Can add `includePaths: true` later if needed

---

## High-Level Implementation Approach

### Phase 1: Rust Engine Changes

1. Add reverse adjacency list to GraphEngine
   - `reverse_adjacency: HashMap<u128, Vec<usize>>` (dst -> edge indices)
   - Build alongside forward adjacency in `open()` and `flush()`
   - Add `reverse_neighbors(id, edge_types)` method

2. Add `reachability` method using existing BFS with direction-aware neighbor function

### Phase 2: Protocol Extension

1. Add `Reachability` request variant to `rfdb_server.rs`

### Phase 3: TypeScript Client

1. Add `reachability()` to `RFDBClient`
2. Add `reachability()` to `RFDBServerBackend`

### Phase 4: MCP Integration

1. Add `trace_reachability` tool to MCP

---

## Risks and Considerations

| Risk | Mitigation |
|------|------------|
| Reverse adjacency doubles memory | Acceptable; edge count ≈ node count |
| Cycles cause infinite loops | BFS uses visited set; already handled |
| Some edges semantically one-way | Caller specifies edge types explicitly |

---

## Acceptance Criteria Mapping

| Criteria | Implementation |
|----------|----------------|
| `graph.reachability()` API | `RFDBServerBackend.reachability()` |
| Backward traversal | `direction: 'backward'` + reverse adjacency |
| Forward traversal | `direction: 'forward'` + existing adjacency |
| Configurable edge types | `edgeTypes` parameter |
| Depth limit | `maxDepth` parameter in BFS |
| Performance | Reverse adjacency list O(1) per step |

---

## Recommendation

**Proceed with Rust-first implementation.**

The key insight is that backward traversal is the bottleneck, and fixing it requires adding reverse adjacency in the Rust engine. Once that's done, the rest is straightforward.

### Critical Files

- `rust-engine/src/graph/engine.rs` - Add reverse adjacency + reachability
- `rust-engine/src/bin/rfdb_server.rs` - Add protocol handler
- `packages/rfdb/ts/client.ts` - Add client method
- `packages/core/src/storage/backends/RFDBServerBackend.ts` - Expose in backend
- `packages/mcp/src/handlers.ts` - MCP tool
