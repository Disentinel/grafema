// =============================================================================
// classes.js — Class Declarations, Inheritance, Members
// =============================================================================

// @construct PENDING class-basic
// @annotation
// CLASS <<Animal>> -> CONTAINS -> METHOD <<Animal.constructor>>
// CLASS <<Animal>> -> CONTAINS -> METHOD <<Animal.speak>>
// CLASS <<Animal>> -> CONTAINS -> METHOD <<Animal.toString>>
// CLASS <<Animal>> -> HAS_PROPERTY -> PROPERTY <<Animal.name>>
// CLASS <<Animal>> -> HAS_PROPERTY -> PROPERTY <<Animal.sound>>
// METHOD <<Animal.constructor>> -> RECEIVES_ARGUMENT -> PARAMETER <<name>>
// METHOD <<Animal.constructor>> -> RECEIVES_ARGUMENT -> PARAMETER <<sound>>
// PROPERTY <<Animal.name>> -> ASSIGNED_FROM -> PARAMETER <<name>>
// PROPERTY <<Animal.sound>> -> ASSIGNED_FROM -> PARAMETER <<sound>>
// METHOD <<Animal.speak>> -> RETURNS -> EXPRESSION <<template-literal-speak>>
// EXPRESSION <<template-literal-speak>> -> READS_FROM -> PROPERTY <<Animal.name>>
// EXPRESSION <<template-literal-speak>> -> READS_FROM -> PROPERTY <<Animal.sound>>
// METHOD <<Animal.toString>> -> RETURNS -> EXPRESSION <<template-literal-toString>>
// EXPRESSION <<template-literal-toString>> -> READS_FROM -> PROPERTY <<Animal.name>>
// @end-annotation
class Animal {
  constructor(name, sound) {
    this.name = name;
    this.sound = sound;
  }

  speak() {
    return `${this.name} says ${this.sound}`;
  }

  toString() {
    return `Animal(${this.name})`;
  }
}

// @construct PENDING class-extends-super
// @annotation
// CLASS <<Dog>> -> EXTENDS -> UNKNOWN <<Animal>>
// CLASS <<Dog>> -> CONTAINS -> METHOD <<Dog.constructor>>
// CLASS <<Dog>> -> CONTAINS -> METHOD <<Dog.learn>>
// CLASS <<Dog>> -> CONTAINS -> METHOD <<Dog.speak>>
// METHOD <<Dog.constructor>> -> CONTAINS -> PARAMETER <<name>>
// METHOD <<Dog.constructor>> -> CONTAINS -> CALL <<super(name, 'woof')>>
// CALL <<super(name, 'woof')>> -> PASSES_ARGUMENT -> PARAMETER <<name>>
// CALL <<super(name, 'woof')>> -> PASSES_ARGUMENT -> LITERAL <<'woof'>>
// PROPERTY_ACCESS <<this.tricks>> -> ASSIGNED_FROM -> LITERAL <<[]>>
// METHOD <<Dog.learn>> -> CONTAINS -> PARAMETER <<trick>>
// METHOD <<Dog.learn>> -> CONTAINS -> CALL <<this.tricks.push(trick)>>
// CALL <<this.tricks.push(trick)>> -> PASSES_ARGUMENT -> PARAMETER <<trick>>
// METHOD <<Dog.speak>> -> RETURNS -> EXPRESSION <<`${super.speak()}!`>>
// EXPRESSION <<`${super.speak()}!`>> -> READS_FROM -> CALL <<super.speak()>>
// @end-annotation
class Dog extends Animal {
  constructor(name) {
    super(name, 'woof');
    this.tricks = [];
  }

  learn(trick) {
    this.tricks.push(trick);
  }

  speak() {
    return `${super.speak()}!`;
  }
}

// @construct PENDING class-static-members
// @annotation
// CLASS <<MathUtils>> -> CONTAINS -> PROPERTY <<MathUtils.PI>>
// PROPERTY <<MathUtils.PI>> -> ASSIGNED_FROM -> LITERAL <<3.14159>>
// CLASS <<MathUtils>> -> CONTAINS -> METHOD <<MathUtils.add>>
// METHOD <<MathUtils.add>> -> CONTAINS -> PARAMETER <<a>>
// METHOD <<MathUtils.add>> -> CONTAINS -> PARAMETER <<b>>
// METHOD <<MathUtils.add>> -> RETURNS -> EXPRESSION <<a + b>>
// EXPRESSION <<a + b>> -> READS_FROM -> PARAMETER <<a>>
// EXPRESSION <<a + b>> -> READS_FROM -> PARAMETER <<b>>
// CLASS <<MathUtils>> -> CONTAINS -> METHOD <<MathUtils.#internalHelper>>
// METHOD <<MathUtils.#internalHelper>> -> RETURNS -> LITERAL <<42>>
// CLASS <<MathUtils>> -> CONTAINS -> METHOD <<MathUtils.create>>
// METHOD <<MathUtils.create>> -> RETURNS -> EXPRESSION <<new MathUtils()>>
// EXPRESSION <<new MathUtils()>> -> CALLS -> CLASS <<MathUtils>>
// @end-annotation
class MathUtils {
  static PI = 3.14159;

  static add(a, b) {
    return a + b;
  }

  static #internalHelper() {
    return 42;
  }

  static create() {
    return new MathUtils();
  }
}

// @construct PENDING class-private-fields
// @annotation
// @end-annotation
class BankAccount {
  #balance;
  #owner;

  constructor(owner, initialBalance) {
    this.#owner = owner;
    this.#balance = initialBalance;
  }

  #validate(amount) {
    return amount > 0 && amount <= this.#balance;
  }

  withdraw(amount) {
    if (this.#validate(amount)) {
      this.#balance -= amount;
      return true;
    }
    return false;
  }

  get balance() {
    return this.#balance;
  }
}

// @construct PENDING class-getters-setters
// @annotation
// CLASS <<Temperature>> -> CONTAINS -> PROPERTY <<#celsius>>
// CLASS <<Temperature>> -> CONTAINS -> METHOD <<Temperature.constructor>>
// CLASS <<Temperature>> -> CONTAINS -> GETTER <<Temperature.fahrenheit:getter>>
// CLASS <<Temperature>> -> CONTAINS -> SETTER <<Temperature.fahrenheit:setter>>
// CLASS <<Temperature>> -> CONTAINS -> GETTER <<Temperature.celsius:getter>>
// CLASS <<Temperature>> -> CONTAINS -> SETTER <<Temperature.celsius:setter>>
// METHOD <<Temperature.constructor>> -> CONTAINS -> PARAMETER <<celsius>>
// PROPERTY_ACCESS <<this.#celsius>> -> ASSIGNED_FROM -> PARAMETER <<celsius>>
// METHOD <<Temperature.constructor>> -> WRITES_TO -> PROPERTY_ACCESS <<this.#celsius>>
// GETTER <<Temperature.fahrenheit:getter>> -> RETURNS -> EXPRESSION <<this.#celsius * 9 / 5 + 32>>
// EXPRESSION <<this.#celsius * 9 / 5 + 32>> -> READS_FROM -> PROPERTY_ACCESS <<this.#celsius>>
// SETTER <<Temperature.fahrenheit:setter>> -> CONTAINS -> PARAMETER <<f>>
// SETTER <<Temperature.fahrenheit:setter>> -> WRITES_TO -> PROPERTY_ACCESS <<this.#celsius>>
// PROPERTY_ACCESS <<this.#celsius>> -> ASSIGNED_FROM -> EXPRESSION <<(f - 32) * 5 / 9>>
// EXPRESSION <<(f - 32) * 5 / 9>> -> READS_FROM -> PARAMETER <<f>>
// GETTER <<Temperature.celsius:getter>> -> RETURNS -> PROPERTY_ACCESS <<this.#celsius>>
// SETTER <<Temperature.celsius:setter>> -> CONTAINS -> PARAMETER <<c>>
// SETTER <<Temperature.celsius:setter>> -> WRITES_TO -> PROPERTY_ACCESS <<this.#celsius>>
// PROPERTY_ACCESS <<this.#celsius>> -> ASSIGNED_FROM -> PARAMETER <<c>>
// @end-annotation
class Temperature {
  #celsius;

  constructor(celsius) {
    this.#celsius = celsius;
  }

  get fahrenheit() {
    return this.#celsius * 9 / 5 + 32;
  }

  set fahrenheit(f) {
    this.#celsius = (f - 32) * 5 / 9;
  }

  get celsius() {
    return this.#celsius;
  }

  set celsius(c) {
    this.#celsius = c;
  }
}

// @construct PENDING class-expr-named
// @annotation
// VARIABLE <<NamedClassExpr>> -> ASSIGNED_FROM -> CLASS <<InternalName>>
// CLASS <<InternalName>> -> CONTAINS -> METHOD <<InternalName.constructor>>
// CLASS <<InternalName>> -> CONTAINS -> METHOD <<InternalName.getValue>>
// METHOD <<InternalName.constructor>> -> CONTAINS -> PARAMETER <<value>>
// PROPERTY_ACCESS <<this.value>> -> ASSIGNED_FROM -> PARAMETER <<value>>
// METHOD <<InternalName.constructor>> -> WRITES_TO -> PROPERTY_ACCESS <<this.value>>
// METHOD <<InternalName.getValue>> -> READS_FROM -> PROPERTY_ACCESS <<this.value>>
// METHOD <<InternalName.getValue>> -> RETURNS -> PROPERTY_ACCESS <<this.value>>
// @end-annotation
const NamedClassExpr = class InternalName {
  constructor(value) {
    this.value = value;
  }

  getValue() {
    return this.value;
  }
};

// @construct PENDING class-expr-anonymous
// @annotation
// UNKNOWN <<module>> -> DECLARES -> VARIABLE <<AnonymousClassExpr>>
// VARIABLE <<AnonymousClassExpr>> -> ASSIGNED_FROM -> CLASS <<AnonymousClassExpr:class>>
// CLASS <<AnonymousClassExpr:class>> -> CONTAINS -> METHOD <<AnonymousClassExpr:class.run>>
// METHOD <<AnonymousClassExpr:class.run>> -> RETURNS -> LITERAL <<'running'>>
// @end-annotation
const AnonymousClassExpr = class {
  run() {
    return 'running';
  }
};

// @construct PENDING class-computed-methods
// @annotation
// VARIABLE <<METHOD_KEY>> -> ASSIGNED_FROM -> LITERAL <<'dynamicMethod'>>
// CLASS <<WithComputedMethods>> -> CONTAINS -> METHOD <<WithComputedMethods.[METHOD_KEY]>>
// METHOD <<WithComputedMethods.[METHOD_KEY]>> -> DEPENDS_ON -> VARIABLE <<METHOD_KEY>>
// METHOD <<WithComputedMethods.[METHOD_KEY]>> -> RETURNS -> LITERAL <<'dynamic'>>
// CLASS <<WithComputedMethods>> -> CONTAINS -> METHOD <<WithComputedMethods.[Symbol.toPrimitive]>>
// METHOD <<WithComputedMethods.[Symbol.toPrimitive]>> -> CONTAINS -> PARAMETER <<hint>>
// METHOD <<WithComputedMethods.[Symbol.toPrimitive]>> -> RETURNS -> EXPRESSION <<ternary>>
// EXPRESSION <<ternary>> -> HAS_CONDITION -> EXPRESSION <<hint === 'number'>>
// EXPRESSION <<ternary>> -> HAS_CONSEQUENT -> LITERAL <<42>>
// EXPRESSION <<ternary>> -> HAS_ALTERNATE -> LITERAL <<'string'>>
// EXPRESSION <<hint === 'number'>> -> READS_FROM -> PARAMETER <<hint>>
// EXPRESSION <<hint === 'number'>> -> READS_FROM -> LITERAL <<'number'>>
// @end-annotation
const METHOD_KEY = 'dynamicMethod';

class WithComputedMethods {
  [METHOD_KEY]() {
    return 'dynamic';
  }

  [Symbol.toPrimitive](hint) {
    return hint === 'number' ? 42 : 'string';
  }
}

// @construct PENDING class-static-block
// @annotation
// CLASS <<Config>> -> CONTAINS -> PROPERTY <<Config.defaults>>
// CLASS <<Config>> -> CONTAINS -> STATIC_BLOCK <<Config:static-block>>
// CLASS <<Config>> -> CONTAINS -> METHOD <<Config.constructor>>
// STATIC_BLOCK <<Config:static-block>> -> WRITES_TO -> PROPERTY <<Config.defaults>>
// PROPERTY <<Config.defaults>> -> ASSIGNED_FROM -> LITERAL <<{timeout: 5000, retries: 3}>>
// LITERAL <<{timeout: 5000, retries: 3}>> -> HAS_PROPERTY -> LITERAL <<5000>>
// LITERAL <<{timeout: 5000, retries: 3}>> -> HAS_PROPERTY -> LITERAL <<3>>
// METHOD <<Config.constructor>> -> CONTAINS -> PARAMETER <<overrides>>
// PARAMETER <<overrides>> -> DEFAULTS_TO -> LITERAL <<{}>>
// METHOD <<Config.constructor>> -> WRITES_TO -> PROPERTY_ACCESS <<this.settings>>
// PROPERTY_ACCESS <<this.settings>> -> ASSIGNED_FROM -> EXPRESSION <<{...Config.defaults, ...overrides}>>
// EXPRESSION <<{...Config.defaults, ...overrides}>> -> READS_FROM -> PROPERTY <<Config.defaults>>
// EXPRESSION <<{...Config.defaults, ...overrides}>> -> READS_FROM -> PARAMETER <<overrides>>
// @end-annotation
class Config {
  static defaults;

  static {
    Config.defaults = {
      timeout: 5000,
      retries: 3,
    };
  }

  constructor(overrides = {}) {
    this.settings = { ...Config.defaults, ...overrides };
  }
}

// @construct PENDING class-multi-level-inheritance
// @annotation
// MODULE <<module>> -> DECLARES -> CLASS <<Base>>
// CLASS <<Base>> -> CONTAINS -> METHOD <<Base.baseMethod>>
// METHOD <<Base.baseMethod>> -> RETURNS -> LITERAL <<'base'>>
// MODULE <<module>> -> DECLARES -> CLASS <<Middle>>
// CLASS <<Middle>> -> EXTENDS -> CLASS <<Base>>
// CLASS <<Middle>> -> CONTAINS -> METHOD <<Middle.middleMethod>>
// METHOD <<Middle.middleMethod>> -> RETURNS -> LITERAL <<'middle'>>
// MODULE <<module>> -> DECLARES -> CLASS <<Derived>>
// CLASS <<Derived>> -> EXTENDS -> CLASS <<Middle>>
// CLASS <<Derived>> -> CONTAINS -> METHOD <<Derived.derivedMethod>>
// METHOD <<Derived.derivedMethod>> -> RETURNS -> LITERAL <<'derived'>>
// CLASS <<Derived>> -> CONTAINS -> METHOD <<Derived.allMethods>>
// METHOD <<Derived.allMethods>> -> RETURNS -> EXPRESSION <<[this.baseMethod(), this.middleMethod(), this.derivedMethod()]>>
// EXPRESSION <<[this.baseMethod(), this.middleMethod(), this.derivedMethod()]>> -> HAS_ELEMENT -> CALL <<this.baseMethod()>>
// EXPRESSION <<[this.baseMethod(), this.middleMethod(), this.derivedMethod()]>> -> HAS_ELEMENT -> CALL <<this.middleMethod()>>
// EXPRESSION <<[this.baseMethod(), this.middleMethod(), this.derivedMethod()]>> -> HAS_ELEMENT -> CALL <<this.derivedMethod()>>
// CALL <<this.baseMethod()>> -> CALLS -> METHOD <<Base.baseMethod>>
// CALL <<this.middleMethod()>> -> CALLS -> METHOD <<Middle.middleMethod>>
// CALL <<this.derivedMethod()>> -> CALLS -> METHOD <<Derived.derivedMethod>>
// @end-annotation
class Base {
  baseMethod() {
    return 'base';
  }
}

class Middle extends Base {
  middleMethod() {
    return 'middle';
  }
}

class Derived extends Middle {
  derivedMethod() {
    return 'derived';
  }

  allMethods() {
    return [this.baseMethod(), this.middleMethod(), this.derivedMethod()];
  }
}

// @construct PENDING class-new-target
// @annotation
// CLASS <<AbstractBase>> -> CONTAINS -> METHOD <<AbstractBase.constructor>>
// METHOD <<AbstractBase.constructor>> -> CONTAINS -> BRANCH <<if-new.target>>
// BRANCH <<if-new.target>> -> HAS_CONDITION -> EXPRESSION <<new.target === AbstractBase>>
// EXPRESSION <<new.target === AbstractBase>> -> READS_FROM -> META_PROPERTY <<new.target>>
// EXPRESSION <<new.target === AbstractBase>> -> READS_FROM -> CLASS <<AbstractBase>>
// BRANCH <<if-new.target>> -> HAS_CONSEQUENT -> CALL <<throw new Error>>
// CALL <<throw new Error>> -> PASSES_ARGUMENT -> LITERAL <<'Cannot instantiate AbstractBase directly'>>
// CLASS <<Concrete>> -> EXTENDS -> CLASS <<AbstractBase>>
// CLASS <<Concrete>> -> CONTAINS -> METHOD <<Concrete.constructor>>
// METHOD <<Concrete.constructor>> -> CONTAINS -> CALL <<super()>>
// CALL <<super()>> -> CALLS -> METHOD <<AbstractBase.constructor>>
// @end-annotation
class AbstractBase {
  constructor() {
    if (new.target === AbstractBase) {
      throw new Error('Cannot instantiate AbstractBase directly');
    }
  }
}

class Concrete extends AbstractBase {
  constructor() {
    super();
  }
}

// @construct PENDING mixin-class-expression
// @annotation
// VARIABLE <<Serializable>> -> ASSIGNED_FROM -> FUNCTION <<Serializable:fn>>
// FUNCTION <<Serializable:fn>> -> RECEIVES_ARGUMENT -> PARAMETER <<SuperClass>>
// FUNCTION <<Serializable:fn>> -> RETURNS -> CLASS <<Serializable:class>>
// CLASS <<Serializable:class>> -> EXTENDS -> PARAMETER <<SuperClass>>
// CLASS <<Serializable:class>> -> CONTAINS -> METHOD <<Serializable:class.serialize>>
// METHOD <<Serializable:class.serialize>> -> RETURNS -> CALL <<JSON.stringify(this)>>
// CALL <<JSON.stringify(this)>> -> CALLS -> PROPERTY_ACCESS <<JSON.stringify>>
// CALL <<JSON.stringify(this)>> -> PASSES_ARGUMENT -> VARIABLE <<this>>
// VARIABLE <<Validatable>> -> ASSIGNED_FROM -> FUNCTION <<Validatable:fn>>
// FUNCTION <<Validatable:fn>> -> RECEIVES_ARGUMENT -> PARAMETER <<SuperClass2>>
// FUNCTION <<Validatable:fn>> -> RETURNS -> CLASS <<Validatable:class>>
// CLASS <<Validatable:class>> -> EXTENDS -> PARAMETER <<SuperClass2>>
// CLASS <<Validatable:class>> -> CONTAINS -> METHOD <<Validatable:class.validate>>
// METHOD <<Validatable:class.validate>> -> RETURNS -> LITERAL <<true>>
// @end-annotation
const Serializable = (SuperClass) => class extends SuperClass {
  serialize() { return JSON.stringify(this); }
};

const Validatable = (SuperClass) => class extends SuperClass {
  validate() { return true; }
};

// @construct PENDING mixin-composition
// @annotation
// CLASS <<User>> -> EXTENDS -> CALL <<Serializable(Validatable-result)>>
// CLASS <<User>> -> CONTAINS -> METHOD <<User.greet>>
// CLASS <<anonymous-base>> -> CONTAINS -> METHOD <<anonymous-base.constructor>>
// METHOD <<anonymous-base.constructor>> -> RECEIVES_ARGUMENT -> PARAMETER <<name>>
// PROPERTY_ACCESS <<this.name>> -> ASSIGNED_FROM -> PARAMETER <<name>>
// CALL <<Validatable(anonymous-base)>> -> PASSES_ARGUMENT -> CLASS <<anonymous-base>>
// CALL <<Serializable(Validatable-result)>> -> PASSES_ARGUMENT -> CALL <<Validatable(anonymous-base)>>
// METHOD <<User.greet>> -> RETURNS -> EXPRESSION <<template-literal>>
// EXPRESSION <<template-literal>> -> HAS_ELEMENT -> LITERAL <<'Hi, '>>
// EXPRESSION <<template-literal>> -> READS_FROM -> PROPERTY_ACCESS <<this.name-read>>
// @end-annotation
class User extends Serializable(Validatable(class {
  constructor(name) { this.name = name; }
})) {
  greet() { return `Hi, ${this.name}`; }
}

// @construct PENDING class-inline-new
// @annotation
// UNKNOWN <<module>> -> DECLARES -> VARIABLE <<inlineInstance>>
// VARIABLE <<inlineInstance>> -> ASSIGNED_FROM -> CALL <<new-anonymous-class>>
// CALL <<new-anonymous-class>> -> CALLS -> CLASS <<anonymous-class>>
// CLASS <<anonymous-class>> -> CONTAINS -> METHOD <<anonymous-class.constructor>>
// CLASS <<anonymous-class>> -> CONTAINS -> METHOD <<anonymous-class.getX>>
// METHOD <<anonymous-class.constructor>> -> WRITES_TO -> PROPERTY_ACCESS <<this.x>>
// PROPERTY_ACCESS <<this.x>> -> ASSIGNED_FROM -> LITERAL <<1>>
// METHOD <<anonymous-class.getX>> -> READS_FROM -> PROPERTY_ACCESS <<this.x>>
// METHOD <<anonymous-class.getX>> -> RETURNS -> PROPERTY_ACCESS <<this.x>>
// @end-annotation
const inlineInstance = new (class {
  constructor() { this.x = 1; }
  getX() { return this.x; }
})();

// @construct PENDING class-inline-extends
// @annotation
// VARIABLE <<inlineChild>> -> ASSIGNED_FROM -> CALL <<new (class extends Error {...})('inline error')>>
// CALL <<new (class extends Error {...})('inline error')>> -> CALLS -> CLASS <<anonymous-class>>
// CALL <<new (class extends Error {...})('inline error')>> -> PASSES_ARGUMENT -> LITERAL <<'inline error'>>
// CLASS <<anonymous-class>> -> CONTAINS -> METHOD <<anonymous-class.constructor>>
// METHOD <<anonymous-class.constructor>> -> CONTAINS -> PARAMETER <<msg>>
// METHOD <<anonymous-class.constructor>> -> CONTAINS -> CALL <<super(msg)>>
// CALL <<super(msg)>> -> PASSES_ARGUMENT -> PARAMETER <<msg>>
// METHOD <<anonymous-class.constructor>> -> WRITES_TO -> PROPERTY_ACCESS <<this.custom>>
// PROPERTY_ACCESS <<this.custom>> -> ASSIGNED_FROM -> LITERAL <<true>>
// @end-annotation
const inlineChild = new (class extends Error {
  constructor(msg) { super(msg); this.custom = true; }
})('inline error');

// @construct PENDING in-brand-check
class Branded {
  #secret = true;
  static isBranded(obj) {
    return #secret in obj;
  }
}

// @construct PENDING new-arrow-throws
// @annotation
// UNKNOWN <<module>> -> DECLARES -> VARIABLE <<ArrowNotConstructable>>
// VARIABLE <<ArrowNotConstructable>> -> ASSIGNED_FROM -> FUNCTION <<ArrowNotConstructable:fn>>
// UNKNOWN <<module>> -> DECLARES -> VARIABLE <<methodShorthandObj>>
// VARIABLE <<methodShorthandObj>> -> ASSIGNED_FROM -> LITERAL <<methodShorthandObj:obj>>
// LITERAL <<methodShorthandObj:obj>> -> HAS_PROPERTY -> METHOD <<method>>
// @end-annotation
const ArrowNotConstructable = () => {};
const methodShorthandObj = { method() {} };
// new ArrowNotConstructable(); // TypeError: not a constructor
// new methodShorthandObj.method(); // TypeError: not a constructor

// @construct PENDING class-field-initializer-side-effects
// @annotation
// @end-annotation
let fieldInitOrder = [];

class FieldInit {
  a = (fieldInitOrder.push('a'), 1);
  b = this.a * 2;
  #c = new Map();
  d = this.#computeD();
  static e = FieldInit.#staticHelper();

  #computeD() { return this.a + this.b; }
  static #staticHelper() { return 42; }
}

// @construct PENDING class-constructor-return-non-this
// @annotation
// CLASS <<Singleton>> -> HAS_PROPERTY -> PROPERTY <<Singleton.instance>>
// CLASS <<Singleton>> -> HAS_PROPERTY -> METHOD <<Singleton.constructor>>
// METHOD <<Singleton.constructor>> -> CONTAINS -> BRANCH <<if-instance-exists>>
// BRANCH <<if-instance-exists>> -> HAS_CONDITION -> PROPERTY_ACCESS <<Singleton.instance-read>>
// BRANCH <<if-instance-exists>> -> HAS_CONSEQUENT -> PROPERTY_ACCESS <<Singleton.instance-read>>
// METHOD <<Singleton.constructor>> -> RETURNS -> PROPERTY_ACCESS <<Singleton.instance-read>>
// PROPERTY_ACCESS <<Singleton.instance-read>> -> READS_FROM -> PROPERTY <<Singleton.instance>>
// PROPERTY_ACCESS <<Singleton.instance-write>> -> ASSIGNED_FROM -> LITERAL <<this>>
// METHOD <<Singleton.constructor>> -> WRITES_TO -> PROPERTY_ACCESS <<Singleton.instance-write>>
// PROPERTY_ACCESS <<Singleton.instance-write>> -> WRITES_TO -> PROPERTY <<Singleton.instance>>
// @end-annotation
class Singleton {
  static instance;
  constructor() {
    if (Singleton.instance) return Singleton.instance;
    Singleton.instance = this;
  }
}

// @construct PENDING class-async-method
// @annotation
// CLASS <<ApiClient>> -> CONTAINS -> METHOD <<ApiClient.fetch>>
// CLASS <<ApiClient>> -> CONTAINS -> METHOD <<ApiClient.create>>
// METHOD <<ApiClient.fetch>> -> RECEIVES_ARGUMENT -> PARAMETER <<url>>
// METHOD <<ApiClient.fetch>> -> RETURNS -> PARAMETER <<url>>
// METHOD <<ApiClient.create>> -> RETURNS -> EXPRESSION <<new ApiClient()>>
// EXPRESSION <<new ApiClient()>> -> CALLS -> CLASS <<ApiClient>>
// @end-annotation
class ApiClient {
  async fetch(url) { return url; }
  static async create() { return new ApiClient(); }
}

// @construct PENDING class-generator-method
// @annotation
// CLASS <<Stream>> -> CONTAINS -> PROPERTY <<Stream.data>>
// PROPERTY <<Stream.data>> -> ASSIGNED_FROM -> LITERAL <<[]>>
// CLASS <<Stream>> -> CONTAINS -> METHOD <<Stream.items>>
// CLASS <<Stream>> -> CONTAINS -> METHOD <<Stream.pages>>
// METHOD <<Stream.items>> -> CONTAINS -> LOOP <<for-of-data>>
// LOOP <<for-of-data>> -> ITERATES_OVER -> PROPERTY_ACCESS <<this.data>>
// LOOP <<for-of-data>> -> CONTAINS -> VARIABLE <<item>>
// METHOD <<Stream.items>> -> YIELDS -> EXPRESSION <<yield item>>
// EXPRESSION <<yield item>> -> READS_FROM -> VARIABLE <<item>>
// METHOD <<Stream.pages>> -> DELEGATES_TO -> EXPRESSION <<yield* this.data>>
// EXPRESSION <<yield* this.data>> -> READS_FROM -> PROPERTY_ACCESS <<this.data>>
// @end-annotation
class Stream {
  data = [];
  *items() { for (const item of this.data) yield item; }
  async *pages() { yield* this.data; }
}

// @construct PENDING class-static-getter-setter
// @annotation
// CLASS <<Registry>> -> CONTAINS -> PROPERTY <<Registry.#store>>
// CLASS <<Registry>> -> CONTAINS -> GETTER <<Registry.size>>
// CLASS <<Registry>> -> CONTAINS -> SETTER <<Registry.defaultValue>>
// PROPERTY <<Registry.#store>> -> ASSIGNED_FROM -> CALL <<new Map()>>
// CALL <<new Map()>> -> CALLS -> UNKNOWN <<Map>>
// GETTER <<Registry.size>> -> RETURNS -> PROPERTY_ACCESS <<this.#store.size>>
// PROPERTY_ACCESS <<this.#store.size>> -> READS_FROM -> PROPERTY <<Registry.#store>>
// SETTER <<Registry.defaultValue>> -> CONTAINS -> PARAMETER <<value>>
// SETTER <<Registry.defaultValue>> -> CONTAINS -> CALL <<this.#store.set('default', value)>>
// CALL <<this.#store.set('default', value)>> -> CALLS_ON -> PROPERTY <<Registry.#store>>
// CALL <<this.#store.set('default', value)>> -> PASSES_ARGUMENT -> LITERAL <<'default'>>
// CALL <<this.#store.set('default', value)>> -> PASSES_ARGUMENT -> PARAMETER <<value>>
// @end-annotation
class Registry {
  static #store = new Map();
  static get size() { return this.#store.size; }
  static set defaultValue(value) { this.#store.set('default', value); }
}

// @construct PENDING class-private-cross-instance
// @annotation
// CLASS <<Vec>> -> HAS_PROPERTY -> PROPERTY <<Vec.#x>>
// CLASS <<Vec>> -> HAS_PROPERTY -> PROPERTY <<Vec.#y>>
// CLASS <<Vec>> -> CONTAINS -> METHOD <<Vec.constructor>>
// CLASS <<Vec>> -> CONTAINS -> METHOD <<Vec.equals>>
// METHOD <<Vec.constructor>> -> CONTAINS -> PARAMETER <<x>>
// METHOD <<Vec.constructor>> -> CONTAINS -> PARAMETER <<y>>
// METHOD <<Vec.constructor>> -> WRITES_TO -> PROPERTY_ACCESS <<this.#x>>
// METHOD <<Vec.constructor>> -> WRITES_TO -> PROPERTY_ACCESS <<this.#y>>
// PROPERTY_ACCESS <<this.#x>> -> ACCESSES_PRIVATE -> PROPERTY <<Vec.#x>>
// PROPERTY_ACCESS <<this.#y>> -> ACCESSES_PRIVATE -> PROPERTY <<Vec.#y>>
// PROPERTY_ACCESS <<this.#x>> -> ASSIGNED_FROM -> PARAMETER <<x>>
// PROPERTY_ACCESS <<this.#y>> -> ASSIGNED_FROM -> PARAMETER <<y>>
// METHOD <<Vec.equals>> -> CONTAINS -> PARAMETER <<other>>
// METHOD <<Vec.equals>> -> RETURNS -> EXPRESSION <<equals-return>>
// PROPERTY_ACCESS <<other.#x>> -> ACCESSES_PRIVATE -> PROPERTY <<Vec.#x>>
// PROPERTY_ACCESS <<other.#y>> -> ACCESSES_PRIVATE -> PROPERTY <<Vec.#y>>
// EXPRESSION <<this.#x === other.#x>> -> READS_FROM -> PROPERTY_ACCESS <<this.#x>>
// EXPRESSION <<this.#x === other.#x>> -> READS_FROM -> PROPERTY_ACCESS <<other.#x>>
// EXPRESSION <<this.#y === other.#y>> -> READS_FROM -> PROPERTY_ACCESS <<this.#y>>
// EXPRESSION <<this.#y === other.#y>> -> READS_FROM -> PROPERTY_ACCESS <<other.#y>>
// EXPRESSION <<equals-return>> -> READS_FROM -> EXPRESSION <<this.#x === other.#x>>
// EXPRESSION <<equals-return>> -> READS_FROM -> EXPRESSION <<this.#y === other.#y>>
// @end-annotation
class Vec {
  #x; #y;
  constructor(x, y) { this.#x = x; this.#y = y; }
  equals(other) {
    return this.#x === other.#x && this.#y === other.#y;
  }
}

// @construct PENDING class-field-no-initializer
// @annotation
// UNKNOWN <<module>> -> DECLARES -> CLASS <<Form>>
// CLASS <<Form>> -> CONTAINS -> PROPERTY <<Form.errors>>
// CLASS <<Form>> -> CONTAINS -> PROPERTY <<Form.count>>
// @end-annotation
class Form {
  errors;
  static count;
}

// --- Dynamic super property access ---

// @construct PENDING super-computed-access
// @annotation
// CLASS <<DynamicChild>> -> CONTAINS -> METHOD <<DynamicChild.callDynamic>>
// CLASS <<DynamicChild>> -> CONTAINS -> METHOD <<DynamicChild.delegateAll>>
// METHOD <<DynamicChild.callDynamic>> -> CONTAINS -> PARAMETER <<methodName>>
// PROPERTY_ACCESS <<super[methodName]>> -> READS_FROM -> PARAMETER <<methodName>>
// CALL <<super[methodName]()>> -> CALLS -> PROPERTY_ACCESS <<super[methodName]>>
// METHOD <<DynamicChild.callDynamic>> -> RETURNS -> CALL <<super[methodName]()>>
// METHOD <<DynamicChild.delegateAll>> -> CONTAINS -> PARAMETER <<methods>>
// CALL <<methods.map(m => super[m]())>> -> CALLS_ON -> PARAMETER <<methods>>
// CALL <<methods.map(m => super[m]())>> -> PASSES_ARGUMENT -> FUNCTION <<m => super[m]()>>
// METHOD <<DynamicChild.delegateAll>> -> RETURNS -> CALL <<methods.map(m => super[m]())>>
// FUNCTION <<m => super[m]()>> -> CONTAINS -> PARAMETER <<m>>
// PROPERTY_ACCESS <<super[m]>> -> READS_FROM -> PARAMETER <<m>>
// CALL <<super[m]()>> -> CALLS -> PROPERTY_ACCESS <<super[m]>>
// FUNCTION <<m => super[m]()>> -> RETURNS -> CALL <<super[m]()>>
// @end-annotation
class DynamicChild extends Animal {
  callDynamic(methodName) {
    return super[methodName](); // dynamic dispatch through prototype chain
  }
  delegateAll(methods) {
    return methods.map(m => super[m]());
  }
}

// --- Method chaining / fluent API ---

// @construct PENDING method-chaining-builder
// @annotation
// @end-annotation
class QueryBuilder {
  #table; #conditions = []; #ordering; #limit;
  from(table) { this.#table = table; return this; }
  where(condition) { this.#conditions.push(condition); return this; }
  orderBy(field) { this.#ordering = field; return this; }
  limit(n) { this.#limit = n; return this; }
  build() { return { table: this.#table, conditions: this.#conditions, ordering: this.#ordering, limit: this.#limit }; }
}

// @construct PENDING method-chaining-usage
// @annotation
// VARIABLE <<chainedQuery>> -> ASSIGNED_FROM -> CALL <<.build()>>
// CALL <<new QueryBuilder()>> -> CALLS -> UNKNOWN <QueryBuilder>
// CALL <<.from('users')>> -> CHAINS_FROM -> CALL <<new QueryBuilder()>>
// CALL <<.from('users')>> -> PASSES_ARGUMENT -> LITERAL <<'users'>>
// CALL <<.where('age > 18')>> -> CHAINS_FROM -> CALL <<.from('users')>>
// CALL <<.where('age > 18')>> -> PASSES_ARGUMENT -> LITERAL <<'age > 18'>>
// CALL <<.orderBy('name')>> -> CHAINS_FROM -> CALL <<.where('age > 18')>>
// CALL <<.orderBy('name')>> -> PASSES_ARGUMENT -> LITERAL <<'name'>>
// CALL <<.limit(10)>> -> CHAINS_FROM -> CALL <<.orderBy('name')>>
// CALL <<.limit(10)>> -> PASSES_ARGUMENT -> LITERAL <<10>>
// CALL <<.build()>> -> CHAINS_FROM -> CALL <<.limit(10)>>
// @end-annotation
const chainedQuery = new QueryBuilder()
  .from('users')
  .where('age > 18')
  .orderBy('name')
  .limit(10)
  .build();

// @construct PENDING method-chaining-array
// @annotation
// @end-annotation
const chainedArray = [3, 1, 4, 1, 5, 9]
  .filter(x => x > 2)
  .map(x => x * 10)
  .sort((a, b) => a - b)
  .slice(0, 3);

// @construct PENDING super-in-arrow-callback
// @annotation
// CLASS <<ParentProcessor>> -> CONTAINS -> METHOD <<ParentProcessor.transform>>
// METHOD <<ParentProcessor.transform>> -> HAS_BODY -> PARAMETER <<item>>
// METHOD <<ParentProcessor.transform>> -> RETURNS -> EXPRESSION <<{ ...item, processed: true }>>
// EXPRESSION <<{ ...item, processed: true }>> -> READS_FROM -> PARAMETER <<item>>
// CLASS <<ParentProcessor>> -> CONTAINS -> METHOD <<ParentProcessor.cleanup>>
// METHOD <<ParentProcessor.cleanup>> -> RETURNS -> LITERAL <<'cleaned'>>
// CLASS <<ChildProcessor>> -> EXTENDS -> CLASS <<ParentProcessor>>
// CLASS <<ChildProcessor>> -> CONTAINS -> METHOD <<ChildProcessor.processAll>>
// METHOD <<ChildProcessor.processAll>> -> HAS_BODY -> PARAMETER <<items>>
// METHOD <<ChildProcessor.processAll>> -> RETURNS -> CALL <<items.map(...)>>
// CALL <<items.map(...)>> -> CALLS_ON -> PARAMETER <<items>>
// CALL <<items.map(...)>> -> PASSES_ARGUMENT -> FUNCTION <<arrow-fn-1>>
// FUNCTION <<arrow-fn-1>> -> HAS_BODY -> PARAMETER <<item-2>>
// FUNCTION <<arrow-fn-1>> -> RETURNS -> CALL <<super.transform(item)>>
// CALL <<super.transform(item)>> -> CALLS -> METHOD <<ParentProcessor.transform>>
// CALL <<super.transform(item)>> -> PASSES_ARGUMENT -> PARAMETER <<item-2>>
// FUNCTION <<arrow-fn-1>> -> CAPTURES -> CLASS <<ChildProcessor>>
// CLASS <<ChildProcessor>> -> CONTAINS -> METHOD <<ChildProcessor.delayed>>
// METHOD <<ChildProcessor.delayed>> -> HAS_BODY -> CALL <<setTimeout(...)>>
// CALL <<setTimeout(...)>> -> PASSES_ARGUMENT -> FUNCTION <<arrow-fn-2>>
// CALL <<setTimeout(...)>> -> PASSES_ARGUMENT -> LITERAL <<100>>
// FUNCTION <<arrow-fn-2>> -> HAS_BODY -> CALL <<super.cleanup()>>
// CALL <<super.cleanup()>> -> CALLS -> METHOD <<ParentProcessor.cleanup>>
// FUNCTION <<arrow-fn-2>> -> CAPTURES -> CLASS <<ChildProcessor>>
// @end-annotation
class ParentProcessor {
  transform(item) { return { ...item, processed: true }; }
  cleanup() { return 'cleaned'; }
}

class ChildProcessor extends ParentProcessor {
  processAll(items) {
    return items.map(item => {
      return super.transform(item);     // super captured via arrow
    });
  }

  delayed() {
    setTimeout(() => {
      super.cleanup();                   // super in async callback arrow
    }, 100);
  }
}

// @construct PENDING super-in-nested-arrows
// @annotation
// CLASS <<DeepSuper>> -> EXTENDS -> EXTERNAL <<ParentProcessor>>
// CLASS <<DeepSuper>> -> CONTAINS -> METHOD <<DeepSuper.deepProcess>>
// CLASS <<DeepSuper>> -> CONTAINS -> METHOD <<DeepSuper.validate>>
// METHOD <<DeepSuper.deepProcess>> -> CONTAINS -> PARAMETER <<items>>
// METHOD <<DeepSuper.deepProcess>> -> RETURNS -> CALL <<items.map(...)>>
// CALL <<items.map(...)>> -> CALLS_ON -> PARAMETER <<items>>
// CALL <<items.map(...)>> -> PASSES_ARGUMENT -> FUNCTION <<map-callback>>
// FUNCTION <<map-callback>> -> CONTAINS -> PARAMETER <<item>>
// FUNCTION <<map-callback>> -> RETURNS -> CALL <<this.validate(item)>>
// CALL <<this.validate(item)>> -> CALLS -> METHOD <<DeepSuper.validate>>
// CALL <<this.validate(item)>> -> PASSES_ARGUMENT -> PARAMETER <<item>>
// CALL <<...then(...)>> -> CALLS_ON -> CALL <<this.validate(item)>>
// CALL <<...then(...)>> -> PASSES_ARGUMENT -> FUNCTION <<then-callback>>
// FUNCTION <<then-callback>> -> CONTAINS -> PARAMETER <<valid>>
// FUNCTION <<then-callback>> -> RETURNS -> CALL <<super.transform(valid)>>
// CALL <<super.transform(valid)>> -> CALLS_ON -> EXTERNAL <<ParentProcessor>>
// CALL <<super.transform(valid)>> -> PASSES_ARGUMENT -> PARAMETER <<valid>>
// METHOD <<DeepSuper.validate>> -> CONTAINS -> PARAMETER <<item-validate>>
// METHOD <<DeepSuper.validate>> -> RETURNS -> CALL <<Promise.resolve(item)>>
// CALL <<Promise.resolve(item)>> -> CALLS_ON -> EXTERNAL <<Promise>>
// CALL <<Promise.resolve(item)>> -> PASSES_ARGUMENT -> PARAMETER <<item-validate>>
// @end-annotation
class DeepSuper extends ParentProcessor {
  deepProcess(items) {
    return items.map(item => {
      return this.validate(item).then(valid => {
        return super.transform(valid);   // super through 2 levels of arrows
      });
    });
  }
  validate(item) { return Promise.resolve(item); }
}

// @construct PENDING computed-class-member-side-effect
// @annotation
// VARIABLE <<classFieldId>> -> ASSIGNED_FROM -> LITERAL <<0>>
// CLASS <<AutoIdFields>> -> CONTAINS -> PROPERTY <<AutoIdFields[computed1]>>
// CLASS <<AutoIdFields>> -> CONTAINS -> PROPERTY <<AutoIdFields[computed2]>>
// CLASS <<AutoIdFields>> -> CONTAINS -> METHOD <<AutoIdFields[computedMethod]>>
// PROPERTY <<AutoIdFields[computed1]>> -> ASSIGNED_FROM -> LITERAL <<'first'>>
// EXPRESSION <<`field_${classFieldId++}`_1>> -> READS_FROM -> VARIABLE <<classFieldId>>
// EXPRESSION <<`field_${classFieldId++}`_1>> -> MODIFIES -> VARIABLE <<classFieldId>>
// PROPERTY <<AutoIdFields[computed2]>> -> ASSIGNED_FROM -> LITERAL <<'second'>>
// EXPRESSION <<`field_${classFieldId++}`_2>> -> READS_FROM -> VARIABLE <<classFieldId>>
// EXPRESSION <<`field_${classFieldId++}`_2>> -> MODIFIES -> VARIABLE <<classFieldId>>
// METHOD <<AutoIdFields[computedMethod]>> -> RETURNS -> LITERAL <<'dynamic'>>
// EXPRESSION <<`method_${classFieldId++}`>> -> READS_FROM -> VARIABLE <<classFieldId>>
// EXPRESSION <<`method_${classFieldId++}`>> -> MODIFIES -> VARIABLE <<classFieldId>>
// @end-annotation
let classFieldId = 0;
class AutoIdFields {
  [`field_${classFieldId++}`] = 'first';
  [`field_${classFieldId++}`] = 'second';
  [`method_${classFieldId++}`]() { return 'dynamic'; }
}

// @construct PENDING destructure-assign-to-this
// @annotation
// CLASS <<ComponentState>> -> CONTAINS -> PROPERTY <<ComponentState.width>>
// CLASS <<ComponentState>> -> CONTAINS -> PROPERTY <<ComponentState.height>>
// CLASS <<ComponentState>> -> CONTAINS -> METHOD <<ComponentState.update>>
// PROPERTY <<ComponentState.width>> -> ASSIGNED_FROM -> LITERAL <<0>>
// PROPERTY <<ComponentState.height>> -> ASSIGNED_FROM -> LITERAL <<0>>
// METHOD <<ComponentState.update>> -> CONTAINS -> PARAMETER <<props>>
// METHOD <<ComponentState.update>> -> CONTAINS -> EXPRESSION <<destructure-props>>
// EXPRESSION <<destructure-props>> -> READS_FROM -> PROPERTY_ACCESS <<props.width>>
// EXPRESSION <<destructure-props>> -> READS_FROM -> PROPERTY_ACCESS <<props.height>>
// EXPRESSION <<destructure-props>> -> WRITES_TO -> PROPERTY_ACCESS <<this.width>>
// EXPRESSION <<destructure-props>> -> WRITES_TO -> PROPERTY_ACCESS <<this.height>>
// PROPERTY_ACCESS <<this.width>> -> MODIFIES -> PROPERTY <<ComponentState.width>>
// PROPERTY_ACCESS <<this.height>> -> MODIFIES -> PROPERTY <<ComponentState.height>>
// @end-annotation
class ComponentState {
  width = 0;
  height = 0;

  update(props) {
    ({ width: this.width, height: this.height } = props);
  }
}

// @construct PENDING destructure-assign-to-this-defaults
// @annotation
// CLASS <<ConfigFromOpts>> -> CONTAINS -> PROPERTY <<ConfigFromOpts.host>>
// CLASS <<ConfigFromOpts>> -> CONTAINS -> PROPERTY <<ConfigFromOpts.port>>
// CLASS <<ConfigFromOpts>> -> CONTAINS -> METHOD <<ConfigFromOpts.constructor>>
// PROPERTY <<ConfigFromOpts.host>> -> ASSIGNED_FROM -> LITERAL <<''>>
// PROPERTY <<ConfigFromOpts.port>> -> ASSIGNED_FROM -> LITERAL <<3000>>
// METHOD <<ConfigFromOpts.constructor>> -> CONTAINS -> PARAMETER <<opts>>
// METHOD <<ConfigFromOpts.constructor>> -> CONTAINS -> EXPRESSION <<destructure-opts>>
// EXPRESSION <<destructure-opts>> -> READS_FROM -> PARAMETER <<opts>>
// EXPRESSION <<destructure-opts>> -> WRITES_TO -> PROPERTY_ACCESS <<this.host>>
// EXPRESSION <<destructure-opts>> -> WRITES_TO -> PROPERTY_ACCESS <<this.port>>
// PROPERTY_ACCESS <<this.port>> -> DEFAULTS_TO -> LITERAL <<3000-default>>
// @end-annotation
class ConfigFromOpts {
  host = '';
  port = 3000;

  constructor(opts) {
    ({ host: this.host, port: this.port = 3000 } = opts);
  }
}

// @construct PENDING default-param-this-access
// @annotation
// CLASS <<ServiceWithDefaults>> -> CONTAINS -> PROPERTY <<ServiceWithDefaults.defaultTimeout>>
// CLASS <<ServiceWithDefaults>> -> CONTAINS -> PROPERTY <<ServiceWithDefaults.baseUrl>>
// CLASS <<ServiceWithDefaults>> -> CONTAINS -> METHOD <<ServiceWithDefaults.fetch>>
// PROPERTY <<ServiceWithDefaults.defaultTimeout>> -> ASSIGNED_FROM -> LITERAL <<5000>>
// PROPERTY <<ServiceWithDefaults.baseUrl>> -> ASSIGNED_FROM -> LITERAL <<'/api'>>
// METHOD <<ServiceWithDefaults.fetch>> -> CONTAINS -> PARAMETER <<url>>
// METHOD <<ServiceWithDefaults.fetch>> -> CONTAINS -> PARAMETER <<timeout>>
// PARAMETER <<timeout>> -> DEFAULTS_TO -> PROPERTY_ACCESS <<this.defaultTimeout>>
// PROPERTY_ACCESS <<this.defaultTimeout>> -> READS_FROM -> PROPERTY <<ServiceWithDefaults.defaultTimeout>>
// EXPRESSION <<this.baseUrl + url>> -> READS_FROM -> PROPERTY_ACCESS <<this.baseUrl>>
// EXPRESSION <<this.baseUrl + url>> -> READS_FROM -> PARAMETER <<url>>
// PROPERTY_ACCESS <<this.baseUrl>> -> READS_FROM -> PROPERTY <<ServiceWithDefaults.baseUrl>>
// EXPRESSION <<{ url: this.baseUrl + url, timeout }>> -> HAS_PROPERTY -> EXPRESSION <<this.baseUrl + url>>
// EXPRESSION <<{ url: this.baseUrl + url, timeout }>> -> HAS_PROPERTY -> PARAMETER <<timeout>>
// METHOD <<ServiceWithDefaults.fetch>> -> RETURNS -> EXPRESSION <<{ url: this.baseUrl + url, timeout }>>
// @end-annotation
class ServiceWithDefaults {
  defaultTimeout = 5000;
  baseUrl = '/api';

  fetch(url, timeout = this.defaultTimeout) {
    return { url: this.baseUrl + url, timeout };
  }
}

// @construct PENDING object-assign-this
// @annotation
// CLASS <<MergeConfig>> -> CONTAINS -> METHOD <<MergeConfig.constructor>>
// METHOD <<MergeConfig.constructor>> -> CONTAINS -> PARAMETER <<opts>>
// METHOD <<MergeConfig.constructor>> -> CONTAINS -> CALL <<Object.assign(this, opts)>>
// CALL <<Object.assign(this, opts)>> -> CALLS -> PROPERTY_ACCESS <<Object.assign>>
// CALL <<Object.assign(this, opts)>> -> PASSES_ARGUMENT -> PARAMETER <<opts>>
// CLASS <<MergeConfigDefaults>> -> CONTAINS -> METHOD <<MergeConfigDefaults.constructor>>
// METHOD <<MergeConfigDefaults.constructor>> -> CONTAINS -> PARAMETER <<defaults>>
// METHOD <<MergeConfigDefaults.constructor>> -> CONTAINS -> PARAMETER <<overrides>>
// METHOD <<MergeConfigDefaults.constructor>> -> CONTAINS -> CALL <<Object.assign(this, defaults, overrides)>>
// CALL <<Object.assign(this, defaults, overrides)>> -> CALLS -> PROPERTY_ACCESS <<Object.assign>>
// CALL <<Object.assign(this, defaults, overrides)>> -> PASSES_ARGUMENT -> PARAMETER <<defaults>>
// CALL <<Object.assign(this, defaults, overrides)>> -> PASSES_ARGUMENT -> PARAMETER <<overrides>>
// @end-annotation
class MergeConfig {
  constructor(opts) {
    Object.assign(this, opts);           // copies ALL properties from opts
  }
}

class MergeConfigDefaults {
  constructor(defaults, overrides) {
    Object.assign(this, defaults, overrides); // merge with precedence
  }
}

// --- super in static context ---

// @construct PENDING super-in-static-method
// @annotation
// CLASS <<StaticParent>> -> CONTAINS -> METHOD <<StaticParent.defaultConfig>>
// CLASS <<StaticParent>> -> CONTAINS -> PROPERTY <<StaticParent.instances>>
// METHOD <<StaticParent.defaultConfig>> -> RETURNS -> LITERAL <<{ timeout: 5000 }>>
// PROPERTY <<StaticParent.instances>> -> ASSIGNED_FROM -> LITERAL <<[]>>
// CLASS <<StaticChild>> -> EXTENDS -> CLASS <<StaticParent>>
// CLASS <<StaticChild>> -> CONTAINS -> METHOD <<StaticChild.defaultConfig>>
// CLASS <<StaticChild>> -> CONTAINS -> PROPERTY <<StaticChild.allInstances>>
// METHOD <<StaticChild.defaultConfig>> -> CONTAINS -> VARIABLE <<base>>
// VARIABLE <<base>> -> ASSIGNED_FROM -> CALL <<super.defaultConfig()>>
// CALL <<super.defaultConfig()>> -> CALLS -> METHOD <<StaticParent.defaultConfig>>
// METHOD <<StaticChild.defaultConfig>> -> RETURNS -> EXPRESSION <<{ ...base, retries: 3 }>>
// EXPRESSION <<{ ...base, retries: 3 }>> -> READS_FROM -> VARIABLE <<base>>
// PROPERTY <<StaticChild.allInstances>> -> ASSIGNED_FROM -> EXPRESSION <<[...super.instances]>>
// EXPRESSION <<[...super.instances]>> -> READS_FROM -> PROPERTY_ACCESS <<super.instances>>
// PROPERTY_ACCESS <<super.instances>> -> READS_FROM -> PROPERTY <<StaticParent.instances>>
// @end-annotation
class StaticParent {
  static defaultConfig() { return { timeout: 5000 }; }
  static instances = [];
}

class StaticChild extends StaticParent {
  static defaultConfig() {
    const base = super.defaultConfig(); // super = StaticParent (constructor, not prototype)
    return { ...base, retries: 3 };
  }

  static allInstances = [...super.instances]; // super in static field initializer
}

// --- super in field initializers ---

// @construct PENDING super-in-field-initializer
// @annotation
// CLASS <<FieldParent>> -> CONTAINS -> METHOD <<FieldParent.getDefaults>>
// METHOD <<FieldParent.getDefaults>> -> RETURNS -> LITERAL <<{ timeout: 5000 }>>
// CLASS <<FieldChild>> -> EXTENDS -> CLASS <<FieldParent>>
// CLASS <<FieldChild>> -> CONTAINS -> PROPERTY <<FieldChild.defaults>>
// PROPERTY <<FieldChild.defaults>> -> ASSIGNED_FROM -> CALL <<super.getDefaults()>>
// CALL <<super.getDefaults()>> -> CALLS -> PROPERTY_ACCESS <<super.getDefaults>>
// PROPERTY_ACCESS <<super.getDefaults>> -> RESOLVES_TO -> METHOD <<FieldParent.getDefaults>>
// @end-annotation
class FieldParent {
  getDefaults() { return { timeout: 5000 }; }
}

class FieldChild extends FieldParent {
  defaults = super.getDefaults(); // super in instance field initializer
}

// --- Interleaved static blocks and static fields ---

// @construct PENDING static-block-interleaved
// @annotation
// @end-annotation
class InterleavedStatic {
  static debug = false;

  static {
    if (typeof process !== 'undefined') InterleavedStatic.debug = true;
  }

  static logLevel = InterleavedStatic.debug ? 'verbose' : 'error';

  static {
    InterleavedStatic.ready = true;
  }

  static cache = InterleavedStatic.debug ? new Map() : null;
}

// --- Private field + Proxy incompatibility ---

// @construct PENDING private-field-proxy-trap
// @annotation
// CLASS <<SecureService>> -> HAS_PROPERTY -> PROPERTY <<#secret>>
// PROPERTY <<#secret>> -> ASSIGNED_FROM -> LITERAL <<42>>
// CLASS <<SecureService>> -> CONTAINS -> METHOD <<SecureService.getSecret>>
// METHOD <<SecureService.getSecret>> -> RETURNS -> PROPERTY_ACCESS <<this.#secret>>
// PROPERTY_ACCESS <<this.#secret>> -> READS_FROM -> PROPERTY <<#secret>>
// FUNCTION <<proxyPrivateDemo>> -> CONTAINS -> VARIABLE <<instance>>
// VARIABLE <<instance>> -> ASSIGNED_FROM -> CALL <<new SecureService()>>
// CALL <<new SecureService()>> -> CALLS -> CLASS <<SecureService>>
// FUNCTION <<proxyPrivateDemo>> -> CONTAINS -> VARIABLE <<proxy>>
// VARIABLE <<proxy>> -> ASSIGNED_FROM -> CALL <<new Proxy(instance, {})>>
// CALL <<new Proxy(instance, {})>> -> PASSES_ARGUMENT -> VARIABLE <<instance>>
// CALL <<new Proxy(instance, {})>> -> PASSES_ARGUMENT -> LITERAL <<{}>>
// FUNCTION <<proxyPrivateDemo>> -> RETURNS -> EXPRESSION <<{ instance, proxy }>>
// EXPRESSION <<{ instance, proxy }>> -> READS_FROM -> VARIABLE <<instance>>
// EXPRESSION <<{ instance, proxy }>> -> READS_FROM -> VARIABLE <<proxy>>
// @end-annotation
class SecureService {
  #secret = 42;
  getSecret() { return this.#secret; }
}

function proxyPrivateDemo() {
  const instance = new SecureService();
  const proxy = new Proxy(instance, {});
  // proxy.getSecret() → TypeError: #secret not accessible through Proxy
  return { instance, proxy };
}

// --- Class expressions in various positions ---

// @construct PENDING class-in-array
// @annotation
// VARIABLE <<classHandlers>> -> ASSIGNED_FROM -> LITERAL <<classHandlers-array>>
// LITERAL <<classHandlers-array>> -> HAS_ELEMENT -> CLASS <<GetHandler>>
// LITERAL <<classHandlers-array>> -> HAS_ELEMENT -> CLASS <<PostHandler>>
// CLASS <<GetHandler>> -> CONTAINS -> METHOD <<GetHandler.handle>>
// METHOD <<GetHandler.handle>> -> RETURNS -> LITERAL <<'get'>>
// CLASS <<PostHandler>> -> CONTAINS -> METHOD <<PostHandler.handle>>
// METHOD <<PostHandler.handle>> -> RETURNS -> LITERAL <<'post'>>
// @end-annotation
const classHandlers = [
  class GetHandler { handle() { return 'get'; } },
  class PostHandler { handle() { return 'post'; } },
];

// @construct PENDING class-in-ternary
// @annotation
// VARIABLE <<StrategyClass>> -> ASSIGNED_FROM -> EXPRESSION <<ternary>>
// EXPRESSION <<ternary>> -> HAS_CONDITION -> EXPRESSION <<Math.random() > 0.5>>
// EXPRESSION <<ternary>> -> HAS_CONSEQUENT -> CLASS <<Aggressive>>
// EXPRESSION <<ternary>> -> HAS_ALTERNATE -> CLASS <<Conservative>>
// EXPRESSION <<Math.random() > 0.5>> -> READS_FROM -> CALL <<Math.random()>>
// EXPRESSION <<Math.random() > 0.5>> -> READS_FROM -> LITERAL <<0.5>>
// CALL <<Math.random()>> -> CALLS -> UNKNOWN <<Math.random>>
// CLASS <<Aggressive>> -> CONTAINS -> METHOD <<Aggressive.execute>>
// METHOD <<Aggressive.execute>> -> RETURNS -> LITERAL <<'fast'>>
// CLASS <<Conservative>> -> CONTAINS -> METHOD <<Conservative.execute>>
// METHOD <<Conservative.execute>> -> RETURNS -> LITERAL <<'slow'>>
// @end-annotation
const StrategyClass = Math.random() > 0.5
  ? class Aggressive { execute() { return 'fast'; } }
  : class Conservative { execute() { return 'slow'; } };

// @construct PENDING class-as-argument
// @annotation
// CLASS <<AbstractFactory>> -> CONTAINS -> METHOD <<AbstractFactory.constructor>>
// METHOD <<AbstractFactory.constructor>> -> DECLARES -> VARIABLE <<getTarget>>
// VARIABLE <<getTarget>> -> ASSIGNED_FROM -> FUNCTION <<getTarget:fn>>
// FUNCTION <<getTarget:fn>> -> RETURNS -> META_PROPERTY <<new.target>>
// FUNCTION <<getTarget:fn>> -> CAPTURES -> META_PROPERTY <<new.target>>
// METHOD <<AbstractFactory.constructor>> -> CONTAINS -> BRANCH <<if-abstract-check>>
// BRANCH <<if-abstract-check>> -> HAS_CONDITION -> EXPRESSION <<getTarget() === AbstractFactory>>
// EXPRESSION <<getTarget() === AbstractFactory>> -> READS_FROM -> CALL <<getTarget()>>
// EXPRESSION <<getTarget() === AbstractFactory>> -> READS_FROM -> CLASS <<AbstractFactory>>
// CALL <<getTarget()>> -> CALLS -> VARIABLE <<getTarget>>
// BRANCH <<if-abstract-check>> -> HAS_CONSEQUENT -> CALL <<throw new Error(...)>>
// CALL <<throw new Error(...)>> -> PASSES_ARGUMENT -> LITERAL <<'AbstractFactory is abstract — use a subclass'>>
// METHOD <<AbstractFactory.constructor>> -> WRITES_TO -> PROPERTY_ACCESS <<this._clone>>
// PROPERTY_ACCESS <<this._clone>> -> ASSIGNED_FROM -> FUNCTION <<_clone:fn>>
// FUNCTION <<_clone:fn>> -> RETURNS -> CALL <<new (new.target)()>>
// FUNCTION <<_clone:fn>> -> CAPTURES -> META_PROPERTY <<new.target>>
// CALL <<new (new.target)()>> -> CALLS -> META_PROPERTY <<new.target>>
// CLASS <<ConcreteFactory>> -> EXTENDS -> CLASS <<AbstractFactory>>
// CLASS <<ConcreteFactory>> -> CONTAINS -> METHOD <<ConcreteFactory.constructor>>
// METHOD <<ConcreteFactory.constructor>> -> CONTAINS -> CALL <<super()>>
// CALL <<super()>> -> CALLS -> METHOD <<AbstractFactory.constructor>>
// @end-annotation
function registerClass(cls) { return new cls(); }
registerClass(class InlinePlugin { activate() { return true; } });

// @construct PENDING new-target-arrow-capture
class AbstractFactory {
  constructor() {
    // new.target captured by arrow — like this/super, lexically bound
    const getTarget = () => new.target;

    if (getTarget() === AbstractFactory) {
      throw new Error('AbstractFactory is abstract — use a subclass');
    }

    // Store for lazy cloning — arrow captures new.target from constructor
    this._clone = () => new (new.target)();
  }
}

class ConcreteFactory extends AbstractFactory {
  constructor() {
    super(); // new.target === ConcreteFactory inside AbstractFactory
  }
}

// @construct PENDING export-named-list
// @annotation
// @end-annotation
export {
  Animal,
  Dog,
  MathUtils,
  BankAccount,
  Temperature,
  NamedClassExpr,
  AnonymousClassExpr,
  WithComputedMethods,
  Config,
  Base,
  Middle,
  Derived,
  AbstractBase,
  Concrete,
  Serializable,
  Validatable,
  User,
  inlineInstance,
  inlineChild,
  Branded,
  ArrowNotConstructable,
  methodShorthandObj,
  FieldInit,
  Singleton,
  ApiClient,
  Stream,
  Registry,
  Vec,
  Form,
  DynamicChild,
  QueryBuilder,
  chainedQuery,
  chainedArray,
  ParentProcessor,
  ChildProcessor,
  DeepSuper,
  AutoIdFields,
  ComponentState,
  ConfigFromOpts,
  ServiceWithDefaults,
  MergeConfig,
  MergeConfigDefaults,
  StaticParent,
  StaticChild,
  FieldParent,
  FieldChild,
  InterleavedStatic,
  SecureService,
  proxyPrivateDemo,
  classHandlers,
  StrategyClass,
  registerClass,
  AbstractFactory,
  ConcreteFactory,
};
