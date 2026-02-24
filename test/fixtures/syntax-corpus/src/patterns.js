// =============================================================================
// patterns.js — Destructuring, Spread, Computed Properties, Shorthands
// =============================================================================

// @construct PENDING obj-destructuring-simple
// @annotation
// @end-annotation
function objectDestructuringSimple() {
  const person = { name: 'Alice', age: 30, city: 'NYC', country: 'US' };

  const { name, age } = person;
  const { name: fullName, age: years } = person;
  const { role = 'user', city: c = 'unknown' } = person;
  const { country, ...remaining } = person;

  return { name, fullName, years, role, remaining };
}

// @construct PENDING obj-destructuring-nested
// @annotation
// FUNCTION <<objectDestructuringNested>> -> CONTAINS -> VARIABLE <<data>>
// VARIABLE <<data>> -> ASSIGNED_FROM -> LITERAL <<{ outer: { inner: { deep: 42 } } }>>
// LITERAL <<{ outer: { inner: { deep: 42 } } }>> -> HAS_PROPERTY -> LITERAL <<42>>
// FUNCTION <<objectDestructuringNested>> -> CONTAINS -> EXPRESSION <<{ outer: { inner: { deep } } }>>
// EXPRESSION <<{ outer: { inner: { deep } } }>> -> READS_FROM -> VARIABLE <<data>>
// EXPRESSION <<{ outer: { inner: { deep } } }>> -> ASSIGNED_FROM -> VARIABLE <<deep>>
// FUNCTION <<objectDestructuringNested>> -> RETURNS -> VARIABLE <<deep>>
// @end-annotation
function objectDestructuringNested() {
  const data = { outer: { inner: { deep: 42 } } };
  const { outer: { inner: { deep } } } = data;
  return deep;
}

// @construct PENDING array-destructuring-simple
// @annotation
// @end-annotation
function arrayDestructuringSimple() {
  const coords = [10, 20, 30, 40, 50];

  const [x, y] = coords;
  const [first, , third] = coords;
  const [head, ...tail] = coords;
  const [a = 0, b = 0, c = 0] = [1, 2];

  return { x, y, first, third, head, tail, a, b, c };
}

// @construct PENDING array-destructuring-nested
// @annotation
// @end-annotation
function arrayDestructuringNested() {
  const matrix = [[1, 2], [3, 4]];
  const [[a1, a2], [b1, b2]] = matrix;
  return { a1, a2, b1, b2 };
}

// @construct PENDING array-destructuring-swap
// @annotation
// FUNCTION <<arrayDestructuringSwap>> -> CONTAINS -> VARIABLE <<left>>
// FUNCTION <<arrayDestructuringSwap>> -> CONTAINS -> VARIABLE <<right>>
// VARIABLE <<left>> -> ASSIGNED_FROM -> LITERAL <<'left'>>
// VARIABLE <<right>> -> ASSIGNED_FROM -> LITERAL <<'right'>>
// EXPRESSION <<[left, right]>> -> ASSIGNED_FROM -> EXPRESSION <<[right, left]>>
// EXPRESSION <<[left, right]>> -> WRITES_TO -> VARIABLE <<left>>
// EXPRESSION <<[left, right]>> -> WRITES_TO -> VARIABLE <<right>>
// EXPRESSION <<[right, left]>> -> READS_FROM -> VARIABLE <<right>>
// EXPRESSION <<[right, left]>> -> READS_FROM -> VARIABLE <<left>>
// FUNCTION <<arrayDestructuringSwap>> -> RETURNS -> EXPRESSION <<{ left, right }>>
// EXPRESSION <<{ left, right }>> -> READS_FROM -> VARIABLE <<left>>
// EXPRESSION <<{ left, right }>> -> READS_FROM -> VARIABLE <<right>>
// @end-annotation
function arrayDestructuringSwap() {
  let left = 'left';
  let right = 'right';
  [left, right] = [right, left];
  return { left, right };
}

// @construct PENDING param-destructuring-object
// @annotation
// FUNCTION <<withObjectParam>> -> CONTAINS -> PARAMETER <<destructured-param>>
// PARAMETER <<destructured-param>> -> ASSIGNED_FROM -> VARIABLE <<name>>
// PARAMETER <<destructured-param>> -> ASSIGNED_FROM -> VARIABLE <<age>>
// PARAMETER <<destructured-param>> -> ASSIGNED_FROM -> VARIABLE <<role>>
// VARIABLE <<role>> -> DEFAULTS_TO -> LITERAL <<'guest'>>
// FUNCTION <<withObjectParam>> -> RETURNS -> EXPRESSION <<template-literal>>
// EXPRESSION <<template-literal>> -> READS_FROM -> VARIABLE <<name>>
// EXPRESSION <<template-literal>> -> READS_FROM -> VARIABLE <<age>>
// EXPRESSION <<template-literal>> -> READS_FROM -> VARIABLE <<role>>
// @end-annotation
function withObjectParam({ name, age, role = 'guest' }) {
  return `${name} (${age}) - ${role}`;
}

// @construct PENDING param-destructuring-array
// @annotation
// FUNCTION <<withNestedParam>> -> CONTAINS -> PARAMETER <<destructured-param>>
// PARAMETER <<destructured-param>> -> ASSIGNED_FROM -> VARIABLE <<name>>
// PARAMETER <<destructured-param>> -> ASSIGNED_FROM -> VARIABLE <<theme>>
// VARIABLE <<theme>> -> DEFAULTS_TO -> LITERAL <<'light'>>
// FUNCTION <<withNestedParam>> -> RETURNS -> EXPRESSION <<{ name, theme }>>
// EXPRESSION <<{ name, theme }>> -> READS_FROM -> VARIABLE <<name>>
// EXPRESSION <<{ name, theme }>> -> READS_FROM -> VARIABLE <<theme>>
// @end-annotation
function withArrayParam([first, second, ...rest]) {
  return { first, second, rest };
}

// @construct PENDING param-destructuring-nested
// @annotation
// FUNCTION <<spreadInArrays>> -> CONTAINS -> VARIABLE <<source>>
// FUNCTION <<spreadInArrays>> -> CONTAINS -> VARIABLE <<extended>>
// FUNCTION <<spreadInArrays>> -> CONTAINS -> VARIABLE <<clone>>
// VARIABLE <<source>> -> ASSIGNED_FROM -> LITERAL <<[1, 2, 3]>>
// LITERAL <<[1, 2, 3]>> -> HAS_ELEMENT -> LITERAL <<1>>
// LITERAL <<[1, 2, 3]>> -> HAS_ELEMENT -> LITERAL <<2>>
// LITERAL <<[1, 2, 3]>> -> HAS_ELEMENT -> LITERAL <<3>>
// VARIABLE <<extended>> -> ASSIGNED_FROM -> LITERAL <<[0, ...source, 4, 5]>>
// LITERAL <<[0, ...source, 4, 5]>> -> HAS_ELEMENT -> LITERAL <<0>>
// LITERAL <<[0, ...source, 4, 5]>> -> HAS_ELEMENT -> EXPRESSION <<...source>>
// LITERAL <<[0, ...source, 4, 5]>> -> HAS_ELEMENT -> LITERAL <<4>>
// LITERAL <<[0, ...source, 4, 5]>> -> HAS_ELEMENT -> LITERAL <<5>>
// EXPRESSION <<...source>> -> SPREADS_FROM -> VARIABLE <<source>>
// VARIABLE <<clone>> -> ASSIGNED_FROM -> LITERAL <<[...source]>>
// LITERAL <<[...source]>> -> HAS_ELEMENT -> EXPRESSION <<...source:clone>>
// EXPRESSION <<...source:clone>> -> SPREADS_FROM -> VARIABLE <<source>>
// FUNCTION <<spreadInArrays>> -> RETURNS -> LITERAL <<{ extended, clone }>>
// LITERAL <<{ extended, clone }>> -> HAS_PROPERTY -> VARIABLE <<extended>>
// LITERAL <<{ extended, clone }>> -> HAS_PROPERTY -> VARIABLE <<clone>>
// @end-annotation
function withNestedParam({ user: { name }, settings: { theme = 'light' } }) {
  return { name, theme };
}

// @construct PENDING spread-arrays
function spreadInArrays() {
  const source = [1, 2, 3];
  const extended = [0, ...source, 4, 5];
  const clone = [...source];
  return { extended, clone };
}

// @construct PENDING spread-objects
// @annotation
// FUNCTION <<spreadInObjects>> -> CONTAINS -> VARIABLE <<base>>
// FUNCTION <<spreadInObjects>> -> CONTAINS -> VARIABLE <<extended>>
// FUNCTION <<spreadInObjects>> -> CONTAINS -> VARIABLE <<clone>>
// VARIABLE <<base>> -> ASSIGNED_FROM -> LITERAL <<{ a: 1, b: 2 }>>
// LITERAL <<{ a: 1, b: 2 }>> -> HAS_PROPERTY -> LITERAL <<1>>
// LITERAL <<{ a: 1, b: 2 }>> -> HAS_PROPERTY -> LITERAL <<2>>
// VARIABLE <<extended>> -> ASSIGNED_FROM -> EXPRESSION <<{ ...base, c: 3, b: 'overridden' }>>
// EXPRESSION <<{ ...base, c: 3, b: 'overridden' }>> -> SPREADS_FROM -> VARIABLE <<base>>
// EXPRESSION <<{ ...base, c: 3, b: 'overridden' }>> -> HAS_PROPERTY -> LITERAL <<3>>
// EXPRESSION <<{ ...base, c: 3, b: 'overridden' }>> -> HAS_PROPERTY -> LITERAL <<'overridden'>>
// VARIABLE <<clone>> -> ASSIGNED_FROM -> EXPRESSION <<{ ...base }>>
// EXPRESSION <<{ ...base }>> -> SPREADS_FROM -> VARIABLE <<base>>
// FUNCTION <<spreadInObjects>> -> RETURNS -> EXPRESSION <<{ extended, clone }>>
// EXPRESSION <<{ extended, clone }>> -> READS_FROM -> VARIABLE <<extended>>
// EXPRESSION <<{ extended, clone }>> -> READS_FROM -> VARIABLE <<clone>>
// @end-annotation
function spreadInObjects() {
  const base = { a: 1, b: 2 };
  const extended = { ...base, c: 3, b: 'overridden' };
  const clone = { ...base };
  return { extended, clone };
}

// @construct PENDING spread-calls
// @annotation
// FUNCTION <<spreadInCalls>> -> CONTAINS -> VARIABLE <<args>>
// FUNCTION <<spreadInCalls>> -> CONTAINS -> VARIABLE <<max>>
// VARIABLE <<args>> -> ASSIGNED_FROM -> LITERAL <<[1, 2, 3]>>
// VARIABLE <<max>> -> ASSIGNED_FROM -> CALL <<Math.max(...args)>>
// CALL <<Math.max(...args)>> -> CALLS -> PROPERTY_ACCESS <<Math.max>>
// CALL <<Math.max(...args)>> -> PASSES_ARGUMENT -> EXPRESSION <<...args>>
// EXPRESSION <<...args>> -> SPREADS_FROM -> VARIABLE <<args>>
// FUNCTION <<spreadInCalls>> -> RETURNS -> VARIABLE <<max>>
// @end-annotation
function spreadInCalls() {
  const args = [1, 2, 3];
  const max = Math.max(...args);
  return max;
}

// @construct PENDING computed-properties
// @annotation
// @end-annotation
function computedProperties() {
  const key = 'dynamic';
  const index = 0;

  const obj = {
    [key]: 'value',
    [`prefix_${key}`]: 'prefixed',
    [index + 1]: 'computed index',
    [Symbol.iterator]: function* () { yield 1; },
  };

  return obj;
}

// @construct PENDING shorthand-patterns
// @annotation
// @end-annotation
function shorthandPatterns() {
  const name = 'Alice';
  const age = 30;

  const person = { name, age };

  const obj = {
    greet() { return 'hello'; },
    async fetchData() { return 42; },
    *generate() { yield 1; },
    get value() { return this._v; },
    set value(v) { this._v = v; },
  };

  return { person, obj };
}

// @construct PENDING object-literal-forms
// @annotation
// @end-annotation
function objectLiteralForms() {
  const key = 'computed';

  return {
    regular: 'value',
    'string-key': 'value',
    42: 'numeric key',
    [key]: 'computed value',
    nested: { a: { b: { c: 1 } } },
    method() { return true; },
    get accessor() { return 1; },
    set accessor(v) {},
  };
}

// @construct PENDING array-literal-forms
// @annotation
// @end-annotation
function arrayLiteralForms() {
  const source = [1, 2, 3];

  return [
    'string',
    42,
    true,
    null,
    undefined,
    { key: 'value' },
    [1, 2],
    ...source,
  ];
}

// @construct PENDING destructure-assign-existing
// @annotation
// @end-annotation
function destructureAssignExisting() {
  let x, y;
  ({ x, y } = { x: 1, y: 2 });

  let first, rest;
  [first, ...rest] = [1, 2, 3, 4];

  return { x, y, first, rest };
}

// @construct PENDING destructure-assign-nested-target
// @annotation
// FUNCTION <<destructureAssignNestedTarget>> -> CONTAINS -> VARIABLE <<state>>
// FUNCTION <<destructureAssignNestedTarget>> -> CONTAINS -> VARIABLE <<name>>
// VARIABLE <<state>> -> ASSIGNED_FROM -> LITERAL <<{ user: { name: 'old' } }>>
// LITERAL <<{ user: { name: 'old' } }>> -> CONTAINS -> LITERAL <<'old'>>
// FUNCTION <<destructureAssignNestedTarget>> -> CONTAINS -> EXPRESSION <<{ user: { name } } = state>>
// EXPRESSION <<{ user: { name } } = state>> -> READS_FROM -> VARIABLE <<state>>
// EXPRESSION <<{ user: { name } } = state>> -> READS_FROM -> PROPERTY_ACCESS <<state.user.name>>
// VARIABLE <<name>> -> ASSIGNED_FROM -> PROPERTY_ACCESS <<state.user.name>>
// FUNCTION <<destructureAssignNestedTarget>> -> RETURNS -> VARIABLE <<name>>
// @end-annotation
function destructureAssignNestedTarget() {
  const state = { user: { name: 'old' } };
  let name;
  ({ user: { name } } = state);
  return name;
}

// @construct PENDING computed-key-side-effect
// @annotation
// @end-annotation
function computedKeySideEffect() {
  let i = 0;
  const obj = {
    [i++]: 'zero',
    [i++]: 'one',
    [i++]: 'two',
  };
  return { obj, finalI: i };
}

// @construct PENDING destructure-from-iterable
// @annotation
// @end-annotation
function destructureFromIterable() {
  const map = new Map([['a', 1], ['b', 2]]);
  const [[k1, v1], [k2, v2]] = map;

  function* gen() { yield 1; yield 2; yield 3; }
  const [first, second] = gen();

  const [a, b, c] = 'abc';

  return { k1, v1, k2, v2, first, second, a, b, c };
}

// @construct PENDING destructure-conditional-default
// @annotation
// @end-annotation
function destructureConditionalDefault() {
  let sideEffectCount = 0;
  function effect() { sideEffectCount++; return 'default'; }

  const { a = effect() } = { a: 'exists' }; // effect NOT called
  const { b = effect() } = {};               // effect IS called

  const [x = effect()] = [1];               // effect NOT called
  const [y = effect()] = [];                 // effect IS called

  return { a, b, x, y, sideEffectCount };
}

// @construct PENDING destructure-computed-key
// @annotation
// FUNCTION <<destructureComputedKey>> -> CONTAINS -> VARIABLE <<key>>
// FUNCTION <<destructureComputedKey>> -> CONTAINS -> VARIABLE <<value>>
// VARIABLE <<key>> -> ASSIGNED_FROM -> LITERAL <<'name'>>
// FUNCTION <<destructureComputedKey>> -> CONTAINS -> EXPRESSION <<{ [key]: value }>>
// EXPRESSION <<{ [key]: value }>> -> ASSIGNED_FROM -> LITERAL <<{ name: 'Alice' }>>
// EXPRESSION <<{ [key]: value }>> -> READS_FROM -> VARIABLE <<key>>
// EXPRESSION <<{ [key]: value }>> -> WRITES_TO -> VARIABLE <<value>>
// LITERAL <<{ name: 'Alice' }>> -> HAS_PROPERTY -> LITERAL <<'Alice'>>
// FUNCTION <<destructureComputedKey>> -> RETURNS -> VARIABLE <<value>>
// @end-annotation
function destructureComputedKey() {
  const key = 'name';
  const { [key]: value } = { name: 'Alice' };
  return value;
}

// @construct PENDING destructure-empty
// @annotation
// UNKNOWN <<module>> -> DECLARES -> FUNCTION <<destructureEmpty>>
// FUNCTION <<destructureEmpty>> -> CONTAINS -> PARAMETER <<obj>>
// FUNCTION <<destructureEmpty>> -> CONTAINS -> PARAMETER <<iter>>
// FUNCTION <<destructureEmpty>> -> CONTAINS -> EXPRESSION <<{} = obj>>
// FUNCTION <<destructureEmpty>> -> CONTAINS -> EXPRESSION <<[] = iter>>
// EXPRESSION <<{} = obj>> -> READS_FROM -> PARAMETER <<obj>>
// EXPRESSION <<[] = iter>> -> READS_FROM -> PARAMETER <<iter>>
// @end-annotation
function destructureEmpty(obj, iter) {
  const {} = obj;        // valid — no vars, triggers toString/valueOf
  const [] = iter;       // valid — consumes iterator, creates nothing
}

// @construct PENDING destructure-assign-to-properties
// @annotation
// FUNCTION <<destructureAssignToProperties>> -> DECLARES -> VARIABLE <<obj>>
// VARIABLE <<obj>> -> ASSIGNED_FROM -> LITERAL <<{}>>
// FUNCTION <<destructureAssignToProperties>> -> CONTAINS -> EXPRESSION <<destructure-assign>>
// EXPRESSION <<destructure-assign>> -> WRITES_TO -> PROPERTY_ACCESS <<obj.x>>
// EXPRESSION <<destructure-assign>> -> WRITES_TO -> PROPERTY_ACCESS <<obj.y>>
// EXPRESSION <<destructure-assign>> -> READS_FROM -> LITERAL <<{ a: 1, b: 2 }>>
// LITERAL <<{ a: 1, b: 2 }>> -> HAS_PROPERTY -> LITERAL <<1>>
// LITERAL <<{ a: 1, b: 2 }>> -> HAS_PROPERTY -> LITERAL <<2>>
// PROPERTY_ACCESS <<obj.x>> -> ASSIGNED_FROM -> LITERAL <<1>>
// PROPERTY_ACCESS <<obj.y>> -> ASSIGNED_FROM -> LITERAL <<2>>
// FUNCTION <<destructureAssignToProperties>> -> RETURNS -> VARIABLE <<obj>>
// @end-annotation
function destructureAssignToProperties() {
  const obj = {};
  ({ a: obj.x, b: obj.y } = { a: 1, b: 2 });
  return obj; // { x: 1, y: 2 }
}

// @construct PENDING destructure-nested-defaults-combined
// @annotation
// FUNCTION <<destructureNestedDefaults>> -> CONTAINS -> VARIABLE <<destructuring>>
// VARIABLE <<destructuring>> -> ASSIGNED_FROM -> VARIABLE <<b>>
// VARIABLE <<destructuring>> -> ASSIGNED_FROM -> LITERAL <<{}:source>>
// VARIABLE <<b>> -> DEFAULTS_TO -> LITERAL <<10>>
// VARIABLE <<destructuring>> -> DEFAULTS_TO -> LITERAL <<{}>>
// FUNCTION <<destructureNestedDefaults>> -> CONTAINS -> EXPRESSION <<return b>>
// EXPRESSION <<return b>> -> READS_FROM -> VARIABLE <<b>>
// FUNCTION <<destructureNestedDefaults>> -> RETURNS -> EXPRESSION <<return b>>
// @end-annotation
function destructureNestedDefaults() {
  const { a: { b = 10 } = {} } = {};
  return b; // 10 — default for inner AND outer
}

// @construct PENDING destructure-nested-rest
// @annotation
// FUNCTION <<destructureNestedRest>> -> CONTAINS -> EXPRESSION <<[first, ...[second, ...deep]]>>
// EXPRESSION <<[first, ...[second, ...deep]]>> -> ASSIGNED_FROM -> LITERAL <<[1, 2, 3, 4, 5]>>
// VARIABLE <<first>> -> ASSIGNED_FROM -> LITERAL <<1>>
// VARIABLE <<second>> -> ASSIGNED_FROM -> LITERAL <<2>>
// VARIABLE <<deep>> -> ASSIGNED_FROM -> UNKNOWN <<[3, 4, 5]>>
// LITERAL <<[1, 2, 3, 4, 5]>> -> HAS_ELEMENT -> LITERAL <<1>>
// LITERAL <<[1, 2, 3, 4, 5]>> -> HAS_ELEMENT -> LITERAL <<2>>
// LITERAL <<[1, 2, 3, 4, 5]>> -> HAS_ELEMENT -> LITERAL <<3>>
// LITERAL <<[1, 2, 3, 4, 5]>> -> HAS_ELEMENT -> LITERAL <<4>>
// LITERAL <<[1, 2, 3, 4, 5]>> -> HAS_ELEMENT -> LITERAL <<5>>
// FUNCTION <<destructureNestedRest>> -> RETURNS -> EXPRESSION <<{ first, second, deep }>>
// EXPRESSION <<{ first, second, deep }>> -> READS_FROM -> VARIABLE <<first>>
// EXPRESSION <<{ first, second, deep }>> -> READS_FROM -> VARIABLE <<second>>
// EXPRESSION <<{ first, second, deep }>> -> READS_FROM -> VARIABLE <<deep>>
// @end-annotation
function destructureNestedRest() {
  const [first, ...[second, ...deep]] = [1, 2, 3, 4, 5];
  // first=1, second=2, deep=[3,4,5]
  return { first, second, deep };
}

// @construct PENDING destructure-computed-default-rename
// @annotation
// FUNCTION <<destructureComputedDefaultRename>> -> CONTAINS -> VARIABLE <<key>>
// VARIABLE <<key>> -> ASSIGNED_FROM -> LITERAL <<'name'>>
// FUNCTION <<destructureComputedDefaultRename>> -> CONTAINS -> VARIABLE <<renamed>>
// FUNCTION <<destructureComputedDefaultRename>> -> CONTAINS -> EXPRESSION <<destructure1>>
// EXPRESSION <<destructure1>> -> READS_FROM -> VARIABLE <<key>>
// VARIABLE <<renamed>> -> ASSIGNED_FROM -> EXPRESSION <<destructure1>>
// VARIABLE <<renamed>> -> DEFAULTS_TO -> LITERAL <<'anonymous'>>
// EXPRESSION <<destructure1>> -> READS_FROM -> LITERAL <<{ name: 'Alice' }>>
// LITERAL <<{ name: 'Alice' }>> -> HAS_PROPERTY -> LITERAL <<'Alice'>>
// FUNCTION <<destructureComputedDefaultRename>> -> CONTAINS -> VARIABLE <<missing>>
// FUNCTION <<destructureComputedDefaultRename>> -> CONTAINS -> EXPRESSION <<destructure2>>
// EXPRESSION <<destructure2>> -> READS_FROM -> VARIABLE <<key>>
// VARIABLE <<missing>> -> ASSIGNED_FROM -> EXPRESSION <<destructure2>>
// VARIABLE <<missing>> -> DEFAULTS_TO -> LITERAL <<'anonymous'>>
// EXPRESSION <<destructure2>> -> READS_FROM -> LITERAL <<{}>>
// FUNCTION <<destructureComputedDefaultRename>> -> RETURNS -> EXPRESSION <<{ renamed, missing }>>
// EXPRESSION <<{ renamed, missing }>> -> READS_FROM -> VARIABLE <<renamed>>
// EXPRESSION <<{ renamed, missing }>> -> READS_FROM -> VARIABLE <<missing>>
// @end-annotation
function destructureComputedDefaultRename() {
  const key = 'name';
  const { [key]: renamed = 'anonymous' } = { name: 'Alice' };
  const { [key]: missing = 'anonymous' } = {};
  return { renamed, missing };
}

// @construct PENDING destructure-rest-own-only
// @annotation
// FUNCTION <<destructureRestOwnOnly>> -> CONTAINS -> VARIABLE <<proto>>
// VARIABLE <<proto>> -> ASSIGNED_FROM -> LITERAL <<{ inherited: 1 }>>
// FUNCTION <<destructureRestOwnOnly>> -> CONTAINS -> VARIABLE <<child>>
// VARIABLE <<child>> -> ASSIGNED_FROM -> CALL <<Object.create(proto)>>
// CALL <<Object.create(proto)>> -> PASSES_ARGUMENT -> VARIABLE <<proto>>
// PROPERTY_ACCESS <<child.own>> -> ASSIGNED_FROM -> LITERAL <<2>>
// PROPERTY_ACCESS <<child.also>> -> ASSIGNED_FROM -> LITERAL <<3>>
// FUNCTION <<destructureRestOwnOnly>> -> CONTAINS -> EXPRESSION <<{ own, ...rest }>>
// EXPRESSION <<{ own, ...rest }>> -> READS_FROM -> VARIABLE <<child>>
// VARIABLE <<own>> -> ASSIGNED_FROM -> EXPRESSION <<{ own, ...rest }>>
// VARIABLE <<rest>> -> ASSIGNED_FROM -> EXPRESSION <<{ own, ...rest }>>
// FUNCTION <<destructureRestOwnOnly>> -> CONTAINS -> EXPRESSION <<{ inherited }>>
// EXPRESSION <<{ inherited }>> -> READS_FROM -> VARIABLE <<child>>
// VARIABLE <<inherited>> -> ASSIGNED_FROM -> EXPRESSION <<{ inherited }>>
// FUNCTION <<destructureRestOwnOnly>> -> RETURNS -> LITERAL <<{ own, rest, inherited }>>
// LITERAL <<{ own, rest, inherited }>> -> READS_FROM -> VARIABLE <<own>>
// LITERAL <<{ own, rest, inherited }>> -> READS_FROM -> VARIABLE <<rest>>
// LITERAL <<{ own, rest, inherited }>> -> READS_FROM -> VARIABLE <<inherited>>
// @end-annotation
function destructureRestOwnOnly() {
  const proto = { inherited: 1 };
  const child = Object.create(proto);
  child.own = 2;
  child.also = 3;

  const { own, ...rest } = child;
  // rest === { also: 3 } — inherited NOT included in rest
  // But:
  const { inherited } = child; // 1 — named destructuring DOES access prototype
  return { own, rest, inherited };
}

// @construct PENDING computed-property-throws
// @annotation
// @end-annotation
function computedPropertyThrows() {
  const log = [];
  function throwingFn() { throw new Error('stop'); }
  try {
    const obj = {
      [log.push('a')]: 'first',
      [throwingFn()]:   'second',  // throws here
      [log.push('c')]: 'third',   // NEVER evaluated
    };
  } catch (e) {}
  return log; // ['a'] — 'c' was never pushed
}

// @construct PENDING async-generator-object-method
// @annotation
// @end-annotation
function asyncGeneratorObjectMethod() {
  const dataSource = {
    // Async generator method in object literal — NOT the same as class method
    async *events(since) {
      let cursor = since;
      const batches = [[{ id: 1 }, { id: 2 }], [{ id: 3 }]];
      for (const batch of batches) {
        for (const event of batch) {
          yield event;
        }
        cursor = batch[batch.length - 1].id;
      }
    },

    // Regular async method alongside for comparison
    async latest() {
      const events = [];
      for await (const e of this.events(0)) {
        events.push(e);
        if (events.length >= 2) break;
      }
      return events;
    },
  };
  return dataSource;
}

// @construct PENDING spread-duplicate-key-override
// @annotation
// FUNCTION <<spreadDuplicateKeyOverride>> -> CONTAINS -> PARAMETER <<overrides>>
// FUNCTION <<spreadDuplicateKeyOverride>> -> CONTAINS -> VARIABLE <<config>>
// VARIABLE <<config>> -> ASSIGNED_FROM -> EXPRESSION <<config-object>>
// EXPRESSION <<config-object>> -> HAS_PROPERTY -> PROPERTY <<debug-1>>
// PROPERTY <<debug-1>> -> ASSIGNED_FROM -> LITERAL <<false>>
// EXPRESSION <<config-object>> -> HAS_ELEMENT -> EXPRESSION <<...overrides>>
// EXPRESSION <<...overrides>> -> SPREADS_FROM -> PARAMETER <<overrides>>
// EXPRESSION <<config-object>> -> HAS_PROPERTY -> PROPERTY <<debug-3>>
// PROPERTY <<debug-3>> -> ASSIGNED_FROM -> LITERAL <<true>>
// PROPERTY <<debug-3>> -> SHADOWS -> PROPERTY <<debug-1>>
// EXPRESSION <<config-object>> -> HAS_PROPERTY -> PROPERTY <<timestamp>>
// PROPERTY <<timestamp>> -> ASSIGNED_FROM -> CALL <<Date.now()>>
// CALL <<Date.now()>> -> CALLS -> PROPERTY_ACCESS <<Date.now>>
// FUNCTION <<spreadDuplicateKeyOverride>> -> RETURNS -> VARIABLE <<config>>
// @end-annotation
function spreadDuplicateKeyOverride(overrides) {
  // Key 'debug' at positions (1) and (3) with spread between — (3) always wins
  const config = {
    debug: false,       // (1) explicit default
    ...overrides,       // (2) user overrides — may set debug
    debug: true,        // (3) THIS ALWAYS WINS — overrides the override
    timestamp: Date.now(),
  };
  return config;
}

// @construct PENDING export-named-list
// @annotation
// @end-annotation
export {
  objectDestructuringSimple,
  objectDestructuringNested,
  arrayDestructuringSimple,
  arrayDestructuringNested,
  arrayDestructuringSwap,
  withObjectParam,
  withArrayParam,
  withNestedParam,
  spreadInArrays,
  spreadInObjects,
  spreadInCalls,
  computedProperties,
  shorthandPatterns,
  objectLiteralForms,
  arrayLiteralForms,
  destructureAssignExisting,
  destructureAssignNestedTarget,
  computedKeySideEffect,
  destructureFromIterable,
  destructureConditionalDefault,
  destructureComputedKey,
  destructureEmpty,
  destructureAssignToProperties,
  destructureNestedDefaults,
  destructureNestedRest,
  destructureComputedDefaultRename,
  destructureRestOwnOnly,
  computedPropertyThrows,
  asyncGeneratorObjectMethod,
  spreadDuplicateKeyOverride,
};
