/**
 * analyzeFunctionBody — extracted from JSASTAnalyzer as a free function.
 *
 * Analyzes a function body, extracting variables, calls, branches, loops, etc.
 * Used by both sequential (analyzeModule) and parallel (ASTWorker) paths.
 *
 * REG-579: Extracted to enable code sharing between sequential and parallel analysis.
 */
import type { NodePath, Visitor } from '@babel/traverse';
import * as t from '@babel/types';
import { getLine, getColumn } from './utils/location.js';
import { extractNamesFromPattern } from './utils/extractNamesFromPattern.js';
import { extractReturnExpressionInfo as extractReturnExpressionInfoFn } from './extractors/ReturnExpressionExtractor.js';
import { collectCatchesFromInfo as collectCatchesFromInfoFn } from './utils/CatchesFromCollector.js';
import { createFunctionBodyContext } from './FunctionBodyContext.js';
import type { FunctionBodyContext } from './FunctionBodyContext.js';
import type { FunctionInfo } from './types.js';
import type { VisitorModule, VisitorCollections } from './visitors/index.js';
import type { AnalyzerDelegate } from './handlers/AnalyzerDelegate.js';
import {
  type FunctionBodyHandler,
  VariableHandler,
  ReturnYieldHandler,
  ThrowHandler,
  NestedFunctionHandler,
  PropertyAccessHandler,
  NewExpressionHandler,
  CallExpressionHandler,
  LoopHandler,
  TryCatchHandler,
  BranchHandler,
} from './handlers/index.js';

/**
 * Attach control flow metadata (cyclomatic complexity, error tracking, HOF bindings)
 * to the matching function node after traversal completes.
 */
function attachControlFlowMetadata(ctx: FunctionBodyContext): void {
  if (!ctx.matchingFunction) return;

  const cyclomaticComplexity = 1 +
    ctx.controlFlowState.branchCount +
    ctx.controlFlowState.loopCount +
    ctx.controlFlowState.caseCount +
    ctx.controlFlowState.logicalOpCount;

  // REG-311: Collect rejection info for this function
  const functionRejectionPatterns = ctx.rejectionPatterns.filter(p => p.functionId === ctx.matchingFunction!.id);
  const asyncPatterns = functionRejectionPatterns.filter(p => p.isAsync);
  const syncPatterns = functionRejectionPatterns.filter(p => !p.isAsync);
  const canReject = asyncPatterns.length > 0;
  const hasAsyncThrow = asyncPatterns.some(p => p.rejectionType === 'async_throw');
  const rejectedBuiltinErrors = [...new Set(
    asyncPatterns
      .filter(p => p.errorClassName !== null)
      .map(p => p.errorClassName!)
  )];
  // REG-286: Sync throw error tracking
  const thrownBuiltinErrors = [...new Set(
    syncPatterns
      .filter(p => p.errorClassName !== null)
      .map(p => p.errorClassName!)
  )];

  ctx.matchingFunction.controlFlow = {
    hasBranches: ctx.controlFlowState.branchCount > 0,
    hasLoops: ctx.controlFlowState.loopCount > 0,
    hasTryCatch: ctx.controlFlowState.hasTryCatch,
    hasEarlyReturn: ctx.controlFlowState.hasEarlyReturn,
    hasThrow: ctx.controlFlowState.hasThrow,
    cyclomaticComplexity,
    // REG-311: Async error tracking
    canReject,
    hasAsyncThrow,
    rejectedBuiltinErrors: rejectedBuiltinErrors.length > 0 ? rejectedBuiltinErrors : undefined,
    // REG-286: Sync throw tracking
    thrownBuiltinErrors: thrownBuiltinErrors.length > 0 ? thrownBuiltinErrors : undefined
  };

  // REG-401: Store invoked parameter indexes for user-defined HOF detection
  if (ctx.invokedParamIndexes.size > 0) {
    ctx.matchingFunction.invokesParamIndexes = [...ctx.invokedParamIndexes];
  }
  // REG-417: Store property paths for destructured param bindings
  if (ctx.invokesParamBindings.length > 0) {
    ctx.matchingFunction.invokesParamBindings = ctx.invokesParamBindings;
  }
}

/**
 * Analyze a function body and extract variables, calls, conditions, etc.
 * Uses ScopeTracker from collections for semantic ID generation.
 *
 * REG-422: Delegates traversal to extracted handler classes.
 * Local state is encapsulated in FunctionBodyContext; each handler
 * contributes a Visitor fragment that is merged into a single traversal.
 */
export function analyzeFunctionBody(
  funcPath: NodePath<t.Function | t.StaticBlock>,
  parentScopeId: string,
  module: VisitorModule,
  collections: VisitorCollections
): void {
  // 1. Create context (replaces ~260 lines of local var declarations)
  const ctx = createFunctionBodyContext(
    funcPath, parentScopeId, module, collections,
    (collections.functions ?? []) as FunctionInfo[],
    extractNamesFromPattern
  );

  // 2. Handle implicit return for THIS arrow function if it has an expression body
  // e.g., `const double = x => x * 2;`
  if (t.isArrowFunctionExpression(ctx.funcNode) && !t.isBlockStatement(ctx.funcNode.body) && ctx.currentFunctionId) {
    const bodyExpr = ctx.funcNode.body;
    const exprInfo = extractReturnExpressionInfoFn(
      bodyExpr, module, ctx.literals, ctx.literalCounterRef, ctx.funcLine, ctx.funcColumn, 'implicit_return'
    );
    ctx.returnStatements.push({
      parentFunctionId: ctx.currentFunctionId,
      file: module.file,
      line: getLine(bodyExpr),
      column: getColumn(bodyExpr),
      returnValueType: 'NONE',
      isImplicitReturn: true,
      ...exprInfo,
    });
  }

  // 3. Create handlers and merge their visitors into a single traversal
  // Create delegate that references this same free function for recursion
  const delegate: AnalyzerDelegate = { analyzeFunctionBody };
  const handlers: FunctionBodyHandler[] = [
    new VariableHandler(ctx, delegate),
    new ReturnYieldHandler(ctx, delegate),
    new ThrowHandler(ctx, delegate),
    new NestedFunctionHandler(ctx, delegate),
    new PropertyAccessHandler(ctx, delegate),
    new NewExpressionHandler(ctx, delegate),
    new CallExpressionHandler(ctx, delegate),
    new LoopHandler(ctx, delegate),
    new TryCatchHandler(ctx, delegate),
    new BranchHandler(ctx, delegate),
  ];

  const mergedVisitor: Visitor = {};
  for (const handler of handlers) {
    Object.assign(mergedVisitor, handler.getHandlers());
  }

  // 4. Single traversal over the function body
  funcPath.traverse(mergedVisitor);

  // 5. Post-traverse: collect CATCHES_FROM info for try/catch blocks
  if (ctx.functionPath) {
    collectCatchesFromInfoFn(
      ctx.functionPath,
      ctx.catchBlocks,
      ctx.callSites,
      ctx.methodCalls,
      ctx.constructorCalls,
      ctx.catchesFromInfos,
      module
    );
  }

  // 6. Post-traverse: Attach control flow metadata to the function node
  attachControlFlowMetadata(ctx);
}
