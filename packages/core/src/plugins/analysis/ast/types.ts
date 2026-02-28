/**
 * AST Analysis Types - общие типы для JSASTAnalyzer и GraphBuilder
 */

import type * as t from '@babel/types';
import type { ScopeTracker } from '../../../core/ScopeTracker.js';

// === MODULE NODE ===
export interface ModuleNode {
  id: string;
  type: 'MODULE';
  name: string;
  file: string;
  line: number;
  contentHash?: string;
  [key: string]: unknown;
}

// === FUNCTION INFO ===
export interface FunctionInfo {
  id: string;
  type: 'FUNCTION';
  name: string;
  file: string;
  line: number;
  column: number;
  async?: boolean;
  generator?: boolean;
  arrowFunction?: boolean;
  isAssignment?: boolean;
  isCallback?: boolean;
  parentScopeId?: string;
  controlFlow?: ControlFlowMetadata;
  // Class method fields (set by ClassVisitor)
  isClassMethod?: boolean;
  className?: string;
  // REG-271: Private methods support
  isPrivate?: boolean;   // true for #privateMethod
  isStatic?: boolean;    // true for static #method()
  methodKind?: 'constructor' | 'method' | 'get' | 'set';
  // REG-401: Parameter invocation tracking for user-defined HOFs
  invokesParamIndexes?: number[];
  // REG-417: Destructured parameter invocation — property paths for OBJECT_LITERAL resolution
  invokesParamBindings?: { paramIndex: number; propertyPath: string[] }[];
}

// === PARAMETER INFO ===
export interface ParameterInfo {
  id: string;
  semanticId?: string;  // Stable ID: file->scope->PARAMETER->name
  type: 'PARAMETER';
  name: string;
  file: string;
  line: number;
  column?: number;
  index?: number;
  hasDefault?: boolean;  // Has default value (e.g., function(a = 1))
  isRest?: boolean;      // Rest parameter (e.g., function(...args))
  functionId?: string;   // Legacy field - prefer parentFunctionId
  parentFunctionId?: string;
  scopePath?: string[];
  // REG-399: Destructuring metadata
  propertyPath?: string[];  // For nested object destructuring: ['data', 'user'] for ({ data: { user } })
  arrayIndex?: number;      // For array destructuring: 0 for first element in ([first, second])
}

// === SCOPE INFO ===
export interface ScopeInfo {
  id: string;
  type: 'SCOPE';
  scopeType: string;
  name?: string;
  semanticId?: string;  // Stable ID for diff comparison (e.g., "MyClass->myMethod:if_statement[0]")
  conditional?: boolean;
  condition?: string;
  constraints?: unknown[];
  file?: string;
  line: number;
  parentScopeId?: string;
  parentFunctionId?: string;
  capturesFrom?: string;
  modifies?: Array<{ variableId: string; variableName: string; line: number }>;
}

// === BRANCH INFO ===
export interface BranchInfo {
  id: string;
  semanticId?: string;
  type: 'BRANCH';
  branchType: 'switch' | 'if' | 'ternary';
  file: string;
  line: number;
  parentScopeId?: string;
  discriminantExpressionId?: string;  // ID of EXPRESSION node for discriminant
  // Linus improvement: store discriminant metadata directly instead of parsing from ID
  discriminantExpressionType?: string;
  discriminantLine?: number;
  discriminantColumn?: number;
  // For else-if chains: the parent BRANCH id whose alternate this branch is
  isAlternateOfBranchId?: string;
  // For ternary: IDs of consequent and alternate expressions
  consequentExpressionId?: string;
  alternateExpressionId?: string;

  // REG-533: Operand metadata for DERIVES_FROM edges on discriminant EXPRESSION nodes
  discriminantLeftSourceName?: string;
  discriminantRightSourceName?: string;
  discriminantObjectSourceName?: string;
  discriminantConsequentSourceName?: string;
  discriminantAlternateSourceName?: string;
  discriminantUnaryArgSourceName?: string;
  discriminantOperator?: string;
  discriminantObject?: string;
  discriminantProperty?: string;
  discriminantComputed?: boolean;
  discriminantExpressionSourceNames?: string[];
}

// === CASE INFO ===
export interface CaseInfo {
  id: string;
  semanticId?: string;
  type: 'CASE';
  value: unknown;
  isDefault: boolean;
  fallsThrough: boolean;
  isEmpty: boolean;
  file: string;
  line: number;
  parentBranchId: string;
}

// === LOOP INFO ===
export interface LoopInfo {
  id: string;
  semanticId?: string;
  type: 'LOOP';
  loopType: 'for' | 'for-in' | 'for-of' | 'while' | 'do-while';
  file: string;
  line: number;
  column?: number;
  parentScopeId?: string;
  // For for-in/for-of: the collection being iterated
  iteratesOverName?: string;      // Variable name (e.g., 'items')
  iteratesOverLine?: number;      // Line of collection reference
  iteratesOverColumn?: number;    // Column of collection reference
  // For while/do-while: condition expression (REG-280)
  conditionExpressionId?: string;     // ID of EXPRESSION/CALL node for condition
  conditionExpressionType?: string;   // 'Identifier', 'BinaryExpression', 'CallExpression', etc.
  conditionLine?: number;             // Line of condition expression
  conditionColumn?: number;           // Column of condition expression

  // For classic for loop (REG-282): init, test, update expressions
  // All three can be null (e.g., for (;;) {})

  // Init: let i = 0 - points to VARIABLE node
  initVariableName?: string;      // Variable name declared in init (e.g., 'i')
  initLine?: number;              // Line of init declaration

  // Test (condition): i < 10 - points to EXPRESSION node
  testExpressionId?: string;      // ID of EXPRESSION node
  testExpressionType?: string;    // 'BinaryExpression', 'Identifier', etc.
  testLine?: number;
  testColumn?: number;

  // Update: i++ - points to EXPRESSION node
  updateExpressionId?: string;    // ID of EXPRESSION node
  updateExpressionType?: string;  // 'UpdateExpression', 'AssignmentExpression', etc.
  updateLine?: number;
  updateColumn?: number;

  // For for-await-of (REG-284)
  async?: boolean;                // true for for-await-of loops

  // REG-533: Operand metadata for DERIVES_FROM edges on test EXPRESSION nodes
  testLeftSourceName?: string;
  testRightSourceName?: string;
  testObjectSourceName?: string;
  testConsequentSourceName?: string;
  testAlternateSourceName?: string;
  testUnaryArgSourceName?: string;
  testUpdateArgSourceName?: string;
  testOperator?: string;
  testObject?: string;
  testProperty?: string;
  testComputed?: boolean;
  testExpressionSourceNames?: string[];

  // REG-533: Operand metadata for DERIVES_FROM edges on update EXPRESSION nodes
  updateArgSourceName?: string;
  updateOperator?: string;
}

// === TRY BLOCK INFO ===
export interface TryBlockInfo {
  id: string;
  semanticId?: string;
  type: 'TRY_BLOCK';
  file: string;
  line: number;
  column?: number;
  parentScopeId?: string;
}

// === CATCH BLOCK INFO ===
export interface CatchBlockInfo {
  id: string;
  semanticId?: string;
  type: 'CATCH_BLOCK';
  file: string;
  line: number;
  column?: number;
  parentScopeId?: string;
  parentTryBlockId: string;  // ID of parent TRY_BLOCK
  parameterName?: string;     // Error parameter name
}

// === FINALLY BLOCK INFO ===
export interface FinallyBlockInfo {
  id: string;
  semanticId?: string;
  type: 'FINALLY_BLOCK';
  file: string;
  line: number;
  column?: number;
  parentScopeId?: string;
  parentTryBlockId: string;  // ID of parent TRY_BLOCK
}

// === CONTROL FLOW METADATA ===
// Attached to FUNCTION nodes
export interface ControlFlowMetadata {
  hasBranches: boolean;      // Has if/switch statements
  hasLoops: boolean;         // Has any loop type
  hasTryCatch: boolean;      // Has try/catch blocks
  hasEarlyReturn: boolean;   // Has return before function end
  hasThrow: boolean;         // Has throw statements
  cyclomaticComplexity: number;  // McCabe cyclomatic complexity
  // REG-311: Async error tracking
  canReject?: boolean;         // True if function can reject (has rejection patterns)
  hasAsyncThrow?: boolean;     // True if async function has throw statements
  rejectedBuiltinErrors?: string[];  // List of builtin error class names this function can reject
  // REG-286: Sync throw tracking
  thrownBuiltinErrors?: string[];    // List of builtin error class names this function can throw
}

// === VARIABLE DECLARATION INFO ===
export interface VariableDeclarationInfo {
  id: string;
  semanticId?: string;  // Stable ID: file->scope->VARIABLE->name
  type: 'VARIABLE' | 'CONSTANT';
  name: string;
  file: string;
  line: number;
  column?: number;
  value?: unknown;
  parentScopeId?: string;
  scopePath?: string[];
  // REG-271: Private fields support
  isPrivate?: boolean;      // true for #privateField
  isStatic?: boolean;       // true for static #field
  isClassProperty?: boolean; // true for class properties (vs local variables)
  // REG-552: TypeScript class property metadata
  accessibility?: 'public' | 'private' | 'protected';  // undefined = implicit public
  isReadonly?: boolean;                                   // true for readonly modifier
  tsType?: string;                                        // TypeScript type annotation string
}

// === GRAFEMA-IGNORE ANNOTATION (REG-332) ===
/**
 * Annotation from grafema-ignore comment to suppress strict mode errors.
 * Parsed from comments like: // grafema-ignore STRICT_UNRESOLVED_METHOD - reason
 */
export interface GrafemaIgnoreAnnotation {
  /** Error code to suppress (e.g., 'STRICT_UNRESOLVED_METHOD') */
  code: string;
  /** Optional reason provided by developer */
  reason?: string;
}

// === PROPERTY ACCESS INFO ===
export interface PropertyAccessInfo {
  id: string;
  semanticId?: string;  // Stable ID: file->scope->PROPERTY_ACCESS->objectName.propertyName#N
  type: 'PROPERTY_ACCESS';
  objectName: string;      // "config", "this", "a.b", etc.
  propertyName: string;    // "maxBodyLength", "<computed>", "0", etc.
  optional?: boolean;      // true for obj?.prop
  computed?: boolean;      // true for obj[x]
  file: string;
  line: number;
  column: number;
  endLine?: number;
  endColumn?: number;
  parentScopeId?: string;
  scopePath?: string[];        // scope path for resolveVariable/resolveParam lookup
  enclosingClassName?: string; // class name when objectName === 'this'
}

// === PROPERTY ASSIGNMENT INFO ===
export interface PropertyAssignmentInfo {
  id: string;
  semanticId?: string;       // Stable ID: file->scope->PROPERTY_ASSIGNMENT->objectName.propertyName#N
  type: 'PROPERTY_ASSIGNMENT';
  objectName: string;        // 'this' or object variable name
  propertyName: string;      // 'graph', '<computed>', etc.
  computed?: boolean;        // true for obj[x] = value
  file: string;
  line: number;
  column: number;
  endLine?: number;
  endColumn?: number;
  parentScopeId?: string;
  scopePath?: string[];
  enclosingClassName?: string;     // class name when objectName === 'this'
  // RHS value info (for ASSIGNED_FROM edge resolution)
  valueType: 'LITERAL' | 'VARIABLE' | 'CALL' | 'EXPRESSION' | 'OBJECT_LITERAL' | 'ARRAY_LITERAL' | 'MEMBER_EXPRESSION';
  valueName?: string;              // For VARIABLE type: the RHS variable name
  // For MEMBER_EXPRESSION type: object and property of the RHS member expression
  memberObject?: string;
  memberProperty?: string;
  // Source line/column of RHS member expression for PROPERTY_ACCESS node lookup
  memberLine?: number;
  memberColumn?: number;
}

// === CALL SITE INFO ===
export interface CallSiteInfo {
  id: string;
  semanticId?: string;  // Stable ID: file->scope->CALL->name#N
  type: 'CALL';
  name: string;
  file: string;
  line: number;
  column?: number;
  endLine?: number;
  endColumn?: number;
  parentScopeId?: string;
  targetFunctionName?: string;
  isNew?: boolean;
  /** REG-332: Annotation to suppress strict mode errors */
  grafemaIgnore?: GrafemaIgnoreAnnotation;
  /** REG-311: true if wrapped in await expression */
  isAwaited?: boolean;
  /** REG-311: true if inside try block (protected from propagation) */
  isInsideTry?: boolean;
  /** REG-298: true if awaited call is inside a loop body */
  isInsideLoop?: boolean;
}

// === METHOD CALL INFO ===
export interface MethodCallInfo {
  id: string;
  semanticId?: string;  // Stable ID: file->scope->CALL->object.method#N
  type: 'CALL';
  name: string;
  object: string;
  method: string;
  computed?: boolean;             // Whether method was accessed via computed property [x]
  computedPropertyVar?: string | null;  // Variable name used in obj[x]() calls
  file: string;
  line: number;
  column?: number;
  endLine?: number;
  endColumn?: number;
  parentScopeId?: string;
  arguments?: unknown[];
  isNew?: boolean;
  /** REG-332: Annotation to suppress strict mode errors */
  grafemaIgnore?: GrafemaIgnoreAnnotation;
  /** REG-311: true if wrapped in await expression */
  isAwaited?: boolean;
  /** REG-311: true if inside try block (protected from propagation) */
  isInsideTry?: boolean;
  /** REG-298: true if awaited call is inside a loop body */
  isInsideLoop?: boolean;
  /** REG-311: true if this is a method call (for CALL node filtering) */
  isMethodCall?: boolean;
  /** REG-579: Position of the object expression (for chain detection) */
  objectLine?: number;
  objectColumn?: number;
}

// === EVENT LISTENER INFO ===
export interface EventListenerInfo {
  id: string;
  semanticId?: string;  // Stable ID: file->scope->EVENT_LISTENER->name#N
  type: 'event:listener';
  name: string;
  object: string;
  file: string;
  line: number;
  parentScopeId?: string;
  callbackArg?: t.Node;
}

// === CLASS INSTANTIATION INFO ===
export interface ClassInstantiationInfo {
  variableId: string;
  variableName: string;
  className: string;
  line: number;
  parentScopeId?: string;
}

// === CONSTRUCTOR CALL INFO ===
export interface ConstructorCallInfo {
  id: string;
  type: 'CONSTRUCTOR_CALL';
  className: string;
  isBuiltin: boolean;
  file: string;
  line: number;
  column: number;
  parentScopeId?: string;
}

// === CLASS DECLARATION INFO ===
export interface ClassDeclarationInfo {
  id: string;
  semanticId?: string;  // Stable ID: file->scope->CLASS->name
  type: 'CLASS';
  name: string;
  file: string;
  line: number;
  column?: number;
  superClass?: string;
  implements?: string[];  // имена интерфейсов, которые реализует класс
  methods: string[];
  // REG-271: Additional class members
  properties?: string[];     // IDs of class properties (including private)
  staticBlocks?: string[];   // IDs of static block scopes
}

// === INTERFACE DECLARATION INFO ===
export interface InterfaceDeclarationInfo {
  /**
   * @deprecated ID is now generated by InterfaceNode.create() in GraphBuilder.
   * This field will be removed in a future version.
   */
  id?: string;
  semanticId?: string;  // Stable ID: file->scope->INTERFACE->name
  type: 'INTERFACE';
  name: string;
  file: string;
  line: number;
  column?: number;
  extends?: string[];  // имена родительских интерфейсов
  properties: InterfacePropertyInfo[];
}

export interface InterfacePropertyInfo {
  name: string;
  type?: string;
  optional?: boolean;
  readonly?: boolean;
}

// === TYPE ALIAS INFO ===
export interface TypeAliasInfo {
  /**
   * @deprecated ID is now generated by NodeFactory.createType() in GraphBuilder.
   * This field will be removed in a future version.
   */
  id?: string;
  semanticId?: string;  // Stable ID: file->scope->TYPE->name
  type: 'TYPE';
  name: string;
  file: string;
  line: number;
  column?: number;
  aliasOf?: string;  // строковое представление типа
  mappedType?: boolean;
  keyName?: string;
  keyConstraint?: string;
  valueType?: string;
  mappedReadonly?: boolean | '+' | '-';
  mappedOptional?: boolean | '+' | '-';
  nameType?: string;
  conditionalType?: boolean;
  checkType?: string;
  extendsType?: string;
  trueType?: string;
  falseType?: string;
}

// === ENUM DECLARATION INFO ===
export interface EnumDeclarationInfo {
  /**
   * @deprecated ID is now generated by EnumNode.create() in GraphBuilder.
   * This field will be removed in a future version.
   */
  id?: string;
  semanticId?: string;  // Stable ID: file->scope->ENUM->name
  type: 'ENUM';
  name: string;
  file: string;
  line: number;
  column?: number;
  isConst?: boolean;  // const enum
  members: EnumMemberInfo[];
}

export interface EnumMemberInfo {
  name: string;
  value?: string | number;
}

// === DECORATOR INFO ===
export interface DecoratorInfo {
  id: string;
  semanticId?: string;  // Stable ID: file->target->DECORATOR->name#N
  type: 'DECORATOR';
  name: string;
  file: string;
  line: number;
  column?: number;
  arguments?: unknown[];  // аргументы декоратора
  targetId: string;       // ID класса/метода/свойства
  targetType: 'CLASS' | 'METHOD' | 'PROPERTY' | 'PARAMETER';
}

// === TYPE PARAMETER INFO ===
export interface TypeParameterInfo {
  name: string;              // "T", "K", "V"
  constraintType?: string;   // "Serializable" (string repr via typeNodeToString)
  defaultType?: string;      // "string" (string repr via typeNodeToString)
  variance?: 'in' | 'out' | 'in out';
  parentId: string;          // ID of owning function/class/interface/type
  parentType: 'FUNCTION' | 'CLASS' | 'INTERFACE' | 'TYPE';
  file: string;
  line: number;
  column: number;
}

// === METHOD CALLBACK INFO ===
export interface MethodCallbackInfo {
  methodCallId: string;
  callbackLine: number;
  callbackColumn: number;
  callbackType: string;
}

// === CALL ARGUMENT INFO ===
export interface CallArgumentInfo {
  callId: string;
  argIndex: number;
  argValue?: unknown;
  targetType?: string;
  targetId?: string;
  targetName?: string;
  file?: string;
  // REG-334: Additional fields for resolve/reject argument tracking
  line?: number;
  column?: number;
  literalValue?: unknown;
  expressionType?: string;
  isSpread?: boolean;
  functionLine?: number;
  functionColumn?: number;
  nestedCallLine?: number;
  nestedCallColumn?: number;
  // REG-402: MemberExpression argument fields for this.method callback resolution
  objectName?: string;
  propertyName?: string;
  enclosingClassName?: string;
}

// === IMPORT INFO ===
export interface ImportInfo {
  id: string;
  type: 'IMPORT';
  name: string;
  source: string;
  file: string;
  line: number;
  column?: number;  // Column position for ImportNode
  specifiers: ImportSpecifier[];
  importKind?: 'value' | 'type' | 'typeof';  // TypeScript: import type { ... }
  isDynamic?: boolean;         // true for dynamic import() expressions
  isResolvable?: boolean;      // true if path is a string literal (statically analyzable)
  dynamicPath?: string;        // original expression for template/variable paths
}

export interface ImportSpecifier {
  imported: string;  // имя в экспортируемом модуле (default, *, или имя)
  local: string;     // имя в текущем модуле
  importKind?: 'value' | 'type' | 'typeof';  // specifier-level: import { type X } from '...'
  column?: number;      // specifier start column
  endColumn?: number;   // specifier end column (exclusive)
}

// === EXPORT INFO ===
export interface ExportInfo {
  id: string;
  type: 'EXPORT' | 'default' | 'named' | 'all';
  name: string;
  file: string;
  line: number;
  specifiers?: ExportSpecifier[];
  source?: string;  // для re-exports: export { foo } from './other'
}

export interface ExportSpecifier {
  local: string;
  exported: string;
  column?: number;
  endColumn?: number;
}

// === HTTP REQUEST INFO ===
export interface HttpRequestInfo {
  id: string;
  type: 'http:request';
  method: string;
  url: string;
  file: string;
  line: number;
  parentScopeId?: string;
}

// === LITERAL INFO ===
export interface LiteralInfo {
  id: string;
  semanticId?: string;  // Stable ID: file->scope->LITERAL->type#N
  type: 'LITERAL' | 'CALL';
  value?: unknown;
  valueType?: string;
  name?: string;
  object?: string;
  method?: string;
  arguments?: unknown[];
  file: string;
  line: number;
  column?: number;
  parentCallId?: string;
  argIndex?: number;
}

// === OBJECT LITERAL INFO ===
export interface ObjectLiteralInfo {
  id: string;
  semanticId?: string;  // Stable ID: file->scope->OBJECT_LITERAL->literal#N
  type: 'OBJECT_LITERAL';
  file: string;
  line: number;
  column: number;
  parentCallId?: string;
  argIndex?: number;
  isSpread?: boolean;
}

// === OBJECT PROPERTY INFO ===
export interface ObjectPropertyInfo {
  objectId: string;
  propertyName: string;
  valueNodeId?: string;
  valueType: 'LITERAL' | 'VARIABLE' | 'CALL' | 'EXPRESSION' | 'OBJECT_LITERAL' | 'ARRAY_LITERAL' | 'SPREAD';
  valueName?: string;       // For VARIABLE
  literalValue?: unknown;   // For LITERAL
  file: string;
  line: number;
  column: number;
  // For CALL values
  callLine?: number;
  callColumn?: number;
  // For nested object/array
  nestedObjectId?: string;
  nestedArrayId?: string;
  // For VARIABLE values - scope path for scope-aware lookup (REG-329)
  valueScopePath?: string[];
}

// === ARRAY LITERAL INFO ===
export interface ArrayLiteralInfo {
  id: string;
  semanticId?: string;  // Stable ID: file->scope->ARRAY_LITERAL->literal#N
  type: 'ARRAY_LITERAL';
  file: string;
  line: number;
  column: number;
  parentCallId?: string;
  argIndex?: number;
}

// === ARRAY ELEMENT INFO ===
export interface ArrayElementInfo {
  arrayId: string;
  index: number;
  valueNodeId?: string;
  valueType: 'LITERAL' | 'VARIABLE' | 'CALL' | 'EXPRESSION' | 'OBJECT_LITERAL' | 'ARRAY_LITERAL' | 'SPREAD';
  valueName?: string;       // For VARIABLE
  literalValue?: unknown;   // For LITERAL
  file: string;
  line: number;
  column: number;
  // For CALL values
  callLine?: number;
  callColumn?: number;
  // For nested object/array
  nestedObjectId?: string;
  nestedArrayId?: string;
}

// === ARRAY MUTATION INFO ===
/**
 * Tracks array mutation calls (push, unshift, splice) and indexed assignments
 * Used to create FLOWS_INTO edges in GraphBuilder
 *
 * IMPORTANT: This type is defined ONLY here. Import from this file everywhere.
 */
export interface ArrayMutationInfo {
  id?: string;                 // Semantic ID for the mutation (optional for backward compatibility)
  arrayName: string;           // Name of the array variable being mutated
  arrayLine?: number;          // Line where array is referenced (for scope resolution)
  mutationScopePath?: string[];  // Scope path where mutation happens (from ScopeTracker)
  mutationMethod: 'push' | 'unshift' | 'splice' | 'indexed';
  file: string;
  line: number;
  column: number;
  insertedValues: ArrayMutationArgument[];  // What's being added to the array
  isNested?: boolean;          // REG-117: true if receiver is MemberExpression
  baseObjectName?: string;     // REG-117: "obj" from obj.arr.push()
  propertyName?: string;       // REG-117: "arr" - the array property name
}

export interface ArrayMutationArgument {
  argIndex: number;
  isSpread?: boolean;
  valueType: 'LITERAL' | 'VARIABLE' | 'CALL' | 'EXPRESSION' | 'OBJECT_LITERAL' | 'ARRAY_LITERAL';
  valueName?: string;          // For VARIABLE type - name of the variable
  valueNodeId?: string;        // For LITERAL, OBJECT_LITERAL, ARRAY_LITERAL - node ID
  valueLine?: number;          // Line of the value expression (for node lookup in GraphBuilder)
  valueColumn?: number;        // Column of the value expression (for node lookup in GraphBuilder)
  literalValue?: unknown;      // For LITERAL type
  callLine?: number;           // For CALL type
  callColumn?: number;
}

// === OBJECT MUTATION INFO ===
/**
 * Tracks object property mutations for FLOWS_INTO edge creation in GraphBuilder.
 * Handles: obj.prop = value, obj['prop'] = value, Object.assign(), spread in object literals.
 *
 * IMPORTANT: This type is defined ONLY here. Import from this file everywhere.
 */
export interface ObjectMutationInfo {
  id?: string;                   // Semantic ID for the mutation (optional for backward compatibility)
  objectName: string;            // Name of the object being mutated ('config', 'this', etc.)
  objectLine?: number;           // Line where object is referenced (for scope resolution)
  mutationScopePath?: string[];  // Scope path where mutation happens (from ScopeTracker)
  enclosingClassName?: string;   // Class name when objectName === 'this' (REG-152)
  enclosingFunctionName?: string;  // Function name when objectName === 'this' (REG-557)
  propertyName: string;          // Property name or '<computed>' for obj[x] or '<assign>' for Object.assign
  mutationType: 'property' | 'computed' | 'assign' | 'spread';
  computedPropertyVar?: string;  // Variable name in obj[key] = value (for computed mutation type)
  file: string;
  line: number;
  column: number;
  value: ObjectMutationValue;
}

export interface ObjectMutationValue {
  valueType: 'LITERAL' | 'VARIABLE' | 'CALL' | 'EXPRESSION' | 'OBJECT_LITERAL' | 'ARRAY_LITERAL' | 'MEMBER_EXPRESSION';
  valueName?: string;            // For VARIABLE type - name of the variable
  valueNodeId?: string;          // For LITERAL, OBJECT_LITERAL, ARRAY_LITERAL - node ID
  literalValue?: unknown;        // For LITERAL type
  callLine?: number;             // For CALL type
  callColumn?: number;
  isSpread?: boolean;            // For Object.assign with spread: Object.assign(target, ...sources)
  argIndex?: number;             // For Object.assign - which source argument (0, 1, 2, ...)
  // REG-554: For MEMBER_EXPRESSION type (e.g., options.graph in this.graph = options.graph)
  memberObject?: string;         // Object name (e.g., 'options')
  memberProperty?: string;       // Property name (e.g., 'graph')
  memberLine?: number;           // Source location for PROPERTY_ACCESS node lookup
  memberColumn?: number;
}

// === RETURN STATEMENT INFO ===
/**
 * Tracks return statements for RETURNS edge creation in GraphBuilder.
 * Used to connect returned expressions to their containing functions.
 *
 * Edge direction: returnExpression --RETURNS--> function
 */
export interface ReturnStatementInfo {
  parentFunctionId: string;          // ID of the containing function
  file: string;
  line: number;
  column: number;
  // Return value type determines how to resolve the source node
  returnValueType: 'VARIABLE' | 'CALL_SITE' | 'METHOD_CALL' | 'LITERAL' | 'EXPRESSION' | 'NONE';
  // For VARIABLE type
  returnValueName?: string;
  // For LITERAL type - the literal node ID
  returnValueId?: string;
  // For CALL_SITE/METHOD_CALL type - coordinates for lookup
  returnValueLine?: number;
  returnValueColumn?: number;
  returnValueCallName?: string;
  // For EXPRESSION type (BinaryExpression, ConditionalExpression, etc.)
  expressionType?: string;

  // For EXPRESSION type - source variable extraction (REG-276)
  // Mirrors VariableAssignmentInfo pattern for code reuse

  // For BinaryExpression/LogicalExpression
  operator?: string;
  leftSourceName?: string;
  rightSourceName?: string;

  // For ConditionalExpression
  consequentSourceName?: string;
  alternateSourceName?: string;

  // For MemberExpression
  object?: string;
  property?: string;
  computed?: boolean;
  objectSourceName?: string;

  // For TemplateLiteral
  expressionSourceNames?: string[];

  // For UnaryExpression
  unaryArgSourceName?: string;

  // For arrow function implicit returns
  isImplicitReturn?: boolean;
}

// === YIELD EXPRESSION INFO (REG-270) ===
/**
 * Tracks yield expressions for YIELDS and DELEGATES_TO edge creation in GraphBuilder.
 * Used to connect yielded expressions to their containing generator functions.
 *
 * Edge direction:
 * - For yield:  yieldedExpression --YIELDS--> generatorFunction
 * - For yield*: delegatedCall --DELEGATES_TO--> generatorFunction
 *
 * Examples:
 * - `yield 42;` creates: LITERAL(42) --YIELDS--> FUNCTION(gen)
 * - `yield* otherGen();` creates: CALL(otherGen) --DELEGATES_TO--> FUNCTION(gen)
 */
export interface YieldExpressionInfo {
  parentFunctionId: string;          // ID of the containing generator function
  file: string;
  line: number;
  column: number;

  /** true for yield*, false for yield */
  isDelegate: boolean;

  // Yield value type determines how to resolve the source node
  // Uses same types as ReturnStatementInfo for code reuse
  yieldValueType: 'VARIABLE' | 'CALL_SITE' | 'METHOD_CALL' | 'LITERAL' | 'EXPRESSION' | 'NONE';

  // For VARIABLE type
  yieldValueName?: string;

  // For LITERAL type - the literal node ID
  yieldValueId?: string;

  // For CALL_SITE/METHOD_CALL type - coordinates for lookup
  yieldValueLine?: number;
  yieldValueColumn?: number;
  yieldValueCallName?: string;

  // For EXPRESSION type (BinaryExpression, ConditionalExpression, etc.)
  expressionType?: string;

  // For EXPRESSION type - source variable extraction (mirrors ReturnStatementInfo)
  // For BinaryExpression/LogicalExpression
  operator?: string;
  leftSourceName?: string;
  rightSourceName?: string;

  // For ConditionalExpression
  consequentSourceName?: string;
  alternateSourceName?: string;

  // For MemberExpression
  object?: string;
  property?: string;
  computed?: boolean;
  objectSourceName?: string;

  // For TemplateLiteral
  expressionSourceNames?: string[];

  // For UnaryExpression
  unaryArgSourceName?: string;
}

/**
 * Resolution status for computed property names.
 * Used in FLOWS_INTO edge metadata to indicate how property name was determined.
 *
 * - RESOLVED: Single deterministic value traced from literals
 * - RESOLVED_CONDITIONAL: Multiple possible values (ternary, logical OR, etc.)
 * - UNKNOWN_PARAMETER: Variable traces to function parameter
 * - UNKNOWN_RUNTIME: Variable traces to function call result
 * - DEFERRED_CROSS_FILE: Variable traces to import (requires cross-file analysis)
 */
export type ResolutionStatus =
  | 'RESOLVED'
  | 'RESOLVED_CONDITIONAL'
  | 'UNKNOWN_PARAMETER'
  | 'UNKNOWN_RUNTIME'
  | 'DEFERRED_CROSS_FILE';

// === VARIABLE ASSIGNMENT INFO ===
export interface VariableAssignmentInfo {
  variableId: string;
  sourceId?: string | null;
  sourceType: string;
  callName?: string;
  callLine?: number;
  callColumn?: number;
  sourceName?: string;
  sourceLine?: number;
  sourceColumn?: number;
  sourceFile?: string;
  className?: string;
  functionName?: string;
  line?: number;
  column?: number;  // Column position for EXPRESSION nodes
  expressionType?: string;
  object?: string;
  property?: string;
  computed?: boolean;
  computedPropertyVar?: string | null;
  objectSourceName?: string | null;
  operator?: string;
  leftSourceName?: string | null;
  rightSourceName?: string | null;
  consequentSourceName?: string | null;
  alternateSourceName?: string | null;
  expressionSourceNames?: string[];
  // UnaryExpression support (REG-534)
  unaryArgSourceName?: string | null;
  // REG-569: Operand literal metadata for DERIVES_FROM edges to inline LITERAL nodes
  // When an operand is not an Identifier, *SourceName is null. These fields carry
  // the literal value so AssignmentBuilder can create LITERAL nodes + DERIVES_FROM edges.
  leftOperandLiteral?: boolean;
  leftOperandValue?: unknown;
  leftOperandLine?: number;
  leftOperandColumn?: number;
  rightOperandLiteral?: boolean;
  rightOperandValue?: unknown;
  rightOperandLine?: number;
  rightOperandColumn?: number;
  consequentOperandLiteral?: boolean;
  consequentOperandValue?: unknown;
  consequentOperandLine?: number;
  consequentOperandColumn?: number;
  alternateOperandLiteral?: boolean;
  alternateOperandValue?: unknown;
  alternateOperandLine?: number;
  alternateOperandColumn?: number;
  unaryArgOperandLiteral?: boolean;
  unaryArgOperandValue?: unknown;
  unaryArgOperandLine?: number;
  unaryArgOperandColumn?: number;
  file?: string;
  // Destructuring support (REG-201)
  path?: string;               // Full property path string, e.g., "req.headers.contentType"
  baseName?: string;           // Base object name, e.g., "req"
  propertyPath?: string[];     // Property path array, e.g., ["headers", "contentType"]
  arrayIndex?: number;         // Array index for array destructuring, e.g., 0 for first element

  // Call-based destructuring support (REG-223)
  callSourceLine?: number;     // Line of the CallExpression
  callSourceColumn?: number;   // Column of the CallExpression
  callSourceFile?: string;     // File containing the call
  callSourceName?: string;     // Function name (for lookup disambiguation)
  sourceMetadata?: {
    sourceType: 'call' | 'variable' | 'method-call';
  };
}

// === VARIABLE REASSIGNMENT INFO ===
/**
 * Tracks variable reassignments for FLOWS_INTO edge creation.
 * Used when a variable is assigned AFTER its declaration: x = y (not const x = y).
 *
 * Edge direction: value --FLOWS_INTO--> variable
 *
 * Supports:
 * - Simple assignment: x = y
 * - Compound operators: x += y, x -= y, x *= y, x /= y, x %= y, x **= y
 * - Bitwise operators: x &= y, x |= y, x ^= y, x <<= y, x >>= y, x >>>= y
 * - Logical operators: x &&= y, x ||= y, x ??= y
 *
 * For compound operators (operator !== '='), creates TWO edges:
 * - READS_FROM: variable --READS_FROM--> variable (self-loop, reads current value)
 * - FLOWS_INTO: source --FLOWS_INTO--> variable (writes new value)
 *
 * Distinction from VariableAssignmentInfo:
 * - VariableAssignmentInfo: initialization (const x = y) -> ASSIGNED_FROM edge
 * - VariableReassignmentInfo: mutation (x = y, x += y) -> FLOWS_INTO edge
 */
export interface VariableReassignmentInfo {
  variableName: string;           // Name of variable being reassigned
  variableLine: number;           // Line where variable is referenced on LHS
  mutationScopePath?: string[];   // Scope path where mutation happens (from ScopeTracker)
  valueType: 'VARIABLE' | 'CALL_SITE' | 'METHOD_CALL' | 'LITERAL' | 'EXPRESSION';
  valueName?: string;             // For VARIABLE, CALL_SITE types
  valueId?: string | null;        // For LITERAL, EXPRESSION types
  callLine?: number;              // For CALL_SITE, METHOD_CALL types
  callColumn?: number;
  operator: string;               // '=', '+=', '-=', '*=', etc.

  // For LITERAL type - complete metadata for node creation
  literalValue?: unknown;         // Actual literal value (number, string, boolean, null)

  // For EXPRESSION type - complete metadata for node creation
  expressionType?: string;        // 'MemberExpression', 'BinaryExpression', 'ConditionalExpression', etc.
  expressionMetadata?: {          // Type-specific metadata (matches VariableAssignmentInfo pattern)
    // MemberExpression
    object?: string;
    property?: string;
    computed?: boolean;
    computedPropertyVar?: string | null;

    // BinaryExpression, LogicalExpression
    operator?: string;
    leftSourceName?: string;
    rightSourceName?: string;

    // ConditionalExpression
    consequentSourceName?: string;
    alternateSourceName?: string;
  };

  file: string;
  line: number;                   // Line of assignment statement
  column: number;
}

// === UPDATE EXPRESSION INFO (i++, obj.prop++, arr[i]++) ===
/**
 * Information about update expressions (increment/decrement).
 *
 * Supports two target types:
 * - IDENTIFIER: Simple variable (i++, --count)
 * - MEMBER_EXPRESSION: Object property (obj.prop++, arr[i]++, this.count++)
 *
 * Creates:
 * - UPDATE_EXPRESSION node with operator and target metadata
 * - MODIFIES edge: UPDATE_EXPRESSION -> target (VARIABLE, PARAMETER, or CLASS)
 * - READS_FROM self-loop: target -> target (reads current value before update)
 * - CONTAINS edge: SCOPE -> UPDATE_EXPRESSION
 *
 * REG-288: Initial implementation for IDENTIFIER targets
 * REG-312: Extended for MEMBER_EXPRESSION targets (obj.prop++, arr[i]++)
 */
export interface UpdateExpressionInfo {
  // Common fields for all update expressions
  operator: '++' | '--';          // Increment or decrement
  prefix: boolean;                // ++i (true) vs i++ (false)
  file: string;
  line: number;                   // Line of update expression
  column: number;
  parentScopeId?: string;         // Containing scope for CONTAINS edge

  // Discriminator: IDENTIFIER (i++) vs MEMBER_EXPRESSION (obj.prop++)
  targetType: 'IDENTIFIER' | 'MEMBER_EXPRESSION';

  // ===== IDENTIFIER fields (REG-288 behavior) =====
  variableName?: string;          // Name of variable being modified (for i++)
  variableLine?: number;          // Line where variable is referenced

  // ===== MEMBER_EXPRESSION fields (REG-312 new) =====
  objectName?: string;            // Object name ("obj" from obj.prop++, "this" from this.count++)
  objectLine?: number;            // Line where object is referenced (for scope resolution)
  enclosingClassName?: string;    // Class name when objectName === 'this' (follows REG-152 pattern)
  enclosingFunctionName?: string; // Function name when objectName === 'this' (REG-557)
  propertyName?: string;          // Property name ("prop" from obj.prop++, "<computed>" for obj[key]++)
  mutationType?: 'property' | 'computed';  // 'property' for obj.prop++, 'computed' for obj[key]++
  computedPropertyVar?: string;   // Variable name for computed access: obj[i]++ -> "i"
}

// === PROMISE EXECUTOR CONTEXT ===
/**
 * Tracks Promise executor context during analysis.
 * Used to detect when resolve/reject calls should create RESOLVES_TO edges.
 *
 * Stored in collections.promiseExecutorContexts Map, keyed by executor function's start:end position.
 */
export interface PromiseExecutorContext {
  /** ID of the CONSTRUCTOR_CALL node for `new Promise()` */
  constructorCallId: string;
  /** Name of the first parameter (typically 'resolve') */
  resolveName: string;
  /** Name of the second parameter (typically 'reject'), if any */
  rejectName?: string;
  /** File path for edge creation */
  file: string;
  /** Line of the Promise constructor for debugging */
  line: number;
  /** REG-311: ID of the function that creates the Promise (for attributing rejection patterns) */
  creatorFunctionId?: string;
}

// === PROMISE RESOLUTION INFO ===
/**
 * Info for Promise resolution RESOLVES_TO edges.
 * Created when resolve(value) or reject(error) is called inside Promise executor.
 *
 * Graph structure:
 * CALL[resolve(42)] --RESOLVES_TO--> CONSTRUCTOR_CALL[new Promise]
 *
 * Edge direction: resolve CALL -> Promise CONSTRUCTOR_CALL
 * This allows traceValues to follow RESOLVES_TO from Promise to find data sources.
 */
export interface PromiseResolutionInfo {
  /** ID of the resolve/reject CALL node */
  callId: string;
  /** ID of the Promise CONSTRUCTOR_CALL node */
  constructorCallId: string;
  /** True if this is reject(), false for resolve() */
  isReject: boolean;
  /** File path */
  file: string;
  /** Line number of resolve/reject call */
  line: number;
}

// === REJECTION PATTERN INFO (REG-311, REG-286) ===
/**
 * Tracks patterns that can cause errors (throws or Promise rejections) in a function.
 * Used for THROWS/REJECTS edge creation and error flow analysis.
 *
 * Patterns detected:
 * - promise_reject: Promise.reject(new Error())
 * - executor_reject: reject(new Error()) in Promise executor
 * - async_throw: throw new Error() in async function
 * - sync_throw: throw new Error() in non-async function (REG-286)
 * - variable_traced: throw/reject(err) where err traced to NewExpression
 * - variable_parameter: throw/reject(param) where param is function parameter
 * - variable_unknown: throw/reject(x) where x couldn't be traced
 *
 * Edge type selection:
 * - isAsync=true patterns → REJECTS edge (async errors caught by .catch())
 * - isAsync=false patterns → THROWS edge (sync errors caught by try/catch)
 */
export interface RejectionPatternInfo {
  /** ID of the containing FUNCTION node */
  functionId: string;
  /** Error class name (e.g., 'Error', 'ValidationError') - null for unresolved variables */
  errorClassName: string | null;
  /** Rejection pattern type */
  rejectionType:
    | 'promise_reject'     // Promise.reject(new Error())
    | 'executor_reject'    // reject(new Error()) in Promise executor
    | 'async_throw'        // throw new Error() in async function
    | 'sync_throw'         // throw new Error() in non-async function (REG-286)
    | 'variable_traced'    // throw/reject(err) where err traced to NewExpression
    | 'variable_parameter' // throw/reject(param) where param is function parameter
    | 'variable_unknown';  // throw/reject(x) where x couldn't be traced
  /** Whether the containing function is async (determines THROWS vs REJECTS edge) */
  isAsync: boolean;
  /** File path */
  file: string;
  /** Line number of rejection call */
  line: number;
  /** Column number */
  column: number;
  /** Source variable name (for variable_* types) */
  sourceVariableName?: string;
  /** Trace path for debugging (e.g., ["err", "error", "new ValidationError"]) */
  tracePath?: string[];
}

// === CATCHES FROM INFO (REG-311) ===
/**
 * Info for CATCHES_FROM edges linking catch parameters to error sources.
 * Created when analyzing try/catch blocks to track which exception sources
 * a catch block can handle.
 *
 * Sources include:
 * - awaited_call: await foo() in try block
 * - sync_call: foo() in try block (any call can throw)
 * - throw_statement: throw new Error() in try block
 * - constructor_call: new SomeClass() in try block
 */
export interface CatchesFromInfo {
  /** ID of the CATCH_BLOCK node */
  catchBlockId: string;
  /** Name of catch parameter (e.g., 'e' in catch(e)) */
  parameterName: string;
  /** ID of source node in try block (CALL, THROW_STATEMENT, CONSTRUCTOR_CALL) */
  sourceId: string;
  /** Source type */
  sourceType: 'awaited_call' | 'sync_call' | 'throw_statement' | 'constructor_call';
  /** File path */
  file: string;
  /** Line of the source (for metadata) */
  sourceLine: number;
}

// === COUNTER REF ===
export interface CounterRef {
  value: number;
}

// === PROCESSED NODES ===
export interface ProcessedNodes {
  functions: Set<string>;
  classes: Set<string>;
  imports: Set<string>;
  exports: Set<string>;
  variables: Set<string>;
  callSites: Set<string>;
  methodCalls: Set<string>;
  varDecls: Set<string>;
  eventListeners: Set<string>;
  [key: string]: Set<string>;
}

// === COLLECTIONS (все данные для GraphBuilder) ===
export interface ASTCollections {
  functions: FunctionInfo[];
  parameters?: ParameterInfo[];
  scopes: ScopeInfo[];
  // Branching
  branches?: BranchInfo[];
  cases?: CaseInfo[];
  // Control flow (new)
  loops?: LoopInfo[];
  tryBlocks?: TryBlockInfo[];
  catchBlocks?: CatchBlockInfo[];
  finallyBlocks?: FinallyBlockInfo[];
  variableDeclarations: VariableDeclarationInfo[];
  callSites: CallSiteInfo[];
  methodCalls?: MethodCallInfo[];
  eventListeners?: EventListenerInfo[];
  classInstantiations?: ClassInstantiationInfo[];
  constructorCalls?: ConstructorCallInfo[];
  classDeclarations?: ClassDeclarationInfo[];
  methodCallbacks?: MethodCallbackInfo[];
  callArguments?: CallArgumentInfo[];
  imports?: ImportInfo[];
  exports?: ExportInfo[];
  httpRequests?: HttpRequestInfo[];
  literals?: LiteralInfo[];
  variableAssignments?: VariableAssignmentInfo[];
  // Object/Array literal tracking for data flow
  objectLiterals?: ObjectLiteralInfo[];
  objectProperties?: ObjectPropertyInfo[];
  arrayLiterals?: ArrayLiteralInfo[];
  arrayElements?: ArrayElementInfo[];
  // Array mutation tracking for FLOWS_INTO edges
  arrayMutations?: ArrayMutationInfo[];
  // Object mutation tracking for FLOWS_INTO edges
  objectMutations?: ObjectMutationInfo[];
  // Property assignment tracking for PROPERTY_ASSIGNMENT nodes (REG-554)
  propertyAssignments?: PropertyAssignmentInfo[];
  // Variable reassignment tracking for FLOWS_INTO edges (REG-290)
  variableReassignments?: VariableReassignmentInfo[];
  // Return statement tracking for RETURNS edges
  returnStatements?: ReturnStatementInfo[];
  // Update expression tracking (i++, obj.prop++, arr[i]++) for MODIFIES edges (REG-288, REG-312)
  updateExpressions?: UpdateExpressionInfo[];
  // Promise resolution tracking for RESOLVES_TO edges (REG-334)
  promiseResolutions?: PromiseResolutionInfo[];
  // Promise executor contexts (REG-334) - keyed by executor function's start:end position
  promiseExecutorContexts?: Map<string, PromiseExecutorContext>;
  // Yield expression tracking for YIELDS/DELEGATES_TO edges (REG-270)
  yieldExpressions?: YieldExpressionInfo[];
  // REG-311: Rejection pattern tracking for async error analysis
  rejectionPatterns?: RejectionPatternInfo[];
  // REG-311: CATCHES_FROM tracking for catch parameter error sources
  catchesFromInfos?: CatchesFromInfo[];
  // Property access tracking for PROPERTY_ACCESS nodes (REG-395)
  propertyAccesses?: PropertyAccessInfo[];
  // Counter ref for property assignment tracking (REG-554)
  propertyAssignmentCounterRef?: CounterRef;
  // REG-297: Top-level await tracking
  hasTopLevelAwait?: boolean;
  // TypeScript-specific collections
  interfaces?: InterfaceDeclarationInfo[];
  typeAliases?: TypeAliasInfo[];
  enums?: EnumDeclarationInfo[];
  decorators?: DecoratorInfo[];
  // Type parameter tracking for generics (REG-303)
  typeParameters?: TypeParameterInfo[];
  // REG-579: Generic misc edges and nodes for lang-spec coverage
  miscEdges?: MiscEdgeInfo[];
  miscNodes?: MiscNodeInfo[];
  // Counter refs (used internally during collection)
  ifScopeCounterRef?: CounterRef;
  scopeCounterRef?: CounterRef;
  varDeclCounterRef?: CounterRef;
  callSiteCounterRef?: CounterRef;
  functionCounterRef?: CounterRef;
  httpRequestCounterRef?: CounterRef;
  literalCounterRef?: CounterRef;
  objectLiteralCounterRef?: CounterRef;
  arrayLiteralCounterRef?: CounterRef;
  branchCounterRef?: CounterRef;
  caseCounterRef?: CounterRef;
  // Counter ref for property access tracking (REG-395)
  propertyAccessCounterRef?: CounterRef;
  // Counter refs for control flow (add)
  loopCounterRef?: CounterRef;
  tryBlockCounterRef?: CounterRef;
  catchBlockCounterRef?: CounterRef;
  finallyBlockCounterRef?: CounterRef;
  processedNodes?: ProcessedNodes;
  // ScopeTracker for semantic ID generation
  scopeTracker?: ScopeTracker;
}

// === MISC EDGE INFO ===
/**
 * Generic edge info for edge types that don't need a dedicated collection.
 * Used for: AWAITS, CHAINS_FROM, DEFAULTS_TO, SPREADS_FROM, DELETES,
 * BINDS_THIS_TO, ACCESSES_PRIVATE, SHADOWS, CONSTRAINED_BY, UNION_MEMBER,
 * INTERSECTS_WITH, INFERS, RETURNS_TYPE, HAS_TYPE, EXTENDS_SCOPE_WITH, LISTENS_TO
 */
export interface MiscEdgeInfo {
  edgeType: string;
  srcId: string;
  dstId: string;
  metadata?: Record<string, unknown>;
}

/**
 * Generic node info for nodes needed by misc edges (e.g., TYPE nodes for annotations).
 */
export interface MiscNodeInfo {
  id: string;
  type: string;
  name: string;
  file: string;
  line: number;
  column?: number;
  metadata?: Record<string, unknown>;
}

// === EXTRACTED VARIABLE ===
export interface ExtractedVariable {
  name: string;
  loc: { start: { line: number; column: number } };
  propertyPath?: string[];
  arrayIndex?: number;
  isRest?: boolean;
}

// === GRAPH NODE (generic node for buffer) ===
export interface GraphNode {
  id: string;
  type: string;
  name?: string;
  file?: string;
  line?: number;
  column?: number;
  // IMPORT node fields
  source?: string;
  importType?: 'default' | 'named' | 'namespace';
  importBinding?: 'value' | 'type' | 'typeof';
  imported?: string;
  local?: string;
  [key: string]: unknown;
}

// === GRAPH EDGE (generic edge for buffer) ===
export interface GraphEdge {
  type: string;
  src: string;
  dst: string;
  index?: number;
  // For FLOWS_INTO edges (array mutations)
  mutationMethod?: string;
  argIndex?: number;
  isSpread?: boolean;
  nestedProperty?: string;  // REG-117: Property name for nested mutations (obj.arr.push -> "arr")
  // For FLOWS_INTO edges (object mutations)
  mutationType?: 'property' | 'computed' | 'assign' | 'spread' | 'this_property';
  propertyName?: string;
  // For computed property resolution (enrichment phase)
  computedPropertyVar?: string;           // Variable name for obj[key] patterns
  resolvedPropertyNames?: string[];       // Resolved names after enrichment
  resolutionStatus?: ResolutionStatus;    // How resolution was determined
  // For HAS_ELEMENT edges (array elements)
  elementIndex?: number;
  metadata?: Record<string, unknown>;
}

// === BUILD RESULT ===
export interface BuildResult {
  nodes: number;
  edges: number;
}
