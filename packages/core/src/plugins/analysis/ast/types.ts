/**
 * AST Analysis Types - общие типы для JSASTAnalyzer и GraphBuilder
 */

import type * as t from '@babel/types';
import type { GraphBackend } from '@grafema/types';

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
}

// === PARAMETER INFO ===
export interface ParameterInfo {
  id: string;
  semanticId?: string;  // Stable ID: file->scope->PARAMETER->name
  type: 'PARAMETER';
  name: string;
  file: string;
  line: number;
  index?: number;
  hasDefault?: boolean;  // Has default value (e.g., function(a = 1))
  isRest?: boolean;      // Rest parameter (e.g., function(...args))
  functionId?: string;   // Legacy field - prefer parentFunctionId
  parentFunctionId?: string;
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
  parentScopeId?: string;
  targetFunctionName?: string;
  isNew?: boolean;
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
  parentScopeId?: string;
  arguments?: unknown[];
  isNew?: boolean;
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
  isSpread?: boolean;
  functionLine?: number;
  functionColumn?: number;
  nestedCallLine?: number;
  nestedCallColumn?: number;
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
  isDynamic?: boolean;         // true for dynamic import() expressions
  isResolvable?: boolean;      // true if path is a string literal (statically analyzable)
  dynamicPath?: string;        // original expression for template/variable paths
}

export interface ImportSpecifier {
  imported: string;  // имя в экспортируемом модуле (default, *, или имя)
  local: string;     // имя в текущем модуле
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
  enclosingClassName?: string;   // Class name when objectName === 'this' (REG-152)
  propertyName: string;          // Property name or '<computed>' for obj[x] or '<assign>' for Object.assign
  mutationType: 'property' | 'computed' | 'assign' | 'spread';
  computedPropertyVar?: string;  // Variable name in obj[key] = value (for computed mutation type)
  file: string;
  line: number;
  column: number;
  value: ObjectMutationValue;
}

export interface ObjectMutationValue {
  valueType: 'LITERAL' | 'VARIABLE' | 'CALL' | 'EXPRESSION' | 'OBJECT_LITERAL' | 'ARRAY_LITERAL';
  valueName?: string;            // For VARIABLE type - name of the variable
  valueNodeId?: string;          // For LITERAL, OBJECT_LITERAL, ARRAY_LITERAL - node ID
  literalValue?: unknown;        // For LITERAL type
  callLine?: number;             // For CALL type
  callColumn?: number;
  isSpread?: boolean;            // For Object.assign with spread: Object.assign(target, ...sources)
  argIndex?: number;             // For Object.assign - which source argument (0, 1, 2, ...)
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
  // For arrow function implicit returns
  isImplicitReturn?: boolean;
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
  // Return statement tracking for RETURNS edges
  returnStatements?: ReturnStatementInfo[];
  // TypeScript-specific collections
  interfaces?: InterfaceDeclarationInfo[];
  typeAliases?: TypeAliasInfo[];
  enums?: EnumDeclarationInfo[];
  decorators?: DecoratorInfo[];
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
  // Counter refs for control flow (add)
  loopCounterRef?: CounterRef;
  tryBlockCounterRef?: CounterRef;
  catchBlockCounterRef?: CounterRef;
  finallyBlockCounterRef?: CounterRef;
  processedNodes?: ProcessedNodes;
  // ScopeTracker for semantic ID generation
  scopeTracker?: import('../../../core/ScopeTracker.js').ScopeTracker;
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
  metadata?: Record<string, unknown>;
}

// === BUILD RESULT ===
export interface BuildResult {
  nodes: number;
  edges: number;
}
