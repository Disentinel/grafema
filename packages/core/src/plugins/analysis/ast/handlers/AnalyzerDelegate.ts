/**
 * AnalyzerDelegate — interface capturing all JSASTAnalyzer methods
 * called from within the analyzeFunctionBody() traverse block.
 *
 * During the handler extraction refactoring (REG-422), extracted handler
 * classes call these methods on the delegate instead of `this`. The delegate
 * is the JSASTAnalyzer instance itself (it implements this interface).
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
  ArrayLiteralInfo,
  CallSiteInfo,
  MethodCallInfo,
  ConstructorCallInfo,
  CatchBlockInfo,
  CatchesFromInfo,
  UpdateExpressionInfo,
  ArrayMutationInfo,
  ObjectMutationInfo,
  PropertyAssignmentInfo,
  VariableReassignmentInfo,
  ReturnStatementInfo,
  ExtractedVariable,
} from '../types.js';
import type { VisitorModule, VisitorCollections } from '../visitors/index.js';

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
    arrayLiterals: ArrayLiteralInfo[],
    arrayLiteralCounterRef: CounterRef,
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
    propertyAssignments?: PropertyAssignmentInfo[],
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
    switchCaseScopeMap?: Map<t.SwitchCase, string>,
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

  // --- Expression helpers used by control flow handlers ---

  memberExpressionToString(expr: t.MemberExpression): string;

  extractDiscriminantExpression(
    discriminant: t.Expression,
    module: VisitorModule,
  ): {
    id: string;
    expressionType: string;
    line: number;
    column: number;
    objectSourceName?: string;
    object?: string;
    property?: string;
    computed?: boolean;
    leftSourceName?: string;
    rightSourceName?: string;
    operator?: string;
    consequentSourceName?: string;
    alternateSourceName?: string;
    unaryArgSourceName?: string;
    updateArgSourceName?: string;
    expressionSourceNames?: string[];
  };

  extractVariableNamesFromPattern(
    pattern: t.Node | null | undefined,
    variables?: ExtractedVariable[],
    propertyPath?: string[],
  ): ExtractedVariable[];
}
