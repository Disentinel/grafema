# Syntax Corpus — Gaps Found

## How to Read

Each gap includes:
- **Code** — minimal reproduction
- **Graph impact** — what nodes/edges the analyzer will miss or misconstruct
- **Production?** — how often this appears in real codebases (1-5 scale, 5 = everywhere)

Organized by severity for graph analysis, not by syntactic category.

---

## A. Module System Gaps (Critical for dependency graph)

### A1. Circular imports + live bindings
**Production: 5/5** — every non-trivial codebase has circular deps.

```js
// counter.js
export let count = 0;
export function increment() { count++; }

// main.js
import { count, increment } from './counter.js';
increment();
console.log(count); // 1 — live binding, NOT a copy
```

**Graph impact:** If the graph treats `import { count }` as a one-time copy (ASSIGNED_FROM), it will miss that `count` changes after `increment()`. Need a LIVE_BINDING edge type or special IMPORTS_FROM semantics that track mutability. Without this, data flow analysis shows stale values for any imported `let`.

### A2. Star import as namespace object
**Production: 4/5** — common in utility aggregation.

```js
import * as utils from './utils.js';
utils.format('hello');       // method call on namespace
const fn = utils.format;      // alias extraction from namespace
const { format } = utils;     // destructured extraction
```

**Graph impact:** The namespace object `utils` has no VARIABLE node — it's a synthetic object. Property access `utils.format` needs to resolve through the MODULE's EXPORTS, not through a normal PROPERTY_ACCESS chain. Without special handling, `utils.format` looks like a regular object property access and loses traceability to the source module.

### A3. Re-export star collision (ambiguous bindings)
**Production: 3/5** — barrel files.

```js
// a.js: export const x = 1;
// b.js: export const x = 2;
// barrel.js:
export * from './a.js';
export * from './b.js'; // x is ambiguous — throws at import site

// But this is fine:
export * from './a.js';
export { x } from './b.js'; // explicit re-export wins
```

**Graph impact:** A naive star re-export creates two EXPORTS edges for `x` from `barrel.js`. The graph must either flag the ambiguity (guarantee violation) or model the precedence rule (explicit > star). Without this, `import { x } from './barrel'` resolves to the wrong source.

### A4. Conditional CJS exports
**Production: 5/5** — ubiquitous in test utilities and dev tools.

```js
module.exports = { publicApi };

if (process.env.NODE_ENV === 'test') {
  module.exports._internal = internalFn;
}

// Also: conditional require
const impl = process.env.USE_NATIVE
  ? require('./native')
  : require('./fallback');
```

**Graph impact:** Static analysis sees only the first `module.exports` assignment. The conditional export is invisible — `_internal` won't appear in EXPORTS edges. The conditional require creates a dynamic IMPORTS_FROM that can't be resolved at parse time. Both are common patterns in production CJS code.

### A5. import.meta.url (most common import.meta usage)
**Production: 5/5** — used for `__dirname` replacement in ESM.

```js
const __filename = new URL(import.meta.url).pathname;
const __dirname = new URL('.', import.meta.url).pathname;
const workerUrl = new URL('./worker.js', import.meta.url);
```

**Graph impact:** `import.meta.url` is the most common ESM metaproperty. The graph should track that `__filename`/`__dirname` derive from module identity. More importantly, `new URL('./worker.js', import.meta.url)` creates an implicit file dependency — same as `require('./worker.js')` — that the analyzer must capture for dependency graph completeness.

---

## B. Scope & Hoisting Gaps (Critical for data flow)

### B1. `for (x of y)` / `for (x in y)` without declaration
**Production: 4/5** — common in older code and when reusing accumulator variables.

```js
let key;
for (key in obj) {           // ASSIGNMENT to existing var, not declaration
  console.log(key);
}

let item;
for (item of items) {        // same — assignment target
  process(item);
}

// Even wilder:
let a, b;
for ([a, b] of [[1,2], [3,4]]) {  // destructuring assignment in for-of head
  console.log(a, b);
}
```

**Graph impact:** The corpus has `for (const x of y)` (declaration). But `for (x of y)` without `const/let/var` is a REASSIGNS edge to an existing variable, not DECLARES + INITIALIZES. If the analyzer always creates a new VARIABLE node in the for-head, it misses the mutation of the outer variable entirely. Particularly nasty for data flow: the outer `key`/`item` changes each iteration.

### B2. Function declarations in blocks (Annex B hoisting)
**Production: 5/5** — legacy JS is full of this.

```js
// SLOPPY MODE (.js without "use strict", not ESM):
function sloppy() {
  console.log(typeof f); // "undefined" — var hoisted, not initialized

  if (true) {
    function f() { return 'inside'; }    // Annex B: hoists to function scope as var
    console.log(f()); // 'inside'
  }

  console.log(f()); // 'inside' — f leaked out of block!
}

// STRICT MODE / ESM:
function strict() {
  'use strict';
  if (true) {
    function f() { return 'inside'; }    // block-scoped — no leak
  }
  // f is NOT accessible here — ReferenceError
}
```

**Graph impact:** In sloppy mode, `function f()` inside an `if` block creates a function-scoped variable (Annex B). This means the scope chain for `f` is the enclosing function, not the block. The graph analyzer must know whether the file is sloppy or strict to place the VARIABLE node in the correct scope. Getting this wrong means callers outside the block either (a) falsely see `f` or (b) falsely don't see it.

### B3. Named function expression self-reference
**Production: 4/5** — recursive event handlers, retry logic.

```js
const factorial = function fact(n) {
  return n <= 1 ? 1 : n * fact(n - 1);  // fact visible ONLY inside
};

// fact is NOT a variable in the enclosing scope
// typeof fact === 'undefined' here
factorial(5); // works
```

**Graph impact:** The internal name `fact` exists in a special "intermediate scope" between the function's body scope and the enclosing scope. It is NOT the same VARIABLE node as `factorial`. The graph must create two nodes: VARIABLE `factorial` (outer scope) and FUNCTION `fact` (with a SELF_REFERENCE or special scope edge). If the analyzer creates only one, the recursive CALLS edge from `fact` → `fact` inside the body won't resolve — it'll look for `fact` in the enclosing scope and fail.

### B4. `new.target` in non-class function
**Production: 3/5** — factory functions that work with or without `new`.

```js
function Flexible(name) {
  if (!new.target) {
    return new Flexible(name);    // called without new → redirect
  }
  this.name = name;
}

const a = new Flexible('a');   // new.target === Flexible
const b = Flexible('b');       // new.target === undefined → auto-redirect
```

**Graph impact:** `new.target` is covered in the corpus only in class context (`class-new-target`). But in functions it enables the "auto-new" pattern — the function behaves as both a factory and a constructor. The graph sees `Flexible('b')` as a regular call (no INSTANCE_OF edge), but it actually creates an instance. Without understanding `new.target`, the data flow from factory call to instance creation is invisible.

### B5. `var` in `catch` block clobbering
**Production: 2/5** — rare but devastating when it happens.

```js
try {
  throw new Error('oops');
} catch (e) {
  var e = 'overwritten';  // var hoists to function scope
  // In sloppy mode: e is BOTH the catch parameter AND the var
}
// e is accessible here (function-scoped var) but value is weird:
// depends on sloppy vs strict
```

**Graph impact:** The `var` declaration hoists to the enclosing function scope, but inside the `catch` block it shares the binding with the catch parameter `e`. The graph might create two separate VARIABLE nodes (`e` from catch, `e` from var) when there should be one (or might miss the aliasing). Pure academic horror show, but Grafema's target is messy legacy code where this exists.

---

## C. Expression & Operator Gaps

### C1. `new` with spread arguments
**Production: 5/5** — factory patterns, argument forwarding.

```js
function createDate(...args) {
  return new Date(...args);           // spread in constructor call
}

// Also:
const args = [2024, 0, 15];
const d = new Date(...args);

// Combined with computed class:
function instantiate(Cls, args) {
  return new Cls(...args);            // dynamic class + spread
}
```

**Graph impact:** The corpus has `new Date()` and `Math.max(...args)` (spread in function call), but NOT spread in constructor calls. `new Cls(...args)` is particularly problematic — the class is dynamic AND the arguments are spread. The graph must model this as CALLS + INSTANCE_OF where the target class is unresolved. If spread in `new` isn't handled, the PASSES_ARGUMENT edges won't connect to the constructor's PARAMETER nodes.

### C2. Getter that returns a function (double-call pattern)
**Production: 4/5** — middleware factories, lazy initialization.

```js
class Router {
  get middleware() {
    return (req, res, next) => { /* ... */ next(); };
  }
}
const router = new Router();
router.middleware(req, res, next);  // getter call + returned function call
// AST: CallExpression(MemberExpression(router, middleware), args)
// Same AST as a regular method call! But semantics differ.

// Also: getter returning different functions based on state
class Adapter {
  #mode = 'json';
  get parser() {
    return this.#mode === 'json' ? JSON.parse : xmlParse;
  }
}
adapter.parser(input); // which function? depends on #mode
```

**Graph impact:** `router.middleware(req, res, next)` looks identical to a method call in AST, but it's actually a getter access (side effect!) followed by a call on the returned value. The graph creates a single CALLS edge to `middleware` as if it were a METHOD. But `middleware` is a getter — the CALLS edge should point to the returned function, not the getter itself. This is indistinguishable in the AST without property descriptor analysis.

### C3. Assignment in condition (pattern-level construct)
**Production: 5/5** — regex exec loops, stream reading, linked list traversal.

```js
let match;
while (match = regex.exec(str)) {    // assignment AS condition
  process(match);
}

let node = head;
while (node = node.next) {           // traversal via assignment
  visit(node);
}

let line;
if (line = readline()) {             // assignment + truthiness check
  process(line);
}
```

**Graph impact:** The corpus has `while ((match = regex.exec(str)) !== null)` (with explicit comparison), but NOT the bare assignment-as-condition pattern. The assignment `match = regex.exec(str)` creates a REASSIGNS edge AND a branch guard. The graph needs to model that the condition is BOTH a mutation and a boolean test. Without this, the scope guard for the loop body is modeled incorrectly (it guards on the assignment result, not on a comparison).

### C4. Chained optional calls (deep chain)
**Production: 5/5** — API responses, config objects.

```js
const value = response?.data?.items?.[0]?.getName?.();
// 5 levels of optional chaining: prop, prop, element, prop, call
```

**Graph impact:** The corpus has `obj?.nested?.deep` (2 levels) and `obj?.method?.()` (1 call). But deep chains with mixed access types (property + element + call) are the real-world pattern. Each `?.` is a potential short-circuit exit point. The graph should model each segment as a separate PROPERTY_ACCESS with a guard, but collapsing the chain is tempting and lossy.

### C5. `await` with comma expression
**Production: 2/5** — minified code, one-liners.

```js
const result = await (sideEffect(), fetchData());
// sideEffect() runs synchronously, fetchData() is awaited
```

**Graph impact:** The comma operator means `sideEffect()` is NOT awaited. The graph must distinguish: CALLS to `sideEffect` (sync) and CALLS + AWAITS to `fetchData` (async). If the analyzer doesn't handle comma-in-await, it might mark both as awaited or miss the side effect entirely.

---

## D. Class & Inheritance Gaps

### D1. `super` in arrow inside method
**Production: 5/5** — callbacks inside methods that call parent.

```js
class Child extends Parent {
  process(items) {
    return items.map(item => {
      return super.transform(item);     // super captured in arrow, like this
    });
  }

  delayed() {
    setTimeout(() => {
      super.cleanup();                   // super in async callback
    }, 100);
  }
}
```

**Graph impact:** `super` inside arrow functions refers to the enclosing method's `super`, same as `this`. The corpus has `super.speak()` in direct method body and arrow functions capturing `this`, but not `super` in arrow. The graph must create a CALLS edge from the arrow to `Parent.transform`, not just from `process`. If the analyzer doesn't follow `super` into nested arrows, these cross-class calls become invisible.

### D2. Computed class members with side effects
**Production: 2/5** — metaprogramming, decorator alternatives.

```js
let id = 0;
class AutoId {
  [Symbol.for(`field_${id++}`)] = 'first';     // side effect in field key
  [Symbol.for(`field_${id++}`)] = 'second';
  [`method_${id++}`]() { return 'dynamic'; }   // side effect in method key
}
```

**Graph impact:** Computed keys with side effects are covered for object literals (`computed-key-side-effect`) but NOT for classes. The evaluation order of class members (static first? fields top-to-bottom?) affects what `id` value each key gets. The graph must either evaluate these at analysis time or mark them as UNRESOLVED_MEMBER.

### D3. Destructuring assignment to `this` properties
**Production: 4/5** — constructor initialization, state update methods.

```js
class Component {
  update(props) {
    ({ width: this.width, height: this.height, ...this.extra } = props);
  }
}

// Object.assign equivalent but with destructuring:
class Config {
  constructor(opts) {
    ({ host: this.host, port: this.port = 3000 } = opts);
  }
}
```

**Graph impact:** The corpus has `destructureAssignToProperties` with `obj.x`, but NOT `this.x`. Destructuring to `this` properties means the graph needs PROPERTY_MUTATION edges on the class instance, similar to `this.x = val` in constructor. Missing this means the graph doesn't know which properties `update()` mutates — critical for mutation analysis.

### D4. Default parameter accessing `this` (class methods)
**Production: 3/5** — configuration methods.

```js
class Service {
  defaultTimeout = 5000;

  fetch(url, timeout = this.defaultTimeout) {
    return httpGet(url, { timeout });
  }
}
```

**Graph impact:** The default `this.defaultTimeout` creates a READS edge from the parameter default to the instance field. The graph must model that `this` in parameter defaults refers to the instance (for class methods) or is undefined (for regular functions in strict mode). Missing this: the data flow from field → parameter default → function body is broken.

### D5. `Object.assign(this, opts)` pattern
**Production: 5/5** — the most common pre-class-fields initialization pattern.

```js
class Config {
  constructor(opts) {
    Object.assign(this, opts);    // copies ALL properties from opts to this
    Object.assign(this, defaults, opts); // merge with defaults
  }
}
```

**Graph impact:** `Object.assign(this, opts)` creates PROPERTY_MUTATION edges for EVERY property in `opts`, but the property names are unknown at parse time. The graph sees a call to `Object.assign` with `this` as target, but can't enumerate which properties are being set. This is a fundamental limitation for property tracking in classes that use this pattern — the analyzer must either (a) mark ALL properties as potentially mutated or (b) trace `opts` back to its source to determine shape.

---

## E. Generator / Async Gaps

### E1. `yield*` return value capture
**Production: 3/5** — coroutine pipelines.

```js
function* inner() {
  yield 1;
  yield 2;
  return 'done';              // return value, NOT yielded
}

function* outer() {
  const result = yield* inner();  // result === 'done'
  yield result;
}
```

**Graph impact:** `yield* inner()` delegates to `inner` AND captures its return value. The corpus has `yield* innerGenerator()` but doesn't capture the return value. The graph needs a RETURNS edge from `inner()` to the assignment target `result` in `outer()`. Without this, the data flow from `inner`'s `return` to `outer`'s `result` is invisible — looks like `result` is always `undefined`.

### E2. `for await` on sync iterable
**Production: 3/5** — utility functions that accept both sync and async.

```js
async function consume(iterable) {
  for await (const item of iterable) {    // works on sync iterables too!
    process(item);
  }
}

consume([1, 2, 3]);              // sync array → each value wrapped in Promise
consume(asyncGenerator());       // async generator → native async iteration
```

**Graph impact:** `for await...of` on a sync iterable wraps each value in a Promise. The graph must know that `item` might be either the raw value (sync) or an unwrapped promise result (async). If the analyzer always treats `for await` as requiring an async iterable, it won't create correct edges for the sync case.

### E3. Async generator + destructuring + default
**Production: 3/5** — stream processing.

```js
async function* processStream(source) {
  for await (const { data, meta: { priority = 'normal' } = {} } of source) {
    yield { ...data, priority };
  }
}
```

**Graph impact:** This combines async iteration, nested destructuring, and nested defaults in a single construct. The graph must model: (a) async iteration of `source`, (b) destructuring `data` and `meta.priority` with defaults at two levels, (c) yield of a spread object. Each of these individually works, but the combination stresses the scope tracker — the destructured variables exist only inside the `for await` block.

---

## F. Destructuring Edge Cases

### F1. Nested rest in destructuring
**Production: 2/5** — deep object splitting.

```js
// Array nested rest:
const [first, ...[second, ...deep]] = [1, 2, 3, 4, 5];
// first=1, second=2, deep=[3,4,5]

// Object with rest at multiple levels:
const { a, ...{ b, ...innerRest } } = { a: 1, b: 2, c: 3, d: 4 };
// a=1, b=2, innerRest={c:3, d:4}
// NOTE: this is actually a SyntaxError in many engines — rest element must be last
// But THIS is valid:
const { a: { x, ...xRest }, ...outerRest } = { a: { x: 1, y: 2 }, b: 3 };
```

**Graph impact:** Nested rest destructuring creates intermediate implicit objects. `...[second, ...deep]` first creates a rest array, then destructures it further. The graph needs intermediate VARIABLE nodes for the rest elements. If only top-level rest is handled, nested destructuring patterns lose the inner bindings.

### F2. Destructuring with computed + default + rename (triple combo)
**Production: 3/5** — dynamic configuration.

```js
const key = 'name';
const { [key]: renamed = 'anonymous' } = config;
// Computed key + rename + default — all three at once
```

**Graph impact:** Three features compose: (a) computed key lookup on `config`, (b) alias binding to `renamed`, (c) default value `'anonymous'` if undefined. The graph must chain: PROPERTY_ACCESS(config, [key]) → CONDITIONAL_DEFAULT('anonymous') → INITIALIZES(renamed). If any step is missing, the data flow from `config[key]` to `renamed` breaks.

### F3. Nested destructuring in catch clause
**Production: 3/5** — structured error objects.

```js
try {
  throw { errors: [{ code: 'E1', path: '/api' }], status: 500 };
} catch ({ errors: [{ code, path }], status }) {
  console.log(code, path, status);
}
```

**Graph impact:** The corpus has simple catch destructuring (`{ code, message }`), but not nested. The catch parameter scope is special — it's not a block scope, not a function scope. Nested destructuring in catch stresses the scope tracker: are `code`, `path`, `status` in the catch clause scope or the block scope?

### F4. Object rest excludes inherited properties
**Production: 3/5** — prototype-based code with spread.

```js
const proto = { inherited: 1 };
const child = Object.create(proto);
child.own = 2;
child.also = 3;

const { own, ...rest } = child;
// rest === { also: 3 } — inherited NOT included!

// But:
'inherited' in child;                 // true
const { inherited } = child;          // 1 — destructuring DOES access inherited
```

**Graph impact:** `...rest` collects only OWN properties, but named destructuring (`{ inherited }`) accesses the prototype chain. The graph must distinguish: PROPERTY_ACCESS through destructuring can resolve inherited properties, but REST_ELEMENT can't. If the graph treats rest as "everything not explicitly destructured", it might incorrectly include prototype properties.

---

## G. TypeScript-Specific Gaps

### G1. Mapped type with `as` clause (key remapping)
**Production: 5/5** — utility type libraries, API generation.

```ts
type Getters<T> = {
  [K in keyof T as `get${Capitalize<string & K>}`]: () => T[K]
};
// { name: string } → { getName: () => string }

type RemoveKind<T> = {
  [K in keyof T as Exclude<K, 'kind'>]: T[K]
};
```

**Graph impact:** The `as` clause transforms property KEYS, not just values. For a graph that models type relationships, this means the output type has entirely new property names that don't exist in the input. Interface/type analysis that assumes key preservation will miss these synthetic properties.

### G2. Variadic tuple types
**Production: 4/5** — generic utility functions, middleware chains.

```ts
type Concat<A extends unknown[], B extends unknown[]> = [...A, ...B];
type Head<T extends unknown[]> = T extends [infer H, ...unknown[]] ? H : never;
type Tail<T extends unknown[]> = T extends [unknown, ...infer R] ? R : never;
type Last<T extends unknown[]> = T extends [...unknown[], infer L] ? L : never;
```

**Graph impact:** Variadic tuples allow type-level manipulation of function argument lists. For the graph, this matters when tracing `Parameters<T>` through generic wrappers — the wrapper's parameter types are derived from the wrapped function's tuple type via spread.

### G3. Generic constraint with `keyof`
**Production: 5/5** — one of the most common generic patterns.

```ts
function getProperty<T, K extends keyof T>(obj: T, key: K): T[K] {
  return obj[key];
}

function pluck<T, K extends keyof T>(items: T[], key: K): T[K][] {
  return items.map(item => item[key]);
}
```

**Graph impact:** `K extends keyof T` constrains the second type parameter to valid property keys of the first. For the graph, this means `obj[key]` is a RESOLVED property access (not dynamic) — the return type `T[K]` preserves the specific property type. Without modeling this constraint, the graph treats `obj[key]` as unresolved dynamic access.

### G4. `typeof ClassName` (constructor type vs instance type)
**Production: 4/5** — factory patterns, DI containers.

```ts
class Foo {
  static create() { return new Foo(); }
  method() {}
}

type FooInstance = Foo;           // instance type — has method()
type FooConstructor = typeof Foo; // constructor type — has create(), new()

function factory(Cls: typeof Foo): Foo {
  return new Cls();               // valid because typeof Foo has [[Construct]]
}
```

**Graph impact:** `typeof Foo` and `Foo` are different types in TypeScript. The graph must model this duality: CLASS node for instance type, CLASS_CONSTRUCTOR for the static side. When `Cls: typeof Foo` is passed to a factory, the INSTANCE_OF edge from `new Cls()` should point to `Foo`, not to `typeof Foo`.

### G5. `this` type guard on class methods
**Production: 3/5** — discriminated type hierarchies.

```ts
class FileSystemNode {
  isFile(): this is FileNode { return this instanceof FileNode; }
  isDir(): this is DirNode { return this instanceof DirNode; }
}

class FileNode extends FileSystemNode {
  content: string = '';
}

class DirNode extends FileSystemNode {
  children: FileSystemNode[] = [];
}

function process(node: FileSystemNode) {
  if (node.isFile()) {
    node.content;     // TypeScript knows: node is FileNode
  }
}
```

**Graph impact:** `this is FileNode` is a type narrowing assertion tied to a method call. The corpus has `value is string` for standalone type guards but not the polymorphic `this is T` form. For the graph, after a call to `node.isFile()`, the type of `node` narrows — all subsequent PROPERTY_ACCESS edges should resolve against `FileNode`, not `FileSystemNode`.

### G6. Intersection of function types (overloaded call signatures)
**Production: 3/5** — merged interfaces, mixins.

```ts
type StringHandler = (input: string) => string;
type NumberHandler = (input: number) => number;
type BothHandler = StringHandler & NumberHandler;

// Equivalent to overload:
// (input: string): string;
// (input: number): number;
```

**Graph impact:** Function type intersection creates call-site ambiguity. The graph must resolve which signature matches at each call site based on argument types. If the analyzer treats intersections as "has all properties of both", it misses that this is overloading, not combination.

### G7. Enum reverse mapping (runtime behavior)
**Production: 4/5** — numeric enums in switch statements, serialization.

```ts
enum Status { Active = 0, Inactive = 1 }

Status.Active;        // 0
Status[0];            // 'Active' — reverse mapping!
Status[Status.Active]; // 'Active'

// String enums do NOT have reverse mapping:
enum Color { Red = 'RED' }
// Color['RED'] is undefined — no reverse mapping
```

**Graph impact:** Numeric TypeScript enums emit runtime reverse mapping objects. The graph must model that `Status[0]` is a valid PROPERTY_ACCESS returning `'Active'`, not just that `Status.Active === 0`. This affects data flow: if someone does `const name = Status[value]`, the graph needs to know the result is a string enum member name.

### G8. Generic default referencing previous generic
**Production: 3/5** — builder patterns, configuration.

```ts
function createStore<
  S extends object,
  A extends object = {},
  G extends object = {},
>(config: { state: S; actions?: A; getters?: G }) {
  return config;
}

// Also: default referencing the first param
function wrap<T, R = T[]>(value: T): R {
  return [value] as unknown as R;
}
```

**Graph impact:** When `R = T[]`, the default for `R` depends on the resolved type of `T`. For the graph, this means generic instantiation is order-dependent — resolving `R` requires first resolving `T`. If the graph resolves generics independently, it might miss the dependency.

---

## H. Interaction Patterns (Composition of Features)

### H1. Nested arrow functions and `this`/`super` capture chain
**Production: 5/5** — callbacks in class methods.

```js
class Service extends Base {
  async processAll(items) {
    return items.map(item => {                    // arrow 1: captures this + super
      return this.validate(item).then(valid => {  // arrow 2: captures this + super
        return super.save(valid);                  // super works through nested arrows
      });
    });
  }
}
```

**Graph impact:** Each nested arrow captures `this` and `super` from the enclosing method. The graph needs CALLS edges from the innermost arrow to `Base.save` (via super) and to `Service.validate` (via this). If `super` resolution stops at the first arrow boundary, these edges are lost.

### H2. Async arrow returning object literal
**Production: 4/5** — inline data transforms.

```js
const transform = async (data) => ({
  id: data.id,
  result: await process(data),
  timestamp: Date.now(),
});
// Without parens: async (data) => { id: data.id } — parsed as block + label!
```

**Graph impact:** This combines two covered constructs (async arrow + object-return parens), but their interaction is not covered. The `await` inside the object literal means the literal construction is async — the graph must model that `result` is assigned the awaited value of `process(data)`, not the Promise itself.

### H3. Template tag on method call result
**Production: 3/5** — styled-components, SQL builders.

```js
const query = db.prepare()`SELECT * FROM users WHERE id = ${id}`;
// Same as: (db.prepare())`...`

// Also: optional chaining + tagged template — SYNTAX ERROR:
// obj?.tag`template`; // SyntaxError!
```

**Graph impact:** `db.prepare()` returns a function, which is then used as a template tag. The AST has a TaggedTemplateExpression where the tag is a CallExpression. The graph must model this as two CALLS: one to `db.prepare()`, and one to the returned function with the template arguments. Also noteworthy: `obj?.tag\`template\`` is a SyntaxError — this interaction is probably not known to the analyzer.

### H4. `typeof` in switch discriminant
**Production: 5/5** — type dispatch.

```js
function processValue(val) {
  switch (typeof val) {
    case 'string': return val.trim();
    case 'number': return val.toFixed(2);
    case 'object': return JSON.stringify(val);
    case 'function': return val();
    default: return String(val);
  }
}
```

**Graph impact:** `typeof val` in switch is a de facto type narrowing pattern. Inside `case 'string'`, `val` is a string. The graph's scope guards should narrow the type of `val` per case — otherwise `val.trim()` looks like an unresolved method call on an unknown type. This is the JS equivalent of TS discriminated unions, and equally important for data flow.

### H5. Short-circuit as guard-and-call
**Production: 5/5** — the single most common JS pattern.

```js
callback && callback(data);         // guard + call
opts?.onSuccess && opts.onSuccess(result);
Array.isArray(items) && items.forEach(fn);

// Combined with optional chaining:
callback?.(data);                    // cleaner equivalent
```

**Graph impact:** `callback && callback(data)` is a CALLS edge that is CONDITIONALLY executed — the call only happens if `callback` is truthy. The graph should model this as a guarded CALLS edge. Without the guard, the graph claims `callback` is always called, which breaks "is this function used?" analysis.

---

## Summary Table

| Gap | Category | Production Frequency | Graph Impact |
|-----|----------|---------------------|--------------|
| A1. Circular imports + live bindings | Modules | 5/5 | CRITICAL — stale data flow |
| A2. Star import namespace | Modules | 4/5 | HIGH — lost traceability |
| A4. Conditional CJS exports | Modules | 5/5 | HIGH — invisible exports |
| B1. `for (x of y)` no declaration | Scope | 4/5 | CRITICAL — mutation missed |
| B2. Block function declarations | Scope | 5/5 | CRITICAL — wrong scope |
| B3. Named func expr self-reference | Scope | 4/5 | HIGH — recursive calls lost |
| C1. `new` with spread | Expressions | 5/5 | HIGH — PASSES_ARGUMENT broken |
| C3. Assignment in condition | Expressions | 5/5 | MEDIUM — guard modeling |
| D1. `super` in nested arrow | Classes | 5/5 | HIGH — cross-class calls lost |
| D3. Destructure to `this` props | Classes | 4/5 | HIGH — mutation tracking |
| D5. `Object.assign(this, opts)` | Classes | 5/5 | CRITICAL — all props unknown |
| E1. `yield*` return value | Generators | 3/5 | MEDIUM — data flow gap |
| G1. Mapped type `as` clause | TypeScript | 5/5 | MEDIUM — key transformation |
| G3. Generic `keyof` constraint | TypeScript | 5/5 | HIGH — resolved access |
| G7. Enum reverse mapping | TypeScript | 4/5 | MEDIUM — runtime behavior |
| H1. `this`/`super` in nested arrows | Interaction | 5/5 | HIGH — compound capture |
| H4. `typeof` in switch | Interaction | 5/5 | HIGH — type narrowing |
| H5. Short-circuit guard-and-call | Interaction | 5/5 | MEDIUM — conditional calls |
