# Federation Architecture: Thick Client + Scattered Databases

Date: 2026-03-15
Status: Design (pre-implementation)
Related: `federation-patterns.md` (background research)

---

## Problem

Grafema holds the entire code graph in one RFDB instance. For large repos this means:
- All LSM indexes in RAM simultaneously
- Vertical scaling limit hit at ~50K nodes
- No way to leverage npm packages as pre-analyzed data
- Analysis restarts from scratch on every run

## Core Insight

Federation doesn't need multiple processes. It needs multiple **databases** managed by one process, with **lazy index loading**.

Two node types:
- **Storage node** — `.grafema/` directory with `graph.rfdb` + `manifest.yaml`. Passive. Just files.
- **Compute node** — RFDB process + query routing logic. Opens storage nodes on demand.

Any storage node can be "promoted" to compute node by running `grafema serve` alongside it.

## Physical Layout

```
repo/
├── packages/cli/
│   ├── src/
│   └── .grafema/
│       ├── graph.rfdb        # LSM segments on disk
│       └── manifest.yaml     # export surface (~2-5KB)
├── packages/util/
│   ├── src/
│   └── .grafema/
│       ├── graph.rfdb
│       └── manifest.yaml
├── node_modules/
│   └── express/
│       └── .grafema/
│           └── manifest.yaml  # manifest only, no .rfdb
│                              # (pre-built, from CDN or npm)
└── .grafema/
    └── federation.yaml        # auto-generated shard map
```

One RFDB binary. Database files scattered per module. Manifests alongside. No binary duplication.

## Memory Model

```
200 shards in monorepo:
  All closed:    200 × manifest(~2KB) = 400KB
  3 opened:      400KB + 3 × index(~2MB) = ~6MB
  All opened:    400KB + 200 × index(~2MB) = ~400MB  ← monolith today

Lazy loading = ~60x RAM savings for typical queries
```

## Manifest Format (Draft v2 — Polyglot)

### Package Identification: purl (Package URL)

Standard URI scheme for cross-ecosystem package identification.
Already used in SBOM (SPDX, CycloneDX), GitHub Advisories, vulnerability databases.

```
pkg:npm/express@4.18.2
pkg:pypi/requests@2.31.0
pkg:maven/org.apache.commons/commons-lang3@3.14.0
pkg:cargo/serde@1.0.200
pkg:golang/github.com/gin-gonic/gin@v1.9.1
pkg:deno/std@0.200.0#http/mod.ts
pkg:gem/rails@7.1.0
pkg:nuget/Newtonsoft.Json@13.0.3
pkg:composer/laravel/framework@10.0.0
```

Format: `pkg:<ecosystem>/<namespace>/<name>@<version>?<qualifiers>#<subpath>`

### Full Manifest Example

```yaml
schema_version: 1              # manifest format version (breaking = bump)
analyzer_version: "0.3.0"     # grafema version that generated this manifest
authored: false                # true if developer-written (not auto-generated)
confidence: 0.85               # 0.0-1.0, how reliable the analysis is
generated: "2026-03-15T10:30:00Z"

# === UNIVERSAL (any language) ===
package:
  purl: "pkg:npm/@grafema/util@0.2.0"
  checksum: "sha256:abc..."
  source:
    tarball: "https://registry.npmjs.org/@grafema/util/-/util-0.2.0.tgz"
    repository: "https://github.com/nicholasgrafema/grafema"
    ref: "v0.2.0"
    source_type: source          # source | compiled_js | minified | dts_only

exports:
  - name: createGraph
    kind: FUNCTION               # FUNCTION | CLASS | VARIABLE | TYPE | CONSTANT
    semanticId: "src/graph.ts->FUNCTION->createGraph"
    effects: [PURE]
    params:
      - name: config
        flow: IN                 # IN | OUT | PIPE | SINK
    returns:
      flow: OUT

  - name: writeNodes
    kind: FUNCTION
    semanticId: "src/rfdb.ts->FUNCTION->writeNodes"
    effects: [MUTATION, IO]
    params:
      - name: db
        flow: PIPE               # read + modified (pass-through mutation)
      - name: nodes
        flow: IN

  - name: GraphConfig
    kind: TYPE
    semanticId: "src/types.ts->INTERFACE->GraphConfig"
    fields: [root, include, exclude, plugins]

imports:
  - purl: "pkg:npm/@grafema/types@0.2.0"
    symbols: [Node, Edge, GraphConfig]
  - purl: "pkg:npm/node@*#fs"
    symbols: [readFileSync, writeFileSync]

capabilities:
  total_exports: 42
  total_internal_symbols: 847
  has_graph: true                # whether full .rfdb exists alongside

access:
  local: "./graph.rfdb"
  remote: "https://cdn.grafema.dev/pkg/npm/@grafema/util/0.2.0/manifest.yaml"

# === LANGUAGE-SPECIFIC (extensible) ===
language: typescript
language_specific:
  module_system: esm             # esm | cjs | dual
  entry_points:
    ".": "./dist/index.js"
    "./config": "./dist/config.js"
  typescript_declarations: true
```

### Flow Types (universal across languages)
- `IN` — read only
- `OUT` — return value (new data)
- `PIPE` — read and modified (pass-through mutation)
- `SINK` — consumed, not returned

### Effect Types (universal across languages)
- `PURE` — deterministic, no side effects
- `MUTATION` — mutates arguments
- `IO` — filesystem, network, database
- `THROW` — may throw exception / raise error / return error
- `ASYNC` — returns Promise/Future/async generator
- `UNKNOWN` — analysis couldn't determine (used when confidence < 0.5)

### Confidence Score
```
1.00 — developer-authored, human verified
0.95 — full source code, complete analysis
0.70 — compiled code, partial analysis
0.40 — .d.ts / type stubs only, export surface without effects
0.20 — minified/obfuscated, heuristic analysis
```

When confidence < 0.5: treat all effects as UNKNOWN, do not propagate transitively.

### Three-Layer Merge (priority: developer > local > CDN)

```
final = deep_merge(
  cdn_manifest,           # base: auto-generated, from CDN
  auto_manifest,          # fresh local analysis (overrides CDN)
  developer_manifest      # hand-written overrides (highest priority)
)
```

Files:
- `manifest.yaml` — developer-authored or final merged result
- `manifest.auto.yaml` — auto-generated by grafema (never edit)
- CDN fallback — fetched when no local manifest exists

### Developer Publishing

Developers include `.grafema/manifest.yaml` in their package:

npm: `"files": ["dist/", ".grafema/"]` in package.json
PyPI: include in `MANIFEST.in` or `pyproject.toml`
Cargo: `include = [".grafema/"]` in Cargo.toml
Maven: resource directory in pom.xml

When consumers install the package, manifest arrives automatically.
Zero config for consumers.

### Flow Types (data flow annotations on parameters)
- `IN` — read only
- `OUT` — return value (new data)
- `PIPE` — read and modified (pass-through mutation)
- `SINK` — consumed, not returned

### Effect Types
- `PURE` — deterministic, no side effects
- `MUTATION` — mutates arguments
- `IO` — filesystem, network, database
- `THROW` — may throw exception
- `ASYNC` — returns Promise/callback

### Manifest Size Budget
- Target: 2-5KB per shard
- Exports: full detail (names, signatures, effects)
- Internals: bloom filter for name lookups (~1KB per 1000 symbols, 1% false positive)
- 10K shards × 5KB = 50MB manifests in RAM — acceptable

## RFDB Protocol Extension

New commands needed:

```
OPEN <path>                    # Load database indexes from path
CLOSE <path>                   # Unload indexes, free RAM
QUERY <path> <datalog>         # Query specific database
LIST_DATABASES                 # Show loaded databases
DATABASE_STATS <path>          # Stats for specific database
```

Behavior:
- OPEN loads LSM indexes + bloom filters into memory
- Data segments stay on disk (read on query via mmap)
- CLOSE frees index memory, keeps mmap mappings alive (OS manages page cache)
- QUERY on non-opened database → auto-OPEN (lazy)
- Idle timeout → auto-CLOSE after configurable period (default 30s)

## Query Routing

```
Client sends: find_calls(name="createGraph")

Compute node:
  1. Read all manifests (cached in memory)
  2. Filter: which shards export "createGraph"? → @grafema/util
  3. Filter: which shards import from @grafema/util? → @grafema/cli, @grafema/mcp
  4. OPEN @grafema/util, @grafema/cli, @grafema/mcp
  5. QUERY each: find_calls(name="createGraph")
  6. Merge results (G-Set union)
  7. Return merged results
  8. Idle timer: CLOSE after 30s of no queries
```

Cross-shard traversal (trace_dataflow):
```
  1. Start in shard A, trace forward
  2. Hit boundary: data flows to exported symbol
  3. Look up manifest: who imports this symbol?
  4. OPEN importing shards
  5. Continue trace in each
  6. Repeat until depth limit or no more cross-shard flows
```

## Shard Discovery (Auto-Sharding)

Priority order:
1. **package.json** — each directory with package.json = shard (monorepo)
2. **Explicit config** — federation.yaml with manual boundaries (monolith)
3. **Auto-clustering** — Louvain community detection on import graph (future, v0.5)

For 90% of cases, option 1 is sufficient.

## npm Ecosystem Capture Strategy

```
Phase 1: Manifest format + generation
  grafema analyze → generates manifest.yaml automatically

Phase 2: npm manifests
  Import resolution reads manifest from node_modules/pkg/.grafema/manifest.yaml
  Fallback: unresolved (as today)

Phase 3: Pre-built CDN
  Background worker:
    1. npm registry → packages sorted by downloads/week desc
    2. For each: npm pack → grafema analyze → manifest.yaml
    3. Upload: cdn.grafema.dev/npm/<pkg>/<version>/manifest.yaml
    4. Immutable per package@version

  Client enhancement:
    1. import { Router } from 'express'
    2. Check node_modules/express/.grafema/manifest.yaml → found? use it
    3. Not found? → GET cdn.grafema.dev/npm/express/4.18.2/manifest.yaml
    4. Not on CDN? → unresolved

  CRITICAL: Analysis order matters. Effects propagate bottom-up.
  Must analyze in topological order of dependency DAG.

  Pipeline:
    1. Fetch npm dependency graph (packument API)
    2. Topological sort (leaves first, popular packages prioritized)
    3. For each level bottom-up:
       - Download package
       - grafema analyze (with dep manifests already on CDN)
       - Generate manifest (effects = own + transitive from deps)
       - Upload to CDN
    4. Next level references previous level's manifests

  Why topological order:
    express → body-parser → raw-body → iconv-lite
    iconv-lite.decode() has effect: [MUTATION] on Buffer
    Without iconv-lite manifest → raw-body manifest says PURE (wrong)
    → body-parser says PURE (wrong) → express says PURE (wrong)
    Transitive effects MUST propagate from leaves to root.

  Level 0 (zero deps): thousands, small, parallelize perfectly
  Level 1-3: bulk of ecosystem
  Level 4+: long tail

  Each manifest is immutable per package@version@analyzer_version.
  Rebuild when: new package version published OR analyzer version bumped.

  Versioning strategy:
    schema_version: manifest format. Breaking change = bump. Client with
      schema_version=2 can't parse schema_version=3 manifest → must re-parse.
    analyzer_version: grafema version that produced the manifest. Older
      analyzer = less precise effects/flow analysis. Client uses manifest
      but flags it for background re-parse.

  Re-parse on analyzer update:
    - Queue re-parse by topological order (leaves first, as always)
    - Priority by popularity (top-1000 first)
    - Gradual: don't re-parse everything at once
    - Old manifests remain usable until replaced

  Coverage:
    Top 1,000 npm packages = ~80% of typical project imports
    One worker processes ~500 packages/hour
    Full top-1000 in ~2 hours

Phase 4: Sharded analysis (--sharded flag)
  Each module analyzed into own .grafema/graph.rfdb
  Behind feature flag, no breaking changes

Phase 5: RFDB multi-database
  OPEN/CLOSE protocol extension
  Full lazy loading
```

## Scale Limits

| Scale | Shards | Manifest RAM | Model |
|-------|--------|-------------|-------|
| Single repo | 5-20 | ~100KB | Trivial |
| Large monorepo | 100-1K | 2-5MB | Works well |
| npm ecosystem | 1K-10K | 20-50MB | Practical limit |
| Beyond 10K | 10K+ | 50MB+ | Needs hierarchical routing |

### Fundamental Bottleneck
Cross-shard traversal is sequential by nature. Each hop depends on the previous step's result. This is inherent to graph traversal, not specific to federation. Federation makes the cost explicit and manageable (controlled OPEN/CLOSE) vs implicit (OS page faults on swapped memory).

### Mitigations for Scale
- **LRU cache**: keep last N shards loaded
- **Hot shard tiering**: always-loaded for popular packages (React, lodash)
- **Bloom filters in manifests**: reduce false-positive shard opens
- **Pre-computed transitive imports**: manifest lists transitive dependencies for pre-warming
- **Depth limits**: configurable max cross-shard hops for traversal queries

## Levels of Operation

| Level | Storage | Compute | Use Case |
|-------|---------|---------|----------|
| File | `.grafema/` on disk | grafema CLI opens | Local repo |
| Service | `.grafema/` + RFDB process | Responds to queries | `grafema serve` on server |
| Network | Multiple services | Each routes queries | Enox P2P mesh |

The manifest format is identical at all levels. Transport differs (file read / unix socket / HTTP).

## Relation to Enox

This architecture is the local-first foundation for Enox federation:
- Storage node = Enox knowledge domain (passive data)
- Compute node = Enox peer (active query handler)
- Manifest = Enox capability advertisement
- Query routing = Enox mesh protocol

Enox adds: DHT discovery, P2P transport, cross-internet routing. But the manifest format and query decomposition logic are shared.

## Effects Bootstrap: Computation + LLM Cross-Validation

### The Problem
Effect annotations must come from somewhere. Three sources of effects:
1. **Runtime builtins** (fs, console, fetch) — finite, curated list
2. **FFI/native modules** (C bindings, WASM) — can't be statically analyzed
3. **Opaque packages** (minified, no source) — analysis impossible

### Solution: Hybrid Pipeline

```
Source 1: Grafema static analysis
  Call graph traversal → propagate known effects transitively
  Detects: direct calls to builtins, assignment chains, re-exports
  Strength: deterministic, verifiable, zero cost per query

Source 2: LLM inference (Claude subagents)
  Input: README + API docs + function signatures + package description
  Output: effect annotations per exported function
  Strength: understands semantic intent ("database" → IO, "hash" → PURE)
  Weakness: may hallucinate

Source 3: Cross-validation
  Compare Grafema output vs LLM output:
    Both agree → high confidence (0.95+)
    LLM says X, Grafema says UNKNOWN → medium confidence (0.80)
    LLM passes disagree with each other → flag for human review
    Grafema says IO, LLM says PURE → detectable error, investigate
```

### Pipeline Implementation

```
For each package:
  1. Grafema analyze → call graph + partial effects from builtins
  2. Claude subagent pass 1 → infer effects from docs/names
  3. Claude subagent pass 2 → independent inference, different prompt
  4. Reconcile:
     - agreement(grafema, claude1, claude2) → confidence 0.99
     - agreement(claude1, claude2) but grafema=UNKNOWN → confidence 0.85
     - disagreement(claude1, claude2) → flag, default UNKNOWN
     - contradiction(grafema, claude) → investigate (likely LLM error)
  5. Output: manifest with effects + confidence per function
```

### Cost Model
- LLM inference: ~$0.01/package (README + exports list, one API call)
- Or: Claude Code subagents in batches of 10 (zero API cost)
- Top-10,000 packages: ~$100 via API, or free via subagents
- One-time cost, results cached forever (immutable per package@version)

### Verification Property
Key advantage over pure-LLM approach: Grafema's static analysis provides
ground truth for verifiable cases. If Grafema traces a call chain to
`fs.writeFile`, that's a FACT, not an inference. LLM errors that contradict
static analysis are automatically detected.

### Effects Database Structure

```
grafema/effects-db/           # git repo or embedded in grafema
├── runtimes/
│   ├── node.yaml             # ~200 Node.js builtins
│   ├── browser.yaml          # ~150 Browser APIs
│   ├── deno.yaml
│   └── bun.yaml
├── packages/                  # community-maintained overrides
│   ├── better-sqlite3.yaml
│   ├── sharp.yaml
│   └── ...
├── taxonomy.yaml              # effect type definitions + versioning
└── README.md                  # contribution guide
```

### Taxonomy (v1, extensible)

```yaml
# taxonomy.yaml
version: 1
types:
  PURE:              "Deterministic, no side effects"
  MUTATION:          "Mutates arguments or external state"
  IO:                "Filesystem, network, database, or device access"
  THROW:             "May throw exception / raise error"
  ASYNC:             "Returns Promise/Future/async generator"
  NONDETERMINISTIC:  "Output varies between calls (Math.random, Date.now)"
  UNKNOWN:           "Analysis couldn't determine — propagate as warning"

# Future subtypes (schema_version 2, backwards compatible):
# IO → FILE_IO, NETWORK_IO, DB_IO
# MUTATION → MUTATES_ARG, MUTATES_GLOBAL, MUTATES_THIS
```

UNKNOWN MUST propagate transitively — it's a signal ("be careful"),
not silence. If A calls B and B has UNKNOWN, then A has UNKNOWN too.

## Key Design Principle

> A graph that doesn't fit in memory isn't a problem to solve — it's a traversal to manage.
> Federation makes traversal costs explicit: you control what's loaded, when, and for how long.
> The alternative (monolithic graph with OS swapping) gives the same latency but with no control.
