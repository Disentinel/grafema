# Rust Semantic Analysis for Grafema

**Status:** Research / Active
**Date:** 2026-03-04
**Origin:** core-v3 moved orchestrator+RFDB to Rust → need to dogfood

## Context

Grafema's core-v3: Rust orchestrator pipeline, RFDB graph database (Rust).
To dogfood Grafema on its own codebase, we need a Rust parser + semantic rules.

Rust is typed, but like Haskell, **types ≠ understanding**. The compiler gives soundness;
Grafema gives visibility, blast radius, cross-module dependency tracking.

Rust also has UNIQUE semantic properties (ownership, lifetimes, unsafe) that no other
language has — these create new projections that don't exist for JS or Haskell.

## Parser: What Parses Rust?

### Options

| Parser | Language | AST format | Pros | Cons |
|--------|----------|-----------|------|------|
| **syn** | Rust | Rust AST types | De facto standard, full syntax, proc-macro ecosystem | Rust-only, requires Rust toolchain |
| **rust-analyzer (RA)** | Rust | Rowan CST → semantic model | IDE-grade, incremental, type info | Complex API, heavy dependency |
| **tree-sitter-rust** | C/any | CST (generic tree) | Multi-language consistency, fast, no Rust toolchain needed | CST not AST, no type info |
| **rustc API** | Rust | HIR/MIR | Full compiler info including types, lifetimes | Unstable API, massive dependency |

### Recommendation: syn (primary) + tree-sitter-rust (fallback)

**syn** = best balance for Rust analysis:
- Full Rust syntax support (all editions)
- Clean, well-documented AST types
- Can run in Grafema's Rust orchestrator natively
- Active maintenance, huge ecosystem
- Outputs structured AST (not CST)

**tree-sitter-rust** = fallback for multi-language consistency:
- If Grafema standardizes on tree-sitter for all languages
- Good enough for structure/module/call analysis
- Misses some Rust-specific semantics

### syn AST Structure

Key types from `syn` crate:

```
File level:
  File                — top-level file (items + attributes)

Item level (top-level declarations):
  Item                 — sum type of all items
    ├── ItemFn           — function definition
    ├── ItemStruct       — struct definition
    ├── ItemEnum         — enum definition
    ├── ItemImpl         — impl block
    ├── ItemTrait        — trait definition
    ├── ItemMod          — module (mod foo { ... } or mod foo;)
    ├── ItemUse          — use declaration
    ├── ItemType         — type alias
    ├── ItemConst        — const declaration
    ├── ItemStatic       — static declaration
    ├── ItemForeignMod   — extern block (FFI)
    ├── ItemMacro        — macro invocation
    └── ItemMacro2       — macro 2.0 definition

Expression level:
  Expr                 — expression (sum type, ~40 variants)
    ├── ExprCall         — function call: f(x)
    ├── ExprMethodCall   — method call: x.f()
    ├── ExprBinary       — binary op: a + b
    ├── ExprUnary        — unary op: !x, -x, *x (deref)
    ├── ExprBlock        — block expression { ... }
    ├── ExprIf           — if/else
    ├── ExprMatch        — match expression (pattern matching)
    ├── ExprLoop         — loop { ... }
    ├── ExprWhile        — while expr { ... }
    ├── ExprForLoop      — for pat in expr { ... }
    ├── ExprReturn       — return expr
    ├── ExprBreak        — break (with optional value)
    ├── ExprContinue     — continue
    ├── ExprClosure      — |args| body
    ├── ExprField        — struct field access: x.field
    ├── ExprIndex        — indexing: x[i]
    ├── ExprPath         — path expression: std::io::Read
    ├── ExprReference    — borrow: &x, &mut x
    ├── ExprStruct       — struct literal: Foo { x: 1 }
    ├── ExprTuple        — tuple: (a, b)
    ├── ExprArray        — array: [a, b, c]
    ├── ExprRange        — range: 1..10
    ├── ExprAwait        — async: expr.await
    ├── ExprAsync        — async block: async { ... }
    ├── ExprTry          — ? operator: expr?
    ├── ExprLet          — let guard: let Some(x) = expr
    ├── ExprAssign       — assignment: x = expr
    ├── ExprUnsafe       — unsafe { ... }
    ├── ExprLit          — literal
    └── ExprCast         — type cast: x as T

Pattern level:
  Pat                  — pattern
    ├── PatIdent         — identifier pattern (x, mut x, ref x)
    ├── PatStruct        — struct pattern: Foo { x, y }
    ├── PatTupleStruct   — tuple struct: Some(x)
    ├── PatTuple         — tuple: (a, b)
    ├── PatPath          — path: None, Foo::Bar
    ├── PatWild          — wildcard: _
    ├── PatOr            — or-pattern: A | B
    ├── PatRange         — range: 1..=10
    ├── PatReference     — reference: &x, &mut x
    ├── PatSlice         — slice: [a, b, ..]
    └── PatLit           — literal: 42

Type level:
  Type                 — type expression
    ├── TypePath         — named type: Vec<i32>
    ├── TypeReference    — reference: &T, &mut T, &'a T
    ├── TypeSlice        — slice: [T]
    ├── TypeArray        — array: [T; N]
    ├── TypeTuple        — tuple: (A, B)
    ├── TypeFn           — function: fn(A) -> B
    ├── TypeImplTrait    — impl Trait
    ├── TypeTraitObject  — dyn Trait
    └── TypeNever        — never: !
```

## Semantic Projections — What's Different from JS

### Projections Matrix: Rust vs JS vs Haskell

```
                    JS    Haskell   Rust      Comment
                    ──    ───────   ────      ───────
DFG                 ✓✓    ✓         ✓✓       Move semantics change flow (value moves, not copies)
CFG                 ✓✓    ✓         ✓✓       Rich: loops + match + ? early return
Scope               ✓✓    ✓         ✓✓       Block scoping + lifetime scopes
Call Graph          ✓     ✓✓✓       ✓✓       Traits (simpler than type classes, no HOF explosion)
Module              ✓     ✓         ✓        mod/use/pub — visibility system
Structure           ✓     ✓✓        ✓✓       struct/enum/impl/trait
Type                ✓✓✓   -         ✓        Partial value — generics, trait bounds
Ownership           -     -         ✓✓✓      UNIQUE. Move/borrow/lifetime graph
Unsafe Boundary     -     -         ✓✓       UNIQUE. Sound abstraction tracking
Effect Flow         -     ✓✓✓       ✓        Result/Option chains (not type-level like Haskell)
```

### Ownership Graph (NEW — Rust only)

THE defining feature. No other language has this.

```rust
let s = String::from("hello");  // s OWNS String
let r = &s;                      // r BORROWS s (immutable)
let m = &mut s;                  // m BORROWS s (mutable) — can't coexist with r
let t = s;                       // s MOVES to t — s is DEAD
// s is no longer valid here
```

Edges:
- `OWNS` — variable owns heap data
- `BORROWS` — reference borrows from owner (+ mutable flag)
- `MOVES_TO` — ownership transfers, source invalidated
- `DROPS_AT` — value destroyed at scope exit (deterministic!)
- `LIFETIME_BOUND` — reference's lifetime constraint

This graph answers: "who owns this data at this point?", "when is this freed?",
"can this reference outlive its data?" — questions that cause the hardest Rust bugs.

### Unsafe Boundary (NEW — Rust only)

Rust's safety guarantee has an escape hatch: `unsafe`. Sound abstractions
wrap unsafe code in safe APIs.

```rust
// UNSAFE internals
unsafe fn raw_pointer_magic(ptr: *mut u8) { ... }

// SAFE abstraction wrapping unsafe
pub fn safe_api(data: &mut [u8]) {
    unsafe { raw_pointer_magic(data.as_mut_ptr()) }
}
```

Edges:
- `CONTAINS_UNSAFE` — function/block contains unsafe code
- `WRAPS_UNSAFE` — safe function wraps unsafe internals
- `USES_RAW_POINTER` — code manipulates raw pointers
- `CALLS_EXTERN` — FFI call to C/other language

Graph answers: "where is all unsafe code?", "what safe abstractions wrap it?",
"is this unsafe usage properly encapsulated?"

### Error Flow via ? operator

```rust
fn process() -> Result<Output, Error> {
    let data = read_file()?;      // ? = early return on Err
    let parsed = parse(data)?;    // ? = early return on Err
    Ok(transform(parsed))
}
```

The `?` operator creates HIDDEN CONTROL FLOW — early return paths not visible
in the happy-path code. Graph can make these explicit.

Edges:
- `ERROR_PROPAGATES` — ? chains error from callee to caller
- `RETURNS_ERROR` — function can return this error type
- `CONVERTS_ERROR` — From impl converts error type

## Node Types (Grafema vocabulary for Rust)

### Core Node Types

| Node Type | Rust Construct | JS Equivalent | Notes |
|-----------|---------------|---------------|-------|
| MODULE | `mod` / file | ES module | + visibility (pub/pub(crate)/private) |
| FUNCTION | `fn`, `impl fn` | function | + async, const, unsafe modifiers |
| VARIABLE | `let`, `const`, `static` | const/let/var | + mut, ownership semantics |
| CALL | `ExprCall`, `ExprMethodCall` | CallExpression | Includes method calls with self |
| STRUCT | `struct` | (none) | Product type (named fields) |
| ENUM | `enum` | (none) | Sum type (Haskell ADT equivalent) |
| VARIANT | enum variant | (none) | One case of enum |
| TRAIT | `trait` | (none) | Interface with optional defaults |
| IMPL_BLOCK | `impl T` / `impl Trait for T` | (none) | Method implementations |
| PATTERN | `Pat` variants | destructuring | Richer than JS (guards, or-patterns) |
| MATCH_ARM | match arm | case in switch | Pattern + optional guard + body |
| CLOSURE | `\|args\| body` | ArrowFunction | Captures environment (move/borrow) |
| IMPORT | `use` declaration | ImportDeclaration | Path-based, glob, rename |
| MACRO_CALL | `macro!()` | (none) | Compile-time code generation |
| ATTRIBUTE | `#[...]` | decorator (stage 3) | Metadata on items |
| LIFETIME | `'a` | (none) | Reference lifetime annotation |
| ASYNC_BLOCK | `async { ... }` | (none) | Future-producing block |
| UNSAFE_BLOCK | `unsafe { ... }` | (none) | Opt-out of safety checks |
| TYPE_ALIAS | `type Foo = ...` | (none) | Type synonym |

### Rust-Specific Node Types (no JS analogue)

| Node Type | Purpose |
|-----------|---------|
| BORROW | `&x` or `&mut x` — tracks borrow creation |
| MOVE | Value transfer point — source invalidated |
| DROP | Implicit destructor call at scope exit |
| DEREF | `*x` — pointer/reference dereference |
| TRAIT_BOUND | `T: Display + Debug` — constraint on generic |
| WHERE_CLAUSE | `where T: Clone` — complex trait bounds |
| ASSOCIATED_TYPE | `type Item` in trait — associated type |
| CONST_GENERIC | `[T; N]` where N is const parameter |

## Edge Types (Grafema vocabulary for Rust)

### Shared with JS (same semantics)

| Edge Type | Meaning |
|-----------|---------|
| CALLS | Function calls function |
| IMPORTS_FROM | Module imports from module |
| EXPORTS | Module exports (pub) item |
| HAS_PARAMETER | Function has parameter |
| RETURNS | Function returns type |
| CONTAINS | Parent contains child |
| DEFINED_IN | Item defined in scope |
| REFERENCES | Expression references variable |
| ASSIGNED_FROM | Variable bound from expression |

### Modified semantics

| Edge Type | JS Meaning | Rust Meaning |
|-----------|-----------|-------------|
| MUTATES | Any assignment | Only `&mut` borrow or `mut` variable |
| THROWS | throw/catch | Error propagation via `?` and Result |

### New edges (Rust-specific)

| Edge Type | From → To | Meaning |
|-----------|-----------|---------|
| OWNS | Variable → Value | Variable holds ownership |
| BORROWS | Reference → Owner | Reference borrows from owner |
| BORROWS_MUT | MutReference → Owner | Mutable borrow (exclusive) |
| MOVES_TO | Source → Dest | Ownership transfer, source dead |
| DROPS_AT | Value → Scope | Value destroyed at scope boundary |
| LIFETIME_OF | Reference → Lifetime | Reference has this lifetime |
| OUTLIVES | Lifetime → Lifetime | 'a: 'b (a outlives b) |
| IMPLEMENTS | ImplBlock → Trait | impl Trait for Type |
| DISPATCHES_VIA | Call → Trait | Dynamic dispatch through dyn Trait |
| HANDLES_VARIANT | MatchArm → Variant | Pattern matches this enum variant |
| ERROR_PROPAGATES | ? expr → Caller | Error bubbles up via ? |
| CONVERTS_ERROR | From impl → ErrorType | Error type conversion |
| CONTAINS_UNSAFE | Function → UnsafeBlock | Function has unsafe code |
| WRAPS_UNSAFE | SafeFn → UnsafeFn | Safe abstraction over unsafe |
| CAPTURES | Closure → Variable | Closure captures outer variable |
| CAPTURES_MUT | Closure → Variable | Closure captures mutably |
| CAPTURES_MOVE | Closure → Variable | Closure takes ownership |
| DERIVES | Struct/Enum → Trait | #[derive(Trait)] |
| HAS_FIELD | Struct → Field | Struct has named field |
| HAS_ATTRIBUTE | Item → Attribute | Item has #[...] attribute |

## Semantic Rules Matrix (DFG column)

```
AST Node                  DFG Rule
────────                  ────────
ExprCall                  value: arguments → function; result → parent
ExprMethodCall            value: self + arguments → method; result → parent
ExprBinary                value: left, right → operator; result → parent
ExprUnary                 value: operand → operator; result → parent
ExprBlock                 value: last expression → parent
ExprIf                    value: then|else → parent (conditional)
ExprMatch                 value: scrutinee → patterns; arm bodies → parent
ExprLoop                  value: break expr → parent
ExprForLoop               value: iterator → pattern; body side effects
ExprReturn                value: expr → function return
ExprBreak                 value: expr → enclosing loop
ExprClosure               value: body → parent (closure value)
ExprField                 value: base.field → parent
ExprIndex                 value: base[index] → parent
ExprReference             value: &expr → parent (borrow creation)
ExprStruct                value: field values → struct → parent
ExprTuple                 value: elements → tuple → parent
ExprArray                 value: elements → array → parent
ExprAwait                 value: future (unwrap) → parent
ExprTry (?)               value: Ok(v) → parent; Err(e) → function return
ExprAssign                value: rhs → lhs (mutable binding update)
ExprCast                  value: expr → parent (type changes, value preserved)
ExprLit                   TERMINAL (creates new value)
ExprPath                  value: referenced binding → parent
ExprUnsafe                value: block body → parent (transparent for DFG)
```

## CFG Rules (Rust-specific)

```
AST Node                  CFG Rule
────────                  ────────
ExprIf                    branch: condition ? then_block : else_block
ExprMatch                 branch: scrutinee → arm1 | arm2 | ... (exhaustive)
ExprLoop                  loop: entry → body → entry (break exits)
ExprWhile                 loop: condition → body → condition (false exits)
ExprForLoop               loop: iterator.next() → Some(v): body | None: exit
ExprTry (?)               branch: Ok: continue | Err: return (HIDDEN!)
ExprReturn                exit: to function boundary
ExprBreak                 exit: to enclosing loop
ExprContinue              jump: to loop head
```

**Key insight:** `?` is the most important CFG rule for Rust. Every `?` creates
a hidden branch — the error path. In a function with 5 `?` calls, there are
6 possible exit points (5 error + 1 success). This is invisible in the code
but critical for understanding control flow.

## Semantic Roles (L2 — cross-language)

| Role | JS | Haskell | Rust |
|------|-----|---------|------|
| Callable | function, arrow | FunBind, Lambda | fn, closure |
| Invocation | CallExpr | HsApp | ExprCall, ExprMethodCall |
| Declaration | var/let/const | FunBind, DataDecl | let, const, static, struct, enum |
| Import | import/export | ImportDecl | use, pub |
| Binding | assignment | PatBind, let | let, assignment |
| Access | member expr | record field | field access, method |
| Control | if, for, switch | case, guards | if, match, loop, for, ? |
| **OwnershipTransfer** | (none) | (none) | move, borrow, drop |
| **TraitDispatch** | (none) | TypeClassDispatch | dyn Trait, impl Trait |
| **ErrorPropagation** | (none) | (none) | ? operator, Result chain |
| **UnsafeEscape** | (none) | (none) | unsafe block/fn |

## Cognitive Dimensions — Where Grafema Adds Value for Rust

| Dimension | rustc handles? | Grafema adds? | How |
|-----------|---------------|---------------|-----|
| Hidden Dependencies | No | Yes | Cross-crate dependency graph, error propagation chains |
| Viscosity | Partially (type errors) | Yes | Blast radius BEFORE changing code, trait impl impact |
| Hard Mental Operations | No | Yes | `trace_dataflow` through modules, ownership tracking |
| Visibility | Partially (rust-analyzer) | Yes | Graph-level search, cross-crate |
| Error flow | Type shows Result | Yes | Full ? propagation chain, From conversions |
| Unsafe audit | No | Yes | Where is unsafe? What wraps it? Sound? |
| Ownership visualization | Compiler checks it | Yes | VISUAL ownership graph for complex code |

## Open Questions

1. **syn vs tree-sitter-rust** — syn is Rust-native (natural for RFDB), tree-sitter for multi-lang consistency
2. **Macro expansion** — macros generate code. Analyze pre- or post-expansion? Both?
3. **Ownership analysis depth** — full borrow checker is NP-hard-adjacent. What's the useful MVP?
4. **Cross-crate analysis** — Rust projects = many crates. Analyze workspace as unit?
5. **Proc macros** — serde, tokio, etc. generate invisible code. Include in graph?
6. **Integration with rust-analyzer** — RA already has go-to-def, find-refs. Where does Grafema add value?

## Next Steps

1. Enumerate full syn AST node types
2. Fill semantic rules matrix for all projections
3. Prototype: parse a .rs file → Grafema nodes + edges
4. Validate on Grafema's own Rust codebase (rfdb-server, orchestrator)

## Related

- [Theoretical Foundations](./theoretical-foundations.md) — L1-L5 framework
- [Declarative Semantic Rules](./declarative-semantic-rules.md) — JS matrix (reference)
- [Haskell Semantic Analysis](./haskell-semantic-analysis.md) — companion document
