# Syntax Corpus — Gaps Round 4

Reviewed all 26 source files, GAPS.md, GAPS-2.md, and GAPS-3.md. Focus: constructs
and interactions NOT covered by the corpus OR prior gap documents.

Verified every item against the actual `@construct` tags and source code.

---

## A. Generator Protocol Gaps

### A1. Generator `.throw()` external error injection
**Production: 3/5** — observable in test frameworks (jest.runAllTimers, manual generator stepping), co/redux-saga-like middleware.

```js
function* resilient() {
  try {
    const x = yield 'ready';
    return x * 2;
  } catch (err) {
    // Catch point — triggered by gen.throw(), NOT a throw inside the body
    yield `recovered: ${err.message}`;
    return -1;
  }
}

const gen = resilient();
gen.next();               // → { value: 'ready', done: false }
gen.throw(new Error('injected'));
// → { value: 'recovered: injected', done: false }
// The error appears AT the yield site, triggers the catch block
```

**Graph impact:** The corpus has `generator-return-throw` (external `.return()`) and `generator-finally-yield-trap` (try/finally), but `.throw()` is the third generator method and has unique semantics: it injects an exception **at the yield point**, routing execution to the nearest `catch` inside the generator body. The graph needs:
- A METHOD_CALL node for `gen.throw(err)` (on the GENERATOR OBJECT)
- A CALLS edge from that METHOD_CALL to the `catch` block's scope (cross-node control flow)
- A PASSES_ARGUMENT edge for `err` flowing into the catch binding
- This is distinct from `gen.return()` — `.return()` goes to finally, `.throw()` goes to catch

Without this, a taint analysis cannot trace data flowing into a generator's catch branch via external `.throw()` injection.

---

### A2. `for...of` break triggering custom iterator `.return()`
**Production: 3/5** — early exit from lazy sequences, resource cleanup iterators.

```js
// The iterator protocol: .return() is called when for-of exits early
const resourceIter = {
  [Symbol.iterator]() {
    let open = true;
    return {
      next() {
        return open ? { value: 'data', done: false } : { done: true };
      },
      return(value) {
        open = false;          // cleanup — called by break, throw, return
        console.log('closed');
        return { value, done: true };
      }
    };
  }
};

for (const item of resourceIter) {
  process(item);
  break;   // ← this triggers .return() on the iterator object
}
```

**Graph impact:** The corpus has `iter-return-cleanup` (defines iterator with `.return()`) and `iter-take` (uses `break` in `for-of`) but no construct explicitly models the **causal link**: `break` → CALLS → `.return()`. This is a hidden CALLS edge that is NOT syntactically visible — the `break` statement implicitly dispatches to `.return()` on the current iterator. Without this edge:
- Impact analysis misses that changing iterator cleanup affects all break-using consumers
- Dead code detection incorrectly marks `.return()` as unreachable
- Resource leak detection cannot trace that early loop exit triggers cleanup

---

## B. Object / Property Pattern Gaps

### B1. Lazy getter self-replacement (memoization via defineProperty)
**Production: 3/5** — performance-critical lazy initialization, Node.js module exports, computed properties.

```js
class Config {
  get expensive() {
    const result = computeExpensive();    // run once
    Object.defineProperty(this, 'expensive', {
      value: result,
      writable: false,
      configurable: false,
    });
    return result;
  }
}
```

**Graph impact:** This is a getter that **replaces itself** on first access. The graph currently models getters as METHOD nodes with a CALLS edge from `get expensive`. But after first access:
1. The property transitions from accessor descriptor to data descriptor
2. Subsequent accesses bypass the getter entirely — they return the stored value
3. `Object.defineProperty(this, 'expensive', ...)` creates a PROPERTY_MUTATION on `this` where the key is the SAME as the getter's name

The required edges are:
- PROPERTY_MUTATION on `this` where target is the getter's own name (self-mutation)
- CALLS edge from the getter body to `Object.defineProperty` (not modeled for class instance getters)
- The CALLS chain transitions from getter CALLS → data value RETURNS (after first call)

Without this, data flow analysis sees infinite recursive access; the memoization contract is invisible to the graph.

---

### B2. Proxy "method missing" / dynamic API synthesis
**Production: 3/5** — fluent query builders, test doubles, remote proxy objects (RPC stubs).

```js
// get trap returns a synthesized function for EVERY property name
const api = new Proxy({}, {
  get(target, method) {
    return (...args) => fetch(`/api/${method}`, {
      method: 'POST',
      body: JSON.stringify(args),
    });
  }
});

// api.getUser(1)  → POST /api/getUser [1]
// api.createPost({}) → POST /api/createPost [{}]
// NONE of these methods exist as actual properties/functions
```

**Graph impact:** The corpus has `prop-proxy-traps` covering all 13 traps with `Reflect.get` delegation. But this pattern is categorically different: the `get` trap **synthesizes a new arrow function** per property access. There is no underlying target object with real properties. The graph impact:
- Every PROPERTY_ACCESS on `api.*` should have an unresolved CALLS target (the synthesized arrow)
- The synthesized arrow has a CALLS edge to `fetch` that is invisible from outside
- All calls like `api.getUser()` look like METHOD_CALL nodes but resolve to the same synthesized code path
- This is the "method missing" / `__getattr__` pattern that makes static analysis fundamentally hard

The annotation vocabulary needs a way to mark "all property accesses dynamically resolved via Proxy.get" as a class of UNRESOLVED_DISPATCH edges.

---

### B3. WeakMap as private instance data pattern
**Production: 3/5** — pre-`#field` code, polyfills, code that needs WeakMap's specific semantics.

```js
// Classic pattern before private class fields
const _data = new WeakMap();

class SafeCounter {
  constructor(initial = 0) {
    _data.set(this, { count: initial, history: [] });
  }

  increment() {
    const d = _data.get(this);
    d.history.push(d.count);
    d.count++;
  }

  get value() {
    return _data.get(this).count;
  }
}
```

**Graph impact:** The corpus has `builtins.js` with `WeakMap` and `WeakRef` usage but NOT this architectural pattern. The key difference:
- `_data` is a MODULE-LEVEL VARIABLE whose value is used as a **private namespace**
- `_data.set(this, {...})` creates a PROPERTY_MUTATION on `this` (conceptually) but through indirection
- `_data.get(this)` is a property READ of that conceptual private state
- The graph must trace that `_data.get(this).count` accesses the same data structure as `_data.set(this, {count: initial})`

Without modeling WeakMap-as-private, data flow for the most common pre-ES2022 encapsulation pattern is broken. The graph sees `_data.get(this)` as an unresolved dynamic access instead of tracing it to the constructor's `_data.set`.

---

## C. TypeScript-Specific Gaps

### C1. Function + namespace declaration merge
**Production: 3/5** — libraries that attach utility methods to callable functions (e.g., `styled-components`, custom validators).

```ts
// Function callable as function AND as namespace for sub-utilities
function validate(value: unknown): boolean {
  return value !== null && value !== undefined;
}

namespace validate {
  export function strict(value: unknown): boolean {
    if (value === null) throw new Error('null not allowed');
    if (value === undefined) throw new Error('undefined not allowed');
    return true;
  }

  export const VERSION = '1.0.0';
}

// Usage:
validate(someValue);          // calls the function
validate.strict(someValue);   // calls the namespace export
```

**Graph impact:** The corpus has class+interface merges (`ts-class-interface-merge`) and enum+namespace merges (`ts-enum-merge`), but function+namespace merge is absent. This is particularly important because:
- The FUNCTION node for `validate` and the MODULE/NAMESPACE node for `validate` share the same identifier
- `validate.strict(x)` creates a METHOD_CALL that resolves to the NAMESPACE's FUNCTION, NOT a method on the function object
- The `namespace` block creates a sub-scope with its own FUNCTION nodes and EXPORTS edges
- Without this, the graph either merges both into one FUNCTION (wrong) or creates two conflicting nodes with the same name (wrong)

---

### C2. `accessor` keyword with decorator
**Production: 2/5** — Stage 3 decorators, Angular/NestJS-style reactive properties.

```ts
function reactive(target: ClassAccessorDecoratorTarget<any, any>, context: ClassAccessorDecoratorContext) {
  return {
    get() {
      const val = target.get.call(this);
      console.log(`read ${String(context.name)}`);
      return val;
    },
    set(value: any) {
      console.log(`write ${String(context.name)} = ${value}`);
      target.set.call(this, value);
    },
  };
}

class ReactiveModel {
  @reactive accessor title = 'untitled';
  @reactive accessor count = 0;
}
```

**Graph impact:** The corpus has `class-accessor-keyword` (modern-es.js) and `ts-parameter-decorators` / `ts-decorator-metadata` (ts-specific.ts) but no construct combining `accessor` + decorator. The `accessor` keyword desugars into a private backing field + getter + setter. When a decorator wraps it, the decorator receives `{get, set}` accessors and returns replacement `{get, set}`. The graph needs:
- A DECORATOR node for `@reactive` applied to the accessor
- CALLS edges: decorator body → `target.get.call(this)` and `target.set.call(this, value)`
- The private backing field generated by `accessor` desugaring
- The replaced getter/setter from the decorator's return value

Without this, the graph cannot see that `@reactive accessor title` has intercepted reads/writes — critical for reactivity framework analysis.

---

## D. Expression / Operator Gaps

### D1. Operator-triggered `Symbol.toPrimitive` / `valueOf` dispatch
**Production: 3/5** — date arithmetic, money/unit types, custom numeric types.

```js
class Money {
  constructor(amount, currency) {
    this.amount = amount;
    this.currency = currency;
  }

  [Symbol.toPrimitive](hint) {
    if (hint === 'number') return this.amount;
    if (hint === 'string') return `${this.amount} ${this.currency}`;
    return this.amount;  // 'default'
  }

  valueOf() {
    return this.amount;
  }
}

const price = new Money(10, 'USD');
const tax = new Money(1.5, 'USD');

const total = price + tax;          // → 11.5  (invokes valueOf or toPrimitive 'default')
const isExpensive = price > 100;    // → false (invokes toPrimitive 'number')
const display = `${price}`;         // → "10 USD" (invokes toPrimitive 'string')
const doubled = price * 2;          // → 20    (invokes toPrimitive 'number')
```

**Graph impact:** The corpus has `proto-symbol-hasinstance` and `Symbol.toPrimitive` usage inside `WithComputedMethods` (classes.js), but NO construct models the **operator-to-method CALLS edge**. The binary `+`, `-`, `*`, `>`, template literal interpolation all implicitly CALL `Symbol.toPrimitive` or `valueOf` on their operands. Without these edges:
- The graph misses implicit CALLS edges from every arithmetic expression involving custom objects
- Data flow from `valueOf()` return value is disconnected from the operator's result
- Security analysis cannot see that user-controlled input flows through `toPrimitive` into arithmetic operations
- Dead code detection may incorrectly mark `valueOf` / `[Symbol.toPrimitive]` as unreachable

This is an annotation gap as much as an analysis gap: the annotation vocabulary must establish that binary operators (and template interpolation, and type coercions) create implicit CALLS edges to coercion methods.

---

### D2. Sequential `await` as subexpressions in a single statement
**Production: 4/5** — concurrent value retrieval, conditional async chains, mixed sync/async computations.

```js
async function fetchAndCombine() {
  // Multiple awaits in a single expression — evaluated sequentially, not concurrently
  const sum = (await getA()) + (await getB());

  // Await in conditional expression
  const result = condition
    ? await fetchSuccess()
    : await fetchFallback();

  // Await in array literal — sequential
  const all = [await loadHeader(), await loadBody(), await loadFooter()];

  // Mixed: await inside function arguments
  const combined = merge(await getConfig(), await getDefaults(), overrides);
}
```

**Graph impact:** The corpus has `await-comma-expression` (expressions.js) and many `async`/`await` constructs in `async-generators.js`. But these show await in **statement position** or as a single await per expression. The interaction gap is:
- Multiple `await` nodes within a single BinaryExpression/ArrayExpression/CallExpression
- Each creates an implicit sequential dependency: `getA()` must resolve before `getB()` starts
- The graph should model DEPENDS_ON edges between sequential awaits within the same expression
- `Promise.all([getA(), getB()])` is CONCURRENT; `[await getA(), await getB()]` is SEQUENTIAL — they look similar but have different CALLS topology

Without this, the graph cannot distinguish sequential await chains from concurrent Promise.all patterns — critical for async performance analysis and deadlock detection.
