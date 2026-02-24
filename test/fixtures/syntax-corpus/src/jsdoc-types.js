// =============================================================================
// jsdoc-types.js — JSDoc Type Annotations in Plain JavaScript
// =============================================================================
//
// PLUGIN TERRITORY: JSDoc parsing requires a dedicated PLUGIN that reads
// comment AST nodes and produces the same graph edges as TypeScript annotations:
// TYPE, PARAMETER_TYPE, RETURNS_TYPE, IMPLEMENTS, TEMPLATE, etc.
//
// From the base JS analyzer's perspective, JSDoc comments are just comments —
// they carry no AST-level semantic information. The PLUGIN enriches the graph
// by extracting type information from these structured comments.
//
// For Grafema's target (massive untyped codebases), JSDoc is often the ONLY
// type information available. This is arguably the most important plugin for
// Grafema's stated mission: "codebases where TypeScript doesn't apply."
// =============================================================================

// @construct PENDING jsdoc-param-returns
// @annotation
// UNKNOWN <<module>> -> DECLARES -> FUNCTION <<createUser>>
// FUNCTION <<createUser>> -> CONTAINS -> PARAMETER <<name>>
// FUNCTION <<createUser>> -> CONTAINS -> PARAMETER <<age>>
// FUNCTION <<createUser>> -> DEPENDS_ON -> EXTERNAL <<@param-name>>
// FUNCTION <<createUser>> -> DEPENDS_ON -> EXTERNAL <<@param-age>>
// FUNCTION <<createUser>> -> DEPENDS_ON -> EXTERNAL <<@returns>>
// EXTERNAL <<@param-name>> -> ALIASES -> PARAMETER <<name>>
// EXTERNAL <<@param-age>> -> ALIASES -> PARAMETER <<age>>
// EXTERNAL <<@returns>> -> ALIASES -> EXPRESSION <<{ name, age }>>
// FUNCTION <<createUser>> -> RETURNS -> EXPRESSION <<{ name, age }>>
// EXPRESSION <<{ name, age }>> -> READS_FROM -> PARAMETER <<name>>
// EXPRESSION <<{ name, age }>> -> READS_FROM -> PARAMETER <<age>>
// @end-annotation
/**
 * @param {string} name
 * @param {number} age
 * @returns {{ name: string, age: number }}
 */
function createUser(name, age) {
  return { name, age };
}

// @construct PENDING jsdoc-type-variable
// @annotation
// VARIABLE <<handlers>> -> HAS_TYPE -> TYPE_REFERENCE <<Map<string, Function>>>
// VARIABLE <<handlers>> -> ASSIGNED_FROM -> CALL <<new Map()>>
// VARIABLE <<currentUser>> -> HAS_TYPE -> TYPE_REFERENCE <<string | null>>
// VARIABLE <<currentUser>> -> ASSIGNED_FROM -> LITERAL <<null>>
// VARIABLE <<PRIMES>> -> HAS_TYPE -> TYPE_REFERENCE <<readonly number[]>>
// VARIABLE <<PRIMES>> -> ASSIGNED_FROM -> LITERAL <<[2, 3, 5, 7, 11]>>
// @end-annotation
/** @type {Map<string, Function>} */
const handlers = new Map();

/** @type {string | null} */
let currentUser = null;

/** @type {readonly number[]} */
const PRIMES = [2, 3, 5, 7, 11];

// @construct PENDING jsdoc-typedef
// @annotation
// UNKNOWN <<module>> -> DECLARES -> TYPE_ALIAS <<UserDef>>
// TYPE_ALIAS <<UserDef>> -> HAS_PROPERTY -> PROPERTY <<UserDef.id>>
// TYPE_ALIAS <<UserDef>> -> HAS_PROPERTY -> PROPERTY <<UserDef.name>>
// TYPE_ALIAS <<UserDef>> -> HAS_PROPERTY -> PROPERTY <<UserDef.email>>
// UNKNOWN <<module>> -> DECLARES -> VARIABLE <<admin>>
// VARIABLE <<admin>> -> ASSIGNED_FROM -> LITERAL <<{ id: 1, name: 'admin' }>>
// VARIABLE <<admin>> -> HAS_TYPE -> TYPE_ALIAS <<UserDef>>
// LITERAL <<{ id: 1, name: 'admin' }>> -> HAS_PROPERTY -> LITERAL <<1>>
// LITERAL <<{ id: 1, name: 'admin' }>> -> HAS_PROPERTY -> LITERAL <<'admin'>>
// @end-annotation
/**
 * @typedef {Object} UserDef
 * @property {number} id
 * @property {string} name
 * @property {string} [email]
 */

/** @type {UserDef} */
const admin = { id: 1, name: 'admin' };

// @construct PENDING jsdoc-template
// @annotation
// FUNCTION <<first>> -> HAS_TYPE_PARAMETER -> TYPE_PARAMETER <<T>>
// FUNCTION <<first>> -> CONTAINS -> PARAMETER <<items>>
// PARAMETER <<items>> -> HAS_TYPE -> TYPE_PARAMETER <<T>>
// FUNCTION <<first>> -> RETURNS -> PROPERTY_ACCESS <<items[0]>>
// PROPERTY_ACCESS <<items[0]>> -> READS_FROM -> PARAMETER <<items>>
// FUNCTION <<getOrDefault>> -> HAS_TYPE_PARAMETER -> TYPE_PARAMETER <<K>>
// FUNCTION <<getOrDefault>> -> HAS_TYPE_PARAMETER -> TYPE_PARAMETER <<V>>
// FUNCTION <<getOrDefault>> -> CONTAINS -> PARAMETER <<map>>
// FUNCTION <<getOrDefault>> -> CONTAINS -> PARAMETER <<key>>
// FUNCTION <<getOrDefault>> -> CONTAINS -> PARAMETER <<fallback>>
// PARAMETER <<map>> -> HAS_TYPE -> TYPE_PARAMETER <<K>>
// PARAMETER <<map>> -> HAS_TYPE -> TYPE_PARAMETER <<V>>
// PARAMETER <<key>> -> HAS_TYPE -> TYPE_PARAMETER <<K>>
// PARAMETER <<fallback>> -> HAS_TYPE -> TYPE_PARAMETER <<V>>
// FUNCTION <<getOrDefault>> -> RETURNS -> EXPRESSION <<map.has(key) ? map.get(key) : fallback>>
// EXPRESSION <<map.has(key) ? map.get(key) : fallback>> -> HAS_CONDITION -> CALL <<map.has(key)>>
// EXPRESSION <<map.has(key) ? map.get(key) : fallback>> -> HAS_CONSEQUENT -> CALL <<map.get(key)>>
// EXPRESSION <<map.has(key) ? map.get(key) : fallback>> -> HAS_ALTERNATE -> PARAMETER <<fallback>>
// CALL <<map.has(key)>> -> CALLS_ON -> PARAMETER <<map>>
// CALL <<map.has(key)>> -> PASSES_ARGUMENT -> PARAMETER <<key>>
// CALL <<map.get(key)>> -> CALLS_ON -> PARAMETER <<map>>
// CALL <<map.get(key)>> -> PASSES_ARGUMENT -> PARAMETER <<key>>
// @end-annotation
/**
 * @template T
 * @param {T[]} items
 * @returns {T | undefined}
 */
function first(items) {
  return items[0];
}

/**
 * @template K, V
 * @param {Map<K, V>} map
 * @param {K} key
 * @param {V} fallback
 * @returns {V}
 */
function getOrDefault(map, key, fallback) {
  return map.has(key) ? map.get(key) : fallback;
}

// @construct PENDING jsdoc-template-constraint
// @annotation
// FUNCTION <<applyDefaults>> -> CONTAINS -> PARAMETER <<target>>
// FUNCTION <<applyDefaults>> -> CONTAINS -> PARAMETER <<overrides>>
// FUNCTION <<applyDefaults>> -> RETURNS -> EXPRESSION <<{ ...target, ...overrides }>>
// EXPRESSION <<{ ...target, ...overrides }>> -> READS_FROM -> PARAMETER <<target>>
// EXPRESSION <<{ ...target, ...overrides }>> -> READS_FROM -> PARAMETER <<overrides>>
// FUNCTION <<applyDefaults>> -> HAS_TYPE_PARAMETER -> TYPE_PARAMETER <<T>>
// TYPE_PARAMETER <<T>> -> CONSTRAINED_BY -> LITERAL_TYPE <<object>>
// PARAMETER <<target>> -> HAS_TYPE -> TYPE_REFERENCE <<target:T>>
// PARAMETER <<overrides>> -> HAS_TYPE -> TYPE_REFERENCE <<overrides:Partial<T>>>
// FUNCTION <<applyDefaults>> -> RETURNS_TYPE -> TYPE_REFERENCE <<returns:T>>
// TYPE_REFERENCE <<target:T>> -> USES -> TYPE_PARAMETER <<T>>
// TYPE_REFERENCE <<overrides:Partial<T>>> -> USES -> TYPE_PARAMETER <<T>>
// TYPE_REFERENCE <<returns:T>> -> USES -> TYPE_PARAMETER <<T>>
// @end-annotation
/**
 * @template {object} T
 * @param {T} target
 * @param {Partial<T>} overrides
 * @returns {T}
 */
function applyDefaults(target, overrides) {
  return { ...target, ...overrides };
}

// @construct PENDING jsdoc-implements
// @annotation
// CLASS <<NumberRange>> -> IMPLEMENTS -> INTERFACE <<Iterable<number>>>
// CLASS <<NumberRange>> -> CONTAINS -> METHOD <<NumberRange.constructor>>
// CLASS <<NumberRange>> -> CONTAINS -> METHOD <<NumberRange[Symbol.iterator]>>
// METHOD <<NumberRange.constructor>> -> CONTAINS -> PARAMETER <<start>>
// METHOD <<NumberRange.constructor>> -> CONTAINS -> PARAMETER <<end>>
// METHOD <<NumberRange.constructor>> -> WRITES_TO -> PROPERTY_ACCESS <<this.start>>
// METHOD <<NumberRange.constructor>> -> WRITES_TO -> PROPERTY_ACCESS <<this.end>>
// PROPERTY_ACCESS <<this.start>> -> ASSIGNED_FROM -> PARAMETER <<start>>
// PROPERTY_ACCESS <<this.end>> -> ASSIGNED_FROM -> PARAMETER <<end>>
// METHOD <<NumberRange[Symbol.iterator]>> -> DECLARES -> VARIABLE <<i>>
// METHOD <<NumberRange[Symbol.iterator]>> -> DECLARES -> VARIABLE <<end:local>>
// VARIABLE <<i>> -> ASSIGNED_FROM -> PROPERTY_ACCESS <<this.start>>
// VARIABLE <<end:local>> -> ASSIGNED_FROM -> PROPERTY_ACCESS <<this.end>>
// METHOD <<NumberRange[Symbol.iterator]>> -> RETURNS -> LITERAL <<return-object>>
// LITERAL <<return-object>> -> HAS_PROPERTY -> METHOD <<next>>
// METHOD <<next>> -> CONTAINS -> EXPRESSION <<i <= end>>
// EXPRESSION <<i <= end>> -> READS_FROM -> VARIABLE <<i>>
// EXPRESSION <<i <= end>> -> READS_FROM -> VARIABLE <<end:local>>
// METHOD <<next>> -> RETURNS -> LITERAL <<iterator-result-value>>
// METHOD <<next>> -> RETURNS -> LITERAL <<iterator-result-done>>
// LITERAL <<iterator-result-value>> -> HAS_PROPERTY -> EXPRESSION <<i++>>
// EXPRESSION <<i++>> -> READS_FROM -> VARIABLE <<i>>
// EXPRESSION <<i++>> -> WRITES_TO -> VARIABLE <<i>>
// @end-annotation
/** @implements {Iterable<number>} */
class NumberRange {
  /** @param {number} start @param {number} end */
  constructor(start, end) {
    this.start = start;
    this.end = end;
  }
  [Symbol.iterator]() {
    let i = this.start;
    const end = this.end;
    return { next() { return i <= end ? { value: i++, done: false } : { done: true }; } };
  }
}

// @construct PENDING jsdoc-enum
// @annotation
// VARIABLE <<Priority>> -> ASSIGNED_FROM -> LITERAL <<Priority-object>>
// LITERAL <<Priority-object>> -> HAS_PROPERTY -> LITERAL <<'low'>>
// LITERAL <<Priority-object>> -> HAS_PROPERTY -> LITERAL <<'medium'>>
// LITERAL <<Priority-object>> -> HAS_PROPERTY -> LITERAL <<'high'>>
// @end-annotation
/** @enum {string} */
const Priority = {
  Low: 'low',
  Medium: 'medium',
  High: 'high',
};

// @construct PENDING jsdoc-callback
// @annotation
// TYPE_ALIAS <<Predicate>> -> CONTAINS -> PARAMETER <<value>>
// TYPE_ALIAS <<Predicate>> -> RETURNS_TYPE -> TYPE_REFERENCE <<Predicate:return>>
// VARIABLE <<isPositive>> -> ASSIGNED_FROM -> FUNCTION <<isPositive:fn>>
// VARIABLE <<isPositive>> -> HAS_TYPE -> TYPE_ALIAS <<Predicate>>
// FUNCTION <<isPositive:fn>> -> CONTAINS -> PARAMETER <<isPositive:value>>
// FUNCTION <<isPositive:fn>> -> RETURNS -> EXPRESSION <<typeof value === 'number' && value > 0>>
// EXPRESSION <<typeof value === 'number' && value > 0>> -> READS_FROM -> EXPRESSION <<typeof value === 'number'>>
// EXPRESSION <<typeof value === 'number' && value > 0>> -> READS_FROM -> EXPRESSION <<value > 0>>
// EXPRESSION <<typeof value === 'number'>> -> READS_FROM -> EXPRESSION <<typeof value>>
// EXPRESSION <<typeof value === 'number'>> -> READS_FROM -> LITERAL <<'number'>>
// EXPRESSION <<typeof value>> -> READS_FROM -> PARAMETER <<isPositive:value>>
// EXPRESSION <<value > 0>> -> READS_FROM -> PARAMETER <<isPositive:value>>
// EXPRESSION <<value > 0>> -> READS_FROM -> LITERAL <<0>>
// @end-annotation
/**
 * @callback Predicate
 * @param {unknown} value
 * @returns {boolean}
 */

/** @type {Predicate} */
const isPositive = (value) => typeof value === 'number' && value > 0;

// @construct PENDING jsdoc-import-type
// @annotation
// UNKNOWN <<module>> -> DECLARES -> VARIABLE <<helperRef>>
// VARIABLE <<helperRef>> -> HAS_TYPE -> TYPE_REFERENCE <<@type-helperRef>>
// TYPE_REFERENCE <<@type-helperRef>> -> RESOLVES_TO -> TYPE_REFERENCE <<import('./modules-helpers.js').HelperClass>>
// TYPE_REFERENCE <<import('./modules-helpers.js').HelperClass>> -> IMPORTS_FROM -> EXTERNAL_MODULE <<./modules-helpers.js>>
// @end-annotation
/** @type {import('./modules-helpers.js').HelperClass} */
let helperRef;

// @construct PENDING jsdoc-overload
/**
 * @overload
 * @param {string} value
 * @returns {number}
 */
/**
 * @overload
 * @param {number} value
 * @returns {string}
 */
/**
 * @param {string | number} value
 * @returns {number | string}
 */
function convert(value) {
  return typeof value === 'string' ? Number(value) : String(value);
}

// @construct PENDING jsdoc-this
// @annotation
// FUNCTION <<greetThis>> -> CONTAINS -> PARAMETER <<greeting>>
// FUNCTION <<greetThis>> -> HAS_TYPE -> TYPE_REFERENCE <<@this>>
// FUNCTION <<greetThis>> -> HAS_TYPE -> TYPE_REFERENCE <<@param-greeting>>
// FUNCTION <<greetThis>> -> RETURNS_TYPE -> TYPE_REFERENCE <<@returns>>
// TYPE_REFERENCE <<@param-greeting>> -> HAS_TYPE -> PARAMETER <<greeting>>
// FUNCTION <<greetThis>> -> RETURNS -> EXPRESSION <<template-literal>>
// EXPRESSION <<template-literal>> -> READS_FROM -> PARAMETER <<greeting>>
// EXPRESSION <<template-literal>> -> READS_FROM -> PROPERTY_ACCESS <<this.name>>
// @end-annotation
/**
 * @this {{ name: string }}
 * @param {string} greeting
 * @returns {string}
 */
function greetThis(greeting) {
  return `${greeting}, ${this.name}`;
}

// @construct PENDING jsdoc-deprecated
// @annotation
// UNKNOWN <<module>> -> DECLARES -> FUNCTION <<oldProcess>>
// FUNCTION <<oldProcess>> -> CONTAINS -> PARAMETER <<input>>
// FUNCTION <<oldProcess>> -> RETURNS -> PARAMETER <<input>>
// EXTERNAL <<oldProcess:jsdoc>> -> DEPENDS_ON -> FUNCTION <<oldProcess>>
// EXTERNAL <<oldProcess:jsdoc>> -> HAS_TYPE -> PARAMETER <<input>>
// @end-annotation
/**
 * @deprecated Use newProcess() instead
 * @param {string} input
 * @returns {string}
 */
function oldProcess(input) {
  return input;
}

// @construct PENDING jsdoc-class-fields
// @annotation
// CLASS <<DataStore>> -> HAS_PROPERTY -> PROPERTY <<DataStore.store>>
// CLASS <<DataStore>> -> HAS_PROPERTY -> PROPERTY <<DataStore._cache>>
// CLASS <<DataStore>> -> CONTAINS -> METHOD <<DataStore.set>>
// CLASS <<DataStore>> -> CONTAINS -> GETTER <<DataStore.size>>
// PROPERTY <<DataStore.store>> -> ASSIGNED_FROM -> CALL <<new Map()>>
// CALL <<new Map()>> -> CALLS -> UNKNOWN <<Map>>
// PROPERTY <<DataStore._cache>> -> ASSIGNED_FROM -> LITERAL <<{}>>
// METHOD <<DataStore.set>> -> CONTAINS -> PARAMETER <<key>>
// METHOD <<DataStore.set>> -> CONTAINS -> PARAMETER <<value>>
// METHOD <<DataStore.set>> -> HAS_BODY -> CALL <<this.store.set(key, value)>>
// CALL <<this.store.set(key, value)>> -> CALLS_ON -> PROPERTY_ACCESS <<this.store>>
// CALL <<this.store.set(key, value)>> -> PASSES_ARGUMENT -> PARAMETER <<key>>
// CALL <<this.store.set(key, value)>> -> PASSES_ARGUMENT -> PARAMETER <<value>>
// PROPERTY_ACCESS <<this.store>> -> READS_FROM -> PROPERTY <<DataStore.store>>
// GETTER <<DataStore.size>> -> RETURNS -> PROPERTY_ACCESS <<this.store.size>>
// PROPERTY_ACCESS <<this.store.size>> -> READS_FROM -> PROPERTY_ACCESS <<this.store>>
// @end-annotation
class DataStore {
  /** @type {Map<string, unknown>} */
  store = new Map();

  /** @private */
  _cache = {};

  /**
   * @param {string} key
   * @param {unknown} value
   */
  set(key, value) {
    this.store.set(key, value);
  }

  /** @returns {number} */
  get size() {
    return this.store.size;
  }
}

// @construct PENDING export-named-list
// @annotation
// EXPORT <<export-named-list>> -> EXPORTS -> VARIABLE <<createUser>>
// EXPORT <<export-named-list>> -> EXPORTS -> VARIABLE <<handlers>>
// EXPORT <<export-named-list>> -> EXPORTS -> VARIABLE <<currentUser>>
// EXPORT <<export-named-list>> -> EXPORTS -> VARIABLE <<PRIMES>>
// EXPORT <<export-named-list>> -> EXPORTS -> VARIABLE <<admin>>
// EXPORT <<export-named-list>> -> EXPORTS -> VARIABLE <<first>>
// EXPORT <<export-named-list>> -> EXPORTS -> VARIABLE <<getOrDefault>>
// EXPORT <<export-named-list>> -> EXPORTS -> VARIABLE <<applyDefaults>>
// EXPORT <<export-named-list>> -> EXPORTS -> VARIABLE <<NumberRange>>
// EXPORT <<export-named-list>> -> EXPORTS -> VARIABLE <<Priority>>
// EXPORT <<export-named-list>> -> EXPORTS -> VARIABLE <<isPositive>>
// EXPORT <<export-named-list>> -> EXPORTS -> VARIABLE <<convert>>
// EXPORT <<export-named-list>> -> EXPORTS -> VARIABLE <<greetThis>>
// EXPORT <<export-named-list>> -> EXPORTS -> VARIABLE <<oldProcess>>
// EXPORT <<export-named-list>> -> EXPORTS -> VARIABLE <<DataStore>>
// @end-annotation
export {
  createUser,
  handlers,
  currentUser,
  PRIMES,
  admin,
  first,
  getOrDefault,
  applyDefaults,
  NumberRange,
  Priority,
  isPositive,
  convert,
  greetThis,
  oldProcess,
  DataStore,
};
