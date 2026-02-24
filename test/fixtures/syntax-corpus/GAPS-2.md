# Syntax Corpus — Gaps Round 2

Reviewed all 24 source files + GAPS.md. Focus: constructs missing from BOTH
the corpus files AND the existing gaps list.

---

## A. Scope & Resolution Gaps

### A1. `with` statement (sloppy mode)
**Production: 2/5** — legacy code only, but Grafema's stated target.

```js
// .cjs or non-strict script — NOT valid in ESM
function renderTemplate(data) {
  with (data) {
    return `${name} is ${age} years old`;
    // name and age — from data? or from enclosing scope? unknowable statically
  }
}

// Nested with:
with (defaults) {
  with (overrides) {
    use(color); // overrides.color ?? defaults.color ?? outer color
  }
}
```

**Graph impact:** `with` makes static scope analysis **impossible** for the block body. Every unqualified identifier inside `with` could resolve to either: (a) a property of the `with` object, or (b) a variable in the enclosing scope. The graph cannot create correct READS/WRITES edges without runtime knowledge of the object's properties. This is the single most destructive construct for static analysis — any function containing `with` should be marked as having **unresolvable scope**. The analyzer must at minimum detect `with` and degrade gracefully (flag all identifier resolution inside as UNRESOLVED).

### A2. `super` in static methods and static fields
**Production: 4/5** — common in factory patterns and ORM base classes.

```js
class Parent {
  static defaultConfig() { return { timeout: 5000 }; }
  static instances = [];
}

class Child extends Parent {
  static defaultConfig() {
    const base = super.defaultConfig();       // super = Parent (the constructor)
    return { ...base, retries: 3 };
  }

  static instances = [...super.instances];    // super in static field initializer

  static {
    super.instances.push('child-registered'); // super in static block
  }
}
```

**Graph impact:** The corpus has `super.method()` in instance methods and nested arrows, but NOT in static context. In static methods, `super` refers to the **parent class constructor** (not `.prototype`). The CALLS edge from `Child.defaultConfig()` should point to `Parent.defaultConfig()` (static method on parent), not `Parent.prototype.defaultConfig`. If the analyzer always resolves `super` through `.prototype`, static super calls resolve to the wrong target — or nowhere.

### A3. `typeof` on TDZ variable vs undeclared variable
**Production: 3/5** — defensive programming patterns.

```js
function safe() {
  console.log(typeof neverDeclared); // "undefined" — safe, no error
}

function unsafe() {
  console.log(typeof x); // ReferenceError! x is in TDZ
  let x = 5;
}

// This distinction matters for guards:
function checkFeature() {
  if (typeof Symbol !== 'undefined') { // safe guard for undeclared
    // ...
  }
}

// But this is a trap:
{
  if (typeof myLocal !== 'undefined') { // THROWS — myLocal in TDZ
    // unreachable
  }
  const myLocal = init();
}
```

**Graph impact:** The corpus has `typeof-undeclared` (safe case) but NOT the TDZ interaction. The graph models `typeof x` as a non-throwing guard, but if `x` is a `let`/`const` in TDZ, it throws. For scope guard analysis, the graph must distinguish: `typeof` on undeclared = safe guard (creates GUARD edge), `typeof` on TDZ = potential throw (creates THROWS edge). Without this, the graph's control flow for `typeof` guards is incorrect in TDZ contexts.

### A4. `eval('let x = 5')` vs `eval('var x = 5')` — scope difference
**Production: 2/5** — rare, but `eval` is Grafema's target territory.

```js
function demo() {
  eval('var x = 1');  // x leaks to function scope
  console.log(x);    // 1 — covered in corpus ✓

  eval('let y = 2'); // y is block-scoped to the EVAL itself
  console.log(y);    // ReferenceError — y doesn't exist here!

  eval('function f() { return 3; }'); // covered ✓
  eval('class C {}');                  // C is block-scoped to eval
  console.log(typeof C);              // "undefined"
}
```

**Graph impact:** The corpus covers `eval('var x')` injection but not the asymmetry with `let`/`const`/`class` inside eval. These are block-scoped to the eval call itself and DON'T leak to the function scope. If the graph treats all eval-declared bindings as function-scoped, it will create false VARIABLE nodes in the enclosing function for `let` and `class` declarations.

---

## B. Expression & Statement Gaps

### B1. `yield` in exotic expression positions (generators)
**Production: 3/5** — state machines, coroutine protocols.

```js
function* exoticYield() {
  // yield as function argument
  console.log(yield 'prompt');          // yields 'prompt', logs .next(val)

  // yield of yield (chained)
  const doubled = yield (yield 'first') * 2;

  // yield in array literal
  const pair = [yield 'a', yield 'b'];  // two suspension points in one expression

  // yield in template literal
  const msg = `Hello ${yield 'name'}!`;

  // yield in ternary
  const val = (yield 'check') ? (yield 'yes') : (yield 'no');

  // yield in object literal value
  const obj = { x: yield 'x', y: yield 'y' };

  // yield as computed property key
  const dynamic = { [yield 'key']: yield 'value' };
}
```

**Graph impact:** The corpus has `yield` in statement position (`yield 1;`) and as assignment source (`const value = yield total;`), but NOT yield as an argument, as an array element, in template interpolation, or as a computed key. Each of these creates a **suspension point** mid-expression — the evaluation pauses, resumes with `.next(val)`, and the yielded-then-received value flows into the surrounding expression. For the graph, each `yield` in expression position creates a YIELDS edge (outgoing data) AND an RECEIVES edge (incoming data from `.next()`), with the **same node** participating in both flows. If the analyzer only handles yield-as-statement, all these expression-position yields are invisible.

### B2. Anonymous export defaults
**Production: 5/5** — extremely common, especially `export default function(){}`.

```js
// Anonymous function default export — IS hoisted (FunctionDeclaration)
export default function() {
  return 'anonymous but hoisted';
}

// Anonymous class default export — NOT hoisted (ClassExpression)
export default class {
  run() { return 'anonymous class'; }
}

// Expression default export — NOT hoisted
export default [1, 2, 3];
export default { key: 'value' };
export default 42;
export default someVariable;
```

**Graph impact:** `modules-helpers.js` has `export default function defaultHelper()` (named) but anonymous defaults only as comments. The AST differs: anonymous `export default function(){}` is a `FunctionDeclaration` with `id: null` — it's hoisted but has no name binding in the module scope. Anonymous `export default class {}` is a `ClassExpression`. The graph must handle: (a) FUNCTION node with no name (or synthetic name `default`), (b) EXPORTS edge from module to this anonymous function, (c) correct hoisting behavior (function yes, class no, expression no). Currently the corpus doesn't exercise any of these AST forms.

### B3. `for...in` with destructuring pattern
**Production: 1/5** — extremely rare but valid.

```js
// Destructures the property NAME (a string)
for (const { length } in { abc: 1, de: 2, f: 3 }) {
  console.log(length); // 3, 2, 1 — string length of each key
}

// With renaming
for (const { 0: firstChar } in { abc: 1, xy: 2 }) {
  console.log(firstChar); // 'a', 'x' — first char of each key
}
```

**Graph impact:** `for...in` yields string keys. Destructuring those strings as objects uses String's properties (length, indexed chars). The graph must model that the destructuring target is a `String` primitive (auto-boxed), not the object being iterated. If the analyzer treats `for...in` destructuring like `for...of` destructuring, it will try to destructure the object's values instead of its keys.

### B4. Computed property that throws — evaluation order
**Production: 3/5** — occurs when computed keys depend on external state.

```js
function computedThrows() {
  let log = [];
  try {
    const obj = {
      [log.push('a')]: 'first',
      [throwingFn()]:   'second',    // throws here
      [log.push('c')]: 'third',     // NEVER evaluated
    };
  } catch (e) {}
  return log; // ['a'] — 'c' was never pushed
}

// Same applies to class fields:
class C {
  [sideEffect1()] = 'a';
  [sideEffect2()] = 'b';   // if this throws, fields below are not initialized
  [sideEffect3()] = 'c';
}
```

**Graph impact:** Computed property keys evaluate **left-to-right, top-to-bottom**. If one throws, subsequent keys and values are never evaluated. The corpus has `computed-key-side-effect` which demonstrates the ordering, but not the **early termination** case. The graph must model that later computed members have a control-flow dependency on earlier ones — a throw in key N prevents key N+1 from creating its node.

### B5. Optional chaining assignment is a SyntaxError
**Production: 0/5** — but important as a negative case for parsers.

```js
obj?.prop = value;      // SyntaxError — cannot assign through ?.
obj?.['key'] = value;   // SyntaxError
arr?.[0] = value;       // SyntaxError

// Also: super doesn't support optional chaining
super?.method();        // SyntaxError

// And: tagged templates don't support optional chaining
obj?.tag`template`;     // SyntaxError (mentioned in GAPS H3)
```

**Graph impact:** These are **parser-level rejections** — they never appear in valid AST. The graph doesn't need to model them. However, documenting them helps validate that the analyzer's parser correctly rejects these forms. If the parser silently accepts `obj?.prop = value`, it would create a malformed PROPERTY_MUTATION edge.

### B6. Nullish coalescing mixed with logical AND/OR
**Production: 4/5** — common mistake, important error case.

```js
// SyntaxError — cannot mix ?? with || or && without parens
a ?? b || c;    // SyntaxError
a || b ?? c;    // SyntaxError
a ?? b && c;    // SyntaxError

// Must use explicit parens:
(a ?? b) || c;  // OK — nullish-coalesce first, then OR
a ?? (b || c);  // OK — OR first, then nullish-coalesce
(a ?? b) && c;  // OK
```

**Graph impact:** This is a **parser constraint**, not a runtime behavior. The analyzer's parser must reject bare `??` mixed with `||`/`&&`. If the parser accepts it (some lenient parsers do), the resulting AST will have incorrect precedence, leading to wrong data flow edges. The corpus has `nullish-coalescing-chain` (multiple `??`) but not the interaction with `||`/`&&`.

---

## C. Class & Inheritance Gaps

### C1. `super.method()` in class field initializers
**Production: 3/5** — initialization from parent behavior.

```js
class Parent {
  getDefaults() { return { timeout: 5000 }; }
  static registry = new Map();
}

class Child extends Parent {
  // super in instance field initializer — calls parent method
  defaults = super.getDefaults();

  // super in static field initializer — calls parent static method
  static allRegistered = super.registry.size;
}
```

**Graph impact:** `super` in field initializers resolves like `super` in the constructor (for instance fields) or like `super` in static methods (for static fields). The corpus has `this.a * 2` in field initializers but NOT `super.method()`. The graph must create a CALLS edge from the field initializer to `Parent.getDefaults()` — but field initializers aren't named functions, so the edge source must be the field node itself or a synthetic initializer scope.

### C2. Multiple interleaved static blocks and static fields
**Production: 3/5** — complex initialization sequences.

```js
class Config {
  static debug = false;

  static {
    if (process.env.DEBUG) Config.debug = true;
  }

  static logLevel = Config.debug ? 'verbose' : 'error';
  //                ^^^^^ depends on static block above

  static {
    console.log(`Config initialized: debug=${Config.debug}, level=${Config.logLevel}`);
  }

  static cache = Config.debug ? new Map() : null;
}
```

**Graph impact:** Static fields and static blocks evaluate **top-to-bottom** in declaration order. The corpus has a single static block. But when MULTIPLE static blocks are interleaved with static fields, the evaluation order creates **data flow dependencies between them**: `logLevel` depends on `debug` which is modified by the first static block. The graph must model the sequential evaluation: static block 1 → `logLevel` field → static block 2 → `cache` field. If the graph treats all static fields as independent, the data flow from `debug` (mutated in block) to `logLevel` (uses `Config.debug`) is invisible.

### C3. Private field + Proxy incompatibility
**Production: 3/5** — DI containers, testing mocks, ORM proxies.

```js
class Secure {
  #secret = 42;
  getSecret() { return this.#secret; }
}

const instance = new Secure();
const proxy = new Proxy(instance, {});

instance.getSecret();  // 42 — works
proxy.getSecret();     // TypeError: Cannot read private member #secret
                       // from an object whose class did not declare it
```

**Graph impact:** Private fields check the object's **internal slot**, not the prototype chain. A Proxy wrapper doesn't have the internal slot — so calling any method that accesses private fields through a Proxy ALWAYS throws. The graph must model that: if a CALLS edge goes through a Proxy-wrapped object to a method that accesses `#fields`, the call will fail. This is critical for DI containers and test mocking frameworks that wrap classes in Proxies.

---

## D. Generator & Async Interaction Gaps

### D1. `yield yield` — chained yield expressions
**Production: 2/5** — coroutine protocols, parser edge case.

```js
function* chained() {
  // Parsed as: yield (yield 1)
  const result = yield yield 1;
  // Step 1: yields 1, suspends
  // Step 2: .next(x) resumes, yields x, suspends
  // Step 3: .next(y) resumes, result = y
}

const g = chained();
g.next();     // { value: 1, done: false }
g.next('a');  // { value: 'a', done: false }
g.next('b');  // { value: undefined, done: true } — result === 'b'
```

**Graph impact:** `yield yield expr` creates TWO suspension points in one expression. The inner `yield 1` produces a value, the outer `yield` produces the value received from the first `.next()` call. The graph needs two YIELDS edges and two RECEIVES edges from a single expression. If the parser/analyzer treats `yield yield` as a single yield, it misses a suspension point.

### D2. `async` destructuring default with `await`
**Production: 4/5** — API handlers, config loading.

```js
// await in destructuring default — valid in async function params
const handler = async ({
  timeout = await getConfig('timeout'),
  retries = await getConfig('retries'),
} = {}) => {
  return { timeout, retries };
};

// Also valid in async function body:
async function process(opts) {
  const {
    data,
    transform = await loadDefaultTransform()
  } = opts;
}
```

**Graph impact:** `await` inside destructuring defaults creates async suspension during parameter/variable binding. The graph must model that: (a) the default value expressions are async — AWAITS edge to `getConfig`, (b) evaluation order matters — if `timeout` default throws, `retries` default never evaluates, (c) the outer `= {}` default is evaluated FIRST (synchronously), then inner property defaults (potentially async). The corpus has `async-generator-destructure-default` but that's in a `for await` context — not in parameter defaults.

---

## E. Module System Gaps

### E1. `import.meta.resolve()` (ES2025)
**Production: 3/5** — growing usage in ESM-native code.

```js
// Resolve a module specifier to a URL without importing
const workerUrl = import.meta.resolve('./worker.js');
const polyfillUrl = import.meta.resolve('core-js/stable');

// Dynamic usage
async function loadOptional(specifier) {
  try {
    const url = import.meta.resolve(specifier);
    return await import(url);
  } catch {
    return null; // module not found
  }
}
```

**Graph impact:** `import.meta.resolve()` creates a **module dependency** without actually importing. The corpus has `import.meta.url` (module's own URL) but not `.resolve()` (resolve another module's URL). For the dependency graph, `import.meta.resolve('./worker.js')` indicates that the module KNOWS ABOUT `./worker.js` — a weaker-than-import relationship but still a dependency. Without this, the graph misses file relationships created through resolve-based patterns.

### E2. Export default — anonymous forms actually exercised
**Production: 5/5** — `export default function(){}` is extremely common.

The corpus has `export default function defaultHelper()` (named) in `modules-helpers.js`, and anonymous forms are mentioned in comments. But the anonymous AST forms are never exercised:

```js
// These produce different AST nodes than named defaults:
export default function() { return 1; }   // FunctionDeclaration, id: null, hoisted
export default class { run() {} }          // ClassExpression, id: null, NOT hoisted
export default [1, 2, 3];                  // ExportDefaultDeclaration > ArrayExpression
export default someExistingVar;            // ExportDefaultDeclaration > Identifier
```

**Graph impact:** Anonymous `export default function(){}` is a FunctionDeclaration with `id: null` — unique in JS syntax (normally FunctionDeclaration requires a name). The graph must handle a FUNCTION node with no name (or synthesize `"default"` as the name). Anonymous `export default class {}` is even trickier — it's a ClassExpression (not ClassDeclaration), so no hoisting. If the analyzer only handles named exports, anonymous defaults produce no FUNCTION/CLASS nodes.

---

## F. TypeScript-Specific Gaps

### F1. `infer` with constraints (TS 4.7+)
**Production: 4/5** — utility types, framework type inference.

```ts
// Basic infer — covered ✓
type UnpackPromise<T> = T extends Promise<infer U> ? U : T;

// Constrained infer — NOT covered
type FirstString<T> = T extends [infer S extends string, ...unknown[]] ? S : never;
type NumericKeys<T> = { [K in keyof T as K extends `${infer N extends number}` ? K : never]: T[K] };

// Multiple constrained infers
type ParsePair<T> = T extends `${infer A extends number},${infer B extends number}`
  ? [A, B]
  : never;
```

**Graph impact:** `infer U extends string` constrains the inferred type variable. Without modeling the constraint, the graph treats `U` as `unknown` — losing type information that narrows property access resolution. For graph analysis: if `U` is constrained to `string`, then property access on values typed as `U` should resolve against `String.prototype`. The corpus has basic `infer` but not the constrained form.

### F2. Inline `import()` type expressions
**Production: 5/5** — `.d.ts` files, JSDoc, cross-module type references.

```ts
// Type-level import() — no runtime import, just type reference
type Config = import('./config').AppConfig;
type Logger = import('winston').Logger;

// In function signatures
function handle(req: import('express').Request): import('express').Response {
  // ...
}

// In JSDoc (already partially in jsdoc-types.js but not this form)
/** @type {import('./types').UserRecord} */
const user = getUser();

// Generic with import()
type Promisified<T extends keyof import('./api')> = Promise<import('./api')[T]>;
```

**Graph impact:** `import('./config').AppConfig` creates a TYPE-LEVEL module dependency — no runtime import, but the dependency graph should include it. These appear everywhere in `.d.ts` files and JSDoc. For the graph, each `import()` type expression should create a DEPENDS_ON edge (type-only) from the current module to the referenced module. Without this, the dependency graph is incomplete for TypeScript projects that use this pattern heavily.

### F3. TypeScript `using` with type annotations
**Production: 3/5** — growing with TC39 Explicit Resource Management.

```ts
using handle: FileHandle = openFile('/tmp/data');
await using conn: DBConnection = await pool.connect();

// In for loops
for (using reader: Reader of getReaders()) {
  reader.process();
}

// Combined with destructuring
using { stream, cleanup }: DisposableStream = createStream();
```

**Graph impact:** The corpus has `using` declarations in `modern-es.js` but in plain JS (no type annotations). TypeScript adds type annotations to `using`, which the graph must parse to create typed VARIABLE nodes. If the analyzer's TS parser doesn't handle `using handle: Type = expr`, it may fail to parse the declaration entirely.

### F4. `satisfies` operator interactions
**Production: 4/5** — config objects, theme definitions.

```ts
// Basic satisfies — covered ✓
const theme = { primary: '#007bff' } satisfies Record<string, string>;

// satisfies + as const (common combo)
const routes = {
  home: '/',
  about: '/about',
  user: '/user/:id',
} as const satisfies Record<string, string>;

// satisfies in complex expressions
const config = (process.env.NODE_ENV === 'production'
  ? { debug: false, logLevel: 'error' }
  : { debug: true, logLevel: 'verbose' }
) satisfies AppConfig;

// satisfies preserves narrowed type while checking assignability
const palette = {
  red: [255, 0, 0],
  green: '#00ff00',  // ERROR if satisfies Record<string, number[]>
} satisfies Record<string, string | number[]>;
```

**Graph impact:** The corpus has basic `satisfies` but NOT the `as const satisfies` combo or `satisfies` on complex expressions. `as const satisfies T` narrows the type to a literal while also validating against `T`. For the graph, this means the VARIABLE node should have BOTH the literal type (from `as const`) AND the constraint type (from `satisfies`). If only one is modeled, property access resolution may use the wrong type.

---

## G. Cross-Cutting Interaction Gaps

### G1. WeakRef and FinalizationRegistry
**Production: 3/5** — caches, resource management, large object tracking.

```js
// WeakRef — reference that doesn't prevent GC
const cache = new Map();
function getCached(key, factory) {
  const ref = cache.get(key);
  const cached = ref?.deref();   // may return undefined if GC'd
  if (cached) return cached;

  const fresh = factory();
  cache.set(key, new WeakRef(fresh));
  return fresh;
}

// FinalizationRegistry — callback when object is GC'd
const registry = new FinalizationRegistry((heldValue) => {
  cache.delete(heldValue);       // cleanup when object is collected
});

function track(key, obj) {
  registry.register(obj, key);   // register for finalization
}
```

**Graph impact:** `WeakRef` creates a reference that the graph must model differently from regular references — it does NOT keep the target alive. `obj.deref()` may return `undefined` at any point (non-deterministic). For data flow analysis, a WeakRef chain is UNRELIABLE — the graph should annotate these edges as WEAK_REFERENCE. `FinalizationRegistry` creates a callback edge that fires at an unpredictable time. Both are important for understanding cache patterns and resource lifecycle in production code.

### G2. Proxy wrapping a class constructor
**Production: 3/5** — DI containers, ORM models, testing.

```js
class Original {
  constructor(name) { this.name = name; }
  greet() { return `Hi, ${this.name}`; }
}

// Proxy intercepts construction
const Tracked = new Proxy(Original, {
  construct(target, args, newTarget) {
    console.log(`Creating ${target.name} with`, args);
    return Reflect.construct(target, args, newTarget);
  },
  get(target, prop, receiver) {
    if (prop === 'create') {
      return (...args) => new Tracked(...args);
    }
    return Reflect.get(target, prop, receiver);
  },
});

const instance = new Tracked('Alice');  // goes through construct trap
instance.greet();                        // 'Hi, Alice'
instance instanceof Original;           // true
```

**Graph impact:** `new Tracked(...)` looks like `new SomeClass(...)` in the AST. But `Tracked` is a Proxy — the graph sees an INSTANCE_OF edge to... what? The Proxy itself has no class body. The graph must trace through the Proxy to find that the actual class is `Original`. Without this, the INSTANCE_OF edge points to a VARIABLE (the Proxy), not a CLASS. Combined with the C3 gap (private fields break through Proxy), this creates a complete blindspot for Proxy-wrapped classes.

### G3. `arguments` and rest parameters coexistence
**Production: 3/5** — migration-era code, backwards compatibility.

```js
function mixed(first, ...rest) {
  console.log(arguments.length); // ALL args count (first + rest)
  console.log(arguments[0]);     // same as `first`
  console.log(arguments[1]);     // rest[0], but through different view
  console.log(rest);             // only the rest portion

  // arguments includes ALL args; rest is a subset
  // They provide DIFFERENT views of the same data
  arguments[0] = 'modified';
  console.log(first);            // 'modified' in sloppy, unchanged in strict
}
```

**Graph impact:** The corpus covers `arguments` separately (aliasing.js) and rest parameters separately (declarations.js), but not their coexistence in the same function. The graph must model: `arguments` contains ALL arguments (including those matched by named params), while `rest` is a true Array containing only the unmatched ones. Two VARIABLE nodes (`arguments`, `rest`) provide overlapping views of the same data — modifying `arguments[1]` in sloppy mode affects the same value as `rest[0]`.

### G4. Object/array literal in statement position (block/label ambiguity)
**Production: 2/5** — copy-paste errors, REPL confusion.

```js
// This is NOT an object literal — it's a block with a labeled expression statement:
{ a: 1 }
// Parsed as: Block { LabeledStatement { label: 'a', body: ExpressionStatement(1) } }

// This IS an object literal (in expression position):
const obj = { a: 1 };
({ a: 1 });           // parenthesized expression statement

// Real-world trap — eval returns wrong thing:
eval('{ a: 1, b: 2 }');  // SyntaxError — parsed as block, comma is illegal after label
eval('({ a: 1, b: 2 })'); // { a: 1, b: 2 } — forced into expression context

// Also: array in statement position is always an expression:
[1, 2, 3]; // ExpressionStatement > ArrayExpression — unambiguous
```

**Graph impact:** This is a parser-level ambiguity. If the graph's source is a parser that correctly handles statement-vs-expression context, this shouldn't be an issue. But if code is analyzed as fragments (e.g., from templates or eval strings), `{ a: 1 }` might be misparsed as an object literal when it's actually a block+label. The graph would create a phantom ObjectExpression node with a property `a` when it should create a LabeledStatement.

---

## H. Delete & Mutation Gaps

### H1. `delete` on computed properties and other exotic targets
**Production: 4/5** — cache eviction, object cleanup.

```js
function dynamicDelete(obj, key) {
  delete obj[key];              // computed delete — property name unknown at parse time
  delete obj[getKey()];         // delete with side-effect in key expression
}

function deleteFromArray(arr, idx) {
  delete arr[idx];              // creates a HOLE, doesn't shift — arr.length unchanged
}

// delete on a variable — sloppy mode only
var globalVar = 1;
delete globalVar;               // true in sloppy global scope — actually deletes!
// In strict mode: SyntaxError

// delete always returns true for non-configurable misses:
delete {}.nonexistent;          // true — property didn't exist
delete Object.freeze({a:1}).a;  // false (or throws in strict) — non-configurable
```

**Graph impact:** The corpus has `delete obj.a` (dot notation, known property) and `optionalChainingDelete`. But `delete obj[key]` with computed key is much more common and harder for the graph — the deleted property is unknown at parse time. The graph must create a PROPERTY_MUTATION (deletion) edge where the property name is UNRESOLVED. For `delete arr[idx]`, the graph should model that this creates a sparse array (different from `splice`). For `delete variable`, the graph must know this only works in sloppy mode on global-scope vars.

---

## I. Miscellaneous Missing Constructs

### I1. Class expression in various expression positions
**Production: 2/5** — metaprogramming, testing utilities.

```js
// Class in array — creates a tuple of classes
const handlers = [
  class GetHandler { handle() {} },
  class PostHandler { handle() {} },
];

// Class in ternary
const Strategy = condition
  ? class Aggressive { execute() {} }
  : class Conservative { execute() {} };

// Class in function argument
register(class InlinePlugin {
  activate() {}
});

// Immediately instantiated class expression
const singleton = new (class {
  #instance;
  constructor() { this.#instance = this; }
})();
```

**Graph impact:** The corpus has inline-new class expressions (`class-inline-new`, `class-inline-extends`). But class expressions in arrays, ternaries, and as function arguments are NOT covered. Each creates a CLASS node that exists in a different scope context. In the array case, two CLASS nodes are siblings. In the ternary case, only one CLASS is ever instantiated (conditional). The graph must create proper scope containment for these ephemeral class definitions.

### I2. Function expression in exotic positions
**Production: 3/5** — callback arrays, strategy patterns.

```js
// Array of named function expressions
const middleware = [
  function auth(req) { return req.user; },
  function validate(req) { return req.body; },
  function handle(req) { return 'ok'; },
];

// Named function expression in ternary
const processor = isAsync
  ? function asyncProcess() { /* ... */ }
  : function syncProcess() { /* ... */ };

// Named function expression as argument (not just arrow)
setTimeout(function retry() {
  if (!done) setTimeout(retry, 1000); // self-reference for retry
}, 1000);
```

**Graph impact:** The corpus has function expressions assigned to variables (`func-expr-named`, `func-expr-anonymous`) but not in arrays, ternaries, or as arguments with self-reference. The `retry` example is particularly important: the named function expression `retry` can reference itself inside `setTimeout` — this creates a CALLS edge from `retry` to `setTimeout` AND from the `setTimeout` callback back to `retry` (recursive self-scheduling). If the analyzer doesn't handle named function expressions as arguments, this recursion loop is invisible.

---

## Summary Table

| Gap | Category | Production | Graph Impact |
|-----|----------|-----------|-------------|
| A1. `with` statement | Scope | 2/5 | CRITICAL — scope unresolvable |
| A2. `super` in static context | Scope | 4/5 | HIGH — wrong resolution target |
| A3. `typeof` on TDZ variable | Scope | 3/5 | MEDIUM — incorrect guard modeling |
| A4. `eval('let x')` scope | Scope | 2/5 | LOW — false variable injection |
| B1. `yield` in expression positions | Expression | 3/5 | HIGH — missed suspension points |
| B2. Anonymous export defaults | Module | 5/5 | HIGH — no FUNCTION/CLASS node |
| B3. `for...in` with destructuring | Statement | 1/5 | LOW — wrong destructure target |
| B4. Computed property throws | Expression | 3/5 | MEDIUM — evaluation order |
| B6. `??` + `||`/`&&` SyntaxError | Expression | 4/5 | LOW — parser validation |
| C1. `super` in field initializers | Class | 3/5 | MEDIUM — missed CALLS edge |
| C2. Interleaved static blocks | Class | 3/5 | MEDIUM — data flow order |
| C3. Private + Proxy incompatibility | Class | 3/5 | HIGH — proxy wrapping breaks |
| D1. `yield yield` chained | Generator | 2/5 | MEDIUM — missed suspension |
| D2. `async` destructuring `await` | Async | 4/5 | HIGH — missed AWAITS edges |
| E1. `import.meta.resolve()` | Module | 3/5 | MEDIUM — missed dependency |
| E2. Anonymous export default forms | Module | 5/5 | HIGH — no node created |
| F1. `infer` with constraints | TypeScript | 4/5 | MEDIUM — weaker type info |
| F2. Inline `import()` type | TypeScript | 5/5 | HIGH — missed type dependency |
| F3. TS `using` with types | TypeScript | 3/5 | LOW — parse failure |
| F4. `satisfies` + `as const` | TypeScript | 4/5 | MEDIUM — wrong type |
| G1. WeakRef / FinalizationRegistry | Reference | 3/5 | MEDIUM — weak reference |
| G2. Proxy wrapping class | Proxy | 3/5 | HIGH — lost INSTANCE_OF |
| G3. `arguments` + rest coexist | Arguments | 3/5 | MEDIUM — overlapping views |
| G4. Block/label vs object ambiguity | Parsing | 2/5 | LOW — parser correctness |
| H1. `delete` computed + exotic | Mutation | 4/5 | MEDIUM — unresolved deletion |
| I1. Class in expression positions | Class | 2/5 | LOW — scope containment |
| I2. Named func expr as argument | Function | 3/5 | MEDIUM — recursive self-ref |
