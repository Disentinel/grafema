# Core-v3 Plan: MLA Findings

**Date:** 2026-03-04
**Source:** Multi-Lens Analysis (Semantic, Contractual, Operational, Risk, Temporal)

## S1: Resolution key (file, name) теряет scope [CRITICAL → RESOLVED]

**Problem:** Plan shows `declarations.get(&(uref.file, uref.name))` for scope resolution in Rust orchestrator. Wrong — scope resolution is language-specific, belongs in Haskell.

**Root cause of the mistake:** Plan forgot that core-v2 always had TWO resolution phases:
1. **postFile** (`resolveFileRefs`) — intra-file scope walk, per-file, language-specific
2. **postProject** (`resolveProject`) — cross-file import/export matching, language-agnostic

Scope resolution was ALWAYS a per-file operation. It was never in the orchestrator.

**Fix:** Haskell binary does intra-file scope resolution as a post-pass within Phase 1. The scope chain is already in memory — no need to serialize it, read it back, or rebuild it.

```haskell
-- Main.hs analysis flow:
1. walkNode ast          → nodes, edges, unresolvedRefs (existing)
2. resolveFileRefs refs rootScope → resolved edges + cross-file-only refs (NEW)
```

```haskell
resolveFileRefs :: [DeferredRef] -> Scope -> ([Edge], [DeferredRef])
resolveFileRefs refs rootScope = partitionEithers $ map resolve refs
  where
    resolve ref = case lookupScopeChain (drName ref) (drScopeId ref) rootScope of
      Just declId -> Left (Edge (drFromNodeId ref) (drEdgeType ref) declId)
      Nothing     -> Right ref  -- cross-file only, pass to orchestrator
```

**Prerequisite:** Populate `drScopeId` (currently always `Nothing`):
```haskell
-- In ruleIdentifier, ruleThisExpression, etc.:
scopeId <- askScopeId
...
drScopeId = Just scopeId
```

**Output changes:** FileAnalysis JSON now includes resolved intra-file edges. `unresolvedRefs` contains ONLY cross-file refs (~10-15K instead of 51K).

**Impact on Rust orchestrator:** Phase 2 only does language-agnostic import→export matching. No scope logic, no language semantics. Back to ~300 LOC estimate.

**Phase 1 (postFile):** Haskell resolves intra-file scope refs. All unresolvedRefs consumed internally. Unresolved identifiers → REFERENCE nodes with `resolved: false`. IMPORT_BINDING nodes emitted for imports.

**unresolvedRefs eliminated from external interfaces.** They're an internal concept of the per-file analyzer — created during AST walk, consumed during postFile scope resolve, never serialized to FactStore or orchestrator.

**Cross-file resolution = post-analysis plugin** (same mechanism as enrichers):
- `js-import-resolution`: queries IMPORT_BINDING nodes, matches to exports in target modules
- `runtime-globals`: queries unresolved REFERENCE nodes, matches to runtime definitions
- `library-defs`: queries 3rd-party IMPORT_BINDINGs, matches to LibraryDef stubs
- Each language provides its own resolution plugins (ESM/CJS for JS, __init__.py for Python, classpath for Java)

**No separate "resolution phase".** All post-analysis work (resolution, enrichment, validation) uses the unified plugin mechanism with DAG ordering. Resolution plugins simply have no `depends_on` (run first). Enrichers depend on resolution. Validation depends on everything.

```yaml
plugins:
  - name: "js-import-resolution"
    command: "grafema-core-v3 resolve-imports"
    query: { type: "IMPORT_BINDING" }
    depends_on: []

  - name: "runtime-globals"
    query:
      datalog: "match(X) :- node(X, \"REFERENCE\"), attr(X, \"resolved\", \"false\")."
    depends_on: []

  - name: "express-routes"
    depends_on: ["js-import-resolution"]
```

**Orchestrator is fully language-agnostic.** Knows nothing about imports, exports, scopes, or any language semantics. Just runs plugins per DAG.

**Status:** RESOLVED. Plan update needed:
- Remove Phase 2 (Rust resolution) entirely
- Remove unresolvedRefs from FactStore / orchestrator
- Unify resolution + enrichment into single plugin phase with DAG ordering

---

## S2: Enricher query не выражает multi-hop контекст [MEDIUM]

**Problem:** Streaming enricher query spec supports flat filters + 1-hop edges. But some enrichers need deeper context (e.g., "CALL where receiver's type is ExpressApp" = 2+ hops).

**User suggestion:** Enricher emits a Datalog query to orchestrator at startup.

**Proposed fix:** Enricher protocol gets a `query_phase`:

```yaml
enrichment:
  - name: "express-routes"
    command: "grafema-core-v3 enrich express"
    mode: streaming
    query:
      # Option A: simple spec (current)
      type: "CALL"
      metadata: { method: ["get","post","put","delete"] }
      include_edges: ["READS_FROM"]

      # Option B: Datalog query (new)
      # Enricher can specify a Datalog query instead of flat spec.
      # Orchestrator runs it against existing top-down evaluator,
      # streams matching nodes to enricher.
      datalog: |
        match(CallId) :-
          node(CallId, "CALL"),
          attr(CallId, "method", Method),
          edge(CallId, ReceiverId, "READS_FROM"),
          node(ReceiverId, "VARIABLE"),
          attr(ReceiverId, "resolvedType", "ExpressApp").
```

**Trade-off:** Datalog queries use the EXISTING top-down evaluator (no changes to RFDB). The orchestrator runs the query, collects matching node IDs, then streams those nodes + their edges to the enricher. Enricher stays stateless.

**Alternative:** Enricher declares needed context depth. `include_edges_depth: 2` means orchestrator includes 2-hop neighborhood for each matching node. Simpler but less precise.

**Status:** Both options viable. Datalog query is more powerful but requires enricher authors to know Datalog. Context depth is simpler. Can support both — default to flat spec, allow Datalog override.

---

## S3: Enrichment = separate binary [MEDIUM]

**Problem:** Current Haskell binary processes ASTNode (OXC JSON). Enrich mode would process GraphNode — completely different ADT. Mixing two modes in one binary creates coupling.

**Decision (per user):** Enrichment is a **separate binary** (`grafema-enrich`) with its own:
- Input types (GraphNode JSON, not ASTNode)
- Module structure (per-library enricher modules)
- Build pipeline (separate cabal package)

**Architecture:**
```
packages/
  core-v3/          # Per-file AST → graph (existing)
    src/
      AST/Types.hs  # ASTNode ADT (OXC ESTree)
      Rules/         # Per-AST-node rules
      Analysis/      # Walker, Context, SemanticId

  enrichers/         # Graph → enriched graph (NEW)
    src/
      Graph/Types.hs # GraphNode ADT (from GraphStore JSON)
      Enrichers/     # Per-library enricher modules
        Express.hs
        React.hs
        TypePropagation.hs
      Protocol.hs    # Streaming JSON lines protocol
```

Per-language analyzers will also be separate binaries:
```
grafema-core-v3          # JS/TS analyzer (Haskell)
grafema-java             # Java analyzer (Haskell, future)
grafema-enrich           # Enrichment (Haskell)
grafema-enrich-django    # Django enrichment (Python, future)
```

**Shared code:** SemanticId, basic types (MetaValue, etc.) → extracted to a shared Haskell library package (`grafema-common`).

**Status:** Record in plan. Does not block current work — enrichment binary is Phase 3, we're building Phase 2 first.

---

## S4: SemanticID stability при enrichment [LOW]

**User question:** "В каких случаях query spec меняется?"

**Answer:** Query spec changes when you update the enricher config:
- Add a metadata filter: `metadata: { method: ["get","post"] }` → `{ method: ["get","post","put","delete"] }`
- Change include_edges: add `["READS_FROM", "ASSIGNED_FROM"]`
- Switch from flat spec to Datalog query

This is a **deployment/versioning** event, not runtime.

**Fix:** SemanticID for enricher-created nodes depends on:
- Enricher name (stable)
- Input node ID (stable — determined by source code, not query)
- NOT the query spec (how you find nodes ≠ how you name them)

```
ROUTE node ID = semanticId(file, "ROUTE", path, parent=enricher_name, hash=hash(input_call_id))
```

If query spec changes, the enricher finds MORE or FEWER nodes, but the ID formula for each found node stays the same. Generation GC handles nodes that are no longer found (not re-created → deleted).

**Status:** Convention, not code. Document in enricher author guide.

---

## C1: Нет валидации enricher output [MEDIUM]

**Problem:** Enricher emits `emit_node`, `emit_edge`. No validation before writing to GraphStore. Buggy enricher → dangling edges, invalid types.

**Fix:** Orchestrator validates before writing:

```rust
for line in enricher_stdout {
    match line {
        EmitNode(node) => {
            validate_node_type(&node.type, &allowed_types)?;
            validate_required_fields(&node)?;
            buffer.push(node);
        }
        EmitEdge(edge) => {
            // Edge target must exist in GraphStore OR in this enricher's buffered nodes
            validate_edge_target(&edge, &graph, &buffer)?;
            buffer.push(edge);
        }
    }
}
// All valid → write to GraphStore
graph.batch_write(buffer);
```

**For batch mode:** Can't validate in orchestrator (plugin writes directly). Options:
- Post-write validation (Phase 4 catches issues)
- RFDB-level constraints (reject edges to non-existent nodes)
- Scoped write permissions (future)

**Status:** Implement for streaming mode. Accept risk for batch mode, rely on Phase 4 validation.

---

## C2: Нет идемпотентности при retry [MEDIUM]

**Problem:** Enricher crashes mid-stream → retry → duplicate nodes if IDs are non-deterministic.

**Fix:** Two mechanisms:

1. **SemanticID = deterministic by construction.** If enricher uses `hash(enricher_name, input_node_id)` for all created nodes, retry produces identical IDs → upsert, no duplicates.

2. **Orchestrator clears enricher's output before retry:**
   ```rust
   // Before retry:
   graph.delete_nodes_where(source_enricher == "express-routes", generation == current_gen);
   // Then re-run enricher from scratch
   ```

**Requirement for enrichers:** All created nodes MUST have deterministic IDs derived from input data. Document this in enricher author guide.

**Status:** Convention + orchestrator retry logic. Not a plan change — implementation detail.

---

## C3: Batch mode без sandbox [HIGH]

**Problem:** Batch enricher gets full RFDB socket. Can write anything, delete anything.

**Options:**

A. **Accept the risk.** Batch mode is for trusted plugins (internal, reviewed). External/untrusted plugins → streaming mode only.

B. **RFDB write scoping.** New RFDB feature: create a scoped session that can only write nodes/edges with `source = "enricher-name"`. Reads unrestricted. Requires RFDB changes.

C. **Separate database per enricher.** Each batch enricher writes to its own RFDB database. Orchestrator merges results. Complex, probably overkill.

**Recommendation:** Option A for now. Batch mode = trusted code only. Document clearly. If abuse becomes a real problem, implement Option B.

**Status:** Document policy. No code changes needed now.

---

## O1: Streaming enricher crash → partial writes [HIGH]

**Problem:** Enricher processes 500/1000 nodes, crashes. 500 results already written → inconsistent graph.

**Fix:** Buffer all enricher output, write only on successful completion:

```rust
let mut buffer = Vec::new();
for line in enricher_stdout {
    buffer.push(parse_emit(line)?);
}
// enricher exited with code 0?
if enricher.wait()?.success() {
    graph.batch_write(buffer);  // atomic
} else {
    log::warn!("enricher {} failed, discarding {} results", name, buffer.len());
    // no writes, graph unchanged
}
```

**Trade-off:** Buffering all output in memory. For enrichers processing <10% of graph (~10K nodes), buffer is ~5-10MB. Acceptable.

For very large enrichers (CallGraphBuilder, ~30K nodes): could buffer to temp file instead of memory.

**Status:** NEEDS FIX in plan. Buffered writes with atomic commit on success.

---

## O2: Re-export cycle → infinite loop [CRITICAL]

**Problem:** Re-export chains can be cyclic: A re-exports from B, B re-exports from A. Any resolver that follows re-exports must handle this.

**Fix:** Now in Haskell `js-import-resolution` plugin (not Rust). Standard visited set + iteration limit:

```haskell
resolveReexports :: ExportIndex -> Set (ModuleId, Name) -> [ImportBinding] -> [Edge]
resolveReexports idx visited [] = []
resolveReexports idx visited (ib:ibs)
  | (ibSource ib, ibName ib) `Set.member` visited = resolveReexports idx visited ibs  -- cycle, skip
  | otherwise = case Map.lookup (ibSource ib, ibName ib) idx of
      Just (Reexport target) ->
        let visited' = Set.insert (ibSource ib, ibName ib) visited
        in resolveReexports idx visited' (followReexport target : ibs)
      Just (Direct nodeId) -> Edge (ibId ib) "RESOLVES_TO" nodeId : resolveReexports idx visited ibs
      Nothing -> resolveReexports idx visited ibs  -- unresolvable
```

Plus iteration limit as safety net (max 100 depth — real re-export chains are <10).

**Status:** NEEDS IMPLEMENTATION in js-import-resolution plugin. Trivial but must be explicit.

---

## O3: FactStore lifecycle [MEDIUM]

**Problem:** SQLite database — per-run or persistent? Old facts from deleted files?

**Fix:** FactStore is **per-generation, persistent.**

```
.grafema/
  graph.db          # GraphStore (existing)
  facts.sqlite      # FactStore (new)
```

Lifecycle:
1. Analysis starts → bump generation
2. Phase 1: INSERT new facts with `generation = current_gen`
3. Phase 2: read facts, create edges
4. After all phases: DELETE FROM unresolved_ref WHERE generation < current_gen

Same generation GC as GraphStore. Persistent between runs for incremental analysis. Stale facts cleaned by generation.

**Status:** Record in plan. Straightforward.

---

## O4: Phase 1 timeout policy [MEDIUM]

**Problem:** Huge file (generated JS, 100K lines) hangs Phase 1. All of Phase 2 waits.

**Fix:**
- Per-file timeout: configurable, default 30s
- On timeout: skip file, create ISSUE node ("analysis_timeout", file, reason)
- Phase 2 proceeds with available data
- Timeout files logged prominently

```yaml
analysis:
  timeout_per_file: 30s  # default
  plugins:
    - pattern: "*.{js,jsx,ts,tsx}"
      command: "grafema-core-v3 analyze"
      timeout: 60s  # override for specific plugin
```

**Status:** Record in plan. Implementation detail for orchestrator.

---

## R1: Resolution complexity underestimated [CRITICAL → ELIMINATED]

**Original problem:** Plan says "300-500 LOC" for Rust resolver.

**Resolution:** Resolution code removed from Rust orchestrator entirely. Orchestrator is language-agnostic.

- postFile scope resolve: ~200 LOC Haskell (internal to per-file analyzer)
- Cross-file resolution: Haskell plugin (~500-800 LOC), same mechanism as enrichers
- Rust orchestrator: 0 LOC resolution. Runs plugins per DAG.

**Status:** ELIMINATED. Not a risk — the concept that caused it no longer exists.

---

## R2: Sync barriers between processes [MEDIUM]

**Problem:** Orchestrator writes to RFDB, then starts enricher. Is the write flushed?

**Fix:** RFDB client protocol already has request/response semantics. `write_nodes()` returns success after data is committed. Orchestrator waits for response before proceeding.

```rust
// Orchestrator
graph.batch_write(nodes)?;   // blocks until RFDB confirms write
graph.batch_write(edges)?;   // blocks until RFDB confirms write
// NOW start enricher — data is guaranteed visible
start_enricher("express-routes")?;
```

If RFDB uses write-behind buffering internally, it must flush before confirming the write response.

**Status:** Not a plan issue — RFDB protocol already handles this. Verify during implementation that write responses are post-flush.

---

## R3: Нет attribution для enricher facts [MEDIUM]

**Problem:** After enrichment, can't tell which enricher created which node/edge.

**Fix:** Orchestrator stamps all enricher output with `source` metadata:

```rust
for emit in enricher_output {
    match emit {
        EmitNode(mut node) => {
            node.metadata.insert("_source", enricher_name);
            node.metadata.insert("_generation", current_gen);
            buffer.push(node);
        }
        EmitEdge(mut edge) => {
            edge.metadata.insert("_source", enricher_name);
            buffer.push(edge);
        }
    }
}
```

`_source` prefix = system metadata, not user-visible. Enables:
- `grafema query 'node(X, "ROUTE"), attr(X, "_source", "express-routes")'`
- Selective enricher re-run: delete all nodes/edges where `_source = "express-routes"`, re-run
- Debugging: "this edge is wrong" → `_source` tells you which enricher

**Status:** Record in plan. Simple, high value.

---

## T1: Data dependencies при incremental re-run [MEDIUM]

**Problem:** Enricher A creates HAS_TYPE edges. Enricher B reads HAS_TYPE. A's output changes → B needs re-run but isn't triggered.

**Fix options:**

A. **Conservative: re-run all enrichers on any change.** Simple, correct, potentially slow.

B. **Track read/write sets.** Each enricher declares what edge/node types it reads and writes. If enricher A's output types overlap with enricher B's input types → B must re-run when A changes.

```yaml
enrichment:
  - name: "type-propagation"
    writes: ["HAS_TYPE"]         # creates these edge types
    depends_on: ["resolution"]
  - name: "typed-routes"
    reads: ["HAS_TYPE", "CALL"]  # needs these to exist
    depends_on: ["type-propagation"]  # explicit, but also auto-inferred from reads/writes
```

C. **Generation GC handles correctness.** Even if B doesn't re-run, its output from the previous generation is still valid IF the graph it read hasn't changed. If A's output changed, B's nodes may reference stale data — but they're still structurally valid. Only semantically stale.

**Recommendation:** Start with A (re-run all). Optimize to B when we have enough enrichers that it matters (>10 enrichers, >5 min total enrichment time).

**Status:** Record in plan. Start conservative.

---

## T2: Parallel enricher writes — race condition [LOW]

**Problem:** Two enrichers write to GraphStore in parallel. Enricher X creates node, enricher Y creates edge to that node. If Y writes before X → dangling edge.

**Analysis:** This can only happen if Y depends on X's output — which means `depends_on` should prevent parallel execution. If they're truly independent (no depends_on), they shouldn't reference each other's nodes.

**Edge case:** Both enrichers create edges to PRE-EXISTING nodes (from Phase 1/2). This is safe — nodes already exist, multiple enrichers adding edges to them is fine.

**Fix:** Not needed if `depends_on` is correctly declared. Add validation in Phase 4 as safety net.

**Status:** No action needed. depends_on handles this.

---

## Summary

| # | Severity | Action needed |
|---|----------|---------------|
| S1 | ~~CRITICAL~~ RESOLVED | Scope resolve = Haskell postFile. unresolvedRefs internal only. Cross-file = plugin. |
| R1 | ~~CRITICAL~~ ELIMINATED | No resolution in Rust. Orchestrator fully language-agnostic. |
| O2 | CRITICAL | Visited set + iteration limit in js-import-resolution plugin |
| O1 | HIGH | Buffer plugin output, atomic write on success |
| C3 | HIGH | Document batch=trusted only policy |
| S2 | MEDIUM | Support Datalog query in plugin spec (uses existing evaluator) |
| S3 | MEDIUM | Enrichment = separate Haskell binary |
| C1 | MEDIUM | Validate streaming plugin output before writing |
| C2 | MEDIUM | Require deterministic SemanticIDs from plugins |
| O3 | MEDIUM | FactStore lifecycle = per-generation, persistent, GC'd (no longer for unresolvedRefs) |
| O4 | MEDIUM | Per-file timeout with skip + ISSUE node |
| R2 | MEDIUM | Verify RFDB write response = post-flush |
| R3 | MEDIUM | Add _source metadata to plugin output |
| T1 | MEDIUM | Start with re-run-all, optimize later |
| S4 | LOW | SemanticID depends on plugin+input, not query spec |
| T2 | LOW | No action — depends_on handles this |

**Remaining CRITICAL:** O2 (re-export cycle detection in Haskell plugin). All others MEDIUM or below.

**Key architectural changes from MLA:**
1. **unresolvedRefs eliminated** from external interfaces — internal to per-file analyzer
2. **No resolution in Rust** — orchestrator is fully language-agnostic
3. **Unified plugin phase** — resolution, enrichment, validation all use same DAG mechanism
4. **REFERENCE nodes with resolved:false** replace unresolvedRefs as the cross-file handoff
