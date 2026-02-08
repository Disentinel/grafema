# REG-124: Language Selection for Grafema Core

**Status:** Research complete
**Decision:** Rust long-term, but the immediate win is **batching IPC calls** (no rewrite needed)

## TL;DR

We profiled Grafema on a real project (Jammers, 153 files). The bottleneck is **N+1 IPC calls** — plugins call `addNode()`/`addEdge()` one-at-a-time in loops instead of batching. GraphBuilder (which already batches) takes 1.3s for 12K nodes. All other plugins take 84.8s for the rest.

**The fix is trivial:** buffer nodes/edges, flush once per plugin. No language change needed for 10-17x speedup.

**Long-term:** Rust migration still justified for token economy (58% less code = 2x more context for AI agents) and eventual IPC elimination via in-process graph.

## Profiling Data (Jammers, 153 files)

```
Total analysis time: 101.8s

ANALYSIS phase:          87.7s (86%)
  JSASTAnalyzer:          2.9s (3.3% of ANALYSIS)
    babel_parse:          0.13s
    traverse_*:           1.4s
    graph_build:          1.3s
  Other plugins (IPC):   84.8s (96.7% of ANALYSIS)

VALIDATION:               9.9s (10%)
ENRICHMENT:               3.6s (3.5%)
INDEXING:                 0.5s
DISCOVERY:                0.006s
```

## What We Learned

### Babel parsing is NOT the bottleneck

134ms to parse 86 files. Switching to Swc (Rust) saves ~100ms. Irrelevant.

### IPC is THE bottleneck

Each graph operation (addNode, addEdge, queryNodes, getOutgoingEdges) goes through:
1. `JSON.stringify()` in TypeScript
2. Write to unix socket
3. Read + parse in Rust RFDB
4. Execute operation
5. Serialize response
6. Write back to socket
7. `JSON.parse()` in TypeScript

Cost: ~0.5-2ms per call. With 47K+ operations: **23-94 seconds just in IPC**.

### Token economy matters

With AI agents writing/reading all code, fewer lines = fewer tokens = more work per subscription dollar.

| | TypeScript | Rust | Savings |
|--|-----------|------|---------|
| ExpressionNode | 233 LOC | 98 LOC | -58% |
| Projected core | 48K LOC | ~20K LOC | -58% |
| Tokens to read core | ~80K | ~35K | -56% |

### Code expressiveness is real but secondary

Rust ADTs eliminate "optional field soup" — you can't create a `MemberExpression` with an `operator` field. Compile-time safety catches errors that TypeScript allows silently. But AI agents rarely make these mistakes, so the benefit is mostly in code size (= tokens).

## Architecture: Before and After

### Current (IPC bottleneck)

```
TypeScript Core                    Rust RFDB Server
     |                                   |
     |  createNode({...})                |
     |  ───JSON.stringify────────────►   |
     |  ───unix socket write─────────►   |
     |                                   |  parse JSON
     |                                   |  insert node
     |                                   |  serialize response
     |  ◄───unix socket read─────────   |
     |  ◄───JSON.parse───────────────   |
     |                                   |
     |  (repeat ~47,000 times)           |
     |                                   |
     |  Total IPC overhead: 50-80s       |
```

### Target (in-memory, no IPC)

```
Rust Core (single process)
     |
     |  graph.create_node(node)     // ~100ns, no serialization
     |  graph.create_edge(edge)     // ~100ns, direct memory access
     |
     |  (47,000 operations)
     |
     |  Total: ~5ms
     |
├── Analysis Engine (Rust)
├── Graph Storage (Rust, ex-RFDB)
├── Enrichment (Rust)
└── WASM/FFI boundary
         |
    TypeScript (CLI, MCP, plugins)
```

**Expected speedup on ANALYSIS phase: 10-50x** (87s → 2-9s)

## Language Comparison

| | TypeScript | Rust | OCaml |
|--|-----------|------|-------|
| Code reduction | baseline | -58% | -63% |
| Performance | 1x | 10-50x | 5-20x |
| WASM maturity | N/A | Excellent | Good |
| AI code gen quality | Excellent | Good | Poor |
| Existing code in project | 48K LOC | 14.5K LOC (RFDB) | 0 |

**Why Rust over OCaml:** RFDB is already Rust (14.5K LOC). One language for the entire core. Better WASM ecosystem. Better AI code generation.

**Why not Haskell/Scala/others:** Lazy evaluation (Haskell) is unpredictable for memory. JVM languages (Scala, Kotlin) add ~100MB runtime. None have production WASM story. See `_tasks/REG-124/002-don-language-research.md` for full analysis.

## Migration Map

| Component | Current LOC | Decision | Rust LOC est. |
|-----------|-------------|----------|---------------|
| Node factories | 4,052 | → Rust | 1,200-1,600 |
| AST Visitors | 3,825 | → Rust + Swc | 1,800-2,200 |
| Graph builders | ~2,000 | → Rust | 800-1,000 |
| Enrichers | ~3,500 | → Rust | 1,200-1,500 |
| Orchestrator | 928 | → Rust | 400-600 |
| Plugin system | ~5,000 | Stays TS | — |
| CLI | 6,886 | Stays TS | — |
| MCP Server | 3,340 | Stays TS | — |
| Types boundary | 1,269 | Stays TS | — |
| RFDB Server | 14,516 | Already Rust | — |

## Next Steps

### Step 1: Batch IPC calls (REG-388 — highest ROI, trivial fix)

35 files, 112 call sites use singular `addNode()`/`addEdge()` in loops.
GraphBuilder already demonstrates the pattern — other plugins just need to follow it.

```typescript
// Before: N+1 IPC calls
for (const endpoint of endpoints) {
  await graph.addNode(endpoint);   // IPC call #1
  await graph.addEdge({ ... });    // IPC call #2
}

// After: 2 IPC calls total
const nodes = [], edges = [];
for (const endpoint of endpoints) {
  nodes.push(endpoint);
  edges.push({ ... });
}
await graph.addNodes(nodes);
await graph.addEdges(edges);
```

Expected: ANALYSIS 87s → 5-10s. No architecture changes.

### Step 2: Incremental Rust migration (long-term, for token economy)

After batching proves the IPC hypothesis:
1. Move node type definitions to Rust ADTs (58% less code = fewer tokens)
2. Move AST analysis to Rust + Swc
3. Move enrichers to Rust
4. Keep CLI/MCP/plugins in TypeScript

Note: napi-rs was rejected because it blocks parallel analysis.
Future in-process approach would need to preserve multi-worker architecture.

### Step 3: Evaluate results

After Step 1, re-profile. If analysis drops to <10s, Step 2 becomes about token economy, not performance.

## Research Artifacts

| File | Content |
|------|---------|
| `_tasks/REG-124/001-user-request.md` | Original task description |
| `_tasks/REG-124/002-don-language-research.md` | Language candidate analysis, prior art |
| `_tasks/REG-124/003-codebase-migration-map.md` | Detailed codebase analysis |
| `_tasks/REG-124/004-benchmark-expression-node.md` | Rust/OCaml code comparison |
| `_tasks/REG-124/005-final-recommendation.md` | Initial recommendation (pre-profiling) |
| `_tasks/REG-124/006-profiling-results.md` | Jammers profiling data |
