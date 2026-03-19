# Grafema

> Licensed under [FSL-1.1-Apache-2.0](./LICENSE) — free to use, source available, converts to Apache 2.0 after 2 years. [Details](./LICENSING.md)

[![CI](https://github.com/Disentinel/grafema/actions/workflows/ci.yml/badge.svg)](https://github.com/Disentinel/grafema/actions/workflows/ci.yml)
[![Coverage](https://img.shields.io/endpoint?url=https://gist.githubusercontent.com/Disentinel/fb8ae29db701dd788e1beaffb159ffef/raw/grafema-coverage.json)](https://github.com/Disentinel/grafema/actions/workflows/ci.yml)
[![Benchmark](https://img.shields.io/endpoint?url=https://gist.githubusercontent.com/Disentinel/fb8ae29db701dd788e1beaffb159ffef/raw/rfdb-benchmark.json)](https://github.com/Disentinel/grafema/actions/workflows/benchmark.yml)

> **v0.3.18** — Early access. [Changelog](./CHANGELOG.md) | [Known limitations](./KNOWN_LIMITATIONS.md)

Graph-driven code analysis. AI should query the graph, not read code.

Grafema builds a queryable graph from your codebase via static analysis. Instead of reading thousands of files, ask questions: "who calls this?", "where does this data come from?", "what does this file do?" — and get structured answers.

**Self-analysis:** Grafema analyzes its own 500+ file polyglot codebase (TypeScript + Haskell + Rust + Elixir) in ~25 seconds.

## Quick Start

```bash
npm install grafema
grafema analyze --quickstart
```

That's it. `--quickstart` auto-detects your project languages, generates config, and builds the graph in one command.

For more control, use the two-step flow: `grafema init` (review config) → `grafema analyze`.

### Explore your code

```bash
# What does this file do? (compact DSL overview, 10-20x smaller than source)
grafema tldr src/server.ts

# Who calls this function?
grafema who handleRequest

# Where does this data come from? (backward dataflow trace)
grafema wtf req.user

# Why is it structured this way? (knowledge base decisions)
grafema why auth-middleware
```

### Use with AI (MCP)

Add to `.mcp.json` in your project root:

```json
{
  "mcpServers": {
    "grafema": {
      "command": "npx",
      "args": ["grafema-mcp", "--project", "."]
    }
  }
}
```

For Claude Desktop (`~/Library/Application Support/Claude/claude_desktop_config.json` on macOS):

```json
{
  "mcpServers": {
    "grafema": {
      "command": "npx",
      "args": ["grafema-mcp", "--project", "/path/to/project"]
    }
  }
}
```

30+ MCP tools available: `find_nodes`, `find_calls`, `trace_dataflow`, `get_file_overview`, `describe`, `query_graph`, and more. The AI agent queries the graph instead of reading files — faster, cheaper, more complete.

## Why Grafema?

**For AI agents:** A `describe` call returns a file overview in 10-20x fewer tokens than reading the source. `find_calls` finds ALL callers across the entire codebase in one query — no grep, no missed references.

**For legacy codebases:** Grafema targets untyped/loosely-typed code (JavaScript, Python, PHP) where type systems can't help. It builds type-system-level understanding for languages that don't have types.

**For understanding:** Trace data flow from frontend `fetch()` to backend handler. Trace `res.json(data)` backward to where the data came from. Across files, across services.

## Language Support

| Language | Parse | Analyze | Resolve | Dataflow | Status |
|----------|-------|---------|---------|----------|--------|
| JavaScript/TypeScript | full | full | full | full | Production |
| Rust | full | full | full | partial | Beta |
| Haskell | full | full | full | partial | Beta |
| Java | full | full | full | partial | Beta |
| Kotlin | full | full | full | partial | Beta |
| Python | full | full | full | partial | Beta |
| Go | full | full | full | partial | Beta |
| C/C++ | full | full | full | partial | Beta |
| Swift | full | full | full | - | Alpha |
| Objective-C | full | full | full | - | Alpha |
| Elixir/Erlang | full | full | full | - | Alpha |

JS/TS is the primary language with full dataflow support. Other languages have parsers, analyzers, and cross-file resolvers via Haskell-based analysis pipeline. `grafema init` includes all languages by default — analyzers for absent languages are simply skipped.

## CLI Commands

| Command | Question it answers | What it does |
|---------|-------------------|--------------|
| `grafema tldr <file>` | "What's in this file?" | Compact DSL overview (10-20x token savings) |
| `grafema wtf <symbol>` | "Where does this come from?" | Backward dataflow trace |
| `grafema who <symbol>` | "Who uses this?" | Find all callers/references |
| `grafema why <symbol>` | "Why is it this way?" | Knowledge base decisions |
| `grafema init` | | Initialize Grafema in a project |
| `grafema analyze` | | Build/rebuild the code graph (`--quickstart` for zero-config) |
| `grafema doctor` | | Check system health |
| `grafema overview` | | High-level project stats |

## VS Code Extension

[![VS Code Marketplace](https://img.shields.io/visual-studio-marketplace/v/GrafemaLabs.grafema-explore)](https://marketplace.visualstudio.com/items?itemName=GrafemaLabs.grafema-explore)

Interactive graph navigation directly in your editor. Install from the [VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=GrafemaLabs.grafema-explore) or search "Grafema Explore" in Extensions.

- **Cmd+Shift+G** — Find graph node at cursor
- **Value Trace** — See where data comes from and flows to
- **Callers** — All call sites for the function under cursor
- **Blast Radius** — Impact analysis: what breaks if you change this?
- **Nodes in File** — All graph nodes in current file with positions
- **Explorer** — Navigate edges (incoming/outgoing) interactively

## Architecture

Grafema uses a Rust orchestrator, Haskell per-language analyzers, and a custom columnar graph database (RFDB):

```
grafema analyze → Rust orchestrator → per-language analyzers → RFDB (graph DB)
                       │                                            ↓
                       │ batched ingestion (500 files)       unix socket
                       │ streaming (ASTs freed after ingest)        ↓
                       └──────── resolution plugins ←── query layer
                                                              ↓
                            grafema tldr / MCP / CLI ← @grafema/util
```

- **RFDB** — columnar graph database optimized for code analysis workloads. Deferred indexing, L1 compaction, edge-type and by-name indexes.
- **Orchestrator** — Rust binary that coordinates discovery, parsing, RFDB ingestion, and resolution across languages. Streaming pipeline frees AST memory after ingestion.
- **Analyzers** — Haskell binaries per language (JS/TS, Rust, Java, Kotlin, Python, Go, C/C++, Swift, Elixir/Erlang). Run as daemon pools with JSON-over-stdio protocol.
- **MCP Server** — 30+ tools for AI agent integration (find_nodes, find_calls, trace_dataflow, describe, query_graph, etc.)

## Environment Variables

| Variable | Purpose |
|----------|---------|
| `GRAFEMA_ORCHESTRATOR` | Path to orchestrator binary (auto-detected) |
| `GRAFEMA_RFDB_SERVER` | Path to RFDB server binary (auto-detected) |

Normally not needed — binaries are included in the npm package. Use these when developing Grafema or using custom builds.

## Platform Support

| Platform | Status |
|----------|--------|
| macOS ARM (Apple Silicon) | Full support |
| macOS Intel (x64) | Full support |
| Linux x64 | Full support |
| Linux ARM64 | Full support |
| Windows | Not planned |

## Packages

| Package | Description |
|---------|-------------|
| [grafema](./packages/grafema) | Unified package (CLI + MCP + binaries) |
| [@grafema/cli](./packages/cli) | Command-line interface |
| [@grafema/mcp](./packages/mcp) | MCP server for AI assistants |
| [@grafema/util](./packages/util) | Query layer, config, RFDB lifecycle |
| [@grafema/types](./packages/types) | Type definitions |
| [@grafema/api](./packages/api) | GraphQL API server |

## Documentation

- [Getting Started](./docs/getting-started.md)
- [Configuration](./docs/configuration.md)
- [Known Limitations](./KNOWN_LIMITATIONS.md)
- [Datalog Cheat Sheet](./docs/datalog-cheat-sheet.md)
- [Changelog](./CHANGELOG.md)

## Requirements

- Node.js >= 18
- macOS (ARM or Intel) or Linux (x64 or ARM64)

## License

[FSL-1.1-Apache-2.0](./LICENSE) — see [LICENSING.md](./LICENSING.md) for details.

## Author

Vadim Reshetnikov
