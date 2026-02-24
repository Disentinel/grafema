// =============================================================================
// modern-es.js — ES2022-2025 Features
// =============================================================================

// --- Array methods (ES2022-2023) ---

// @construct PENDING modern-array-at
// @annotation
// FUNCTION <<arrayAt>> -> CONTAINS -> PARAMETER <<arr>>
// FUNCTION <<arrayAt>> -> CONTAINS -> VARIABLE <<first>>
// VARIABLE <<first>> -> ASSIGNED_FROM -> CALL <<arr.at(0)>>
// CALL <<arr.at(0)>> -> READS_FROM -> PARAMETER <<arr>>
// CALL <<arr.at(0)>> -> PASSES_ARGUMENT -> LITERAL <<0>>
// FUNCTION <<arrayAt>> -> CONTAINS -> VARIABLE <<last>>
// VARIABLE <<last>> -> ASSIGNED_FROM -> CALL <<arr.at(-1)>>
// CALL <<arr.at(-1)>> -> READS_FROM -> PARAMETER <<arr>>
// CALL <<arr.at(-1)>> -> PASSES_ARGUMENT -> LITERAL <<-1>>
// FUNCTION <<arrayAt>> -> CONTAINS -> VARIABLE <<second>>
// VARIABLE <<second>> -> ASSIGNED_FROM -> CALL <<arr.at(1)>>
// CALL <<arr.at(1)>> -> READS_FROM -> PARAMETER <<arr>>
// CALL <<arr.at(1)>> -> PASSES_ARGUMENT -> LITERAL <<1>>
// FUNCTION <<arrayAt>> -> RETURNS -> EXPRESSION <<{ first, last, second }>>
// EXPRESSION <<{ first, last, second }>> -> READS_FROM -> VARIABLE <<first>>
// EXPRESSION <<{ first, last, second }>> -> READS_FROM -> VARIABLE <<last>>
// EXPRESSION <<{ first, last, second }>> -> READS_FROM -> VARIABLE <<second>>
// @end-annotation
function arrayAt(arr) {
  const first = arr.at(0);
  const last = arr.at(-1);
  const second = arr.at(1);
  return { first, last, second };
}

// @construct PENDING modern-array-findlast
// @annotation
// FUNCTION <<arrayFindLast>> -> CONTAINS -> PARAMETER <<arr>>
// FUNCTION <<arrayFindLast>> -> CONTAINS -> VARIABLE <<last>>
// FUNCTION <<arrayFindLast>> -> CONTAINS -> VARIABLE <<lastIdx>>
// VARIABLE <<last>> -> ASSIGNED_FROM -> CALL <<arr.findLast(x => x > 3)>>
// CALL <<arr.findLast(x => x > 3)>> -> CALLS_ON -> PARAMETER <<arr>>
// CALL <<arr.findLast(x => x > 3)>> -> PASSES_ARGUMENT -> FUNCTION <<findLast-callback>>
// FUNCTION <<findLast-callback>> -> CONTAINS -> PARAMETER <<x>>
// FUNCTION <<findLast-callback>> -> RETURNS -> EXPRESSION <<x > 3>>
// EXPRESSION <<x > 3>> -> READS_FROM -> PARAMETER <<x>>
// EXPRESSION <<x > 3>> -> READS_FROM -> LITERAL <<3>>
// VARIABLE <<lastIdx>> -> ASSIGNED_FROM -> CALL <<arr.findLastIndex(x => x > 3)>>
// CALL <<arr.findLastIndex(x => x > 3)>> -> CALLS_ON -> PARAMETER <<arr>>
// CALL <<arr.findLastIndex(x => x > 3)>> -> PASSES_ARGUMENT -> FUNCTION <<findLastIndex-callback>>
// FUNCTION <<findLastIndex-callback>> -> CONTAINS -> PARAMETER <<x2>>
// FUNCTION <<findLastIndex-callback>> -> RETURNS -> EXPRESSION <<x2 > 3>>
// EXPRESSION <<x2 > 3>> -> READS_FROM -> PARAMETER <<x2>>
// EXPRESSION <<x2 > 3>> -> READS_FROM -> LITERAL <<3-2>>
// FUNCTION <<arrayFindLast>> -> RETURNS -> EXPRESSION <<{ last, lastIdx }>>
// EXPRESSION <<{ last, lastIdx }>> -> READS_FROM -> VARIABLE <<last>>
// EXPRESSION <<{ last, lastIdx }>> -> READS_FROM -> VARIABLE <<lastIdx>>
// @end-annotation
function arrayFindLast(arr) {
  const last = arr.findLast(x => x > 3);
  const lastIdx = arr.findLastIndex(x => x > 3);
  return { last, lastIdx };
}

// @construct PENDING modern-array-immutable (ES2023)
// @annotation
// @end-annotation
function arrayImmutable(arr) {
  const sorted = arr.toSorted((a, b) => a - b);
  const reversed = arr.toReversed();
  const spliced = arr.toSpliced(1, 1, 'new');
  const replaced = arr.with(0, 'replaced');
  return { sorted, reversed, spliced, replaced, original: arr };
}

// --- Object.groupBy / Map.groupBy (ES2024) ---

// @construct PENDING modern-object-groupby
// @annotation
// FUNCTION <<objectGroupBy>> -> HAS_BODY -> PARAMETER <<items>>
// FUNCTION <<objectGroupBy>> -> RETURNS -> CALL <<Object.groupBy(items, item => item.category)>>
// CALL <<Object.groupBy(items, item => item.category)>> -> CALLS -> PROPERTY_ACCESS <<Object.groupBy>>
// CALL <<Object.groupBy(items, item => item.category)>> -> PASSES_ARGUMENT -> PARAMETER <<items>>
// CALL <<Object.groupBy(items, item => item.category)>> -> PASSES_ARGUMENT -> FUNCTION <<item => item.category>>
// FUNCTION <<item => item.category>> -> HAS_BODY -> PARAMETER <<item>>
// FUNCTION <<item => item.category>> -> RETURNS -> PROPERTY_ACCESS <<item.category>>
// PROPERTY_ACCESS <<item.category>> -> READS_FROM -> PARAMETER <<item>>
// @end-annotation
function objectGroupBy(items) {
  return Object.groupBy(items, item => item.category);
}

// @construct PENDING modern-map-groupby
function mapGroupBy(items) {
  return Map.groupBy(items, item => item.category);
}

// --- Promise.withResolvers (ES2024) ---

// @construct PENDING modern-promise-with-resolvers
// @annotation
// FUNCTION <<createDeferred>> -> CONTAINS -> CALL <<Promise.withResolvers()>>
// CALL <<Promise.withResolvers()>> -> CALLS -> PROPERTY_ACCESS <<Promise.withResolvers>>
// FUNCTION <<createDeferred>> -> CONTAINS -> VARIABLE <<promise>>
// FUNCTION <<createDeferred>> -> CONTAINS -> VARIABLE <<resolve>>
// FUNCTION <<createDeferred>> -> CONTAINS -> VARIABLE <<reject>>
// VARIABLE <<promise>> -> ASSIGNED_FROM -> CALL <<Promise.withResolvers()>>
// VARIABLE <<resolve>> -> ASSIGNED_FROM -> CALL <<Promise.withResolvers()>>
// VARIABLE <<reject>> -> ASSIGNED_FROM -> CALL <<Promise.withResolvers()>>
// FUNCTION <<createDeferred>> -> RETURNS -> EXPRESSION <<return-object>>
// EXPRESSION <<return-object>> -> READS_FROM -> VARIABLE <<promise>>
// EXPRESSION <<return-object>> -> READS_FROM -> VARIABLE <<resolve>>
// EXPRESSION <<return-object>> -> READS_FROM -> VARIABLE <<reject>>
// @end-annotation
function createDeferred() {
  const { promise, resolve, reject } = Promise.withResolvers();
  return { promise, resolve, reject };
}

// --- Error.cause usage ---

// @construct PENDING modern-error-cause
// @annotation
// FUNCTION <<wrapError>> -> HAS_BODY -> PARAMETER <<fn>>
// FUNCTION <<wrapError>> -> HAS_BODY -> TRY_BLOCK <<try-block>>
// TRY_BLOCK <<try-block>> -> CONTAINS -> CALL <<fn()>>
// CALL <<fn()>> -> CALLS -> PARAMETER <<fn>>
// FUNCTION <<wrapError>> -> HAS_CATCH -> CATCH_BLOCK <<catch-block>>
// CATCH_BLOCK <<catch-block>> -> CONTAINS -> PARAMETER <<err>>
// CATCH_BLOCK <<catch-block>> -> THROWS -> CALL <<new Error()>>
// CALL <<new Error()>> -> PASSES_ARGUMENT -> LITERAL <<'Wrapper failed'>>
// CALL <<new Error()>> -> PASSES_ARGUMENT -> EXPRESSION <<{ cause: err }>>
// EXPRESSION <<{ cause: err }>> -> READS_FROM -> PARAMETER <<err>>
// @end-annotation
function wrapError(fn) {
  try {
    return fn();
  } catch (err) {
    throw new Error('Wrapper failed', { cause: err });
  }
}

// --- Object.hasOwn (ES2022) ---

// @construct PENDING modern-object-hasown
// @annotation
// FUNCTION <<hasOwnCheck>> -> HAS_BODY -> PARAMETER <<obj>>
// FUNCTION <<hasOwnCheck>> -> HAS_BODY -> PARAMETER <<key>>
// FUNCTION <<hasOwnCheck>> -> RETURNS -> CALL <<Object.hasOwn(obj, key)>>
// CALL <<Object.hasOwn(obj, key)>> -> CALLS -> PROPERTY_ACCESS <<Object.hasOwn>>
// CALL <<Object.hasOwn(obj, key)>> -> PASSES_ARGUMENT -> PARAMETER <<obj>>
// CALL <<Object.hasOwn(obj, key)>> -> PASSES_ARGUMENT -> PARAMETER <<key>>
// PROPERTY_ACCESS <<Object.hasOwn>> -> READS_FROM -> UNKNOWN <<Object>>
// @end-annotation
function hasOwnCheck(obj, key) {
  return Object.hasOwn(obj, key);
}

// --- structuredClone (ES2022) ---

// @construct PENDING modern-structured-clone
// @annotation
// FUNCTION <<deepClone>> -> HAS_BODY -> PARAMETER <<obj>>
// FUNCTION <<deepClone>> -> RETURNS -> CALL <<structuredClone(obj)>>
// CALL <<structuredClone(obj)>> -> CALLS -> EXTERNAL <<structuredClone>>
// CALL <<structuredClone(obj)>> -> PASSES_ARGUMENT -> PARAMETER <<obj>>
// @end-annotation
function deepClone(obj) {
  return structuredClone(obj);
}

// --- Hashbang (ES2023) ---
// Note: hashbang must be at very top of file, so this is just a reference
// #!/usr/bin/env node — would be first line in a CLI script

// --- RegExp: d flag / match indices (ES2022) ---

// @construct PENDING modern-regex-indices
// @annotation
// FUNCTION <<regexIndices>> -> CONTAINS -> PARAMETER <<str>>
// FUNCTION <<regexIndices>> -> CONTAINS -> VARIABLE <<regex>>
// VARIABLE <<regex>> -> ASSIGNED_FROM -> LITERAL <</(?<word>\w+)/gd>>
// FUNCTION <<regexIndices>> -> CONTAINS -> VARIABLE <<match>>
// VARIABLE <<match>> -> ASSIGNED_FROM -> CALL <<regex.exec(str)>>
// CALL <<regex.exec(str)>> -> CALLS_ON -> VARIABLE <<regex>>
// CALL <<regex.exec(str)>> -> PASSES_ARGUMENT -> PARAMETER <<str>>
// FUNCTION <<regexIndices>> -> CONTAINS -> BRANCH <<if (!match)>>
// BRANCH <<if (!match)>> -> READS_FROM -> VARIABLE <<match>>
// BRANCH <<if (!match)>> -> HAS_CONSEQUENT -> LITERAL <<null>>
// FUNCTION <<regexIndices>> -> CONTAINS -> VARIABLE <<indices>>
// VARIABLE <<indices>> -> ASSIGNED_FROM -> PROPERTY_ACCESS <<match.indices>>
// PROPERTY_ACCESS <<match.indices>> -> READS_FROM -> VARIABLE <<match>>
// FUNCTION <<regexIndices>> -> RETURNS -> EXPRESSION <<return-object>>
// EXPRESSION <<return-object>> -> HAS_PROPERTY -> PROPERTY_ACCESS <<match[0]>>
// EXPRESSION <<return-object>> -> HAS_PROPERTY -> PROPERTY_ACCESS <<indices[0][0]>>
// EXPRESSION <<return-object>> -> HAS_PROPERTY -> PROPERTY_ACCESS <<indices[0][1]>>
// EXPRESSION <<return-object>> -> HAS_PROPERTY -> PROPERTY_ACCESS <<indices.groups>>
// PROPERTY_ACCESS <<match[0]>> -> READS_FROM -> VARIABLE <<match>>
// PROPERTY_ACCESS <<indices[0][0]>> -> READS_FROM -> VARIABLE <<indices>>
// PROPERTY_ACCESS <<indices[0][1]>> -> READS_FROM -> VARIABLE <<indices>>
// PROPERTY_ACCESS <<indices.groups>> -> READS_FROM -> VARIABLE <<indices>>
// @end-annotation
function regexIndices(str) {
  const regex = /(?<word>\w+)/gd;
  const match = regex.exec(str);
  if (!match) return null;
  const { indices } = match;
  return { match: match[0], start: indices[0][0], end: indices[0][1], groups: indices.groups };
}

// --- Top-level await (ES2022) — already in async-generators.js, reference only ---

// --- Logical assignment already in expressions.js (&&=, ||=, ??=) ---

// --- Private class fields / methods already in classes.js ---

// --- Class static block already in classes.js ---

// --- Symbols: well-known symbols ---

// @construct PENDING modern-symbol-iterator
// @annotation
// CLASS <<InfiniteOnes>> -> CONTAINS -> METHOD <<InfiniteOnes[Symbol.iterator]>>
// METHOD <<InfiniteOnes[Symbol.iterator]>> -> RETURNS -> LITERAL <<object-literal>>
// LITERAL <<object-literal>> -> HAS_PROPERTY -> METHOD <<next>>
// METHOD <<next>> -> RETURNS -> LITERAL <<return-object>>
// LITERAL <<return-object>> -> HAS_PROPERTY -> LITERAL <<1>>
// LITERAL <<return-object>> -> HAS_PROPERTY -> LITERAL <<false>>
// @end-annotation
class InfiniteOnes {
  [Symbol.iterator]() {
    return {
      next() { return { value: 1, done: false }; },
    };
  }
}

// @construct PENDING modern-symbol-async-iterator
// @annotation
// @end-annotation
class AsyncSequence {
  constructor(values) {
    this.values = values;
  }

  [Symbol.asyncIterator]() {
    let i = 0;
    const values = this.values;
    return {
      async next() {
        if (i < values.length) {
          return { value: values[i++], done: false };
        }
        return { value: undefined, done: true };
      },
    };
  }
}

// @construct PENDING modern-symbol-toprimitive
// @annotation
// CLASS <<Money>> -> CONTAINS -> METHOD <<Money.constructor>>
// CLASS <<Money>> -> CONTAINS -> METHOD <<Money.[Symbol.toPrimitive]>>
// METHOD <<Money.constructor>> -> RECEIVES_ARGUMENT -> PARAMETER <<amount>>
// METHOD <<Money.constructor>> -> RECEIVES_ARGUMENT -> PARAMETER <<currency>>
// PROPERTY_ACCESS <<this.amount>> -> ASSIGNED_FROM -> PARAMETER <<amount>>
// PROPERTY_ACCESS <<this.currency>> -> ASSIGNED_FROM -> PARAMETER <<currency>>
// METHOD <<Money.[Symbol.toPrimitive]>> -> RECEIVES_ARGUMENT -> PARAMETER <<hint>>
// METHOD <<Money.[Symbol.toPrimitive]>> -> HAS_CONDITION -> BRANCH <<hint === 'number'>>
// METHOD <<Money.[Symbol.toPrimitive]>> -> HAS_CONDITION -> BRANCH <<hint === 'string'>>
// BRANCH <<hint === 'number'>> -> READS_FROM -> PARAMETER <<hint>>
// BRANCH <<hint === 'number'>> -> READS_FROM -> LITERAL <<'number'>>
// BRANCH <<hint === 'string'>> -> READS_FROM -> PARAMETER <<hint>>
// BRANCH <<hint === 'string'>> -> READS_FROM -> LITERAL <<'string'>>
// BRANCH <<hint === 'number'>> -> HAS_CONSEQUENT -> PROPERTY_ACCESS <<this.amount>>
// BRANCH <<hint === 'string'>> -> HAS_CONSEQUENT -> EXPRESSION <<`${this.amount} ${this.currency}`>>
// METHOD <<Money.[Symbol.toPrimitive]>> -> RETURNS -> PROPERTY_ACCESS <<this.amount>>
// EXPRESSION <<`${this.amount} ${this.currency}`>> -> READS_FROM -> PROPERTY_ACCESS <<this.amount>>
// EXPRESSION <<`${this.amount} ${this.currency}`>> -> READS_FROM -> PROPERTY_ACCESS <<this.currency>>
// @end-annotation
class Money {
  constructor(amount, currency) {
    this.amount = amount;
    this.currency = currency;
  }

  [Symbol.toPrimitive](hint) {
    if (hint === 'number') return this.amount;
    if (hint === 'string') return `${this.amount} ${this.currency}`;
    return this.amount;
  }
}

// @construct PENDING modern-symbol-tostringtag
// @annotation
// UNKNOWN <<module>> -> DECLARES -> CLASS <<CustomCollection>>
// CLASS <<CustomCollection>> -> CONTAINS -> GETTER <<CustomCollection.[Symbol.toStringTag]>>
// GETTER <<CustomCollection.[Symbol.toStringTag]>> -> HAS_PROPERTY -> PROPERTY_ACCESS <<Symbol.toStringTag>>
// GETTER <<CustomCollection.[Symbol.toStringTag]>> -> RETURNS -> LITERAL <<'CustomCollection'>>
// @end-annotation
class CustomCollection {
  get [Symbol.toStringTag]() {
    return 'CustomCollection';
  }
}

// @construct PENDING modern-symbol-species
// @annotation
// UNKNOWN <<module>> -> DECLARES -> CLASS <<SpecialArray>>
// CLASS <<SpecialArray>> -> EXTENDS -> VARIABLE <<Array>>
// CLASS <<SpecialArray>> -> CONTAINS -> GETTER <<SpecialArray[Symbol.species]>>
// GETTER <<SpecialArray[Symbol.species]>> -> USES -> PROPERTY_ACCESS <<Symbol.species>>
// GETTER <<SpecialArray[Symbol.species]>> -> RETURNS -> VARIABLE <<Array>>
// GETTER <<SpecialArray[Symbol.species]>> -> READS_FROM -> VARIABLE <<Array>>
// @end-annotation
class SpecialArray extends Array {
  static get [Symbol.species]() {
    return Array;
  }
}

// --- AbortController ---

// @construct PENDING modern-abort-controller
// @annotation
// FUNCTION <<fetchWithAbort>> -> CONTAINS -> PARAMETER <<url>>
// FUNCTION <<fetchWithAbort>> -> CONTAINS -> PARAMETER <<timeoutMs>>
// FUNCTION <<fetchWithAbort>> -> CONTAINS -> VARIABLE <<controller>>
// VARIABLE <<controller>> -> ASSIGNED_FROM -> CALL <<new AbortController()>>
// CALL <<new AbortController()>> -> CALLS -> UNKNOWN <AbortController>
// FUNCTION <<fetchWithAbort>> -> CONTAINS -> VARIABLE <<signal>>
// VARIABLE <<signal>> -> ASSIGNED_FROM -> PROPERTY_ACCESS <<controller.signal>>
// PROPERTY_ACCESS <<controller.signal>> -> READS_FROM -> VARIABLE <<controller>>
// FUNCTION <<fetchWithAbort>> -> CONTAINS -> VARIABLE <<timeoutId>>
// VARIABLE <<timeoutId>> -> ASSIGNED_FROM -> CALL <<setTimeout(...)>>
// CALL <<setTimeout(...)>> -> CALLS -> UNKNOWN <setTimeout>
// CALL <<setTimeout(...)>> -> PASSES_ARGUMENT -> FUNCTION <<timeout-callback>>
// CALL <<setTimeout(...)>> -> PASSES_ARGUMENT -> PARAMETER <<timeoutMs>>
// FUNCTION <<timeout-callback>> -> CONTAINS -> CALL <<controller.abort()>>
// CALL <<controller.abort()>> -> CALLS_ON -> VARIABLE <<controller>>
// FUNCTION <<fetchWithAbort>> -> CONTAINS -> TRY_BLOCK <<try-block>>
// TRY_BLOCK <<try-block>> -> CONTAINS -> VARIABLE <<response>>
// VARIABLE <<response>> -> ASSIGNED_FROM -> CALL <<fetch(url, { signal })>>
// CALL <<fetch(url, { signal })>> -> CALLS -> UNKNOWN <fetch>
// CALL <<fetch(url, { signal })>> -> PASSES_ARGUMENT -> PARAMETER <<url>>
// CALL <<fetch(url, { signal })>> -> PASSES_ARGUMENT -> LITERAL <<{ signal }>>
// LITERAL <<{ signal }>> -> READS_FROM -> VARIABLE <<signal>>
// TRY_BLOCK <<try-block>> -> RETURNS -> CALL <<response.json()>>
// CALL <<response.json()>> -> CALLS_ON -> VARIABLE <<response>>
// FUNCTION <<fetchWithAbort>> -> HAS_FINALLY -> FINALLY_BLOCK <<finally-block>>
// FINALLY_BLOCK <<finally-block>> -> CONTAINS -> CALL <<clearTimeout(timeoutId)>>
// CALL <<clearTimeout(timeoutId)>> -> CALLS -> UNKNOWN <clearTimeout>
// CALL <<clearTimeout(timeoutId)>> -> PASSES_ARGUMENT -> VARIABLE <<timeoutId>>
// @end-annotation
async function fetchWithAbort(url, timeoutMs) {
  const controller = new AbortController();
  const { signal } = controller;
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, { signal });
    return await response.json();
  } finally {
    clearTimeout(timeoutId);
  }
}

// --- Disposable resources (ES2025) ---

// @construct PENDING modern-using-sync
// @annotation
// FUNCTION <<usingSyncExample>> -> CONTAINS -> VARIABLE <<resource>>
// VARIABLE <<resource>> -> ASSIGNED_FROM -> LITERAL <<resource-object>>
// LITERAL <<resource-object>> -> HAS_PROPERTY -> PROPERTY <<data-property>>
// PROPERTY <<data-property>> -> ASSIGNED_FROM -> LITERAL <<'important'>>
// LITERAL <<resource-object>> -> HAS_PROPERTY -> METHOD <<resource[Symbol.dispose]>>
// METHOD <<resource[Symbol.dispose]>> -> WRITES_TO -> PROPERTY_ACCESS <<this.data>>
// PROPERTY_ACCESS <<this.data>> -> ASSIGNED_FROM -> LITERAL <<null>>
// FUNCTION <<usingSyncExample>> -> RETURNS -> VARIABLE <<resource>>
// @end-annotation
function usingSyncExample() {
  // Symbol.dispose — synchronous cleanup
  const resource = {
    data: 'important',
    [Symbol.dispose]() {
      this.data = null;
    },
  };
  return resource;
}

// @construct PENDING modern-using-async
// @annotation
// FUNCTION <<usingAsyncExample>> -> CONTAINS -> VARIABLE <<resource>>
// VARIABLE <<resource>> -> HAS_PROPERTY -> LITERAL <<'important'>>
// VARIABLE <<resource>> -> HAS_PROPERTY -> METHOD <<resource[Symbol.asyncDispose]>>
// METHOD <<resource[Symbol.asyncDispose]>> -> AWAITS -> CALL <<new Promise(r => setTimeout(r, 10))>>
// CALL <<new Promise(r => setTimeout(r, 10))>> -> PASSES_ARGUMENT -> FUNCTION <<r => setTimeout(r, 10)>>
// FUNCTION <<r => setTimeout(r, 10)>> -> CONTAINS -> PARAMETER <<r>>
// FUNCTION <<r => setTimeout(r, 10)>> -> RETURNS -> CALL <<setTimeout(r, 10)>>
// CALL <<setTimeout(r, 10)>> -> PASSES_ARGUMENT -> PARAMETER <<r>>
// CALL <<setTimeout(r, 10)>> -> PASSES_ARGUMENT -> LITERAL <<10>>
// METHOD <<resource[Symbol.asyncDispose]>> -> WRITES_TO -> PROPERTY_ACCESS <<this.data>>
// PROPERTY_ACCESS <<this.data>> -> ASSIGNED_FROM -> LITERAL <<null>>
// FUNCTION <<usingAsyncExample>> -> RETURNS -> VARIABLE <<resource>>
// @end-annotation
async function usingAsyncExample() {
  const resource = {
    data: 'important',
    async [Symbol.asyncDispose]() {
      await new Promise(r => setTimeout(r, 10));
      this.data = null;
    },
  };
  return resource;
}

// --- Iterator helpers (ES2025) ---

// @construct PENDING modern-iterator-helpers
// @annotation
// FUNCTION <<iteratorHelpers>> -> CONTAINS -> PARAMETER <<arr>>
// FUNCTION <<iteratorHelpers>> -> CONTAINS -> VARIABLE <<iter>>
// VARIABLE <<iter>> -> ASSIGNED_FROM -> CALL <<arr.values()>>
// CALL <<arr.values()>> -> CALLS_ON -> PARAMETER <<arr>>
// FUNCTION <<iteratorHelpers>> -> CONTAINS -> VARIABLE <<mapped>>
// VARIABLE <<mapped>> -> ASSIGNED_FROM -> CALL <<iter.map(x => x * 2)>>
// CALL <<iter.map(x => x * 2)>> -> CALLS_ON -> VARIABLE <<iter>>
// CALL <<iter.map(x => x * 2)>> -> PASSES_ARGUMENT -> FUNCTION <<x => x * 2>>
// FUNCTION <<x => x * 2>> -> CONTAINS -> PARAMETER <<x>>
// FUNCTION <<x => x * 2>> -> RETURNS -> EXPRESSION <<x * 2>>
// EXPRESSION <<x * 2>> -> READS_FROM -> PARAMETER <<x>>
// EXPRESSION <<x * 2>> -> READS_FROM -> LITERAL <<2>>
// FUNCTION <<iteratorHelpers>> -> CONTAINS -> VARIABLE <<taken>>
// VARIABLE <<taken>> -> ASSIGNED_FROM -> CALL <<mapped.take(3)>>
// CALL <<mapped.take(3)>> -> CALLS_ON -> VARIABLE <<mapped>>
// CALL <<mapped.take(3)>> -> PASSES_ARGUMENT -> LITERAL <<3>>
// FUNCTION <<iteratorHelpers>> -> RETURNS -> EXPRESSION <<[...taken]>>
// EXPRESSION <<[...taken]>> -> READS_FROM -> VARIABLE <<taken>>
// @end-annotation
function iteratorHelpers(arr) {
  // Iterator.from, .map, .filter, .take, .drop, .flatMap, .reduce, .toArray, .forEach, .some, .every, .find
  const iter = arr.values();
  const mapped = iter.map(x => x * 2);
  const taken = mapped.take(3);
  return [...taken];
}

// --- Set methods (ES2025) ---

// @construct PENDING modern-set-methods
// @annotation
// @end-annotation
function setMethods() {
  const a = new Set([1, 2, 3, 4]);
  const b = new Set([3, 4, 5, 6]);

  const union = a.union(b);
  const intersection = a.intersection(b);
  const difference = a.difference(b);
  const symmetricDifference = a.symmetricDifference(b);
  const isSubset = a.isSubsetOf(b);
  const isSuperset = a.isSupersetOf(b);
  const isDisjoint = a.isDisjointFrom(b);

  return { union, intersection, difference, symmetricDifference, isSubset, isSuperset, isDisjoint };
}

// @construct PENDING using-declaration
// @annotation
// FUNCTION <<usingDeclaration>> -> CONTAINS -> FUNCTION <<openFile>>
// FUNCTION <<openFile>> -> CONTAINS -> PARAMETER <<path>>
// FUNCTION <<openFile>> -> RETURNS -> LITERAL <<object-literal>>
// LITERAL <<object-literal>> -> HAS_PROPERTY -> PROPERTY <<path-property>>
// PROPERTY <<path-property>> -> READS_FROM -> PARAMETER <<path>>
// LITERAL <<object-literal>> -> HAS_PROPERTY -> METHOD <<read>>
// METHOD <<read>> -> RETURNS -> EXPRESSION <<template-literal>>
// EXPRESSION <<template-literal>> -> READS_FROM -> PARAMETER <<path>>
// LITERAL <<object-literal>> -> HAS_PROPERTY -> METHOD <<Symbol.dispose>>
// METHOD <<Symbol.dispose>> -> CONTAINS -> CALL <<console.log>>
// CALL <<console.log>> -> PASSES_ARGUMENT -> EXPRESSION <<dispose-template>>
// EXPRESSION <<dispose-template>> -> READS_FROM -> PARAMETER <<path>>
// FUNCTION <<usingDeclaration>> -> DECLARES -> VARIABLE <<handle>>
// VARIABLE <<handle>> -> ASSIGNED_FROM -> CALL <<openFile('/tmp/test')>>
// CALL <<openFile('/tmp/test')>> -> CALLS -> FUNCTION <<openFile>>
// CALL <<openFile('/tmp/test')>> -> PASSES_ARGUMENT -> LITERAL <<'/tmp/test'>>
// FUNCTION <<usingDeclaration>> -> RETURNS -> CALL <<handle.read()>>
// CALL <<handle.read()>> -> READS_FROM -> VARIABLE <<handle>>
// CALL <<handle.read()>> -> CALLS -> METHOD <<read>>
// @end-annotation
function usingDeclaration() {
  function openFile(path) {
    return {
      path,
      read() { return `contents of ${path}`; },
      [Symbol.dispose]() { console.log(`closed ${path}`); },
    };
  }
  using handle = openFile('/tmp/test');
  return handle.read();
}

// @construct PENDING using-await-declaration
// @annotation
// FUNCTION <<usingAwaitDeclaration>> -> CONTAINS -> FUNCTION <<openStream>>
// FUNCTION <<openStream>> -> CONTAINS -> PARAMETER <<url>>
// FUNCTION <<openStream>> -> RETURNS -> EXPRESSION <<object-literal>>
// EXPRESSION <<object-literal>> -> HAS_PROPERTY -> PARAMETER <<url>>
// EXPRESSION <<object-literal>> -> HAS_PROPERTY -> METHOD <<readAll>>
// EXPRESSION <<object-literal>> -> HAS_PROPERTY -> METHOD <<Symbol.asyncDispose>>
// METHOD <<readAll>> -> RETURNS -> LITERAL <<'data'>>
// METHOD <<Symbol.asyncDispose>> -> CONTAINS -> CALL <<console.log(template)>>
// EXPRESSION <<template-literal>> -> HAS_ELEMENT -> LITERAL <<'closed '>>
// EXPRESSION <<template-literal>> -> HAS_ELEMENT -> PARAMETER <<url>>
// CALL <<console.log(template)>> -> PASSES_ARGUMENT -> EXPRESSION <<template-literal>>
// FUNCTION <<usingAwaitDeclaration>> -> DECLARES -> VARIABLE <<stream>>
// VARIABLE <<stream>> -> ASSIGNED_FROM -> CALL <<openStream('http://example.com')>>
// CALL <<openStream('http://example.com')>> -> CALLS -> FUNCTION <<openStream>>
// CALL <<openStream('http://example.com')>> -> PASSES_ARGUMENT -> LITERAL <<'http://example.com'>>
// FUNCTION <<usingAwaitDeclaration>> -> RETURNS -> CALL <<stream.readAll()>>
// CALL <<stream.readAll()>> -> READS_FROM -> VARIABLE <<stream>>
// CALL <<stream.readAll()>> -> CALLS -> METHOD <<readAll>>
// @end-annotation
async function usingAwaitDeclaration() {
  function openStream(url) {
    return {
      url,
      async readAll() { return 'data'; },
      async [Symbol.asyncDispose]() { console.log(`closed ${url}`); },
    };
  }
  await using stream = await openStream('http://example.com');
  return stream.readAll();
}

// @construct PENDING using-in-for
// @annotation
// FUNCTION <<usingInFor>> -> CONTAINS -> PARAMETER <<readers>>
// FUNCTION <<usingInFor>> -> CONTAINS -> LOOP <<for-of-using>>
// LOOP <<for-of-using>> -> ITERATES_OVER -> PARAMETER <<readers>>
// LOOP <<for-of-using>> -> CONTAINS -> VARIABLE <<reader>>
// LOOP <<for-of-using>> -> HAS_BODY -> CALL <<reader.process()>>
// CALL <<reader.process()>> -> CALLS -> PROPERTY_ACCESS <<reader.process>>
// PROPERTY_ACCESS <<reader.process>> -> READS_FROM -> VARIABLE <<reader>>
// @end-annotation
function usingInFor(readers) {
  for (using reader of readers) {
    reader.process();
  }
}

// @construct PENDING reexport-namespace
// @annotation
// UNKNOWN <<module>> -> CONTAINS -> EXPORT <<export-namespace>>
// EXPORT <<export-namespace>> -> DEPENDS_ON -> IMPORT <<import-all>>
// IMPORT <<import-all>> -> IMPORTS_FROM -> UNKNOWN <<./modules-helpers.js>>
// EXPORT <<export-namespace>> -> ALIASES -> UNKNOWN <<utils>>
// @end-annotation
// export * as utils from './modules-helpers.js';
// (commented — would conflict with existing exports; syntax reference only)

// @construct PENDING class-accessor-keyword
class Reactive {
  accessor count = 0;
}

// --- Import Attributes (ES2025) ---

// @construct PENDING import-attributes-json
// @annotation
// IMPORT <<import-config>> -> IMPORTS -> VARIABLE <<config>>
// IMPORT <<import-config>> -> IMPORTS_FROM -> EXTERNAL_MODULE <<./config.json>>
// @end-annotation
// import config from './config.json' with { type: 'json' };

// @construct PENDING import-attributes-css
// import styles from './app.css' with { type: 'css' };

// @construct PENDING import-attributes-dynamic
// const data = await import('./data.json', { with: { type: 'json' } });

// @construct PENDING import-attributes-reexport
// export { default as schema } from './schema.json' with { type: 'json' };

// --- import.meta.resolve() (ES2025) ---

// @construct PENDING import-meta-resolve
const workerUrl = import.meta.resolve('./modules-helpers.js');

async function loadOptional(specifier) {
  try {
    const url = import.meta.resolve(specifier);
    return await import(url);
  } catch {
    return null;
  }
}

// --- WeakRef and FinalizationRegistry ---

// @construct PENDING weakref-cache
// @annotation
// FUNCTION <<createWeakCache>> -> CONTAINS -> VARIABLE <<cache>>
// VARIABLE <<cache>> -> ASSIGNED_FROM -> CALL <<new Map()>>
// FUNCTION <<createWeakCache>> -> RETURNS -> LITERAL <<object-literal>>
// LITERAL <<object-literal>> -> HAS_PROPERTY -> METHOD <<get>>
// METHOD <<get>> -> CONTAINS -> PARAMETER <<key>>
// METHOD <<get>> -> CONTAINS -> PARAMETER <<factory>>
// METHOD <<get>> -> CONTAINS -> VARIABLE <<ref>>
// VARIABLE <<ref>> -> ASSIGNED_FROM -> CALL <<cache.get(key)>>
// CALL <<cache.get(key)>> -> READS_FROM -> VARIABLE <<cache>>
// CALL <<cache.get(key)>> -> PASSES_ARGUMENT -> PARAMETER <<key>>
// METHOD <<get>> -> CONTAINS -> VARIABLE <<cached>>
// VARIABLE <<cached>> -> ASSIGNED_FROM -> CALL <<ref?.deref()>>
// CALL <<ref?.deref()>> -> READS_FROM -> VARIABLE <<ref>>
// METHOD <<get>> -> CONTAINS -> BRANCH <<if-cached>>
// BRANCH <<if-cached>> -> HAS_CONDITION -> VARIABLE <<cached>>
// BRANCH <<if-cached>> -> RETURNS -> VARIABLE <<cached>>
// METHOD <<get>> -> CONTAINS -> VARIABLE <<fresh>>
// VARIABLE <<fresh>> -> ASSIGNED_FROM -> CALL <<factory()>>
// CALL <<factory()>> -> CALLS -> PARAMETER <<factory>>
// METHOD <<get>> -> CONTAINS -> CALL <<cache.set(key, new WeakRef(fresh))>>
// CALL <<cache.set(key, new WeakRef(fresh))>> -> WRITES_TO -> VARIABLE <<cache>>
// CALL <<cache.set(key, new WeakRef(fresh))>> -> PASSES_ARGUMENT -> PARAMETER <<key>>
// CALL <<cache.set(key, new WeakRef(fresh))>> -> PASSES_ARGUMENT -> CALL <<new WeakRef(fresh)>>
// CALL <<new WeakRef(fresh)>> -> PASSES_ARGUMENT -> VARIABLE <<fresh>>
// METHOD <<get>> -> RETURNS -> VARIABLE <<fresh>>
// @end-annotation
function createWeakCache() {
  const cache = new Map();
  return {
    get(key, factory) {
      const ref = cache.get(key);
      const cached = ref?.deref();
      if (cached) return cached;
      const fresh = factory();
      cache.set(key, new WeakRef(fresh));
      return fresh;
    },
  };
}

// @construct PENDING finalization-registry
// @annotation
// VARIABLE <<cleanupRegistry>> -> ASSIGNED_FROM -> CALL <<new FinalizationRegistry>>
// CALL <<new FinalizationRegistry>> -> PASSES_ARGUMENT -> FUNCTION <<cleanup-callback>>
// FUNCTION <<cleanup-callback>> -> HAS_BODY -> PARAMETER <<key>>
// FUNCTION <<cleanup-callback>> -> HAS_BODY -> CALL <<console.log>>
// CALL <<console.log>> -> PASSES_ARGUMENT -> LITERAL <<template-literal>>
// LITERAL <<template-literal>> -> READS_FROM -> PARAMETER <<key>>
// FUNCTION <<trackObject>> -> HAS_BODY -> PARAMETER <<trackObject.key>>
// FUNCTION <<trackObject>> -> HAS_BODY -> PARAMETER <<trackObject.obj>>
// FUNCTION <<trackObject>> -> HAS_BODY -> CALL <<cleanupRegistry.register>>
// CALL <<cleanupRegistry.register>> -> CALLS_ON -> VARIABLE <<cleanupRegistry>>
// CALL <<cleanupRegistry.register>> -> PASSES_ARGUMENT -> PARAMETER <<trackObject.obj>>
// CALL <<cleanupRegistry.register>> -> PASSES_ARGUMENT -> PARAMETER <<trackObject.key>>
// @end-annotation
const cleanupRegistry = new FinalizationRegistry((key) => {
  console.log(`Object for key "${key}" was garbage collected`);
});

function trackObject(key, obj) {
  cleanupRegistry.register(obj, key);
}

// @construct PENDING export-named-list
// @annotation
// @end-annotation
export {
  arrayAt,
  arrayFindLast,
  arrayImmutable,
  objectGroupBy,
  mapGroupBy,
  createDeferred,
  wrapError,
  hasOwnCheck,
  deepClone,
  regexIndices,
  InfiniteOnes,
  AsyncSequence,
  Money,
  CustomCollection,
  SpecialArray,
  fetchWithAbort,
  usingSyncExample,
  usingAsyncExample,
  iteratorHelpers,
  setMethods,
  usingDeclaration,
  usingAwaitDeclaration,
  usingInFor,
  Reactive,
  workerUrl,
  loadOptional,
  createWeakCache,
  cleanupRegistry,
  trackObject,
};
