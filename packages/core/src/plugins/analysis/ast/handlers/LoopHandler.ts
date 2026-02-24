/**
 * LoopHandler -- handles loop control flow nodes: for, for-in, for-of,
 * while, and do-while statements.
 *
 * Inlines the createLoopScopeHandler logic from JSASTAnalyzer (REG-422).
 */
import type { Visitor, NodePath } from '@babel/traverse';
import * as t from '@babel/types';
import { getLine, getColumn } from '../utils/location.js';
import { memberExpressionToString } from '../utils/expression-helpers.js';
import { generateSemanticId } from '../utils/semanticIdHelpers.js';
import { computeSemanticId } from '../../../../core/SemanticId.js';
import { ExpressionNode } from '../../../../core/nodes/ExpressionNode.js';
import { extractDiscriminantExpression } from '../extractors/index.js';
import { FunctionBodyHandler } from './FunctionBodyHandler.js';

export class LoopHandler extends FunctionBodyHandler {
  getHandlers(): Visitor {
    return {
      ForStatement: this.createLoopHandler('for', 'for-loop', 'for'),
      ForInStatement: this.createLoopHandler('for-in', 'for-in-loop', 'for-in'),
      ForOfStatement: this.createLoopHandler('for-of', 'for-of-loop', 'for-of'),
      WhileStatement: this.createLoopHandler('while', 'while-loop', 'while'),
      DoWhileStatement: this.createLoopHandler('do-while', 'do-while-loop', 'do-while'),
    };
  }

  private createLoopHandler(
    trackerScopeType: string,
    scopeType: string,
    loopType: 'for' | 'for-in' | 'for-of' | 'while' | 'do-while',
  ): { enter: (path: NodePath<t.Loop>) => void; exit: () => void } {
    const ctx = this.ctx;

    return {
      enter: (path: NodePath<t.Loop>) => {
        const node = path.node;

        // Phase 6 (REG-267): Increment loop count for cyclomatic complexity
        if (ctx.controlFlowState) {
          ctx.controlFlowState.loopCount++;
          // REG-298: Track loop nesting depth for isInsideLoop detection
          ctx.controlFlowState.loopDepth++;
        }

        // 1. Create LOOP node
        const loopCounter = ctx.loopCounterRef.value++;
        const legacyLoopId = `${ctx.module.file}:LOOP:${loopType}:${getLine(node)}:${loopCounter}`;
        const loopId = ctx.scopeTracker
          ? computeSemanticId('LOOP', loopType, ctx.scopeTracker.getContext(), { discriminator: loopCounter })
          : legacyLoopId;

        // 2. Extract iteration target for for-in/for-of
        let iteratesOverName: string | undefined;
        let iteratesOverLine: number | undefined;
        let iteratesOverColumn: number | undefined;

        if (loopType === 'for-in' || loopType === 'for-of') {
          const loopNode = node as t.ForInStatement | t.ForOfStatement;
          if (t.isIdentifier(loopNode.right)) {
            iteratesOverName = loopNode.right.name;
            iteratesOverLine = getLine(loopNode.right);
            iteratesOverColumn = getColumn(loopNode.right);
          } else if (t.isMemberExpression(loopNode.right)) {
            iteratesOverName = memberExpressionToString(loopNode.right);
            iteratesOverLine = getLine(loopNode.right);
            iteratesOverColumn = getColumn(loopNode.right);
          }
        }

        // 2b. Extract init/test/update for classic for loops and test for while/do-while (REG-282)
        let initVariableName: string | undefined;
        let initLine: number | undefined;

        let testExpressionId: string | undefined;
        let testExpressionType: string | undefined;
        let testLine: number | undefined;
        let testColumn: number | undefined;

        let updateExpressionId: string | undefined;
        let updateExpressionType: string | undefined;
        let updateLine: number | undefined;
        let updateColumn: number | undefined;

        if (loopType === 'for') {
          const forNode = node as t.ForStatement;

          // Extract init: let i = 0
          if (forNode.init) {
            initLine = getLine(forNode.init);
            if (t.isVariableDeclaration(forNode.init)) {
              // Get name of first declared variable
              const firstDeclarator = forNode.init.declarations[0];
              if (t.isIdentifier(firstDeclarator.id)) {
                initVariableName = firstDeclarator.id.name;
              }
            }
          }

          // Extract test: i < 10
          if (forNode.test) {
            testLine = getLine(forNode.test);
            testColumn = getColumn(forNode.test);
            testExpressionType = forNode.test.type;
            testExpressionId = ExpressionNode.generateId(forNode.test.type, ctx.module.file, testLine, testColumn);
          }

          // Extract update: i++
          if (forNode.update) {
            updateLine = getLine(forNode.update);
            updateColumn = getColumn(forNode.update);
            updateExpressionType = forNode.update.type;
            updateExpressionId = ExpressionNode.generateId(forNode.update.type, ctx.module.file, updateLine, updateColumn);
          }
        }

        // Extract test condition for while and do-while loops
        if (loopType === 'while' || loopType === 'do-while') {
          const condLoop = node as t.WhileStatement | t.DoWhileStatement;
          if (condLoop.test) {
            testLine = getLine(condLoop.test);
            testColumn = getColumn(condLoop.test);
            testExpressionType = condLoop.test.type;
            testExpressionId = ExpressionNode.generateId(condLoop.test.type, ctx.module.file, testLine, testColumn);
          }
        }

        // Extract async flag for for-await-of (REG-284)
        let isAsync: boolean | undefined;
        if (loopType === 'for-of') {
          const forOfNode = node as t.ForOfStatement;
          isAsync = forOfNode.await === true ? true : undefined;
        }

        // 3. Determine actual parent - use stack for nested loops, otherwise original parentScopeId
        const actualParentScopeId = (ctx.scopeIdStack && ctx.scopeIdStack.length > 0)
          ? ctx.scopeIdStack[ctx.scopeIdStack.length - 1]
          : ctx.parentScopeId;

        // 3.5. Extract condition expression for while/do-while/for loops (REG-280)
        // Note: for-in and for-of don't have test expressions (they use ITERATES_OVER instead)
        let conditionExpressionId: string | undefined;
        let conditionExpressionType: string | undefined;
        let conditionLine: number | undefined;
        let conditionColumn: number | undefined;

        // REG-533: Operand metadata for test EXPRESSION DERIVES_FROM edges
        let testLeftSourceName: string | undefined;
        let testRightSourceName: string | undefined;
        let testObjectSourceName: string | undefined;
        let testConsequentSourceName: string | undefined;
        let testAlternateSourceName: string | undefined;
        let testUnaryArgSourceName: string | undefined;
        let testUpdateArgSourceName: string | undefined;
        let testOperator: string | undefined;
        let testObject: string | undefined;
        let testProperty: string | undefined;
        let testComputed: boolean | undefined;
        let testExpressionSourceNames: string[] | undefined;

        if (loopType === 'while' || loopType === 'do-while') {
          const testNode = (node as t.WhileStatement | t.DoWhileStatement).test;
          if (testNode) {
            const condResult = extractDiscriminantExpression(testNode, ctx.module);
            conditionExpressionId = condResult.id;
            conditionExpressionType = condResult.expressionType;
            conditionLine = condResult.line;
            conditionColumn = condResult.column;
            // REG-533: Extract operand metadata
            testLeftSourceName = condResult.leftSourceName;
            testRightSourceName = condResult.rightSourceName;
            testObjectSourceName = condResult.objectSourceName;
            testConsequentSourceName = condResult.consequentSourceName;
            testAlternateSourceName = condResult.alternateSourceName;
            testUnaryArgSourceName = condResult.unaryArgSourceName;
            testUpdateArgSourceName = condResult.updateArgSourceName;
            testOperator = condResult.operator;
            testObject = condResult.object;
            testProperty = condResult.property;
            testComputed = condResult.computed;
            testExpressionSourceNames = condResult.expressionSourceNames;
          }
        } else if (loopType === 'for') {
          const forNode = node as t.ForStatement;
          // for loop test may be null (infinite loop: for(;;))
          if (forNode.test) {
            const condResult = extractDiscriminantExpression(forNode.test, ctx.module);
            conditionExpressionId = condResult.id;
            conditionExpressionType = condResult.expressionType;
            conditionLine = condResult.line;
            conditionColumn = condResult.column;
            // REG-533: Extract operand metadata
            testLeftSourceName = condResult.leftSourceName;
            testRightSourceName = condResult.rightSourceName;
            testObjectSourceName = condResult.objectSourceName;
            testConsequentSourceName = condResult.consequentSourceName;
            testAlternateSourceName = condResult.alternateSourceName;
            testUnaryArgSourceName = condResult.unaryArgSourceName;
            testUpdateArgSourceName = condResult.updateArgSourceName;
            testOperator = condResult.operator;
            testObject = condResult.object;
            testProperty = condResult.property;
            testComputed = condResult.computed;
            testExpressionSourceNames = condResult.expressionSourceNames;
          }
        }

        // REG-533: Extract operand metadata for for-loop update expression
        let updateArgSourceName: string | undefined;
        let updateOperator: string | undefined;
        if (loopType === 'for') {
          const forNode = node as t.ForStatement;
          if (forNode.update) {
            const updateResult = extractDiscriminantExpression(forNode.update, ctx.module);
            updateArgSourceName = updateResult.updateArgSourceName;
            updateOperator = updateResult.operator;
          }
        }

        // 4. Push LOOP info
        ctx.loops.push({
          id: loopId,
          semanticId: loopId,
          type: 'LOOP',
          loopType,
          file: ctx.module.file,
          line: getLine(node),
          column: getColumn(node),
          parentScopeId: actualParentScopeId,
          iteratesOverName,
          iteratesOverLine,
          iteratesOverColumn,
          conditionExpressionId,
          conditionExpressionType,
          conditionLine,
          conditionColumn,
          // REG-282: init/test/update for classic for loops
          initVariableName,
          initLine,
          testExpressionId,
          testExpressionType,
          testLine,
          testColumn,
          updateExpressionId,
          updateExpressionType,
          updateLine,
          updateColumn,
          // REG-284: async flag for for-await-of
          async: isAsync,
          // REG-533: Operand metadata for DERIVES_FROM edges
          testLeftSourceName,
          testRightSourceName,
          testObjectSourceName,
          testConsequentSourceName,
          testAlternateSourceName,
          testUnaryArgSourceName,
          testUpdateArgSourceName,
          testOperator,
          testObject,
          testProperty,
          testComputed,
          testExpressionSourceNames,
          updateArgSourceName,
          updateOperator
        });

        // 5. Create body SCOPE (backward compatibility)
        const scopeId = `SCOPE#${scopeType}#${ctx.module.file}#${getLine(node)}:${ctx.scopeCounterRef.value++}`;
        const semanticId = generateSemanticId(scopeType, ctx.scopeTracker);
        ctx.scopes.push({
          id: scopeId,
          type: 'SCOPE',
          scopeType,
          semanticId,
          file: ctx.module.file,
          line: getLine(node),
          parentScopeId: loopId  // Parent is LOOP, not original parentScopeId
        });

        // 6. Push body SCOPE to scopeIdStack (for CONTAINS edges to nested items)
        // The body scope is the container for nested loops, not the LOOP itself
        if (ctx.scopeIdStack) {
          ctx.scopeIdStack.push(scopeId);
        }

        // Enter scope for semantic ID generation
        if (ctx.scopeTracker) {
          ctx.scopeTracker.enterCountedScope(trackerScopeType);
        }
      },
      exit: () => {
        // REG-298: Decrement loop depth counter
        if (ctx.controlFlowState) {
          ctx.controlFlowState.loopDepth--;
        }

        // Pop loop scope from stack
        if (ctx.scopeIdStack) {
          ctx.scopeIdStack.pop();
        }

        // Exit scope
        if (ctx.scopeTracker) {
          ctx.scopeTracker.exitScope();
        }
      }
    };
  }
}
