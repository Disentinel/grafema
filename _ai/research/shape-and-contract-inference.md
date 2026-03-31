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
