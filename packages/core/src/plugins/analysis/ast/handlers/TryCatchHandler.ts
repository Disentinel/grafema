/**
 * TryCatchHandler -- handles try/catch/finally control flow nodes.
 *
 * Inlines the createTryStatementHandler and createCatchClauseHandler logic
 * from JSASTAnalyzer (REG-422).
 */
import type { Visitor, NodePath } from '@babel/traverse';
import * as t from '@babel/types';
import { getLine, getColumn } from '../utils/location.js';
import { generateSemanticId } from '../utils/semanticIdHelpers.js';
import { computeSemanticId } from '../../../../core/SemanticId.js';
import { extractNamesFromPattern } from '../utils/extractNamesFromPattern.js';
import { FunctionBodyHandler } from './FunctionBodyHandler.js';

export class TryCatchHandler extends FunctionBodyHandler {
  getHandlers(): Visitor {
    return {
      TryStatement: this.createTryStatementVisitor(),
      CatchClause: this.createCatchClauseVisitor(),
    };
  }

  private createTryStatementVisitor(): {
    enter: (tryPath: NodePath<t.TryStatement>) => void;
    exit: (tryPath: NodePath<t.TryStatement>) => void;
  } {
    const ctx = this.ctx;

    return {
      enter: (tryPath: NodePath<t.TryStatement>) => {
        const tryNode = tryPath.node;

        // Phase 6 (REG-267): Mark that this function has try/catch
        if (ctx.controlFlowState) {
          ctx.controlFlowState.hasTryCatch = true;
          // REG-311: Increment try block depth for O(1) isInsideTry detection
          ctx.controlFlowState.tryBlockDepth++;
        }

        // Determine actual parent - use stack for nested structures, otherwise original parentScopeId
        const actualParentScopeId = (ctx.scopeIdStack && ctx.scopeIdStack.length > 0)
          ? ctx.scopeIdStack[ctx.scopeIdStack.length - 1]
          : ctx.parentScopeId;

        // 1. Create TRY_BLOCK node
        const tryBlockCounter = ctx.tryBlockCounterRef.value++;
        const legacyTryBlockId = `${ctx.module.file}:TRY_BLOCK:${getLine(tryNode)}:${tryBlockCounter}`;
        const tryBlockId = ctx.scopeTracker
          ? computeSemanticId('TRY_BLOCK', 'try', ctx.scopeTracker.getContext(), { discriminator: tryBlockCounter })
          : legacyTryBlockId;

        ctx.tryBlocks.push({
          id: tryBlockId,
          semanticId: tryBlockId,
          type: 'TRY_BLOCK',
          file: ctx.module.file,
          line: getLine(tryNode),
          column: getColumn(tryNode),
          parentScopeId: actualParentScopeId
        });

        // 2. Create try-body SCOPE (backward compatibility)
        // Parent is now TRY_BLOCK, not original parentScopeId
        const tryScopeId = `SCOPE#try-block#${ctx.module.file}#${getLine(tryNode)}:${ctx.scopeCounterRef.value++}`;
        const trySemanticId = generateSemanticId('try-block', ctx.scopeTracker);
        ctx.scopes.push({
          id: tryScopeId,
          type: 'SCOPE',
          scopeType: 'try-block',
          semanticId: trySemanticId,
          file: ctx.module.file,
          line: getLine(tryNode),
          parentScopeId: tryBlockId  // Parent is TRY_BLOCK
        });

        // 3. Create CATCH_BLOCK and catch-body SCOPE if handler exists
        let catchBlockId: string | null = null;
        let catchScopeId: string | null = null;
        if (tryNode.handler) {
          const catchClause = tryNode.handler;
          const catchBlockCounter = ctx.catchBlockCounterRef.value++;
          const legacyCatchBlockId = `${ctx.module.file}:CATCH_BLOCK:${getLine(catchClause)}:${catchBlockCounter}`;
          catchBlockId = ctx.scopeTracker
            ? computeSemanticId('CATCH_BLOCK', 'catch', ctx.scopeTracker.getContext(), { discriminator: catchBlockCounter })
            : legacyCatchBlockId;

          // Extract parameter name if present
          let parameterName: string | undefined;
          if (catchClause.param && t.isIdentifier(catchClause.param)) {
            parameterName = catchClause.param.name;
          }

          ctx.catchBlocks.push({
            id: catchBlockId,
            semanticId: catchBlockId,
            type: 'CATCH_BLOCK',
            file: ctx.module.file,
            line: getLine(catchClause),
            column: getColumn(catchClause),
            parentScopeId: ctx.parentScopeId,
            parentTryBlockId: tryBlockId,
            parameterName
          });

          // Create catch-body SCOPE (backward compatibility)
          catchScopeId = `SCOPE#catch-block#${ctx.module.file}#${getLine(catchClause)}:${ctx.scopeCounterRef.value++}`;
          const catchSemanticId = generateSemanticId('catch-block', ctx.scopeTracker);
          ctx.scopes.push({
            id: catchScopeId,
            type: 'SCOPE',
            scopeType: 'catch-block',
            semanticId: catchSemanticId,
            file: ctx.module.file,
            line: getLine(catchClause),
            parentScopeId: catchBlockId  // Parent is CATCH_BLOCK
          });
        }

        // 4. Create FINALLY_BLOCK and finally-body SCOPE if finalizer exists
        let finallyBlockId: string | null = null;
        let finallyScopeId: string | null = null;
        if (tryNode.finalizer) {
          const finallyBlockCounter = ctx.finallyBlockCounterRef.value++;
          const legacyFinallyBlockId = `${ctx.module.file}:FINALLY_BLOCK:${getLine(tryNode.finalizer)}:${finallyBlockCounter}`;
          finallyBlockId = ctx.scopeTracker
            ? computeSemanticId('FINALLY_BLOCK', 'finally', ctx.scopeTracker.getContext(), { discriminator: finallyBlockCounter })
            : legacyFinallyBlockId;

          ctx.finallyBlocks.push({
            id: finallyBlockId,
            semanticId: finallyBlockId,
            type: 'FINALLY_BLOCK',
            file: ctx.module.file,
            line: getLine(tryNode.finalizer),
            column: getColumn(tryNode.finalizer),
            parentScopeId: ctx.parentScopeId,
            parentTryBlockId: tryBlockId
          });

          // Create finally-body SCOPE (backward compatibility)
          finallyScopeId = `SCOPE#finally-block#${ctx.module.file}#${getLine(tryNode.finalizer)}:${ctx.scopeCounterRef.value++}`;
          const finallySemanticId = generateSemanticId('finally-block', ctx.scopeTracker);
          ctx.scopes.push({
            id: finallyScopeId,
            type: 'SCOPE',
            scopeType: 'finally-block',
            semanticId: finallySemanticId,
            file: ctx.module.file,
            line: getLine(tryNode.finalizer),
            parentScopeId: finallyBlockId  // Parent is FINALLY_BLOCK
          });
        }

        // 5. Push try scope onto stack for CONTAINS edges
        if (ctx.scopeIdStack) {
          ctx.scopeIdStack.push(tryScopeId);
        }

        // Enter try scope for semantic ID generation
        if (ctx.scopeTracker) {
          ctx.scopeTracker.enterCountedScope('try');
        }

        // 6. Store scope info for catch/finally transitions
        ctx.tryScopeMap.set(tryNode, {
          tryScopeId,
          catchScopeId,
          finallyScopeId,
          currentBlock: 'try',
          tryBlockId,
          catchBlockId,
          finallyBlockId
        });
      },
      exit: (tryPath: NodePath<t.TryStatement>) => {
        const tryNode = tryPath.node;
        const _scopeInfo = ctx.tryScopeMap.get(tryNode);

        // REG-311: Only decrement try block depth if we're still in 'try' block
        // (not transitioned to catch/finally, where we already decremented)
        if (ctx.controlFlowState && _scopeInfo?.currentBlock === 'try') {
          ctx.controlFlowState.tryBlockDepth--;
        }

        // Pop the current scope from stack (could be try, catch, or finally)
        if (ctx.scopeIdStack) {
          ctx.scopeIdStack.pop();
        }

        // Exit the current scope
        if (ctx.scopeTracker) {
          ctx.scopeTracker.exitScope();
        }

        // Clean up
        ctx.tryScopeMap.delete(tryNode);
      }
    };
  }

  private createCatchClauseVisitor(): {
    enter: (catchPath: NodePath<t.CatchClause>) => void;
  } {
    const ctx = this.ctx;

    return {
      enter: (catchPath: NodePath<t.CatchClause>) => {
        const catchNode = catchPath.node;
        const parent = catchPath.parent;

        if (!t.isTryStatement(parent)) return;

        const scopeInfo = ctx.tryScopeMap.get(parent);
        if (!scopeInfo || !scopeInfo.catchScopeId) return;

        // Transition from try scope to catch scope
        if (scopeInfo.currentBlock === 'try') {
          // Pop try scope, push catch scope
          if (ctx.scopeIdStack) {
            ctx.scopeIdStack.pop();
            ctx.scopeIdStack.push(scopeInfo.catchScopeId);
          }

          // Exit try scope, enter catch scope for semantic ID
          if (ctx.scopeTracker) {
            ctx.scopeTracker.exitScope();
            ctx.scopeTracker.enterCountedScope('catch');
          }

          // REG-311: Decrement tryBlockDepth when leaving try block for catch
          // Calls in catch block should NOT have isInsideTry=true
          if (ctx.controlFlowState) {
            ctx.controlFlowState.tryBlockDepth--;
          }

          scopeInfo.currentBlock = 'catch';
        }

        // Handle catch parameter (e.g., catch (e) or catch ({ message }))
        if (catchNode.param) {
          const errorVarInfo = extractNamesFromPattern(catchNode.param);

          errorVarInfo.forEach(varInfo => {
            const legacyId = `VARIABLE#${varInfo.name}#${ctx.module.file}#${varInfo.loc.start.line}:${varInfo.loc.start.column}:${ctx.varDeclCounterRef.value++}`;
            const varId = ctx.scopeTracker
              ? computeSemanticId('VARIABLE', varInfo.name, ctx.scopeTracker.getContext())
              : legacyId;

            ctx.variableDeclarations.push({
              id: varId,
              type: 'VARIABLE',
              name: varInfo.name,
              file: ctx.module.file,
              line: varInfo.loc.start.line,
              parentScopeId: scopeInfo.catchScopeId!
            });
          });
        }
      }
    };
  }
}
