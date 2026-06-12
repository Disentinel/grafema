# Grafema Roadmap

Graph-Driven Development: from code graph to system guarantees.

*Last updated: 2026-04-25*

---

## Current State ✅

### Core Infrastructure
- **RFDB v2** — columnar storage engine, manifest chain, L1/L2 compaction, Datalog evaluator with edge-type index
- **Rust orchestrator** (`grafema-orchestrator`) — replaces old JS pipeline, handles analysis + layout + BEAM
- **Datalog engine** — declarative queries, numeric predicates, edge-type index for O(1) pattern matching
- **GuaranteeManager** — `.grafema/guarantees.yaml`, `grafema check` CI gate
- **Enrichment pipeline** — batch protocol, library callback enricher, manifest generator
- **SemanticID → URI** — `grafema://owner/repo/path#symbol` format

### Language Support
- **JS/TS** — full AST analysis, cross-file resolution, data flow, class/module graph
- **Python** — parser + resolver (ClassInheritance, imports)
- **Rust** — intra-file call resolution, struct/impl/trait graph
- **Haskell** — module graph, type signatures
- **BEAM/Elixir** — message passing (SENDS_MESSAGE, PUBLISHES), state fields, handler self-loops
- **Java** — analysis (in progress)

### Data Analysis
- **Data Shape Inference** — object shapes through assignment chains, in-engine `shape_verifier.dl` stdlib pack
- **Cross-service tracing** — frontend ↔ backend value flow, CALLS_REMOTE edges
- **Library Callback Enricher** — auto-detects MCP tools, CLI commands from YAML effects-db
- **Effects-DB** — curated side-effect annotations for npm packages + Node.js builtins

### Visualization
- **HexAtlas** — unified React + Three.js hex map, 2D ⇄ 3D runtime switch
- **Rust hex layout** — `grafema-orchestrator layout`, 10× faster than JS (503µs/1k nodes)
- **VS Code extension** — Map panel iframes HexAtlas, dynamic port, auto-start RFDB

### CLI & MCP
- `grafema analyze`, `init`, `tldr`, `wtf`, `who`, `why`, `check`, `overview`, `doctor`
- 24+ MCP tools: `find_nodes`, `find_calls`, `trace_dataflow`, `trace_alias`, `describe`, `get_shape`, `create_guarantee`, `query_graph`, …

---

## v0.3 — Stability & Onboarding *(current)*

Making Grafema reliable enough for real project use.

### In Progress
- [ ] Method call resolution — JS methods (0/478 callers, REG-688)
- [ ] 78% parameters disconnected from callers (REG-690)
- [ ] JS/TS MODULE names with absolute paths (REG-625)
- [ ] Analysis pipeline test strategy — 5-layer coverage (REG-564)
- [ ] Strict mode for analysis pipeline (REG-563)

### Backlog
- [ ] METRIC guarantees: Datalog-based performance thresholds (REG-679)
- [ ] METRIC enrichment plugin (REG-678)
- [ ] ISSUE node count stable across runs (RFD-65)
- [ ] JSX support design (REG-264)
- [ ] Return value tracking design (REG-266)
- [ ] Audit AST gaps REG-295–305 vs v3 orchestrator (REG-1109)
- [ ] Standalone distribution: `install.sh` + bun compile (REG-1088)
- [ ] `ls` UX improvements (REG-278, REG-279)

---

## v0.4 — Visualization + Registry *(next)*

Ship the code map and open the feedback loop with users.

### Demo
- [ ] DEMO 1: Data trace end-to-end screencast (REG-654) ← **blocks landing page**
- [ ] Demo gallery: compelling use cases (REG-92)

### Visualization
- [ ] HexAtlas integration with live RFDB data (current worktree)
- [ ] `@grafema/hexgraph` — publish layout+renderer as standalone npm package (REG-1093)
- [ ] `@grafema/hex-atlas` — full package (REG-1101)

### Registry & Go-to-Market
- [ ] **Landing page v2** — polish before launch (REG-510)
- [ ] **Registry Server** — HTTP server for user requests to populate effects-db (REG-1106)
- [ ] `grafema registry submit --package=@company/internal-lib` CLI command
- [ ] Submit Grafema MCP to all MCP directories (REG-465)

---

## v0.5 — Internal Deployment & Team Features

After Grafema is validated on a real project internally.

### Internal Deployment
- [ ] AI Agent Skills — high-level MCP workflows for typical tasks (REG-93, written post-deployment)
- [ ] **Contract Discovery** — queue contracts (Kafka, RabbitMQ) + API schemas (REG-1108)
- [ ] Feature detection for documentation improvement (current worktree)

### Visualization
- [ ] Bus Factor Map — knowledge concentration heatmap (REG-1095)
- [ ] 3D octahedral grid visualization (REG-593)

### Team Server *(after internal validation)*
- [ ] Multi-user RFDB server with access control
- [ ] Shared graph across team instances
- [ ] Request workflow: developer → registry → effects-db update

### Infrastructure
- [ ] Context Graph: Git layer — blame, churn, authorship (REG-471)
- [ ] Context Graph: GitHub PR & Code Review layer (REG-472)
- [ ] RFDB scale benchmarks up to 1M nodes (RFD-32)

---

## v0.6 — Code Quality & Insights

Graph-native code quality — deeper than SonarQube because graph has function-level granularity.

### Code Quality Metrics (REG-1107)
- [ ] Cyclomatic complexity via CFG graph
- [ ] Cardinality tracking (from REG-314)
- [ ] Coupling: afferent/efferent via DEPENDS_ON
- [ ] Hotspots: change frequency × complexity (needs git layer)
- [ ] `grafema health` CLI command + quality gate

### Context Graph
- [ ] Task tracker integration: Linear → code (REG-473)
- [ ] AI Session layer: CC decision traces (REG-476)
- [ ] Tribal Knowledge layer: ADR, conventions (REG-475)

---

## v0.7+ — Strategic

### Multi-language Expansion
- Java (priority — large enterprise codebases)
- C# (REG-662)
- Scala (REG-664)
- Go, Swift, OCaml, Clojure (REG-668, REG-669)

### Advanced Features
- gRPC connection analysis (REG-434)
- Co-change pattern mining from git (REG-442)
- Semantic similarity edges (REG-444)
- Enox: federated knowledge graph (complementary product)

### Infrastructure
- Vector search in RFDB (RFD-50)
- Federation router in Rust (RFD-54)
- Node-level incremental reanalysis (REG-1090)

---

## Architecture Principles

### Reuse Before Build

| Need | Don't Build | Extend Instead |
|------|-------------|----------------|
| "Check property X" | New analysis engine | Datalog rule + GuaranteeManager |
| "Track metadata Y" | New node type | `metadata` field on existing nodes |
| "Report issue Z" | New warning system | ISSUE nodes + existing reporters |
| "Query pattern W" | Custom traversal | Datalog query |

### Core = Graph + Datalog + Guarantees

Most features: **enricher** (adds data) + **Datalog rules** (query it) + **GuaranteeManager** (report violations).

### AI-First

Every MCP tool documented for LLM agents. UX designed for agents, not just humans. AI should query the graph — not read code.

---

## Success Metrics

| Metric | Target |
|--------|--------|
| Analysis precision | >95% nodes correctly represent code |
| MCP response time | <2 seconds |
| Full analysis (1k files) | <30 seconds |
| AI agents prefer graph over file reads | measurable via dogfooding |
| Guarantee violations caught pre-merge | CI integration working |
