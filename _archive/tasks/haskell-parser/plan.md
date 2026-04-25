# Haskell Semantic Analyzer for Grafema

## Context

Grafema's core-v3 is written in Haskell (analyzer) + Rust (orchestrator, RFDB). To dogfood Grafema on its own codebase and reduce cognitive load for humans and AI agents working on Grafema, we need Haskell language support. The Haskell codebase is 28 files / 5,111 lines across 3 packages (core-v3, grafema-common, grafema-resolve).

**Goal**: Full Haskell analyzer — all semantic projections (structure, scope, modules, call graph, DFG, effect flow, demand/laziness, pattern coverage). General-purpose, reusable for any Haskell project.

**Parser**: ghc-lib-parser (GHC already installed for development; distributed as compiled binary).

## Architecture

New Cabal package `packages/haskell-analyzer/` following the exact pattern of `packages/core-v3/`:

```
Source (.hs) → ghc-lib-parser (internal) → GHC AST → Walker + Rules → FileAnalysis JSON
```

Key difference from JS analyzer: **no external parser step**. The Haskell analyzer parses internally via ghc-lib-parser, so the orchestrator sends raw source text (`{"file":"...","source":"..."}`) instead of pre-parsed AST.

Same output format (FileAnalysis JSON), same daemon protocol (length-prefixed frames), same grafema-common types.

---

## Phase 1: Skeleton + Parser + MODULE node

**Goal**: Parse `.hs` with ghc-lib-parser, emit MODULE node, validate end-to-end pipeline.

### Create

| File | Purpose |
|------|---------|
| `packages/haskell-analyzer/haskell-analyzer.cabal` | Package definition (exe + test-suite), deps: ghc-lib-parser, grafema-common |
| `packages/haskell-analyzer/src/Main.hs` | Entry point: `--daemon` (length-prefixed frames) + stdin (streaming) modes |
| `packages/haskell-analyzer/src/Parser.hs` | `parseHaskell :: Text -> Text -> Either String (HsModule GhcPs)` — configure DynFlags, invoke ghc-lib-parser |
| `packages/haskell-analyzer/src/Analysis/Types.hs` | FileAnalysis, DeferredRef, Scope, Declaration — adapted from core-v3 with Haskell scope kinds |
| `packages/haskell-analyzer/src/Analysis/Context.hs` | `type Analyzer a = ReaderT Ctx (Writer FileAnalysis) a` — same monad stack as core-v3 |
| `packages/haskell-analyzer/src/Analysis/Walker.hs` | `walkModule :: HsModule GhcPs -> Analyzer ()` — emit MODULE, iterate declarations |
| `packages/haskell-analyzer/src/Loc.hs` | Extract line/column from `SrcSpan`, `Located` wrappers |
| `packages/haskell-analyzer/test/Spec.hs` | Tests: parse minimal module, parse with syntax error, round-trip on core-v3 files |

### Modify

| File | Change |
|------|--------|
| `packages/core-v3/cabal.project` | Add `../haskell-analyzer` to packages list |

### Nodes: MODULE, IMPORT (stub), EXPORT (stub)

### Tests
- Parse `module Foo where` → MODULE node
- Parse `module Foo (bar) where` → EXPORT in list
- Parse file with syntax error → graceful failure
- Parse `packages/core-v3/src/Main.hs` → no crash, valid JSON output

---

## Phase 2: Structure (Declarations)

**Goal**: All declaration-level nodes — functions, data types, type classes, instances, type signatures.

### Create

| File | Purpose |
|------|---------|
| `src/Rules/Declarations.hs` | FunBind → FUNCTION, PatBind → VARIABLE, SigDecl → TYPE_SIGNATURE |
| `src/Rules/DataTypes.hs` | DataDecl → DATA_TYPE, ConDecl → CONSTRUCTOR, ConDeclField → RECORD_FIELD, DerivDecl → DERIVING |
| `src/Rules/TypeClasses.hs` | ClassDecl → TYPE_CLASS, InstDecl → INSTANCE + IMPLEMENTS edge |
| `src/Rules/TypeLevel.hs` | SynDecl → TYPE_SYNONYM, FamDecl → TYPE_FAMILY |

### Modify: `Analysis/Walker.hs` — dispatch HsDecl constructors to rule modules

### Nodes: FUNCTION, VARIABLE, TYPE_SIGNATURE, DATA_TYPE, CONSTRUCTOR, RECORD_FIELD, TYPE_CLASS, INSTANCE, TYPE_SYNONYM, TYPE_FAMILY, DERIVING
### Edges: CONTAINS, HAS_FIELD, IMPLEMENTS, DERIVES

### Tests
- `data Color = Red | Green | Blue` → DATA_TYPE + 3 CONSTRUCTORs
- `data Person = Person { name :: String, age :: Int }` → RECORD_FIELDs + HAS_FIELD
- `class Show a where show :: a -> String` → TYPE_CLASS
- `instance Show Color where ...` → INSTANCE + IMPLEMENTS
- Run on `packages/core-v3/src/Analysis/Types.hs` → DATA_TYPE nodes for DeferredKind, FileAnalysis, Scope, etc.

---

## Phase 3: Module Graph (Imports/Exports)

**Goal**: Full import/export modeling. Haskell imports: qualified, hiding, selective, as-renamed.

### Create

| File | Purpose |
|------|---------|
| `src/Rules/Imports.hs` | ImportDecl → IMPORT + IMPORT_BINDING nodes. Metadata: qualified, alias, hiding, source. DeferredRef for cross-file resolution |
| `src/Rules/Exports.hs` | Export list → EXPORT_BINDING nodes (IEVar, IEThingAbs/All/With, IEModuleContents for re-exports) |

### Nodes: IMPORT, IMPORT_BINDING, EXPORT_BINDING
### Edges: IMPORTS_FROM (deferred), EXPORTS

### Tests
- `import Data.Text (Text, pack)` → IMPORT + 2 IMPORT_BINDING
- `import qualified Data.Map.Strict as Map` → qualified=true, alias="Map"
- `import Data.List hiding (sort)` → hiding=true
- `module Foo (bar, Quux(..)) where` → EXPORT_BINDINGs
- Run on `packages/core-v3/src/Rules/Declarations.hs` → capture all its imports

---

## Phase 4: Scope + Call Graph

**Goal**: Scoping (where/let/lambda/case/do), function calls (HsApp, OpApp), intra-file resolution.

### Create

| File | Purpose |
|------|---------|
| `src/Rules/Expressions.hs` | HsApp → CALL, OpApp → OPERATOR/CALL, HsVar → REFERENCE, HsLam → LAMBDA, HsCase → BRANCH, HsIf → BRANCH, HsDo → DO_BLOCK, HsLet → LET_BLOCK, literals, records, sections (~20 constructors) |
| `src/Rules/Patterns.hs` | VarPat → declare in scope, ConPat → PATTERN + HANDLES_CONSTRUCTOR, AsPat, WildPat, LitPat, ViewPat, BangPat |
| `src/Rules/Guards.hs` | GRHSs → walk guards + where clause, GRHS → GUARD + GUARDS edge, local where → WHERE_BLOCK |
| `src/Analysis/Scope.hs` | Haskell scope kinds: WhereScope, LetScope, CaseScope, DoScope, LambdaScope |
| `src/Analysis/Resolve.hs` | Intra-file scope resolution (same algorithm as core-v3) |

### Modify: `Analysis/Walker.hs` — add walkExpr (~40 constructors), walkPat (~15), walkMatch, walkLocalBinds

### Nodes: CALL, REFERENCE, LAMBDA, OPERATOR, PATTERN, GUARD, DO_BLOCK, WHERE_BLOCK, LET_BLOCK, BRANCH, SCOPE, PARAMETER
### Edges: CALLS (deferred), REFERENCES, RECEIVES_ARGUMENT, PASSES_ARGUMENT, HANDLES_CONSTRUCTOR, GUARDS, BINDS_IN, HAS_SCOPE

### Tests
- `f x = x + 1` → FUNCTION, PARAMETER, REFERENCE → PARAMETER resolution
- `g x = let y = x in y + 1` → LET_BLOCK, scope resolution
- `h x = case x of { Just y -> y; Nothing -> 0 }` → PATTERN + HANDLES_CONSTRUCTOR
- `map f (x:xs) = f x : map f xs` → multi-equation patterns
- `do { x <- getLine; putStrLn x }` → DO_BLOCK, monadic bindings
- `f x | x > 0 = x; f x = -x` → GUARD nodes
- Run on `packages/core-v3/src/Analysis/Walker.hs` → FUNCTION nodes, CALL nodes for rule dispatches

---

## Phase 5: Data Flow Graph (DFG)

**Goal**: Value flow through expressions. Cleaner than JS (purity = no side-effect tracking here).

### Modify: Expression/pattern/guard rules from Phase 4 to emit DFG edges

### DFG Rules (from research doc)
```
HsApp      → argument → function, result → parent
HsLam      → body → parent (function value)
HsCase     → scrutinee → patterns; each body → parent
HsIf       → then|else → parent
HsDo       → last statement → parent; >>= chains
HsLet      → body → parent; bindings → scope
OpApp      → left, right → operator; result → parent
FunBind    → match bodies → binding name
PatBind    → rhs → bound names
Match      → guarded RHS → function result
GRHS       → guard true → body → parent
```

### Edges: ASSIGNED_FROM, RETURNS, DERIVED_FROM
### Tests
- `f x = x + 1` → DERIVED_FROM x, 1 to `+`, RETURNS to f
- `g = \x -> x` → value flow x → lambda → g
- `case x of True -> 1; False -> 0` → both branches flow to result

---

## Phase 6: Effect Flow + Evaluation/Demand

**Goal**: Haskell-specific projections — monadic effects from type sigs, laziness/strictness.

### Create

| File | Purpose |
|------|---------|
| `src/Rules/Effects.hs` | Scan type sigs for IO/ST/Reader/Writer/State → EFFECT node + HAS_EFFECT edge. PROPAGATES_EFFECT for callers. Pure functions get `pure: true` metadata |
| `src/Rules/Demand.hs` | BangPat → DEMANDS, strict fields → metadata, `seq`/`$!` → DEMANDS, thunk creation metadata |
| `src/Rules/Types.hs` | Walk HsType: TYPE_VARIABLE, CONSTRAINT (HsQualTy), CONSTRAINS edges, SPECIALIZES edges |
| `src/Rules/Pragmas.hs` | INLINE/SPECIALIZE/LANGUAGE pragmas → metadata on relevant nodes |

### Nodes: EFFECT, TYPE_VARIABLE, CONSTRAINT, PRAGMA
### Edges: HAS_EFFECT, PROPAGATES_EFFECT, DEMANDS, CONSTRAINS, SPECIALIZES

### Tests
- `readFile :: FilePath -> IO String` → EFFECT "IO" + HAS_EFFECT
- `process :: String -> Int` → no EFFECT, pure=true
- `data Strict = Strict !Int !String` → strict fields
- `f !x = x + 1` → DEMANDS edge
- `class Eq a => Ord a where ...` → CONSTRAINT + CONSTRAINS

---

## Phase 7: Pattern Coverage + Type Class Dispatch

**Goal**: Constructor coverage matrix, type class virtual dispatch tracking.

### Create

| File | Purpose |
|------|---------|
| `src/Rules/Coverage.hs` | Post-pass: collect HANDLES_CONSTRUCTOR per function, compare to DATA_TYPE constructors → MISSING_CONSTRUCTOR edges |
| `src/Rules/Dispatch.hs` | When CALL target is type class method → DISPATCHES_VIA edge. Intra-file: check ClassDecl methods. Cross-file: DeferredRef |

### Edges: MISSING_CONSTRUCTOR, DISPATCHES_VIA

### Tests
- Missing constructor: `area Circle = ...; area Square = ...` (missing Triangle) → MISSING_CONSTRUCTOR
- Dispatch: `display x = putStrLn (show x)` where show is class method → DISPATCHES_VIA

---

## Phase 8: Orchestrator Integration

**Goal**: Route `.hs` files to haskell-analyzer, mixed JS+Haskell projects work.

### Modify

| File | Change |
|------|--------|
| `packages/grafema-orchestrator/src/analyzer.rs` | Add `analyze_haskell_file()` — sends `{"file":"...","source":"..."}` (raw source, not AST). Add `HaskellPool` alongside existing grafema-analyzer pool. Route by extension: `.hs` → haskell-analyzer, `.js/.ts/.jsx/.tsx` → grafema-analyzer |
| `packages/grafema-orchestrator/src/main.rs` | Partition discovered files by language. Create separate pools. Merge results for RFDB ingestion |
| `packages/grafema-orchestrator/src/config.rs` | Optional `analyzers` config map. Default: extension-based detection |

### Tests
- Integration test: temp dir with `.js` + `.hs` files, both analyzed, valid RFDB ingestion

---

## Phase 9: Cross-File Resolution for Haskell

**Goal**: Resolve Haskell imports across files (module name → file, selective imports → declarations).

### Create

| File | Purpose |
|------|---------|
| `packages/grafema-resolve/src/HaskellImportResolution.hs` | Module name → file path mapping (Haskell conventions: Data.Map.Strict → Data/Map/Strict.hs). Export index building. Selective import resolution. Re-export chain following |

### Modify
| File | Change |
|------|--------|
| `packages/grafema-resolve/src/Main.hs` | Add `haskell-imports` command |
| `packages/grafema-resolve/grafema-resolve.cabal` | Add HaskellImportResolution module |

### Tests
- Two-file: `module A (foo) where foo = 1` + `module B where import A (foo); bar = foo` → IMPORTS_FROM edge B→A

---

## Phase Dependencies

```
Phase 1 (Skeleton) ──→ Phase 2 (Structure) ──→ Phase 3 (Modules)
                                │
                                └──→ Phase 4 (Scope + Calls) ──┬→ Phase 5 (DFG)
                                                                ├→ Phase 6 (Effects)
                                                                └→ Phase 7 (Coverage)

Phase 1 ──→ Phase 8 (Orchestrator) ──→ Phase 9 (Cross-file)
Phase 3 ──→ Phase 9
```

Phases 5, 6, 7 are independent of each other (parallelizable). Phase 8 can start after Phase 1.

---

## Verification

After each phase, run on Grafema's own Haskell codebase (28 files):
```bash
# Build
cd packages/haskell-analyzer && cabal build

# Test single file
echo '{"file":"src/Main.hs","source":"..."}' | haskell-analyzer

# Test all files
for f in packages/core-v3/src/**/*.hs; do haskell-analyzer "$f"; done

# After Phase 8: full pipeline
grafema-orchestrator analyze --config grafema.config.yaml
```

After Phase 9 (full integration):
```bash
# MCP validation
grafema find_nodes --type FUNCTION --file "*.hs"
grafema find_calls --name walkNode
grafema trace_dataflow --node "Analysis.Walker->FUNCTION->walkNode"
grafema get_file_overview --file "packages/core-v3/src/Analysis/Walker.hs"
```

---

## Technical Risks

| Risk | Mitigation |
|------|------------|
| ghc-lib-parser API complexity (XRec, GhcPs pass, Located wrappers) | Thin wrapper in Loc.hs that uniformly extracts locations |
| GHC version coupling | Pin to specific ghc-lib-parser version matching installed GHC |
| Binary size (~80MB from ghc-lib-parser) | Acceptable for dev tooling; strip symbols in release |
| Compilation time | Cache deps via `cabal build --only-dependencies` |
| Effect detection without type-checked AST | Heuristic: scan type signatures for IO/ST/etc. — good enough for visibility |
| Laziness analysis depth | Syntactic only (BangPatterns, `!` fields, `seq`, `$!`) — not GHC's demand analyzer |

## Critical Files (Reference)

- `packages/core-v3/src/Analysis/Context.hs` — monad stack pattern to replicate
- `packages/core-v3/src/Analysis/Types.hs` — FileAnalysis, DeferredRef, Scope types to adapt
- `packages/grafema-common/src/Grafema/Types.hs` — GraphNode, GraphEdge, MetaValue to reuse
- `packages/grafema-common/src/Grafema/Protocol.hs` — daemon protocol (readFrame/writeFrame)
- `packages/grafema-orchestrator/src/analyzer.rs` — orchestrator routing to modify
- `packages/grafema-orchestrator/src/main.rs` — pipeline coordination to modify
