# Grafema AST Analysis: Gaps & Questions

This document analyzes which Babel AST node types and semantic relations are NOT currently implemented in Grafema, and identifies areas that need clarification or further design.

## Summary

**Currently implemented:** ~73 AST node types, 22 edge types
**Missing/Incomplete:** ~50+ AST node types, several critical edge patterns

---

## 1. Critical Gaps (High Priority)

### 1.1 Control Flow Statements (NOT TRACKED) — DECISION: ADD CONTROL FLOW LAYER

These AST nodes are currently ignored - no graph representation:

| AST Node | What It Does | Why It Matters |
|----------|--------------|----------------|
| `IfStatement` | Conditional branching | Critical for understanding code paths, dead code detection |
| `SwitchStatement` | Multi-way branching | Same as above |
| `WhileStatement` | Loop | Loop detection, infinite loop risk |
| `DoWhileStatement` | Loop (body first) | Same |
| `ForStatement` | Classic for loop | Same |
| `ForInStatement` | Object iteration | Iteration over object keys |
| `ForOfStatement` | Iterable iteration | Iteration over iterables |
| `TryStatement` | Exception handling | Error propagation, catch-all patterns |
| `ThrowStatement` | Exception throwing | Tracked partially (THROWS edge exists but not systematically) |

**DECISION: Yes, implement control flow layer.**

#### Proposed Design: Control Flow Nodes & Edges

##### New Node Types

```
BRANCH          - Conditional branching (if, switch, ternary)
LOOP            - Loop construct (for, while, do-while, for-in, for-of)
TRY_BLOCK       - Exception handling block
CATCH_BLOCK     - Catch clause
FINALLY_BLOCK   - Finally clause
```

##### New Edge Types

```
HAS_CONDITION   - BRANCH/LOOP → condition expression
HAS_CONSEQUENT  - BRANCH → consequent (then) block
HAS_ALTERNATE   - BRANCH → alternate (else) block
HAS_BODY        - LOOP → loop body
HAS_CATCH       - TRY_BLOCK → CATCH_BLOCK
HAS_FINALLY     - TRY_BLOCK → FINALLY_BLOCK
ITERATES_OVER   - LOOP → iterated collection (for-in/for-of)
```

##### Example: If Statement

```javascript
if (user.isAdmin) {
  deleteAll();
} else {
  showError();
}
```

Graph:
```
BRANCH#if:file.js:5
  ├─[HAS_CONDITION]→ EXPRESSION(user.isAdmin)
  ├─[HAS_CONSEQUENT]→ SCOPE#then:file.js:5
  │    └─[CONTAINS]→ CALL(deleteAll)
  └─[HAS_ALTERNATE]→ SCOPE#else:file.js:7
       └─[CONTAINS]→ CALL(showError)
```

##### Example: For-Of Loop

```javascript
for (const item of items) {
  process(item);
}
```

Graph:
```
LOOP#for-of:file.js:10
  ├─[ITERATES_OVER]→ VARIABLE(items)
  ├─[DECLARES]→ VARIABLE(item)
  └─[HAS_BODY]→ SCOPE#loop-body:file.js:10
       └─[CONTAINS]→ CALL(process)
            └─[PASSES_ARGUMENT]→ VARIABLE(item)
```

##### Example: Try-Catch-Finally

```javascript
try {
  riskyOperation();
} catch (error) {
  logError(error);
} finally {
  cleanup();
}
```

Graph:
```
TRY_BLOCK#try:file.js:1
  ├─[HAS_BODY]→ SCOPE#try-body:file.js:1
  │    └─[CONTAINS]→ CALL(riskyOperation)
  ├─[HAS_CATCH]→ CATCH_BLOCK#catch:file.js:3
  │    ├─[DECLARES]→ PARAMETER(error)
  │    └─[HAS_BODY]→ SCOPE#catch-body:file.js:3
  │         └─[CONTAINS]→ CALL(logError)
  └─[HAS_FINALLY]→ FINALLY_BLOCK#finally:file.js:5
       └─[HAS_BODY]→ SCOPE#finally-body:file.js:5
            └─[CONTAINS]→ CALL(cleanup)
```

##### Metadata on Existing Nodes

Additionally, annotate FUNCTION nodes with control flow metadata:

```typescript
interface FunctionControlFlowMetadata {
  hasBranches: boolean;      // Contains if/switch
  hasLoops: boolean;         // Contains for/while/do-while
  hasTryCatch: boolean;      // Contains try-catch
  hasEarlyReturn: boolean;   // Contains return not at end
  hasThrow: boolean;         // Contains throw
  cyclomaticComplexity: number;  // McCabe complexity
}
```

##### Use Cases Enabled

1. **Dead Code Detection**: Unreachable code after `return`/`throw` in branches
2. **Complexity Metrics**: Cyclomatic complexity from branch/loop count
3. **Error Flow Analysis**: Track which functions can throw, what catches them
4. **Loop Analysis**: Detect potential infinite loops, understand iteration patterns
5. **Condition Analysis**: What conditions guard certain operations

---

### 1.2 JSX (NOT IMPLEMENTED) — NEEDS DETAILED DESIGN

**Missing entirely:**
- `JSXElement` - React component usage
- `JSXFragment` - `<></>` fragments
- `JSXAttribute` - props passed to components
- `JSXSpreadAttribute` - `{...props}`
- `JSXExpressionContainer` - `{expression}`

**Why it matters:**
- Can't track React component usage
- Can't trace prop data flow
- Can't identify unused components

**DECISION: Needs more detailed design thinking before implementation.**

**Options to consider:**

1. **JSX as CALL:** `<Button onClick={fn}>` → `CALL` node to `Button` with `PASSES_ARGUMENT` to `fn`
   - Pro: Reuses existing infrastructure
   - Con: Loses JSX-specific semantics (children, fragments, etc.)

2. **Dedicated JSX types:** `JSX_ELEMENT`, `JSX_ATTRIBUTE` nodes
   - Pro: Full semantic representation
   - Con: Adds complexity, new node/edge types

3. **Plugin-based:** Separate plugin for React analysis
   - Pro: Clean separation, optional feature
   - Con: Requires plugin architecture work

**Key questions to answer:**
- How important is React/JSX support for target users?
- Should JSX children be modeled as special edges or reuse `CONTAINS`?
- How to handle component composition patterns?
- Do we need to distinguish HTML elements from custom components?

**Deferred to separate design document.**

---

### 1.3 Dynamic Import (PARTIALLY IMPLEMENTED)

**Current state:**
- Static `import x from 'y'` ✓
- Dynamic `import('module')` - NOT tracked

**Missing:**
```javascript
const mod = await import('./dynamic.js');  // Dynamic import not tracked
const config = await import(`./config/${env}.js`);  // Template literal path
```

**Question:** How to handle dynamic import paths?
- Literal paths: Can resolve
- Template literals: Can partially resolve
- Variable paths: Cannot resolve statically

**Recommendation:** Track as `IMPORT` node with `isDynamic: true` flag, resolve what we can.

---

### 1.4 Return Statement Analysis (INCOMPLETE)

**Current state:**
- `FUNCTION -[RETURNS]→ ?` edge exists
- But target is not systematically populated

**Missing:**
```javascript
function getData() {
  return { foo: bar };  // What does it return? Not tracked
}

async function fetchUser() {
  return await api.get('/user');  // Return value derived from call
}
```

**What should happen:**
- `FUNCTION -[RETURNS]→ LITERAL` (for literal returns)
- `FUNCTION -[RETURNS]→ VARIABLE` (for variable returns)
- `FUNCTION -[RETURNS]→ CALL` (for function call returns)

---

### 1.5 Closure Capture (INCOMPLETE)

**Current state:**
- `SCOPE -[CAPTURES]→ VARIABLE` exists
- But only for immediate parent scope

**Missing:**
```javascript
function outer() {
  const x = 1;
  return function inner() {
    return function deepest() {
      return x;  // Captures from 2 levels up - not tracked properly
    }
  }
}
```

**Question:** Should we track transitive captures?

---

## 2. Medium Priority Gaps

### 2.1 Generator Functions (PARTIAL)

**Current state:**
- `generator: true` flag on FUNCTION ✓
- `YieldExpression` - NOT tracked

**Missing:**
```javascript
function* gen() {
  yield 1;           // What values are yielded? Not tracked
  yield* otherGen(); // Delegation to another generator
}
```

**What should happen:**
- `FUNCTION -[YIELDS]→ value` edges
- `FUNCTION -[DELEGATES_TO]→ otherGenerator` for `yield*`

---

### 2.2 Optional Chaining (PARTIAL)

**Current state:**
- `OptionalMemberExpression` handled in some cases
- `OptionalCallExpression` handled in some cases

**Missing nuance:**
```javascript
const x = obj?.prop?.nested;  // Each ?. is potential null check
const y = fn?.();             // Optional function call
```

**Question:** Do we need to track optional-ness for data flow? Probably not critical.

---

### 2.3 Nullish Coalescing (NOT EXPLICITLY TRACKED)

```javascript
const x = foo ?? 'default';  // LogicalExpression with ?? operator
```

**Current state:** Handled as generic `LogicalExpression` in `DERIVES_FROM` edges.
**Status:** Acceptable for now.

---

### 2.4 Spread in Various Contexts (INCOMPLETE)

**Current state:**
- `SpreadElement` in function arguments ✓
- `SpreadElement` in array literals ✓
- `SpreadElement` in object literals ✓

**Missing nuance:**
```javascript
const merged = { ...a, ...b, c: 1 };  // Order matters for data flow
```

**Question:** Should we track spread order? Probably overkill.

---

### 2.5 Computed Property Names (PARTIAL)

**Current state:**
- `computed: true` flag tracked
- `computedPropertyVar` tracked for method calls

**Missing:**
```javascript
const key = 'dynamic';
const obj = { [key]: value };  // Computed property creation
obj[key] = newValue;           // Computed property write
```

**What should happen:**
- Track `[key]` as computed access
- Link to the `key` variable if resolvable

---

### 2.6 Class Features (PARTIAL)

**Current state:**
- Class declarations ✓
- Class methods ✓
- Class properties ✓
- Static blocks - NOT tracked
- Private fields (#field) - NOT tracked
- Decorators ✓

**Missing:**
```javascript
class Foo {
  static { /* init code */ }  // StaticBlock
  #private = 1;               // PrivateName
  get prop() { }              // Getter/setter distinction
}
```

---

### 2.7 for...of / for...in Destructuring (NOT TRACKED)

```javascript
for (const { x, y } of points) {  // Destructuring in loop
  // x and y are scoped to loop body
}
```

**Current state:** Loop variables not tracked at all.

---

## 3. Low Priority Gaps (Edge Cases)

### 3.1 eval() and Function() Constructor

**Current state:** Flagged but not tracked

```javascript
eval('code');              // Security concern, can't analyze
new Function('a', 'b', 'return a + b');  // Same
```

**Recommendation:** Flag as security issue, don't analyze content.

---

### 3.2 with Statement

```javascript
with (obj) {
  x = 1;  // Ambiguous scope
}
```

**Status:** Correctly ignored. `with` is deprecated and impossible to analyze statically.

---

### 3.3 Labels and Labeled Statements

```javascript
outer: for (...) {
  inner: for (...) {
    break outer;  // Jump to outer loop
  }
}
```

**Recommendation:** Not worth tracking unless doing advanced control flow analysis.

---

### 3.4 Sequence Expressions

```javascript
const x = (a++, b++, c);  // Returns c, but a and b have side effects
```

**Current state:** Partially handled in expression evaluation.
**Recommendation:** Low priority.

---

### 3.5 Comma Operator in Declarations

```javascript
let a = 1, b = 2, c = 3;  // Multiple declarators
```

**Current state:** Handled correctly (iterates through declarations array).

---

## 4. Design Decisions (CONFIRMED)

### Q1: Expression Nodes Granularity — DECISION: FLAT FOR NOW

**Issue:** Currently creating `EXPRESSION` nodes for many expression types.

```javascript
const x = a + b * c;
```

**Current:** Creates one `EXPRESSION` node with `DERIVES_FROM` edges to `a`, `b`, `c`.

**Alternative:** Create AST-like tree of expression nodes.

**DECISION: Flat representation with `DERIVES_FROM` edges is sufficient for now.**

Rationale:
- Flat model answers "where does this value come from?" effectively
- Expression trees add complexity without clear use cases yet
- Can extend later if specific queries require tree structure

---

### Q2: Literal Deduplication

**Issue:** Same literal value creates multiple nodes.

```javascript
foo(42);
bar(42);  // Both create separate LITERAL nodes for 42
```

**Question:** Should we deduplicate by value, or keep separate nodes?

**Recommendation:** Keep separate - they're different AST positions with different contexts.

---

### Q3: Type Annotations Processing

**Issue:** TypeScript types are partially tracked (INTERFACE, TYPE, ENUM).

**Missing:**
- Type parameter constraints
- Conditional types
- Mapped types
- Template literal types

**Question:** How much type-level analysis is needed?

**Recommendation:** Current level is sufficient for structural analysis. Deep type analysis is better left to TypeScript compiler.

---

### Q4: Async/Await Edge Cases

**Current state:**
- `async` flag on FUNCTION ✓
- `AwaitExpression` unwrapped in assignments ✓

**Missing:**
- Multiple awaits in sequence
- Await in loops (potential issues)
- Top-level await

**Question:** Is current handling sufficient?

**Recommendation:** Yes for v0.2.

---

### Q5: Module Side Effects

```javascript
import './polyfill.js';  // Side-effect-only import
```

**Current state:** Import node created, but no specifiers.

**Question:** Should we flag these as "side-effect imports"?

**Recommendation:** Add `sideEffect: true` flag to IMPORT nodes.

---

## 5. Implementation Roadmap (Updated with Decisions)

### Phase 1: v0.2 (Current Focus)
- [ ] **Control Flow Layer** — CONFIRMED
  - [ ] `BRANCH`, `LOOP`, `TRY_BLOCK`, `CATCH_BLOCK`, `FINALLY_BLOCK` nodes
  - [ ] `HAS_CONDITION`, `HAS_CONSEQUENT`, `HAS_ALTERNATE`, `HAS_BODY`, etc. edges
  - [ ] Function metadata: hasBranches, hasLoops, hasTryCatch, cyclomaticComplexity
- [ ] Dynamic import tracking (`isDynamic: true` flag)
- [ ] Return statement RETURNS edges (needs more design)

### Phase 2: v0.3
- [ ] JSX support (after detailed design)
- [ ] Generator yield tracking
- [ ] Static blocks
- [ ] Private fields
- [ ] Enhanced closure capture

### Phase 3: v0.5+
- [ ] Advanced type analysis (optional)
- [ ] Full CFG visualization

---

## 6. Edge Types Summary

### Currently Implemented (22)
✓ CONTAINS, HAS_SCOPE, HAS_PARAMETER, DECLARES
✓ CALLS, PASSES_ARGUMENT, HAS_CALLBACK, HANDLED_BY, MAKES_REQUEST
✓ ASSIGNED_FROM, DERIVES_FROM, FLOWS_INTO
✓ IMPLEMENTS, EXTENDS, DECORATED_BY
✓ CAPTURES, MODIFIES, IMPORTS, WRITES_TO, INSTANCE_OF
✓ HAS_PROPERTY, HAS_ELEMENT

### New Edges for Control Flow Layer (v0.2)
- `HAS_CONDITION` - BRANCH/LOOP → condition expression
- `HAS_CONSEQUENT` - BRANCH → consequent (then) block
- `HAS_ALTERNATE` - BRANCH → alternate (else) block
- `HAS_BODY` - LOOP/TRY_BLOCK → body scope
- `HAS_CATCH` - TRY_BLOCK → CATCH_BLOCK
- `HAS_FINALLY` - TRY_BLOCK → FINALLY_BLOCK
- `ITERATES_OVER` - LOOP → iterated collection

### Future Edges (v0.3+)
- `RETURNS` - properly populated (FUNCTION → return value)
- `YIELDS` - generator yields (FUNCTION → yielded value)
- `DELEGATES_TO` - yield* delegation (FUNCTION → generator)
- `THROWS` - exception flow (FUNCTION/CALL → error type)

---

## 7. Files to Modify

### v0.2 Control Flow Implementation

| File | Changes Needed |
|------|----------------|
| **New: `ControlFlowVisitor.ts`** | Handle IfStatement, SwitchStatement, WhileStatement, ForStatement, TryStatement |
| `types.ts` | Add BRANCH, LOOP, TRY_BLOCK, CATCH_BLOCK, FINALLY_BLOCK node interfaces |
| `edges.ts` | Add HAS_CONDITION, HAS_CONSEQUENT, HAS_ALTERNATE, HAS_BODY, HAS_CATCH, HAS_FINALLY, ITERATES_OVER |
| `nodes.ts` / `NodeKind.ts` | Register new node types |
| `GraphBuilder.ts` | Process control flow collections |
| `FunctionVisitor.ts` | Compute control flow metadata (hasBranches, cyclomaticComplexity) |
| `ImportExportVisitor.ts` | Add `isDynamic: true` flag for `import()` expressions |

### v0.3+ (Future)

| File | Changes Needed |
|------|----------------|
| `JSXVisitor.ts` (new) | Dedicated JSX handling (after design) |
| `FunctionVisitor.ts` | Track return statements, yields |
