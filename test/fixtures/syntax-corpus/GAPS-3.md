# Syntax Corpus — Gaps Round 3

Reviewed all 25 source files, GAPS.md, and GAPS-2.md. Focus: constructs and
interactions NOT covered by the corpus OR prior gap documents.

Verified every item against the actual `@construct` tags and source code.

---

## A. Expression Position Gaps

### A1. Assignment as subexpression (non-condition positions)
**Production: 4/5** — minified code, terse idioms, sometimes intentional.

```js
// Assignment inside array literal — creates variables AS side effect
const arr = [a = 1, b = 2, c = a + b];

// Assignment as function argument — mutates AND passes value
log(x = computeExpensive());

// Assignment as computed property key — side effect in key expression
const obj = { [idx = getNextId()]: 'value' };

// Assignment inside template interpolation
const msg = `User ${name = getName()} is ${age = getAge()} years old`;
```

**Graph impact:** The corpus has `assignment-in-condition` (`while (x = f())`) and `assignment-in-if`. But assignment in array literal, function argument, property key, and template interpolation is NOT covered. Each creates a REASSIGNS edge as a **side effect** of the expression being evaluated for its value. The graph must emit both the value-use edge (e.g., PASSES_ARGUMENT to `log`) AND the mutation edge (REASSIGNS to `x`). If the analyzer only looks for assignments in statement/condition position, these hidden mutations are invisible — critical for data flow analysis of minified code and terse idioms.

### A2. `typeof` as computed property key (dispatch table pattern)
**Production: 4/5** — runtime type dispatch without switch, common in serializers and validators.

```js
const handlers = {
  string(v) { return v.trim(); },
  number(v) { return v.toFixed(2); },
  boolean(v) { return v ? 'yes' : 'no'; },
  object(v) { return v === null ? 'null' : JSON.stringify(v); },
};

function dispatch(val) {
  return handlers[typeof val](val);
  //     ^^^^^^^^ computed property access where key is a typeof expression
}
```

**Graph impact:** The corpus has `typeof-switch-narrowing` (typeof in switch discriminant). But `handlers[typeof val]` is a fundamentally different pattern — it's a PROPERTY_ACCESS with a dynamic key that happens to be a `typeof` expression. The graph must model that `typeof val` returns one of 7 possible strings ("string", "number", "boolean", "object", "function", "undefined", "symbol"), and the property access resolves to one of those methods. Without this, the graph treats it as an unresolved dynamic access with unknown CALLS target — but typeof has a known, finite result set.

### A3. Arrow returning assignment expression
**Production: 2/5** — callbacks, reduce accumulators.

```js
// Parenthesized assignment — looks like object return but ISN'T
const setAndReturn = (val) => (cache = val);

// In reduce accumulator
const last = items.reduce((_, item) => (current = item), null);

// With destructuring assignment
const swap = () => ([a, b] = [b, a]);
```

**Graph impact:** The corpus has `arrow-return-object-literal` (`(x) => ({ key: x })`), showing that parentheses force object-literal interpretation. But `(x) => (y = x)` uses parentheses for a DIFFERENT reason — to make the assignment expression the return value. The AST is `ArrowFunctionExpression > AssignmentExpression`, not `ArrowFunctionExpression > ObjectExpression`. If the parser/analyzer confuses these, it will create wrong nodes. The graph must create both a REASSIGNS edge (mutation of `cache`) AND a RETURNS edge (the assigned value is the return).

### A4. `void 0` as explicit undefined
**Production: 4/5** — minified code, intentional in libraries.

```js
// Minifier pattern — void 0 is shorter than undefined and immune to shadowing
const isUndefined = val === void 0;

// void with side effect — expression is evaluated, result is discarded
void sideEffect();
// Different from: sideEffect(); — because void always returns undefined

// void in ternary
const result = condition ? value : void 0;

// Distinction: undefined can be shadowed (in sloppy mode), void 0 cannot
function dangerous() {
  var undefined = 42; // legal in sloppy!
  return undefined;   // 42, not actual undefined
  // void 0 would still return real undefined
}
```

**Graph impact:** The corpus has `void-iife` and `void-promise` (void with function calls). But `void 0` as the canonical undefined-replacement is NOT covered. For the graph, `void expr` always evaluates `expr` (creating CALLS edges if it's a call) but the result is always `undefined`. The `void 0` idiom is semantically a LITERAL `undefined` — the graph should either treat it as an UNDEFINED_LITERAL node or at minimum recognize it as producing `undefined`. Without this, `val === void 0` looks like a comparison against the result of `void(0)` — which is technically correct but loses the semantic intent. Grafema's target is legacy code where `void 0` is ubiquitous.

---

## B. Declaration & Scope Gaps

### B1. Destructured parameter feeding subsequent parameter default
**Production: 3/5** — configuration functions, builder patterns.

```js
function createWidget({width, height}, area = width * height) {
  return { width, height, area };
}

// Also with nested destructuring:
function query({table, schema = 'public'}, fullName = `${schema}.${table}`) {
  return `SELECT * FROM ${fullName}`;
}

// With array destructuring:
function range([start, end], length = end - start) {
  return { start, end, length };
}
```

**Graph impact:** `param-default-depends-on-prior` covers `(a, b = a * 2)` where `a` is a simple parameter. But `({width, height}, area = width * height)` is fundamentally different: the variables `width` and `height` are created by DESTRUCTURING the first parameter, then used in the DEFAULT of the second parameter. The graph must: (a) create VARIABLE nodes for `width` and `height` from destructuring, (b) create a READS edge from the default expression `width * height` to those VARIABLE nodes, (c) model that these reads happen in the PARAMETER SCOPE, not the function body scope. If the analyzer processes parameters independently without a shared scope, the READS edges from `area`'s default to `width`/`height` won't resolve.

### B2. `var` re-declaration of function parameter
**Production: 3/5** — legacy code, accidental pattern.

```js
function legacy(x, y) {
  var x = x || 'default';  // same binding as parameter x
  var y;                     // re-declares y, but doesn't reset it
  return { x, y };
}

legacy(null, 42); // { x: 'default', y: 42 }
// var x doesn't create a new binding — it's the SAME variable as param x
// var y doesn't reset — y is still 42 from the parameter

// Contrast with let:
function modern(x) {
  let x = 10; // SyntaxError! let cannot re-declare parameter
}
```

**Graph impact:** `var-function-collision` covers var vs function declaration collision. But var re-declaring a PARAMETER is different: the `var x` declaration doesn't create a new VARIABLE node — it's the same binding as parameter `x`. The graph must NOT create two VARIABLE nodes for `x`. The `var x = x || 'default'` is a REASSIGNS edge on the existing parameter binding. If the graph creates a separate VARIABLE node for the `var` declaration, it will lose the connection to the parameter — callers passing arguments won't link to the body variable.

### B3. Numeric separators
**Production: 3/5** — growing, especially in configs and constants.

```js
const TIMEOUT = 30_000;              // 30000
const MAX_SAFE = 9_007_199_254_740_991; // Number.MAX_SAFE_INTEGER
const COLOR = 0xFF_EC_D9;            // hex with separators
const MASK = 0b1111_0000_1010_0101;  // binary
const OCTAL = 0o777_000;             // octal
const BIG = 1_000_000_000_000n;      // BigInt with separators
const FLOAT = 1_000.123_456;         // in float
```

**Graph impact:** Numeric separators (`_`) are stripped by the parser — `30_000` evaluates to `30000`. The graph's LITERAL nodes must store the EVALUATED value, not the source text. If the analyzer stores the raw text `"30_000"`, value comparison fails: `30_000 !== 30000` as strings. This matters for constant folding, value domain analysis, and duplicate detection. The parser must normalize the value, and the graph must reflect the normalized form.

### B4. Hashbang (shebang) comment
**Production: 5/5** — every Node.js CLI tool.

```js
#!/usr/bin/env node
// This is line 2 in the file, but line 1 in "normal" code

import { run } from './cli.js';
run(process.argv.slice(2));
```

**Graph impact:** The hashbang `#!` must be skipped by the parser. If the parser doesn't handle it, the entire file fails to parse — no nodes generated at all. More subtly, if the parser ignores it but counts it as a line, ALL line numbers in the file are correct. But if the parser strips it and re-indexes, all line numbers are off by one. Since Grafema uses line numbers for node location and code context display, an off-by-one error makes every node in the file point to the wrong line. Every CLI entry point starts with a hashbang.

### B5. Function `.name` inference from context
**Production: 4/5** — affects FUNCTION node naming in the graph.

```js
// Variable assignment → name inferred
const foo = function() {};
foo.name; // "foo"

// Object property → name inferred
const obj = {
  method: function() {},     // name: "method"
  arrow: () => {},            // name: "arrow"
  [Symbol.for('x')]: function() {}, // name: "[Symbol.for('x')]"
};

// Default export → name is "default"
// export default function() {} → name: "default"

// Class expression name
const MyClass = class {};
MyClass.name; // "MyClass"

// Default parameter value → name inferred
function withDefault(fn = function() {}) {
  fn.name; // "fn"
}

// Object.defineProperty → NO name inference
Object.defineProperty(obj, 'hidden', { value: function() {} });
// obj.hidden.name → "" (empty string)
```

**Graph impact:** The graph creates FUNCTION nodes with a `name` property. For anonymous functions, this name is INFERRED from context — the same rules V8/SpiderMonkey use for `.name`. The corpus has `func-expr-anonymous` and `func-expr-named`, but doesn't cover the inference rules. If the graph uses AST node `id` for the name (null for anonymous functions), anonymous functions get no name — making them unqueryable. The graph should infer names using the same rules as the engine: variable name, property name, method name, "default" for default exports. Without this, `find_nodes({name: "foo"})` won't find `const foo = function() {}`.

---

## C. Object & Property Gaps

### C1. Method shorthand vs function property — `[[HomeObject]]` and `super`
**Production: 4/5** — important to distinguish for correct super resolution.

```js
const parent = {
  greet() { return 'parent'; },
};

const child = {
  __proto__: parent,

  // Method shorthand — HAS [[HomeObject]], super works
  method() {
    return super.greet();  // 'parent' ✓
  },

  // Function property — NO [[HomeObject]], super is SyntaxError
  func: function() {
    // return super.greet(); // SyntaxError: 'super' keyword unexpected here
  },

  // Arrow property — NO [[HomeObject]], super inherits from enclosing scope
  arrow: () => {
    // super.greet() — depends on where arrow is defined, not on child
  },
};
```

**Graph impact:** `super-in-object-literal` shows `super` in a shorthand method. But it doesn't contrast with function properties that CANNOT use super. The graph must distinguish: METHOD nodes (from shorthand) get [[HomeObject]] and can have CALLS-via-super edges. FUNCTION nodes assigned to properties do NOT get [[HomeObject]]. If the graph treats both as equivalent "object methods", it might incorrectly resolve super calls from function properties — or conversely, might not allow super calls from valid shorthand methods.

### C2. Property access chain on anonymous expression results
**Production: 5/5** — chaining without intermediate variables.

```js
// Method call on function return (no intermediate variable)
getUser().name;
getConfig().database.host;

// After await (very common in fetch patterns)
const data = (await fetch(url)).json(); // oops — missing await on json()
const data2 = await (await fetch(url)).json(); // correct

// After new
new Map([['a', 1]]).get('a');

// After array operations
[...items].sort((a, b) => a - b)[0]; // sorted copy, first element

// After IIFE
(function() { return { x: 1 }; })().x;

// Chained methods on literal
'hello world'.split(' ').map(s => s[0]).join('');
```

**Graph impact:** The corpus has `method-chaining-builder` and `method-chaining-usage` which chain on a named variable. But chaining directly on an expression result (function call, `await`, `new`, array literal) creates PROPERTY_ACCESS and METHOD_CALL nodes where the base is NOT a VARIABLE — it's an anonymous expression result. The graph must create a CALL node for `getUser()`, then a PROPERTY_ACCESS node for `.name` that references the CALL node's return value. Without intermediate VARIABLE anchors, the data flow from `getUser()`'s return to `.name` requires the graph to connect CALL → PROPERTY_ACCESS directly. If the graph always expects a VARIABLE as the base of property access, these chains produce orphaned PROPERTY_ACCESS nodes.

---

## D. Generator & Async Gaps

### D1. `new.target` captured by arrow inside constructor
**Production: 3/5** — abstract factory, base class detection.

```js
class Base {
  constructor() {
    // new.target is like this — captured by arrows
    const getTarget = () => new.target;

    if (new.target === Base) {
      throw new Error('Base is abstract — use a subclass');
    }

    // Store for lazy initialization
    this._factory = () => new (new.target)();
  }
}

class Derived extends Base {
  constructor() {
    super(); // new.target === Derived inside Base's constructor
  }
}

new Derived(); // works
new Base();    // throws — abstract guard
```

**Graph impact:** `class-new-target` covers `new.target` directly in a constructor body. `super-in-arrow-callback` covers `super` captured by arrows. But `new.target` captured by arrows inside a constructor is NOT covered. Like `this` and `super`, `new.target` is lexically bound in arrows — the arrow inherits the constructor's `new.target`. The graph must create a READS edge from the arrow's `new.target` reference back to the enclosing constructor's `new.target` meta-property. Without this, the abstract factory pattern (`() => new (new.target)()`) is invisible — the graph doesn't know that the arrow creates instances of the actual derived class.

---

## E. Loop & Iteration Gaps

### E1. `for` loop with comma operator in init and update
**Production: 4/5** — bidirectional iteration, multiple counters.

```js
// Two-pointer technique (extremely common in algorithms)
for (let lo = 0, hi = arr.length - 1; lo < hi; lo++, hi--) {
  [arr[lo], arr[hi]] = [arr[hi], arr[lo]]; // swap
}

// Side effect in update
for (let i = 0; i < n; i++, processedCount++) {
  process(items[i]);
}

// Comma in init with side effect
for (let i = (reset(), 0); i < n; i++) {
  // reset() called once before loop starts
}
```

**Graph impact:** `for-classic` has `for (let i = 0; i < 10; i++)` — single variable, single update. The multi-variable init (`let lo = 0, hi = arr.length - 1`) creates TWO VARIABLE nodes in the for-head scope. The comma-separated update (`lo++, hi--`) creates TWO UPDATE_EXPRESSION nodes that both execute per iteration. The graph must model: (a) both variables exist in the same loop scope, (b) both update expressions execute each iteration, (c) the condition can reference both. Without modeling the multi-update, the graph only sees one counter being modified per iteration.

---

## F. TypeScript-Specific Gaps

### F1. `export =` and `import = require()` (CJS interop)
**Production: 5/5** — every `.d.ts` file for CJS modules uses this.

```ts
// ---- module.ts (CJS-style export) ----
class MyLib {
  static VERSION = '1.0';
  process(data: string): string { return data.toUpperCase(); }
}

export = MyLib; // Emits: module.exports = MyLib

// ---- consumer.ts ----
import MyLib = require('./module');
// Emits: const MyLib = require('./module')

const instance = new MyLib();
instance.process('hello');

// Also: interop with default import (esModuleInterop)
// import MyLib from './module'; // requires esModuleInterop flag
```

**Graph impact:** The corpus has ESM imports/exports and CJS `module.exports`/`require()`. But TypeScript's `export =` and `import = require()` are NEITHER — they're TS-specific syntax that emits CJS. The parser must handle `export = expr` (ExportAssignment with `isExportEquals: true`) and `import x = require()` (ImportEqualsDeclaration). These are the ONLY way to type CJS modules in `.d.ts` files. If the analyzer doesn't handle them, the entire DefinitelyTyped ecosystem is unparseable. The graph needs: EXPORTS edge from module to the `export =` value, and IMPORTS_FROM edge for `import = require()`.

### F2. Getter and setter with different types (TS 4.3+)
**Production: 3/5** — DOM wrappers, adapters, state management.

```ts
class SmartField {
  #raw: string = '';

  // Getter returns string
  get value(): string {
    return this.#raw;
  }

  // Setter accepts string | number — different type!
  set value(input: string | number) {
    this.#raw = String(input);
  }
}

const field = new SmartField();
field.value = 42;        // OK — setter accepts number
const v: string = field.value; // OK — getter returns string

// Real-world: DOM element.style
// get style(): CSSStyleDeclaration
// set style(value: string | CSSStyleDeclaration)
```

**Graph impact:** The corpus has `class-getters-setters` with matching types. But TS 4.3+ allows getter and setter to have DIFFERENT types — the read-type and write-type of a property diverge. The graph must model two separate type annotations on the same property: PROPERTY_ACCESS (read) resolves to the getter's return type, PROPERTY_MUTATION (write) resolves to the setter's parameter type. If the graph stores one type per property, it either loses the getter type or the setter type — leading to false type errors in data flow analysis.

### F3. Inline `type` modifier on individual import/export specifiers
**Production: 5/5** — standard TS practice since 4.5.

```ts
// Mixed value + type in single import (TS 4.5+)
import { Component, type Props, type State } from './ui';
// Component is a VALUE import — emits runtime code
// Props and State are TYPE imports — erased at compile time

// Mixed value + type in single re-export
export { handler, type HandlerConfig } from './handlers';

// Contrast with import type (entire statement is type-only):
import type { OnlyTypes } from './types';
// vs inline type (mixed):
import { realValue, type JustType } from './mixed';
```

**Graph impact:** `ts-import-type` notes `import { type Role, Permission }` in a comment but doesn't exercise it as real code. `ts-export-type` similarly comments `export { type Status }`. The inline `type` modifier is DIFFERENT from `import type` — it allows mixing value and type imports in a single statement. For the graph: `Component` needs an IMPORTS_FROM edge (runtime dependency), but `Props` does NOT (type-only, erased). If the graph treats all specifiers in an import statement the same way, it either: (a) creates false runtime dependencies for type imports, or (b) misses runtime dependencies when `import type` is used for the whole statement. The `type` modifier per-specifier is the solution and must be parsed correctly.

### F4. `this` parameter combined with destructured parameters
**Production: 2/5** — event handlers, middleware with typed context.

```ts
// this-param + destructured object param
function handleEvent(
  this: HTMLButtonElement,
  { detail, bubbles }: CustomEvent
): void {
  console.log(this.id, detail, bubbles);
}

// this-param + rest
function middleware(
  this: AppContext,
  ...args: [Request, Response, NextFunction]
): void {
  this.logger.info('handling', args[0].url);
}
```

**Graph impact:** `ts-explicit-this-param` has `function f(this: T, greeting: string)` — `this` param with a simple named param. But `this` combined with destructuring or rest creates a more complex parameter list: the `this` param occupies position 0 in the TS AST but is NOT a real parameter at runtime. The destructured `{detail, bubbles}` is the FIRST actual parameter. If the graph counts `this` as a real PARAMETER node, the PASSES_ARGUMENT edges are off-by-one — the first argument maps to `{detail, bubbles}`, not to `this`. The graph must skip the `this` parameter when creating PARAMETER nodes or adjust argument indexing.

---

## G. Interaction Gaps (Composition of Features)

### G1. Async generator method in object literal
**Production: 3/5** — streaming APIs, real-time data processing.

```js
const dataSource = {
  // Async generator method — combines async, generator, and method shorthand
  async *events(since) {
    let cursor = since;
    while (true) {
      const batch = await fetchEvents(cursor);
      if (!batch.length) break;
      for (const event of batch) {
        yield event;
      }
      cursor = batch[batch.length - 1].id;
    }
  },

  // Regular async method alongside for comparison
  async latest() {
    const events = [];
    for await (const e of this.events(Date.now() - 3600000)) {
      events.push(e);
      if (events.length >= 10) break;
    }
    return events;
  },
};

// Usage: for await (const event of dataSource.events(cursor)) { ... }
```

**Graph impact:** `shorthand-patterns` has `async fetchData()` (async method) and `*generate()` (generator method) in an object literal, separately. `class-async-method` and `class-generator-method` exist for classes. But `async *method()` in an **object literal** is NOT covered anywhere. This combines three features: async (AWAITS edges), generator (YIELDS edges), and method shorthand ([[HomeObject]] for super). The graph must create a FUNCTION node that is both async AND generator, contained in an OBJECT_LITERAL — different from class containment. If the analyzer handles `async *` only in class context, object literal async generators produce malformed nodes.

### G2. Chained destructuring assignment
**Production: 1/5** — rare but tests parser completeness.

```js
let a, b, c, d;

// Chained destructuring — evaluates right-to-left
[a, b] = [c, d] = [1, 2];
// Step 1: [c, d] = [1, 2] → c=1, d=2, returns [1, 2]
// Step 2: [a, b] = [1, 2] → a=1, b=2

// With overlapping targets
[a, b] = [b, a] = [1, 2]; // swap? NO!
// Step 1: [b, a] = [1, 2] → b=1, a=2, returns [1, 2]
// Step 2: [a, b] = [1, 2] → a=1, b=2
// Result: a=1, b=2 (not a swap at all)

// Object chained destructuring
({x: a} = {x: b} = {x: 42});
```

**Graph impact:** `chained-assignment` covers `a = b = c = 42` (simple chain). But chained DESTRUCTURING is fundamentally different — each destructuring pattern receives the same RHS value (the result of the assignment expression). The right-to-left evaluation creates surprising results when targets overlap. The graph must model: (a) the rightmost assignment evaluates first, (b) its return value feeds the next destructuring, (c) if targets overlap, later writes overwrite earlier ones. Without this, the graph might show `[a, b] = [b, a]` as a swap (it's NOT).

### G3. Duplicate keys with spread between them
**Production: 3/5** — config merging with explicit overrides.

```js
function mergeConfig(overrides) {
  return {
    debug: false,         // (1) explicit default
    ...overrides,         // (2) user overrides — may set debug
    debug: true,          // (3) THIS ALWAYS WINS — overrides the override!
    timestamp: Date.now(),
  };
}
// Key: 'debug' appears at positions (1) and (3), with spread between.
// Result: debug is ALWAYS true, regardless of overrides.

// Also relevant for React patterns:
// <Component {...props} className="forced" /> — className always wins
```

**Graph impact:** `spread-objects` has `{ ...base, c: 3, b: 'overridden' }` where the duplicate `b` is AFTER the spread. But the pattern of a key BEFORE the spread, the spread potentially setting the same key, and then the key AFTER the spread (triply-defined) is not covered. The graph must model that property evaluation is strictly left-to-right: (1) sets debug to false, (2) spread may set debug to anything, (3) sets debug to true — final value is always true. Without modeling this ordering, the graph might show `debug` as having data flow from `overrides`, when in fact it's always `true`.

### G4. `in` operator as conditional type guard (narrowing pattern)
**Production: 5/5** — the most common way to discriminate object shapes in JS.

```js
function process(input) {
  if ('name' in input) {
    // Inside this branch: graph should know input has .name
    return input.name.toUpperCase();
  }
  if ('items' in input && 'count' in input) {
    // Compound in-check — input has both .items and .count
    return input.items.slice(0, input.count);
  }
  return String(input);
}

// Common in event handling:
function handleMessage(msg) {
  if ('error' in msg) {
    throw msg.error;
  }
  if ('data' in msg) {
    return msg.data;
  }
}
```

**Graph impact:** `prop-existence-checks` has `'key' in obj` as a standalone check. But the GUARD pattern — using `'prop' in obj` as an if-condition to narrow the type inside the branch — is NOT covered. This is the JS equivalent of TypeScript's discriminated union. Inside the `if ('name' in input)` block, the graph's scope guard should assert that `input` has a `name` property, making `input.name` a RESOLVED PROPERTY_ACCESS instead of an unresolved one. Without this guard-based narrowing, `input.name` looks like a potentially-undefined access — but the `in` check guarantees it exists. This is how real JS code does type discrimination without TypeScript.

### G5. Immediately destructured dynamic import
**Production: 5/5** — the standard pattern for dynamic module loading.

```js
// Destructured await import — the most common dynamic import pattern
const { readFile, writeFile } = await import('node:fs/promises');

// Conditional dynamic import with destructuring
const { parse } = await import(
  useYaml ? 'yaml' : 'json5'
);

// Destructured import in function
async function loadFormatter(lang) {
  const { format } = await import(`./formatters/${lang}.js`);
  return format;
}
```

**Graph impact:** The corpus has `top-level-await` and `alias-import-dynamic-variable` (dynamic import into a variable). But `const { x } = await import('mod')` combines destructuring + await + dynamic import in one statement. The graph must: (a) create an IMPORTS_FROM edge (dynamic), (b) AWAIT the import result, (c) DESTRUCTURE the module namespace object — extracting named exports as local variables. Each variable created by destructuring should have an IMPORTS_FROM-like edge tracing back to the source module's export. If the graph handles dynamic import as "returns opaque value", the destructured variables lose their connection to the module's exports.

---

## Summary Table

| Gap | Category | Production | Graph Impact |
|-----|----------|-----------|-------------|
| A1. Assignment as subexpression | Expression | 4/5 | HIGH — hidden mutations |
| A2. `typeof` as computed key (dispatch) | Expression | 4/5 | MEDIUM — finite key set |
| A3. Arrow returning assignment | Expression | 2/5 | LOW — mutation + return |
| A4. `void 0` as undefined | Expression | 4/5 | MEDIUM — literal recognition |
| B1. Destructured param → param default | Scope | 3/5 | HIGH — cross-param flow |
| B2. `var` re-declares parameter | Scope | 3/5 | MEDIUM — shared binding |
| B3. Numeric separators | Literal | 3/5 | LOW — value normalization |
| B4. Hashbang comment | Parser | 5/5 | CRITICAL — parse failure |
| B5. Function `.name` inference | Declaration | 4/5 | HIGH — node naming |
| C1. Method vs function-property `super` | Object | 4/5 | HIGH — incorrect super |
| C2. Chain on anonymous expression | Expression | 5/5 | HIGH — orphaned access |
| D1. `new.target` in arrow (constructor) | Class | 3/5 | MEDIUM — factory pattern |
| E1. `for` with comma in update | Loop | 4/5 | MEDIUM — missed counter |
| F1. TS `export =` / `import = require()` | TypeScript | 5/5 | CRITICAL — .d.ts files |
| F2. TS getter/setter different types | TypeScript | 3/5 | MEDIUM — read vs write type |
| F3. TS inline `type` modifier | TypeScript | 5/5 | HIGH — false dependencies |
| F4. TS `this` + destructured param | TypeScript | 2/5 | MEDIUM — off-by-one |
| G1. Async generator in object literal | Interaction | 3/5 | MEDIUM — async+gen+method |
| G2. Chained destructuring assignment | Interaction | 1/5 | LOW — overlapping writes |
| G3. Duplicate keys with spread between | Interaction | 3/5 | MEDIUM — override ordering |
| G4. `in` operator as type guard | Interaction | 5/5 | HIGH — narrowing pattern |
| G5. Destructured dynamic import | Interaction | 5/5 | HIGH — import→variable |
