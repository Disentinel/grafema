# CodeGraphContext (CGC) — Competitor Analysis

**Date:** 2026-02-16
**Threat level:** HIGH (7/10)
**Website:** https://codegraphcontext.github.io/
**GitHub:** https://github.com/CodeGraphContext/CodeGraphContext
**Creator:** Shashank Shekhar Singh (solo developer)
**License:** MIT
**Category:** Code graph for AI context (MCP server + CLI)

## Why This Matters

**This is a direct competitor.** Same core thesis as Grafema: build a code graph, let AI query it instead of reading raw code. Same delivery mechanism (MCP server). Same target audience (AI coding assistants + developers). Fast-growing: ~400 → 735 stars in ~1 week (Feb 2026).

## What It Is

MCP server + CLI toolkit that indexes local code into a graph database. Two modes:
1. **CLI** — direct commands for call chain analysis, dead code detection, complexity
2. **MCP Server** — connects to Cursor, Claude, VS Code for natural language queries

## How It Works

1. **Tree-sitter parsing** — extracts functions, classes, methods, parameters, imports, calls
2. **Graph construction** — stores in FalkorDB Lite (default, in-process) or Neo4j
3. **Query layer** — Cypher queries (Neo4j) or natural language via MCP
4. **Live watching** — `cgc watch` monitors file changes, updates graph in real-time

## Architecture

- **Language:** Python
- **Parser:** Tree-sitter (multi-language)
- **Database:** FalkorDB Lite (zero-config, in-process) or Neo4j (Docker/external)
- **Protocol:** MCP (Model Context Protocol)
- **File watching:** watchdog library
- **CLI:** Typer + Rich + InquirerPy

## Supported Languages

12 languages claimed: Python, JavaScript, TypeScript, Java, C/C++, C#, Go, Rust, Ruby, PHP, Swift, Kotlin.

**Reality check:** Primary mature support appears to be Python only. JS/TS, Rust, C++ listed as roadmap/partial.

## MCP Tools Provided

| Tool | Description |
|------|-------------|
| `add_code_to_graph` | Index a codebase |
| `watch_directory` | Live file watching |
| `unwatch_directory` | Stop watching |
| `find_code` | Find code entities |
| `analyze_code_relationships` | Callers, callees, chains |
| `find_dead_code` | Dead code detection |
| `calculate_cyclomatic_complexity` | Complexity metrics |
| `list_indexed_repositories` | List indexed repos |
| `delete_repository` | Remove from graph |
| `execute_cypher_query` | Raw Cypher access |

## What It Extracts (Graph Content)

**Nodes:** Functions, Classes, Methods, Parameters, Variables (definitions)
**Relationships:** CALLS, INHERITS, IMPORTS

This is essentially a **call graph + class hierarchy + import map**.

## What It Does NOT Do

- **No data flow analysis** — cannot trace "where does this value come from?"
- **No scope resolution** — no scope chains, no variable shadowing awareness
- **No semantic IDs** — nodes identified by name/file, not semantic path
- **No mutation tracking** — doesn't track variable reassignments
- **No type inference** — no value type propagation
- **No Datalog** — queries are Cypher or natural language (LLM-interpreted)
- **No cross-file value tracing** — knows A imports B, but not what data flows between them
- **No enrichment pipeline** — no plugin architecture for adding semantic layers
- **No guarantee system** — no way to define and check code invariants

## Project Stats (Feb 2026)

| Metric | Value |
|--------|-------|
| Stars | 735 (fast-growing) |
| Forks | 308 |
| Open Issues | 103 |
| PRs | 13 |
| Commits | 727 |
| Version | 0.2.2 |
| License | MIT |
| Contributors | Solo + community |

## Strengths (vs Grafema)

1. **Multi-language from day one** — 12 languages via tree-sitter vs Grafema's JS-only
2. **Easy setup** — `pip install codegraphcontext`, zero-config FalkorDB Lite
3. **Live file watching** — real-time graph updates (Grafema needs manual re-analyze)
4. **Traction** — 735 stars, 308 forks, active community
5. **Pre-indexed bundles** — load famous repos without indexing
6. **Neo4j ecosystem** — mature tooling, visualization, Cypher query language
7. **Lower barrier to entry** — Python, pip install, works immediately

## Weaknesses (vs Grafema)

1. **Shallow analysis** — call graph is the floor, not the ceiling. No data flow, no scope chains, no value tracing. This is the fundamental difference.
2. **No semantic understanding** — knows "A calls B" but not "A passes user.id to B's first parameter which flows into SQL query"
3. **No enrichment architecture** — can't layer semantic analysis on top of structural graph
4. **No Datalog** — limited to Cypher or LLM-interpreted natural language
5. **No guarantee/invariant system** — can't define and verify code contracts
6. **Solo developer risk** — bus factor = 1
7. **Python runtime** — slower parsing than native (Grafema's RFDB is Rust)
8. **No framework-specific analyzers** — doesn't understand Express routes, React components, etc.
9. **103 open issues** — scaling/quality concerns as popularity grows

## Head-to-Head Comparison

| Dimension | Grafema | CGC |
|-----------|---------|-----|
| **Core thesis** | AI queries graph, not code | AI queries graph, not code |
| **Graph depth** | Deep (data flow, scopes, values) | Shallow (calls, classes, imports) |
| **Parser** | Babel (JS), expandable | Tree-sitter (12 languages) |
| **Database** | RFDB (Rust, custom) | FalkorDB Lite / Neo4j |
| **Query language** | Datalog + MCP tools | Cypher + natural language |
| **MCP server** | Yes (25 tools) | Yes (~10 tools) |
| **Data flow** | Yes | No |
| **Scope resolution** | Yes | No |
| **Value tracing** | Yes | No |
| **Variable mutations** | Yes | No |
| **Framework-aware** | Yes (Express, React planned) | No |
| **Languages** | JS (expanding) | 12 (Python mature, rest partial) |
| **Live watching** | No (re-analyze needed) | Yes |
| **Setup friction** | Higher (Rust binary, build step) | Lower (pip install) |
| **Traction** | Early | 735 stars, growing fast |
| **License** | (check) | MIT |
| **Target codebases** | Massive legacy, untyped | Any codebase |

## Threat Assessment: HIGH (7/10)

### Why It's Dangerous

1. **Same thesis, lower barrier.** CGC proves the market exists for "code graph for AI". It's easier to install and supports more languages. Developers discovering this need will find CGC first.

2. **Network effects.** 735 stars + 308 forks = community momentum. Contributors will add features. MCP integration means IDE adoption.

3. **Good enough for many use cases.** Most developers asking "what calls this function?" don't need data flow analysis. CGC answers the 80% questions well enough.

4. **First-mover in MCP ecosystem.** Listed on mcpservers.org, awesome-mcp lists. Being THE code graph MCP server is a strong position.

### Why It's NOT Fatal

1. **Depth ceiling.** CGC's tree-sitter-based call graph cannot answer Grafema's core questions: "where does this value come from?", "what data flows into this SQL query?", "what are the possible types of this variable?" This is not a feature gap — it's an architectural limitation. Adding data flow to a tree-sitter call graph is essentially rebuilding Grafema.

2. **Different target.** CGC works well for well-structured modern codebases. Grafema targets massive legacy codebases where call graphs are insufficient — you need semantic understanding to navigate untyped spaghetti code.

3. **Complementary, not competitive at depth.** For surface-level queries (call chains, dead code, complexity), CGC is good enough. For deep queries (data flow, type inference, security tracing), only Grafema can answer. These are different products at different depth levels.

4. **Solo developer.** 103 open issues with one maintainer. Scaling a deep analysis tool requires significant engineering. Community contributions tend to be shallow (new language parsers, not fundamental architecture).

## Strategic Implications for Grafema

### Short-term Risks
- CGC captures developer mindshare for "code graph + AI" category
- Developers who try CGC first and find it "good enough" won't look further
- CGC's multi-language support makes Grafema's JS-only look limited

### Long-term Advantages
- Deep analysis is a moat CGC cannot easily cross
- Legacy codebase use case is where shallow tools fail and deep tools shine
- Framework-aware analysis (Express routes → handlers → DB queries) is uniquely Grafema

### Recommended Actions
1. **Differentiate on depth, not breadth.** Don't race to add 12 languages. Win by being 10x deeper on JS/TS first, then expand.
2. **Reduce setup friction.** `pip install` vs Rust binary build is a real barrier. Consider pre-built binaries or npm global install.
3. **Demo the depth gap.** Create compelling examples: "CGC says A calls B. Grafema says A passes user input to B which flows into unsanitized SQL." This is the killer demo.
4. **Live watching is table stakes.** Implement incremental analysis — users expect real-time updates.
5. **Claim the "deep code understanding" positioning.** Let CGC own "code graph for AI". Own "semantic code understanding for AI on legacy codebases."

## Also Discovered: drewdrewH/code-graph-context

A separate project (different author) doing similar thing specifically for TypeScript. Uses MCP, builds rich code graphs. Much smaller (no star data found). Worth monitoring: https://github.com/drewdrewH/code-graph-context

## Sources

- https://github.com/CodeGraphContext/CodeGraphContext
- https://codegraphcontext.github.io/
- https://codegraphcontext.vercel.app/
- https://skywork.ai/skypage/en/codegraph-smart-code-companion/1978349276941164544
- https://mcpservers.org/servers/shashankss1205/codegraphcontext
- https://github.com/drewdrewH/code-graph-context
