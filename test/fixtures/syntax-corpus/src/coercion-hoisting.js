// =============================================================================
// coercion-hoisting.js — Type Coercion, Hoisting, TDZ, Shadowing, eval
// =============================================================================

// --- Implicit type coercion ---

// @construct PENDING coerce-string-concat
// @annotation
// @end-annotation
function stringCoercion() {
  const numToStr = '' + 42;
  const boolToStr = '' + true;
  const nullToStr = '' + null;
  const objToStr = '' + { valueOf: () => 99 };
  const arrToStr = '' + [1, 2, 3];
  return { numToStr, boolToStr, nullToStr, objToStr, arrToStr };
}

// @construct PENDING coerce-to-number
// @annotation
// @end-annotation
function numberCoercion() {
  const strToNum = +'42';
  const boolToNum = +true;
  const nullToNum = +null;
  const undefToNum = +undefined;
  const arrToNum = +[];
  const emptyStr = +'';
  const bitwiseTrunc = ~~3.7;
  const bitwiseOr = '5' | 0;
  return { strToNum, boolToNum, nullToNum, undefToNum, arrToNum, emptyStr, bitwiseTrunc, bitwiseOr };
}

// @construct PENDING coerce-to-boolean
// @annotation
// @end-annotation
function booleanCoercion() {
  const dblNot = !!1;
  const falsy = [!!0, !!'', !!null, !!undefined, !!NaN, !!false];
  const truthy = [!!1, !!'text', !!{}, !![], !!-1];
  return { dblNot, falsy, truthy };
}

// @construct PENDING coerce-equality
// @annotation
// @end-annotation
function equalityCoercion() {
  const a = 0 == '';          // true — both coerce to 0
  const b = 0 == false;       // true
  const c = '' == false;      // true
  const d = null == undefined; // true — special case
  const e = null == 0;         // false — null only == undefined
  const f = NaN == NaN;        // false
  const g = [] == false;       // true — [] → '' → 0, false → 0
  return { a, b, c, d, e, f, g };
}

// --- valueOf / toString / Symbol.toPrimitive ---

// @construct PENDING coerce-valueof-tostring
// @annotation
// VARIABLE <<customCoerce>> -> ASSIGNED_FROM -> EXPRESSION <<customCoerce:obj>>
// EXPRESSION <<customCoerce:obj>> -> CONTAINS -> METHOD <<valueOf>>
// EXPRESSION <<customCoerce:obj>> -> CONTAINS -> METHOD <<toString>>
// METHOD <<valueOf>> -> RETURNS -> LITERAL <<42>>
// METHOD <<toString>> -> RETURNS -> LITERAL <<'custom'>>
// VARIABLE <<usedInMath>> -> ASSIGNED_FROM -> EXPRESSION <<customCoerce + 1>>
// EXPRESSION <<customCoerce + 1>> -> READS_FROM -> VARIABLE <<customCoerce>>
// EXPRESSION <<customCoerce + 1>> -> READS_FROM -> LITERAL <<1>>
// EXPRESSION <<customCoerce + 1>> -> CALLS -> METHOD <<valueOf>>
// VARIABLE <<usedInTemplate>> -> ASSIGNED_FROM -> EXPRESSION <<`${customCoerce}`>>
// EXPRESSION <<`${customCoerce}`>> -> READS_FROM -> VARIABLE <<customCoerce>>
// EXPRESSION <<`${customCoerce}`>> -> CALLS -> METHOD <<toString>>
// @end-annotation
const customCoerce = {
  valueOf() { return 42; },
  toString() { return 'custom'; },
};

const usedInMath = customCoerce + 1;        // 43 (valueOf)
const usedInTemplate = `${customCoerce}`;   // 'custom' (toString)

// @construct PENDING coerce-symbol-toprimitive
// @annotation
// VARIABLE <<toPrimitive>> -> ASSIGNED_FROM -> LITERAL <<object-literal>>
// LITERAL <<object-literal>> -> HAS_PROPERTY -> METHOD <<[Symbol.toPrimitive]>>
// METHOD <<[Symbol.toPrimitive]>> -> CONTAINS -> PARAMETER <<hint>>
// METHOD <<[Symbol.toPrimitive]>> -> CONTAINS -> BRANCH <<if-number>>
// BRANCH <<if-number>> -> HAS_CONDITION -> EXPRESSION <<hint === 'number'>>
// EXPRESSION <<hint === 'number'>> -> READS_FROM -> PARAMETER <<hint>>
// EXPRESSION <<hint === 'number'>> -> READS_FROM -> LITERAL <<'number'>>
// BRANCH <<if-number>> -> RETURNS -> LITERAL <<10>>
// METHOD <<[Symbol.toPrimitive]>> -> CONTAINS -> BRANCH <<if-string>>
// BRANCH <<if-string>> -> HAS_CONDITION -> EXPRESSION <<hint === 'string'>>
// EXPRESSION <<hint === 'string'>> -> READS_FROM -> PARAMETER <<hint>>
// EXPRESSION <<hint === 'string'>> -> READS_FROM -> LITERAL <<'string'>>
// BRANCH <<if-string>> -> RETURNS -> LITERAL <<'ten'>>
// METHOD <<[Symbol.toPrimitive]>> -> RETURNS -> LITERAL <<true>>
// @end-annotation
const toPrimitive = {
  [Symbol.toPrimitive](hint) {
    if (hint === 'number') return 10;
    if (hint === 'string') return 'ten';
    return true;
  },
};

// --- Hoisting ---

// @construct PENDING hoist-var
// @annotation
// FUNCTION <<varHoisting>> -> DECLARES -> VARIABLE <<x>>
// VARIABLE <<x>> -> ASSIGNED_FROM -> LITERAL <<10>>
// CALL <<console.log(x):1>> -> CALLS -> PROPERTY_ACCESS <<console.log>>
// CALL <<console.log(x):1>> -> PASSES_ARGUMENT -> VARIABLE <<x>>
// CALL <<console.log(x):2>> -> CALLS -> PROPERTY_ACCESS <<console.log>>
// CALL <<console.log(x):2>> -> PASSES_ARGUMENT -> VARIABLE <<x>>
// FUNCTION <<varHoisting>> -> RETURNS -> VARIABLE <<x>>
// @end-annotation
function varHoisting() {
  console.log(x); // undefined — hoisted, not initialized
  var x = 10;
  console.log(x); // 10
  return x;
}

// @construct PENDING hoist-function-decl
// @annotation
// FUNCTION <<functionHoisting>> -> CONTAINS -> VARIABLE <<result>>
// FUNCTION <<functionHoisting>> -> CONTAINS -> FUNCTION <<hoisted>>
// VARIABLE <<result>> -> ASSIGNED_FROM -> CALL <<hoisted()>>
// CALL <<hoisted()>> -> CALLS -> FUNCTION <<hoisted>>
// FUNCTION <<hoisted>> -> RETURNS -> LITERAL <<'hoisted'>>
// FUNCTION <<functionHoisting>> -> RETURNS -> VARIABLE <<result>>
// @end-annotation
function functionHoisting() {
  const result = hoisted(); // works — function declarations are fully hoisted
  function hoisted() { return 'hoisted'; }
  return result;
}

// @construct PENDING hoist-function-expr-not
// @annotation
// FUNCTION <<functionExprNotHoisted>> -> HAS_BODY -> TRY_BLOCK <<try-block>>
// TRY_BLOCK <<try-block>> -> CONTAINS -> CALL <<notHoisted()>>
// CALL <<notHoisted()>> -> CALLS -> VARIABLE <<notHoisted>>
// TRY_BLOCK <<try-block>> -> HAS_CATCH -> CATCH_BLOCK <<catch-block>>
// CATCH_BLOCK <<catch-block>> -> RECEIVES_ARGUMENT -> PARAMETER <<e>>
// FUNCTION <<functionExprNotHoisted>> -> DECLARES -> VARIABLE <<notHoisted>>
// VARIABLE <<notHoisted>> -> ASSIGNED_FROM -> FUNCTION <<notHoisted:fn>>
// FUNCTION <<notHoisted:fn>> -> RETURNS -> LITERAL <<'not hoisted'>>
// FUNCTION <<functionExprNotHoisted>> -> RETURNS -> CALL <<notHoisted()_return>>
// CALL <<notHoisted()_return>> -> CALLS -> VARIABLE <<notHoisted>>
// @end-annotation
function functionExprNotHoisted() {
  try {
    notHoisted(); // TypeError: notHoisted is not a function
  } catch (e) {
    // var notHoisted is hoisted as undefined, but assignment is not
  }
  var notHoisted = function () { return 'not hoisted'; };
  return notHoisted();
}

// --- Temporal Dead Zone (TDZ) ---

// @construct PENDING tdz-let
// @annotation
// FUNCTION <<tdzLet>> -> HAS_BODY -> TRY_BLOCK <<try-block>>
// TRY_BLOCK <<try-block>> -> HAS_CATCH -> CATCH_BLOCK <<catch-block>>
// TRY_BLOCK <<try-block>> -> CONTAINS -> CALL <<console.log(x)>>
// CATCH_BLOCK <<catch-block>> -> RECEIVES_ARGUMENT -> PARAMETER <<e>>
// CALL <<console.log(x)>> -> CALLS -> PROPERTY_ACCESS <<console.log>>
// CALL <<console.log(x)>> -> PASSES_ARGUMENT -> VARIABLE <<x>>
// CALL <<console.log(x)>> -> READS_FROM -> VARIABLE <<x>>
// FUNCTION <<tdzLet>> -> DECLARES -> VARIABLE <<x>>
// VARIABLE <<x>> -> ASSIGNED_FROM -> LITERAL <<10>>
// FUNCTION <<tdzLet>> -> RETURNS -> VARIABLE <<x>>
// CALL <<console.log(x)>> -> THROWS -> CATCH_BLOCK <<catch-block>>
// @end-annotation
function tdzLet() {
  try {
    console.log(x); // ReferenceError — TDZ
  } catch (e) {
    // let x exists but cannot be accessed before declaration
  }
  let x = 10;
  return x;
}

// @construct PENDING tdz-const
// @annotation
// FUNCTION <<tdzConst>> -> CONTAINS -> TRY_BLOCK <<try-block>>
// FUNCTION <<tdzConst>> -> CONTAINS -> CATCH_BLOCK <<catch-block>>
// TRY_BLOCK <<try-block>> -> CONTAINS -> CALL <<console.log(C)>>
// CATCH_BLOCK <<catch-block>> -> CONTAINS -> PARAMETER <<e>>
// CALL <<console.log(C)>> -> CALLS -> PROPERTY_ACCESS <<console.log>>
// CALL <<console.log(C)>> -> PASSES_ARGUMENT -> VARIABLE <<C>>
// FUNCTION <<tdzConst>> -> DECLARES -> VARIABLE <<C>>
// VARIABLE <<C>> -> ASSIGNED_FROM -> LITERAL <<42>>
// FUNCTION <<tdzConst>> -> RETURNS -> VARIABLE <<C>>
// CALL <<console.log(C)>> -> READS_FROM -> VARIABLE <<C>>
// @end-annotation
function tdzConst() {
  try {
    console.log(C); // ReferenceError — TDZ
  } catch (e) {
    // const C in TDZ
  }
  const C = 42;
  return C;
}

// @construct PENDING tdz-class
// @annotation
// FUNCTION <<tdzClass>> -> CONTAINS -> TRY_BLOCK <<try-block>>
// TRY_BLOCK <<try-block>> -> CONTAINS -> CALL <<new MyClass()>>
// CALL <<new MyClass()>> -> CALLS -> CLASS <<MyClass>>
// TRY_BLOCK <<try-block>> -> HAS_CATCH -> CATCH_BLOCK <<catch-block>>
// CATCH_BLOCK <<catch-block>> -> CONTAINS -> PARAMETER <<e>>
// FUNCTION <<tdzClass>> -> DECLARES -> CLASS <<MyClass>>
// FUNCTION <<tdzClass>> -> RETURNS -> CALL <<new MyClass():return>>
// CALL <<new MyClass():return>> -> CALLS -> CLASS <<MyClass>>
// @end-annotation
function tdzClass() {
  try {
    new MyClass(); // ReferenceError — class TDZ
  } catch (e) {
    // class declarations have TDZ like let/const
  }
  class MyClass {}
  return new MyClass();
}

// --- Variable shadowing ---

// @construct PENDING shadow-block-scope
// @annotation
// LITERAL <<'outer'>> {value: outer, literalType: string}
// SCOPE <<shadowingExample:scope>> -> DECLARES -> VARIABLE <<outerConst:function>>
// VARIABLE <<outerConst:function>> -> ASSIGNED_FROM -> LITERAL <<'shadowed'>>
// VARIABLE <<outerConst:function>> -> SHADOWS -> VARIABLE <<outerConst:module>>
// FUNCTION <<shadowingExample>> -> HAS_SCOPE -> SCOPE <<shadowingExample:scope>>
// FUNCTION <<shadowingExample>> -> CONTAINS -> BRANCH <<if-true>>
// BRANCH <<if-true>> -> HAS_SCOPE -> SCOPE <<if-block:scope>>
// SCOPE <<if-block:scope>> -> DECLARES -> VARIABLE <<outerConst:block>>
// VARIABLE <<outerConst:block>> -> ASSIGNED_FROM -> LITERAL <<'inner-shadowed'>>
// VARIABLE <<outerConst:block>> -> SHADOWS -> VARIABLE <<outerConst:function>>
// BRANCH <<if-true>> -> CONTAINS -> CALL <<console.log(outerConst)>>
// CALL <<console.log(outerConst)>> -> CALLS -> PROPERTY_ACCESS <<console.log>>
// CALL <<console.log(outerConst)>> -> PASSES_ARGUMENT -> VARIABLE <<outerConst:block>>
// FUNCTION <<shadowingExample>> -> RETURNS -> VARIABLE <<outerConst:function>>
// @end-annotation
const outerConst = 'outer';

function shadowingExample() {
  const outerConst = 'shadowed'; // shadows module-level
  if (true) {
    const outerConst = 'inner-shadowed'; // shadows function-level
    console.log(outerConst); // 'inner-shadowed'
  }
  return outerConst; // 'shadowed'
}

// @construct PENDING shadow-param-scope
// @annotation
// FUNCTION <<paramShadowing>> -> CONTAINS -> PARAMETER <<x:param>>
// FUNCTION <<paramShadowing>> -> CONTAINS -> VARIABLE <<x2>>
// VARIABLE <<x2>> -> ASSIGNED_FROM -> PARAMETER <<x:param>>
// FUNCTION <<paramShadowing>> -> CONTAINS -> SCOPE <<if-block-scope>>
// SCOPE <<if-block-scope>> -> CONTAINS -> VARIABLE <<x:shadowed>>
// VARIABLE <<x:shadowed>> -> ASSIGNED_FROM -> LITERAL <<'shadowed'>>
// VARIABLE <<x:shadowed>> -> SHADOWS -> PARAMETER <<x:param>>
// CALL <<console.log(x)>> -> CALLS -> PROPERTY_ACCESS <<console.log>>
// CALL <<console.log(x)>> -> PASSES_ARGUMENT -> VARIABLE <<x:shadowed>>
// FUNCTION <<paramShadowing>> -> RETURNS -> PARAMETER <<x:param>>
// @end-annotation
function paramShadowing(x) {
  const x2 = x;
  if (true) {
    const x = 'shadowed'; // shadows parameter
    console.log(x); // 'shadowed'
  }
  return x; // original param
}

// @construct PENDING shadow-catch-scope
// @annotation
// FUNCTION <<catchShadowing>> -> CONTAINS -> VARIABLE <<error:outer>>
// VARIABLE <<error:outer>> -> ASSIGNED_FROM -> LITERAL <<'not an error'>>
// FUNCTION <<catchShadowing>> -> CONTAINS -> TRY_BLOCK <<try-block>>
// FUNCTION <<catchShadowing>> -> CONTAINS -> CATCH_BLOCK <<catch-block>>
// TRY_BLOCK <<try-block>> -> HAS_CATCH -> CATCH_BLOCK <<catch-block>>
// CATCH_BLOCK <<catch-block>> -> CONTAINS -> PARAMETER <<error:catch>>
// TRY_BLOCK <<try-block>> -> THROWS -> CALL <<new Error('real error')>>
// CALL <<new Error('real error')>> -> PASSES_ARGUMENT -> LITERAL <<'real error'>>
// CATCH_BLOCK <<catch-block>> -> CONTAINS -> CALL <<console.log(error.message)>>
// CALL <<console.log(error.message)>> -> PASSES_ARGUMENT -> PROPERTY_ACCESS <<error.message>>
// PROPERTY_ACCESS <<error.message>> -> READS_FROM -> PARAMETER <<error:catch>>
// FUNCTION <<catchShadowing>> -> RETURNS -> VARIABLE <<error:outer>>
// PARAMETER <<error:catch>> -> SHADOWS -> VARIABLE <<error:outer>>
// @end-annotation
function catchShadowing() {
  const error = 'not an error';
  try {
    throw new Error('real error');
  } catch (error) {
    console.log(error.message); // 'real error' — shadows outer "error"
  }
  return error; // 'not an error'
}

// --- eval ---

// @construct PENDING eval-direct
// @annotation
// UNKNOWN <<module>> -> DECLARES -> FUNCTION <<directEval>>
// FUNCTION <<directEval>> -> CONTAINS -> PARAMETER <<code>>
// FUNCTION <<directEval>> -> RETURNS -> CALL <<eval(code)>>
// CALL <<eval(code)>> -> CALLS -> EXTERNAL <<eval>>
// CALL <<eval(code)>> -> PASSES_ARGUMENT -> PARAMETER <<code>>
// EXTERNAL <<eval>> -> CAPTURES -> FUNCTION <<directEval>>
// @end-annotation
function directEval(code) {
  return eval(code);
}

// @construct PENDING eval-indirect
function indirectEval(code) {
  const evaluate = eval;
  return evaluate(code);
}

// @construct PENDING eval-new-function
// @annotation
// FUNCTION <<newFunction>> -> HAS_BODY -> PARAMETER <<body>>
// FUNCTION <<newFunction>> -> DECLARES -> VARIABLE <<fn>>
// VARIABLE <<fn>> -> ASSIGNED_FROM -> CALL <<new Function('a', 'b', body)>>
// CALL <<new Function('a', 'b', body)>> -> PASSES_ARGUMENT -> LITERAL <<'a'>>
// CALL <<new Function('a', 'b', body)>> -> PASSES_ARGUMENT -> LITERAL <<'b'>>
// CALL <<new Function('a', 'b', body)>> -> PASSES_ARGUMENT -> PARAMETER <<body>>
// FUNCTION <<newFunction>> -> RETURNS -> CALL <<fn(1, 2)>>
// CALL <<fn(1, 2)>> -> CALLS -> VARIABLE <<fn>>
// CALL <<fn(1, 2)>> -> PASSES_ARGUMENT -> LITERAL <<1>>
// CALL <<fn(1, 2)>> -> PASSES_ARGUMENT -> LITERAL <<2>>
// @end-annotation
function newFunction(body) {
  const fn = new Function('a', 'b', body);
  return fn(1, 2);
}

// --- Comma operator for side effects ---

// @construct PENDING coerce-comma-sequence
// @annotation
// FUNCTION <<commaSequence>> -> CONTAINS -> VARIABLE <<x>>
// FUNCTION <<commaSequence>> -> CONTAINS -> VARIABLE <<result>>
// VARIABLE <<x>> -> ASSIGNED_FROM -> LITERAL <<0>>
// VARIABLE <<result>> -> ASSIGNED_FROM -> EXPRESSION <<comma-sequence>>
// EXPRESSION <<comma-sequence>> -> HAS_ELEMENT -> EXPRESSION <<x++[1]>>
// EXPRESSION <<comma-sequence>> -> HAS_ELEMENT -> EXPRESSION <<x++[2]>>
// EXPRESSION <<comma-sequence>> -> HAS_ELEMENT -> EXPRESSION <<x++[3]>>
// EXPRESSION <<comma-sequence>> -> HAS_ELEMENT -> EXPRESSION <<x-final>>
// EXPRESSION <<x++[1]>> -> READS_FROM -> VARIABLE <<x>>
// EXPRESSION <<x++[1]>> -> WRITES_TO -> VARIABLE <<x>>
// EXPRESSION <<x++[2]>> -> READS_FROM -> VARIABLE <<x>>
// EXPRESSION <<x++[2]>> -> WRITES_TO -> VARIABLE <<x>>
// EXPRESSION <<x++[3]>> -> READS_FROM -> VARIABLE <<x>>
// EXPRESSION <<x++[3]>> -> WRITES_TO -> VARIABLE <<x>>
// EXPRESSION <<x-final>> -> READS_FROM -> VARIABLE <<x>>
// FUNCTION <<commaSequence>> -> RETURNS -> VARIABLE <<result>>
// @end-annotation
function commaSequence() {
  let x = 0;
  const result = (x++, x++, x++, x);
  return result; // 3
}

// @construct PENDING eval-var-injection
// @annotation
// UNKNOWN <<module>> -> DECLARES -> FUNCTION <<evalVarInjection>>
// FUNCTION <<evalVarInjection>> -> CONTAINS -> CALL <<eval('var injected = 42')>>
// CALL <<eval('var injected = 42')>> -> CALLS -> UNKNOWN <<eval>>
// CALL <<eval('var injected = 42')>> -> PASSES_ARGUMENT -> LITERAL <<'var injected = 42'>>
// CALL <<eval('var injected = 42')>> -> MODIFIES -> VARIABLE <<injected>>
// VARIABLE <<injected>> -> ASSIGNED_FROM -> LITERAL <<42>>
// FUNCTION <<evalVarInjection>> -> RETURNS -> VARIABLE <<injected>>
// @end-annotation
function evalVarInjection() {
  eval('var injected = 42');
  return injected; // 42 — eval injected into function scope
}

// @construct PENDING eval-function-injection
// @annotation
// FUNCTION <<evalFunctionInjection>> -> CONTAINS -> CALL <<eval('function surprise() { return "boo"; }')>>
// CALL <<eval('function surprise() { return "boo"; }')>> -> PASSES_ARGUMENT -> LITERAL <<'function surprise() { return "boo"; }'>>
// CALL <<eval('function surprise() { return "boo"; }')>> -> DECLARES -> FUNCTION <<surprise>>
// FUNCTION <<surprise>> -> RETURNS -> LITERAL <<"boo">>
// FUNCTION <<evalFunctionInjection>> -> CONTAINS -> CALL <<surprise()>>
// CALL <<surprise()>> -> CALLS -> FUNCTION <<surprise>>
// FUNCTION <<evalFunctionInjection>> -> RETURNS -> CALL <<surprise()>>
// @end-annotation
function evalFunctionInjection() {
  eval('function surprise() { return "boo"; }');
  return surprise(); // "boo"
}

// @construct PENDING primitive-autoboxing
// @annotation
// FUNCTION <<primitiveAutoboxing>> -> CONTAINS -> VARIABLE <<str>>
// VARIABLE <<str>> -> ASSIGNED_FROM -> LITERAL <<'hello'>>
// FUNCTION <<primitiveAutoboxing>> -> CONTAINS -> VARIABLE <<upper>>
// VARIABLE <<upper>> -> ASSIGNED_FROM -> CALL <<str.toUpperCase()>>
// CALL <<str.toUpperCase()>> -> CALLS_ON -> VARIABLE <<str>>
// PROPERTY_ACCESS <<str.customProp>> -> ASSIGNED_FROM -> LITERAL <<1>>
// PROPERTY_ACCESS <<str.customProp>> -> HAS_PROPERTY -> VARIABLE <<str>>
// FUNCTION <<primitiveAutoboxing>> -> CONTAINS -> VARIABLE <<lost>>
// VARIABLE <<lost>> -> ASSIGNED_FROM -> PROPERTY_ACCESS <<str.customProp:read>>
// PROPERTY_ACCESS <<str.customProp:read>> -> HAS_PROPERTY -> VARIABLE <<str>>
// FUNCTION <<primitiveAutoboxing>> -> CONTAINS -> VARIABLE <<num>>
// VARIABLE <<num>> -> ASSIGNED_FROM -> LITERAL <<42>>
// FUNCTION <<primitiveAutoboxing>> -> CONTAINS -> VARIABLE <<fixed>>
// VARIABLE <<fixed>> -> ASSIGNED_FROM -> CALL <<num.toFixed(2)>>
// CALL <<num.toFixed(2)>> -> CALLS_ON -> VARIABLE <<num>>
// CALL <<num.toFixed(2)>> -> PASSES_ARGUMENT -> LITERAL <<2>>
// FUNCTION <<primitiveAutoboxing>> -> RETURNS -> LITERAL <<{...}>>
// LITERAL <<{...}>> -> READS_FROM -> VARIABLE <<upper>>
// LITERAL <<{...}>> -> READS_FROM -> VARIABLE <<lost>>
// LITERAL <<{...}>> -> READS_FROM -> VARIABLE <<fixed>>
// @end-annotation
function primitiveAutoboxing() {
  const str = 'hello';
  const upper = str.toUpperCase(); // auto-boxes to String object
  str.customProp = 1; // sets on TEMPORARY boxed String, immediately GC'd
  const lost = str.customProp; // undefined

  const num = 42;
  const fixed = num.toFixed(2); // auto-boxes to Number

  return { upper, lost, fixed };
}

// @construct PENDING var-function-collision
// @annotation
// FUNCTION <<varFunctionCollision>> -> CONTAINS -> CALL <<console.log(typeof collision)1>>
// CALL <<console.log(typeof collision)1>> -> CALLS -> EXTERNAL <<console.log>>
// CALL <<console.log(typeof collision)1>> -> PASSES_ARGUMENT -> EXPRESSION <<typeof collision1>>
// EXPRESSION <<typeof collision1>> -> READS_FROM -> FUNCTION <<collision:fn>>
// FUNCTION <<varFunctionCollision>> -> DECLARES -> VARIABLE <<collision:var>>
// FUNCTION <<varFunctionCollision>> -> DECLARES -> FUNCTION <<collision:fn>>
// VARIABLE <<collision:var>> -> ASSIGNED_FROM -> LITERAL <<1>>
// FUNCTION <<collision:fn>> -> RETURNS -> LITERAL <<2>>
// FUNCTION <<varFunctionCollision>> -> CONTAINS -> CALL <<console.log(typeof collision)2>>
// CALL <<console.log(typeof collision)2>> -> CALLS -> EXTERNAL <<console.log>>
// CALL <<console.log(typeof collision)2>> -> PASSES_ARGUMENT -> EXPRESSION <<typeof collision2>>
// EXPRESSION <<typeof collision2>> -> READS_FROM -> VARIABLE <<collision:var>>
// FUNCTION <<varFunctionCollision>> -> RETURNS -> VARIABLE <<collision:var>>
// FUNCTION <<collision:fn>> -> SHADOWS -> VARIABLE <<collision:var>>
// @end-annotation
function varFunctionCollision() {
  console.log(typeof collision); // "function" — function hoists over var
  var collision = 1;
  function collision() { return 2; }
  console.log(typeof collision); // "number" — assignment runs after
  return collision;
}

// @construct PENDING contextual-keyword-as-identifier
// @annotation
// UNKNOWN <<MODULE>> -> DECLARES -> FUNCTION <<contextualKeywords>>
// FUNCTION <<contextualKeywords>> -> CONTAINS -> VARIABLE <<async>>
// VARIABLE <<async>> -> ASSIGNED_FROM -> LITERAL <<1>>
// FUNCTION <<contextualKeywords>> -> RETURNS -> VARIABLE <<async>>
// @end-annotation
function contextualKeywords() {
  var async = 1;       // valid — "async" is not a reserved word
  // var yield = 3;    // SyntaxError in strict/ESM — valid in sloppy scripts
  // var let = 2;      // SyntaxError in strict — valid with var in sloppy
  return async;
}

// @construct PENDING object-as-map-key-tostring
// @annotation
// FUNCTION <<objectAsMapKey>> -> CONTAINS -> VARIABLE <<cache>>
// FUNCTION <<objectAsMapKey>> -> CONTAINS -> VARIABLE <<obj>>
// VARIABLE <<cache>> -> ASSIGNED_FROM -> LITERAL <<{}>>
// VARIABLE <<obj>> -> ASSIGNED_FROM -> LITERAL <<obj-literal>>
// PROPERTY_ACCESS <<cache[obj]>> -> READS_FROM -> VARIABLE <<cache>>
// PROPERTY_ACCESS <<cache[obj]>> -> READS_FROM -> VARIABLE <<obj>>
// PROPERTY_ACCESS <<cache[obj]>> -> ASSIGNED_FROM -> LITERAL <<'value'>>
// VARIABLE <<obj>> -> FLOWS_INTO -> SIDE_EFFECT <<obj-toString>>
// PROPERTY_ACCESS <<cache[obj]>> -> DEPENDS_ON -> SIDE_EFFECT <<obj-toString>>
// PROPERTY_ACCESS <<cache[{ a: 1 }]>> -> READS_FROM -> VARIABLE <<cache>>
// PROPERTY_ACCESS <<cache[{ a: 1 }]>> -> READS_FROM -> LITERAL <<{ a: 1 }>>
// PROPERTY_ACCESS <<cache[{ a: 1 }]>> -> ASSIGNED_FROM -> LITERAL <<'another'>>
// LITERAL <<{ a: 1 }>> -> FLOWS_INTO -> SIDE_EFFECT <<inline-obj-toString>>
// PROPERTY_ACCESS <<cache[{ a: 1 }]>> -> DEPENDS_ON -> SIDE_EFFECT <<inline-obj-toString>>
// FUNCTION <<objectAsMapKey>> -> RETURNS -> VARIABLE <<cache>>
// @end-annotation
function objectAsMapKey() {
  const cache = {};
  const obj = {};
  cache[obj] = 'value';           // key is "[object Object]"
  cache[{ a: 1 }] = 'another';   // SAME key "[object Object]" — overwrites!
  return cache;
}

// @construct PENDING block-function-declaration-strict
// @annotation
// FUNCTION <<blockFunctionDemo>> -> CONTAINS -> VARIABLE <<result>>
// VARIABLE <<result>> -> ASSIGNED_FROM -> LITERAL <<'before'>>
// FUNCTION <<blockFunctionDemo>> -> CONTAINS -> BRANCH <<if-true>>
// BRANCH <<if-true>> -> HAS_CONDITION -> LITERAL <<true>>
// BRANCH <<if-true>> -> HAS_BODY -> SCOPE <<if-block-scope>>
// SCOPE <<if-block-scope>> -> DECLARES -> FUNCTION <<blockFn>>
// FUNCTION <<blockFn>> -> RETURNS -> LITERAL <<'inside'>>
// SCOPE <<if-block-scope>> -> CONTAINS -> CALL <<blockFn()>>
// CALL <<blockFn()>> -> CALLS -> FUNCTION <<blockFn>>
// SCOPE <<if-block-scope>> -> CONTAINS -> EXPRESSION <<result = blockFn()>>
// EXPRESSION <<result = blockFn()>> -> WRITES_TO -> VARIABLE <<result>>
// EXPRESSION <<result = blockFn()>> -> ASSIGNED_FROM -> CALL <<blockFn()>>
// FUNCTION <<blockFunctionDemo>> -> RETURNS -> VARIABLE <<result>>
// @end-annotation
// NOTE: behavior differs between strict (ESM) and sloppy (script) mode.
// This file is ESM (strict), so the function is block-scoped.
// In sloppy mode (.cjs / <script>), the function would leak to function scope (Annex B).
function blockFunctionDemo() {
  let result = 'before';

  if (true) {
    function blockFn() { return 'inside'; }  // block-scoped in strict/ESM
    result = blockFn();
  }

  // blockFn is NOT accessible here in strict mode
  // In sloppy mode it WOULD be accessible (Annex B hoisting)
  return result;
}

// @construct PENDING var-in-catch-clobber
// @annotation
// FUNCTION <<varInCatchClobber>> -> CONTAINS -> TRY_BLOCK <<try-block>>
// TRY_BLOCK <<try-block>> -> THROWS -> CALL <<new Error('oops')>>
// CALL <<new Error('oops')>> -> PASSES_ARGUMENT -> LITERAL <<'oops'>>
// FUNCTION <<varInCatchClobber>> -> HAS_CATCH -> CATCH_BLOCK <<catch-block>>
// CATCH_BLOCK <<catch-block>> -> CONTAINS -> PARAMETER <<e:catch>>
// CATCH_BLOCK <<catch-block>> -> CONTAINS -> VARIABLE <<e:var>>
// VARIABLE <<e:var>> -> ASSIGNED_FROM -> LITERAL <<'overwritten'>>
// FUNCTION <<varInCatchClobber>> -> RETURNS -> EXPRESSION <<return e>>
// EXPRESSION <<return e>> -> READS_FROM -> VARIABLE <<e:var>>
// FUNCTION <<varInCatchClobber>> -> DECLARES -> VARIABLE <<e:var>>
// @end-annotation
function varInCatchClobber() {
  try {
    throw new Error('oops');
  } catch (e) {
    var e = 'overwritten';  // var hoists to function scope, shares binding with catch param
  }
  return e; // 'overwritten' in sloppy; in strict var still hoists but catch e is separate
}

// @construct PENDING typeof-tdz-trap
// @annotation
// FUNCTION <<typeofTdzTrap>> -> HAS_BODY -> TRY_BLOCK <<try-block>>
// TRY_BLOCK <<try-block>> -> HAS_CATCH -> CATCH_BLOCK <<catch-block>>
// TRY_BLOCK <<try-block>> -> DECLARES -> VARIABLE <<result>>
// VARIABLE <<result>> -> ASSIGNED_FROM -> EXPRESSION <<typeof x>>
// EXPRESSION <<typeof x>> -> READS_FROM -> VARIABLE <<x>>
// CATCH_BLOCK <<catch-block>> -> DECLARES -> PARAMETER <<e>>
// FUNCTION <<typeofTdzTrap>> -> DECLARES -> VARIABLE <<x>>
// VARIABLE <<x>> -> ASSIGNED_FROM -> LITERAL <<5>>
// EXPRESSION <<typeof x>> -> THROWS -> CATCH_BLOCK <<catch-block>>
// @end-annotation
function typeofTdzTrap() {
  try {
    const result = typeof x; // ReferenceError — x is in TDZ, unlike undeclared
  } catch (e) {
    // typeof on TDZ variable THROWS, unlike typeof on undeclared
  }
  let x = 5;
}

// @construct PENDING eval-let-scope
// @annotation
// FUNCTION <<evalLetScope>> -> CONTAINS -> CALL <<eval('let y = 2')>>
// CALL <<eval('let y = 2')>> -> PASSES_ARGUMENT -> LITERAL <<'let y = 2'>>
// CALL <<eval('let y = 2')>> -> HAS_SCOPE -> SCOPE <<eval-scope>>
// SCOPE <<eval-scope>> -> DECLARES -> VARIABLE <<y>>
// VARIABLE <<y>> -> ASSIGNED_FROM -> LITERAL <<2>>
// FUNCTION <<evalLetScope>> -> CONTAINS -> TRY_BLOCK <<try-block>>
// FUNCTION <<evalLetScope>> -> HAS_CATCH -> CATCH_BLOCK <<catch-block>>
// TRY_BLOCK <<try-block>> -> CONTAINS -> EXPRESSION <<return y>>
// EXPRESSION <<return y>> -> READS_FROM -> VARIABLE <<y>>
// FUNCTION <<evalLetScope>> -> RETURNS -> EXPRESSION <<return y>>
// CATCH_BLOCK <<catch-block>> -> RECEIVES_ARGUMENT -> PARAMETER <<e>>
// FUNCTION <<evalLetScope>> -> RETURNS -> LITERAL <<'y not accessible'>>
// @end-annotation
function evalLetScope() {
  eval('let y = 2');   // y is block-scoped to the eval itself
  try {
    return y;          // ReferenceError — y doesn't exist here
  } catch (e) {
    return 'y not accessible';
  }
}

// @construct PENDING block-label-ambiguity
// @annotation
// UNKNOWN <<module>> -> DECLARES -> FUNCTION <<blockLabelAmbiguity>>
// FUNCTION <<blockLabelAmbiguity>> -> CONTAINS -> VARIABLE <<obj>>
// VARIABLE <<obj>> -> ASSIGNED_FROM -> CALL <<eval('({ a: 1, b: 2 })')>>
// CALL <<eval('({ a: 1, b: 2 })')>> -> CALLS -> EXTERNAL <<eval>>
// CALL <<eval('({ a: 1, b: 2 })')>> -> PASSES_ARGUMENT -> LITERAL <<'({ a: 1, b: 2 })'>>
// FUNCTION <<blockLabelAmbiguity>> -> RETURNS -> VARIABLE <<obj>>
// @end-annotation
function blockLabelAmbiguity() {
  // { a: 1 } in statement position is a block with labeled expression, NOT an object
  // Parentheses force expression context:
  const obj = eval('({ a: 1, b: 2 })'); // object literal
  // eval('{ a: 1, b: 2 }');            // SyntaxError — block + label + illegal comma
  return obj;
}

// @construct PENDING var-redeclares-parameter
// @annotation
// FUNCTION <<varRedeclaresParameter>> -> CONTAINS -> PARAMETER <<x>>
// FUNCTION <<varRedeclaresParameter>> -> CONTAINS -> PARAMETER <<y>>
// PARAMETER <<x>> -> ASSIGNED_FROM -> EXPRESSION <<x || 'default'>>
// EXPRESSION <<x || 'default'>> -> READS_FROM -> PARAMETER <<x>>
// EXPRESSION <<x || 'default'>> -> READS_FROM -> LITERAL <<'default'>>
// FUNCTION <<varRedeclaresParameter>> -> RETURNS -> LITERAL <<{...}>>
// LITERAL <<{...}>> -> READS_FROM -> PARAMETER <<x>>
// LITERAL <<{...}>> -> READS_FROM -> PARAMETER <<y>>
// @end-annotation
function varRedeclaresParameter(x, y) {
  var x = x || 'default'; // same binding as parameter x — NOT a new variable
  var y;                    // re-declares y but does NOT reset it
  return { x, y };
}
// varRedeclaresParameter(null, 42) → { x: 'default', y: 42 }
// Contrast: let x = ... inside would be SyntaxError (cannot re-declare param)

// @construct PENDING export-named-list
// @annotation
// UNKNOWN <<module>> -> CONTAINS -> EXPORT <<export-named-list>>
// EXPORT <<export-named-list>> -> EXPORTS -> UNKNOWN <<stringCoercion>>
// EXPORT <<export-named-list>> -> EXPORTS -> UNKNOWN <<numberCoercion>>
// EXPORT <<export-named-list>> -> EXPORTS -> UNKNOWN <<booleanCoercion>>
// EXPORT <<export-named-list>> -> EXPORTS -> UNKNOWN <<equalityCoercion>>
// EXPORT <<export-named-list>> -> EXPORTS -> UNKNOWN <<customCoerce>>
// EXPORT <<export-named-list>> -> EXPORTS -> UNKNOWN <<usedInMath>>
// EXPORT <<export-named-list>> -> EXPORTS -> UNKNOWN <<usedInTemplate>>
// EXPORT <<export-named-list>> -> EXPORTS -> UNKNOWN <<toPrimitive>>
// EXPORT <<export-named-list>> -> EXPORTS -> UNKNOWN <<varHoisting>>
// EXPORT <<export-named-list>> -> EXPORTS -> UNKNOWN <<functionHoisting>>
// EXPORT <<export-named-list>> -> EXPORTS -> UNKNOWN <<functionExprNotHoisted>>
// EXPORT <<export-named-list>> -> EXPORTS -> UNKNOWN <<tdzLet>>
// EXPORT <<export-named-list>> -> EXPORTS -> UNKNOWN <<tdzConst>>
// EXPORT <<export-named-list>> -> EXPORTS -> UNKNOWN <<tdzClass>>
// EXPORT <<export-named-list>> -> EXPORTS -> UNKNOWN <<outerConst>>
// EXPORT <<export-named-list>> -> EXPORTS -> UNKNOWN <<shadowingExample>>
// EXPORT <<export-named-list>> -> EXPORTS -> UNKNOWN <<paramShadowing>>
// EXPORT <<export-named-list>> -> EXPORTS -> UNKNOWN <<catchShadowing>>
// EXPORT <<export-named-list>> -> EXPORTS -> UNKNOWN <<directEval>>
// EXPORT <<export-named-list>> -> EXPORTS -> UNKNOWN <<indirectEval>>
// EXPORT <<export-named-list>> -> EXPORTS -> UNKNOWN <<newFunction>>
// EXPORT <<export-named-list>> -> EXPORTS -> UNKNOWN <<commaSequence>>
// EXPORT <<export-named-list>> -> EXPORTS -> UNKNOWN <<evalVarInjection>>
// EXPORT <<export-named-list>> -> EXPORTS -> UNKNOWN <<evalFunctionInjection>>
// EXPORT <<export-named-list>> -> EXPORTS -> UNKNOWN <<primitiveAutoboxing>>
// EXPORT <<export-named-list>> -> EXPORTS -> UNKNOWN <<varFunctionCollision>>
// EXPORT <<export-named-list>> -> EXPORTS -> UNKNOWN <<contextualKeywords>>
// EXPORT <<export-named-list>> -> EXPORTS -> UNKNOWN <<objectAsMapKey>>
// EXPORT <<export-named-list>> -> EXPORTS -> UNKNOWN <<blockFunctionDemo>>
// EXPORT <<export-named-list>> -> EXPORTS -> UNKNOWN <<varInCatchClobber>>
// EXPORT <<export-named-list>> -> EXPORTS -> UNKNOWN <<typeofTdzTrap>>
// EXPORT <<export-named-list>> -> EXPORTS -> UNKNOWN <<evalLetScope>>
// EXPORT <<export-named-list>> -> EXPORTS -> UNKNOWN <<blockLabelAmbiguity>>
// EXPORT <<export-named-list>> -> EXPORTS -> UNKNOWN <<varRedeclaresParameter>>
// @end-annotation
export {
  stringCoercion,
  numberCoercion,
  booleanCoercion,
  equalityCoercion,
  customCoerce,
  usedInMath,
  usedInTemplate,
  toPrimitive,
  varHoisting,
  functionHoisting,
  functionExprNotHoisted,
  tdzLet,
  tdzConst,
  tdzClass,
  outerConst,
  shadowingExample,
  paramShadowing,
  catchShadowing,
  directEval,
  indirectEval,
  newFunction,
  commaSequence,
  evalVarInjection,
  evalFunctionInjection,
  primitiveAutoboxing,
  varFunctionCollision,
  contextualKeywords,
  objectAsMapKey,
  blockFunctionDemo,
  varInCatchClobber,
  typeofTdzTrap,
  evalLetScope,
  blockLabelAmbiguity,
  varRedeclaresParameter,
};
