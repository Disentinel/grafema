# Grafema

Grafema turns your codebase, infrastructure, knowledge, and workflows around it — into one queryable graph.
For humans and AI.

---

We treat code as text. But text is just a form. 

What actually matters when you write code is the system you have in your head — its **structure**. Entities, invariants, limitations. Goals and purpose.
And how all these things relate to each other.

Software is naturally an executable graph — and so is everything around it: your services, your decisions, your team's knowledge. Grafema uses compiler-grade AST parsers — containing years of community-shared knowledge for each language — to excavate the deepest possible model of your system, and turn it into a transparent, queryable, enrichable map that grounds your understanding of it.

We refuse to accept *"that's impossible to analyze statically."* You can read code and understand it — you have a mental model in your head. So it's a matter of good enough heuristics. Human brains are literally built on this.

It's not magic and won't cover 100% of your system on day one. There will be gaps and *"Here be dragons"* signs. You will slay these dragons one by one — extend analysis with your own rules, fill up the knowledge base. And if you contribute, you slay one for everyone.

Thinking in graphs is not easy.
But once it clicks - you stop reading code and just navigate the system.
And your AI minions too.

Welcome to the party!

---

> Licensed under [FSL-1.1-Apache-2.0](./LICENSE) — free to use, source available, converts to Apache 2.0 after 2 years. [Details](./LICENSING.md)

[![CI](https://github.com/Disentinel/grafema/actions/workflows/ci.yml/badge.svg)](https://github.com/Disentinel/grafema/actions/workflows/ci.yml)
[![Coverage](https://img.shields.io/endpoint?url=https://gist.githubusercontent.com/Disentinel/fb8ae29db701dd788e1beaffb159ffef/raw/grafema-coverage.json)](https://github.com/Disentinel/grafema/actions/workflows/ci.yml)
[![Benchmark](https://img.shields.io/endpoint?url=https://gist.githubusercontent.com/Disentinel/fb8ae29db701dd788e1beaffb159ffef/raw/rfdb-benchmark.json)](https://github.com/Disentinel/grafema/actions/workflows/benchmark.yml)
[![Glama](https://glama.ai/mcp/servers/Disentinel/grafema/badges/score.svg)](https://glama.ai/mcp/servers/Disentinel/grafema)

> **v0.4.1** — Early access. [Changelog](./CHANGELOG.md) | [Known limitations](./KNOWN_LIMITATIONS.md)

## Quick Start

```bash
npm install -g grafema
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

There is also a Docker image for running the MCP server (stdio) in a container — see the root [`Dockerfile`](./Dockerfile): `docker run -i --rm -v "$PWD":/workspace grafema-mcp`.

30+ MCP tools available: `find_nodes`, `find_calls`, `trace_dataflow`, `get_file_overview`, `describe`, `query_graph`, and more. The AI agent queries the graph instead of reading files — faster, cheaper, more complete.

`find_nodes` returns rich context in a single call: callers, members, parent, import/call counts. Fuzzy name matching via local embeddings means approximate queries like `find_nodes(name="PtyHostHeartbeatService")` find `HeartbeatService` even without exact match.

## Capabilities

**Analyze**
- ✅ Call graph — who calls what, across all files
- ✅ Data flow — trace values source to sink, forward and backward
- ✅ Control flow — CFG, reachability, branching paths
- ✅ Data shapes — object structure through assignment chains
- ✅ Effect propagation — transitive side-effect analysis through call graph
- ✅ Symbolic execution
- ✅ Cross-language & inter-process — service boundaries, message passing, remote calls
- ⏳ Side effect chain analysis
- ⏳ Inter-service contracts — message queue schemas, API schemas (OpenAPI, JSON Schema, gRPC)
- ⏳ Infrastructure as Code — Terraform, Kubernetes, Docker

**Query**
- ✅ CLI: `tldr`, `who`, `wtf`, `why`, `check`, `overview`
- ✅ 40+ MCP tools for AI agents (graph queries, navigation, dataflow, knowledge, git history)
- ✅ Datalog for custom structural queries
- ✅ Cypher query language
- ✅ Programmatic API (`@grafema/util`)
- ✅ HexAtlas — visual code map (2D/3D)
- ✅ VS Code extension

**Document**
- ✅ `grafema export --as docs-md` — generate human-readable docs from the live graph
- ✅ `grafema export --as openapi-3.1` — auto-generate OpenAPI for HTTP routes
- ✅ `grafema export --as mcp-schema` — JSON-RPC tool registry, directly servable by any MCP runtime
- ✅ `grafema export --as json-schema` — Draft 2020-12 schemas per FEATURE
- ✅ Intent sidecars (`_ai/intents/...`) — handwritten "when to use" + captured examples that augment autogen output
- ✅ `grafema features --duplicates` — cross-modality dedup ("which CLI commands are wrappers around the same library function as which MCP tools")

**Connect knowledge to code entities and flows**
- ✅ Knowledge base — decisions, ADRs linked to code nodes
- ✅ Effects-DB & Registry — curated database of side effects and contract mappings for popular third-party packages across ecosystems (npm, PyPI, and more)
- ⏳ Git integration — blame, churn, authorship

**Enforce your rules**
- ✅ Architectural invariants as Datalog rules
- ✅ `grafema check` — CI gate
- ⏳ Code Quality Metrics — complexity, coupling, hotspots

**Enrich with your own meaning**
- ✅ Custom node types and edges via plugins
- ✅ Library callback enricher — auto-detect MCP tools, CLI commands
- ✅ Manifest generation — API surface with effect annotations

## Language Support

| Language | Parser | Analyze | Resolve | Dataflow | Status |
|----------|--------|---------|---------|----------|--------|
| JavaScript/TypeScript | [OXC](https://oxc.rs) | full | full | full | Production |
| Rust | [syn](https://github.com/dtolnay/syn) | full | full | partial | Beta |
| Haskell | [ghc-lib-parser](https://hackage.haskell.org/package/ghc-lib-parser) | full | full | partial | Beta |
| Java | [JavaParser](https://javaparser.org) | full | full | partial | Beta |
| Kotlin | kotlin-compiler-embeddable | full | full | partial | Beta |
| Python | [rustpython-parser](https://github.com/RustPython/RustPython) | full | full | partial | Beta |
| Go | go/ast (stdlib) | full | full | partial | Beta |
| C/C++ | tree-sitter-c | full | full | partial | Beta |
| Swift | [SwiftSyntax](https://github.com/apple/swift-syntax) | full | full | - | Alpha |
| Objective-C | libclang | full | full | - | Alpha |
| Elixir/Erlang | native BEAM AST | full | full | - | Alpha |

JS/TS is the primary language with full dataflow support. Each language uses its community's canonical parser — not a generic tokenizer. `grafema init` includes all languages by default — analyzers for absent languages are simply skipped.

## CLI Commands

| Command | Question it answers | What it does |
|---------|-------------------|--------------|
| `grafema tldr <file>` | "What's in this file?" | Compact DSL overview (10-20x token savings) |
| `grafema wtf <symbol>` | "Where does this come from?" | Backward dataflow trace |
| `grafema who <symbol>` | "Who uses this?" | Find all callers/references |
| `grafema why <symbol>` | "Why is it this way?" | Knowledge base decisions |
| `grafema init` | | Initialize Grafema in a project |
| `grafema analyze` | | Build/rebuild the code graph (`--quickstart` for zero-config) |
| `grafema check` | "Are my rules still satisfied?" | Run architectural guarantees, exit 1 on violations |
| `grafema doctor` | | Check system health |
| `grafema upgrade` | | Clean stale artifacts and upgrade binaries |
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

## Benchmarks

### Analysis Performance

| Codebase | Files | Nodes | Edges | Time |
|----------|-------|-------|-------|------|
| Grafema (self) | 509 | 203K | 385K | 25s |
| BullMQ | 90 | 24K | 50K | 8s |
| microsoft/vscode | ~5,600 | 3.56M | 7.55M | 14 min |

### AI Agent Accuracy (Autoresearch)

Methodology: 30 questions sourced from real VS Code GitHub issues, scored by LLM judge. Questions span Sillito taxonomy levels L1 (finding focus) through L4 (full architecture understanding). Each question run as independent `claude -p` session with no prior context.

| Condition | Accuracy | MCP Adoption | Tokens | Detail |
|-----------|----------|-------------|--------|--------|
| Baseline (grep + read only) | 20/30 (67%) | 0% | 88K | Agent uses Grep, Read, Glob |
| Grafema (graph tools) | 23/30 (77%) | 96% | 139K | +10% accuracy, graph-guided navigation |

Grafema provides the biggest advantage on **L4 architecture questions** and **debugging/tracing** (up to +4 points per question) where structural graph queries outperform text search. On simple L1 lookups ("where is X?"), grep is often sufficient.

The evaluation harness captures full tool interaction traces including MCP tool results, reasoning chains, and fallback patterns. See [`autoresearch/`](./autoresearch/) for methodology and raw data.

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

- **RFDB** — columnar graph database optimized for code analysis workloads. Deferred indexing, L1 compaction, edge-type and by-name indexes. Includes **local embedding index** for fuzzy name search — approximate queries find structurally similar names without exact match (e.g., `PtyHostHeartbeatService` matches `HeartbeatService`). Automatic segment GC after compaction.
- **Orchestrator** — Rust binary that coordinates discovery, parsing, RFDB ingestion, and resolution across languages. Streaming pipeline frees AST memory after ingestion.
- **Analyzers** — per-language binaries (Haskell + native parsers where needed: libclang for ObjC, tree-sitter for C/C++, SwiftSyntax for Swift). Run as daemon pools with JSON-over-stdio protocol.
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

**Vadim Reshetnikov** — Senior R&D Engineer with 6+ years working in massive legacy untyped codebases with high-load, high-performance backends. Building Grafema to fight the cognitive complexity of software development and maintenance.

Grafema was born from a real pain: spending 58% of engineering time on code comprehension (per research), with no tools that actually understand code structure at scale. Type systems help — but only for typed languages. Grafema fills the gap for everything else.

- LinkedIn: [linkedin.com/in/disentinel](https://linkedin.com/in/disentinel)
- Telegram: [@vadresh](https://t.me/vadresh) — dev log, research notes, behind-the-scenes
