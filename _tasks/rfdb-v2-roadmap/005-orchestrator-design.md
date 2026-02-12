# Track 2: Orchestrator v2 Design

> Date: 2026-02-11
> Input: 004-expert-concerns.md (resolved), 002-roadmap.md (updated), current orchestrator exploration
> Status: DRAFT — requires expert review + user approval

---

## 1. Current State (As-Is)

### Architecture

**File:** `packages/core/src/Orchestrator.ts` (1248 LOC)

Sequential 5-phase pipeline:
```
DISCOVERY → INDEXING → ANALYSIS → ENRICHMENT → VALIDATION
```

- Phases execute sequentially, plugins within phase topologically sorted (Kahn's algorithm)
- INDEXING + ANALYSIS run per-service-unit in batches (parallel within batch)
- ENRICHMENT + VALIDATION run globally (single pass over entire graph)
- 14 enrichers, each calls `graph.addEdge()` directly
- `IncrementalReanalyzer.ts` (196 LOC) — limited: clears file nodes, re-analyzes, re-runs only 2 enrichers

### Key Limitations

1. **No batch commit** — enrichers call `addEdge()` one at a time. No atomicity.
2. **No blast radius** — incremental re-analysis hard-codes 2 enrichers (InstanceOfResolver, ImportExportLinker)
3. **No enrichment ownership** — edges have no owner tracking, can't selectively delete/replace
4. **No delta awareness** — orchestrator doesn't know what changed, re-runs everything
5. **Guarantees run during VALIDATION** — mixed with issue reporting, not tied to enrichment completion

---

## 2. What Changes (Delta from v1)

### New RFDB v2 Capabilities Used

| RFDB v2 Feature | Orchestrator Impact |
|-----------------|-------------------|
| CommitBatch (atomic) | Enrichers commit via batch, not individual addEdge() |
| CommitBatch delta (changedTypes, removedNodeIds) | Orchestrator knows WHAT changed → selective re-enrichment |
| content_hash per node (I4) | Precision diff: node-level "truly modified" detection |
| Composite file context (I2) | Enrichment shards: `__enrichment__/{enricher}/{file}` |
| Snapshot isolation | Readers never blocked during commits |
| Zone maps + dst bloom (I3, N8) | Fast reverse edge queries for blast radius |

### New Orchestrator Responsibilities

| Responsibility | Current (v1) | Target (v2) |
|---------------|-------------|-------------|
| Blast radius | None | Pre-commit query → dependent files (C4) |
| Enricher scheduling | Run all, always | Run affected enrichers for affected files (I5) |
| Enrichment ownership | None | Commit per enricher per file (I2) |
| Guarantee checking | In VALIDATION phase | After full cycle, all rules (C1+C2) |
| Delta tracking | None | CommitBatch delta → enricher selection |
| Coverage monitoring | None | content_hash canary (I4) |

---

## 3. Orchestrator v2 Protocol

### 3.1 Analysis Phase (unchanged conceptually)

```
For each changed file:
  1. Parse → nodes + edges (analysis plugins)
  2. Compute content_hash per node from source text
  3. Collect into batch
```

### 3.2 Pre-Commit Blast Radius (NEW — C4)

**Before** committing analysis results:

```
1. blast_radius_files = RFDB.query(
     "edges where dst.file ∈ changedFiles AND src.file ∉ changedFiles"
   ) → unique src.file values
   // Runs on LIVE graph (pre-tombstone), no C3 conflict

2. RFDB.CommitBatch(analysis_nodes, analysis_edges)
   → delta: { changedFiles, removedNodeIds, changedNodeTypes, changedEdgeTypes,
              nodesModified (via content_hash) }

3. re_enrich_files = changedFiles ∪ blast_radius_files
```

**Why before commit:** After commit, tombstone filtering (C3) hides edges pointing to deleted nodes. Pre-commit query sees all edges on the live graph.

### 3.3 Selective Enrichment (NEW — I5)

```
For each enricher in toposorted order:
  affected_files = re_enrich_files ∩ enricher.relevant_files(delta)

  For each file in affected_files:
    result = enricher.process(file, graph)
    RFDB.CommitBatch(
      file_context: "__enrichment__/{enricher.name}/{file}",
      edges: result.edges
    )
    → enricher_delta

    If enricher_delta.changedEdgeTypes not empty:
      // This enricher's output changed → downstream enrichers need re-run
      propagate_to_dependents(enricher, file)
```

**Enricher dependency graph** = first-class data structure:
- Built from `plugin.metadata.dependencies` (already exists) + `plugin.metadata.creates` (already exists)
- When enricher A's output changes → all enrichers depending on A's edge types re-run
- Cycle = build error (Kahn's algorithm already detects this)

### 3.4 Guarantee Checking (C1+C2)

```
After ALL enrichment complete:
  for each guarantee_rule:
    result = RFDB.CheckGuarantee(rule)
    if violation → collect

  // MVP: check ALL rules (5-20 rules, microseconds vs analysis time)
  // Optimization: check only rules matching changedNodeTypes/changedEdgeTypes
```

**Invariant:** Guarantees never run between analysis and enrichment. Only after full cycle.

### 3.5 Coverage Monitoring (I4)

```
After enrichment, for each file in changedFiles:
  nodes_with_content_change = delta.nodes where content_hash changed
  nodes_with_analysis_change = delta.nodes where children/edges changed

  coverage_gaps = nodes_with_content_change - nodes_with_analysis_change
  if coverage_gaps:
    log.warn("Analyzer coverage gap: {count} nodes changed content but not analysis")
    // Future: create ISSUE nodes for coverage gaps
```

---

## 4. Enricher Contract v2

### Current Contract (v1)

```typescript
abstract class Plugin {
  abstract execute(context: PluginContext): Promise<PluginResult>;
}
```

Enricher gets full graph access, does whatever it wants. No structure.

### New Contract (v2)

```typescript
interface EnricherV2 {
  metadata: EnricherMetadata;

  // Which files does this enricher care about?
  // Called with delta to determine scope
  relevantFiles(delta: CommitDelta, graph: GraphBackend): Promise<string[]>;

  // Process one file. Returns edges to commit.
  // Orchestrator commits them to __enrichment__/{name}/{file}
  processFile(file: string, graph: GraphBackend): Promise<EnricherFileResult>;
}

interface EnricherMetadata extends PluginMetadata {
  // What edge types does this enricher READ (consume)?
  consumes: EdgeType[];
  // What edge types does this enricher WRITE (produce)?
  produces: EdgeType[];
}

interface EnricherFileResult {
  edges: EdgeRecord[];
  nodes?: NodeRecord[];  // Optional: ISSUE nodes, synthetic nodes
}
```

**Key changes:**
1. **File-scoped processing** — enricher processes one file at a time (not whole graph)
2. **Declarative I/O** — `consumes` + `produces` enable automatic dependency graph
3. **Orchestrator owns commit** — enricher returns data, orchestrator commits to correct shard
4. **relevantFiles()** — enricher declares which files it needs to re-process (not "re-run everything")

### Migration Path

V1 enrichers can be wrapped:

```typescript
class V1EnricherAdapter implements EnricherV2 {
  constructor(private legacy: Plugin) {}

  async relevantFiles(delta: CommitDelta): Promise<string[]> {
    return delta.changedFiles; // Conservative: all changed files
  }

  async processFile(file: string, graph: GraphBackend): Promise<EnricherFileResult> {
    // Delegate to legacy execute() — collects edges for this file
    // This is a transitional wrapper, not permanent
  }
}
```

---

## 5. Enricher Dependency Graph

### Construction

```
From enricher metadata:
  ImportExportLinker:  consumes=[JSASTAnalyzer outputs], produces=[IMPORTS, IMPORTS_FROM]
  MethodCallResolver: consumes=[IMPORTS_FROM], produces=[CALLS]
  ValueDomainAnalyzer: consumes=[CALLS], produces=[VALUE_DOMAIN]

Dependency edges:
  MethodCallResolver → ImportExportLinker  (consumes IMPORTS_FROM)
  ValueDomainAnalyzer → MethodCallResolver (consumes CALLS)
```

### Propagation Rule

When enricher A re-runs for file X and produces different output:
1. enricher_delta = CommitBatch delta for `__enrichment__/A/X`
2. If enricher_delta has changes → find enrichers that `consume` A's `produces`
3. Those enrichers must re-run for file X (and potentially their blast radius files)

### Termination

- Graph is a DAG (Kahn's ensures no cycles)
- Each enricher can only add/modify edges of types it `produces`
- Propagation follows dependency edges → guaranteed to terminate
- Worst case: all enrichers re-run for all changed files = current v1 behavior

---

## 6. File-Level Orchestration Lifecycle

Complete flow for "user edits file B":

```
┌─ ANALYSIS ──────────────────────────────────────┐
│ 1. Parse file B → new nodes + edges             │
│ 2. Compute content_hash per node                 │
│ 3. Pre-commit blast radius query:                │
│    "who depends on file B?" → {C, D}             │
│ 4. CommitBatch(analysis, file: "B")              │
│    → delta: { modified: [func1], removed: [func2]│
│              changedNodeTypes: [FUNCTION] }       │
└──────────────────────────────────────────────────┘
                        │
                        ▼
┌─ ENRICHMENT ─────────────────────────────────────┐
│ re_enrich_files = {B, C, D}                      │
│                                                   │
│ For each enricher (toposorted):                   │
│   affected = enricher.relevantFiles(delta)        │
│              ∩ re_enrich_files                     │
│                                                   │
│   For each file in affected:                      │
│     result = enricher.processFile(file, graph)    │
│     CommitBatch(                                  │
│       file: "__enrichment__/{enricher}/{file}",   │
│       edges: result.edges                         │
│     ) → enricher_delta                            │
│                                                   │
│     If enricher_delta has changes:                │
│       propagate to dependent enrichers            │
└──────────────────────────────────────────────────┘
                        │
                        ▼
┌─ GUARANTEES ─────────────────────────────────────┐
│ Check all guarantee rules                         │
│ Collect violations                                │
│ Coverage monitoring (content_hash canary)         │
└──────────────────────────────────────────────────┘
```

---

## 7. Watch Mode Integration

Watch mode = repeated cycles of the above flow:

```
FileWatcher → changed files →
  filter (debounce, dedup) →
  Analysis Phase (only changed files) →
  Pre-commit blast radius →
  CommitBatch →
  Selective enrichment (only affected enrichers + files) →
  Guarantees
```

**Debouncing:** orchestrator collects changes for N ms (configurable), then runs one cycle.

**Key difference from v1:** In v1, watch mode re-runs full ENRICHMENT (all 14 enrichers, all files). In v2, only affected enrichers for affected files.

---

## 8. Implementation Phases

### Phase A: Enricher Contract v2 (can start now)

1. Define `EnricherV2` interface
2. Add `consumes`/`produces` to existing enricher metadata
3. Add `relevantFiles()` to existing enrichers (default: all changed files)
4. Add `processFile()` alongside existing `execute()`
5. Tests: enricher metadata declares correct consumes/produces

**No RFDB v2 dependency.** This is pure TS refactoring.

### Phase B: Orchestrator Batch Protocol (requires RFDB Phase 4)

1. Switch from `addEdge()` to `CommitBatch` calls
2. Implement enrichment shard file context (`__enrichment__/{enricher}/{file}`)
3. Implement pre-commit blast radius query (C4)
4. Use CommitBatch delta for selective enrichment
5. Tests: enrichment produces correct shard structure

### Phase C: Enricher Dependency Propagation (requires Phase B)

1. Build enricher dependency graph from consumes/produces
2. Implement propagation rule (enricher output changed → downstream re-run)
3. Termination proof tests
4. Tests: change in enricher A output → enricher B re-runs

### Phase D: Guarantee Integration (requires Phase B)

1. Move guarantee checking to post-enrichment hook
2. Remove from VALIDATION phase (VALIDATION = issue reporting only)
3. Coverage monitoring via content_hash
4. Tests: guarantees never fire between analysis and enrichment

---

## 9. Dependencies on Other Tracks

| Orchestrator Phase | Depends on RFDB Phase | Depends on Client Phase |
|-------------------|----------------------|------------------------|
| Phase A (contract) | None | None |
| Phase B (batch) | Phase 4 (CommitBatch) | Track 3 (batch API) |
| Phase C (propagation) | Phase 4 (delta) | Track 3 (delta parsing) |
| Phase D (guarantees) | Phase 2 (queries) | None |

**Phase A can start immediately** — no dependencies on RFDB v2.

---

## 10. Open Questions

1. **I6: Semantic ID stability** — requires dedicated research before Phase B. Renames, anonymous entities, computed properties. Research issue needed.

2. **Enricher granularity** — some enrichers are naturally file-scoped (ImportExportLinker), others are global (ValueDomainAnalyzer analyzes patterns across files). How to handle global enrichers in file-scoped model?

3. **Parallel enrichment** — enrichers within same dependency level could run in parallel (they don't depend on each other). Worth it for 14 enrichers? Profile first.

4. **Backward compatibility** — during transition, both v1 and v2 enricher contracts must work. V1EnricherAdapter pattern sufficient?

---

## 11. Relationship to Concerns

| Concern | Where Addressed | Section |
|---------|----------------|---------|
| C1+C2 | Guarantee timing | §3.4 |
| C4 | Pre-commit blast radius | §3.2 |
| I2 | Enrichment shard model | §3.3, §4 |
| I4 | content_hash + coverage | §3.5 |
| I5 | Enricher dependency graph | §5 |
| I6 | Open question | §10 |
| N7 | removedNodeIds in delta | §3.2 |
