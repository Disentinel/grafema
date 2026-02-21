/** FunctionBodyContext - all local state for analyzeFunctionBody() traversal. */
import type { NodePath } from '@babel/traverse';
import * as t from '@babel/types';
import { getLine, getColumn } from './utils/location.js';
import type { ScopeTracker } from '../../../core/ScopeTracker.js';
import type {
  FunctionInfo, ScopeInfo, BranchInfo, LoopInfo,
  TryBlockInfo, CatchBlockInfo, FinallyBlockInfo,
  VariableDeclarationInfo, CallSiteInfo, MethodCallInfo,
  EventListenerInfo, MethodCallbackInfo, ClassInstantiationInfo,
  ConstructorCallInfo, HttpRequestInfo, LiteralInfo,
  VariableAssignmentInfo, ObjectLiteralInfo, ObjectPropertyInfo,
  ArrayLiteralInfo,
  ReturnStatementInfo, YieldExpressionInfo, UpdateExpressionInfo,
  PromiseExecutorContext, PromiseResolutionInfo, RejectionPatternInfo,
  CatchesFromInfo, ParameterInfo, CounterRef, ProcessedNodes,
} from './types.js';
import type { VisitorModule, VisitorCollections } from './visitors/index.js';

/** Tracks if/else scope transitions during traversal (Phase 3: includes branchId). */
export interface IfElseScopeInfo {
  inElse: boolean;
  hasElse: boolean;
  ifScopeId: string;
  elseScopeId: string | null;
  branchId: string;
}

/** Tracks try/catch/finally scope transitions during traversal. */
export interface TryScopeInfo {
  tryScopeId: string;
  catchScopeId: string | null;
  finallyScopeId: string | null;
  currentBlock: 'try' | 'catch' | 'finally';
  tryBlockId: string;
  catchBlockId: string | null;
  finallyBlockId: string | null;
}

/** Phase 6 (REG-267): Control flow tracking state for cyclomatic complexity. */
export interface ControlFlowState {
  branchCount: number;
  loopCount: number;
  caseCount: number;
  logicalOpCount: number;
  hasTryCatch: boolean;
  hasEarlyReturn: boolean;
  hasThrow: boolean;
  returnCount: number;
  totalStatements: number;
  tryBlockDepth: number;   // REG-311: O(1) isInsideTry
  loopDepth: number;       // REG-298: O(1) isInsideLoop
}

/** All local state needed by function body traversal handlers. */
export interface FunctionBodyContext {
  // Function identity
  funcPath: NodePath<t.Function | t.StaticBlock>;
  funcNode: t.Function | t.StaticBlock;
  functionNode: t.Function | null;
  functionPath: NodePath<t.Function> | null;
  funcLine: number;
  funcColumn: number;
  currentFunctionId: string | null;
  matchingFunction: FunctionInfo | undefined;
  // Module & scope
  module: VisitorModule;
  collections: VisitorCollections;
  parentScopeId: string;
  scopeIdStack: string[];
  getCurrentScopeId: () => string;
  scopeTracker: ScopeTracker | undefined;
  // Collections extracted from VisitorCollections
  functions: FunctionInfo[];
  scopes: ScopeInfo[];
  variableDeclarations: VariableDeclarationInfo[];
  callSites: CallSiteInfo[];
  methodCalls: MethodCallInfo[];
  eventListeners: EventListenerInfo[];
  methodCallbacks: MethodCallbackInfo[];
  classInstantiations: ClassInstantiationInfo[];
  constructorCalls: ConstructorCallInfo[];
  httpRequests: HttpRequestInfo[];
  literals: LiteralInfo[];
  variableAssignments: VariableAssignmentInfo[];
  parameters: ParameterInfo[];
  returnStatements: ReturnStatementInfo[];
  yieldExpressions: YieldExpressionInfo[];
  updateExpressions: UpdateExpressionInfo[];
  objectLiterals: ObjectLiteralInfo[];
  objectProperties: ObjectPropertyInfo[];
  arrayLiterals: ArrayLiteralInfo[];
  // Control flow
  loops: LoopInfo[];
  branches: BranchInfo[];
  tryBlocks: TryBlockInfo[];
  catchBlocks: CatchBlockInfo[];
  finallyBlocks: FinallyBlockInfo[];
  // Promise & error tracking
  promiseExecutorContexts: Map<string, PromiseExecutorContext>;
  promiseResolutions: PromiseResolutionInfo[];
  rejectionPatterns: RejectionPatternInfo[];
  catchesFromInfos: CatchesFromInfo[];
  // Counter refs
  objectLiteralCounterRef: CounterRef;
  arrayLiteralCounterRef: CounterRef;
  loopCounterRef: CounterRef;
  branchCounterRef: CounterRef;
  tryBlockCounterRef: CounterRef;
  catchBlockCounterRef: CounterRef;
  finallyBlockCounterRef: CounterRef;
  ifScopeCounterRef: CounterRef;
  scopeCounterRef: CounterRef;
  varDeclCounterRef: CounterRef;
  callSiteCounterRef: CounterRef;
  functionCounterRef: CounterRef;
  httpRequestCounterRef: CounterRef;
  literalCounterRef: CounterRef;
  anonymousFunctionCounterRef: CounterRef;
  // Processed nodes (deduplication)
  processedNodes: ProcessedNodes;
  processedCallSites: Set<string>;
  processedMethodCalls: Set<string>;
  processedVarDecls: Set<string>;
  processedEventListeners: Set<string>;
  parentScopeVariables: Set<{ name: string; id: string; scopeId: string }>;
  // Scope tracking maps
  ifElseScopeMap: Map<t.IfStatement, IfElseScopeInfo>;
  tryScopeMap: Map<t.TryStatement, TryScopeInfo>;
  switchCaseScopeMap: Map<t.SwitchCase, string>;  // Maps SwitchCase node -> caseId (CaseInfo.id)
  // Parameter invocation tracking (REG-401, REG-416, REG-417)
  paramNameToIndex: Map<string, number>;
  paramNameToPropertyPath: Map<string, string[]>;
  restParamNames: Set<string>;
  invokedParamIndexes: Set<number>;
  invokesParamBindings: { paramIndex: number; propertyPath: string[] }[];
  aliasToParamIndex: Map<string, number>;
  // Control flow state (REG-267)
  controlFlowState: ControlFlowState;
}

function ensure<T>(c: VisitorCollections, k: string, fb: () => unknown): T {
  if (!c[k]) { c[k] = fb(); }
  return c[k] as T;
}
function extract<T>(c: VisitorCollections, k: string): T[] { return (c[k] ?? []) as T[]; }
function counter(c: VisitorCollections, k: string): CounterRef { return (c[k] ?? { value: 0 }) as CounterRef; }

/** Creates FunctionBodyContext matching analyzeFunctionBody() lines 3507-3763 init logic. */
export function createFunctionBodyContext(
  funcPath: NodePath<t.Function | t.StaticBlock>,
  parentScopeId: string,
  module: VisitorModule,
  collections: VisitorCollections,
  functions: FunctionInfo[],
  extractNamesFromPatternFn: (pattern: t.ObjectPattern | t.ArrayPattern) => { name: string; propertyPath?: string[] }[],
): FunctionBodyContext {
  const c = collections;
  const scopes = extract<ScopeInfo>(c, 'scopes');
  const variableDeclarations = extract<VariableDeclarationInfo>(c, 'variableDeclarations');
  const callSites = extract<CallSiteInfo>(c, 'callSites');
  const methodCalls = extract<MethodCallInfo>(c, 'methodCalls');
  const eventListeners = extract<EventListenerInfo>(c, 'eventListeners');
  const methodCallbacks = extract<MethodCallbackInfo>(c, 'methodCallbacks');
  const classInstantiations = extract<ClassInstantiationInfo>(c, 'classInstantiations');
  const constructorCalls = extract<ConstructorCallInfo>(c, 'constructorCalls');
  const httpRequests = extract<HttpRequestInfo>(c, 'httpRequests');
  const literals = extract<LiteralInfo>(c, 'literals');
  const variableAssignments = extract<VariableAssignmentInfo>(c, 'variableAssignments');
  const parameters = extract<ParameterInfo>(c, 'parameters');
  const returnStatements = extract<ReturnStatementInfo>(c, 'returnStatements');
  const updateExpressions = extract<UpdateExpressionInfo>(c, 'updateExpressions');
  const ifScopeCounterRef = counter(c, 'ifScopeCounterRef');
  const scopeCounterRef = counter(c, 'scopeCounterRef');
  const varDeclCounterRef = counter(c, 'varDeclCounterRef');
  const callSiteCounterRef = counter(c, 'callSiteCounterRef');
  const functionCounterRef = counter(c, 'functionCounterRef');
  const httpRequestCounterRef = counter(c, 'httpRequestCounterRef');
  const literalCounterRef = counter(c, 'literalCounterRef');
  const anonymousFunctionCounterRef = counter(c, 'anonymousFunctionCounterRef');
  const scopeTracker = c.scopeTracker as ScopeTracker | undefined;
  const objectLiterals = ensure<ObjectLiteralInfo[]>(c, 'objectLiterals', () => []);
  const objectProperties = ensure<ObjectPropertyInfo[]>(c, 'objectProperties', () => []);
  const objectLiteralCounterRef = ensure<CounterRef>(c, 'objectLiteralCounterRef', () => ({ value: 0 }));
  const arrayLiterals = ensure<ArrayLiteralInfo[]>(c, 'arrayLiterals', () => []);
  const arrayLiteralCounterRef = ensure<CounterRef>(c, 'arrayLiteralCounterRef', () => ({ value: 0 }));
  const yieldExpressions = ensure<YieldExpressionInfo[]>(c, 'yieldExpressions', () => []);
  const loops = ensure<LoopInfo[]>(c, 'loops', () => []);
  const loopCounterRef = ensure<CounterRef>(c, 'loopCounterRef', () => ({ value: 0 }));
  const branches = ensure<BranchInfo[]>(c, 'branches', () => []);
  const branchCounterRef = ensure<CounterRef>(c, 'branchCounterRef', () => ({ value: 0 }));
  const tryBlocks = ensure<TryBlockInfo[]>(c, 'tryBlocks', () => []);
  const catchBlocks = ensure<CatchBlockInfo[]>(c, 'catchBlocks', () => []);
  const finallyBlocks = ensure<FinallyBlockInfo[]>(c, 'finallyBlocks', () => []);
  const tryBlockCounterRef = ensure<CounterRef>(c, 'tryBlockCounterRef', () => ({ value: 0 }));
  const catchBlockCounterRef = ensure<CounterRef>(c, 'catchBlockCounterRef', () => ({ value: 0 }));
  const finallyBlockCounterRef = ensure<CounterRef>(c, 'finallyBlockCounterRef', () => ({ value: 0 }));
  const promiseExecutorContexts = ensure<Map<string, PromiseExecutorContext>>(
    c, 'promiseExecutorContexts', () => new Map<string, PromiseExecutorContext>());
  const promiseResolutions = ensure<PromiseResolutionInfo[]>(c, 'promiseResolutions', () => []);
  const rejectionPatterns = ensure<RejectionPatternInfo[]>(c, 'rejectionPatterns', () => []);
  const catchesFromInfos = ensure<CatchesFromInfo[]>(c, 'catchesFromInfos', () => []);

  const processedNodes: ProcessedNodes = c.processedNodes ?? {
    functions: new Set<string>(), classes: new Set<string>(),
    imports: new Set<string>(), exports: new Set<string>(),
    variables: new Set<string>(), callSites: new Set<string>(),
    methodCalls: new Set<string>(), varDecls: new Set<string>(),
    eventListeners: new Set<string>(),
  };

  const scopeIdStack: string[] = [parentScopeId];
  const getCurrentScopeId = (): string => scopeIdStack[scopeIdStack.length - 1];

  // Function identity
  const funcNode = funcPath.node;
  const functionNode = t.isFunction(funcNode) ? funcNode : null;
  const functionPath = functionNode ? (funcPath as NodePath<t.Function>) : null;
  const funcLine = getLine(funcNode);
  const funcColumn = getColumn(funcNode);
  let currentFunctionId: string | null = null;

  const matchingFunction = funcNode.type !== 'StaticBlock'
    ? functions.find(f =>
        f.file === module.file && f.line === funcLine &&
        (f.column === undefined || f.column === funcColumn))
    : undefined;
  if (matchingFunction) { currentFunctionId = matchingFunction.id; }

  // Parameter invocation tracking (REG-401, REG-416, REG-417)
  const paramNameToIndex = new Map<string, number>();
  const paramNameToPropertyPath = new Map<string, string[]>();
  const restParamNames = new Set<string>();
  const invokedParamIndexes = new Set<number>();
  const invokesParamBindings: { paramIndex: number; propertyPath: string[] }[] = [];
  const aliasToParamIndex = new Map<string, number>();

  if (functionNode) {
    for (let i = 0; i < functionNode.params.length; i++) {
      const param = functionNode.params[i];
      if (t.isIdentifier(param)) {
        paramNameToIndex.set(param.name, i);
      } else if (t.isAssignmentPattern(param)) {
        if (t.isIdentifier(param.left)) {
          paramNameToIndex.set(param.left.name, i);
        } else if (t.isObjectPattern(param.left) || t.isArrayPattern(param.left)) {
          for (const info of extractNamesFromPatternFn(param.left)) {
            paramNameToIndex.set(info.name, i);
            if (info.propertyPath) { paramNameToPropertyPath.set(info.name, info.propertyPath); }
          }
        }
      } else if (t.isObjectPattern(param) || t.isArrayPattern(param)) {
        for (const info of extractNamesFromPatternFn(param)) {
          paramNameToIndex.set(info.name, i);
          if (info.propertyPath) { paramNameToPropertyPath.set(info.name, info.propertyPath); }
        }
      } else if (t.isRestElement(param) && t.isIdentifier(param.argument)) {
        paramNameToIndex.set(param.argument.name, i);
        restParamNames.add(param.argument.name);
      }
    }
  }

  const controlFlowState: ControlFlowState = {
    branchCount: 0, loopCount: 0, caseCount: 0, logicalOpCount: 0,
    hasTryCatch: false, hasEarlyReturn: false, hasThrow: false,
    returnCount: 0, totalStatements: 0, tryBlockDepth: 0, loopDepth: 0,
  };

  return {
    funcPath, funcNode, functionNode, functionPath, funcLine, funcColumn, currentFunctionId, matchingFunction,
    module, collections, parentScopeId, scopeIdStack, getCurrentScopeId, scopeTracker,
    functions, scopes, variableDeclarations, callSites, methodCalls,
    eventListeners, methodCallbacks, classInstantiations, constructorCalls,
    httpRequests, literals, variableAssignments, parameters,
    returnStatements, yieldExpressions, updateExpressions,
    objectLiterals, objectProperties, arrayLiterals,
    loops, branches, tryBlocks, catchBlocks, finallyBlocks,
    promiseExecutorContexts, promiseResolutions, rejectionPatterns, catchesFromInfos,
    objectLiteralCounterRef, arrayLiteralCounterRef, loopCounterRef, branchCounterRef,
    tryBlockCounterRef, catchBlockCounterRef, finallyBlockCounterRef,
    ifScopeCounterRef, scopeCounterRef, varDeclCounterRef,
    callSiteCounterRef, functionCounterRef, httpRequestCounterRef,
    literalCounterRef, anonymousFunctionCounterRef,
    processedNodes,
    processedCallSites: processedNodes.callSites,
    processedMethodCalls: processedNodes.methodCalls,
    processedVarDecls: processedNodes.varDecls,
    processedEventListeners: processedNodes.eventListeners,
    parentScopeVariables: new Set<{ name: string; id: string; scopeId: string }>(),
    ifElseScopeMap: new Map<t.IfStatement, IfElseScopeInfo>(),
    tryScopeMap: new Map<t.TryStatement, TryScopeInfo>(),
    switchCaseScopeMap: new Map<t.SwitchCase, string>(),
    paramNameToIndex, paramNameToPropertyPath, restParamNames,
    invokedParamIndexes, invokesParamBindings, aliasToParamIndex,
    controlFlowState,
  };
}
