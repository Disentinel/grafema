# Known Limitations — Grafema v0.3.0-beta

Honest list of what works, what doesn't, and when we plan to fix it.

## Platform Support

| Platform | Rust binaries | Haskell analyzers | Status |
|----------|--------------|-------------------|--------|
| macOS ARM (Apple Silicon) | ✅ CI builds | ✅ CI builds | Full support |
| macOS Intel (x64) | ✅ CI builds | ✅ CI builds | Full support |
| Linux x64 | ✅ CI builds | ✅ CI builds | Full support |
| Linux ARM64 | ❌ cross-compile bug | ❌ not in CI | Planned v0.4 |
| Windows | ❌ | ❌ | Not planned |

**Linux ARM64 issue:** Rust cross-compile fails due to `c_char` type mismatch (`u8` vs `i8` on aarch64). Fixable but not blocking beta.

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
| PHP | ❌ | ❌ | ⚠️ resolve-only | ❌ | Stub |

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

## Binary Delivery

- **Haskell analyzers** — not included in `npm install`. Will be lazy-downloaded on first use (not yet implemented in v0.3.0-beta)
- **`~/.grafema/bin/`** — not yet in orchestrator's binary search path

## MCP Server

- **`report_issue` tool** — GitHub token expired, generates issue template text instead of creating issues directly
- **Tool description length** — some descriptions exceed 500 chars; behavior may vary across MCP clients

## Known Bugs

- **REG-655: `get_file_overview` shows empty calls** — TS method bodies show `calls: []` because the tool expects CALLS edges on METHOD nodes, but CoreV3 emits CALLS edges on CALL nodes. Workaround: use `find_calls` instead.
- **REG-656: Rust intra-file CALLS missing** — Rust analyzer creates FUNCTION nodes but `rust-resolve` doesn't create CALLS edges between functions in the same file. Cross-file calls work.
- **REG-625: JS/TS MODULE names have absolute paths** — MODULE node `name` field contains absolute paths instead of relative. The `file` field is correct. Cosmetic issue.
- **REG-652: MCP not workspace-aware** — MCP server connects to default `.grafema/rfdb.sock`. If RFDB server uses a different socket path (multi-workspace, worktrees), MCP tools fail. Workaround: use `--project` flag.
- **RFDB stale socket** — `grafema doctor` detects stale `rfdb.sock` after crash, but doesn't auto-clean. Run `grafema analyze` to restart.
- **`grafema init` config** — fixed in v0.3.0-beta: generated config previously used phased plugin map that orchestrator couldn't parse.
