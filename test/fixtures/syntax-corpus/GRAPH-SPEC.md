# Graph Specification — Syntax Corpus

## Purpose

This document defines the principles for annotating JS/TS constructs
with their expected graph representation. It is the source of truth
for what nodes and edges each construct SHOULD produce.

The annotations describe the **desired** graph, not the current implementation.
Gaps between this spec and reality become tasks.

## Tasks the Graph Must Solve

Every node type, edge type, and metadata field in Grafema exists to serve
one or more of these tasks. If a graph element doesn't serve any task —
it's noise. If a task can't be answered by querying the graph — it's a gap.

### 1. Code Navigation / Understanding

Without the graph: agent reads file after file, loses context.
With the graph: one query, precise answer.

- **Where is X defined?** — node lookup by name/semantic ID
- **What calls this function?** — reverse CALLS edges (transitive for call chains)
- **What does this module export?** — EXPORTS edges from MODULE node
- **Who imports this module?** — reverse IMPORTS_FROM edges
- **Show class hierarchy** — EXTENDS / IMPLEMENTS chains
- **What methods does this class have?** — CONTAINS edges from CLASS to METHOD
- **What are the parameters of this function?** — CONTAINS edges to PARAMETER nodes
- **What does this function return?** — RETURNS edges or return value tracing

### 2. Impact Analysis / Change Safety

Key question: **"if I change X — what breaks?"**

- **Transitive callers** — all who directly or transitively call X
- **Module reverse deps** — who imports this module (transitively)
- **Interface implementors** — if I change interface, who implements it
- **Export consumers** — if I rename an export, who imports it
- **Side effect radius** — what external systems does a function touch (DB, HTTP, FS)
- **Test coverage mapping** — which tests exercise this code path

### 3. Data Flow Tracing

Key question: **"where did this value come from?" / "where does it go?"**

- **Backward trace** — from variable back through assignments, parameters, returns
- **Forward trace** — from source forward through all usages
- **Value domain** — what can a variable contain (types, ranges, literals)
- **Null flow** — can null/undefined reach this point
- **Transformation chain** — what transforms the data passes through (parse → validate → transform → serialize)
- **Cross-function flow** — arguments passed in → parameters → return → assigned to caller variable

### 4. Taint Analysis / Security

Key question: **"does user input reach a dangerous call without sanitization?"**

- **Source → sink tracing** — user input (req.body, req.params) → SQL query / eval / innerHTML
- **Sanitization checkpoints** — does the flow pass through validation/sanitization
- **Exposed API surface** — what endpoints exist, what data they accept/return
- **Sensitive data flow** — where do passwords, tokens, PII go (logs, API responses)
- **Auth/authz coverage** — are all endpoints protected by auth middleware

### 5. Architecture Analysis

Key question: **"what is the system's structure and where is it violated?"**

- **Module dependency graph** — who depends on whom
- **Circular dependencies** — cycles in the dependency graph
- **Layer violations** — UI imports from data layer directly
- **Fan-in / fan-out** — too many dependencies = god module
- **Cohesion metrics** — how related are elements within a module
- **Dead code** — functions/modules with no incoming calls/imports

### 6. Mutation / State Analysis

Key question: **"who and how changes this state?"**

- **Shared mutable state** — variables written from multiple locations
- **Side effects** — function modifies something outside its scope (this, globals, closures)
- **Pure function detection** — no side effects, result depends only on arguments
- **Race condition candidates** — shared state + async = potential race
- **Closure mutation** — who mutates a captured variable
- **Property mutation** — what object properties are modified, where

### 7. Refactoring Support

Key question: **"can I safely make this change?"**

- **Safe rename** — all references to a symbol (including dynamic access, re-exports)
- **Extract module** — what dependencies would follow
- **Inline function** — what does it read from outer scope
- **Dead code elimination** — what can be safely deleted
- **API deprecation** — who uses deprecated API, migration path
- **Move method** — where is `this` used, what does the method access

### 8. Guarantee Verification (Datalog rules)

Key question: **"does invariant X hold across the entire codebase?"**

- **"All HTTP handlers validate input"** — every route handler calls validate
- **"No direct SQL queries"** — all DB access through ORM layer
- **"Every export is tested"** — exported function has incoming CALLS from test file
- **"No circular deps between layers"** — DAG constraint on module graph
- **"All errors are logged"** — catch blocks contain logging call
- **"No secrets in code"** — no literal strings matching secret patterns in non-config files
- **Custom business rules** — project-specific invariants as Datalog queries

### 9. Cross-boundary Analysis

Key question: **"how does data cross boundaries?"**

- **Frontend → Backend** — fetch/axios call → route handler mapping
- **Inter-service** — HTTP/gRPC/message queue boundaries
- **Socket.io** — emit ↔ on matching (which events, which data)
- **Template engine** — data binding (which variables reach template)
- **Database** — query → schema mapping (which tables/columns are touched)
- **Config** — env vars → runtime usage (where configuration values are used)
- **File system** — read/write operations → path resolution

### 10. AI Agent Tasks

Key question: **"how can an agent understand code without reading it?"**

- **Context building** — instead of "read 50 files" → "query subgraph around this function"
- **Change planning** — "which files will my change affect?"
- **Test selection** — "which tests to run for verification?"
- **Type inference** — "what type is this variable?" (without TypeScript)
- **Code generation context** — "what patterns are used in this module?"
- **Verification** — "did my changes break any invariants?"
- **Navigation** — "find the right file/function to modify for this task"

## Core Principles

### 1. Maximally atomic nodes

Each semantically distinct entity is a separate node.
A literal `"hello"` is a node. A variable `x` is a node.
They are connected by edges — never collapsed into metadata.

### 2. Maximally specific edge types

Every semantic distinction gets its own edge type.
"Declaration init" and "reassignment" are different operations —
they get different edge types (INITIALIZES vs REASSIGNS), even if
a consumer might treat them the same.

**Rationale**: You can always aggregate fine-grained edges.
You can never disaggregate coarse ones.

### 3. Traits are a runtime/query concern, not a spec concern

Traits (groupings of edge types for specific analysis purposes)
are defined AFTER the full graph is specified. They are not part
of the annotation vocabulary. The annotation uses exact edge types.

### 4. Bottom-up discovery

We do NOT start from an existing edge type vocabulary.
We annotate each construct asking: "What semantic relationships
exist here?" — and name them precisely. The vocabulary emerges
from the constructs, not the other way around.

After all constructs are annotated, we collect the full vocabulary
and then define traits as overlapping sets over that vocabulary.

## Annotation Format

Each construct is wrapped in an annotation block:

```js
// @construct PENDING <category>
// <NodeType> <id> {metadata} -> <EDGE_TYPE> -> <NodeType> <id>
// <NodeType> <id> {metadata} -> <EDGE_TYPE> -> <NodeType> <id>
<actual code>
```

### Rules

- `@construct` — marker for automated counting and filtering
- Status: `PENDING` (not yet reviewed) or `APPROVED` (reviewed by human)
- Category: short tag for the construct type (e.g., `var-decl-init`)
- Each line after the marker describes one node or one edge
- Node format: `<TYPE> <id> {key: value, ...}`
- Edge format: `<SOURCE> -> <EDGE_TYPE> -> <TARGET>`
- Use `<angle brackets>` for semantic IDs
- Use `{curly braces}` for metadata/properties
- `[GAP]` marks things not yet implemented in Grafema

### Example (pending approval)

```js
// @construct PENDING var-decl-init
// SCOPE <module> -> DECLARES -> VARIABLE <count>
// VARIABLE <count> {declarationKind: 'let'} -> INITIALIZES -> NUMBER_LITERAL <0>
let count = 0;

// @construct PENDING var-reassign
// NUMBER_LITERAL <10> -> REASSIGNS -> VARIABLE <count>
count = 10;

// @construct PENDING var-compound-assign
// VARIABLE <count> -> SELF_READS -> VARIABLE <count>
// NUMBER_LITERAL <5> -> COMPOUNDS -> VARIABLE <count>
count += 5;

// @construct PENDING update-expr
// UPDATE_EXPRESSION <count++> -> INCREMENTS -> VARIABLE <count>
// VARIABLE <count> -> SELF_READS -> VARIABLE <count>
count++;
```

## Corpus Statistics

- **26 source files** covering JS, CJS, and TypeScript
- **691 constructs** tagged with `@construct PENDING`
- Categories: declarations, expressions, statements, patterns, classes,
  async/generators, closures, prototypes, callbacks, error handling,
  iterators, property access, builtins, coercion/hoisting, modern ES,
  aliasing, modules (ESM, CJS, re-exports), TypeScript-specific,
  runtime APIs (plugin), JSDoc types (plugin), legacy patterns (AMD/UMD/polyfills)
- Six rounds of adversarial review (GAPS.md, GAPS-2.md, GAPS-3.md) integrated

## Process

1. **Annotate** — go construct by construct, write exact nodes + edges
2. **Approve** — human reviews each `@construct`, flips PENDING → APPROVED
3. **Collect vocabulary** — extract all node types and edge types from approved annotations
4. **Define traits** — group edge types into overlapping sets for query purposes
5. **Implement** — update Grafema to match the spec; each gap = a task

## Open Questions

Tracked here as they arise during annotation:

- (none yet)
