// =============================================================================
// builtins.js — JSON, Map/Set, WeakRef, TypedArrays, Globals, Regex Usage
// =============================================================================

// --- JSON ---

// @construct PENDING builtin-json-parse
// @annotation
// FUNCTION <<jsonParse>> -> CONTAINS -> PARAMETER <<str>>
// FUNCTION <<jsonParse>> -> RETURNS -> CALL <<JSON.parse(str)>>
// CALL <<JSON.parse(str)>> -> CALLS -> PROPERTY_ACCESS <<JSON.parse>>
// CALL <<JSON.parse(str)>> -> PASSES_ARGUMENT -> PARAMETER <<str>>
// PROPERTY_ACCESS <<JSON.parse>> -> READS_FROM -> EXTERNAL <<JSON>>
// @end-annotation
function jsonParse(str) {
  return JSON.parse(str);
}

// @construct PENDING builtin-json-parse-reviver
function jsonParseReviver(str) {
  return JSON.parse(str, (key, value) => {
    if (key === 'date') return new Date(value);
    return value;
  });
}

// @construct PENDING builtin-json-stringify
// @annotation
// UNKNOWN <<MODULE>> -> DECLARES -> FUNCTION <<jsonStringify>>
// FUNCTION <<jsonStringify>> -> CONTAINS -> PARAMETER <<obj>>
// FUNCTION <<jsonStringify>> -> RETURNS -> CALL <<JSON.stringify(obj)>>
// CALL <<JSON.stringify(obj)>> -> CALLS -> PROPERTY_ACCESS <<JSON.stringify>>
// CALL <<JSON.stringify(obj)>> -> PASSES_ARGUMENT -> PARAMETER <<obj>>
// PROPERTY_ACCESS <<JSON.stringify>> -> ACCESSES_PRIVATE -> EXTERNAL <<JSON>>
// @end-annotation
function jsonStringify(obj) {
  return JSON.stringify(obj);
}

// @construct PENDING builtin-json-stringify-replacer
function jsonStringifyReplacer(obj) {
  return JSON.stringify(obj, (key, value) => {
    if (typeof value === 'function') return undefined;
    return value;
  }, 2);
}

// --- Map ---

// @construct PENDING builtin-map-ops
// @annotation
// @end-annotation
function mapOperations() {
  const map = new Map();
  map.set('a', 1);
  map.set('b', 2);
  map.set('c', 3);

  const hasA = map.has('a');
  const getB = map.get('b');
  map.delete('c');
  const size = map.size;

  const entries = [...map.entries()];
  const keys = [...map.keys()];
  const values = [...map.values()];

  map.forEach((value, key) => {
    console.log(key, value);
  });

  for (const [key, value] of map) {
    console.log(key, value);
  }

  map.clear();
  return { hasA, getB, size, entries, keys, values };
}

// @construct PENDING builtin-map-constructor
// @annotation
// FUNCTION <<mapFromEntries>> -> CONTAINS -> VARIABLE <<map>>
// VARIABLE <<map>> -> ASSIGNED_FROM -> CALL <<new Map([...])>>
// CALL <<new Map([...])>> -> CALLS -> EXTERNAL <<Map>>
// CALL <<new Map([...])>> -> PASSES_ARGUMENT -> LITERAL <<[['x', 10], ['y', 20]]>>
// LITERAL <<[['x', 10], ['y', 20]]>> -> HAS_ELEMENT -> LITERAL <<['x', 10]>>
// LITERAL <<[['x', 10], ['y', 20]]>> -> HAS_ELEMENT -> LITERAL <<['y', 20]>>
// LITERAL <<['x', 10]>> -> HAS_ELEMENT -> LITERAL <<'x'>>
// LITERAL <<['x', 10]>> -> HAS_ELEMENT -> LITERAL <<10>>
// LITERAL <<['y', 20]>> -> HAS_ELEMENT -> LITERAL <<'y'>>
// LITERAL <<['y', 20]>> -> HAS_ELEMENT -> LITERAL <<20>>
// FUNCTION <<mapFromEntries>> -> RETURNS -> VARIABLE <<map>>
// @end-annotation
function mapFromEntries() {
  const map = new Map([
    ['x', 10],
    ['y', 20],
  ]);
  return map;
}

// --- Set ---

// @construct PENDING builtin-set-ops
// @annotation
// @end-annotation
function setOperations() {
  const set = new Set([1, 2, 3, 2, 1]);
  set.add(4);
  const has3 = set.has(3);
  set.delete(1);
  const size = set.size;
  const values = [...set];

  set.forEach(v => console.log(v));

  for (const v of set) {
    console.log(v);
  }

  set.clear();
  return { has3, size, values };
}

// --- WeakMap / WeakSet ---

// @construct PENDING builtin-weakmap
// @annotation
// @end-annotation
function weakMapUsage() {
  const wm = new WeakMap();
  const key1 = {};
  const key2 = {};
  wm.set(key1, 'data1');
  wm.set(key2, 'data2');
  const val = wm.get(key1);
  const has = wm.has(key2);
  wm.delete(key1);
  return { val, has };
}

// @construct PENDING builtin-weakset
// @annotation
// FUNCTION <<weakSetUsage>> -> CONTAINS -> VARIABLE <<ws>>
// FUNCTION <<weakSetUsage>> -> CONTAINS -> VARIABLE <<obj1>>
// FUNCTION <<weakSetUsage>> -> CONTAINS -> VARIABLE <<obj2>>
// FUNCTION <<weakSetUsage>> -> CONTAINS -> VARIABLE <<has>>
// FUNCTION <<weakSetUsage>> -> CONTAINS -> VARIABLE <<hasAfter>>
// VARIABLE <<ws>> -> ASSIGNED_FROM -> CALL <<new WeakSet()>>
// CALL <<new WeakSet()>> -> CALLS -> UNKNOWN <<WeakSet>>
// VARIABLE <<obj1>> -> ASSIGNED_FROM -> LITERAL <<{}>>
// VARIABLE <<obj2>> -> ASSIGNED_FROM -> LITERAL <<{}2>>
// CALL <<ws.add(obj1)>> -> CALLS_ON -> VARIABLE <<ws>>
// CALL <<ws.add(obj1)>> -> PASSES_ARGUMENT -> VARIABLE <<obj1>>
// VARIABLE <<has>> -> ASSIGNED_FROM -> CALL <<ws.has(obj1)>>
// CALL <<ws.has(obj1)>> -> CALLS_ON -> VARIABLE <<ws>>
// CALL <<ws.has(obj1)>> -> PASSES_ARGUMENT -> VARIABLE <<obj1>>
// CALL <<ws.delete(obj1)>> -> CALLS_ON -> VARIABLE <<ws>>
// CALL <<ws.delete(obj1)>> -> PASSES_ARGUMENT -> VARIABLE <<obj1>>
// VARIABLE <<hasAfter>> -> ASSIGNED_FROM -> CALL <<ws.has(obj1)2>>
// CALL <<ws.has(obj1)2>> -> CALLS_ON -> VARIABLE <<ws>>
// CALL <<ws.has(obj1)2>> -> PASSES_ARGUMENT -> VARIABLE <<obj1>>
// FUNCTION <<weakSetUsage>> -> RETURNS -> EXPRESSION <<{ has, hasAfter }>>
// EXPRESSION <<{ has, hasAfter }>> -> READS_FROM -> VARIABLE <<has>>
// EXPRESSION <<{ has, hasAfter }>> -> READS_FROM -> VARIABLE <<hasAfter>>
// @end-annotation
function weakSetUsage() {
  const ws = new WeakSet();
  const obj1 = {};
  const obj2 = {};
  ws.add(obj1);
  const has = ws.has(obj1);
  ws.delete(obj1);
  const hasAfter = ws.has(obj1);
  return { has, hasAfter };
}

// --- WeakRef / FinalizationRegistry ---

// @construct PENDING builtin-weakref
// @annotation
// FUNCTION <<weakRefUsage>> -> CONTAINS -> VARIABLE <<target>>
// FUNCTION <<weakRefUsage>> -> CONTAINS -> VARIABLE <<ref>>
// FUNCTION <<weakRefUsage>> -> CONTAINS -> VARIABLE <<deref>>
// VARIABLE <<target>> -> ASSIGNED_FROM -> LITERAL <<{ data: 'important' }>>
// VARIABLE <<ref>> -> ASSIGNED_FROM -> CALL <<new WeakRef(target)>>
// CALL <<new WeakRef(target)>> -> PASSES_ARGUMENT -> VARIABLE <<target>>
// VARIABLE <<deref>> -> ASSIGNED_FROM -> CALL <<ref.deref()>>
// CALL <<ref.deref()>> -> CALLS_ON -> VARIABLE <<ref>>
// FUNCTION <<weakRefUsage>> -> RETURNS -> PROPERTY_ACCESS <<deref?.data>>
// PROPERTY_ACCESS <<deref?.data>> -> READS_FROM -> VARIABLE <<deref>>
// @end-annotation
function weakRefUsage() {
  let target = { data: 'important' };
  const ref = new WeakRef(target);
  const deref = ref.deref();
  return deref?.data;
}

// @construct PENDING builtin-finalization-registry
// @annotation
// FUNCTION <<finalizationUsage>> -> CONTAINS -> VARIABLE <<registry>>
// FUNCTION <<finalizationUsage>> -> CONTAINS -> VARIABLE <<obj>>
// VARIABLE <<registry>> -> ASSIGNED_FROM -> CALL <<new FinalizationRegistry(...)>>
// CALL <<new FinalizationRegistry(...)>> -> PASSES_ARGUMENT -> FUNCTION <<cleanup-callback>>
// FUNCTION <<cleanup-callback>> -> CONTAINS -> PARAMETER <<heldValue>>
// FUNCTION <<cleanup-callback>> -> CONTAINS -> CALL <<console.log(...)>>
// CALL <<console.log(...)>> -> PASSES_ARGUMENT -> EXPRESSION <<`Cleaned up: ${heldValue}`>>
// EXPRESSION <<`Cleaned up: ${heldValue}`>> -> READS_FROM -> PARAMETER <<heldValue>>
// VARIABLE <<obj>> -> ASSIGNED_FROM -> LITERAL <<{ id: 1 }>>
// FUNCTION <<finalizationUsage>> -> CONTAINS -> CALL <<registry.register(obj, 'resource-1')>>
// CALL <<registry.register(obj, 'resource-1')>> -> PASSES_ARGUMENT -> VARIABLE <<obj>>
// CALL <<registry.register(obj, 'resource-1')>> -> PASSES_ARGUMENT -> LITERAL <<'resource-1'>>
// FUNCTION <<finalizationUsage>> -> RETURNS -> VARIABLE <<obj>>
// @end-annotation
function finalizationUsage() {
  const registry = new FinalizationRegistry((heldValue) => {
    console.log(`Cleaned up: ${heldValue}`);
  });
  let obj = { id: 1 };
  registry.register(obj, 'resource-1');
  return obj;
}

// --- TypedArrays / ArrayBuffer ---

// @construct PENDING builtin-arraybuffer
// @annotation
// @end-annotation
function arrayBufferOps() {
  const buffer = new ArrayBuffer(16);
  const view = new DataView(buffer);
  view.setInt32(0, 42);
  view.setFloat64(4, 3.14);
  const int = view.getInt32(0);
  const float = view.getFloat64(4);
  return { int, float, byteLength: buffer.byteLength };
}

// @construct PENDING builtin-typed-arrays
// @annotation
// @end-annotation
function typedArrayOps() {
  const i32 = new Int32Array([1, 2, 3, 4]);
  const u8 = new Uint8Array(4);
  const f64 = new Float64Array([1.1, 2.2, 3.3]);

  u8.set([10, 20, 30, 40]);
  const sliced = i32.slice(1, 3);
  const mapped = i32.map(x => x * 2);
  const filtered = f64.filter(x => x > 2);

  return { i32, u8, f64, sliced, mapped, filtered };
}

// --- Regex usage ---

// @construct PENDING builtin-regex-exec
// @annotation
// @end-annotation
function regexExec(pattern, str) {
  const regex = new RegExp(pattern, 'g');
  const matches = [];
  let match;
  while ((match = regex.exec(str)) !== null) {
    matches.push({ match: match[0], index: match.index });
  }
  return matches;
}

// @construct PENDING builtin-regex-string-methods
// @annotation
// @end-annotation
function regexStringMethods(str) {
  const matchResult = str.match(/\d+/g);
  const matchAll = [...str.matchAll(/(\w+)=(\w+)/g)];
  const replaced = str.replace(/foo/g, 'bar');
  const replaceAll = str.replaceAll('a', 'b');
  const searchIdx = str.search(/\d/);
  const split = str.split(/[,;]/);
  return { matchResult, matchAll, replaced, replaceAll, searchIdx, split };
}

// @construct PENDING builtin-regex-named-groups
// @annotation
// FUNCTION <<regexNamedGroups>> -> CONTAINS -> PARAMETER <<dateStr>>
// FUNCTION <<regexNamedGroups>> -> CONTAINS -> VARIABLE <<pattern>>
// VARIABLE <<pattern>> -> ASSIGNED_FROM -> LITERAL <</(?<year>\d{4})-(?<month>\d{2})-(?<day>\d{2})/>>
// FUNCTION <<regexNamedGroups>> -> CONTAINS -> VARIABLE <<match>>
// VARIABLE <<match>> -> ASSIGNED_FROM -> CALL <<dateStr.match(pattern)>>
// CALL <<dateStr.match(pattern)>> -> READS_FROM -> PARAMETER <<dateStr>>
// CALL <<dateStr.match(pattern)>> -> PASSES_ARGUMENT -> VARIABLE <<pattern>>
// FUNCTION <<regexNamedGroups>> -> CONTAINS -> BRANCH <<if (!match)>>
// BRANCH <<if (!match)>> -> HAS_CONDITION -> VARIABLE <<match>>
// BRANCH <<if (!match)>> -> HAS_CONSEQUENT -> LITERAL <<null>>
// FUNCTION <<regexNamedGroups>> -> CONTAINS -> VARIABLE <<year>>
// FUNCTION <<regexNamedGroups>> -> CONTAINS -> VARIABLE <<month>>
// FUNCTION <<regexNamedGroups>> -> CONTAINS -> VARIABLE <<day>>
// VARIABLE <<year>> -> ASSIGNED_FROM -> PROPERTY_ACCESS <<match.groups>>
// VARIABLE <<month>> -> ASSIGNED_FROM -> PROPERTY_ACCESS <<match.groups>>
// VARIABLE <<day>> -> ASSIGNED_FROM -> PROPERTY_ACCESS <<match.groups>>
// PROPERTY_ACCESS <<match.groups>> -> READS_FROM -> VARIABLE <<match>>
// FUNCTION <<regexNamedGroups>> -> RETURNS -> LITERAL <<{...}>>
// LITERAL <<{...}>> -> READS_FROM -> VARIABLE <<year>>
// LITERAL <<{...}>> -> READS_FROM -> VARIABLE <<month>>
// LITERAL <<{...}>> -> READS_FROM -> VARIABLE <<day>>
// @end-annotation
function regexNamedGroups(dateStr) {
  const pattern = /(?<year>\d{4})-(?<month>\d{2})-(?<day>\d{2})/;
  const match = dateStr.match(pattern);
  if (!match) return null;
  const { year, month, day } = match.groups;
  return { year, month, day };
}

// --- Date ---

// @construct PENDING builtin-date
// @annotation
// @end-annotation
function dateOperations() {
  const now = new Date();
  const specific = new Date(2024, 0, 15);
  const fromISO = new Date('2024-01-15T10:30:00Z');
  const timestamp = Date.now();

  const year = now.getFullYear();
  const month = now.getMonth();
  const iso = now.toISOString();

  return { now, specific, fromISO, timestamp, year, month, iso };
}

// --- Math ---

// @construct PENDING builtin-math
// @annotation
// @end-annotation
function mathOperations() {
  const abs = Math.abs(-5);
  const ceil = Math.ceil(4.2);
  const floor = Math.floor(4.8);
  const round = Math.round(4.5);
  const trunc = Math.trunc(4.9);
  const max = Math.max(1, 2, 3);
  const min = Math.min(1, 2, 3);
  const pow = Math.pow(2, 10);
  const sqrt = Math.sqrt(16);
  const random = Math.random();
  const sign = Math.sign(-5);
  const log = Math.log2(8);
  const clz32 = Math.clz32(1);

  return { abs, ceil, floor, round, trunc, max, min, pow, sqrt, random, sign, log, clz32 };
}

// --- String methods ---

// @construct PENDING builtin-string-methods
// @annotation
// @end-annotation
function stringMethods(str) {
  const upper = str.toUpperCase();
  const lower = str.toLowerCase();
  const trimmed = str.trim();
  const starts = str.startsWith('he');
  const ends = str.endsWith('lo');
  const includes = str.includes('ll');
  const idx = str.indexOf('l');
  const lastIdx = str.lastIndexOf('l');
  const sliced = str.slice(1, 3);
  const sub = str.substring(1, 3);
  const padded = str.padStart(10, '0');
  const padEnd = str.padEnd(10, '.');
  const repeated = str.repeat(3);
  const charCode = str.charCodeAt(0);
  const at = str.at(-1);
  const replaced = str.replaceAll('l', 'r');

  return { upper, lower, trimmed, starts, ends, includes, idx, lastIdx, sliced, sub, padded, padEnd, repeated, charCode, at, replaced };
}

// --- Number / parsing ---

// @construct PENDING builtin-number-parsing
// @annotation
// @end-annotation
function numberParsing() {
  const fromString = Number('42');
  const fromBool = Number(true);
  const parseInt10 = parseInt('42', 10);
  const parseInt16 = parseInt('ff', 16);
  const parseF = parseFloat('3.14');
  const isNaN1 = Number.isNaN(NaN);
  const isFinite1 = Number.isFinite(42);
  const isInteger = Number.isInteger(42.0);
  const isSafe = Number.isSafeInteger(2 ** 53);
  const toFixed = (3.14159).toFixed(2);
  const toPrecision = (3.14159).toPrecision(4);

  return { fromString, fromBool, parseInt10, parseInt16, parseF, isNaN1, isFinite1, isInteger, isSafe, toFixed, toPrecision };
}

// --- BigInt operations ---

// @construct PENDING builtin-bigint-ops
// @annotation
// @end-annotation
function bigIntOperations() {
  const a = 100n;
  const b = 42n;
  const add = a + b;
  const sub = a - b;
  const mul = a * b;
  const div = a / b;
  const mod = a % b;
  const exp = a ** 2n;
  const neg = -a;

  const fromNumber = BigInt(Number.MAX_SAFE_INTEGER);
  const fromString = BigInt('999999999999999999');
  const toNumber = Number(42n);

  const compare = a > b;
  const mixed = a === 100n;

  return { add, sub, mul, div, mod, exp, neg, fromNumber, fromString, toNumber, compare, mixed };
}

// --- globalThis ---

// @construct PENDING builtin-globalthis
// @annotation
// FUNCTION <<globalThisAccess>> -> CONTAINS -> VARIABLE <<g>>
// FUNCTION <<globalThisAccess>> -> CONTAINS -> VARIABLE <<hasConsole>>
// VARIABLE <<g>> -> ASSIGNED_FROM -> EXTERNAL <<globalThis>>
// VARIABLE <<hasConsole>> -> ASSIGNED_FROM -> EXPRESSION <<'console' in globalThis>>
// EXPRESSION <<'console' in globalThis>> -> READS_FROM -> LITERAL <<'console'>>
// EXPRESSION <<'console' in globalThis>> -> READS_FROM -> EXTERNAL <<globalThis>>
// FUNCTION <<globalThisAccess>> -> RETURNS -> LITERAL <<{...}>>
// LITERAL <<{...}>> -> READS_FROM -> VARIABLE <<g>>
// LITERAL <<{...}>> -> READS_FROM -> VARIABLE <<hasConsole>>
// @end-annotation
function globalThisAccess() {
  const g = globalThis;
  const hasConsole = 'console' in globalThis;
  return { g, hasConsole };
}

// --- URL / URLSearchParams ---

// @construct PENDING builtin-url
// @annotation
// @end-annotation
function urlOperations() {
  const url = new URL('https://example.com/path?a=1&b=2#section');
  const { protocol, hostname, pathname, hash } = url;
  const params = new URLSearchParams(url.search);
  params.set('c', '3');
  params.delete('a');
  const hasB = params.has('b');
  const entries = [...params.entries()];

  return { protocol, hostname, pathname, hash, hasB, entries };
}

// @construct PENDING regex-lookahead
// @annotation
// UNKNOWN <<module>> -> DECLARES -> VARIABLE <<posLookahead>>
// VARIABLE <<posLookahead>> -> ASSIGNED_FROM -> LITERAL <</\d+(?=px)/>>
// UNKNOWN <<module>> -> DECLARES -> VARIABLE <<negLookahead>>
// VARIABLE <<negLookahead>> -> ASSIGNED_FROM -> LITERAL <</\d+(?!px)/>>
// @end-annotation
const posLookahead = /\d+(?=px)/;
const negLookahead = /\d+(?!px)/;

// @construct PENDING regex-lookbehind
// @annotation
// @end-annotation
const posLookbehind = /(?<=\$)\d+/;
const negLookbehind = /(?<!\$)\d+/;

// @construct PENDING regex-named-backref
// @annotation
// UNKNOWN <<MODULE>> -> DECLARES -> VARIABLE <<emoji>>
// VARIABLE <<emoji>> -> ASSIGNED_FROM -> LITERAL <</\p{Emoji}/u>>
// UNKNOWN <<MODULE>> -> DECLARES -> VARIABLE <<greek>>
// VARIABLE <<greek>> -> ASSIGNED_FROM -> LITERAL <</\p{Script=Greek}/u>>
// UNKNOWN <<MODULE>> -> DECLARES -> VARIABLE <<letter>>
// VARIABLE <<letter>> -> ASSIGNED_FROM -> LITERAL <</\p{Letter}/u>>
// @end-annotation
const repeatedChar = /(?<char>.)\k<char>/;

// @construct PENDING regex-unicode-props
// @annotation
// UNKNOWN <<module>> -> DECLARES -> VARIABLE <<windowsPath>>
// VARIABLE <<windowsPath>> -> ASSIGNED_FROM -> CALL <<String.raw`C:\Users\name\file`>>
// CALL <<String.raw`C:\Users\name\file`>> -> CALLS -> PROPERTY_ACCESS <<String.raw>>
// PROPERTY_ACCESS <<String.raw>> -> READS_FROM -> LITERAL <<String>>
// CALL <<String.raw`C:\Users\name\file`>> -> PASSES_ARGUMENT -> LITERAL <<template-literal>>
// @end-annotation
const emoji = /\p{Emoji}/u;
const greek = /\p{Script=Greek}/u;
const letter = /\p{Letter}/u;

// @construct PENDING string-raw-template
// @annotation
// FUNCTION <<sparseArrayOps>> -> CONTAINS -> VARIABLE <<sparse>>
// FUNCTION <<sparseArrayOps>> -> CONTAINS -> VARIABLE <<length>>
// FUNCTION <<sparseArrayOps>> -> CONTAINS -> VARIABLE <<hasIndex1>>
// FUNCTION <<sparseArrayOps>> -> CONTAINS -> VARIABLE <<mapped>>
// VARIABLE <<sparse>> -> ASSIGNED_FROM -> LITERAL <<sparse-array>>
// LITERAL <<sparse-array>> -> HAS_ELEMENT -> LITERAL <<1>>
// LITERAL <<sparse-array>> -> HAS_ELEMENT -> LITERAL <<3>>
// LITERAL <<sparse-array>> -> HAS_ELEMENT -> LITERAL <<5>>
// VARIABLE <<length>> -> ASSIGNED_FROM -> PROPERTY_ACCESS <<sparse.length>>
// PROPERTY_ACCESS <<sparse.length>> -> READS_FROM -> VARIABLE <<sparse>>
// VARIABLE <<hasIndex1>> -> ASSIGNED_FROM -> EXPRESSION <<1 in sparse>>
// EXPRESSION <<1 in sparse>> -> READS_FROM -> LITERAL <<1-key>>
// EXPRESSION <<1 in sparse>> -> READS_FROM -> VARIABLE <<sparse>>
// VARIABLE <<mapped>> -> ASSIGNED_FROM -> CALL <<sparse.map(x => x * 2)>>
// CALL <<sparse.map(x => x * 2)>> -> CALLS_ON -> VARIABLE <<sparse>>
// CALL <<sparse.map(x => x * 2)>> -> PASSES_ARGUMENT -> FUNCTION <<map-callback>>
// FUNCTION <<map-callback>> -> CONTAINS -> PARAMETER <<x>>
// FUNCTION <<map-callback>> -> RETURNS -> EXPRESSION <<x * 2>>
// EXPRESSION <<x * 2>> -> READS_FROM -> PARAMETER <<x>>
// EXPRESSION <<x * 2>> -> READS_FROM -> LITERAL <<2>>
// FUNCTION <<sparseArrayOps>> -> RETURNS -> LITERAL <<{...}>>
// LITERAL <<{...}>> -> HAS_PROPERTY -> VARIABLE <<length>>
// LITERAL <<{...}>> -> HAS_PROPERTY -> VARIABLE <<hasIndex1>>
// LITERAL <<{...}>> -> HAS_PROPERTY -> VARIABLE <<mapped>>
// @end-annotation
const windowsPath = String.raw`C:\Users\name\file`;
// windowsPath === 'C:\\Users\\name\\file' — no escape processing

// @construct PENDING sparse-array
function sparseArrayOps() {
  const sparse = [1, , 3, , 5];
  const length = sparse.length;       // 5
  const hasIndex1 = 1 in sparse;      // false — hole, not undefined
  const mapped = sparse.map(x => x * 2); // [2, empty, 6, empty, 10]
  return { length, hasIndex1, mapped };
}

// @construct PENDING array-from-mapfn
// @annotation
// FUNCTION <<arrayFromMapFn>> -> CONTAINS -> VARIABLE <<indices>>
// VARIABLE <<indices>> -> ASSIGNED_FROM -> CALL <<Array.from({ length: 5 }, (_, i) => i)>>
// CALL <<Array.from({ length: 5 }, (_, i) => i)>> -> CALLS -> UNKNOWN <<Array.from>>
// CALL <<Array.from({ length: 5 }, (_, i) => i)>> -> PASSES_ARGUMENT -> LITERAL <<{ length: 5 }>>
// CALL <<Array.from({ length: 5 }, (_, i) => i)>> -> PASSES_ARGUMENT -> FUNCTION <<(_, i) => i>>
// FUNCTION <<(_, i) => i>> -> CONTAINS -> PARAMETER <<_>>
// FUNCTION <<(_, i) => i>> -> CONTAINS -> PARAMETER <<i>>
// FUNCTION <<(_, i) => i>> -> RETURNS -> PARAMETER <<i>>
// FUNCTION <<arrayFromMapFn>> -> RETURNS -> VARIABLE <<indices>>
// @end-annotation
function arrayFromMapFn() {
  const indices = Array.from({ length: 5 }, (_, i) => i);
  return indices; // [0, 1, 2, 3, 4]
}

// --- Symbol.for cross-realm registry ---

// @construct PENDING symbol-for-cross-realm
// @annotation
// @end-annotation
function symbolForCrossRealm() {
  const key = Symbol.for('myapp.version');
  const sameKey = Symbol.for('myapp.version');
  const areSame = key === sameKey; // true — cross-realm identity
  const name = Symbol.keyFor(key); // 'myapp.version'
  const localSym = Symbol('local');
  const noName = Symbol.keyFor(localSym); // undefined — not in global registry
  return { areSame, name, noName };
}

// @construct PENDING symbol-private-property
// @annotation
// VARIABLE <<_private>> -> ASSIGNED_FROM -> CALL <<Symbol('private')>>
// CALL <<Symbol('private')>> -> PASSES_ARGUMENT -> LITERAL <<'private'>>
// CLASS <<SymbolStore>> -> CONTAINS -> PROPERTY <<SymbolStore[_private]>>
// PROPERTY <<SymbolStore[_private]>> -> USES -> VARIABLE <<_private>>
// PROPERTY <<SymbolStore[_private]>> -> ASSIGNED_FROM -> CALL <<new Map()>>
// CLASS <<SymbolStore>> -> CONTAINS -> METHOD <<SymbolStore.set>>
// METHOD <<SymbolStore.set>> -> CONTAINS -> PARAMETER <<key>>
// METHOD <<SymbolStore.set>> -> CONTAINS -> PARAMETER <<value>>
// METHOD <<SymbolStore.set>> -> CONTAINS -> CALL <<this[_private].set(key, value)>>
// PROPERTY_ACCESS <<this[_private]>> -> READS_FROM -> VARIABLE <<_private>>
// CALL <<this[_private].set(key, value)>> -> CALLS_ON -> PROPERTY_ACCESS <<this[_private]>>
// CALL <<this[_private].set(key, value)>> -> PASSES_ARGUMENT -> PARAMETER <<key>>
// CALL <<this[_private].set(key, value)>> -> PASSES_ARGUMENT -> PARAMETER <<value>>
// CLASS <<SymbolStore>> -> CONTAINS -> METHOD <<SymbolStore.get>>
// METHOD <<SymbolStore.get>> -> CONTAINS -> PARAMETER <<key2>>
// METHOD <<SymbolStore.get>> -> RETURNS -> CALL <<this[_private].get(key)>>
// PROPERTY_ACCESS <<this[_private]2>> -> READS_FROM -> VARIABLE <<_private>>
// CALL <<this[_private].get(key)>> -> CALLS_ON -> PROPERTY_ACCESS <<this[_private]2>>
// CALL <<this[_private].get(key)>> -> PASSES_ARGUMENT -> PARAMETER <<key2>>
// @end-annotation
const _private = Symbol('private');
class SymbolStore {
  [_private] = new Map();
  set(key, value) { this[_private].set(key, value); }
  get(key) { return this[_private].get(key); }
}

// --- WeakMap as private instance data (pre-#field pattern) ---

// @construct PENDING weakmap-private-data
// @annotation
// @end-annotation
const _counter = new WeakMap();

class SafeCounter {
  constructor(initial = 0) {
    // Module-level WeakMap used as private namespace — NOT accessible from outside
    _counter.set(this, { count: initial, history: [] });
  }

  increment() {
    const d = _counter.get(this);
    d.history.push(d.count);
    d.count++;
  }

  get value() {
    return _counter.get(this).count;
  }

  reset() {
    const d = _counter.get(this);
    d.history = [];
    d.count = 0;
  }
}

// @construct PENDING export-named-list
export {
  jsonParse,
  jsonParseReviver,
  jsonStringify,
  jsonStringifyReplacer,
  mapOperations,
  mapFromEntries,
  setOperations,
  weakMapUsage,
  weakSetUsage,
  weakRefUsage,
  finalizationUsage,
  arrayBufferOps,
  typedArrayOps,
  regexExec,
  regexStringMethods,
  regexNamedGroups,
  dateOperations,
  mathOperations,
  stringMethods,
  numberParsing,
  bigIntOperations,
  globalThisAccess,
  urlOperations,
  posLookahead,
  negLookahead,
  posLookbehind,
  negLookbehind,
  repeatedChar,
  emoji,
  greek,
  letter,
  windowsPath,
  sparseArrayOps,
  arrayFromMapFn,
  symbolForCrossRealm,
  SymbolStore,
  SafeCounter,
};
