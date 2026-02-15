/**
 * AnalyzerDelegate — interface capturing all JSASTAnalyzer methods
 * called from within the analyzeFunctionBody() traverse block.
 *
 * During the handler extraction refactoring (REG-422), extracted handler
 * classes call these methods on the delegate instead of `this`. The delegate
 * is the JSASTAnalyzer instance itself (it implements this interface).
 *
 * Once all handlers are extracted and the methods are moved/refactored,
 * the create*Handler methods will be removed from this interface.
 */
import type { NodePath } from '@babel/traverse';
import type * as t from '@babel/types';
import type { ScopeTracker } from '../../../../core/ScopeTracker.js';
import type {
  VariableDeclarationInfo,
  ClassInstantiationInfo,
  LiteralInfo,
  VariableAssignmentInfo,
  CounterRef,
  ObjectLiteralInfo,
  ObjectPropertyInfo,
  ScopeInfo,
  LoopInfo,
  TryBlockInfo,
  CatchBlockInfo,
  FinallyBlockInfo,
  BranchInfo,
  CallSiteInfo,
  MethodCallInfo,
  ConstructorCallInfo,
  CatchesFromInfo,
  UpdateExpressionInfo,
  ArrayMutationInfo,
  ObjectMutationInfo,
  VariableReassignmentInfo,
  ReturnStatementInfo,
} from '../types.js';
import type { VisitorModule, VisitorCollections } from '../visitors/index.js';
import type { IfElseScopeInfo, TryScopeInfo } from '../FunctionBodyContext.js';

export interface AnalyzerDelegate {
  // --- Variable handling ---

  handleVariableDeclaration(
    varPath: NodePath<t.VariableDeclaration>,
    parentScopeId: string,
    module: VisitorModule,
    variableDeclarations: VariableDeclarationInfo[],
    classInstantiations: ClassInstantiationInfo[],
    literals: LiteralInfo[],
    variableAssignments: VariableAssignmentInfo[],
    varDeclCounterRef: CounterRef,
    literalCounterRef: CounterRef,
    scopeTracker: ScopeTracker | undefined,
    parentScopeVariables: Set<{ name: string; id: string; scopeId: string }>,
    objectLiterals: ObjectLiteralInfo[],
    objectProperties: ObjectPropertyInfo[],
    objectLiteralCounterRef: CounterRef,
  ): void;

  detectVariableReassignment(
    assignNode: t.AssignmentExpression,
    module: VisitorModule,
    variableReassignments: VariableReassignmentInfo[],
    scopeTracker?: ScopeTracker,
  ): void;

  // --- Array / object mutation ---

  detectIndexedArrayAssignment(
    assignNode: t.AssignmentExpression,
    module: VisitorModule,
    arrayMutations: ArrayMutationInfo[],
    scopeTracker?: ScopeTracker,
    collections?: VisitorCollections,
  ): void;

  detectObjectPropertyAssignment(
    assignNode: t.AssignmentExpression,
    module: VisitorModule,
    objectMutations: ObjectMutationInfo[],
    scopeTracker?: ScopeTracker,
  ): void;

  // --- Return / expression helpers ---

  extractReturnExpressionInfo(
    expr: t.Expression,
    module: { file: string },
    literals: LiteralInfo[],
    literalCounterRef: CounterRef,
    baseLine: number,
    baseColumn: number,
    literalIdSuffix?: 'return' | 'implicit_return' | 'yield',
  ): Partial<ReturnStatementInfo>;

  microTraceToErrorClass(
    variableName: string,
    funcPath: NodePath<t.Function>,
    variableDeclarations: VariableDeclarationInfo[],
  ): { errorClassName: string | null; tracePath: string[] };

  // --- Switch ---

  handleSwitchStatement(
    switchPath: NodePath<t.SwitchStatement>,
    parentScopeId: string,
    module: VisitorModule,
    collections: VisitorCollections,
    scopeTracker: ScopeTracker | undefined,
    controlFlowState?: { branchCount: number; caseCount: number },
  ): void;

  // --- Naming / ID generation ---

  generateAnonymousName(scopeTracker: ScopeTracker | undefined): string;

  generateSemanticId(
    scopeType: string,
    scopeTracker: ScopeTracker | undefined,
  ): string | undefined;

  // --- Recursive analysis ---

  analyzeFunctionBody(
    funcPath: NodePath<t.Function | t.StaticBlock>,
    parentScopeId: string,
    module: VisitorModule,
    collections: VisitorCollections,
  ): void;

  // --- Update expression ---

  collectUpdateExpression(
    updateNode: t.UpdateExpression,
    module: VisitorModule,
    updateExpressions: UpdateExpressionInfo[],
    parentScopeId: string | undefined,
    scopeTracker?: ScopeTracker,
  ): void;

  // --- Logical operators ---

  countLogicalOperators(node: t.Expression): number;

  // --- Call expression ---

  handleCallExpression(
    callNode: t.CallExpression,
    processedCallSites: Set<string>,
    processedMethodCalls: Set<string>,
    callSites: CallSiteInfo[],
    methodCalls: MethodCallInfo[],
    module: VisitorModule,
    callSiteCounterRef: CounterRef,
    scopeTracker: ScopeTracker | undefined,
    parentScopeId: string,
    collections: VisitorCollections,
    isAwaited?: boolean,
    isInsideTry?: boolean,
    isInsideLoop?: boolean,
  ): void;

  // --- Catch-from collection (second pass) ---

  collectCatchesFromInfo(
    funcPath: NodePath<t.Function>,
    catchBlocks: CatchBlockInfo[],
    callSites: CallSiteInfo[],
    methodCalls: MethodCallInfo[],
    constructorCalls: ConstructorCallInfo[],
    catchesFromInfos: CatchesFromInfo[],
    module: VisitorModule,
  ): void;

  // --- Factory methods for scope/control-flow handlers ---
  // These exist on the delegate during the transition period.
  // They will be removed once the corresponding handlers are fully extracted.

  createLoopScopeHandler(
    trackerScopeType: string,
    scopeType: string,
    loopType: 'for' | 'for-in' | 'for-of' | 'while' | 'do-while',
    parentScopeId: string,
    module: VisitorModule,
    scopes: ScopeInfo[],
    loops: LoopInfo[],
    scopeCounterRef: CounterRef,
    loopCounterRef: CounterRef,
    scopeTracker: ScopeTracker | undefined,
    scopeIdStack?: string[],
    controlFlowState?: { loopCount: number; loopDepth: number },
  ): { enter: (path: NodePath<t.Loop>) => void; exit: () => void };

  createTryStatementHandler(
    parentScopeId: string,
    module: VisitorModule,
    scopes: ScopeInfo[],
    tryBlocks: TryBlockInfo[],
    catchBlocks: CatchBlockInfo[],
    finallyBlocks: FinallyBlockInfo[],
    scopeCounterRef: CounterRef,
    tryBlockCounterRef: CounterRef,
    catchBlockCounterRef: CounterRef,
    finallyBlockCounterRef: CounterRef,
    scopeTracker: ScopeTracker | undefined,
    tryScopeMap: Map<t.TryStatement, TryScopeInfo>,
    scopeIdStack?: string[],
    controlFlowState?: { hasTryCatch: boolean; tryBlockDepth: number },
  ): { enter: (tryPath: NodePath<t.TryStatement>) => void; exit: (tryPath: NodePath<t.TryStatement>) => void };

  createCatchClauseHandler(
    module: VisitorModule,
    variableDeclarations: VariableDeclarationInfo[],
    varDeclCounterRef: CounterRef,
    scopeTracker: ScopeTracker | undefined,
    tryScopeMap: Map<t.TryStatement, TryScopeInfo>,
    scopeIdStack?: string[],
    controlFlowState?: { hasTryCatch: boolean; tryBlockDepth: number },
  ): { enter: (catchPath: NodePath<t.CatchClause>) => void };

  createIfStatementHandler(
    parentScopeId: string,
    module: VisitorModule,
    scopes: ScopeInfo[],
    branches: BranchInfo[],
    ifScopeCounterRef: CounterRef,
    branchCounterRef: CounterRef,
    scopeTracker: ScopeTracker | undefined,
    sourceCode: string,
    ifElseScopeMap: Map<t.IfStatement, IfElseScopeInfo>,
    scopeIdStack?: string[],
    controlFlowState?: { branchCount: number; logicalOpCount: number },
    countLogicalOperators?: (node: t.Expression) => number,
  ): { enter: (ifPath: NodePath<t.IfStatement>) => void; exit: (ifPath: NodePath<t.IfStatement>) => void };

  createConditionalExpressionHandler(
    parentScopeId: string,
    module: VisitorModule,
    branches: BranchInfo[],
    branchCounterRef: CounterRef,
    scopeTracker: ScopeTracker | undefined,
    scopeIdStack?: string[],
    controlFlowState?: { branchCount: number; logicalOpCount: number },
    countLogicalOperators?: (node: t.Expression) => number,
  ): (condPath: NodePath<t.ConditionalExpression>) => void;

  createBlockStatementHandler(
    scopeTracker: ScopeTracker | undefined,
    ifElseScopeMap: Map<t.IfStatement, IfElseScopeInfo>,
    tryScopeMap: Map<t.TryStatement, TryScopeInfo>,
    scopeIdStack?: string[],
  ): { enter: (blockPath: NodePath<t.BlockStatement>) => void };
}
