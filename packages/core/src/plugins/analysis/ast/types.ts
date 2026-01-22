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
  stableId: string;
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
  type: 'PARAMETER';
  name: string;
  file: string;
  line: number;
  index?: number;
  functionId: string;
  parentFunctionId?: string;
}

// === SCOPE INFO ===
export interface ScopeInfo {
  id: string;
  type: 'SCOPE';
  scopeType: string;
  name?: string;
  semanticId?: string;  // Stable ID for diff comparison (e.g., "MyClass.myMethod:if_statement[0]")
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

// === VARIABLE DECLARATION INFO ===
export interface VariableDeclarationInfo {
  id: string;
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
  type: 'CALL';
  name: string;
  object: string;
  method: string;
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

// === CLASS DECLARATION INFO ===
export interface ClassDeclarationInfo {
  id: string;
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
  id: string;
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
  id: string;
  type: 'TYPE';
  name: string;
  file: string;
  line: number;
  column?: number;
  aliasOf?: string;  // строковое представление типа
}

// === ENUM DECLARATION INFO ===
export interface EnumDeclarationInfo {
  id: string;
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
  specifiers: ImportSpecifier[];
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
  arrayName: string;           // Name of the array variable being mutated
  arrayLine?: number;          // Line where array is referenced (for scope resolution)
  mutationMethod: 'push' | 'unshift' | 'splice' | 'indexed';
  file: string;
  line: number;
  column: number;
  arguments: ArrayMutationArgument[];  // What's being added to the array
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
  variableDeclarations: VariableDeclarationInfo[];
  callSites: CallSiteInfo[];
  methodCalls?: MethodCallInfo[];
  eventListeners?: EventListenerInfo[];
  classInstantiations?: ClassInstantiationInfo[];
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
  processedNodes?: ProcessedNodes;
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
  metadata?: Record<string, unknown>;
}

// === BUILD RESULT ===
export interface BuildResult {
  nodes: number;
  edges: number;
}
