# Haskell Semantic Analysis for Grafema

**Status:** Research / Active
**Date:** 2026-03-04
**Origin:** core-v3 moved orchestrator+analyzer to Haskell/Rust → need to dogfood

## Context

Grafema's core-v3 is written in Haskell (per-file analyzer) and Rust (orchestrator, RFDB).
To dogfood Grafema on its own codebase, we need Haskell and Rust parsers + semantic rules.

Grafema = "Haskell for untyped code." Analyzing actual Haskell is ironic but valuable:
**types ≠ understanding**. GHC gives soundness, Grafema gives visibility.

## Parser: What Parses Haskell?

### Options

| Parser | Language | AST format | Pros | Cons |
|--------|----------|-----------|------|------|
| **GHC API** | Haskell | GHC's own AST (`HsExpr`, `HsDecl`, ...) | Complete, production-grade, type info available | Heavy dependency, GHC version coupling, complex API |
| **haskell-src-exts** | Haskell | Own AST (`Module`, `Decl`, `Exp`, ...) | Simpler API, widely used | Lags behind GHC extensions, no type info |
| **ghc-lib-parser** | Haskell | GHC AST (standalone) | GHC quality without full GHC dependency | Still complex API, large binary |
| **tree-sitter-haskell** | C/any | CST (generic tree) | Multi-language consistency, fast | CST not AST, lossy semantics, layout issues |
| **Ormolu/fourmolu internals** | Haskell | GHC AST | Battle-tested on real Haskell | Formatter-focused, not analysis-focused |

### Recommendation: ghc-lib-parser

**ghc-lib-parser** = GHC's parser extracted as standalone library. Best balance:
- Full GHC-quality parsing (all extensions, layout rule, etc.)
- No dependency on installed GHC
- Same AST as GHC → can leverage GHC documentation
- Used by HLS (Haskell Language Server), hlint, ormolu — battle-tested

Alternative: **tree-sitter-haskell** if we want consistency with multi-language strategy
(Rust already has tree-sitter-rust). But CST→AST gap is real for Haskell.

### GHC AST Structure (ghc-lib-parser)

Key types from `Language.Haskell.Syntax`:

```
Module level:
  HsModule          — top-level module
  ImportDecl         — import declaration
  HsDecl             — top-level declaration (sum type)
    ├── TyClDecl     — type/class declaration
    │   ├── DataDecl     — data/newtype
    │   ├── ClassDecl    — type class
    │   └── SynDecl      — type synonym
    ├── InstDecl     — instance declaration
    ├── ValDecl      — value binding (function/pattern)
    ├── SigDecl      — type signature
    ├── ForeignDecl  — FFI declaration
    └── ...

Expression level:
  HsExpr             — expression (sum type, ~40 constructors)
    ├── HsVar            — variable reference
    ├── HsApp            — function application (f x)
    ├── HsLam            — lambda (\x -> ...)
    ├── HsCase           — case expression
    ├── HsIf             — if-then-else
    ├── HsDo             — do-notation
    ├── HsLet            — let expression
    ├── OpApp            — operator application (a + b)
    ├── HsLit            — literal
    ├── ExplicitList     — [a, b, c]
    ├── ExplicitTuple    — (a, b)
    ├── RecordCon        — record construction Foo { x = 1 }
    ├── RecordUpd        — record update foo { x = 2 }
    ├── SectionL/R       — operator sections (+ 1), (1 +)
    ├── HsPar            — parenthesized expression
    ├── NegApp           — negation (- x)
    ├── ArithSeq         — [1..10], [1,3..10]
    └── ...

Pattern level:
  Pat                 — pattern (sum type)
    ├── VarPat           — variable pattern (x)
    ├── ConPat           — constructor pattern (Just x)
    ├── TuplePat         — tuple pattern (a, b)
    ├── ListPat          — list pattern [a, b]
    ├── WildPat          — wildcard (_)
    ├── AsPat            — as-pattern (x@(Just _))
    ├── LitPat           — literal pattern (42)
    ├── ViewPat          — view pattern (f -> pat)
    ├── BangPat          — strict pattern (!x)
    └── ...

Type level:
  HsType              — type expression
    ├── HsTyVar          — type variable (a)
    ├── HsAppTy          — type application (Maybe Int)
    ├── HsFunTy          — function type (a -> b)
    ├── HsListTy         — list type [a]
    ├── HsTupleTy        — tuple type (a, b)
    ├── HsQualTy         — qualified type (Eq a => ...)
    ├── HsForAllTy       — forall type
    └── ...

Binding level:
  HsBind              — value binding
    ├── FunBind          — function binding (f x = ...)
    ├── PatBind          — pattern binding (Just x = ...)
    └── VarBind          — simple variable binding

Match/Guard:
  Match               — one equation of a function
  GRHS                — guarded right-hand side
  GRHSs               — collection of guards + where clause
```

## Semantic Projections — What's Different from JS

### Projections Matrix: Haskell vs JS

```
                    JS    Haskell   Comment
                    ──    ───────   ───────
DFG                 ✓✓    ✓        Cleaner (purity) but laziness complicates
CFG                 ✓✓    ✓        No loops, recursion-based, guards
Scope               ✓✓    ✓        Simpler (no hoisting) but where/let/pattern vars
Call Graph          ✓     ✓✓✓      HOF + type class dispatch = complexity explosion
Module              ✓     ✓        Similar (import/export/re-export)
Structure           ✓     ✓✓       ADT + type classes = richer
Type                ✓✓✓   -        Useless — GHC does it better
Effect Flow         -     ✓✓✓      NEW. Impossible in JS, free in Haskell types
Evaluation/Demand   -     ✓✓       NEW. Laziness tracking (space leak detection)
Pattern Coverage    -     ✓✓       NEW. ADT exhaustiveness across functions
```

### Effect Flow (NEW — Haskell only)

Side effects are explicit in types: `IO a`, `ST s a`, `Reader r a`, `State s a`.

Graph can trace: for each function, which effects it carries and WHERE they came from.

```haskell
readFile :: FilePath -> IO String        -- IO effect: filesystem
processData :: String -> Result          -- PURE
writeResult :: Result -> IO ()           -- IO effect: filesystem

pipeline :: FilePath -> IO ()            -- IO from readFile + writeResult
```

Edge types: PROPAGATES_EFFECT, HAS_EFFECT, PURE_FUNCTION

### Evaluation/Demand (NEW — Haskell only)

Laziness = values computed only when demanded. Thunks accumulate → space leaks.

```haskell
let xs = [1..]           -- thunk (infinite)
    ys = map (+1) xs     -- thunk (depends on xs)
    z  = take 5 ys       -- FORCES ys, which forces xs (5 elements)
```

Edge types: DEMANDS, CREATES_THUNK, FORCES

### Pattern Coverage (NEW — Haskell only)

Which constructors does each function handle?

```haskell
data AST = Lit Int | Var String | App AST AST | Lam String AST

eval :: AST -> Value
eval (Lit n)   = ...     -- handles Lit
eval (App f x) = ...     -- handles App
-- MISSING: Var, Lam
```

Edge types: HANDLES_CONSTRUCTOR, MISSING_CONSTRUCTOR

## Node Types (Grafema vocabulary for Haskell)

### Core Node Types

| Node Type | Haskell Construct | JS Equivalent | Notes |
|-----------|------------------|---------------|-------|
| MODULE | `module Foo where` | ES module | + explicit export list |
| FUNCTION | `FunBind` | function decl/expr | Always pure unless typed IO |
| VARIABLE | `PatBind`, let/where | const/let/var | Immutable by default |
| CALL | `HsApp` | CallExpression | Space = call. `f x` not `f(x)` |
| TYPE_SIGNATURE | `SigDecl` | (none) | Explicit type declaration |
| DATA_TYPE | `DataDecl` | (none) | ADT definition |
| CONSTRUCTOR | `ConDecl` | (none) | Data constructor |
| TYPE_CLASS | `ClassDecl` | (none) | Interface-like |
| INSTANCE | `InstDecl` | (none) | Type class implementation |
| PATTERN | `Pat` variants | (none) | Pattern in case/function def |
| GUARD | `GRHS` | (none) | Guarded expression |
| DO_BLOCK | `HsDo` | (none) | Monadic sequencing |
| IMPORT | `ImportDecl` | ImportDeclaration | qualified, hiding, selective |
| EXPORT | export list item | export statement | Explicit export list |
| WHERE_BLOCK | local `where` | (none) | Local scope with bindings |
| LET_BLOCK | `HsLet` | (none) | Local scope in expression |
| LAMBDA | `HsLam` | ArrowFunction | `\x -> body` |
| OPERATOR | `OpApp` | BinaryExpression | Infix application |
| RECORD_FIELD | field in DataDecl | property | Named field in ADT |
| TYPE_VARIABLE | `HsTyVar` | (none) | Polymorphic type parameter |
| CONSTRAINT | `HsQualTy` context | (none) | `Eq a =>` requirement |

### Haskell-Specific Node Types (no JS analogue)

| Node Type | Purpose |
|-----------|---------|
| EFFECT | Tracks monadic effect type (IO, ST, Reader, ...) |
| THUNK | Unevaluated lazy computation |
| DERIVING | Automatic instance derivation |
| TYPE_FAMILY | Type-level computation |
| TYPE_SYNONYM | `type String = [Char]` |
| PATTERN_SYNONYM | Reusable pattern |
| PRAGMA | `{-# INLINE #-}`, `{-# LANGUAGE ... #-}` |

## Edge Types (Grafema vocabulary for Haskell)

### Shared with JS (same semantics)

| Edge Type | Meaning |
|-----------|---------|
| CALLS | Function calls function |
| IMPORTS_FROM | Module imports from module |
| EXPORTS | Module exports declaration |
| HAS_PARAMETER | Function has parameter |
| RETURNS | Function returns value/type |
| CONTAINS | Parent contains child (structure) |
| DEFINED_IN | Declaration defined in scope |
| REFERENCES | Expression references variable |
| ASSIGNED_FROM | Variable bound from expression |

### Modified semantics (same name, different meaning)

| Edge Type | JS Meaning | Haskell Meaning |
|-----------|-----------|-----------------|
| MUTATES | Modifies variable | N/A — no mutation in pure Haskell |
| THROWS | Throws exception | Rare — errors via types (Either, Maybe) |

### New edges (Haskell-specific)

| Edge Type | From → To | Meaning |
|-----------|-----------|---------|
| PROPAGATES_EFFECT | Function → Function | Callee's effect type flows to caller |
| HAS_EFFECT | Function → Effect | Function carries this effect |
| IMPLEMENTS | Instance → TypeClass | Instance implements class |
| DISPATCHES_VIA | Call → TypeClass | Call resolved through type class |
| HANDLES_CONSTRUCTOR | Pattern → Constructor | Pattern matches this constructor |
| DEMANDS | Expression → Expression | Forces evaluation of lazy value |
| CONSTRAINS | Constraint → TypeVariable | Type variable must satisfy class |
| DERIVES | DataType → TypeClass | Automatic instance derivation |
| HAS_FIELD | DataType → RecordField | Record has named field |
| SPECIALIZES | TypeApplication → Type | Concrete type for type variable |
| GUARDS | Guard → Expression | Guard condition for branch |
| BINDS_IN | WhereBlock → Function | Where clause provides local bindings |

## Semantic Rules Matrix (DFG column — first priority)

```
AST Node                  DFG Rule
────────                  ────────
HsApp (application)       value: argument → function, result → parent
HsLam (lambda)            value: body → parent (function value)
HsCase (case)             value: scrutinee → patterns; each body → parent
HsIf (if-then-else)       value: then|else → parent (conditional)
HsDo (do-notation)        value: last statement → parent; each >>= chains
HsLet (let-in)            value: body → parent; bindings → scope of body
OpApp (operator)          value: left, right → operator; result → parent
HsVar (variable)          value: referenced binding → parent
HsLit (literal)           TERMINAL (creates new value)
ExplicitList              value: elements → list → parent
ExplicitTuple             value: elements → tuple → parent
RecordCon                 value: field values → record → parent
RecordUpd                 value: base record + updates → new record → parent
SectionL/R                value: partial application → parent (function value)
FunBind (function def)    value: match bodies → binding name
PatBind (pattern bind)    value: rhs → bound names
Match (equation)          value: guarded RHS → function result
GRHS (guarded rhs)        value: guard true → body → parent
```

## Semantic Roles (L2 — cross-language)

| Role | JS Constructs | Haskell Constructs |
|------|--------------|-------------------|
| Callable | function, arrow, method | FunBind, Lambda, data constructor |
| Invocation | CallExpression | HsApp, OpApp |
| Declaration | var/let/const, function, class | FunBind, PatBind, DataDecl, ClassDecl |
| Import | import/export | ImportDecl, export list |
| Binding | assignment | PatBind, let, where, <- in do |
| Access | member expression | record field, module qualification |
| Control | if, for, switch, try | case, guards, if, do |
| **TypeClassDispatch** | (none) | Instance resolution for polymorphic call |
| **MonadicBind** | (none) | `x <- action` in do-notation |
| **PatternDestruct** | destructuring | Pattern matching in case/function |
| **Constraint** | (none) | `Eq a =>` type class constraint |

## Cognitive Dimensions — Where Grafema Adds Value for Haskell

GHC provides types. Grafema provides visibility. Orthogonal value:

| Dimension | GHC handles? | Grafema adds? | How |
|-----------|-------------|---------------|-----|
| Hidden Dependencies | No | Yes | Cross-module dependency graph |
| Viscosity | Partially (type errors) | Yes | Blast radius BEFORE changing code |
| Hard Mental Operations | No | Yes | `trace_dataflow` through N modules |
| Visibility | Partially (hoogle) | Yes | `find_nodes`, `find_calls` |
| Effect propagation | Type shows WHAT | Yes | Graph shows WHERE effect comes from |
| Pattern coverage | -Wincomplete-patterns | Yes | Cross-function constructor coverage matrix |

## Open Questions

1. **Parser choice finalization** — ghc-lib-parser vs tree-sitter-haskell. Tradeoff: semantic richness vs multi-language consistency
2. **Type info from GHC** — should we use GHC's type-checked AST (much richer) or just parsed AST? Type-checked = more edges but requires compilation
3. **Laziness analysis depth** — full demand analysis is research-grade (GHC's own demand analyzer is ~10k lines). What's the MVP?
4. **Effect tracking granularity** — track IO vs track Reader/Writer/State separately?
5. **Integration with existing Haskell tooling** — HLS already has go-to-def, find-references. Where does Grafema add value that HLS doesn't?

## Next Steps

1. Enumerate full GHC AST node types (from ghc-lib-parser source)
2. Fill semantic rules matrix for all projections
3. Prototype: parse a .hs file → Grafema nodes + edges
4. Validate on Grafema's own Haskell codebase (core-v3 analyzer)

## Related

- [Theoretical Foundations](./theoretical-foundations.md) — L1-L5 framework
- [Declarative Semantic Rules](./declarative-semantic-rules.md) — JS matrix (reference)
- [Rust Semantic Analysis](./rust-semantic-analysis.md) — companion document
