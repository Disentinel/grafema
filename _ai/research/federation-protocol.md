# RFDB Federation Protocol

> Reshetnikov's Federative Database — decentralized federated knowledge graph protocol.
> Design session: 2026-03-17

## Core Thesis

Within a shard — analysis-time resolution (full materialized graph).
Between shards — execution-time resolution (lazy, on-demand, only if needed).

RFDB is not just a code graph database. Once federation works, it becomes a **general-purpose decentralized federative knowledge database**. Code is the first domain; the mechanism is domain-agnostic.

## Architecture

```
┌─────────────────────────────────────────────────┐
│  Browser worker / CLI / MCP                      │
│  ┌───────────────────────────────────────────┐  │
│  │         Query Router                       │  │
│  │   file path → shard → WS connection        │  │
│  └──────┬──────────┬──────────────┬──────────┘  │
│         │          │              │              │
│    ┌────▼───┐ ┌────▼───┐    ┌────▼───┐         │
│    │ Shard A │ │ Shard B │    │ Shard C │         │
│    │ (local) │ │ (local) │    │ (remote)│         │
│    └────────┘ └────────┘    └────────┘         │
└─────────────────────────────────────────────────┘
```

Local = remote = WebSocket. Difference is only the address: `ws://localhost:${port}` vs `ws://team-b.company.com:${port}`.

### Key Design Decisions

1. **No phantom nodes, no federation.yaml, no pre-configured shards.** Edges store absolute file paths in target semantic IDs. Dangling edge = target not in local graph. Router discovers shards at query time.

2. **Auto-discovery, zero-config.** Each rfdb-server registers itself at startup. Discovery is by file path prefix matching. Shards find each other automatically.

3. **SUBGRAPH as single federation primitive.** One command covers all federation query patterns.

4. **Honest gaps.** If target shard unavailable → ISSUE node (explicit gap). Optionally fall back to manifest (lightweight export surface). Never pretend the graph is complete when it isn't.

5. **Datalog stays local.** No distributed Datalog. Cross-shard queries are either scatter-gather or traversal-with-frontier, driven by the TypeScript query router.

## Auto-Discovery Protocol

Each rfdb-server knows its `root` — absolute path of the analysis root. This is its "territory".

```
Shard A:  /repo/packages/frontend/*
Shard B:  /repo/packages/api/*
Shard C:  /repo/packages/shared/*

Edge in Shard A:  IMPORTS_FROM → target file: /repo/packages/api/src/client.ts
                                               ^^^^^^^^^^^^^^^^^^^^
                                               This is Shard B's territory
```

### Registration

rfdb-server at startup writes:
```json
// /tmp/rfdb-shards/{hash}.json
{
  "port": 9201,
  "root": "/repo/packages/api",
  "socket": "/tmp/rfdb-api.sock",
  "pid": 12345,
  "started": "2026-03-17T10:00:00Z"
}
```

At shutdown — removes the file. Stale files detected by PID check or TTL.

For remote shards: same concept, different registry (DNS-SD, HTTP endpoint, etc.).

### Validation

```
WHO_ARE_YOU
→ { root: "/repo/packages/api", files: 342, nodes: 12847,
    analyzer_version: "0.3.16", analyzed_at: "2026-03-17T09:55:00Z" }
```

Confirms the shard actually covers the expected path and reports freshness.

## RFDB Protocol Extension

### SUBGRAPH Command

Single federation primitive:

```
SUBGRAPH
  entries: string[]          # entry point semantic IDs
  direction: forward|backward|both
  edge_types?: string[]      # filter: only CALLS, only DATAFLOW, etc.
  max_depth: number

→ {
    nodes: Node[],
    edges: Edge[],
    frontier: DanglingEdge[]   # exits beyond this shard's territory
  }
```

Covers all patterns:
- **trace_dataflow** → `SUBGRAPH entries=[x] direction=forward edge_types=[ASSIGNS_TO,PASSES_ARGUMENT,RETURNS]`
- **find_calls fan-in** → `SUBGRAPH entries=[matched_functions] direction=backward edge_types=[CALLS]`
- **get_context** → `SUBGRAPH entries=[x] direction=both max_depth=1`

### Frontier

The key abstraction. When traversal hits a dangling edge (target node not in local store), instead of silently stopping, return it as frontier:

```json
{
  "edgeType": "IMPORTS_FROM",
  "sourceId": "frontend/src/app.ts->apiClient",
  "targetId": "api/src/client.ts->FUNCTION->post",
  "targetFile": "/repo/packages/api/src/client.ts"
}
```

Router uses `targetFile` for shard discovery.

## Query Patterns

### 1. Traversal with Frontier (trace_dataflow, trace_alias)

```
federatedTrace(start, direction, maxDepth):

  1. Shard A — local Datalog trace to boundary
     chain=[userInput → validate → apiClient.post]
     frontier=[{target: "/repo/api/src/client.ts->post"}]

  2. Router groups frontier by target shard
     Shard B: [post]

  3. Shard B — SUBGRAPH from grouped entry points
     (shared visited set — fan-in handled: post and get converge)
     chain=[post → httpClient.request → db.query]
     frontier=[{target: "/repo/db/src/pool.ts->query"}]

  4. Stitch + recurse if new frontier and depth remaining
```

**Critical**: Router maintains **global visited set** across all hops to prevent cycles.

### 2. Scatter-Gather (find_nodes, find_calls, query_graph)

```
federatedSearch(query):

  1. Broadcast query to all known shards (parallel)
  2. Each shard executes locally, returns results
  3. Router merges results
  4. Non-monotonic results marked confidence: "partial"
```

Optimization: use manifests for pre-filtering. If `find_nodes(name="redis")`, check manifests first — only query shards whose manifest mentions "redis".

### 3. Point Lookup (get_context, get_node)

```
federatedLookup(semanticId):

  1. Extract file path from semantic ID
  2. Discover shard by path prefix
  3. Route to single shard
```

## Theoretical Foundations

### CALM Theorem (Hellerstein, 2019)

> A program has a consistent, coordination-free distributed implementation iff it is expressible in monotonic Datalog.

**Implications for us:**
- Monotonic queries (find, trace, reachability) → coordination-free → safe for federation
- Non-monotonic queries (negation: "find dead code", aggregation: "count all nodes") → require ALL shards → must be marked as partial if not all available

### Link Traversal Query Processing (Verborgh et al., ISWC 2023)

LTQP from Solid ecosystem is the closest academic analog to our model:
- Many small sources, unknown before query time
- Discovery during traversal (follow links)
- Same problems: termination (cycles), completeness (which links to follow)

**Reference**: [Link Traversal Query Processing Over Decentralized Environments with Structural Assumptions](https://link.springer.com/chapter/10.1007/978-3-031-47240-4_1)

### FedUP (ACM Web Conference 2024)

Source selection is THE bottleneck in SPARQL federation — finding which endpoints to contact. FedUP solves via "quotient summaries". Our manifests serve the same role.

**Reference**: [FedUP: Querying Large-Scale Federations of SPARQL Endpoints](https://dl.acm.org/doi/10.1145/3589334.3645704)

### Dedalus: Time as First-Class Concern

> "Distributed programming is about time, not about space." (Alvaro et al., Berkeley, 2009)

Version skew between shards is a temporal problem. Shard A analyzed yesterday, Shard B today. Manifest timestamps + checksums make staleness explicit.

**Reference**: [Dedalus: Datalog in Time and Space](https://www2.eecs.berkeley.edu/Pubs/TechRpts/2009/EECS-2009-173.pdf)

## Known Flaws & Mitigations

### HIGH severity

| Flaw | Description | Mitigation |
|------|-------------|------------|
| Non-monotonic queries | Negation/aggregation across shards gives wrong results | Mark as `confidence: "partial"`, require all shards for complete answer |
| Fan-out explosion | O(shards^depth) pathological traversal | Cost budget, bloom filter on visited, per-shard depth limit |

### MEDIUM severity

| Flaw | Description | Mitigation |
|------|-------------|------------|
| Cycle termination | Circular imports between shards | Global visited set in router |
| Reachability criteria | Which edge types to follow cross-shard? | Explicit whitelist of federation-eligible edges |
| Source selection for broadcast | find_nodes without file filter → N connections | Manifest pre-filtering |
| Version skew | Stale analysis in one shard | Manifest timestamp + checksum, staleness warnings |

## Federation is OPT-IN

**Critical**: Federation mode must be **explicitly enabled**. Default behavior is unchanged — single RFDB server, no discovery, no cross-shard queries.

**Why**: Multiple worktrees / CI jobs / dev environments routinely run `grafema analyze` on the same repo simultaneously. Auto-registering in `/tmp/rfdb-shards/` by default would cause conflicts — overlapping territories, stale registrations from parallel workers, cross-contamination between branches.

**Activation**:
- `rfdb-server --federate` flag enables shard registration and discovery
- Without `--federate`, server works exactly as today — isolated, no side effects
- Config option in `.grafema/config.yaml`: `federation: { enabled: true }`
- MCP/CLI: `grafema analyze --federate` to analyze + register shard

**Worktree safety**: Without `--federate`, worktree-1 through worktree-8 can all run independently on the same codebase without interference, as they do today.

## Invariants

```
INV-0: Federation is opt-in. Default mode = isolated single server, zero side effects.
INV-1: Semantic ID contains absolute file path (discovery depends on it)
INV-2: One file path belongs to exactly one shard (no overlapping territories)
INV-3: Router visited set is global across all hops (termination guarantee)
INV-4: Federation-eligible edge types are an explicit whitelist (completeness)
INV-5: Non-monotonic cross-shard results are marked confidence: partial
INV-6: Cost budget on traversal (fan-out protection)
```

## Why This Differs from Semantic Web

| Semantic Web | RFDB Federation |
|---|---|
| Started with abstraction ("all knowledge") | Starts with concrete domain (code) |
| Requires ontology alignment | Each shard sovereign, frontier = honest gap |
| Manual endpoint configuration | Auto-discovery, zero-config |
| SPARQL — complex, slow | Datalog — simple, bounded |
| "Must work perfectly" | Graceful degradation (manifest fallback → ISSUE node) |

## Use Cases Beyond Code

The federation mechanism is domain-agnostic. Same protocol works for:

1. **npm/package ecosystem** — pre-built graphs on CDN, zero-install deep analysis
2. **Microservices** — each team's service = shard, cross-service impact analysis
3. **Distributed tracing** — spans as nodes, causal links as edges, services as shards
4. **SBOM** — each package has its own dependency subgraph, federated vulnerability traversal
5. **Multi-language migration** — PHP monolith + Node microservices, different analyzers, same query layer
6. **Browser exploration** — thin worker routing queries to online RFDB servers

## Implementation Phases

### Phase 1: Shard Announcement (Rust, rfdb-server)

- rfdb-server writes JSON to `/tmp/rfdb-shards/` at startup, removes at shutdown
- New protocol message: `WHO_ARE_YOU` → returns root, file count, node count, timestamps
- PID-based stale detection for crashed servers

### Phase 2: SUBGRAPH Command (Rust, rfdb-server)

- New protocol message: `SUBGRAPH` with entries, direction, edge_types, max_depth
- Returns nodes + edges + frontier (dangling edges)
- Modify existing traversal to collect frontier instead of silently stopping

### Phase 3: Query Router (TypeScript, packages/util)

- `ShardDiscovery` — scan `/tmp/rfdb-shards/`, resolve file path → shard
- `FederatedTracer` — iterative traversal with global visited set, cost budget
- `FederatedSearch` — scatter-gather with manifest pre-filtering
- Integration with existing query layer (trace_dataflow, find_calls, etc.)

### Phase 4: Manifest as Fallback

- When shard unavailable, ManifestResolver provides export surface
- Frontier entries annotated: `resolved: "manifest"` vs `resolved: "full_graph"`
- ISSUE nodes created for completely unresolvable references

### Phase 5: Remote Shards

- WS connection to remote rfdb-servers (same protocol, different address)
- Remote shard registry (beyond /tmp/ — HTTP/DNS-SD based)
- Authentication & access control layer
