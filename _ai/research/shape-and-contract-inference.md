# Shape and Contract Inference

## 1. Problem Statement

Grafema needs to understand the "shape" of objects as they flow through code — what properties and methods they have at each point in execution. This enables:

- **Method call resolution**: `db.getNode()` — does `db` have `getNode`?
- **Contract verification**: producer sends `{ orderId, amount }`, consumer reads `order.shipping` — mismatch
- **Error detection**: `obj.nonExistent` — property doesn't exist on inferred shape
- **Cross-process validation**: data serialized by TS, deserialized by Rust — shapes must match

Current state: 77% method call resolution via type inference (INSTANCE_OF edges). Remaining 23% requires shape-level understanding.

## 2. Core Abstraction: SHAPE

A SHAPE is a set of named members (properties + methods) with metadata about each:

```
SHAPE {
  members: {
    getNode: { kind: 'method', type: 'Promise<Node|null>' },
    socketPath: { kind: 'property', type: 'string' },
  },
  binding: nominal | structural | external | inferred,
  source: CLASS | LITERAL | SCHEMA | FUNCTION_RETURN,
  mutable: boolean,
  confidence: high | medium | low,
}
```

### Binding types

| Binding | Source | Example | Confidence |
|---------|--------|---------|------------|
| **nominal** | CLASS/INTERFACE definition | `class GraphBackend { getNode() {} }` | High |
| **structural** | Object literal or property writes | `const obj = { x: 1, y: 2 }` | High |
| **external** | Wire protocol schema | RabbitMQ message, HTTP response | Medium |
| **inferred** | Return type of function, parameter propagation | `getBackend()` returns GraphBackend | Medium-Low |

### Contract = SHAPE + obligation

A CONTRACT is a SHAPE used at a boundary where it becomes a **requirement**:
- Function parameter: caller MUST provide an object matching this shape
- Return value: function MUST return an object matching this shape
- IPC boundary: sender MUST send data matching this shape

One SHAPE node type with contextual interpretation. No separate CONTRACT node needed.

> **Cross-reference.** Where a SHAPE attaches to a *user-facing entry point* — CLI command, MCP tool, HTTP route, exported library function — the FEATURE/BEHAVIOR/CONTRACT decomposition lives in `_ai/research/cognitive-debt-and-feature-detection.md`. The canonical six-entity model (ENTRY_POINT / INTERFACE / CONTRACT / BEHAVIOR / FEATURE / COMPONENT) with edges, cardinalities, and registry interaction is in `_ai/research/feature-taxonomy.md`. Contracts are owned by **entry points**, not by features-as-such: one logical feature can be exposed as both `cli:command` and `mcp:tool` with two different contracts but a single shared BEHAVIOR.

### Interface vs Contract

In the Design-by-Contract sense (Meyer), **Contract ⊃ Interface**:

- **Interface** — structural surface only: in-shape, out-shape, names and types.
- **Contract** = Interface + **behavioral guarantees**: pre-conditions, post-conditions, effects, invariants, error semantics.

In Grafema's graph, behavioral guarantees already live partly elsewhere — `EffectType` annotations on BEHAVIOR / FEATURE nodes (`PURE`, `IO`, `THROW`, `MUTATION`, …), `THROWS` edges, and the BEHAVIOR hash as identity of underlying logic. So a CONTRACT = SHAPE-at-boundary + linked effects/invariants. The SHAPE node carries the interface; the rest is composed via existing edges.

### 2.5 Three classes of contract: Speced, Emergent, Synthesized

A cross-paradigm survey (see Appendix A) shows that the {Speced, Emergent} pair is incomplete. There are **three** primary classes plus one degenerate fourth:

**A. Speced — single declarative authority.** Callers conform to a spec declared at one site.
- Examples: Express `app.get(...)`, MCP `inputSchema`, gRPC `.proto`, Haskell Servant route type, Python `@app.route` decorator, function signature, `package.json#contributes`.
- Inference: read the declaration. Static.

**B. Emergent — N producers / M consumers asymmetry.** Contract is the inferred shape from union of writers vs union of readers; mismatch = bug.
- Examples: redis pub/sub topic, Node `EventEmitter`, Kafka raw topic, Akka classic untyped mailbox, shared mutable state, Go `chan T`, Rack env hash, `context.Value` bag, Spring `ApplicationEvent`, Symfony EventDispatcher (when listener count is dynamic).
- Inference: collect shapes from all writer and reader sites in the graph; compare; emit ISSUE on mismatch.

**C. Synthesized — contract produced by a transformation, not declared at any site.** Three sub-flavors:
- **Build-time codegen:** Rust proc-macros, Swift macros, Scala 3 inline, Kotlin KSP/kapt, Java annotation processors (Lombok/MapStruct), C# Roslyn source generators, `go generate`. Inference: read post-transformation artifact, OR model the transformation.
- **Resolution-time scope:** Haskell type classes (incl. orphan instances), Scala implicits / `given`, Rust trait blanket impls, Swift protocol extensions, Kotlin extension functions, Go structural interface satisfaction (no `implements` keyword), CLOS / Clojure multimethods. Inference: implement instance-resolution mimicking the compiler's coherence rules.
- **Cross-cutting advice:** Spring AOP `@Around`/`@Aspect`, Rust `tower::Layer` middleware, Rack middleware, NestJS interceptors. Inference: model the intercept chain — contract isn't on the callable, it's around it.

**D. Reflective — contract computed per-call, no enumerable surface.** Degenerate — analysis cannot enumerate without runtime instrumentation.
- Examples: Ruby `method_missing` / `define_method` DSLs / ActiveRecord dynamic finders; Python `__getattr__` / `__getattribute__`; JS `Proxy` traps; PHP `__call` / `__get` / variable-variables / `eval`; Lua `__index`; Perl `AUTOLOAD` + symbol-table munging; C# `dynamic` / DLR; eval-based dispatch.
- Inference: emit OPAQUE_BOUNDARY ISSUE listing the reflective sites; accept incomplete coverage; recommend manual annotation or runtime probing.

### 2.6 Cross-cutting modifiers

Orthogonal to the primary class, a contract may carry one or more modifiers:

| Modifier | Adds | Examples |
|---|---|---|
| **Versioned / evolving** | contract = family of shapes + compat rules | Kafka + Schema Registry (BACKWARD/FORWARD/FULL), Avro reader/writer resolution, gRPC field additions, OpenAPI versioning |
| **Compositional** | contract assembled at use site from primitives | GraphQL resolver tree, algebraic effects (Koka/Frank/Eff), monad transformer stacks, Erlang OTP behaviour + mailbox |
| **Time-dependent** | depends on load-order / runtime patches | monkey-patching (`gevent.monkey`, Ruby refinements, JS prototype patching, Perl `*glob` assignment), hot-reload, plugin registration order |
| **Conditional / build-flag** | function of build configuration | Cargo `cfg`, Go build tags, C preprocessor, conditional compilation in F# / Scala 3 |
| **Open-world hook** | string-keyed, any participant can register | WordPress `add_action`/`add_filter`, Drupal `hook_*`, ActiveSupport::Notifications, Vim autocmd |

A mechanism can stack modifiers (e.g., gRPC = Speced + Versioned; WordPress hooks = Emergent + Open-world + Time-dependent). Modifiers shape what "mismatch detection" means — for Versioned contracts, mismatch = compat-rule violation, not field difference.

### 2.7 Implications for the inference pipeline

The pipeline branches by class:

| Class | Strategy | Output |
|---|---|---|
| **Speced** | Read the declaration directly. effects-db YAML marks the source. | SHAPE node with `binding: nominal` |
| **Emergent** | Collect writer/reader sites, infer Σ-shape pair, compare. | SHAPE node with `binding: structural` + ISSUE on mismatch |
| **Synthesized — codegen** | Read post-expansion artifact (e.g. gRPC generated stubs). | Same as Speced after expansion |
| **Synthesized — resolution-time** | Mimic compiler instance resolution; emit per-resolved-instance edges. | SHAPE node with `binding: inferred`, lower confidence |
| **Synthesized — advice** | Model the intercept chain; flatten to effective-handler shape. | SHAPE node + INTERCEPTED_BY edges |
| **Reflective** | Mark site as OPAQUE_BOUNDARY; do not over-promise. | ISSUE node |

For each language Grafema supports, an effects-db extension declares which constructs land in which class. This is the integration point with the **declarative effects YAML** the project already uses for Speced library entry-points (`commander.yaml`, `vscode.yaml`, `modelcontextprotocol-sdk.yaml`).

## 3. Sound Evidence for Shape Construction

**Critical principle**: shapes are constructed from WRITES (definitions), not from READS (usage).

### Sound evidence (can add members to shape)

| Pattern | Evidence | Graph representation |
|---------|----------|---------------------|
| CLASS/INTERFACE declaration | Defines methods + properties | CLASS → HAS_METHOD → METHOD |
| Object literal `{ a: 1, b: 2 }` | Creates shape { a, b } | LITERAL → HAS_PROPERTY |
| Property write `obj.x = val` | Adds x to shape | WRITES_TO edge |
| `new ClassName()` | Shape = class definition | CALL → CALLS → CLASS |
| Spread `{ ...base, extra }` | Merge shapes | DERIVED_FROM edge |
| Array literal `[1, 2, 3]` | Shape = Array prototype | LITERAL with type array |

### NOT evidence (usage, potentially wrong)

| Pattern | Why not evidence |
|---------|-----------------|
| Property read `obj.x` | Attempt — might be undefined |
| Destructuring `const { x } = obj` | Read attempt — x might not exist |
| Method call `db.getNode()` | Call attempt — method might not exist |
| `if (obj.x)` guard | Check, not definition |

Using reads as evidence creates circular reasoning: "we call `.getNode` therefore it has `.getNode`" — this prevents detecting the error when `.getNode` doesn't actually exist.

## 4. Temporal Shape: Reaching Definitions

Object shapes change over execution:

```js
const obj = {};        // shape(obj) = {}
obj.x = 1;            // shape(obj) = { x }
if (condition) {
  obj.y = 2;           // shape(obj) = { x, y } (in this branch)
}
// shape(obj) = { x } ∩ { x, y } = { x }  (intersection at merge)
obj.z = 3;            // shape(obj) = { x, z }
```

### Rules

1. **Object literal**: shape = all literal properties
2. **Property write**: shape += new property (after write point)
3. **Branch merge**: shape = **intersection** of branch shapes (only guaranteed properties)
4. **Loop**: fixed-point iteration (shape at loop entry = shape at loop exit)

### Guarded properties

Properties defined inside branches carry a **guard** — the condition under which they exist:

```
shape(obj, after_if) = {
  x: { guard: true },           // unconditional
  y: { guard: condition },       // only if condition was true
}
```

Backward tracing from a read to its guard:
```
READ(obj.y)
  → who writes .y? → WRITES_TO(obj.y = 2) at line 4
    → what scope? → inside BRANCH(condition)
      → GOVERNS edge → BRANCH → HAS_CONDITION → expression
```

This answers: "under what conditions does `obj.y` exist?"

## 5. Inter-Procedural Shape Propagation

```js
function addFields(obj) { obj.extra = true; }
const x = {};
addFields(x);
x.extra;  // valid — addFields writes .extra
```

Propagation through call graph:
1. Function `addFields` has PARAMETER `obj`
2. Inside function body: WRITES_TO `obj.extra`
3. At call site: `x` is passed via PASSES_ARGUMENT
4. `addFields` modifies the shape of its argument → caller's variable shape changes

This requires **inter-procedural** analysis:
- Trace PASSES_ARGUMENT → RECEIVES_ARGUMENT
- Collect writes to parameters inside called function
- Propagate back to caller's variable shape

Bounded by call chain depth (same as `trace_calls` traversal).

## 6. Contract Verification (Lint Mode)

### Three verification points

#### 6.1 Function boundary (intra-process)

```ts
function startServer(config: { port: number, host: string }) {
  config.port;   // read — must exist in caller's shape
  config.host;   // read — must exist in caller's shape
}
startServer({ port: 3000 });  // VIOLATION: missing 'host'
```

Check: `SHAPE(argument) ⊇ REQUIRES_SHAPE(parameter)`

#### 6.2 Class implementation (inheritance)

```ts
abstract class GraphBackend {
  abstract getNode(id: string);
  abstract newMethod();           // added
}
class RFDBServerBackend extends GraphBackend {
  getNode(id) { ... }
  // missing newMethod → VIOLATION
}
```

Check: `SHAPE(subclass) ⊇ SHAPE(superclass)`

#### 6.3 IPC boundary (cross-process)

```
Producer serializes: { orderId, amount }
Consumer deserializes and reads: { orderId, amount, shipping }
```

Check: `SHAPE(producer output) ⊇ SHAPE(consumer reads)` via CALLS_REMOTE bridge.

### Guarantee rule (Datalog)

```datalog
% Property read without matching write in shape
violation(ReadSite, Property) :-
  reads_property(ReadSite, Variable, Property),
  shape_at(Variable, ReadSite, Shape),
  not member(Property, Shape).
```

Run via `grafema check --guarantee shape-contracts`.

## 7. Incremental Verification on Code Change

When a file changes:

```
Changed file → re-analyze → updated SHAPE nodes
  → for each changed SHAPE:
    → trace outgoing: PASSES_ARGUMENT, CALLS_REMOTE, ASSIGNED_FROM, RETURNS
      → find all downstream consumers
        → for each consumer: reads ⊆ shape?
          → new mismatch → ISSUE node
          → fixed mismatch → remove ISSUE
```

### Cascade handling

```
A.js → exports function returning { x, y }
B.js → imports from A, passes to C
C.js → reads .x, .y, .z

Change: A removes .y
Cascade: A's return SHAPE changes → B propagates → C reads .y → VIOLATION
```

Cascade depth bounded by call chain. Uses existing `trace_calls` + `trace_dataflow` infrastructure for traversal.

## 8. Graph Representation

### SHAPE node

```
SHAPE {
  id: "shape::<file>::<variable>::<line>"
  members: Map<string, { kind, type?, guard? }>
  binding: "nominal" | "structural" | "external" | "inferred"
  source_node: ID (CLASS, LITERAL, or FUNCTION that defines it)
  confidence: "high" | "medium" | "low"
}
```

### Edges

```
VARIABLE → HAS_SHAPE → SHAPE              (variable has this shape at this point)
PARAMETER → REQUIRES_SHAPE → SHAPE        (function requires this shape from caller)
FUNCTION → RETURNS_SHAPE → SHAPE          (function promises this shape on return)
SHAPE → SHAPE_MEMBER → PROPERTY/METHOD    (shape contains this member)
CALL → VIOLATES_SHAPE → SHAPE             (call reads member not in shape)
```

### Alternatively: point-sensitive shapes

```
VARIABLE(obj) → HAS_SHAPE → SHAPE_POINT(line:5) { members: [x] }
VARIABLE(obj) → HAS_SHAPE → SHAPE_POINT(line:10) { members: [x, y, z] }
```

For MVP: single widened SHAPE per variable (union of all writes). Point-sensitivity as future enhancement.

## 9. Connection to Existing Infrastructure

| Existing | How it connects |
|----------|----------------|
| CLASS → HAS_METHOD/HAS_PROPERTY | Nominal SHAPE source |
| WRITES_TO edges | Structural SHAPE evidence |
| BRANCH → GOVERNS | Guard conditions for properties |
| PASSES_ARGUMENT / RECEIVES_ARGUMENT | Shape propagation across calls |
| CALLS_REMOTE (bridge detection) | Shape propagation across processes |
| INSTANCE_OF (type inference) | Binds variable to nominal SHAPE |
| ASSIGNED_FROM | Shape propagation through assignments |
| LITERAL → HAS_ELEMENT/HAS_PROPERTY | Structural SHAPE from literals |
| Guarantees (Datalog) | Contract verification as lint rules |

## 10. Implementation Phases

### Phase 1: Nominal shapes (from CLASS/INTERFACE)
- Extract SHAPE from CLASS → HAS_METHOD + HAS_PROPERTY
- Bind via INSTANCE_OF: VARIABLE → HAS_SHAPE → SHAPE(class)
- Contract check: method calls on typed variables
- **This replaces the BUILTINS hack in type-inference.mjs**

### Phase 2: Structural shapes (from literals + writes)
- Object literals → SHAPE
- WRITES_TO tracking → shape mutation
- Widened shape per variable (union of all writes, no point-sensitivity)

### Phase 3: Inter-procedural propagation
- Parameter shapes from callers (PASSES_ARGUMENT chain)
- Return shapes from function bodies
- Shape through assignment chains

### Phase 4: Guarded properties + point-sensitivity
- Branch-aware shapes (intersection at merge)
- Guard tracking via GOVERNS edges
- Backward tracing: "when does this property exist?"

### Phase 5: Cross-process contract verification
- Shape at serialize point (producer) vs shape at deserialize point (consumer)
- Via CALLS_REMOTE bridges
- Mismatch → ISSUE with cross-process context

## 11. Relationship to REG-1086 (Data Shape Inference)

This document supersedes the original REG-1086 description. Key evolution:
- Original: "track object structure through assignment chains"
- Now: unified SHAPE abstraction covering nominal (classes), structural (objects), external (wire), with contract verification and incremental lint

REG-1086 acceptance criteria updated:
- [ ] SHAPE nodes created from CLASS/INTERFACE definitions
- [ ] SHAPE nodes created from object literals
- [ ] SHAPE propagation through ASSIGNED_FROM + PASSES_ARGUMENT
- [ ] Contract verification via Datalog guarantee
- [ ] ISSUE nodes for shape violations
- [ ] Cross-process shape checking via CALLS_REMOTE bridges

## 12. Application to Grafema FEATURE categories

For each FEATURE-class node produced by the L0 entry-point detection enrichers
(`cognitive-debt-and-feature-detection.md` §4.3), the contract source is:

| FEATURE category | Class | Interface source |
|---|---|---|
| `cli:command` | Speced | `program.command('build <input> --watch')` declarative string + effects-db YAML annotations on `commander` |
| `mcp:tool` | Speced | `inputSchema.properties` JSON Schema on the tool definition |
| `vscode:command` | Speced | `package.json#contributes.commands` + typing on the args registered with `vscode.commands.registerCommand` |
| `http:route` (planned, A1) | Speced | route registration in express/fastify/koa/hono via effects-db YAML; Spring `@RestController` etc. via annotation processor reading |
| `package:export` | Speced | exported function/method signature (PARAMETER + RETURNS + THROWS edges) |
| internal channel (future) | Emergent | union of writer sites vs union of reader sites for a given queue / topic / shared variable |

Cross-paradigm cases that don't fit cleanly (Synthesized / Reflective) — see §2.5
and Appendix A. For polyglot codebases Grafema targets, language-specific
mechanisms (decorators, annotation processors, AOP advice, type classes,
multimethods, monkey-patching, hooks) need explicit per-language handling.

### Note on the shipped contractEnricher.ts (Sprint 1)

The current `packages/util/src/enrichers/contractEnricher.ts` extracts
`{ inputs, outputs, errors }` only from the **handler function's JS signature**:
PARAMETER nodes, RETURNS edges, THROWS edges. This is a minimal **interface
scrape** (in the §2.4 sense), not a full contract:

- For `package:export FUNCTION` targets — the JS signature **is** the interface,
  so the scrape is correct.
- For `cli:command`, `mcp:tool`, `vscode:command` — the JS signature carries
  near-zero information (one anonymous parameter `args` / `options`); the real
  interface lives in declarative library calls (commander, inputSchema,
  package.json contributes) which this enricher does not read.

**Honest renaming**: the shipped artifact should be called `IMPL_CONTRACT` or
`HANDLER_SIGNATURE` (interface seen by the handler implementation), and the
declarative-spec extraction is a separate enricher that produces the
*user-facing* interface from the L0 detection sources. Both attach to the same
FEATURE node via different edge types
(`HAS_HANDLER_SIGNATURE` vs `HAS_LOGICAL_INTERFACE` — names TBD).

For v0.3 this is captured as a follow-up; the existing CONTRACT node and
`HAS_CONTRACT` edge remain in place under the current name to avoid graph churn.

## Appendix A. Cross-paradigm contract-mechanism survey

Compiled from three parallel surveys (static-typed / dynamic-scripting / functional+actor+IDL+broker) across ~30 languages and frameworks. Mechanisms that **don't fit** the {Speced, Emergent} dichotomy without contortions, grouped by failure mode.

### A.1 Synthesized — build-time codegen

Contract exists only after a transformation step; neither the input nor the output is "the" canonical contract.

- Annotation processors (Lombok, MapStruct, Java JSR-269)
- Source generators (Roslyn, KSP, kapt)
- Macros (Rust proc-macros, Scala 3 `inline`, Swift macros)
- `go generate`, gRPC/Thrift/protobuf code generation
- Cargo `cfg` / Go build tags / C preprocessor — contract conditional on build flags

### A.2 Synthesized — resolution-time scope

Contract exists at every call site as a function of the local scope's available instances/conformances/specializations. No central declaration.

- Type classes (Haskell, with orphan instances making coherence package-set-dependent)
- Implicits / `given` (Scala)
- Trait blanket impls (Rust)
- Protocol extensions (Swift) and extension functions (Kotlin) — retroactive shape augmentation
- Go structural interface satisfaction — no `implements` keyword; conformance discovered
- CLOS / Clojure multimethods — one logical name, scattered `defmethod` sites

### A.3 Synthesized — cross-cutting advice

Contract isn't on the callable; it's around it. The advice has no callable signature of its own visible to consumers.

- Spring AOP `@Around` / `@Aspect`
- Rust `tower::Layer` middleware chains
- Rack middleware, Express middleware (when used as wrappers, not handlers)
- NestJS interceptors, Symfony event subscribers as wrappers
- Property wrappers (`@Published`), result builders, attribute macros (`#[tokio::main]`) — entry point rewritten before user-code analysis sees it

### A.4 Reflective — runtime-synthesized, no enumerable surface

The contract is computed per access; analysis cannot enumerate without runtime instrumentation. Treat as OPAQUE_BOUNDARY.

- Ruby `method_missing`, `define_method`, ActiveRecord dynamic finders, RSpec/FactoryBot DSLs
- Python `__getattr__` / `__getattribute__`
- JavaScript `Proxy` traps; `eval` / `new Function`
- PHP `__call` / `__get`, variable-variables, `eval`, `create_function`
- Lua `__index` / `__newindex` metatables
- Perl `AUTOLOAD`, symbol-table munging
- C# `dynamic` / DLR

### A.5 Compositional — contract assembled at use site

Spec is partial; effective contract emerges from composition.

- Algebraic effects (Koka, Frank, Eff): effect signature is declared at function type but handlers reinterpret dynamically; effect stack determines actual semantics
- GraphQL: schema is speced but execution = recursive resolver tree; per-field semantics + N+1 + DataLoader concerns are emergent
- Erlang OTP `gen_server` behaviour: callback module shape is speced (init/handle_call/handle_cast/...), but mailbox payloads are emergent
- Monad transformer stacks (mtl-style): each layer adds capability, total contract = stack-dependent
- ZIO `R` capability environment: contract is the *requested environment*, satisfied by the caller's stack

### A.6 Versioned / evolving

Contract is a *family* of shapes plus compat rules — not one snapshot.

- Kafka + Confluent Schema Registry (BACKWARD / FORWARD / FULL compat policies)
- Avro reader/writer schema resolution at read time
- gRPC field-add semver discipline
- OpenAPI version negotiation

### A.7 Time-dependent / open-world

Contract changes as code loads / patches / hot-reloads.

- Monkey-patching: `gevent.monkey`, Ruby refinements, JS prototype patching, Perl `*glob` assignment, Swift method swizzling
- Hot reload (Rails, Webpack HMR, Erlang code_change/2)
- WordPress `add_action`/`add_filter` and Drupal `hook_*`: hook tag is a free-form string; "spec" is community convention
- Plugin systems where load order shapes effective dispatch

### A.8 Stringly-typed bag passthroughs

Typed languages with deliberate untyped escape hatches.

- Go `context.Value(key)`
- Akka classic `receive: Any => Unit`
- C# `dynamic`
- Rack `env` hash, Express `req` object as ambient state
- Notification systems with `userInfo: [AnyHashable: Any]` (NotificationCenter), event payloads as opaque maps (ActiveSupport::Notifications, Symfony EventDispatcher with string keys)

### A.9 Implication for Grafema's polyglot strategy

Per-language extraction in effects-db YAML must declare the contract class for each construct. A starter mapping:

```yaml
# effects-db/packages/<lang-or-framework>.yaml — proposed extension
contract_class: speced | emergent | synthesized-codegen | synthesized-resolution
              | synthesized-advice | reflective
modifiers: [versioned, compositional, time-dependent, conditional, open-world]
```

For Reflective sites, the extractor emits an OPAQUE_BOUNDARY ISSUE rather than a SHAPE; downstream tooling treats the ISSUE as a known incompleteness, not a bug.
