// =============================================================================
// prototypes.js — Old-style Inheritance, Constructor Functions, Mixins
// =============================================================================

// --- Constructor function (pre-class) ---

// @construct PENDING proto-constructor-function
// @annotation
// PROPERTY_ACCESS <<Person.prototype>>
// FUNCTION <<Person>> -> HAS_BODY -> PARAMETER <<name>>
// FUNCTION <<Person>> -> HAS_BODY -> PARAMETER <<age>>
// FUNCTION <<Person>> -> WRITES_TO -> PROPERTY_ACCESS <<this.name>>
// FUNCTION <<Person>> -> WRITES_TO -> PROPERTY_ACCESS <<this.age>>
// PROPERTY_ACCESS <<this.name>> -> ASSIGNED_FROM -> PARAMETER <<name>>
// PROPERTY_ACCESS <<this.age>> -> ASSIGNED_FROM -> PARAMETER <<age>>
// PROPERTY_ACCESS <<Person.prototype.greet>> -> ASSIGNED_FROM -> FUNCTION <<greet:fn>>
// FUNCTION <<greet:fn>> -> RETURNS -> EXPRESSION <<`Hi, I'm ${this.name}`>>
// EXPRESSION <<`Hi, I'm ${this.name}`>> -> READS_FROM -> PROPERTY_ACCESS <<this.name>>
// PROPERTY_ACCESS <<Person.prototype.toString>> -> ASSIGNED_FROM -> FUNCTION <<toString:fn>>
// FUNCTION <<toString:fn>> -> RETURNS -> EXPRESSION <<`Person(${this.name}, ${this.age})`>>
// EXPRESSION <<`Person(${this.name}, ${this.age})`>> -> READS_FROM -> PROPERTY_ACCESS <<this.name>>
// EXPRESSION <<`Person(${this.name}, ${this.age})`>> -> READS_FROM -> PROPERTY_ACCESS <<this.age>>
// @end-annotation
function Person(name, age) {
  this.name = name;
  this.age = age;
}

Person.prototype.greet = function () {
  return `Hi, I'm ${this.name}`;
};

Person.prototype.toString = function () {
  return `Person(${this.name}, ${this.age})`;
};

// @construct PENDING proto-static-method
// @annotation
// PROPERTY_ACCESS <<Person.create>> -> ASSIGNED_FROM -> FUNCTION <<Person.create:fn>>
// FUNCTION <<Person.create:fn>> -> CONTAINS -> PARAMETER <<name>>
// FUNCTION <<Person.create:fn>> -> CONTAINS -> PARAMETER <<age>>
// FUNCTION <<Person.create:fn>> -> RETURNS -> CALL <<new Person(name, age)>>
// CALL <<new Person(name, age)>> -> CALLS -> UNKNOWN <<Person>>
// CALL <<new Person(name, age)>> -> PASSES_ARGUMENT -> PARAMETER <<name>>
// CALL <<new Person(name, age)>> -> PASSES_ARGUMENT -> PARAMETER <<age>>
// @end-annotation
Person.create = function (name, age) {
  return new Person(name, age);
};

// --- Prototypal inheritance ---

// @construct PENDING proto-inheritance-chain
// @annotation
// FUNCTION <<Employee>> -> CONTAINS -> PARAMETER <<name>>
// FUNCTION <<Employee>> -> CONTAINS -> PARAMETER <<age>>
// FUNCTION <<Employee>> -> CONTAINS -> PARAMETER <<role>>
// FUNCTION <<Employee>> -> CONTAINS -> CALL <<Person.call(this, name, age)>>
// CALL <<Person.call(this, name, age)>> -> PASSES_ARGUMENT -> PARAMETER <<name>>
// CALL <<Person.call(this, name, age)>> -> PASSES_ARGUMENT -> PARAMETER <<age>>
// PROPERTY_ACCESS <<this.role>> -> ASSIGNED_FROM -> PARAMETER <<role>>
// FUNCTION <<Employee>> -> WRITES_TO -> PROPERTY_ACCESS <<this.role>>
// PROPERTY_ACCESS <<Employee.prototype>> -> ASSIGNED_FROM -> CALL <<Object.create(Person.prototype)>>
// CALL <<Object.create(Person.prototype)>> -> PASSES_ARGUMENT -> PROPERTY_ACCESS <<Person.prototype>>
// PROPERTY_ACCESS <<Employee.prototype>> -> EXTENDS -> PROPERTY_ACCESS <<Person.prototype>>
// PROPERTY_ACCESS <<Employee.prototype.constructor>> -> ASSIGNED_FROM -> FUNCTION <<Employee>>
// PROPERTY_ACCESS <<Employee.prototype>> -> HAS_PROPERTY -> METHOD <<Employee.prototype.describe>>
// METHOD <<Employee.prototype.describe>> -> RETURNS -> EXPRESSION <<template-literal>>
// EXPRESSION <<template-literal>> -> READS_FROM -> CALL <<this.greet()>>
// EXPRESSION <<template-literal>> -> READS_FROM -> PROPERTY_ACCESS <<this.role>>
// CALL <<this.greet()>> -> CALLS_ON -> UNKNOWN <<this>>
// @end-annotation
function Employee(name, age, role) {
  Person.call(this, name, age);
  this.role = role;
}

Employee.prototype = Object.create(Person.prototype);
Employee.prototype.constructor = Employee;

Employee.prototype.describe = function () {
  return `${this.greet()}, I'm a ${this.role}`;
};

// --- Object.create ---

// @construct PENDING proto-object-create
// @annotation
// VARIABLE <<baseProto>> -> ASSIGNED_FROM -> LITERAL <<baseProto:object>>
// LITERAL <<baseProto:object>> -> HAS_PROPERTY -> PROPERTY <<baseProto.type>>
// PROPERTY <<baseProto.type>> -> ASSIGNED_FROM -> LITERAL <<'base'>>
// LITERAL <<baseProto:object>> -> HAS_PROPERTY -> METHOD <<baseProto.identify>>
// METHOD <<baseProto.identify>> -> RETURNS -> PROPERTY_ACCESS <<this.type>>
// METHOD <<baseProto.identify>> -> READS_FROM -> PROPERTY_ACCESS <<this.type>>
// VARIABLE <<derived>> -> ASSIGNED_FROM -> CALL <<Object.create(baseProto)>>
// CALL <<Object.create(baseProto)>> -> PASSES_ARGUMENT -> VARIABLE <<baseProto>>
// VARIABLE <<derived>> -> EXTENDS -> VARIABLE <<baseProto>>
// PROPERTY <<derived.type>> -> ASSIGNED_FROM -> LITERAL <<'derived'>>
// PROPERTY <<derived.extra>> -> ASSIGNED_FROM -> FUNCTION <<derived.extra:fn>>
// FUNCTION <<derived.extra:fn>> -> RETURNS -> LITERAL <<'extra'>>
// @end-annotation
const baseProto = {
  type: 'base',
  identify() {
    return this.type;
  },
};

const derived = Object.create(baseProto);
derived.type = 'derived';
derived.extra = function () {
  return 'extra';
};

// @construct PENDING proto-object-create-null
// @annotation
// UNKNOWN <<MODULE>> -> DECLARES -> VARIABLE <<nullProto>>
// VARIABLE <<nullProto>> -> ASSIGNED_FROM -> CALL <<Object.create(null)>>
// CALL <<Object.create(null)>> -> CALLS -> PROPERTY_ACCESS <<Object.create>>
// CALL <<Object.create(null)>> -> PASSES_ARGUMENT -> LITERAL <<null>>
// PROPERTY_ACCESS <<nullProto.key>> -> ASSIGNED_FROM -> LITERAL <<'value'>>
// UNKNOWN <<MODULE>> -> WRITES_TO -> PROPERTY_ACCESS <<nullProto.key>>
// @end-annotation
const nullProto = Object.create(null);
nullProto.key = 'value';

// --- Prototype chain inspection ---

// @construct PENDING proto-chain-inspection
// @annotation
// FUNCTION <<inspectPrototype>> -> CONTAINS -> PARAMETER <<obj>>
// FUNCTION <<inspectPrototype>> -> CONTAINS -> VARIABLE <<proto>>
// VARIABLE <<proto>> -> ASSIGNED_FROM -> CALL <<Object.getPrototypeOf(obj)>>
// CALL <<Object.getPrototypeOf(obj)>> -> CALLS -> PROPERTY_ACCESS <<Object.getPrototypeOf>>
// CALL <<Object.getPrototypeOf(obj)>> -> PASSES_ARGUMENT -> PARAMETER <<obj>>
// FUNCTION <<inspectPrototype>> -> CONTAINS -> VARIABLE <<hasOwn>>
// VARIABLE <<hasOwn>> -> ASSIGNED_FROM -> CALL <<obj.hasOwnProperty('name')>>
// CALL <<obj.hasOwnProperty('name')>> -> CALLS -> PROPERTY_ACCESS <<obj.hasOwnProperty>>
// CALL <<obj.hasOwnProperty('name')>> -> PASSES_ARGUMENT -> LITERAL <<'name'>>
// FUNCTION <<inspectPrototype>> -> CONTAINS -> VARIABLE <<hasOwn2>>
// VARIABLE <<hasOwn2>> -> ASSIGNED_FROM -> CALL <<Object.hasOwn(obj, 'name')>>
// CALL <<Object.hasOwn(obj, 'name')>> -> CALLS -> PROPERTY_ACCESS <<Object.hasOwn>>
// CALL <<Object.hasOwn(obj, 'name')>> -> PASSES_ARGUMENT -> PARAMETER <<obj>>
// CALL <<Object.hasOwn(obj, 'name')>> -> PASSES_ARGUMENT -> LITERAL <<'name'2>>
// FUNCTION <<inspectPrototype>> -> CONTAINS -> VARIABLE <<inChain>>
// VARIABLE <<inChain>> -> ASSIGNED_FROM -> EXPRESSION <<'toString' in obj>>
// EXPRESSION <<'toString' in obj>> -> READS_FROM -> LITERAL <<'toString'>>
// EXPRESSION <<'toString' in obj>> -> READS_FROM -> PARAMETER <<obj>>
// FUNCTION <<inspectPrototype>> -> RETURNS -> LITERAL <<{...}>>
// LITERAL <<{...}>> -> READS_FROM -> VARIABLE <<proto>>
// LITERAL <<{...}>> -> READS_FROM -> VARIABLE <<hasOwn>>
// LITERAL <<{...}>> -> READS_FROM -> VARIABLE <<hasOwn2>>
// LITERAL <<{...}>> -> READS_FROM -> VARIABLE <<inChain>>
// @end-annotation
function inspectPrototype(obj) {
  const proto = Object.getPrototypeOf(obj);
  const hasOwn = obj.hasOwnProperty('name');
  const hasOwn2 = Object.hasOwn(obj, 'name');
  const inChain = 'toString' in obj;
  return { proto, hasOwn, hasOwn2, inChain };
}

// --- Object.setPrototypeOf ---

// @construct PENDING proto-set-prototype
// @annotation
// FUNCTION <<reparent>> -> HAS_BODY -> PARAMETER <<obj>>
// FUNCTION <<reparent>> -> HAS_BODY -> PARAMETER <<newParent>>
// FUNCTION <<reparent>> -> CONTAINS -> CALL <<Object.setPrototypeOf(obj, newParent)>>
// CALL <<Object.setPrototypeOf(obj, newParent)>> -> CALLS -> PROPERTY_ACCESS <<Object.setPrototypeOf>>
// CALL <<Object.setPrototypeOf(obj, newParent)>> -> PASSES_ARGUMENT -> PARAMETER <<obj>>
// CALL <<Object.setPrototypeOf(obj, newParent)>> -> PASSES_ARGUMENT -> PARAMETER <<newParent>>
// FUNCTION <<reparent>> -> RETURNS -> PARAMETER <<obj>>
// PARAMETER <<obj>> -> MODIFIES -> PARAMETER <<newParent>>
// @end-annotation
function reparent(obj, newParent) {
  Object.setPrototypeOf(obj, newParent);
  return obj;
}

// --- Mixin pattern ---

// @construct PENDING proto-mixin
// @annotation
// @end-annotation
const Serializable = {
  serialize() {
    return JSON.stringify(this);
  },
  deserialize(json) {
    return Object.assign(Object.create(this), JSON.parse(json));
  },
};

const EventEmitterMixin = {
  on(event, handler) {
    if (!this._handlers) this._handlers = {};
    if (!this._handlers[event]) this._handlers[event] = [];
    this._handlers[event].push(handler);
  },
  emit(event, ...args) {
    if (this._handlers?.[event]) {
      this._handlers[event].forEach(h => h(...args));
    }
  },
};

function applyMixins(target, ...mixins) {
  mixins.forEach(mixin => Object.assign(target.prototype, mixin));
}

// @construct PENDING proto-mixin-applied
// @annotation
// FUNCTION <<Widget>> -> CONTAINS -> PARAMETER <<name>>
// PROPERTY_ACCESS <<this.name>> -> ASSIGNED_FROM -> PARAMETER <<name>>
// FUNCTION <<Widget>> -> WRITES_TO -> PROPERTY_ACCESS <<this.name>>
// CALL <<applyMixins(Widget, Serializable, EventEmitterMixin)>> -> CALLS -> EXTERNAL <<applyMixins>>
// CALL <<applyMixins(Widget, Serializable, EventEmitterMixin)>> -> PASSES_ARGUMENT -> FUNCTION <<Widget>>
// CALL <<applyMixins(Widget, Serializable, EventEmitterMixin)>> -> PASSES_ARGUMENT -> EXTERNAL <<Serializable>>
// CALL <<applyMixins(Widget, Serializable, EventEmitterMixin)>> -> PASSES_ARGUMENT -> EXTERNAL <<EventEmitterMixin>>
// FUNCTION <<Widget>> -> DEPENDS_ON -> EXTERNAL <<Serializable>>
// FUNCTION <<Widget>> -> DEPENDS_ON -> EXTERNAL <<EventEmitterMixin>>
// @end-annotation
function Widget(name) {
  this.name = name;
}
applyMixins(Widget, Serializable, EventEmitterMixin);

// --- Property descriptors ---

// @construct PENDING proto-define-property
// @annotation
// FUNCTION <<createReadonly>> -> CONTAINS -> PARAMETER <<obj>>
// FUNCTION <<createReadonly>> -> CONTAINS -> PARAMETER <<prop>>
// FUNCTION <<createReadonly>> -> CONTAINS -> PARAMETER <<value>>
// FUNCTION <<createReadonly>> -> CONTAINS -> CALL <<Object.defineProperty(obj, prop, {...})>>
// CALL <<Object.defineProperty(obj, prop, {...})>> -> CALLS -> PROPERTY_ACCESS <<Object.defineProperty>>
// CALL <<Object.defineProperty(obj, prop, {...})>> -> PASSES_ARGUMENT -> PARAMETER <<obj>>
// CALL <<Object.defineProperty(obj, prop, {...})>> -> PASSES_ARGUMENT -> PARAMETER <<prop>>
// CALL <<Object.defineProperty(obj, prop, {...})>> -> PASSES_ARGUMENT -> EXPRESSION <<descriptor>>
// EXPRESSION <<descriptor>> -> HAS_PROPERTY -> PARAMETER <<value>>
// EXPRESSION <<descriptor>> -> HAS_PROPERTY -> LITERAL <<false>>
// EXPRESSION <<descriptor>> -> HAS_PROPERTY -> LITERAL <<true>>
// FUNCTION <<createReadonly>> -> RETURNS -> PARAMETER <<obj>>
// @end-annotation
function createReadonly(obj, prop, value) {
  Object.defineProperty(obj, prop, {
    value,
    writable: false,
    enumerable: true,
    configurable: false,
  });
  return obj;
}

// @construct PENDING proto-define-getter-setter
// @annotation
// FUNCTION <<withComputedProp>> -> CONTAINS -> PARAMETER <<obj>>
// FUNCTION <<withComputedProp>> -> CONTAINS -> VARIABLE <<_internal>>
// VARIABLE <<_internal>> -> ASSIGNED_FROM -> LITERAL <<0>>
// FUNCTION <<withComputedProp>> -> CONTAINS -> CALL <<Object.defineProperty>>
// CALL <<Object.defineProperty>> -> PASSES_ARGUMENT -> PARAMETER <<obj>>
// CALL <<Object.defineProperty>> -> PASSES_ARGUMENT -> LITERAL <<'computed'>>
// CALL <<Object.defineProperty>> -> PASSES_ARGUMENT -> EXPRESSION <<computed-descriptor>>
// EXPRESSION <<computed-descriptor>> -> HAS_PROPERTY -> GETTER <<computed-getter>>
// EXPRESSION <<computed-descriptor>> -> HAS_PROPERTY -> SETTER <<computed-setter>>
// EXPRESSION <<computed-descriptor>> -> HAS_PROPERTY -> LITERAL <<true-enumerable>>
// EXPRESSION <<computed-descriptor>> -> HAS_PROPERTY -> LITERAL <<true-configurable>>
// GETTER <<computed-getter>> -> RETURNS -> EXPRESSION <<_internal * 2>>
// EXPRESSION <<_internal * 2>> -> READS_FROM -> VARIABLE <<_internal>>
// EXPRESSION <<_internal * 2>> -> READS_FROM -> LITERAL <<2>>
// SETTER <<computed-setter>> -> CONTAINS -> PARAMETER <<v>>
// SETTER <<computed-setter>> -> WRITES_TO -> VARIABLE <<_internal>>
// VARIABLE <<_internal>> -> ASSIGNED_FROM -> PARAMETER <<v>>
// FUNCTION <<withComputedProp>> -> RETURNS -> PARAMETER <<obj>>
// @end-annotation
function withComputedProp(obj) {
  let _internal = 0;
  Object.defineProperty(obj, 'computed', {
    get() { return _internal * 2; },
    set(v) { _internal = v; },
    enumerable: true,
    configurable: true,
  });
  return obj;
}

// @construct PENDING proto-define-properties
// @annotation
// FUNCTION <<defineMultiple>> -> CONTAINS -> PARAMETER <<obj>>
// FUNCTION <<defineMultiple>> -> CONTAINS -> CALL <<Object.defineProperties>>
// CALL <<Object.defineProperties>> -> PASSES_ARGUMENT -> PARAMETER <<obj>>
// CALL <<Object.defineProperties>> -> PASSES_ARGUMENT -> EXPRESSION <<x-descriptor>>
// CALL <<Object.defineProperties>> -> PASSES_ARGUMENT -> EXPRESSION <<y-descriptor>>
// CALL <<Object.defineProperties>> -> PASSES_ARGUMENT -> EXPRESSION <<sum-descriptor>>
// EXPRESSION <<x-descriptor>> -> HAS_PROPERTY -> LITERAL <<10>>
// EXPRESSION <<x-descriptor>> -> HAS_PROPERTY -> LITERAL <<true-writable-x>>
// EXPRESSION <<x-descriptor>> -> HAS_PROPERTY -> LITERAL <<true-enumerable-x>>
// EXPRESSION <<y-descriptor>> -> HAS_PROPERTY -> LITERAL <<20>>
// EXPRESSION <<y-descriptor>> -> HAS_PROPERTY -> LITERAL <<true-writable-y>>
// EXPRESSION <<y-descriptor>> -> HAS_PROPERTY -> LITERAL <<true-enumerable-y>>
// EXPRESSION <<sum-descriptor>> -> HAS_PROPERTY -> GETTER <<sum-getter>>
// EXPRESSION <<sum-descriptor>> -> HAS_PROPERTY -> LITERAL <<true-enumerable-sum>>
// GETTER <<sum-getter>> -> RETURNS -> EXPRESSION <<this.x + this.y>>
// EXPRESSION <<this.x + this.y>> -> READS_FROM -> PROPERTY_ACCESS <<this.x>>
// EXPRESSION <<this.x + this.y>> -> READS_FROM -> PROPERTY_ACCESS <<this.y>>
// FUNCTION <<defineMultiple>> -> RETURNS -> PARAMETER <<obj>>
// @end-annotation
function defineMultiple(obj) {
  Object.defineProperties(obj, {
    x: { value: 10, writable: true, enumerable: true },
    y: { value: 20, writable: true, enumerable: true },
    sum: {
      get() { return this.x + this.y; },
      enumerable: true,
    },
  });
  return obj;
}

// @construct PENDING proto-property-descriptor-read
// @annotation
// FUNCTION <<getDescriptor>> -> HAS_BODY -> PARAMETER <<obj>>
// FUNCTION <<getDescriptor>> -> HAS_BODY -> PARAMETER <<prop>>
// FUNCTION <<getDescriptor>> -> RETURNS -> CALL <<Object.getOwnPropertyDescriptor(obj, prop)>>
// CALL <<Object.getOwnPropertyDescriptor(obj, prop)>> -> CALLS -> PROPERTY_ACCESS <<Object.getOwnPropertyDescriptor>>
// CALL <<Object.getOwnPropertyDescriptor(obj, prop)>> -> PASSES_ARGUMENT -> PARAMETER <<obj>>
// CALL <<Object.getOwnPropertyDescriptor(obj, prop)>> -> PASSES_ARGUMENT -> PARAMETER <<prop>>
// FUNCTION <<getAllDescriptors>> -> HAS_BODY -> PARAMETER <<obj2>>
// FUNCTION <<getAllDescriptors>> -> RETURNS -> CALL <<Object.getOwnPropertyDescriptors(obj)>>
// CALL <<Object.getOwnPropertyDescriptors(obj)>> -> CALLS -> PROPERTY_ACCESS <<Object.getOwnPropertyDescriptors>>
// CALL <<Object.getOwnPropertyDescriptors(obj)>> -> PASSES_ARGUMENT -> PARAMETER <<obj2>>
// @end-annotation
function getDescriptor(obj, prop) {
  return Object.getOwnPropertyDescriptor(obj, prop);
}

function getAllDescriptors(obj) {
  return Object.getOwnPropertyDescriptors(obj);
}

// --- instanceof with Symbol.hasInstance ---

// @construct PENDING proto-symbol-hasinstance
// @annotation
// CLASS <<EvenNumber>> -> CONTAINS -> METHOD <<EvenNumber[Symbol.hasInstance]>>
// METHOD <<EvenNumber[Symbol.hasInstance]>> -> CONTAINS -> PARAMETER <<instance>>
// METHOD <<EvenNumber[Symbol.hasInstance]>> -> RETURNS -> EXPRESSION <<typeof instance === 'number' && instance % 2 === 0>>
// EXPRESSION <<typeof instance === 'number' && instance % 2 === 0>> -> READS_FROM -> PARAMETER <<instance>>
// EXPRESSION <<typeof instance === 'number' && instance % 2 === 0>> -> READS_FROM -> LITERAL <<'number'>>
// EXPRESSION <<typeof instance === 'number' && instance % 2 === 0>> -> READS_FROM -> LITERAL <<2>>
// EXPRESSION <<typeof instance === 'number' && instance % 2 === 0>> -> READS_FROM -> LITERAL <<0>>
// @end-annotation
class EvenNumber {
  static [Symbol.hasInstance](instance) {
    return typeof instance === 'number' && instance % 2 === 0;
  }
}

// --- Monkey-patching ---

// @construct PENDING monkey-patch-builtin
// @annotation
// PROPERTY_ACCESS <<Array.prototype.last>> -> ASSIGNED_FROM -> FUNCTION <<last:fn>>
// FUNCTION <<last:fn>> -> RETURNS -> PROPERTY_ACCESS <<this[this.length - 1]>>
// PROPERTY_ACCESS <<this[this.length - 1]>> -> READS_FROM -> EXPRESSION <<this.length - 1>>
// EXPRESSION <<this.length - 1>> -> READS_FROM -> PROPERTY_ACCESS <<this.length>>
// EXPRESSION <<this.length - 1>> -> READS_FROM -> LITERAL <<1>>
// CALL <<[1, 2, 3].last()>> -> CALLS -> FUNCTION <<last:fn>>
// CALL <<[1, 2, 3].last()>> -> READS_FROM -> LITERAL <<[1, 2, 3]>>
// @end-annotation
Array.prototype.last = function () {
  return this[this.length - 1];
};
[1, 2, 3].last();

// @construct PENDING monkey-patch-third-party
// @annotation
// LITERAL <<'GET '>> {value: GET , literalType: string}
// FUNCTION <<patchRouter>> -> CONTAINS -> PARAMETER <<router>>
// FUNCTION <<patchRouter>> -> DECLARES -> VARIABLE <<originalGet>>
// VARIABLE <<originalGet>> -> ASSIGNED_FROM -> PROPERTY_ACCESS <<router.get>>
// PROPERTY_ACCESS <<router.get>> -> READS_FROM -> PARAMETER <<router>>
// PROPERTY_ACCESS <<router.get>> -> ASSIGNED_FROM -> FUNCTION <<router.get:replacement>>
// FUNCTION <<router.get:replacement>> -> CONTAINS -> PARAMETER <<path>>
// FUNCTION <<router.get:replacement>> -> CONTAINS -> PARAMETER <<handler>>
// FUNCTION <<router.get:replacement>> -> CONTAINS -> CALL <<console.log>>
// CALL <<console.log>> -> PASSES_ARGUMENT -> EXPRESSION <<`GET ${path}`>>
// EXPRESSION <<`GET ${path}`>> -> READS_FROM -> PARAMETER <<path>>
// FUNCTION <<router.get:replacement>> -> RETURNS -> CALL <<originalGet.call>>
// CALL <<originalGet.call>> -> CALLS -> VARIABLE <<originalGet>>
// CALL <<originalGet.call>> -> PASSES_ARGUMENT -> LITERAL <<this>>
// CALL <<originalGet.call>> -> PASSES_ARGUMENT -> PARAMETER <<path>>
// CALL <<originalGet.call>> -> PASSES_ARGUMENT -> PARAMETER <<handler>>
// FUNCTION <<patchRouter>> -> MODIFIES -> PARAMETER <<router>>
// @end-annotation
function patchRouter(router) {
  const originalGet = router.get;
  router.get = function (path, handler) {
    console.log(`GET ${path}`);
    return originalGet.call(this, path, handler);
  };
}

// @construct PENDING monkey-patch-global
// @annotation
// VARIABLE <<originalFetch>> -> ASSIGNED_FROM -> PROPERTY_ACCESS <<globalThis.fetch>>
// PROPERTY_ACCESS <<globalThis.fetch>> -> ASSIGNED_FROM -> CALL <<fetch-proxy>>
// CALL <<fetch-proxy>> -> PASSES_ARGUMENT -> PROPERTY_ACCESS <<globalThis.fetch>>
// CALL <<fetch-proxy>> -> HAS_PROPERTY -> METHOD <<apply-handler>>
// METHOD <<apply-handler>> -> RECEIVES_ARGUMENT -> PARAMETER <<target>>
// METHOD <<apply-handler>> -> RECEIVES_ARGUMENT -> PARAMETER <<thisArg>>
// METHOD <<apply-handler>> -> RECEIVES_ARGUMENT -> PARAMETER <<args>>
// METHOD <<apply-handler>> -> CONTAINS -> CALL <<console.log>>
// METHOD <<apply-handler>> -> RETURNS -> CALL <<Reflect.apply>>
// CALL <<console.log>> -> PASSES_ARGUMENT -> PROPERTY_ACCESS <<args[0]>>
// CALL <<Reflect.apply>> -> PASSES_ARGUMENT -> PARAMETER <<target>>
// CALL <<Reflect.apply>> -> PASSES_ARGUMENT -> PARAMETER <<thisArg>>
// CALL <<Reflect.apply>> -> PASSES_ARGUMENT -> PARAMETER <<args>>
// @end-annotation
const originalFetch = globalThis.fetch;
globalThis.fetch = new Proxy(globalThis.fetch, {
  apply(target, thisArg, args) {
    console.log('intercepted:', args[0]);
    return Reflect.apply(target, thisArg, args);
  },
});

// @construct PENDING super-in-object-literal
// @annotation
// VARIABLE <<parentObj>> -> ASSIGNED_FROM -> EXPRESSION <<parentObj:obj>>
// EXPRESSION <<parentObj:obj>> -> CONTAINS -> METHOD <<parentObj.greet>>
// METHOD <<parentObj.greet>> -> RETURNS -> LITERAL <<'hello from parent'>>
// VARIABLE <<childObj>> -> ASSIGNED_FROM -> EXPRESSION <<childObj:obj>>
// EXPRESSION <<childObj:obj>> -> CONTAINS -> PROPERTY_ACCESS <<__proto__>>
// PROPERTY_ACCESS <<__proto__>> -> ASSIGNED_FROM -> VARIABLE <<parentObj>>
// EXPRESSION <<childObj:obj>> -> EXTENDS -> EXPRESSION <<parentObj:obj>>
// EXPRESSION <<childObj:obj>> -> CONTAINS -> METHOD <<childObj.greet>>
// METHOD <<childObj.greet>> -> RETURNS -> EXPRESSION <<super.greet() + ' and child'>>
// CALL <<super.greet()>> -> CALLS -> METHOD <<parentObj.greet>>
// EXPRESSION <<super.greet() + ' and child'>> -> READS_FROM -> CALL <<super.greet()>>
// EXPRESSION <<super.greet() + ' and child'>> -> READS_FROM -> LITERAL <<' and child'>>
// @end-annotation
const parentObj = {
  greet() { return 'hello from parent'; },
};

const childObj = {
  __proto__: parentObj,
  greet() {
    return super.greet() + ' and child';
  },
};

// @construct PENDING method-vs-function-property-super
// @annotation
// VARIABLE <<superParent>> -> ASSIGNED_FROM -> EXPRESSION <<superParent:obj>>
// EXPRESSION <<superParent:obj>> -> HAS_PROPERTY -> METHOD <<superParent.greet>>
// METHOD <<superParent.greet>> -> RETURNS -> LITERAL <<'parent'>>
// VARIABLE <<superChild>> -> ASSIGNED_FROM -> EXPRESSION <<superChild:obj>>
// EXPRESSION <<superChild:obj>> -> HAS_PROPERTY -> PROPERTY <<__proto__:superParent>>
// PROPERTY <<__proto__:superParent>> -> ASSIGNED_FROM -> EXPRESSION <<superParent:obj>>
// EXPRESSION <<superChild:obj>> -> HAS_PROPERTY -> METHOD <<superChild.shorthand>>
// METHOD <<superChild.shorthand>> -> CONTAINS -> CALL <<super.greet()>>
// CALL <<super.greet()>> -> CALLS -> METHOD <<superParent.greet>>
// METHOD <<superChild.shorthand>> -> RETURNS -> CALL <<super.greet()>>
// EXPRESSION <<superChild:obj>> -> HAS_PROPERTY -> PROPERTY <<superChild.funcProp>>
// PROPERTY <<superChild.funcProp>> -> ASSIGNED_FROM -> FUNCTION <<superChild.funcProp:fn>>
// FUNCTION <<superChild.funcProp:fn>> -> RETURNS -> LITERAL <<'no super access'>>
// EXPRESSION <<superChild:obj>> -> HAS_PROPERTY -> PROPERTY <<superChild.arrowProp>>
// PROPERTY <<superChild.arrowProp>> -> ASSIGNED_FROM -> FUNCTION <<superChild.arrowProp:fn>>
// FUNCTION <<superChild.arrowProp:fn>> -> RETURNS -> LITERAL <<'arrow has no own super'>>
// @end-annotation
const superParent = {
  greet() { return 'parent'; },
};

const superChild = {
  __proto__: superParent,

  // Method shorthand — HAS [[HomeObject]], super works
  shorthand() {
    return super.greet(); // 'parent' ✓
  },

  // Function property — NO [[HomeObject]], super is SyntaxError
  funcProp: function() {
    // super.greet(); // Would be SyntaxError: 'super' keyword unexpected here
    return 'no super access';
  },

  // Arrow property — NO own [[HomeObject]], inherits from defining scope
  arrowProp: () => {
    // super.greet(); // Would use enclosing scope's super, not this object's
    return 'arrow has no own super';
  },
};

// @construct PENDING export-named-list
// @annotation
// EXPORT <<export-named-list>> -> EXPORTS -> VARIABLE <<Person>>
// EXPORT <<export-named-list>> -> EXPORTS -> VARIABLE <<Employee>>
// EXPORT <<export-named-list>> -> EXPORTS -> VARIABLE <<baseProto>>
// EXPORT <<export-named-list>> -> EXPORTS -> VARIABLE <<derived>>
// EXPORT <<export-named-list>> -> EXPORTS -> VARIABLE <<nullProto>>
// EXPORT <<export-named-list>> -> EXPORTS -> VARIABLE <<inspectPrototype>>
// EXPORT <<export-named-list>> -> EXPORTS -> VARIABLE <<reparent>>
// EXPORT <<export-named-list>> -> EXPORTS -> VARIABLE <<Serializable>>
// EXPORT <<export-named-list>> -> EXPORTS -> VARIABLE <<EventEmitterMixin>>
// EXPORT <<export-named-list>> -> EXPORTS -> VARIABLE <<applyMixins>>
// EXPORT <<export-named-list>> -> EXPORTS -> VARIABLE <<Widget>>
// EXPORT <<export-named-list>> -> EXPORTS -> VARIABLE <<createReadonly>>
// EXPORT <<export-named-list>> -> EXPORTS -> VARIABLE <<withComputedProp>>
// EXPORT <<export-named-list>> -> EXPORTS -> VARIABLE <<defineMultiple>>
// EXPORT <<export-named-list>> -> EXPORTS -> VARIABLE <<getDescriptor>>
// EXPORT <<export-named-list>> -> EXPORTS -> VARIABLE <<getAllDescriptors>>
// EXPORT <<export-named-list>> -> EXPORTS -> VARIABLE <<EvenNumber>>
// EXPORT <<export-named-list>> -> EXPORTS -> VARIABLE <<patchRouter>>
// EXPORT <<export-named-list>> -> EXPORTS -> VARIABLE <<originalFetch>>
// EXPORT <<export-named-list>> -> EXPORTS -> VARIABLE <<parentObj>>
// EXPORT <<export-named-list>> -> EXPORTS -> VARIABLE <<childObj>>
// EXPORT <<export-named-list>> -> EXPORTS -> VARIABLE <<superParent>>
// EXPORT <<export-named-list>> -> EXPORTS -> VARIABLE <<superChild>>
// @end-annotation
export {
  Person,
  Employee,
  baseProto,
  derived,
  nullProto,
  inspectPrototype,
  reparent,
  Serializable,
  EventEmitterMixin,
  applyMixins,
  Widget,
  createReadonly,
  withComputedProp,
  defineMultiple,
  getDescriptor,
  getAllDescriptors,
  EvenNumber,
  patchRouter,
  originalFetch,
  parentObj,
  childObj,
  superParent,
  superChild,
};
