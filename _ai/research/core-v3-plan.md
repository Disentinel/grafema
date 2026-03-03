# Core v3: Haskell + Datalog Architecture

**Status:** Research / Architecture Plan
**Date:** 2026-03-03
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

**Three computational models → three languages.**

| Layer | Computation | Current (JS) | v3 |
|-------|------------|-------------|-----|
| Per-file analysis | Pattern match + context | Visitor pattern + mutable stacks | **Haskell** (AG + Reader/Writer) |
| Cross-file resolution | Joins + transitive closure | Imperative index building + BFS | **Datalog** (RFDB) |
| Orchestration | I/O, filesystem, CLI | Node.js | **Node.js** (unchanged) |

## Architecture

```
Source files
    │
    ▼
┌─────────────────────────────────────────┐
│ Phase 0: DISCOVER (JS)                  │
│   glob → file list → MODULE nodes       │
└─────────────────┬───────────────────────┘
                  │
    ┌─────────────┼─────────────┐
    │ per file:   │             │
    ▼             ▼             ▼
┌────────┐  ┌────────┐  ┌────────┐
│ Babel  │  │ Babel  │  │ Babel  │    Phase 1a: PARSE
│ parse  │  │ parse  │  │ parse  │    (JS, parallel)
└───┬────┘  └───┬────┘  └───┬────┘
    │           │           │
    ▼           ▼           ▼
┌────────┐  ┌────────┐  ┌────────┐
│Haskell │  │Haskell │  │Haskell │    Phase 1b: ANALYZE
│ binary │  │ binary │  │ binary │    (native, parallel)
└───┬────┘  └───┬────┘  └───┬────┘
    │           │           │
    └─────────┬─┘───────────┘
              │
              ▼
┌─────────────────────────────────────────┐
│ Phase 1c: INGEST (RFDB)                │
│   bulk insert nodes + edges + unresolved│
└─────────────────┬───────────────────────┘
                  │
                  ▼
┌─────────────────────────────────────────┐
│ Phase 2: RESOLVE (RFDB Datalog)         │
│   import resolution                     │
│   re-export chains (transitive closure) │
│   transitive extends                    │
│   arg-param binding                     │
│   derived edges                         │
│   domain rules (HTTP, Redis, WS)        │
│   guarantees / validation               │
└─────────────────────────────────────────┘
```

### What each language does

**Babel (JS):** `source code → JSON AST`. One job. Best-in-class JS/TS parser.

**Haskell binary:** `JSON AST → FileAnalysis JSON`. Per-file, stateless, parallel.
- Scope resolution (within file)
- Node + edge emission via Attribute Grammar rules
- Domain detection via LibraryDef (Express routes, Redis ops, Axios requests)
- DeferredRef emission for cross-file references
- Exhaustiveness guaranteed at compile time (253 AST types × all lenses)

**RFDB Datalog:** All cross-file work. One-shot on complete fact set.
- Import resolution, re-export chains
- Transitive closure (EXTENDS, DERIVES_FROM)
- Arg-param binding, call returns, instance-of
- Domain cross-file rules (HTTP req↔route, pub/sub, socket matching)
- Guarantees and validation (`.grafema/guarantees.yaml` → Datalog rules)

**Node.js orchestrator:** Glue. Discovery, Babel spawning, Haskell binary spawning, RFDB ingestion, CLI/MCP interface. No analysis logic.

## Haskell Binary Design

### Output format

```haskell
data FileAnalysis = FileAnalysis
  { nodes      :: [GraphNode]
  , edges      :: [GraphEdge]
  , unresolved :: [UnresolvedRef]   -- for Phase 2 Datalog
  , exports    :: [ExportInfo]      -- what this file exports
  }
```

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

```
rules/
├── core/
│   ├── imports.dl        -- import resolution, re-export chains
│   ├── types.dl          -- type resolution, transitive extends
│   ├── calls.dl          -- call resolution, callable targets
│   ├── args.dl           -- arg-param binding
│   ├── derived.dl        -- instance-of, call-returns, element-of
│   └── callbacks.dl      -- callback call resolution
│
├── domain/
│   ├── http.dl           -- generic: http:request ↔ http:route matching
│   ├── redis.dl          -- pub/sub channels, containment
│   ├── websocket.dl      -- socket event matching
│   ├── database.dl       -- query ↔ schema linking
│   └── messaging.dl      -- message queue pub/sub (Kafka, RabbitMQ)
│
└── validation/
    ├── broken-imports.dl -- unresolved import detection
    ├── sql-injection.dl  -- taint flow: user input → SQL query
    ├── dead-code.dl      -- exported but never imported
    └── guarantees.dl     -- user-defined invariant rules
```

## Performance

```
Pipeline for 10K file project (~500K LOC):

Phase 0:  Discovery       ~100ms   (glob)
Phase 1a: Babel parse     ~30-60s  ← BOTTLENECK (JS, single-threaded per file)
Phase 1b: Haskell walk    ~1-2s    (native binary, embarrassingly parallel)
Phase 1c: RFDB ingest     ~3-5s    (Rust, bulk insert ~50K nodes + ~200K edges)
Phase 2:  Datalog rules   ~0.5-2s  (Rust, one-shot evaluation)
───────────────────────────────────
Total:                    ~35-70s
```

Bottleneck is Babel parsing, not Datalog.

Future: replace Babel with oxc (Rust, 50-100x faster) → total ~5-10s.

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
- Datalog rules (cross-file resolution is language-agnostic)
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
4. Reuse LibraryDefs (Spring, Retrofit share HTTP patterns with Express, Axios)
5. Reuse ALL Datalog rules (cross-file resolution is language-agnostic)

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
| **resolve.ts** (cross-file) | ~1400 lines | ~80 lines Datalog | 94% |
| **15 enricher plugins** | ~3000 lines | ~120 lines Datalog | 96% |
| **Plugin base + orchestrator** | ~2000 lines | ~500 lines JS (simplified) | 75% |
| **Domain plugins** (Express etc.) | ~200 lines JS classes | ~30 lines LibraryDef data | 85% |
| **Domain enrichers** (5 plugins) | ~1050 lines | ~40 lines Datalog | 96% |
| **6 validation plugins** | ~800 lines | ~60 lines Datalog | 93% |
| **Types/interfaces** | ~500 lines | ~150 lines Haskell types | 70% |
| ──── | ──── | ──── | ──── |
| **Total analysis code** | **~13,400 lines JS** | **~1,980 lines (Haskell + Datalog + JS)** | **~85%** |

Breakdown of v3:
- ~1,000 lines Haskell (AG rules + types + generic walker)
- ~300 lines Datalog (core + domain + validation rules)
- ~500 lines JS (simplified orchestrator)
- ~180 lines LibraryDef data files

**What grows:** Test fixtures (sample ASTs + expected outputs), documentation, build infrastructure (GHC + Cabal).

**What disappears entirely:**
- Plugin base class hierarchy (Plugin, DomainPlugin, PluginMetadata, PluginContext)
- Propagation loop (consumes/produces/re-run logic)
- Per-enricher index building (15 × Map construction)
- DeferredRef kind dispatch (scope_lookup, call_resolve, type_resolve, etc.)
- Compensatory visitor patterns (visitIdentifier exclusions + compensators)
- Mutable stack management (_scopeStack, _functionStack, _classStack auto-pop)

## Migration Path

Not a rewrite. Incremental replacement:

**Step 1: Haskell binary for per-file analysis (replaces core-v2)**
- Haskell binary reads Babel JSON AST, outputs FileAnalysis JSON
- JS orchestrator calls Haskell binary instead of core-v2 walkFile
- Enrichers and resolve.ts still run in JS (unchanged)
- Validation: output must match core-v2 exactly (diff test suite)

**Step 2: Datalog rules for cross-file resolution (replaces resolve.ts)**
- Write Datalog rules in RFDB
- JS orchestrator loads unresolved refs, fires Datalog
- Enrichers still run in JS
- Validation: resolved edges must match resolve.ts output

**Step 3: Datalog rules for enrichment (replaces 15 enrichers)**
- One enricher at a time → Datalog rule
- Start with easiest: ExportEntityLinker, SocketConnectionEnricher
- End with hardest: ValueDomainAnalyzer, ServiceConnectionEnricher
- Validation: enriched graph must match enricher output

**Step 4: LibraryDef system (replaces domain plugins)**
- Express LibraryDef replaces ExpressPlugin + ExpressHandlerLinker + MountPointResolver
- Each library: LibraryDef + domain Datalog rules
- Validation: domain nodes/edges must match plugin output

**Step 5: Validation as Datalog (replaces validation plugins)**
- Each validation plugin → Datalog rule file
- Guarantees already in Datalog (grafema check)

**Step 6: Multi-language (new capability)**
- Java first (simplest AST, reveals cross-language patterns)
- Then Kotlin → Swift → Obj-C

## Multi-Language Support

### Time estimates (Opus 4.6 writing + debugging)

| Language | AST types | AG rules | Write | Debug | Libraries (top 10) |
|----------|-----------|----------|-------|-------|---------------------|
| **JS/TS** | 253 | ~800 lines | done | done | express, axios, react, ... |
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

### R2: Babel JSON AST serialization overhead

**Risk:** Babel AST → JSON → parse in Haskell adds serialization/deserialization cost. For large files (10K+ lines), the JSON AST can be 5-10MB.

**Severity:** Medium. Babel is already the bottleneck; serialization adds ~10-20% overhead.

**Mitigations:**
- Use MessagePack or CBOR instead of JSON (2-3x smaller, faster to parse).
- Use `stdout` pipe instead of temp files (streaming, no disk I/O).
- Long-term: replace Babel with oxc (Rust parser). Then oxc → Haskell via FFI or shared memory, no serialization at all.
- Alternative: Haskell WASM module called from JS, receives AST as in-memory object via WASM linear memory.

### R3: RFDB Datalog expressiveness

**Risk:** Some enrichment patterns may not be expressible in RFDB's current Datalog dialect. Specifically:
- `paths_match(URL, Path)` for parametric routes (`/api/:id` matches `/api/42`)
- String operations (concat, prefix matching, regex)
- Aggregation (COUNT, MIN for disambiguation)
- Negation-as-failure (stratified negation for priority-ordered resolution)

**Severity:** High. If Datalog can't express a pattern, it stays in JS — defeating the purpose.

**Mitigations:**
- Extend RFDB Datalog with built-in predicates: `string_concat`, `glob_match`, `regex_match`.
- Add aggregate support: `count`, `min`, `max` — standard in Souffle and DataScript.
- Stratified negation is well-understood theory; implement in RFDB.
- For truly inexpressible patterns (ValueDomainAnalyzer path-sensitivity): keep as Rust plugin in RFDB, callable from Datalog as an external predicate.
- Worst case: ~3 enrichers stay in JS/Rust. The other 12 move to Datalog. Still 80% reduction.

### R4: Two-binary deployment complexity

**Risk:** Shipping both a Haskell binary and a Rust binary (RFDB) alongside an npm package increases build/deployment complexity. Platform matrix: darwin-arm64, darwin-x64, linux-x64, linux-arm64, win-x64 = 5 platforms × 2 binaries = 10 artifacts.

**Severity:** Medium. Well-solved problem (esbuild, swc, Biome all do this).

**Mitigations:**
- `optionalDependencies` in npm with platform-specific packages (established pattern).
- GHC WASM backend → single `grafema-analyzer.wasm`, no platform matrix for Haskell.
- Docker image for CI/CD (both binaries pre-installed).
- Homebrew/apt/winget for standalone installation.
- Future: merge Haskell logic into RFDB as a Rust module (rewrite AG rules in Rust, ship one binary). Haskell serves as the prototyping/spec language, Rust as production target.

### R5: Haskell ↔ JSON AST fidelity

**Risk:** Babel's AST has undocumented fields, edge cases, and version-specific variations. The Haskell ADT may not match 100%, causing silent data loss or crashes.

**Severity:** Medium-High. Babel's AST is de facto, not formally specified.

**Mitigations:**
- Generate Haskell ADT from `@babel/types` definitions (same source core-v2 uses). Mechanical, not manual.
- Differential testing: run core-v2 (JS) and v3 (Haskell) on same files, diff outputs. Any mismatch = bug.
- Haskell's `aeson` JSON parsing with `rejectUnknownFields = False` — unknown fields logged, not crashed.
- Babel's `@babel/types` package has `NODE_FIELDS` definitions — exhaustive field list per type. Use as ground truth.

### R6: Incremental analysis complexity

**Risk:** Current architecture supports incremental re-analysis (changed files only, via `touchedFiles`). In v3, Haskell binary is stateless per-file (good for incremental), but Datalog rules fire on the ENTIRE fact set. Re-running all Datalog rules after one file changes may be expensive for large projects.

**Severity:** Medium. Matters for IDE-scale latency (<1s response).

**Mitigations:**
- Haskell binary: already per-file, naturally incremental. Re-analyze only changed file.
- RFDB: on file change, delete old nodes/edges for that file, insert new ones, re-run Datalog on the delta.
- Semi-naive evaluation (standard Datalog optimization): only propagate changes from new/modified facts, don't re-derive unchanged conclusions.
- For IDE latency: skip Datalog for single-file edits (per-file analysis is sufficient for local navigation). Run full Datalog on save/build.

### R7: Testing and correctness verification

**Risk:** core-v2 has ~500 test fixtures. Rewriting in Haskell means either porting all tests or building a differential testing harness. Bugs in AG rules are subtle — wrong edge type, missing edge, wrong scope — and hard to catch without comprehensive tests.

**Severity:** Medium. Addressed by migration strategy.

**Mitigations:**
- Step 1 of migration: differential testing. v3 output MUST match core-v2 output for all existing test fixtures.
- Property-based testing (QuickCheck): generate random ASTs, verify invariants (every CALL has a target or an ISSUE, every IMPORT resolves or has an error, scope chains are acyclic).
- Exhaustiveness matrix: 253 AST types × 8 lenses. Haskell compiler warns if any cell is unhandled.
- Grafema guarantees (`grafema check`): existing guarantee rules validate graph structural invariants. These are Datalog rules that run on the output — independent of implementation language.

### Risk summary

| Risk | Severity | Mitigation quality | Net risk |
|------|----------|-------------------|----------|
| R1: Haskell hiring | High | Medium (LLMs, DSL escape hatch) | **Medium-High** |
| R2: JSON serialization | Medium | High (MessagePack, oxc) | **Low** |
| R3: Datalog expressiveness | High | Medium (extend RFDB, keep ~3 in Rust) | **Medium** |
| R4: Two-binary deploy | Medium | High (solved problem, WASM) | **Low** |
| R5: AST fidelity | Medium-High | High (codegen ADT, diff testing) | **Low-Medium** |
| R6: Incremental analysis | Medium | Medium (semi-naive, skip for IDE) | **Medium** |
| R7: Testing | Medium | High (differential, property-based) | **Low** |

**Top 2 risks: R1 (Haskell talent) and R3 (Datalog expressiveness).** Both have escape hatches but require active investment.

## What We Actually Designed

### The realization

This is not a code analysis tool. We designed a **formal ontology of software engineering** — a universal knowledge graph with provable properties, into which any tool with an API integrates as a data source.

### What this is

1. **Exhaustive per-node analysis** (Attribute Grammars / Haskell) guarantees every AST construct in every supported language produces correct graph edges — verified at compile time.
2. **Declarative cross-file resolution** (Datalog) replaces thousands of lines of imperative graph traversal with ~50 lines of recursive rules that are provably terminating and sound.
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
- Joins + transitive closure → Datalog (it was DESIGNED for this)
- I/O + glue → JS/Node (it was DESIGNED for this)

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

1. **Accumulated rules.** 253 AST types × AG rules + 100+ LibraryDefs + Datalog rules = person-years of semantic knowledge encoded in small, verifiable units.

2. **Velocity.** LLM-native development model. Someone forks → in a month we have +3 languages and +20 LibraryDefs. They're still reading the architecture doc.

3. **Network effect from integrations.** Each adapter (Linear, Datadog, PagerDuty...) adds value to all others via cross-projection Datalog rules. More connected projections → exponentially more valuable queries. Fork without integrations = empty graph.

### Licensing strategy (under consideration)

Option A: Full open source (MIT/Apache). Moat = velocity + accumulated rules + integrations.

Option B: **Split repo.** Public: CLI, MCP, VSCode extension, binary distribution. Private: Haskell analyzer core, AG rules, LibraryDefs. Public repo ships pre-compiled binaries (`@grafema/analyzer-{platform}`). Users get the tool; the semantic engine is proprietary.

Option B gives: open ecosystem (anyone builds on the graph) + proprietary core (the hard-to-replicate engine). Precedent: MongoDB (SSPL), Elasticsearch (proprietary after 7.x), CockroachDB (BSL). More relevant: Turso (libSQL open, cloud proprietary), Neon (compute open, storage proprietary).

## Related

- [Theoretical Foundations](./theoretical-foundations.md) — 5 abstraction levels, Cognitive Dimensions
- [Declarative Semantic Rules](./declarative-semantic-rules.md) — completeness model, rules matrix
- [Sociotechnical Graph Model](./sociotechnical-graph-model.md) — 12 projections, inter-projection edges
- [01-semantic.md](./projections/01-semantic.md) — all 253 Babel AST types mapped to semantic edges
