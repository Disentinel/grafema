// =============================================================================
// declarations.js — Variable & Function Declaration Forms
// =============================================================================

// @construct PENDING var-decl-init
// @annotation
// UNKNOWN <<module>> -> DECLARES -> VARIABLE <<mutableVar>>
// VARIABLE <<mutableVar>> -> ASSIGNED_FROM -> LITERAL <<'hello'>>
// @end-annotation
var mutableVar = 'hello';

// @construct PENDING var-decl-uninit
// @annotation
// UNKNOWN <<module>> -> DECLARES -> VARIABLE <<multi1>>
// VARIABLE <<multi1>> -> ASSIGNED_FROM -> LITERAL <<1>>
// UNKNOWN <<module>> -> DECLARES -> VARIABLE <<multi2>>
// VARIABLE <<multi2>> -> ASSIGNED_FROM -> LITERAL <<2>>
// UNKNOWN <<module>> -> DECLARES -> VARIABLE <<multi3>>
// VARIABLE <<multi3>> -> ASSIGNED_FROM -> LITERAL <<3>>
// @end-annotation
var uninitialized;

// @construct PENDING var-decl-multi
// @annotation
// UNKNOWN <<module>> -> DECLARES -> VARIABLE <<reassignable>>
// VARIABLE <<reassignable>> -> ASSIGNED_FROM -> LITERAL <<42>>
// @end-annotation
var multi1 = 1, multi2 = 2, multi3 = 3;

// @construct PENDING let-decl-init
// @annotation
// UNKNOWN <<module>> -> DECLARES -> VARIABLE <<uninitializedLet>>
// @end-annotation
let reassignable = 42;

// @construct PENDING let-decl-uninit
// @annotation
// UNKNOWN <<module>> -> DECLARES -> VARIABLE <<immutable>>
// VARIABLE <<immutable>> -> ASSIGNED_FROM -> LITERAL <<true>>
// @end-annotation
let uninitializedLet;

// @construct PENDING const-decl-bool-literal
// @annotation
// UNKNOWN <<module>> -> DECLARES -> VARIABLE <<objectConst>>
// VARIABLE <<objectConst>> -> ASSIGNED_FROM -> LITERAL <<objectConst:object>>
// LITERAL <<objectConst:object>> -> HAS_PROPERTY -> LITERAL <<'key'>>
// LITERAL <<'key'>> -> ASSIGNED_FROM -> LITERAL <<'value'>>
// @end-annotation
const immutable = true;

// @construct PENDING const-decl-object-literal
// @annotation
// UNKNOWN <<module>> -> DECLARES -> VARIABLE <<arrayConst>>
// VARIABLE <<arrayConst>> -> ASSIGNED_FROM -> LITERAL <<[1, 2, 3]>>
// LITERAL <<[1, 2, 3]>> -> HAS_ELEMENT -> LITERAL <<1>>
// LITERAL <<[1, 2, 3]>> -> HAS_ELEMENT -> LITERAL <<2>>
// LITERAL <<[1, 2, 3]>> -> HAS_ELEMENT -> LITERAL <<3>>
// @end-annotation
const objectConst = { key: 'value' };

// @construct PENDING const-decl-array-literal
// @annotation
// UNKNOWN <<module>> -> DECLARES -> VARIABLE <<bigNumber>>
// VARIABLE <<bigNumber>> -> ASSIGNED_FROM -> LITERAL <<42n>>
// @end-annotation
const arrayConst = [1, 2, 3];

// @construct PENDING const-decl-bigint-literal
// @annotation
// UNKNOWN <<module>> -> DECLARES -> VARIABLE <<bigComputed>>
// VARIABLE <<bigComputed>> -> ASSIGNED_FROM -> CALL <<BigInt(Number.MAX_SAFE_INTEGER)>>
// CALL <<BigInt(Number.MAX_SAFE_INTEGER)>> -> CALLS -> UNKNOWN <<BigInt>>
// CALL <<BigInt(Number.MAX_SAFE_INTEGER)>> -> PASSES_ARGUMENT -> PROPERTY_ACCESS <<Number.MAX_SAFE_INTEGER>>
// PROPERTY_ACCESS <<Number.MAX_SAFE_INTEGER>> -> READS_FROM -> UNKNOWN <<Number>>
// @end-annotation
const bigNumber = 42n;

// @construct PENDING const-decl-call-result
// @annotation
// UNKNOWN <<module>> -> DECLARES -> VARIABLE <<uniqueKey>>
// VARIABLE <<uniqueKey>> -> ASSIGNED_FROM -> CALL <<Symbol('description')>>
// CALL <<Symbol('description')>> -> CALLS -> UNKNOWN <<Symbol>>
// CALL <<Symbol('description')>> -> PASSES_ARGUMENT -> LITERAL <<'description'>>
// @end-annotation
const bigComputed = BigInt(Number.MAX_SAFE_INTEGER);

// @construct PENDING const-decl-call-result
// @annotation
// UNKNOWN <<module>> -> DECLARES -> VARIABLE <<globalSymbol>>
// VARIABLE <<globalSymbol>> -> ASSIGNED_FROM -> CALL <<Symbol.for('shared')>>
// CALL <<Symbol.for('shared')>> -> CALLS -> PROPERTY_ACCESS <<Symbol.for>>
// CALL <<Symbol.for('shared')>> -> PASSES_ARGUMENT -> LITERAL <<'shared'>>
// PROPERTY_ACCESS <<Symbol.for>> -> READS_FROM -> EXTERNAL <<Symbol>>
// @end-annotation
const uniqueKey = Symbol('description');

// @construct PENDING const-decl-method-call-result
// @annotation
// UNKNOWN <<module>> -> DECLARES -> VARIABLE <<regexSimple>>
// VARIABLE <<regexSimple>> -> ASSIGNED_FROM -> LITERAL <</hello/>>
// UNKNOWN <<module>> -> DECLARES -> VARIABLE <<regexFlags>>
// VARIABLE <<regexFlags>> -> ASSIGNED_FROM -> LITERAL <</pattern/gi>>
// UNKNOWN <<module>> -> DECLARES -> VARIABLE <<regexComplex>>
// VARIABLE <<regexComplex>> -> ASSIGNED_FROM -> LITERAL <</^start.*end$/ms>>
// @end-annotation
const globalSymbol = Symbol.for('shared');

// @construct PENDING const-decl-regex-literal
const regexSimple = /hello/;
const regexFlags = /pattern/gi;
const regexComplex = /^start.*end$/ms;

// =============================================================================
// Function Declarations
// =============================================================================

// @construct PENDING func-decl
// @annotation
// UNKNOWN <<module>> -> DECLARES -> FUNCTION <<regularFunction>>
// FUNCTION <<regularFunction>> -> CONTAINS -> PARAMETER <<param1>>
// FUNCTION <<regularFunction>> -> CONTAINS -> PARAMETER <<param2>>
// FUNCTION <<regularFunction>> -> RETURNS -> EXPRESSION <<param1 + param2>>
// EXPRESSION <<param1 + param2>> -> READS_FROM -> PARAMETER <<param1>>
// EXPRESSION <<param1 + param2>> -> READS_FROM -> PARAMETER <<param2>>
// @end-annotation
function regularFunction(param1, param2) {
  return param1 + param2;
}

// @construct PENDING func-decl-defaults
// @annotation
// UNKNOWN <<module>> -> DECLARES -> FUNCTION <<withRestParams>>
// FUNCTION <<withRestParams>> -> CONTAINS -> PARAMETER <<args>>
// FUNCTION <<withRestParams>> -> RETURNS -> PROPERTY_ACCESS <<args.length>>
// PROPERTY_ACCESS <<args.length>> -> READS_FROM -> PARAMETER <<args>>
// @end-annotation
function withDefaults(a = 10, b = 'default') {
  return `${a}${b}`;
}

// @construct PENDING func-decl-rest-params
// @annotation
// FUNCTION <<withMixedParams>> -> CONTAINS -> PARAMETER <<required>>
// FUNCTION <<withMixedParams>> -> CONTAINS -> PARAMETER <<optional>>
// FUNCTION <<withMixedParams>> -> CONTAINS -> PARAMETER <<rest>>
// PARAMETER <<optional>> -> DEFAULTS_TO -> LITERAL <<null>>
// FUNCTION <<withMixedParams>> -> RETURNS -> EXPRESSION <<[required, optional, ...rest]>>
// EXPRESSION <<[required, optional, ...rest]>> -> READS_FROM -> PARAMETER <<required>>
// EXPRESSION <<[required, optional, ...rest]>> -> READS_FROM -> PARAMETER <<optional>>
// EXPRESSION <<[required, optional, ...rest]>> -> READS_FROM -> PARAMETER <<rest>>
// @end-annotation
function withRestParams(...args) {
  return args.length;
}

// @construct PENDING func-decl-mixed-params
function withMixedParams(required, optional = null, ...rest) {
  return [required, optional, ...rest];
}

// =============================================================================
// Function Expressions
// =============================================================================

// @construct PENDING func-expr-named
// @annotation
// UNKNOWN <<module>> -> DECLARES -> VARIABLE <<namedExpression>>
// VARIABLE <<namedExpression>> -> ASSIGNED_FROM -> FUNCTION <<multiply>>
// FUNCTION <<multiply>> -> CONTAINS -> PARAMETER <<x>>
// FUNCTION <<multiply>> -> CONTAINS -> PARAMETER <<y>>
// FUNCTION <<multiply>> -> RETURNS -> EXPRESSION <<x * y>>
// EXPRESSION <<x * y>> -> READS_FROM -> PARAMETER <<x>>
// EXPRESSION <<x * y>> -> READS_FROM -> PARAMETER <<y>>
// @end-annotation
const namedExpression = function multiply(x, y) {
  return x * y;
};

// @construct PENDING func-expr-anonymous
const anonymousExpression = function (x) {
  return x * 2;
};

// =============================================================================
// Arrow Functions
// =============================================================================

// @construct PENDING arrow-block-body
// @annotation
// UNKNOWN <<module>> -> DECLARES -> VARIABLE <<arrowBlock>>
// VARIABLE <<arrowBlock>> -> ASSIGNED_FROM -> FUNCTION <<arrowBlock:fn>>
// FUNCTION <<arrowBlock:fn>> -> CONTAINS -> PARAMETER <<a>>
// FUNCTION <<arrowBlock:fn>> -> CONTAINS -> PARAMETER <<b>>
// FUNCTION <<arrowBlock:fn>> -> RETURNS -> EXPRESSION <<a + b>>
// EXPRESSION <<a + b>> -> READS_FROM -> PARAMETER <<a>>
// EXPRESSION <<a + b>> -> READS_FROM -> PARAMETER <<b>>
// @end-annotation
const arrowBlock = (a, b) => {
  return a + b;
};

// @construct PENDING arrow-expression-body
// @annotation
// UNKNOWN <<module>> -> DECLARES -> VARIABLE <<arrowSingleParam>>
// VARIABLE <<arrowSingleParam>> -> ASSIGNED_FROM -> FUNCTION <<arrowSingleParam:fn>>
// FUNCTION <<arrowSingleParam:fn>> -> CONTAINS -> PARAMETER <<x>>
// FUNCTION <<arrowSingleParam:fn>> -> RETURNS -> EXPRESSION <<x * 2>>
// EXPRESSION <<x * 2>> -> READS_FROM -> PARAMETER <<x>>
// EXPRESSION <<x * 2>> -> READS_FROM -> LITERAL <<2>>
// @end-annotation
const arrowExpression = (a, b) => a + b;

// @construct PENDING arrow-single-param
// @annotation
// UNKNOWN <<module>> -> DECLARES -> VARIABLE <<arrowNoParams>>
// VARIABLE <<arrowNoParams>> -> ASSIGNED_FROM -> FUNCTION <<arrowNoParams:fn>>
// FUNCTION <<arrowNoParams:fn>> -> RETURNS -> LITERAL <<42>>
// @end-annotation
const arrowSingleParam = x => x * 2;

// @construct PENDING arrow-no-params
const arrowNoParams = () => 42;

// =============================================================================
// Generator Functions
// =============================================================================

// @construct PENDING generator-decl
// @annotation
// UNKNOWN <<module>> -> DECLARES -> FUNCTION <<numberGenerator>>
// FUNCTION <<numberGenerator>> -> YIELDS -> LITERAL <<1>>
// FUNCTION <<numberGenerator>> -> YIELDS -> LITERAL <<2>>
// FUNCTION <<numberGenerator>> -> YIELDS -> LITERAL <<3>>
// @end-annotation
function* numberGenerator() {
  yield 1;
  yield 2;
  yield 3;
}

// @construct PENDING generator-delegation
// @annotation
// UNKNOWN <<module>> -> DECLARES -> FUNCTION <<delegatingGenerator>>
// FUNCTION <<delegatingGenerator>> -> CONTAINS -> EXPRESSION <<yield* numberGenerator()>>
// FUNCTION <<delegatingGenerator>> -> CONTAINS -> EXPRESSION <<yield 4>>
// EXPRESSION <<yield* numberGenerator()>> -> DELEGATES_TO -> CALL <<numberGenerator()>>
// CALL <<numberGenerator()>> -> CALLS -> UNKNOWN <<numberGenerator>>
// EXPRESSION <<yield 4>> -> YIELDS -> LITERAL <<4>>
// @end-annotation
function* delegatingGenerator() {
  yield* numberGenerator();
  yield 4;
}

// =============================================================================
// Async Functions
// =============================================================================

// @construct PENDING async-func-decl
// @annotation
// UNKNOWN <<module>> -> DECLARES -> FUNCTION <<asyncFunction>>
// FUNCTION <<asyncFunction>> -> RETURNS -> EXPRESSION <<await Promise.resolve(42)>>
// EXPRESSION <<await Promise.resolve(42)>> -> AWAITS -> CALL <<Promise.resolve(42)>>
// CALL <<Promise.resolve(42)>> -> CALLS -> UNKNOWN <<Promise.resolve>>
// CALL <<Promise.resolve(42)>> -> PASSES_ARGUMENT -> LITERAL <<42>>
// @end-annotation
async function asyncFunction() {
  return await Promise.resolve(42);
}

// @construct PENDING async-arrow
const asyncArrow = async () => {
  return await Promise.resolve('async arrow');
};

// =============================================================================
// Async Generator Functions
// =============================================================================

// @construct PENDING async-generator-decl
// @annotation
// FUNCTION <<asyncGenerator>> -> CONTAINS -> EXPRESSION <<yield await Promise.resolve(1)>>
// FUNCTION <<asyncGenerator>> -> CONTAINS -> EXPRESSION <<yield await Promise.resolve(2)>>
// EXPRESSION <<yield await Promise.resolve(1)>> -> YIELDS -> EXPRESSION <<await Promise.resolve(1)>>
// EXPRESSION <<await Promise.resolve(1)>> -> AWAITS -> CALL <<Promise.resolve(1)>>
// CALL <<Promise.resolve(1)>> -> CALLS_ON -> EXTERNAL <<Promise>>
// CALL <<Promise.resolve(1)>> -> PASSES_ARGUMENT -> LITERAL <<1>>
// EXPRESSION <<yield await Promise.resolve(2)>> -> YIELDS -> EXPRESSION <<await Promise.resolve(2)>>
// EXPRESSION <<await Promise.resolve(2)>> -> AWAITS -> CALL <<Promise.resolve(2)>>
// CALL <<Promise.resolve(2)>> -> CALLS_ON -> EXTERNAL <<Promise>>
// CALL <<Promise.resolve(2)>> -> PASSES_ARGUMENT -> LITERAL <<2>>
// @end-annotation
async function* asyncGenerator() {
  yield await Promise.resolve(1);
  yield await Promise.resolve(2);
}

// =============================================================================
// IIFE (Immediately Invoked Function Expression)
// =============================================================================

// @construct PENDING iife
// @annotation
// UNKNOWN <<module>> -> DECLARES -> VARIABLE <<iifeResult>>
// FUNCTION <<iife:fn>> -> RETURNS -> LITERAL <<'iife'>>
// CALL <<iife:call>> -> CALLS -> FUNCTION <<iife:fn>>
// VARIABLE <<iifeResult>> -> ASSIGNED_FROM -> CALL <<iife:call>>
// @end-annotation
const iifeResult = (function () {
  return 'iife';
})();

// @construct PENDING iife-arrow
const arrowIifeResult = (() => {
  return 'arrow iife';
})();

// =============================================================================
// Named Exports
// =============================================================================

// @construct PENDING param-default-depends-on-prior
// @annotation
// FUNCTION <<paramDefaultChain>> -> CONTAINS -> PARAMETER <<a>>
// FUNCTION <<paramDefaultChain>> -> CONTAINS -> PARAMETER <<b>>
// FUNCTION <<paramDefaultChain>> -> CONTAINS -> PARAMETER <<c>>
// PARAMETER <<b>> -> DEFAULTS_TO -> EXPRESSION <<a * 2>>
// EXPRESSION <<a * 2>> -> READS_FROM -> PARAMETER <<a>>
// EXPRESSION <<a * 2>> -> READS_FROM -> LITERAL <<2>>
// PARAMETER <<c>> -> DEFAULTS_TO -> EXPRESSION <<a + b>>
// EXPRESSION <<a + b>> -> READS_FROM -> PARAMETER <<a>>
// EXPRESSION <<a + b>> -> READS_FROM -> PARAMETER <<b>>
// FUNCTION <<paramDefaultChain>> -> RETURNS -> LITERAL <<{...}>>
// LITERAL <<{...}>> -> READS_FROM -> PARAMETER <<a>>
// LITERAL <<{...}>> -> READS_FROM -> PARAMETER <<b>>
// LITERAL <<{...}>> -> READS_FROM -> PARAMETER <<c>>
// @end-annotation
function paramDefaultChain(a, b = a * 2, c = a + b) {
  return { a, b, c };
}

// @construct PENDING param-default-scope-quirk
let outerX = 'outer';
function paramDefaultScope(a = () => outerX, outerX) {
  return a();
}

// @construct PENDING arrow-return-object-literal
// @annotation
// UNKNOWN <<module>> -> DECLARES -> VARIABLE <<arrowReturnsObject>>
// VARIABLE <<arrowReturnsObject>> -> ASSIGNED_FROM -> FUNCTION <<arrowReturnsObject:fn>>
// FUNCTION <<arrowReturnsObject:fn>> -> CONTAINS -> PARAMETER <<x>>
// FUNCTION <<arrowReturnsObject:fn>> -> RETURNS -> LITERAL <<object-literal>>
// LITERAL <<object-literal>> -> HAS_PROPERTY -> PARAMETER <<x>>
// LITERAL <<object-literal>> -> HAS_PROPERTY -> EXPRESSION <<x * 2>>
// EXPRESSION <<x * 2>> -> READS_FROM -> PARAMETER <<x>>
// EXPRESSION <<x * 2>> -> READS_FROM -> LITERAL <<2>>
// @end-annotation
const arrowReturnsObject = (x) => ({ key: x, value: x * 2 });
// Without parens: (x) => { key: x } — parsed as block with label "key"!

// @construct PENDING async-iife
// @annotation
// VARIABLE <<constMultiA>> -> ASSIGNED_FROM -> LITERAL <<1>>
// VARIABLE <<constMultiB>> -> ASSIGNED_FROM -> EXPRESSION <<constMultiA + 1>>
// EXPRESSION <<constMultiA + 1>> -> READS_FROM -> VARIABLE <<constMultiA>>
// VARIABLE <<constMultiC>> -> ASSIGNED_FROM -> EXPRESSION <<constMultiA + constMultiB>>
// EXPRESSION <<constMultiA + constMultiB>> -> READS_FROM -> VARIABLE <<constMultiA>>
// EXPRESSION <<constMultiA + constMultiB>> -> READS_FROM -> VARIABLE <<constMultiB>>
// VARIABLE <<letMultiX>> -> ASSIGNED_FROM -> LITERAL <<0>>
// VARIABLE <<letMultiY>> -> ASSIGNED_FROM -> EXPRESSION <<letMultiX + 1>>
// EXPRESSION <<letMultiX + 1>> -> READS_FROM -> VARIABLE <<letMultiX>>
// @end-annotation
const asyncIifeResult = (async () => {
  return await Promise.resolve('async iife');
})();

// @construct PENDING let-const-multi-declaration
// @annotation
// VARIABLE <<factorialNamedExpr>> -> ASSIGNED_FROM -> FUNCTION <<fact>>
// FUNCTION <<fact>> -> CONTAINS -> PARAMETER <<n>>
// FUNCTION <<fact>> -> HAS_CONDITION -> EXPRESSION <<n <= 1>>
// EXPRESSION <<n <= 1>> -> READS_FROM -> PARAMETER <<n>>
// EXPRESSION <<n <= 1>> -> READS_FROM -> LITERAL <<1>>
// FUNCTION <<fact>> -> HAS_CONSEQUENT -> LITERAL <<1-return>>
// FUNCTION <<fact>> -> HAS_ALTERNATE -> EXPRESSION <<n * fact(n - 1)>>
// EXPRESSION <<n * fact(n - 1)>> -> READS_FROM -> PARAMETER <<n>>
// EXPRESSION <<n * fact(n - 1)>> -> READS_FROM -> CALL <<fact(n - 1)>>
// CALL <<fact(n - 1)>> -> CALLS -> FUNCTION <<fact>>
// CALL <<fact(n - 1)>> -> PASSES_ARGUMENT -> EXPRESSION <<n - 1>>
// EXPRESSION <<n - 1>> -> READS_FROM -> PARAMETER <<n>>
// EXPRESSION <<n - 1>> -> READS_FROM -> LITERAL <<1>>
// @end-annotation
const constMultiA = 1, constMultiB = constMultiA + 1, constMultiC = constMultiA + constMultiB;
let letMultiX = 0, letMultiY = letMultiX + 1;

// @construct PENDING func-expr-recursive-self-ref
const factorialNamedExpr = function fact(n) {
  return n <= 1 ? 1 : n * fact(n - 1); // fact visible ONLY inside
};
// typeof fact === 'undefined' — internal name not in enclosing scope

// @construct PENDING new-target-in-function
// @annotation
// FUNCTION <<FlexibleConstructor>> -> CONTAINS -> PARAMETER <<name>>
// FUNCTION <<FlexibleConstructor>> -> CONTAINS -> BRANCH <<if-new-target>>
// BRANCH <<if-new-target>> -> HAS_CONDITION -> EXPRESSION <<!new.target>>
// EXPRESSION <<!new.target>> -> READS_FROM -> META_PROPERTY <<new.target>>
// BRANCH <<if-new-target>> -> HAS_CONSEQUENT -> CALL <<new FlexibleConstructor(name)>>
// CALL <<new FlexibleConstructor(name)>> -> CALLS -> FUNCTION <<FlexibleConstructor>>
// CALL <<new FlexibleConstructor(name)>> -> PASSES_ARGUMENT -> PARAMETER <<name>>
// BRANCH <<if-new-target>> -> RETURNS -> CALL <<new FlexibleConstructor(name)>>
// FUNCTION <<FlexibleConstructor>> -> WRITES_TO -> PROPERTY_ACCESS <<this.name>>
// PROPERTY_ACCESS <<this.name>> -> ASSIGNED_FROM -> PARAMETER <<name>>
// @end-annotation
function FlexibleConstructor(name) {
  if (!new.target) {
    return new FlexibleConstructor(name); // redirect if called without new
  }
  this.name = name;
}

// @construct PENDING param-default-from-destructured
// @annotation
// FUNCTION <<paramDefaultFromDestructured>> -> CONTAINS -> PARAMETER <<{width, height}>>
// FUNCTION <<paramDefaultFromDestructured>> -> CONTAINS -> PARAMETER <<area>>
// PARAMETER <<{width, height}>> -> HAS_ELEMENT -> VARIABLE <<width>>
// PARAMETER <<{width, height}>> -> HAS_ELEMENT -> VARIABLE <<height>>
// PARAMETER <<area>> -> DEFAULTS_TO -> EXPRESSION <<width * height>>
// EXPRESSION <<width * height>> -> READS_FROM -> VARIABLE <<width>>
// EXPRESSION <<width * height>> -> READS_FROM -> VARIABLE <<height>>
// FUNCTION <<paramDefaultFromDestructured>> -> RETURNS -> LITERAL <<{...}>>
// LITERAL <<{...}>> -> READS_FROM -> VARIABLE <<width>>
// LITERAL <<{...}>> -> READS_FROM -> VARIABLE <<height>>
// LITERAL <<{...}>> -> READS_FROM -> PARAMETER <<area>>
// FUNCTION <<queryBuilder>> -> CONTAINS -> PARAMETER <<{table, schema = 'public'}>>
// FUNCTION <<queryBuilder>> -> CONTAINS -> PARAMETER <<fullName>>
// PARAMETER <<{table, schema = 'public'}>> -> HAS_ELEMENT -> VARIABLE <<table>>
// PARAMETER <<{table, schema = 'public'}>> -> HAS_ELEMENT -> VARIABLE <<schema>>
// VARIABLE <<schema>> -> DEFAULTS_TO -> LITERAL <<'public'>>
// PARAMETER <<fullName>> -> DEFAULTS_TO -> EXPRESSION <<`${schema}.${table}`>>
// EXPRESSION <<`${schema}.${table}`>> -> READS_FROM -> VARIABLE <<schema>>
// EXPRESSION <<`${schema}.${table}`>> -> READS_FROM -> VARIABLE <<table>>
// FUNCTION <<queryBuilder>> -> RETURNS -> EXPRESSION <<`SELECT * FROM ${fullName}`>>
// EXPRESSION <<`SELECT * FROM ${fullName}`>> -> READS_FROM -> PARAMETER <<fullName>>
// @end-annotation
function paramDefaultFromDestructured({width, height}, area = width * height) {
  return { width, height, area };
}

// Also with nested destructuring feeding later default:
function queryBuilder({table, schema = 'public'}, fullName = `${schema}.${table}`) {
  return `SELECT * FROM ${fullName}`;
}

// @construct PENDING numeric-separators
// @annotation
// UNKNOWN <<module>> -> DECLARES -> VARIABLE <<TIMEOUT_MS>>
// VARIABLE <<TIMEOUT_MS>> -> ASSIGNED_FROM -> LITERAL <<30_000>>
// UNKNOWN <<module>> -> DECLARES -> VARIABLE <<MAX_SAFE>>
// VARIABLE <<MAX_SAFE>> -> ASSIGNED_FROM -> LITERAL <<9_007_199_254_740_991>>
// UNKNOWN <<module>> -> DECLARES -> VARIABLE <<HEX_COLOR>>
// VARIABLE <<HEX_COLOR>> -> ASSIGNED_FROM -> LITERAL <<0xFF_EC_D9>>
// UNKNOWN <<module>> -> DECLARES -> VARIABLE <<BIT_MASK>>
// VARIABLE <<BIT_MASK>> -> ASSIGNED_FROM -> LITERAL <<0b1111_0000_1010_0101>>
// UNKNOWN <<module>> -> DECLARES -> VARIABLE <<BIG_NUM>>
// VARIABLE <<BIG_NUM>> -> ASSIGNED_FROM -> LITERAL <<1_000_000_000n>>
// UNKNOWN <<module>> -> DECLARES -> VARIABLE <<FLOAT_SEP>>
// VARIABLE <<FLOAT_SEP>> -> ASSIGNED_FROM -> LITERAL <<1_000.123_456>>
// @end-annotation
const TIMEOUT_MS = 30_000;
const MAX_SAFE = 9_007_199_254_740_991;
const HEX_COLOR = 0xFF_EC_D9;
const BIT_MASK = 0b1111_0000_1010_0101;
const BIG_NUM = 1_000_000_000n;
const FLOAT_SEP = 1_000.123_456;

// @construct PENDING function-name-inference
// @annotation
// @end-annotation
function functionNameInference() {
  // Variable assignment → name inferred as "fromVar"
  const fromVar = function() {};

  // Object property → name inferred as "method"
  const obj = {
    method: function() {},
    arrow: () => {},
  };

  // Class expression → name inferred as "MyClass"
  const MyClass = class {};

  // Default param → name inferred as "fn"
  function withDefault(fn = function() {}) {
    return fn;
  }

  // NOT inferred — Object.defineProperty
  Object.defineProperty(obj, 'hidden', { value: function() {} });

  return {
    varName: fromVar.name,        // "fromVar"
    methodName: obj.method.name,  // "method"
    arrowName: obj.arrow.name,    // "arrow"
    className: MyClass.name,      // "MyClass"
    defaultName: withDefault().name, // "fn"
    hiddenName: obj.hidden.name,  // "" (empty)
  };
}

// @construct PENDING export-named-list
// @annotation
// UNKNOWN <<module>> -> CONTAINS -> EXPORT <<export-named-list>>
// EXPORT <<export-named-list>> -> EXPORTS -> UNKNOWN <<mutableVar>>
// EXPORT <<export-named-list>> -> EXPORTS -> UNKNOWN <<reassignable>>
// EXPORT <<export-named-list>> -> EXPORTS -> UNKNOWN <<immutable>>
// EXPORT <<export-named-list>> -> EXPORTS -> UNKNOWN <<objectConst>>
// EXPORT <<export-named-list>> -> EXPORTS -> UNKNOWN <<arrayConst>>
// EXPORT <<export-named-list>> -> EXPORTS -> UNKNOWN <<bigNumber>>
// EXPORT <<export-named-list>> -> EXPORTS -> UNKNOWN <<uniqueKey>>
// EXPORT <<export-named-list>> -> EXPORTS -> UNKNOWN <<globalSymbol>>
// EXPORT <<export-named-list>> -> EXPORTS -> UNKNOWN <<regexSimple>>
// EXPORT <<export-named-list>> -> EXPORTS -> UNKNOWN <<regularFunction>>
// EXPORT <<export-named-list>> -> EXPORTS -> UNKNOWN <<withDefaults>>
// EXPORT <<export-named-list>> -> EXPORTS -> UNKNOWN <<withRestParams>>
// EXPORT <<export-named-list>> -> EXPORTS -> UNKNOWN <<withMixedParams>>
// EXPORT <<export-named-list>> -> EXPORTS -> UNKNOWN <<namedExpression>>
// EXPORT <<export-named-list>> -> EXPORTS -> UNKNOWN <<anonymousExpression>>
// EXPORT <<export-named-list>> -> EXPORTS -> UNKNOWN <<arrowBlock>>
// EXPORT <<export-named-list>> -> EXPORTS -> UNKNOWN <<arrowExpression>>
// EXPORT <<export-named-list>> -> EXPORTS -> UNKNOWN <<arrowSingleParam>>
// EXPORT <<export-named-list>> -> EXPORTS -> UNKNOWN <<arrowNoParams>>
// EXPORT <<export-named-list>> -> EXPORTS -> UNKNOWN <<numberGenerator>>
// EXPORT <<export-named-list>> -> EXPORTS -> UNKNOWN <<delegatingGenerator>>
// EXPORT <<export-named-list>> -> EXPORTS -> UNKNOWN <<asyncFunction>>
// EXPORT <<export-named-list>> -> EXPORTS -> UNKNOWN <<asyncArrow>>
// EXPORT <<export-named-list>> -> EXPORTS -> UNKNOWN <<asyncGenerator>>
// EXPORT <<export-named-list>> -> EXPORTS -> UNKNOWN <<iifeResult>>
// EXPORT <<export-named-list>> -> EXPORTS -> UNKNOWN <<arrowIifeResult>>
// EXPORT <<export-named-list>> -> EXPORTS -> UNKNOWN <<paramDefaultChain>>
// EXPORT <<export-named-list>> -> EXPORTS -> UNKNOWN <<paramDefaultScope>>
// EXPORT <<export-named-list>> -> EXPORTS -> UNKNOWN <<arrowReturnsObject>>
// EXPORT <<export-named-list>> -> EXPORTS -> UNKNOWN <<asyncIifeResult>>
// EXPORT <<export-named-list>> -> EXPORTS -> UNKNOWN <<constMultiC>>
// EXPORT <<export-named-list>> -> EXPORTS -> UNKNOWN <<letMultiY>>
// EXPORT <<export-named-list>> -> EXPORTS -> UNKNOWN <<factorialNamedExpr>>
// EXPORT <<export-named-list>> -> EXPORTS -> UNKNOWN <<FlexibleConstructor>>
// EXPORT <<export-named-list>> -> EXPORTS -> UNKNOWN <<paramDefaultFromDestructured>>
// EXPORT <<export-named-list>> -> EXPORTS -> UNKNOWN <<queryBuilder>>
// EXPORT <<export-named-list>> -> EXPORTS -> UNKNOWN <<TIMEOUT_MS>>
// EXPORT <<export-named-list>> -> EXPORTS -> UNKNOWN <<MAX_SAFE>>
// EXPORT <<export-named-list>> -> EXPORTS -> UNKNOWN <<HEX_COLOR>>
// EXPORT <<export-named-list>> -> EXPORTS -> UNKNOWN <<BIT_MASK>>
// EXPORT <<export-named-list>> -> EXPORTS -> UNKNOWN <<BIG_NUM>>
// EXPORT <<export-named-list>> -> EXPORTS -> UNKNOWN <<FLOAT_SEP>>
// EXPORT <<export-named-list>> -> EXPORTS -> UNKNOWN <<functionNameInference>>
// @end-annotation
export {
  mutableVar,
  reassignable,
  immutable,
  objectConst,
  arrayConst,
  bigNumber,
  uniqueKey,
  globalSymbol,
  regexSimple,
  regularFunction,
  withDefaults,
  withRestParams,
  withMixedParams,
  namedExpression,
  anonymousExpression,
  arrowBlock,
  arrowExpression,
  arrowSingleParam,
  arrowNoParams,
  numberGenerator,
  delegatingGenerator,
  asyncFunction,
  asyncArrow,
  asyncGenerator,
  iifeResult,
  arrowIifeResult,
  paramDefaultChain,
  paramDefaultScope,
  arrowReturnsObject,
  asyncIifeResult,
  constMultiC,
  letMultiY,
  factorialNamedExpr,
  FlexibleConstructor,
  paramDefaultFromDestructured,
  queryBuilder,
  TIMEOUT_MS,
  MAX_SAFE,
  HEX_COLOR,
  BIT_MASK,
  BIG_NUM,
  FLOAT_SEP,
  functionNameInference,
};
