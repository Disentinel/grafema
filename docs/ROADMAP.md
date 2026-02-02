# Grafema Roadmap

Graph-Driven Development: from code graph to system guarantees.

---

## Current State (v0.1.0)

### Core Infrastructure ✅

- **RFDB Server** — Rust graph database, client-server via unix-socket
- **Monorepo architecture** — `types`, `core`, `cli`, `mcp`, `gui`
- **Datalog engine** — declarative queries over the graph
- **GuaranteeManager** — rule-based invariant checking

### Analysis ✅

- **JS/TS AST Analysis** — functions, classes, modules, variables, parameters
- **Data Flow** — AliasTracker, ValueDomainAnalyzer, path-sensitive CFG
- **Framework Plugins** — Express, Socket.IO, Database, Fetch
- **Cross-file Resolution** — imports, exports, re-exports, call resolution

### CLI ✅

- `grafema analyze` — full project analysis
- `grafema query` — natural language + Datalog queries
- `grafema ls` — list nodes by type
- `grafema types` — show available node types
- `grafema show` — node details with edges

### MCP Server ✅

- `query_graph`, `find_calls`, `trace_alias`, `check_invariant`
- `get_value_set`, `trace_data_flow`, `get_stats`
- `analyze_project`, `discover_services`, `get_analysis_status`

---

## v0.1.x — Polish & Stability

Bug fixes and improvements for current functionality.

### AST Coverage Gaps

- [ ] Track `import.meta` (REG-300)
- [ ] Track `new.target` (REG-301)
- [ ] Track transitive closure captures (REG-302)
- [ ] Track type parameter constraints (REG-303)
- [ ] Track conditional types (REG-304)
- [ ] Track mapped types (REG-305)
- [ ] Track top-level await (REG-297)
- [ ] Track await in loops — performance flag (REG-298)
- [ ] Track `YieldExpression` (REG-299)
- [ ] Track side-effect-only imports (REG-296)
- [ ] Track `ImportExpression` with options (REG-295)
- [ ] Track getter/setter distinction (REG-293)
- [ ] Track `PrivateName` (#fields) (REG-292)
- [ ] Track `StaticBlock` (REG-291)
- [ ] Track `SequenceExpression` side effects (REG-289)

---

## v0.2 — Data Flow & Early Access

Features needed for production use on real codebases.

### Data Flow

- [ ] Async error patterns — `Promise.reject`, reject callback (REG-311)
- [ ] Cardinality tracking — complexity guarantees via Datalog (REG-314)
- [ ] Server-side scope filtering for query command (REG-310)
- [x] Cross-service value tracing — frontend ↔ backend (REG-252) 🔄
- [ ] Config-based cross-service routing rules (REG-256)

### Tech Debt

- [ ] Extract shared expression handling in JSASTAnalyzer (REG-306)

### Package-Specific Analyzers

- [ ] Architecture: plugin structure for npm/maven packages (REG-259)
- [ ] `npm/sqlite3` analyzer (REG-260)
- [ ] DatabaseAnalyzer: sqlite3 API support (REG-258)

---

## v0.3 — Stability & Onboarding

Making Grafema easy to adopt for new projects.

### AST Completeness

- [ ] Track class static blocks and private fields (REG-271)
- [ ] Track generator function yields — YIELDS edge (REG-270)

### Query Languages

- [ ] Cypher query language support in RFDB (REG-255)

### Research & Design

- [ ] Design: Return value tracking — FUNCTION → RETURNS → value (REG-266)
- [ ] Design: JSX support in Grafema graph (REG-264)

### UX

- [ ] Project onboarding wizard
- [ ] Better error messages and suggestions
- [ ] Better duplicate node differentiation in `ls` (REG-279)
- [ ] Improve `ls` error message when --type missing (REG-278)
- [ ] Performance optimization for large codebases

---

## v0.5+ — Strategic

Long-term vision features.

### Verification & Benchmarks

- [ ] SWE-bench Lite: ABBA runs (10× MCP vs 10× baseline) with token logging (REG-245)
- [ ] Strategy: Token savings as hook, understanding as product (REG-246)

### Research

- [ ] Design: Expression tree granularity for data flow (REG-265)
- [ ] Research: Auto-parse nginx.conf for cross-service routing (REG-257)

### GUI ⭐

- [ ] Graph visualization dashboard
- [ ] Interactive node explorer
- [ ] Query builder UI

### Contract Discovery ⭐

- [ ] Queue Contract Discovery — RabbitMQ, Kafka, SQS
- [ ] Schema inference from destructuring
- [ ] API Contract Discovery — request/response schemas
- [ ] AWS SDK Analyzer — cloud API calls

### Infrastructure Layer ⭐

- [ ] Terraform Parser — IAM roles, policies, resources
- [ ] IAM Policy Analyzer — permission extraction
- [ ] Permission Path Tracer — code → role → policy validation
- [ ] K8s manifest analysis

### Guarantee System ⭐

- [ ] Guarantee nodes as first-class graph objects
- [ ] GOVERNS edge type
- [ ] Guarantee lifecycle: discovered → reviewed → active
- [ ] Change Request workflow
- [ ] Impact analysis

### Priority & Governance ⭐

- [ ] Impact Score Calculator — auto-priority from graph reachability
- [ ] Monitoring Config Parser — priority hints from alerts
- [ ] Priority Aggregator — combine multiple sources

### Advanced MCP Tools ⭐

- [ ] `find_similar_patterns` — pattern matching for guarantees
- [ ] `verify_no_regressions` — pre-commit checks
- [ ] `get_implementation_context` — proactive AI guidance

---

## Version Philosophy

| Version | Focus | Timeline |
|---------|-------|----------|
| **v0.1.x** | Works correctly | Current |
| **v0.2** | Works on real projects | Next |
| **v0.3** | Easy to adopt | After v0.2 |
| **v0.5+** | Full GDD vision | Future |

⭐ = Planned for Grafema Pro (details TBA)

---

## Success Metrics

### Quality

- Analysis precision: >95% (nodes correctly represent code)
- Query accuracy: >90% (Datalog returns expected results)
- False positive rate: <5% for guarantees

### Performance

- 1000 files: <30 seconds full analysis
- Incremental: <5 seconds for changed files
- MCP response: <2 seconds

### Adoption

- Can analyze any JS/TS project without configuration
- AI agents prefer graph queries over reading code
- Guarantee violations caught before merge

---

## Architecture Principles

### Reuse Before Build

Before proposing a new subsystem, check if existing infrastructure can be extended:

| Need | Don't Build | Extend Instead |
|------|-------------|----------------|
| "Check property X" | New analysis engine | Datalog rule |
| "Track metadata Y" | New node type | `metadata` field |
| "Report issue Z" | New warning system | ISSUE nodes |
| "Query pattern W" | Custom traversal | Datalog query |

### Core = Graph + Datalog + Guarantees

Most features should be: **enricher** (adds data) + **Datalog rules** (query it) + **GuaranteeManager** (report violations).

---

*Last updated: 2026-02-02*
