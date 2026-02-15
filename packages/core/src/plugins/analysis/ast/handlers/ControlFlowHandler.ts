/**
 * ControlFlowHandler — handles control flow nodes: loops, try/catch/finally,
 * if/else, ternary, block statements, and switch statements.
 *
 * Mechanical extraction from analyzeFunctionBody() (REG-422).
 * Original source: JSASTAnalyzer.ts lines ~4063-4347.
 */
import type { Visitor, NodePath } from '@babel/traverse';
import type * as t from '@babel/types';
import { FunctionBodyHandler } from './FunctionBodyHandler.js';

export class ControlFlowHandler extends FunctionBodyHandler {
  getHandlers(): Visitor {
    const ctx = this.ctx;
    const analyzer = this.analyzer;

    return {
      ForStatement: analyzer.createLoopScopeHandler('for', 'for-loop', 'for', ctx.parentScopeId, ctx.module, ctx.scopes, ctx.loops, ctx.scopeCounterRef, ctx.loopCounterRef, ctx.scopeTracker, ctx.scopeIdStack, ctx.controlFlowState),
      ForInStatement: analyzer.createLoopScopeHandler('for-in', 'for-in-loop', 'for-in', ctx.parentScopeId, ctx.module, ctx.scopes, ctx.loops, ctx.scopeCounterRef, ctx.loopCounterRef, ctx.scopeTracker, ctx.scopeIdStack, ctx.controlFlowState),
      ForOfStatement: analyzer.createLoopScopeHandler('for-of', 'for-of-loop', 'for-of', ctx.parentScopeId, ctx.module, ctx.scopes, ctx.loops, ctx.scopeCounterRef, ctx.loopCounterRef, ctx.scopeTracker, ctx.scopeIdStack, ctx.controlFlowState),
      WhileStatement: analyzer.createLoopScopeHandler('while', 'while-loop', 'while', ctx.parentScopeId, ctx.module, ctx.scopes, ctx.loops, ctx.scopeCounterRef, ctx.loopCounterRef, ctx.scopeTracker, ctx.scopeIdStack, ctx.controlFlowState),
      DoWhileStatement: analyzer.createLoopScopeHandler('do-while', 'do-while-loop', 'do-while', ctx.parentScopeId, ctx.module, ctx.scopes, ctx.loops, ctx.scopeCounterRef, ctx.loopCounterRef, ctx.scopeTracker, ctx.scopeIdStack, ctx.controlFlowState),

      // Phase 4 (REG-267): Now creates TRY_BLOCK, CATCH_BLOCK, FINALLY_BLOCK nodes
      TryStatement: analyzer.createTryStatementHandler(
        ctx.parentScopeId,
        ctx.module,
        ctx.scopes,
        ctx.tryBlocks,
        ctx.catchBlocks,
        ctx.finallyBlocks,
        ctx.scopeCounterRef,
        ctx.tryBlockCounterRef,
        ctx.catchBlockCounterRef,
        ctx.finallyBlockCounterRef,
        ctx.scopeTracker,
        ctx.tryScopeMap,
        ctx.scopeIdStack,
        ctx.controlFlowState
      ),

      CatchClause: analyzer.createCatchClauseHandler(
        ctx.module,
        ctx.variableDeclarations,
        ctx.varDeclCounterRef,
        ctx.scopeTracker,
        ctx.tryScopeMap,
        ctx.scopeIdStack,
        ctx.controlFlowState
      ),

      SwitchStatement: (switchPath: NodePath<t.SwitchStatement>) => {
        analyzer.handleSwitchStatement(
          switchPath,
          ctx.parentScopeId,
          ctx.module,
          ctx.collections,
          ctx.scopeTracker,
          ctx.controlFlowState
        );
      },

      // IF statements - create conditional scopes and traverse contents for CALL nodes
      // Phase 3 (REG-267): Now creates BRANCH nodes with branchType='if'
      IfStatement: analyzer.createIfStatementHandler(
        ctx.parentScopeId,
        ctx.module,
        ctx.scopes,
        ctx.branches,
        ctx.ifScopeCounterRef,
        ctx.branchCounterRef,
        ctx.scopeTracker,
        ctx.collections.code ?? '',
        ctx.ifElseScopeMap,
        ctx.scopeIdStack,
        ctx.controlFlowState,
        analyzer.countLogicalOperators.bind(analyzer)
      ),

      // Ternary expressions (REG-287): Creates BRANCH nodes with branchType='ternary'
      ConditionalExpression: analyzer.createConditionalExpressionHandler(
        ctx.parentScopeId,
        ctx.module,
        ctx.branches,
        ctx.branchCounterRef,
        ctx.scopeTracker,
        ctx.scopeIdStack,
        ctx.controlFlowState,
        analyzer.countLogicalOperators.bind(analyzer)
      ),

      // Track when we enter the alternate (else) block of an IfStatement
      BlockStatement: analyzer.createBlockStatementHandler(ctx.scopeTracker, ctx.ifElseScopeMap, ctx.tryScopeMap, ctx.scopeIdStack),
    };
  }
}
