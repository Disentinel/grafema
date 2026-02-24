// =============================================================================
// property-access.js — Property Patterns, Object Methods, Freeze/Seal
// =============================================================================

// --- Dot vs bracket notation ---

// @construct PENDING prop-dot-notation
// @annotation
// FUNCTION <<dotAccess>> -> CONTAINS -> PARAMETER <<obj>>
// FUNCTION <<dotAccess>> -> DECLARES -> VARIABLE <<a>>
// FUNCTION <<dotAccess>> -> DECLARES -> VARIABLE <<b>>
// VARIABLE <<a>> -> ASSIGNED_FROM -> PROPERTY_ACCESS <<obj.name>>
// PROPERTY_ACCESS <<obj.name>> -> READS_FROM -> PARAMETER <<obj>>
// VARIABLE <<b>> -> ASSIGNED_FROM -> PROPERTY_ACCESS <<obj.nested.deep.value>>
// PROPERTY_ACCESS <<obj.nested>> -> READS_FROM -> PARAMETER <<obj>>
// PROPERTY_ACCESS <<obj.nested.deep>> -> READS_FROM -> PROPERTY_ACCESS <<obj.nested>>
// PROPERTY_ACCESS <<obj.nested.deep.value>> -> READS_FROM -> PROPERTY_ACCESS <<obj.nested.deep>>
// FUNCTION <<dotAccess>> -> RETURNS -> EXPRESSION <<{ a, b }>>
// EXPRESSION <<{ a, b }>> -> READS_FROM -> VARIABLE <<a>>
// EXPRESSION <<{ a, b }>> -> READS_FROM -> VARIABLE <<b>>
// @end-annotation
function dotAccess(obj) {
  const a = obj.name;
  const b = obj.nested.deep.value;
  return { a, b };
}

// @construct PENDING prop-bracket-notation
// @annotation
// FUNCTION <<bracketAccess>> -> CONTAINS -> PARAMETER <<obj>>
// FUNCTION <<bracketAccess>> -> CONTAINS -> PARAMETER <<key>>
// FUNCTION <<bracketAccess>> -> CONTAINS -> VARIABLE <<a>>
// FUNCTION <<bracketAccess>> -> CONTAINS -> VARIABLE <<b>>
// FUNCTION <<bracketAccess>> -> CONTAINS -> VARIABLE <<c>>
// VARIABLE <<a>> -> ASSIGNED_FROM -> PROPERTY_ACCESS <<obj['name']>>
// PROPERTY_ACCESS <<obj['name']>> -> READS_FROM -> PARAMETER <<obj>>
// PROPERTY_ACCESS <<obj['name']>> -> USES -> LITERAL <<'name'>>
// VARIABLE <<b>> -> ASSIGNED_FROM -> PROPERTY_ACCESS <<obj[key]>>
// PROPERTY_ACCESS <<obj[key]>> -> READS_FROM -> PARAMETER <<obj>>
// PROPERTY_ACCESS <<obj[key]>> -> USES -> PARAMETER <<key>>
// VARIABLE <<c>> -> ASSIGNED_FROM -> PROPERTY_ACCESS <<obj['complex-key']>>
// PROPERTY_ACCESS <<obj['complex-key']>> -> READS_FROM -> PARAMETER <<obj>>
// PROPERTY_ACCESS <<obj['complex-key']>> -> USES -> LITERAL <<'complex-key'>>
// FUNCTION <<bracketAccess>> -> RETURNS -> EXPRESSION <<{ a, b, c }>>
// EXPRESSION <<{ a, b, c }>> -> READS_FROM -> VARIABLE <<a>>
// EXPRESSION <<{ a, b, c }>> -> READS_FROM -> VARIABLE <<b>>
// EXPRESSION <<{ a, b, c }>> -> READS_FROM -> VARIABLE <<c>>
// @end-annotation
function bracketAccess(obj, key) {
  const a = obj['name'];
  const b = obj[key];
  const c = obj['complex-key'];
  return { a, b, c };
}

// @construct PENDING prop-dynamic-access
// @annotation
// FUNCTION <<dynamicAccess>> -> CONTAINS -> PARAMETER <<obj>>
// FUNCTION <<dynamicAccess>> -> CONTAINS -> PARAMETER <<keys>>
// FUNCTION <<dynamicAccess>> -> CONTAINS -> VARIABLE <<results>>
// VARIABLE <<results>> -> ASSIGNED_FROM -> LITERAL <<{}>>
// FUNCTION <<dynamicAccess>> -> CONTAINS -> LOOP <<for-of>>
// LOOP <<for-of>> -> ITERATES_OVER -> PARAMETER <<keys>>
// LOOP <<for-of>> -> CONTAINS -> VARIABLE <<key>>
// PROPERTY_ACCESS <<results[key]>> -> ASSIGNED_FROM -> PROPERTY_ACCESS <<obj[key]>>
// PROPERTY_ACCESS <<results[key]>> -> WRITES_TO -> VARIABLE <<results>>
// PROPERTY_ACCESS <<obj[key]>> -> READS_FROM -> PARAMETER <<obj>>
// FUNCTION <<dynamicAccess>> -> RETURNS -> VARIABLE <<results>>
// @end-annotation
function dynamicAccess(obj, keys) {
  const results = {};
  for (const key of keys) {
    results[key] = obj[key];
  }
  return results;
}

// --- Property chain ---

// @construct PENDING prop-deep-chain
// @annotation
// FUNCTION <<deepChain>> -> CONTAINS -> PARAMETER <<root>>
// FUNCTION <<deepChain>> -> RETURNS -> PROPERTY_ACCESS <<root.level1.level2.level3.value>>
// PROPERTY_ACCESS <<root.level1>> -> READS_FROM -> PARAMETER <<root>>
// PROPERTY_ACCESS <<root.level1.level2>> -> CHAINS_FROM -> PROPERTY_ACCESS <<root.level1>>
// PROPERTY_ACCESS <<root.level1.level2.level3>> -> CHAINS_FROM -> PROPERTY_ACCESS <<root.level1.level2>>
// PROPERTY_ACCESS <<root.level1.level2.level3.value>> -> CHAINS_FROM -> PROPERTY_ACCESS <<root.level1.level2.level3>>
// @end-annotation
function deepChain(root) {
  return root.level1.level2.level3.value;
}

// @construct PENDING prop-optional-chain-mixed
function optionalChainMixed(obj) {
  const a = obj?.level1?.level2;
  const b = obj?.['dynamic-key']?.value;
  const c = obj?.method?.();
  const d = obj?.arr?.[0]?.name;
  return { a, b, c, d };
}

// --- Property assignment patterns ---

// @construct PENDING prop-dot-assign
// @annotation
// FUNCTION <<dotAssign>> -> CONTAINS -> PARAMETER <<obj>>
// PROPERTY_ACCESS <<obj.name>> -> ASSIGNED_FROM -> LITERAL <<'new'>>
// FUNCTION <<dotAssign>> -> WRITES_TO -> PROPERTY_ACCESS <<obj.name>>
// PROPERTY_ACCESS <<obj.nested>> -> ASSIGNED_FROM -> LITERAL <<{}>>
// FUNCTION <<dotAssign>> -> WRITES_TO -> PROPERTY_ACCESS <<obj.nested>>
// PROPERTY_ACCESS <<obj.nested.deep>> -> ASSIGNED_FROM -> LITERAL <<42>>
// FUNCTION <<dotAssign>> -> WRITES_TO -> PROPERTY_ACCESS <<obj.nested.deep>>
// FUNCTION <<dotAssign>> -> RETURNS -> PARAMETER <<obj>>
// @end-annotation
function dotAssign(obj) {
  obj.name = 'new';
  obj.nested = {};
  obj.nested.deep = 42;
  return obj;
}

// @construct PENDING prop-bracket-assign
// @annotation
// FUNCTION <<bracketAssign>> -> CONTAINS -> PARAMETER <<obj>>
// FUNCTION <<bracketAssign>> -> CONTAINS -> PARAMETER <<key>>
// FUNCTION <<bracketAssign>> -> CONTAINS -> PARAMETER <<value>>
// PROPERTY_ACCESS <<obj[key]>> -> READS_FROM -> PARAMETER <<obj>>
// PROPERTY_ACCESS <<obj[key]>> -> READS_FROM -> PARAMETER <<key>>
// PROPERTY_ACCESS <<obj[key]>> -> ASSIGNED_FROM -> PARAMETER <<value>>
// PROPERTY_ACCESS <<obj['fixed-key']>> -> READS_FROM -> PARAMETER <<obj>>
// PROPERTY_ACCESS <<obj['fixed-key']>> -> ASSIGNED_FROM -> LITERAL <<'fixed'>>
// FUNCTION <<bracketAssign>> -> RETURNS -> PARAMETER <<obj>>
// @end-annotation
function bracketAssign(obj, key, value) {
  obj[key] = value;
  obj['fixed-key'] = 'fixed';
  return obj;
}

// @construct PENDING prop-compound-assign
// @annotation
// FUNCTION <<compoundPropertyAssign>> -> CONTAINS -> PARAMETER <<obj>>
// FUNCTION <<compoundPropertyAssign>> -> CONTAINS -> EXPRESSION <<obj.count += 1>>
// FUNCTION <<compoundPropertyAssign>> -> CONTAINS -> EXPRESSION <<obj.total -= 5>>
// FUNCTION <<compoundPropertyAssign>> -> CONTAINS -> EXPRESSION <<obj.name += ' suffix'>>
// FUNCTION <<compoundPropertyAssign>> -> CONTAINS -> EXPRESSION <<obj.flags |= 0x04>>
// FUNCTION <<compoundPropertyAssign>> -> CONTAINS -> EXPRESSION <<obj.mask &= 0xff>>
// FUNCTION <<compoundPropertyAssign>> -> RETURNS -> PARAMETER <<obj>>
// EXPRESSION <<obj.count += 1>> -> WRITES_TO -> PROPERTY_ACCESS <<obj.count>>
// EXPRESSION <<obj.count += 1>> -> READS_FROM -> PROPERTY_ACCESS <<obj.count>>
// EXPRESSION <<obj.count += 1>> -> READS_FROM -> LITERAL <<1>>
// EXPRESSION <<obj.total -= 5>> -> WRITES_TO -> PROPERTY_ACCESS <<obj.total>>
// EXPRESSION <<obj.total -= 5>> -> READS_FROM -> PROPERTY_ACCESS <<obj.total>>
// EXPRESSION <<obj.total -= 5>> -> READS_FROM -> LITERAL <<5>>
// EXPRESSION <<obj.name += ' suffix'>> -> WRITES_TO -> PROPERTY_ACCESS <<obj.name>>
// EXPRESSION <<obj.name += ' suffix'>> -> READS_FROM -> PROPERTY_ACCESS <<obj.name>>
// EXPRESSION <<obj.name += ' suffix'>> -> READS_FROM -> LITERAL <<' suffix'>>
// EXPRESSION <<obj.flags |= 0x04>> -> WRITES_TO -> PROPERTY_ACCESS <<obj.flags>>
// EXPRESSION <<obj.flags |= 0x04>> -> READS_FROM -> PROPERTY_ACCESS <<obj.flags>>
// EXPRESSION <<obj.flags |= 0x04>> -> READS_FROM -> LITERAL <<0x04>>
// EXPRESSION <<obj.mask &= 0xff>> -> WRITES_TO -> PROPERTY_ACCESS <<obj.mask>>
// EXPRESSION <<obj.mask &= 0xff>> -> READS_FROM -> PROPERTY_ACCESS <<obj.mask>>
// EXPRESSION <<obj.mask &= 0xff>> -> READS_FROM -> LITERAL <<0xff>>
// @end-annotation
function compoundPropertyAssign(obj) {
  obj.count += 1;
  obj.total -= 5;
  obj.name += ' suffix';
  obj.flags |= 0x04;
  obj.mask &= 0xff;
  return obj;
}

// --- Object.keys / values / entries ---

// @construct PENDING prop-object-keys
// @annotation
// FUNCTION <<objectEnumeration>> -> CONTAINS -> PARAMETER <<obj>>
// FUNCTION <<objectEnumeration>> -> DECLARES -> VARIABLE <<keys>>
// VARIABLE <<keys>> -> ASSIGNED_FROM -> CALL <<Object.keys(obj)>>
// CALL <<Object.keys(obj)>> -> CALLS -> PROPERTY_ACCESS <<Object.keys>>
// CALL <<Object.keys(obj)>> -> PASSES_ARGUMENT -> PARAMETER <<obj>>
// FUNCTION <<objectEnumeration>> -> DECLARES -> VARIABLE <<values>>
// VARIABLE <<values>> -> ASSIGNED_FROM -> CALL <<Object.values(obj)>>
// CALL <<Object.values(obj)>> -> CALLS -> PROPERTY_ACCESS <<Object.values>>
// CALL <<Object.values(obj)>> -> PASSES_ARGUMENT -> PARAMETER <<obj>>
// FUNCTION <<objectEnumeration>> -> DECLARES -> VARIABLE <<entries>>
// VARIABLE <<entries>> -> ASSIGNED_FROM -> CALL <<Object.entries(obj)>>
// CALL <<Object.entries(obj)>> -> CALLS -> PROPERTY_ACCESS <<Object.entries>>
// CALL <<Object.entries(obj)>> -> PASSES_ARGUMENT -> PARAMETER <<obj>>
// FUNCTION <<objectEnumeration>> -> RETURNS -> EXPRESSION <<{ keys, values, entries }>>
// EXPRESSION <<{ keys, values, entries }>> -> READS_FROM -> VARIABLE <<keys>>
// EXPRESSION <<{ keys, values, entries }>> -> READS_FROM -> VARIABLE <<values>>
// EXPRESSION <<{ keys, values, entries }>> -> READS_FROM -> VARIABLE <<entries>>
// @end-annotation
function objectEnumeration(obj) {
  const keys = Object.keys(obj);
  const values = Object.values(obj);
  const entries = Object.entries(obj);
  return { keys, values, entries };
}

// @construct PENDING prop-object-from-entries
// @annotation
// FUNCTION <<fromEntries>> -> HAS_BODY -> PARAMETER <<entries>>
// FUNCTION <<fromEntries>> -> RETURNS -> CALL <<Object.fromEntries(entries)>>
// CALL <<Object.fromEntries(entries)>> -> CALLS -> PROPERTY_ACCESS <<Object.fromEntries>>
// CALL <<Object.fromEntries(entries)>> -> PASSES_ARGUMENT -> PARAMETER <<entries>>
// PROPERTY_ACCESS <<Object.fromEntries>> -> READS_FROM -> EXTERNAL <<Object>>
// @end-annotation
function fromEntries(entries) {
  return Object.fromEntries(entries);
}

// --- Object.assign ---

// @construct PENDING prop-object-assign
// @annotation
// FUNCTION <<objectAssign>> -> CONTAINS -> VARIABLE <<target>>
// FUNCTION <<objectAssign>> -> CONTAINS -> VARIABLE <<source1>>
// FUNCTION <<objectAssign>> -> CONTAINS -> VARIABLE <<source2>>
// VARIABLE <<target>> -> ASSIGNED_FROM -> LITERAL <<{ a: 1 }>>
// LITERAL <<{ a: 1 }>> -> HAS_PROPERTY -> PROPERTY <<target.a>>
// PROPERTY <<target.a>> -> ASSIGNED_FROM -> LITERAL <<1>>
// VARIABLE <<source1>> -> ASSIGNED_FROM -> LITERAL <<{ b: 2 }>>
// LITERAL <<{ b: 2 }>> -> HAS_PROPERTY -> PROPERTY <<source1.b>>
// PROPERTY <<source1.b>> -> ASSIGNED_FROM -> LITERAL <<2>>
// VARIABLE <<source2>> -> ASSIGNED_FROM -> LITERAL <<{ c: 3, a: 'overridden' }>>
// LITERAL <<{ c: 3, a: 'overridden' }>> -> HAS_PROPERTY -> PROPERTY <<source2.c>>
// LITERAL <<{ c: 3, a: 'overridden' }>> -> HAS_PROPERTY -> PROPERTY <<source2.a>>
// PROPERTY <<source2.c>> -> ASSIGNED_FROM -> LITERAL <<3>>
// PROPERTY <<source2.a>> -> ASSIGNED_FROM -> LITERAL <<'overridden'>>
// CALL <<Object.assign(target, source1, source2)>> -> CALLS -> PROPERTY_ACCESS <<Object.assign>>
// CALL <<Object.assign(target, source1, source2)>> -> PASSES_ARGUMENT -> VARIABLE <<target>>
// CALL <<Object.assign(target, source1, source2)>> -> PASSES_ARGUMENT -> VARIABLE <<source1>>
// CALL <<Object.assign(target, source1, source2)>> -> PASSES_ARGUMENT -> VARIABLE <<source2>>
// FUNCTION <<objectAssign>> -> RETURNS -> CALL <<Object.assign(target, source1, source2)>>
// @end-annotation
function objectAssign() {
  const target = { a: 1 };
  const source1 = { b: 2 };
  const source2 = { c: 3, a: 'overridden' };
  return Object.assign(target, source1, source2);
}

// --- Object.freeze / seal / preventExtensions ---

// @construct PENDING prop-freeze
// @annotation
// FUNCTION <<frozen>> -> CONTAINS -> VARIABLE <<obj>>
// VARIABLE <<obj>> -> ASSIGNED_FROM -> LITERAL <<{ a: 1, b: { c: 2 } }>>
// LITERAL <<{ a: 1, b: { c: 2 } }>> -> HAS_PROPERTY -> LITERAL <<1>>
// LITERAL <<{ a: 1, b: { c: 2 } }>> -> HAS_PROPERTY -> LITERAL <<{ c: 2 }>>
// LITERAL <<{ c: 2 }>> -> HAS_PROPERTY -> LITERAL <<2>>
// FUNCTION <<frozen>> -> CONTAINS -> CALL <<Object.freeze(obj)>>
// CALL <<Object.freeze(obj)>> -> PASSES_ARGUMENT -> VARIABLE <<obj>>
// PROPERTY_ACCESS <<obj.a>> -> READS_FROM -> VARIABLE <<obj>>
// PROPERTY_ACCESS <<obj.a>> -> ASSIGNED_FROM -> LITERAL <<999>>
// PROPERTY_ACCESS <<obj.b.c>> -> READS_FROM -> VARIABLE <<obj>>
// PROPERTY_ACCESS <<obj.b.c>> -> ASSIGNED_FROM -> LITERAL <<999-2>>
// FUNCTION <<frozen>> -> RETURNS -> VARIABLE <<obj>>
// @end-annotation
function frozen() {
  const obj = { a: 1, b: { c: 2 } };
  Object.freeze(obj);
  obj.a = 999;       // silently fails (or throws in strict)
  obj.b.c = 999;     // succeeds — shallow freeze
  return obj;
}

// @construct PENDING prop-seal
// @annotation
// FUNCTION <<sealed>> -> CONTAINS -> VARIABLE <<obj>>
// VARIABLE <<obj>> -> ASSIGNED_FROM -> LITERAL <<{ a: 1 }>>
// LITERAL <<{ a: 1 }>> -> HAS_PROPERTY -> LITERAL <<1>>
// CALL <<Object.seal(obj)>> -> PASSES_ARGUMENT -> VARIABLE <<obj>>
// FUNCTION <<sealed>> -> CONTAINS -> CALL <<Object.seal(obj)>>
// PROPERTY_ACCESS <<obj.a>> -> ASSIGNED_FROM -> LITERAL <<2>>
// PROPERTY_ACCESS <<obj.b>> -> ASSIGNED_FROM -> LITERAL <<3>>
// EXPRESSION <<delete obj.a>> -> READS_FROM -> PROPERTY_ACCESS <<obj.a>>
// FUNCTION <<sealed>> -> CONTAINS -> EXPRESSION <<delete obj.a>>
// FUNCTION <<sealed>> -> RETURNS -> VARIABLE <<obj>>
// @end-annotation
function sealed() {
  const obj = { a: 1 };
  Object.seal(obj);
  obj.a = 2;         // allowed — existing property
  obj.b = 3;         // silently fails — no new properties
  delete obj.a;      // silently fails — cannot delete
  return obj;
}

// @construct PENDING prop-prevent-extensions
// @annotation
// FUNCTION <<preventExtensions>> -> CONTAINS -> VARIABLE <<obj>>
// VARIABLE <<obj>> -> ASSIGNED_FROM -> LITERAL <<{ a: 1 }>>
// LITERAL <<{ a: 1 }>> -> HAS_PROPERTY -> PROPERTY <<a>>
// PROPERTY <<a>> -> ASSIGNED_FROM -> LITERAL <<1>>
// CALL <<Object.preventExtensions(obj)>> -> CALLS -> PROPERTY_ACCESS <<Object.preventExtensions>>
// CALL <<Object.preventExtensions(obj)>> -> PASSES_ARGUMENT -> VARIABLE <<obj>>
// FUNCTION <<preventExtensions>> -> CONTAINS -> CALL <<Object.preventExtensions(obj)>>
// PROPERTY_ACCESS <<obj.b>> -> ASSIGNED_FROM -> LITERAL <<2>>
// FUNCTION <<preventExtensions>> -> WRITES_TO -> PROPERTY_ACCESS <<obj.b>>
// PROPERTY_ACCESS <<obj.a>> -> ASSIGNED_FROM -> LITERAL <<99>>
// FUNCTION <<preventExtensions>> -> WRITES_TO -> PROPERTY_ACCESS <<obj.a>>
// EXPRESSION <<delete obj.a>> -> READS_FROM -> PROPERTY_ACCESS <<obj.a>>
// FUNCTION <<preventExtensions>> -> CONTAINS -> EXPRESSION <<delete obj.a>>
// FUNCTION <<preventExtensions>> -> RETURNS -> VARIABLE <<obj>>
// @end-annotation
function preventExtensions() {
  const obj = { a: 1 };
  Object.preventExtensions(obj);
  obj.b = 2;         // silently fails
  obj.a = 99;        // allowed
  delete obj.a;      // allowed
  return obj;
}

// --- Property existence checks ---

// @construct PENDING prop-existence-checks
// @annotation
// @end-annotation
function propertyChecks(obj) {
  const hasIn = 'key' in obj;
  const hasOwn = Object.hasOwn(obj, 'key');
  const hasOwnProp = obj.hasOwnProperty('key');
  const isUndef = obj.key === undefined;
  return { hasIn, hasOwn, hasOwnProp, isUndef };
}

// --- Property deletion ---

// @construct PENDING prop-delete
// @annotation
// FUNCTION <<propertyDeletion>> -> CONTAINS -> PARAMETER <<obj>>
// FUNCTION <<propertyDeletion>> -> CONTAINS -> VARIABLE <<hadKey>>
// VARIABLE <<hadKey>> -> ASSIGNED_FROM -> EXPRESSION <<'key' in obj>>
// EXPRESSION <<'key' in obj>> -> READS_FROM -> LITERAL <<'key'>>
// EXPRESSION <<'key' in obj>> -> READS_FROM -> PARAMETER <<obj>>
// EXPRESSION <<delete obj.key>> -> DELETES -> PROPERTY_ACCESS <<obj.key>>
// PROPERTY_ACCESS <<obj.key>> -> READS_FROM -> PARAMETER <<obj>>
// FUNCTION <<propertyDeletion>> -> CONTAINS -> VARIABLE <<hasKey>>
// VARIABLE <<hasKey>> -> ASSIGNED_FROM -> EXPRESSION <<'key' in obj_2>>
// EXPRESSION <<'key' in obj_2>> -> READS_FROM -> LITERAL <<'key'_2>>
// EXPRESSION <<'key' in obj_2>> -> READS_FROM -> PARAMETER <<obj>>
// FUNCTION <<propertyDeletion>> -> RETURNS -> EXPRESSION <<{ hadKey, hasKey }>>
// EXPRESSION <<{ hadKey, hasKey }>> -> READS_FROM -> VARIABLE <<hadKey>>
// EXPRESSION <<{ hadKey, hasKey }>> -> READS_FROM -> VARIABLE <<hasKey>>
// @end-annotation
function propertyDeletion(obj) {
  const hadKey = 'key' in obj;
  delete obj.key;
  const hasKey = 'key' in obj;
  return { hadKey, hasKey };
}

// --- Property enumeration order ---

// @construct PENDING prop-enumeration-order
// @annotation
// FUNCTION <<enumerationOrder>> -> CONTAINS -> VARIABLE <<obj>>
// VARIABLE <<obj>> -> ASSIGNED_FROM -> LITERAL <<{}>>
// PROPERTY_ACCESS <<obj.b>> -> WRITES_TO -> VARIABLE <<obj>>
// PROPERTY_ACCESS <<obj.b>> -> ASSIGNED_FROM -> LITERAL <<1>>
// PROPERTY_ACCESS <<obj.a>> -> WRITES_TO -> VARIABLE <<obj>>
// PROPERTY_ACCESS <<obj.a>> -> ASSIGNED_FROM -> LITERAL <<2>>
// PROPERTY_ACCESS <<obj[1]>> -> WRITES_TO -> VARIABLE <<obj>>
// PROPERTY_ACCESS <<obj[1]>> -> ASSIGNED_FROM -> LITERAL <<3>>
// PROPERTY_ACCESS <<obj[0]>> -> WRITES_TO -> VARIABLE <<obj>>
// PROPERTY_ACCESS <<obj[0]>> -> ASSIGNED_FROM -> LITERAL <<4>>
// PROPERTY_ACCESS <<obj.c>> -> WRITES_TO -> VARIABLE <<obj>>
// PROPERTY_ACCESS <<obj.c>> -> ASSIGNED_FROM -> LITERAL <<5>>
// CALL <<Object.keys(obj)>> -> CALLS -> PROPERTY_ACCESS <<Object.keys>>
// CALL <<Object.keys(obj)>> -> PASSES_ARGUMENT -> VARIABLE <<obj>>
// FUNCTION <<enumerationOrder>> -> RETURNS -> CALL <<Object.keys(obj)>>
// @end-annotation
function enumerationOrder() {
  const obj = {};
  obj.b = 1;
  obj.a = 2;
  obj[1] = 3;
  obj[0] = 4;
  obj.c = 5;
  // Integer keys first (sorted), then string keys (insertion order)
  return Object.keys(obj); // ['0', '1', 'b', 'a', 'c']
}

// --- Getter/setter via Object.defineProperty ---

// @construct PENDING prop-define-accessor
// @annotation
// FUNCTION <<defineAccessor>> -> CONTAINS -> VARIABLE <<obj>>
// VARIABLE <<obj>> -> ASSIGNED_FROM -> LITERAL <<{ _value: 0 }>>
// LITERAL <<{ _value: 0 }>> -> HAS_PROPERTY -> LITERAL <<0>>
// FUNCTION <<defineAccessor>> -> CONTAINS -> CALL <<Object.defineProperty(obj, 'value', {...})>>
// CALL <<Object.defineProperty(obj, 'value', {...})>> -> CALLS -> EXTERNAL <<Object.defineProperty>>
// CALL <<Object.defineProperty(obj, 'value', {...})>> -> PASSES_ARGUMENT -> VARIABLE <<obj>>
// CALL <<Object.defineProperty(obj, 'value', {...})>> -> PASSES_ARGUMENT -> LITERAL <<'value'>>
// CALL <<Object.defineProperty(obj, 'value', {...})>> -> PASSES_ARGUMENT -> LITERAL <<descriptor>>
// LITERAL <<descriptor>> -> HAS_PROPERTY -> GETTER <<get>>
// LITERAL <<descriptor>> -> HAS_PROPERTY -> SETTER <<set>>
// LITERAL <<descriptor>> -> HAS_PROPERTY -> LITERAL <<true>>
// GETTER <<get>> -> RETURNS -> PROPERTY_ACCESS <<this._value>>
// SETTER <<set>> -> CONTAINS -> PARAMETER <<v>>
// PROPERTY_ACCESS <<this._value_assign>> -> ASSIGNED_FROM -> CALL <<Math.max(0, v)>>
// SETTER <<set>> -> WRITES_TO -> PROPERTY_ACCESS <<this._value_assign>>
// CALL <<Math.max(0, v)>> -> CALLS -> EXTERNAL <<Math.max>>
// CALL <<Math.max(0, v)>> -> PASSES_ARGUMENT -> LITERAL <<0>>
// CALL <<Math.max(0, v)>> -> PASSES_ARGUMENT -> PARAMETER <<v>>
// FUNCTION <<defineAccessor>> -> RETURNS -> VARIABLE <<obj>>
// @end-annotation
function defineAccessor() {
  const obj = { _value: 0 };
  Object.defineProperty(obj, 'value', {
    get() { return this._value; },
    set(v) { this._value = Math.max(0, v); },
    enumerable: true,
  });
  return obj;
}

// --- Object.is ---

// @construct PENDING prop-object-is
// @annotation
// FUNCTION <<objectIsComparison>> -> CONTAINS -> VARIABLE <<a>>
// FUNCTION <<objectIsComparison>> -> CONTAINS -> VARIABLE <<b>>
// FUNCTION <<objectIsComparison>> -> CONTAINS -> VARIABLE <<c>>
// VARIABLE <<a>> -> ASSIGNED_FROM -> CALL <<Object.is(NaN, NaN)>>
// CALL <<Object.is(NaN, NaN)>> -> CALLS -> PROPERTY_ACCESS <<Object.is>>
// CALL <<Object.is(NaN, NaN)>> -> PASSES_ARGUMENT -> LITERAL <<NaN>>
// CALL <<Object.is(NaN, NaN)>> -> PASSES_ARGUMENT -> LITERAL <<NaN>>
// VARIABLE <<b>> -> ASSIGNED_FROM -> CALL <<Object.is(0, -0)>>
// CALL <<Object.is(0, -0)>> -> CALLS -> PROPERTY_ACCESS <<Object.is>>
// CALL <<Object.is(0, -0)>> -> PASSES_ARGUMENT -> LITERAL <<0>>
// CALL <<Object.is(0, -0)>> -> PASSES_ARGUMENT -> LITERAL <<-0>>
// VARIABLE <<c>> -> ASSIGNED_FROM -> CALL <<Object.is(1, 1)>>
// CALL <<Object.is(1, 1)>> -> CALLS -> PROPERTY_ACCESS <<Object.is>>
// CALL <<Object.is(1, 1)>> -> PASSES_ARGUMENT -> LITERAL <<1>>
// CALL <<Object.is(1, 1)>> -> PASSES_ARGUMENT -> LITERAL <<1>>
// FUNCTION <<objectIsComparison>> -> RETURNS -> EXPRESSION <<{ a, b, c }>>
// EXPRESSION <<{ a, b, c }>> -> READS_FROM -> VARIABLE <<a>>
// EXPRESSION <<{ a, b, c }>> -> READS_FROM -> VARIABLE <<b>>
// EXPRESSION <<{ a, b, c }>> -> READS_FROM -> VARIABLE <<c>>
// @end-annotation
function objectIsComparison() {
  const a = Object.is(NaN, NaN);       // true (unlike ===)
  const b = Object.is(0, -0);          // false (unlike ===)
  const c = Object.is(1, 1);           // true
  return { a, b, c };
}

// --- structuredClone ---

// @construct PENDING prop-structured-clone
// @annotation
// FUNCTION <<deepClone>> -> CONTAINS -> PARAMETER <<obj>>
// FUNCTION <<deepClone>> -> RETURNS -> CALL <<structuredClone(obj)>>
// CALL <<structuredClone(obj)>> -> CALLS -> EXTERNAL <<structuredClone>>
// CALL <<structuredClone(obj)>> -> PASSES_ARGUMENT -> PARAMETER <<obj>>
// @end-annotation
function deepClone(obj) {
  return structuredClone(obj);
}

// --- Getter/setter side effects ---

// @construct PENDING prop-getter-side-effect
// @annotation
// FUNCTION <<getterSideEffect>> -> CONTAINS -> VARIABLE <<callCount>>
// VARIABLE <<callCount>> -> ASSIGNED_FROM -> LITERAL <<0>>
// FUNCTION <<getterSideEffect>> -> CONTAINS -> VARIABLE <<obj>>
// VARIABLE <<obj>> -> ASSIGNED_FROM -> EXPRESSION <<obj:object>>
// EXPRESSION <<obj:object>> -> HAS_PROPERTY -> GETTER <<obj.value:getter>>
// EXPRESSION <<obj:object>> -> HAS_PROPERTY -> SETTER <<obj.value:setter>>
// GETTER <<obj.value:getter>> -> CONTAINS -> EXPRESSION <<callCount++>>
// EXPRESSION <<callCount++>> -> MODIFIES -> VARIABLE <<callCount>>
// GETTER <<obj.value:getter>> -> RETURNS -> LITERAL <<42>>
// SETTER <<obj.value:setter>> -> CONTAINS -> PARAMETER <<v>>
// SETTER <<obj.value:setter>> -> CONTAINS -> CALL <<console.log('set to', v)>>
// CALL <<console.log('set to', v)>> -> PASSES_ARGUMENT -> LITERAL <<'set to'>>
// CALL <<console.log('set to', v)>> -> PASSES_ARGUMENT -> PARAMETER <<v>>
// FUNCTION <<getterSideEffect>> -> CONTAINS -> VARIABLE <<x>>
// VARIABLE <<x>> -> ASSIGNED_FROM -> PROPERTY_ACCESS <<obj.value:read>>
// PROPERTY_ACCESS <<obj.value:read>> -> READS_FROM -> VARIABLE <<obj>>
// PROPERTY_ACCESS <<obj.value:read>> -> INVOKES -> GETTER <<obj.value:getter>>
// PROPERTY_ACCESS <<obj.value:write>> -> WRITES_TO -> VARIABLE <<obj>>
// PROPERTY_ACCESS <<obj.value:write>> -> ASSIGNED_FROM -> LITERAL <<10>>
// PROPERTY_ACCESS <<obj.value:write>> -> INVOKES -> SETTER <<obj.value:setter>>
// FUNCTION <<getterSideEffect>> -> RETURNS -> EXPRESSION <<return-object>>
// EXPRESSION <<return-object>> -> HAS_PROPERTY -> VARIABLE <<x>>
// EXPRESSION <<return-object>> -> HAS_PROPERTY -> VARIABLE <<callCount>>
// @end-annotation
function getterSideEffect() {
  let callCount = 0;
  const obj = {
    get value() {
      callCount++;
      return 42;
    },
    set value(v) {
      console.log('set to', v);
    },
  };
  const x = obj.value;   // triggers getter — side effect
  obj.value = 10;         // triggers setter — side effect
  return { x, callCount };
}

// --- Circular references ---

// @construct PENDING prop-circular-object
// @annotation
// FUNCTION <<circularObject>> -> CONTAINS -> VARIABLE <<a>>
// FUNCTION <<circularObject>> -> CONTAINS -> VARIABLE <<b>>
// VARIABLE <<a>> -> ASSIGNED_FROM -> LITERAL <<{}>>
// VARIABLE <<b>> -> ASSIGNED_FROM -> LITERAL <<{ ref: a }>>
// LITERAL <<{ ref: a }>> -> READS_FROM -> VARIABLE <<a>>
// PROPERTY_ACCESS <<a.ref>> -> ASSIGNED_FROM -> VARIABLE <<b>>
// FUNCTION <<circularObject>> -> WRITES_TO -> PROPERTY_ACCESS <<a.ref>>
// FUNCTION <<circularObject>> -> RETURNS -> VARIABLE <<a>>
// @end-annotation
function circularObject() {
  const a = {};
  const b = { ref: a };
  a.ref = b;
  return a;
}

// @construct PENDING prop-circular-class
// @annotation
// CLASS <<TreeNode>> -> CONTAINS -> METHOD <<TreeNode.constructor>>
// CLASS <<TreeNode>> -> CONTAINS -> METHOD <<TreeNode.addChild>>
// METHOD <<TreeNode.constructor>> -> CONTAINS -> PARAMETER <<value>>
// METHOD <<TreeNode.constructor>> -> WRITES_TO -> PROPERTY_ACCESS <<this.value>>
// PROPERTY_ACCESS <<this.value>> -> ASSIGNED_FROM -> PARAMETER <<value>>
// METHOD <<TreeNode.constructor>> -> WRITES_TO -> PROPERTY_ACCESS <<this.parent>>
// PROPERTY_ACCESS <<this.parent>> -> ASSIGNED_FROM -> LITERAL <<null>>
// METHOD <<TreeNode.constructor>> -> WRITES_TO -> PROPERTY_ACCESS <<this.children>>
// PROPERTY_ACCESS <<this.children>> -> ASSIGNED_FROM -> LITERAL <<[]>>
// METHOD <<TreeNode.addChild>> -> CONTAINS -> PARAMETER <<child>>
// METHOD <<TreeNode.addChild>> -> WRITES_TO -> PROPERTY_ACCESS <<child.parent>>
// PROPERTY_ACCESS <<child.parent>> -> ASSIGNED_FROM -> METHOD <<TreeNode.addChild>>
// METHOD <<TreeNode.addChild>> -> CONTAINS -> CALL <<this.children.push(child)>>
// CALL <<this.children.push(child)>> -> CALLS -> PROPERTY_ACCESS <<this.children.push>>
// CALL <<this.children.push(child)>> -> PASSES_ARGUMENT -> PARAMETER <<child>>
// PROPERTY_ACCESS <<this.children.push>> -> READS_FROM -> PROPERTY_ACCESS <<this.children>>
// @end-annotation
class TreeNode {
  constructor(value) {
    this.value = value;
    this.parent = null;
    this.children = [];
  }
  addChild(child) {
    child.parent = this;
    this.children.push(child);
  }
}

// --- Symbol as property key ---

// @construct PENDING prop-symbol-key
// @annotation
// FUNCTION <<symbolKey>> -> CONTAINS -> VARIABLE <<sym>>
// FUNCTION <<symbolKey>> -> CONTAINS -> VARIABLE <<obj>>
// VARIABLE <<sym>> -> ASSIGNED_FROM -> CALL <<Symbol('myKey')>>
// CALL <<Symbol('myKey')>> -> PASSES_ARGUMENT -> LITERAL <<'myKey'>>
// VARIABLE <<obj>> -> ASSIGNED_FROM -> EXPRESSION <<{ [sym]: 'symbol value' }>>
// EXPRESSION <<{ [sym]: 'symbol value' }>> -> HAS_PROPERTY -> PROPERTY <<[sym]>>
// PROPERTY <<[sym]>> -> READS_FROM -> VARIABLE <<sym>>
// PROPERTY <<[sym]>> -> ASSIGNED_FROM -> LITERAL <<'symbol value'>>
// FUNCTION <<symbolKey>> -> RETURNS -> PROPERTY_ACCESS <<obj[sym]>>
// PROPERTY_ACCESS <<obj[sym]>> -> READS_FROM -> VARIABLE <<obj>>
// PROPERTY_ACCESS <<obj[sym]>> -> READS_FROM -> VARIABLE <<sym>>
// @end-annotation
function symbolKey() {
  const sym = Symbol('myKey');
  const obj = { [sym]: 'symbol value' };
  return obj[sym];
}

// --- __proto__ direct assignment ---

// @construct PENDING prop-proto-direct
// @annotation
// FUNCTION <<protoDirectAssign>> -> CONTAINS -> VARIABLE <<obj>>
// VARIABLE <<obj>> -> ASSIGNED_FROM -> LITERAL <<{}>>
// PROPERTY_ACCESS <<obj.__proto__>> -> ASSIGNED_FROM -> LITERAL <<{ inherited: true }>>
// FUNCTION <<protoDirectAssign>> -> WRITES_TO -> PROPERTY_ACCESS <<obj.__proto__>>
// FUNCTION <<protoDirectAssign>> -> READS_FROM -> PROPERTY_ACCESS <<obj.inherited>>
// FUNCTION <<protoDirectAssign>> -> RETURNS -> PROPERTY_ACCESS <<obj.inherited>>
// @end-annotation
function protoDirectAssign() {
  const obj = {};
  obj.__proto__ = { inherited: true };
  return obj.inherited;
}

// --- Null-prototype dictionary ---

// @construct PENDING prop-null-proto-dict
// @annotation
// LITERAL <<'key with spaces'>> {value: key with spaces, literalType: string}
// LITERAL <<'another-key'>> {value: another-key, literalType: string}
// FUNCTION <<nullPrototypeDict>> -> CONTAINS -> VARIABLE <<dict>>
// VARIABLE <<dict>> -> ASSIGNED_FROM -> CALL <<Object.create(null)>>
// CALL <<Object.create(null)>> -> CALLS -> PROPERTY_ACCESS <<Object.create>>
// CALL <<Object.create(null)>> -> PASSES_ARGUMENT -> LITERAL <<null>>
// PROPERTY_ACCESS <<dict['key with spaces']>> -> READS_FROM -> VARIABLE <<dict>>
// PROPERTY_ACCESS <<dict['key with spaces']>> -> ASSIGNED_FROM -> LITERAL <<1>>
// PROPERTY_ACCESS <<dict['another-key']>> -> READS_FROM -> VARIABLE <<dict>>
// PROPERTY_ACCESS <<dict['another-key']>> -> ASSIGNED_FROM -> LITERAL <<2>>
// FUNCTION <<nullPrototypeDict>> -> RETURNS -> VARIABLE <<dict>>
// @end-annotation
function nullPrototypeDict() {
  const dict = Object.create(null);
  dict['key with spaces'] = 1;
  dict['another-key'] = 2;
  return dict;
}

// --- Proxy handler traps (full set) ---

// @construct PENDING prop-proxy-traps
// @annotation
// @end-annotation
function proxyFullTraps(target) {
  const handler = {
    get(t, prop, receiver) { return Reflect.get(t, prop, receiver); },
    set(t, prop, value, receiver) { return Reflect.set(t, prop, value, receiver); },
    has(t, prop) { return Reflect.has(t, prop); },
    deleteProperty(t, prop) { return Reflect.deleteProperty(t, prop); },
    apply(t, thisArg, args) { return Reflect.apply(t, thisArg, args); },
    construct(t, args, newTarget) { return Reflect.construct(t, args, newTarget); },
    getPrototypeOf(t) { return Reflect.getPrototypeOf(t); },
    setPrototypeOf(t, proto) { return Reflect.setPrototypeOf(t, proto); },
    isExtensible(t) { return Reflect.isExtensible(t); },
    preventExtensions(t) { return Reflect.preventExtensions(t); },
    getOwnPropertyDescriptor(t, prop) { return Reflect.getOwnPropertyDescriptor(t, prop); },
    defineProperty(t, prop, desc) { return Reflect.defineProperty(t, prop, desc); },
    ownKeys(t) { return Reflect.ownKeys(t); },
  };
  return new Proxy(target, handler);
}

// @construct PENDING prop-proxy-revocable
// @annotation
// CALL <<revoke()>> {callee: revoke}
// FUNCTION <<proxyRevocable>> -> CONTAINS -> VARIABLE <<proxy>>
// FUNCTION <<proxyRevocable>> -> CONTAINS -> VARIABLE <<revoke>>
// VARIABLE <<proxy>> -> ASSIGNED_FROM -> CALL <<Proxy.revocable({}, handler)>>
// VARIABLE <<revoke>> -> ASSIGNED_FROM -> CALL <<Proxy.revocable({}, handler)>>
// CALL <<Proxy.revocable({}, handler)>> -> PASSES_ARGUMENT -> LITERAL <<{}>>
// CALL <<Proxy.revocable({}, handler)>> -> PASSES_ARGUMENT -> FUNCTION <<handler>>
// FUNCTION <<handler>> -> CONTAINS -> METHOD <<handler.get>>
// METHOD <<handler.get>> -> CONTAINS -> PARAMETER <<t>>
// METHOD <<handler.get>> -> CONTAINS -> PARAMETER <<prop>>
// EXPRESSION <<prop in t>> -> READS_FROM -> PARAMETER <<prop>>
// EXPRESSION <<prop in t>> -> READS_FROM -> PARAMETER <<t>>
// PROPERTY_ACCESS <<t[prop]>> -> READS_FROM -> PARAMETER <<t>>
// PROPERTY_ACCESS <<t[prop]>> -> READS_FROM -> PARAMETER <<prop>>
// METHOD <<handler.get>> -> CONTAINS -> EXPRESSION <<prop in t>>
// METHOD <<handler.get>> -> RETURNS -> PROPERTY_ACCESS <<t[prop]>>
// METHOD <<handler.get>> -> RETURNS -> LITERAL <<'default'>>
// PROPERTY_ACCESS <<proxy.x>> -> READS_FROM -> VARIABLE <<proxy>>
// PROPERTY_ACCESS <<proxy.x>> -> ASSIGNED_FROM -> LITERAL <<1>>
// VARIABLE <<val>> -> ASSIGNED_FROM -> PROPERTY_ACCESS <<proxy.x:read>>
// PROPERTY_ACCESS <<proxy.x:read>> -> READS_FROM -> VARIABLE <<proxy>>
// FUNCTION <<proxyRevocable>> -> RETURNS -> VARIABLE <<val>>
// @end-annotation
function proxyRevocable() {
  const { proxy, revoke } = Proxy.revocable({}, {
    get(t, prop) { return prop in t ? t[prop] : 'default'; },
  });
  proxy.x = 1;
  const val = proxy.x;
  revoke();
  return val;
}

// @construct PENDING prop-getter-only-no-setter
// @annotation
// FUNCTION <<getterOnlyNoSetter>> -> CONTAINS -> VARIABLE <<obj>>
// VARIABLE <<obj>> -> ASSIGNED_FROM -> EXPRESSION <<obj-literal>>
// EXPRESSION <<obj-literal>> -> HAS_PROPERTY -> GETTER <<value-getter>>
// GETTER <<value-getter>> -> RETURNS -> LITERAL <<42>>
// PROPERTY_ACCESS <<obj.value-write>> -> READS_FROM -> VARIABLE <<obj>>
// PROPERTY_ACCESS <<obj.value-write>> -> ASSIGNED_FROM -> LITERAL <<99>>
// PROPERTY_ACCESS <<obj.value-read>> -> READS_FROM -> VARIABLE <<obj>>
// PROPERTY_ACCESS <<obj.value-read>> -> INVOKES -> GETTER <<value-getter>>
// FUNCTION <<getterOnlyNoSetter>> -> RETURNS -> PROPERTY_ACCESS <<obj.value-read>>
// @end-annotation
function getterOnlyNoSetter() {
  const obj = {
    get value() { return 42; },
  };
  obj.value = 99; // silently fails in sloppy, throws in strict
  return obj.value; // still 42
}

// @construct PENDING optional-chaining-delete
// @annotation
// FUNCTION <<optionalChainingDelete>> -> CONTAINS -> PARAMETER <<obj>>
// FUNCTION <<optionalChainingDelete>> -> CONTAINS -> VARIABLE <<result>>
// VARIABLE <<result>> -> ASSIGNED_FROM -> EXPRESSION <<delete obj?.prop>>
// EXPRESSION <<delete obj?.prop>> -> DELETES -> PROPERTY_ACCESS <<obj?.prop>>
// PROPERTY_ACCESS <<obj?.prop>> -> READS_FROM -> PARAMETER <<obj>>
// FUNCTION <<optionalChainingDelete>> -> RETURNS -> VARIABLE <<result>>
// @end-annotation
function optionalChainingDelete(obj) {
  const result = delete obj?.prop; // true if obj is nullish (no-op), normal delete otherwise
  return result;
}

// --- Getter side effects in destructuring and spread ---

// @construct PENDING getter-destructuring-side-effect
// @annotation
// FUNCTION <<getterInDestructuring>> -> CONTAINS -> VARIABLE <<callCount>>
// VARIABLE <<callCount>> -> ASSIGNED_FROM -> LITERAL <<0>>
// FUNCTION <<getterInDestructuring>> -> CONTAINS -> VARIABLE <<sneaky>>
// VARIABLE <<sneaky>> -> ASSIGNED_FROM -> EXPRESSION <<sneaky:obj>>
// EXPRESSION <<sneaky:obj>> -> HAS_PROPERTY -> GETTER <<sneaky.value>>
// GETTER <<sneaky.value>> -> RETURNS -> EXPRESSION <<callCount++>>
// EXPRESSION <<callCount++>> -> MODIFIES -> VARIABLE <<callCount>>
// EXPRESSION <<callCount++>> -> READS_FROM -> VARIABLE <<callCount>>
// FUNCTION <<getterInDestructuring>> -> CONTAINS -> VARIABLE <<value>>
// VARIABLE <<value>> -> ASSIGNED_FROM -> EXPRESSION <<{ value }>>
// EXPRESSION <<{ value }>> -> READS_FROM -> VARIABLE <<sneaky>>
// EXPRESSION <<{ value }>> -> INVOKES -> GETTER <<sneaky.value>>
// FUNCTION <<getterInDestructuring>> -> CONTAINS -> VARIABLE <<copy>>
// VARIABLE <<copy>> -> ASSIGNED_FROM -> EXPRESSION <<copy:obj>>
// EXPRESSION <<copy:obj>> -> CONTAINS -> EXPRESSION <<...sneaky>>
// EXPRESSION <<...sneaky>> -> SPREADS_FROM -> VARIABLE <<sneaky>>
// EXPRESSION <<...sneaky>> -> INVOKES -> GETTER <<sneaky.value>>
// FUNCTION <<getterInDestructuring>> -> RETURNS -> EXPRESSION <<return:obj>>
// EXPRESSION <<return:obj>> -> CONTAINS -> VARIABLE <<value>>
// EXPRESSION <<return:obj>> -> CONTAINS -> VARIABLE <<copy>>
// EXPRESSION <<return:obj>> -> CONTAINS -> VARIABLE <<callCount>>
// @end-annotation
function getterInDestructuring() {
  let callCount = 0;
  const sneaky = {
    get value() { callCount++; return callCount; },
  };
  const { value } = sneaky;        // getter fires — callCount incremented
  const copy = { ...sneaky };      // spread triggers ALL getters
  return { value, copy, callCount };
}

// @construct PENDING getter-computed-destructuring
// @annotation
// FUNCTION <<getterComputedDestructuring>> -> CONTAINS -> VARIABLE <<fired>>
// VARIABLE <<fired>> -> ASSIGNED_FROM -> LITERAL <<false>>
// FUNCTION <<getterComputedDestructuring>> -> CONTAINS -> VARIABLE <<obj>>
// VARIABLE <<obj>> -> ASSIGNED_FROM -> EXPRESSION <<obj-literal>>
// EXPRESSION <<obj-literal>> -> HAS_PROPERTY -> GETTER <<obj.secret>>
// GETTER <<obj.secret>> -> WRITES_TO -> VARIABLE <<fired>>
// GETTER <<obj.secret>> -> FLOWS_INTO -> LITERAL <<true>>
// GETTER <<obj.secret>> -> RETURNS -> LITERAL <<42>>
// FUNCTION <<getterComputedDestructuring>> -> CONTAINS -> VARIABLE <<key>>
// VARIABLE <<key>> -> ASSIGNED_FROM -> LITERAL <<'secret'>>
// FUNCTION <<getterComputedDestructuring>> -> CONTAINS -> VARIABLE <<extracted>>
// EXPRESSION <<destructure-obj>> -> READS_FROM -> VARIABLE <<obj>>
// EXPRESSION <<destructure-obj>> -> FLOWS_INTO -> VARIABLE <<extracted>>
// PROPERTY_ACCESS <<obj[key]>> -> READS_FROM -> VARIABLE <<key>>
// PROPERTY_ACCESS <<obj[key]>> -> CALLS -> GETTER <<obj.secret>>
// VARIABLE <<extracted>> -> ASSIGNED_FROM -> PROPERTY_ACCESS <<obj[key]>>
// EXPRESSION <<return-object>> -> HAS_PROPERTY -> VARIABLE <<extracted>>
// EXPRESSION <<return-object>> -> HAS_PROPERTY -> VARIABLE <<fired>>
// EXPRESSION <<return-expression>> -> RETURNS -> EXPRESSION <<return-object>>
// FUNCTION <<getterComputedDestructuring>> -> RETURNS -> EXPRESSION <<return-expression>>
// @end-annotation
function getterComputedDestructuring() {
  let fired = false;
  const obj = {
    get secret() { fired = true; return 42; },
  };
  const key = 'secret';
  const { [key]: extracted } = obj; // getter via computed key
  return { extracted, fired };
}

// @construct PENDING getter-throws-in-destructuring
// @annotation
// FUNCTION <<getterThrowsInDestructuring>> -> CONTAINS -> VARIABLE <<dangerous>>
// VARIABLE <<dangerous>> -> ASSIGNED_FROM -> EXPRESSION <<dangerous:object>>
// EXPRESSION <<dangerous:object>> -> HAS_PROPERTY -> GETTER <<boom:getter>>
// EXPRESSION <<dangerous:object>> -> HAS_PROPERTY -> PROPERTY <<safe:property>>
// GETTER <<boom:getter>> -> HAS_BODY -> EXPRESSION <<throw new Error('trap!')>>
// EXPRESSION <<throw new Error('trap!')>> -> THROWS -> CALL <<new Error('trap!')>>
// CALL <<new Error('trap!')>> -> PASSES_ARGUMENT -> LITERAL <<'trap!'>>
// PROPERTY <<safe:property>> -> ASSIGNED_FROM -> LITERAL <<1>>
// FUNCTION <<getterThrowsInDestructuring>> -> CONTAINS -> TRY_BLOCK <<try-block>>
// TRY_BLOCK <<try-block>> -> HAS_BODY -> EXPRESSION <<{ boom } = dangerous>>
// EXPRESSION <<{ boom } = dangerous>> -> DECLARES -> VARIABLE <<boom>>
// EXPRESSION <<{ boom } = dangerous>> -> READS_FROM -> VARIABLE <<dangerous>>
// EXPRESSION <<{ boom } = dangerous>> -> INVOKES -> GETTER <<boom:getter>>
// TRY_BLOCK <<try-block>> -> HAS_CATCH -> CATCH_BLOCK <<catch-block>>
// CATCH_BLOCK <<catch-block>> -> CONTAINS -> PARAMETER <<e>>
// FUNCTION <<getterThrowsInDestructuring>> -> RETURNS -> PROPERTY_ACCESS <<e.message>>
// PROPERTY_ACCESS <<e.message>> -> READS_FROM -> PARAMETER <<e>>
// @end-annotation
function getterThrowsInDestructuring() {
  const dangerous = {
    get boom() { throw new Error('trap!'); },
    safe: 1,
  };
  try {
    const { boom } = dangerous; // throws during destructuring
  } catch (e) {
    return e.message;
  }
}

// --- Proxy wrapping a class constructor ---

// @construct PENDING proxy-class-constructor
// @annotation
// CLASS <<OriginalClass>> -> CONTAINS -> METHOD <<OriginalClass.constructor>>
// CLASS <<OriginalClass>> -> CONTAINS -> METHOD <<OriginalClass.greet>>
// METHOD <<OriginalClass.constructor>> -> CONTAINS -> PARAMETER <<name>>
// PROPERTY_ACCESS <<this.name>> -> ASSIGNED_FROM -> PARAMETER <<name>>
// METHOD <<OriginalClass.constructor>> -> WRITES_TO -> PROPERTY_ACCESS <<this.name>>
// METHOD <<OriginalClass.greet>> -> RETURNS -> EXPRESSION <<`Hi, ${this.name}`>>
// EXPRESSION <<`Hi, ${this.name}`>> -> READS_FROM -> PROPERTY_ACCESS <<this.name>>
// VARIABLE <<TrackedClass>> -> ASSIGNED_FROM -> CALL <<new Proxy(OriginalClass, {...})>>
// CALL <<new Proxy(OriginalClass, {...})>> -> PASSES_ARGUMENT -> CLASS <<OriginalClass>>
// CALL <<new Proxy(OriginalClass, {...})>> -> PASSES_ARGUMENT -> LITERAL <<proxy-handler>>
// LITERAL <<proxy-handler>> -> HAS_PROPERTY -> METHOD <<construct>>
// METHOD <<construct>> -> CONTAINS -> PARAMETER <<target>>
// METHOD <<construct>> -> CONTAINS -> PARAMETER <<args>>
// METHOD <<construct>> -> CONTAINS -> PARAMETER <<newTarget>>
// METHOD <<construct>> -> RETURNS -> CALL <<Reflect.construct(target, args, newTarget)>>
// CALL <<Reflect.construct(target, args, newTarget)>> -> PASSES_ARGUMENT -> PARAMETER <<target>>
// CALL <<Reflect.construct(target, args, newTarget)>> -> PASSES_ARGUMENT -> PARAMETER <<args>>
// CALL <<Reflect.construct(target, args, newTarget)>> -> PASSES_ARGUMENT -> PARAMETER <<newTarget>>
// VARIABLE <<trackedInstance>> -> ASSIGNED_FROM -> CALL <<new TrackedClass('Alice')>>
// CALL <<new TrackedClass('Alice')>> -> CALLS -> VARIABLE <<TrackedClass>>
// CALL <<new TrackedClass('Alice')>> -> PASSES_ARGUMENT -> LITERAL <<'Alice'>>
// @end-annotation
class OriginalClass {
  constructor(name) { this.name = name; }
  greet() { return `Hi, ${this.name}`; }
}

const TrackedClass = new Proxy(OriginalClass, {
  construct(target, args, newTarget) {
    return Reflect.construct(target, args, newTarget);
  },
});

const trackedInstance = new TrackedClass('Alice');

// --- delete on computed properties ---

// @construct PENDING delete-computed-property
// @annotation
// FUNCTION <<deleteComputed>> -> CONTAINS -> PARAMETER <<obj>>
// FUNCTION <<deleteComputed>> -> CONTAINS -> PARAMETER <<key>>
// FUNCTION <<deleteComputed>> -> CONTAINS -> SIDE_EFFECT <<delete obj[key]>>
// FUNCTION <<deleteComputed>> -> CONTAINS -> SIDE_EFFECT <<delete obj[key.toUpperCase()]>>
// SIDE_EFFECT <<delete obj[key]>> -> DELETES -> PROPERTY_ACCESS <<obj[key]>>
// PROPERTY_ACCESS <<obj[key]>> -> READS_FROM -> PARAMETER <<obj>>
// PROPERTY_ACCESS <<obj[key]>> -> READS_FROM -> PARAMETER <<key>>
// SIDE_EFFECT <<delete obj[key.toUpperCase()]>> -> DELETES -> PROPERTY_ACCESS <<obj[key.toUpperCase()]>>
// PROPERTY_ACCESS <<obj[key.toUpperCase()]>> -> READS_FROM -> PARAMETER <<obj>>
// PROPERTY_ACCESS <<obj[key.toUpperCase()]>> -> READS_FROM -> CALL <<key.toUpperCase()>>
// CALL <<key.toUpperCase()>> -> CALLS -> PROPERTY_ACCESS <<key.toUpperCase>>
// PROPERTY_ACCESS <<key.toUpperCase>> -> READS_FROM -> PARAMETER <<key>>
// @end-annotation
function deleteComputed(obj, key) {
  delete obj[key];               // computed delete — property name unknown at parse time
  delete obj[key.toUpperCase()]; // delete with expression in key
}

// @construct PENDING delete-array-hole
// @annotation
// FUNCTION <<deleteArrayHole>> -> DECLARES -> PARAMETER <<arr>>
// FUNCTION <<deleteArrayHole>> -> CONTAINS -> SIDE_EFFECT <<delete arr[1]>>
// SIDE_EFFECT <<delete arr[1]>> -> DELETES -> PROPERTY_ACCESS <<arr[1]>>
// PROPERTY_ACCESS <<arr[1]>> -> READS_FROM -> PARAMETER <<arr>>
// PROPERTY_ACCESS <<arr[1]>> -> USES -> LITERAL <<1>>
// FUNCTION <<deleteArrayHole>> -> RETURNS -> PARAMETER <<arr>>
// @end-annotation
function deleteArrayHole(arr) {
  delete arr[1];                 // creates a HOLE — arr.length unchanged
  return arr;                    // [1, empty, 3] if arr was [1, 2, 3]
}

// --- Lazy getter self-replacement (memoization via defineProperty) ---

// @construct PENDING lazy-getter-self-replace
// @annotation
// @end-annotation
class LazyConfig {
  get expensive() {
    // Compute once, then replace this accessor with a plain data property
    const result = Array.from({ length: 100 }, (_, i) => i).reduce((a, b) => a + b, 0);
    Object.defineProperty(this, 'expensive', {
      value: result,
      writable: false,
      configurable: false,
    });
    return result;
  }
}

// Module-level lazy property on plain object
const lazyModule = {
  get computed() {
    const val = Math.PI * 2;
    Object.defineProperty(lazyModule, 'computed', { value: val });
    return val;
  },
};

// --- Proxy "method missing" / dynamic API synthesis ---

// @construct PENDING proxy-method-missing
function createApiProxy(baseUrl) {
  // get trap returns a SYNTHESIZED arrow for every property name.
  // No real methods exist on the target — all are generated on access.
  return new Proxy({}, {
    get(target, method) {
      return (...args) => fetch(`${baseUrl}/${String(method)}`, {
        method: 'POST',
        body: JSON.stringify(args),
      });
    },
  });
}

const apiProxy = createApiProxy('/api');
// apiProxy.getUser(1)      → POST /api/getUser  [1]
// apiProxy.createPost({})  → POST /api/createPost  [{}]

// @construct PENDING export-named-list
export {
  dotAccess,
  bracketAccess,
  dynamicAccess,
  deepChain,
  optionalChainMixed,
  dotAssign,
  bracketAssign,
  compoundPropertyAssign,
  objectEnumeration,
  fromEntries,
  objectAssign,
  frozen,
  sealed,
  preventExtensions,
  propertyChecks,
  propertyDeletion,
  enumerationOrder,
  defineAccessor,
  objectIsComparison,
  deepClone,
  getterSideEffect,
  circularObject,
  TreeNode,
  symbolKey,
  protoDirectAssign,
  nullPrototypeDict,
  proxyFullTraps,
  proxyRevocable,
  getterOnlyNoSetter,
  optionalChainingDelete,
  getterInDestructuring,
  getterComputedDestructuring,
  getterThrowsInDestructuring,
  OriginalClass,
  TrackedClass,
  trackedInstance,
  deleteComputed,
  deleteArrayHole,
  LazyConfig,
  lazyModule,
  createApiProxy,
  apiProxy,
};
