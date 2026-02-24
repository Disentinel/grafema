// =============================================================================
// aliasing.js — Method Extraction, Function Identity, Indirect Calls, arguments
// =============================================================================

// --- Method extraction & aliasing ---

// @construct PENDING alias-method-extraction
// @annotation
// VARIABLE <<log>> -> ASSIGNED_FROM -> PROPERTY_ACCESS <<console.log>>
// PROPERTY_ACCESS <<console.log>> -> READS_FROM -> UNKNOWN <<console>>
// CALL <<log('extracted')>> -> CALLS -> VARIABLE <<log>>
// CALL <<log('extracted')>> -> PASSES_ARGUMENT -> LITERAL <<'extracted'>>
// @end-annotation
const log = console.log;
log('extracted');

// @construct PENDING alias-destructured-method
// @annotation
// VARIABLE <<mathObj>> -> ASSIGNED_FROM -> LITERAL <<mathObj-object>>
// LITERAL <<mathObj-object>> -> HAS_PROPERTY -> METHOD <<add>>
// METHOD <<add>> -> CONTAINS -> PARAMETER <<a>>
// METHOD <<add>> -> CONTAINS -> PARAMETER <<b>>
// METHOD <<add>> -> RETURNS -> EXPRESSION <<a + b>>
// EXPRESSION <<a + b>> -> READS_FROM -> PARAMETER <<a>>
// EXPRESSION <<a + b>> -> READS_FROM -> PARAMETER <<b>>
// VARIABLE <<methodName>> -> ASSIGNED_FROM -> LITERAL <<'add'>>
// VARIABLE <<fn>> -> ASSIGNED_FROM -> PROPERTY_ACCESS <<mathObj[methodName]>>
// PROPERTY_ACCESS <<mathObj[methodName]>> -> READS_FROM -> VARIABLE <<mathObj>>
// PROPERTY_ACCESS <<mathObj[methodName]>> -> READS_FROM -> VARIABLE <<methodName>>
// PROPERTY_ACCESS <<mathObj[methodName]>> -> RESOLVES_TO -> METHOD <<add>>
// CALL <<fn(1, 2)>> -> CALLS -> VARIABLE <<fn>>
// CALL <<fn(1, 2)>> -> PASSES_ARGUMENT -> LITERAL <<1>>
// CALL <<fn(1, 2)>> -> PASSES_ARGUMENT -> LITERAL <<2>>
// @end-annotation
const { parse, stringify } = JSON;
const parsed = parse('{"a":1}');

// @construct PENDING alias-computed-method
const mathObj = { add(a, b) { return a + b; } };
const methodName = 'add';
const fn = mathObj[methodName];
fn(1, 2);

// --- Function reassignment ---

// @construct PENDING alias-reassign-function
// @annotation
// VARIABLE <<handler>> -> ASSIGNED_FROM -> FUNCTION <<first>>
// FUNCTION <<first>> -> RETURNS -> LITERAL <<1>>
// CALL <<handler()_1>> -> CALLS -> VARIABLE <<handler>>
// VARIABLE <<handler>> -> ASSIGNED_FROM -> FUNCTION <<second>>
// FUNCTION <<second>> -> RETURNS -> LITERAL <<2>>
// CALL <<handler()_2>> -> CALLS -> VARIABLE <<handler>>
// @end-annotation
let handler = function first() { return 1; };
handler();

handler = function second() { return 2; };
handler();

// @construct PENDING alias-reassign-conditional
// @annotation
// BRANCH <<if-random>> -> HAS_CONDITION -> EXPRESSION <<Math.random() > 0.5>>
// EXPRESSION <<Math.random() > 0.5>> -> CONTAINS -> CALL <<Math.random()>>
// EXPRESSION <<Math.random() > 0.5>> -> CONTAINS -> LITERAL <<0.5>>
// BRANCH <<if-random>> -> HAS_CONSEQUENT -> VARIABLE <<strategy>>
// VARIABLE <<strategy>> -> ASSIGNED_FROM -> FUNCTION <<fast>>
// FUNCTION <<fast>> -> RETURNS -> LITERAL <<'fast'>>
// BRANCH <<if-random>> -> HAS_ALTERNATE -> VARIABLE <<strategy>>
// VARIABLE <<strategy>> -> ASSIGNED_FROM -> FUNCTION <<slow>>
// FUNCTION <<slow>> -> RETURNS -> LITERAL <<'slow'>>
// CALL <<strategy()>> -> CALLS -> VARIABLE <<strategy>>
// @end-annotation
let strategy;
if (Math.random() > 0.5) {
  strategy = function fast() { return 'fast'; };
} else {
  strategy = function slow() { return 'slow'; };
}
strategy();

// --- Callback identity through higher-order functions ---

// @construct PENDING alias-callback-passed
// @annotation
// FUNCTION <<applyToArray>> -> HAS_BODY -> PARAMETER <<arr>>
// FUNCTION <<applyToArray>> -> HAS_BODY -> PARAMETER <<callback>>
// FUNCTION <<applyToArray>> -> RETURNS -> CALL <<arr.map(callback)>>
// CALL <<arr.map(callback)>> -> CALLS_ON -> PARAMETER <<arr>>
// CALL <<arr.map(callback)>> -> PASSES_ARGUMENT -> PARAMETER <<callback>>
// FUNCTION <<double>> -> HAS_BODY -> PARAMETER <<x>>
// FUNCTION <<double>> -> RETURNS -> EXPRESSION <<x * 2>>
// EXPRESSION <<x * 2>> -> READS_FROM -> PARAMETER <<x>>
// EXPRESSION <<x * 2>> -> READS_FROM -> LITERAL <<2>>
// CALL <<applyToArray([1, 2, 3], double)>> -> CALLS -> FUNCTION <<applyToArray>>
// CALL <<applyToArray([1, 2, 3], double)>> -> PASSES_ARGUMENT -> LITERAL <<[1, 2, 3]>>
// CALL <<applyToArray([1, 2, 3], double)>> -> PASSES_ARGUMENT -> FUNCTION <<double>>
// PARAMETER <<callback>> -> ALIASES -> FUNCTION <<double>>
// @end-annotation
function applyToArray(arr, callback) {
  return arr.map(callback);
}
function double(x) { return x * 2; }
applyToArray([1, 2, 3], double);

// @construct PENDING alias-callback-returned
// @annotation
// FUNCTION <<getComparator>> -> CONTAINS -> PARAMETER <<ascending>>
// FUNCTION <<getComparator>> -> CONTAINS -> BRANCH <<if-ascending>>
// BRANCH <<if-ascending>> -> HAS_CONDITION -> PARAMETER <<ascending>>
// BRANCH <<if-ascending>> -> HAS_CONSEQUENT -> FUNCTION <<ascending-comparator>>
// BRANCH <<if-ascending>> -> HAS_ALTERNATE -> FUNCTION <<descending-comparator>>
// FUNCTION <<ascending-comparator>> -> CONTAINS -> PARAMETER <<a1>>
// FUNCTION <<ascending-comparator>> -> CONTAINS -> PARAMETER <<b1>>
// FUNCTION <<ascending-comparator>> -> RETURNS -> EXPRESSION <<a1 - b1>>
// EXPRESSION <<a1 - b1>> -> READS_FROM -> PARAMETER <<a1>>
// EXPRESSION <<a1 - b1>> -> READS_FROM -> PARAMETER <<b1>>
// FUNCTION <<descending-comparator>> -> CONTAINS -> PARAMETER <<a2>>
// FUNCTION <<descending-comparator>> -> CONTAINS -> PARAMETER <<b2>>
// FUNCTION <<descending-comparator>> -> RETURNS -> EXPRESSION <<b2 - a2>>
// EXPRESSION <<b2 - a2>> -> READS_FROM -> PARAMETER <<b2>>
// EXPRESSION <<b2 - a2>> -> READS_FROM -> PARAMETER <<a2>>
// VARIABLE <<cmp>> -> ASSIGNED_FROM -> CALL <<getComparator(true)>>
// CALL <<getComparator(true)>> -> CALLS -> FUNCTION <<getComparator>>
// CALL <<getComparator(true)>> -> PASSES_ARGUMENT -> LITERAL <<true>>
// CALL <<[3, 1, 2].sort(cmp)>> -> CALLS_ON -> LITERAL <<[3, 1, 2]>>
// CALL <<[3, 1, 2].sort(cmp)>> -> PASSES_ARGUMENT -> VARIABLE <<cmp>>
// @end-annotation
function getComparator(ascending) {
  if (ascending) return (a, b) => a - b;
  return (a, b) => b - a;
}
const cmp = getComparator(true);
[3, 1, 2].sort(cmp);

// --- Wrapper / adapter patterns ---

// @construct PENDING alias-wrapper-transparent
// @annotation
// @end-annotation
function withLogging(wrappedFn) {
  return function (...args) {
    console.log('call:', wrappedFn.name, args);
    const result = wrappedFn.apply(this, args);
    console.log('result:', result);
    return result;
  };
}
const loggedAdd = withLogging(function add(a, b) { return a + b; });
loggedAdd(1, 2);

// @construct PENDING alias-bind-partial
// @annotation
// FUNCTION <<multiply>> -> HAS_BODY -> PARAMETER <<a>>
// FUNCTION <<multiply>> -> HAS_BODY -> PARAMETER <<b>>
// FUNCTION <<multiply>> -> RETURNS -> EXPRESSION <<a * b>>
// EXPRESSION <<a * b>> -> READS_FROM -> PARAMETER <<a>>
// EXPRESSION <<a * b>> -> READS_FROM -> PARAMETER <<b>>
// VARIABLE <<doubleIt>> -> ASSIGNED_FROM -> CALL <<multiply.bind(null, 2)>>
// CALL <<multiply.bind(null, 2)>> -> CALLS -> FUNCTION <<multiply>>
// CALL <<multiply.bind(null, 2)>> -> PASSES_ARGUMENT -> LITERAL <<null>>
// CALL <<multiply.bind(null, 2)>> -> PASSES_ARGUMENT -> LITERAL <<2>>
// CALL <<multiply.bind(null, 2)>> -> RETURNS -> FUNCTION <<doubleIt:bound>>
// FUNCTION <<doubleIt:bound>> -> DERIVES_FROM -> FUNCTION <<multiply>>
// FUNCTION <<doubleIt:bound>> -> CAPTURES -> LITERAL <<2>>
// CALL <<doubleIt(5)>> -> CALLS -> VARIABLE <<doubleIt>>
// CALL <<doubleIt(5)>> -> PASSES_ARGUMENT -> LITERAL <<5>>
// @end-annotation
function multiply(a, b) { return a * b; }
const doubleIt = multiply.bind(null, 2);
doubleIt(5);

// --- arguments object ---

// @construct PENDING arguments-basic
// @annotation
// FUNCTION <<sum>> -> CONTAINS -> VARIABLE <<total>>
// FUNCTION <<sum>> -> CONTAINS -> LOOP <<for-loop>>
// VARIABLE <<total>> -> ASSIGNED_FROM -> LITERAL <<0>>
// LOOP <<for-loop>> -> CONTAINS -> VARIABLE <<i>>
// VARIABLE <<i>> -> ASSIGNED_FROM -> LITERAL <<0>>
// LOOP <<for-loop>> -> HAS_CONDITION -> EXPRESSION <<i < arguments.length>>
// EXPRESSION <<i < arguments.length>> -> READS_FROM -> VARIABLE <<i>>
// EXPRESSION <<i < arguments.length>> -> READS_FROM -> PROPERTY_ACCESS <<arguments.length>>
// PROPERTY_ACCESS <<arguments.length>> -> READS_FROM -> EXTERNAL <<arguments>>
// LOOP <<for-loop>> -> HAS_UPDATE -> EXPRESSION <<i++>>
// EXPRESSION <<i++>> -> MODIFIES -> VARIABLE <<i>>
// LOOP <<for-loop>> -> HAS_BODY -> EXPRESSION <<total += arguments[i]>>
// EXPRESSION <<total += arguments[i]>> -> MODIFIES -> VARIABLE <<total>>
// EXPRESSION <<total += arguments[i]>> -> READS_FROM -> PROPERTY_ACCESS <<arguments[i]>>
// PROPERTY_ACCESS <<arguments[i]>> -> READS_FROM -> EXTERNAL <<arguments>>
// PROPERTY_ACCESS <<arguments[i]>> -> READS_FROM -> VARIABLE <<i>>
// FUNCTION <<sum>> -> RETURNS -> VARIABLE <<total>>
// FUNCTION <<sum>> -> CAPTURES -> EXTERNAL <<arguments>>
// @end-annotation
function sum() {
  let total = 0;
  for (let i = 0; i < arguments.length; i++) {
    total += arguments[i];
  }
  return total;
}

// @construct PENDING arguments-array-conversion
// @annotation
// FUNCTION <<toArray>> -> CONTAINS -> VARIABLE <<fromArrayFn>>
// VARIABLE <<fromArrayFn>> -> ASSIGNED_FROM -> CALL <<Array.from(arguments)>>
// CALL <<Array.from(arguments)>> -> CALLS -> PROPERTY_ACCESS <<Array.from>>
// CALL <<Array.from(arguments)>> -> PASSES_ARGUMENT -> VARIABLE <<arguments>>
// FUNCTION <<toArray>> -> CONTAINS -> VARIABLE <<fromSpread>>
// VARIABLE <<fromSpread>> -> ASSIGNED_FROM -> EXPRESSION <<[...arguments]>>
// EXPRESSION <<[...arguments]>> -> SPREADS_FROM -> VARIABLE <<arguments>>
// FUNCTION <<toArray>> -> CONTAINS -> VARIABLE <<fromSlice>>
// VARIABLE <<fromSlice>> -> ASSIGNED_FROM -> CALL <<[].slice.call(arguments)>>
// CALL <<[].slice.call(arguments)>> -> CALLS -> PROPERTY_ACCESS <<[].slice.call>>
// CALL <<[].slice.call(arguments)>> -> PASSES_ARGUMENT -> VARIABLE <<arguments>>
// PROPERTY_ACCESS <<[].slice>> -> READS_FROM -> LITERAL <<[]>>
// FUNCTION <<toArray>> -> RETURNS -> EXPRESSION <<{ fromArrayFn, fromSpread, fromSlice }>>
// EXPRESSION <<{ fromArrayFn, fromSpread, fromSlice }>> -> READS_FROM -> VARIABLE <<fromArrayFn>>
// EXPRESSION <<{ fromArrayFn, fromSpread, fromSlice }>> -> READS_FROM -> VARIABLE <<fromSpread>>
// EXPRESSION <<{ fromArrayFn, fromSpread, fromSlice }>> -> READS_FROM -> VARIABLE <<fromSlice>>
// @end-annotation
function toArray() {
  const fromArrayFn = Array.from(arguments);
  const fromSpread = [...arguments];
  const fromSlice = [].slice.call(arguments);
  return { fromArrayFn, fromSpread, fromSlice };
}

// @construct PENDING arguments-callee
// @annotation
// VARIABLE <<factorial>> -> ASSIGNED_FROM -> FUNCTION <<factorial:fn>>
// FUNCTION <<factorial:fn>> -> CONTAINS -> PARAMETER <<n>>
// FUNCTION <<factorial:fn>> -> RETURNS -> EXPRESSION <<ternary>>
// EXPRESSION <<ternary>> -> HAS_CONDITION -> EXPRESSION <<n <= 1>>
// EXPRESSION <<ternary>> -> HAS_CONSEQUENT -> LITERAL <<1-return>>
// EXPRESSION <<ternary>> -> HAS_ALTERNATE -> EXPRESSION <<n * arguments.callee(n - 1)>>
// EXPRESSION <<n <= 1>> -> READS_FROM -> PARAMETER <<n>>
// EXPRESSION <<n <= 1>> -> READS_FROM -> LITERAL <<1>>
// EXPRESSION <<n * arguments.callee(n - 1)>> -> READS_FROM -> PARAMETER <<n>>
// EXPRESSION <<n * arguments.callee(n - 1)>> -> READS_FROM -> CALL <<arguments.callee(n - 1)>>
// CALL <<arguments.callee(n - 1)>> -> CALLS -> PROPERTY_ACCESS <<arguments.callee>>
// CALL <<arguments.callee(n - 1)>> -> PASSES_ARGUMENT -> EXPRESSION <<n - 1>>
// EXPRESSION <<n - 1>> -> READS_FROM -> PARAMETER <<n>>
// EXPRESSION <<n - 1>> -> READS_FROM -> LITERAL <<1>>
// PROPERTY_ACCESS <<arguments.callee>> -> ALIASES -> FUNCTION <<factorial:fn>>
// @end-annotation
const factorial = function (n) {
  return n <= 1 ? 1 : n * arguments.callee(n - 1);
};

// --- Dynamic import edge cases ---

// @construct PENDING alias-import-dynamic-variable
// @annotation
// VARIABLE <<modulePath>> -> ASSIGNED_FROM -> LITERAL <<'./declarations.js'>>
// VARIABLE <<dynamicMod>> -> ASSIGNED_FROM -> CALL <<import(modulePath)>>
// CALL <<import(modulePath)>> -> PASSES_ARGUMENT -> VARIABLE <<modulePath>>
// CALL <<import(modulePath)>> -> IMPORTS_FROM -> EXTERNAL_MODULE <<./declarations.js>>
// VARIABLE <<dynamicMod>> -> ALIASES -> EXTERNAL_MODULE <<./declarations.js>>
// @end-annotation
const modulePath = './declarations.js';
const dynamicMod = await import(modulePath);

// @construct PENDING alias-import-dynamic-conditional
// @annotation
// FUNCTION <<loadPlugin>> -> CONTAINS -> PARAMETER <<name>>
// FUNCTION <<loadPlugin>> -> CONTAINS -> VARIABLE <<plugin>>
// VARIABLE <<plugin>> -> ASSIGNED_FROM -> IMPORT <<dynamic-import>>
// IMPORT <<dynamic-import>> -> IMPORTS_FROM -> EXPRESSION <<template-literal>>
// EXPRESSION <<template-literal>> -> READS_FROM -> PARAMETER <<name>>
// FUNCTION <<loadPlugin>> -> RETURNS -> PROPERTY_ACCESS <<plugin.default>>
// PROPERTY_ACCESS <<plugin.default>> -> READS_FROM -> VARIABLE <<plugin>>
// @end-annotation
const impl = await import(
  Math.random() > 0.5 ? './declarations.js' : './expressions.js'
);

// @construct PENDING alias-import-dynamic-template
async function loadPlugin(name) {
  const plugin = await import(`./plugins/${name}.js`);
  return plugin.default;
}

// @construct PENDING arguments-param-aliasing
// @annotation
// FUNCTION <<argumentsAliasing>> -> CONTAINS -> PARAMETER <<a>>
// FUNCTION <<argumentsAliasing>> -> CONTAINS -> PARAMETER <<b>>
// FUNCTION <<argumentsAliasing>> -> CONTAINS -> VARIABLE <<arguments>>
// VARIABLE <<arguments>> -> ALIASES -> PARAMETER <<a>>
// VARIABLE <<arguments>> -> ALIASES -> PARAMETER <<b>>
// PROPERTY_ACCESS <<arguments[0]>> -> ASSIGNED_FROM -> LITERAL <<99>>
// PARAMETER <<a>> -> ALIASES -> PROPERTY_ACCESS <<arguments[0]>>
// FUNCTION <<argumentsAliasing>> -> DECLARES -> VARIABLE <<aAfterMutation>>
// VARIABLE <<aAfterMutation>> -> ASSIGNED_FROM -> PARAMETER <<a>>
// PARAMETER <<a>> -> ASSIGNED_FROM -> LITERAL <<'changed'>>
// FUNCTION <<argumentsAliasing>> -> DECLARES -> VARIABLE <<arg0AfterReassign>>
// VARIABLE <<arg0AfterReassign>> -> ASSIGNED_FROM -> PROPERTY_ACCESS <<arguments[0]>>
// FUNCTION <<argumentsAliasing>> -> RETURNS -> EXPRESSION <<{ aAfterMutation, arg0AfterReassign }>>
// EXPRESSION <<{ aAfterMutation, arg0AfterReassign }>> -> READS_FROM -> VARIABLE <<aAfterMutation>>
// EXPRESSION <<{ aAfterMutation, arg0AfterReassign }>> -> READS_FROM -> VARIABLE <<arg0AfterReassign>>
// @end-annotation
function argumentsAliasing(a, b) {
  arguments[0] = 99;
  const aAfterMutation = a; // 99 in sloppy mode — bidirectional alias
  a = 'changed';
  const arg0AfterReassign = arguments[0]; // 'changed' in sloppy mode
  return { aAfterMutation, arg0AfterReassign };
}

// @construct PENDING arrow-no-arguments
// @annotation
// FUNCTION <<outerWithArguments>> -> CONTAINS -> VARIABLE <<arrow>>
// VARIABLE <<arrow>> -> ASSIGNED_FROM -> FUNCTION <<arrow:fn>>
// FUNCTION <<outerWithArguments>> -> RETURNS -> FUNCTION <<arrow:fn>>
// FUNCTION <<arrow:fn>> -> RETURNS -> PROPERTY_ACCESS <<arguments[0]>>
// PROPERTY_ACCESS <<arguments[0]>> -> CAPTURES -> FUNCTION <<outerWithArguments>>
// VARIABLE <<arrowFromOuter>> -> ASSIGNED_FROM -> CALL <<outerWithArguments(42)>>
// CALL <<outerWithArguments(42)>> -> CALLS -> FUNCTION <<outerWithArguments>>
// CALL <<outerWithArguments(42)>> -> PASSES_ARGUMENT -> LITERAL <<42>>
// @end-annotation
function outerWithArguments() {
  const arrow = () => {
    return arguments[0]; // captures OUTER function's arguments
  };
  return arrow;
}
const arrowFromOuter = outerWithArguments(42);

// @construct PENDING arguments-rest-coexistence
// @annotation
// FUNCTION <<argumentsWithRest>> -> CONTAINS -> PARAMETER <<first>>
// FUNCTION <<argumentsWithRest>> -> CONTAINS -> PARAMETER <<rest>>
// FUNCTION <<argumentsWithRest>> -> CONTAINS -> VARIABLE <<allCount>>
// FUNCTION <<argumentsWithRest>> -> CONTAINS -> VARIABLE <<firstFromArgs>>
// FUNCTION <<argumentsWithRest>> -> CONTAINS -> VARIABLE <<restFromArgs>>
// VARIABLE <<allCount>> -> ASSIGNED_FROM -> PROPERTY_ACCESS <<arguments.length>>
// PROPERTY_ACCESS <<arguments.length>> -> READS_FROM -> EXTERNAL <<arguments>>
// VARIABLE <<firstFromArgs>> -> ASSIGNED_FROM -> PROPERTY_ACCESS <<arguments[0]>>
// PROPERTY_ACCESS <<arguments[0]>> -> READS_FROM -> EXTERNAL <<arguments>>
// VARIABLE <<restFromArgs>> -> ASSIGNED_FROM -> PROPERTY_ACCESS <<arguments[1]>>
// PROPERTY_ACCESS <<arguments[1]>> -> READS_FROM -> EXTERNAL <<arguments>>
// FUNCTION <<argumentsWithRest>> -> RETURNS -> EXPRESSION <<return-object>>
// EXPRESSION <<return-object>> -> READS_FROM -> VARIABLE <<allCount>>
// EXPRESSION <<return-object>> -> READS_FROM -> VARIABLE <<firstFromArgs>>
// EXPRESSION <<return-object>> -> READS_FROM -> VARIABLE <<restFromArgs>>
// EXPRESSION <<return-object>> -> READS_FROM -> PARAMETER <<rest>>
// @end-annotation
function argumentsWithRest(first, ...rest) {
  const allCount = arguments.length;  // ALL args count (first + rest)
  const firstFromArgs = arguments[0]; // same as `first`
  const restFromArgs = arguments[1];  // same as rest[0]
  return { allCount, firstFromArgs, restFromArgs, rest };
}

// @construct PENDING export-named-list
// @annotation
// @end-annotation
export {
  log,
  parse,
  stringify,
  parsed,
  mathObj,
  methodName,
  fn,
  handler,
  strategy,
  applyToArray,
  double,
  getComparator,
  cmp,
  withLogging,
  loggedAdd,
  multiply,
  doubleIt,
  sum,
  toArray,
  factorial,
  dynamicMod,
  impl,
  loadPlugin,
  argumentsAliasing,
  outerWithArguments,
  arrowFromOuter,
  argumentsWithRest,
};
