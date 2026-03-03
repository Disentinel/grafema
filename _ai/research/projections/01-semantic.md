# Projection 1: Semantic

**Question:** What does the code *mean*?
**Soundness:** Real code dependency exists → graph shows it.

## Lenses

### 1.1 DFG (how do values flow)

**read** — consuming a stored value (variable read, property access, array index)
- × Security: "Is this read accessing untrusted data?" Taint source identification.
- × Behavioral: "This read fetches user preference — how often is it accessed?"

**write** — producing/storing a value (variable assignment, property set)
- × Contractual: "This write produces the API response — does it match the spec?"
- × Causal: "This write overwrote the correct value with a wrong one — root cause."

**transform** — consuming inputs and producing a new value (operation, function return)
- × Financial: "This transform calls a paid API per invocation." Cost amplifier.
- × Operational: "This transform is the hot path — 60% of CPU."

**propagation** — value passing through unchanged (parameter pass, return, spread, destructuring)
- × Security: "User input propagates through 4 functions unsanitized to SQL query." The chain IS the vulnerability.
- × Epistemic: "Developer doesn't realize this value originated 3 modules away."

**mutation** — modifying an existing object without creating a new binding (`x.push(y)`, `obj.name = val`)
- × Causal: "Mutation of shared object caused race condition." Mutation ≠ new binding, which makes it invisible in naive flow analysis.
- × Risk: "This mutation has side effects visible to other modules." Hidden coupling through shared mutable state.

> **Note:** One AST node can be multiple DFG roles simultaneously. `x += 1` is read(x) + transform(+) + write(x). A function call is read(args) + transform(body) + write(return). The graph models roles, not nodes.

### 1.2 CFG (in what order does code execute)

**entry_point** — where execution begins (function entry, event handler, module top-level)
- × Security: "Is this entry point reachable from untrusted input?" Attack surface boundary.
- × Operational: "This entry point is an HTTP handler — maps to endpoint /api/users."

**exit_point** — where execution ends (return, throw, implicit return, process.exit)
- × Contractual: "Does every exit point return a value matching the type contract?"
- × Causal: "Crash happened at this exit point — uncaught throw."

**branch** — conditional execution point (if/switch/ternary)
- × Contractual: "Are all branches covered by tests?" Untested branch = invisible risk.
- × Risk: "What happens on the else path nobody ever hits?" Dead branches hide surprises.

**loop** — repeated execution construct
- × Operational: "This loop iterates over all records — O(n) on production dataset." Performance impact.
- × Financial: "This loop calls a paid API per iteration." Cost amplifier.

**exception_path** — error handling flow (try/catch/finally)
- × Causal: "The incident happened because this catch swallows errors silently." Root cause in CFG.
- × Contractual: "Does every exception path produce an error response matching the API spec?"

**early_exit** — return/throw/break that terminates normal flow
- × Contractual: "This guard clause returns 403 — does it match the auth SLO?"
- × Behavioral: "How often does this early exit actually fire in production?"

### 1.3 Scope (where are names visible)

**binding** — name-to-value association in a scope
- × Epistemic: "What does `config` mean in this file?" Without scope, name is ambiguous.
- × Security: "Is `password` still accessible after this block ends?"

**closure** — captured environment from outer scope
- × Causal: "This closure captured a stale reference — the bug is a scope issue."
- × Risk: "This closure holds a DB connection — if it leaks, connection pool exhausts."

**shadow** — name in inner scope hiding outer name
- × Causal: "The bug: inner `user` shadows outer `user`, wrong object is mutated."
- × Epistemic: "Developer thinks they're using module-level config but actually using local shadow."

### 1.4 Call (who calls whom)

**call_site** — location where a function is invoked
- × Temporal: "This call site was added in commit X" — when the dependency was introduced.
- × Organizational: "This call site is in Team A's code, calling Team B's function" — cross-team coupling.

**callee** — the function being called (resolved target)
- × Operational: "This callee becomes an HTTP request at runtime" — code-to-infra mapping.
- × Financial: "This callee calls Stripe API — each invocation costs $0.01."

**argument** — value passed to a function
- × Security: "Is this argument user-controlled? Does the callee trust it?"
- × Contractual: "Does this argument satisfy the callee's type contract?"

### 1.5 Module (what depends on what)

**import** — dependency on external module
- × Security: "This import pulls in a package with known CVE." Supply chain risk.
- × Risk: "This import depends on a package with 1 maintainer and no funding."

**export** — public interface of a module
- × Organizational: "This export is used by 5 other teams — breaking change requires coordination."
- × Contractual: "This export is the API contract — any change must be backwards-compatible."

**re-export** — passing through a module's export from another module (barrel file)
- × Risk: "Consumer thinks they depend on module A, actually depend on B through A." Invisible coupling.
- × Epistemic: "Developers don't realize this function comes from three modules away."

**dynamic_import** — runtime-loaded dependency (`import()`, `require()`)
- × Operational: "This dynamic import triggers code splitting — separate chunk loaded on demand."
- × Security: "Dynamic import path constructed from user input — potential code injection."

### 1.6 Structure (what is composed of what)

**class** — type definition (class, interface, object shape)
- × Intentional: "This class implements the core of feature X." Feature-to-code mapping.
- × Organizational: "This class is owned by Team Y." Ownership granularity below module level.

**method** — behavior defined on a type
- × Behavioral: "This method is the hot path — called 50k times/day." Usage data on code structure.
- × Contractual: "This method must satisfy invariant Z." Guarantee attachment point.

**property** — data field on a type
- × Security: "This property contains PII (email)." Data classification on structure.
- × Compliance: "This property must be encrypted at rest per GDPR."

**inheritance** — type extension chain (extends, implements, mixins)
- × Causal: "Breaking change in parent class cascades to 12 subclasses."
- × Epistemic: "Developer must understand parent to understand child — implicit knowledge dependency."

**composition** — containment relationship (object with objects, class with injected deps)
- × Structure: "Service A depends on Service B, C, D — visible in constructor."
- × Risk: "Deep composition chain means single failure cascades."

### 1.7 Type (what types exist and where do they break)

**type_declaration** — definition of a type (interface, type alias, class as type, enum)
- × Contractual: "This type IS the API contract — callers depend on its shape."
- × Epistemic: "This type documents developer intent about the domain model."

**type_constraint** — restriction on values (generic bound, union member, type guard, Zod schema)
- × Contractual: "Violation of this constraint = runtime error."
- × Security: "This constraint prevents SQL injection by narrowing input type."

**type_relationship** — connection between types (extends, implements, assignable to)
- × Semantic/Structure: "Type hierarchy = architecture of the domain model."
- × Intentional: "These types model the business domain — Product, Order, Payment."

**type_boundary** — point where one type system meets another (API boundary, JSON.parse, DB read, serialization)
- × Security: "At this boundary, types are not validated — `JSON.parse` returns `any`."
- × Contractual: "Here GraphQL schema validates what TypeScript promises — or doesn't."
- × Causal: "The bug: type was correct in code, but serialization lost the Date→string conversion."

**type_gap** — place where type is unknown, `any`, or unverifiable
- × Risk: "`any` = no safety net. Whatever flows through here is unchecked."
- × Contractual: "At this point the type system can't help — runtime validation needed."

### 1.8 Physical (code containers hierarchy)

**file** — physical source file
- × Organizational: "CODEOWNERS works at file level." Ownership granularity.
- × Temporal: "Git history is per-file — 'who last touched this file?'"
- × Epistemic: "File name IS documentation — `auth-middleware.ts` tells you what's inside."

**directory** — physical grouping of files
- × Intentional: "`src/features/checkout/` — directory AS feature boundary." Physical layout encodes intent.
- × Organizational: "This directory is owned by Team X." Team-to-directory mapping.

**package** — distributable unit (npm package, jar, wheel)
- × Risk: "This package has 1 maintainer and 500 dependents." Supply chain risk.
- × Operational: "This package is deployed to registry Y." Distribution channel.
- × Temporal: "Version 2.3.1 introduced the breaking change."

**repository** — version-controlled container
- × Organizational: "This repo belongs to Team X." Ownership at repo level.
- × Temporal: "This repo's full history — all commits, branches, tags."
- × Security: "Who has write access to this repo?"

**registry** — package distribution infrastructure (npm, PyPI, Maven Central)
- × Operational: "Packages are published to and consumed from this registry."
- × Risk: "If this registry goes down, CI/CD breaks." Infrastructure dependency.
- × Security: "Is this a private or public registry? Who can publish?"

---

## AST Node Types → Semantic Edges

This section maps every Babel AST node type to the semantic edges it creates.

**Source:** `@babel/types@7.28.6` — 253 node types total.
**Scope:** Core JS (106), JSX (15), TypeScript (67), Flow (65).
**Notation:**

```
NodeType                              [fields]
  LENS → EDGE_TYPE: source → target   (description)
```

### Edge Types Legend

**DFG edges** (data flow):

| Edge | Meaning |
|------|---------|
| `READS` | Expression reads a binding or value |
| `WRITES` | Expression writes to a binding |
| `MUTATES` | Expression modifies an existing object in-place |
| `TRANSFORMS` | Expression creates new value from inputs |
| `PROPAGATES` | Value passes through unchanged |
| `TERMINAL` | Expression creates a new value with no incoming data flow (literals, closures) |

**CFG edges** (control flow):

| Edge | Meaning |
|------|---------|
| `BRANCHES_TO` | Control flow conditionally goes to target |
| `LOOPS_TO` | Control flow repeats through target |
| `EXITS_TO` | Control flow exits to caller/handler |
| `NEXT` | Sequential control flow |
| `THROWS` | Exception flow to catch handler |
| `ENTRY_POINT` | Node is where execution begins |
| `EXCEPTION_PATH` | Error handling flow (try → catch → finally) |
| `LABELS` | Named target for break/continue |

**Scope edges:**

| Edge | Meaning |
|------|---------|
| `BINDS` | Name bound in scope |
| `CREATES_SCOPE` | Node creates a new scope |
| `CAPTURES` | Closure captures outer binding |
| `SHADOWS` | Inner binding shadows outer |
| `REFERENCES` | Refers to a binding in scope chain |

**Call edges:**

| Edge | Meaning |
|------|---------|
| `CALLS` | Invocation edge from call site to callee |
| `PASSES_ARGUMENT` | Argument passed to callee parameter |
| `RETURNS` | Value returned from function to caller |
| `DEFINES` | Node defines a callable entity |

**Module edges:**

| Edge | Meaning |
|------|---------|
| `IMPORTS_FROM` | Module imports from source |
| `EXPORTS` | Module exports symbol |
| `RE_EXPORTS` | Module re-exports from another |
| `REFERENCES` | Refers to external module |
| `METADATA` | Import/export metadata (assertions, attributes) |

**Structure edges:**

| Edge | Meaning |
|------|---------|
| `DEFINES` | Node defines a structural entity (class, object shape) |
| `CONTAINS` | Container holds members |
| `HAS_MEMBER` | Structure has a member (method, property) |
| `EXTENDS` | Type/class extends another |
| `IMPLEMENTS` | Class implements interface |
| `CREATES` | Expression creates new instance |
| `ACCESS` | Expression accesses member of structure |

**Type edges:**

| Edge | Meaning |
|------|---------|
| `DECLARES_TYPE` | Node declares a type |
| `HAS_PROPERTY` | Type has a property |
| `INSTANTIATES` | Expression instantiates or applies a type |
| `ASSERTS_TYPE` | Expression narrows/asserts type |
| `VALIDATES_TYPE` | Expression validates type conformance without narrowing (satisfies) |
| `REFERENCES` | Refers to a type by name |
| `ANNOTATES` | Attaches type to a binding |
| `EXTENDS` | Type extends another type |

**Physical edges:**

| Edge | Meaning |
|------|---------|
| `FILE` | Represents file content |

---

### Core JS — Expressions

#### Literals

```
NumericLiteral                        [value]
  DFG → TERMINAL: creates numeric value (no incoming flow)

StringLiteral                         [value]
  DFG → TERMINAL: creates string value (no incoming flow)

BooleanLiteral                        [value]
  DFG → TERMINAL: creates boolean value (no incoming flow)

NullLiteral                           []
  DFG → TERMINAL: creates null value (no incoming flow)

BigIntLiteral                         [value]
  DFG → TERMINAL: creates bigint value (no incoming flow)

RegExpLiteral                         [pattern, flags]
  DFG → TERMINAL: creates regexp value (no incoming flow)

DecimalLiteral                        [value]
  DFG → TERMINAL: creates decimal value (no incoming flow)

TemplateLiteral                       [quasis, expressions]
  DFG → READS: reads each expression in ${...}
  DFG → TRANSFORMS: expressions + quasis → new string value
  Note: tagging is handled by TaggedTemplateExpression, not here — untagged TemplateLiteral only concatenates

TemplateElement                       [value, tail]
  (structural — part of TemplateLiteral, no edges of its own)
```

#### Identifiers & References

```
Identifier                            [name]
  DFG → READS: reads binding from current scope (when in expression position)
  DFG → WRITES: writes to binding (when LVal in assignment/declaration)
  Scope → REFERENCES: refers to a binding in scope chain
  (context-dependent — role changes based on parent node)

ThisExpression                        []
  DFG → READS: reads implicit `this` binding from enclosing function/class
  Scope → REFERENCES: refers to `this` binding (lexical in arrow, dynamic in function)

Super                                 []
  DFG → READS: reads parent class reference
  Structure → REFERENCES: refers to superclass

MetaProperty                          [meta, property]
  DFG → READS: reads meta-level property (new.target, import.meta, function.sent)
  (TERMINAL for import.meta — produces environment value)
```

#### Operations

```
BinaryExpression                      [operator, left, right]
  DFG → READS: reads left and right operands
  DFG → TRANSFORMS: left + right → new value via operator
  DFG → TERMINAL: result is a newly created value
  Note: `left in right` — left can be PrivateName (`#field in obj`)

UnaryExpression                       [prefix, argument, operator]
  DFG → READS: reads argument
  DFG → TRANSFORMS: argument → new value via operator (typeof, !, +, -, ~, void, delete, throw)
  DFG → TERMINAL: result is a newly created value
  DFG → MUTATES: `delete obj.prop` mutates obj (removes property)
  CFG → THROWS: `throw` as unary operator (proposal) raises exception
  Note: `void expr` always produces `undefined`; `+expr` coerces to number

UpdateExpression                      [prefix, argument, operator]
  DFG → READS: reads argument (current value)
  DFG → WRITES: writes back incremented/decremented value to same binding
  DFG → TRANSFORMS: argument → argument ± 1
  DFG → PROPAGATES: prefix=true → NEW value flows to parent; prefix=false → OLD value flows to parent
  Note: `++x` (prefix) returns value AFTER update; `x++` (postfix) returns value BEFORE update.
    argument must be Identifier or MemberExpression (not arbitrary expression)

LogicalExpression                     [operator, left, right]
  DFG → READS: reads left; conditionally reads right
  DFG → PROPAGATES: left → parent (if short-circuit) OR right → parent
  CFG → BRANCHES_TO: left evaluated first; right evaluated only if condition met
  Note: `||` — right evaluated if left is falsy (any falsy: 0, "", null, undefined, false, NaN)
    `&&` — right evaluated if left is truthy
    `??` — right evaluated ONLY if left is null/undefined (NOT other falsy values)
    All three short-circuit: right may not execute. Result is one of the operands, not coerced to boolean

ConditionalExpression                 [test, consequent, alternate]
  DFG → READS: reads test
  DFG → PROPAGATES: consequent → parent OR alternate → parent (one of two)
  CFG → BRANCHES_TO: test ? consequent : alternate
  Note: result flows from ONE of consequent/alternate, not both

SequenceExpression                    [expressions]
  DFG → PROPAGATES: last expression → parent (only last expression's value survives)
  CFG → NEXT: expressions evaluated left to right, all side effects execute

AssignmentExpression                  [operator, left, right]
  DFG → READS: reads right (and left if compound: +=, -=, etc.)
  DFG → WRITES: writes result to left
  DFG → PROPAGATES: assigned value → parent (the expression evaluates to the assigned value)
  Scope → WRITES: updates binding at left
  Note: `a = b` → right flows to left AND to parent. `a += b` → read(a) + read(b) + transform(+) + write(a).
    left can be a pattern (ArrayPattern, ObjectPattern) for destructuring: `[a, b] = arr`, `{x} = obj`.
    When left is a pattern, only `=` operator is valid (not compound).
    Logical assignment operators (`||=`, `&&=`, `??=`) have short-circuit semantics:
    `a ||= b` only evaluates and assigns b if a is falsy; `a ??= b` only if a is null/undefined
  CFG → BRANCHES_TO: for `||=`, `&&=`, `??=` — right side conditionally evaluated (short-circuit)
```

#### Property Access

```
MemberExpression                      [object, property, computed]
  DFG → READS: reads object; reads property from it (non-computed: static name; computed: reads expression)
  DFG → PROPAGATES: object.property → parent
  Structure → ACCESS: accesses member of object/class
  Note: non-computed `a.b` — property is Identifier (static name, not a DFG read of binding `b`).
    Computed `a[expr]` — property is Expression, READS expr as separate DFG node.
    `a.#b` — property is PrivateName (non-computed), class-private access

OptionalMemberExpression              [object, property, computed, optional]
  DFG → READS: reads object; conditionally reads property (if object not nullish)
  DFG → PROPAGATES: object?.property → parent (may be undefined)
  CFG → BRANCHES_TO: null-check on object — short-circuits to undefined if nullish
  Structure → ACCESS: accesses member of object/class

SpreadElement                         [argument]
  DFG → READS: reads argument (iterable/object)
  DFG → PROPAGATES: argument elements → parent container (expanded)
  Note: `...x` — context-dependent behavior:
    In array: iterates x, spreads elements into array positions
    In object: copies own enumerable properties of x into object
    In call: iterates x, spreads as individual arguments
```

#### Function-Related Expressions

```
ArrowFunctionExpression               [params, body, async, expression]
  DFG → TERMINAL: creates a new function value (closure)
  Scope → CREATES_SCOPE: new scope for params and body
  Scope → BINDS: each param bound in function scope
  Scope → CAPTURES: captures bindings from enclosing scope (lexical this, outer vars)
  CFG → ENTRY_POINT: body is the entry point of the function
  Structure → DEFINES: defines an anonymous callable
  Note: arrow captures lexical `this` — no own `this`, `arguments`, `super`, or `new.target` bindings.
    Cannot be used as constructor (no `new`). Cannot be a generator

FunctionExpression                    [id, params, body, generator, async]
  DFG → TERMINAL: creates a new function value (closure)
  Scope → CREATES_SCOPE: new scope for params and body
  Scope → BINDS: each param bound in function scope; optional `id` bound in inner scope only
  Scope → CAPTURES: captures outer bindings (but NOT lexical this — has own `this`)
  CFG → ENTRY_POINT: body is the entry point of the function
  Structure → DEFINES: defines a callable (named or anonymous)
  Note: if generator=true, body can contain YieldExpression. If async=true, body can contain AwaitExpression

AwaitExpression                       [argument]
  DFG → READS: reads argument (promise)
  DFG → PROPAGATES: argument (unwrapped from Promise) → parent
  CFG → EXITS_TO: suspends execution, resumes when promise settles
  CFG → THROWS: if promise rejects, throws the rejection reason as exception
  Note: await unwraps Promise — the resolved value flows to parent, not the promise itself.
    If argument is not a Promise, it is wrapped in Promise.resolve() first

YieldExpression                       [delegate, argument]
  DFG → READS: reads argument (if present; yield without argument sends undefined)
  DFG → PROPAGATES: argument → caller (via generator.next() return value)
  DFG → PROPAGATES: .next(value) → this expression (bidirectional: yield both sends out AND receives)
  CFG → EXITS_TO: suspends generator, resumes on next .next() call
  Note: `yield*` (delegate=true) → delegates to sub-iterator, propagates each value individually.
    With `yield*`, return value of sub-iterator becomes value of the yield* expression.
    Without argument: `yield` sends undefined to caller

CallExpression                        [callee, arguments]
  DFG → READS: reads callee and each argument
  DFG → TRANSFORMS: arguments → return value (through function body)
  Call → CALLS: invocation edge to callee
  Call → PASSES_ARGUMENT: each argument → corresponding parameter
  Call → RETURNS: callee's return value → this expression
  CFG → THROWS: callee may throw (any function call is a potential exception source)
  Note: callee can be Expression or Super (super.method()). Arguments can include SpreadElement

OptionalCallExpression                [callee, arguments, optional]
  DFG → READS: reads callee (if not nullish) and arguments
  DFG → TRANSFORMS: arguments → return value (through function body) or undefined
  Call → CALLS: conditional invocation — only if callee is not nullish
  Call → PASSES_ARGUMENT: each argument → corresponding parameter
  CFG → BRANCHES_TO: null-check on callee — short-circuits to undefined if nullish
  Call → RETURNS: callee's return value → this expression (if called)
  CFG → THROWS: callee may throw if invoked

NewExpression                         [callee, arguments]
  DFG → READS: reads callee (constructor) and each argument
  DFG → TRANSFORMS: arguments → new instance
  Call → CALLS: invocation of constructor
  Call → PASSES_ARGUMENT: each argument → constructor parameter
  Type → INSTANTIATES: creates instance of callee's type
  Call → RETURNS: new instance → this expression (unless constructor explicitly returns object)
  Structure → CREATES: creates new object instance
  CFG → THROWS: constructor may throw

TaggedTemplateExpression              [tag, quasi, typeParameters]
  DFG → READS: reads tag function and quasi's expressions
  DFG → TRANSFORMS: tag processes template parts → return value
  Call → CALLS: invocation of tag function
  Call → PASSES_ARGUMENT: first arg = strings array (from quasis), rest args = evaluated expressions
  Call → RETURNS: tag function's return value → this expression
  CFG → THROWS: tag function may throw
  Note: tag receives (strings[], ...values) — strings array has .raw property with unprocessed strings.
    The return type is whatever the tag function returns (not necessarily a string)

BindExpression                        [object, callee]
  DFG → READS: reads object and callee
  DFG → TRANSFORMS: creates bound function (object::callee → callee.bind(object))
  Note: proposal — `obj::fn` is `fn.bind(obj)`
```

#### Object & Array Constructors

```
ArrayExpression                       [elements]
  DFG → READS: reads each element
  DFG → TRANSFORMS: elements → new array value
  DFG → TERMINAL: creates a new array object
  Note: elements can include SpreadElement and null (holes: `[1,,3]`)

ObjectExpression                      [properties]
  DFG → READS: reads each property value (and computed keys)
  DFG → TRANSFORMS: properties → new object value
  DFG → TERMINAL: creates a new object
  Structure → DEFINES: defines an object shape (properties as members)
  Note: properties can include SpreadElement (`{...other}`), ObjectProperty, and ObjectMethod

ObjectProperty                        [key, value, computed, shorthand]
  DFG → READS: reads value (and key if computed)
  DFG → PROPAGATES: value → property slot on parent object
  Structure → HAS_MEMBER: parent object has this property
  Note: in ObjectPattern context, value is PatternLike (destructuring target, not source)

ObjectMethod                          [kind, key, params, body, computed, generator, async]
  Scope → CREATES_SCOPE: new scope for params and body
  Scope → BINDS: each param bound in method scope
  CFG → ENTRY_POINT: body is the entry point
  Structure → HAS_MEMBER: parent object has this method
  Call → DEFINES: defines a callable method (get/set/method)

RecordExpression                      [properties]
  DFG → READS: reads each property value
  DFG → TRANSFORMS: properties → new immutable record
  DFG → TERMINAL: creates new record value (proposal)
  Note: like ObjectExpression but value is deeply immutable. Properties: ObjectProperty | SpreadElement

TupleExpression                       [elements]
  DFG → READS: reads each element
  DFG → TRANSFORMS: elements → new immutable tuple
  DFG → TERMINAL: creates new tuple value (proposal)
  Note: like ArrayExpression but value is deeply immutable. Elements: Expression | SpreadElement
```

#### Patterns (Destructuring)

```
ArrayPattern                          [elements]
  DFG → PROPAGATES: source array → each element binding (destructured)
  Scope → BINDS: each element identifier bound in scope
  Note: `const [a, b] = arr` — arr[0] → a, arr[1] → b. Elements can be null (holes), PatternLike, or RestElement

ObjectPattern                         [properties]
  DFG → PROPAGATES: source object → each property binding (destructured)
  Scope → BINDS: each property target identifier bound in scope
  Note: `const {x, y: z} = obj` — obj.x → x, obj.y → z. Properties: RestElement | ObjectProperty

AssignmentPattern                     [left, right]
  DFG → READS: reads right (default value) — only evaluated if source is undefined
  DFG → PROPAGATES: source value → left (if defined), otherwise right → left
  CFG → BRANCHES_TO: check if source is undefined → use default
  Note: `function(a = 5)` or `const {x = 0} = obj`. Default is lazily evaluated

RestElement                           [argument]
  DFG → PROPAGATES: remaining elements/properties → argument binding
  Scope → BINDS: argument bound in scope
  Note: `const [a, ...rest] = arr` — remaining elements → rest. Must be last element in pattern

VoidPattern                           []
  (structural — represents empty binding slot in destructuring, proposal stage)
  Note: used in pattern position where no binding is needed — `const [, , third] = arr` alternative syntax
```

#### Pipeline (Proposal)

```
PipelineTopicExpression               [expression]
  DFG → PROPAGATES: topic reference → expression
  Note: `x |> #.toString()` — x flows into # placeholder

PipelineBareFunction                  [callee]
  DFG → READS: reads callee function
  Call → CALLS: pipe calls callee with piped value
  Call → PASSES_ARGUMENT: piped value → first parameter of callee
  Note: `x |> fn` — fn(x)

PipelinePrimaryTopicReference         []
  DFG → READS: reads the current pipeline topic value
  Note: `#` in pipeline — refers to value being piped

TopicReference                        []
  DFG → READS: reads topic value (Hack-style pipes)
```

#### Miscellaneous Expressions

```
ParenthesizedExpression               [expression]
  DFG → PROPAGATES: expression → parent (transparent wrapper)
  Note: purely syntactic, no semantic effect

TypeCastExpression                    [expression, typeAnnotation]  (Flow)
  DFG → PROPAGATES: expression → parent (value unchanged)
  Type → ASSERTS_TYPE: narrows type of expression to typeAnnotation
  Note: runtime no-op, only type-level effect

Import                                []
  Module → IMPORTS_FROM: dynamic import marker (deprecated — use ImportExpression)

ImportExpression                      [source, options, phase]
  DFG → READS: reads source (module specifier string); reads options (if present)
  DFG → TRANSFORMS: source → Promise<module namespace>
  Module → IMPORTS_FROM: dynamic import of module at runtime
  CFG → THROWS: import can fail (module not found, network error, module execution error)
  Note: returns a Promise — execution continues, module loads asynchronously.
    phase can be "source" or "defer" (proposals). options is import attributes: `import(x, {with: {...}})`

DoExpression                          [body, async]
  DFG → PROPAGATES: completion value of body → parent (proposal)
  Scope → CREATES_SCOPE: body executes in new scope
  CFG → ENTRY_POINT: body is a BlockStatement yielding a completion value
  Note: if async=true, result is wrapped in Promise

ModuleExpression                      [body]
  DFG → TERMINAL: creates a module reference value (proposal)
  Module → DEFINES: inline module definition
  Note: body is a Program node (full module inside an expression)
```

---

### Core JS — Statements

#### Control Flow Statements

```
IfStatement                           [test, consequent, alternate]
  CFG → BRANCHES_TO: test ? consequent : alternate
  DFG → READS: evaluates test expression
  Note: alternate is optional — if absent, falsy test falls through to next statement
  Note: no DFG output — statement, not expression (but test/consequent/alternate contain expressions with DFG)

SwitchStatement                       [discriminant, cases]
  CFG → BRANCHES_TO: discriminant compared to each case test via === → matching case body
  DFG → READS: reads discriminant
  Scope → CREATES_SCOPE: switch body is a single block scope (let/const shared across cases)
  Note: cases without break/return fall through to next case body sequentially

SwitchCase                            [test, consequent]
  CFG → BRANCHES_TO: if test matches discriminant → execute consequent
  CFG → NEXT: falls through to next case if no break
  DFG → READS: reads test expression (null test = default case)

WhileStatement                        [test, body]
  CFG → LOOPS_TO: test ? body → test (repeat) : exit
  DFG → READS: reads test each iteration

DoWhileStatement                      [test, body]
  CFG → LOOPS_TO: body → test ? body (repeat) : exit
  DFG → READS: reads test each iteration
  Note: body always executes at least once

ForStatement                          [init, test, update, body]
  CFG → LOOPS_TO: init → test ? body → update → test : exit
  Scope → CREATES_SCOPE: init scope (for `let`/`const` declarations)
  DFG → READS: reads test, update

ForInStatement                        [left, right, body]
  CFG → LOOPS_TO: for each key in right → assign to left, execute body
  DFG → READS: reads right (object to iterate)
  DFG → WRITES: writes each enumerable string key to left
  Scope → CREATES_SCOPE: iteration scope (for `let`/`const` in left)
  Note: iterates ALL enumerable properties including inherited (prototype chain). Order: integer indices ascending, then string keys in creation order

ForOfStatement                        [left, right, body, await]
  CFG → LOOPS_TO: for each value of right → assign to left, execute body
  DFG → READS: reads right (iterable)
  DFG → WRITES: writes each value to left
  DFG → PROPAGATES: each element of right → left binding
  Call → CALLS: right[Symbol.iterator]() to get iterator, then .next() per iteration
  Scope → CREATES_SCOPE: iteration scope (for `let`/`const` in left)
  Note: `for await...of` — calls right[Symbol.asyncIterator](), awaits each .next() result

LabeledStatement                      [label, body]
  CFG → LABELS: named target for break/continue
  Note: no DFG effect — purely control flow label

BreakStatement                        [label]
  CFG → EXITS_TO: exits enclosing loop/switch (or labeled statement)
  CFG → early_exit: terminates normal block flow

ContinueStatement                     [label]
  CFG → EXITS_TO: jumps to next iteration of enclosing loop
  CFG → early_exit: skips rest of loop body

ReturnStatement                       [argument]
  DFG → READS: reads argument (if present)
  DFG → PROPAGATES: argument → function's return value
  Call → RETURNS: argument value → caller's call expression
  CFG → EXITS_TO: exits function, returns to caller

ThrowStatement                        [argument]
  DFG → READS: reads argument (error object)
  CFG → THROWS: exits normal flow → nearest catch handler
  CFG → EXITS_TO: terminates function execution via exception path
```

#### Exception Handling

```
TryStatement                          [block, handler, finalizer]
  CFG → EXCEPTION_PATH: block (try) → handler (catch) if exception thrown
  CFG → NEXT: block → finalizer (always) → continuation
  CFG → NEXT: handler → finalizer (always) → continuation
  Note: handler and finalizer are each optional (but at least one must be present)
  Note: finalizer always executes regardless of exception or return
  Note: return/throw in finalizer OVERRIDES any return/throw from block or handler

CatchClause                           [param, body]
  Scope → CREATES_SCOPE: new block scope for catch body
  Scope → BINDS: param (error binding) in catch scope (if param present)
  DFG → WRITES: caught exception → param binding (if param present)
  CFG → ENTRY_POINT: entered when exception thrown in try block
  Note: param is optional — `catch { ... }` (ES2019) omits the binding
```

#### Declaration Statements

```
VariableDeclaration                   [kind, declarations]
  Scope → BINDS: each declarator's id bound in scope
  Note: kind (var/let/const) determines scope — var = function, let/const = block
  Note: var — hoisted to function/module top, initialized to undefined before execution
  Note: let/const — TDZ (Temporal Dead Zone) from scope entry until declaration; access before declaration throws ReferenceError

VariableDeclarator                    [id, init]
  DFG → READS: reads init (if present)
  DFG → WRITES: writes init value → id binding
  Scope → BINDS: id bound in enclosing scope
  DFG → PROPAGATES: init → id
  Note: `const x = expr` — expr flows to x

FunctionDeclaration                   [id, params, body, generator, async]
  DFG → TERMINAL: creates function value
  Scope → CREATES_SCOPE: new scope for params and body
  Scope → BINDS: each param bound in function scope; id bound in enclosing scope
  Call → DEFINES: defines a named callable
  CFG → ENTRY_POINT: body is the function entry
  Structure → DEFINES: defines a named callable
  Note: fully hoisted — both binding and value available before declaration in source order (unlike var which hoists only the binding)

ClassDeclaration                      [id, superClass, body, decorators, implements]
  DFG → TERMINAL: creates class value
  DFG → READS: reads superClass expression (if present)
  Scope → CREATES_SCOPE: new scope for class body (id available as const inside body)
  Scope → BINDS: id bound in enclosing scope
  Structure → DEFINES: defines a class (with members from body)
  Structure → EXTENDS: superClass (if present) — inheritance edge
  Type → DECLARES_TYPE: class serves as both value and type
  Type → IMPLEMENTS: interface implementation (if implements present — TS only)
  Note: NOT hoisted — class is in TDZ before declaration (unlike FunctionDeclaration)
  Note: decorators execute bottom-up at class evaluation time
  Note: static members and StaticBlocks initialize in source order during class evaluation

ClassExpression                       [id, superClass, body, decorators, implements]
  DFG → TERMINAL: creates class value (like ClassDeclaration but as expression)
  DFG → READS: reads superClass expression (if present)
  Scope → CREATES_SCOPE: new scope for class body
  Scope → BINDS: optional id only visible inside class body (not in enclosing scope)
  Structure → DEFINES: defines a class
  Structure → EXTENDS: superClass (if present)
  Type → DECLARES_TYPE: class as type
  Note: decorators execute bottom-up at class evaluation time
```

#### Class Members

```
ClassBody                             [body]
  Structure → CONTAINS: holds all class members (methods, properties, static blocks)

ClassMethod                           [kind, key, params, body, static, computed, access]
  Scope → CREATES_SCOPE: new scope for params and body
  Scope → BINDS: params bound in method scope
  CFG → ENTRY_POINT: body is the method entry
  Structure → HAS_MEMBER: parent class has this method
  DFG → READS: reads key expression (if computed)
  Call → DEFINES: defines a callable method
  Note: kind = "constructor" | "method" | "get" | "set"
  Note: get/set — getter called implicitly on property read, setter on property write

ClassPrivateMethod                    [kind, key, params, body, static]
  (same as ClassMethod, but key is PrivateName — accessible only within class)
  Scope → CREATES_SCOPE: new scope for params and body
  Structure → HAS_MEMBER: private member of parent class
  Call → DEFINES: defines a private callable method

ClassProperty                         [key, value, static, computed]
  DFG → READS: reads key expression (if computed)
  DFG → READS: reads value (initializer, if present)
  DFG → WRITES: writes value to property on instance/class
  Structure → HAS_MEMBER: parent class has this property
  Type → HAS_PROPERTY: instance has this typed property
  Note: instance properties initialized in constructor (after super() if subclass); static properties at class evaluation time

ClassPrivateProperty                  [key, value, static]
  (same as ClassProperty, but key is PrivateName)
  DFG → READS: reads value (initializer, if present)
  DFG → WRITES: writes value to private property slot
  Structure → HAS_MEMBER: private member of parent class

ClassAccessorProperty                 [key, value, static, computed]
  DFG → READS: reads value (initializer)
  Structure → HAS_MEMBER: auto-accessor property (auto-generates get/set)
  Note: proposal — `accessor x = 5` generates hidden storage + get/set pair

StaticBlock                           [body]
  CFG → ENTRY_POINT: body executes once at class evaluation time
  Scope → CREATES_SCOPE: new scope for static initialization (has access to class private names)
  DFG → WRITES: can write to static properties during class evaluation
  Note: executes interleaved with static field initializers in source order

PrivateName                           [id]
  (structural — wraps identifier for #name private field access)
  Scope → REFERENCES: refers to class-private binding

Decorator                             [expression]
  DFG → READS: reads expression (decorator function)
  Call → CALLS: decorator function called with decorated target
  DFG → TRANSFORMS: decorated target → possibly wrapped/modified target
  Note: `@log class Foo {}` → log(Foo) or log(Foo) → wrapped Foo
```

#### Module Statements

```
ImportDeclaration                     [source, specifiers, importKind]
  Module → IMPORTS_FROM: current module imports from source module
  Scope → BINDS: each specifier's local name bound in module scope (as immutable)
  DFG → READS: reads exported values from source module
  Note: ES module imports are LIVE BINDINGS — they reflect the exporting module's current value, not a copy. Imported bindings cannot be reassigned by the importer.

ImportSpecifier                       [local, imported, importKind]
  Module → IMPORTS_FROM: imports `imported` name as `local` binding
  DFG → PROPAGATES: source module's export → local binding
  Scope → BINDS: local bound in module scope

ImportDefaultSpecifier                [local]
  Module → IMPORTS_FROM: imports default export as local binding
  DFG → PROPAGATES: source module's default → local binding
  Scope → BINDS: local bound in module scope

ImportNamespaceSpecifier              [local]
  Module → IMPORTS_FROM: imports entire module namespace as local binding
  DFG → PROPAGATES: source module namespace → local binding
  Scope → BINDS: local bound in module scope

ImportAttribute                       [key, value]
  Module → METADATA: import assertion/attribute (e.g., `{ type: "json" }`)
  Note: metadata on import, not a binding

ExportNamedDeclaration                [declaration, specifiers, source, exportKind]
  Module → EXPORTS: exports named bindings from current module
  Module → RE_EXPORTS: if source present — re-exports from another module
  DFG → PROPAGATES: declaration or specifier values → module's export table
  Note: exports are LIVE BINDINGS — importers see updated values when the exporter mutates them

ExportDefaultDeclaration              [declaration, exportKind]
  Module → EXPORTS: exports declaration as default export
  DFG → PROPAGATES: declaration → module's default export

ExportAllDeclaration                  [source, exportKind]
  Module → RE_EXPORTS: all exports from source → current module's exports
  Note: `export * from 'mod'` — namespace re-export

ExportSpecifier                       [local, exported, exportKind]
  Module → EXPORTS: exports local binding as exported name
  DFG → PROPAGATES: local value → exported name

ExportNamespaceSpecifier              [exported]
  Module → RE_EXPORTS: entire source namespace → exported name
  Note: `export * as ns from 'mod'`

ExportDefaultSpecifier                [exported]
  Module → RE_EXPORTS: source default → exported name
```

#### Block & Program Structures

```
Program                               [sourceType, body, directives]
  Scope → CREATES_SCOPE: module/script top-level scope
  CFG → ENTRY_POINT: program entry — execution starts here
  Module → DEFINES: defines the module itself
  Physical → FILE: represents file content

BlockStatement                        [body, directives]
  Scope → CREATES_SCOPE: new block scope (for let/const declarations)
  CFG → NEXT: statements execute sequentially

ExpressionStatement                   [expression]
  CFG → NEXT: sequential flow
  Note: evaluates expression for side effects only — completion value is discarded (no DFG output from the statement itself; the inner expression has its own DFG edges)

EmptyStatement                        []
  (no edges — purely syntactic placeholder)

DebuggerStatement                     []
  CFG → NEXT: pauses execution in debugger (no DFG/Scope effect)

WithStatement                         [object, body]
  Scope → CREATES_SCOPE: extends scope chain with object's properties (dynamic scope injection)
  DFG → READS: reads object
  Note: DEPRECATED and FORBIDDEN in strict mode. Makes static scope analysis UNSOUND for body — any identifier could resolve to a property of object (unknowable at compile time). Every unqualified name in body has an ambiguous binding.

Directive                             [value]
  (metadata — "use strict" etc., no graph edges)

DirectiveLiteral                      [value]
  (structural — string value of directive)

InterpreterDirective                  [value]
  (metadata — `#!/usr/bin/env node`, no graph edges)

File                                  [program]
  Physical → FILE: top-level container
  (structural — wraps Program)

Noop                                  []
  (no edges — placeholder node)
```

---

### JSX

```
JSXElement                            [openingElement, closingElement, children, selfClosing]
  DFG → TRANSFORMS: component function/class + props + children → virtual DOM element
  Call → CALLS: invokes component function (or React.createElement)
  Structure → INSTANTIATES: creates instance of component
  Note: `<Foo bar={1}>` ≈ `Foo({bar: 1, children: ...})` or `createElement(Foo, {bar: 1}, ...)`

JSXFragment                           [openingFragment, closingFragment, children]
  DFG → TRANSFORMS: children → fragment virtual DOM node
  Call → CALLS: invokes React.Fragment (or equivalent)

JSXOpeningElement                     [name, attributes, selfClosing]
  DFG → READS: reads component reference (name)
  Call → CALLS: component identified by name
  Type → INSTANTIATES: component type reference

JSXClosingElement                     [name]
  (structural — no edges, paired with opening)

JSXOpeningFragment                    []
  (structural — fragment delimiter)

JSXClosingFragment                    []
  (structural — fragment delimiter)

JSXAttribute                          [name, value]
  DFG → READS: reads value
  DFG → PROPAGATES: value → component prop
  Call → PASSES_ARGUMENT: value → component parameter (prop)

JSXSpreadAttribute                    [argument]
  DFG → READS: reads argument (object)
  DFG → PROPAGATES: argument properties → component props (spread)
  Call → PASSES_ARGUMENT: spread props → component parameters

JSXExpressionContainer                [expression]
  DFG → PROPAGATES: expression → JSX child or attribute value
  Note: `{expr}` in JSX — wraps any JS expression

JSXSpreadChild                        [expression]
  DFG → READS: reads expression (iterable)
  DFG → PROPAGATES: expression elements → children array

JSXText                               [value]
  DFG → TERMINAL: creates text node value

JSXEmptyExpression                    []
  (no edges — empty `{}` in JSX)

JSXIdentifier                         [name]
  (structural — JSX-specific identifier, resolves to component or HTML tag)
  DFG → READS: reads component binding (if uppercase) or HTML tag name

JSXMemberExpression                   [object, property]
  DFG → READS: reads object, then property — `<Ns.Component />`
  Structure → ACCESS: accesses member of namespace object

JSXNamespacedName                     [namespace, name]
  (structural — `xml:lang` style attribute names, rare in React)
```

---

### TypeScript

#### Type Keywords (Leaf Types)

```
TSAnyKeyword                          []
  Type → DECLARES_TYPE: the `any` type — opts out of type checking
  Type → type_gap: marks a point where type safety is lost

TSUnknownKeyword                      []
  Type → DECLARES_TYPE: the `unknown` type — safe top type, requires narrowing

TSNeverKeyword                        []
  Type → DECLARES_TYPE: the `never` type — uninhabited, marks unreachable code

TSVoidKeyword                         []
  Type → DECLARES_TYPE: the `void` type — function returns nothing

TSNullKeyword                         []
  Type → DECLARES_TYPE: the `null` literal type

TSUndefinedKeyword                    []
  Type → DECLARES_TYPE: the `undefined` literal type

TSBooleanKeyword                      []
  Type → DECLARES_TYPE: the `boolean` type

TSNumberKeyword                       []
  Type → DECLARES_TYPE: the `number` type

TSStringKeyword                       []
  Type → DECLARES_TYPE: the `string` type

TSBigIntKeyword                       []
  Type → DECLARES_TYPE: the `bigint` type

TSSymbolKeyword                       []
  Type → DECLARES_TYPE: the `symbol` type

TSObjectKeyword                       []
  Type → DECLARES_TYPE: the `object` type (non-primitive)

TSIntrinsicKeyword                    []
  Type → DECLARES_TYPE: compiler-internal type (Uppercase, Lowercase, etc.)

TSThisType                            []
  Type → DECLARES_TYPE: the `this` type — polymorphic reference to current class
```

#### Type Constructors (Compound Types)

```
TSArrayType                           [elementType]
  Type → DECLARES_TYPE: Array<elementType> — array of element type
  Type → type_relationship: references elementType

TSUnionType                           [types]
  Type → DECLARES_TYPE: A | B | C — one of several types
  Type → type_relationship: references each member type

TSIntersectionType                    [types]
  Type → DECLARES_TYPE: A & B & C — combination of all types
  Type → type_relationship: references each member type

TSTupleType                           [elementTypes]
  Type → DECLARES_TYPE: [A, B, C] — fixed-length typed array
  Type → type_relationship: references each element type

TSNamedTupleMember                    [label, elementType, optional]
  Type → DECLARES_TYPE: named tuple element — `[name: string, age: number]`

TSOptionalType                        [typeAnnotation]
  Type → DECLARES_TYPE: optional element in tuple

TSRestType                            [typeAnnotation]
  Type → DECLARES_TYPE: rest element in tuple — `[...string[]]`

TSLiteralType                         [literal]
  Type → DECLARES_TYPE: literal type — `"hello"`, `42`, `true`
  Note: literal can be NumericLiteral, StringLiteral, BooleanLiteral, BigIntLiteral, TemplateLiteral, or UnaryExpression(-num)

TSTemplateLiteralType                 [quasis, types]
  Type → DECLARES_TYPE: template literal type — `` `prefix_${string}` ``

TSFunctionType                        [typeParameters, parameters, typeAnnotation]
  Type → DECLARES_TYPE: function type signature — `(a: A) => B`
  Type → type_relationship: param types → return type

TSConstructorType                     [typeParameters, parameters, typeAnnotation, abstract]
  Type → DECLARES_TYPE: constructor type — `new (a: A) => B`
  Type → type_relationship: param types → constructed type

TSMappedType                          [typeParameter, typeAnnotation, nameType, readonly, optional]
  Type → DECLARES_TYPE: mapped type — `{ [K in keyof T]: V }`
  Type → type_relationship: maps over source type
  Note: readonly/optional accept true | false | "+" | "-" for adding/removing modifiers

TSConditionalType                     [checkType, extendsType, trueType, falseType]
  Type → DECLARES_TYPE: conditional type — `T extends U ? A : B`
  Type → type_relationship: conditional relationship between types

TSIndexedAccessType                   [objectType, indexType]
  Type → DECLARES_TYPE: indexed access — `T[K]`
  Type → type_relationship: accesses type at index from object type

TSInferType                           [typeParameter]
  Type → DECLARES_TYPE: inferred type variable in conditional — `infer U`

TSTypeOperator                        [typeAnnotation, operator]
  Type → DECLARES_TYPE: type-level operator — `keyof T`, `unique symbol`, `readonly T[]`

TSParenthesizedType                   [typeAnnotation]
  Type → PROPAGATES: transparent wrapper around type (grouping)

TSTypePredicate                       [parameterName, typeAnnotation, asserts]
  Type → ASSERTS_TYPE: type guard — `x is string` or `asserts x is string`
  CFG → BRANCHES_TO: enables type narrowing in if-else branches
  Note: when `asserts` is true, this is an assertion predicate (`asserts x is T`)
```

#### Type Declarations

```
TSTypeAliasDeclaration                [id, typeAnnotation, typeParameters, declare]
  Type → DECLARES_TYPE: `type X = ...` — named type alias
  Scope → BINDS: id bound in type namespace
  Type → type_relationship: alias → aliased type

TSInterfaceDeclaration                [id, body, typeParameters, extends, declare]
  Type → DECLARES_TYPE: `interface X { ... }` — structural type declaration
  Scope → BINDS: id bound in type namespace
  Structure → DEFINES: defines structural shape (properties, methods)
  Type → EXTENDS: extends other interfaces (if extends present)

TSInterfaceBody                       [body]
  Structure → CONTAINS: holds interface members

TSPropertySignature                   [key, typeAnnotation, computed, optional, readonly, kind]
  Type → HAS_PROPERTY: interface/type literal has this property
  Structure → HAS_MEMBER: property member of type
  Note: kind can be "get" or "set" (optional)

TSMethodSignature                     [key, typeParameters, parameters, typeAnnotation, computed, optional, kind]
  Type → HAS_PROPERTY: interface/type literal has this method
  Structure → HAS_MEMBER: method member of type
  Call → DEFINES: defines callable signature

TSCallSignatureDeclaration            [typeAnnotation, typeParameters, params]
  Type → HAS_PROPERTY: callable signature on interface — `interface Fn { (x: A): B }`
  Call → DEFINES: defines how the type can be called

TSConstructSignatureDeclaration       [typeAnnotation, typeParameters, params]
  Type → HAS_PROPERTY: construct signature — `interface Cls { new(x: A): B }`
  Call → DEFINES: defines how the type can be constructed

TSIndexSignature                      [parameters, typeAnnotation]
  Type → HAS_PROPERTY: index signature — `[key: string]: V`

TSTypeLiteral                         [members]
  Type → DECLARES_TYPE: inline object type — `{ x: number; y: string }`
  Structure → DEFINES: structural shape

TSEnumDeclaration                     [id, body]
  Type → DECLARES_TYPE: enum type
  Scope → BINDS: id bound in both value and type namespace
  Structure → DEFINES: defines enumerated type with members

TSEnumBody                            [members]
  Structure → CONTAINS: holds enum members

TSEnumMember                          [id, initializer]
  DFG → READS: reads initializer (if present)
  Type → HAS_PROPERTY: enum has this member
  Structure → HAS_MEMBER: enum member

TSModuleDeclaration                   [id, body]
  Scope → CREATES_SCOPE: new namespace scope
  Scope → BINDS: id bound in enclosing scope
  Module → DEFINES: namespace/module declaration
  Note: `namespace Foo { }` or `module "foo" { }`

TSModuleBlock                         [body]
  Scope → CREATES_SCOPE: scope for module block contents
```

#### Type Expressions & Assertions

```
TSTypeAnnotation                      [typeAnnotation]
  Type → ANNOTATES: attaches type to a binding/parameter/return

TSTypeReference                       [typeName, typeParameters]
  Type → REFERENCES: refers to a type by name — `Foo`, `Map<K, V>`
  Type → type_relationship: references the declared type

TSExpressionWithTypeArguments         [expression, typeParameters]
  Type → REFERENCES: expression + type args — used in `extends`/`implements`
  Type → INSTANTIATES: instantiates generic type

TSTypeQuery                           [exprName, typeParameters]
  Type → REFERENCES: `typeof x` — type-level query of value's type

TSQualifiedName                       [left, right]
  Type → REFERENCES: qualified type name — `Namespace.Type`

TSTypeParameterDeclaration            [params]
  Type → DECLARES_TYPE: generic type parameters — `<T, U extends V>`
  Scope → BINDS: each type parameter bound in type scope

TSTypeParameter                       [name, constraint, default]
  Type → DECLARES_TYPE: single generic parameter — `T extends Constraint = Default`
  Scope → BINDS: type parameter bound in generic scope
  Type → type_constraint: constraint limits what types can be substituted

TSTypeParameterInstantiation          [params]
  Type → INSTANTIATES: supplies concrete types to generic — `<string, number>`

TSAsExpression                        [expression, typeAnnotation]
  DFG → PROPAGATES: expression → parent (value unchanged at runtime)
  Type → ASSERTS_TYPE: overrides inferred type — `expr as Type`
  Type → type_boundary: assertion may create type gap if incorrect

TSSatisfiesExpression                 [expression, typeAnnotation]
  DFG → PROPAGATES: expression → parent (value unchanged)
  Type → ASSERTS_TYPE: validates type without widening — `expr satisfies Type`
  Note: safer than `as` — doesn't change inferred type, only validates

TSTypeAssertion                       [expression, typeAnnotation]
  DFG → PROPAGATES: expression → parent (value unchanged)
  Type → ASSERTS_TYPE: angle-bracket assertion — `<Type>expr`
  Note: equivalent to `as` but older syntax, not usable in JSX

TSNonNullExpression                   [expression]
  DFG → PROPAGATES: expression → parent (value unchanged)
  Type → ASSERTS_TYPE: removes null/undefined from type — `expr!`
  Type → type_gap: if expr IS null/undefined, this masks the error

TSInstantiationExpression             [expression, typeParameters]
  DFG → PROPAGATES: expression → parent (partially applied generic at type level)
  Type → INSTANTIATES: instantiates generic without calling — `fn<string>`
```

#### TS Module Features

```
TSImportEqualsDeclaration             [id, moduleReference, isExport]
  Module → IMPORTS_FROM: `import X = require("mod")` or `import X = Namespace.Y`
  Scope → BINDS: id bound in module scope
  DFG → PROPAGATES: module reference → id binding

TSExportAssignment                    [expression]
  Module → EXPORTS: `export = expr` — CommonJS-style default export
  DFG → PROPAGATES: expression → module's export

TSNamespaceExportDeclaration          [id]
  Module → EXPORTS: `export as namespace X` — UMD global export

TSExternalModuleReference             [expression]
  Module → REFERENCES: `require("mod")` in import-equals context

TSImportType                          [argument, qualifier, typeParameters]
  Type → REFERENCES: `import("mod").Type` — type-level dynamic import
  Module → IMPORTS_FROM: type-only import reference

TSDeclareFunction                     [id, params, returnType, typeParameters]
  Type → DECLARES_TYPE: ambient function declaration (no body)
  Scope → BINDS: id in enclosing scope
  Call → DEFINES: callable signature only (implementation elsewhere)

TSDeclareMethod                       [key, params, returnType, typeParameters]
  Type → DECLARES_TYPE: ambient method declaration
  Structure → HAS_MEMBER: ambient member
  Call → DEFINES: callable signature only

TSParameterProperty                   [parameter, accessibility, readonly, override]
  Scope → BINDS: constructor parameter that auto-creates class property
  Structure → HAS_MEMBER: auto-created property on class instance
  DFG → PROPAGATES: constructor argument → class property
  Note: `constructor(public x: number)` — x is both param and property
```

---

### Flow

Flow types mirror TypeScript concepts but with Flow-specific syntax. Grouped by correspondence.

#### Flow Type Annotations (parallel to TS keywords)

```
AnyTypeAnnotation                     []
  Type → DECLARES_TYPE: Flow `any` — same as TSAnyKeyword

MixedTypeAnnotation                   []
  Type → DECLARES_TYPE: Flow `mixed` — safe top type (≈ unknown)

EmptyTypeAnnotation                   []
  Type → DECLARES_TYPE: Flow `empty` — uninhabited (≈ never)

VoidTypeAnnotation                    []
  Type → DECLARES_TYPE: Flow `void`

NullLiteralTypeAnnotation             []
  Type → DECLARES_TYPE: Flow `null` literal type

BooleanTypeAnnotation                 []
  Type → DECLARES_TYPE: Flow `boolean`

NumberTypeAnnotation                  []
  Type → DECLARES_TYPE: Flow `number`

StringTypeAnnotation                  []
  Type → DECLARES_TYPE: Flow `string`

SymbolTypeAnnotation                  []
  Type → DECLARES_TYPE: Flow `symbol`

BooleanLiteralTypeAnnotation          [value]
  Type → DECLARES_TYPE: Flow boolean literal type — `true` or `false`

NumberLiteralTypeAnnotation           [value]
  Type → DECLARES_TYPE: Flow number literal type — `42`

StringLiteralTypeAnnotation           [value]
  Type → DECLARES_TYPE: Flow string literal type — `"hello"`

ThisTypeAnnotation                    []
  Type → DECLARES_TYPE: Flow `this` type

ExistsTypeAnnotation                  []
  Type → DECLARES_TYPE: Flow `*` — existential type (inferred)
```

#### Flow Type Constructors

```
ArrayTypeAnnotation                   [elementType]
  Type → DECLARES_TYPE: Flow `Type[]`

UnionTypeAnnotation                   [types]
  Type → DECLARES_TYPE: Flow `A | B`

IntersectionTypeAnnotation            [types]
  Type → DECLARES_TYPE: Flow `A & B`

NullableTypeAnnotation                [typeAnnotation]
  Type → DECLARES_TYPE: Flow `?Type` — nullable

TupleTypeAnnotation                   [types]
  Type → DECLARES_TYPE: Flow `[A, B, C]`

FunctionTypeAnnotation                [params, rest, returnType, typeParameters]
  Type → DECLARES_TYPE: Flow function type `(A, B) => C`

FunctionTypeParam                     [name, typeAnnotation, optional]
  Type → HAS_PROPERTY: parameter in function type

GenericTypeAnnotation                 [id, typeParameters]
  Type → REFERENCES: Flow generic type reference — `Foo<Bar>`

TypeofTypeAnnotation                  [argument]
  Type → REFERENCES: Flow `typeof x` — type-of query

IndexedAccessType                     [objectType, indexType]
  Type → DECLARES_TYPE: Flow `T[K]` — indexed access

OptionalIndexedAccessType             [objectType, indexType, optional]
  Type → DECLARES_TYPE: Flow `T?.[K]` — optional indexed access

InterfaceTypeAnnotation               [extends, body]
  Type → DECLARES_TYPE: inline interface type

ObjectTypeAnnotation                  [properties, indexers, callProperties, internalSlots, exact, inexact]
  Type → DECLARES_TYPE: Flow object type — `{ x: number, y: string }`
  Structure → DEFINES: structural shape

ObjectTypeProperty                    [key, value, optional, static, proto, variance, method, kind]
  Type → HAS_PROPERTY: property in object type

ObjectTypeSpreadProperty              [argument]
  Type → PROPAGATES: spreads properties from argument type

ObjectTypeIndexer                     [id, key, value, static, variance]
  Type → HAS_PROPERTY: indexer in object type — `[key: K]: V`

ObjectTypeCallProperty                [value, static]
  Type → HAS_PROPERTY: call signature in object type
  Call → DEFINES: callable signature

ObjectTypeInternalSlot                [id, value, optional, static, method]
  Type → HAS_PROPERTY: internal slot — `[[Slot]]`

QualifiedTypeIdentifier               [id, qualification]
  Type → REFERENCES: qualified type reference — `Namespace.Type`
```

#### Flow Type Parameters

```
TypeAnnotation                        [typeAnnotation]
  Type → ANNOTATES: Flow type annotation wrapper

TypeParameterDeclaration              [params]
  Type → DECLARES_TYPE: Flow generic params `<T, U>`
  Scope → BINDS: type params in scope

TypeParameter                         [name, bound, default, variance]
  Type → DECLARES_TYPE: Flow single generic param
  Type → type_constraint: bound limits substitution

TypeParameterInstantiation            [params]
  Type → INSTANTIATES: Flow type application `<A, B>`

Variance                              [kind]
  Type → METADATA: `+` (covariant) or `-` (contravariant) marker
```

#### Flow Declarations

```
TypeAlias                             [id, typeParameters, right]
  Type → DECLARES_TYPE: `type X = ...`
  Scope → BINDS: id in type namespace

OpaqueType                            [id, typeParameters, supertype, impltype]
  Type → DECLARES_TYPE: `opaque type X: Super = Impl`
  Scope → BINDS: id in type namespace
  Note: outside module sees supertype; inside sees impltype

InterfaceDeclaration                  [id, typeParameters, extends, body]
  Type → DECLARES_TYPE: Flow `interface X { ... }`
  Scope → BINDS: id in type namespace
  Structure → DEFINES: structural shape
  Type → EXTENDS: extends other interfaces

InterfaceExtends                      [id, typeParameters]
  Type → EXTENDS: interface extension reference

ClassImplements                       [id, typeParameters]
  Type → IMPLEMENTS: class implements interface

DeclareVariable                       [id]
  Type → DECLARES_TYPE: ambient variable — `declare var x: T`
  Scope → BINDS: id in scope

DeclareFunction                       [id, predicate]
  Type → DECLARES_TYPE: ambient function — `declare function f(): T`
  Scope → BINDS: id in scope
  Call → DEFINES: callable signature
  Note: predicate is optional DeclaredPredicate for `%checks`

DeclareClass                          [id, typeParameters, extends, body, implements, mixins]
  Type → DECLARES_TYPE: ambient class
  Scope → BINDS: id in scope
  Structure → DEFINES: class shape

DeclareInterface                      [id, typeParameters, extends, body]
  Type → DECLARES_TYPE: ambient interface
  Scope → BINDS: id in scope

DeclareModule                         [id, body, kind]
  Module → DEFINES: ambient module — `declare module "foo" { ... }`
  Scope → CREATES_SCOPE: module scope
  Note: id can be Identifier or StringLiteral. kind is optional: "CommonJS" | "ES". Purely ambient — no runtime effect, no DFG edges.

DeclareModuleExports                  [typeAnnotation]
  Module → EXPORTS: ambient module export type — `declare module.exports: T`

DeclareExportDeclaration              [declaration, specifiers, source, default, attributes]
  Module → EXPORTS: ambient export

DeclareExportAllDeclaration           [source, exportKind, attributes]
  Module → RE_EXPORTS: ambient re-export all
  Note: exportKind is optional: "type" | "value"

DeclareTypeAlias                      [id, typeParameters, right]
  Type → DECLARES_TYPE: ambient type alias

DeclareOpaqueType                     [id, typeParameters, supertype, impltype]
  Type → DECLARES_TYPE: ambient opaque type
  Note: impltype is optional in Babel AST but typically absent in ambient declarations

DeclaredPredicate                     [value]
  Type → ASSERTS_TYPE: declared type predicate — `%checks`

InferredPredicate                     []
  Type → ASSERTS_TYPE: inferred type predicate
```

#### Flow Enums

```
EnumDeclaration                       [id, body]
  Type → DECLARES_TYPE: Flow enum
  Scope → BINDS: id in both value and type namespace
  Structure → DEFINES: enumerated type
  DFG → WRITES: creates runtime enum object bound to id
  Note: Flow enums have runtime representation via `flow-enums-runtime` — frozen objects created with Object.create(null). NOT erased at build time.

EnumBooleanBody                       [members, explicitType, hasUnknownMembers]
  Structure → CONTAINS: enum body with boolean-typed members

EnumNumberBody                        [members, explicitType, hasUnknownMembers]
  Structure → CONTAINS: enum body with number-typed members

EnumStringBody                        [members, explicitType, hasUnknownMembers]
  Structure → CONTAINS: enum body with string-typed members
  Note: accepts both EnumStringMember and EnumDefaultedMember

EnumSymbolBody                        [members, hasUnknownMembers]
  Structure → CONTAINS: enum body with symbol-typed members
  Note: NO explicitType field — symbol enums are always implicitly typed. Members are always EnumDefaultedMember.

EnumBooleanMember                     [id, init]
  Type → HAS_PROPERTY: enum member
  Structure → HAS_MEMBER: named enum member
  DFG → WRITES: init (BooleanLiteral) value flows into enum member

EnumNumberMember                      [id, init]
  Type → HAS_PROPERTY: enum member
  Structure → HAS_MEMBER: named enum member
  DFG → WRITES: init (NumericLiteral) value flows into enum member

EnumStringMember                      [id, init]
  Type → HAS_PROPERTY: enum member
  Structure → HAS_MEMBER: named enum member
  DFG → WRITES: init (StringLiteral) value flows into enum member

EnumDefaultedMember                   [id]
  Type → HAS_PROPERTY: enum member
  Structure → HAS_MEMBER: named enum member
  Note: no init field — value is implicitly derived from member name/position
```

---

### Uncategorized / Structural

```
ArgumentPlaceholder                   []
  (proposal — placeholder in partial application, no edges yet)

V8IntrinsicIdentifier                 [name]
  Call → CALLS: V8-internal function call — `%DebugPrint(x)`
  Note: not standard JS — V8 engine internals only

Placeholder                           [expectedNode]
  (Babel internal — template placeholder, no semantic edges)
```

---

## Completeness Summary

| Category | Types | Covered | Notes |
|----------|-------|---------|-------|
| Core JS Expressions | 52 | 52 | All expressions mapped |
| Core JS Statements | 47 | 47 | All statements mapped |
| Patterns | 5 | 5 | Including VoidPattern (proposal) |
| Class Members | 8 | 8 | Including accessor, static block |
| Module Specifiers | 6 | 6 | All import/export specifiers |
| Literals | 8 | 8 | All literal types |
| JSX | 15 | 15 | All JSX nodes mapped |
| TypeScript | 67 | 67 | All TS nodes mapped |
| Flow — Types | 48 | 48 | All Flow type annotations |
| Flow — Declarations | 12 | 12 | Declare*, TypeAlias, OpaqueType, Interface |
| Flow — Enums | 10 | 10 | Bodies and members disaggregated |
| Structural/Other | 4 | 4 | Noop, File, Placeholder, ArgumentPlaceholder |
| **Total** | **253** | **253** | |

## Entity Count: 37

Entities in this projection (from lens analysis):
- DFG: read, write, transform, propagation, mutation (5)
- CFG: entry_point, exit_point, branch, loop, exception_path, early_exit (6)
- Scope: binding, closure, shadow (3)
- Call: call_site, callee, argument (3)
- Module: import, export, re-export, dynamic_import (4)
- Structure: class, method, property, inheritance, composition (5)
- Type: type_declaration, type_constraint, type_relationship, type_boundary, type_gap (5)
- Physical: file, directory, package, repository, registry (5)
- **Edge types: 42** (from Edge Types Legend, grouped by lens)
