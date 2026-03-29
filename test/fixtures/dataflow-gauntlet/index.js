// =============================================================================
// Dataflow Gauntlet: One value through every JS passthrough & modification pattern
// =============================================================================
//
// The SEED value "TRACED_VALUE" must be traceable through every path.
// Each section is a distinct JS mechanism. Sections build on each other:
// output of one section feeds into the next where possible.
//
// Naming: variables carrying the original value use `v_<section>_<detail>`.
// Modifications (derived values) use `m_<section>_<detail>`.

const SEED = "TRACED_VALUE";

// =============================================================================
// 1. ASSIGNMENT CHAINS — direct, transitive, compound
// =============================================================================

const v_assign_1 = SEED;
const v_assign_2 = v_assign_1;
const v_assign_3 = v_assign_2;             // 3-level chain
let v_assign_mut = v_assign_3;
v_assign_mut = v_assign_1;                  // reassignment (still same value)

// Modification: string concat
const m_assign_concat = v_assign_3 + "_modified";
const m_assign_template = `prefix_${v_assign_3}_suffix`;

// =============================================================================
// 2. FUNCTION PARAMETERS — positional, default, rest, spread
// =============================================================================

function passthrough(x) {
  return x;
}
const v_fn_simple = passthrough(SEED);

function withDefault(x = SEED) {
  return x;
}
const v_fn_default = withDefault();
const v_fn_default_override = withDefault("OTHER");

function withRest(first, ...rest) {
  return { first, rest };
}
const v_fn_rest_result = withRest(SEED, "a", "b");
// v_fn_rest_result.first === SEED

function spreadCall(...args) {
  return passthrough(...args);
}
const v_fn_spread = spreadCall(SEED);

// =============================================================================
// 3. ARROW FUNCTIONS & IIFE
// =============================================================================

const arrow_identity = (x) => x;
const v_arrow = arrow_identity(SEED);

const arrow_body = (x) => {
  const inner = x;
  return inner;
};
const v_arrow_body = arrow_body(SEED);

const v_iife = ((val) => val)(SEED);

const v_iife_complex = (function (val) {
  const temp = val;
  return temp;
})(SEED);

// =============================================================================
// 4. OBJECT PATTERNS — property, shorthand, computed, spread, nested
// =============================================================================

const obj_simple = { value: SEED };
const v_obj_prop = obj_simple.value;

const key = "value";
const v_obj_computed = obj_simple[key];

const obj_shorthand = { SEED };              // { SEED: "TRACED_VALUE" }

const obj_spread = { ...obj_simple };
const v_obj_spread = obj_spread.value;

const obj_nested = { outer: { inner: { deep: SEED } } };
const v_obj_nested = obj_nested.outer.inner.deep;

// Object.assign
const obj_assigned = Object.assign({}, obj_simple);
const v_obj_assign = obj_assigned.value;

// Getter
const obj_getter = {
  get val() { return SEED; }
};
const v_obj_getter = obj_getter.val;

// Method returning value
const obj_method = {
  _v: SEED,
  get() { return this._v; }
};
const v_obj_method = obj_method.get();

// =============================================================================
// 5. ARRAY PATTERNS — index, spread, destructuring, methods
// =============================================================================

const arr = [SEED, "other"];
const v_arr_index = arr[0];

const arr_spread = [...arr];
const v_arr_spread = arr_spread[0];

const arr_concat = [].concat(arr);
const v_arr_concat = arr_concat[0];

const arr_from = Array.from(arr);
const v_arr_from = arr_from[0];

// Array.of
const arr_of = Array.of(SEED);
const v_arr_of = arr_of[0];

// Slice (passthrough)
const arr_slice = arr.slice(0, 1);
const v_arr_slice = arr_slice[0];

// =============================================================================
// 6. DESTRUCTURING — object, array, nested, renaming, defaults, rest
// =============================================================================

const { value: v_destr_obj } = obj_simple;

const [v_destr_arr] = arr;

const { outer: { inner: { deep: v_destr_nested } } } = obj_nested;

const { value: v_destr_rename } = obj_simple;

const { missing: v_destr_default = SEED } = {};

const [v_destr_first, ...v_destr_rest] = arr;

const { ...v_destr_obj_rest } = obj_simple;
// v_destr_obj_rest.value === SEED

// Destructuring in function params
function destrParam({ value }) {
  return value;
}
const v_destr_param = destrParam(obj_simple);

function destrArrayParam([first]) {
  return first;
}
const v_destr_arr_param = destrArrayParam(arr);

// =============================================================================
// 7. CONTROL FLOW — if/else, switch, ternary, nullish, optional chain
// =============================================================================

// Ternary
const v_cf_ternary = true ? SEED : "never";

// Nullish coalescing
const v_cf_nullish = null ?? SEED;
const v_cf_nullish_skip = SEED ?? "never";

// Optional chaining (passthrough)
const v_cf_optional = obj_nested?.outer?.inner?.deep;

// Logical OR
const v_cf_or = "" || SEED;

// Logical AND
const v_cf_and = "truthy" && SEED;

// if/else — value flows through branch
let v_cf_if;
if (true) {
  v_cf_if = SEED;
} else {
  v_cf_if = "never";
}

// switch
let v_cf_switch;
switch ("match") {
  case "match":
    v_cf_switch = SEED;
    break;
  default:
    v_cf_switch = "never";
}

// Logical assignment
let v_cf_logical_or = null;
v_cf_logical_or ||= SEED;

let v_cf_logical_nullish = undefined;
v_cf_logical_nullish ??= SEED;

// =============================================================================
// 8. LOOPS — for, for-of, for-in, while, do-while, forEach, reduce
// =============================================================================

// for — value into accumulator
const arr_for_input = [SEED, SEED, SEED];
const v_loop_for_results = [];
for (let i = 0; i < arr_for_input.length; i++) {
  v_loop_for_results.push(arr_for_input[i]);
}
// v_loop_for_results[0] === SEED

// for-of
const v_loop_forof_results = [];
for (const item of arr_for_input) {
  v_loop_forof_results.push(item);
}

// for-in — value on object
const obj_for_in = { a: SEED };
let v_loop_forin;
for (const k in obj_for_in) {
  v_loop_forin = obj_for_in[k];
}

// while
let v_loop_while;
let _i = 0;
while (_i < 1) {
  v_loop_while = SEED;
  _i++;
}

// do-while
let v_loop_dowhile;
do {
  v_loop_dowhile = SEED;
} while (false);

// forEach
let v_loop_foreach;
[SEED].forEach((item) => {
  v_loop_foreach = item;
});

// map (modification)
const m_loop_map = [SEED].map((item) => item + "_mapped");

// filter (passthrough)
const v_loop_filter = [SEED, "other"].filter((item) => item === SEED);
// v_loop_filter[0] === SEED

// reduce
const v_loop_reduce = [SEED].reduce((acc, item) => item, null);

// find
const v_loop_find = [SEED, "other"].find((item) => item === SEED);

// flatMap
const v_loop_flatmap = [SEED].flatMap((item) => [item]);
// v_loop_flatmap[0] === SEED

// =============================================================================
// 9. CLOSURES & HIGHER-ORDER FUNCTIONS
// =============================================================================

function makeGetter(val) {
  return function () {
    return val;
  };
}
const v_closure = makeGetter(SEED)();

function applyFn(fn, arg) {
  return fn(arg);
}
const v_hof = applyFn((x) => x, SEED);

// Closure over outer variable
const outerVal = SEED;
function closureOuter() {
  return outerVal;
}
const v_closure_outer = closureOuter();

// Currying
function curry(a) {
  return function (b) {
    return a;
  };
}
const v_curry = curry(SEED)("ignored");

// Composition
const compose = (f, g) => (x) => f(g(x));
const v_compose = compose((x) => x, (x) => x)(SEED);

// =============================================================================
// 10. PROMISES & ASYNC/AWAIT
// =============================================================================

// Promise.resolve passthrough
const v_promise_resolve = Promise.resolve(SEED);
// await v_promise_resolve === SEED

// Promise constructor
const v_promise_ctor = new Promise((resolve) => resolve(SEED));

// .then chain (passthrough)
const v_promise_then = Promise.resolve(SEED)
  .then((val) => val)
  .then((val) => val);

// .then chain (modification)
const m_promise_then = Promise.resolve(SEED)
  .then((val) => val + "_async");

// async/await passthrough
async function asyncPassthrough(val) {
  const result = await Promise.resolve(val);
  return result;
}
const v_async_fn = asyncPassthrough(SEED);

// async arrow
const asyncArrow = async (val) => {
  const inner = await val;
  return inner;
};
const v_async_arrow = asyncArrow(Promise.resolve(SEED));

// Promise.all
const v_promise_all = Promise.all([Promise.resolve(SEED)]);
// (await v_promise_all)[0] === SEED

// Promise.race
const v_promise_race = Promise.race([Promise.resolve(SEED)]);

// async IIFE
const v_async_iife = (async () => {
  return SEED;
})();

// =============================================================================
// 11. CLASSES — constructor, method, static, getter, inheritance, private
// =============================================================================

class Container {
  #value;

  constructor(val) {
    this.value = val;
    this.#value = val;
  }

  get() {
    return this.value;
  }

  getPrivate() {
    return this.#value;
  }

  static wrap(val) {
    return new Container(val);
  }

  static passthrough(val) {
    return val;
  }

  get prop() {
    return this.value;
  }

  set prop(val) {
    this.value = val;
  }

  transform(fn) {
    return new Container(fn(this.value));
  }

  [Symbol.toPrimitive]() {
    return this.value;
  }
}

const container = new Container(SEED);
const v_class_get = container.get();
const v_class_private = container.getPrivate();
const v_class_static = Container.wrap(SEED).get();
const v_class_static_passthrough = Container.passthrough(SEED);
const v_class_getter = container.prop;
const v_class_transform = container.transform((x) => x).get();

// Inheritance
class DerivedContainer extends Container {
  constructor(val) {
    super(val);
    this.derived = true;
  }

  getDerived() {
    return super.get();
  }
}

const derived = new DerivedContainer(SEED);
const v_class_inherit = derived.get();
const v_class_super = derived.getDerived();

// =============================================================================
// 12. GENERATORS & ITERATORS
// =============================================================================

function* genPassthrough(val) {
  yield val;
}
const v_gen = genPassthrough(SEED).next().value;

function* genMultiple(val) {
  const inner = val;
  yield inner;
  yield inner;
}
const v_gen_multi = [...genMultiple(SEED)];
// v_gen_multi[0] === SEED

// yield*
function* genDelegate(val) {
  yield* genPassthrough(val);
}
const v_gen_delegate = genDelegate(SEED).next().value;

// Generator as iterable
function* genIterable() {
  yield SEED;
}
const [v_gen_destr] = genIterable();

// Infinite generator with value
function* genInfinite(val) {
  while (true) {
    yield val;
  }
}
const genIter = genInfinite(SEED);
const v_gen_inf = genIter.next().value;

// Async generator
async function* asyncGen(val) {
  yield await Promise.resolve(val);
}

// =============================================================================
// 13. CALLBACKS & EVENT PATTERNS
// =============================================================================

function withCallback(val, cb) {
  cb(val);
}
let v_callback;
withCallback(SEED, (result) => {
  v_callback = result;
});

// Callback chain
function chainCallbacks(val, cb1, cb2) {
  cb1(val, (intermediate) => {
    cb2(intermediate);
  });
}
let v_callback_chain;
chainCallbacks(
  SEED,
  (val, next) => next(val),
  (val) => { v_callback_chain = val; }
);

// Event emitter pattern
class Emitter {
  constructor() {
    this.listeners = {};
  }
  on(event, fn) {
    (this.listeners[event] ||= []).push(fn);
  }
  emit(event, data) {
    (this.listeners[event] || []).forEach((fn) => fn(data));
  }
}

const emitter = new Emitter();
let v_event;
emitter.on("data", (val) => { v_event = val; });
emitter.emit("data", SEED);

// setTimeout/setInterval (value capture)
let v_timeout;
setTimeout(() => { v_timeout = SEED; }, 0);

// =============================================================================
// 14. TRY/CATCH/FINALLY — CFG exception paths
// =============================================================================

let v_try_normal;
try {
  v_try_normal = SEED;
} catch (e) {
  v_try_normal = "never";
}

// Value through throw/catch
let v_try_catch;
try {
  throw SEED;
} catch (e) {
  v_try_catch = e;
}

// Finally passthrough
let v_try_finally;
try {
  v_try_finally = SEED;
} finally {
  // v_try_finally is still SEED
}

// Nested try/catch
let v_try_nested;
try {
  try {
    throw SEED;
  } catch (inner) {
    throw inner;          // re-throw
  }
} catch (outer) {
  v_try_nested = outer;
}

// =============================================================================
// 15. MAP, SET, WEAKMAP, WEAKREF — collection passthrough
// =============================================================================

const map = new Map();
map.set("key", SEED);
const v_map_get = map.get("key");

const v_map_entries = [...map.entries()];
// v_map_entries[0][1] === SEED

const v_map_values = [...map.values()];
// v_map_values[0] === SEED

const set = new Set([SEED]);
const v_set_has = set.has(SEED);             // true, but value is boolean
const v_set_spread = [...set];               // v_set_spread[0] === SEED

const weakmap = new WeakMap();
const _wm_key = {};
weakmap.set(_wm_key, SEED);
const v_weakmap = weakmap.get(_wm_key);

// =============================================================================
// 16. PROXY & REFLECT
// =============================================================================

const proxy = new Proxy({ value: SEED }, {
  get(target, prop) {
    return Reflect.get(target, prop);
  },
  set(target, prop, val) {
    return Reflect.set(target, prop, val);
  }
});
const v_proxy_get = proxy.value;

proxy.value = SEED;
const v_proxy_set = proxy.value;

// Proxy wrapping function
const fnProxy = new Proxy(passthrough, {
  apply(target, thisArg, args) {
    return Reflect.apply(target, thisArg, args);
  }
});
const v_proxy_fn = fnProxy(SEED);

// =============================================================================
// 17. SYMBOL, WELL-KNOWN SYMBOLS
// =============================================================================

const sym = Symbol("traced");
const obj_sym = { [sym]: SEED };
const v_symbol = obj_sym[sym];

// Symbol.iterator
class IterableContainer {
  constructor(val) { this.val = val; }
  [Symbol.iterator]() {
    let done = false;
    const val = this.val;
    return {
      next() {
        if (!done) { done = true; return { value: val, done: false }; }
        return { value: undefined, done: true };
      }
    };
  }
}
const [v_symbol_iter] = new IterableContainer(SEED);

// =============================================================================
// 18. TAGGED TEMPLATES & TEMPLATE LITERALS
// =============================================================================

function tag(strings, ...values) {
  return values[0];
}
const v_tagged = tag`prefix ${SEED} suffix`;

// Raw passthrough tag
function raw(strings, ...values) {
  return String.raw(strings, ...values);
}
const m_tagged_raw = raw`before_${SEED}_after`;

// =============================================================================
// 19. EVAL & DYNAMIC PATTERNS (static analysis boundaries)
// =============================================================================

// eval — opaque to static analysis
// const v_eval = eval('SEED');   // intentionally commented: untraceable

// Function constructor — also opaque
// const v_fn_ctor = new Function('return "TRACED_VALUE"')();

// Indirect call
const indirectPassthrough = passthrough;
const v_indirect = indirectPassthrough(SEED);

// Computed method name
const methodName = "get";
const v_computed_method = obj_method[methodName]();

// =============================================================================
// 20. MODULE PATTERNS — CommonJS & ESM (as expressions)
// =============================================================================

// CommonJS-style
const mod_cjs = { exports: {} };
mod_cjs.exports.value = SEED;
const v_cjs = mod_cjs.exports.value;

// Factory pattern
function createModule(val) {
  return {
    getValue() { return val; },
    value: val
  };
}
const mod = createModule(SEED);
const v_factory_method = mod.getValue();
const v_factory_prop = mod.value;

// =============================================================================
// 21. WEAKREF & FINALIZATIONREGISTRY
// =============================================================================

const weakRefTarget = { value: SEED };
const weakRef = new WeakRef(weakRefTarget);
const v_weakref = weakRef.deref()?.value;

// =============================================================================
// 22. STRUCTURED CLONE / JSON ROUND-TRIP (modification boundaries)
// =============================================================================

const obj_json = { value: SEED };
const m_json_roundtrip = JSON.parse(JSON.stringify(obj_json));
// m_json_roundtrip.value === SEED (but identity is lost)

// structuredClone
const m_structured_clone = structuredClone(obj_json);
// m_structured_clone.value === SEED

// =============================================================================
// 23. COMMA OPERATOR, VOID, TYPEOF, SEQUENCE
// =============================================================================

const v_comma = (0, SEED);                  // comma operator: returns last

const v_typeof = typeof SEED;               // "string" — modification
// void SEED === undefined                   // void kills value

// Sequence in for-loop init
let v_seq;
for (v_seq = SEED, _i = 0; _i < 1; _i++) {}
// v_seq === SEED

// =============================================================================
// 24. LABEL, BREAK, CONTINUE — CFG jumps
// =============================================================================

let v_label;
outer: for (let i = 0; i < 2; i++) {
  for (let j = 0; j < 2; j++) {
    if (j === 1) {
      v_label = SEED;
      break outer;
    }
  }
}

let v_continue;
const v_continue_results = [];
for (let i = 0; i < 3; i++) {
  if (i === 0) continue;
  v_continue = SEED;
  v_continue_results.push(SEED);
}
// v_continue === SEED, v_continue_results.length === 2

// =============================================================================
// 25. WITH STATEMENT (legacy, sloppy mode only)
// =============================================================================

// `with` is forbidden in strict mode; included for completeness
// with ({ SEED }) { v_with = SEED; }

// =============================================================================
// 26. COMPLEX COMPOSITIONS — real-world patterns
// =============================================================================

// Promise → destructure → class → callback
async function complexPipeline() {
  const resolved = await Promise.resolve({ value: SEED });
  const { value } = resolved;
  const c = new Container(value);
  return new Promise((resolve) => {
    withCallback(c.get(), (result) => {
      resolve(result);
    });
  });
}

// Reduce → Map → generator
function* reduceMapGen(items) {
  const mapped = items.map((x) => ({ wrapped: x }));
  const reduced = mapped.reduce((acc, item) => {
    acc.push(item.wrapped);
    return acc;
  }, []);
  for (const val of reduced) {
    yield val;
  }
}
const v_complex_rmg = [...reduceMapGen([SEED])];
// v_complex_rmg[0] === SEED

// Nested closures → async → destructure
function outerClosure(val) {
  return async function () {
    const wrapped = await Promise.resolve({ data: val });
    const { data } = wrapped;
    return data;
  };
}
const v_complex_closure = outerClosure(SEED);
// await v_complex_closure() === SEED

// Method chaining (builder pattern)
class Builder {
  constructor() { this.parts = []; }
  add(val) { this.parts.push(val); return this; }
  build() { return this.parts; }
}
const v_builder = new Builder().add(SEED).build();
// v_builder[0] === SEED

// Recursive passthrough
function recurse(val, depth) {
  if (depth <= 0) return val;
  return recurse(val, depth - 1);
}
const v_recurse = recurse(SEED, 5);

// Mutual recursion
function pingpongA(val, n) {
  if (n <= 0) return val;
  return pingpongB(val, n - 1);
}
function pingpongB(val, n) {
  return pingpongA(val, n);
}
const v_mutual_recurse = pingpongA(SEED, 4);

// Async iteration + transform pipeline
async function asyncPipeline() {
  async function* source() {
    yield SEED;
  }

  const collected = [];
  for await (const val of source()) {
    collected.push(val);
  }

  return collected
    .map((x) => ({ v: x }))
    .filter((x) => x.v === SEED)
    .map((x) => x.v)[0];
}

// =============================================================================
// EXPORTS — one object for all traced values, grouped by section
// =============================================================================

export {
  SEED,

  // 1. Assignment
  v_assign_1, v_assign_2, v_assign_3, v_assign_mut,
  m_assign_concat, m_assign_template,

  // 2. Function params
  v_fn_simple, v_fn_default, v_fn_default_override, v_fn_rest_result, v_fn_spread,

  // 3. Arrow / IIFE
  v_arrow, v_arrow_body, v_iife, v_iife_complex,

  // 4. Objects
  v_obj_prop, v_obj_computed, v_obj_spread, v_obj_nested,
  v_obj_assign, v_obj_getter, v_obj_method,

  // 5. Arrays
  v_arr_index, v_arr_spread, v_arr_concat, v_arr_from, v_arr_of, v_arr_slice,

  // 6. Destructuring
  v_destr_obj, v_destr_arr, v_destr_nested, v_destr_rename, v_destr_default,
  v_destr_first, v_destr_rest, v_destr_obj_rest, v_destr_param, v_destr_arr_param,

  // 7. Control flow
  v_cf_ternary, v_cf_nullish, v_cf_nullish_skip, v_cf_optional,
  v_cf_or, v_cf_and, v_cf_if, v_cf_switch,
  v_cf_logical_or, v_cf_logical_nullish,

  // 8. Loops
  v_loop_for_results, v_loop_forof_results, v_loop_forin,
  v_loop_while, v_loop_dowhile, v_loop_foreach,
  m_loop_map, v_loop_filter, v_loop_reduce, v_loop_find, v_loop_flatmap,

  // 9. Closures / HOF
  v_closure, v_hof, v_closure_outer, v_curry, v_compose,

  // 10. Promises / async
  v_promise_resolve, v_promise_ctor, v_promise_then, m_promise_then,
  v_async_fn, v_async_arrow, v_promise_all, v_promise_race, v_async_iife,

  // 11. Classes
  v_class_get, v_class_private, v_class_static, v_class_static_passthrough,
  v_class_getter, v_class_transform, v_class_inherit, v_class_super,

  // 12. Generators
  v_gen, v_gen_multi, v_gen_delegate, v_gen_destr, v_gen_inf,

  // 13. Callbacks / events
  v_callback, v_callback_chain, v_event, v_timeout,

  // 14. Try/catch
  v_try_normal, v_try_catch, v_try_finally, v_try_nested,

  // 15. Collections
  v_map_get, v_map_entries, v_map_values, v_set_has, v_set_spread, v_weakmap,

  // 16. Proxy / Reflect
  v_proxy_get, v_proxy_set, v_proxy_fn,

  // 17. Symbol
  v_symbol, v_symbol_iter,

  // 18. Tagged templates
  v_tagged, m_tagged_raw,

  // 19. Indirect / computed
  v_indirect, v_computed_method,

  // 20. Module patterns
  v_cjs, v_factory_method, v_factory_prop,

  // 21. WeakRef
  v_weakref,

  // 22. Clone / JSON
  m_json_roundtrip, m_structured_clone,

  // 23. Comma / sequence
  v_comma, v_typeof, v_seq,

  // 24. Label / break / continue
  v_label, v_continue_results,

  // 26. Complex compositions
  complexPipeline, v_complex_rmg, v_complex_closure, v_builder,
  v_recurse, v_mutual_recurse, asyncPipeline,
};
