/**
 * createCollections — factory that initializes all collection arrays and counters
 * used during module analysis in JSASTAnalyzer.analyzeModule().
 *
 * Extracted from JSASTAnalyzer to reduce method length (REG-460 step 10).
 */

import type { ScopeTracker } from '../../../../core/ScopeTracker.js';
import type { VisitorModule } from '../visitors/index.js';
import type {
  FunctionInfo,
  ParameterInfo,
  ScopeInfo,
  BranchInfo,
  CaseInfo,
  LoopInfo,
  VariableDeclarationInfo,
  CallSiteInfo,
  MethodCallInfo,
  EventListenerInfo,
  ClassInstantiationInfo,
  ConstructorCallInfo,
  ClassDeclarationInfo,
  MethodCallbackInfo,
  CallArgumentInfo,
  ImportInfo,
  ExportInfo,
  HttpRequestInfo,
  LiteralInfo,
  VariableAssignmentInfo,
  InterfaceDeclarationInfo,
  TypeAliasInfo,
  EnumDeclarationInfo,
  DecoratorInfo,
  ObjectLiteralInfo,
  ObjectPropertyInfo,
  ArrayLiteralInfo,
  ArrayElementInfo,
  ArrayMutationInfo,
  ObjectMutationInfo,
  VariableReassignmentInfo,
  ReturnStatementInfo,
  UpdateExpressionInfo,
  PromiseResolutionInfo,
  PromiseExecutorContext,
  YieldExpressionInfo,
  RejectionPatternInfo,
  CatchesFromInfo,
  PropertyAccessInfo,
  TypeParameterInfo,
  CounterRef,
  ProcessedNodes,
  PropertyAssignmentInfo,
} from '../types.js';

/** All collection arrays and counter refs used during module analysis. */
export interface AnalysisCollections {
  functions: FunctionInfo[];
  parameters: ParameterInfo[];
  scopes: ScopeInfo[];
  branches: BranchInfo[];
  cases: CaseInfo[];
  loops: LoopInfo[];
  variableDeclarations: VariableDeclarationInfo[];
  callSites: CallSiteInfo[];
  methodCalls: MethodCallInfo[];
  eventListeners: EventListenerInfo[];
  classInstantiations: ClassInstantiationInfo[];
  constructorCalls: ConstructorCallInfo[];
  classDeclarations: ClassDeclarationInfo[];
  methodCallbacks: MethodCallbackInfo[];
  callArguments: CallArgumentInfo[];
  imports: ImportInfo[];
  exports: ExportInfo[];
  httpRequests: HttpRequestInfo[];
  literals: LiteralInfo[];
  variableAssignments: VariableAssignmentInfo[];
  interfaces: InterfaceDeclarationInfo[];
  typeAliases: TypeAliasInfo[];
  enums: EnumDeclarationInfo[];
  decorators: DecoratorInfo[];
  typeParameters: TypeParameterInfo[];
  objectLiterals: ObjectLiteralInfo[];
  objectProperties: ObjectPropertyInfo[];
  arrayLiterals: ArrayLiteralInfo[];
  arrayElements: ArrayElementInfo[];
  arrayMutations: ArrayMutationInfo[];
  objectMutations: ObjectMutationInfo[];
  variableReassignments: VariableReassignmentInfo[];
  returnStatements: ReturnStatementInfo[];
  updateExpressions: UpdateExpressionInfo[];
  promiseResolutions: PromiseResolutionInfo[];
  promiseExecutorContexts: Map<string, PromiseExecutorContext>;
  yieldExpressions: YieldExpressionInfo[];
  rejectionPatterns: RejectionPatternInfo[];
  catchesFromInfos: CatchesFromInfo[];
  propertyAccesses: PropertyAccessInfo[];
  propertyAssignments?: PropertyAssignmentInfo[];

  ifScopeCounterRef: CounterRef;
  scopeCounterRef: CounterRef;
  varDeclCounterRef: CounterRef;
  callSiteCounterRef: CounterRef;
  functionCounterRef: CounterRef;
  httpRequestCounterRef: CounterRef;
  literalCounterRef: CounterRef;
  anonymousFunctionCounterRef: CounterRef;
  objectLiteralCounterRef: CounterRef;
  arrayLiteralCounterRef: CounterRef;
  branchCounterRef: CounterRef;
  caseCounterRef: CounterRef;
  propertyAccessCounterRef: CounterRef;
  propertyAssignmentCounterRef?: CounterRef;

  processedNodes: ProcessedNodes;
  code?: string;

  // VisitorCollections compatibility fields
  classes: ClassDeclarationInfo[];
  methods: FunctionInfo[];
  variables: VariableDeclarationInfo[];
  sideEffects: unknown[];
  variableCounterRef: CounterRef;
  scopeTracker?: ScopeTracker;
  [key: string]: unknown;
}

/**
 * Create all collection arrays, counter refs, and processedNodes sets
 * for a single module analysis pass.
 */
export function createCollections(
  module: VisitorModule,
  scopeTracker: ScopeTracker,
  code: string,
): AnalysisCollections {
  const functions: FunctionInfo[] = [];
  const parameters: ParameterInfo[] = [];
  const scopes: ScopeInfo[] = [];
  const branches: BranchInfo[] = [];
  const cases: CaseInfo[] = [];
  const loops: LoopInfo[] = [];
  const variableDeclarations: VariableDeclarationInfo[] = [];
  const callSites: CallSiteInfo[] = [];
  const methodCalls: MethodCallInfo[] = [];
  const eventListeners: EventListenerInfo[] = [];
  const classInstantiations: ClassInstantiationInfo[] = [];
  const constructorCalls: ConstructorCallInfo[] = [];
  const classDeclarations: ClassDeclarationInfo[] = [];
  const methodCallbacks: MethodCallbackInfo[] = [];
  const callArguments: CallArgumentInfo[] = [];
  const imports: ImportInfo[] = [];
  const exports: ExportInfo[] = [];
  const httpRequests: HttpRequestInfo[] = [];
  const literals: LiteralInfo[] = [];
  const variableAssignments: VariableAssignmentInfo[] = [];
  const interfaces: InterfaceDeclarationInfo[] = [];
  const typeAliases: TypeAliasInfo[] = [];
  const enums: EnumDeclarationInfo[] = [];
  const decorators: DecoratorInfo[] = [];
  const typeParameters: TypeParameterInfo[] = [];
  const objectLiterals: ObjectLiteralInfo[] = [];
  const objectProperties: ObjectPropertyInfo[] = [];
  const arrayLiterals: ArrayLiteralInfo[] = [];
  const arrayElements: ArrayElementInfo[] = [];
  const arrayMutations: ArrayMutationInfo[] = [];
  const objectMutations: ObjectMutationInfo[] = [];
  const variableReassignments: VariableReassignmentInfo[] = [];
  const returnStatements: ReturnStatementInfo[] = [];
  const updateExpressions: UpdateExpressionInfo[] = [];
  const promiseResolutions: PromiseResolutionInfo[] = [];
  const promiseExecutorContexts = new Map<string, PromiseExecutorContext>();
  const yieldExpressions: YieldExpressionInfo[] = [];
  const rejectionPatterns: RejectionPatternInfo[] = [];
  const catchesFromInfos: CatchesFromInfo[] = [];
  const propertyAccesses: PropertyAccessInfo[] = [];

  const varDeclCounterRef: CounterRef = { value: 0 };

  return {
    functions, parameters, scopes,
    branches, cases,
    loops,
    variableDeclarations, callSites, methodCalls,
    eventListeners, methodCallbacks, callArguments,
    classInstantiations, constructorCalls, classDeclarations,
    httpRequests, literals, variableAssignments,
    interfaces, typeAliases, enums, decorators,
    typeParameters,
    objectLiterals, objectProperties, arrayLiterals, arrayElements,
    arrayMutations,
    objectMutations,
    variableReassignments,
    returnStatements,
    updateExpressions,
    promiseResolutions,
    promiseExecutorContexts,
    yieldExpressions,
    rejectionPatterns,
    catchesFromInfos,
    propertyAccesses,
    propertyAccessCounterRef: { value: 0 },
    objectLiteralCounterRef: { value: 0 },
    arrayLiteralCounterRef: { value: 0 },
    ifScopeCounterRef: { value: 0 },
    scopeCounterRef: { value: 0 },
    varDeclCounterRef,
    callSiteCounterRef: { value: 0 },
    functionCounterRef: { value: 0 },
    httpRequestCounterRef: { value: 0 },
    literalCounterRef: { value: 0 },
    anonymousFunctionCounterRef: { value: 0 },
    branchCounterRef: { value: 0 },
    caseCounterRef: { value: 0 },
    processedNodes: {
      functions: new Set(),
      classes: new Set(),
      imports: new Set(),
      exports: new Set(),
      variables: new Set(),
      callSites: new Set(),
      methodCalls: new Set(),
      varDecls: new Set(),
      eventListeners: new Set(),
    },
    imports, exports, code,
    // VisitorCollections compatibility
    classes: classDeclarations,
    methods: [],
    variables: variableDeclarations,
    sideEffects: [],
    variableCounterRef: varDeclCounterRef,
    scopeTracker,
  };
}
