// =============================================================================
// ts-specific.ts — TypeScript-Only Constructs
// =============================================================================

// @construct PENDING ts-type-annotations
// @annotation
// @end-annotation
const typed: string = 'hello';
let count: number = 0;
const flag: boolean = true;
const nothing: null = null;
const undef: undefined = undefined;
const sym: symbol = Symbol('typed');

// @construct PENDING ts-typed-function
// @annotation
// UNKNOWN <<module>> -> DECLARES -> FUNCTION <<typedFunction>>
// FUNCTION <<typedFunction>> -> CONTAINS -> PARAMETER <<name>>
// FUNCTION <<typedFunction>> -> CONTAINS -> PARAMETER <<age>>
// FUNCTION <<typedFunction>> -> RETURNS_TYPE -> TYPE_REFERENCE <<string:return>>
// PARAMETER <<name>> -> HAS_TYPE -> UNKNOWN <<string>>
// PARAMETER <<age>> -> HAS_TYPE -> UNKNOWN <<number>>
// FUNCTION <<typedFunction>> -> RETURNS -> EXPRESSION <<`${name} is ${age}`>>
// EXPRESSION <<`${name} is ${age}`>> -> CONTAINS -> EXPRESSION <<${name}>>
// EXPRESSION <<`${name} is ${age}`>> -> CONTAINS -> EXPRESSION <<${age}>>
// EXPRESSION <<${name}>> -> READS_FROM -> PARAMETER <<name>>
// EXPRESSION <<${age}>> -> READS_FROM -> PARAMETER <<age>>
// @end-annotation
function typedFunction(name: string, age: number): string {
  return `${name} is ${age}`;
}

// @construct PENDING ts-typed-arrow
// @annotation
// UNKNOWN <<module>> -> DECLARES -> INTERFACE <<User>>
// INTERFACE <<User>> -> CONTAINS -> PROPERTY <<User.name>>
// INTERFACE <<User>> -> CONTAINS -> PROPERTY <<User.age>>
// INTERFACE <<User>> -> CONTAINS -> PROPERTY <<User.email>>
// INTERFACE <<User>> -> CONTAINS -> PROPERTY <<User.id>>
// @end-annotation
const typedArrow = (x: number): number => x * 2;

// @construct PENDING interface-basic
interface User {
  name: string;
  age: number;
  email?: string;
  readonly id: number;
}

// @construct PENDING interface-method
// @annotation
// UNKNOWN <<module>> -> DECLARES -> INTERFACE <<Printable>>
// INTERFACE <<Printable>> -> CONTAINS -> METHOD <<Printable.print>>
// @end-annotation
interface Printable {
  print(): void;
}

// @construct PENDING interface-extends
interface Admin extends User, Printable {
  role: string;
  permissions: string[];
}

// @construct PENDING interface-index-signature
// @annotation
// UNKNOWN <<module>> -> DECLARES -> INTERFACE <<StringMap>>
// INTERFACE <<StringMap>> -> HAS_PROPERTY -> PROPERTY <<StringMap[key: string]>>
// PROPERTY <<StringMap[key: string]>> -> CONTAINS -> PARAMETER <<key>>
// @end-annotation
interface StringMap {
  [key: string]: string;
}

// @construct PENDING interface-call-signature
interface Logger {
  (message: string): void;
  level: string;
}

// @construct PENDING interface-construct-signature
// @annotation
// INTERFACE <<Constructor>> -> CONTAINS -> METHOD <<Constructor.new>>
// METHOD <<Constructor.new>> -> RECEIVES_ARGUMENT -> PARAMETER <<name>>
// PARAMETER <<name>> -> HAS_TYPE -> TYPE_REFERENCE <<string>>
// METHOD <<Constructor.new>> -> RETURNS_TYPE -> TYPE_REFERENCE <<User>>
// @end-annotation
interface Constructor {
  new (name: string): User;
}

// @construct PENDING type-alias-union
// @annotation
// TYPE_ALIAS <<Nullable>> -> HAS_TYPE_PARAMETER -> TYPE_PARAMETER <<T>>
// TYPE_ALIAS <<Nullable>> -> UNION_MEMBER -> TYPE_REFERENCE <<T:ref>>
// TYPE_ALIAS <<Nullable>> -> UNION_MEMBER -> LITERAL_TYPE <<null>>
// TYPE_REFERENCE <<T:ref>> -> RESOLVES_TO -> TYPE_PARAMETER <<T>>
// @end-annotation
type ID = string | number;

// @construct PENDING type-alias-generic
// @annotation
// UNKNOWN <<module>> -> DECLARES -> TYPE_ALIAS <<Callback>>
// TYPE_ALIAS <<Callback>> -> CONTAINS -> PARAMETER <<error>>
// TYPE_ALIAS <<Callback>> -> CONTAINS -> PARAMETER <<result>>
// TYPE_ALIAS <<Callback>> -> RETURNS_TYPE -> TYPE_REFERENCE <<void>>
// PARAMETER <<error>> -> HAS_TYPE -> TYPE_REFERENCE <<Error | null>>
// PARAMETER <<result>> -> HAS_TYPE -> TYPE_REFERENCE <<unknown>>
// TYPE_REFERENCE <<Error | null>> -> UNION_MEMBER -> TYPE_REFERENCE <<Error>>
// TYPE_REFERENCE <<Error | null>> -> UNION_MEMBER -> LITERAL_TYPE <<null>>
// @end-annotation
type Nullable<T> = T | null;

// @construct PENDING type-alias-function
// @annotation
// UNKNOWN <<module>> -> DECLARES -> TYPE_ALIAS <<Pair>>
// TYPE_ALIAS <<Pair>> -> HAS_TYPE_PARAMETER -> TYPE_PARAMETER <<A>>
// TYPE_ALIAS <<Pair>> -> HAS_TYPE_PARAMETER -> TYPE_PARAMETER <<B>>
// TYPE_ALIAS <<Pair>> -> ALIASES -> TYPE_REFERENCE <<[A, B]>>
// TYPE_REFERENCE <<[A, B]>> -> HAS_ELEMENT -> TYPE_PARAMETER <<A>>
// TYPE_REFERENCE <<[A, B]>> -> HAS_ELEMENT -> TYPE_PARAMETER <<B>>
// @end-annotation
type Callback = (error: Error | null, result?: unknown) => void;

// @construct PENDING type-alias-tuple
// @annotation
// UNKNOWN <<module>> -> DECLARES -> ENUM <<Direction>>
// ENUM <<Direction>> -> CONTAINS -> ENUM_MEMBER <<Direction.Up>>
// ENUM <<Direction>> -> CONTAINS -> ENUM_MEMBER <<Direction.Down>>
// ENUM <<Direction>> -> CONTAINS -> ENUM_MEMBER <<Direction.Left>>
// ENUM <<Direction>> -> CONTAINS -> ENUM_MEMBER <<Direction.Right>>
// @end-annotation
type Pair<A, B> = [A, B];

// @construct PENDING enum-numeric
enum Direction {
  Up,
  Down,
  Left,
  Right,
}

// @construct PENDING enum-string
// @annotation
// UNKNOWN <<module>> -> DECLARES -> ENUM <<Status>>
// ENUM <<Status>> -> CONTAINS -> ENUM_MEMBER <<Status.Active>>
// ENUM <<Status>> -> CONTAINS -> ENUM_MEMBER <<Status.Inactive>>
// ENUM <<Status>> -> CONTAINS -> ENUM_MEMBER <<Status.Pending>>
// ENUM_MEMBER <<Status.Active>> -> ASSIGNED_FROM -> LITERAL <<'ACTIVE'>>
// ENUM_MEMBER <<Status.Inactive>> -> ASSIGNED_FROM -> LITERAL <<'INACTIVE'>>
// ENUM_MEMBER <<Status.Pending>> -> ASSIGNED_FROM -> LITERAL <<'PENDING'>>
// @end-annotation
enum Status {
  Active = 'ACTIVE',
  Inactive = 'INACTIVE',
  Pending = 'PENDING',
}

// @construct PENDING enum-const
// @annotation
// UNKNOWN <<module>> -> DECLARES -> ENUM <<Flags>>
// ENUM <<Flags>> -> CONTAINS -> ENUM_MEMBER <<Flags.Read>>
// ENUM <<Flags>> -> CONTAINS -> ENUM_MEMBER <<Flags.Write>>
// ENUM <<Flags>> -> CONTAINS -> ENUM_MEMBER <<Flags.Execute>>
// ENUM_MEMBER <<Flags.Read>> -> ASSIGNED_FROM -> LITERAL <<1>>
// ENUM_MEMBER <<Flags.Write>> -> ASSIGNED_FROM -> LITERAL <<2>>
// ENUM_MEMBER <<Flags.Execute>> -> ASSIGNED_FROM -> LITERAL <<4>>
// @end-annotation
const enum Flags {
  Read = 1,
  Write = 2,
  Execute = 4,
}

// @construct PENDING enum-heterogeneous
// @annotation
// UNKNOWN <<module>> -> DECLARES -> ENUM <<Mixed>>
// ENUM <<Mixed>> -> CONTAINS -> ENUM_MEMBER <<Mixed.No>>
// ENUM <<Mixed>> -> CONTAINS -> ENUM_MEMBER <<Mixed.Yes>>
// ENUM_MEMBER <<Mixed.No>> -> ASSIGNED_FROM -> LITERAL <<0>>
// ENUM_MEMBER <<Mixed.Yes>> -> ASSIGNED_FROM -> LITERAL <<'YES'>>
// @end-annotation
enum Mixed {
  No = 0,
  Yes = 'YES',
}

// @construct PENDING generic-function
// @annotation
// UNKNOWN <<module>> -> DECLARES -> FUNCTION <<identity>>
// FUNCTION <<identity>> -> CONTAINS -> TYPE_PARAMETER <<T>>
// FUNCTION <<identity>> -> CONTAINS -> PARAMETER <<value>>
// PARAMETER <<value>> -> HAS_TYPE -> TYPE_REFERENCE <<T:param>>
// FUNCTION <<identity>> -> RETURNS_TYPE -> TYPE_REFERENCE <<T:return>>
// TYPE_REFERENCE <<T:param>> -> HAS_TYPE -> TYPE_PARAMETER <<T>>
// TYPE_REFERENCE <<T:return>> -> HAS_TYPE -> TYPE_PARAMETER <<T>>
// FUNCTION <<identity>> -> RETURNS -> PARAMETER <<value>>
// @end-annotation
function identity<T>(value: T): T {
  return value;
}

// @construct PENDING generic-function-multi
// @annotation
// UNKNOWN <<module>> -> DECLARES -> CLASS <<Container>>
// CLASS <<Container>> -> HAS_TYPE_PARAMETER -> TYPE_PARAMETER <<T>>
// CLASS <<Container>> -> CONTAINS -> PROPERTY <<Container.value>>
// CLASS <<Container>> -> CONTAINS -> METHOD <<Container.constructor>>
// CLASS <<Container>> -> CONTAINS -> METHOD <<Container.getValue>>
// CLASS <<Container>> -> CONTAINS -> METHOD <<Container.map>>
// PROPERTY <<Container.value>> -> HAS_TYPE -> TYPE_PARAMETER <<T>>
// METHOD <<Container.constructor>> -> CONTAINS -> PARAMETER <<constructor.value>>
// PARAMETER <<constructor.value>> -> HAS_TYPE -> TYPE_PARAMETER <<T>>
// PROPERTY_ACCESS <<this.value>> -> ASSIGNED_FROM -> PARAMETER <<constructor.value>>
// METHOD <<Container.constructor>> -> WRITES_TO -> PROPERTY_ACCESS <<this.value>>
// METHOD <<Container.getValue>> -> RETURNS_TYPE -> TYPE_PARAMETER <<T>>
// METHOD <<Container.getValue>> -> RETURNS -> PROPERTY_ACCESS <<this.value>>
// METHOD <<Container.getValue>> -> READS_FROM -> PROPERTY_ACCESS <<this.value>>
// METHOD <<Container.map>> -> HAS_TYPE_PARAMETER -> TYPE_PARAMETER <<U>>
// METHOD <<Container.map>> -> CONTAINS -> PARAMETER <<map.fn>>
// PARAMETER <<map.fn>> -> HAS_TYPE -> TYPE_PARAMETER <<T>>
// PARAMETER <<map.fn>> -> RETURNS_TYPE -> TYPE_PARAMETER <<U>>
// METHOD <<Container.map>> -> RETURNS_TYPE -> CLASS <<Container>>
// METHOD <<Container.map>> -> RETURNS_TYPE -> TYPE_PARAMETER <<U>>
// METHOD <<Container.map>> -> RETURNS -> CALL <<new Container(fn(this.value))>>
// CALL <<new Container(fn(this.value))>> -> CALLS -> CLASS <<Container>>
// CALL <<new Container(fn(this.value))>> -> PASSES_ARGUMENT -> CALL <<fn(this.value)>>
// CALL <<fn(this.value)>> -> CALLS -> PARAMETER <<map.fn>>
// CALL <<fn(this.value)>> -> PASSES_ARGUMENT -> PROPERTY_ACCESS <<this.value>>
// CALL <<fn(this.value)>> -> READS_FROM -> PROPERTY_ACCESS <<this.value>>
// @end-annotation
function merge<T, U>(obj1: T, obj2: U): T & U {
  return { ...obj1, ...obj2 };
}

// @construct PENDING generic-class
class Container<T> {
  private value: T;

  constructor(value: T) {
    this.value = value;
  }

  getValue(): T {
    return this.value;
  }

  map<U>(fn: (value: T) => U): Container<U> {
    return new Container(fn(this.value));
  }
}

// @construct PENDING generic-interface
// @annotation
// UNKNOWN <<module>> -> DECLARES -> INTERFACE <<Repository>>
// INTERFACE <<Repository>> -> HAS_TYPE_PARAMETER -> TYPE_PARAMETER <<T>>
// INTERFACE <<Repository>> -> CONTAINS -> METHOD <<Repository.find>>
// INTERFACE <<Repository>> -> CONTAINS -> METHOD <<Repository.save>>
// INTERFACE <<Repository>> -> CONTAINS -> METHOD <<Repository.delete>>
// METHOD <<Repository.find>> -> CONTAINS -> PARAMETER <<id>>
// METHOD <<Repository.find>> -> RETURNS -> TYPE_REFERENCE <<Promise<T>>>
// TYPE_REFERENCE <<Promise<T>>> -> HAS_TYPE_PARAMETER -> TYPE_PARAMETER <<T>>
// METHOD <<Repository.save>> -> CONTAINS -> PARAMETER <<item>>
// METHOD <<Repository.save>> -> RETURNS -> TYPE_REFERENCE <<Promise<void>>>
// PARAMETER <<item>> -> HAS_TYPE -> TYPE_PARAMETER <<T>>
// METHOD <<Repository.delete>> -> CONTAINS -> PARAMETER <<id2>>
// METHOD <<Repository.delete>> -> RETURNS -> TYPE_REFERENCE <<Promise<boolean>>>
// @end-annotation
interface Repository<T> {
  find(id: string): Promise<T>;
  save(item: T): Promise<void>;
  delete(id: string): Promise<boolean>;
}

// @construct PENDING generic-constraint
// @annotation
// UNKNOWN <<module>> -> DECLARES -> FUNCTION <<getLength>>
// FUNCTION <<getLength>> -> CONTAINS -> TYPE_PARAMETER <<T>>
// TYPE_PARAMETER <<T>> -> CONSTRAINED_BY -> TYPE_REFERENCE <<{ length: number }>>
// FUNCTION <<getLength>> -> CONTAINS -> PARAMETER <<item>>
// PARAMETER <<item>> -> HAS_TYPE -> TYPE_REFERENCE <<T:param>>
// FUNCTION <<getLength>> -> RETURNS_TYPE -> TYPE_REFERENCE <<number:return>>
// FUNCTION <<getLength>> -> RETURNS -> PROPERTY_ACCESS <<item.length>>
// PROPERTY_ACCESS <<item.length>> -> READS_FROM -> PARAMETER <<item>>
// @end-annotation
function getLength<T extends { length: number }>(item: T): number {
  return item.length;
}

// @construct PENDING generic-default
// @annotation
// UNKNOWN <<module>> -> DECLARES -> FUNCTION <<typeAssertions>>
// FUNCTION <<typeAssertions>> -> CONTAINS -> PARAMETER <<value>>
// FUNCTION <<typeAssertions>> -> DECLARES -> VARIABLE <<asString>>
// FUNCTION <<typeAssertions>> -> DECLARES -> VARIABLE <<angleBracket>>
// VARIABLE <<asString>> -> ASSIGNED_FROM -> EXPRESSION <<value as string>>
// EXPRESSION <<value as string>> -> HAS_TYPE -> PARAMETER <<value>>
// VARIABLE <<angleBracket>> -> ASSIGNED_FROM -> EXPRESSION <<<number>value>>
// EXPRESSION <<<number>value>> -> HAS_TYPE -> PARAMETER <<value>>
// FUNCTION <<typeAssertions>> -> RETURNS -> EXPRESSION <<{ asString, angleBracket }>>
// EXPRESSION <<{ asString, angleBracket }>> -> READS_FROM -> VARIABLE <<asString>>
// EXPRESSION <<{ asString, angleBracket }>> -> READS_FROM -> VARIABLE <<angleBracket>>
// @end-annotation
function createArray<T = string>(length: number, fill: T): T[] {
  return Array(length).fill(fill);
}

// @construct PENDING type-assertion-as
function typeAssertions(value: unknown) {
  const asString = value as string;
  const angleBracket = value as number; // angle-bracket form conflicts with jsx plugin
  return { asString, angleBracket };
}

// @construct PENDING non-null-assertion
// @annotation
// UNKNOWN <<module>> -> DECLARES -> FUNCTION <<nonNullAssertion>>
// FUNCTION <<nonNullAssertion>> -> CONTAINS -> PARAMETER <<map>>
// FUNCTION <<nonNullAssertion>> -> DECLARES -> VARIABLE <<value>>
// CALL <<map.get('key')>> -> CALLS -> PARAMETER <<map>>
// CALL <<map.get('key')>> -> PASSES_ARGUMENT -> LITERAL <<'key'>>
// EXPRESSION <<map.get('key')!>> -> HAS_TYPE -> CALL <<map.get('key')>>
// VARIABLE <<value>> -> ASSIGNED_FROM -> EXPRESSION <<map.get('key')!>>
// CALL <<value.toUpperCase()>> -> CALLS -> VARIABLE <<value>>
// FUNCTION <<nonNullAssertion>> -> RETURNS -> CALL <<value.toUpperCase()>>
// @end-annotation
function nonNullAssertion(map: Map<string, string>) {
  const value = map.get('key')!;
  return value.toUpperCase();
}

// @construct PENDING as-const
// @annotation
// UNKNOWN <<module>> -> DECLARES -> VARIABLE <<config>>
// VARIABLE <<config>> -> ASSIGNED_FROM -> EXPRESSION <<config:as-const>>
// EXPRESSION <<config:as-const>> -> HAS_TYPE -> LITERAL <<config:object>>
// LITERAL <<config:object>> -> HAS_PROPERTY -> PROPERTY <<config:object.api>>
// PROPERTY <<config:object.api>> -> ASSIGNED_FROM -> LITERAL <<'https://api.example.com'>>
// LITERAL <<config:object>> -> HAS_PROPERTY -> PROPERTY <<config:object.timeout>>
// PROPERTY <<config:object.timeout>> -> ASSIGNED_FROM -> LITERAL <<5000>>
// LITERAL <<config:object>> -> HAS_PROPERTY -> PROPERTY <<config:object.retries>>
// PROPERTY <<config:object.retries>> -> ASSIGNED_FROM -> LITERAL <<3>>
// UNKNOWN <<module>> -> DECLARES -> VARIABLE <<directions>>
// VARIABLE <<directions>> -> ASSIGNED_FROM -> EXPRESSION <<directions:as-const>>
// EXPRESSION <<directions:as-const>> -> HAS_TYPE -> LITERAL <<directions:array>>
// LITERAL <<directions:array>> -> HAS_ELEMENT -> LITERAL <<'up'>>
// LITERAL <<directions:array>> -> HAS_ELEMENT -> LITERAL <<'down'>>
// LITERAL <<directions:array>> -> HAS_ELEMENT -> LITERAL <<'left'>>
// LITERAL <<directions:array>> -> HAS_ELEMENT -> LITERAL <<'right'>>
// @end-annotation
const config = {
  api: 'https://api.example.com',
  timeout: 5000,
  retries: 3,
} as const;

const directions = ['up', 'down', 'left', 'right'] as const;

// @construct PENDING satisfies
// @annotation
// UNKNOWN <<module>> -> DECLARES -> VARIABLE <<theme>>
// VARIABLE <<theme>> -> ASSIGNED_FROM -> LITERAL <<{primary: '#007bff', secondary: '#6c757d'}>>
// LITERAL <<{primary: '#007bff', secondary: '#6c757d'}>> -> HAS_PROPERTY -> LITERAL <<'#007bff'>>
// LITERAL <<{primary: '#007bff', secondary: '#6c757d'}>> -> HAS_PROPERTY -> LITERAL <<'#6c757d'>>
// LITERAL <<{primary: '#007bff', secondary: '#6c757d'}>> -> HAS_TYPE -> TYPE_REFERENCE <<Record<string, string>>>
// @end-annotation
const theme = {
  primary: '#007bff',
  secondary: '#6c757d',
} satisfies Record<string, string>;

// @construct PENDING access-modifiers
// @annotation
// UNKNOWN <<module>> -> DECLARES -> CLASS <<Service>>
// CLASS <<Service>> -> CONTAINS -> PROPERTY <<Service.name>>
// CLASS <<Service>> -> CONTAINS -> PROPERTY <<Service.config>>
// CLASS <<Service>> -> CONTAINS -> PROPERTY <<Service.secret>>
// CLASS <<Service>> -> CONTAINS -> METHOD <<Service.constructor>>
// METHOD <<Service.constructor>> -> CONTAINS -> PARAMETER <<name>>
// METHOD <<Service.constructor>> -> CONTAINS -> PARAMETER <<secret>>
// METHOD <<Service.constructor>> -> WRITES_TO -> PROPERTY_ACCESS <<this.name>>
// METHOD <<Service.constructor>> -> WRITES_TO -> PROPERTY_ACCESS <<this.config>>
// METHOD <<Service.constructor>> -> WRITES_TO -> PROPERTY_ACCESS <<this.secret>>
// PROPERTY_ACCESS <<this.name>> -> ASSIGNED_FROM -> PARAMETER <<name>>
// PROPERTY_ACCESS <<this.config>> -> ASSIGNED_FROM -> LITERAL <<{}>>
// PROPERTY_ACCESS <<this.secret>> -> ASSIGNED_FROM -> PARAMETER <<secret>>
// @end-annotation
class Service {
  public name: string;
  protected config: Record<string, unknown>;
  private secret: string;

  constructor(name: string, secret: string) {
    this.name = name;
    this.config = {};
    this.secret = secret;
  }
}

// @construct PENDING parameter-properties
// @annotation
// UNKNOWN <<module>> -> DECLARES -> CLASS <<ServiceWithParamProps>>
// CLASS <<ServiceWithParamProps>> -> CONTAINS -> METHOD <<ServiceWithParamProps.constructor>>
// METHOD <<ServiceWithParamProps.constructor>> -> CONTAINS -> PARAMETER <<name>>
// METHOD <<ServiceWithParamProps.constructor>> -> CONTAINS -> PARAMETER <<config>>
// METHOD <<ServiceWithParamProps.constructor>> -> CONTAINS -> PARAMETER <<secret>>
// METHOD <<ServiceWithParamProps.constructor>> -> CONTAINS -> PARAMETER <<id>>
// CLASS <<ServiceWithParamProps>> -> CONTAINS -> PROPERTY <<ServiceWithParamProps.name>>
// CLASS <<ServiceWithParamProps>> -> CONTAINS -> PROPERTY <<ServiceWithParamProps.config>>
// CLASS <<ServiceWithParamProps>> -> CONTAINS -> PROPERTY <<ServiceWithParamProps.secret>>
// CLASS <<ServiceWithParamProps>> -> CONTAINS -> PROPERTY <<ServiceWithParamProps.id>>
// PARAMETER <<name>> -> DECLARES -> PROPERTY <<ServiceWithParamProps.name>>
// PARAMETER <<config>> -> DECLARES -> PROPERTY <<ServiceWithParamProps.config>>
// PARAMETER <<secret>> -> DECLARES -> PROPERTY <<ServiceWithParamProps.secret>>
// PARAMETER <<id>> -> DECLARES -> PROPERTY <<ServiceWithParamProps.id>>
// PROPERTY <<ServiceWithParamProps.name>> -> ASSIGNED_FROM -> PARAMETER <<name>>
// PROPERTY <<ServiceWithParamProps.config>> -> ASSIGNED_FROM -> PARAMETER <<config>>
// PROPERTY <<ServiceWithParamProps.secret>> -> ASSIGNED_FROM -> PARAMETER <<secret>>
// PROPERTY <<ServiceWithParamProps.id>> -> ASSIGNED_FROM -> PARAMETER <<id>>
// @end-annotation
class ServiceWithParamProps {
  constructor(
    public name: string,
    protected config: Record<string, unknown>,
    private secret: string,
    readonly id: number,
  ) {}
}

// @construct PENDING abstract-class
// @annotation
// UNKNOWN <<module>> -> DECLARES -> CLASS <<Shape>>
// CLASS <<Shape>> -> CONTAINS -> METHOD <<Shape.area>>
// CLASS <<Shape>> -> CONTAINS -> METHOD <<Shape.perimeter>>
// CLASS <<Shape>> -> CONTAINS -> METHOD <<Shape.describe>>
// METHOD <<Shape.describe>> -> RETURNS -> EXPRESSION <<template-literal>>
// EXPRESSION <<template-literal>> -> CONTAINS -> CALL <<this.area()>>
// EXPRESSION <<template-literal>> -> CONTAINS -> CALL <<this.perimeter()>>
// CALL <<this.area()>> -> CALLS -> METHOD <<Shape.area>>
// CALL <<this.perimeter()>> -> CALLS -> METHOD <<Shape.perimeter>>
// UNKNOWN <<module>> -> DECLARES -> CLASS <<Circle>>
// CLASS <<Circle>> -> EXTENDS -> CLASS <<Shape>>
// CLASS <<Circle>> -> CONTAINS -> METHOD <<Circle.constructor>>
// METHOD <<Circle.constructor>> -> CONTAINS -> PARAMETER <<radius>>
// METHOD <<Circle.constructor>> -> CONTAINS -> CALL <<super()>>
// CALL <<super()>> -> CALLS -> CLASS <<Shape>>
// CLASS <<Circle>> -> CONTAINS -> METHOD <<Circle.area>>
// METHOD <<Circle.area>> -> IMPLEMENTS -> METHOD <<Shape.area>>
// METHOD <<Circle.area>> -> RETURNS -> EXPRESSION <<Math.PI * this.radius ** 2>>
// EXPRESSION <<Math.PI * this.radius ** 2>> -> READS_FROM -> PROPERTY_ACCESS <<Math.PI>>
// EXPRESSION <<Math.PI * this.radius ** 2>> -> READS_FROM -> PROPERTY_ACCESS <<this.radius>>
// PROPERTY_ACCESS <<this.radius>> -> READS_FROM -> PARAMETER <<radius>>
// CLASS <<Circle>> -> CONTAINS -> METHOD <<Circle.perimeter>>
// METHOD <<Circle.perimeter>> -> IMPLEMENTS -> METHOD <<Shape.perimeter>>
// METHOD <<Circle.perimeter>> -> RETURNS -> EXPRESSION <<2 * Math.PI * this.radius>>
// EXPRESSION <<2 * Math.PI * this.radius>> -> READS_FROM -> LITERAL <<2>>
// EXPRESSION <<2 * Math.PI * this.radius>> -> READS_FROM -> PROPERTY_ACCESS <<Math.PI>>
// EXPRESSION <<2 * Math.PI * this.radius>> -> READS_FROM -> PROPERTY_ACCESS <<this.radius>>
// @end-annotation
abstract class Shape {
  abstract area(): number;
  abstract perimeter(): number;

  describe(): string {
    return `Area: ${this.area()}, Perimeter: ${this.perimeter()}`;
  }
}

class Circle extends Shape {
  constructor(private radius: number) {
    super();
  }

  area(): number {
    return Math.PI * this.radius ** 2;
  }

  perimeter(): number {
    return 2 * Math.PI * this.radius;
  }
}

// @construct PENDING decorator-method
// @annotation
// UNKNOWN <<module>> -> DECLARES -> FUNCTION <<log>>
// FUNCTION <<log>> -> CONTAINS -> PARAMETER <<target>>
// FUNCTION <<log>> -> CONTAINS -> PARAMETER <<propertyKey>>
// FUNCTION <<log>> -> CONTAINS -> PARAMETER <<descriptor>>
// FUNCTION <<log>> -> DECLARES -> VARIABLE <<original>>
// VARIABLE <<original>> -> ASSIGNED_FROM -> PROPERTY_ACCESS <<descriptor.value>>
// PROPERTY_ACCESS <<descriptor.value>> -> READS_FROM -> PARAMETER <<descriptor>>
// PROPERTY_ACCESS <<descriptor.value>> -> ASSIGNED_FROM -> FUNCTION <<wrapper:fn>>
// FUNCTION <<wrapper:fn>> -> CONTAINS -> PARAMETER <<args>>
// FUNCTION <<wrapper:fn>> -> CONTAINS -> CALL <<console.log>>
// CALL <<console.log>> -> PASSES_ARGUMENT -> EXPRESSION <<template-literal>>
// EXPRESSION <<template-literal>> -> READS_FROM -> PARAMETER <<propertyKey>>
// FUNCTION <<wrapper:fn>> -> RETURNS -> CALL <<original.apply>>
// CALL <<original.apply>> -> CALLS -> VARIABLE <<original>>
// CALL <<original.apply>> -> PASSES_ARGUMENT -> LITERAL <<this>>
// CALL <<original.apply>> -> PASSES_ARGUMENT -> PARAMETER <<args>>
// @end-annotation
function log(target: any, propertyKey: string, descriptor: PropertyDescriptor) {
  const original = descriptor.value;
  descriptor.value = function (...args: any[]) {
    console.log(`Calling ${propertyKey}`);
    return original.apply(this, args);
  };
}

// @construct PENDING decorator-class
// @annotation
// UNKNOWN <<module>> -> DECLARES -> FUNCTION <<sealed>>
// FUNCTION <<sealed>> -> CONTAINS -> PARAMETER <<constructor>>
// FUNCTION <<sealed>> -> CONTAINS -> CALL <<Object.seal(constructor)>>
// FUNCTION <<sealed>> -> CONTAINS -> CALL <<Object.seal(constructor.prototype)>>
// CALL <<Object.seal(constructor)>> -> CALLS -> UNKNOWN <<Object.seal>>
// CALL <<Object.seal(constructor)>> -> PASSES_ARGUMENT -> PARAMETER <<constructor>>
// CALL <<Object.seal(constructor.prototype)>> -> CALLS -> UNKNOWN <<Object.seal>>
// CALL <<Object.seal(constructor.prototype)>> -> PASSES_ARGUMENT -> PROPERTY_ACCESS <<constructor.prototype>>
// PROPERTY_ACCESS <<constructor.prototype>> -> READS_FROM -> PARAMETER <<constructor>>
// @end-annotation
function sealed(constructor: Function) {
  Object.seal(constructor);
  Object.seal(constructor.prototype);
}

// @construct PENDING decorator-usage
// @annotation
// UNKNOWN <<module>> -> DECLARES -> CLASS <<DecoratedClass>>
// DECORATOR <<@sealed>> -> DECORATED_BY -> CLASS <<DecoratedClass>>
// CLASS <<DecoratedClass>> -> CONTAINS -> METHOD <<DecoratedClass.method>>
// DECORATOR <<@log>> -> DECORATED_BY -> METHOD <<DecoratedClass.method>>
// METHOD <<DecoratedClass.method>> -> RETURNS -> LITERAL <<42>>
// DECORATOR <<@sealed>> -> CALLS -> UNKNOWN <<sealed>>
// DECORATOR <<@log>> -> CALLS -> UNKNOWN <<log>>
// @end-annotation
@sealed
class DecoratedClass {
  @log
  method() {
    return 42;
  }
}

// @construct PENDING conditional-type
// @annotation
// UNKNOWN <<module>> -> DECLARES -> TYPE_ALIAS <<IsString>>
// TYPE_ALIAS <<IsString>> -> CONTAINS -> TYPE_PARAMETER <<T>>
// TYPE_ALIAS <<IsString>> -> ASSIGNED_FROM -> CONDITIONAL_TYPE <<T extends string ? true : false>>
// CONDITIONAL_TYPE <<T extends string ? true : false>> -> HAS_CONDITION -> TYPE_PARAMETER <<T>>
// CONDITIONAL_TYPE <<T extends string ? true : false>> -> EXTENDS -> TYPE_REFERENCE <<string>>
// CONDITIONAL_TYPE <<T extends string ? true : false>> -> HAS_CONSEQUENT -> LITERAL_TYPE <<true>>
// CONDITIONAL_TYPE <<T extends string ? true : false>> -> HAS_ALTERNATE -> LITERAL_TYPE <<false>>
// @end-annotation
type IsString<T> = T extends string ? true : false;

// @construct PENDING conditional-type-infer
// @annotation
// UNKNOWN <<module>> -> DECLARES -> TYPE_ALIAS <<StrictNonNull>>
// TYPE_ALIAS <<StrictNonNull>> -> CONTAINS -> TYPE_PARAMETER <<T>>
// TYPE_ALIAS <<StrictNonNull>> -> ASSIGNED_FROM -> CONDITIONAL_TYPE <<T extends null | undefined ? never : T>>
// CONDITIONAL_TYPE <<T extends null | undefined ? never : T>> -> HAS_CONDITION -> TYPE_PARAMETER <<T>>
// CONDITIONAL_TYPE <<T extends null | undefined ? never : T>> -> HAS_CONDITION -> TYPE_ALIAS <<null | undefined>>
// TYPE_ALIAS <<null | undefined>> -> CONTAINS -> LITERAL_TYPE <<null>>
// TYPE_ALIAS <<null | undefined>> -> CONTAINS -> LITERAL_TYPE <<undefined>>
// CONDITIONAL_TYPE <<T extends null | undefined ? never : T>> -> HAS_CONSEQUENT -> LITERAL_TYPE <<never>>
// CONDITIONAL_TYPE <<T extends null | undefined ? never : T>> -> HAS_ALTERNATE -> TYPE_PARAMETER <<T>>
// @end-annotation
type UnpackPromise<T> = T extends Promise<infer U> ? U : T;

// @construct PENDING conditional-type-exclude
// @annotation
// UNKNOWN <<module>> -> DECLARES -> TYPE_ALIAS <<ReadonlyAll>>
// TYPE_ALIAS <<ReadonlyAll>> -> CONTAINS -> TYPE_PARAMETER <<T>>
// TYPE_ALIAS <<ReadonlyAll>> -> ASSIGNED_FROM -> TYPE_ALIAS <<ReadonlyAll:mapped>>
// TYPE_ALIAS <<ReadonlyAll:mapped>> -> CONTAINS -> TYPE_PARAMETER <<K>>
// TYPE_PARAMETER <<K>> -> CONSTRAINED_BY -> TYPE_REFERENCE <<keyof T>>
// TYPE_REFERENCE <<keyof T>> -> READS_FROM -> TYPE_PARAMETER <<T>>
// TYPE_ALIAS <<ReadonlyAll:mapped>> -> DERIVES_FROM -> TYPE_REFERENCE <<T[K]>>
// TYPE_REFERENCE <<T[K]>> -> READS_FROM -> TYPE_PARAMETER <<T>>
// TYPE_REFERENCE <<T[K]>> -> READS_FROM -> TYPE_PARAMETER <<K>>
// @end-annotation
type StrictNonNull<T> = T extends null | undefined ? never : T;

// @construct PENDING mapped-type-readonly
// @annotation
// UNKNOWN <<module>> -> DECLARES -> TYPE_ALIAS <<Optional>>
// TYPE_ALIAS <<Optional>> -> CONTAINS -> TYPE_PARAMETER <<T>>
// TYPE_ALIAS <<Optional>> -> ASSIGNED_FROM -> TYPE_ALIAS <<Optional:mapped>>
// TYPE_ALIAS <<Optional:mapped>> -> CONTAINS -> TYPE_PARAMETER <<K>>
// TYPE_PARAMETER <<K>> -> ITERATES_OVER -> TYPE_REFERENCE <<keyof T>>
// TYPE_REFERENCE <<keyof T>> -> READS_FROM -> TYPE_PARAMETER <<T>>
// TYPE_ALIAS <<Optional:mapped>> -> DERIVES_FROM -> PROPERTY_ACCESS <<T[K]>>
// PROPERTY_ACCESS <<T[K]>> -> READS_FROM -> TYPE_PARAMETER <<T>>
// PROPERTY_ACCESS <<T[K]>> -> READS_FROM -> TYPE_PARAMETER <<K>>
// @end-annotation
type ReadonlyAll<T> = { readonly [K in keyof T]: T[K] };

// @construct PENDING mapped-type-optional
// @annotation
// UNKNOWN <<module>> -> DECLARES -> TYPE_ALIAS <<Mutable>>
// TYPE_ALIAS <<Mutable>> -> CONTAINS -> TYPE_PARAMETER <<T>>
// TYPE_ALIAS <<Mutable>> -> ASSIGNED_FROM -> TYPE_ALIAS <<Mutable:mapped>>
// TYPE_ALIAS <<Mutable:mapped>> -> CONTAINS -> TYPE_PARAMETER <<K>>
// TYPE_PARAMETER <<K>> -> ITERATES_OVER -> TYPE_REFERENCE <<keyof T>>
// TYPE_REFERENCE <<keyof T>> -> READS_FROM -> TYPE_PARAMETER <<T>>
// TYPE_ALIAS <<Mutable:mapped>> -> DERIVES_FROM -> PROPERTY_ACCESS <<T[K]>>
// PROPERTY_ACCESS <<T[K]>> -> READS_FROM -> TYPE_PARAMETER <<T>>
// PROPERTY_ACCESS <<T[K]>> -> READS_FROM -> TYPE_PARAMETER <<K>>
// @end-annotation
type Optional<T> = { [K in keyof T]?: T[K] };

// @construct PENDING mapped-type-mutable
// @annotation
// UNKNOWN <<module>> -> DECLARES -> TYPE_ALIAS <<EventName>>
// TYPE_ALIAS <<EventName>> -> UNION_MEMBER -> LITERAL_TYPE <<'click'>>
// TYPE_ALIAS <<EventName>> -> UNION_MEMBER -> LITERAL_TYPE <<'focus'>>
// TYPE_ALIAS <<EventName>> -> UNION_MEMBER -> LITERAL_TYPE <<'blur'>>
// UNKNOWN <<module>> -> DECLARES -> TYPE_ALIAS <<OnEvent>>
// TYPE_ALIAS <<OnEvent>> -> ASSIGNED_FROM -> TYPE_REFERENCE <<`on${Capitalize<EventName>}`>>
// TYPE_REFERENCE <<`on${Capitalize<EventName>}`>> -> CONTAINS -> TYPE_REFERENCE <<Capitalize<EventName>>>
// TYPE_REFERENCE <<Capitalize<EventName>>> -> DERIVES_FROM -> TYPE_ALIAS <<EventName>>
// UNKNOWN <<module>> -> DECLARES -> TYPE_ALIAS <<CSSProperty>>
// TYPE_ALIAS <<CSSProperty>> -> ASSIGNED_FROM -> TYPE_REFERENCE <<`${string}-${string}`>>
// TYPE_REFERENCE <<`${string}-${string}`>> -> CONTAINS -> TYPE_REFERENCE <<string>>
// @end-annotation
type Mutable<T> = { -readonly [K in keyof T]: T[K] };

// @construct PENDING template-literal-type
// @annotation
// UNKNOWN <<module>> -> DECLARES -> TYPE_ALIAS <<Point2D>>
// TYPE_ALIAS <<Point2D>> -> DECLARES -> TYPE_ALIAS <<Point2D:tuple>>
// TYPE_ALIAS <<Point2D:tuple>> -> HAS_ELEMENT -> TYPE_REFERENCE <<number:0>>
// TYPE_ALIAS <<Point2D:tuple>> -> HAS_ELEMENT -> TYPE_REFERENCE <<number:1>>
// UNKNOWN <<module>> -> DECLARES -> TYPE_ALIAS <<Point3D>>
// TYPE_ALIAS <<Point3D>> -> DECLARES -> TYPE_ALIAS <<Point3D:tuple>>
// TYPE_ALIAS <<Point3D:tuple>> -> HAS_ELEMENT -> TYPE_REFERENCE <<number:0:3d>>
// TYPE_ALIAS <<Point3D:tuple>> -> HAS_ELEMENT -> TYPE_REFERENCE <<number:1:3d>>
// TYPE_ALIAS <<Point3D:tuple>> -> HAS_ELEMENT -> TYPE_REFERENCE <<number:2:3d>>
// UNKNOWN <<module>> -> DECLARES -> TYPE_ALIAS <<NamedTuple>>
// TYPE_ALIAS <<NamedTuple>> -> DECLARES -> TYPE_ALIAS <<NamedTuple:tuple>>
// TYPE_ALIAS <<NamedTuple:tuple>> -> HAS_ELEMENT -> TYPE_REFERENCE <<name>>
// TYPE_REFERENCE <<name>> -> HAS_TYPE -> TYPE_REFERENCE <<string:named>>
// TYPE_ALIAS <<NamedTuple:tuple>> -> HAS_ELEMENT -> TYPE_REFERENCE <<age>>
// TYPE_REFERENCE <<age>> -> HAS_TYPE -> TYPE_REFERENCE <<number:named>>
// UNKNOWN <<module>> -> DECLARES -> TYPE_ALIAS <<RestTuple>>
// TYPE_ALIAS <<RestTuple>> -> DECLARES -> TYPE_ALIAS <<RestTuple:tuple>>
// TYPE_ALIAS <<RestTuple:tuple>> -> HAS_ELEMENT -> TYPE_REFERENCE <<string:rest>>
// TYPE_ALIAS <<RestTuple:tuple>> -> CONTAINS -> PARAMETER <<...number[]>>
// PARAMETER <<...number[]>> -> SPREADS_FROM -> TYPE_REFERENCE <<number[]>>
// TYPE_REFERENCE <<number[]>> -> CONTAINS -> TYPE_REFERENCE <<number:array>>
// @end-annotation
type EventName = 'click' | 'focus' | 'blur';
type OnEvent = `on${Capitalize<EventName>}`;
type CSSProperty = `${string}-${string}`;

// @construct PENDING tuple-types
type Point2D = [number, number];
type Point3D = [number, number, number];
type NamedTuple = [name: string, age: number];
type RestTuple = [string, ...number[]];

// @construct PENDING union-intersection
// @annotation
// UNKNOWN <<module>> -> DECLARES -> TYPE_ALIAS <<StringOrNumber>>
// TYPE_ALIAS <<StringOrNumber>> -> ASSIGNED_FROM -> TYPE_ALIAS <<string | number>>
// TYPE_ALIAS <<string | number>> -> UNION_MEMBER -> TYPE_REFERENCE <<string>>
// TYPE_ALIAS <<string | number>> -> UNION_MEMBER -> TYPE_REFERENCE <<number>>
// UNKNOWN <<module>> -> DECLARES -> TYPE_ALIAS <<ObjA>>
// TYPE_ALIAS <<ObjA>> -> ASSIGNED_FROM -> TYPE_REFERENCE <<{ a: string }>>
// TYPE_REFERENCE <<{ a: string }>> -> CONTAINS -> TYPE_REFERENCE <<a: string>>
// TYPE_REFERENCE <<a: string>> -> HAS_TYPE -> TYPE_REFERENCE <<string>>
// UNKNOWN <<module>> -> DECLARES -> TYPE_ALIAS <<ObjB>>
// TYPE_ALIAS <<ObjB>> -> ASSIGNED_FROM -> TYPE_REFERENCE <<{ b: number }>>
// TYPE_REFERENCE <<{ b: number }>> -> CONTAINS -> TYPE_REFERENCE <<b: number>>
// TYPE_REFERENCE <<b: number>> -> HAS_TYPE -> TYPE_REFERENCE <<number>>
// UNKNOWN <<module>> -> DECLARES -> TYPE_ALIAS <<Combined>>
// TYPE_ALIAS <<Combined>> -> ASSIGNED_FROM -> TYPE_REFERENCE <<ObjA & ObjB>>
// TYPE_REFERENCE <<ObjA & ObjB>> -> INTERSECTS_WITH -> TYPE_ALIAS <<ObjA>>
// TYPE_REFERENCE <<ObjA & ObjB>> -> INTERSECTS_WITH -> TYPE_ALIAS <<ObjB>>
// @end-annotation
type StringOrNumber = string | number;
type ObjA = { a: string };
type ObjB = { b: number };
type Combined = ObjA & ObjB;

// @construct PENDING discriminated-union
// @annotation
// UNKNOWN <<module>> -> DECLARES -> TYPE_ALIAS <<Result>>
// TYPE_ALIAS <<Result>> -> HAS_TYPE_PARAMETER -> TYPE_PARAMETER <<T>>
// TYPE_ALIAS <<Result>> -> RESOLVES_TO -> TYPE_ALIAS <<Result:union>>
// TYPE_ALIAS <<Result:union>> -> UNION_MEMBER -> TYPE_REFERENCE <<success-case>>
// TYPE_ALIAS <<Result:union>> -> UNION_MEMBER -> TYPE_REFERENCE <<error-case>>
// TYPE_REFERENCE <<success-case>> -> HAS_PROPERTY -> TYPE_REFERENCE <<success-case.success>>
// TYPE_REFERENCE <<success-case>> -> HAS_PROPERTY -> TYPE_REFERENCE <<success-case.data>>
// TYPE_REFERENCE <<success-case.success>> -> HAS_TYPE -> LITERAL_TYPE <<true>>
// TYPE_REFERENCE <<success-case.data>> -> HAS_TYPE -> TYPE_PARAMETER <<T>>
// TYPE_REFERENCE <<error-case>> -> HAS_PROPERTY -> TYPE_REFERENCE <<error-case.success>>
// TYPE_REFERENCE <<error-case>> -> HAS_PROPERTY -> TYPE_REFERENCE <<error-case.error>>
// TYPE_REFERENCE <<error-case.success>> -> HAS_TYPE -> LITERAL_TYPE <<false>>
// TYPE_REFERENCE <<error-case.error>> -> HAS_TYPE -> TYPE_REFERENCE <<Error>>
// @end-annotation
type Result<T> =
  | { success: true; data: T }
  | { success: false; error: Error };

// @construct PENDING type-guard-is
// @annotation
// UNKNOWN <<module>> -> DECLARES -> FUNCTION <<hasName>>
// FUNCTION <<hasName>> -> CONTAINS -> PARAMETER <<obj>>
// FUNCTION <<hasName>> -> HAS_TYPE -> TYPE_REFERENCE <<obj is { name: string }>>
// FUNCTION <<hasName>> -> RETURNS -> EXPRESSION <<guard-conjunction>>
// EXPRESSION <<guard-conjunction>> -> CONTAINS -> EXPRESSION <<typeof obj === 'object'>>
// EXPRESSION <<guard-conjunction>> -> CONTAINS -> EXPRESSION <<obj !== null>>
// EXPRESSION <<guard-conjunction>> -> CONTAINS -> EXPRESSION <<'name' in obj>>
// EXPRESSION <<typeof obj === 'object'>> -> READS_FROM -> PARAMETER <<obj>>
// EXPRESSION <<typeof obj === 'object'>> -> READS_FROM -> LITERAL <<'object'>>
// EXPRESSION <<obj !== null>> -> READS_FROM -> PARAMETER <<obj>>
// EXPRESSION <<obj !== null>> -> READS_FROM -> LITERAL <<null>>
// EXPRESSION <<'name' in obj>> -> READS_FROM -> LITERAL <<'name'>>
// EXPRESSION <<'name' in obj>> -> READS_FROM -> PARAMETER <<obj>>
// TYPE_REFERENCE <<obj is { name: string }>> -> HAS_TYPE -> PARAMETER <<obj>>
// @end-annotation
function isString(value: unknown): value is string {
  return typeof value === 'string';
}

// @construct PENDING type-guard-assertion
// @annotation
// UNKNOWN <<module>> -> DECLARES -> TYPE_ALIAS <<UserKeys>>
// TYPE_ALIAS <<UserKeys>> -> ASSIGNED_FROM -> TYPE_REFERENCE <<keyof User>>
// TYPE_REFERENCE <<keyof User>> -> READS_FROM -> TYPE_REFERENCE <<User>>
// UNKNOWN <<module>> -> DECLARES -> VARIABLE <<sampleUser>>
// VARIABLE <<sampleUser>> -> ASSIGNED_FROM -> LITERAL <<{ name: 'Alice', age: 30 }>>
// LITERAL <<{ name: 'Alice', age: 30 }>> -> HAS_PROPERTY -> LITERAL <<'Alice'>>
// LITERAL <<{ name: 'Alice', age: 30 }>> -> HAS_PROPERTY -> LITERAL <<30>>
// UNKNOWN <<module>> -> DECLARES -> TYPE_ALIAS <<InferredUser>>
// TYPE_ALIAS <<InferredUser>> -> ASSIGNED_FROM -> TYPE_REFERENCE <<typeof sampleUser>>
// TYPE_REFERENCE <<typeof sampleUser>> -> READS_FROM -> VARIABLE <<sampleUser>>
// @end-annotation
function hasName(obj: unknown): obj is { name: string } {
  return typeof obj === 'object' && obj !== null && 'name' in obj;
}

// @construct PENDING keyof-typeof
// @annotation
// UNKNOWN <<module>> -> DECLARES -> TYPE_ALIAS <<UserName>>
// TYPE_ALIAS <<UserName>> -> ASSIGNED_FROM -> TYPE_REFERENCE <<User['name']>>
// TYPE_REFERENCE <<User['name']>> -> READS_FROM -> UNKNOWN <<User>>
// TYPE_REFERENCE <<User['name']>> -> READS_FROM -> LITERAL_TYPE <<'name'>>
// UNKNOWN <<module>> -> DECLARES -> TYPE_ALIAS <<UserNameOrAge>>
// TYPE_ALIAS <<UserNameOrAge>> -> ASSIGNED_FROM -> TYPE_REFERENCE <<User['name' | 'age']>>
// TYPE_REFERENCE <<User['name' | 'age']>> -> READS_FROM -> UNKNOWN <<User>>
// TYPE_REFERENCE <<User['name' | 'age']>> -> READS_FROM -> TYPE_ALIAS <<'name' | 'age'>>
// TYPE_ALIAS <<'name' | 'age'>> -> CONTAINS -> LITERAL_TYPE <<'name'>>
// TYPE_ALIAS <<'name' | 'age'>> -> CONTAINS -> LITERAL_TYPE <<'age'>>
// @end-annotation
type UserKeys = keyof User;
const sampleUser = { name: 'Alice', age: 30 };
type InferredUser = typeof sampleUser;

// @construct PENDING index-access-type
// @annotation
// UNKNOWN <<module>> -> DECLARES -> NAMESPACE <<Validation>>
// NAMESPACE <<Validation>> -> CONTAINS -> INTERFACE <<Validation.Schema>>
// NAMESPACE <<Validation>> -> CONTAINS -> FUNCTION <<Validation.createSchema>>
// INTERFACE <<Validation.Schema>> -> CONTAINS -> METHOD <<Validation.Schema.validate>>
// METHOD <<Validation.Schema.validate>> -> CONTAINS -> PARAMETER <<data>>
// FUNCTION <<Validation.createSchema>> -> RETURNS -> LITERAL <<{ validate: () => true }>>
// LITERAL <<{ validate: () => true }>> -> HAS_PROPERTY -> FUNCTION <<() => true>>
// FUNCTION <<() => true>> -> RETURNS -> LITERAL <<true>>
// FUNCTION <<Validation.createSchema>> -> RETURNS_TYPE -> INTERFACE <<Validation.Schema>>
// @end-annotation
type UserName = User['name'];
type UserNameOrAge = User['name' | 'age'];

// @construct PENDING namespace
namespace Validation {
  export interface Schema {
    validate(data: unknown): boolean;
  }

  export function createSchema(): Schema {
    return { validate: () => true };
  }
}

// @construct PENDING utility-types
// @annotation
// UNKNOWN <<module>> -> DECLARES -> TYPE_ALIAS <<PartialUser>>
// TYPE_ALIAS <<PartialUser>> -> ASSIGNED_FROM -> TYPE_REFERENCE <<Partial<User>>>
// TYPE_REFERENCE <<Partial<User>>> -> DERIVES_FROM -> UNKNOWN <<User>>
// UNKNOWN <<module>> -> DECLARES -> TYPE_ALIAS <<RequiredUser>>
// TYPE_ALIAS <<RequiredUser>> -> ASSIGNED_FROM -> TYPE_REFERENCE <<Required<User>>>
// TYPE_REFERENCE <<Required<User>>> -> DERIVES_FROM -> UNKNOWN <<User>>
// UNKNOWN <<module>> -> DECLARES -> TYPE_ALIAS <<PickedUser>>
// TYPE_ALIAS <<PickedUser>> -> ASSIGNED_FROM -> TYPE_REFERENCE <<Pick<User, 'name' | 'age'>>>
// TYPE_REFERENCE <<Pick<User, 'name' | 'age'>>> -> DERIVES_FROM -> UNKNOWN <<User>>
// TYPE_REFERENCE <<Pick<User, 'name' | 'age'>>> -> READS_FROM -> LITERAL <<'name'>>
// TYPE_REFERENCE <<Pick<User, 'name' | 'age'>>> -> READS_FROM -> LITERAL <<'age'>>
// UNKNOWN <<module>> -> DECLARES -> TYPE_ALIAS <<OmittedUser>>
// TYPE_ALIAS <<OmittedUser>> -> ASSIGNED_FROM -> TYPE_REFERENCE <<Omit<User, 'email'>>>
// TYPE_REFERENCE <<Omit<User, 'email'>>> -> DERIVES_FROM -> UNKNOWN <<User>>
// TYPE_REFERENCE <<Omit<User, 'email'>>> -> CONTAINS -> LITERAL <<'email'>>
// UNKNOWN <<module>> -> DECLARES -> TYPE_ALIAS <<UserRecord>>
// TYPE_ALIAS <<UserRecord>> -> ASSIGNED_FROM -> TYPE_REFERENCE <<Record<string, User>>>
// TYPE_REFERENCE <<Record<string, User>>> -> DERIVES_FROM -> UNKNOWN <<User>>
// UNKNOWN <<module>> -> DECLARES -> TYPE_ALIAS <<ExtractedType>>
// TYPE_ALIAS <<ExtractedType>> -> ASSIGNED_FROM -> TYPE_REFERENCE <<Extract<string | number | boolean, string | boolean>>>
// TYPE_REFERENCE <<Extract<string | number | boolean, string | boolean>>> -> READS_FROM -> TYPE_ALIAS <<string | number | boolean>>
// TYPE_REFERENCE <<Extract<string | number | boolean, string | boolean>>> -> HAS_CONDITION -> TYPE_ALIAS <<string | boolean>>
// UNKNOWN <<module>> -> DECLARES -> TYPE_ALIAS <<ExcludedType>>
// TYPE_ALIAS <<ExcludedType>> -> ASSIGNED_FROM -> TYPE_REFERENCE <<Exclude<string | number | boolean, boolean>>>
// TYPE_REFERENCE <<Exclude<string | number | boolean, boolean>>> -> CONTAINS -> TYPE_ALIAS <<string | number | boolean>>
// @end-annotation
type PartialUser = Partial<User>;
type RequiredUser = Required<User>;
type PickedUser = Pick<User, 'name' | 'age'>;
type OmittedUser = Omit<User, 'email'>;
type UserRecord = Record<string, User>;
type ExtractedType = Extract<string | number | boolean, string | boolean>;
type ExcludedType = Exclude<string | number | boolean, boolean>;

// @construct PENDING function-overloads
// @annotation
// UNKNOWN <<module>> -> DECLARES -> METHOD <<processInput:overload1>>
// UNKNOWN <<module>> -> DECLARES -> METHOD <<processInput:overload2>>
// UNKNOWN <<module>> -> DECLARES -> FUNCTION <<processInput>>
// FUNCTION <<processInput>> -> IMPLEMENTS_OVERLOAD -> METHOD <<processInput:overload1>>
// FUNCTION <<processInput>> -> IMPLEMENTS_OVERLOAD -> METHOD <<processInput:overload2>>
// FUNCTION <<processInput>> -> CONTAINS -> PARAMETER <<input>>
// FUNCTION <<processInput>> -> RETURNS -> PARAMETER <<input>>
// @end-annotation
function processInput(input: string): string;
function processInput(input: number): number;
function processInput(input: string | number): string | number {
  return input;
}

// @construct PENDING class-implements
// @annotation
// UNKNOWN <<module>> -> DECLARES -> CLASS <<UserImpl>>
// CLASS <<UserImpl>> -> IMPLEMENTS -> INTERFACE <<User>>
// CLASS <<UserImpl>> -> IMPLEMENTS -> INTERFACE <<Printable>>
// CLASS <<UserImpl>> -> CONTAINS -> METHOD <<UserImpl.constructor>>
// CLASS <<UserImpl>> -> CONTAINS -> METHOD <<UserImpl.print>>
// METHOD <<UserImpl.constructor>> -> CONTAINS -> PARAMETER <<name>>
// METHOD <<UserImpl.constructor>> -> CONTAINS -> PARAMETER <<age>>
// METHOD <<UserImpl.constructor>> -> CONTAINS -> PARAMETER <<id>>
// METHOD <<UserImpl.print>> -> CONTAINS -> CALL <<console.log(this.name)>>
// CALL <<console.log(this.name)>> -> CALLS -> UNKNOWN <<console.log>>
// CALL <<console.log(this.name)>> -> PASSES_ARGUMENT -> PROPERTY_ACCESS <<this.name>>
// PROPERTY_ACCESS <<this.name>> -> READS_FROM -> PARAMETER <<name>>
// @end-annotation
class UserImpl implements User, Printable {
  constructor(
    public name: string,
    public age: number,
    public readonly id: number,
  ) {}

  print(): void {
    console.log(this.name);
  }
}

// @construct PENDING ts-import-type
// @annotation
// UNKNOWN <<module>> -> DECLARES -> TYPE_ALIAS <<ImportedType>>
// TYPE_ALIAS <<ImportedType>> -> ASSIGNED_FROM -> TYPE_REFERENCE <<User>>
// @end-annotation
// import type { User } from './types';
// import { type Role, Permission } from './auth';
// (commented out — no actual modules to import from, but syntax is valid)
type ImportedType = User;

// @construct PENDING ts-export-type
// @annotation
// UNKNOWN <<module>> -> CONTAINS -> EXPORT <<export-type-Admin>>
// EXPORT <<export-type-Admin>> -> EXPORTS -> TYPE_REFERENCE <<Admin>>
// UNKNOWN <<module>> -> EXPORTS -> TYPE_REFERENCE <<Admin>>
// @end-annotation
export type { Admin };
// export { type Status }; — inline type export (already exported as value above)

// @construct PENDING ts-declare-const
// @annotation
// UNKNOWN <<module>> -> DECLARES -> FUNCTION <<require>>
// FUNCTION <<require>> -> CONTAINS -> PARAMETER <<id>>
// PARAMETER <<id>> -> HAS_TYPE -> TYPE_REFERENCE <<string>>
// FUNCTION <<require>> -> RETURNS_TYPE -> TYPE_REFERENCE <<any>>
// @end-annotation
declare const __VERSION__: string;

// @construct PENDING ts-declare-function
// @annotation
// UNKNOWN <<module>> -> DECLARES -> NAMESPACE <<declare-*.css>>
// NAMESPACE <<declare-*.css>> -> CONTAINS -> VARIABLE <<content>>
// VARIABLE <<content>> -> HAS_TYPE -> TYPE_REFERENCE <<Record<string, string>>>
// NAMESPACE <<declare-*.css>> -> CONTAINS -> EXPORT <<default-export>>
// EXPORT <<default-export>> -> EXPORTS -> VARIABLE <<content>>
// @end-annotation
declare function require(id: string): any;

// @construct PENDING ts-declare-module
declare module '*.css' {
  const content: Record<string, string>;
  export default content;
}

// @construct PENDING ts-declare-global
// @annotation
// UNKNOWN <<module>> -> CONTAINS -> EXPRESSION <<global-declaration>>
// EXPRESSION <<global-declaration>> -> DECLARES -> INTERFACE <<Window>>
// INTERFACE <<Window>> -> HAS_PROPERTY -> PROPERTY <<__APP_STATE__>>
// @end-annotation
declare global {
  interface Window {
    __APP_STATE__: unknown;
  }
}

// @construct PENDING ts-declare-namespace
// @annotation
// UNKNOWN <<module>> -> DECLARES -> NAMESPACE <<NodeJS>>
// NAMESPACE <<NodeJS>> -> CONTAINS -> INTERFACE <<ProcessEnv>>
// INTERFACE <<ProcessEnv>> -> CONTAINS -> PROPERTY <<NODE_ENV>>
// PROPERTY <<NODE_ENV>> -> HAS_TYPE -> TYPE_ALIAS <<'development' | 'production'>>
// TYPE_ALIAS <<'development' | 'production'>> -> CONTAINS -> LITERAL_TYPE <<'development'>>
// TYPE_ALIAS <<'development' | 'production'>> -> CONTAINS -> LITERAL_TYPE <<'production'>>
// @end-annotation
declare namespace NodeJS {
  interface ProcessEnv {
    NODE_ENV: 'development' | 'production';
  }
}

// @construct PENDING ts-override
// @annotation
// UNKNOWN <<module>> -> DECLARES -> CLASS <<BaseWithMethod>>
// CLASS <<BaseWithMethod>> -> CONTAINS -> METHOD <<BaseWithMethod.greet>>
// METHOD <<BaseWithMethod.greet>> -> RETURNS -> LITERAL <<'hello'>>
// UNKNOWN <<module>> -> DECLARES -> CLASS <<DerivedWithOverride>>
// CLASS <<DerivedWithOverride>> -> EXTENDS -> CLASS <<BaseWithMethod>>
// CLASS <<DerivedWithOverride>> -> CONTAINS -> METHOD <<DerivedWithOverride.greet>>
// METHOD <<DerivedWithOverride.greet>> -> OVERRIDES -> METHOD <<BaseWithMethod.greet>>
// METHOD <<DerivedWithOverride.greet>> -> RETURNS -> LITERAL <<'hi'>>
// @end-annotation
class BaseWithMethod {
  greet() { return 'hello'; }
}
class DerivedWithOverride extends BaseWithMethod {
  override greet() { return 'hi'; }
}

// @construct PENDING ts-asserts-guard
// @annotation
// UNKNOWN <<module>> -> DECLARES -> FUNCTION <<assertDefined>>
// FUNCTION <<assertDefined>> -> CONTAINS -> TYPE_PARAMETER <<T>>
// FUNCTION <<assertDefined>> -> CONTAINS -> PARAMETER <<val>>
// PARAMETER <<val>> -> HAS_TYPE -> TYPE_REFERENCE <<T | undefined>>
// FUNCTION <<assertDefined>> -> RETURNS -> EXPRESSION <<asserts val is T>>
// EXPRESSION <<asserts val is T>> -> HAS_TYPE -> PARAMETER <<val>>
// EXPRESSION <<asserts val is T>> -> HAS_TYPE -> TYPE_PARAMETER <<T>>
// FUNCTION <<assertDefined>> -> CONTAINS -> BRANCH <<if-undefined-check>>
// BRANCH <<if-undefined-check>> -> HAS_CONDITION -> EXPRESSION <<val === undefined>>
// EXPRESSION <<val === undefined>> -> READS_FROM -> PARAMETER <<val>>
// EXPRESSION <<val === undefined>> -> READS_FROM -> LITERAL <<undefined>>
// BRANCH <<if-undefined-check>> -> HAS_CONSEQUENT -> EXPRESSION <<throw-error>>
// EXPRESSION <<throw-error>> -> THROWS -> CALL <<new Error('undefined')>>
// CALL <<new Error('undefined')>> -> CALLS -> UNKNOWN <<Error>>
// CALL <<new Error('undefined')>> -> PASSES_ARGUMENT -> LITERAL <<'undefined'>>
// @end-annotation
function assertDefined<T>(val: T | undefined): asserts val is T {
  if (val === undefined) throw new Error('undefined');
}

// @construct PENDING ts-const-type-param
function literal<const T>(value: T): T {
  return value;
}
const literalResult = literal({ x: 1, y: [2, 3] } as const);

// @construct PENDING ts-variance-in-out
// @annotation
// UNKNOWN <<module>> -> DECLARES -> INTERFACE <<Producer>>
// INTERFACE <<Producer>> -> HAS_TYPE_PARAMETER -> TYPE_PARAMETER <<Producer.T>>
// INTERFACE <<Producer>> -> CONTAINS -> METHOD <<Producer.produce>>
// METHOD <<Producer.produce>> -> RETURNS_TYPE -> TYPE_PARAMETER <<Producer.T>>
// UNKNOWN <<module>> -> DECLARES -> INTERFACE <<Consumer>>
// INTERFACE <<Consumer>> -> HAS_TYPE_PARAMETER -> TYPE_PARAMETER <<Consumer.T>>
// INTERFACE <<Consumer>> -> CONTAINS -> METHOD <<Consumer.consume>>
// METHOD <<Consumer.consume>> -> CONTAINS -> PARAMETER <<Consumer.consume.value>>
// PARAMETER <<Consumer.consume.value>> -> HAS_TYPE -> TYPE_PARAMETER <<Consumer.T>>
// UNKNOWN <<module>> -> DECLARES -> INTERFACE <<Transformer>>
// INTERFACE <<Transformer>> -> HAS_TYPE_PARAMETER -> TYPE_PARAMETER <<Transformer.T>>
// INTERFACE <<Transformer>> -> HAS_TYPE_PARAMETER -> TYPE_PARAMETER <<Transformer.U>>
// INTERFACE <<Transformer>> -> CONTAINS -> METHOD <<Transformer.transform>>
// METHOD <<Transformer.transform>> -> CONTAINS -> PARAMETER <<Transformer.transform.input>>
// PARAMETER <<Transformer.transform.input>> -> HAS_TYPE -> TYPE_PARAMETER <<Transformer.T>>
// METHOD <<Transformer.transform>> -> RETURNS_TYPE -> TYPE_PARAMETER <<Transformer.U>>
// @end-annotation
interface Producer<out T> {
  produce(): T;
}
interface Consumer<in T> {
  consume(value: T): void;
}
interface Transformer<in T, out U> {
  transform(input: T): U;
}

// @construct PENDING ts-module-augmentation
// @annotation
// UNKNOWN <<module>> -> DECLARES -> NAMESPACE <<express-augmentation>>
// NAMESPACE <<express-augmentation>> -> CONTAINS -> INTERFACE <<Request-augmentation>>
// INTERFACE <<Request-augmentation>> -> CONTAINS -> PROPERTY <<user>>
// PROPERTY <<user>> -> HAS_TYPE -> TYPE_REFERENCE <<user-type>>
// TYPE_REFERENCE <<user-type>> -> CONTAINS -> PROPERTY <<id>>
// TYPE_REFERENCE <<user-type>> -> CONTAINS -> PROPERTY <<role>>
// NAMESPACE <<express-augmentation>> -> MERGES_WITH -> UNKNOWN <express>
// @end-annotation
declare module 'express' {
  interface Request {
    user?: { id: string; role: string };
  }
}

// @construct PENDING ts-recursive-type
// @annotation
// UNKNOWN <<module>> -> DECLARES -> TYPE_ALIAS <<JSONValue>>
// TYPE_ALIAS <<JSONValue>> -> ASSIGNED_FROM -> TYPE_ALIAS <<JSONValue:union>>
// TYPE_ALIAS <<JSONValue:union>> -> CONTAINS -> TYPE_REFERENCE <<string>>
// TYPE_ALIAS <<JSONValue:union>> -> CONTAINS -> TYPE_REFERENCE <<number>>
// TYPE_ALIAS <<JSONValue:union>> -> CONTAINS -> TYPE_REFERENCE <<boolean>>
// TYPE_ALIAS <<JSONValue:union>> -> CONTAINS -> LITERAL_TYPE <<null>>
// TYPE_ALIAS <<JSONValue:union>> -> CONTAINS -> TYPE_REFERENCE <<JSONValue[]>>
// TYPE_ALIAS <<JSONValue:union>> -> CONTAINS -> TYPE_REFERENCE <<JSONValue:object>>
// TYPE_REFERENCE <<JSONValue[]>> -> CONTAINS -> TYPE_ALIAS <<JSONValue>>
// TYPE_REFERENCE <<JSONValue:object>> -> CONTAINS -> PROPERTY <<[key: string]: JSONValue>>
// PROPERTY <<[key: string]: JSONValue>> -> HAS_TYPE -> TYPE_REFERENCE <<string>>
// PROPERTY <<[key: string]: JSONValue>> -> HAS_TYPE -> TYPE_ALIAS <<JSONValue>>
// TYPE_ALIAS <<JSONValue>> -> ALIASES -> TYPE_ALIAS <<JSONValue>>
// @end-annotation
type JSONValue = string | number | boolean | null | JSONValue[] | { [key: string]: JSONValue };

// @construct PENDING ts-recursive-type-tree
type TreeNode<T> = {
  value: T;
  children: TreeNode<T>[];
};

// @construct PENDING ts-template-literal-infer
// @annotation
// UNKNOWN <<module>> -> DECLARES -> TYPE_ALIAS <<ParseRoute>>
// TYPE_ALIAS <<ParseRoute>> -> CONTAINS -> TYPE_PARAMETER <<T>>
// TYPE_ALIAS <<ParseRoute>> -> ASSIGNED_FROM -> CONDITIONAL_TYPE <<ParseRoute-conditional>>
// CONDITIONAL_TYPE <<ParseRoute-conditional>> -> HAS_CONDITION -> TYPE_PARAMETER <<T>>
// CONDITIONAL_TYPE <<ParseRoute-conditional>> -> HAS_CONDITION -> TYPE_REFERENCE <<`/${infer Segment}/${infer Rest}`>>
// TYPE_REFERENCE <<`/${infer Segment}/${infer Rest}`>> -> INFERS -> INFER_TYPE <<infer Segment>>
// TYPE_REFERENCE <<`/${infer Segment}/${infer Rest}`>> -> INFERS -> INFER_TYPE <<infer Rest>>
// CONDITIONAL_TYPE <<ParseRoute-conditional>> -> HAS_CONSEQUENT -> TYPE_ALIAS <<[Segment, ...ParseRoute<`/${Rest}`>]>>
// TYPE_ALIAS <<[Segment, ...ParseRoute<`/${Rest}`>]>> -> READS_FROM -> INFER_TYPE <<infer Segment>>
// TYPE_ALIAS <<[Segment, ...ParseRoute<`/${Rest}`>]>> -> SPREADS_FROM -> TYPE_REFERENCE <<ParseRoute<`/${Rest}`>>>
// TYPE_REFERENCE <<ParseRoute<`/${Rest}`>>> -> CALLS -> TYPE_ALIAS <<ParseRoute>>
// TYPE_REFERENCE <<ParseRoute<`/${Rest}`>>> -> PASSES_ARGUMENT -> TYPE_REFERENCE <<`/${Rest}`>>
// TYPE_REFERENCE <<`/${Rest}`>> -> READS_FROM -> INFER_TYPE <<infer Rest>>
// CONDITIONAL_TYPE <<ParseRoute-conditional>> -> HAS_CONDITION -> TYPE_REFERENCE <<`/${infer Segment}`>>
// TYPE_REFERENCE <<`/${infer Segment}`>> -> INFERS -> INFER_TYPE <<infer Segment-2>>
// CONDITIONAL_TYPE <<ParseRoute-conditional>> -> HAS_ALTERNATE -> TYPE_ALIAS <<[Segment]>>
// TYPE_ALIAS <<[Segment]>> -> READS_FROM -> INFER_TYPE <<infer Segment-2>>
// CONDITIONAL_TYPE <<ParseRoute-conditional>> -> HAS_ALTERNATE -> TYPE_ALIAS <<[]>>
// @end-annotation
type ParseRoute<T extends string> =
  T extends `/${infer Segment}/${infer Rest}`
    ? [Segment, ...ParseRoute<`/${Rest}`>]
    : T extends `/${infer Segment}`
      ? [Segment]
      : [];

// @construct PENDING ts-branded-type
// @annotation
// UNKNOWN <<module>> -> DECLARES -> TYPE_ALIAS <<UserId>>
// TYPE_ALIAS <<UserId>> -> ASSIGNED_FROM -> TYPE_REFERENCE <<string & { readonly __brand: unique symbol }>>
// TYPE_REFERENCE <<string & { readonly __brand: unique symbol }>> -> INTERSECTS_WITH -> TYPE_REFERENCE <<string>>
// TYPE_REFERENCE <<string & { readonly __brand: unique symbol }>> -> INTERSECTS_WITH -> TYPE_REFERENCE <<{ readonly __brand: unique symbol }>>
// TYPE_REFERENCE <<{ readonly __brand: unique symbol }>> -> CONTAINS -> PROPERTY <<__brand>>
// PROPERTY <<__brand>> -> HAS_TYPE -> TYPE_REFERENCE <<unique symbol>>
// UNKNOWN <<module>> -> DECLARES -> TYPE_ALIAS <<OrderId>>
// TYPE_ALIAS <<OrderId>> -> ASSIGNED_FROM -> TYPE_REFERENCE <<string & { readonly __brand: unique symbol }#2>>
// TYPE_REFERENCE <<string & { readonly __brand: unique symbol }#2>> -> INTERSECTS_WITH -> TYPE_REFERENCE <<string>>
// TYPE_REFERENCE <<string & { readonly __brand: unique symbol }#2>> -> INTERSECTS_WITH -> TYPE_REFERENCE <<{ readonly __brand: unique symbol }#2>>
// TYPE_REFERENCE <<{ readonly __brand: unique symbol }#2>> -> CONTAINS -> PROPERTY <<__brand#2>>
// PROPERTY <<__brand#2>> -> HAS_TYPE -> TYPE_REFERENCE <<unique symbol#2>>
// UNKNOWN <<module>> -> DECLARES -> FUNCTION <<createUserId>>
// FUNCTION <<createUserId>> -> CONTAINS -> PARAMETER <<id>>
// PARAMETER <<id>> -> HAS_TYPE -> TYPE_REFERENCE <<string>>
// FUNCTION <<createUserId>> -> RETURNS -> TYPE_ALIAS <<UserId>>
// FUNCTION <<createUserId>> -> RETURNS -> EXPRESSION <<id as UserId>>
// EXPRESSION <<id as UserId>> -> HAS_TYPE -> PARAMETER <<id>>
// EXPRESSION <<id as UserId>> -> HAS_TYPE -> TYPE_ALIAS <<UserId>>
// UNKNOWN <<module>> -> DECLARES -> FUNCTION <<createOrderId>>
// FUNCTION <<createOrderId>> -> CONTAINS -> PARAMETER <<id#2>>
// PARAMETER <<id#2>> -> HAS_TYPE -> TYPE_REFERENCE <<string>>
// FUNCTION <<createOrderId>> -> RETURNS -> TYPE_ALIAS <<OrderId>>
// FUNCTION <<createOrderId>> -> RETURNS -> EXPRESSION <<id as OrderId>>
// EXPRESSION <<id as OrderId>> -> HAS_TYPE -> PARAMETER <<id#2>>
// EXPRESSION <<id as OrderId>> -> HAS_TYPE -> TYPE_ALIAS <<OrderId>>
// @end-annotation
type UserId = string & { readonly __brand: unique symbol };
type OrderId = string & { readonly __brand: unique symbol };

function createUserId(id: string): UserId {
  return id as UserId;
}

function createOrderId(id: string): OrderId {
  return id as OrderId;
}

// @construct PENDING ts-this-type
// @annotation
// UNKNOWN <<module>> -> DECLARES -> CLASS <<Builder>>
// CLASS <<Builder>> -> CONTAINS -> PROPERTY <<Builder.builderValue>>
// PROPERTY <<Builder.builderValue>> -> ASSIGNED_FROM -> LITERAL <<0>>
// CLASS <<Builder>> -> CONTAINS -> METHOD <<Builder.add>>
// METHOD <<Builder.add>> -> CONTAINS -> PARAMETER <<n>>
// METHOD <<Builder.add>> -> RETURNS_TYPE -> TYPE_REFERENCE <<this-return-type>>
// METHOD <<Builder.add>> -> CONTAINS -> EXPRESSION <<this.builderValue += n>>
// EXPRESSION <<this.builderValue += n>> -> WRITES_TO -> PROPERTY_ACCESS <<this.builderValue>>
// EXPRESSION <<this.builderValue += n>> -> READS_FROM -> PARAMETER <<n>>
// METHOD <<Builder.add>> -> RETURNS -> UNKNOWN <<this>>
// CLASS <<Builder>> -> CONTAINS -> METHOD <<Builder.multiply>>
// METHOD <<Builder.multiply>> -> CONTAINS -> PARAMETER <<n2>>
// METHOD <<Builder.multiply>> -> RETURNS_TYPE -> TYPE_REFERENCE <<this-return-type2>>
// METHOD <<Builder.multiply>> -> CONTAINS -> EXPRESSION <<this.builderValue *= n>>
// EXPRESSION <<this.builderValue *= n>> -> WRITES_TO -> PROPERTY_ACCESS <<this.builderValue2>>
// EXPRESSION <<this.builderValue *= n>> -> READS_FROM -> PARAMETER <<n2>>
// METHOD <<Builder.multiply>> -> RETURNS -> UNKNOWN <<this>>
// UNKNOWN <<module>> -> DECLARES -> CLASS <<AdvancedBuilder>>
// CLASS <<AdvancedBuilder>> -> EXTENDS -> CLASS <<Builder>>
// CLASS <<AdvancedBuilder>> -> CONTAINS -> METHOD <<AdvancedBuilder.negate>>
// METHOD <<AdvancedBuilder.negate>> -> RETURNS_TYPE -> TYPE_REFERENCE <<this-return-type3>>
// METHOD <<AdvancedBuilder.negate>> -> RETURNS -> UNKNOWN <<this>>
// @end-annotation
class Builder {
  private builderValue = 0;

  add(n: number): this {
    this.builderValue += n;
    return this;
  }

  multiply(n: number): this {
    this.builderValue *= n;
    return this;
  }
}

class AdvancedBuilder extends Builder {
  negate(): this {
    return this;
  }
}

// @construct PENDING ts-exhaustive-never
// @annotation
// UNKNOWN <<module>> -> DECLARES -> TYPE_ALIAS <<ShapeUnion>>
// TYPE_ALIAS <<ShapeUnion>> -> CONTAINS -> TYPE_REFERENCE <<circle-type>>
// TYPE_ALIAS <<ShapeUnion>> -> CONTAINS -> TYPE_REFERENCE <<square-type>>
// UNKNOWN <<module>> -> DECLARES -> FUNCTION <<shapeArea>>
// FUNCTION <<shapeArea>> -> CONTAINS -> PARAMETER <<shape>>
// PARAMETER <<shape>> -> HAS_TYPE -> TYPE_ALIAS <<ShapeUnion>>
// FUNCTION <<shapeArea>> -> CONTAINS -> BRANCH <<switch-shape.kind>>
// BRANCH <<switch-shape.kind>> -> READS_FROM -> PARAMETER <<shape>>
// BRANCH <<switch-shape.kind>> -> HAS_CASE -> CASE <<case-circle>>
// BRANCH <<switch-shape.kind>> -> HAS_CASE -> CASE <<case-square>>
// BRANCH <<switch-shape.kind>> -> HAS_DEFAULT -> CASE <<case-default>>
// CASE <<case-circle>> -> RETURNS -> EXPRESSION <<Math.PI * shape.radius ** 2>>
// CASE <<case-square>> -> RETURNS -> EXPRESSION <<shape.side ** 2>>
// EXPRESSION <<Math.PI * shape.radius ** 2>> -> READS_FROM -> PARAMETER <<shape>>
// EXPRESSION <<shape.side ** 2>> -> READS_FROM -> PARAMETER <<shape>>
// CASE <<case-default>> -> DECLARES -> VARIABLE <<_exhaustive>>
// VARIABLE <<_exhaustive>> -> ASSIGNED_FROM -> PARAMETER <<shape>>
// CASE <<case-default>> -> CONTAINS -> CALL <<throw new Error>>
// CALL <<throw new Error>> -> READS_FROM -> VARIABLE <<_exhaustive>>
// CALL <<throw new Error>> -> PASSES_ARGUMENT -> LITERAL <<'Unknown shape: '>>
// @end-annotation
type ShapeUnion = { kind: 'circle'; radius: number } | { kind: 'square'; side: number };

function shapeArea(shape: ShapeUnion): number {
  switch (shape.kind) {
    case 'circle': return Math.PI * shape.radius ** 2;
    case 'square': return shape.side ** 2;
    default: {
      const _exhaustive: never = shape;
      throw new Error(`Unknown shape: ${_exhaustive}`);
    }
  }
}

// @construct PENDING ts-noinfer
// @annotation
// UNKNOWN <<module>> -> DECLARES -> FUNCTION <<createFSM>>
// FUNCTION <<createFSM>> -> HAS_TYPE_PARAMETER -> TYPE_PARAMETER <<S>>
// TYPE_PARAMETER <<S>> -> EXTENDS -> UNKNOWN <string>
// FUNCTION <<createFSM>> -> CONTAINS -> PARAMETER <<config>>
// PARAMETER <<config>> -> HAS_TYPE -> TYPE_REFERENCE <<config:type>>
// TYPE_REFERENCE <<config:type>> -> HAS_PROPERTY -> PROPERTY <<initial>>
// TYPE_REFERENCE <<config:type>> -> HAS_PROPERTY -> PROPERTY <<states>>
// PROPERTY <<initial>> -> HAS_TYPE -> TYPE_REFERENCE <<NoInfer<S>>>
// TYPE_REFERENCE <<NoInfer<S>>> -> CONTAINS -> TYPE_PARAMETER <<S>>
// PROPERTY <<states>> -> HAS_TYPE -> TYPE_REFERENCE <<Record<S, object>>>
// TYPE_REFERENCE <<Record<S, object>>> -> HAS_TYPE -> TYPE_PARAMETER <<S>>
// FUNCTION <<createFSM>> -> RETURNS -> PARAMETER <<config>>
// @end-annotation
function createFSM<S extends string>(config: {
  initial: NoInfer<S>;
  states: Record<S, object>;
}) {
  return config;
}

// @construct PENDING ts-import-type-star
// @annotation
// UNKNOWN <<module>> -> DECLARES -> TYPE_ALIAS <<AllTypesPlaceholder>>
// TYPE_ALIAS <<AllTypesPlaceholder>> -> ASSIGNED_FROM -> TYPE_REFERENCE <<Record<string, unknown>>>
// @end-annotation
// import type * as AllTypes from './modules-helpers.js';
// (commented out — no actual modules to import from, but syntax is valid)
type AllTypesPlaceholder = Record<string, unknown>;

// @construct PENDING ts-import-assertions
// @annotation
// UNKNOWN <<module>> -> DECLARES -> ENUM <<BitFlags>>
// ENUM <<BitFlags>> -> CONTAINS -> ENUM_MEMBER <<BitFlags.Read>>
// ENUM <<BitFlags>> -> CONTAINS -> ENUM_MEMBER <<BitFlags.Write>>
// ENUM <<BitFlags>> -> CONTAINS -> ENUM_MEMBER <<BitFlags.Execute>>
// ENUM <<BitFlags>> -> CONTAINS -> ENUM_MEMBER <<BitFlags.ReadWrite>>
// ENUM_MEMBER <<BitFlags.Read>> -> ASSIGNED_FROM -> EXPRESSION <<1 << 0>>
// EXPRESSION <<1 << 0>> -> READS_FROM -> LITERAL <<1>>
// EXPRESSION <<1 << 0>> -> READS_FROM -> LITERAL <<0>>
// ENUM_MEMBER <<BitFlags.Write>> -> ASSIGNED_FROM -> EXPRESSION <<1 << 1>>
// EXPRESSION <<1 << 1>> -> READS_FROM -> LITERAL <<1_2>>
// EXPRESSION <<1 << 1>> -> READS_FROM -> LITERAL <<1_literal>>
// ENUM_MEMBER <<BitFlags.Execute>> -> ASSIGNED_FROM -> EXPRESSION <<1 << 2>>
// EXPRESSION <<1 << 2>> -> READS_FROM -> LITERAL <<1_3>>
// EXPRESSION <<1 << 2>> -> READS_FROM -> LITERAL <<2>>
// ENUM_MEMBER <<BitFlags.ReadWrite>> -> ASSIGNED_FROM -> EXPRESSION <<Read | Write>>
// EXPRESSION <<Read | Write>> -> READS_FROM -> ENUM_MEMBER <<BitFlags.Read>>
// EXPRESSION <<Read | Write>> -> READS_FROM -> ENUM_MEMBER <<BitFlags.Write>>
// @end-annotation
// import data from './data.json' with { type: 'json' };
// (commented out — import attributes syntax, requires runtime support)
type ImportedJSON = Record<string, unknown>;

// @construct PENDING ts-const-enum-computed
const enum BitFlags {
  Read = 1 << 0,
  Write = 1 << 1,
  Execute = 1 << 2,
  ReadWrite = Read | Write,
}

// @construct PENDING ts-abstract-construct
// @annotation
// UNKNOWN <<module>> -> DECLARES -> TYPE_ALIAS <<AbstractConstructor>>
// TYPE_ALIAS <<AbstractConstructor>> -> HAS_TYPE_PARAMETER -> TYPE_PARAMETER <<T>>
// TYPE_ALIAS <<AbstractConstructor>> -> RESOLVES_TO -> TYPE_REFERENCE <<abstract new (...args: any[]) => T>>
// TYPE_REFERENCE <<abstract new (...args: any[]) => T>> -> RETURNS -> TYPE_PARAMETER <<T>>
// UNKNOWN <<module>> -> DECLARES -> FUNCTION <<withMixin>>
// FUNCTION <<withMixin>> -> HAS_TYPE_PARAMETER -> TYPE_PARAMETER <<T:withMixin>>
// TYPE_PARAMETER <<T:withMixin>> -> CONSTRAINED_BY -> TYPE_ALIAS <<AbstractConstructor>>
// FUNCTION <<withMixin>> -> CONTAINS -> PARAMETER <<Base>>
// FUNCTION <<withMixin>> -> CONTAINS -> CLASS <<Mixed>>
// CLASS <<Mixed>> -> EXTENDS -> PARAMETER <<Base>>
// CLASS <<Mixed>> -> CONTAINS -> METHOD <<Mixed.doThing>>
// FUNCTION <<withMixin>> -> RETURNS -> CLASS <<Mixed>>
// @end-annotation
type AbstractConstructor<T> = abstract new (...args: any[]) => T;

function withMixin<T extends AbstractConstructor<{}>>(Base: T) {
  abstract class Mixed extends Base {
    abstract doThing(): void;
  }
  return Mixed;
}

// @construct PENDING ts-explicit-this-param
// @annotation
// UNKNOWN <<module>> -> DECLARES -> FUNCTION <<onActivate>>
// FUNCTION <<onActivate>> -> CONTAINS -> PARAMETER <<this>>
// FUNCTION <<onActivate>> -> CONTAINS -> PARAMETER <<greeting>>
// FUNCTION <<onActivate>> -> RETURNS -> LITERAL <<template-literal>>
// LITERAL <<template-literal>> -> READS_FROM -> PARAMETER <<greeting>>
// LITERAL <<template-literal>> -> READS_FROM -> PROPERTY_ACCESS <<this.name>>
// PROPERTY_ACCESS <<this.name>> -> READS_FROM -> PARAMETER <<this>>
// @end-annotation
function onActivate(this: { name: string }, greeting: string): string {
  return `${greeting}, ${this.name}`;
}

// @construct PENDING ts-declaration-merging
// @annotation
// UNKNOWN <<module>> -> DECLARES -> CLASS <<Parser>>
// CLASS <<Parser>> -> CONTAINS -> METHOD <<Parser.parse>>
// METHOD <<Parser.parse>> -> HAS_OVERLOAD -> METHOD <<Parser.parse:overload1>>
// METHOD <<Parser.parse>> -> HAS_OVERLOAD -> METHOD <<Parser.parse:overload2>>
// METHOD <<Parser.parse>> -> IMPLEMENTS_OVERLOAD -> METHOD <<Parser.parse:implementation>>
// METHOD <<Parser.parse:overload1>> -> CONTAINS -> PARAMETER <<input:overload1>>
// METHOD <<Parser.parse:overload2>> -> CONTAINS -> PARAMETER <<input:overload2>>
// METHOD <<Parser.parse:implementation>> -> CONTAINS -> PARAMETER <<input:implementation>>
// PARAMETER <<input:overload1>> -> HAS_TYPE -> TYPE_REFERENCE <<string>>
// PARAMETER <<input:overload2>> -> HAS_TYPE -> TYPE_REFERENCE <<number>>
// PARAMETER <<input:implementation>> -> HAS_TYPE -> TYPE_REFERENCE <<string | number>>
// METHOD <<Parser.parse:overload1>> -> RETURNS_TYPE -> TYPE_REFERENCE <<string>>
// METHOD <<Parser.parse:overload2>> -> RETURNS_TYPE -> TYPE_REFERENCE <<number>>
// METHOD <<Parser.parse:implementation>> -> RETURNS_TYPE -> TYPE_REFERENCE <<string | number>>
// METHOD <<Parser.parse:implementation>> -> RETURNS -> PARAMETER <<input:implementation>>
// @end-annotation
class Box { x = 0; }
interface Box { y: number; }
// Box now has both x (from class) and y (from interface)

// @construct PENDING ts-class-method-overloads
class Parser {
  parse(input: string): string;
  parse(input: number): number;
  parse(input: string | number): string | number {
    return input;
  }
}

// @construct PENDING ts-constructor-overloads
// @annotation
// UNKNOWN <<module>> -> DECLARES -> CLASS <<Point>>
// CLASS <<Point>> -> CONTAINS -> PROPERTY <<Point.x>>
// CLASS <<Point>> -> CONTAINS -> PROPERTY <<Point.y>>
// CLASS <<Point>> -> CONTAINS -> METHOD <<Point.constructor:overload1>>
// CLASS <<Point>> -> CONTAINS -> METHOD <<Point.constructor:overload2>>
// CLASS <<Point>> -> CONTAINS -> METHOD <<Point.constructor>>
// METHOD <<Point.constructor:overload1>> -> CONTAINS -> PARAMETER <<x:overload1>>
// METHOD <<Point.constructor:overload1>> -> CONTAINS -> PARAMETER <<y:overload1>>
// METHOD <<Point.constructor:overload2>> -> CONTAINS -> PARAMETER <<coords:overload2>>
// METHOD <<Point.constructor>> -> CONTAINS -> PARAMETER <<xOrCoords>>
// METHOD <<Point.constructor>> -> CONTAINS -> PARAMETER <<y>>
// METHOD <<Point.constructor>> -> IMPLEMENTS_OVERLOAD -> METHOD <<Point.constructor:overload1>>
// METHOD <<Point.constructor>> -> IMPLEMENTS_OVERLOAD -> METHOD <<Point.constructor:overload2>>
// METHOD <<Point.constructor>> -> CONTAINS -> BRANCH <<Array.isArray(xOrCoords)>>
// BRANCH <<Array.isArray(xOrCoords)>> -> READS_FROM -> PARAMETER <<xOrCoords>>
// BRANCH <<Array.isArray(xOrCoords)>> -> HAS_CONSEQUENT -> PROPERTY_ACCESS <<this.x:branch1>>
// BRANCH <<Array.isArray(xOrCoords)>> -> HAS_CONSEQUENT -> PROPERTY_ACCESS <<this.y:branch1>>
// BRANCH <<Array.isArray(xOrCoords)>> -> HAS_ALTERNATE -> PROPERTY_ACCESS <<this.x:branch2>>
// BRANCH <<Array.isArray(xOrCoords)>> -> HAS_ALTERNATE -> PROPERTY_ACCESS <<this.y:branch2>>
// PROPERTY_ACCESS <<this.x:branch1>> -> ASSIGNED_FROM -> PROPERTY_ACCESS <<xOrCoords[0]>>
// PROPERTY_ACCESS <<xOrCoords[0]>> -> READS_FROM -> PARAMETER <<xOrCoords>>
// PROPERTY_ACCESS <<this.y:branch1>> -> ASSIGNED_FROM -> PROPERTY_ACCESS <<xOrCoords[1]>>
// PROPERTY_ACCESS <<xOrCoords[1]>> -> READS_FROM -> PARAMETER <<xOrCoords>>
// PROPERTY_ACCESS <<this.x:branch2>> -> ASSIGNED_FROM -> PARAMETER <<xOrCoords>>
// PROPERTY_ACCESS <<this.y:branch2>> -> ASSIGNED_FROM -> EXPRESSION <<y!>>
// EXPRESSION <<y!>> -> READS_FROM -> PARAMETER <<y>>
// @end-annotation
class Point {
  x: number;
  y: number;
  constructor(x: number, y: number);
  constructor(coords: [number, number]);
  constructor(xOrCoords: number | [number, number], y?: number) {
    if (Array.isArray(xOrCoords)) {
      this.x = xOrCoords[0];
      this.y = xOrCoords[1];
    } else {
      this.x = xOrCoords;
      this.y = y!;
    }
  }
}

// @construct PENDING ts-distributive-conditional
// @annotation
// UNKNOWN <<module>> -> DECLARES -> TYPE_ALIAS <<ToArray>>
// TYPE_ALIAS <<ToArray>> -> CONTAINS -> TYPE_PARAMETER <<T>>
// TYPE_ALIAS <<ToArray>> -> RESOLVES_TO -> CONDITIONAL_TYPE <<T extends any ? T[] : never>>
// CONDITIONAL_TYPE <<T extends any ? T[] : never>> -> HAS_CONDITION -> TYPE_REFERENCE <<T extends any>>
// CONDITIONAL_TYPE <<T extends any ? T[] : never>> -> HAS_CONSEQUENT -> TYPE_REFERENCE <<T[]>>
// CONDITIONAL_TYPE <<T extends any ? T[] : never>> -> HAS_ALTERNATE -> LITERAL_TYPE <<never>>
// TYPE_REFERENCE <<T extends any>> -> CONSTRAINED_BY -> TYPE_PARAMETER <<T>>
// TYPE_REFERENCE <<T[]>> -> CONTAINS -> TYPE_PARAMETER <<T>>
// UNKNOWN <<module>> -> DECLARES -> TYPE_ALIAS <<DistResult>>
// TYPE_ALIAS <<DistResult>> -> RESOLVES_TO -> TYPE_REFERENCE <<ToArray<string | number>>>
// TYPE_REFERENCE <<ToArray<string | number>>> -> CALLS -> TYPE_ALIAS <<ToArray>>
// TYPE_REFERENCE <<ToArray<string | number>>> -> HAS_TYPE -> TYPE_ALIAS <<string | number>>
// TYPE_ALIAS <<string | number>> -> UNION_MEMBER -> TYPE_REFERENCE <<string>>
// TYPE_ALIAS <<string | number>> -> UNION_MEMBER -> TYPE_REFERENCE <<number>>
// UNKNOWN <<module>> -> DECLARES -> TYPE_ALIAS <<ToArrayND>>
// TYPE_ALIAS <<ToArrayND>> -> CONTAINS -> TYPE_PARAMETER <<T_nd>>
// TYPE_ALIAS <<ToArrayND>> -> RESOLVES_TO -> CONDITIONAL_TYPE <<[T] extends [any] ? T[] : never>>
// CONDITIONAL_TYPE <<[T] extends [any] ? T[] : never>> -> HAS_CONDITION -> TYPE_REFERENCE <<[T] extends [any]>>
// CONDITIONAL_TYPE <<[T] extends [any] ? T[] : never>> -> HAS_CONSEQUENT -> TYPE_REFERENCE <<T[]_nd>>
// CONDITIONAL_TYPE <<[T] extends [any] ? T[] : never>> -> HAS_ALTERNATE -> LITERAL_TYPE <<never_nd>>
// TYPE_REFERENCE <<[T] extends [any]>> -> CONSTRAINED_BY -> TYPE_ALIAS <<[T]>>
// TYPE_REFERENCE <<[T] extends [any]>> -> CONSTRAINED_BY -> TYPE_ALIAS <<[any]>>
// TYPE_ALIAS <<[T]>> -> CONTAINS -> TYPE_PARAMETER <<T_nd>>
// TYPE_REFERENCE <<T[]_nd>> -> CONTAINS -> TYPE_PARAMETER <<T_nd>>
// UNKNOWN <<module>> -> DECLARES -> TYPE_ALIAS <<NonDistResult>>
// TYPE_ALIAS <<NonDistResult>> -> RESOLVES_TO -> TYPE_REFERENCE <<ToArrayND<string | number>>>
// TYPE_REFERENCE <<ToArrayND<string | number>>> -> CALLS -> TYPE_ALIAS <<ToArrayND>>
// TYPE_REFERENCE <<ToArrayND<string | number>>> -> HAS_TYPE -> TYPE_ALIAS <<string | number_nd>>
// TYPE_ALIAS <<string | number_nd>> -> UNION_MEMBER -> TYPE_REFERENCE <<string>>
// TYPE_ALIAS <<string | number_nd>> -> UNION_MEMBER -> TYPE_REFERENCE <<number>>
// @end-annotation
type ToArray<T> = T extends any ? T[] : never;
type DistResult = ToArray<string | number>; // string[] | number[]

type ToArrayND<T> = [T] extends [any] ? T[] : never;
type NonDistResult = ToArrayND<string | number>; // (string | number)[]

// @construct PENDING ts-enum-namespace-merge
// @annotation
// UNKNOWN <<module>> -> DECLARES -> ENUM <<Color>>
// ENUM <<Color>> -> CONTAINS -> ENUM_MEMBER <<Color.Red>>
// ENUM <<Color>> -> CONTAINS -> ENUM_MEMBER <<Color.Green>>
// ENUM <<Color>> -> CONTAINS -> ENUM_MEMBER <<Color.Blue>>
// UNKNOWN <<module>> -> DECLARES -> NAMESPACE <<Color:namespace>>
// NAMESPACE <<Color:namespace>> -> CONTAINS -> FUNCTION <<Color.parse>>
// FUNCTION <<Color.parse>> -> CONTAINS -> PARAMETER <<s>>
// FUNCTION <<Color.parse>> -> RETURNS -> PROPERTY_ACCESS <<Color[s]>>
// PROPERTY_ACCESS <<Color[s]>> -> READS_FROM -> ENUM <<Color>>
// PROPERTY_ACCESS <<Color[s]>> -> READS_FROM -> EXPRESSION <<s as keyof typeof Color>>
// EXPRESSION <<s as keyof typeof Color>> -> DERIVES_FROM -> PARAMETER <<s>>
// NAMESPACE <<Color:namespace>> -> MERGES_WITH -> ENUM <<Color>>
// @end-annotation
enum Color { Red, Green, Blue }
namespace Color {
  export function parse(s: string): Color { return Color[s as keyof typeof Color]; }
}

// @construct PENDING ts-unique-symbol
// @annotation
// UNKNOWN <<module>> -> DECLARES -> VARIABLE <<uniqueSym>>
// VARIABLE <<uniqueSym>> -> HAS_TYPE -> TYPE_REFERENCE <<unique symbol>>
// UNKNOWN <<module>> -> DECLARES -> TYPE_REFERENCE <<WithSymKey>>
// TYPE_REFERENCE <<WithSymKey>> -> ASSIGNED_FROM -> TYPE_REFERENCE <<WithSymKey:object>>
// TYPE_REFERENCE <<WithSymKey:object>> -> CONTAINS -> PROPERTY <<WithSymKey:[uniqueSym]>>
// PROPERTY <<WithSymKey:[uniqueSym]>> -> READS_FROM -> VARIABLE <<uniqueSym>>
// PROPERTY <<WithSymKey:[uniqueSym]>> -> HAS_TYPE -> UNKNOWN <<string>>
// @end-annotation
declare const uniqueSym: unique symbol;
type WithSymKey = { [uniqueSym]: string };

// @construct PENDING ts-ambient-class-enum
declare class ExternalLib {
  constructor(config: object);
  process(): Promise<void>;
}
declare enum Platform { Web, Mobile, Desktop }

// --- Decorator metadata (Stage 3 + TS experimental) ---

// @construct PENDING ts-decorator-metadata
// @annotation
// UNKNOWN <<module>> -> DECLARES -> FUNCTION <<track>>
// FUNCTION <<track>> -> CONTAINS -> PARAMETER <<constructor>>
// FUNCTION <<track>> -> CONTAINS -> PARAMETER <<context>>
// FUNCTION <<track>> -> WRITES_TO -> PROPERTY_ACCESS <<context.metadata.tracked>>
// PROPERTY_ACCESS <<context.metadata.tracked>> -> ASSIGNED_FROM -> LITERAL <<true>>
// UNKNOWN <<module>> -> DECLARES -> FUNCTION <<log>>
// FUNCTION <<log>> -> CONTAINS -> PARAMETER <<target>>
// FUNCTION <<log>> -> CONTAINS -> PARAMETER <<context2>>
// FUNCTION <<log>> -> CONTAINS -> CALL <<context.addInitializer(...)>>
// CALL <<context.addInitializer(...)>> -> PASSES_ARGUMENT -> FUNCTION <<addInitializer-callback>>
// FUNCTION <<addInitializer-callback>> -> CONTAINS -> CALL <<console.log(...)>>
// CALL <<console.log(...)>> -> PASSES_ARGUMENT -> EXPRESSION <<String(context.name)>>
// UNKNOWN <<module>> -> DECLARES -> CLASS <<TrackedService>>
// DECORATOR <<@track>> -> DECORATED_BY -> FUNCTION <<track>>
// CLASS <<TrackedService>> -> DECORATED_BY -> DECORATOR <<@track>>
// CLASS <<TrackedService>> -> CONTAINS -> METHOD <<TrackedService.process>>
// DECORATOR <<@logMethod>> -> DECORATED_BY -> FUNCTION <<logMethod>>
// METHOD <<TrackedService.process>> -> DECORATED_BY -> DECORATOR <<@logMethod>>
// METHOD <<TrackedService.process>> -> CONTAINS -> PARAMETER <<data>>
// METHOD <<TrackedService.process>> -> RETURNS -> PARAMETER <<data>>
// @end-annotation
function track(constructor: Function, context: ClassDecoratorContext) {
  context.metadata.tracked = true;
}

function logMethod(target: Function, context: ClassMethodDecoratorContext) {
  context.addInitializer(function() {
    console.log(`${String(context.name)} initialized`);
  });
}

@track
class TrackedService {
  @logMethod
  process(data: string) { return data; }
}
// const meta = TrackedService[Symbol.metadata]; // { tracked: true }

// @construct PENDING ts-parameter-decorators
// @annotation
// UNKNOWN <<module>> -> DECLARES -> FUNCTION <<Inject>>
// FUNCTION <<Inject>> -> CONTAINS -> PARAMETER <<token>>
// FUNCTION <<Inject>> -> RETURNS -> FUNCTION <<Inject:decorator>>
// FUNCTION <<Inject:decorator>> -> CONTAINS -> PARAMETER <<target>>
// FUNCTION <<Inject:decorator>> -> CONTAINS -> PARAMETER <<propertyKey>>
// FUNCTION <<Inject:decorator>> -> CONTAINS -> PARAMETER <<parameterIndex>>
// UNKNOWN <<module>> -> DECLARES -> CLASS <<AppController>>
// CLASS <<AppController>> -> CONTAINS -> METHOD <<AppController.constructor>>
// METHOD <<AppController.constructor>> -> CONTAINS -> PARAMETER <<db>>
// DECORATOR <<@Inject('DB')>> -> CALLS -> FUNCTION <<Inject>>
// DECORATOR <<@Inject('DB')>> -> PASSES_ARGUMENT -> LITERAL <<'DB'>>
// PARAMETER <<db>> -> DECORATED_BY -> DECORATOR <<@Inject('DB')>>
// DECORATOR <<@Inject('DB')>> -> RETURNS -> FUNCTION <<Inject:decorator>>
// @end-annotation
// Common in NestJS/Angular — parameter decorators
function Inject(token: string) {
  return function(target: any, propertyKey: string | symbol, parameterIndex: number) {};
}

class AppController {
  constructor(@Inject('DB') private db: any) {}
}

// @construct PENDING ts-mapped-type-as-clause
// @annotation
// UNKNOWN <<module>> -> DECLARES -> TYPE_ALIAS <<Getters>>
// TYPE_ALIAS <<Getters>> -> CONTAINS -> TYPE_PARAMETER <<T>>
// TYPE_ALIAS <<Getters>> -> ASSIGNED_FROM -> TYPE_ALIAS <<Getters:mapped>>
// TYPE_ALIAS <<Getters:mapped>> -> ITERATES_OVER -> TYPE_PARAMETER <<K>>
// TYPE_ALIAS <<Getters:mapped>> -> DERIVES_FROM -> TYPE_REFERENCE <<get${Capitalize<string & K>}>>
// TYPE_ALIAS <<Getters:mapped>> -> DERIVES_FROM -> TYPE_REFERENCE <<() => T[K]>>
// TYPE_REFERENCE <<get${Capitalize<string & K>}>> -> READS_FROM -> TYPE_PARAMETER <<K>>
// TYPE_REFERENCE <<() => T[K]>> -> READS_FROM -> TYPE_PARAMETER <<T>>
// TYPE_REFERENCE <<() => T[K]>> -> READS_FROM -> TYPE_PARAMETER <<K>>
// UNKNOWN <<module>> -> DECLARES -> TYPE_ALIAS <<RemoveKind>>
// TYPE_ALIAS <<RemoveKind>> -> CONTAINS -> TYPE_PARAMETER <<T2>>
// TYPE_ALIAS <<RemoveKind>> -> ASSIGNED_FROM -> TYPE_ALIAS <<RemoveKind:mapped>>
// TYPE_ALIAS <<RemoveKind:mapped>> -> ITERATES_OVER -> TYPE_PARAMETER <<K2>>
// TYPE_ALIAS <<RemoveKind:mapped>> -> DERIVES_FROM -> TYPE_REFERENCE <<Exclude<K, 'kind'>>>
// TYPE_ALIAS <<RemoveKind:mapped>> -> DERIVES_FROM -> TYPE_PARAMETER <<T2>>
// TYPE_REFERENCE <<Exclude<K, 'kind'>>> -> READS_FROM -> TYPE_PARAMETER <<K2>>
// TYPE_REFERENCE <<Exclude<K, 'kind'>>> -> READS_FROM -> LITERAL <<'kind'>>
// @end-annotation
type Getters<T> = {
  [K in keyof T as `get${Capitalize<string & K>}`]: () => T[K]
};
type RemoveKind<T> = {
  [K in keyof T as Exclude<K, 'kind'>]: T[K]
};

// @construct PENDING ts-variadic-tuple
// @annotation
// UNKNOWN <<module>> -> DECLARES -> TYPE_ALIAS <<Concat>>
// TYPE_ALIAS <<Concat>> -> CONTAINS -> TYPE_PARAMETER <<A>>
// TYPE_ALIAS <<Concat>> -> CONTAINS -> TYPE_PARAMETER <<B>>
// TYPE_ALIAS <<Concat>> -> RESOLVES_TO -> TYPE_ALIAS <<[...A, ...B]>>
// TYPE_ALIAS <<[...A, ...B]>> -> CONTAINS -> EXPRESSION <<...A>>
// TYPE_ALIAS <<[...A, ...B]>> -> CONTAINS -> EXPRESSION <<...B>>
// EXPRESSION <<...A>> -> SPREADS_FROM -> TYPE_PARAMETER <<A>>
// EXPRESSION <<...B>> -> SPREADS_FROM -> TYPE_PARAMETER <<B>>
// UNKNOWN <<module>> -> DECLARES -> TYPE_ALIAS <<HeadOf>>
// TYPE_ALIAS <<HeadOf>> -> CONTAINS -> TYPE_PARAMETER <<T>>
// TYPE_ALIAS <<HeadOf>> -> RESOLVES_TO -> CONDITIONAL_TYPE <<T extends [infer H, ...unknown[]] ? H : never>>
// CONDITIONAL_TYPE <<T extends [infer H, ...unknown[]] ? H : never>> -> HAS_CONDITION -> TYPE_PARAMETER <<T>>
// CONDITIONAL_TYPE <<T extends [infer H, ...unknown[]] ? H : never>> -> INFERS -> INFER_TYPE <<H>>
// CONDITIONAL_TYPE <<T extends [infer H, ...unknown[]] ? H : never>> -> RETURNS -> INFER_TYPE <<H>>
// CONDITIONAL_TYPE <<T extends [infer H, ...unknown[]] ? H : never>> -> RETURNS -> LITERAL_TYPE <<never>>
// UNKNOWN <<module>> -> DECLARES -> TYPE_ALIAS <<TailOf>>
// TYPE_ALIAS <<TailOf>> -> CONTAINS -> TYPE_PARAMETER <<T:TailOf>>
// TYPE_ALIAS <<TailOf>> -> RESOLVES_TO -> CONDITIONAL_TYPE <<T extends [unknown, ...infer R] ? R : never>>
// CONDITIONAL_TYPE <<T extends [unknown, ...infer R] ? R : never>> -> HAS_CONDITION -> TYPE_PARAMETER <<T:TailOf>>
// CONDITIONAL_TYPE <<T extends [unknown, ...infer R] ? R : never>> -> INFERS -> INFER_TYPE <<R>>
// CONDITIONAL_TYPE <<T extends [unknown, ...infer R] ? R : never>> -> RETURNS -> INFER_TYPE <<R>>
// CONDITIONAL_TYPE <<T extends [unknown, ...infer R] ? R : never>> -> RETURNS -> LITERAL_TYPE <<never:TailOf>>
// UNKNOWN <<module>> -> DECLARES -> TYPE_ALIAS <<LastOf>>
// TYPE_ALIAS <<LastOf>> -> CONTAINS -> TYPE_PARAMETER <<T:LastOf>>
// TYPE_ALIAS <<LastOf>> -> RESOLVES_TO -> CONDITIONAL_TYPE <<T extends [...unknown[], infer L] ? L : never>>
// CONDITIONAL_TYPE <<T extends [...unknown[], infer L] ? L : never>> -> HAS_CONDITION -> TYPE_PARAMETER <<T:LastOf>>
// CONDITIONAL_TYPE <<T extends [...unknown[], infer L] ? L : never>> -> INFERS -> INFER_TYPE <<L>>
// CONDITIONAL_TYPE <<T extends [...unknown[], infer L] ? L : never>> -> RETURNS -> INFER_TYPE <<L>>
// CONDITIONAL_TYPE <<T extends [...unknown[], infer L] ? L : never>> -> RETURNS -> LITERAL_TYPE <<never:LastOf>>
// @end-annotation
type Concat<A extends unknown[], B extends unknown[]> = [...A, ...B];
type HeadOf<T extends unknown[]> = T extends [infer H, ...unknown[]] ? H : never;
type TailOf<T extends unknown[]> = T extends [unknown, ...infer R] ? R : never;
type LastOf<T extends unknown[]> = T extends [...unknown[], infer L] ? L : never;

// @construct PENDING ts-generic-keyof-constraint
// @annotation
// UNKNOWN <<module>> -> DECLARES -> FUNCTION <<getProperty>>
// FUNCTION <<getProperty>> -> CONTAINS -> TYPE_PARAMETER <<T>>
// FUNCTION <<getProperty>> -> CONTAINS -> TYPE_PARAMETER <<K>>
// TYPE_PARAMETER <<K>> -> CONSTRAINED_BY -> TYPE_REFERENCE <<keyof T>>
// TYPE_REFERENCE <<keyof T>> -> DEPENDS_ON -> TYPE_PARAMETER <<T>>
// FUNCTION <<getProperty>> -> CONTAINS -> PARAMETER <<obj>>
// FUNCTION <<getProperty>> -> CONTAINS -> PARAMETER <<key>>
// PARAMETER <<obj>> -> HAS_TYPE -> TYPE_PARAMETER <<T>>
// PARAMETER <<key>> -> HAS_TYPE -> TYPE_PARAMETER <<K>>
// FUNCTION <<getProperty>> -> RETURNS -> TYPE_REFERENCE <<T[K]>>
// TYPE_REFERENCE <<T[K]>> -> DEPENDS_ON -> TYPE_PARAMETER <<T>>
// TYPE_REFERENCE <<T[K]>> -> DEPENDS_ON -> TYPE_PARAMETER <<K>>
// FUNCTION <<getProperty>> -> RETURNS -> PROPERTY_ACCESS <<obj[key]>>
// PROPERTY_ACCESS <<obj[key]>> -> READS_FROM -> PARAMETER <<obj>>
// PROPERTY_ACCESS <<obj[key]>> -> READS_FROM -> PARAMETER <<key>>
// UNKNOWN <<module>> -> DECLARES -> FUNCTION <<pluck>>
// FUNCTION <<pluck>> -> CONTAINS -> TYPE_PARAMETER <<T2>>
// FUNCTION <<pluck>> -> CONTAINS -> TYPE_PARAMETER <<K2>>
// TYPE_PARAMETER <<K2>> -> CONSTRAINED_BY -> TYPE_REFERENCE <<keyof T2>>
// TYPE_REFERENCE <<keyof T2>> -> DEPENDS_ON -> TYPE_PARAMETER <<T2>>
// FUNCTION <<pluck>> -> CONTAINS -> PARAMETER <<items>>
// FUNCTION <<pluck>> -> CONTAINS -> PARAMETER <<key2>>
// PARAMETER <<items>> -> HAS_TYPE -> TYPE_PARAMETER <<T2>>
// PARAMETER <<key2>> -> HAS_TYPE -> TYPE_PARAMETER <<K2>>
// FUNCTION <<pluck>> -> RETURNS -> TYPE_REFERENCE <<T[K][]>>
// TYPE_REFERENCE <<T[K][]>> -> DEPENDS_ON -> TYPE_PARAMETER <<T2>>
// TYPE_REFERENCE <<T[K][]>> -> DEPENDS_ON -> TYPE_PARAMETER <<K2>>
// FUNCTION <<pluck>> -> RETURNS -> CALL <<items.map(...)>>
// CALL <<items.map(...)>> -> CALLS -> PARAMETER <<items>>
// CALL <<items.map(...)>> -> PASSES_ARGUMENT -> FUNCTION <<arrow-fn>>
// FUNCTION <<arrow-fn>> -> CONTAINS -> PARAMETER <<item>>
// FUNCTION <<arrow-fn>> -> RETURNS -> PROPERTY_ACCESS <<item[key]>>
// PROPERTY_ACCESS <<item[key]>> -> READS_FROM -> PARAMETER <<item>>
// PROPERTY_ACCESS <<item[key]>> -> READS_FROM -> PARAMETER <<key2>>
// @end-annotation
function getProperty<T, K extends keyof T>(obj: T, key: K): T[K] {
  return obj[key];
}

function pluck<T, K extends keyof T>(items: T[], key: K): T[K][] {
  return items.map(item => item[key]);
}

// @construct PENDING ts-typeof-class
// @annotation
// UNKNOWN <<module>> -> DECLARES -> CLASS <<ExampleForTypeof>>
// CLASS <<ExampleForTypeof>> -> CONTAINS -> METHOD <<ExampleForTypeof.create>>
// CLASS <<ExampleForTypeof>> -> CONTAINS -> METHOD <<ExampleForTypeof.method>>
// METHOD <<ExampleForTypeof.create>> -> RETURNS -> EXPRESSION <<new ExampleForTypeof()>>
// EXPRESSION <<new ExampleForTypeof()>> -> CALLS -> CLASS <<ExampleForTypeof>>
// METHOD <<ExampleForTypeof.method>> -> RETURNS -> LITERAL <<1>>
// UNKNOWN <<module>> -> DECLARES -> TYPE_ALIAS <<ExampleInstance>>
// TYPE_ALIAS <<ExampleInstance>> -> ALIASES -> TYPE_REFERENCE <<ExampleForTypeof:instance-type>>
// TYPE_REFERENCE <<ExampleForTypeof:instance-type>> -> HAS_TYPE -> CLASS <<ExampleForTypeof>>
// UNKNOWN <<module>> -> DECLARES -> TYPE_ALIAS <<ExampleConstructor>>
// TYPE_ALIAS <<ExampleConstructor>> -> ALIASES -> TYPE_REFERENCE <<typeof ExampleForTypeof>>
// TYPE_REFERENCE <<typeof ExampleForTypeof>> -> HAS_TYPE -> CLASS <<ExampleForTypeof>>
// UNKNOWN <<module>> -> DECLARES -> FUNCTION <<classFactory>>
// FUNCTION <<classFactory>> -> CONTAINS -> PARAMETER <<Cls>>
// PARAMETER <<Cls>> -> HAS_TYPE -> TYPE_REFERENCE <<typeof ExampleForTypeof:param-type>>
// TYPE_REFERENCE <<typeof ExampleForTypeof:param-type>> -> HAS_TYPE -> CLASS <<ExampleForTypeof>>
// FUNCTION <<classFactory>> -> RETURNS_TYPE -> TYPE_REFERENCE <<ExampleForTypeof:return-type>>
// TYPE_REFERENCE <<ExampleForTypeof:return-type>> -> HAS_TYPE -> CLASS <<ExampleForTypeof>>
// FUNCTION <<classFactory>> -> RETURNS -> CALL <<Cls.create()>>
// CALL <<Cls.create()>> -> CALLS_ON -> PARAMETER <<Cls>>
// CALL <<Cls.create()>> -> CALLS -> METHOD <<ExampleForTypeof.create>>
// @end-annotation
class ExampleForTypeof {
  static create() { return new ExampleForTypeof(); }
  method() { return 1; }
}

type ExampleInstance = ExampleForTypeof;            // instance type — has method()
type ExampleConstructor = typeof ExampleForTypeof;  // constructor type — has create()

function classFactory(Cls: typeof ExampleForTypeof): ExampleForTypeof {
  return Cls.create();
}

// @construct PENDING ts-this-type-guard
// @annotation
// UNKNOWN <<module>> -> DECLARES -> CLASS <<FSNode>>
// CLASS <<FSNode>> -> CONTAINS -> METHOD <<FSNode.isFile>>
// CLASS <<FSNode>> -> CONTAINS -> METHOD <<FSNode.isDir>>
// METHOD <<FSNode.isFile>> -> RETURNS -> EXPRESSION <<this instanceof FSFileNode>>
// METHOD <<FSNode.isDir>> -> RETURNS -> EXPRESSION <<this instanceof FSDirNode>>
// EXPRESSION <<this instanceof FSFileNode>> -> READS_FROM -> CLASS <<FSFileNode>>
// EXPRESSION <<this instanceof FSDirNode>> -> READS_FROM -> CLASS <<FSDirNode>>
// UNKNOWN <<module>> -> DECLARES -> CLASS <<FSFileNode>>
// CLASS <<FSFileNode>> -> EXTENDS -> CLASS <<FSNode>>
// CLASS <<FSFileNode>> -> CONTAINS -> PROPERTY <<FSFileNode.content>>
// PROPERTY <<FSFileNode.content>> -> ASSIGNED_FROM -> LITERAL <<''>>
// UNKNOWN <<module>> -> DECLARES -> CLASS <<FSDirNode>>
// CLASS <<FSDirNode>> -> EXTENDS -> CLASS <<FSNode>>
// CLASS <<FSDirNode>> -> CONTAINS -> PROPERTY <<FSDirNode.children>>
// PROPERTY <<FSDirNode.children>> -> ASSIGNED_FROM -> LITERAL <<[]>>
// @end-annotation
class FSNode {
  isFile(): this is FSFileNode { return this instanceof FSFileNode; }
  isDir(): this is FSDirNode { return this instanceof FSDirNode; }
}

class FSFileNode extends FSNode {
  content: string = '';
}

class FSDirNode extends FSNode {
  children: FSNode[] = [];
}

// @construct PENDING ts-function-type-intersection
// @annotation
// UNKNOWN <<module>> -> DECLARES -> TYPE_ALIAS <<StringHandler>>
// TYPE_ALIAS <<StringHandler>> -> ASSIGNED_FROM -> TYPE_REFERENCE <<StringHandler:fn-type>>
// TYPE_REFERENCE <<StringHandler:fn-type>> -> CONTAINS -> TYPE_REFERENCE <<StringHandler:input>>
// TYPE_REFERENCE <<StringHandler:input>> -> HAS_TYPE -> TYPE_REFERENCE <<string1>>
// TYPE_REFERENCE <<StringHandler:fn-type>> -> RETURNS -> TYPE_REFERENCE <<string2>>
// UNKNOWN <<module>> -> DECLARES -> TYPE_ALIAS <<NumberHandler>>
// TYPE_ALIAS <<NumberHandler>> -> ASSIGNED_FROM -> TYPE_REFERENCE <<NumberHandler:fn-type>>
// TYPE_REFERENCE <<NumberHandler:fn-type>> -> CONTAINS -> TYPE_REFERENCE <<NumberHandler:input>>
// TYPE_REFERENCE <<NumberHandler:input>> -> HAS_TYPE -> TYPE_REFERENCE <<number1>>
// TYPE_REFERENCE <<NumberHandler:fn-type>> -> RETURNS -> TYPE_REFERENCE <<number2>>
// UNKNOWN <<module>> -> DECLARES -> TYPE_ALIAS <<BothHandler>>
// TYPE_ALIAS <<BothHandler>> -> ASSIGNED_FROM -> TYPE_REFERENCE <<StringHandler & NumberHandler>>
// TYPE_REFERENCE <<StringHandler & NumberHandler>> -> INTERSECTS_WITH -> TYPE_ALIAS <<StringHandler>>
// TYPE_REFERENCE <<StringHandler & NumberHandler>> -> INTERSECTS_WITH -> TYPE_ALIAS <<NumberHandler>>
// @end-annotation
type StringHandler = (input: string) => string;
type NumberHandler = (input: number) => number;
type BothHandler = StringHandler & NumberHandler;

// @construct PENDING ts-enum-reverse-mapping
enum HttpStatus {
  OK = 200,
  NotFound = 404,
  ServerError = 500,
}
const statusName = HttpStatus[200];           // 'OK' — reverse mapping
const statusCode = HttpStatus.OK;             // 200 — forward mapping
// String enums do NOT have reverse mapping

// @construct PENDING ts-generic-default-prior-ref
// @annotation
// UNKNOWN <<module>> -> DECLARES -> FUNCTION <<createGenericStore>>
// FUNCTION <<createGenericStore>> -> HAS_TYPE_PARAMETER -> TYPE_PARAMETER <<S>>
// FUNCTION <<createGenericStore>> -> HAS_TYPE_PARAMETER -> TYPE_PARAMETER <<A>>
// FUNCTION <<createGenericStore>> -> HAS_TYPE_PARAMETER -> TYPE_PARAMETER <<G>>
// TYPE_PARAMETER <<A>> -> DEFAULTS_TO -> LITERAL <<{}>>
// TYPE_PARAMETER <<G>> -> DEFAULTS_TO -> LITERAL <<{}>>
// TYPE_PARAMETER <<G>> -> HAS_TYPE -> TYPE_PARAMETER <<S>>
// FUNCTION <<createGenericStore>> -> CONTAINS -> PARAMETER <<config>>
// PARAMETER <<config>> -> HAS_TYPE -> TYPE_PARAMETER <<S>>
// PARAMETER <<config>> -> HAS_TYPE -> TYPE_PARAMETER <<A>>
// PARAMETER <<config>> -> HAS_TYPE -> TYPE_PARAMETER <<G>>
// FUNCTION <<createGenericStore>> -> RETURNS -> PARAMETER <<config>>
// UNKNOWN <<module>> -> DECLARES -> FUNCTION <<wrapInArray>>
// FUNCTION <<wrapInArray>> -> HAS_TYPE_PARAMETER -> TYPE_PARAMETER <<T>>
// FUNCTION <<wrapInArray>> -> HAS_TYPE_PARAMETER -> TYPE_PARAMETER <<R>>
// TYPE_PARAMETER <<R>> -> HAS_TYPE -> TYPE_PARAMETER <<T>>
// FUNCTION <<wrapInArray>> -> CONTAINS -> PARAMETER <<value>>
// PARAMETER <<value>> -> HAS_TYPE -> TYPE_PARAMETER <<T>>
// FUNCTION <<wrapInArray>> -> RETURNS -> EXPRESSION <<[value] as unknown as R>>
// EXPRESSION <<[value] as unknown as R>> -> DERIVES_FROM -> EXPRESSION <<[value]>>
// EXPRESSION <<[value]>> -> READS_FROM -> PARAMETER <<value>>
// EXPRESSION <<[value] as unknown as R>> -> DERIVES_FROM -> TYPE_PARAMETER <<R>>
// @end-annotation
function createGenericStore<
  S extends object,
  A extends object = {},
  G extends Record<string, (state: S) => unknown> = {},
>(config: { state: S; actions?: A; getters?: G }) {
  return config;
}

function wrapInArray<T, R = T[]>(value: T): R {
  return [value] as unknown as R;         // R defaults to T[]
}

// --- infer with constraints (TS 4.7+) ---

// @construct PENDING ts-infer-constrained
// @annotation
// UNKNOWN <<module>> -> DECLARES -> TYPE_ALIAS <<FirstString>>
// TYPE_ALIAS <<FirstString>> -> CONTAINS -> TYPE_PARAMETER <<T1>>
// TYPE_ALIAS <<FirstString>> -> ASSIGNED_FROM -> CONDITIONAL_TYPE <<FirstString:conditional>>
// CONDITIONAL_TYPE <<FirstString:conditional>> -> HAS_CONDITION -> TYPE_PARAMETER <<T1>>
// CONDITIONAL_TYPE <<FirstString:conditional>> -> EXTENDS -> TYPE_ALIAS <<[infer S extends string, ...unknown[]]>>
// TYPE_ALIAS <<[infer S extends string, ...unknown[]]>> -> INFERS -> INFER_TYPE <<S>>
// INFER_TYPE <<S>> -> CONSTRAINED_BY -> UNKNOWN <string>
// CONDITIONAL_TYPE <<FirstString:conditional>> -> HAS_CONSEQUENT -> INFER_TYPE <<S>>
// CONDITIONAL_TYPE <<FirstString:conditional>> -> HAS_ALTERNATE -> LITERAL_TYPE <<never1>>
// UNKNOWN <<module>> -> DECLARES -> TYPE_ALIAS <<NumericKeys>>
// TYPE_ALIAS <<NumericKeys>> -> CONTAINS -> TYPE_PARAMETER <<T2>>
// TYPE_ALIAS <<NumericKeys>> -> ASSIGNED_FROM -> TYPE_ALIAS <<NumericKeys:mapped>>
// TYPE_ALIAS <<NumericKeys:mapped>> -> ITERATES_OVER -> TYPE_PARAMETER <<T2>>
// TYPE_ALIAS <<NumericKeys:mapped>> -> DERIVES_FROM -> TYPE_REFERENCE <<NumericKeys:remapping>>
// TYPE_REFERENCE <<NumericKeys:remapping>> -> EXTENDS -> TYPE_REFERENCE <<${infer N extends number}>>
// TYPE_REFERENCE <<${infer N extends number}>> -> INFERS -> INFER_TYPE <<N>>
// INFER_TYPE <<N>> -> CONSTRAINED_BY -> UNKNOWN <number>
// TYPE_REFERENCE <<NumericKeys:remapping>> -> HAS_ALTERNATE -> LITERAL_TYPE <<never2>>
// UNKNOWN <<module>> -> DECLARES -> TYPE_ALIAS <<ParsePair>>
// TYPE_ALIAS <<ParsePair>> -> CONTAINS -> TYPE_PARAMETER <<T3>>
// TYPE_ALIAS <<ParsePair>> -> ASSIGNED_FROM -> CONDITIONAL_TYPE <<ParsePair:conditional>>
// CONDITIONAL_TYPE <<ParsePair:conditional>> -> HAS_CONDITION -> TYPE_PARAMETER <<T3>>
// CONDITIONAL_TYPE <<ParsePair:conditional>> -> EXTENDS -> TYPE_REFERENCE <<${infer A extends number},${infer B extends number}>>
// TYPE_REFERENCE <<${infer A extends number},${infer B extends number}>> -> INFERS -> INFER_TYPE <<A>>
// TYPE_REFERENCE <<${infer A extends number},${infer B extends number}>> -> INFERS -> INFER_TYPE <<B>>
// INFER_TYPE <<A>> -> CONSTRAINED_BY -> UNKNOWN <number>
// INFER_TYPE <<B>> -> CONSTRAINED_BY -> UNKNOWN <number>
// CONDITIONAL_TYPE <<ParsePair:conditional>> -> HAS_CONSEQUENT -> TYPE_ALIAS <<[A, B]>>
// TYPE_ALIAS <<[A, B]>> -> CONTAINS -> INFER_TYPE <<A>>
// TYPE_ALIAS <<[A, B]>> -> CONTAINS -> INFER_TYPE <<B>>
// CONDITIONAL_TYPE <<ParsePair:conditional>> -> HAS_ALTERNATE -> LITERAL_TYPE <<never3>>
// @end-annotation
type FirstString<T> = T extends [infer S extends string, ...unknown[]] ? S : never;
type NumericKeys<T> = { [K in keyof T as K extends `${infer N extends number}` ? K : never]: T[K] };
type ParsePair<T> = T extends `${infer A extends number},${infer B extends number}` ? [A, B] : never;

// --- Inline import() type expressions ---

// @construct PENDING ts-import-type-inline
// @annotation
// UNKNOWN <<module>> -> DECLARES -> TYPE_ALIAS <<InlineImported>>
// TYPE_ALIAS <<InlineImported>> -> ASSIGNED_FROM -> PROPERTY_ACCESS <<import('./modules-helpers.js').default>>
// PROPERTY_ACCESS <<import('./modules-helpers.js').default>> -> READS_FROM -> IMPORT <<import('./modules-helpers.js')>>
// IMPORT <<import('./modules-helpers.js')>> -> IMPORTS_FROM -> UNKNOWN <<./modules-helpers.js>>
// @end-annotation
// Type-level import() — resolves types without runtime import
type InlineImported = import('./modules-helpers.js').default;
// In function signatures: function handle(req: import('express').Request): void {}

// --- TypeScript using with type annotations ---

// @construct PENDING ts-using-typed
// @annotation
// UNKNOWN <<module>> -> DECLARES -> VARIABLE <<handle>>
// VARIABLE <<handle>> -> HAS_TYPE -> TYPE_REFERENCE <<FileHandle>>
// VARIABLE <<handle>> -> ASSIGNED_FROM -> CALL <<openFile('/tmp/data')>>
// CALL <<openFile('/tmp/data')>> -> CALLS -> UNKNOWN <<openFile>>
// CALL <<openFile('/tmp/data')>> -> PASSES_ARGUMENT -> LITERAL <<'/tmp/data'>>
// UNKNOWN <<module>> -> DECLARES -> VARIABLE <<conn>>
// VARIABLE <<conn>> -> HAS_TYPE -> TYPE_REFERENCE <<DBConnection>>
// VARIABLE <<conn>> -> ASSIGNED_FROM -> EXPRESSION <<await pool.connect()>>
// EXPRESSION <<await pool.connect()>> -> AWAITS -> CALL <<pool.connect()>>
// CALL <<pool.connect()>> -> CALLS -> UNKNOWN <<pool.connect>>
// LOOP <<for-using>> -> ITERATES_OVER -> CALL <<getReaders()>>
// LOOP <<for-using>> -> CONTAINS -> VARIABLE <<reader>>
// VARIABLE <<reader>> -> HAS_TYPE -> TYPE_REFERENCE <<Reader>>
// CALL <<getReaders()>> -> CALLS -> UNKNOWN <<getReaders>>
// CALL <<reader.process()>> -> CALLS -> UNKNOWN <<reader.process>>
// CALL <<reader.process()>> -> READS_FROM -> VARIABLE <<reader>>
// @end-annotation
// using with type annotations (TS extension of ES2025 Explicit Resource Management)
// using handle: FileHandle = openFile('/tmp/data');
// await using conn: DBConnection = await pool.connect();
// for (using reader: Reader of getReaders()) { reader.process(); }

// --- satisfies + as const combo ---

// @construct PENDING ts-satisfies-as-const
const routes = {
  home: '/',
  about: '/about',
  user: '/user/:id',
} as const satisfies Record<string, string>;

const palette = {
  red: [255, 0, 0],
  green: '#00ff00',
} satisfies Record<string, string | number[]>;

// --- TS CJS interop: export = / import = require() ---

// @construct PENDING ts-export-equals
// @annotation
// UNKNOWN <<module>> -> DECLARES -> CLASS <<CjsLibrary>>
// CLASS <<CjsLibrary>> -> CONTAINS -> PROPERTY <<CjsLibrary.VERSION>>
// PROPERTY <<CjsLibrary.VERSION>> -> ASSIGNED_FROM -> LITERAL <<'1.0'>>
// CLASS <<CjsLibrary>> -> CONTAINS -> METHOD <<CjsLibrary.process>>
// METHOD <<CjsLibrary.process>> -> CONTAINS -> PARAMETER <<data>>
// METHOD <<CjsLibrary.process>> -> RETURNS -> CALL <<data.toUpperCase()>>
// CALL <<data.toUpperCase()>> -> CALLS_ON -> PARAMETER <<data>>
// EXPORT <<export=CjsLibrary>> -> EXPORTS -> CLASS <<CjsLibrary>>
// @end-annotation
// CJS-style export assignment — emits: module.exports = CjsLibrary
class CjsLibrary {
  static VERSION = '1.0';
  process(data: string): string { return data.toUpperCase(); }
}
// export = CjsLibrary;
// (commented out: only one module export mode per file; shown for AST coverage)

// @construct PENDING ts-import-equals-require
// @annotation
// UNKNOWN <<module>> -> CONTAINS -> IMPORT <<import-equals>>
// IMPORT <<import-equals>> -> IMPORTS -> VARIABLE <<CjsLib>>
// UNKNOWN <<module>> -> IMPORTS_FROM -> UNKNOWN <<./module>>
// UNKNOWN <<module>> -> DECLARES -> VARIABLE <<instance>>
// VARIABLE <<instance>> -> ASSIGNED_FROM -> CALL <<new CjsLib()>>
// CALL <<new CjsLib()>> -> CALLS -> VARIABLE <<CjsLib>>
// @end-annotation
// CJS-style import — emits: const CjsLib = require('./module')
// import CjsLib = require('./module');
// const instance = new CjsLib();
// (commented out: requires actual CJS module; syntax is ExportAssignment / ImportEqualsDeclaration)

// --- Getter and setter with different types (TS 4.3+) ---

// @construct PENDING ts-getter-setter-different-types
class SmartField {
  #raw: string = '';

  get value(): string {
    return this.#raw;
  }

  // Setter accepts wider type than getter returns
  set value(input: string | number) {
    this.#raw = String(input);
  }
}

// --- Inline type modifier on import/export specifiers (TS 4.5+) ---

// @construct PENDING ts-inline-type-modifier
// @annotation
// UNKNOWN <<module>> -> CONTAINS -> IMPORT <<import-ui>>
// IMPORT <<import-ui>> -> IMPORTS -> VARIABLE <<Component>>
// IMPORT <<import-ui>> -> IMPORTS -> TYPE_ALIAS <<Props>>
// IMPORT <<import-ui>> -> IMPORTS -> TYPE_ALIAS <<State>>
// UNKNOWN <<module>> -> IMPORTS_FROM -> UNKNOWN <<./ui>>
// UNKNOWN <<module>> -> CONTAINS -> EXPORT <<export-handlers>>
// EXPORT <<export-handlers>> -> EXPORTS -> VARIABLE <<handler>>
// EXPORT <<export-handlers>> -> EXPORTS -> TYPE_ALIAS <<HandlerConfig>>
// UNKNOWN <<module>> -> IMPORTS_FROM -> UNKNOWN <<./handlers>>
// UNKNOWN <<module>> -> CONTAINS -> IMPORT <<import-types>>
// IMPORT <<import-types>> -> IMPORTS -> TYPE_ALIAS <<OnlyTypes>>
// @end-annotation
// Mixed value + type in single import:
// import { Component, type Props, type State } from './ui';
// Component → runtime import (IMPORTS_FROM edge)
// Props, State → type-only (erased, NO runtime dependency)

// Mixed value + type in single re-export:
// export { handler, type HandlerConfig } from './handlers';

// Contrast with import type (entire statement is type-only):
// import type { OnlyTypes } from './types';

// --- this parameter combined with destructuring ---

// @construct PENDING ts-this-param-destructured
function handleEvent(
  this: { id: string; logger: { info: (...args: unknown[]) => void } },
  { detail, bubbles }: { detail: unknown; bubbles: boolean }
): void {
  // this is NOT a real parameter — erased at runtime
  // {detail, bubbles} is the FIRST actual parameter
  this.logger.info(this.id, detail, bubbles);
}

// this + rest params
function middleware(
  this: { logger: { info: (...args: unknown[]) => void } },
  ...args: [string, number]
): void {
  this.logger.info('handling', args[0]);
}

// @construct PENDING ts-function-namespace-merge
// @annotation
// @end-annotation
// Function callable as function AND namespace for sub-utilities.
// TypeScript merges these into a single identifier with dual semantics.
function validate(value: unknown): boolean {
  return value !== null && value !== undefined;
}

namespace validate {
  export function strict(value: unknown): boolean {
    if (value === null) throw new Error('null not allowed');
    if (value === undefined) throw new Error('undefined not allowed');
    return true;
  }

  export const VERSION = '1.0.0';
}

// Usage patterns:
// validate(someValue)         → calls the FUNCTION node
// validate.strict(someValue)  → calls the NAMESPACE's FUNCTION node
// validate.VERSION            → PROPERTY_ACCESS on the NAMESPACE node

// @construct PENDING ts-accessor-decorator
// accessor keyword requires decoratorAutoAccessors Babel plugin — commented for now.
// function reactive(
//   target: ClassAccessorDecoratorTarget<ReactiveModel, string | number>,
//   context: ClassAccessorDecoratorContext
// ) {
//   return {
//     get(this: ReactiveModel) {
//       const val = target.get.call(this);
//       return val;
//     },
//     set(this: ReactiveModel, value: string | number) {
//       target.set.call(this, value);
//     },
//   };
// }
//
// class ReactiveModel {
//   @reactive accessor title: string = 'untitled';
//   @reactive accessor count: number = 0;
// }

// @construct PENDING export-named-list
export {
  typed,
  count,
  flag,
  typedFunction,
  typedArrow,
  identity,
  merge,
  Container,
  getLength,
  createArray,
  typeAssertions,
  nonNullAssertion,
  config,
  directions,
  theme,
  Service,
  ServiceWithParamProps,
  Shape,
  Circle,
  DecoratedClass,
  isString,
  hasName,
  sampleUser,
  Validation,
  Direction,
  Status,
  processInput,
  UserImpl,
  BaseWithMethod,
  DerivedWithOverride,
  assertDefined,
  literal,
  literalResult,
  createUserId,
  createOrderId,
  Builder,
  AdvancedBuilder,
  shapeArea,
  createFSM,
  withMixin,
  onActivate,
  Box,
  Parser,
  Point,
  Color,
  TrackedService,
  AppController,
  getProperty,
  pluck,
  ExampleForTypeof,
  classFactory,
  FSNode,
  FSFileNode,
  FSDirNode,
  HttpStatus,
  statusName,
  statusCode,
  createGenericStore,
  wrapInArray,
  routes,
  palette,
  CjsLibrary,
  SmartField,
  handleEvent,
  middleware,
  validate,
  // reactive, // commented out — accessor keyword needs decoratorAutoAccessors plugin
  // ReactiveModel,
};
