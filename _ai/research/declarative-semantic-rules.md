# Declarative Semantic Rules Matrix

**Status:** Research / Conceptual
**Date:** 2026-03-03
**Origin:** Brainstorm session — multi-language support → Haskell theory → completeness guarantees

## Problem

Grafema's graph completeness depends on every AST node type that participates in data flow (and other semantic layers) creating the correct edges. Currently visitors are written manually — gaps are discovered through bugs, months after the code is written.

Data flow trace is a **chain**. One missing edge = chain breaks = `trace_dataflow` stops at the gap. Three months of v1 + ongoing v2 work, and gaps keep appearing because there's no way to guarantee completeness.

## Core Idea

**A formal matrix of declarative rules: AST node type × semantic layer → rule.**

Instead of writing visitors bottom-up (one per AST node, hoping to cover everything), define the rules top-down:

1. Enumerate ALL AST node types from `@babel/types` definitions (~180)
2. Define semantic layers: DFG, CFG, Call Graph, Module Graph, Scope Graph, Type Graph, Structure Graph
3. For each (node type, layer) pair — write a rule or mark N/A
4. Empty significant cell = **guaranteed gap**
5. From filled cells — **generate** visitors/edge-creation code

### The Matrix

```
                    DFG    CFG    Scope   Call   Module  Structure  Type
                    ───    ───    ─────   ────   ──────  ─────────  ────
IfStatement          -      ✓       -      -       -        -        -
FunctionDeclaration  -      -       ✓      -       -        ✓        -
CallExpression       ✓      -       -      ✓       -        -        -
ImportDeclaration    -      -       ✓      -       ✓        -        -
ClassMethod          -      -       ✓      -       -        ✓        -
AssignmentExpression ✓      -       -      -       -        -        -
ConditionalExpr      ✓      ✓       -      -       -        -        -
TSInterfaceDecl      -      -       ✓      -       -        ✓        ✓
...180 rows total
```

~180 node types × 7 layers = ~1260 cells. ~300-400 filled with rules. Rest = N/A.

### Rule Examples

**DFG Rules** (value flow through expressions):
```
ConditionalExpression  → value: consequent|alternate → parent
AssignmentExpression   → value: right → left, right → parent
AwaitExpression        → value: argument (unwrap) → parent
SpreadElement          → value: argument (expand) → parent
SequenceExpression     → value: last(expressions) → parent
BinaryExpression       → TERMINAL (creates new value)
```

**CFG Rules** (control flow through statements):
```
IfStatement            → branch: test ? consequent : alternate
ForStatement           → loop: init → test → body → update → test
TryCatchStatement      → normal: block, exception: handler
ReturnStatement        → exit: to parent function
SwitchStatement        → branch: discriminant → case1 | case2 | ...
```

**Scope Rules** (name binding through declarations):
```
FunctionDeclaration    → creates: new scope, binds: name in parent scope
VariableDeclaration    → binds: name in current scope (let/const=block, var=function)
CatchClause            → creates: block scope, binds: param
```

## Why This Matters

### 1. Completeness is provable
List of expression types is finite and known. If the table has a rule for every expression type → DFG is complete. No table → no guarantee.

### 2. Visitors are generated, not written
From the rule `ConditionalExpression → value: consequent|alternate → parent` a visitor can be mechanically generated. Manual visitor writing is the source of gaps.

### 3. Multi-language becomes tractable
Each language = its own matrix. The semantic layers are the same (DFG, CFG, Scope...). Only the rules differ. Java matrix, Kotlin matrix, Swift matrix — same structure, different content.

### 4. Gaps are visible
An empty cell in the matrix is a concrete, addressable gap — not a mysterious "sometimes trace_dataflow doesn't work".

## Haskell Connection

Haskell's type system provides exhaustiveness checking — if you model AST node types as an ADT, the compiler forces you to handle every case. The matrix idea is the same principle: enumerate all cases, handle each one explicitly.

A Haskell executable spec (~300 lines) could serve as the source of truth:

```haskell
data FlowRule
  = FlowsUp [FieldName]
  | FlowsSideways FieldName FieldName
  | Terminal
  | PassThrough FieldName

flowRule :: BabelExprType -> FlowRule
flowRule ConditionalExpression = FlowsUp ["consequent", "alternate"]
flowRule AssignmentExpression  = FlowsSideways "right" "left"
-- miss a case? COMPILE ERROR
```

GHC guarantees the table is complete. From the table, generate:
- Datalog guarantees for self-check
- Edge-creating visitors
- Test cases
- Documentation

## Prior Art

| Project | Declarative rules? | For existing languages? | Complete matrix? | Rules from spec? |
|---------|-------------------|------------------------|-----------------|-----------------|
| **Spoofax/FlowSpec** | Yes | No (new DSLs only) | No | No |
| **Spoofax/Statix** | Yes (scope graphs) | No (new DSLs only) | No | No |
| **CodeQL** | No (imperative extractors) | Yes | No | No |
| **Joern/CPG** | No (schema only) | Yes | No | No |
| **This idea** | **Yes** | **Yes** | **Yes** | **Yes** |

Spoofax proved declarative rules → analysis works. CodeQL/Joern proved complete semantic graphs for JS are possible. Nobody combined: formal rules matrix derived from AST spec for an existing language.

## Broader Context: Grafema as "Haskell for Untyped Code"

This research emerged from realizing that Grafema's graph model is essentially doing what Haskell's type system does — mapping human understanding of code into formal relationships. Haskell forces you to declare types; Grafema infers them from the graph.

Key parallel:
- Haskell type signature `Order -> Either OrderError Confirmation` = Grafema edge `FUNCTION(processOrder) --RETURNS--> TYPE(Confirmation)`
- Haskell exhaustiveness checking = Grafema semantic rules matrix
- Haskell type class laws = Grafema guarantees
- Hoogle (search by type) = Grafema `find_nodes` (search by graph)

The pitch: "Grafema gives your untyped JS code the same guarantees Haskell gives out of the box."

## Next Steps

1. **Extract full list of expression types from `@babel/types`** — machine-readable, not manual
2. **Fill DFG column first** — ~60 rules, highest impact (trace_dataflow)
3. **Prototype: rule → visitor generation** — even a simple codegen proves the concept
4. **Validate against existing visitors** — do current v2 visitors match the rules? Where do they diverge?
5. **Haskell executable spec** (optional) — for exhaustiveness guarantee

## Related

- REG-613: Java analyzer MVP (tests multi-language readiness)
- Spoofax FlowSpec: https://spoofax.dev/references/flowspec/
- Joern CPG spec: https://cpg.joern.io/
- CodeQL JS model: https://codeql.github.com/docs/codeql-language-guides/codeql-library-for-javascript/
