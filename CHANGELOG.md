# Changelog

All notable changes to this project will be documented in this file.

## [Unreleased]

### Features

- feat(cli): `grafema upgrade` command — clean stale artifacts from `~/.grafema/bin/` and upgrade binaries to current version. Supports `--all`, `--lang`, `--project`, `--dry-run` flags.
- feat(cypher): SUM/AVG/MIN/MAX aggregates in Cypher queries (RFD-70) — real typed accumulators with Cypher NULL semantics and Int→Float promotion; unsupported aggregate functions now error instead of silently returning a row count (#274)
- feat(orchestrator): emit `resolve_progress` profiler events during per-file JS/TS resolve (files_done / total_files / edges_so_far, every 500 files + at completion) — closes the silent profiler gap between `js_resolve_start` and `js_resolve_complete` (#296)

### Bug Fixes

- fix(coverage): exclude skipped/failed files from the analyzed count — oversized files that the orchestrator silently skips are reclassified from "analyzed" into a new "Failed" bucket, so `grafema coverage` reports an accurate (no longer inflated) percentage (REG-1140, #276)
- fix(rfdb): correct token fuzzy-search Jaccard scores by unifying the tokenizer — removes the phantom whole-string token that inflated the union denominator and distorted `find_nodes` fuzzy-fallback ranking (#275)
- fix(rust-analyzer): unwrap `Box`/`Rc`/`Arc` receiver types so `Box<dyn Trait>` resolves to the inner trait, restoring dyn-dispatch CALLS edges that were previously dropped (#273)
- fix(orchestrator): index exported `namespace` declarations so `export namespace X {}` resolves cross-file and gets an IMPORTS_FROM edge — keeps `INDEX_NODE_TYPES` in sync with the resolver's exported-declaration list (REG-1139, #277)
- fix(cypher): route only real aggregates (COUNT/SUM/AVG/MIN/MAX) through HashAggregate — a scalar function in `RETURN` (e.g. `toUpper(n.name)`) now fails loudly at plan time instead of being mislabeled as an aggregate and erroring at execution (RFD-70 follow-up, #282)
- fix(orchestrator): checkpoint JS/TS resolve every 500 files instead of a single end-of-phase commit, so a crash or SIGTERM mid-resolve loses at most ~500 files of work rather than the entire (multi-hour on large monorepos) resolution phase (REG-1138, #286)
- fix(cli): `grafema analyze --resolve-jobs N` / `grafema resolve --jobs N` no longer silently ignore the requested worker count — resolution currently runs single-worker, so any value other than 1 now prints a clear notice that the flag has no effect and proceeds with 1 worker; help text updated to match (REG-563, #287)
- fix(cli): `grafema who` attributes each call to its enclosing named function (via the v2 `[in:…]` semantic-id annotation) instead of `<anonymous>`; import statements are no longer mislabelled as bare callers (#292)
- fix(cli): `file`/`explain` resolve files correctly when the project root is a symlink (e.g. `--project` at a symlinked checkout, or a root under macOS `/tmp`→`/private/tmp`) — previously reported `NOT_ANALYZED` for analyzed files because the project-relative path was computed against a non-realpath'd root (#293)
- fix(cli): `grafema impact <method>` resolves a bare method name to its METHOD node and finds its callers (previously reported "No node found") — recovers `receiver.method()` call sites whose `method` attribute is unpopulated via a name-based CALL scan, consistent with `grafema who` (#297)
- fix(util): `findContainingFunction` attributes a call inside a class method to that METHOD instead of the enclosing CLASS — fixes caller labelling and impact's internal-call exclusion for method-to-method calls (REG-254, #300)
- fix(cli): `grafema impact <Class>` aggregates callers of all the class's methods (enumerated via `HAS_METHOD`) and excludes the class's own method-to-method internal calls from the external-impact count (REG-543, #303)
- fix(cli): `grafema impact <symbol> --json` emits valid JSON (zero-impact object with `target: null`) instead of empty stdout when the target is not found; the human-readable note stays on stderr (#304)

## [0.3.23] - 2026-04-01

### Highlights

- **Cross-process bridge detection** — Automatic discovery of IPC boundaries across languages: TypeScript `spawn`/`fetch` → Rust handlers, Unix socket connections, config-driven plugin dispatch. 13/14 internal boundaries detected (66 CALLS_REMOTE edges). First tool to link `fetch()` in frontend to Axum route handler in Rust backend through a single graph.
- **Object literal shapes** — `const config = { host, port }` now carries structural shape (`objectKeys`) through the graph. Type inference heuristic rewritten (suffix-only matching), eliminating 57 false positive shape violations.
- **CFG connectivity fix** — `BlockStatement` now creates SCOPE nodes, fixing a fundamental gap where `if/else` branches were disconnected from their contents. Enables branch-aware analysis: 179 GUARDED_WRITE edges mark conditional property mutations.
- **Rust PASSES_ARGUMENT** — Rust analyzer now emits argument edges for function/method calls (25K+ edges), enabling cross-language dataflow tracing.
- **Fuzzy name search via local embeddings (RFD-63)** — RFDB now includes a token-based + embedding index for fuzzy name matching. When exact name match returns 0 results, `find_nodes` falls back to embedding similarity.
- **Rich find_nodes output (REG-1015)** — `find_nodes` returns structural context per node: callers, member list for classes, parent node, import/call counts.
- **Progressive fallback chain** — `find_nodes` tries: exact match → fuzzy embedding → type relaxation → grep-enriched results.
- **Autoresearch benchmark** — 30 questions from real VS Code GitHub issues. Grafema + Claude Sonnet = 77% vs 67% baseline (+10% accuracy).

### Features

- feat: object literal `objectKeys` metadata on LITERAL nodes (JS analyzer)
- feat: template literal `quasis` metadata for static string extraction
- feat: structural shape in INSTANCE_OF edge metadata via type-inference plugin
- feat: shape propagation through assignment chains (shape-tracker Phase 3b)
- feat: GUARDED_WRITE edges for property writes inside if/else branches (Phase 3c)
- feat: BlockStatement creates SCOPE node via `withScope BlockScope` (CFG fix)
- feat: TryStatement HAS_BODY edge to block scope
- feat: Rust analyzer PASSES_ARGUMENT edges via `captureFirstNodeId`/`listen`
- feat: axum-route-detector plugin — 5 http:route nodes from Axum `.route()` calls
- feat: semantic-bridge-detector — subprocess, HTTP, unix socket bridge detection
- feat: config-driven symbolic execution — parse `config.yaml` plugins for dynamic bridges
- feat: `process.execPath` detection for self-spawn bridges
- feat: RFDBClient/RFDBServerBackend `channelHint` for class-mediated socket bridges
- feat: ISSUE nodes for unresolved IPC boundaries (17 actionable diagnostics)
- feat: `extractServiceName` with deep function call chain tracing
- feat(rfdb): fuzzy name search — token-based + embedding index in RFDB (RFD-63)
- feat(mcp): rich find_nodes output with `_context` (callers, members, parent, counts)
- feat(mcp): progressive fallback chain — embedding → type relaxation → grep enriched
- feat(mcp): auto-retry find_nodes without type filter on 0 results
- feat(mcp): server instructions with prohibition + routing rules + few-shot examples
- feat(autoresearch): H012 prompt ablation — 20 prompts, 7 dimensions, 60 runs

### Bug Fixes

- fix: Unix socket path panic when project in deep directory (#231)
- fix: type inference heuristic — substring → suffix-only match (57→0 false violations)
- fix: dot-calls excluded from factory name heuristic (`.map()` no longer typed as `Map`)
- fix: `RETURN_TYPE_MAP` for `Object.keys/values/entries` → `Array`
- fix: duplicate IMPLEMENTS entries in edges.ts and archetypes.ts
- fix: `<obj>.write` removed from IPC sender primitives (was matching stdout/fs writes)
- fix: config version check relaxed to patch-level (warn, not throw)
- fix(rfdb): wire gc_collect + gc_purge into compact flow (orphaned segment cleanup)
- fix(mcp): use HAS_METHOD edges for CLASS member listing (was CONTAINS)

## [Unreleased]

## [0.3.24] - 2026-04-02

### Features

- feat: Ruby language support via Prism parser — functions, classes, modules, method calls, blocks, require/require_relative resolution
- feat(vscode): GUI server auto-download — "Open Map" offers to download `grafema-gui` from GitHub Releases when binary not found
- feat(vscode): `grafema.guiPath` setting for explicit GUI server binary path

### Build

- build: enable Ruby support by default (`default = ["ruby"]` in Cargo.toml)
- build: skip Ruby for linux-arm64 cross-compilation (`--no-default-features`) due to bindgen/libclang requirement
- build: add `grafema-gui` binary to CI build pipeline (4 platforms)
- build: add `grafema-gui` and `rfdb-server` to lazy-downloadable binaries list
- ci: make `file` command non-fatal in Haskell binary verify step (self-hosted runner compatibility)

### Bug Fixes

- fix(vscode): GUI server binary discovery — search bundled, env var, ~/.grafema/bin/, monorepo paths (was monorepo-only)

## [0.3.22] - 2026-03-25

### Highlights

- **Python import resolution** — Relative imports (`from ..base import X`), glob imports (`from .models import *`), and re-export chains now fully resolved. Validated at 100% recall on syntactic imports against the [ToCS benchmark](https://arxiv.org/abs/2603.00601).
- **Virtual dispatch for Python** — Method calls on typed variables (e.g., `stage.process()` where `stage: StageBase`) resolve to all subclass implementations via class hierarchy and type annotations.
- **Per-file streaming resolution (RFD-61)** — Resolution plugins receive nodes one file at a time instead of the entire graph, reducing memory pressure for large repos.
- **RFDB input validation** — `addEdges`/`addNodes` now throw on missing required fields (`src`/`dst`/`id`) with helpful hints (e.g., "Did you mean 'src'? Found 'source'"), preventing silent data loss.

### Features

- feat(python-resolve): resolve relative imports — `..base` → `pkg.base` via file-to-module-path mapping
- feat(python-resolve): glob import handling — `from .models import *` → IMPORTS_FROM to MODULE node
- feat(python-resolve): re-export support — IMPORT_BINDING nodes in name index as fallback for re-exported symbols
- feat(python-resolve): virtual dispatch — type-aware call resolution via EXTENDS edges + annotation metadata
- feat(python-resolve): class hierarchy index from `bases` metadata, transitive subclass expansion
- feat(resolve): per-file streaming resolution — orchestrator streams nodes per-file to resolve plugins (RFD-61)
- feat(resolve): batch plugin framework improvements — batch-mode plugins write directly to RFDB

### Bug Fixes

- fix(rfdb): input validation for addEdges/addNodes — throw on missing `src`/`dst`/`id` with actionable error messages
- fix(rfdb): detect common field name mistakes (`source`→`src`, `target`→`dst`) and include in error hint

### Documentation

- docs: add Grafema for ToCS benchmark results (`docs/GRAFEMA_FOR_TOCS.md`)

## [0.3.21] - 2026-03-23

### Highlights

- **Resolution phase OOM fix (REG-781)** — Batch-resolve combines 7 sequential daemon calls into 1, eliminating 7× context concat and 6× redundant index rebuilds per worker. Streaming RFDB queries reduce orchestrator peak memory from ~500MB to ~12MB. Expected total peak: ~3.5-4.5GB (was 23GB on 14k-file repos).
- **Rust intra-file call resolution (REG-688)** — Rust functions calling other functions in the same file now get CALLS edges resolved.
- **Interface HAS_PROPERTY edges (REG-676)** — TypeScript interfaces now emit HAS_PROPERTY edges to property and method signatures.

### Performance

- perf(resolve): batch `resolve-all` daemon command — 7 sequential IPC round-trips → 1, 7× concat → 1, 6× index rebuild eliminated (REG-781)
- perf(resolve): streaming RFDB queries in orchestrator — `query_nodes_by_type` no longer materializes full Vec per type, chunks processed incrementally (REG-781)
- perf(resolve): direct msgpack serialization bypassing aeson intermediate in Haskell daemon hot path (REG-781)
- perf(resolve): `DaemonState` finalize-context — cache flattened node list after first resolve, avoid repeated concat (REG-781)

### Features

- feat(rust-resolve): Rust intra-file call resolution — CALLS edges for same-file function invocations (REG-688)
- feat(js-analyzer): HAS_PROPERTY edges from INTERFACE to property/method signatures (REG-676)
- feat(mcp): `findProjectRoot` auto-detection + socket path override (REG-652)

### Bug Fixes

- fix(resolve): OOM on 14k-file repos — 23GB memory, 100% single-core CPU, 300s timeout crash (REG-781)
- fix(ci): remove cross-platform optionalDeps from workspace package.json — fixes frozen-lockfile CI failures
- fix(ci): remove deleted benchmark target from workflow
- fix(util): METHOD_CALL support in FileOverview, manifest URI updates

### Infrastructure

- Resolution phase now shows progress on stderr: streaming counter, per-command timing
- `drain_query_stream` method for RFDB socket safety on mid-stream errors
- New skill: `haskell-batch-laziness-memory-trap`

## [0.3.20] - 2026-03-19

### Highlights

- **Zero-config quickstart** — `grafema analyze --quickstart` scans the project for supported languages, generates config, and runs analysis in one command. No separate `grafema init` step needed.
- **Correct source positions for JS/TS** — The Haskell js-analyzer outputs byte offsets, not line numbers. The orchestrator now converts them to proper line:column positions, fixing VS Code extension panels (Value Trace, Callers, Blast Radius, Nodes in File).
- **RFDB read path optimization (RFD-55)** — Per-level read path with L1 edge-type index and WriteBuffer incremental index for O(1) type lookups. Typed CommitBatch envelope eliminates ~70K+ heap allocations per batch, cutting p99 commit latency from 4918ms to 2512ms.

### Features

- feat(cli): `--quickstart` flag for `grafema analyze` — auto-initializes project if no config exists (scan extensions, generate config, update .gitignore)
- feat(cli): `--detail` flag for `grafema wtf` — control output verbosity (`summary`, `normal`, `full`); CLI hint text now context-aware

### Performance

- perf(rfdb): per-level read path — immutable L1 edge-type index built at shard open, incremental WriteBuffer edge_type_index for O(1) lookups (RFD-55)
- perf(orchestrator): typed CommitBatch envelope replaces `serde_json::Value` intermediate tree — eliminates heap allocations, serialize_ms drops to 0ms, total rfdb_commit_ms 39.8s → 28.6s (1.39x speedup) (RFD-55)

### Bug Fixes

- fix(orchestrator): convert byte offsets to line:column in JS/TS analysis — Haskell analyzer outputs byte offsets in line/endLine fields, now properly converted via line index. Fixes VS Code extension findNodeAtCursor matching.
- fix(cli): `wtf` command hint text said `detail="full"` (MCP syntax) instead of `--detail full` (CLI syntax)

## [0.3.18] - 2026-03-17

### Highlights

- **Comprehensive analysis telemetry** — Phase timers (discovery, analysis, resolve, compact), per-plugin resolution timing, RFDB commit stats (p50/p95/p99 latency, throughput), per-file semantic density (decl/ref/call/prop counts). All persisted as queryable METRIC nodes.
- **Unresolved diagnostics** — After resolution, Datalog negation queries find unresolved CALL and IMPORT_BINDING nodes. Categorized as `unresolved_external` (outside analyzed root) or `unresolved_internal` (file exists, symbol not found). Persisted as ISSUE nodes.
- **Per-file performance metrics** — METRIC nodes in the graph with OBSERVES edges to MODULE. 7 metrics per file: parse_ms, analyze_ms, total_ms, file_size_bytes, ast_size_bytes, node_count, edge_count.
- **Datalog numeric operators** — `gt()`, `lt()`, `gte()`, `lte()` for metric-based queries and guarantees.
- **RFDB O(N²) elimination** — commit_batch 15x faster on large codebases via file-to-node index, shard-targeted edge lookup, Arc tombstones.
- **Manifests & Effects** — `grafema analyze` generates `manifest.yaml` with exported API surface and side-effect annotations. Effects-DB ships pre-built annotations for npm packages and Node.js builtins.
- **MCP documentation** — new `metrics` and `effects` topics in `get_documentation`, numeric predicates documented in query syntax.

### Features

- feat(orchestrator): comprehensive analysis telemetry — phase timers, per-plugin resolve timing, RFDB commit stats (p50/p95/p99), per-file semantic density metrics
- feat(orchestrator): unresolved diagnostics as ISSUE nodes — Datalog negation finds unresolved CALLs and IMPORT_BINDINGs, categorized by severity
- feat(orchestrator): METRIC nodes as first-class observability layer (parse_ms, analyze_ms, file_size_bytes, etc.)
- feat(rfdb): numeric comparison operators `gt`, `lt`, `gte`, `lte` in Datalog engine
- feat(orchestrator): per-file performance profiling and `scripts/profile-analyze.mjs` bottleneck analysis tool
- feat(cli): auto-generate `manifest.yaml` with exports, imports, and transitive effects after analysis
- feat: effects-db — curated side-effect annotations for npm packages and Node.js builtins
- docs(mcp): `get_documentation` topics for metrics, effects, numeric predicates

### Bug Fixes

- fix(analyzer): HANDLES edge now resolves to actual handler function instead of synthetic ARG node — passes walked argument IDs through matchCallSite → applyArgRule
- fix(mcp): `get_function_details` finds const-bound arrow functions by following ASSIGNED_FROM edges from CONSTANT/VARIABLE nodes
- fix(mcp): `get_file_overview` reclassifies const-bound functions as Functions instead of Variables
- fix(rfdb): eliminate commit_batch O(N²) degradation via file index, shard-targeted edges, Arc tombstones (15x speedup)
- fix: lazy-downloaded binaries version-checked and re-downloaded when stale
- fix: lazy download uses latest `binaries-v*` tag instead of hardcoded version

## [0.3.16] - 2026-03-17

### Bug Fixes

- fix: lazy-downloaded binaries use latest `binaries-v*` release tag instead of hardcoded `binaries-v{version}`. Fixes download failure when npm version is ahead of binary build tag (e.g. JS-only releases).

## [0.3.15] - 2026-03-17

### Bug Fixes

- fix: lazy-downloaded binaries (`~/.grafema/bin/`) are now version-checked on every run. If the cached binary is from a previous release, it is automatically re-downloaded from the matching `binaries-v{version}` tag. Fixes `unknown command: load-context` when upgrading Grafema versions.

## [0.3.14] - 2026-03-17

### Highlights

- **Large file resilience** — Minified bundles and generated files (100KB+ source, multi-MB AST) no longer choke the analysis pipeline. Configurable size guards skip oversized files before parsing and persist ISSUE nodes in the graph for queryability via MCP tools.

### Features

- feat(orchestrator): `maxFileSizeKb` config option (default: 1024 = 1MB) — files larger than this are skipped before parsing
- feat(orchestrator): `maxAstSizeKb` config option (default: 51200 = 50MB) — ASTs larger than this are skipped before sending to daemon
- feat(orchestrator): ISSUE nodes persisted in graph for oversized files, parse errors, and analysis failures — queryable via `find_nodes(type="ISSUE")`
- feat(orchestrator): MODULE stub nodes created for failed files so they appear in graph queries and file-scoped GC works
- feat(orchestrator): Set either limit to 0 to disable the corresponding guard

## [0.3.13] - 2026-03-16

### Highlights

- **Critical fix: data loss on server restart** — `flush_data_only()` was a no-op in V2 engine. Since the orchestrator sends all `commitBatch` with `deferIndex=true`, data lived only in write buffers and was lost if analysis failed before `compact()` or if server stopped. Now flushes to disk when write buffers exceed 100K nodes/shard.
- **Shutdown flush** — `grafema server stop` (Shutdown command) now flushes all databases before exit, matching signal handler behavior.
- **`diskBytes` in GetStats** — RFDB server now reports database size on disk.

### Bug Fixes

- fix(rfdb): `flush_data_only()` was no-op — all `commitBatch(deferIndex=true)` data stayed in RAM. If analysis crashed before `compact()`, all nodes/edges were lost on restart. Now periodically flushes when write buffers exceed 100K nodes or 256MB per shard.
- fix(rfdb): Shutdown wire command exited without flushing databases. Signal handler (SIGINT/SIGTERM) flushed correctly, but `grafema server stop` sent Shutdown command which called `process::exit(0)` directly. Both Unix socket and WebSocket handlers now flush before exit.

### Features

- feat(rfdb): `diskBytes` field in GetStats response — reports total database size on disk via recursive directory traversal. Returns 0 for ephemeral databases.
- feat(rfdb): `disk_size_bytes()` method on GraphStore trait

## [0.3.12] - 2026-03-16

### Highlights

- Streaming resolution pipeline — streams nodes from RFDB to resolve workers incrementally instead of collecting all 6.7M nodes into a single Vec (~1.67GB). Orchestrator peak memory drops ~4x.
- JSONL profiler for analysis pipeline observability — writes timestamped events with RSS/CPU metrics to `.grafema/analysis-profile.jsonl` for crash/hang diagnosis and bottleneck identification.
- Fix DEPENDS_ON derivation — MODULE→MODULE dependency edges now correctly derived from IMPORTS_FROM edges (was 0 due to URI format parsing bug).

### Features

- feat(orchestrator): streaming double-buffer resolution — query RFDB one node type at a time, route context nodes (broadcast to all workers) vs work nodes (sharded by file hash), flush at 50K threshold
- feat(orchestrator): JSONL profiler with cross-platform process stats (macOS mach_task_info, Linux /proc) — 29 events covering discovery, analysis, each resolve command, DEPENDS_ON derivation, compaction
- feat(orchestrator): `acquire_all()` helper on ProcessPool for directed streaming to all workers

### Bug Fixes

- fix(orchestrator): DEPENDS_ON derivation produces 0 edges — semantic IDs in RFDB use `grafema://` URI format with `#` fragments, but code was splitting by `->` (legacy compact format). Now correctly parses URI to extract file paths.
- fix(orchestrator): non-JS resolvers (Haskell, Rust, etc.) silently producing 0 edges — `load-context` protocol not supported by these daemons. Now passes nodes directly in resolve commands.
- fix(profiler): numeric values in JSONL had trailing stray quote due to raw string formatting bug

## [0.3.11] - 2026-03-16

### Highlights

- Parallel sharded resolution — fixes crash on 14K-file JS projects where 6.7M resolve nodes exceeded the 100MB frame limit

### Features

- feat(orchestrator): two-phase parallel sharded resolution for JS/TS — per-file resolvers (same-file-calls, js-local-refs, runtime-globals, builtins) run in parallel via tokio::join!, each sharded across N workers; global resolvers (imports, cross-file-calls, property-access) share export context loaded once into all workers
- feat(orchestrator): automatic worker pool sizing — min(7, available_cpus - 1) with 200MB frame limit and 300s timeout
- feat(resolve): stateful context protocol — Haskell daemon supports load-context/clear-context commands for accumulating declaration/export nodes across multiple chunks, enabling sharded resolution without sending 2GB in one frame
- feat(orchestrator): WorkerHandle acquire/release API and send_to_all for broadcasting context to all pool workers

## [0.3.10-beta] - 2026-03-15

### Features

- feat(orchestrator): unified streaming double-buffer for ALL languages — analysis and RFDB ingestion run in parallel via bounded mpsc channel (batch size 20). All languages share one channel, producing results concurrently while consumer batches and commits to RFDB. Eliminates OOM on 14K+ file codebases.
- refactor(orchestrator): extract `analyze_single_js_file()` for shared per-file logic; JS/TS streams per-file, other languages stream per-pool-batch

## [0.3.9-beta] - 2026-03-15

### Bug Fixes

- fix(orchestrator): 120s per-file timeout — daemon worker killed and respawned if stuck, pipeline no longer hangs indefinitely
- fix(orchestrator): per-file progress logging — `[N/M] Done Xms`, `SLOW` warnings for files >5s, parse failures with timing
- fix(ci): 11 missing Haskell analyzer binaries now built in CI (Python, Swift, Obj-C, Apple, BEAM, Go/Java/Kotlin resolvers)
- fix(cli): detect languages from config and pre-download matching analyzer binaries before spawning orchestrator

## [0.3.8-beta] - 2026-03-15

### Features

- feat(rfdb): `RFDB_VERBOSE=1` request logging — every request logged with operation name and timing (`[rfdb] CommitBatch 42ms`)
- feat(rfdb): internal process logging for commitBatch (node/edge add/remove counts, file count, flush mode) and queryNodes (node count or chunk count for streamed responses)
- feat(rfdb): exhaustive operation name coverage — all 50+ Request variants now have proper names instead of falling through to "Other"
- feat(cli): `grafema server start --foreground` now uses `RFDB_VERBOSE=1` instead of useless `RUST_LOG` (rfdb-server has no tracing/env_logger)

## [0.3.6-beta] - 2026-03-15

### Bug Fixes

- fix(rfdb): remove O(N×E) `get_incoming_edges` loop in `handle_commit_batch` — orphaned incoming edges now filtered at query time by tombstone checks, cleaned up by compaction
- fix(orchestrator): streaming protocol mismatch — `query_nodes_by_type` now reads all streaming frames until `done=true`, preventing deadlock on large codebases (>100 nodes per query)
- feat(cli): lazy-download orchestrator binary if missing (matches existing analyzer pattern)
- chore(config): include Elixir/Erlang sources in self-analysis (511 files, was 490)
- feat(cli): `grafema server start --foreground` for debug logging during analysis
- chore: switch license from Apache-2.0 to FSL-1.1-Apache-2.0

## [0.3.5-beta] - 2026-03-15

### Highlights

- **Streaming analysis pipeline** — AST results are now freed after RFDB ingestion instead of being held through the entire resolution phase. On 16k-file projects this eliminates swap thrashing that caused analysis to hang.
- **Batched RFDB ingestion** — Files are committed in batches of 500, balancing round-trip overhead vs memory usage.
- **linux-arm64 support** — Full binary support across all platforms including native ARM64 Linux.
- **Multi-language init** — `grafema init` now configures all 11 supported languages by default, not just JS/TS.

### Bug Fixes

- fix(orchestrator): `c_char` type portability for ARM Linux (`i8` on x86 vs `u8` on ARM)
- fix(orchestrator): streaming pipeline — drop AST results after RFDB ingestion
- fix(orchestrator): batched ingestion with `INGEST_BATCH_SIZE=500` and deferred indexing
- fix(init): support all 11 languages, remove `src/` prefix assumption
- fix(ci): Haskell build for linux-arm64 (native `ubuntu-24.04-arm` runner)
- fix(ci): macOS x64 runner deprecation (`macos-13` → `macos-13-large`)
- fix(npm): `postinstall.js` chmod for platform binaries (EACCES on Linux)
- fix: sync pnpm-lock.yaml with platform package versions

## [0.3.0-beta] - 2026-03-13

159 commits, 37 merged PRs since v0.2.13-beta.

### Highlights

- **Unified `grafema` package** — `npm install grafema` gives you CLI, MCP server, and platform binaries in one install. Replaces the old `@grafema/cli` + `@grafema/mcp` split.
- **Cypher query language** (REG-255) — Full Cypher implementation in RFDB: hand-written recursive descent parser, pull-based Volcano executor, rule-based planner, 96 tests. TypeScript client, CLI (`grafema cypher`), and MCP integration.
- **6 new languages** — Java (REG-613), Kotlin, Python (REG-659), Go (REG-661), C/C++ (libclang FFI), PHP (resolve-only). Each with parser, analyzer, and cross-file resolver.
- **CoreV3 engine** — Haskell-based per-file analyzers + Rust orchestrator replace the TypeScript CoreV2 engine. All languages analyzed through unified Haskell pipeline.
- **Notation DSL** — Compact code representation with archetype operators (`o-` depends, `>` calls, `<` reads, `=>` writes, `>x` throws). 10-20x token savings vs reading source. Budget system, depth levels, fold engine.
- **Knowledge Base** (REG-626–630) — KB schema with SESSION/DECISION/FACT nodes. Git history ingestion (churn, co-change, ownership). Semantic address rebinding for cross-DB references. MCP tools: `add_knowledge`, `query_knowledge`, `query_decisions`.
- **Human-first CLI** — `grafema tldr` (file overview), `grafema wtf` (backward dataflow), `grafema who` (callers), `grafema why` (KB decisions).

### RFDB (graph database)

- **REG-255**: Cypher query language — parser, AST, Volcano executor, planner, CypherQuery protocol message
- **RFD-44**: Hash join optimization for Datalog evaluator
- **RFD-44**: Edge-type index in shards — `get_edges_by_type` on GraphStore trait, lazy index in Shard + MultiShardStore
- **RFD-44**: Use edge-type index in Datalog `eval_edge` + `eval_incoming`
- **RFD-36**: Performance — remove `count_nodes_by_type` full scan, remove mmap→Vec copy in segment readers, remove `get_all_edges()` N+1 pattern, push down bindings in Datalog `eval_derived` (P0)
- **RFD-46**: Engine-level cursor abstraction for streaming and pipelined Datalog
- **RFD-45**: Server-side query timeout, cancellation, and iteration limits for Datalog
- **RFD-33**: `by_name` inverted index in L1 compaction
- **RFD-49**: Optimize negative joins for dst-position variables
- **RFD-48**: `attr()` finds first-class node fields and extra analyzer properties
- Server-side substring matching for `find_by_attr` name/file fields
- `string_contains` Datalog predicate
- Wildcard `_` support in Datalog `edge`/`incoming`/`node` predicates
- Per-shard lifecycle diagnostics in `GetStats`
- Removed dead V1 engine, FFI, and storage layers

### Languages

- **REG-613**: Java — parser (tree-sitter), analyzer (9 rule modules), resolver, orchestrator integration
- Kotlin — parser, analyzer (9 rule modules), resolver, cross-language resolution
- **REG-659**: Python — in-process parser, analyzer (9 modules incl. UnsafeDynamic), resolver
- **REG-661**: Go — parser, analyzer (5 rule modules), resolver, orchestrator integration
- C/C++ — libclang FFI parser, Haskell analyzer (15 rule modules, 30 node types, 22 edge types), resolver
- PHP — cross-file resolver with type inference and call resolution (no parser/analyzer)
- **REG-653**: Haskell local refs resolver for same-file declarations
- **REG-653**: JS/TS local refs resolver + same-file calls + property access resolver
- **REG-618**: Cross-package import resolution (`@scope/pkg` → workspace package)
- PROPERTY_ACCESS cross-file resolver — READS_FROM edges for namespace import accesses

### Analysis Engine (CoreV2 → CoreV3)

CoreV2 (TypeScript declarative walker) was intermediate — shipped these improvements before CoreV3 (Haskell analyzers + Rust orchestrator) replaced it entirely:

- **#161**: CoreV2Analyzer replaces JSASTAnalyzer as sole TS analysis engine
- Domain plugin system: `DomainPlugin` interface, `walkFile` hook, `ExpressPlugin`
- **REG-573**: PROPERTY_ASSIGNMENT nodes for object properties and mutations
- **REG-596**: EXTENDS/IMPLEMENTS edges for ClassExpression
- **REG-597**: ASSIGNED_FROM edges for class property and enum member initializers
- **REG-598**: PROPERTY_VALUE edge for non-shorthand Identifier object values
- **REG-599**: ASSIGNED_FROM edges for TS type assertion expressions
- **REG-595**: EXPORT(default) → exported value via EXPORTS edge
- **REG-560**: `isAwaited` metadata on CALL nodes
- ArgumentParameterLinker — link call arguments to function parameters
- `argValues` metadata on CALL nodes
- **REG-590**: Resolve callback invocations via `resolveCallbackCalls`

CoreV3 (current architecture):

- Haskell per-file analyzer with REFERENCE/EXPRESSION nodes
- Rust orchestrator coordinates all language analyzers via IPC
- Per-language Haskell analyzers (JS/TS, Rust, Java, Kotlin, Python, Go, C/C++, Haskell)

### Dataflow & Tracing

- **REG-576**: CALL_RETURNS edges and trace through function calls
- **REG-574**: `traceValues` and `DataFlowValidator` follow conditional edges
- JS analyzer dataflow improvements — gauntlet fixture 119/119
- 6 backward trace heuristics in `trace_dataflow` MCP handler
- Shared BFS dataflow tracing + narrative renderer (module-grouped, operator-annotated)
- **REG-594**: ASSIGNS_TO edges for non-this object property assignments

### Knowledge Base

- **REG-626**: KB schema, parser, KnowledgeBase class, MCP tools
- **REG-627**: Semantic address rebinding for cross-DB references
- **REG-628**: Git history ingestion — churn, co-change, ownership, archaeology queries
- **REG-629**: Subtype/scope fields on KB nodes, MCP handler tests
- **REG-630**: Extraction runbooks, skill, KB-first exploration workflow

### Notation DSL

- Notation engine — render graph as compact visual notation with archetype operators
- Lambda context resolution — replace `<arrow>` with meaningful names
- Fold engine — compress repetitive siblings at depth 2
- Depth 3 (exact) support, archetypes reordered input→output
- CLI `describe` command, `get_documentation` topic for notation
- Budget system (default 7 lines per group)

### CLI & MCP

- Unified `grafema` npm package with platform-specific optional dependencies
- CLI commands: `tldr`, `wtf`, `who`, `why`, `doctor`, `overview`, `setup-skill`
- `grafema init` generates minimal config compatible with Rust orchestrator
- `grafema doctor` checks binary availability (4-level search: env, monorepo, PATH, ~/.local/bin)
- MCP `describe` tool returns DSL notation
- Agent Skill auto-installed by `grafema init`
- 35 orphaned node Datalog guarantees for graph quality validation

### Orchestrator

- Source hash verification for stale binary detection
- All resolvers mandatory, expanded resolve node types
- C/C++ parser via libclang FFI + pipeline integration
- Cross-package import resolution
- Function-has-contains guarantee
- CONTAINS edges for expression/arrow functions

### Bug Fixes

- **RFD-48**: Datalog `attr()` predicate works correctly for `name`, `file`, `source` attributes
- `grafema init` config format — generates minimal config (was using old phased plugin map)
- `grafema init` config paths — `root: ".."` for correct resolution from `.grafema/` directory
- `find_calls` MCP handler correctly filters by function name
- `find_nodes`/`get_file_overview` filter fixes
- Return raw bindings for non-node-ID Datalog results instead of dropping them
- Preserve property key names in HAS_PROPERTY edges (REG-573)
- Remove stale npm deps from js-analyzer package.json
- CONTAINS emission centralized in `emitNode`, star re-export resolution

### Breaking Changes

- **Package rename**: Install `grafema` instead of `@grafema/cli`. The old package still works but is deprecated.
- **Engine change**: CoreV3 (Haskell analyzers + Rust orchestrator) replaces the TypeScript CoreV2 engine.
- **Config format**: `grafema init --force` to regenerate. Old phased plugin configs are not compatible with the Rust orchestrator.
- **Binary requirement**: Rust binaries (orchestrator + RFDB server) are now required. Included in platform packages.

---

## [0.2.13-beta] - 2026-03-01

### Highlights

- **core-v2 declarative AST walker** — New declarative analysis engine (REG-579) that replaces the imperative GraphBuilder. Uses edge-maps, typed visitors, and deferred scope lookups. Integrated into CLI/MCP via `--engine v2` flag. Coverage: 385/591 golden constructs (65%).
- **lang-spec package** — Automated language specification pipeline with JS corpus output for systematic language coverage tracking.
- **Redis domain support** — LibraryRegistry architecture for pluggable library-specific analysis, starting with Redis.
- **RFDB flock locking** — Advisory file locks on database directories prevent concurrent corruption (RFD-43).

### Features

- **REG-579**: Integrate core-v2 declarative AST engine into CLI/MCP pipeline via `--engine v2` flag
- **REG-579**: Universal LiteralHandler + NullLiteral fix + additive commit support
- **REG-579**: Add FunctionExpression support, fix RETURNS edge direction, enable CALLS resolution
- **REG-571, REG-583**: DERIVES_FROM edges for class inheritance + runtime-typed builtin nodes
- **REG-569**: EXPORTS edges from EXPORT nodes to exported entities
- **REG-554**: Index `this.property = value` as PROPERTY_ASSIGNMENT nodes
- Add ELEMENT_OF and KEY_OF data flow edges (core-v2)
- Add HAS_MEMBER edge type for class members (core-v2)
- Resolve monorepo package imports via packageMap (core-v2)
- Lang-defs builtin resolution + OptionalMemberExpression fix + receiver inference (core-v2)
- Add lang-spec pipeline package and JS corpus output
- Add Redis domain support with LibraryRegistry architecture
- Add ExportEntityLinker to dogfooding enrichment pipeline
- Add GraphDataError guard for CALL node end positions
- Add PID file validation in startRfdbServer (RFD-43)
- Add flock advisory lock on database directory (RFD-43)

### Bug Fixes

- **REG-579**: Batch 1 matching improvements — golden coverage 384 to 385/591
- **REG-570**: Add ASSIGNED_FROM edges for class field initializers
- **REG-567**: Remove isNewExpr from shouldBeConstant in ASTWorker parallel path
- **REG-562**: Skip class field arrow functions in FunctionVisitor (deduplication fix)
- **REG-550**: Store correct column in PARAMETER nodes
- **REG-549**: EXPORT named specifiers store per-name column instead of column=0
- Fix find_calls MCP handler ignoring name parameter + add agent instructions
- Filter cycle and duplicate nodes from explorer tree
- Add endLine/endColumn to TaggedTemplateExpression CALL nodes
- Add Phase 1a same-line containment for IMPORT specifiers (VS Code)

### Refactoring

- **REG-579**: Unify parallel/sequential AST analysis paths
- **REG-460**: Extract JSASTAnalyzer.ts from 4,739 to 855 lines

### Infrastructure

- Add Nodes in File debug panel + skills and scripts (VS Code)

---

## [0.2.12-beta] - 2026-02-18

### Features

- **REG-491**: CONTAINS edges from scope to CONSTRUCTOR_CALL nodes — constructor calls are now part of the scope containment graph
- **RFD-42**: Client-side RFDB version validation on connect — CLI detects incompatible rfdb-server versions early with a clear error message
- **RFD-40**: `grafema server restart` command, unified RFDB server spawn utility, `pnpm rfdb:*` scripts for development
- **RFD-41**: Cargo.toml version auto-synced by release script and CI

### Bug Fixes

- **REG-489**: Protect MODULE nodes from cross-phase deletion in commitBatch — modules created during INDEXING were silently deleted when ANALYSIS committed batch updates for the same file
- Fix specifier-level type imports (`import { type X } from '...'`) — type-only specifiers now correctly propagate importKind
- Resolve `.js→.ts` imports and propagate importKind for type-only imports

### Performance

- **REG-487**: Deferred RFDB indexing eliminates O(n²) index rebuilds during bulk analysis — indexes are now built once after all data is loaded
- **REG-488**: Analysis progress line shows file count instead of misleading service count

### Infrastructure

- Extract MLA workflow, agent personas, and dogfooding guide into `_ai/` directory

## [0.2.11] - 2026-02-17

### Performance

- **JSASTAnalyzer**: Per-module batch commits instead of buffering entire ANALYSIS phase — prevents RFDB connection timeouts on large codebases by writing incrementally during analysis

## [0.2.10] - 2026-02-17

### Bug Fixes

- **@grafema/rfdb**: Republish with fresh prebuilt binaries — v0.2.8/0.2.9 shipped stale rfdb-server binaries missing CommitBatch support
- **ANALYSIS phase**: Plugin applicability filter silently skipped all plugins in global context — REG-482 filter read `manifest.service` (singular) but REG-478 changed ANALYSIS to use `manifest.services[]` (plural), causing empty dependency set and zero graph output
- **release.sh**: Fixed cwd bug — used relative paths for `require()` after `cd` into package directory

## [0.2.9] - 2026-02-17

### Features

- **REG-485**: Interface-aware CHA (Class Hierarchy Analysis) fallback for method call resolution — when precise type resolution fails, the resolver finds all classes implementing the interface and creates CALLS edges to matching methods

### Performance

- **REG-478**: Run ANALYSIS phase globally instead of per-service — eliminates redundant re-analysis when multiple services share files
- **REG-479**: Scope queryNodes calls by file/name in ExpressResponseAnalyzer
- **REG-480**: Scope queryNodes calls by file in DatabaseAnalyzer and SQLiteAnalyzer
- **REG-481**: Scope queryNodes calls in ServiceLayerAnalyzer and GraphBuilder
- **REG-482**: Skip irrelevant ANALYSIS plugins based on service dependencies — plugins that don't match the service's technology stack are no longer loaded
- **REG-483**: Eliminate redundant GraphBuilder buffer layer via sync batch API — removes double-buffering overhead, uses RFDB's synchronous addNodes/addEdges directly

### Bug Fixes

- **RFD-39**: Deduplicate node_count/edge_count after RFDB flush — counts no longer inflate after memory-triggered compaction
- Seed all enrichers in propagation queue to prevent skipping enrichment passes
- Release script npm auth fix — copy .npmrc.local for pnpm publish

### Tests

- Cross-platform deterministic graph snapshots
- Deep-sort nested object keys in snapshot comparison

## [0.2.8] - 2026-02-16

### Bug Fixes

- **CommitBatch chunking**: Large codebases (4k+ modules) caused ECONNRESET during analysis — a single CommitBatch message exceeded the server's 100MB limit (1.1GB observed). `RFDBClient.commitBatch()` now automatically splits into 10k-item chunks, with the first chunk handling atomic file replacement and subsequent chunks being additive only.

## [0.2.7] - 2026-02-16

### Bug Fixes

- **Progress display**: Show service-level progress (e.g., "50/767 services | auth-service") during indexing/analysis instead of confusing module counts that were overwritten per-service DFS run

### Known Issues

- **RFD-39**: RFDB `node_count()`/`edge_count()` report inflated numbers after memory-triggered flush (data is correct, only counts are wrong). Fix tracked separately.

## [0.2.6-beta] - 2026-02-16

### Highlights

- **RFDB v2 — Complete storage engine rewrite** — 23,800 lines of new Rust code across 6 milestones and 25 tasks. Columnar segment format with zone maps and bloom filters, manifest-based snapshot chain for incremental analysis, directory-based sharding, tombstones with atomic batch commit, LSM-style background compaction, and adaptive resource tuning. This is a ground-up rewrite of the graph database, not an incremental update.
- **Enrichment pipeline integration** — Orchestrator now uses batch protocol with virtual shards, dependency-driven propagation, and post-enrichment guarantee checking — all wired through the new RFDB v2 storage layer.
- **Semantic IDs v2** — Scope-aware format (`file->TYPE->name[in:parent]`) for precise node identification across files.
- **Orchestrator decomposition** — 800+ line monolith split into focused modules (GraphInitializer, DiscoveryManager, GuaranteeChecker, ParallelAnalysisRunner).
- **Infrastructure type system** — Foundation for infrastructure-as-code analysis (Kubernetes, Terraform, Docker).

### RFDB v2 Storage Engine (Rust)

Complete rewrite of the graph database. 61 files changed, 23,800 lines added.

**M1 — Foundation:**
- **RFD-1**: Immutable columnar segment format with zone maps and bloom filters
- **RFD-3**: Client request IDs for concurrent request matching
- **RFD-4**: Semantic ID v2 wire format (scope-aware)

**M2 — Storage Engine:**
- **RFD-5**: Manifest + snapshot chain for incremental analysis
- **RFD-6**: Single-shard read/write with columnar storage
- **RFD-7**: Multi-shard storage layer with parallel fan-out queries

**M3 — Incremental Core:**
- **RFD-8**: Tombstones + atomic batch commit protocol
- **RFD-9**: Client batch API (CommitBatch wire command)
- **RFD-10**: Client snapshot API types and methods

**M4 — Integration Gate:**
- **RFD-11**: Wire protocol v3 with polymorphic `dyn GraphStore` backend
- **RFD-12**: Native semantic ID wire format (v3 protocol)
- **RFD-13**: Streaming response support for large result sets
- **RFD-14**: Integration gate validation — equivalence tests, crash recovery, stress tests

**M5 — Enrichment Pipeline:**
- **RFD-15**: Enrichment virtual shards for surgical edge deletion by file context
- **RFD-16**: Orchestrator batch protocol — PhaseRunner, runPluginWithBatch, delta-driven selective enrichment
- **RFD-17**: Queue-based enrichment dependency propagation with consumer index
- **RFD-18**: Post-enrichment guarantee checking with selective filtering
- **RFD-19**: Enrichment pipeline integration tests and benchmark

**M6 — Performance:**
- **RFD-20**: LSM-style background compaction — L1 segments, inverted indexes, global index for O(log N) lookups
- **RFD-21**: Adaptive resource tuning — auto-detect CPU, memory, disk type; tune write buffers, compaction parallelism, prefetch strategy
- **RFD-22**: Comprehensive benchmark suite — 16 groups (node/edge read/write, traversal, mutation, maintenance), memory profiler, bench report tool

**Additional:**
- **RFD-27**: Fix parse_query to reject unconsumed input
- **RFD-28**: Unified `executeDatalog` endpoint with auto-detection (query vs rule)
- **RFD-29**: Upsert semantics for edges — EdgeWriteOp/UpsertStats types
- **RFD-31**: Optimize v2 find queries, deprecate AttrQuery.version

### Architecture

- **REG-462**: Decompose Orchestrator into GraphInitializer, DiscoveryManager, GuaranteeChecker, ParallelAnalysisRunner
- **REG-463**: Split MethodCallResolver.ts into focused modules
- **REG-464**: Migrate semantic IDs to v2 scope-aware format
- **REG-368**: Split NodeFactory into domain-specific factories (CoreFactory, InfraFactory, etc.)
- **REG-461**: Decompose MCP handlers.ts into domain modules
- **REG-422/423**: Extract 10 domain builders from GraphBuilder.ts, inline handler classes
- **REG-430**: Remove dead HTTPConnectionEnricher import
- **REG-239**: Extract named constants for BFS depth limits

### New Capabilities

- **REG-259**: Package coverage tracking via PackageCoverageValidator
- **REG-363**: Infrastructure type system — InfraResourceMap and InfraAnalyzer base class for IaC analysis
- **REG-242**: Warn about unknown Datalog predicates in `--raw` queries
- **REG-432**: Socket connection analysis (Unix/TCP)
- **REG-371/374/375/376**: Branded node contracts for Rust, Database, ServiceLayer, External nodes

### Bug Fixes

- **REG-445**: Restore CLI query functionality broken by RFDB v3 semantic ID format
- Fix streaming desync and semanticId stripping in RFDB client
- Skip edges with unknown source instead of aborting batch (rfdb-server)
- Clear v2 tombstones when records are re-added
- Upsert v2 edge metadata for duplicate edge keys
- Preserve `exported` field in v2 type conversion

### Documentation

- **REG-361**: Audit and update documentation across all packages (8 READMEs updated)
- MLA workflow v2.1 — add Dijkstra plan verifier, split auto-review into 4 perspectives
- Define Paid-Ready quality bar (REG-75)

### Infrastructure

- **REG-241**: Code quality improvements in CLI query.ts
- CI: Fix self-hosted runner concurrency, switch to corepack, return to ubuntu-latest

---

## [0.2.5-beta] - 2026-02-09

### Highlights

- **Declarative plugin ordering** — Replace magic priority numbers with `dependencies: [...]` (topological sort)
- **Batch IPC** — 10-17x speedup in analysis phase by eliminating N+1 graph calls
- **MCP onboarding** — AI agents get step-by-step instructions via MCP Prompts protocol
- **Plugin introspection** — Query `grafema:plugin` nodes to discover plugin capabilities without reading source

### Plugin Architecture

- **REG-367**: Replace `priority` with declarative `dependencies` for plugin ordering. Topological sort with cycle detection
- **REG-386**: Expose plugin metadata as `grafema:plugin` graph nodes — phase, dependencies, created types all queryable
- **REG-388**: Batch IPC optimization across all analysis plugins — collect nodes/edges, flush once instead of N+1 calls

### Data Flow

- **REG-270**: YIELDS/DELEGATES_TO edges for generator functions (`yield`, `yield*`)
- **REG-288**: Track UpdateExpression modifications (`i++`, `--count`) as first-class graph nodes
- **REG-392**: FLOWS_INTO edges for non-variable values in array mutations (literals, calls, expressions)

### CLI & DX

- **REG-199**: `--log-file` option for `grafema analyze` — write structured logs to file
- **REG-350**: Live progress UI during analysis — current phase and plugin name
- **REG-347**: Loading spinner for slow graph queries, auto-start server fix
- **REG-385**: Fix CLI failure in nvm environments — use `process.execPath` instead of `'node'`
- **REG-353**: VS Code "Copy Tree State" command for debugging
- **REG-348**: VS Code setting for custom rfdb-server binary path

### Onboarding

- **REG-173**: Instruction-driven onboarding via MCP Prompts — AI agents receive step-by-step setup guide

### Quality & Testing

- **REG-195**: Code coverage with c8 and CI integration
- **REG-149**: ESLint type safety — promote warn to error, fix all `as any` / `as unknown` casts
- **REG-198**: Enforce branded nodes in GraphBackend.addNode — no more raw object literals
- **REG-154**: Fix 4 skipped test files, migrate ExpressResponseAnalyzer to NodeFactory
- **REG-390**: Fix 293 test failures after multi-branch merge
- **REG-393**: Directory index resolution regression test

### Enrichment & Analysis

- **REG-306**: Extract shared expression handling in JSASTAnalyzer
- **REG-323**: Byte offset for HANDLED_BY edge matching (precision fix)
- **REG-351**: Reduce strict mode false positives — expand isExternalMethod detection
- **REG-354**: Library coverage tracking — report which libraries are called and suggest analyzers
- **REG-311**: Track async error patterns (Promise.reject, reject callback)

### Infrastructure

- **REG-67**: Release workflow with CI/CD — stable branch, semantic versioning, GitHub Actions
- **REG-76**: Multi-root workspace support
- **REG-349**: Fix esbuild CJS bundling (RustAnalyzer lazy load)
- **REG-243**: Deduplicate diagnostic category mappings
- **REG-320**: Extract shared `resolveModulePath` utility
- **REG-378**: Ensure `grafema analyze` exits cleanly

### Bug Fixes

- **REG-322**: HANDLED_BY edge finds correct handler (byte offset matching)
- **REG-385**: CLI init fails when Node.js not in PATH (nvm)

---

## [0.2.4-beta] - 2026-02-05

### Infrastructure

- **Shared binary finder**: Unified `findRfdbBinary()` utility across CLI, MCP, VS Code extension
- **Linux support**: Added `~/grafema` and `/home/vadimr/grafema` dev paths for Linux
- **Explicit server lifecycle**: `grafema server start/stop/status` commands
- **Binary path config**: Support `server.binaryPath` in config.yaml and `--binary` flag
- **Release skill**: Added `/release` skill for npm publishing workflow

### Known Issues

- VS Code extension build broken (REG-349: RustAnalyzer top-level await + CJS)

---

## [0.2.3-beta] - 2026-02-04

### Bug Fixes

- Fixed `--version` showing hardcoded 0.1.0 instead of actual version
- Ported custom plugin loading from MCP to CLI (`.grafema/plugins/`)
- Added `~/.local/bin/rfdb-server` fallback for user-built binaries

---

## [0.2.0-beta] - 2026-02-04

### Highlights

- **Cross-service tracing** - Click on a frontend fetch call, trace to backend handler
- **VS Code Extension** - Interactive graph navigation (Cmd+Shift+G)
- **Promise dataflow** - Track data through resolve() callbacks
- **Column-precise locations** - All nodes have exact column positions

### Data Flow

- **REG-252**: Cross-service value tracing (frontend <-> backend)
- **REG-334**: Promise dataflow tracking through resolve() calls
- **REG-333**: Support wrapper functions (asyncHandler, catchAsync)
- **REG-263**: Track return statements (RETURNS edge)
- **REG-229**: Argument-to-parameter binding
- **REG-225**: Cross-file imported function call resolution
- **REG-232**: Re-export chain resolution

### Control Flow

- **REG-267**: Control flow layer (BRANCH, LOOP, TRY_BLOCK nodes)
- **REG-272**: Loop variable declarations (for...of/for...in)
- **REG-268**: Dynamic imports with isDynamic flag
- **REG-274**: IfStatement tracking
- **REG-275**: SwitchStatement tracking

### Graph Improvements

- **REG-337/339**: Column location for all physical nodes
- **REG-313**: Nested paths in attr() predicate
- **REG-315**: attr_edge() predicate for edge metadata
- **REG-250**: Fixed attr() to return attribute values
- **REG-251**: Fixed edge() predicate

### Enrichment

- **REG-248**: Router mount prefix resolution
- **REG-226**: External package call resolution
- **REG-309**: Scope-aware variable lookup
- **REG-269**: Transitive closure captures
- **REG-262**: Method call usage edges

### Query UX

- **REG-307**: Natural language query support
- **REG-253**: Query by arbitrary node type
- **REG-249**: http:request nodes searchable

### Validation

- **REG-261**: Broken import detection
- **REG-227**: Updated CallResolverValidator

### Bug Fixes

- **REG-322**: HANDLED_BY edge finds correct handler
- **REG-321**: MAKES_REQUEST links to CALL node
- **REG-318**: MountPointResolver module matching
- **REG-308**: Server-side file filtering
- **REG-247**: WorkspaceDiscovery entrypoint passing

---

## [0.1.1-alpha] - 2025-01-25

### Features

- **REG-174**: Add `services` config field for explicit service definitions in monorepos
  - Bypass auto-discovery by specifying services manually in config.yaml
  - Support custom entrypoints per service
- **REG-152**: Add FLOWS_INTO edges for `this.prop = value` patterns
- **REG-153**: Use semantic IDs for PARAMETER nodes (breaking change for existing graphs)
- **REG-169**: Add `grafema coverage` command to CLI and MCP
- **REG-176**: Add `--entrypoint` option to analyze command
- **REG-189**: Add `grafema server start/stop/status` commands
- **REG-171**: Add WorkspaceDiscovery plugin for npm/pnpm/yarn/lerna workspaces
- **REG-170**: Unify config format from JSON to YAML
- **REG-111**: Add branded type system for NodeFactory (type safety improvement)

### Bug Fixes

- **REG-174**: Fix JSModuleIndexer to use `metadata.entrypoint` instead of `service.path`
  - This was causing 0 modules to be indexed for config-provided services
- **REG-181**: Preserve RFDB server between CLI and MCP sessions
  - No more "server not running" errors when switching between tools
- **REG-192**: Properly type RFDB query results
- **REG-194**: Remove type-unsafe `as any` casts for discovery config
- **REG-175**: Add discovery plugin support to CLI analyze command
- **REG-187**: Use semantic ID parsing for trace scope filtering
- **REG-180**: Correct trace_alias parameter name
- **REG-122**: Replace non-null loc assertions with defensive checks

### Improvements

- **REG-191**: Remove dead ServiceDetector code
- **REG-159**: Add concurrent safety to MCP analyze_project handler
- **REG-158**: Add E2E test for init → analyze → query workflow
- **REG-157**: Standardize error messages across CLI commands
- **REG-150/REG-151**: Implement reportIssue() for VALIDATION plugins
- **REG-140**: Remove deprecated stableId field from node types
- **REG-148**: Migrate all plugins from console.log to structured Logger
- **REG-139**: Centralize ID generation with IdGenerator service
- **REG-141**: Remove legacy scopeCtx parameter from analyzeFunctionBody
- **REG-144**: Add variable lookup cache in bufferArrayMutationEdges (performance)

### New Capabilities

- **REG-95**: Add ISSUE node type for plugin-detected problems
- **REG-117**: Track nested array mutations (`obj.arr.push`)
- **REG-134**: Create PARAMETER nodes for class constructor/method parameters
- **REG-135**: Resolve computed property names in `obj[key]` patterns
- **REG-145**: Pass Logger through PluginContext for controllable verbosity
- **REG-147**: Add error reporting for parse failures in JSModuleIndexer
- **REG-146**: Update GitPlugin to use GrafemaError

---

## [0.1.0-alpha.5] - 2025-01-20

Initial alpha release with core functionality.
