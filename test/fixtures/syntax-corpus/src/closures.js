// =============================================================================
// closures.js — Closures, Scope Crossing, this Binding, Factories
// =============================================================================

// --- Module-level shared state ---

// @construct PENDING closure-module-var-read
// @annotation
// UNKNOWN <<module>> -> DECLARES -> VARIABLE <<requestCount>>
// VARIABLE <<requestCount>> -> ASSIGNED_FROM -> LITERAL <<0>>
// UNKNOWN <<module>> -> DECLARES -> FUNCTION <<getRequestCount>>
// FUNCTION <<getRequestCount>> -> READS_FROM -> VARIABLE <<requestCount>>
// FUNCTION <<getRequestCount>> -> RETURNS -> VARIABLE <<requestCount>>
// FUNCTION <<getRequestCount>> -> CAPTURES -> VARIABLE <<requestCount>>
// @end-annotation
let requestCount = 0;

function getRequestCount() {
  return requestCount;
}

// @construct PENDING closure-module-var-write
// @annotation
// UNKNOWN <<module>> -> DECLARES -> FUNCTION <<incrementRequestCount>>
// FUNCTION <<incrementRequestCount>> -> CONTAINS -> EXPRESSION <<requestCount++>>
// EXPRESSION <<requestCount++>> -> READS_FROM -> UNKNOWN <<requestCount>>
// EXPRESSION <<requestCount++>> -> WRITES_TO -> UNKNOWN <<requestCount>>
// @end-annotation
function incrementRequestCount() {
  requestCount++;
}

// @construct PENDING closure-shared-state
let sharedCache = {};

function setCache(key, value) {
  sharedCache[key] = value;
}

function getCache(key) {
  return sharedCache[key];
}

function clearCache() {
  sharedCache = {};
}

// --- Factory functions returning closures ---

// @construct PENDING closure-factory-counter
// @annotation
// FUNCTION <<createCounter>> -> CONTAINS -> PARAMETER <<initial>>
// PARAMETER <<initial>> -> DEFAULTS_TO -> LITERAL <<0>>
// FUNCTION <<createCounter>> -> CONTAINS -> VARIABLE <<count>>
// VARIABLE <<count>> -> ASSIGNED_FROM -> PARAMETER <<initial>>
// FUNCTION <<createCounter>> -> RETURNS -> LITERAL <<{...}>>
// LITERAL <<{...}>> -> HAS_PROPERTY -> METHOD <<increment>>
// LITERAL <<{...}>> -> HAS_PROPERTY -> METHOD <<decrement>>
// LITERAL <<{...}>> -> HAS_PROPERTY -> METHOD <<value>>
// METHOD <<increment>> -> RETURNS -> EXPRESSION <<++count>>
// EXPRESSION <<++count>> -> MODIFIES -> VARIABLE <<count>>
// METHOD <<decrement>> -> RETURNS -> EXPRESSION <<--count>>
// EXPRESSION <<--count>> -> MODIFIES -> VARIABLE <<count>>
// METHOD <<value>> -> RETURNS -> VARIABLE <<count>>
// METHOD <<increment>> -> CAPTURES -> VARIABLE <<count>>
// METHOD <<decrement>> -> CAPTURES -> VARIABLE <<count>>
// METHOD <<value>> -> CAPTURES -> VARIABLE <<count>>
// @end-annotation
function createCounter(initial = 0) {
  let count = initial;
  return {
    increment() { return ++count; },
    decrement() { return --count; },
    value() { return count; },
  };
}

// @construct PENDING closure-factory-multiplier
// @annotation
// FUNCTION <<createMultiplier>> -> HAS_BODY -> PARAMETER <<factor>>
// FUNCTION <<createMultiplier>> -> RETURNS -> FUNCTION <<createMultiplier:returnFn>>
// FUNCTION <<createMultiplier:returnFn>> -> HAS_BODY -> PARAMETER <<x>>
// FUNCTION <<createMultiplier:returnFn>> -> RETURNS -> EXPRESSION <<x * factor>>
// EXPRESSION <<x * factor>> -> READS_FROM -> PARAMETER <<x>>
// EXPRESSION <<x * factor>> -> READS_FROM -> PARAMETER <<factor>>
// FUNCTION <<createMultiplier:returnFn>> -> CAPTURES -> PARAMETER <<factor>>
// @end-annotation
function createMultiplier(factor) {
  return (x) => x * factor;
}

// @construct PENDING closure-factory-accumulator
function createAccumulator() {
  const items = [];
  return {
    add(item) { items.push(item); },
    getAll() { return [...items]; },
    count() { return items.length; },
  };
}

// --- Closure over loop variable ---

// @construct PENDING closure-loop-var-bug
// @annotation
// FUNCTION <<closureLoopVarBug>> -> CONTAINS -> VARIABLE <<funcs>>
// VARIABLE <<funcs>> -> ASSIGNED_FROM -> LITERAL <<[]>>
// FUNCTION <<closureLoopVarBug>> -> CONTAINS -> LOOP <<for-loop>>
// LOOP <<for-loop>> -> CONTAINS -> VARIABLE <<i>>
// VARIABLE <<i>> -> ASSIGNED_FROM -> LITERAL <<0>>
// LOOP <<for-loop>> -> HAS_CONDITION -> EXPRESSION <<i < 5>>
// EXPRESSION <<i < 5>> -> READS_FROM -> VARIABLE <<i>>
// EXPRESSION <<i < 5>> -> READS_FROM -> LITERAL <<5>>
// LOOP <<for-loop>> -> HAS_UPDATE -> EXPRESSION <<i++>>
// EXPRESSION <<i++>> -> MODIFIES -> VARIABLE <<i>>
// LOOP <<for-loop>> -> HAS_BODY -> CALL <<funcs.push(...)>>
// CALL <<funcs.push(...)>> -> CALLS_ON -> VARIABLE <<funcs>>
// CALL <<funcs.push(...)>> -> PASSES_ARGUMENT -> FUNCTION <<anonymous-closure>>
// FUNCTION <<anonymous-closure>> -> RETURNS -> EXPRESSION <<return i>>
// EXPRESSION <<return i>> -> READS_FROM -> VARIABLE <<i>>
// FUNCTION <<anonymous-closure>> -> CAPTURES -> VARIABLE <<i>>
// FUNCTION <<closureLoopVarBug>> -> RETURNS -> VARIABLE <<funcs>>
// @end-annotation
function closureLoopVarBug() {
  const funcs = [];
  for (var i = 0; i < 5; i++) {
    funcs.push(function () { return i; });
  }
  return funcs; // all return 5
}

// @construct PENDING closure-loop-let-fix
// @annotation
// FUNCTION <<closureLoopLetFix>> -> CONTAINS -> VARIABLE <<funcs>>
// VARIABLE <<funcs>> -> ASSIGNED_FROM -> LITERAL <<[]>>
// FUNCTION <<closureLoopLetFix>> -> CONTAINS -> LOOP <<for-loop>>
// LOOP <<for-loop>> -> CONTAINS -> VARIABLE <<i>>
// VARIABLE <<i>> -> ASSIGNED_FROM -> LITERAL <<0>>
// LOOP <<for-loop>> -> HAS_CONDITION -> EXPRESSION <<i < 5>>
// EXPRESSION <<i < 5>> -> READS_FROM -> VARIABLE <<i>>
// EXPRESSION <<i < 5>> -> READS_FROM -> LITERAL <<5>>
// LOOP <<for-loop>> -> HAS_UPDATE -> EXPRESSION <<i++>>
// EXPRESSION <<i++>> -> MODIFIES -> VARIABLE <<i>>
// LOOP <<for-loop>> -> HAS_BODY -> CALL <<funcs.push(...)>>
// CALL <<funcs.push(...)>> -> CALLS -> PROPERTY_ACCESS <<funcs.push>>
// PROPERTY_ACCESS <<funcs.push>> -> READS_FROM -> VARIABLE <<funcs>>
// CALL <<funcs.push(...)>> -> PASSES_ARGUMENT -> FUNCTION <<anonymous-closure>>
// FUNCTION <<anonymous-closure>> -> CAPTURES -> VARIABLE <<i>>
// FUNCTION <<anonymous-closure>> -> RETURNS -> VARIABLE <<i>>
// FUNCTION <<closureLoopLetFix>> -> RETURNS -> VARIABLE <<funcs>>
// @end-annotation
function closureLoopLetFix() {
  const funcs = [];
  for (let i = 0; i < 5; i++) {
    funcs.push(function () { return i; });
  }
  return funcs; // each returns 0,1,2,3,4
}

// @construct PENDING closure-loop-iife-fix
// @annotation
// FUNCTION <<closureLoopIifeFix>> -> CONTAINS -> VARIABLE <<funcs>>
// VARIABLE <<funcs>> -> ASSIGNED_FROM -> LITERAL <<[]>>
// FUNCTION <<closureLoopIifeFix>> -> CONTAINS -> LOOP <<for-loop>>
// LOOP <<for-loop>> -> CONTAINS -> VARIABLE <<i>>
// VARIABLE <<i>> -> ASSIGNED_FROM -> LITERAL <<0>>
// LOOP <<for-loop>> -> HAS_CONDITION -> EXPRESSION <<i < 5>>
// EXPRESSION <<i < 5>> -> READS_FROM -> VARIABLE <<i>>
// EXPRESSION <<i < 5>> -> READS_FROM -> LITERAL <<5>>
// LOOP <<for-loop>> -> HAS_UPDATE -> EXPRESSION <<i++>>
// EXPRESSION <<i++>> -> MODIFIES -> VARIABLE <<i>>
// LOOP <<for-loop>> -> HAS_BODY -> CALL <<funcs.push(...)>>
// CALL <<funcs.push(...)>> -> CALLS_ON -> VARIABLE <<funcs>>
// CALL <<funcs.push(...)>> -> PASSES_ARGUMENT -> CALL <<iife-call>>
// CALL <<iife-call>> -> CALLS -> FUNCTION <<iife>>
// CALL <<iife-call>> -> PASSES_ARGUMENT -> VARIABLE <<i>>
// FUNCTION <<iife>> -> CONTAINS -> PARAMETER <<captured>>
// PARAMETER <<captured>> -> CAPTURES -> VARIABLE <<i>>
// FUNCTION <<iife>> -> RETURNS -> FUNCTION <<inner-closure>>
// FUNCTION <<inner-closure>> -> CAPTURES -> PARAMETER <<captured>>
// FUNCTION <<inner-closure>> -> RETURNS -> PARAMETER <<captured>>
// FUNCTION <<closureLoopIifeFix>> -> RETURNS -> VARIABLE <<funcs>>
// @end-annotation
function closureLoopIifeFix() {
  const funcs = [];
  for (var i = 0; i < 5; i++) {
    funcs.push((function (captured) {
      return function () { return captured; };
    })(i));
  }
  return funcs;
}

// --- Nested closures (3+ levels) ---

// @construct PENDING closure-nested-deep
// @annotation
// FUNCTION <<outermost>> -> CONTAINS -> PARAMETER <<a>>
// FUNCTION <<outermost>> -> RETURNS -> FUNCTION <<middle>>
// FUNCTION <<middle>> -> CONTAINS -> PARAMETER <<b>>
// FUNCTION <<middle>> -> RETURNS -> FUNCTION <<innermost>>
// FUNCTION <<innermost>> -> CONTAINS -> PARAMETER <<c>>
// FUNCTION <<innermost>> -> RETURNS -> EXPRESSION <<a + b + c>>
// EXPRESSION <<a + b + c>> -> READS_FROM -> PARAMETER <<a>>
// EXPRESSION <<a + b + c>> -> READS_FROM -> PARAMETER <<b>>
// EXPRESSION <<a + b + c>> -> READS_FROM -> PARAMETER <<c>>
// FUNCTION <<middle>> -> CAPTURES -> PARAMETER <<a>>
// FUNCTION <<innermost>> -> CAPTURES -> PARAMETER <<a>>
// FUNCTION <<innermost>> -> CAPTURES -> PARAMETER <<b>>
// @end-annotation
function outermost(a) {
  return function middle(b) {
    return function innermost(c) {
      return a + b + c;
    };
  };
}

// @construct PENDING closure-nested-mutation
// @annotation
// FUNCTION <<createTracker>> -> CONTAINS -> VARIABLE <<total>>
// VARIABLE <<total>> -> ASSIGNED_FROM -> LITERAL <<0>>
// FUNCTION <<createTracker>> -> CONTAINS -> FUNCTION <<addGroup>>
// FUNCTION <<addGroup>> -> CONTAINS -> PARAMETER <<groupName>>
// FUNCTION <<addGroup>> -> CONTAINS -> VARIABLE <<groupTotal>>
// VARIABLE <<groupTotal>> -> ASSIGNED_FROM -> LITERAL <<0-inner>>
// FUNCTION <<addGroup>> -> CONTAINS -> FUNCTION <<addItem>>
// FUNCTION <<addGroup>> -> RETURNS -> FUNCTION <<addItem>>
// FUNCTION <<addItem>> -> CONTAINS -> PARAMETER <<value>>
// FUNCTION <<addItem>> -> CONTAINS -> EXPRESSION <<groupTotal += value>>
// FUNCTION <<addItem>> -> CONTAINS -> EXPRESSION <<total += value>>
// EXPRESSION <<groupTotal += value>> -> WRITES_TO -> VARIABLE <<groupTotal>>
// EXPRESSION <<groupTotal += value>> -> READS_FROM -> PARAMETER <<value>>
// EXPRESSION <<total += value>> -> WRITES_TO -> VARIABLE <<total>>
// EXPRESSION <<total += value>> -> READS_FROM -> PARAMETER <<value>>
// FUNCTION <<addItem>> -> RETURNS -> LITERAL <<{...}>>
// LITERAL <<{...}>> -> READS_FROM -> PARAMETER <<groupName>>
// LITERAL <<{...}>> -> READS_FROM -> VARIABLE <<groupTotal>>
// LITERAL <<{...}>> -> READS_FROM -> VARIABLE <<total>>
// FUNCTION <<createTracker>> -> CONTAINS -> FUNCTION <<getTotal>>
// FUNCTION <<getTotal>> -> READS_FROM -> VARIABLE <<total>>
// FUNCTION <<createTracker>> -> RETURNS -> EXPRESSION <<{ addGroup, getTotal: () => total }>>
// EXPRESSION <<{ addGroup, getTotal: () => total }>> -> READS_FROM -> FUNCTION <<addGroup>>
// EXPRESSION <<{ addGroup, getTotal: () => total }>> -> READS_FROM -> FUNCTION <<getTotal>>
// FUNCTION <<addItem>> -> CAPTURES -> VARIABLE <<total>>
// FUNCTION <<addItem>> -> CAPTURES -> VARIABLE <<groupTotal>>
// FUNCTION <<addItem>> -> CAPTURES -> PARAMETER <<groupName>>
// FUNCTION <<getTotal>> -> CAPTURES -> VARIABLE <<total>>
// @end-annotation
function createTracker() {
  let total = 0;
  function addGroup(groupName) {
    let groupTotal = 0;
    return function addItem(value) {
      groupTotal += value;
      total += value;
      return { groupName, groupTotal, total };
    };
  }
  return { addGroup, getTotal: () => total };
}

// --- this binding ---

// @construct PENDING this-method-context
// @annotation
// VARIABLE <<obj>> -> ASSIGNED_FROM -> LITERAL <<obj-literal>>
// LITERAL <<obj-literal>> -> HAS_PROPERTY -> LITERAL <<'context'>>
// LITERAL <<obj-literal>> -> HAS_PROPERTY -> METHOD <<getName>>
// LITERAL <<obj-literal>> -> HAS_PROPERTY -> FUNCTION <<getNameArrow>>
// METHOD <<getName>> -> RETURNS -> PROPERTY_ACCESS <<this.name-method>>
// PROPERTY_ACCESS <<this.name-method>> -> READS_FROM -> LITERAL <<obj-literal>>
// FUNCTION <<getNameArrow>> -> RETURNS -> PROPERTY_ACCESS <<this.name-arrow>>
// @end-annotation
const obj = {
  name: 'context',
  getName() {
    return this.name;
  },
  getNameArrow: () => {
    return this.name; // `this` is module/global, not obj
  },
};

// @construct PENDING this-lost-in-callback
// @annotation
// FUNCTION <<thisLostInCallback>> -> CONTAINS -> VARIABLE <<timer>>
// VARIABLE <<timer>> -> ASSIGNED_FROM -> LITERAL <<timer-object>>
// LITERAL <<timer-object>> -> HAS_PROPERTY -> PROPERTY_ACCESS <<timer.seconds>>
// PROPERTY_ACCESS <<timer.seconds>> -> ASSIGNED_FROM -> LITERAL <<0>>
// LITERAL <<timer-object>> -> HAS_PROPERTY -> METHOD <<timer.start>>
// LITERAL <<timer-object>> -> HAS_PROPERTY -> METHOD <<timer.startFixed>>
// METHOD <<timer.start>> -> CONTAINS -> CALL <<setTimeout-regular>>
// CALL <<setTimeout-regular>> -> PASSES_ARGUMENT -> FUNCTION <<setTimeout-callback-regular>>
// CALL <<setTimeout-regular>> -> PASSES_ARGUMENT -> LITERAL <<1000-1>>
// FUNCTION <<setTimeout-callback-regular>> -> CONTAINS -> EXPRESSION <<this.seconds++-regular>>
// EXPRESSION <<this.seconds++-regular>> -> WRITES_TO -> PROPERTY_ACCESS <<this.seconds-regular>>
// METHOD <<timer.startFixed>> -> CONTAINS -> CALL <<setTimeout-arrow>>
// CALL <<setTimeout-arrow>> -> PASSES_ARGUMENT -> FUNCTION <<setTimeout-callback-arrow>>
// CALL <<setTimeout-arrow>> -> PASSES_ARGUMENT -> LITERAL <<1000-2>>
// FUNCTION <<setTimeout-callback-arrow>> -> CONTAINS -> EXPRESSION <<this.seconds++-arrow>>
// EXPRESSION <<this.seconds++-arrow>> -> WRITES_TO -> PROPERTY_ACCESS <<this.seconds-arrow>>
// FUNCTION <<setTimeout-callback-arrow>> -> CAPTURES -> LITERAL <<timer-object>>
// FUNCTION <<thisLostInCallback>> -> RETURNS -> VARIABLE <<timer>>
// @end-annotation
function thisLostInCallback() {
  const timer = {
    seconds: 0,
    start() {
      // `this` lost: regular function callback
      setTimeout(function () {
        this.seconds++; // `this` is undefined/global
      }, 1000);
    },
    startFixed() {
      // `this` preserved: arrow function callback
      setTimeout(() => {
        this.seconds++;
      }, 1000);
    },
  };
  return timer;
}

// @construct PENDING this-bind
// @annotation
// FUNCTION <<thisBind>> -> CONTAINS -> FUNCTION <<greet>>
// FUNCTION <<greet>> -> DECLARES -> PARAMETER <<greeting>>
// FUNCTION <<greet>> -> RETURNS -> EXPRESSION <<`${greeting}, ${this.name}`>>
// EXPRESSION <<`${greeting}, ${this.name}`>> -> READS_FROM -> PARAMETER <<greeting>>
// EXPRESSION <<`${greeting}, ${this.name}`>> -> READS_FROM -> PROPERTY_ACCESS <<this.name>>
// FUNCTION <<thisBind>> -> DECLARES -> VARIABLE <<user>>
// VARIABLE <<user>> -> ASSIGNED_FROM -> LITERAL <<{ name: 'Alice' }>>
// LITERAL <<{ name: 'Alice' }>> -> HAS_PROPERTY -> LITERAL <<'Alice'>>
// FUNCTION <<thisBind>> -> DECLARES -> VARIABLE <<bound>>
// VARIABLE <<bound>> -> ASSIGNED_FROM -> CALL <<greet.bind(user)>>
// CALL <<greet.bind(user)>> -> BINDS_THIS_TO -> VARIABLE <<user>>
// FUNCTION <<thisBind>> -> RETURNS -> CALL <<bound('Hello')>>
// CALL <<bound('Hello')>> -> CALLS -> VARIABLE <<bound>>
// CALL <<bound('Hello')>> -> PASSES_ARGUMENT -> LITERAL <<'Hello'>>
// @end-annotation
function thisBind() {
  function greet(greeting) {
    return `${greeting}, ${this.name}`;
  }
  const user = { name: 'Alice' };
  const bound = greet.bind(user);
  return bound('Hello');
}

// @construct PENDING this-call-apply
// @annotation
// FUNCTION <<thisCallApply>> -> CONTAINS -> FUNCTION <<introduce>>
// FUNCTION <<introduce>> -> CONTAINS -> PARAMETER <<role>>
// FUNCTION <<introduce>> -> RETURNS -> EXPRESSION <<template-literal>>
// EXPRESSION <<template-literal>> -> READS_FROM -> PROPERTY_ACCESS <<this.name>>
// EXPRESSION <<template-literal>> -> READS_FROM -> PARAMETER <<role>>
// FUNCTION <<thisCallApply>> -> CONTAINS -> VARIABLE <<person>>
// VARIABLE <<person>> -> ASSIGNED_FROM -> LITERAL <<object-literal>>
// LITERAL <<object-literal>> -> HAS_PROPERTY -> LITERAL <<'Bob'>>
// FUNCTION <<thisCallApply>> -> CONTAINS -> VARIABLE <<viaCall>>
// VARIABLE <<viaCall>> -> ASSIGNED_FROM -> CALL <<introduce.call>>
// CALL <<introduce.call>> -> CALLS -> FUNCTION <<introduce>>
// CALL <<introduce.call>> -> BINDS_THIS_TO -> VARIABLE <<person>>
// CALL <<introduce.call>> -> PASSES_ARGUMENT -> LITERAL <<'admin'>>
// FUNCTION <<thisCallApply>> -> CONTAINS -> VARIABLE <<viaApply>>
// VARIABLE <<viaApply>> -> ASSIGNED_FROM -> CALL <<introduce.apply>>
// CALL <<introduce.apply>> -> CALLS -> FUNCTION <<introduce>>
// CALL <<introduce.apply>> -> BINDS_THIS_TO -> VARIABLE <<person>>
// CALL <<introduce.apply>> -> PASSES_ARGUMENT -> LITERAL <<array-literal>>
// LITERAL <<array-literal>> -> HAS_ELEMENT -> LITERAL <<'admin'>>
// FUNCTION <<thisCallApply>> -> RETURNS -> LITERAL <<return-object>>
// LITERAL <<return-object>> -> HAS_PROPERTY -> VARIABLE <<viaCall>>
// LITERAL <<return-object>> -> HAS_PROPERTY -> VARIABLE <<viaApply>>
// @end-annotation
function thisCallApply() {
  function introduce(role) {
    return `${this.name} is ${role}`;
  }
  const person = { name: 'Bob' };
  const viaCall = introduce.call(person, 'admin');
  const viaApply = introduce.apply(person, ['admin']);
  return { viaCall, viaApply };
}

// @construct PENDING this-in-class-callback
// @annotation
// CLASS <<EventHandler>> -> CONTAINS -> METHOD <<EventHandler.constructor>>
// CLASS <<EventHandler>> -> CONTAINS -> METHOD <<EventHandler.handle>>
// CLASS <<EventHandler>> -> CONTAINS -> METHOD <<EventHandler.handleArrow>>
// METHOD <<EventHandler.constructor>> -> CONTAINS -> PARAMETER <<name>>
// PROPERTY_ACCESS <<this.name>> -> ASSIGNED_FROM -> PARAMETER <<name>>
// PROPERTY_ACCESS <<this.handleBound>> -> ASSIGNED_FROM -> CALL <<this.handle.bind(this)>>
// CALL <<this.handle.bind(this)>> -> CALLS -> PROPERTY_ACCESS <<this.handle>>
// CALL <<this.handle.bind(this)>> -> PASSES_ARGUMENT -> UNKNOWN <<this>>
// METHOD <<EventHandler.handle>> -> CONTAINS -> PARAMETER <<event>>
// METHOD <<EventHandler.handle>> -> RETURNS -> EXPRESSION <<`${this.name}: ${event}`>>
// EXPRESSION <<`${this.name}: ${event}`>> -> READS_FROM -> PROPERTY_ACCESS <<this.name>>
// EXPRESSION <<`${this.name}: ${event}`>> -> READS_FROM -> PARAMETER <<event>>
// METHOD <<EventHandler.handleArrow>> -> CONTAINS -> PARAMETER <<event:arrow>>
// METHOD <<EventHandler.handleArrow>> -> RETURNS -> EXPRESSION <<`${this.name}: ${event}`:arrow>>
// EXPRESSION <<`${this.name}: ${event}`:arrow>> -> READS_FROM -> PROPERTY_ACCESS <<this.name>>
// EXPRESSION <<`${this.name}: ${event}`:arrow>> -> READS_FROM -> PARAMETER <<event:arrow>>
// METHOD <<EventHandler.handleArrow>> -> CAPTURES -> UNKNOWN <<this>>
// @end-annotation
class EventHandler {
  constructor(name) {
    this.name = name;
    this.handleBound = this.handle.bind(this);
  }

  handle(event) {
    return `${this.name}: ${event}`;
  }

  handleArrow = (event) => {
    return `${this.name}: ${event}`;
  };
}

// --- Closure as private scope ---

// @construct PENDING closure-module-pattern
// @annotation
// VARIABLE <<counterModule>> -> ASSIGNED_FROM -> CALL <<counterModule:iife-call>>
// CALL <<counterModule:iife-call>> -> CALLS -> FUNCTION <<counterModule:iife>>
// FUNCTION <<counterModule:iife>> -> DECLARES -> VARIABLE <<count>>
// VARIABLE <<count>> -> ASSIGNED_FROM -> LITERAL <<0>>
// FUNCTION <<counterModule:iife>> -> RETURNS -> LITERAL <<counterModule:object>>
// LITERAL <<counterModule:object>> -> HAS_PROPERTY -> METHOD <<increment>>
// LITERAL <<counterModule:object>> -> HAS_PROPERTY -> METHOD <<decrement>>
// LITERAL <<counterModule:object>> -> HAS_PROPERTY -> METHOD <<getCount>>
// METHOD <<increment>> -> CONTAINS -> EXPRESSION <<count++>>
// EXPRESSION <<count++>> -> MODIFIES -> VARIABLE <<count>>
// METHOD <<decrement>> -> CONTAINS -> EXPRESSION <<count-->>
// EXPRESSION <<count-->> -> MODIFIES -> VARIABLE <<count>>
// METHOD <<getCount>> -> READS_FROM -> VARIABLE <<count>>
// METHOD <<increment>> -> CAPTURES -> VARIABLE <<count>>
// METHOD <<decrement>> -> CAPTURES -> VARIABLE <<count>>
// METHOD <<getCount>> -> CAPTURES -> VARIABLE <<count>>
// @end-annotation
const counterModule = (function () {
  let count = 0;
  return {
    increment() { count++; },
    decrement() { count--; },
    getCount() { return count; },
  };
})();

// --- Memoization via closure ---

// @construct PENDING closure-memoize
// @annotation
// FUNCTION <<memoize>> -> HAS_BODY -> PARAMETER <<fn>>
// FUNCTION <<memoize>> -> CONTAINS -> VARIABLE <<cache>>
// VARIABLE <<cache>> -> ASSIGNED_FROM -> CALL <<new Map()>>
// FUNCTION <<memoize>> -> RETURNS -> FUNCTION <<memoize:returnFn>>
// FUNCTION <<memoize:returnFn>> -> HAS_BODY -> PARAMETER <<...args>>
// FUNCTION <<memoize:returnFn>> -> CONTAINS -> VARIABLE <<key>>
// VARIABLE <<key>> -> ASSIGNED_FROM -> CALL <<JSON.stringify(args)>>
// CALL <<JSON.stringify(args)>> -> PASSES_ARGUMENT -> PARAMETER <<...args>>
// FUNCTION <<memoize:returnFn>> -> CONTAINS -> VARIABLE <<result>>
// VARIABLE <<result>> -> ASSIGNED_FROM -> CALL <<fn.apply(this, args)>>
// CALL <<fn.apply(this, args)>> -> CALLS -> PARAMETER <<fn>>
// CALL <<fn.apply(this, args)>> -> PASSES_ARGUMENT -> PARAMETER <<...args>>
// CALL <<cache.has(key)>> -> CALLS_ON -> VARIABLE <<cache>>
// CALL <<cache.has(key)>> -> PASSES_ARGUMENT -> VARIABLE <<key>>
// CALL <<cache.get(key)>> -> CALLS_ON -> VARIABLE <<cache>>
// CALL <<cache.get(key)>> -> PASSES_ARGUMENT -> VARIABLE <<key>>
// CALL <<cache.set(key, result)>> -> CALLS_ON -> VARIABLE <<cache>>
// CALL <<cache.set(key, result)>> -> PASSES_ARGUMENT -> VARIABLE <<key>>
// CALL <<cache.set(key, result)>> -> PASSES_ARGUMENT -> VARIABLE <<result>>
// FUNCTION <<memoize:returnFn>> -> CAPTURES -> VARIABLE <<cache>>
// FUNCTION <<memoize:returnFn>> -> CAPTURES -> PARAMETER <<fn>>
// @end-annotation
function memoize(fn) {
  const cache = new Map();
  return function (...args) {
    const key = JSON.stringify(args);
    if (cache.has(key)) return cache.get(key);
    const result = fn.apply(this, args);
    cache.set(key, result);
    return result;
  };
}

// --- Once (call-at-most-once) ---

// @construct PENDING closure-once
// @annotation
// FUNCTION <<once>> -> HAS_BODY -> PARAMETER <<fn>>
// FUNCTION <<once>> -> DECLARES -> VARIABLE <<called>>
// VARIABLE <<called>> -> ASSIGNED_FROM -> LITERAL <<false>>
// FUNCTION <<once>> -> DECLARES -> VARIABLE <<result>>
// FUNCTION <<once>> -> RETURNS -> FUNCTION <<once:inner>>
// FUNCTION <<once:inner>> -> HAS_BODY -> PARAMETER <<...args>>
// FUNCTION <<once:inner>> -> HAS_BODY -> BRANCH <<if-not-called>>
// BRANCH <<if-not-called>> -> HAS_CONDITION -> EXPRESSION <<!called>>
// EXPRESSION <<!called>> -> READS_FROM -> VARIABLE <<called>>
// BRANCH <<if-not-called>> -> HAS_CONSEQUENT -> EXPRESSION <<called = true>>
// EXPRESSION <<called = true>> -> WRITES_TO -> VARIABLE <<called>>
// EXPRESSION <<called = true>> -> READS_FROM -> LITERAL <<true>>
// BRANCH <<if-not-called>> -> HAS_CONSEQUENT -> EXPRESSION <<result = fn.apply(this, args)>>
// EXPRESSION <<result = fn.apply(this, args)>> -> WRITES_TO -> VARIABLE <<result>>
// EXPRESSION <<result = fn.apply(this, args)>> -> READS_FROM -> CALL <<fn.apply(this, args)>>
// CALL <<fn.apply(this, args)>> -> CALLS -> PARAMETER <<fn>>
// CALL <<fn.apply(this, args)>> -> PASSES_ARGUMENT -> PARAMETER <<...args>>
// FUNCTION <<once:inner>> -> RETURNS -> VARIABLE <<result>>
// FUNCTION <<once:inner>> -> CAPTURES -> VARIABLE <<called>>
// FUNCTION <<once:inner>> -> CAPTURES -> VARIABLE <<result>>
// FUNCTION <<once:inner>> -> CAPTURES -> PARAMETER <<fn>>
// @end-annotation
function once(fn) {
  let called = false;
  let result;
  return function (...args) {
    if (!called) {
      called = true;
      result = fn.apply(this, args);
    }
    return result;
  };
}

// @construct PENDING this-module-level
// @annotation
// MODULE <<module>> -> DECLARES -> VARIABLE <<thisAtModuleLevel>>
// VARIABLE <<thisAtModuleLevel>> -> ASSIGNED_FROM -> META_PROPERTY <<this>>
// META_PROPERTY <<this>> -> DEPENDS_ON -> MODULE <<module>>
// @end-annotation
// In ESM: `this` is `undefined` at top level
const thisAtModuleLevel = this; // undefined in ESM, module.exports in CJS

// --- Named function expression as argument (self-referencing) ---

// @construct PENDING named-func-expr-as-argument
// @annotation
// VARIABLE <<retryDone>> -> ASSIGNED_FROM -> LITERAL <<false>>
// CALL <<setTimeout(function retry() {...}, 1000)>> -> PASSES_ARGUMENT -> FUNCTION <<retry>>
// CALL <<setTimeout(function retry() {...}, 1000)>> -> PASSES_ARGUMENT -> LITERAL <<1000>>
// FUNCTION <<retry>> -> CONTAINS -> BRANCH <<if (!retryDone)>>
// BRANCH <<if (!retryDone)>> -> HAS_CONDITION -> EXPRESSION <<!retryDone>>
// EXPRESSION <<!retryDone>> -> READS_FROM -> VARIABLE <<retryDone>>
// BRANCH <<if (!retryDone)>> -> HAS_CONSEQUENT -> CALL <<setTimeout(retry, 1000)>>
// CALL <<setTimeout(retry, 1000)>> -> PASSES_ARGUMENT -> LITERAL <<1000-inner>>
// FUNCTION <<retry>> -> CAPTURES -> VARIABLE <<retryDone>>
// @end-annotation
let retryDone = false;
setTimeout(function retry() {
  if (!retryDone) setTimeout(retry, 1000); // self-reference for recursive scheduling
}, 1000);

// @construct PENDING export-named-list
// @annotation
// @end-annotation
export {
  requestCount,
  getRequestCount,
  incrementRequestCount,
  sharedCache,
  setCache,
  getCache,
  clearCache,
  createCounter,
  createMultiplier,
  createAccumulator,
  closureLoopVarBug,
  closureLoopLetFix,
  closureLoopIifeFix,
  outermost,
  createTracker,
  obj,
  thisLostInCallback,
  thisBind,
  thisCallApply,
  EventHandler,
  counterModule,
  memoize,
  once,
  thisAtModuleLevel,
  retryDone,
};
