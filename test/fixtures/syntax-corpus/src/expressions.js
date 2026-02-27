// =============================================================================
// expressions.js — Operators, Calls, Templates, Type Checks
// =============================================================================

// @construct PENDING arithmetic-ops
// @annotation
// @end-annotation
function arithmeticOperators(a, b) {
  const add = a + b;
  const sub = a - b;
  const mul = a * b;
  const div = a / b;
  const mod = a % b;
  const exp = a ** b;
  return { add, sub, mul, div, mod, exp };
}

// @construct PENDING comparison-ops
// @annotation
// @end-annotation
function comparisonOperators(a, b) {
  const eq = a == b;
  const strictEq = a === b;
  const neq = a != b;
  const strictNeq = a !== b;
  const lt = a < b;
  const gt = a > b;
  const lte = a <= b;
  const gte = a >= b;
  return { eq, strictEq, neq, strictNeq, lt, gt, lte, gte };
}

// @construct PENDING logical-ops
// @annotation
// FUNCTION <<logicalOperators>> -> CONTAINS -> PARAMETER <<a>>
// FUNCTION <<logicalOperators>> -> CONTAINS -> PARAMETER <<b>>
// FUNCTION <<logicalOperators>> -> CONTAINS -> VARIABLE <<and>>
// VARIABLE <<and>> -> ASSIGNED_FROM -> EXPRESSION <<a && b>>
// EXPRESSION <<a && b>> -> READS_FROM -> PARAMETER <<a>>
// EXPRESSION <<a && b>> -> READS_FROM -> PARAMETER <<b>>
// FUNCTION <<logicalOperators>> -> CONTAINS -> VARIABLE <<or>>
// VARIABLE <<or>> -> ASSIGNED_FROM -> EXPRESSION <<a || b>>
// EXPRESSION <<a || b>> -> READS_FROM -> PARAMETER <<a>>
// EXPRESSION <<a || b>> -> READS_FROM -> PARAMETER <<b>>
// FUNCTION <<logicalOperators>> -> CONTAINS -> VARIABLE <<nullish>>
// VARIABLE <<nullish>> -> ASSIGNED_FROM -> EXPRESSION <<a ?? b>>
// EXPRESSION <<a ?? b>> -> READS_FROM -> PARAMETER <<a>>
// EXPRESSION <<a ?? b>> -> READS_FROM -> PARAMETER <<b>>
// FUNCTION <<logicalOperators>> -> CONTAINS -> VARIABLE <<not>>
// VARIABLE <<not>> -> ASSIGNED_FROM -> EXPRESSION <<!a>>
// EXPRESSION <<!a>> -> READS_FROM -> PARAMETER <<a>>
// FUNCTION <<logicalOperators>> -> RETURNS -> LITERAL <<{...}>>
// LITERAL <<{...}>> -> READS_FROM -> VARIABLE <<and>>
// LITERAL <<{...}>> -> READS_FROM -> VARIABLE <<or>>
// LITERAL <<{...}>> -> READS_FROM -> VARIABLE <<nullish>>
// LITERAL <<{...}>> -> READS_FROM -> VARIABLE <<not>>
// @end-annotation
function logicalOperators(a, b) {
  const and = a && b;
  const or = a || b;
  const nullish = a ?? b;
  const not = !a;
  return { and, or, nullish, not };
}

// @construct PENDING bitwise-ops
// @annotation
// @end-annotation
function bitwiseOperators(a, b) {
  const and = a & b;
  const or = a | b;
  const xor = a ^ b;
  const not = ~a;
  const lshift = a << b;
  const rshift = a >> b;
  const urshift = a >>> b;
  return { and, or, xor, not, lshift, rshift, urshift };
}

// @construct PENDING unary-ops
// @annotation
// FUNCTION <<unaryOperators>> -> CONTAINS -> PARAMETER <<x>>
// FUNCTION <<unaryOperators>> -> CONTAINS -> VARIABLE <<pos>>
// VARIABLE <<pos>> -> ASSIGNED_FROM -> EXPRESSION <<+x>>
// EXPRESSION <<+x>> -> READS_FROM -> PARAMETER <<x>>
// FUNCTION <<unaryOperators>> -> CONTAINS -> VARIABLE <<neg>>
// VARIABLE <<neg>> -> ASSIGNED_FROM -> EXPRESSION <<-x>>
// EXPRESSION <<-x>> -> READS_FROM -> PARAMETER <<x>>
// FUNCTION <<unaryOperators>> -> CONTAINS -> VARIABLE <<logNot>>
// VARIABLE <<logNot>> -> ASSIGNED_FROM -> EXPRESSION <<!x>>
// EXPRESSION <<!x>> -> READS_FROM -> PARAMETER <<x>>
// FUNCTION <<unaryOperators>> -> CONTAINS -> VARIABLE <<bitNot>>
// VARIABLE <<bitNot>> -> ASSIGNED_FROM -> EXPRESSION <<~x>>
// EXPRESSION <<~x>> -> READS_FROM -> PARAMETER <<x>>
// FUNCTION <<unaryOperators>> -> CONTAINS -> VARIABLE <<typeOfX>>
// VARIABLE <<typeOfX>> -> ASSIGNED_FROM -> EXPRESSION <<typeof x>>
// EXPRESSION <<typeof x>> -> READS_FROM -> PARAMETER <<x>>
// FUNCTION <<unaryOperators>> -> CONTAINS -> VARIABLE <<voidX>>
// VARIABLE <<voidX>> -> ASSIGNED_FROM -> EXPRESSION <<void x>>
// EXPRESSION <<void x>> -> READS_FROM -> PARAMETER <<x>>
// FUNCTION <<unaryOperators>> -> RETURNS -> LITERAL <<{...}>>
// LITERAL <<{...}>> -> READS_FROM -> VARIABLE <<pos>>
// LITERAL <<{...}>> -> READS_FROM -> VARIABLE <<neg>>
// LITERAL <<{...}>> -> READS_FROM -> VARIABLE <<logNot>>
// LITERAL <<{...}>> -> READS_FROM -> VARIABLE <<bitNot>>
// LITERAL <<{...}>> -> READS_FROM -> VARIABLE <<typeOfX>>
// LITERAL <<{...}>> -> READS_FROM -> VARIABLE <<voidX>>
// @end-annotation
function unaryOperators(x) {
  const pos = +x;
  const neg = -x;
  const logNot = !x;
  const bitNot = ~x;
  const typeOfX = typeof x;
  const voidX = void x;
  return { pos, neg, logNot, bitNot, typeOfX, voidX };
}

// @construct PENDING delete-op
// @annotation
// FUNCTION <<deleteOperator>> -> CONTAINS -> VARIABLE <<obj>>
// VARIABLE <<obj>> -> ASSIGNED_FROM -> LITERAL <<{ a: 1, b: 2 }>>
// LITERAL <<{ a: 1, b: 2 }>> -> HAS_PROPERTY -> LITERAL <<1>>
// LITERAL <<{ a: 1, b: 2 }>> -> HAS_PROPERTY -> LITERAL <<2>>
// FUNCTION <<deleteOperator>> -> CONTAINS -> EXPRESSION <<delete obj.a>>
// EXPRESSION <<delete obj.a>> -> DELETES -> PROPERTY_ACCESS <<obj.a>>
// PROPERTY_ACCESS <<obj.a>> -> READS_FROM -> VARIABLE <<obj>>
// FUNCTION <<deleteOperator>> -> RETURNS -> VARIABLE <<obj>>
// @end-annotation
function deleteOperator() {
  const obj = { a: 1, b: 2 };
  delete obj.a;
  return obj;
}

// @construct PENDING update-expr
// @annotation
// FUNCTION <<updateExpressions>> -> CONTAINS -> VARIABLE <<x>>
// VARIABLE <<x>> -> ASSIGNED_FROM -> LITERAL <<0>>
// EXPRESSION <<x++>> -> READS_FROM -> VARIABLE <<x>>
// EXPRESSION <<x++>> -> WRITES_TO -> VARIABLE <<x>>
// EXPRESSION <<x-->> -> READS_FROM -> VARIABLE <<x>>
// EXPRESSION <<x-->> -> WRITES_TO -> VARIABLE <<x>>
// EXPRESSION <<++x>> -> READS_FROM -> VARIABLE <<x>>
// EXPRESSION <<++x>> -> WRITES_TO -> VARIABLE <<x>>
// EXPRESSION <<--x>> -> READS_FROM -> VARIABLE <<x>>
// EXPRESSION <<--x>> -> WRITES_TO -> VARIABLE <<x>>
// FUNCTION <<updateExpressions>> -> RETURNS -> VARIABLE <<x>>
// @end-annotation
function updateExpressions() {
  let x = 0;
  x++;
  x--;
  ++x;
  --x;
  return x;
}

// @construct PENDING assignment-ops
// @annotation
// @end-annotation
function assignmentOperators() {
  let x = 10;
  x += 5;
  x -= 3;
  x *= 2;
  x /= 4;
  x %= 3;
  x **= 2;
  x &= 0xff;
  x |= 0x0f;
  x ^= 0xaa;
  x <<= 2;
  x >>= 1;
  x >>>= 1;

  let flag = true;
  flag &&= false;
  flag ||= true;

  let val = null;
  val ??= 'fallback';

  return { x, flag, val };
}

// @construct PENDING ternary
// @annotation
// FUNCTION <<ternaryOperator>> -> CONTAINS -> PARAMETER <<condition>>
// FUNCTION <<ternaryOperator>> -> CONTAINS -> PARAMETER <<value>>
// FUNCTION <<ternaryOperator>> -> CONTAINS -> VARIABLE <<simple>>
// FUNCTION <<ternaryOperator>> -> CONTAINS -> VARIABLE <<nested>>
// VARIABLE <<simple>> -> ASSIGNED_FROM -> EXPRESSION <<condition ? 'yes' : 'no'>>
// EXPRESSION <<condition ? 'yes' : 'no'>> -> HAS_CONDITION -> PARAMETER <<condition>>
// EXPRESSION <<condition ? 'yes' : 'no'>> -> HAS_CONSEQUENT -> LITERAL <<'yes'>>
// EXPRESSION <<condition ? 'yes' : 'no'>> -> HAS_ALTERNATE -> LITERAL <<'no'>>
// VARIABLE <<nested>> -> ASSIGNED_FROM -> EXPRESSION <<condition ? (value > 5 ? 'high' : 'low') : 'none'>>
// EXPRESSION <<condition ? (value > 5 ? 'high' : 'low') : 'none'>> -> HAS_CONDITION -> PARAMETER <<condition>>
// EXPRESSION <<condition ? (value > 5 ? 'high' : 'low') : 'none'>> -> HAS_CONSEQUENT -> EXPRESSION <<value > 5 ? 'high' : 'low'>>
// EXPRESSION <<condition ? (value > 5 ? 'high' : 'low') : 'none'>> -> HAS_ALTERNATE -> LITERAL <<'none'>>
// EXPRESSION <<value > 5 ? 'high' : 'low'>> -> HAS_CONDITION -> EXPRESSION <<value > 5>>
// EXPRESSION <<value > 5 ? 'high' : 'low'>> -> HAS_CONSEQUENT -> LITERAL <<'high'>>
// EXPRESSION <<value > 5 ? 'high' : 'low'>> -> HAS_ALTERNATE -> LITERAL <<'low'>>
// EXPRESSION <<value > 5>> -> READS_FROM -> PARAMETER <<value>>
// EXPRESSION <<value > 5>> -> READS_FROM -> LITERAL <<5>>
// FUNCTION <<ternaryOperator>> -> RETURNS -> LITERAL <<{...}>>
// LITERAL <<{...}>> -> HAS_PROPERTY -> VARIABLE <<simple>>
// LITERAL <<{...}>> -> HAS_PROPERTY -> VARIABLE <<nested>>
// @end-annotation
function ternaryOperator(condition, value) {
  const simple = condition ? 'yes' : 'no';
  const nested = condition ? (value > 5 ? 'high' : 'low') : 'none';
  return { simple, nested };
}

// @construct PENDING optional-chaining
// @annotation
// FUNCTION <<optionalChaining>> -> CONTAINS -> PARAMETER <<obj>>
// FUNCTION <<optionalChaining>> -> CONTAINS -> VARIABLE <<prop>>
// FUNCTION <<optionalChaining>> -> CONTAINS -> VARIABLE <<method>>
// FUNCTION <<optionalChaining>> -> CONTAINS -> VARIABLE <<computed>>
// VARIABLE <<prop>> -> ASSIGNED_FROM -> EXPRESSION <<obj?.nested?.deep>>
// EXPRESSION <<obj?.nested?.deep>> -> READS_FROM -> PARAMETER <<obj>>
// VARIABLE <<method>> -> ASSIGNED_FROM -> EXPRESSION <<obj?.method?.()>>
// EXPRESSION <<obj?.method?.()>> -> READS_FROM -> PARAMETER <<obj>>
// VARIABLE <<computed>> -> ASSIGNED_FROM -> EXPRESSION <<obj?.items?.[0]>>
// EXPRESSION <<obj?.items?.[0]>> -> READS_FROM -> PARAMETER <<obj>>
// EXPRESSION <<obj?.items?.[0]>> -> READS_FROM -> LITERAL <<0>>
// FUNCTION <<optionalChaining>> -> RETURNS -> LITERAL <<{...}>>
// LITERAL <<{...}>> -> READS_FROM -> VARIABLE <<prop>>
// LITERAL <<{...}>> -> READS_FROM -> VARIABLE <<method>>
// LITERAL <<{...}>> -> READS_FROM -> VARIABLE <<computed>>
// @end-annotation
function optionalChaining(obj) {
  const prop = obj?.nested?.deep;
  const method = obj?.method?.();
  const computed = obj?.items?.[0];
  return { prop, method, computed };
}

// @construct PENDING template-literal
// @annotation
// @end-annotation
function templateLiterals(name, age) {
  const simple = `Hello, ${name}!`;
  const multiline = `
    Name: ${name}
    Age: ${age}
  `;
  const expression = `Result: ${age * 2 + 1}`;
  const nested = `Outer ${`inner ${name}`} end`;
  return { simple, multiline, expression, nested };
}

// @construct PENDING tagged-template-fn
// @annotation
// FUNCTION <<tag>> -> HAS_BODY -> PARAMETER <<strings>>
// FUNCTION <<tag>> -> HAS_BODY -> PARAMETER <<values>>
// PROPERTY_ACCESS <<strings.raw>> -> READS_FROM -> PARAMETER <<strings>>
// CALL <<strings.raw.join('')>> -> CALLS_ON -> PROPERTY_ACCESS <<strings.raw>>
// CALL <<strings.raw.join('')>> -> PASSES_ARGUMENT -> LITERAL <<''>>
// CALL <<values.join('')>> -> CALLS_ON -> PARAMETER <<values>>
// CALL <<values.join('')>> -> PASSES_ARGUMENT -> LITERAL <<''>>
// EXPRESSION <<strings.raw.join('') + values.join('')>> -> READS_FROM -> CALL <<strings.raw.join('')>>
// EXPRESSION <<strings.raw.join('') + values.join('')>> -> READS_FROM -> CALL <<values.join('')>>
// FUNCTION <<tag>> -> RETURNS -> EXPRESSION <<strings.raw.join('') + values.join('')>>
// @end-annotation
function tag(strings, ...values) {
  return strings.raw.join('') + values.join('');
}

// @construct PENDING tagged-template-usage
// @annotation
// @end-annotation
const tagged = tag`Hello ${'world'} number ${42}`;

// @construct PENDING new-expr
function constructorCalls() {
  const date = new Date();
  const map = new Map();
  const set = new Set([1, 2, 3]);
  const regex = new RegExp('pattern', 'gi');
  const error = new Error('message');
  const weakMap = new WeakMap();
  const weakSet = new WeakSet();
  const promise = new Promise((resolve) => resolve(42));
  return { date, map, set, regex, error, weakMap, weakSet, promise };
}

// @construct PENDING call-expr
// @annotation
// @end-annotation
function callExpressions() {
  const sum = arithmeticOperators(1, 2);

  const arr = [3, 1, 2];
  arr.sort();
  arr.push(4);

  const result = [1, 2, 3].filter(x => x > 1).map(x => x * 2);

  const obj = { fn: () => 42 };
  const computed = obj['fn']();

  const doubled = [1, 2, 3].map(x => x * 2);
  const sum2 = [1, 2, 3].reduce((acc, x) => acc + x, 0);
  const found = [1, 2, 3].find(x => x === 2);

  return { sum, result, computed, doubled, sum2, found };
}

// @construct PENDING typeof-instanceof-in
// @annotation
// @end-annotation
function typeCheckOperators(value) {
  const isString = typeof value === 'string';
  const isNumber = typeof value === 'number';
  const isArray = value instanceof Array;
  const isError = value instanceof Error;
  const hasKey = 'key' in (value || {});
  return { isString, isNumber, isArray, isError, hasKey };
}

// @construct PENDING comma-op
// @annotation
// @end-annotation
function commaOperator() {
  const result = (1, 2, 3);
  let x = 0;
  for (let i = 0, j = 10; i < j; i++, j--) {
    x += i;
  }
  return { result, x };
}

// @construct PENDING grouping
// @annotation
// FUNCTION <<groupingOperator>> -> CONTAINS -> PARAMETER <<a>>
// FUNCTION <<groupingOperator>> -> CONTAINS -> PARAMETER <<b>>
// FUNCTION <<groupingOperator>> -> CONTAINS -> PARAMETER <<c>>
// FUNCTION <<groupingOperator>> -> CONTAINS -> VARIABLE <<withGrouping>>
// VARIABLE <<withGrouping>> -> ASSIGNED_FROM -> EXPRESSION <<(a + b) * c>>
// EXPRESSION <<(a + b) * c>> -> READS_FROM -> EXPRESSION <<a + b>>
// EXPRESSION <<(a + b) * c>> -> READS_FROM -> PARAMETER <<c>>
// EXPRESSION <<a + b>> -> READS_FROM -> PARAMETER <<a>>
// EXPRESSION <<a + b>> -> READS_FROM -> PARAMETER <<b>>
// FUNCTION <<groupingOperator>> -> CONTAINS -> VARIABLE <<withoutGrouping>>
// VARIABLE <<withoutGrouping>> -> ASSIGNED_FROM -> EXPRESSION <<a + b * c>>
// EXPRESSION <<a + b * c>> -> READS_FROM -> PARAMETER <<a>>
// EXPRESSION <<a + b * c>> -> READS_FROM -> EXPRESSION <<b * c>>
// EXPRESSION <<b * c>> -> READS_FROM -> PARAMETER <<b>>
// EXPRESSION <<b * c>> -> READS_FROM -> PARAMETER <<c>>
// FUNCTION <<groupingOperator>> -> RETURNS -> LITERAL <<{...}>>
// LITERAL <<{...}>> -> READS_FROM -> VARIABLE <<withGrouping>>
// LITERAL <<{...}>> -> READS_FROM -> VARIABLE <<withoutGrouping>>
// @end-annotation
function groupingOperator(a, b, c) {
  const withGrouping = (a + b) * c;
  const withoutGrouping = a + b * c;
  return { withGrouping, withoutGrouping };
}

// @construct PENDING proxy-reflect
// @annotation
// @end-annotation
function proxyAndReflect() {
  const target = { x: 1, y: 2 };
  const handler = {
    get(obj, prop, receiver) {
      return Reflect.get(obj, prop, receiver);
    },
    set(obj, prop, value, receiver) {
      return Reflect.set(obj, prop, value, receiver);
    },
  };
  return new Proxy(target, handler);
}

// @construct PENDING chained-assignment
// @annotation
// FUNCTION <<chainedAssignment>> -> DECLARES -> VARIABLE <<a>>
// FUNCTION <<chainedAssignment>> -> DECLARES -> VARIABLE <<b>>
// FUNCTION <<chainedAssignment>> -> DECLARES -> VARIABLE <<c>>
// VARIABLE <<c>> -> ASSIGNED_FROM -> LITERAL <<42>>
// VARIABLE <<b>> -> ASSIGNED_FROM -> VARIABLE <<c>>
// VARIABLE <<a>> -> ASSIGNED_FROM -> VARIABLE <<b>>
// FUNCTION <<chainedAssignment>> -> RETURNS -> LITERAL <<{...}>>
// LITERAL <<{...}>> -> READS_FROM -> VARIABLE <<a>>
// LITERAL <<{...}>> -> READS_FROM -> VARIABLE <<b>>
// LITERAL <<{...}>> -> READS_FROM -> VARIABLE <<c>>
// @end-annotation
function chainedAssignment() {
  let a, b, c;
  a = b = c = 42;
  return { a, b, c };
}

// @construct PENDING chained-assignment-mixed
// @annotation
// FUNCTION <<chainedAssignmentMixed>> -> CONTAINS -> VARIABLE <<obj>>
// VARIABLE <<obj>> -> ASSIGNED_FROM -> LITERAL <<{}>>
// EXPRESSION <<obj.x = obj.y = []>> -> READS_FROM -> LITERAL <<[]>>
// PROPERTY_ACCESS <<obj.y>> -> ASSIGNED_FROM -> LITERAL <<[]>>
// PROPERTY_ACCESS <<obj.x>> -> ASSIGNED_FROM -> PROPERTY_ACCESS <<obj.y>>
// EXPRESSION <<obj.x = obj.y = []>> -> WRITES_TO -> PROPERTY_ACCESS <<obj.x>>
// EXPRESSION <<obj.x = obj.y = []>> -> WRITES_TO -> PROPERTY_ACCESS <<obj.y>>
// FUNCTION <<chainedAssignmentMixed>> -> RETURNS -> VARIABLE <<obj>>
// @end-annotation
function chainedAssignmentMixed() {
  const obj = {};
  obj.x = obj.y = [];
  return obj;
}

// @construct PENDING short-circuit-side-effect
// @annotation
// @end-annotation
function shortCircuitSideEffects() {
  let count = 0;
  function effect() { count++; return true; }

  const a = false && effect();  // effect NOT called
  const b = true || effect();   // effect NOT called
  const c = null ?? effect();   // effect IS called
  const d = true && effect();   // effect IS called
  return { a, b, c, d, count };
}

// @construct PENDING tagged-template-raw
// @annotation
// UNKNOWN <<module>> -> DECLARES -> FUNCTION <<rawTemplate>>
// FUNCTION <<rawTemplate>> -> CONTAINS -> PARAMETER <<strings>>
// FUNCTION <<rawTemplate>> -> RETURNS -> PROPERTY_ACCESS <<strings.raw[0]>>
// PROPERTY_ACCESS <<strings.raw[0]>> -> READS_FROM -> PARAMETER <<strings>>
// UNKNOWN <<module>> -> DECLARES -> VARIABLE <<rawResult>>
// VARIABLE <<rawResult>> -> ASSIGNED_FROM -> CALL <<rawTemplate`\n`>>
// CALL <<rawTemplate`\n`>> -> CALLS -> FUNCTION <<rawTemplate>>
// @end-annotation
function rawTemplate(strings) {
  return strings.raw[0];
}
const rawResult = rawTemplate`\n`;

// @construct PENDING tagged-template-rewriting
// @annotation
// @end-annotation
function html(strings, ...values) {
  return strings.reduce((result, str, i) =>
    result + str + (values[i] !== undefined ? String(values[i]).replace(/</g, '&lt;') : ''), ''
  );
}
const userInput = '<script>alert(1)</script>';
const sanitized = html`<div>${userInput}</div>`;

// @construct PENDING comma-in-return
// @annotation
// UNKNOWN <<module>> -> DECLARES -> FUNCTION <<commaInReturn>>
// FUNCTION <<commaInReturn>> -> RETURNS -> EXPRESSION <<(1, 2, 3)>>
// EXPRESSION <<(1, 2, 3)>> -> CONTAINS -> LITERAL <<1>>
// EXPRESSION <<(1, 2, 3)>> -> CONTAINS -> LITERAL <<2>>
// EXPRESSION <<(1, 2, 3)>> -> CONTAINS -> LITERAL <<3>>
// @end-annotation
function commaInReturn() {
  return (1, 2, 3);
}

// @construct PENDING comma-in-arrow-body
// @annotation
// EXPRESSION <<void-expression>> -> CONTAINS -> CALL <<iife-call>>
// CALL <<iife-call>> -> CALLS -> FUNCTION <<anonymous-fn>>
// FUNCTION <<anonymous-fn>> -> CONTAINS -> CALL <<console.log('fire and forget')>>
// CALL <<console.log('fire and forget')>> -> CALLS -> PROPERTY_ACCESS <<console.log>>
// CALL <<console.log('fire and forget')>> -> PASSES_ARGUMENT -> LITERAL <<'fire and forget'>>
// @end-annotation
const commaArrow = (x) => (console.log(x), x * 2);

// @construct PENDING void-iife
// @annotation
// EXPRESSION <<void-expression>> -> CONTAINS -> CALL <<iife-call>>
// CALL <<iife-call>> -> CALLS -> FUNCTION <<async-iife>>
// FUNCTION <<async-iife>> -> CONTAINS -> EXPRESSION <<await-expression>>
// EXPRESSION <<await-expression>> -> AWAITS -> CALL <<Promise.resolve('ping')>>
// CALL <<Promise.resolve('ping')>> -> CALLS -> PROPERTY_ACCESS <<Promise.resolve>>
// CALL <<Promise.resolve('ping')>> -> PASSES_ARGUMENT -> LITERAL <<'ping'>>
// PROPERTY_ACCESS <<Promise.resolve>> -> READS_FROM -> EXTERNAL <<Promise>>
// @end-annotation
void function () { console.log('fire and forget'); }();

// @construct PENDING void-promise
// @annotation
// FUNCTION <<logicalAssignProperty>> -> CONTAINS -> VARIABLE <<config>>
// VARIABLE <<config>> -> ASSIGNED_FROM -> LITERAL <<object-literal>>
// LITERAL <<object-literal>> -> HAS_PROPERTY -> PROPERTY <<timeout-prop>>
// PROPERTY <<timeout-prop>> -> ASSIGNED_FROM -> LITERAL <<0>>
// LITERAL <<object-literal>> -> HAS_PROPERTY -> PROPERTY <<retries-prop>>
// PROPERTY <<retries-prop>> -> ASSIGNED_FROM -> LITERAL <<null>>
// LITERAL <<object-literal>> -> HAS_PROPERTY -> PROPERTY <<debug-prop>>
// PROPERTY <<debug-prop>> -> ASSIGNED_FROM -> LITERAL <<false>>
// FUNCTION <<logicalAssignProperty>> -> CONTAINS -> EXPRESSION <<config.timeout ||= 5000>>
// EXPRESSION <<config.timeout ||= 5000>> -> WRITES_TO -> PROPERTY_ACCESS <<config.timeout>>
// EXPRESSION <<config.timeout ||= 5000>> -> READS_FROM -> PROPERTY_ACCESS <<config.timeout>>
// EXPRESSION <<config.timeout ||= 5000>> -> ASSIGNED_FROM -> LITERAL <<5000>>
// FUNCTION <<logicalAssignProperty>> -> CONTAINS -> EXPRESSION <<config.retries ??= 3>>
// EXPRESSION <<config.retries ??= 3>> -> WRITES_TO -> PROPERTY_ACCESS <<config.retries>>
// EXPRESSION <<config.retries ??= 3>> -> READS_FROM -> PROPERTY_ACCESS <<config.retries>>
// EXPRESSION <<config.retries ??= 3>> -> ASSIGNED_FROM -> LITERAL <<3>>
// FUNCTION <<logicalAssignProperty>> -> CONTAINS -> EXPRESSION <<config.debug &&= true>>
// EXPRESSION <<config.debug &&= true>> -> WRITES_TO -> PROPERTY_ACCESS <<config.debug>>
// EXPRESSION <<config.debug &&= true>> -> READS_FROM -> PROPERTY_ACCESS <<config.debug>>
// EXPRESSION <<config.debug &&= true>> -> ASSIGNED_FROM -> LITERAL <<true>>
// FUNCTION <<logicalAssignProperty>> -> RETURNS -> VARIABLE <<config>>
// @end-annotation
void async function () { await Promise.resolve('ping'); }();

// @construct PENDING logical-assign-property
function logicalAssignProperty() {
  const config = { timeout: 0, retries: null, debug: false };
  config.timeout ||= 5000;    // 5000 — 0 is falsy
  config.retries ??= 3;       // 3 — null is nullish
  config.debug &&= true;      // false — short-circuits
  return config;
}

// @construct PENDING conditional-method-call
// @annotation
// FUNCTION <<conditionalMethodCall>> -> CONTAINS -> PARAMETER <<input>>
// FUNCTION <<conditionalMethodCall>> -> CONTAINS -> VARIABLE <<value>>
// VARIABLE <<value>> -> ASSIGNED_FROM -> CALL <<.trim()>>
// CALL <<.trim()>> -> CALLS_ON -> EXPRESSION <<conditional>>
// EXPRESSION <<conditional>> -> HAS_CONDITION -> EXPRESSION <<typeof input === 'string'>>
// EXPRESSION <<conditional>> -> HAS_CONSEQUENT -> PARAMETER <<input>>
// EXPRESSION <<conditional>> -> HAS_ALTERNATE -> CALL <<String(input)>>
// EXPRESSION <<typeof input === 'string'>> -> READS_FROM -> EXPRESSION <<typeof input>>
// EXPRESSION <<typeof input === 'string'>> -> READS_FROM -> LITERAL <<'string'>>
// EXPRESSION <<typeof input>> -> READS_FROM -> PARAMETER <<input>>
// CALL <<String(input)>> -> PASSES_ARGUMENT -> PARAMETER <<input>>
// FUNCTION <<conditionalMethodCall>> -> RETURNS -> VARIABLE <<value>>
// @end-annotation
function conditionalMethodCall(input) {
  const value = (typeof input === 'string' ? input : String(input)).trim();
  return value;
}

// @construct PENDING comma-in-array-subscript
// @annotation
// FUNCTION <<commaSubscript>> -> CONTAINS -> VARIABLE <<matrix>>
// FUNCTION <<commaSubscript>> -> CONTAINS -> VARIABLE <<result>>
// VARIABLE <<matrix>> -> ASSIGNED_FROM -> LITERAL <<[[1, 2], [3, 4]]>>
// VARIABLE <<result>> -> ASSIGNED_FROM -> PROPERTY_ACCESS <<matrix[0, 1]>>
// PROPERTY_ACCESS <<matrix[0, 1]>> -> READS_FROM -> VARIABLE <<matrix>>
// EXPRESSION <<0, 1>> -> CONTAINS -> LITERAL <<0>>
// EXPRESSION <<0, 1>> -> CONTAINS -> LITERAL <<1>>
// FUNCTION <<commaSubscript>> -> RETURNS -> VARIABLE <<result>>
// @end-annotation
function commaSubscript() {
  const matrix = [[1, 2], [3, 4]];
  const result = matrix[0, 1]; // comma evaluates to 1 → matrix[1]
  return result; // [3, 4]
}

// @construct PENDING comma-in-condition
// @annotation
// FUNCTION <<commaInWhile>> -> CONTAINS -> VARIABLE <<i>>
// FUNCTION <<commaInWhile>> -> CONTAINS -> VARIABLE <<total>>
// VARIABLE <<i>> -> ASSIGNED_FROM -> LITERAL <<0>>
// VARIABLE <<total>> -> ASSIGNED_FROM -> LITERAL <<0_2>>
// FUNCTION <<commaInWhile>> -> CONTAINS -> LOOP <<while>>
// LOOP <<while>> -> HAS_CONDITION -> EXPRESSION <<comma-condition>>
// EXPRESSION <<comma-condition>> -> HAS_ELEMENT -> EXPRESSION <<total += i>>
// EXPRESSION <<comma-condition>> -> HAS_ELEMENT -> EXPRESSION <<++i < 5>>
// EXPRESSION <<total += i>> -> WRITES_TO -> VARIABLE <<total>>
// EXPRESSION <<total += i>> -> READS_FROM -> VARIABLE <<i>>
// EXPRESSION <<++i>> -> WRITES_TO -> VARIABLE <<i>>
// EXPRESSION <<++i < 5>> -> HAS_ELEMENT -> EXPRESSION <<++i>>
// EXPRESSION <<++i < 5>> -> HAS_ELEMENT -> LITERAL <<5>>
// FUNCTION <<commaInWhile>> -> CONTAINS -> EXPRESSION <<return total>>
// EXPRESSION <<return total>> -> READS_FROM -> VARIABLE <<total>>
// FUNCTION <<commaInWhile>> -> RETURNS -> EXPRESSION <<return total>>
// @end-annotation
function commaInWhile() {
  let i = 0, total = 0;
  while ((total += i, ++i < 5)) {
    // comma in condition
  }
  return total; // 10
}

// @construct PENDING new-constructor-return-non-this
// @annotation
// UNKNOWN <<MODULE>> -> DECLARES -> FUNCTION <<NonThisConstructor>>
// FUNCTION <<NonThisConstructor>> -> RETURNS -> LITERAL <<{ custom: true }>>
// UNKNOWN <<MODULE>> -> DECLARES -> VARIABLE <<nonThisInstance>>
// VARIABLE <<nonThisInstance>> -> ASSIGNED_FROM -> CALL <<new NonThisConstructor()>>
// CALL <<new NonThisConstructor()>> -> CALLS -> FUNCTION <<NonThisConstructor>>
// @end-annotation
function NonThisConstructor() {
  return { custom: true }; // returns different object than `this`
}
const nonThisInstance = new NonThisConstructor(); // NOT instanceof NonThisConstructor!

// @construct PENDING new-precedence-trap
// @annotation
// FUNCTION <<newPrecedence>> -> CONTAINS -> VARIABLE <<withParens>>
// FUNCTION <<newPrecedence>> -> CONTAINS -> VARIABLE <<noParens>>
// VARIABLE <<withParens>> -> ASSIGNED_FROM -> CALL <<getTime()>>
// CALL <<getTime()>> -> CALLS -> PROPERTY_ACCESS <<Date().getTime>>
// PROPERTY_ACCESS <<Date().getTime>> -> CALLS_ON -> CALL <<new Date()>>
// CALL <<new Date()>> -> CALLS -> EXTERNAL <<Date>>
// VARIABLE <<noParens>> -> ASSIGNED_FROM -> CALL <<new Map>>
// CALL <<new Map>> -> CALLS -> EXTERNAL <<Map>>
// FUNCTION <<newPrecedence>> -> RETURNS -> LITERAL <<{...}>>
// LITERAL <<{...}>> -> READS_FROM -> VARIABLE <<withParens>>
// LITERAL <<{...}>> -> READS_FROM -> VARIABLE <<noParens>>
// @end-annotation
function newPrecedence() {
  const withParens = new Date().getTime();       // (new Date()).getTime()
  // new Date.getTime()                          // new (Date.getTime)() — TypeError!
  const noParens = new Map;                      // valid — no parens needed
  return { withParens, noParens };
}

// @construct PENDING new-member-expression
// @annotation
// FUNCTION <<newMemberExpression>> -> CONTAINS -> PARAMETER <<mod>>
// FUNCTION <<newMemberExpression>> -> DECLARES -> VARIABLE <<instance>>
// VARIABLE <<instance>> -> ASSIGNED_FROM -> EXPRESSION <<new mod.MyClass()>>
// EXPRESSION <<new mod.MyClass()>> -> CALLS -> PROPERTY_ACCESS <<mod.MyClass>>
// PROPERTY_ACCESS <<mod.MyClass>> -> READS_FROM -> PARAMETER <<mod>>
// FUNCTION <<newMemberExpression>> -> DECLARES -> VARIABLE <<nested>>
// VARIABLE <<nested>> -> ASSIGNED_FROM -> EXPRESSION <<new mod.sub.Factory()>>
// EXPRESSION <<new mod.sub.Factory()>> -> CALLS -> PROPERTY_ACCESS <<mod.sub.Factory>>
// PROPERTY_ACCESS <<mod.sub.Factory>> -> READS_FROM -> PROPERTY_ACCESS <<mod.sub>>
// PROPERTY_ACCESS <<mod.sub>> -> READS_FROM -> PARAMETER <<mod>>
// FUNCTION <<newMemberExpression>> -> RETURNS -> LITERAL <<{...}>>
// LITERAL <<{...}>> -> READS_FROM -> VARIABLE <<instance>>
// LITERAL <<{...}>> -> READS_FROM -> VARIABLE <<nested>>
// @end-annotation
function newMemberExpression(mod) {
  const instance = new mod.MyClass();
  const nested = new mod.sub.Factory();
  return { instance, nested };
}

// @construct PENDING conditional-tag-template
// @annotation
// FUNCTION <<conditionalTagTemplate>> -> CONTAINS -> PARAMETER <<dangerous>>
// FUNCTION <<conditionalTagTemplate>> -> CONTAINS -> VARIABLE <<escape>>
// VARIABLE <<escape>> -> ASSIGNED_FROM -> EXPRESSION <<dangerous ? (s) => s[0].toUpperCase() : (s) => s[0]>>
// EXPRESSION <<dangerous ? (s) => s[0].toUpperCase() : (s) => s[0]>> -> READS_FROM -> PARAMETER <<dangerous>>
// EXPRESSION <<dangerous ? (s) => s[0].toUpperCase() : (s) => s[0]>> -> HAS_CONSEQUENT -> FUNCTION <<(s) => s[0].toUpperCase()>>
// EXPRESSION <<dangerous ? (s) => s[0].toUpperCase() : (s) => s[0]>> -> HAS_ALTERNATE -> FUNCTION <<(s) => s[0]>>
// FUNCTION <<(s) => s[0].toUpperCase()>> -> CONTAINS -> PARAMETER <<s1>>
// FUNCTION <<(s) => s[0].toUpperCase()>> -> RETURNS -> CALL <<s[0].toUpperCase()>>
// CALL <<s[0].toUpperCase()>> -> CALLS -> PROPERTY_ACCESS <<s[0]>>
// PROPERTY_ACCESS <<s[0]>> -> READS_FROM -> PARAMETER <<s1>>
// FUNCTION <<(s) => s[0]>> -> CONTAINS -> PARAMETER <<s2>>
// FUNCTION <<(s) => s[0]>> -> RETURNS -> PROPERTY_ACCESS <<s2[0]>>
// PROPERTY_ACCESS <<s2[0]>> -> READS_FROM -> PARAMETER <<s2>>
// FUNCTION <<conditionalTagTemplate>> -> CONTAINS -> VARIABLE <<result>>
// VARIABLE <<result>> -> ASSIGNED_FROM -> CALL <<escape`hello`>>
// CALL <<escape`hello`>> -> CALLS -> VARIABLE <<escape>>
// CALL <<escape`hello`>> -> PASSES_ARGUMENT -> LITERAL <<`hello`>>
// FUNCTION <<conditionalTagTemplate>> -> RETURNS -> VARIABLE <<result>>
// @end-annotation
function conditionalTagTemplate(dangerous) {
  const escape = dangerous ? (s) => s[0].toUpperCase() : (s) => s[0];
  const result = escape`hello`;
  return result;
}

// @construct PENDING typeof-undeclared
// @annotation
// UNKNOWN <<module>> -> DECLARES -> FUNCTION <<typeofUndeclared>>
// FUNCTION <<typeofUndeclared>> -> CONTAINS -> VARIABLE <<safe>>
// VARIABLE <<safe>> -> ASSIGNED_FROM -> EXPRESSION <<typeof undeclaredVar>>
// EXPRESSION <<typeof undeclaredVar>> -> READS_FROM -> VARIABLE <<undeclaredVar>>
// EXPRESSION <<typeof undeclaredVar>> -> RESOLVES_TO -> LITERAL <<'undefined'>>
// FUNCTION <<typeofUndeclared>> -> RETURNS -> VARIABLE <<safe>>
// @end-annotation
function typeofUndeclared() {
  const safe = typeof undeclaredVar; // "undefined" — NO ReferenceError
  return safe;
}

// @construct PENDING nullish-coalescing-chain
// @annotation
// FUNCTION <<nullishChain>> -> CONTAINS -> PARAMETER <<a>>
// FUNCTION <<nullishChain>> -> CONTAINS -> PARAMETER <<b>>
// FUNCTION <<nullishChain>> -> CONTAINS -> PARAMETER <<c>>
// FUNCTION <<nullishChain>> -> CONTAINS -> PARAMETER <<defaultValue>>
// FUNCTION <<nullishChain>> -> DECLARES -> VARIABLE <<value>>
// VARIABLE <<value>> -> ASSIGNED_FROM -> EXPRESSION <<a ?? b ?? c ?? defaultValue>>
// EXPRESSION <<a ?? b ?? c ?? defaultValue>> -> READS_FROM -> PARAMETER <<a>>
// EXPRESSION <<a ?? b ?? c ?? defaultValue>> -> READS_FROM -> PARAMETER <<b>>
// EXPRESSION <<a ?? b ?? c ?? defaultValue>> -> READS_FROM -> PARAMETER <<c>>
// EXPRESSION <<a ?? b ?? c ?? defaultValue>> -> READS_FROM -> PARAMETER <<defaultValue>>
// FUNCTION <<nullishChain>> -> RETURNS -> VARIABLE <<value>>
// @end-annotation
function nullishChain(a, b, c, defaultValue) {
  const value = a ?? b ?? c ?? defaultValue;
  return value;
}

// @construct PENDING in-operator-array
// @annotation
// FUNCTION <<inOperatorArray>> -> CONTAINS -> VARIABLE <<hasIndex>>
// FUNCTION <<inOperatorArray>> -> CONTAINS -> VARIABLE <<hasStr>>
// FUNCTION <<inOperatorArray>> -> CONTAINS -> VARIABLE <<noIndex>>
// VARIABLE <<hasIndex>> -> ASSIGNED_FROM -> EXPRESSION <<0 in [1, 2, 3]>>
// EXPRESSION <<0 in [1, 2, 3]>> -> USES -> LITERAL <<0>>
// EXPRESSION <<0 in [1, 2, 3]>> -> USES -> LITERAL <<[1, 2, 3]>>
// LITERAL <<[1, 2, 3]>> -> HAS_ELEMENT -> LITERAL <<1>>
// LITERAL <<[1, 2, 3]>> -> HAS_ELEMENT -> LITERAL <<2>>
// LITERAL <<[1, 2, 3]>> -> HAS_ELEMENT -> LITERAL <<3>>
// VARIABLE <<hasStr>> -> ASSIGNED_FROM -> EXPRESSION <<'0' in [1, 2, 3]>>
// EXPRESSION <<'0' in [1, 2, 3]>> -> USES -> LITERAL <<'0'>>
// EXPRESSION <<'0' in [1, 2, 3]>> -> USES -> LITERAL <<[1, 2, 3]>>
// VARIABLE <<noIndex>> -> ASSIGNED_FROM -> EXPRESSION <<5 in [1, 2, 3]>>
// EXPRESSION <<5 in [1, 2, 3]>> -> USES -> LITERAL <<5>>
// EXPRESSION <<5 in [1, 2, 3]>> -> USES -> LITERAL <<[1, 2, 3]>>
// FUNCTION <<inOperatorArray>> -> RETURNS -> LITERAL <<{...}>>
// LITERAL <<{...}>> -> USES -> VARIABLE <<hasIndex>>
// LITERAL <<{...}>> -> USES -> VARIABLE <<hasStr>>
// LITERAL <<{...}>> -> USES -> VARIABLE <<noIndex>>
// @end-annotation
function inOperatorArray() {
  const hasIndex = 0 in [1, 2, 3];     // true — checks INDEX, not value
  const hasStr = '0' in [1, 2, 3];     // true — coerced to string
  const noIndex = 5 in [1, 2, 3];      // false
  return { hasIndex, hasStr, noIndex };
}

// --- Reflect.construct with newTarget (constructor spoofing) ---

// @construct PENDING reflect-construct-newtarget
// @annotation
// CLASS <<ReflectBase>> -> CONTAINS -> METHOD <<ReflectBase.constructor>>
// PROPERTY_ACCESS <<this.constructedBy>> -> ASSIGNED_FROM -> META_PROPERTY <<new.target.name>>
// METHOD <<ReflectBase.constructor>> -> WRITES_TO -> PROPERTY_ACCESS <<this.constructedBy>>
// METHOD <<ReflectBase.constructor>> -> READS_FROM -> META_PROPERTY <<new.target.name>>
// CLASS <<ReflectDerived>> -> EXTENDS -> CLASS <<ReflectBase>>
// FUNCTION <<reflectConstructDemo>> -> CONTAINS -> VARIABLE <<normal>>
// VARIABLE <<normal>> -> ASSIGNED_FROM -> CALL <<new ReflectDerived()>>
// CALL <<new ReflectDerived()>> -> CALLS -> CLASS <<ReflectDerived>>
// FUNCTION <<reflectConstructDemo>> -> CONTAINS -> VARIABLE <<spoofed>>
// VARIABLE <<spoofed>> -> ASSIGNED_FROM -> CALL <<Reflect.construct(ReflectBase, [], ReflectDerived)>>
// CALL <<Reflect.construct(ReflectBase, [], ReflectDerived)>> -> PASSES_ARGUMENT -> CLASS <<ReflectBase>>
// CALL <<Reflect.construct(ReflectBase, [], ReflectDerived)>> -> PASSES_ARGUMENT -> LITERAL <<[]>>
// CALL <<Reflect.construct(ReflectBase, [], ReflectDerived)>> -> PASSES_ARGUMENT -> CLASS <<ReflectDerived>>
// FUNCTION <<reflectConstructDemo>> -> RETURNS -> LITERAL <<{...}>>
// LITERAL <<{...}>> -> READS_FROM -> VARIABLE <<normal>>
// LITERAL <<{...}>> -> READS_FROM -> VARIABLE <<spoofed>>
// @end-annotation
class ReflectBase {
  constructor() {
    this.constructedBy = new.target.name;
  }
}
class ReflectDerived extends ReflectBase {}

function reflectConstructDemo() {
  const normal = new ReflectDerived();                       // constructedBy: 'ReflectDerived'
  const spoofed = Reflect.construct(ReflectBase, [], ReflectDerived); // constructedBy: 'ReflectDerived' but runs Base constructor
  return { normal, spoofed };
}

// @construct PENDING reflect-construct-factory
// @annotation
// FUNCTION <<createInstance>> -> CONTAINS -> PARAMETER <<Cls>>
// FUNCTION <<createInstance>> -> CONTAINS -> PARAMETER <<args>>
// FUNCTION <<createInstance>> -> RETURNS -> CALL <<Reflect.construct(Cls, args)>>
// CALL <<Reflect.construct(Cls, args)>> -> CALLS -> PROPERTY_ACCESS <<Reflect.construct>>
// CALL <<Reflect.construct(Cls, args)>> -> PASSES_ARGUMENT -> PARAMETER <<Cls>>
// CALL <<Reflect.construct(Cls, args)>> -> PASSES_ARGUMENT -> PARAMETER <<args>>
// PROPERTY_ACCESS <<Reflect.construct>> -> READS_FROM -> EXTERNAL <<Reflect>>
// @end-annotation
function createInstance(Cls, args) {
  return Reflect.construct(Cls, args); // factory pattern — construct without `new`
}

// --- Tagged template returning non-string ---

// @construct PENDING tagged-template-returns-object
// @annotation
// FUNCTION <<sql>> -> HAS_BODY -> PARAMETER <<strings>>
// FUNCTION <<sql>> -> HAS_BODY -> PARAMETER <<values>>
// FUNCTION <<sql>> -> RETURNS -> LITERAL <<{...}>>
// LITERAL <<{...}>> -> HAS_PROPERTY -> LITERAL <<'text'>>
// LITERAL <<{...}>> -> HAS_PROPERTY -> CALL <<strings.join('?')>>
// LITERAL <<{...}>> -> HAS_PROPERTY -> LITERAL <<'params'>>
// LITERAL <<{...}>> -> HAS_PROPERTY -> PARAMETER <<values>>
// CALL <<strings.join('?')>> -> CALLS_ON -> PARAMETER <<strings>>
// CALL <<strings.join('?')>> -> PASSES_ARGUMENT -> LITERAL <<'?'>>
// VARIABLE <<userId>> -> ASSIGNED_FROM -> LITERAL <<42>>
// VARIABLE <<query>> -> ASSIGNED_FROM -> CALL <<sql`SELECT * FROM users WHERE id = ${userId}`>>
// CALL <<sql`SELECT * FROM users WHERE id = ${userId}`>> -> CALLS -> FUNCTION <<sql>>
// CALL <<sql`SELECT * FROM users WHERE id = ${userId}`>> -> PASSES_ARGUMENT -> LITERAL <<'SELECT * FROM users WHERE id = '>>
// CALL <<sql`SELECT * FROM users WHERE id = ${userId}`>> -> PASSES_ARGUMENT -> LITERAL <<''>>
// CALL <<sql`SELECT * FROM users WHERE id = ${userId}`>> -> PASSES_ARGUMENT -> VARIABLE <<userId>>
// @end-annotation
function sql(strings, ...values) {
  return { text: strings.join('?'), params: values }; // returns object, not string!
}
const userId = 42;
const query = sql`SELECT * FROM users WHERE id = ${userId}`;

// @construct PENDING tagged-template-returns-class
// @annotation
// VARIABLE <<styledDiv>> -> ASSIGNED_FROM -> EXPRESSION <<styledDiv:obj>>
// EXPRESSION <<styledDiv:obj>> -> HAS_PROPERTY -> METHOD <<div>>
// METHOD <<div>> -> CONTAINS -> PARAMETER <<strings>>
// METHOD <<div>> -> CONTAINS -> PARAMETER <<exprs>>
// METHOD <<div>> -> RETURNS -> CLASS <<StyledComponent>>
// CLASS <<StyledComponent>> -> CONTAINS -> PROPERTY <<styles>>
// PROPERTY <<styles>> -> ASSIGNED_FROM -> CALL <<strings.join('')>>
// CALL <<strings.join('')>> -> CALLS_ON -> PARAMETER <<strings>>
// CALL <<strings.join('')>> -> PASSES_ARGUMENT -> LITERAL <<''>>
// VARIABLE <<Component>> -> ASSIGNED_FROM -> CALL <<styledDiv.div`color: red; font-size: 14px;`>>
// CALL <<styledDiv.div`color: red; font-size: 14px;`>> -> CALLS -> PROPERTY_ACCESS <<styledDiv.div>>
// CALL <<styledDiv.div`color: red; font-size: 14px;`>> -> PASSES_ARGUMENT -> LITERAL <<`color: red; font-size: 14px;`>>
// PROPERTY_ACCESS <<styledDiv.div>> -> READS_FROM -> VARIABLE <<styledDiv>>
// @end-annotation
const styledDiv = {
  div(strings, ...exprs) {
    return class StyledComponent {
      styles = strings.join('');
    };
  },
};
const Component = styledDiv.div`color: red; font-size: 14px;`;

// @construct PENDING tagged-template-chained
// @annotation
// FUNCTION <<chainTag>> -> HAS_BODY -> PARAMETER <<strings>>
// FUNCTION <<chainTag>> -> RETURNS -> FUNCTION <<chainTag:inner>>
// FUNCTION <<chainTag:inner>> -> HAS_BODY -> PARAMETER <<strings2>>
// FUNCTION <<chainTag:inner>> -> RETURNS -> EXPRESSION <<strings[0] + strings2[0]>>
// EXPRESSION <<strings[0] + strings2[0]>> -> READS_FROM -> PROPERTY_ACCESS <<strings[0]>>
// EXPRESSION <<strings[0] + strings2[0]>> -> READS_FROM -> PROPERTY_ACCESS <<strings2[0]>>
// PROPERTY_ACCESS <<strings[0]>> -> READS_FROM -> PARAMETER <<strings>>
// PROPERTY_ACCESS <<strings2[0]>> -> READS_FROM -> PARAMETER <<strings2>>
// VARIABLE <<chainedResult>> -> ASSIGNED_FROM -> CALL <<chainTag`hello``world`>>
// CALL <<chainTag`hello`>> -> CALLS -> FUNCTION <<chainTag>>
// CALL <<chainTag`hello`>> -> PASSES_ARGUMENT -> LITERAL <<`hello`>>
// CALL <<chainTag`hello``world`>> -> CALLS -> CALL <<chainTag`hello`>>
// CALL <<chainTag`hello``world`>> -> PASSES_ARGUMENT -> LITERAL <<`world`>>
// @end-annotation
function chainTag(strings) {
  return (strings2) => strings[0] + strings2[0];
}
const chainedResult = chainTag`hello``world`;

// @construct PENDING new-with-spread
// @annotation
// FUNCTION <<newWithSpread>> -> CONTAINS -> VARIABLE <<args>>
// VARIABLE <<args>> -> ASSIGNED_FROM -> LITERAL <<[2024, 0, 15]>>
// LITERAL <<[2024, 0, 15]>> -> HAS_ELEMENT -> LITERAL <<2024>>
// LITERAL <<[2024, 0, 15]>> -> HAS_ELEMENT -> LITERAL <<0>>
// LITERAL <<[2024, 0, 15]>> -> HAS_ELEMENT -> LITERAL <<15>>
// FUNCTION <<newWithSpread>> -> CONTAINS -> VARIABLE <<date>>
// VARIABLE <<date>> -> ASSIGNED_FROM -> CALL <<new Date(...args)>>
// CALL <<new Date(...args)>> -> CALLS -> EXTERNAL <<Date>>
// CALL <<new Date(...args)>> -> READS_FROM -> VARIABLE <<args>>
// FUNCTION <<newWithSpread>> -> CONTAINS -> FUNCTION <<instantiate>>
// FUNCTION <<instantiate>> -> CONTAINS -> PARAMETER <<Cls>>
// FUNCTION <<instantiate>> -> CONTAINS -> PARAMETER <<ctorArgs>>
// FUNCTION <<instantiate>> -> RETURNS -> CALL <<new Cls(...ctorArgs)>>
// CALL <<new Cls(...ctorArgs)>> -> CALLS -> PARAMETER <<Cls>>
// CALL <<new Cls(...ctorArgs)>> -> READS_FROM -> PARAMETER <<ctorArgs>>
// FUNCTION <<newWithSpread>> -> RETURNS -> LITERAL <<{...}>>
// LITERAL <<{...}>> -> HAS_PROPERTY -> VARIABLE <<date>>
// LITERAL <<{...}>> -> HAS_PROPERTY -> FUNCTION <<instantiate>>
// @end-annotation
function newWithSpread() {
  const args = [2024, 0, 15];
  const date = new Date(...args);

  function instantiate(Cls, ctorArgs) {
    return new Cls(...ctorArgs);       // dynamic class + spread
  }

  return { date, instantiate };
}

// @construct PENDING assignment-in-condition
// @annotation
// FUNCTION <<assignmentInCondition>> -> CONTAINS -> PARAMETER <<regex>>
// FUNCTION <<assignmentInCondition>> -> CONTAINS -> PARAMETER <<str>>
// FUNCTION <<assignmentInCondition>> -> CONTAINS -> VARIABLE <<matches>>
// VARIABLE <<matches>> -> ASSIGNED_FROM -> LITERAL <<[]>>
// FUNCTION <<assignmentInCondition>> -> CONTAINS -> VARIABLE <<match>>
// FUNCTION <<assignmentInCondition>> -> CONTAINS -> LOOP <<while>>
// LOOP <<while>> -> HAS_CONDITION -> EXPRESSION <<match = regex.exec(str)>>
// EXPRESSION <<match = regex.exec(str)>> -> WRITES_TO -> VARIABLE <<match>>
// EXPRESSION <<match = regex.exec(str)>> -> READS_FROM -> CALL <<regex.exec(str)>>
// CALL <<regex.exec(str)>> -> CALLS -> PROPERTY_ACCESS <<regex.exec>>
// PROPERTY_ACCESS <<regex.exec>> -> READS_FROM -> PARAMETER <<regex>>
// CALL <<regex.exec(str)>> -> PASSES_ARGUMENT -> PARAMETER <<str>>
// LOOP <<while>> -> HAS_BODY -> CALL <<matches.push(match[0])>>
// CALL <<matches.push(match[0])>> -> CALLS -> PROPERTY_ACCESS <<matches.push>>
// PROPERTY_ACCESS <<matches.push>> -> READS_FROM -> VARIABLE <<matches>>
// CALL <<matches.push(match[0])>> -> PASSES_ARGUMENT -> EXPRESSION <<match[0]>>
// EXPRESSION <<match[0]>> -> READS_FROM -> VARIABLE <<match>>
// EXPRESSION <<match[0]>> -> READS_FROM -> LITERAL <<0>>
// FUNCTION <<assignmentInCondition>> -> RETURNS -> VARIABLE <<matches>>
// @end-annotation
function assignmentInCondition(regex, str) {
  const matches = [];
  let match;
  while (match = regex.exec(str)) {   // assignment AS condition (no explicit comparison)
    matches.push(match[0]);
  }
  return matches;
}

// @construct PENDING assignment-in-if
// @annotation
// FUNCTION <<assignmentInIf>> -> CONTAINS -> PARAMETER <<compute>>
// FUNCTION <<assignmentInIf>> -> CONTAINS -> VARIABLE <<result>>
// FUNCTION <<assignmentInIf>> -> CONTAINS -> BRANCH <<if-assignment>>
// BRANCH <<if-assignment>> -> HAS_CONDITION -> EXPRESSION <<result = compute()>>
// EXPRESSION <<result = compute()>> -> WRITES_TO -> VARIABLE <<result>>
// EXPRESSION <<result = compute()>> -> ASSIGNED_FROM -> CALL <<compute()>>
// CALL <<compute()>> -> CALLS -> PARAMETER <<compute>>
// BRANCH <<if-assignment>> -> HAS_CONSEQUENT -> VARIABLE <<result>>
// FUNCTION <<assignmentInIf>> -> RETURNS -> VARIABLE <<result>>
// FUNCTION <<assignmentInIf>> -> RETURNS -> LITERAL <<null>>
// @end-annotation
function assignmentInIf(compute) {
  let result;
  if (result = compute()) {            // assignment + truthiness check
    return result;
  }
  return null;
}

// @construct PENDING deep-optional-chain
// @annotation
// FUNCTION <<deepOptionalChain>> -> CONTAINS -> PARAMETER <<response>>
// FUNCTION <<deepOptionalChain>> -> CONTAINS -> VARIABLE <<value>>
// FUNCTION <<deepOptionalChain>> -> CONTAINS -> VARIABLE <<nested>>
// VARIABLE <<value>> -> ASSIGNED_FROM -> EXPRESSION <<response?.data?.items?.[0]?.getName?.()>>
// EXPRESSION <<response?.data?.items?.[0]?.getName?.()>> -> CHAINS_FROM -> PROPERTY_ACCESS <<response?.data>>
// PROPERTY_ACCESS <<response?.data>> -> READS_FROM -> PARAMETER <<response>>
// PROPERTY_ACCESS <<data?.items>> -> CHAINS_FROM -> PROPERTY_ACCESS <<response?.data>>
// PROPERTY_ACCESS <<items?.[0]>> -> CHAINS_FROM -> PROPERTY_ACCESS <<data?.items>>
// PROPERTY_ACCESS <<[0]?.getName>> -> CHAINS_FROM -> PROPERTY_ACCESS <<items?.[0]>>
// CALL <<getName?.()>> -> CHAINS_FROM -> PROPERTY_ACCESS <<[0]?.getName>>
// VARIABLE <<nested>> -> ASSIGNED_FROM -> EXPRESSION <<response?.config?.headers?.['Content-Type']?.split?.('/')>>
// EXPRESSION <<response?.config?.headers?.['Content-Type']?.split?.('/')>> -> CHAINS_FROM -> PROPERTY_ACCESS <<response?.config>>
// PROPERTY_ACCESS <<response?.config>> -> READS_FROM -> PARAMETER <<response>>
// PROPERTY_ACCESS <<config?.headers>> -> CHAINS_FROM -> PROPERTY_ACCESS <<response?.config>>
// PROPERTY_ACCESS <<headers?.['Content-Type']>> -> CHAINS_FROM -> PROPERTY_ACCESS <<config?.headers>>
// PROPERTY_ACCESS <<['Content-Type']?.split>> -> CHAINS_FROM -> PROPERTY_ACCESS <<headers?.['Content-Type']>>
// CALL <<split?.('/')>> -> CHAINS_FROM -> PROPERTY_ACCESS <<['Content-Type']?.split>>
// CALL <<split?.('/')>> -> PASSES_ARGUMENT -> LITERAL <<'/'>>
// FUNCTION <<deepOptionalChain>> -> RETURNS -> LITERAL <<{...}>>
// LITERAL <<{...}>> -> READS_FROM -> VARIABLE <<value>>
// LITERAL <<{...}>> -> READS_FROM -> VARIABLE <<nested>>
// @end-annotation
function deepOptionalChain(response) {
  const value = response?.data?.items?.[0]?.getName?.();
  const nested = response?.config?.headers?.['Content-Type']?.split?.('/');
  return { value, nested };
}

// @construct PENDING short-circuit-guard-call
// @annotation
// FUNCTION <<shortCircuitGuard>> -> CONTAINS -> PARAMETER <<callback>>
// FUNCTION <<shortCircuitGuard>> -> CONTAINS -> PARAMETER <<data>>
// FUNCTION <<shortCircuitGuard>> -> CONTAINS -> EXPRESSION <<callback && callback(data)>>
// EXPRESSION <<callback && callback(data)>> -> READS_FROM -> PARAMETER <<callback>>
// EXPRESSION <<callback && callback(data)>> -> CONTAINS -> CALL <<callback(data)>>
// CALL <<callback(data)>> -> CALLS -> PARAMETER <<callback>>
// CALL <<callback(data)>> -> PASSES_ARGUMENT -> PARAMETER <<data>>
// FUNCTION <<shortCircuitGuard>> -> DECLARES -> VARIABLE <<result>>
// VARIABLE <<result>> -> ASSIGNED_FROM -> CALL <<callback?.(data)>>
// CALL <<callback?.(data)>> -> CALLS -> PARAMETER <<callback>>
// CALL <<callback?.(data)>> -> PASSES_ARGUMENT -> PARAMETER <<data>>
// FUNCTION <<shortCircuitGuard>> -> RETURNS -> VARIABLE <<result>>
// @end-annotation
function shortCircuitGuard(callback, data) {
  callback && callback(data);           // guard + call
  const result = callback?.(data);      // optional call equivalent
  return result;
}

// @construct PENDING getter-returns-function
// @annotation
// FUNCTION <<getterReturnsFunction>> -> CONTAINS -> VARIABLE <<obj>>
// VARIABLE <<obj>> -> ASSIGNED_FROM -> EXPRESSION <<obj-literal>>
// EXPRESSION <<obj-literal>> -> HAS_PROPERTY -> GETTER <<handler-getter>>
// GETTER <<handler-getter>> -> RETURNS -> FUNCTION <<arrow-fn>>
// FUNCTION <<arrow-fn>> -> CONTAINS -> PARAMETER <<x>>
// FUNCTION <<arrow-fn>> -> RETURNS -> EXPRESSION <<x * 2>>
// EXPRESSION <<x * 2>> -> READS_FROM -> PARAMETER <<x>>
// EXPRESSION <<x * 2>> -> READS_FROM -> LITERAL <<2>>
// FUNCTION <<getterReturnsFunction>> -> CONTAINS -> VARIABLE <<result>>
// VARIABLE <<result>> -> ASSIGNED_FROM -> CALL <<obj.handler(21)>>
// CALL <<obj.handler(21)>> -> CALLS -> PROPERTY_ACCESS <<obj.handler>>
// PROPERTY_ACCESS <<obj.handler>> -> READS_FROM -> VARIABLE <<obj>>
// CALL <<obj.handler(21)>> -> PASSES_ARGUMENT -> LITERAL <<21>>
// FUNCTION <<getterReturnsFunction>> -> RETURNS -> VARIABLE <<result>>
// @end-annotation
function getterReturnsFunction() {
  const obj = {
    get handler() {
      return (x) => x * 2;             // getter returns a function
    },
  };
  const result = obj.handler(21);       // getter call + returned function call
  return result; // 42
}

// @construct PENDING await-comma-expression
// @annotation
// FUNCTION <<awaitCommaExpression>> -> CONTAINS -> PARAMETER <<sideEffect>>
// FUNCTION <<awaitCommaExpression>> -> CONTAINS -> PARAMETER <<fetchData>>
// FUNCTION <<awaitCommaExpression>> -> CONTAINS -> VARIABLE <<result>>
// VARIABLE <<result>> -> ASSIGNED_FROM -> EXPRESSION <<await (sideEffect(), fetchData())>>
// EXPRESSION <<await (sideEffect(), fetchData())>> -> AWAITS -> EXPRESSION <<(sideEffect(), fetchData())>>
// EXPRESSION <<(sideEffect(), fetchData())>> -> CONTAINS -> CALL <<sideEffect()>>
// EXPRESSION <<(sideEffect(), fetchData())>> -> CONTAINS -> CALL <<fetchData()>>
// CALL <<sideEffect()>> -> CALLS -> PARAMETER <<sideEffect>>
// CALL <<fetchData()>> -> CALLS -> PARAMETER <<fetchData>>
// FUNCTION <<awaitCommaExpression>> -> RETURNS -> VARIABLE <<result>>
// @end-annotation
async function awaitCommaExpression(sideEffect, fetchData) {
  const result = await (sideEffect(), fetchData());
  // sideEffect() runs sync, fetchData() is awaited
  return result;
}

// @construct PENDING async-arrow-returns-object
// @annotation
// VARIABLE <<asyncArrowObject>> -> ASSIGNED_FROM -> FUNCTION <<asyncArrowObject:fn>>
// FUNCTION <<asyncArrowObject:fn>> -> CONTAINS -> PARAMETER <<data>>
// FUNCTION <<asyncArrowObject:fn>> -> CONTAINS -> PARAMETER <<processFn>>
// FUNCTION <<asyncArrowObject:fn>> -> RETURNS -> LITERAL <<{...}>>
// LITERAL <<{...}>> -> HAS_PROPERTY -> PROPERTY_ACCESS <<data.id>>
// LITERAL <<{...}>> -> HAS_PROPERTY -> EXPRESSION <<await processFn(data)>>
// LITERAL <<{...}>> -> HAS_PROPERTY -> CALL <<Date.now()>>
// PROPERTY_ACCESS <<data.id>> -> READS_FROM -> PARAMETER <<data>>
// EXPRESSION <<await processFn(data)>> -> AWAITS -> CALL <<processFn(data)>>
// CALL <<processFn(data)>> -> CALLS -> PARAMETER <<processFn>>
// CALL <<processFn(data)>> -> PASSES_ARGUMENT -> PARAMETER <<data>>
// CALL <<Date.now()>> -> CALLS -> PROPERTY_ACCESS <<Date.now>>
// @end-annotation
const asyncArrowObject = async (data, processFn) => ({
  id: data.id,
  result: await processFn(data),
  timestamp: Date.now(),
});
// Without parens: async (data) => { id: data.id } — parsed as block + label!

// @construct PENDING tag-on-call-result
// @annotation
// FUNCTION <<tagOnCallResult>> -> CONTAINS -> FUNCTION <<getFormatter>>
// FUNCTION <<getFormatter>> -> RECEIVES_ARGUMENT -> PARAMETER <<type>>
// FUNCTION <<getFormatter>> -> RETURNS -> FUNCTION <<getFormatter:arrow>>
// FUNCTION <<getFormatter:arrow>> -> RECEIVES_ARGUMENT -> PARAMETER <<strings>>
// FUNCTION <<getFormatter:arrow>> -> RECEIVES_ARGUMENT -> PARAMETER <<...values>>
// FUNCTION <<getFormatter:arrow>> -> RETURNS -> LITERAL <<{...}>>
// LITERAL <<{...}>> -> READS_FROM -> PARAMETER <<type>>
// LITERAL <<{...}>> -> READS_FROM -> PARAMETER <<strings>>
// LITERAL <<{...}>> -> READS_FROM -> PARAMETER <<...values>>
// FUNCTION <<tagOnCallResult>> -> CONTAINS -> VARIABLE <<result>>
// VARIABLE <<result>> -> ASSIGNED_FROM -> CALL <<tagged_template_call>>
// CALL <<getFormatter('sql')>> -> CALLS -> FUNCTION <<getFormatter>>
// CALL <<getFormatter('sql')>> -> PASSES_ARGUMENT -> LITERAL <<'sql'>>
// CALL <<tagged_template_call>> -> CALLS -> CALL <<getFormatter('sql')>>
// CALL <<tagged_template_call>> -> PASSES_ARGUMENT -> EXPRESSION <<`SELECT * FROM ${'users'}`>>
// EXPRESSION <<`SELECT * FROM ${'users'}`>> -> CONTAINS -> LITERAL <<'users'>>
// FUNCTION <<tagOnCallResult>> -> RETURNS -> VARIABLE <<result>>
// @end-annotation
function tagOnCallResult() {
  function getFormatter(type) {
    return (strings, ...values) => ({ type, parts: strings, values });
  }
  const result = getFormatter('sql')`SELECT * FROM ${'users'}`;
  return result;
}

// @construct PENDING optional-chaining-syntax-errors
// @annotation
// UNKNOWN <<module>> -> CONTAINS -> EXPRESSION <<obj?.prop = value>>
// UNKNOWN <<module>> -> CONTAINS -> EXPRESSION <<obj?.['key'] = value>>
// UNKNOWN <<module>> -> CONTAINS -> EXPRESSION <<arr?.[0] = value>>
// UNKNOWN <<module>> -> CONTAINS -> EXPRESSION <<super?.method()>>
// UNKNOWN <<module>> -> CONTAINS -> EXPRESSION <<obj?.tag`template`>>
// @end-annotation
// SyntaxError cases — cannot appear in valid AST:
// obj?.prop = value;    // cannot assign through ?.
// obj?.['key'] = value; // cannot assign through ?.
// arr?.[0] = value;     // cannot assign through ?.
// super?.method();      // super doesn't support optional chaining
// obj?.tag`template`;   // tagged templates don't support optional chaining

// @construct PENDING nullish-logical-mixing-error
// SyntaxError — cannot mix ?? with || or && without explicit parentheses:
// a ?? b || c;    // SyntaxError
// a || b ?? c;    // SyntaxError
// a ?? b && c;    // SyntaxError
// Must use: (a ?? b) || c  or  a ?? (b || c)

// @construct PENDING assignment-as-subexpression
function assignmentAsSubexpression() {
  let a, b, c, idx;

  // Assignment inside array literal — creates variables as side effect
  const arr = [a = 1, b = 2, c = a + b];

  // Assignment as function argument — mutates AND passes value
  function identity(x) { return x; }
  const result = identity(idx = 10);

  // Assignment as computed property key
  const obj = { [idx = 20]: 'value' };

  // Assignment inside template interpolation
  const msg = `index is ${idx = 30}`;

  return { arr, result, obj, msg, a, b, c, idx };
}

// @construct PENDING typeof-computed-dispatch
// @annotation
// @end-annotation
function typeofComputedDispatch(val) {
  const handlers = {
    string(v) { return v.trim(); },
    number(v) { return v.toFixed(2); },
    boolean(v) { return v ? 'yes' : 'no'; },
    object(v) { return v === null ? 'null' : JSON.stringify(v); },
  };
  // typeof result as computed property key — finite key set
  return handlers[typeof val]?.(val);
}

// @construct PENDING void-as-undefined
// @annotation
// FUNCTION <<voidAsUndefined>> -> CONTAINS -> PARAMETER <<val>>
// FUNCTION <<voidAsUndefined>> -> DECLARES -> VARIABLE <<isUndef>>
// VARIABLE <<isUndef>> -> ASSIGNED_FROM -> EXPRESSION <<val === void 0>>
// EXPRESSION <<val === void 0>> -> READS_FROM -> PARAMETER <<val>>
// EXPRESSION <<val === void 0>> -> READS_FROM -> EXPRESSION <<void 0>>
// EXPRESSION <<void 0>> -> READS_FROM -> LITERAL <<0>>
// FUNCTION <<voidAsUndefined>> -> DECLARES -> VARIABLE <<sideEffectRan>>
// VARIABLE <<sideEffectRan>> -> ASSIGNED_FROM -> LITERAL <<false>>
// EXPRESSION <<void (sideEffectRan = true)>> -> READS_FROM -> EXPRESSION <<sideEffectRan = true>>
// EXPRESSION <<sideEffectRan = true>> -> WRITES_TO -> VARIABLE <<sideEffectRan>>
// EXPRESSION <<sideEffectRan = true>> -> READS_FROM -> LITERAL <<true>>
// FUNCTION <<voidAsUndefined>> -> DECLARES -> VARIABLE <<result>>
// VARIABLE <<result>> -> ASSIGNED_FROM -> EXPRESSION <<val !== void 0 ? val : 'fallback'>>
// EXPRESSION <<val !== void 0 ? val : 'fallback'>> -> HAS_CONDITION -> EXPRESSION <<val !== void 0>>
// EXPRESSION <<val !== void 0>> -> READS_FROM -> PARAMETER <<val>>
// EXPRESSION <<val !== void 0>> -> READS_FROM -> EXPRESSION <<void 0 (ternary)>>
// EXPRESSION <<void 0 (ternary)>> -> READS_FROM -> LITERAL <<0 (ternary)>>
// EXPRESSION <<val !== void 0 ? val : 'fallback'>> -> HAS_CONSEQUENT -> PARAMETER <<val>>
// EXPRESSION <<val !== void 0 ? val : 'fallback'>> -> HAS_ALTERNATE -> LITERAL <<'fallback'>>
// FUNCTION <<voidAsUndefined>> -> RETURNS -> LITERAL <<{...}>>
// LITERAL <<{...}>> -> READS_FROM -> VARIABLE <<isUndef>>
// LITERAL <<{...}>> -> READS_FROM -> VARIABLE <<sideEffectRan>>
// LITERAL <<{...}>> -> READS_FROM -> VARIABLE <<result>>
// @end-annotation
function voidAsUndefined(val) {
  // void 0 is shorter than undefined and immune to shadowing
  const isUndef = val === void 0;

  // void with side effect — expression runs, result discarded
  let sideEffectRan = false;
  void (sideEffectRan = true);

  // void in ternary — explicit undefined branch
  const result = val !== void 0 ? val : 'fallback';

  return { isUndef, sideEffectRan, result };
}

// @construct PENDING chain-on-anonymous-expression
// @annotation
// @end-annotation
function chainOnAnonymousExpression() {
  // Property access on function return (no intermediate variable)
  function getUser() { return { name: 'Alice', age: 30 }; }
  const name = getUser().name;

  // Method chain on new expression
  const first = new Map([['a', 1], ['b', 2]]).get('a');

  // Chain on array expression
  const sorted = [3, 1, 2].sort((a, b) => a - b)[0];

  // Chain on IIFE result
  const prop = (function() { return { x: 42 }; })().x;

  // Method chain on literal
  const initials = 'hello world'.split(' ').map(s => s[0]).join('');

  return { name, first, sorted, prop, initials };
}

// @construct PENDING chained-destructuring-assignment
// @annotation
// @end-annotation
function chainedDestructuringAssignment() {
  let a, b, c, d;

  // Chained destructuring — right-to-left evaluation
  [a, b] = [c, d] = [1, 2];
  // Step 1: [c, d] = [1, 2] → c=1, d=2, returns [1, 2]
  // Step 2: [a, b] = [1, 2] → a=1, b=2

  // Object chained destructuring
  let x, y;
  ({x} = {y} = {x: 10, y: 20});

  return { a, b, c, d, x, y };
}

// @construct PENDING arrow-return-assignment
// @annotation
// FUNCTION <<arrowReturnAssignment>> -> CONTAINS -> VARIABLE <<cache>>
// VARIABLE <<cache>> -> ASSIGNED_FROM -> LITERAL <<null>>
// FUNCTION <<arrowReturnAssignment>> -> CONTAINS -> VARIABLE <<setCache>>
// VARIABLE <<setCache>> -> ASSIGNED_FROM -> FUNCTION <<setCache:fn>>
// FUNCTION <<setCache:fn>> -> CONTAINS -> PARAMETER <<val>>
// FUNCTION <<setCache:fn>> -> RETURNS -> EXPRESSION <<cache = val>>
// EXPRESSION <<cache = val>> -> WRITES_TO -> VARIABLE <<cache>>
// EXPRESSION <<cache = val>> -> READS_FROM -> PARAMETER <<val>>
// FUNCTION <<arrowReturnAssignment>> -> CONTAINS -> CALL <<setCache(42)>>
// CALL <<setCache(42)>> -> CALLS -> VARIABLE <<setCache>>
// CALL <<setCache(42)>> -> PASSES_ARGUMENT -> LITERAL <<42>>
// FUNCTION <<arrowReturnAssignment>> -> CONTAINS -> VARIABLE <<first>>
// FUNCTION <<arrowReturnAssignment>> -> CONTAINS -> VARIABLE <<second>>
// FUNCTION <<arrowReturnAssignment>> -> CONTAINS -> VARIABLE <<swap>>
// VARIABLE <<swap>> -> ASSIGNED_FROM -> FUNCTION <<swap:fn>>
// FUNCTION <<swap:fn>> -> RETURNS -> EXPRESSION <<[first, second] = [second, first]>>
// EXPRESSION <<[first, second] = [second, first]>> -> WRITES_TO -> VARIABLE <<first>>
// EXPRESSION <<[first, second] = [second, first]>> -> WRITES_TO -> VARIABLE <<second>>
// EXPRESSION <<[first, second] = [second, first]>> -> READS_FROM -> EXPRESSION <<[second, first]>>
// EXPRESSION <<[second, first]>> -> READS_FROM -> VARIABLE <<second>>
// EXPRESSION <<[second, first]>> -> READS_FROM -> VARIABLE <<first>>
// FUNCTION <<arrowReturnAssignment>> -> RETURNS -> LITERAL <<{...}>>
// LITERAL <<{...}>> -> READS_FROM -> VARIABLE <<cache>>
// LITERAL <<{...}>> -> READS_FROM -> VARIABLE <<setCache>>
// LITERAL <<{...}>> -> READS_FROM -> VARIABLE <<swap>>
// @end-annotation
function arrowReturnAssignment() {
  let cache = null;

  // Arrow returning assignment — parenthesized to make it expression body
  const setCache = (val) => (cache = val);
  setCache(42);

  // With destructuring assignment in arrow
  let first, second;
  const swap = () => ([first, second] = [second, first]);

  return { cache, setCache, swap };
}

// @construct PENDING operator-toprimitive-dispatch
// @annotation
// @end-annotation
class Money {
  constructor(amount, currency) {
    this.amount = amount;
    this.currency = currency;
  }

  [Symbol.toPrimitive](hint) {
    if (hint === 'number') return this.amount;
    if (hint === 'string') return `${this.amount} ${this.currency}`;
    return this.amount; // 'default' hint
  }

  valueOf() {
    return this.amount;
  }
}

function operatorCoercionDemo() {
  const price = new Money(10, 'USD');
  const tax   = new Money(1.5, 'USD');

  // Each operator implicitly calls Symbol.toPrimitive / valueOf on the operands.
  // These are hidden CALLS edges from the operator expression to the method.
  const total      = price + tax;         // toPrimitive('default') → 10 + 1.5
  const isExpensive = price > 100;        // toPrimitive('number')  → 10 > 100
  const display    = `${price}`;          // toPrimitive('string')  → "10 USD"
  const doubled    = price * 2;           // toPrimitive('number')  → 10 * 2

  return { total, isExpensive, display, doubled };
}

// @construct PENDING export-named-list
export {
  arithmeticOperators,
  comparisonOperators,
  logicalOperators,
  bitwiseOperators,
  unaryOperators,
  deleteOperator,
  updateExpressions,
  assignmentOperators,
  ternaryOperator,
  optionalChaining,
  templateLiterals,
  tag,
  tagged,
  constructorCalls,
  callExpressions,
  typeCheckOperators,
  commaOperator,
  groupingOperator,
  proxyAndReflect,
  chainedAssignment,
  chainedAssignmentMixed,
  shortCircuitSideEffects,
  rawTemplate,
  rawResult,
  html,
  sanitized,
  commaInReturn,
  commaArrow,
  logicalAssignProperty,
  conditionalMethodCall,
  commaSubscript,
  commaInWhile,
  NonThisConstructor,
  nonThisInstance,
  newPrecedence,
  newMemberExpression,
  conditionalTagTemplate,
  typeofUndeclared,
  nullishChain,
  inOperatorArray,
  ReflectBase,
  ReflectDerived,
  reflectConstructDemo,
  createInstance,
  sql,
  query,
  styledDiv,
  Component,
  chainTag,
  chainedResult,
  newWithSpread,
  assignmentInCondition,
  assignmentInIf,
  deepOptionalChain,
  shortCircuitGuard,
  getterReturnsFunction,
  awaitCommaExpression,
  asyncArrowObject,
  tagOnCallResult,
  assignmentAsSubexpression,
  typeofComputedDispatch,
  voidAsUndefined,
  chainOnAnonymousExpression,
  chainedDestructuringAssignment,
  arrowReturnAssignment,
  Money,
  operatorCoercionDemo,
};
