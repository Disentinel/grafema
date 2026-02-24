/**
 * ReturnYieldHandler — handles ReturnStatement and YieldExpression nodes.
 *
 * Mechanical extraction from analyzeFunctionBody() (REG-422).
 * Original source: JSASTAnalyzer.ts lines ~3835-4061.
 */
import type { Visitor, NodePath } from '@babel/traverse';
import * as t from '@babel/types';
import { getLine, getColumn } from '../utils/location.js';
import type { ReturnStatementInfo, YieldExpressionInfo } from '../types.js';
import { extractReturnExpressionInfo } from '../extractors/ReturnExpressionExtractor.js';
import { FunctionBodyHandler } from './FunctionBodyHandler.js';

export class ReturnYieldHandler extends FunctionBodyHandler {
  getHandlers(): Visitor {
    const ctx = this.ctx;

    return {
      // Handle return statements for RETURNS edges
      ReturnStatement: (returnPath: NodePath<t.ReturnStatement>) => {
        // Skip if we couldn't determine the function ID
        if (!ctx.currentFunctionId) {
          return;
        }

        // Skip if this return is inside a nested function (not the function we're analyzing)
        // Check if there's a function ancestor BETWEEN us and funcNode
        // Stop checking once we reach funcNode - parents above funcNode are outside scope
        let parent: NodePath | null = returnPath.parentPath;
        let isInsideConditional = false;
        while (parent) {
          // If we've reached funcNode, we're done checking - this return belongs to funcNode
          if (parent.node === ctx.funcNode) {
            break;
          }
          if (t.isFunction(parent.node)) {
            // Found a function between returnPath and funcNode - this return is inside a nested function
            return;
          }
          // Track if return is inside a conditional block (if/else, switch case, loop, try/catch)
          if (t.isIfStatement(parent.node) ||
              t.isSwitchCase(parent.node) ||
              t.isLoop(parent.node) ||
              t.isTryStatement(parent.node) ||
              t.isCatchClause(parent.node)) {
            isInsideConditional = true;
          }
          parent = parent.parentPath;
        }

        // Phase 6 (REG-267): Track return count and early return detection
        ctx.controlFlowState.returnCount++;

        // A return is "early" if it's inside a conditional structure
        // (More returns after this one indicate the function doesn't always end here)
        if (isInsideConditional) {
          ctx.controlFlowState.hasEarlyReturn = true;
        }

        const returnNode = returnPath.node;
        const returnLine = getLine(returnNode);
        const returnColumn = getColumn(returnNode);

        // Handle bare return; (no value)
        if (!returnNode.argument) {
          // Skip - no data flow value
          return;
        }

        const arg = returnNode.argument;

        // Extract expression-specific info using shared method
        const exprInfo = extractReturnExpressionInfo(
          arg, ctx.module, ctx.literals, ctx.literalCounterRef, returnLine, returnColumn, 'return'
        );

        const returnInfo: ReturnStatementInfo = {
          parentFunctionId: ctx.currentFunctionId,
          file: ctx.module.file,
          line: returnLine,
          column: returnColumn,
          returnValueType: 'NONE',
          ...exprInfo,
        };

        ctx.returnStatements.push(returnInfo);
      },

      // Handle yield expressions for YIELDS/DELEGATES_TO edges (REG-270)
      YieldExpression: (yieldPath: NodePath<t.YieldExpression>) => {
        // Skip if we couldn't determine the function ID
        if (!ctx.currentFunctionId) {
          return;
        }

        // Skip if this yield is inside a nested function (not the function we're analyzing)
        // Check if there's a function ancestor BETWEEN us and funcNode
        let parent: NodePath | null = yieldPath.parentPath;
        while (parent) {
          // If we've reached funcNode, we're done checking - this yield belongs to funcNode
          if (parent.node === ctx.funcNode) {
            break;
          }
          if (t.isFunction(parent.node)) {
            // Found a function between yieldPath and funcNode - this yield is inside a nested function
            return;
          }
          parent = parent.parentPath;
        }

        const yieldNode = yieldPath.node;
        const yieldLine = getLine(yieldNode);
        const yieldColumn = getColumn(yieldNode);
        const isDelegate = yieldNode.delegate ?? false;

        // Handle bare yield; (no value) - only valid for non-delegate yield
        if (!yieldNode.argument && !isDelegate) {
          // Skip - no data flow value
          return;
        }

        // For yield* without argument (syntax error in practice, but handle gracefully)
        if (!yieldNode.argument) {
          return;
        }

        const arg = yieldNode.argument;

        // Extract expression-specific info using shared method
        // Note: We reuse extractReturnExpressionInfo since yield values have identical semantics
        const exprInfo = extractReturnExpressionInfo(
          arg, ctx.module, ctx.literals, ctx.literalCounterRef, yieldLine, yieldColumn, 'yield'
        );

        // Map ReturnStatementInfo fields to YieldExpressionInfo fields
        const yieldInfo: YieldExpressionInfo = {
          parentFunctionId: ctx.currentFunctionId,
          file: ctx.module.file,
          line: yieldLine,
          column: yieldColumn,
          isDelegate,
          yieldValueType: exprInfo.returnValueType ?? 'NONE',
          yieldValueName: exprInfo.returnValueName,
          yieldValueId: exprInfo.returnValueId,
          yieldValueLine: exprInfo.returnValueLine,
          yieldValueColumn: exprInfo.returnValueColumn,
          yieldValueCallName: exprInfo.returnValueCallName,
          expressionType: exprInfo.expressionType,
          operator: exprInfo.operator,
          leftSourceName: exprInfo.leftSourceName,
          rightSourceName: exprInfo.rightSourceName,
          consequentSourceName: exprInfo.consequentSourceName,
          alternateSourceName: exprInfo.alternateSourceName,
          object: exprInfo.object,
          property: exprInfo.property,
          computed: exprInfo.computed,
          objectSourceName: exprInfo.objectSourceName,
          expressionSourceNames: exprInfo.expressionSourceNames,
          unaryArgSourceName: exprInfo.unaryArgSourceName,
        };

        ctx.yieldExpressions.push(yieldInfo);
      },
    };
  }
}
