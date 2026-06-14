# Known Limitations — Grafema v0.4.x

Honest list of what works, what doesn't, and when we plan to fix it.

## Platform Support

| Platform | Rust binaries | Haskell analyzers | Status |
|----------|--------------|-------------------|--------|
| macOS ARM (Apple Silicon) | ✅ CI builds | ✅ CI builds | Full support |
| macOS Intel (x64) | ✅ CI builds | ✅ CI builds | Full support |
| Linux x64 | ✅ CI builds | ✅ CI builds | Full support |
| Linux ARM64 | ✅ CI builds | ✅ CI builds | Full support (no Ruby — see below) |
| Windows | ❌ | ❌ | Not planned |

## Language Support

| Language | Parse | Analyze | Resolve | Dataflow | Status |
|----------|-------|---------|---------|----------|--------|
| JavaScript/TypeScript | ✅ | ✅ | ✅ | ✅ | Production |
| Rust | ✅ | ✅ | ✅ | ⚠️ | Beta |
| Haskell | ✅ | ✅ | ✅ | ⚠️ | Beta |
| Java | ✅ | ✅ | ✅ | ⚠️ | Beta |
| Kotlin | ✅ | ✅ | ✅ | ⚠️ | Beta |
| Python | ✅ | ✅ | ✅ | ⚠️ | Beta |
| C/C++ | ✅ | ✅ | ✅ | ⚠️ | Beta |
| Go | ✅ | ✅ | ✅ | ⚠️ | Alpha |
| Ruby | ✅ | ✅ | ✅ | ❌ | Alpha |
| PHP | ❌ | ❌ | ⚠️ resolve-only | ❌ | Stub |

### Ruby

- **Linux ARM64** — Ruby support is excluded from `linux-arm64` binaries. The `ruby-prism-sys` crate requires `bindgen` + `libclang` at build time, which are unavailable in the `cross` Docker image used for ARM64 cross-compilation. Ruby works on all other platforms (macOS x64/ARM64, Linux x64).
- **Dataflow** — not yet implemented for Ruby

### JS/TS Specific Gaps

- **Re-export chain resolution** — `export * from './internal'` is detected as EXPORT nodes, but following the chain to the final definition is partial. Re-export EXPORT nodes lack outgoing IMPORTS_FROM edges needed for full chain traversal. Cross-package workspace imports (`@scope/pkg`) resolve correctly.
- **Dynamic imports** — `import()` expressions are parsed but runtime resolution is inherently limited
- **Decorators** — Parsed by Babel, basic analysis, but no decorator-specific graph enrichment
- **JSX component resolution** — ReactAnalyzer exists but component-to-definition linking is partial

### Cross-Language

- **Generics/lifetimes** (Rust, Java, Kotlin) — parsed but not tracked as separate graph nodes
- **Macro expansion** (Rust) — macro invocations appear as CALL nodes, no expansion
- **Go error handling** — no dedicated ErrorFlow rule (Go's `if err != nil` pattern not tracked)
- **Go generics** — no Types rule for Go 1.18+ generics
- **PHP** — resolve-only, requires external parser to produce graph nodes first

## Graph & Query

- **Datalog `attr()` performance** — works correctly but O(n) scan. For large graphs (100K+ nodes), prefer `find_nodes` over Datalog `attr()` queries
- **Datalog joins** — complex multi-hop joins may time out on large graphs. MODULE→MODULE DEPENDS_ON is derived in Rust orchestrator, not via Datalog
- **Cross-package resolution** — works for workspace packages (`@scope/pkg` → `packages/pkg/src/index.ts`). Does NOT resolve to external `node_modules` packages

## v0.4.x Requirements

- **rfdb-server with `datalogDerive` capability required** — `grafema analyze` and `grafema resolve` will refuse a server that does not advertise `datalogDerive` in the Hello handshake (old binary, or `RFDB_DERIVE_ENGINE=off`). If you get "rfdb-server does not support datalogDerive", upgrade the `rfdb-server` binary. Run `grafema upgrade` to pull the current version.

## Binary Delivery

- **Haskell analyzers** — not included in `npm install`. Lazy-downloaded on first use to `~/.grafema/bin/`. Version-checked and re-downloaded when stale (since v0.3.15). Run `grafema upgrade` to clean stale artifacts and force-refresh all binaries.

## MCP Server

- **`report_issue` tool** — GitHub token expired, generates issue template text instead of creating issues directly
- **Tool description length** — some descriptions exceed 500 chars; behavior may vary across MCP clients

## Known Bugs

- ~~**REG-655: `get_file_overview` shows empty calls**~~ — Fixed: line-range fallback in `FileOverview.buildFunctionOverview()` now queries both `CALL` and `METHOD_CALL` nodes by file+line range when `findCallsInFunction` returns empty. TS class methods now report calls correctly.
- ~~**REG-656: Rust intra-file CALLS missing**~~ — Fixed: `rust-resolve` now runs `rust-calls` command that matches CALL nodes to same-file FUNCTION nodes by name (exact or last `::` segment).
- ~~**REG-625: JS/TS MODULE names have absolute paths**~~ — Fixed: `node.name` now stripped to relative path in `relativize_paths()` alongside `node.file` (commit `96b30173`).
- ~~**REG-652: MCP not workspace-aware**~~ — Fixed: MCP server auto-detects project root by walking up from `process.cwd()` looking for `grafema.yaml` or `.grafema/`. `--project` flag still works as an explicit override. MCP clients (Claude Code, Cursor) set CWD = workspace root when spawning the server, so no config is needed.
- ~~**RFDB stale socket**~~ — Fixed in v0.3.31: `grafema doctor` now removes a stale `rfdb.sock` on ping timeout, so a crashed server no longer blocks a clean restart (REG-1129).
- **`grafema init` config** — fixed in v0.3.0: generated config previously used phased plugin map that orchestrator couldn't parse.
