# Core v3: Haskell + Datalog Architecture

**Status:** Steps 1-3 implemented, Step 4+ remaining
**Date:** 2026-03-03 (revised 2026-03-04 based on MLA findings, updated 2026-03-04 after cross-file resolution)
**Origin:** Analysis of core-v2 visitors, enrichers, and resolve.ts revealed that the current JS codebase naturally splits into three layers with distinct computational models.

## Problem

core-v2 is ~8000 lines of JS implementing three fundamentally different things:

1. **Per-file AST → graph** (~3500 lines: visitors, edge-map, walk.ts) — pattern matching + context threading
2. **Cross-file resolution** (~1400 lines: resolve.ts) — joins + transitive closure
3. **Graph enrichment** (~3000 lines: 15 enricher plugins) — graph rewriting rules

All three are in JS. Each has problems:
- Visitors: no exhaustiveness guarantee, compensatory patterns between visitors, mutable stacks
- Resolve: 17 functions, 13 are pure joins reimplemented imperatively
- Enrichers: each builds its own indexes, 15 full graph scans, ad hoc propagation ordering

## Core Thesis

**Each computation gets the right language.**

| Layer | Computation | Current (JS) | v3 |
|-------|------------|-------------|-----|
| Per-file analysis | Pattern match + context | Visitor pattern + mutable stacks | **Haskell** (AG + Reader/Writer) |
| Cross-file resolution | Language-specific joins | Imperative index building + BFS | **Haskell plugins** (DAG-ordered) |
| Enrichment | Graph pattern matching | 15 ad hoc enricher plugins | **Haskell plugins** (streaming/batch) |
| Orchestration | I/O, process management | Node.js | **Rust** (language-agnostic DAG runner) |
| Queries + guarantees | Read-only graph queries | — | **Datalog** (existing top-down evaluator) |

## Architecture

```
Source files
    │
    ▼
┌─────────────────────────────────────────┐
│ Phase 0: DISCOVER (Rust orchestrator)   │
│   config-driven glob → MODULE nodes     │
└─────────────────┬───────────────────────┘
                  │
    ┌─────────────┼─────────────┐
    │ per file:   │             │
    ▼             ▼             ▼
┌────────┐  ┌────────┐  ┌────────┐
│  OXC   │  │  OXC   │  │  OXC   │    Phase 1: PER-FILE ANALYSIS
│ parse  │  │ parse  │  │ parse  │    (parallel per file)
│   +    │  │   +    │  │   +    │
│Haskell │  │Haskell │  │Haskell │    OXC parse + Haskell analyze
│analyze │  │analyze │  │analyze │    + postFile scope resolve
└───┬────┘  └───┬────┘  └───┬────┘
    │           │           │
    └─────────┬─┘───────────┘
              │
              ▼  (orchestrator ingests nodes + edges into RFDB)
              │
              ▼
┌─────────────────────────────────────────┐
│ Phase 2: PLUGINS (DAG-parallel)         │
│   resolution plugins (depends_on: [])   │
│     js-import-resolution                │
│     runtime-globals                     │
│   enrichment plugins                    │
│     express-routes, react-components    │
│   validation plugins                    │
│     dangling-edges, guarantees          │
└─────────────────────────────────────────┘
```

### What each language does

**OXC (Rust):** `source code → JSON AST`. Best-in-class JS/TS parser (10-100x faster than Babel). ESTree JSON format.

**Haskell binary (per-file):** `JSON AST → FileAnalysis JSON`. Per-file, stateless, parallel.
- Node + edge emission via Attribute Grammar rules
- Intra-file scope resolution (postFile pass — resolves scope chain refs within the file)
- REFERENCE nodes with `resolved: false` for unresolved identifiers
- IMPORT_BINDING nodes for imports needing cross-file matching
- Domain detection via LibraryDef (Express routes, Redis ops, Axios requests)
- Exhaustiveness guaranteed at compile time (~160 OXC ESTree types × all lenses)

**Haskell plugins (cross-file):** Resolution and enrichment as DAG-ordered plugins.
- `js-import-resolution`: matches IMPORT_BINDING nodes to EXPORT_BINDING nodes in target modules
- `runtime-globals`: matches unresolved REFERENCE nodes to runtime definitions
- Enrichment plugins (express-routes, react-components, type-propagation, etc.)
- Each language provides its own resolution plugins (ESM/CJS for JS, classpath for Java)

**RFDB Datalog:** Ad-hoc queries + guarantees only (existing top-down evaluator, no changes needed).
- `grafema check` — validation rules from `.grafema/guarantees.yaml`
- MCP queries — interactive graph exploration
- ISSUE node creation from validation rules

**Rust orchestrator:** Fully language-agnostic. Zero language semantics.
- File discovery (config-driven glob)
- Phase 1 spawning (OXC + Haskell, parallel per file)
- RFDB ingestion (load Phase 1 results into GraphStore)
- Plugin DAG execution (topological sort by `depends_on`, parallel independent plugins)
- Plugin output validation and buffered writes

## Haskell Binary Design

### Output format

```haskell
data FileAnalysis = FileAnalysis
  { nodes    :: [GraphNode]     -- includes REFERENCE (resolved:false), IMPORT_BINDING
  , edges    :: [GraphEdge]     -- includes intra-file resolved edges from postFile
  , exports  :: [ExportInfo]    -- what this file exports
  }
```

**Note:** `unresolvedRefs` are internal to the Haskell binary — created during AST walk, consumed during postFile scope resolve, never serialized. The external handoff for cross-file work is:
- **REFERENCE nodes** with `resolved: false` — identifiers that couldn't be resolved within the file
- **IMPORT_BINDING nodes** — imports that need matching to exports in other modules

### Context threading: Reader monad, not mutable stacks

Current JS uses four mutable stacks: `_scopeStack`, `_functionStack`, `_classStack`, `_ancestorStack`. In Haskell, these become fields in an immutable Reader context:

```haskell
data Context = Context
  { scope          :: Scope            -- was _scopeStack (top)
  , enclosingFn    :: Maybe NodeId     -- was _functionStack (top)
  , enclosingClass :: Maybe NodeId     -- was _classStack (top)
  , ancestors      :: [ASTNode]        -- was _ancestorStack
  , condTypeStack  :: [NodeId]         -- was _conditionalTypeStack
  , libraryInstances :: Map Name LibraryDef  -- detected lib instances
  , file           :: FilePath
  , line           :: Int
  }

-- local modifies context for subtree, auto-restores on return
walkFunction fn = do
  let fnId = nodeId "FUNCTION" fn.name fn.line
  emit (FunctionNode fnId fn)
  local (setEnclosingFn fnId . pushScope "function" fnId) $
    walkAST fn.body
```

### Pattern matching on structure: no compensatory patterns

Current JS: `visitIdentifier` has 20 exclusion conditions, `visitObjectProperty` and `visitForOfStatement` "compensate" by emitting deferreds that `visitIdentifier` skipped.

Haskell: match on (parent, child) structure. One decision point, not three:

```haskell
-- Instead of 20 exclusions in visitIdentifier:
identifierEdges :: ASTNode -> Identifier -> Context -> [DeferredRef]
identifierEdges (ObjectProperty True key _)   ident ctx | key == ident = [readsFrom ident ctx]
identifierEdges (ObjectProperty False _ val)  ident ctx | val == ident = [propertyValue ident ctx]
identifierEdges (ForOfStatement _ right)      ident ctx | right == ident = [iteratesOver ident ctx]
identifierEdges (ReturnStatement (Just arg))  ident ctx | arg == ident = [returns ident (enclosingFn ctx)]
identifierEdges _                             ident ctx = [readsFrom ident ctx]  -- default
```

Compiler checks exhaustiveness. No compensatory patterns needed.

### Intra-file scope resolution (postFile)

The Haskell binary performs scope resolution as a post-pass within Phase 1. The scope chain is already in memory — no need to serialize it, read it back, or rebuild it in another process.

```haskell
-- Main.hs analysis flow:
-- 1. walkNode ast          → nodes, edges, deferredRefs (internal)
-- 2. resolveFileRefs refs rootScope → resolved edges + unresolved as REFERENCE nodes

resolveFileRefs :: [DeferredRef] -> Scope -> ([Edge], [GraphNode])
resolveFileRefs refs rootScope = partitionResults $ map resolve refs
  where
    resolve ref = case lookupScopeChain (drName ref) (drScopeId ref) rootScope of
      Just declId -> Left (Edge (drFromNodeId ref) (drEdgeType ref) declId)
      Nothing     -> Right (ReferenceNode (drFromNodeId ref) (drName ref) False)
        -- ^ REFERENCE node with resolved=false, emitted in FileAnalysis
```

**Prerequisite:** Populate `drScopeId` (currently always `Nothing`):
```haskell
-- In ruleIdentifier, ruleThisExpression, etc.:
scopeId <- askScopeId
-- ...
-- drScopeId = Just scopeId
```

**Key insight:** `unresolvedRefs` are an implementation detail of the per-file analyzer — created during AST walk, consumed during `resolveFileRefs`, never serialized to any external interface. The external handoff for cross-file work is REFERENCE nodes with `resolved: false` and IMPORT_BINDING nodes.

### LibraryDef: domain plugins as data

```haskell
data LibraryDef = LibraryDef
  { name     :: String
  , packages :: [String]                -- npm package names to match
  , detect   :: [DetectionPattern]      -- how to find instances
  , methods  :: [MethodRule]            -- what methods create what nodes
  , config   :: [ConfigField]           -- relevant config properties
  }

data DetectionPattern
  = AssignFrom CallPattern              -- const app = express()
  | ImportDefault String                -- import axios from 'axios'
  | ImportNamed String String           -- import { createClient } from 'redis'
  | AliasChain                          -- const server = app (follow assignments)

data MethodRule = MethodRule
  { method   :: String                  -- "get", "post", "set", "subscribe"
  , creates  :: NodeTemplate            -- what node type to emit
  , args     :: [ArgSemantic]           -- how to interpret arguments
  }

data ArgSemantic
  = PathArg Int         -- arg[i] is a URL path
  | UrlArg Int          -- arg[i] is a full URL
  | KeyArg Int          -- arg[i] is a cache/db key
  | HandlerArg Int      -- arg[i] is a callback handler
  | DataArg Int         -- arg[i] is request/message body
  | ChannelArg Int      -- arg[i] is a pub/sub channel
  | PortArg Int         -- arg[i] is a network port
  | ConfigArg Int       -- arg[i] is a config object
```

One generic matcher interprets ALL LibraryDefs during the walk:

```haskell
matchLibraryCall :: [LibraryDef] -> Context -> CallExpr -> Maybe [GraphNode]
matchLibraryCall libs ctx call =
  case findInstance libs ctx (call.object) of
    Just lib -> applyMethodRules lib call ctx
    Nothing  -> Nothing
```

New library = new .hs data file. No code.

### Library definitions

```
libraries/
├── express.hs        -- ~30 lines: routes, mounts, middleware
├── koa.hs            -- ~25 lines: same HTTP pattern, different API
├── fastify.hs        -- ~30 lines: same HTTP pattern
├── axios.hs          -- ~25 lines: HTTP client requests
├── node-fetch.hs     -- ~15 lines: fetch() calls
├── ioredis.hs        -- ~60 lines: 50+ Redis commands
├── pg.hs             -- ~30 lines: PostgreSQL queries
├── mongoose.hs       -- ~40 lines: MongoDB operations
├── socket-io.hs      -- ~35 lines: WebSocket events
├── amqplib.hs        -- ~25 lines: RabbitMQ publish/subscribe
├── kafkajs.hs        -- ~30 lines: Kafka produce/consume
└── aws-sdk.hs        -- ~50 lines: S3, SQS, DynamoDB calls
```

### Datalog rule files

Resolution and enrichment are now handled by Haskell plugins (not Datalog). The `rules/core/` directory is eliminated. Datalog is used only for validation queries and guarantees — top-down evaluation against the completed graph.

```
rules/
├── domain/                          -- plugin query configs (optional Datalog specs)
│   ├── http.dl           -- generic: http:request ↔ http:route matching
│   ├── redis.dl          -- pub/sub channels, containment
│   ├── websocket.dl      -- socket event matching
│   ├── database.dl       -- query ↔ schema linking
│   └── messaging.dl      -- message queue pub/sub (Kafka, RabbitMQ)
│
└── validation/                      -- top-down Datalog queries → ISSUE nodes
    ├── broken-imports.dl -- unresolved import detection
    ├── sql-injection.dl  -- taint flow: user input → SQL query
    ├── dead-code.dl      -- exported but never imported
    └── guarantees.dl     -- user-defined invariant rules
```

**Note:** Domain `.dl` files are plugin query configs — they specify what nodes/edges a plugin needs, queried by the existing top-down evaluator. They are NOT bottom-up resolution rules.

## Performance

```
Pipeline for 10K file project (~500K LOC):

Phase 0:  Discovery        ~100ms   (config-driven glob)
Phase 1:  OXC + Haskell    ~30-60s  (parse + analyze + postFile resolve, parallel)
Phase 1': RFDB ingest      ~3-5s    (orchestrator loads nodes + edges into GraphStore)
Phase 2:  Plugins (DAG)    ~2-5s    (resolution + enrichment + validation)
───────────────────────────────────────
Total:                     ~35-70s
```

Bottleneck is OXC parsing + Haskell analysis (Phase 1), embarrassingly parallel per file. Resolution is no longer a separate phase — it's the first plugin in the DAG (~1-2s for import matching). Enrichment plugins run in parallel where dependencies allow.

## Deployment

Haskell binary distributed as platform-specific npm optional dependencies:

```
@grafema/analyzer-darwin-arm64
@grafema/analyzer-darwin-x64
@grafema/analyzer-linux-x64
@grafema/analyzer-win-x64
```

Precedent: esbuild (Go), swc (Rust), Biome (Rust) — all ship native binaries via npm.

Alternative: GHC WASM backend (stable since GHC 9.10) → single `grafema-analyzer.wasm` artifact.

---

## Open Questions for Discussion

### 1. Multi-Language Support

How does adding Java, Kotlin, Swift, Obj-C work in this architecture?

**Parser per language (unchanged from current strategy):**
- Java: JavaParser → JSON AST
- Kotlin: kotlin-compiler PSI → JSON AST
- Swift: SwiftSyntax → JSON AST

**Haskell binary: shared framework, per-language rules:**

```haskell
-- Shared type class
class Analyzable ast where
  type LangContext ast :: *
  walkAST :: ast -> ReaderT (LangContext ast) (Writer FileAnalysis) ()

-- Per-language instances
instance Analyzable BabelAST where
  type LangContext BabelAST = JSContext
  walkAST = walkJS

instance Analyzable JavaAST where
  type LangContext JavaAST = JavaContext
  walkAST = walkJava
```

**What's shared:**
- `FileAnalysis` output format (same nodes/edges for all languages)
- LibraryDef matcher (library detection is language-agnostic at the method level)
- Plugin protocol (streaming/batch — same mechanism for all languages' resolution + enrichment)
- Validation Datalog rules (queries against completed graph — language-agnostic)
- Semantic roles (Callable, Invocation, Declaration, Import, etc.)

**What's per-language:**
- AST ADT (BabelAST vs JavaAST vs KotlinAST)
- Context fields (Java has no hoisting, Kotlin has coroutine scope, etc.)
- Scope rules (JS has function/block/module scoping, Java has class/method/block)
- AG rules (how AST types map to semantic roles)

**Adding a new language:**
1. Write parser adapter (Java: `JavaParser → JSON`)
2. Define AST ADT in Haskell (`data JavaAST = ...`)
3. Write AG rules (`walkJava :: JavaAST -> ...`)
4. Write resolution plugin (Java: classpath resolution — language-specific)
5. Reuse LibraryDefs (Spring, Retrofit share HTTP patterns with Express, Axios)
6. Reuse validation Datalog rules, enrichment plugins, plugin protocol

### 2. Non-Semantic Projections (Task Tracker, Infrastructure, Monitoring)

The sociotechnical graph model defines 12 projections. Semantic is projection #1. How do the other 11 integrate?

**Key insight: projections differ in data source, not computational model.**

| Projection | Data Source | Ingestion | Nodes Created | Cross-Projection Edges |
|------------|-----------|-----------|--------------|----------------------|
| Semantic | Source code (Babel AST) | Haskell binary | FUNCTION, CLASS, etc. | — |
| Operational | Infrastructure (k8s, Docker) | API adapter | SERVICE, DEPLOYMENT, POD | SERVICE → MODULE |
| Causal | Incident tracker (PagerDuty) | API adapter | INCIDENT, ROOT_CAUSE | INCIDENT → FUNCTION |
| Contractual | Test results + SLO config | API adapter + Haskell | TEST, SLO, GUARANTEE | TEST → FUNCTION |
| Intentional | Task tracker (Linear) | API adapter | FEATURE, INITIATIVE | FEATURE → MODULE |
| Organizational | Git + CODEOWNERS | Git adapter | TEAM, OWNER | TEAM → MODULE |
| Temporal | Git history | Git adapter | COMMIT, PR | COMMIT → FUNCTION |
| Epistemic | Docs (Confluence, ADRs) | API adapter | DOCUMENT, ADR | ADR → MODULE |
| Security | Vulnerability scanners | API adapter | CVE, VULNERABILITY | CVE → DEPENDENCY |
| Financial | Cloud billing (AWS) | API adapter | COST_ITEM | COST_ITEM → SERVICE |
| Behavioral | Analytics (Mixpanel) | API adapter | FEATURE_USAGE, JOURNEY | USAGE → FEATURE |
| Risk | Risk registry | API adapter + Datalog | RISK, MITIGATION | RISK → SERVICE |

**Architecture pattern: Adapter + Datalog**

Each non-semantic projection follows:

```
External API → Adapter (JS/TS) → Nodes JSON → RFDB ingest → Datalog rules
```

The adapter is a thin translation layer: fetch data from Linear/PagerDuty/k8s/AWS, map to graph nodes, ingest into RFDB. Cross-projection edges are Datalog rules:

```datalog
% Intentional × Semantic: feature → code
implemented_by(Feature, Module) :-
  linear_issue(Feature, _, Labels),
  label_contains_path(Labels, Path),
  module(Module, Path).

% Causal × Semantic: incident → function
caused_by(Incident, Function) :-
  incident(Incident, _, CommitSHA),
  commit_changes(CommitSHA, File, Line),
  function(Function, File, StartLine, EndLine),
  Line >= StartLine, Line <= EndLine.

% Organizational × Semantic: team → code
owns(Team, Module) :-
  codeowners_rule(Pattern, Team),
  module(Module, Path),
  glob_match(Pattern, Path).

% Temporal × Semantic: who changed what
changed_by(Function, Author, Date) :-
  commit(Commit, Author, Date),
  commit_changes(Commit, File, Line),
  function(Function, File, StartLine, EndLine),
  Line >= StartLine, Line <= EndLine.
```

**The Haskell binary only handles Semantic projection.** All other projections are:
1. API adapter (JS/TS) → fetch + transform to graph nodes
2. Datalog rules → cross-projection edges

No Haskell needed for non-code projections. The data is already structured (JSON from APIs), not unstructured (source code requiring parsing).

### 3. Contributor Documentation

What documentation is needed for each type of contribution?

**A. Add support for a new JS/TS library (e.g., fastify)**

Contributor writes ONE file:

```
libraries/fastify.hs
```

Documentation needed:
- LibraryDef format reference (detect patterns, method rules, arg semantics)
- List of NodeTemplate types (HttpRoute, HttpRequest, RedisOp, etc.)
- List of ArgSemantic types (PathArg, KeyArg, HandlerArg, etc.)
- Examples: express.hs, axios.hs as templates
- Test: provide a sample .js file, expected nodes/edges output

If new cross-file semantics needed (rare), also add a `.dl` file to `rules/domain/`.

**Estimated contributor docs: ~5 pages.**

**B. Add a new language (e.g., Java)**

Contributor writes:
1. Parser adapter (JavaParser → JSON AST format) — language-specific
2. AST ADT in Haskell (`data JavaAST = ...`) — from parser spec
3. AG rules — semantic role mapping per AST type

Documentation needed:
- AST JSON format spec (what the parser must output)
- Haskell ADT conventions (naming, field types)
- Semantic role reference (Callable, Invocation, Declaration, etc.)
- AG rule writing guide (inherited/synthesized attributes, scope rules)
- Exhaustiveness matrix (AST types × projections — what to fill in)
- Test fixtures: sample Java files + expected graph output

**Estimated contributor docs: ~15 pages.**

**C. Add a new projection (e.g., Infrastructure)**

Contributor writes:
1. API adapter (JS/TS) — fetch from k8s/Docker/AWS, map to nodes
2. Datalog rules — cross-projection edges

Documentation needed:
- Node schema conventions (type naming, required fields)
- Adapter interface (what to return: nodes JSON array)
- Datalog rule writing guide (available predicates, built-in functions)
- Cross-projection edge conventions (naming, directionality)
- Test: mock API responses + expected graph state

**Estimated contributor docs: ~8 pages.**

**D. Add a validation rule (e.g., detect SQL injection)**

Contributor writes ONE file:

```
rules/validation/sql-injection.dl
```

Documentation needed:
- Available predicates (node types, edge types, metadata fields)
- Datalog syntax reference
- Taint analysis patterns (source/sink/propagation)
- ISSUE node emission convention
- Examples: broken-imports.dl, dead-code.dl as templates

**Estimated contributor docs: ~3 pages.**

### 4. Code Reduction Estimate

| Component | Current (JS) | v3 | Reduction |
|-----------|-------------|-----|-----------|
| **Visitors** (expressions + statements + declarations) | ~3500 lines | ~800 lines Haskell AG rules | 77% |
| **edge-map.ts** | ~216 lines | 0 (subsumed by AG rules) | 100% |
| **walk.ts** (traversal engine) | ~771 lines | ~200 lines Haskell (generic catamorphism) | 74% |
| **resolve.ts** (cross-file) | ~1400 lines | ~500-800 lines Haskell plugin | 43-64% |
| **15 enricher plugins** | ~3000 lines | ~500-800 lines Haskell plugins | 73-83% |
| **Plugin base + orchestrator** | ~2000 lines | ~300 lines Rust (DAG runner) | 85% |
| **Domain plugins** (Express etc.) | ~200 lines JS classes | ~30 lines LibraryDef data | 85% |
| **Domain enrichers** (5 plugins) | ~1050 lines | ~200 lines Haskell plugins | 81% |
| **6 validation plugins** | ~800 lines | ~60 lines Datalog | 93% |
| **Types/interfaces** | ~500 lines | ~150 lines Haskell types | 70% |
| ──── | ──── | ──── | ──── |
| **Total analysis code** | **~13,400 lines JS** | **~2,800-3,200 lines (Haskell + Rust + Datalog)** | **~76%** |

Breakdown of v3:
- ~1,800-2,400 lines Haskell (AG rules + types + walker + resolution plugin + enricher plugins)
- ~300 lines Rust (orchestrator DAG runner)
- ~60 lines Datalog (validation rules)
- ~180 lines LibraryDef data files

**Note:** Reduction is less dramatic than original Datalog-based estimate (~76% vs ~85%), but the resulting code is more maintainable — each plugin is a self-contained Haskell module with exhaustive pattern matching, vs Datalog rules with no type safety.

**What grows:** Test fixtures (sample ASTs + expected outputs), documentation, build infrastructure (GHC + Cabal).

**What disappears entirely:**
- Plugin base class hierarchy (Plugin, DomainPlugin, PluginMetadata, PluginContext)
- Propagation loop (consumes/produces/re-run logic)
- Per-enricher index building (15 × Map construction)
- DeferredRef kind dispatch (scope_lookup, call_resolve, type_resolve, etc.)
- Compensatory visitor patterns (visitIdentifier exclusions + compensators)
- Mutable stack management (_scopeStack, _functionStack, _classStack auto-pop)

## Migration Path

**Full rewrite of `packages/core/`.** Everything in core (visitors, walk.ts, edge-map, resolve.ts, enrichers, orchestrator) is replaced. Other packages (cli, mcp, gui, rfdb-server, types) are not affected — they consume the graph, not produce it.

The rewrite is sequenced so that each step can be validated against core-v2 output before proceeding:

**Step 1: Haskell binary for per-file analysis (replaces visitors + walk.ts + edge-map)** ✅ DONE
- Haskell binary reads OXC ESTree JSON, outputs FileAnalysis JSON
- Includes postFile scope resolution (intra-file)
- `withExported` context propagates exported flag through export declarations
- IMPORT_BINDING nodes carry `source` metadata for cross-file resolution

**Step 2: Rust orchestrator + RFDB ingestion (replaces JS orchestrator)** ✅ DONE
- Config-driven discovery, Phase 1 spawning (OXC + Haskell daemon pool), RFDB ingestion
- Plugin DAG runner for Phase 2
- Direct in-memory resolution path (bypasses RFDB Datalog round-trip)
- Default plugin configuration (`js-import-resolution`, `runtime-globals`)

**Step 3: Haskell plugins for cross-file resolution (replaces resolve.ts)** ✅ DONE
- `js-import-resolution`: IMPORT_BINDING → export target + IMPORT → MODULE
- `runtime-globals`: unresolved REFERENCE → GLOBAL_DEFINITION
- E2E verified: named, default, namespace imports; module-level edges; runtime globals

**Step 4: Haskell plugins for enrichment (replaces 15 enrichers)**
- One enricher at a time → streaming or batch plugin
- Start with easiest: ExportEntityLinker, SocketConnectionEnricher
- End with hardest: ValueDomainAnalyzer, ServiceConnectionEnricher
- Validation: enriched graph must match enricher output

**Step 5: LibraryDef system (replaces domain plugins)**
- Express LibraryDef replaces ExpressPlugin + ExpressHandlerLinker + MountPointResolver
- Each library: LibraryDef (detection patterns + method rules) + enrichment plugin (cross-file semantics)
- Validation: domain nodes/edges must match plugin output

**Step 6: Validation as Datalog (replaces validation plugins)**
- Each validation plugin → Datalog rule file
- Guarantees already in Datalog (grafema check)

**Step 7: Multi-language (new capability)**
- Java first (simplest AST, reveals cross-language patterns)
- Then Kotlin → Swift → Obj-C

After Step 6, `packages/core/` can be deleted entirely. The analysis pipeline is: Rust orchestrator → OXC + Haskell (Phase 1) → Haskell plugins (Phase 2) → RFDB (storage + Datalog queries).

## Multi-Language Support

### Time estimates (Opus 4.6 writing + debugging)

| Language | AST types | AG rules | Write | Debug | Libraries (top 10) |
|----------|-----------|----------|-------|-------|---------------------|
| **JS/TS** | ~160 | ~800 lines | done | done | express, axios, react, ... |
| **Java** | ~200 | ~600 lines | ~2h | ~3h | Spring, Hibernate, JDBC, Retrofit |
| **Python** | ~100 | ~500 lines | ~1.5h | ~3h | Django, Flask, FastAPI, SQLAlchemy |
| **Kotlin** | ~180 | ~650 lines | ~2.5h | ~4h | Ktor, Exposed, Spring (shared) |
| **Go** | ~80 | ~400 lines | ~1h | ~2h | net/http, gin, gorm, grpc-go |
| **Swift** | ~120 | ~550 lines | ~2h | ~3h | SwiftUI, Combine, Alamofire, Vapor |
| **PHP** | ~120 | ~500 lines | ~1.5h | ~3h | Laravel, Symfony, Doctrine, Guzzle |
| **Ruby** | ~100 | ~500 lines | ~1.5h | ~3h | Rails, Sinatra, ActiveRecord, Sidekiq |
| **C#** | ~200 | ~650 lines | ~2.5h | ~4h | ASP.NET, EF, SignalR |
| **Rust** | ~150 | ~700 lines | ~3h | ~5h | actix-web, tokio, diesel, serde |

Total for 10 languages: ~65 hours Opus time (~8 working days) for initial generation.

**Realistic estimates (3-5x multiplier for debugging, edge cases, real-world testing):**
- Per language total: ~1-2 months (parser setup, AG rules, test on real codebases, fix edge cases)
- 10 languages: ~12-18 months with one human architect + LLM
- Parallelizable: 2-3 humans → 6-9 months

Human time per language: parser infrastructure (~1 week), review AG rules (~1 week), build test fixtures from real projects (~2 weeks), iterate on edge cases (~2-4 weeks).

### Language versioning model

**New language versions add AST constructors, not change existing ones.**

```
Java 8:   class, method, lambda
Java 14:  + record, switch expression
Java 17:  + sealed class
Java 21:  + record pattern, string template
```

Parser (JavaParser) supports all versions. AG rules cover the superset. Old code simply doesn't trigger new-version rules. No version flags in AG rules.

**Rare semantic changes** (Python 2 `print` statement vs Python 3 `print()` function) are handled at parser level — different parsers produce different AST. AG rules work with whatever AST they receive.

### Runtimes

Runtime = set of builtin LibraryDefs. Language semantics unchanged.

```haskell
runtimeLibs :: Runtime -> [LibraryDef]
runtimeLibs NodeJS  = [nodeFs, nodePath, nodeHttp, nodeCrypto, ...]
runtimeLibs Deno    = [denoFs, denoHttp, denoKv, ...]
runtimeLibs Bun     = [bunFile, bunServe, bunSqlite, ...]
runtimeLibs Browser = [fetchApi, domApi, webCrypto, localStorage, ...]
```

Config: `runtime: node | deno | bun | browser` → loads appropriate LibraryDefs.

### Library versions

LibraryDef per major version, or superset (unused methods don't trigger).
Version auto-detected from `package.json` semver ranges.

**Summary: no version-specific logic in AG rules or Datalog rules.** All variability is in data (parser config, LibraryDef selection), not code.

## Risks

### R1: Haskell ecosystem — hiring and maintenance

**Risk:** Haskell developers are rare. Finding contributors who can write AG rules is harder than finding JS developers.

**Severity:** High. This is the single biggest risk.

**Mitigations:**
- AG rules are a DSL WITHIN Haskell — not general Haskell programming. The subset needed is: ADTs, pattern matching, Reader monad. No advanced type-level programming, no lens, no effect systems.
- LibraryDefs require ZERO Haskell knowledge — they're pure data declarations with a fixed schema. Most contributions will be LibraryDefs.
- Opus 4.6 / future LLMs can write and debug AG rules. The human role shifts from "write code" to "review correctness of semantic mappings."
- If Haskell proves too high a barrier: the AG rules can be expressed in a custom DSL that compiles to Haskell (or directly to JS). The architecture doesn't depend on Haskell-the-language — it depends on the computational model (AG + exhaustive pattern matching).

**Escape hatch:** If Haskell is abandoned, the AG spec can target Rust (via `enum` exhaustiveness) or even TypeScript (via discriminated unions + `never` check). The intellectual content — the rules — is language-independent.

### R2: OXC JSON AST serialization overhead

**Risk:** OXC AST → JSON → parse in Haskell adds serialization/deserialization cost. For large files (10K+ lines), the JSON AST can be 5-10MB.

**Severity:** Low-Medium. OXC is 10-100x faster than Babel, so parsing is no longer the bottleneck. Serialization overhead (~10-20%) is relative to a much smaller base.

**Mitigations:**
- Use MessagePack or CBOR instead of JSON (2-3x smaller, faster to parse).
- Use `stdout` pipe instead of temp files (streaming, no disk I/O).
- Long-term: OXC → Haskell via FFI or shared memory, no serialization at all.
- Alternative: Haskell WASM module, receives AST as in-memory object via WASM linear memory.

### R3: RFDB Datalog expressiveness

**Risk:** Some query patterns may not be expressible in RFDB's current Datalog dialect. Specifically:
- `paths_match(URL, Path)` for parametric routes (`/api/:id` matches `/api/42`)
- String operations (concat, prefix matching, regex)
- Aggregation (COUNT, MIN for disambiguation)
- Negation-as-failure (stratified negation for priority-ordered resolution)

**Severity:** Medium (reduced from High). Datalog is now used ONLY for queries and guarantees (`grafema check`, MCP queries, ISSUE node creation) — not for resolution or enrichment. Resolution and enrichment are Haskell plugins with full language expressiveness. The remaining Datalog use cases (validation rules, cross-projection queries) are well within top-down evaluation capabilities.

**Mitigations:**
- Extend RFDB Datalog with built-in predicates: `string_concat`, `glob_match`, `regex_match` — for validation queries.
- Add aggregate support: `count`, `min`, `max` — for guarantee rules.
- Stratified negation is well-understood theory; implement in RFDB if needed.
- For complex validation patterns: implement as a validation plugin (same mechanism as enrichment plugins) instead of Datalog.

### R4: Multi-binary deployment complexity

**Risk:** Shipping multiple native binaries alongside an npm package increases build/deployment complexity. Current binary count: Rust orchestrator, RFDB, Haskell analyzer (core-v3), Haskell resolver (grafema-resolve), Haskell enricher (grafema-enrich). Platform matrix: darwin-arm64, darwin-x64, linux-x64, linux-arm64, win-x64 = 5 platforms × 3-5 binaries = 15-25 artifacts.

**Severity:** Medium-High (increased from Medium). More binaries than originally planned.

**Mitigations:**
- Haskell binaries can share a single GHC runtime — or compile as subcommands of one `grafema-haskell` binary (analyze/resolve/enrich modes). Reduces Haskell to 1 binary.
- Rust orchestrator + RFDB could merge into one binary (orchestrator as RFDB subcommand). Reduces Rust to 1 binary.
- **Realistic minimum: 2 native binaries** (one Rust, one Haskell) + platform matrix = 10 artifacts.
- `optionalDependencies` in npm with platform-specific packages (established pattern).
- GHC WASM backend → single `grafema-haskell.wasm`, no platform matrix for Haskell.
- Docker image for CI/CD (all binaries pre-installed).
- Future: merge Haskell logic into Rust (rewrite AG rules in Rust, ship one binary).

### R5: Haskell ↔ OXC ESTree fidelity

**Risk:** OXC's ESTree JSON may have edge cases or deviations from the spec. The Haskell ADT may not match 100%, causing silent data loss or crashes.

**Severity:** Medium (reduced from Medium-High). ESTree is a well-specified standard, unlike Babel's de facto AST. OXC aims for ESTree conformance.

**Mitigations:**
- Generate Haskell ADT from ESTree spec (formalized, unlike Babel's ad-hoc `@babel/types`).
- Differential testing: run core-v2 (JS) and v3 (Haskell) on same files, diff outputs. Any mismatch = bug.
- Haskell's `aeson` JSON parsing with `rejectUnknownFields = False` — unknown fields logged, not crashed.
- OXC has its own conformance tests against ESTree spec — leverage them.

### R6: Incremental analysis complexity

**Risk:** Current architecture supports incremental re-analysis (changed files only, via `touchedFiles`). In v3, Phase 1 (Haskell per-file) is naturally incremental. But Phase 2 (plugins) is the question: which plugins need re-running when one file changes?

**Severity:** Medium. Matters for IDE-scale latency (<1s response).

**Mitigations:**
- Haskell binary: already per-file, naturally incremental. Re-analyze only changed file.
- Resolution plugins: re-run only for changed file's IMPORT_BINDINGs + files that import the changed file.
- Enrichment plugins: re-run only plugins whose input query matches changed file's nodes. Track read/write sets per plugin to determine which are affected.
- Conservative fallback: re-run all plugins (~2-5s). Acceptable for save-time; optimize later for IDE-scale latency.
- For IDE latency: skip plugins for single-file edits (per-file analysis is sufficient for local navigation). Run full plugin DAG on save/build.
- Generation GC handles correctness: stale plugin output from previous runs is cleaned up regardless.

### R7: Testing and correctness verification

**Risk:** core-v2 has ~500 test fixtures. Rewriting in Haskell means either porting all tests or building a differential testing harness. Bugs in AG rules are subtle — wrong edge type, missing edge, wrong scope — and hard to catch without comprehensive tests.

**Severity:** Medium. Addressed by migration strategy.

**Mitigations:**
- Step 1 of migration: differential testing. v3 output MUST match core-v2 output for all existing test fixtures.
- Property-based testing (QuickCheck): generate random ASTs, verify invariants (every CALL has a target or an ISSUE, every IMPORT resolves or has an error, scope chains are acyclic).
- Exhaustiveness matrix: ~160 OXC ESTree types × 8 lenses. Haskell compiler warns if any cell is unhandled.
- Grafema guarantees (`grafema check`): existing guarantee rules validate graph structural invariants. These are Datalog rules that run on the output — independent of implementation language.

### Risk summary

| Risk | Severity | Mitigation quality | Net risk |
|------|----------|-------------------|----------|
| R1: Haskell hiring | High | Medium (LLMs, DSL escape hatch) | **Medium-High** |
| R2: JSON serialization | Low-Medium | High (OXC already in use, MessagePack) | **Low** |
| R3: Datalog expressiveness | Medium | High (Datalog only for queries/guarantees now) | **Low** |
| R4: Multi-binary deploy | Medium-High | Medium (merge subcommands, WASM) | **Medium** |
| R5: ESTree fidelity | Medium | High (ESTree spec, diff testing) | **Low** |
| R6: Incremental analysis | Medium | Medium (semi-naive, skip for IDE) | **Medium** |
| R7: Testing | Medium | High (differential, property-based) | **Low** |

**Top risk: R1 (Haskell talent).** Has escape hatches but requires active investment. R3 (Datalog expressiveness) was reduced to Low — Datalog is now only for queries/guarantees, not resolution/enrichment.

## What We Actually Designed

### The realization

This is not a code analysis tool. We designed a **formal ontology of software engineering** — a universal knowledge graph with provable properties, into which any tool with an API integrates as a data source.

### What this is

1. **Exhaustive per-node analysis** (Attribute Grammars / Haskell) guarantees every AST construct in every supported language produces correct graph edges — verified at compile time.
2. **Plugin-based cross-file resolution** (Haskell plugins via unified DAG) replaces thousands of lines of imperative graph traversal with language-specific resolution plugins using the same protocol as enrichment.
3. **Data-driven library support** (LibraryDef) makes adding a new framework a 30-line data file instead of a 300-line plugin class.
4. **12 orthogonal projections** (Semantic + 11 sociotechnical) unified in a single graph, connected by Datalog rules.

This is not a linter, not a type checker, not an IDE backend. It's a **queryable semantic model of the entire sociotechnical system** — code, infrastructure, people, incidents, features, costs — with formal soundness guarantees per projection.

### Why nobody built this

**1. The fields never talked to each other.**

The pieces exist separately:
- **Attribute Grammars** — well-understood since Knuth (1968). Used in compiler construction (Silver, JastAdd, uuagc). Never applied to multi-language code analysis for graphs.
- **Datalog for code analysis** — CodeQL (GitHub/Semmle), Soufflé (Oracle), Doop (pointer analysis for Java). But always single-language, single-projection (security or types), never sociotechnical.
- **Sociotechnical systems theory** — Leavitt (1958), Sommerville. Qualitative models. Never formalized into a queryable graph with soundness properties.
- **Developer portals** — Backstage (Spotify), Cortex, OpsLevel. Flat catalogs of entities. No projections, no formal properties, no cross-projection queries.

Nobody combined AG + Datalog + sociotechnical theory because these communities don't overlap. AG people build compilers. Datalog people build program analyzers. Sociotechnical people write papers. Developer portal people build CRUD apps.

**2. The "one language, one concern" assumption.**

Every existing tool assumes one language and one concern:
- CodeQL: one language (C++/Java/JS/...) × one concern (security)
- SonarQube: one language × one concern (code quality)
- Backstage: language-agnostic but no code analysis at all
- Datadog: language-agnostic but only runtime, no code structure

Grafema v3 breaks both assumptions: **all languages × all concerns × formal guarantees**.

The reason nobody tried: it looks impossible. How do you formally analyze 10 languages? How do you connect code to incidents to costs? The answer — which took this entire research arc to find — is:
- Languages share semantic roles (Callable, Invocation, Declaration) — AG rules per language, shared output format
- Concerns share a graph — projections are views, Datalog rules connect them
- Formal guarantees are per-projection, not per-language or per-concern

**3. The target audience didn't exist until recently.**

Grafema's target: massive legacy codebases in untyped languages where migration to typed languages is economically unfeasible. These codebases have:
- 10K-100K files across multiple languages
- Custom build systems, internal DSLs, legacy frameworks
- No type annotations, no static analysis, no formal specs
- 50+ developers, tribal knowledge, bus factor = 1

Ten years ago, the response was "rewrite in TypeScript." Five years ago, "use tree-sitter and LSP." Today, with AI-assisted development, these codebases are being actively modified at unprecedented speed — by developers (and AI agents) who don't understand them. The need for a formal semantic model is more acute than ever, and the traditional answer ("add types") is still not feasible.

**4. The computational model mismatch was invisible.**

The key insight that unlocked v3: the analysis pipeline contains THREE fundamentally different computations (pattern matching, joins, graph rewriting) all forced into ONE language (JS). This is like writing a compiler, a database, and a rule engine in the same codebase and wondering why it's 13,000 lines of spaghetti.

Once you see the three layers, the architecture is obvious:
- Pattern matching → Haskell (it was DESIGNED for this)
- Joins + transitive closure → Haskell plugins (language-specific resolution) + Datalog (queries/guarantees)
- I/O + orchestration → Rust (language-agnostic DAG runner)

But seeing the three layers requires: (a) building the system once in one language, (b) analyzing what you built, (c) recognizing the computational models. You can't design v3 without having built v2. The predecessor is the proof that the problem exists.

**5. Nobody framed it as an integration layer.**

Backstage (Spotify) came closest — it's a "developer portal" that aggregates information from multiple tools. But Backstage is a UI with a flat entity catalog. No projections, no formal properties, no Datalog, no code analysis. It's a dashboard, not a knowledge graph.

The integration layer insight: every tool with an API is a data source for a projection. The graph is the JOIN TABLE for the entire developer tool ecosystem. The adapter pattern (100 lines JS per tool) makes integration nearly free. But nobody saw it because:
- Code analysis people don't think about PagerDuty
- DevOps people don't think about Abstract Interpretation
- Product people don't think about graph databases
- Everyone builds their own silo and wonders why cross-tool queries are impossible

**6. The economic model changed.**

Building a multi-language, multi-projection analysis system with formal guarantees used to require a team of 20 PhD-level engineers for 5 years. Now:
- LLMs write AG rules, LibraryDefs, Datalog rules, API adapters
- Humans review semantic correctness (not write code)
- Bugs surface through usage (wrong query results → trace to rule → fix)
- The system is DESIGNED for LLM-assisted development: declarative, small units, verifiable

The cost dropped from "research lab budget" to "one architect + LLMs." This is the 2026 development model: humans design, machines implement, humans verify.

### The three identities

**Identity 1: Formal ontology of software engineering.**
12 projections × ~40 sub-projections × ~258 entity types. Each projection has soundness and completeness properties derived from Abstract Interpretation theory. This is not a loose taxonomy (like Backstage's entity model) — it's a formal system where "complete" and "sound" have mathematical definitions. Comparable to: Schema.org is an ontology for the web. Grafema is an ontology for the entire software development lifecycle — but with formal verification.

**Identity 2: Universal integration layer.**
Every SaaS tool is a data silo. Linear knows tasks. Datadog knows metrics. GitHub knows code history. PagerDuty knows incidents. AWS knows costs. Nobody connects them.

Grafema's graph IS the connection layer:
```
Linear API    → adapter (100 lines JS) → FEATURE nodes    → Datalog → connected to CODE
PagerDuty API → adapter (100 lines JS) → INCIDENT nodes   → Datalog → connected to CODE
Datadog API   → adapter (100 lines JS) → METRIC nodes     → Datalog → connected to SERVICE
AWS Cost API  → adapter (100 lines JS) → COST nodes       → Datalog → connected to SERVICE
GitHub API    → adapter (100 lines JS) → COMMIT nodes     → Datalog → connected to FUNCTION
Confluence    → adapter (100 lines JS) → DOCUMENT nodes   → Datalog → connected to MODULE
Sentry API    → adapter (100 lines JS) → ERROR nodes      → Datalog → connected to FUNCTION
```

Each adapter: ~100 lines of trivial JSON mapping. Each Datalog rule: ~3-5 lines. The value: a query like "show me all incidents caused by functions owned by team X that implement feature Y documented in ADR Z" traverses 6 projections in one Datalog query. No existing tool can do this. Each tool sees one silo.

**Identity 3: LLM-native development platform.**
The implementation model is SOTA 2026: LLMs write the code (AG rules, LibraryDefs, Datalog rules, adapters), humans review semantic correctness. This is not a weakness ("we can't hire Haskell developers") — it's the design. The system is DESIGNED to be written by LLMs:
- AG rules are structured pattern matching — LLMs excel at this
- LibraryDefs are pure data — trivial for LLMs
- Datalog rules are small, verifiable, formal — ideal LLM output
- API adapters are JSON mapping — boilerplate LLMs generate perfectly
- Bugs are detectable from usage (graph queries return wrong results → trace to rule → fix)

The human role: design projections, define semantic roles, review correctness, define guarantees. The LLM role: implement the rules, write the adapters, generate tests.

### Target audience

Not "developers who use code analysis tools." **All software developers.** And their managers, SREs, security engineers, product managers, CTOs.

Because the graph covers all 12 projections:
- Developer asks: "what does this function do, who calls it, what tests cover it?"
- SRE asks: "what service was affected by this incident, who owns it, what's the runbook?"
- PM asks: "what features shipped this sprint, what's the adoption rate, what's the cost?"
- CTO asks: "what's our bus factor, where are the single points of failure, what's our ROI per feature?"

Each question traverses 2-4 projections. Each is one Datalog query. None requires manual cross-tool investigation.

### What this means competitively

| Existing tool | What it does | What Grafema v3 adds |
|--------------|-------------|---------------------|
| CodeQL | Security analysis, one language | All projections, all languages, formal soundness |
| Backstage | Entity catalog, flat | 12 projections, cross-projection queries, formal |
| SonarQube | Code quality, one language | Semantic graph, not pattern matching on AST |
| Datadog | Runtime observability | Connected to code structure (Semantic × Operational) |
| Linear | Task tracking | Connected to code (Intentional × Semantic) |
| GitHub Copilot | Code completion | Code comprehension (the other 58% of dev time) |

**The moat:** Nobody else has the theoretical framework (projections + soundness + completeness per projection). The framework took 6 months of research to develop. The implementation is "just" engineering — but engineering guided by theory that doesn't exist elsewhere.

**The 58% opportunity:** Developers spend 58% of time understanding code. Current tools optimize the other 42% (writing, testing, deploying). Grafema is the first tool designed to reduce the 58% with formal guarantees that the understanding is correct.

## Moat Analysis

### Why open source is safe

To replicate Grafema v3, one must simultaneously understand:
1. Abstract Interpretation (Cousot & Cousot, 1977)
2. Attribute Grammars (Knuth, 1968)
3. Datalog and stratified semantics
4. Haskell (monads, type classes, pattern matching)
5. Compiler construction (scope chains, name resolution)
6. Sociotechnical systems theory (Leavitt, Sommerville)
7. Cognitive Dimensions of Notations (Green & Petre)
8. Semantics of JS/TS/Java/Kotlin/Swift/Go/Python/...
9. APIs of 20+ SaaS tools
10. How and why all of this connects

The Venn diagram of people who know all 10: ∅

### Three real moats

1. **Accumulated rules.** ~160 OXC ESTree types × AG rules + 100+ LibraryDefs + Datalog rules = person-years of semantic knowledge encoded in small, verifiable units.

2. **Velocity.** LLM-native development model. Someone forks → in a month we have +3 languages and +20 LibraryDefs. They're still reading the architecture doc.

3. **Network effect from integrations.** Each adapter (Linear, Datadog, PagerDuty...) adds value to all others via cross-projection Datalog rules. More connected projections → exponentially more valuable queries. Fork without integrations = empty graph.

### Licensing strategy (under consideration)

Option A: Full open source (MIT/Apache). Moat = velocity + accumulated rules + integrations.

Option B: **Split repo.** Public: CLI, MCP, VSCode extension, binary distribution. Private: Haskell analyzer core, AG rules, LibraryDefs. Public repo ships pre-compiled binaries (`@grafema/analyzer-{platform}`). Users get the tool; the semantic engine is proprietary.

Option B gives: open ecosystem (anyone builds on the graph) + proprietary core (the hard-to-replicate engine). Precedent: MongoDB (SSPL), Elasticsearch (proprietary after 7.x), CockroachDB (BSL). More relevant: Turso (libSQL open, cloud proprietary), Neon (compute open, storage proprietary).

## Revised Architecture Decisions (2026-03-03)

After implementing Phase 1 (Haskell per-file analysis) and running it on Grafema's own codebase (116K nodes, 63K edges, 0 analysis errors), several architectural decisions were revised based on real experience.

### Current State (updated 2026-03-04)

**Step 1 — DONE:** Haskell per-file analyzer
- Haskell binary (`grafema-analyzer`) reads OXC ESTree JSON, outputs FileAnalysis JSON
- 116,782 nodes, 63,813 edges across 354 files, 0 dangling edges
- Intra-file scope resolution (`resolveFileRefs`) — REFERENCE→declaration READS_FROM edges
- IMPORT_BINDING nodes carry `source` metadata and encode import source in semantic ID: `file->IMPORT_BINDING->name[in:./source]`
- Export context (`withExported`) propagates `exported: true` to declarations inside `export` statements
- Committed as `f6cc2ac`, cross-file metadata additions pending commit

**Step 2 — DONE:** Rust orchestrator
- Config-driven file discovery, OXC parse → Haskell analyzer daemon pool
- RFDB ingestion with generation GC
- Plugin DAG runner (Kahn's algorithm, topological sort by `depends_on`)
- Direct resolution path: `collect_resolve_nodes` bypasses RFDB Datalog round-trip, sends in-memory GraphNode JSON to resolve daemon
- Default plugins (`js-import-resolution`, `runtime-globals`) auto-configured via `AnalyzerConfig::with_defaults()`
- Committed as `814dbd8`, in-memory resolution additions pending commit

**Step 3 — DONE:** Cross-file resolution plugins (Haskell)
- `grafema-resolve imports`: resolves IMPORT_BINDING → target export (FUNCTION, CONSTANT, CLASS, EXPORT_BINDING) AND IMPORT → MODULE (module-level edges)
- `grafema-resolve runtime-globals`: resolves unresolved REFERENCE → GLOBAL_DEFINITION (console, process, setTimeout, etc.)
- E2E verified: `import { greet } from './utils'` produces IMPORTS_FROM edge to `utils.js->FUNCTION->greet`
- Module-level: `IMPORT->./utils` → `MODULE#utils.js` with deduplication
- Pending commit

**What's remaining:**
- Step 4: Enrichment plugins (express-routes, react-components, etc.)
- Step 5: LibraryDef system
- Step 6: Validation as Datalog
- Step 7: Multi-language (Java first)
- Namespace import resolution (`import * as X`) — needs MODULE-level binding, not export matching

### Decision 1: Parser — OXC, not Babel

The Haskell binary already reads OXC ESTree JSON (via `packages/core-v3/scripts/parse.js` calling `oxc-parser`). This is the correct choice:
- OXC is 10-100x faster than Babel
- ESTree JSON format is stable and well-specified
- Babel's quirks (non-standard AST fields, undocumented behavior) are avoided

The original plan mentioned "Babel JSON AST" — this is outdated. OXC is the parser.

### Decision 2: Orchestrator — separate Rust binary, not JS, not embedded in RFDB

**Old plan:** JS orchestrator (Node.js) coordinates Haskell binary + RFDB Datalog.
**New plan:** Separate Rust binary (orchestrator) communicates with RFDB via unix-socket.

RFDB = storage + Datalog engine. Orchestrator = pipeline coordination (discover files, spawn analyzers, load results, trigger Datalog phases). Separate concerns, separate processes.

Rationale: migrating the JS orchestrator piecemeal is painful and creates a maintenance burden for a component we plan to replace anyway. The JS orchestrator served as a prototype; the production orchestrator is Rust for single-binary deployment alongside RFDB.

**Pipeline:**
```
Orchestrator (Rust, separate binary)          RFDB (Rust, separate process)
  │                                              │
  ├─ Phase 0: DISCOVER                          │
  │   Config-driven: glob → file list            │
  │   ──── insert MODULE nodes ──────────────►   │ GraphStore
  │                                              │
  ├─ Phase 1: PER-FILE ANALYSIS (parallel)       │
  │   For each file (N workers):                 │
  │     OXC parser → Haskell binary              │
  │     (analyze + postFile scope resolve)       │
  │     → FileAnalysis JSON (nodes, edges,       │
  │       REFERENCE resolved:false,              │
  │       IMPORT_BINDING nodes)                  │
  │   ──── load nodes + edges ───────────────►   │ GraphStore
  │                                              │
  ├─ Phase 2: PLUGINS (DAG-parallel)             │
  │   All use same mechanism. DAG ordering       │
  │   from depends_on.                           │
  │                                              │
  │   Resolution plugins (depends_on: []):       │
  │     js-import-resolution, runtime-globals    │
  │   Enrichment plugins:                        │
  │     express-routes, react-components, etc.   │
  │   Validation plugins:                        │
  │     Top-down Datalog queries → ISSUE nodes   │
  │                                              │
  │   Streaming: query GraphStore → stdin →      │
  │     plugin → stdout → validate → buffer      │
  │     → atomic write on success ───────────►   │ GraphStore
  │   Batch: plugin gets RFDB_SOCKET,            │
  │     queries + writes autonomously ───────►   │ GraphStore
  │                                              │
```

**Key change:** No separate "Phase 2: RESOLUTION" in Rust. No FactStore loading. Orchestrator is ~300 LOC of plugin DAG runner with zero language semantics.

### How references are resolved

Resolution happens in two stages, neither of which involves the Rust orchestrator:

**Stage 1: Intra-file scope resolution (Haskell postFile, Phase 1)**

The Haskell binary resolves scope chain references within each file as a post-pass. The scope chain is already in memory from the AST walk — no serialization needed.

- `walkNode` produces nodes, edges, and deferred refs (internal to Haskell)
- `resolveFileRefs` walks scope chain to resolve intra-file references
- Resolved refs → edges emitted in FileAnalysis
- Unresolved identifiers → REFERENCE nodes with `resolved: false`
- Import statements → IMPORT_BINDING nodes

`unresolvedRefs` never leave the Haskell process — they're created during walkNode and consumed during resolveFileRefs.

**Stage 2: Cross-file resolution (Haskell plugins, Phase 2)**

Cross-file resolution is a plugin in the DAG, using the same mechanism as enrichment:

1. **`js-import-resolution` plugin** queries IMPORT_BINDING nodes, matches to EXPORT_BINDING nodes in target modules. Handles re-export chains with visited set + iteration limit (max 100 depth).

2. **`runtime-globals` plugin** queries unresolved REFERENCE nodes (resolved:false), matches to runtime definitions (Node.js builtins, browser globals, etc.).

3. **`library-defs` plugin** queries 3rd-party IMPORT_BINDINGs, matches to LibraryDef stubs.

4. Each language provides its own resolution plugins (ESM/CJS for JS, `__init__.py` for Python, classpath for Java).

**No "resolution phase."** All post-analysis work (resolution, enrichment, validation) uses the unified plugin mechanism with DAG ordering. Resolution plugins have `depends_on: []` (run first). Enrichers depend on resolution. Validation depends on everything.

```yaml
plugins:
  - name: "js-import-resolution"
    command: "grafema-resolve imports"
    query: { type: "IMPORT_BINDING" }
    depends_on: []

  - name: "runtime-globals"
    command: "grafema-resolve runtime-globals"
    query:
      datalog: 'match(X) :- node(X, "REFERENCE"), attr(X, "resolved", "false").'
    depends_on: []

  - name: "express-routes"
    command: "grafema-enrich express"
    depends_on: ["js-import-resolution"]
```

### Decision 3: Generation GC, not Provenance

**Provenance tracking was tried before and failed.** Each node/edge was tagged with its producing rule + input bindings. On re-analysis, delete facts whose provenance no longer holds. In practice: provenance metadata exploded (3-5x graph size), provenance maintenance became the bottleneck, bugs in provenance tracking were harder to find than bugs in analysis.

**Generation GC:**
```
1. Bump generation counter: gen = current_gen + 1
2. Run analysis pipeline (all phases)
3. Every emitted/touched node/edge gets stamped: generation = gen
4. Delete everything where generation < gen
```

Properties:
- Zero metadata overhead during analysis (just a single integer per fact)
- Correctness by construction: if a rule didn't fire, its output is gone
- Works for all phases (per-file, resolution, enrichment) uniformly
- Incremental: re-analyze only changed files → only their nodes get new generation → old versions deleted
- File-scoped optimization: on single-file change, only GC nodes where `file = changed_file AND generation < gen`

### Decision 4: SemanticID for ALL nodes

SemanticID stays **human-readable** — that's the whole point of "Semantic" in the name.

Format: `file->TYPE->name[in:parent,h:xxxx]`

Extends to all nodes, not just code:
- Code: `src/auth.ts->FUNCTION->login[in:AuthService,h:a1b2]`
- Incidents: `pagerduty->INCIDENT->P1-2024-03-15[h:c3d4]`
- Features: `linear->FEATURE->user-auth[h:e5f6]`
- Metrics: `datadog->METRIC->api.latency.p99[h:g7h8]`

For plugin-derived nodes: `SemanticID = hash(plugin_name, input_node_id)` — deterministic, stable across re-runs if inputs don't change.

Worth the overhead (slightly longer IDs, hash computation) because:
- Debuggable: you can READ the ID and know what it is
- Stable: same code → same ID (enables incremental analysis)
- Composable: parent reference in ID creates implicit hierarchy

### Decision 5: Config-driven plugin system

Analysis is not hardcoded per language. Config declares what to run. Resolution, enrichment, and validation all use the same unified plugin mechanism:

```yaml
# .grafema/config.yaml
analysis:
  timeout_per_file: 30s    # default, per-file timeout
  plugins:
    - pattern: "*.{js,jsx,ts,tsx}"
      command: "grafema-core-v3 analyze"   # Haskell binary, analyze mode
      parser: "oxc"
      timeout: 60s                         # override for specific plugin
    - pattern: "*.java"
      command: "grafema-java analyze"      # Future: another Haskell binary
      parser: "javaparser"
    - pattern: "*.py"
      command: "grafema-python analyze"
      parser: "tree-sitter-python"

plugins:
  # Resolution plugins (run first, no dependencies)
  - name: "js-import-resolution"
    command: "grafema-resolve imports"
    query: { type: "IMPORT_BINDING" }
    depends_on: []

  - name: "runtime-globals"
    command: "grafema-resolve runtime-globals"
    query:
      datalog: 'match(X) :- node(X, "REFERENCE"), attr(X, "resolved", "false").'
    depends_on: []

  # Enrichment plugins (depend on resolution)
  - name: "express-routes"
    command: "grafema-enrich express"
    mode: streaming
    query:
      # Option A: simple spec
      type: "CALL"
      metadata: { method: ["get","post","put","delete"] }
      include_edges: ["READS_FROM"]
      # Option B: Datalog query (alternative)
      # datalog: |
      #   match(CallId) :- node(CallId, "CALL"), attr(CallId, "method", Method), ...
    depends_on: ["js-import-resolution"]

  - name: "django-models"
    command: "python3 enrichers/django.py"
    mode: batch
    depends_on: ["js-import-resolution"]

  - name: "react-components"
    command: "node enrichers/react.js"
    mode: streaming
    query:
      type: "CALL"
      metadata: { jsx: true }
    depends_on: ["js-import-resolution"]

  - name: "security-audit"
    command: "./enrichers/security-scanner"
    mode: batch
    depends_on: ["express-routes", "django-models"]

  # Validation plugins (depend on everything)
  - name: "dangling-edges"
    type: "datalog"
    file: "rules/validate-edges.dl"     # Existing top-down Datalog, no changes
    depends_on: ["express-routes", "react-components", "security-audit"]
```

**Key properties:**
- Analysis plugins = arbitrary commands that read AST and output FileAnalysis JSON
- Resolution = Haskell plugins with `depends_on: []` (run first in DAG)
- Enrichment = streaming (stdin/stdout JSON lines) or batch (RFDB socket) plugins in any language
- Validation = existing top-down Datalog queries that create ISSUE nodes
- ALL post-analysis plugins use the same mechanism — no separate "resolution phase"
- DAG dependencies via explicit `depends_on` — orchestrator topologically sorts and parallelizes independent plugins
- Plugin query supports flat spec OR Datalog query (for complex multi-hop patterns)

### Decision 6: No MATERIALIZE — resolution as plugins, not Rust code

**MATERIALIZE was removed from the plan.** Originally proposed as a Datalog extension for bottom-up fact creation, it was abandoned because:

1. **Requires a new bottom-up evaluator** with semi-naive optimization (~2000+ LOC) — the existing top-down evaluator can't do it
2. **Resolution is language-specific** — each language has its own import semantics (ESM/CJS, classpath, `__init__.py`), so resolution must be in Haskell plugins, not a generic Rust phase
3. **Enrichment is pattern matching**, not joins — Haskell or any language via plugin protocol
4. **No enricher needs the full graph** — each works on a small subset (<1-10%), queried by type/metadata

**Resolution is a Haskell plugin, not Rust code in the orchestrator.** The orchestrator has zero resolution logic — it's a language-agnostic DAG runner that spawns plugins. Resolution plugins (`js-import-resolution`, `runtime-globals`) use the same streaming/batch protocol as enrichment plugins.

**The plugin protocol handles resolution, enrichment, and validation uniformly.** See Decision 6a for the protocol spec.

**RFDB stays clean:** GraphStore + top-down Datalog for queries/guarantees. No new features needed.

### Decision 6a: Enrichment plugin protocol

Two modes, both supported for any language (Haskell, JS, Python, binary):

**Streaming mode** — orchestrator controls data flow, plugin is a pure function:

```
Orchestrator                         Plugin (any language)
    │                                    │
    │ query GraphStore per enricher spec │
    │ ────── JSON line ──────────────►   │ stdin
    │ ────── JSON line ──────────────►   │
    │                                    │ pattern match, process
    │ ◄────── emit_node JSON line ────   │ stdout
    │ ◄────── emit_edge JSON line ────   │
    │ ────── EOF ────────────────────►   │
    │ ◄────── EOF ───────────────────    │
```

Plugin doesn't know about RFDB. Stateless. Input: JSON lines on stdin. Output: JSON lines on stdout.

Input contract (per JSON line):
```json
{"node":{"id":"...","type":"CALL","name":"app.get","file":"src/app.ts","line":42,
  "metadata":{"method":"get","object":"app"},
  "edges":[{"type":"READS_FROM","target":"express-app-id","targetType":"VARIABLE","targetName":"app"}]}}
```

Output contract (per JSON line):
```json
{"emit_node":{"id":"...","type":"ROUTE","name":"/api/users","file":"src/app.ts","line":42,"metadata":{"method":"GET"}}}
{"emit_edge":{"from":"route-id","to":"handler-id","type":"HANDLES"}}
```

**Batch mode** — plugin controls execution, gets RFDB socket:

```
Orchestrator                         Plugin (any language)
    │                                    │
    │ spawn with env:                    │
    │   RFDB_SOCKET=/tmp/rfdb.sock       │
    │   RFDB_DATABASE=project-xyz        │
    │ ──────────────────────────────►    │
    │                                    │ connect to RFDB
    │                                    │ query → process → write
    │                                    │ query → process → write
    │ ◄──── exit code 0 ────────────    │
```

Plugin makes its own queries and writes results. Full autonomy. Needed for complex multi-query patterns.

**Config** (unified `plugins` section — resolution, enrichment, and validation all use the same mechanism):

```yaml
plugins:
  # Resolution (depends_on: [] → runs first)
  - name: "js-import-resolution"
    command: "grafema-resolve imports"
    mode: streaming
    query: { type: "IMPORT_BINDING" }
    depends_on: []

  - name: "runtime-globals"
    command: "grafema-resolve runtime-globals"
    mode: streaming
    query:
      datalog: 'match(X) :- node(X, "REFERENCE"), attr(X, "resolved", "false").'
    depends_on: []

  # Enrichment (depends on resolution)
  - name: "express-routes"
    command: "grafema-enrich express"
    mode: streaming
    query:
      type: "CALL"
      metadata: { method: ["get","post","put","delete"] }
      include_edges: ["READS_FROM"]
    depends_on: ["js-import-resolution"]

  - name: "django-models"
    command: "python3 enrichers/django.py"
    mode: batch
    depends_on: ["js-import-resolution"]

  - name: "react-components"
    command: "node enrichers/react.js"
    mode: streaming
    query:
      type: "CALL"
      metadata: { jsx: true }
    depends_on: ["js-import-resolution"]

  # Cross-enricher dependency
  - name: "security-audit"
    command: "./enrichers/security-scanner"
    mode: batch
    depends_on: ["express-routes", "django-models"]
```

**DAG parallelism:** Orchestrator topologically sorts by `depends_on`, runs independent plugins in parallel as separate OS processes. Multi-core utilization is free — each plugin is a separate process.

```
js-import-resolution (Haskell, streaming, depends_on: [])
runtime-globals (Haskell, streaming, depends_on: [])
    │
    ├─── express-routes (Haskell, streaming)  ──┐
    ├─── django-models (Python, batch)          ├── security-audit (binary, batch)
    ├─── react-components (JS, streaming)  ─────┘
    └─── type-propagation (Haskell, streaming)
```

**Plugin output handling:**
- Orchestrator buffers all streaming output in memory, writes atomically on plugin success (O1)
- Orchestrator validates streaming output before writing — node types, required fields, edge targets (C1)
- Orchestrator stamps `_source` + `_generation` metadata on all plugin output (R3)
- Per-file timeout with ISSUE node on skip (O4)
- Re-export cycle detection via visited set in `js-import-resolution` (O2)

### Decision 7a: Enrichment as separate binary

Per-file analysis and enrichment use different input types (ASTNode vs GraphNode). Mixing them in one binary creates coupling.

```
packages/
  core-v3/          # Per-file AST → graph (analyze mode only)
    src/
      AST/Types.hs  # ASTNode ADT (OXC ESTree)
      Rules/         # Per-AST-node rules
      Analysis/      # Walker, Context, SemanticId, postFile resolve

  resolvers/         # Cross-file resolution plugins (graph → resolved edges)
    src/
      Graph/Types.hs # GraphNode ADT (from GraphStore JSON, shared with enrichers)
      Resolvers/
        ImportResolution.hs   # IMPORT_BINDING → EXPORT_BINDING matching
        RuntimeGlobals.hs     # Unresolved REFERENCE → runtime definitions
      Protocol.hs    # Streaming JSON lines protocol

  enrichers/         # Graph → enriched graph (grafema-enrich)
    src/
      Enrichers/     # Per-library enricher modules
        Express.hs
        React.hs
        TypePropagation.hs

  grafema-common/    # Shared: SemanticId, MetaValue, GraphNode types, Protocol
```

**Key insight:** `core-v3` works with ASTNode (OXC ESTree JSON). Resolvers and enrichers work with GraphNode (RFDB graph JSON). Different input types → separate packages. `grafema-common` holds shared types including GraphNode ADT and the streaming protocol.

Binaries:
```
grafema-core-v3          # JS/TS per-file analyzer (Haskell, ASTNode → GraphNode)
grafema-resolve          # Cross-file resolution plugins (Haskell, GraphNode → edges)
grafema-enrich           # Enrichment plugins (Haskell, GraphNode → enriched graph)
grafema-java             # Java per-file analyzer (Haskell, future)
grafema-enrich-django    # Django enrichment (Python, future)
```

### Decision 8: FactStore — DEFERRED

**Original problem:** Datalog needs EDB tables for intermediate data: unresolvedRefs, LibraryDefs, config routing, framework hints.

**Revised status: DEFERRED.** The primary use case (unresolvedRefs) no longer needs FactStore — unresolvedRefs are internal to the Haskell binary, consumed during postFile scope resolve, never serialized. The remaining use cases:

- `library_export` → can be plugin config or graph nodes (EXPORT_BINDING nodes already exist)
- `file_pattern` → orchestrator config, not runtime data
- Framework hints → LibraryDef data, loaded by the Haskell binary directly

**Decision:** Don't build FactStore until a concrete need arises. Keep the SQLite design as a documented option for future use:

<details>
<summary>SQLite FactStore design (preserved for future reference)</summary>

Use SQLite via `rusqlite` (with `bundled` feature) as the FactStore alongside GraphStore.

```
RFDB
├── GraphStore (nodes, edges)       ← existing engine, disk-backed segments
├── FactStore (SQLite via rusqlite) ← FUTURE, for EDB tables if needed
└── Datalog Evaluator
    ├── node(), edge(), path(), attr()  → GraphStore
    ├── custom_table(), ...             → FactStore (SQL SELECT)
    └── derived rules                   → recursive eval
```

Why SQLite: disk-backed B-tree indexes, observable (`sqlite3` CLI), proven at scale, zero maintenance, ~1MB binary overhead.

Integration with Datalog evaluator:
```rust
// In eval_atom():
match atom.predicate() {
    "node" | "type" => self.eval_node(atom),
    "edge" => self.eval_edge(atom),
    predicate if self.fact_store.has_table(predicate) => {
        self.fact_store.query(predicate, atom.args())
    }
    _ => self.eval_derived(atom),
}
```
</details>

**Current architecture:** GraphStore only. All intermediate data either stays internal to plugins or becomes graph nodes.

### Decision 7: Language split rationale (revised)

| Computation | Language | Why |
|-------------|----------|-----|
| Per-file AST → graph | **Haskell** | Exhaustive pattern matching on ~160 OXC ESTree types + postFile scope resolve. Compiler catches missing cases. |
| Cross-file resolution | **Haskell plugin** | Language-specific (JS/Java/Python each have own resolution semantics). Same plugin protocol as enrichment. |
| Enrichment | **Haskell** (separate binary) + any language | Pattern matching on graph subsets. Streaming or batch mode. Library-specific rules. |
| Orchestration | **Rust** | Language-agnostic DAG runner. No resolution logic. File discovery, process management, parallelism, plugin DAG scheduling. |
| Queries + guarantees | **Datalog** (existing top-down in RFDB) | Unchanged. Works perfectly for `grafema check` and MCP queries. |
| Storage | **RFDB** (Rust) | GraphStore only. FactStore deferred until concrete need arises. |

**Why resolution moved from Rust orchestrator to Haskell plugins:**
Resolution is language-specific — JS has ESM/CJS imports, Java has classpath, Python has `__init__.py`. Putting resolution in the Rust orchestrator would leak language semantics into what should be a language-agnostic component. As a Haskell plugin, resolution uses the same mechanism as enrichment: streaming/batch protocol, DAG ordering, buffered writes.

**Orchestrator is fully language-agnostic:** ~300 LOC of plugin DAG runner. Knows nothing about imports, exports, scopes, or any language semantics.

**Datalog stays for queries/guarantees:** The existing top-down evaluator is perfect for `grafema check` and MCP queries. No changes needed.

### Resolved Questions

**Q1: DAG dependencies** → **Explicit `depends_on` in config.yaml.** Applies to all plugin types (analysis, enrichment, validation). Orchestrator topologically sorts, runs independent plugins in parallel. Revisit if bugs arise from manual dependency declaration.

**Q2: Enrichment plugin protocol** → **Two modes: streaming (stdin/stdout JSON lines) + batch (RFDB socket via env var).** See Decision 6a for full protocol spec. Each enricher declares its mode in config.

**Q3: Incremental enrichment** → **Generation GC + selective re-run.** On single-file change:
1. Re-analyze changed file (Haskell Phase 1, includes postFile scope resolve)
2. Re-run resolution plugins for affected imports (Phase 2 — fast, plugin queries only changed file's IMPORT_BINDINGs)
3. Re-run enrichment plugins whose input query matches changed file's nodes (Phase 2)
4. Generation GC deletes stale facts from previous run
Performance concern deferred — measure first, optimize if needed.

**Q4: Haskell binary contract** — Two modes, both JSON:

**Analyze mode** (per-file, Phase 1):
```
grafema-core-v3 analyze < ast.json > analysis.json
```
```json
{
  "nodes": [
    {"id": "...", "type": "FUNCTION", "name": "foo", ...},
    {"id": "...", "type": "REFERENCE", "name": "y", "resolved": false, ...},
    {"id": "...", "type": "IMPORT_BINDING", "name": "express", "source": "./express", ...}
  ],
  "edges": [
    {"from": "id1", "to": "id2", "type": "READS_FROM", ...}
  ],
  "exports": [{"name": "foo", "nodeId": "...", ...}]
}
```

No `unresolvedRefs` field. Unresolved identifiers are REFERENCE nodes with `resolved: false`. Imports are IMPORT_BINDING nodes. Both are regular graph nodes emitted in the `nodes` array.

**Enrich/resolve mode** (streaming, Phase 2 plugins):
```
grafema-resolve imports < input.jsonl > output.jsonl
grafema-enrich express < input.jsonl > output.jsonl
```
Input: JSON lines with nodes + edges (per plugin query spec).
Output: JSON lines with emit_node / emit_edge commands.

Both contracts are language-independent — any binary/script that implements them works as a plugin.

## Related

- [Theoretical Foundations](./theoretical-foundations.md) — 5 abstraction levels, Cognitive Dimensions
- [Declarative Semantic Rules](./declarative-semantic-rules.md) — completeness model, rules matrix
- [Sociotechnical Graph Model](./sociotechnical-graph-model.md) — 12 projections, inter-projection edges
- [01-semantic.md](./projections/01-semantic.md) — all ~160 OXC ESTree types mapped to semantic edges
